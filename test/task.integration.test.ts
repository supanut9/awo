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
  tasks: Record<string, { status: string; lastRunOutcome: string | null; attempts: number }>;
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
