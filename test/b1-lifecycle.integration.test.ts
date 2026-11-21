import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/b1-lifecycle.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const moduleUrl = (name: string) => pathToFileURL(path.join(REPO_ROOT, "dist", name)).href;

/** An agent runtime, as `npm test`'s AWO_HUMAN=1 would otherwise hide it. */
const AGENT_ENV = { ...process.env, AWO_HUMAN: "", CLAUDECODE: "1" };

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env, stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function ok(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = awo(cwd, args, env);
  assert.equal(r.code, 0, `awo ${args.join(" ")} failed:\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

const GOAL_DIR = path.join("goals", "TEST-G1-demo");

function taskFile(id: string, fields: Record<string, string>, body: string): string {
  const fm = Object.entries({ id, goalId: "TEST-G1", ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}`;
}

/**
 * One goal, T1 and T2 (T2 depends on T1), targeting `api`. With `git`, `api` is a
 * repository with a passing `t.sh`, so runs get real worktrees and measurements.
 */
function makeWorkspace(options: { git?: boolean } = {}): { ws: string; repo: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-b1-"));
  ok(ws, ["init", "--key", "TEST"]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-b1-repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  if (options.git) {
    fs.writeFileSync(path.join(repo, "t.sh"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(repo, "t.sh"), 0o755);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "awo-test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
  }
  ok(ws, ["connect", repo, "--name", "api"]);

  const goalDir = path.join(ws, GOAL_DIR);
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goalDir, "goal.md"), `---\nid: TEST-G1\ntitle: Demo goal\n---\n\n## Objective\nDemo.\n`);
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T1-first.md"),
    taskFile("TEST-T1", { name: "First", targets: "[api]", dependsOn: "[]", agent: "software-engineer", status: "todo" }, "## Objective\nDo the first thing.\n")
  );
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T2-second.md"),
    taskFile("TEST-T2", { name: "Second", targets: "[api]", dependsOn: "[TEST-T1]", status: "todo" }, "## Objective\nDo the second thing.\n")
  );
  return { ws, repo };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

type TaskStateJson = Record<string, unknown> & {
  status: string;
  attempts: number;
  lastRunId: string | null;
  blockedReason: string | null;
  owner?: Record<string, unknown> | null;
  transitions?: Array<Record<string, unknown>>;
};

function stateAt(ws: string, goalDir = GOAL_DIR): Record<string, unknown> & { tasks: Record<string, TaskStateJson> } {
  return JSON.parse(fs.readFileSync(path.join(ws, goalDir, "state.json"), "utf8"));
}

function taskState(ws: string, id: string, goalDir = GOAL_DIR): TaskStateJson {
  return stateAt(ws, goalDir).tasks[id];
}

function runEvents(ws: string, runId: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(ws, "logs", runId.slice(0, 10), "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.type === "event" && l.runId === runId);
}

function writeState(ws: string, tasks: Record<string, Partial<TaskStateJson>>, goalDir = GOAL_DIR): void {
  const base = { lastRunOutcome: null, lastRunId: null, startedAt: null, finishedAt: null, attempts: 0, worktree: null, blockedReason: null };
  fs.writeFileSync(
    path.join(ws, goalDir, "state.json"),
    JSON.stringify({
      rev: 1,
      goalId: "TEST-G1",
      goalStatus: "planning",
      updatedAt: new Date().toISOString(),
      tasks: Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, { ...base, ...t }])),
    }, null, 2)
  );
}

// ---------------------------------------------------------------------------
// B1-1 — the dependency gate and blocked tasks
// ---------------------------------------------------------------------------

test("a blocked task is retried by task run: attempt+1, reason cleared", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"]);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "tests red"]);
  assert.equal(taskState(ws, "TEST-T1").status, "blocked");

  // 0.7 refused this (`blocked -> running` was not in the table) and agents typed
  // `task status <id> todo` first, 33 times in the real logs.
  ok(ws, ["task", "run", "TEST-T1"]);
  const t1 = taskState(ws, "TEST-T1");
  assert.equal(t1.status, "running");
  assert.equal(t1.attempts, 2);
  assert.equal(t1.blockedReason, null);
  cleanup(ws, repo);
});

