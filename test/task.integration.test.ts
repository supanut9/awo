import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/task.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A workspace with one goal and two tasks, T2 depending on T1. */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-task-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TEST"], { cwd: dir });

  // A local repo to satisfy `targets` validation.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: dir });

  const goalDir = path.join(dir, "goals", "TEST-G1-demo");
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(goalDir, "goal.md"),
    `---\nid: TEST-G1\ntitle: Demo goal\nstatus: planning\n---\n\n## Objective\nDemo.\n`
  );
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T1-first.md"),
    `---\nid: TEST-T1\ngoalId: TEST-G1\nname: First task\ntargets: [api]\ndependsOn: []\nagent: software-engineer\nstatus: todo\n---\n\n## Objective\nDo the first thing.\n`
  );
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T2-second.md"),
    `---\nid: TEST-T2\ngoalId: TEST-G1\nname: Second task\ntargets: [api]\ndependsOn: [TEST-T1]\nstatus: todo\n---\n\n## Objective\nDo the second thing.\n`
  );

  return dir;
}

function readState(ws: string): {
  rev: number;
  goalStatus: string;
  tasks: Record<
    string,
    { status: string; lastRunOutcome: string | null; attempts: number; lastRunId: string | null }
  >;
} {
  return JSON.parse(
    fs.readFileSync(path.join(ws, "goals", "TEST-G1-demo", "state.json"), "utf8")
  );
}

