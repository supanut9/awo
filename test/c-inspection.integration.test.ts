import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/c-inspection.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const HUMAN_ENV = { ...process.env, AWO_HUMAN: "1", AWO_AGENT: "" };

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** stderr is captured on success too: several behaviours here are warnings. */
function awo(cwd: string, args: string[], env: NodeJS.ProcessEnv = HUMAN_ENV): RunResult {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function ok(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = awo(cwd, args, env);
  assert.equal(r.code, 0, `awo ${args.join(" ")} failed:\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

async function load(rel: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(REPO_ROOT, "dist", rel)).href);
}

interface TaskSpec {
  id: string;
  deps?: string[];
  kind?: string;
  /** Raw frontmatter override, for malformed files. */
  raw?: string;
  file?: string;
}

interface GoalSpec {
  id: string;
  archived?: boolean;
  governed?: boolean;
  requirementId?: string;
  tasks: TaskSpec[];
}

/** A workspace with hand-authored goals, plus one linked repo `api` (a git repo when asked). */
function makeWorkspace(key: string, goals: GoalSpec[], options: { git?: boolean } = {}): { ws: string; repo: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-c-"));
  execFileSync(process.execPath, [CLI, "init", "--key", key], { cwd: ws, stdio: "ignore" });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-c-repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  if (options.git) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "--initial-branch=main");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  }
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: ws, stdio: "ignore" });
  for (const g of goals) writeGoal(ws, g);
  return { ws, repo };
}

function goalDir(ws: string, g: Pick<GoalSpec, "id" | "archived">): string {
  return g.archived ? path.join(ws, "goals", "archive", g.id) : path.join(ws, "goals", g.id);
}

function writeGoal(ws: string, g: GoalSpec): void {
  const dir = goalDir(ws, g);
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  const policy = g.governed ? `completionPolicy:\n  qaRequired: true\n` : "";
  const req = g.requirementId ? `requirementId: ${g.requirementId}\n` : "";
  fs.writeFileSync(path.join(dir, "goal.md"), `---\nid: ${g.id}\ntitle: Goal ${g.id}\n${req}${policy}---\n\nObjective.\n`);
  for (const t of g.tasks) {
    const fm =
      t.raw ??
      `id: ${t.id}\ngoalId: ${g.id}\nname: Task ${t.id}\ntargets: [api]\ndependsOn: [${(t.deps ?? []).join(", ")}]\n${t.kind ? `kind: ${t.kind}\n` : ""}`;
    fs.writeFileSync(path.join(dir, "tasks", t.file ?? `${t.id}.md`), `---\n${fm}---\n\n## Objective\nDo ${t.id}.\n`);
  }
}

function taskState(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    lastRunOutcome: status === "in-review" || status === "done" ? "success" : null,
    lastRunId: null,
    startedAt: null,
    finishedAt: null,
    attempts: status === "todo" ? 0 : 1,
    worktree: null,
    blockedReason: null,
    ...extra,
  };
}

function writeState(ws: string, g: Pick<GoalSpec, "id" | "archived">, tasks: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(goalDir(ws, g), "state.json"),
    JSON.stringify({ rev: 1, goalId: g.id, goalStatus: "planning", updatedAt: new Date().toISOString(), tasks, ...extra })
  );
}

function readStateFile(ws: string, g: Pick<GoalSpec, "id" | "archived">): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(goalDir(ws, g), "state.json"), "utf8"));
}