test("a task the old gate marked blocked runs once its dependency lands", () => {
  const { ws, repo } = makeWorkspace();
  writeState(ws, {
    "TEST-T1": { status: "in-review", lastRunOutcome: "success", attempts: 1 },
    "TEST-T2": { status: "blocked", blockedReason: "unmet dependencies: TEST-T1 (todo)" },
  });
  ok(ws, ["task", "run", "TEST-T2"]);
  assert.equal(taskState(ws, "TEST-T2").status, "running");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-2 — humans park and restore
// ---------------------------------------------------------------------------

test("humans park work with a required reason, and restore cancelled work", () => {
  const { ws, repo } = makeWorkspace();
  const bare = awo(ws, ["task", "status", "TEST-T1", "blocked"]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /needs a reason/);
  assert.match(bare.stderr, /awo task status TEST-T1 blocked --reason/);

  // `--why` is the hidden spelling agents reach for.
  ok(ws, ["task", "status", "TEST-T1", "blocked", "--why", "waiting on the vendor sandbox"]);
  assert.equal(taskState(ws, "TEST-T1").status, "blocked");
  assert.equal(taskState(ws, "TEST-T1").blockedReason, "waiting on the vendor sandbox");
  ok(ws, ["task", "status", "TEST-T1", "todo"]);
  assert.equal(taskState(ws, "TEST-T1").blockedReason, null);

  // in-review work can be parked too.
  ok(ws, ["task", "run", "TEST-T1"]);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);
  ok(ws, ["task", "status", "TEST-T1", "blocked", "--reason", "awaiting a security review"]);
  assert.equal(taskState(ws, "TEST-T1").status, "blocked");

  // Cancelled is no longer a one-way door, and `task run` names the way back.
  ok(ws, ["task", "status", "TEST-T2", "cancelled", "--reason", "folded into T1"]);
  const refused = awo(ws, ["task", "run", "TEST-T2"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /awo task status TEST-T2 todo/);
  ok(ws, ["task", "status", "TEST-T2", "todo"]);
  assert.equal(taskState(ws, "TEST-T2").status, "todo");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-3 — the transition audit
// ---------------------------------------------------------------------------

test("every lifecycle move is recorded with who, why and which run", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"], AGENT_ENV);
  const runId = taskState(ws, "TEST-T1").lastRunId!;
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"], AGENT_ENV);
  ok(ws, ["task", "verify", "TEST-T1", "--reject", "--why", "missing the empty-list case"]);

  const moves = taskState(ws, "TEST-T1").transitions!;
  assert.deepEqual(
    moves.map((m) => [m.from, m.to, m.actor, m.by, m.runId]),
    [
      ["todo", "running", "runner", "claude", runId],
      ["running", "in-review", "runner", "claude", runId],
      ["in-review", "todo", "qa", "human", runId],
    ]
  );
  assert.equal(moves[2].reason, "missing the empty-list case");
  assert.ok(moves.every((m) => typeof m.at === "string"));

  // The rejection reaches the next round instead of dying in the reviewer's terminal.
  const next = ok(ws, ["task", "run", "TEST-T1"]);
  assert.match(next, /rejected in review: missing the empty-list case/);
  const start = runEvents(ws, taskState(ws, "TEST-T1").lastRunId!).find((e) => e.kind === "run.start")!;
  assert.equal(start.rejectedBecause, "missing the empty-list case");

  // Cancelling a running task says so in the abandoned run's own stream.
  const open = taskState(ws, "TEST-T1").lastRunId!;
  ok(ws, ["task", "status", "TEST-T1", "cancelled", "--reason", "superseded by a redesign"]);
  const cancelled = taskState(ws, "TEST-T1");
  assert.equal(cancelled.owner, null);
  assert.equal(cancelled.transitions!.at(-1)!.reason, "superseded by a redesign");
  assert.ok(
    runEvents(ws, open).some((e) => e.kind === "note" && e.category === "cancelled" && e.label === "superseded by a redesign")
  );
  cleanup(ws, repo);
});

test("moving a running task by hand points at task complete, not an illegal move", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"]);
  const out = awo(ws, ["task", "status", "TEST-T1", "todo"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /awo task complete TEST-T1 --outcome failed --summary/);
  assert.equal(taskState(ws, "TEST-T1").status, "running");
  cleanup(ws, repo);
});

test("transition history keeps the newest 50 moves", async () => {
  const { applyTransition, newTaskState } = await import(moduleUrl("state.js"));
  const state = { rev: 0, goalId: "G", goalStatus: "planning", updatedAt: "", tasks: { T: newTaskState() } };
  for (let i = 0; i < 60; i++) {
    applyTransition(state, "T", i % 2 === 0 ? "blocked" : "todo", "human", { by: "human", reason: `move ${i}` });
  }
  const moves = state.tasks.T.transitions;
  assert.equal(moves.length, 50);
  assert.equal(moves.at(-1).reason, "move 59");
  assert.equal(moves[0].reason, "move 10");
  assert.throws(() => applyTransition(state, "T", "done", "human"), /Invalid transition/);
});

// ---------------------------------------------------------------------------
// B1-4 — repair rounds and idempotent task run
// ---------------------------------------------------------------------------

test("--reopen opens a repair round on reviewed work as a new, recorded run", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"]);
  const first = taskState(ws, "TEST-T1").lastRunId!;
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);

  const plain = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /is in review/);
  assert.match(plain.stderr, /awo task run TEST-T1 --reopen --reason/);
  assert.match(awo(ws, ["task", "run", "TEST-T1", "--reopen"]).stderr, /say what it repairs/);

  const reopened = ok(ws, ["task", "run", "TEST-T1", "--reopen", "--reason", "handle the timeout path"]);
  assert.match(reopened, /reopened: handle the timeout path/);
  const t1 = taskState(ws, "TEST-T1");
  assert.equal(t1.status, "running");
  assert.equal(t1.attempts, 2);
  assert.notEqual(t1.lastRunId, first);
  const move = t1.transitions!.at(-1)!;
  assert.deepEqual([move.from, move.to, move.reason], ["in-review", "running", "handle the timeout path"]);
  const start = runEvents(ws, t1.lastRunId!).find((e) => e.kind === "run.start")!;
  assert.equal(start.reopenReason, "handle the timeout path");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-5 — unwritten bodies
// ---------------------------------------------------------------------------

test("task run refuses a body that is still the task-new template unless briefed", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "new", "--goal", "TEST-G1", "--name", "Unwritten", "--targets", "api"]);
  ok(ws, ["task", "new", "--goal", "TEST-G1", "--name", "Also unwritten", "--targets", "api"]);
  const ids = fs.readdirSync(path.join(ws, GOAL_DIR, "tasks")).filter((f) => !f.startsWith("TEST-T1-") && !f.startsWith("TEST-T2-"));
  assert.equal(ids.length, 2);
  const [a, b] = ids.map((f) => /^(TEST-T\d+)/.exec(f)![1]).sort();

  const refused = awo(ws, ["task", "run", a]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /still the `awo task new` template/);
  assert.match(refused.stderr, /awo task new --body-file/);
  assert.match(refused.stderr, /--instruction/);
  const untouched = fs.existsSync(path.join(ws, GOAL_DIR, "state.json")) ? taskState(ws, a) : undefined;
  assert.ok(!untouched || (untouched.status === "todo" && untouched.attempts === 0), "a refused run must not change state");

  ok(ws, ["task", "run", a, "--instruction", "Add the health endpoint described in the goal."]);
  ok(ws, ["task", "run", b, "--allow-empty-body"]);
  assert.equal(taskState(ws, a).status, "running");
  assert.equal(taskState(ws, b).status, "running");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-6 — run ownership; tasks without targets
// ---------------------------------------------------------------------------

test("the run owner is recorded at start and dropped when the run closes", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"], AGENT_ENV);
  const t1 = taskState(ws, "TEST-T1");
  const owner = t1.owner!;
  assert.equal(owner.runId, t1.lastRunId);
  assert.equal(owner.actor, "claude");
  assert.equal(owner.host, os.hostname());
  assert.equal(typeof owner.pid, "number");
  assert.equal(owner.startedAt, owner.heartbeatAt);

  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "x"]);
  assert.equal(taskState(ws, "TEST-T1").owner, null);
  cleanup(ws, repo);
});