test("task list reads authored frontmatter status before any state exists", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["task", "list"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /TEST-T1\ttodo/);
  assert.match(out.stdout, /TEST-T2\ttodo/);
  assert.ok(
    !fs.existsSync(path.join(ws, "goals", "TEST-G1-demo", "state.json")),
    "reading must not create state.json"
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("pre-0.0.2 task files authored with the old status vocabulary still load", () => {
  const ws = makeWorkspace();
  const tasksDir = path.join(ws, "goals", "TEST-G1-demo", "tasks");

  // The old vocabulary was pending|running|success|failed|skipped (§7.4).
  fs.writeFileSync(
    path.join(tasksDir, "TEST-T9-legacy.md"),
    `---\nid: TEST-T9\ngoalId: TEST-G1\nname: Legacy task\ntargets: [api]\nstatus: pending\n---\n\n## Objective\nx\n`
  );
  fs.writeFileSync(
    path.join(tasksDir, "TEST-T8-legacy-done.md"),
    `---\nid: TEST-T8\ngoalId: TEST-G1\nname: Legacy done\ntargets: [api]\nstatus: success\n---\n\n## Objective\nx\n`
  );

  const out = awo(ws, ["task", "list"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /TEST-T9\ttodo/, "pending must translate to todo");
  assert.match(out.stdout, /TEST-T8\tdone/, "success must translate to done");

  // A genuinely unknown status is still an error, and names what it saw.
  fs.writeFileSync(
    path.join(tasksDir, "TEST-T7-bogus.md"),
    `---\nid: TEST-T7\ngoalId: TEST-G1\nname: Bogus\nstatus: wat\n---\n\nx\n`
  );
  const bad = awo(ws, ["task", "list"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /has status "wat"/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a full run: open -> events -> complete, writing state, events, index and detail", () => {
  const ws = makeWorkspace();

  const started = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /TEST-T1 is running/);

  let state = readState(ws);
  assert.equal(state.tasks["TEST-T1"].status, "running");
  assert.equal(state.goalStatus, "in-progress");
  assert.equal(state.tasks["TEST-T1"].attempts, 1);

  const runId = JSON.parse(
    fs.readFileSync(path.join(ws, "goals", "TEST-G1-demo", "state.json"), "utf8")
  ).tasks["TEST-T1"].lastRunId as string;

  assert.equal(awo(ws, ["task", "event", "TEST-T1", "step.start", "--label", "Edit files"]).code, 0);
  assert.equal(
    awo(ws, ["task", "event", "TEST-T1", "repo.diff", "--data", '{"repo":"api","files":2}']).code,
    0
  );

  const done = awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--summary", "Did it."]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /task is now done/);

  state = readState(ws);
  assert.equal(state.tasks["TEST-T1"].status, "done");
  assert.equal(state.tasks["TEST-T1"].lastRunOutcome, "success");

  // Events file: run.start, step.start, repo.diff, run.end
  const eventsPath = path.join(ws, "logs", "runs", runId.slice(0, 10), `${runId}.events.jsonl`);
  const kinds = fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ["run.start", "step.start", "repo.diff", "run.end"]);

  // Index line + detail file
  const index = JSON.parse(fs.readFileSync(path.join(ws, "logs", "runs.jsonl"), "utf8").trim());
  assert.equal(index.runId, runId);
  assert.equal(index.status, "success");
  assert.deepEqual(index.reposChanged, ["api"], "reposChanged is derived from repo.diff events");

  const detail = fs.readFileSync(path.join(ws, "logs", "runs", runId.slice(0, 10), `${runId}.md`), "utf8");
  assert.match(detail, /^---\n/);
  assert.match(detail, /taskId: TEST-T1/);
  assert.match(detail, /Did it\./);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("a task with unmet dependencies is blocked rather than run", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["task", "run", "TEST-T2"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /unmet dependencies: TEST-T1 \(todo\)/);
  assert.equal(readState(ws).tasks["TEST-T2"].status, "blocked");
  assert.equal(readState(ws).goalStatus, "blocked");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("dependencies clear once the dependency is done", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);

  const out = awo(ws, ["task", "run", "TEST-T2"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readState(ws).tasks["TEST-T2"].status, "running");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a failed run blocks the task and records the outcome", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const out = awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "tests red"]);
  assert.equal(out.code, 0, out.stderr);

  const s = readState(ws).tasks["TEST-T1"];
  assert.equal(s.status, "blocked");
  assert.equal(s.lastRunOutcome, "failed");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("--gate routes a success to in-review, and verify closes the QA gate", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--gate"]);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "in-review");
  assert.equal(readState(ws).goalStatus, "qa-review");

  const rejected = awo(ws, ["task", "verify", "TEST-T1", "--reject", "--reason", "missing case"]);
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "todo");

  awo(ws, ["task", "run", "TEST-T1"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--gate"]);
  assert.equal(awo(ws, ["task", "verify", "TEST-T1"]).code, 0);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "done");
  assert.equal(readState(ws).tasks["TEST-T1"].attempts, 2);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("cancelled is human-only and reachable from any live state", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["task", "status", "TEST-T1", "cancelled"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "cancelled");

  // A cancelled task cannot be run without being revived first.
  const blocked = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /is cancelled/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("invalid transitions are rejected with the allowed set named", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["task", "status", "TEST-T1", "in-review"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /Invalid transition for TEST-T1: "todo" -> "in-review"/);
  assert.match(out.stderr, /may move to/);

  const bogus = awo(ws, ["task", "status", "TEST-T1", "finished"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /Unknown status "finished"/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a task targeting an unlinked repo fails fast before any state change", () => {
  const ws = makeWorkspace();
  const goalDir = path.join(ws, "goals", "TEST-G1-demo");
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T3-bad.md"),
    `---\nid: TEST-T3\ngoalId: TEST-G1\nname: Bad targets\ntargets: [nope]\nstatus: todo\n---\n\n## Objective\nx\n`
  );

  const out = awo(ws, ["task", "run", "TEST-T3"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /targets repos not in the manifest: nope/);
  assert.ok(
    !fs.existsSync(path.join(goalDir, "state.json")),
    "target validation must run before any state is written"
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a second run cannot open while one is already running", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /already running/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("events cannot be recorded without an open run", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["task", "event", "TEST-T1", "note", "--message", "hi"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /has no open run/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("state.json rev increments on every write and never leaves a .tmp behind", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const rev1 = readState(ws).rev;
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);
  const rev2 = readState(ws).rev;
  assert.ok(rev2 > rev1, `rev must increase (${rev1} -> ${rev2})`);

  const leftovers = fs
    .readdirSync(path.join(ws, "goals", "TEST-G1-demo"))
    .filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "atomic write must not leave .tmp files");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("log list, show and tail read back what a run wrote", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  awo(ws, ["task", "event", "TEST-T1", "test", "--data", '{"repo":"api","pass":10,"fail":0}']);
  // reposChanged is derived from repo.diff only — a test event doesn't mean the
  // repo was modified — so emit one to exercise the --repo filter.
  awo(ws, ["task", "event", "TEST-T1", "repo.diff", "--data", '{"repo":"api","files":1}']);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--summary", "green"]);

  const list = awo(ws, ["log", "list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /_TEST-T1\tsuccess/);

  const filtered = awo(ws, ["log", "list", "--status", "failed"]);
  assert.match(filtered.stdout, /No runs match/);

  const byRepo = awo(ws, ["log", "list", "--repo", "api"]);
  assert.match(byRepo.stdout, /_TEST-T1/);

  const tail = awo(ws, ["log", "tail"]);
  assert.equal(tail.code, 0, tail.stderr);
  assert.match(tail.stdout, /run\.start/);
  assert.match(tail.stdout, /test  repo=api pass=10 fail=0/);
  assert.match(tail.stdout, /run\.end/);

  const runId = readStateRunId(ws);
  const show = awo(ws, ["log", "show", runId]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /green/);

  const missing = awo(ws, ["log", "show", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Unknown run "nope"/);
  fs.rmSync(ws, { recursive: true, force: true });
});

function readStateRunId(ws: string): string {
  return JSON.parse(
    fs.readFileSync(path.join(ws, "goals", "TEST-G1-demo", "state.json"), "utf8")
  ).tasks["TEST-T1"].lastRunId as string;
}

test("log add records work that is not a task run, with taskId null", () => {
  const ws = makeWorkspace();

  const out = awo(ws, [
    "log", "add", "--label", "intake", "--agent", "product-manager",
    "--model", "codex", "--summary", "Refined the requirement.",
    "--prompt", "capture the FAQ ask", "--note", "two questions open",
  ]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /recorded \d{4}-\d{2}-\d{2}T.*_intake/);

  const index = JSON.parse(fs.readFileSync(path.join(ws, "logs", "runs.jsonl"), "utf8").trim());
  assert.equal(index.taskId, null, "ad-hoc work has no task (§7.3)");
  assert.equal(index.agent, "product-manager");
  assert.equal(index.status, "success");

  const detail = fs.readFileSync(path.join(ws, "logs", "runs", index.runId.slice(0, 10), `${index.runId}.md`), "utf8");
  assert.match(detail, /taskId: null/);
  assert.match(detail, /Refined the requirement\./);
  assert.match(detail, /two questions open/);

  // It shows up in the same index the rest of the log tooling reads.
  assert.match(awo(ws, ["log", "list"]).stdout, /_intake\tsuccess/);
  assert.match(awo(ws, ["log", "show", index.runId]).stdout, /Refined the requirement/);

  // A supplied start time is honoured, and drives the runId.
  const dated = awo(ws, [
    "log", "add", "--agent", "tech-lead", "--summary", "planned",
    "--started", "2026-01-02T03:04:05.000Z", "--duration", "60",
  ]);
  assert.match(dated.stdout, /2026-01-02T03-04-05-000Z_adhoc/);

  const bad = awo(ws, ["log", "add", "--agent", "x", "--summary", "y", "--started", "not-a-date"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /must be an ISO timestamp/);

  const badOutcome = awo(ws, ["log", "add", "--agent", "x", "--summary", "y", "--outcome", "great"]);
  assert.equal(badOutcome.code, 1);
  assert.match(badOutcome.stderr, /Unknown outcome "great"/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("task run resolves a model from the agent's tier, and the manifest can override it", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const setModels = (models: unknown): void => {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.models = models;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  };

  // TEST-T1 has `agent: software-engineer`, which the shipped agent file marks
  // `tier: worker`. With no policy, the built-in fallback applies.
  let out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /agent:\s+software-engineer \(worker\)/);
  assert.match(out.stdout, /model:\s+claude:sonnet/);
  assert.match(out.stdout, /hand to: claude --model sonnet/);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);

  // A tier-level policy wins over the fallback.
  setModels({ worker: { runtime: "codex", model: "gpt-5-codex" }, orchestrator: { runtime: "claude", model: "opus" } });
  out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.match(out.stdout, /model:\s+codex:gpt-5-codex/);
  assert.match(out.stdout, /hand to: codex exec -m gpt-5-codex/);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);

  // byRole is more specific than the tier default.
  setModels({
    worker: { runtime: "codex", model: "gpt-5-codex" },
    byRole: { "software-engineer": { runtime: "claude", model: "opus" } },
  });
  out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.match(out.stdout, /model:\s+claude:opus/);

  // The tier and model land in the run.start event, so the log records what ran.
  const runId = readState(ws).tasks["TEST-T1"].lastRunId!;
  const events = fs
    .readFileSync(path.join(ws, "logs", "runs", runId.slice(0, 10), `${runId}.events.jsonl`), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].kind, "run.start");
  assert.equal(events[0].tier, "worker");
  assert.equal(events[0].model, "claude:opus");

  // An unassigned task falls back to the worker tier rather than erroring.
  const goalDir = path.join(ws, "goals", "TEST-G1-demo");
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T5-noagent.md"),
    `---\nid: TEST-T5\ngoalId: TEST-G1\nname: No agent\ntargets: [api]\nstatus: todo\n---\n\nx\n`
  );
  out = awo(ws, ["task", "run", "TEST-T5"]);
  assert.match(out.stdout, /agent:\s+unassigned \(worker\)/);
  fs.rmSync(ws, { recursive: true, force: true });
});
