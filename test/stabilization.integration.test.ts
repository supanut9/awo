import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (name: string) => import(pathToFileURL(path.join(ROOT, "dist", name)).href);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awo-stability-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(ROOT, "dist/cli.js"), "init", "--key", "TST"], { cwd: root, stdio: "pipe" });
  const goal = path.join(root, "goals/TST-G1");
  await fs.mkdir(path.join(goal, "tasks"), { recursive: true });
  await fs.writeFile(path.join(goal, "goal.md"), '---\nid: TST-G1\ntitle: Strict goal\nstatus: done\ncompletionPolicy:\n  qaRequired: true\n  acceptanceEvidenceRequired: true\n---\n');
  await fs.writeFile(path.join(goal, "requirement.md"), '---\nid: TST-R1\nstatus: approved\n---\n## Acceptance criteria\n- Given input, when executed, then it works.\n');
  await fs.writeFile(path.join(goal, "tasks/TST-T1.md"), '---\nid: TST-T1\ngoalId: TST-G1\nstatus: done\n---\n');
  const { newTaskState } = await load("state.js");
  const state = { rev: 1, goalId: "TST-G1", goalStatus: "done", updatedAt: "",
    tasks: { "TST-T1": newTaskState("done") },
    criteria: { "1": [{ taskId: "TST-T1", kind: "manual", ref: "proof", recordedAt: "2026-11-03" }] },
    qa: { briefRunId: "brief", verdict: "pass", verdictBy: "tester" },
  };
  await fs.writeFile(path.join(goal, "state.json"), JSON.stringify(state));
  return { root, goal, state };
}

test("identical evidence retries preserve QA, changed evidence retains stale verdict history", async (t) => {
  const { root, goal } = await fixture(t);
  const { runTaskEvidence } = await load("commands/traceability.js");
  const { runGoalReadiness } = await load("commands/readiness.js");
  const input = { cwd: root, taskId: "TST-T1", criterion: 1, kind: "manual", ref: "proof" };
  await runTaskEvidence(input);
  assert.equal((await runGoalReadiness("TST-G1", { cwd: root })).ready, true);
  await runTaskEvidence({ ...input, ref: "new proof" });
  assert.equal((await runGoalReadiness("TST-G1", { cwd: root })).ready, false);
  const state = JSON.parse(await fs.readFile(path.join(goal, "state.json"), "utf8"));
  assert.equal(state.qaHistory.at(-1).verdict, "pass");
  assert.equal(state.criteria["1"].length, 2);
});

test("missing QA is consistent across readiness, list, context, UI and archival", async (t) => {
  const { root, goal, state } = await fixture(t);
  const { qa, ...withoutQa } = state;
  await fs.writeFile(path.join(goal, "state.json"), JSON.stringify(withoutQa));
  const { runGoalReadiness } = await load("commands/readiness.js");
  const { runGoalList, runGoalArchive, findArchivableGoals } = await load("commands/goal-archive.js");
  const { FileReader } = await load("ui/reader.js");
  const { runContext } = await load("commands/context.js");
  assert.equal((await runGoalReadiness("TST-G1", { cwd: root })).status, "qa-review");
  assert.equal((await runGoalList({ cwd: root }))[0].status, "qa-review");
  assert.equal((await new FileReader(root).goals())[0].status, "qa-review");
  assert.equal((await runContext({ cwd: root })).snapshot.goals[0].status, "qa-review");
  assert.deepEqual(await findArchivableGoals(root), []);
  await assert.rejects(runGoalArchive("TST-G1", { cwd: root }), /QA|qa-review|readiness/);
  assert.ok(await fs.stat(goal));
});

test("ready governed goals can still archive", async (t) => {
  const { root } = await fixture(t);
  const { runGoalArchive } = await load("commands/goal-archive.js");
  assert.equal((await runGoalArchive("TST-G1", { cwd: root })).status, "done");
});