test("an investigation task with no targets opens a run without worktrees", () => {
  const { ws, repo } = makeWorkspace({ git: true });
  fs.writeFileSync(
    path.join(ws, GOAL_DIR, "tasks", "TEST-T3-look.md"),
    taskFile("TEST-T3", { name: "Find out", targets: "[]", dependsOn: "[]", kind: "investigation", status: "todo" }, "## Objective\nFind out why the export is slow.\n")
  );
  const out = ok(ws, ["task", "run", "TEST-T3"]);
  assert.match(out, /no repository — this task has no targets/);
  const t3 = taskState(ws, "TEST-T3");
  assert.equal(t3.status, "running");
  assert.equal(t3.worktree, null);
  assert.deepEqual(runEvents(ws, t3.lastRunId!).find((e) => e.kind === "run.start")!.checkouts, []);
  assert.ok(!fs.existsSync(path.join(ws, "repos", ".worktrees", "api", "TEST-T3")));
  ok(ws, ["task", "complete", "TEST-T3", "--outcome", "success", "--summary", "An N+1 query in the exporter."]);
  assert.equal(taskState(ws, "TEST-T3").status, "done");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-7 — intended vs executed model
// ---------------------------------------------------------------------------

test("run.start records the intended model and who executed it; --model/--runtime override", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"], AGENT_ENV);
  let start = runEvents(ws, taskState(ws, "TEST-T1").lastRunId!).find((e) => e.kind === "run.start")!;
  assert.equal(typeof start.intendedModel, "string");
  assert.equal(start.model, start.intendedModel, "`model` stays for older readers");
  assert.equal(start.executedBy, "claude");
  assert.equal(start.executedModel, undefined);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "x"]);

  const bad = awo(ws, ["task", "run", "TEST-T1", "--runtime", "codex"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /needs --model too/);

  const out = ok(ws, ["task", "run", "TEST-T1", "--runtime", "codex", "--model", "gpt-5"]);
  assert.match(out, /runs as: codex:gpt-5/);
  assert.match(out, /hand to: codex exec -m gpt-5/);
  start = runEvents(ws, taskState(ws, "TEST-T1").lastRunId!).find((e) => e.kind === "run.start")!;
  assert.equal(start.executedModel, "codex:gpt-5");
  assert.equal(start.executedBy, "codex");
  assert.notEqual(start.intendedModel, "codex:gpt-5");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-8 — briefs recorded once per content
// ---------------------------------------------------------------------------

test("an unchanged brief is recorded once, then by reference", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "run", "TEST-T1"]);
  const first = taskState(ws, "TEST-T1").lastRunId!;
  const firstBrief = runEvents(ws, first).find((e) => e.kind === "brief")!;
  assert.match(String(firstBrief.text), /Do the first thing/);
  assert.equal(typeof firstBrief.briefHash, "string");
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "x"]);

  ok(ws, ["task", "run", "TEST-T1"]);
  const second = taskState(ws, "TEST-T1").lastRunId!;
  const secondBrief = runEvents(ws, second).find((e) => e.kind === "brief")!;
  assert.equal(secondBrief.text, undefined);
  assert.equal(secondBrief.sameAs, first);
  assert.equal(secondBrief.briefHash, firstBrief.briefHash);

  // Re-typing `task run` on the open run follows the pointer and prints the text.
  const again = ok(ws, ["task", "run", "TEST-T1"]);
  assert.match(again, new RegExp(`already running — run ${second}`));
  assert.match(again, new RegExp(`brief unchanged since run ${first}`));
  assert.match(again, /Do the first thing/);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "failed", "--summary", "x"]);

  // A changed body is a new brief, recorded in full.
  const file = path.join(ws, GOAL_DIR, "tasks", "TEST-T1-first.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Do the first thing.", "Do the first thing, paginated."));
  ok(ws, ["task", "run", "TEST-T1"]);
  const third = runEvents(ws, taskState(ws, "TEST-T1").lastRunId!).find((e) => e.kind === "brief")!;
  assert.match(String(third.text), /paginated/);
  assert.equal(third.sameAs, undefined);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-9 — task resume