function dayRows(ws: string): Record<string, any>[] {
  const logs = path.join(ws, "logs");
  return fs
    .readdirSync(logs)
    .filter((d) => fs.existsSync(path.join(logs, d, "runs.jsonl")))
    .flatMap((d) =>
      fs
        .readFileSync(path.join(logs, d, "runs.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    );
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// C1 — strict arguments, suggestions, command aliases
// ---------------------------------------------------------------------------

test("C1: extra positional arguments fail loudly instead of being silently ignored", () => {
  const { ws, repo } = makeWorkspace("CA", [{ id: "CA-G1", tasks: [{ id: "CA-T1" }] }]);

  const extra = awo(ws, ["context", "now"]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /too many arguments for 'context'/);

  // 0.7 printed T1 and dropped "success" without a word.
  const show = awo(ws, ["task", "show", "CA-T1", "success"]);
  assert.equal(show.code, 1);
  assert.match(show.stderr, /too many arguments/);

  const typo = awo(ws, ["contxt"]);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /Did you mean context\?/);
  cleanup(ws, repo);
});

test("C1: task start, task approve and requirement are aliases of task run, task verify and req", () => {
  const { ws, repo } = makeWorkspace("CB", [{ id: "CB-G1", tasks: [{ id: "CB-T1" }] }]);

  assert.match(ok(ws, ["task", "start", "CB-T1", "--no-worktree"]), /CB-T1 is running/);
  ok(ws, ["task", "complete", "CB-T1", "--outcome", "success", "--gate", "--untested", "fixture"]);
  assert.equal(readStateFile(ws, { id: "CB-G1" }).tasks["CB-T1"].status, "in-review");
  ok(ws, ["task", "approve", "CB-T1"]);
  assert.equal(readStateFile(ws, { id: "CB-G1" }).tasks["CB-T1"].status, "done");

  ok(ws, ["requirement", "new", "--title", "Thing"]);
  assert.match(ok(ws, ["requirement", "list"]), /CB-R1/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C2 — task list / task show / goal show / goal list --needs-verdict
// ---------------------------------------------------------------------------

test("C2: task list shows live goals by default with a goal column; --all and a goal reach the archive", () => {
  const { ws, repo } = makeWorkspace("CC", [
    { id: "CC-G1", tasks: [{ id: "CC-T1" }, { id: "CC-T2" }] },
    { id: "CC-G2", archived: true, tasks: [{ id: "CC-T3" }] },
  ]);

  const live = ok(ws, ["task", "list"]);
  assert.match(live, /^CC-T1\ttodo\tCC-G1\tTask CC-T1$/m);
  assert.doesNotMatch(live, /CC-T3/, "archived goals' tasks are history, not the live list");

  assert.match(ok(ws, ["task", "list", "--all"]), /^CC-T3\ttodo\tCC-G2 \[archived\]\t/m);
  assert.match(ok(ws, ["task", "list", "CC-G2"]), /CC-T3/);
  assert.match(ok(ws, ["task", "list", "--goal", "CC-G2"]), /CC-T3/);
  assert.doesNotMatch(ok(ws, ["task", "list", "CC-G2"]), /CC-T1/);

  const rows = JSON.parse(ok(ws, ["task", "list", "--json", "--all"]));
  assert.deepEqual(
    rows.map((r: { id: string; goalArchived: boolean }) => [r.id, r.goalArchived]),
    [["CC-T1", false], ["CC-T2", false], ["CC-T3", true]]
  );

  const unknown = awo(ws, ["task", "list", "CC-G9"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown goal "CC-G9"\. Live goals: CC-G1/);
  cleanup(ws, repo);
});

test("C2: task show carries goal policy, worktree, base, PRs, owner, last transition and the latest measurement", () => {
  const { ws, repo } = makeWorkspace("CD", [{ id: "CD-G1", governed: true, tasks: [{ id: "CD-T1" }] }], { git: true });
  const goal = { id: "CD-G1" };

  ok(ws, ["task", "run", "CD-T1"]);
  ok(ws, ["task", "event", "CD-T1", "test", "--run", "true"]);

  // Fields other lanes record at runtime; this command only has to show them.
  const state = readStateFile(ws, goal);
  const pr = {
    repo: "api", number: 7, url: "https://example.invalid/pr/7", branch: "feature/CD-T1", headSha: "abc",
    isDraft: false, mergeState: "CLEAN", checks: "passing", reviews: "approved", lastCheckedAt: "2026-01-01T00:00:00.000Z",
    feedback: {}, state: "MERGED", merged: true, mergedAt: "2026-01-02T00:00:00.000Z", mergeCommit: "def",
  };
  Object.assign(state.tasks["CD-T1"], {
    pullRequests: { api: pr },
    owner: { runId: state.tasks["CD-T1"].lastRunId, pid: 42, host: "box", actor: "claude", startedAt: "2026-01-01T00:00:00.000Z", heartbeatAt: "2026-01-01T01:00:00.000Z" },
    transitions: [{ from: "todo", to: "running", actor: "runner", by: "human", reason: null, runId: null, at: "2026-01-01T00:00:00.000Z" }],
    base: { api: { ref: "origin/main", sha: "0123456789abcdef" } },
  });
  fs.writeFileSync(path.join(goalDir(ws, goal), "state.json"), JSON.stringify(state));

  const j = JSON.parse(ok(ws, ["task", "show", "CD-T1", "--json"]));
  assert.equal(j.goal.id, "CD-G1");
  assert.equal(j.goal.policy.qaRequired, true);
  assert.deepEqual(j.worktrees, [
    { repo: "api", path: path.join("repos", ".worktrees", "api", "CD-T1"), exists: true, branch: "feature/CD-T1" },
  ]);
  assert.equal(j.base.api.ref, "origin/main");
  assert.equal(j.pullRequests[0].merged, true);
  assert.equal(j.owner.actor, "claude");
  assert.equal(j.lastTransition.to, "running");
  assert.equal(j.measurements.length, 1);
  assert.equal(j.measurements[0].repo, "api");
  assert.equal(j.measurements[0].exitCode, 0);
  assert.equal(typeof j.measurements[0].diagnosis, "string");

  const text = ok(ws, ["task", "show", "CD-T1"]);
  assert.match(text, /status: {3}running/);
  assert.match(text, /policy: QA verdict required/);
  assert.match(text, /worktree: repos\/\.worktrees\/api\/CD-T1 on feature\/CD-T1/);
  assert.match(text, /base: {5}api origin\/main@0123456789/);
  assert.match(text, /PRs: {6}api#7 merged/);
  assert.match(text, /owner: {4}claude \(pid 42 on box\)/);
  assert.match(text, /moved: {4}todo → running by human/);
  assert.match(text, /tested: {3}api exit 0/);
  cleanup(ws, repo);
});

test("C2: goal show summarises status, policy, criteria, in-review counts, PRs and worktrees", () => {
  const goal = { id: "CE-G1", governed: true, requirementId: "CE-R1", tasks: [{ id: "CE-T1" }, { id: "CE-T2" }] };
  const archivedGoal = { id: "CE-G2", archived: true, tasks: [{ id: "CE-T3" }] };
  const { ws, repo } = makeWorkspace("CE", [goal, archivedGoal]);
  const pr = {
    repo: "api", number: 12, url: "u", branch: "feature/CE-T1", headSha: "a", isDraft: false, mergeState: "CLEAN",
    checks: "passing", reviews: "approved", lastCheckedAt: "2026-01-01T00:00:00.000Z", feedback: {}, state: "MERGED", merged: true,
  };
  writeState(ws, goal, { "CE-T1": taskState("in-review", { pullRequest: pr }), "CE-T2": taskState("in-review") });
  writeState(ws, archivedGoal, { "CE-T3": taskState("cancelled") }, { archivedStatus: "cancelled", archivedAt: "2026-02-01T00:00:00.000Z" });
  fs.mkdirSync(path.join(ws, "repos", ".worktrees", "api", "CE-T2"), { recursive: true });
  fs.writeFileSync(
    path.join(goalDir(ws, goal), "requirement.md"),
    "---\nid: CE-R1\ntitle: Thing\nstatus: approved\n---\n\n## Acceptance criteria\n- one works\n- two works\n"
  );

  const text = ok(ws, ["goal", "show", "CE-G1"]);
  assert.match(text, /^CE-G1 — Goal CE-G1$/m);
  assert.match(text, /status: {4}qa-review — awaiting a verdict/);
  assert.match(text, /policy: {4}QA verdict required/);
  assert.match(text, /req: {7}CE-R1/);
  assert.match(text, /criteria: {2}2 declared — coverage not required by policy/);
  assert.match(text, /tasks: {5}2 total · 2 in review/);
  assert.match(text, /CE-T1\tin-review.*api#12 merged/);
  assert.match(text, /PRs: {7}1 linked, 1 merged/);
  assert.match(text, /worktrees: 1 on disk — repos\/\.worktrees\/api\/CE-T2/);

  const j = JSON.parse(ok(ws, ["goal", "show", "CE-G1", "--json"]));
  assert.equal(j.awaitingVerdict, true);
  assert.equal(j.counts["in-review"], 2);
  assert.equal(j.pullRequests[0].merged, true);
  assert.equal(j.requirementId, "CE-R1");
  assert.equal(j.criteriaCount, 2);
  assert.equal(j.readiness.ready, false);

  // An archived goal reports the status frozen when it was filed.
  const archived = JSON.parse(ok(ws, ["goal", "show", "CE-G2", "--json"]));
  assert.equal(archived.archived, true);
  assert.equal(archived.status, "cancelled");

  const unknown = awo(ws, ["goal", "show", "CE-G9"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown goal "CE-G9"/);
  cleanup(ws, repo);
});

test("C2: goal list --needs-verdict names governed goals whose work is all in review, and shows in-review counts", () => {
  const goals: GoalSpec[] = [
    { id: "CF-G1", governed: true, tasks: [{ id: "CF-T1" }, { id: "CF-T2" }] },
    { id: "CF-G2", tasks: [{ id: "CF-T3" }] },
    { id: "CF-G3", governed: true, tasks: [{ id: "CF-T4" }, { id: "CF-T5" }] },
    { id: "CF-G4", governed: true, tasks: [{ id: "CF-T6" }] },
  ];
  const { ws, repo } = makeWorkspace("CF", goals);
  writeState(ws, goals[0], { "CF-T1": taskState("in-review"), "CF-T2": taskState("done") });
  writeState(ws, goals[1], { "CF-T3": taskState("in-review") });
  writeState(ws, goals[2], { "CF-T4": taskState("in-review"), "CF-T5": taskState("todo") });
  writeState(ws, goals[3], { "CF-T6": taskState("in-review") }, {
    qa: { briefRunId: "r", briefRecordedAt: "t", verdict: "pass", summary: "ok", verdictRunId: "v", verdictRecordedAt: "t", verdictBy: "lead", model: null },
  });

  const waiting = ok(ws, ["goal", "list", "--needs-verdict"]);
  assert.match(waiting, /^CF-G1\t/m);
  assert.doesNotMatch(waiting, /CF-G2|CF-G3|CF-G4/);

  assert.match(ok(ws, ["goal", "list"]), /CF-G3\t\S+\t0\/2 done, 1 in review/);
  const rows = JSON.parse(ok(ws, ["goal", "list", "--needs-verdict", "--json"]));
  assert.deepEqual(rows.map((r: { id: string }) => r.id), ["CF-G1"]);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C3 — log tail / log show / log list
// ---------------------------------------------------------------------------

function twoRunWorkspace(key: string): { ws: string; repo: string; closedRun: string; openRun: string } {
  const goal = { id: `${key}-G1`, tasks: [{ id: `${key}-T1` }, { id: `${key}-T2` }] };
  const { ws, repo } = makeWorkspace(key, [goal]);
  ok(ws, ["task", "run", `${key}-T1`, "--no-worktree"]);
  ok(ws, ["task", "complete", `${key}-T1`, "--outcome", "success", "--untested", "fixture", "--summary", "first done"]);
  ok(ws, ["task", "run", `${key}-T2`, "--no-worktree", "--instruction", "line one\nline two"]);
  ok(ws, ["log", "add", "a journal entry newer than both runs"]);
  const state = readStateFile(ws, goal);
  return { ws, repo, closedRun: state.tasks[`${key}-T1`].lastRunId, openRun: state.tasks[`${key}-T2`].lastRunId };
}

test("C3: log tail shows the newest run including an open one, skips log add entries, and truncates the brief", () => {
  const { ws, repo, closedRun, openRun } = twoRunWorkspace("CG");

  // 0.7 read only the index of completed runs: it showed the journal entry (no
  // events) or CG-T1's finished run while CG-T2 was the one in progress.
  const tail = ok(ws, ["log", "tail"]);
  assert.match(tail, new RegExp(`^# ${openRun} \\(open\\)$`, "m"));
  assert.match(tail, /run\.start/);
  assert.match(tail, /\d+ more lines — full brief: `awo log show /);

  const byTask = ok(ws, ["log", "tail", "--task", "CG-T1"]);
  assert.match(byTask, new RegExp(`^# ${closedRun}$`, "m"));
  assert.match(byTask, /run\.end/);
  assert.match(ok(ws, ["log", "tail", "CG-T1"]), new RegExp(`^# ${closedRun}$`, "m"));
  cleanup(ws, repo);
});

test("C3: log show accepts a task id, shows an open run's events, and suggests the newest runs", () => {
  const { ws, repo, openRun } = twoRunWorkspace("CH");

  const open = ok(ws, ["log", "show", openRun]);
  assert.match(open, new RegExp(`^# ${openRun} \\(open`, "m"));
  assert.match(open, /line two/, "log show prints the whole brief");
  assert.doesNotMatch(open, /more lines — full brief/);
  assert.match(ok(ws, ["log", "show", "CH-T2"]), /\(open/);
  assert.match(ok(ws, ["log", "show", "CH-T1"]), /first done/);

  for (let day = 1; day <= 6; day += 1) {
    ok(ws, ["log", "add", `old entry ${day}`, "--started", `2020-01-0${day}T00:00:00.000Z`, "--duration", "1"]);
  }
  const missing = awo(ws, ["log", "show", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Unknown run "nope"/);
  assert.match(missing.stderr, new RegExp(`Newest runs: .*${openRun}`));
  assert.doesNotMatch(missing.stderr, /2020-01-01/, "the oldest runs are not what anyone is looking for");
  cleanup(ws, repo);
});

test("C3: log list supports --limit, --json, --goal and --task", () => {
  const { ws, repo, closedRun } = twoRunWorkspace("CI");
  writeGoal(ws, { id: "CI-G2", tasks: [{ id: "CI-T9" }] });
  ok(ws, ["log", "add", "about T1", "--task", "CI-T1"]);
  ok(ws, ["log", "add", "about G2", "--goal", "CI-G2"]);

  assert.equal(ok(ws, ["log", "list", "--limit", "1"]).trim().split("\n").length, 1);
  const all = JSON.parse(ok(ws, ["log", "list", "--json"]));
  assert.equal(all.length, 4);

  const byTask = JSON.parse(ok(ws, ["log", "list", "--task", "CI-T1", "--json"]));
  assert.deepEqual(
    byTask.map((r: { runId: string }) => r.runId).sort(),
    [closedRun, all.find((r: { linkedTaskId?: string }) => r.linkedTaskId === "CI-T1").runId].sort()
  );
  const byGoal = JSON.parse(ok(ws, ["log", "list", "--goal", "CI-G1", "--json"]));
  assert.equal(byGoal.length, 2, "the goal's task run and the entry linked to its task");
  const g2 = JSON.parse(ok(ws, ["log", "list", "--goal", "CI-G2", "--json"]));
  assert.equal(g2.length, 1);
  assert.equal(g2[0].linkedGoalId, "CI-G2");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C4 — log add
// ---------------------------------------------------------------------------

test("C4: log add takes the summary positionally, by -m or from --note, and defaults the agent", () => {
  const { ws, repo } = makeWorkspace("CJ", [{ id: "CJ-G1", tasks: [{ id: "CJ-T1" }] }]);

  assert.match(ok(ws, ["log", "add", "Planned the work"]), /agent: human/);
  assert.match(ok(ws, ["log", "add", "-m", "with m"], { ...HUMAN_ENV, AWO_AGENT: "product-manager" }), /agent: product-manager/);
  assert.match(ok(ws, ["log", "add", "--note", "noted first", "noted second"], { ...process.env, AWO_HUMAN: "", AWO_AGENT: "", CLAUDECODE: "1" }), /agent: claude/);

  const rows = dayRows(ws).filter((r) => r.type === "run");
  assert.deepEqual(rows.map((r) => r.agent), ["human", "product-manager", "claude"]);
  const day = fs.readdirSync(path.join(ws, "logs")).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
  const runsMd = fs.readFileSync(path.join(ws, "logs", day, "runs.md"), "utf8");
  assert.match(runsMd, /### Summary of changes\nnoted first/);
  assert.match(runsMd, /- noted second/);

  const missing = awo(ws, ["log", "add", "--agent", "tech-lead"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /needs a summary/);
  cleanup(ws, repo);
});

test("C4: log add accepts --title/--slug and --status, links --task/--goal, and warns on a model as --agent", () => {
  const { ws, repo } = makeWorkspace("CK", [{ id: "CK-G1", tasks: [{ id: "CK-T1" }] }]);

  assert.match(ok(ws, ["log", "add", "titled", "--title", "Plan the Q3 work!"]), /_Plan-the-Q3-work/);
  assert.match(ok(ws, ["log", "add", "slugged", "--slug", "audit pass"]), /_audit-pass/);
  ok(ws, ["log", "add", "it broke", "--status", "failed"]);
  assert.equal(dayRows(ws).filter((r) => r.type === "run").at(-1)!.status, "failed");

  ok(ws, ["log", "add", "about the task", "--task", "CK-T1"]);
  const linked = dayRows(ws).filter((r) => r.type === "run").at(-1)!;
  assert.equal(linked.taskId, null, "a linked entry is still not a task run");
  assert.equal(linked.linkedTaskId, "CK-T1");
  assert.equal(linked.linkedGoalId, "CK-G1");

  const badTask = awo(ws, ["log", "add", "x", "--task", "CK-T9"]);
  assert.equal(badTask.code, 1);
  assert.match(badTask.stderr, /Unknown task "CK-T9"/);

  const model = awo(ws, ["log", "add", "ran it", "--agent", "opus"]);
  assert.equal(model.code, 0, "a warning, not a refusal");
  assert.match(model.stderr, /looks like a model name/);
  assert.match(model.stderr, /--model opus/);
  assert.equal(awo(ws, ["log", "add", "fine", "--agent", "tech-lead"]).stderr, "");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C5 — inventory cache and locateTask fast path
// ---------------------------------------------------------------------------

test("C5: the cached inventory sees edits within one process, and a task whose file name differs is still found", async () => {
  const { ws, repo } = makeWorkspace("CL", [
    { id: "CL-G1", tasks: [{ id: "CL-T1" }, { id: "CL-T2", file: "renamed-by-hand.md" }] },
  ]);
  const { findAllTasks, locateTask } = await load("tasks.js");

  assert.equal((await findAllTasks(ws)).find((t: any) => t.task.id === "CL-T1").task.name, "Task CL-T1");
  const file = path.join(ws, "goals", "CL-G1", "tasks", "CL-T1.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("name: Task CL-T1", "name: Renamed in place"));
  assert.equal((await findAllTasks(ws)).find((t: any) => t.task.id === "CL-T1").task.name, "Renamed in place");

  const hit = await locateTask(ws, "CL-T2");
  assert.equal(hit.goal.id, "CL-G1");
  assert.deepEqual(hit.goal.taskIds, ["CL-T1", "CL-T2"]);
  await assert.rejects(locateTask(ws, "CL-T9"), /Unknown task "CL-T9"/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C6 — context
// ---------------------------------------------------------------------------

test("C6: with every goal archived, context says nothing is live and ignores the archived tasks", () => {
  const goal = { id: "CM-G1", archived: true, tasks: [{ id: "CM-T1" }] };
  const { ws, repo } = makeWorkspace("CM", [goal]);

  const out = ok(ws, ["context"]);
  assert.match(out, /goals {9}none live/);
  assert.match(out, /\(1 archived/);
  assert.match(out, /NEXT {10}nothing live — start with `awo req new/);
  assert.doesNotMatch(out, /<goalId>/, "0.7 printed a literal placeholder here");
  assert.doesNotMatch(out, /CM-T1/, "an archived goal's todo task is not the next thing to do");
  cleanup(ws, repo);
});

test("C6: a review backlog and a goal awaiting a verdict outrank a stale run, which is labelled abandoned", () => {
  const g1 = { id: "CN-G1", tasks: [{ id: "CN-T1" }, { id: "CN-T2" }] };
  const g2 = { id: "CN-G2", governed: true, tasks: [{ id: "CN-T3" }] };
  const { ws, repo } = makeWorkspace("CN", [g1, g2]);

  // An open run whose last event is 30 hours old.
  const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const runId = `${old.slice(0, 19).replace(/[:.]/g, "-")}_CN-T1`;
  fs.mkdirSync(path.join(ws, "logs", old.slice(0, 10)), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "logs", old.slice(0, 10), "runs.jsonl"),
    JSON.stringify({ type: "event", runId, t: old, kind: "run.start", taskId: "CN-T1" }) + "\n"
  );
  const running = taskState("running", { lastRunId: runId, startedAt: old });

  writeState(ws, g1, { "CN-T1": running, "CN-T2": taskState("in-review") });
  writeState(ws, g2, { "CN-T3": taskState("in-review") });
  let out = ok(ws, ["context"]);
  assert.match(out, /CN-T1 running — stale \(abandoned\?\) no events for 30h/);
  assert.match(out, /CN-G2 qa-review — 0\/1 done, 1 in review — awaiting verdict/);
  assert.match(out, /NEXT {10}CN-G2 awaits a verdict \(1 in review\) — `awo goal readiness CN-G2`/);

  writeState(ws, g2, { "CN-T3": taskState("done") }, {
    qa: { briefRunId: "r", briefRecordedAt: "t", verdict: "pass", summary: "ok", verdictRunId: "v", verdictRecordedAt: "t", verdictBy: "lead", model: null },
  });
  out = ok(ws, ["context"]);
  assert.match(out, /NEXT {10}verify CN-T2 — `awo task verify CN-T2`/);

  writeState(ws, g1, { "CN-T1": running, "CN-T2": taskState("done") });
  out = ok(ws, ["context"]);
  assert.match(out, /NEXT {10}CN-T1's run looks abandoned \(no events for 30h\) — inspect `awo log tail --task CN-T1`/);
  assert.doesNotMatch(out, /CN-T1 is running/);
  cleanup(ws, repo);
});

test("C6: context stats count worker runs and journal entries apart, and --json mirrors the digest", () => {
  const goal = { id: "CO-G1", tasks: [{ id: "CO-T1" }] };
  const { ws, repo } = makeWorkspace("CO", [goal, { id: "CO-G2", archived: true, tasks: [{ id: "CO-T2" }] }]);
  ok(ws, ["task", "run", "CO-T1", "--no-worktree"]);
  ok(ws, ["task", "complete", "CO-T1", "--outcome", "failed", "--summary", "red"]);
  ok(ws, ["log", "add", "planning", "--duration", "60"]);
  ok(ws, ["log", "add", "intake", "--duration", "120"]);

  const out = ok(ws, ["context"]);
  assert.match(out, /history {7}1 runs · 0% success · median \d+s · 2 journal entries · median 1m30s/);
  assert.match(out, /tasks {9}blocked 1$/m, "only live goals' tasks are counted");

  const j = JSON.parse(ok(ws, ["context", "--json"]));
  assert.equal(j.stats.workerRuns, 1);
  assert.equal(j.stats.journalEntries, 2);
  assert.equal(j.stats.medianJournalDurationSec, 90);
  assert.deepEqual(j.goals.map((g: { id: string }) => g.id), ["CO-G1"]);
  assert.equal(j.archivedGoals, 1);
  assert.equal(j.recent.length, 3);
  assert.equal(j.snapshot, undefined);
  assert.match(j.next, /unblock CO-T1/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// C7 — malformed task files
// ---------------------------------------------------------------------------

test("C7: a malformed task file is skipped with one warning instead of breaking every command", async () => {
  const goal = {
    id: "CP-G1",
    tasks: [
      { id: "CP-T1" },
      { id: "CP-T2", raw: "id: CP-T2\nname: Missing its goal\n" },
      { id: "CP-T3", kind: "documentation" },
    ],
  };
  const { ws, repo } = makeWorkspace("CP", [goal]);

  const context = awo(ws, ["context"]);
  assert.equal(context.code, 0, context.stderr);
  assert.equal(context.stderr.match(/skipped malformed task file/g)?.length, 1, context.stderr);
  assert.match(context.stderr, /goals\/CP-G1\/tasks\/CP-T2\.md is missing a `goalId:`/);
  assert.match(context.stderr, /kind "documentation", which is not a task kind/);

  const list = awo(ws, ["task", "list"]);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /CP-T1/);
  assert.match(list.stdout, /CP-T3/, "an unknown kind is still read, as implementation");
  assert.doesNotMatch(list.stdout, /CP-T2/);
  assert.equal(awo(ws, ["goal", "list"]).code, 0);

  // The broken task is named for what it is, not "unknown".
  const shown = awo(ws, ["task", "show", "CP-T2"]);
  assert.equal(shown.code, 1);
  assert.match(shown.stderr, /missing a `goalId:`/);

  const { listTaskParseErrors } = await load("tasks.js");
  const problems = await listTaskParseErrors(ws);
  assert.deepEqual(
    problems.map((p: { id: string; severity: string }) => [p.id, p.severity]),
    [["CP-T2", "error"], ["CP-T3", "warning"]]
  );

  // The state writer must not read the unparseable task as orphaned and drop it.
  writeState(ws, goal, { "CP-T1": taskState("todo"), "CP-T2": taskState("in-review", { attempts: 3 }) });
  const write = awo(ws, ["task", "status", "CP-T1", "cancelled"]);
  assert.equal(write.code, 1);
  assert.match(write.stderr, /missing a `goalId:`/);
  assert.equal(readStateFile(ws, goal).tasks["CP-T2"].attempts, 3);
  cleanup(ws, repo);
});
