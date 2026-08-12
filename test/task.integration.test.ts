import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
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

function awo(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: options.env,
    });
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

/** The same file, untyped, for assertions about fields the helper above omits. */
function readStateFull(ws: string): {
  tasks: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(fs.readFileSync(path.join(ws, "goals", "TEST-G1-demo", "state.json"), "utf8"));
}

/** logs/<date>/ holds exactly two files, plus workers/ when one was dispatched. */
function dayFile(ws: string, runId: string, file: string): string {
  return path.join(ws, "logs", runId.slice(0, 10), file);
}
/** One run's structured lines, filtered out of the day it shares. */
function runLines(ws: string, runId: string): Record<string, unknown>[] {
  return fs
    .readFileSync(dayFile(ws, runId, "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.runId === runId && l.type === "event")
    .map(({ type: _t, runId: _r, ...event }) => event);
}
/** One run's record, extracted from the day's runs.md by its marker. */
function runRecord(ws: string, runId: string): string {
  const text = fs.readFileSync(dayFile(ws, runId, "runs.md"), "utf8");
  const start = text.indexOf(`<!-- awo:run ${runId} -->`);
  if (start < 0) return "";
  const next = text.indexOf("<!-- awo:run ", start + 1);
  return text.slice(start, next < 0 ? text.length : next);
}

/** The only day folder a test workspace has, since each test runs on one day. */
function onlyDayFile(ws: string, name: string): string {
  const day = fs.readdirSync(path.join(ws, "logs")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return path.join(ws, "logs", day[0] ?? "missing", name);
}
/** Every run row recorded, across all days. There is no global index any more. */
function dayRows(ws: string): Record<string, unknown>[] {
  return fs
    .readdirSync(path.join(ws, "logs"))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .flatMap((d) =>
      fs
        .readFileSync(path.join(ws, "logs", d, "runs.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    )
    .filter((l) => l.type === "run");
}

/**
 * Walk a requirement through intake so a test can get to planning.
 *
 * Every one of these call sites used to be `goal new --from` on a bare skeleton.
 * The approval gate (§16) makes that an error on purpose, so the helper does what a
 * PM agent and a human would: write checkable criteria, propose, approve.
 */
function approveRequirement(ws: string, id: string): void {
  const file = path.join(ws, "requirements", `${id}.md`);
  const text = fs.readFileSync(file, "utf8");
  // Idempotent: a test that already walked the gate itself must not walk it twice.
  if (/^status:\s*approved\s*$/m.test(text)) return;
  if (!/Given /.test(text)) {
    fs.writeFileSync(
      file,
      text.replace("- _…_", "- Given a precondition, when the action happens, then the outcome holds")
    );
  }
  execFileSync(process.execPath, [CLI, "req", "propose", id], { cwd: ws, stdio: "ignore" });
  execFileSync(process.execPath, [CLI, "req", "approve", id], { cwd: ws, stdio: "ignore" });
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

  const done = awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--summary", "Did it."]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /task is now done/);

  state = readState(ws);
  assert.equal(state.tasks["TEST-T1"].status, "done");
  assert.equal(state.tasks["TEST-T1"].lastRunOutcome, "success");

  // The day's file carries this run's events, in order, alongside its run row.
  const kinds = runLines(ws, runId).map((e) => e.kind);
  // `brief` follows run.start: what the worker was told, recorded at open (§16.7).
  assert.deepEqual(kinds, ["run.start", "brief", "step.start", "repo.diff", "run.end"]);

  // The run row, and the record section it points at
  const index = dayRows(ws).find((r) => r.runId === runId) as Record<string, unknown>;
  assert.equal(index.runId, runId);
  assert.equal(index.status, "success");
  assert.deepEqual(index.reposChanged, ["api"], "reposChanged is derived from repo.diff events");

  const detail = runRecord(ws, runId);
  assert.match(detail, /^<!-- awo:run /, "each record is a marked section of the day");
  assert.match(detail, /\*\*taskId:\*\* TEST-T1/);
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
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture"]);

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
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "in-review");
  // `in-progress`, not `qa-review`: TEST-T2 is authored and has never run, so the
  // goal is not in QA. This assertion used to read `qa-review` because the rollup
  // saw only the tasks present in state.json — the subset that had run — which is
  // how a goal could report further along than it was.
  assert.equal(readState(ws).goalStatus, "in-progress");

  const rejected = awo(ws, ["task", "verify", "TEST-T1", "--reject", "--reason", "missing case"]);
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.equal(readState(ws).tasks["TEST-T1"].status, "todo");

  awo(ws, ["task", "run", "TEST-T1"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--gate"]);
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
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture"]);
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
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--summary", "green"]);

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

  const index = dayRows(ws).at(-1) as Record<string, unknown>;
  assert.equal(index.taskId, null, "ad-hoc work has no task (§7.3)");
  assert.equal(index.agent, "product-manager");
  assert.equal(index.status, "success");

  const detail = runRecord(ws, String(index.runId));
  assert.match(detail, /\*\*taskId:\*\* —/, "metadata is a block, not repeated frontmatter");
  assert.match(detail, /Refined the requirement\./);
  assert.match(detail, /two questions open/);

  // It shows up in the same index the rest of the log tooling reads.
  assert.match(awo(ws, ["log", "list"]).stdout, /_intake\tsuccess/);
  assert.match(awo(ws, ["log", "show", String(index.runId)]).stdout, /Refined the requirement/);

  // A supplied start time is honoured, and drives the runId.
  const dated = awo(ws, [
    "log", "add", "--agent", "tech-lead", "--summary", "planned",
    "--started", "2026-01-02T03:04:05.000Z", "--duration", "60",
  ]);
  assert.match(dated.stdout, /2026-01-02T03-04-05_adhoc/);

  const bad = awo(ws, ["log", "add", "--agent", "x", "--summary", "y", "--started", "not-a-date"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /must be an ISO timestamp/);

  const badOutcome = awo(ws, ["log", "add", "--agent", "x", "--summary", "y", "--outcome", "great"]);
  assert.equal(badOutcome.code, 1);
  assert.match(badOutcome.stderr, /Unknown outcome "great"/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("tier follows the work: agent default, manifest policy, and per-task override", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const setModels = (models: unknown): void => {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.models = models;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  };
  const rerun = (id: string): RunResult => {
    awo(ws, ["task", "complete", id, "--outcome", "success", "--untested", "fixture"]);
    awo(ws, ["task", "status", id, "todo"]);
    return awo(ws, ["task", "run", id]);
  };

  // TEST-T1 is `agent: software-engineer`, which ships as tier: low — writing
  // code to an existing spec. No policy, so the built-in fallback applies.
  let out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /agent:\s+software-engineer — low tier \(from agent\)/);
  assert.match(out.stdout, /model:\s+claude:haiku effort=medium/);

  // A tiers policy maps the kind of work to a runtime+model.
  setModels({
    orchestrator: { runtime: "claude", model: "opus", mode: "plan" },
    tiers: {
      high: { runtime: "claude", model: "opus", mode: "plan" },
      low: { runtime: "codex", model: "gpt-5-codex" },
    },
  });
  out = rerun("TEST-T1");
  assert.match(out.stdout, /model:\s+codex:gpt-5-codex/);
  assert.match(out.stdout, /hand to: codex exec -m gpt-5-codex/);

  // A task whose WORK is thinking-heavy overrides the role's tier.
  const goalDir = path.join(ws, "goals", "TEST-G1-demo");
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T6-model.md"),
    `---\nid: TEST-T6\ngoalId: TEST-G1\nname: Define the data model\ntargets: [api]\nagent: software-engineer\ntier: high\nstatus: todo\n---\n\nx\n`
  );
  out = awo(ws, ["task", "run", "TEST-T6"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /software-engineer — high tier \(from task\)/, "the task's tier must win");
  assert.match(out.stdout, /model:\s+claude:opus effort=high \(plan mode\)/);
  assert.match(out.stdout, /hand to: claude --model opus --permission-mode plan/);

  // byRole pins a role regardless of tier mapping.
  setModels({ tiers: { low: { runtime: "codex", model: "gpt-5-codex" } }, byRole: { "software-engineer": { runtime: "claude", model: "sonnet" } } });
  out = rerun("TEST-T1");
  assert.match(out.stdout, /model:\s+claude:sonnet/);

  // The run.start event records tier, where it came from, and the model.
  const runId = readState(ws).tasks["TEST-T1"].lastRunId!;
  const events = runLines(ws, runId);
  assert.equal(events[0].tier, "low");
  assert.equal(events[0].tierFrom, "agent");
  assert.equal(events[0].model, "claude:sonnet");

  // An unassigned task falls back to standard — the middle, not the cheapest.
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T5-noagent.md"),
    `---\nid: TEST-T5\ngoalId: TEST-G1\nname: No agent\ntargets: [api]\nstatus: todo\n---\n\nx\n`
  );
  out = awo(ws, ["task", "run", "TEST-T5"]);
  assert.match(out.stdout, /unassigned — standard tier \(from default\)/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("task run creates the isolated worktree at the specced path", () => {
  const ws = makeWorkspace();
  // Make the linked repo a real git repo so a worktree can be created.
  const repoPath = JSON.parse(
    fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")
  ).repos[0].path as string;
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoPath });

  const out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /work in: repos\/\.worktrees\/api\/TEST-T1  \(api on feature\/TEST-T1\)/);
  // The printed command must be runnable: a worker sandboxed to the workspace
  // cannot commit unless it can also write the repo that owns the worktree's
  // .git (§9 item 40).
  assert.match(out.stdout, /hand to: .* -C repos\/\.worktrees\/api\/TEST-T1 --add-dir /);
  // ONLY the git metadata dir — granting the repo itself would let the worker
  // edit the real checkout instead of the worktree (§9 item 42).
  assert.ok(
    out.stdout.includes(`--add-dir ${path.join(repoPath, ".git")}`),
    "the worktree's git dir must be granted"
  );
  assert.ok(
    !new RegExp(`--add-dir ${repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(out.stdout),
    "the repo itself must NOT be granted"
  );

  const wt = path.join(ws, "repos", ".worktrees", "api", "TEST-T1");
  assert.ok(fs.existsSync(wt), "the worktree directory must exist");
  assert.match(
    execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" }),
    /TEST-T1/,
    "git must know about the worktree"
  );

  // It is announced in the event stream, so the log shows isolation happened.
  const runId = readState(ws).tasks["TEST-T1"].lastRunId!;
  const events = runLines(ws, runId);
  assert.ok(events.some((e) => String(e.label ?? "").includes("worktree ready for api")));

  // Re-running reuses it rather than failing.
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  assert.equal(awo(ws, ["task", "run", "TEST-T1"]).code, 0);

  // --no-worktree opts out, and says so loudly.
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  const shared = awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  assert.match(shared.stdout, /NO worktree isolation/);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("reposChanged is derived from any repo-bearing event, and falls back to targets on commit", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  // A worker that reports a test and a commit but never a repo.diff — exactly
  // what the dogfood produced, which used to yield reposChanged: [].
  awo(ws, ["task", "event", "TEST-T1", "test", "--data", '{"repo":"api","pass":10}']);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture", "--summary", "done"]);
  let index = dayRows(ws).at(-1) as Record<string, unknown>;
  assert.deepEqual(index.reposChanged, ["api"], "a test event naming a repo counts");

  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  awo(ws, ["task", "event", "TEST-T1", "commit", "--label", "abc123 feat: thing"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture"]);
  const lines = fs.readFileSync(onlyDayFile(ws, "runs.jsonl"), "utf8").trim().split("\n");
  index = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(index.reposChanged, ["api"], "a commit with no repo falls back to the task's targets");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("agent add installs from the catalog and refuses unknown or duplicate names", () => {
  const ws = makeWorkspace();
  let out = awo(ws, ["agent", "list"]);
  assert.match(out.stdout, /available: audit, data-engineer, marketing-specialist/);
  assert.ok(!fs.existsSync(path.join(ws, "agents", "data-engineer.md")));

  out = awo(ws, ["agent", "add", "data-engineer"]);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(fs.existsSync(path.join(ws, "agents", "data-engineer.md")));
  assert.match(awo(ws, ["agent", "list"]).stdout, /installed: .*data-engineer/);

  const dup = awo(ws, ["agent", "add", "data-engineer"]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already installed/);

  const missing = awo(ws, ["agent", "add", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Available: audit, marketing-specialist/);

  // An installed data-engineer is high tier, so schema work stops landing on a
  // low-tier implementer (§9 item 33).
  const goalDir = path.join(ws, "goals", "TEST-G1-demo");
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T4-model.md"),
    `---\nid: TEST-T4\ngoalId: TEST-G1\nname: Model\ntargets: [api]\nagent: data-engineer\nstatus: todo\n---\n\nx\n`
  );
  assert.match(awo(ws, ["task", "run", "TEST-T4", "--no-worktree"]).stdout, /data-engineer — high tier/);

  assert.match(awo(ws, ["skill", "list"]).stdout, /available: .*write-migration/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("agent org reports relationships, workload, and invalid references", () => {
  const ws = makeWorkspace();
  const agentsDir = path.join(ws, "agents");
  fs.writeFileSync(
    path.join(agentsDir, "tech-lead.md"),
    "---\ntier: high\n---\n\nLead.\n"
  );
  fs.writeFileSync(
    path.join(agentsDir, "software-engineer.md"),
    "---\nreportsTo: tech-lead\ndelegatesTo: [missing-role]\nreviews: [tech-lead]\n---\n\nBuild.\n"
  );

  const graph = awo(ws, ["agent", "org", "--json"]);
  assert.equal(graph.code, 1);
  const parsed = JSON.parse(graph.stdout) as { roots: string[]; errors: string[]; agents: { id: string; reportsTo: string | null }[] };
  assert.ok(parsed.roots.includes("tech-lead"));
  assert.match(parsed.errors.join("\n"), /unknown agent/);
  assert.equal(parsed.agents.find((agent) => agent.id === "software-engineer")?.reportsTo, "tech-lead");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("context treats authored tasks missing from state as inconsistent", () => {
  const ws = makeWorkspace();
  const stateFile = path.join(ws, "goals", "TEST-G1-demo", "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      rev: 1,
      goalId: "TEST-G1",
      goalStatus: "done",
      updatedAt: new Date().toISOString(),
      tasks: { "TEST-T1": { status: "done", lastRunOutcome: "success", lastRunId: null, startedAt: null, finishedAt: null, attempts: 1, worktree: null, blockedReason: null } },
    })
  );
  const context = awo(ws, ["context"]);
  assert.equal(context.code, 0);
  assert.match(context.stdout, /TEST-G1 inconsistent/);
  const doctor = awo(ws, ["doctor"]);
  assert.equal(doctor.code, 1);
  assert.match(`${doctor.stdout}\n${doctor.stderr}`, /missing authored task/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a tier can declare a fallback for when the primary is out of quota", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m.models = {
    orchestrator: { runtime: "claude", model: "opus", fallback: { runtime: "codex", model: "gpt-5-codex" } },
    tiers: {
      low: { runtime: "claude", model: "haiku", fallback: { runtime: "codex", model: "gpt-5.4-mini" } },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  const out = awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /hand to: claude --model haiku/);
  assert.match(out.stdout, /if quota: codex exec -m gpt-5\.4-mini/);

  // A tier with no fallback simply doesn't offer one.
  const m2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m2.models = { tiers: { low: { runtime: "claude", model: "haiku" } } };
  fs.writeFileSync(manifestPath, JSON.stringify(m2, null, 2));
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  const noFb = awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  assert.ok(!/if quota:/.test(noFb.stdout), "no fallback declared means none suggested");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("task run reuses the worktree already holding the branch, and never fakes isolation", () => {
  const ws = makeWorkspace();
  const repoPath = JSON.parse(
    fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")
  ).repos[0].path as string;
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoPath });

  // Someone (or an earlier attempt) already put feature/TEST-T1 in a worktree
  // somewhere else. git allows a branch in only ONE worktree, so creating the
  // canonical one would fail — reuse the existing path instead of advertising a
  // directory git refused to make.
  const stray = path.join(ws, ".worktrees", "api", "TEST-T1");
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", "feature/TEST-T1", stray], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(stray, "prior-work.txt"), "work from the orphaned attempt\n");

  const out = awo(ws, ["task", "run", "TEST-T1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /work in: \.worktrees\/api\/TEST-T1  \(api on feature\/TEST-T1, reused\)/);
  assert.ok(!/WARNING: no isolation/.test(out.stdout));

  // The canonical path must NOT be advertised, because it does not exist.
  assert.ok(!out.stdout.includes("repos/.worktrees/api/TEST-T1"));
  assert.ok(!fs.existsSync(path.join(ws, "repos", ".worktrees", "api", "TEST-T1")));

  // And the prior work is still reachable at the reused path.
  assert.ok(fs.existsSync(path.join(stray, "prior-work.txt")));

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("the index records tier, model, effort and attempts, and log list can filter by them", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m.models = {
    tiers: {
      low: { runtime: "codex", model: "gpt-5.4-mini", effort: "medium" },
      high: { runtime: "codex", model: "gpt-5.4-mini", effort: "high" },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  // A low-tier run that fails, is retried, and then succeeds — the shape the
  // "is low effort actually cheaper?" question needs in order to be answerable.
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "fixture"]);

  const lines = dayRows(ws);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.tier, "low");
    assert.equal(l.effort, "medium", "the low TIER still exists; only low EFFORT was dropped");
    assert.equal(l.model, "codex:gpt-5.4-mini");
  }
  assert.equal(lines[0].attempts, 1);
  assert.equal(lines[1].attempts, 2, "the retry is visible, which is what makes cost comparable");

  // A high-tier task records its own effort, so the two are comparable.
  const goalDir = path.join(ws, "goals", "TEST-G1-demo");
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TEST-T7-think.md"),
    `---\nid: TEST-T7\ngoalId: TEST-G1\nname: Think hard\ntargets: [api]\nagent: software-engineer\ntier: high\nstatus: todo\n---\n\nx\n`
  );
  awo(ws, ["task", "run", "TEST-T7", "--no-worktree"]);
  awo(ws, ["task", "complete", "TEST-T7", "--outcome", "success", "--untested", "fixture"]);

  const listed = awo(ws, ["log", "list"]);
  assert.match(listed.stdout, /low effort=medium/);
  assert.match(listed.stdout, /high effort=high/);
  assert.match(listed.stdout, /try#2/);

  assert.equal(awo(ws, ["log", "list", "--effort", "high"]).stdout.trim().split("\n").length, 1);
  assert.equal(awo(ws, ["log", "list", "--effort", "medium"]).stdout.trim().split("\n").length, 2);
  assert.equal(awo(ws, ["log", "list", "--tier", "low"]).stdout.trim().split("\n").length, 2);
  assert.match(awo(ws, ["log", "list", "--tier", "low", "--status", "failed"]).stdout, /failed/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a task cannot close as success without test evidence", () => {
  const ws = makeWorkspace();
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);

  // §7.1 tests-must-pass, previously unenforceable: six tasks closed as success
  // with no evidence and composed into a broken feature (§9 item 47).
  const bare = awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /cannot close as success with no test evidence/);
  assert.match(bare.stderr, /rule: tests-must-pass/);
  assert.match(awo(ws, ["task", "show", "TEST-T1"]).stdout, /status: {3}running/, "still open");

  // Typing a test event is no longer enough: it is a claim, and a claim cannot be
  // checked. Nothing about the workspace changes until something is measured.
  awo(ws, ["task", "event", "TEST-T1", "test", "--data", '{"repo":"api","pass":12,"fail":0}']);
  const claimed = awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]);
  assert.equal(claimed.code, 1);
  assert.match(claimed.stderr, /awo did not run/);

  // Having awo run it does satisfy the gate.
  awo(ws, ["task", "event", "TEST-T1", "test", "--run", "true"]);
  assert.equal(awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success"]).code, 0);
  assert.match(awo(ws, ["task", "show", "TEST-T1"]).stdout, /status: {3}done/);

  // Failure needs no evidence — a failed run is allowed to have run nothing.
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  assert.equal(awo(ws, ["task", "complete", "TEST-T1", "--outcome", "failed"]).code, 0);

  // And an honest escape hatch that records WHY in the run log.
  awo(ws, ["task", "status", "TEST-T1", "todo"]);
  awo(ws, ["task", "run", "TEST-T1", "--no-worktree"]);
  const excused = awo(ws, [
    "task", "complete", "TEST-T1", "--outcome", "success",
    "--untested", "no database available in this environment",
  ]);
  assert.equal(excused.code, 0, excused.stderr);
  const runId = readState(ws).tasks["TEST-T1"].lastRunId!;
  const detail = runRecord(ws, runId);
  assert.match(detail, /UNTESTED: no database available/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("dispatch spawns the worker, blocks, and fails loudly when the runtime is missing", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // A runtime that does not exist: dispatch must fail the task, never quietly do
  // the work some other way (§9 item 41).
  m.models = { tiers: { low: { runtime: "codex", model: "definitely-not-installed-xyz" } } };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

  const dry = awo(ws, ["task", "dispatch", "TEST-T1", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would dispatch TEST-T1 to codex:definitely-not-installed-xyz/);
  // A dry run must leave no state behind.
  assert.ok(!fs.existsSync(path.join(ws, "goals", "TEST-G1-demo", "state.json")));

  const out = awo(ws, ["task", "dispatch", "TEST-T1", "--timeout", "1"], {
    // Keep git available for task-run's worktree setup, but hide the locally
    // installed Codex binary so this really exercises spawn failure.
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(out.code, 1, "a failed worker must be a non-zero exit");
  assert.match(out.stdout, /worker: {2}exited/);
  assert.match(out.stdout, /run closed as failed/);

  // The task is blocked, not left dangling in `running` (§9 item 35).
  assert.equal(readState(ws).tasks["TEST-T1"].status, "blocked");

  // The worker's own output is captured beside the run, not just summarised.
  const runId = readState(ws).tasks["TEST-T1"].lastRunId!;
  const workerLog = path.join(ws, "logs", runId.slice(0, 10), "workers", `${runId.slice(11, 19)}-${runId.slice(runId.indexOf("_") + 1)}.log`);
  assert.ok(fs.existsSync(workerLog), "the worker's output must be retained for diagnosis");

  // The dispatch is visible in the event stream, command included.
  const events = runLines(ws, runId);
  assert.ok(events.some((e) => String(e.label ?? "").includes("dispatching to codex")));
  assert.ok(events.some((e) => e.kind === "step.end" && e.ok === false));
  fs.rmSync(ws, { recursive: true, force: true });
});

/** A repo whose suite is a script we can make pass or fail deterministically. */
function makeEvidenceWorkspace(
  opts: { brokenAtBase?: boolean } = {}
): { ws: string; repo: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awo-ev-"));
  const ws = path.join(root, "ws");
  const repo = path.join(root, "api");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: "ignore" });
  git("init -q .");
  git("config user.email a@b.c");
  git("config user.name t");
  fs.writeFileSync(
    path.join(repo, "src", "pricing.ts"),
    opts.brokenAtBase ? "export const rate = 0.1; // BREAK\n" : "export const rate = 0.1;\n"
  );
  fs.writeFileSync(path.join(repo, "src", "pricing.spec.ts"), "expect(rate).toBe(0.1)\n");
  fs.writeFileSync(
    path.join(repo, "t.sh"),
    '#!/bin/sh\ngrep -q BREAK src/pricing.ts && { echo "1 failed"; exit 1; }\necho "2 passed"\n'
  );
  fs.chmodSync(path.join(repo, "t.sh"), 0o755);
  git("add -A");
  git("commit -qm base");

  execFileSync(process.execPath, [CLI, "init", "--key", "EV"], { cwd: ws });
  execFileSync(process.execPath, [CLI, "connect", repo], { cwd: ws });
  execFileSync(process.execPath, [CLI, "req", "new", "--title", "thing"], { cwd: ws });
  approveRequirement(ws, "EV-R1");
  execFileSync(process.execPath, [CLI, "goal", "new", "--from", "EV-R1"], { cwd: ws });
  execFileSync(process.execPath, [CLI, "task", "new", "--goal", "EV-G1", "--name", "Do", "--targets", "api"], { cwd: ws });
  execFileSync(process.execPath, [CLI, "task", "run", "EV-T1"], { cwd: ws });
  return { ws, repo, worktree: path.join(ws, "repos", ".worktrees", "api", "EV-T1") };
}

function lastTestEvent(ws: string): Record<string, unknown> {
  const day = fs.readdirSync(path.join(ws, "logs")).filter((d) => /^\d{4}-/.test(d))[0];
  return fs
    .readFileSync(path.join(ws, "logs", day, "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === "test")
    .at(-1)!;
}

test("a test event with --run is measured, not claimed", () => {
  const { ws } = makeEvidenceWorkspace();
  execFileSync(process.execPath, [CLI, "task", "event", "EV-T1", "test", "--run", "./t.sh"], { cwd: ws });

  const e = lastTestEvent(ws);
  assert.equal(e.verified, true, "awo ran it");
  assert.equal(e.exitCode, 0);
  assert.equal(e.command, "./t.sh");
  assert.equal(e.passed, 2, "counts are parsed from the runner's output");
  assert.equal(e.diagnosis, "pass");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("a failure is attributed against the branch point, not guessed", () => {
  const { ws, worktree } = makeEvidenceWorkspace();
  // The branch breaks a suite that passed where it started.
  fs.writeFileSync(path.join(worktree, "src", "pricing.ts"), "export const rate = 0.1; // BREAK\n");
  execSync("git commit -aqm break", { cwd: worktree, stdio: "ignore" });

  execFileSync(
    process.execPath,
    [CLI, "task", "event", "EV-T1", "test", "--run", "./t.sh", "--baseline"],
    { cwd: ws }
  );
  const e = lastTestEvent(ws);
  assert.equal(e.exitCode, 1);
  assert.equal(e.baselineExitCode, 0, "the baseline actually ran");
  assert.equal(e.diagnosis, "regression");
  assert.equal(e.needsHuman, false, "a regression is decided, not escalated");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("a suite already failing at the branch point is not blamed on the task", () => {
  // Broken before the task's branch ever existed, so the branch point fails too.
  const { ws, worktree } = makeEvidenceWorkspace({ brokenAtBase: true });
  fs.writeFileSync(path.join(worktree, "src", "pricing.ts"), "export const rate = 0.2; // BREAK\n");
  execSync("git commit -aqm unrelated-change", { cwd: worktree, stdio: "ignore" });

  execFileSync(
    process.execPath,
    [CLI, "task", "event", "EV-T1", "test", "--run", "./t.sh", "--baseline"],
    { cwd: ws }
  );
  assert.equal(lastTestEvent(ws).diagnosis, "pre-existing");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("a test edited alongside the code it covers is inconclusive, even passing", () => {
  const { ws, worktree } = makeEvidenceWorkspace();
  fs.writeFileSync(path.join(worktree, "src", "pricing.ts"), "export const rate = 0.25;\n");
  fs.writeFileSync(path.join(worktree, "src", "pricing.spec.ts"), "expect(rate).toBe(0.25)\n");
  execSync("git commit -aqm both", { cwd: worktree, stdio: "ignore" });

  execFileSync(process.execPath, [CLI, "task", "event", "EV-T1", "test", "--run", "./t.sh"], { cwd: ws });
  const e = lastTestEvent(ws);
  assert.equal(e.exitCode, 0, "it passes");
  assert.equal(e.diagnosis, "test-and-code-changed");
  assert.equal(e.needsHuman, true, "a test edited into agreement proves nothing");

  // ...and passing is not enough to reach done directly.
  const straight = awo(ws, ["task", "complete", "EV-T1", "--outcome", "success", "--summary", "x"]);
  assert.equal(straight.code, 1);
  assert.match(straight.stderr, /needs a human, so it cannot go straight to done/);

  const gated = awo(ws, ["task", "complete", "EV-T1", "--outcome", "success", "--gate", "--summary", "x"]);
  assert.equal(gated.code, 0, gated.stderr);
  assert.match(gated.stdout, /in-review/);
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("the gate refuses a test event awo did not run", () => {
  const { ws } = makeEvidenceWorkspace();
  execFileSync(process.execPath, [CLI, "task", "event", "EV-T1", "test", "--label", "suite green"], { cwd: ws });

  const out = awo(ws, ["task", "complete", "EV-T1", "--outcome", "success", "--gate", "--summary", "x"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /cannot close as success on a test event awo did not run/);
  assert.match(out.stderr, /--run/, "it must say how to fix it");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("recheck attaches real evidence to a task closed without any", () => {
  const { ws, worktree } = makeEvidenceWorkspace();

  // Close it the way the dogfood did: success, no measurement, excused.
  execFileSync(process.execPath, [CLI, "task", "event", "EV-T1", "commit", "--label", "abc feat: thing"], { cwd: ws });
  execFileSync(
    process.execPath,
    [CLI, "task", "complete", "EV-T1", "--outcome", "success", "--untested", "no runner then"],
    { cwd: ws }
  );
  assert.match(awo(ws, ["task", "show", "EV-T1"]).stdout, /status: {3}done/);
  assert.match(awo(ws, ["doctor"]).stdout, /EV-T1 is done with no test evidence/);

  // doctor's advice must be runnable. The old text said `task event`, which cannot
  // work on a closed task — assert the advice names the command that does.
  assert.match(awo(ws, ["doctor"]).stdout, /awo task recheck EV-T1 --run/);

  const rechecked = awo(ws, ["task", "recheck", "EV-T1", "--run", "./t.sh", "--baseline"]);
  assert.equal(rechecked.code, 0, rechecked.stderr);
  assert.match(rechecked.stdout, /done -> done — pass/);

  // The original run is untouched; the verification is a new one (append-only).
  const runs = dayRows(ws).filter((r) => r.taskId === "EV-T1");
  assert.equal(runs.length, 2, "a new run, not a rewritten one");
  const e = lastTestEvent(ws);
  assert.equal(e.verified, true);
  assert.equal(e.exitCode, 0);

  assert.ok(!/no test evidence/.test(awo(ws, ["doctor"]).stdout), "the warning must be gone");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("recheck that fails says the original close was wrong, and does not hide it", () => {
  const { ws, worktree } = makeEvidenceWorkspace();
  execFileSync(
    process.execPath,
    [CLI, "task", "complete", "EV-T1", "--outcome", "success", "--untested", "no runner then"],
    { cwd: ws }
  );

  // The work is actually broken.
  fs.writeFileSync(path.join(worktree, "src", "pricing.ts"), "export const rate = 0.1; // BREAK\n");
  execSync("git commit -aqm break", { cwd: worktree, stdio: "ignore" });

  const out = awo(ws, ["task", "recheck", "EV-T1", "--run", "./t.sh", "--baseline"]);
  assert.equal(out.code, 1, "a failed re-check must not exit 0");
  assert.match(out.stdout, /the original close was wrong/);
  assert.match(awo(ws, ["task", "show", "EV-T1"]).stdout, /status: {3}blocked/);
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("recheck refuses a task that is not closed, and says what to run instead", () => {
  const { ws } = makeEvidenceWorkspace();
  const out = awo(ws, ["task", "recheck", "EV-T1", "--run", "./t.sh"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /is running, so there is nothing to re-check/);
  assert.match(out.stderr, /awo task run EV-T1/);
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("a recheck against an already-red suite is inconclusive, not a verdict on the task", () => {
  // The suite fails at the branch point, so it says nothing about this change. The
  // first version of recheck blamed the task for it and left it blocked.
  const { ws, worktree } = makeEvidenceWorkspace({ brokenAtBase: true });
  execFileSync(
    process.execPath,
    [CLI, "task", "complete", "EV-T1", "--outcome", "success", "--untested", "no runner then"],
    { cwd: ws }
  );
  fs.writeFileSync(path.join(worktree, "README.md"), "unrelated\n");
  execSync("git add -A && git commit -qm unrelated", { cwd: worktree, stdio: "ignore" });

  const out = awo(ws, ["task", "recheck", "EV-T1", "--run", "./t.sh", "--baseline"]);
  assert.equal(out.code, 1, "inconclusive is not success");
  assert.match(out.stdout, /pre-existing/);
  assert.match(out.stdout, /proves nothing about this/);

  // Blocked, not done: the task cannot be verified until the base is green, and it
  // was only `done` because it closed before any gate existed. Laundering it back to
  // done would also need an illegal blocked -> done transition.
  assert.match(awo(ws, ["task", "show", "EV-T1"]).stdout, /status: {3}blocked/);
  const rows = dayRows(ws).filter((r) => r.taskId === "EV-T1");
  assert.equal(rows.at(-1)!.status, "skipped", "the run is skipped, not failed");
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

test("what the worker was told is recorded at run-open, not left to be remembered", () => {
  const { ws } = makeEvidenceWorkspace();
  // makeEvidenceWorkspace already opened the run; open a second one with an
  // orchestrator instruction attached.
  awo(ws, ["task", "complete", "EV-T1", "--outcome", "failed", "--summary", "x"]);
  awo(ws, ["task", "status", "EV-T1", "todo"]);
  const opened = awo(ws, [
    "task", "run", "EV-T1",
    "--instruction", "Use the existing pagination helper; add no dependency.",
  ]);
  assert.equal(opened.code, 0, opened.stderr);

  const day = fs.readdirSync(path.join(ws, "logs")).filter((d) => /^\d{4}-/.test(d))[0];
  const briefs = fs
    .readFileSync(path.join(ws, "logs", day, "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === "brief");

  assert.ok(briefs.length >= 1, "opening a run must record the brief");
  const brief = briefs.at(-1)!;
  assert.match(String(brief.text), /You are software-engineer working task EV-T1/);
  assert.match(String(brief.text), /isolated git worktree/);
  assert.match(String(brief.text), /--run "<cmd>"/, "it must tell the worker how evidence works");
  assert.equal(brief.instruction, "Use the existing pagination helper; add no dependency.");

  // And it reaches the record with nobody passing --prompt, which is the whole point:
  // 28 of 28 records from the first real run said "_not recorded_".
  awo(ws, ["task", "event", "EV-T1", "test", "--run", "./t.sh"]);
  awo(ws, ["task", "complete", "EV-T1", "--outcome", "success", "--summary", "done"]);
  const record = runRecord(ws, String(briefs.at(-1)!.runId));
  assert.match(record, /### User prompt\n+You are software-engineer/);
  assert.ok(!/### User prompt\n_not recorded_/.test(record));
  fs.rmSync(path.dirname(ws), { recursive: true, force: true });
});

/** A workspace whose linked repo is a real git repo, so worktrees can be created. */
function makeGitWorkspace(): { ws: string; repoPath: string } {
  const ws = makeWorkspace();
  const repoPath = JSON.parse(
    fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")
  ).repos[0].path as string;
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: repoPath,
  });
  return { ws, repoPath };
}

/** Close TEST-T1 as done without needing real test evidence. */
function closeAsDone(ws: string): void {
  awo(ws, ["task", "complete", "TEST-T1", "--outcome", "success", "--untested", "not the point here"]);
}

test("task run records where it put the worker, instead of claiming no worktree", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);

  // `state.worktree` was initialised to null and never written, so every task
  // claimed no checkout while the directories piled up on disk.
  assert.equal(
    readStateFull(ws).tasks["TEST-T1"].worktree,
    path.join("repos", ".worktrees", "api", "TEST-T1")
  );

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("worktree list reports every checkout and whether removing it loses work", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);

  const clean = awo(ws, ["worktree", "list"]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /repos\/\.worktrees\/api\/TEST-T1/);
  assert.match(clean.stdout, /feature\/TEST-T1/);
  assert.match(clean.stdout, /safe to remove/);

  // An uncommitted edit must flip it, or prune would silently discard the edit.
  fs.writeFileSync(path.join(ws, "repos", ".worktrees", "api", "TEST-T1", "scratch.txt"), "wip\n");
  assert.match(awo(ws, ["worktree", "list"]).stdout, /KEEP — uncommitted changes in the checkout/);

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("worktree prune removes finished tasks' checkouts and deregisters them from git", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const wt = path.join(ws, "repos", ".worktrees", "api", "TEST-T1");
  assert.ok(fs.existsSync(wt));

  // A running task is not finished, so the default selection leaves it alone.
  assert.match(awo(ws, ["worktree", "prune"]).stdout, /Nothing to prune/);
  assert.ok(fs.existsSync(wt), "a running task's worktree must survive a prune");

  closeAsDone(ws);
  const dry = awo(ws, ["worktree", "prune", "--dry-run"]);
  assert.match(dry.stdout, /remove repos\/\.worktrees\/api\/TEST-T1/);
  assert.match(dry.stdout, /nothing was touched/);
  assert.ok(fs.existsSync(wt), "--dry-run must not remove anything");

  const out = awo(ws, ["worktree", "prune"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /removed repos\/\.worktrees\/api\/TEST-T1/);
  assert.ok(!fs.existsSync(wt), "the directory must be gone");

  // `git worktree remove`, not a plain rm: a stale registration makes git refuse
  // to reuse the path until someone prunes it by hand.
  assert.doesNotMatch(
    execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" }),
    /TEST-T1/,
    "git must no longer know about it"
  );

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("worktree prune keeps a checkout that still holds work, and says why", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const wt = path.join(ws, "repos", ".worktrees", "api", "TEST-T1");
  closeAsDone(ws);

  // A commit no other branch contains. Under `goal-feature-branch` a task's commits
  // are merged into the delivery branch AFTER the task closes, so a prune at
  // completion time would have thrown this away.
  fs.writeFileSync(path.join(wt, "feature.txt"), "real work\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat"], {
    cwd: wt,
  });

  const out = awo(ws, ["worktree", "prune"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /kept .*TEST-T1.*commit\(s\) no other branch contains/);
  assert.match(out.stdout, /1 kept because they still hold work/);
  assert.ok(fs.existsSync(wt), "unmerged work must survive a default prune");

  // Merged into another branch, the same commits are no longer at risk.
  execFileSync("git", ["branch", "delivery", "feature/TEST-T1"], { cwd: repoPath });
  const after = awo(ws, ["worktree", "prune"]);
  assert.match(after.stdout, /removed repos\/\.worktrees\/api\/TEST-T1/);
  assert.ok(!fs.existsSync(wt));

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("worktree prune --force discards work only when asked in those words", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  const wt = path.join(ws, "repos", ".worktrees", "api", "TEST-T1");
  closeAsDone(ws);
  fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");

  assert.match(awo(ws, ["worktree", "prune"]).stdout, /kept .*uncommitted changes/);
  assert.ok(fs.existsSync(wt));

  assert.match(awo(ws, ["worktree", "prune", "--force"]).stdout, /removed/);
  assert.ok(!fs.existsSync(wt));

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("doctor reports a finished task's leftover worktree and points at prune", () => {
  const { ws, repoPath } = makeGitWorkspace();
  awo(ws, ["task", "run", "TEST-T1"]);
  closeAsDone(ws);

  const out = awo(ws, ["doctor"]);
  assert.match(out.stdout, /repos\/\.worktrees\/api\/TEST-T1 is still checked out, but TEST-T1 is finished/);
  assert.match(out.stdout, /awo worktree prune/);

  // Read-only: a diagnostic that silently repairs hides the problem it was run for.
  assert.ok(
    fs.existsSync(path.join(ws, "repos", ".worktrees", "api", "TEST-T1")),
    "doctor must not remove anything"
  );

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("doctor collapses one systemic problem into one finding with a count", () => {
  const ws = makeWorkspace();

  // Six repos with no testCommand is one planning gap, not six findings. Real use
  // turned this page into 166 lines, 74 of them the same sentence.
  for (const name of ["r1", "r2", "r3", "r4", "r5", "r6"]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `awo-doc-${name}-`));
    fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
    awo(ws, ["connect", repo, "--name", name]);
  }

  const collapsed = awo(ws, ["doctor"]);
  assert.match(collapsed.stdout, /…and \d+ more like this \(\d+ in total\)/);
  assert.match(collapsed.stdout, /awo doctor --all/);

  const all = awo(ws, ["doctor", "--all"]);
  assert.doesNotMatch(all.stdout, /more like this/);
  // Every instance is still there under --all, and the tally never changed.
  for (const name of ["r1", "r2", "r3", "r4", "r5", "r6"]) {
    assert.match(all.stdout, new RegExp(`${name} has no testCommand`));
  }
  const tally = /(\d+) error\(s\), (\d+) warning\(s\), (\d+) note\(s\)/;
  assert.deepEqual(tally.exec(collapsed.stdout)?.slice(1), tally.exec(all.stdout)?.slice(1));

  fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * The SHOP workspace had three directories under repos/.worktrees/ that git had no
 * record of: `ALMO-261`, 532KB of a checkout an agent made by hand while following
 * the goal-branch flow, and two empty leaves left by a failed `worktree add`.
 * Discovery through `git worktree list` alone cannot see any of them, and they
 * occupy the path awo wants to reuse.
 */
test("worktree list finds directories git has no record of, and prune keeps the ones with content", () => {
  const { ws, repoPath } = makeGitWorkspace();
  const under = path.join(ws, "repos", ".worktrees", "api");
  fs.mkdirSync(path.join(under, "ALMO-9"), { recursive: true });
  fs.writeFileSync(path.join(under, "ALMO-9", "handwritten.txt"), "work nobody registered\n");
  fs.mkdirSync(path.join(under, "TEST-T9"), { recursive: true });

  const list = awo(ws, ["worktree", "list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /ALMO-9\t—\t.*KEEP — git has no record of it/);
  // An empty leftover is safe by inspection, so it is not held back.
  assert.match(list.stdout, /TEST-T9\t—\t0MB\tsafe to remove/);

  const out = awo(ws, ["worktree", "prune", "--all"]);
  assert.match(out.stdout, /kept .*ALMO-9.*git has no record of it/);
  assert.match(out.stdout, /removed .*TEST-T9/);
  assert.ok(fs.existsSync(path.join(under, "ALMO-9")), "unaccounted-for content must survive");
  assert.ok(!fs.existsSync(path.join(under, "TEST-T9")), "an empty leftover can go");

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});