// ---------------------------------------------------------------------------

test("task resume re-briefs a fresh worker into the open run and takes ownership", () => {
  const { ws, repo } = makeWorkspace({ git: true });
  ok(ws, ["task", "run", "TEST-T1"]);
  const runId = taskState(ws, "TEST-T1").lastRunId!;
  ok(ws, ["task", "event", "TEST-T1", "test", "--run", "./t.sh"]);
  ok(ws, ["task", "event", "TEST-T1", "note", "--label", "schema drafted"]);
  const before = taskState(ws, "TEST-T1").owner!;

  const out = ok(ws, ["task", "resume", "TEST-T1"], AGENT_ENV);
  assert.match(out, new RegExp(`resuming run ${runId}`));
  assert.match(out, /held by human/);
  assert.match(out, /work in: repos\/\.worktrees\/api\/TEST-T1 {2}\(api on feature\/TEST-T1\)/);
  assert.match(out, /schema drafted/);
  assert.match(out, /api: `\.\/t\.sh` exit 0/);
  assert.match(out, /Do the first thing/);
  assert.match(out, /hand to: (?:cd "[^"]+" && )?claude .*--add-dir/);

  const t1 = taskState(ws, "TEST-T1");
  assert.equal(t1.status, "running");
  assert.equal(t1.lastRunId, runId, "resume continues the run; it does not open another");
  assert.equal(t1.attempts, 1);
  assert.equal(t1.owner!.actor, "claude");
  assert.equal(t1.owner!.startedAt, before.startedAt);
  assert.ok(String(t1.owner!.heartbeatAt) >= String(before.heartbeatAt));
  assert.equal(t1.transitions!.at(-1)!.reason, "resumed by claude");
  const resume = runEvents(ws, runId).find((e) => e.kind === "run.resume")!;
  assert.equal(resume.actor, "claude");
  assert.equal((resume.previousOwner as Record<string, unknown>).actor, "human");
  cleanup(ws, repo);
});

test("task resume without an open run says what to run instead", () => {
  const { ws, repo } = makeWorkspace();
  const fresh = awo(ws, ["task", "resume", "TEST-T1"]);
  assert.equal(fresh.code, 1);
  assert.match(fresh.stderr, /no open run to resume \(status: todo\)/);
  assert.match(fresh.stderr, /awo task run TEST-T1/);

  ok(ws, ["task", "run", "TEST-T1"]);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);
  const reviewed = awo(ws, ["task", "resume", "TEST-T1"]);
  assert.equal(reviewed.code, 1);
  assert.match(reviewed.stderr, /awo task recheck TEST-T1/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-11 — archived goals
// ---------------------------------------------------------------------------

test("an archived goal is read-only until restored, and keeps its frozen status", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "status", "TEST-T1", "cancelled", "--reason", "dropped"]);
  ok(ws, ["task", "status", "TEST-T2", "cancelled", "--reason", "dropped"]);
  ok(ws, ["goal", "archive", "TEST-G1"]);
  const archivedDir = path.join("goals", "archive", "TEST-G1");
  const frozen = stateAt(ws, archivedDir);
  assert.equal(frozen.archivedStatus, "cancelled");
  assert.equal(typeof frozen.archivedAt, "string");

  for (const args of [
    ["task", "run", "TEST-T1"],
    ["task", "status", "TEST-T1", "todo"],
    ["task", "resume", "TEST-T1"],
  ]) {
    const out = awo(ws, args);
    assert.equal(out.code, 1, args.join(" "));
    assert.match(out.stderr, /restore first: awo goal restore TEST-G1/);
  }

  // Readers show what the goal was when it was filed, not a fresh re-derivation.
  const file = path.join(ws, archivedDir, "state.json");
  const drifted = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const t of Object.values(drifted.tasks) as Array<Record<string, unknown>>) t.status = "todo";
  fs.writeFileSync(file, JSON.stringify(drifted));
  assert.match(ok(ws, ["goal", "list", "--archived"]), /TEST-G1\tcancelled\t/);

  ok(ws, ["goal", "restore", "TEST-G1"]);
  const restored = stateAt(ws, path.join("goals", "TEST-G1"));
  assert.equal(restored.archivedStatus, undefined);
  assert.equal(restored.archivedAt, undefined);
  ok(ws, ["task", "run", "TEST-T1"]);
  cleanup(ws, repo);
});