test("dirty and untracked tests participate in evidence attribution; bad refs reject", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awo-dirty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-b", "main");
  await fs.writeFile(path.join(root, "price.ts"), "original\n");
  await fs.writeFile(path.join(root, "price.test.ts"), "original\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: fixture");
  await fs.writeFile(path.join(root, "price.ts"), "modified\n");
  await fs.writeFile(path.join(root, "price.test.ts"), "modified\n");
  await fs.writeFile(path.join(root, "new.spec.ts"), "new oracle\n");
  const { changedFiles } = await load("evidence.js");
  const changes = await changedFiles(root, "main");
  assert.deepEqual(changes.testsAndCodeTogether, ["price.test.ts"]);
  assert.ok(changes.newTests.includes("new.spec.ts"));
  await assert.rejects(changedFiles(root, "does-not-exist"));
});

test("measurements use the recorded custom checkout and pinned base, never a missing checkout fallback", async (t) => {
  const { root, goal, state } = await fixture(t);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "custom-checkout");
  await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  git("init", "-b", "main");
  await fs.writeFile(path.join(repo, "marker.txt"), "intended");
  git("add", ".");
  const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-am", "test: fixture");
  commit();
  const base = git("rev-parse", "HEAD").trim();
  git("worktree", "add", "-b", "candidate", checkout);
  const manifestFile = path.join(root, ".workspace/manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.repos = [{ name: "api", type: "local", path: repo }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.writeFile(path.join(goal, "tasks/TST-T1.md"), '---\nid: TST-T1\ngoalId: TST-G1\nstatus: running\ntargets: [api]\n---\n');
  const runId = "2026-11-03T01-00-00_TST-T1";
  state.tasks["TST-T1"] = { ...state.tasks["TST-T1"], status: "running", lastRunId: runId, worktree: checkout };
  await fs.writeFile(path.join(goal, "state.json"), JSON.stringify(state));
  const { appendEvent, readEvents } = await load("runs.js");
  await appendEvent(root, runId, "repo.baseline", { repo: "api", checkout, sha: base });
  await fs.writeFile(path.join(repo, "marker.txt"), "unrelated shared checkout");
  commit();
  const { runTaskEvent } = await load("commands/task.js");
  const result = await runTaskEvent("TST-T1", "test", { cwd: root,
    run: 'node -e "if(require(\'fs\').readFileSync(\'marker.txt\',\'utf8\')!==\'intended\')process.exit(1)"' });
  assert.equal(result.diagnosis, "pass");
  const receipt = (await readEvents(root, runId)).find((e: { kind: string }) => e.kind === "test");
  assert.equal(receipt.checkout, checkout);
  assert.equal(receipt.headSha, base);
  assert.equal(receipt.baseSha, base);
  assert.match(receipt.treeFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(await fs.stat(path.join(root, receipt.artifact)));
  await fs.rename(checkout, `${checkout}-moved`);
  await assert.rejects(runTaskEvent("TST-T1", "test", { cwd: root, run: "true" }), /checkout is missing/);
});

test("doctor treats unregistered historical targets as information but active targets as errors", async (t) => {
  const { root, goal } = await fixture(t);
  await fs.writeFile(path.join(goal, "tasks/TST-T1.md"), '---\nid: TST-T1\ngoalId: TST-G1\nstatus: done\ntargets: [retired]\n---\n');
  const { runDoctor } = await load("commands/doctor.js");
  let findings = await runDoctor({ cwd: root });
  assert.ok(findings.some((f: any) => f.area === "tasks" && f.severity === "error" && f.message.includes("retired")));
  await fs.mkdir(path.join(root, "goals/archive"), { recursive: true });
  await fs.rename(goal, path.join(root, "goals/archive/TST-G1"));
  findings = await runDoctor({ cwd: root });
  assert.ok(!findings.some((f: any) => f.area === "tasks" && f.severity === "error" && f.message.includes("retired")));
  assert.ok(findings.some((f: any) => f.severity === "info" && f.message.includes("retired")));
  assert.ok(!(await runDoctor({ cwd: root, scope: "active" })).some((f: any) => f.message.includes("retired")));
  const active = path.join(root, "goals/TST-G2");
  await fs.mkdir(path.join(active, "tasks"), { recursive: true });
  await fs.writeFile(path.join(active, "goal.md"), "---\nid: TST-G2\ntitle: Active dependent\n---\n");
  await fs.writeFile(path.join(active, "tasks/TST-T2.md"), "---\nid: TST-T2\ngoalId: TST-G2\ndependsOn: [TST-T1]\n---\n");
  assert.ok(!(await runDoctor({ cwd: root, scope: "active" })).some((f: any) => f.message.includes('dependsOn "TST-T1"')));
});

async function measuredFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const data = await fixture(t);
  const checkout = path.join(data.root, "candidate");
  await fs.mkdir(checkout);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "pipe", encoding: "utf8" });
  git("init", "-b", "main");
  await fs.writeFile(path.join(checkout, "code.txt"), "original");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: fixture");
  const manifestFile = path.join(data.root, ".workspace/manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.repos = [{ name: "api", type: "local", path: checkout }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.writeFile(path.join(data.goal, "tasks/TST-T1.md"), "---\nid: TST-T1\ngoalId: TST-G1\nstatus: running\ntargets: [api]\n---\n");
  const runId = "2026-11-04T01-00-00_TST-T1";
  data.state.tasks["TST-T1"] = { ...data.state.tasks["TST-T1"], status: "running", lastRunId: runId, worktree: checkout };
  await fs.writeFile(path.join(data.goal, "state.json"), JSON.stringify(data.state));
  const { appendEvent } = await load("runs.js");
  await appendEvent(data.root, runId, "repo.baseline", { repo: "api", checkout, sha: git("rev-parse", "HEAD").trim() });
  const { runTaskEvent, runTaskComplete } = await load("commands/task.js");
  return { ...data, checkout,
    measure: (run: string) => runTaskEvent("TST-T1", "test", { cwd: data.root, run }),
    complete: () => runTaskComplete("TST-T1", { cwd: data.root, outcome: "success", gate: true }),
  };
}

test("completion refuses a failed measurement even when routed to review", async (t) => {
  const f = await measuredFixture(t);
  await f.measure("node -e 'process.exit(7)'");
  await assert.rejects(f.complete(), /failing|failed|passing/i);
});

test("a later failing rerun supersedes a passing receipt", async (t) => {
  const f = await measuredFixture(t);
  const command = "node -e 'process.exit(require(\"fs\").readFileSync(\"code.txt\", \"utf8\") === \"original\" ? 0 : 1)'";
  await f.measure(command);
  await fs.writeFile(path.join(f.checkout, "code.txt"), "broken");
  await f.measure(command);
  await assert.rejects(f.complete(), /failing|failed|passing/i);
});

test("completion refuses an exit-zero command that changes its tested tree", async (t) => {
  const f = await measuredFixture(t);
  const result = await f.measure("node -e 'require(\"fs\").writeFileSync(\"code.txt\", \"changed by test\")'");
  assert.equal(result.diagnosis, "unknown");
  await assert.rejects(f.complete(), /tree|stable|stale/i);
});

test("completion refuses a receipt after a later untested source edit", async (t) => {
  const f = await measuredFixture(t);
  await f.measure("node -e 'process.exit(0)'");
  await fs.writeFile(path.join(f.checkout, "code.txt"), "untested edit");
  await assert.rejects(f.complete(), /tree|stable|stale/i);
});

test("a passing rerun of the same command replaces an earlier failure", async (t) => {
  const f = await measuredFixture(t);
  const command = "node -e 'process.exit(require(\"fs\").readFileSync(\"code.txt\", \"utf8\") === \"original\" ? 0 : 1)'";
  await fs.writeFile(path.join(f.checkout, "code.txt"), "broken");
  await f.measure(command);
  await fs.writeFile(path.join(f.checkout, "code.txt"), "original");
  await f.measure(command);
  assert.equal((await f.complete()).status, "in-review");
});

test("a passing different command cannot hide a failing check", async (t) => {
  const f = await measuredFixture(t);
  await f.measure("node -e 'process.exit(1)'");
  await f.measure("node -e 'process.exit(0)'");
  await assert.rejects(f.complete(), /failing|failed|passing/i);
});

test("rerunning against the changed tree replaces a stale receipt", async (t) => {
  const f = await measuredFixture(t);
  const command = "node -e 'process.exit(0)'";
  await f.measure(command);
  await fs.writeFile(path.join(f.checkout, "code.txt"), "new implementation");
  await assert.rejects(f.complete(), /stale|tree/i);
  await f.measure(command);
  assert.equal((await f.complete()).status, "in-review");
});