test("goal archive refuses unmerged linked pull requests unless --unmerged-ok", () => {
  const { ws, repo } = makeWorkspace();
  const pr = (number: number, extra: Record<string, unknown>) => ({
    repo: "api", number, url: `https://example.invalid/pr/${number}`, branch: "feature/x", headSha: "abc",
    isDraft: false, mergeState: "CLEAN", checks: "passing", reviews: "approved",
    lastCheckedAt: new Date().toISOString(), feedback: {}, ...extra,
  });
  writeState(ws, {
    "TEST-T1": { status: "cancelled", pullRequest: pr(7, { state: "OPEN", merged: false }) },
    "TEST-T2": { status: "cancelled", pullRequests: { api: pr(8, {}) } },
  });
  const refused = awo(ws, ["goal", "archive", "TEST-G1"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not merged/);
  assert.match(refused.stderr, /TEST-T1 {2}api#7 {2}OPEN/);
  assert.match(refused.stderr, /TEST-T2 {2}api#8 {2}state unknown .* awo pr status TEST-T2/);
  assert.match(refused.stderr, /--unmerged-ok/);
  assert.ok(fs.existsSync(path.join(ws, GOAL_DIR)), "a refused archive must not move the goal");

  const archived = ok(ws, ["goal", "archive", "TEST-G1", "--unmerged-ok"]);
  assert.match(archived, /2 unmerged pull request\(s\): api#7, api#8/);
  ok(ws, ["goal", "restore", "TEST-G1"]);

  // Merged work archives without ceremony.
  const live = path.join("goals", "TEST-G1");
  const state = stateAt(ws, live);
  state.tasks["TEST-T1"].pullRequest = pr(7, { state: "MERGED", merged: true });
  state.tasks["TEST-T2"].pullRequests = { api: pr(8, { state: "MERGED", merged: true }) };
  fs.writeFileSync(path.join(ws, live, "state.json"), JSON.stringify(state));
  ok(ws, ["goal", "archive", "TEST-G1"]);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B1-10 — `awo run` shares the dependency policy
// ---------------------------------------------------------------------------

/** A `claude` that exits 0, so `dispatch` completes without a real model. */
function fakeRuntimeEnv(): { env: NodeJS.ProcessEnv; bin: string } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "awo-b1-bin-"));
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  return { bin, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } };
}

function addSecondGoal(ws: string, tasks: Array<{ id: string; dependsOn: string; body?: string }>): string {
  const dir = path.join("goals", "TEST-G2-next");
  fs.mkdirSync(path.join(ws, dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(ws, dir, "goal.md"), `---\nid: TEST-G2\ntitle: Next goal\n---\n\n## Objective\nNext.\n`);
  for (const t of tasks) {
    fs.writeFileSync(
      path.join(ws, dir, "tasks", `${t.id}.md`),
      `---\nid: ${t.id}\ngoalId: TEST-G2\nname: ${t.id}\ntargets: [api]\ndependsOn: ${t.dependsOn}\nstatus: todo\n---\n\n${t.body ?? "## Objective\nBuild on the first goal.\n"}`
    );
  }
  return dir;
}

test("awo run reads a cross-goal dependency from its own goal and accepts in-review", () => {
  const { ws, repo } = makeWorkspace();
  const { env, bin } = fakeRuntimeEnv();
  ok(ws, ["task", "run", "TEST-T1"]);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);
  const g2 = addSecondGoal(ws, [{ id: "TEST-T5", dependsOn: "[TEST-T1]" }]);

  // 0.7 read TEST-T1's status from TEST-G2's state (so: `todo`) and wanted `done`.
  const out = ok(ws, ["run", "--goal", "TEST-G2"], env);
  assert.match(out, /TEST-T5\tsuccess/);
  assert.notEqual(taskState(ws, "TEST-T5", g2).status, "todo");
  cleanup(ws, repo, bin);
});

test("awo run starts only what task run would: dependency-blocked yes, failure-blocked and unwritten no", () => {
  const { ws, repo } = makeWorkspace();
  const { env, bin } = fakeRuntimeEnv();
  ok(ws, ["task", "run", "TEST-T1"]);
  ok(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture"]);
  const g2 = addSecondGoal(ws, [
    { id: "TEST-T5", dependsOn: "[TEST-T1]" },
    { id: "TEST-T6", dependsOn: "[]" },
  ]);
  // T5 was parked by the pre-0.8 gate; T6 failed and needs a decision.
  writeState(ws, {
    "TEST-T5": { status: "blocked", blockedReason: "unmet dependencies: TEST-T1 (todo)" },
    "TEST-T6": { status: "blocked", blockedReason: "tests red", attempts: 1 },
  }, g2);

  const out = ok(ws, ["run", "--goal", "TEST-G2"], env);
  assert.match(out, /TEST-T5\tsuccess/);
  assert.match(out, /stopped: nothing-ready/);
  assert.match(out, /TEST-T6 is blocked \(tests red\)/);
  assert.match(out, /awo task run TEST-T6/);
  assert.equal(taskState(ws, "TEST-T6", g2).attempts, 1, "a failure-blocked task must not be re-dispatched");

  // An unwritten body stops the autorun before any dispatch.
  const g3 = path.join("goals", "TEST-G3-blank");
  fs.mkdirSync(path.join(ws, g3, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(ws, g3, "goal.md"), `---\nid: TEST-G3\ntitle: Blank\n---\n`);
  fs.writeFileSync(
    path.join(ws, g3, "tasks", "TEST-T7.md"),
    `---\nid: TEST-T7\ngoalId: TEST-G3\nname: Blank\ntargets: [api]\ndependsOn: []\nstatus: todo\n---\n\n## Objective\n_What "done" means for this unit._\n\n## Steps\n1. _…_\n`
  );
  const blank = ok(ws, ["run", "--goal", "TEST-G3"], env);
  assert.match(blank, /stopped: nothing-ready/);
  assert.match(blank, /TEST-T7's body is still the `awo task new` template/);
  assert.ok(!fs.existsSync(path.join(ws, g3, "state.json")), "nothing may be dispatched");
  cleanup(ws, repo, bin);
});

test("awo run refuses an archived goal", () => {
  const { ws, repo } = makeWorkspace();
  ok(ws, ["task", "status", "TEST-T1", "cancelled", "--reason", "x"]);
  ok(ws, ["task", "status", "TEST-T2", "cancelled", "--reason", "x"]);
  ok(ws, ["goal", "archive", "TEST-G1"]);
  const out = awo(ws, ["run", "--goal", "TEST-G1"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /restore first: awo goal restore TEST-G1/);
  cleanup(ws, repo);
});
