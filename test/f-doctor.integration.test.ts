import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/f-doctor.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const load = (name: string) => import(pathToFileURL(path.join(REPO_ROOT, "dist", name)).href);
const INSTALLED = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
}).version;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[]): RunResult {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

interface Finding {
  severity: string;
  area: string;
  code?: string;
  message: string;
  fix?: string;
}

async function doctor(ws: string, options: Record<string, unknown> = {}): Promise<Finding[]> {
  const { runDoctor } = await load("commands/doctor.js");
  return runDoctor({ cwd: ws, ...options });
}

const withCode = (findings: Finding[], code: string): Finding[] => findings.filter((f) => f.code === code);

function makeWorkspace(key = "FD"): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-fdoc-"));
  execFileSync(process.execPath, [CLI, "init", "--key", key], { cwd: ws, stdio: "ignore" });
  return ws;
}

/** A local repo linked as `api`; with `git`, a real repo with one commit. */
function linkRepo(ws: string, options: { git?: boolean } = {}): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awo-fdoc-repo-")));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  if (options.git) {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  }
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: ws, stdio: "ignore" });
  return repo;
}

interface TaskSeed {
  id: string;
  status?: string;
  kind?: string;
  agent?: string;
  body?: string;
}

const TEMPLATE_BODY = `\n## Objective\n_What "done" means for this unit._\n\n## Steps\n1. _…_\n\n## Done when\n- _…_\n`;

/** Write a goal folder directly — faster than the CLI pipeline, and any state is reachable. */
function writeGoal(
  ws: string,
  id: string,
  options: {
    governed?: boolean;
    createdAt?: string;
    tasks?: TaskSeed[];
    state?: Record<string, unknown>;
    archived?: boolean;
  } = {}
): string {
  const dir = path.join(ws, "goals", ...(options.archived ? ["archive"] : []), id);
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  const tasks = options.tasks ?? [];
  fs.writeFileSync(
    path.join(dir, "goal.md"),
    [
      "---",
      `id: ${id}`,
      `title: Goal ${id}`,
      `taskIds: [${tasks.map((t) => t.id).join(", ")}]`,
      ...(options.governed
        ? ["completionPolicy:", "  qaRequired: true", "  acceptanceEvidenceRequired: true"]
        : []),
      ...(options.createdAt ? [`createdAt: ${options.createdAt}`] : []),
      "---",
      "",
      "## Objective",
      "Demo.",
      "",
    ].join("\n")
  );
  if (options.governed) {
    fs.writeFileSync(
      path.join(dir, "requirement.md"),
      `---\nid: ${id}-R\nstatus: approved\n---\n\n## Acceptance criteria\n- Given input, when executed, then it works.\n`
    );
  }
  for (const t of tasks) {
    fs.writeFileSync(
      path.join(dir, "tasks", `${t.id}.md`),
      [
        "---",
        `id: ${t.id}`,
        `goalId: ${id}`,
        `name: Task ${t.id}`,
        "targets: [api]",
        ...(t.kind ? [`kind: ${t.kind}`] : []),
        ...(t.agent ? [`agent: ${t.agent}`] : []),
        `status: ${t.status ?? "todo"}`,
        "---",
        t.body ?? "\n## Objective\nDo the real thing.\n",
      ].join("\n")
    );
  }
  if (options.state) {
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ rev: 1, goalId: id, goalStatus: "planning", updatedAt: ago(0), tasks: {}, ...options.state }, null, 2)
    );
  }
  return dir;
}

function taskState(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    lastRunOutcome: null,
    lastRunId: null,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    worktree: null,
    blockedReason: null,
    ...extra,
  };
}

function writeEvents(ws: string, runId: string, events: Array<Record<string, unknown>>): void {
  const day = path.join(ws, "logs", runId.slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  fs.appendFileSync(
    path.join(day, "runs.jsonl"),
    events.map((e) => JSON.stringify({ type: "event", runId, ...e })).join("\n") + "\n"
  );
}

const rm = (...dirs: string[]): void => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// F1 — doctor
// ---------------------------------------------------------------------------

test("doctor defaults to --scope active; --scope all brings archived history back", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    archived: true,
    tasks: [{ id: "FD-T1", status: "done" }],
  });
  fs.writeFileSync(
    path.join(ws, "goals", "archive", "FD-G1", "tasks", "FD-T1.md"),
    "---\nid: FD-T1\ngoalId: FD-G1\nstatus: done\ntargets: [retired]\n---\n\nold work\n"
  );

  const active = awo(ws, ["doctor"]);
  assert.doesNotMatch(active.stdout, /retired/, "archived history must not appear by default");

  const all = awo(ws, ["doctor", "--scope", "all"]);
  assert.match(all.stdout, /historical target "retired"/);
  rm(ws);
});

test("doctor flags governed goals stuck before the verdict, and ones with no criterion evidence", async () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    governed: true,
    tasks: [{ id: "FD-T1", status: "in-review" }],
    state: { tasks: { "FD-T1": taskState("in-review", { finishedAt: ago(9 * DAY) }) } },
  });
  writeGoal(ws, "FD-G2", {
    governed: true,
    tasks: [{ id: "FD-T2", status: "in-review" }],
    state: { tasks: { "FD-T2": taskState("in-review", { finishedAt: ago(1 * DAY) }) } },
  });

  let findings = await doctor(ws);
  const stale = withCode(findings, "goal-qa-review-stale");
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0].message, /FD-G1 has waited 9d in qa-review with no verdict/);
  assert.match(stale[0].fix ?? "", /awo goal verify FD-G1/, "no brief yet, so the first step is the brief");
  assert.match(stale[0].fix ?? "", /awo goal verdict FD-G1 --pass\|--gap/);

  const bare = withCode(findings, "goal-no-criterion-evidence");
  assert.deepEqual(bare.map((f) => f.message.split(" ")[0]).sort(), ["FD-G1", "FD-G2"]);
  assert.match(bare[0].fix ?? "", /awo task evidence FD-T\d --criterion <n>/);

  // A brief attached changes the advice; evidence clears the second finding.
  const file = path.join(ws, "goals", "FD-G1", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.qa = { briefRunId: "brief-1", verdict: null };
  state.criteria = { "1": [{ taskId: "FD-T1", kind: "manual", ref: "checked", recordedAt: ago(0) }] };
  fs.writeFileSync(file, JSON.stringify(state));

  findings = await doctor(ws);
  assert.match(withCode(findings, "goal-qa-review-stale")[0].fix ?? "", /QA brief is attached/);
  assert.deepEqual(withCode(findings, "goal-no-criterion-evidence").map((f) => f.message.split(" ")[0]), ["FD-G2"]);
  rm(ws);
});

test("doctor flags a goal that has sat in planning with no tasks for over a week", async () => {
  const ws = makeWorkspace();
  writeGoal(ws, "FD-G1", { createdAt: ago(10 * DAY) });
  writeGoal(ws, "FD-G2", { createdAt: ago(1 * DAY) });

  const empty = withCode(await doctor(ws), "goal-planning-empty");
  assert.equal(empty.length, 1);
  assert.match(empty[0].message, /FD-G1 has been planning for 10d with no tasks/);
  assert.match(empty[0].fix ?? "", /awo goal plan FD-G1/);
  assert.match(empty[0].fix ?? "", /awo goal archive FD-G1 --force/);
  rm(ws);
});

test("doctor reports worktree pointers to directories that no longer exist", async () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    tasks: [
      { id: "FD-T1", status: "done" },
      { id: "FD-T2", status: "running" },
    ],
    state: {
      tasks: {
        "FD-T1": taskState("done", { worktree: "repos/.worktrees/api/FD-T1" }),
        "FD-T2": taskState("running", { worktree: "repos/.worktrees/api/FD-T2" }),
      },
    },
  });

  const dangling = withCode(await doctor(ws), "worktree-pointer-dangling");
  assert.equal(dangling.length, 2);
  const finished = dangling.find((f) => f.severity === "info")!;
  assert.match(finished.message, /^1 task\(s\) record a worktree that no longer exists \(FD-T1\)/, "harmless, so counted once");
  const running = dangling.find((f) => f.severity === "warn")!;
  assert.match(running.message, /^FD-T2 \(running\) records worktree/, "an open run that lost its checkout is not harmless");
  assert.match(running.fix ?? "", /awo task complete FD-T2 --outcome failed/);
  rm(ws);
});

test("disk check warns under 10% free and counts task worktrees", async () => {
  const { diskSpaceFinding } = await load("commands/doctor.js");
  const low = diskSpaceFinding({ bavail: 5, blocks: 100, bsize: 1024 ** 3 / 10 }, 3);
  assert.equal(low.code, "disk-space-low");
  assert.equal(low.severity, "warn");
  assert.match(low.message, /5\.0% free/);
  assert.match(low.message, /3 task worktree\(s\)/);
  assert.match(low.fix, /awo worktree prune/);
  assert.equal(diskSpaceFinding({ bavail: 50, blocks: 100, bsize: 4096 }, 3), null, "plenty of space is not a finding");
});

test("doctor flags live tasks whose body is still the task-new template", async () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    tasks: [
      { id: "FD-T1", status: "todo", body: TEMPLATE_BODY },
      { id: "FD-T2", status: "todo" },
      { id: "FD-T3", status: "done", body: TEMPLATE_BODY },
    ],
    state: { tasks: { "FD-T3": taskState("done") } },
  });
  writeGoal(ws, "FD-G9", { archived: true, tasks: [{ id: "FD-T9", status: "todo", body: TEMPLATE_BODY }] });

  const unwritten = withCode(await doctor(ws, { scope: "all" }), "task-body-placeholder");
  assert.deepEqual(unwritten.map((f) => f.message.split(" ")[0]), ["FD-T1"], "only live, unstarted work");
  assert.match(unwritten[0].fix ?? "", /goals\/FD-G1\/tasks\/FD-T1\.md/);
  rm(ws);
});

test("doctor notes requirements approved within a minute with no delegation on record", async () => {
  const ws = makeWorkspace();
  const req = (id: string, created: string, decided: string, extra = ""): void =>
    fs.writeFileSync(
      path.join(ws, "requirements", `${id}.md`),
      `---\nid: ${id}\nstatus: approved\ncreatedAt: ${created}\ndecidedAt: ${decided}\n${extra}---\n\nbody\n`
    );
  const t0 = Date.now() - DAY;
  const at = (offset: number): string => new Date(t0 + offset).toISOString();
  req("FD-R1", at(0), at(12_000));
  req("FD-R2", at(0), at(12_000), "delegation:\n  by: a-lead\n");
  req("FD-R3", at(0), at(5 * 60_000));

  const fast = withCode(await doctor(ws), "requirement-fast-approval");
  assert.equal(fast.length, 1);
  assert.equal(fast[0].severity, "info", "speed alone proves nothing, so it is informational");
  assert.match(fast[0].message, /FD-R1 was approved 12s after it was written/);
  rm(ws);
});

test("doctor warns when the workspace root is a git repo, loudest when it has no commits", async () => {
  const ws = makeWorkspace();
  execFileSync("git", ["init", "-q"], { cwd: ws });

  let findings = await doctor(ws);
  assert.equal(withCode(findings, "workspace-root-git-empty")[0]?.severity, "warn");
  assert.match(withCode(findings, "workspace-root-git-empty")[0].message, /Git Graph/);

  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  findings = await doctor(ws);
  assert.equal(withCode(findings, "workspace-root-git-empty").length, 0);
  assert.equal(withCode(findings, "workspace-root-git-repo")[0]?.severity, "info");
  assert.match(withCode(findings, "workspace-root-git-repo")[0].fix ?? "", /FD\.code-workspace/);
  rm(ws);
});

test("doctor classifies open runs as possibly live, quiet or abandoned, with a legal fix", async () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  const run = (id: string): string => `2026-11-01T01-00-00_${id}`;
  writeGoal(ws, "FD-G1", {
    tasks: ["FD-T1", "FD-T2", "FD-T3", "FD-T4"].map((id) => ({ id, status: "running" })),
    state: {
      tasks: {
        // Old events, but its owner process (this test) is alive on this host.
        "FD-T1": taskState("running", {
          lastRunId: run("FD-T1"),
          owner: { runId: run("FD-T1"), pid: process.pid, host: os.hostname(), actor: "human", startedAt: ago(3 * DAY), heartbeatAt: ago(3 * DAY) },
        }),
        "FD-T2": taskState("running", { lastRunId: run("FD-T2") }),
        "FD-T3": taskState("running", { lastRunId: run("FD-T3") }),
        "FD-T4": taskState("running", { lastRunId: run("FD-T4") }),
      },
    },
  });
  writeEvents(ws, run("FD-T1"), [{ t: ago(3 * DAY), kind: "run.start" }]);
  writeEvents(ws, run("FD-T2"), [{ t: ago(10 * 60_000), kind: "run.start" }]);
  writeEvents(ws, run("FD-T3"), [{ t: ago(5 * HOUR), kind: "run.start" }]);
  writeEvents(ws, run("FD-T4"), [{ t: ago(3 * DAY), kind: "run.start" }]);

  const findings = await doctor(ws);
  const live = withCode(findings, "run-open-possibly-live").map((f) => f.message.split(":")[0]).sort();
  assert.deepEqual(live, ["FD-T1", "FD-T2"]);
  assert.match(withCode(findings, "run-open-possibly-live").find((f) => f.message.startsWith("FD-T1"))!.message, /owner process/);
  assert.deepEqual(withCode(findings, "run-open-quiet").map((f) => f.message.split(":")[0]), ["FD-T3"]);
  const abandoned = withCode(findings, "run-abandoned");
  assert.deepEqual(abandoned.map((f) => f.message.split(":")[0]), ["FD-T4"]);
  assert.equal(abandoned[0].fix, '`awo task complete FD-T4 --outcome failed --summary "abandoned"`');

  // `running -> todo` is refused by the transition table; doctor must never advise it.
  for (const f of findings) assert.doesNotMatch(f.fix ?? "", /task status \S+ todo/, f.fix);
  rm(ws);
});

test("a malformed task file is reported by name instead of crashing doctor", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", { tasks: [{ id: "FD-T1" }] });
  const tasks = path.join(ws, "goals", "FD-G1", "tasks");
  fs.writeFileSync(path.join(tasks, "FD-T8.md"), "---\nid: [unclosed\n---\n\nbroken yaml\n");
  fs.writeFileSync(path.join(tasks, "FD-T9.md"), "---\nid: FD-T9\nstatus: todo\n---\n\nno goal id\n");
  fs.writeFileSync(path.join(tasks, "FD-T7.md"), "---\nid: FD-T7\ngoalId: FD-G1\nkind: spike\n---\n\nunknown kind\n");

  const out = awo(ws, ["doctor", "--all"]);
  assert.equal(out.code, 1, "a malformed file is an error");
  assert.match(out.stdout, /goals\/FD-G1\/tasks\/FD-T8\.md: its frontmatter does not parse/);
  assert.match(out.stdout, /goals\/FD-G1\/tasks\/FD-T9\.md: no `goalId:`/);
  assert.match(out.stdout, /FD-T7\.md: kind "spike" is not one of/);
  assert.match(out.stdout, /task and goal checks were skipped/);
  rm(ws);
});

test("doctor flags folders under goals/ that are not goals, and empty stray files at the root", async () => {
  const ws = makeWorkspace();
  fs.mkdirSync(path.join(ws, "goals", "scratch-notes"), { recursive: true });
  fs.writeFileSync(path.join(ws, "goals", "scratch-notes", "idea.md"), "an idea\n");
  fs.mkdirSync(path.join(ws, "goals", "archive"), { recursive: true });
  fs.writeFileSync(path.join(ws, "5}{n:"), "");
  fs.writeFileSync(path.join(ws, ".keep"), "");
  fs.writeFileSync(path.join(ws, "notes.txt"), "not empty\n");

  const findings = await doctor(ws);
  const folders = withCode(findings, "goals-folder-not-goal");
  assert.deepEqual(folders.map((f) => f.message.split("/ ")[0]), ["goals/scratch-notes"], "goals/archive is a container, not a stray");
  const stray = withCode(findings, "stray-empty-file");
  assert.deepEqual(stray.map((f) => f.fix), ["rm -- '5}{n:'"], "dotfiles and non-empty files are left alone");
  rm(ws);
});

test("a verification task proven by manual criterion evidence is not flagged for missing tests", async () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    tasks: [
      { id: "FD-T1", status: "done", kind: "verification" },
      { id: "FD-T2", status: "done", kind: "verification" },
    ],
    state: {
      tasks: {
        "FD-T1": taskState("done", { lastRunId: "2026-11-01T01-00-00_FD-T1" }),
        "FD-T2": taskState("done", { lastRunId: "2026-11-01T02-00-00_FD-T2" }),
      },
      criteria: { "1": [{ taskId: "FD-T1", kind: "manual", ref: "walked the flow", recordedAt: ago(0) }] },
    },
  });

  const untested = withCode(await doctor(ws), "run-no-test-evidence");
  assert.deepEqual(untested.map((f) => f.message.split(" ")[0]), ["FD-T2"]);
  rm(ws);
});

test("doctor --secrets reports which log files hold credentials, never the values", () => {
  const ws = makeWorkspace();
  const day = path.join(ws, "logs", "2026-11-01");
  fs.mkdirSync(path.join(day, "workers"), { recursive: true });
  fs.writeFileSync(
    path.join(day, "runs.jsonl"),
    `${JSON.stringify({ type: "event", kind: "test", command: "DB_PASSWORD=hunter2 npm test" })}\n` +
      `${JSON.stringify({ type: "event", kind: "test", command: "npm test" })}\n`
  );
  fs.writeFileSync(path.join(day, "workers", "w.log"), "mysql -uroot -ps3cret app\nok\nAPI_TOKEN=abc123 run\n");

  assert.doesNotMatch(awo(ws, ["doctor"]).stdout, /credential/, "opt-in only");

  const out = awo(ws, ["doctor", "--secrets", "--all"]);
  assert.match(out.stdout, /logs\/2026-11-01\/runs\.jsonl records 1 line\(s\) with a credential/);
  assert.match(out.stdout, /logs\/2026-11-01\/workers\/w\.log records 2 line\(s\) with a credential/);
  assert.doesNotMatch(out.stdout, /hunter2|s3cret|abc123/, "a diagnostic must not reprint the secret");
  rm(ws);
});

test("doctor --json keeps the array shape and adds a stable code to findings", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  const out = awo(ws, ["doctor", "--json"]);
  const findings = JSON.parse(out.stdout) as Finding[];
  assert.ok(Array.isArray(findings));
  const noTest = findings.find((f) => f.message.includes("has no testCommand"));
  assert.equal(noTest?.code, "repo-no-test-command");
  assert.equal(noTest?.area, "repos");
  rm(ws);
});

// ---------------------------------------------------------------------------
// F2 — goal close
// ---------------------------------------------------------------------------

/** Intake -> governed goal with one todo task, through the real CLI. */
function governedGoal(ws: string): void {
  awo(ws, ["req", "new", "--title", "Thing"]);
  const file = path.join(ws, "requirements", "FD-R1.md");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- _…_", "- Given a precondition, when the action happens, then the outcome holds")
  );
  awo(ws, ["req", "propose", "FD-R1"]);
  awo(ws, ["req", "approve", "FD-R1"]);
  awo(ws, ["goal", "new", "--from", "FD-R1"]);
  awo(ws, ["task", "new", "--goal", "FD-G1", "--name", "Work", "--targets", "api"]);
}

function snapshot(dir: string): string {
  return execFileSync("find", [".", "-type", "f"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .sort()
    .map((f) => (f ? `${f}:${createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")}` : ""))
    .join("\n");
}

test("goal close --dry-run lists every blocker as an exact command and writes nothing", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  governedGoal(ws);
  const before = snapshot(path.join(ws, "goals"));

  const dry = awo(ws, ["goal", "close", "FD-G1", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /FD-G1 \(\S+\) cannot close yet/);
  assert.match(dry.stdout, /\n\s+awo task run FD-T1\n/);
  assert.match(dry.stdout, /\n\s+awo task evidence FD-T1 --criterion 1 --kind test/);
  assert.match(dry.stdout, /\n\s+awo goal verify FD-G1\n/);
  assert.match(dry.stdout, /awo goal verdict FD-G1 --pass --summary "…" --who "<human>"/);
  assert.match(dry.stdout, /dry run — nothing was touched/);
  assert.equal(snapshot(path.join(ws, "goals")), before, "a dry run must not write");

  const refused = awo(ws, ["goal", "close", "FD-G1"]);
  assert.equal(refused.code, 1, "a blocked close exits non-zero");
  assert.match(refused.stdout, /Nothing was changed/);
  assert.ok(fs.existsSync(path.join(ws, "goals", "FD-G1", "goal.md")), "a blocked goal stays live");
  assert.equal(snapshot(path.join(ws, "goals")), before);
  rm(ws);
});

test("goal close archives a finished goal and prunes its clean worktrees", () => {
  const ws = makeWorkspace();
  const repo = linkRepo(ws, { git: true });
  writeGoal(ws, "FD-G1", { tasks: [{ id: "FD-T1" }] });
  assert.equal(awo(ws, ["task", "run", "FD-T1"]).code, 0);
  const worktree = path.join(ws, "repos", ".worktrees", "api", "FD-T1");
  assert.ok(fs.existsSync(worktree), "precondition: task run made a worktree");
  const done = awo(ws, ["task", "complete", "FD-T1", "--outcome", "success", "--untested", "fixture"]);
  assert.equal(done.code, 0, done.stderr);

  const dry = awo(ws, ["goal", "close", "FD-G1", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /FD-G1 \(done\) can close/);
  assert.match(dry.stdout, /would prune repos\/\.worktrees\/api\/FD-T1/);
  assert.ok(fs.existsSync(worktree) && fs.existsSync(path.join(ws, "goals", "FD-G1")), "dry run touched nothing");

  const closed = awo(ws, ["goal", "close", "FD-G1"]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stdout, /FD-G1 \(done\) closed: archived to goals\/archive\/FD-G1/);
  assert.match(closed.stdout, /pruned repos\/\.worktrees\/api\/FD-T1/);
  assert.ok(fs.existsSync(path.join(ws, "goals", "archive", "FD-G1", "goal.md")));
  assert.ok(!fs.existsSync(worktree), "the clean worktree is gone");
  assert.doesNotMatch(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }), /FD-T1/);

  assert.match(awo(ws, ["goal", "close", "FD-G1"]).stderr, /already closed and archived/);
  rm(ws, repo);
});

test("goal close refuses while a worktree still holds work", () => {
  const ws = makeWorkspace();
  const repo = linkRepo(ws, { git: true });
  writeGoal(ws, "FD-G1", { tasks: [{ id: "FD-T1" }] });
  awo(ws, ["task", "run", "FD-T1"]);
  awo(ws, ["task", "complete", "FD-T1", "--outcome", "success", "--untested", "fixture"]);
  const worktree = path.join(ws, "repos", ".worktrees", "api", "FD-T1");
  fs.writeFileSync(path.join(worktree, "wip.txt"), "uncommitted\n");

  const out = awo(ws, ["goal", "close", "FD-G1"]);
  assert.equal(out.code, 1);
  assert.match(out.stdout, /uncommitted changes in the checkout/);
  assert.match(out.stdout, /awo worktree prune --task FD-T1 --force/);
  assert.ok(fs.existsSync(path.join(worktree, "wip.txt")), "nothing was removed");
  assert.ok(fs.existsSync(path.join(ws, "goals", "FD-G1", "goal.md")), "nothing was archived");
  rm(ws, repo);
});

test("goal close waits for linked PRs to merge, with --unmerged-ok for one that landed another way", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  const pr = (state: string | undefined): Record<string, unknown> => ({
    repo: "api", number: 7, url: "https://example.invalid/pr/7", branch: "feature/FD-T1", headSha: "abc",
    isDraft: false, mergeState: "CLEAN", checks: "passing", reviews: "approved", lastCheckedAt: ago(0), feedback: {},
    ...(state ? { state, merged: state === "MERGED" } : {}),
  });
  const seed = (state: string | undefined): void => {
    writeGoal(ws, "FD-G1", {
      tasks: [{ id: "FD-T1", status: "done" }],
      state: { tasks: { "FD-T1": taskState("done", { pullRequest: pr(state) }) } },
    });
  };

  seed("OPEN");
  let out = awo(ws, ["goal", "close", "FD-G1", "--dry-run"]);
  assert.match(out.stdout, /FD-T1's PR api#7 is still open/);
  assert.match(out.stdout, /\n\s+awo pr reconcile --all\n/);

  seed(undefined);
  assert.match(awo(ws, ["goal", "close", "FD-G1", "--dry-run"]).stdout, /no merge state on record/);

  seed("CLOSED");
  out = awo(ws, ["goal", "close", "FD-G1"]);
  assert.equal(out.code, 1);
  assert.match(out.stdout, /closed without merging/);
  assert.match(out.stdout, /awo goal close FD-G1 --unmerged-ok/);

  const forced = awo(ws, ["goal", "close", "FD-G1", "--unmerged-ok"]);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.ok(fs.existsSync(path.join(ws, "goals", "archive", "FD-G1")));
  rm(ws);
});

test("goal close files away a governed goal whose every task was cancelled", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", {
    governed: true,
    tasks: [{ id: "FD-T1", status: "cancelled" }],
    state: { tasks: { "FD-T1": taskState("cancelled") } },
  });
  const out = awo(ws, ["goal", "close", "FD-G1"]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /FD-G1 \(cancelled\) closed/);
  rm(ws);
});

// ---------------------------------------------------------------------------
// F3 — upgrade safety
// ---------------------------------------------------------------------------

const hash = (buf: string | Buffer): string => `sha256-${createHash("sha256").update(buf).digest("hex")}`;

function setManifest(ws: string, patch: Record<string, unknown>): void {
  const file = path.join(ws, ".workspace", "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }, null, 2));
}
function lockOf(ws: string): { libraryVersion: string; files: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "template.lock"), "utf8"));
}
function writeLock(ws: string, lock: unknown): void {
  fs.writeFileSync(path.join(ws, ".workspace", "template.lock"), JSON.stringify(lock, null, 2));
}

/** Make `rule` look unmodified-but-outdated, so the next upgrade replaces (and backs it up). */
function staleRule(ws: string, rel: string, marker: string): void {
  const file = path.join(ws, ...rel.split("/"));
  fs.appendFileSync(file, `\n${marker}\n`);
  const lock = lockOf(ws);
  lock.files[rel] = hash(fs.readFileSync(file));
  writeLock(ws, lock);
  setManifest(ws, { libraryVersion: "0.0.1" });
}

test("every upgrade gets its own timestamped backup, so a re-run never overwrites the first", () => {
  const ws = makeWorkspace("UP");
  const rel = "rules/no-push-to-main.md";
  const backups = path.join(ws, ".workspace", "upgrade-backups");

  staleRule(ws, rel, "first edition");
  assert.equal(awo(ws, ["upgrade"]).code, 0);
  staleRule(ws, rel, "second edition");
  assert.equal(awo(ws, ["upgrade"]).code, 0);

  const dirs = fs.readdirSync(backups).sort();
  assert.equal(dirs.length, 2, `two upgrades, two backups: ${dirs.join(", ")}`);
  for (const dir of dirs) assert.match(dir, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_0\\.0\\.1-to-${INSTALLED.replace(/\./g, "\\.")}`));
  assert.match(fs.readFileSync(path.join(backups, dirs[0], rel), "utf8"), /first edition/);
  assert.match(fs.readFileSync(path.join(backups, dirs[1], rel), "utf8"), /second edition/);
  rm(ws);
});

test("the legacy .worktrees migration preserves the checkouts instead of deleting them", () => {
  const ws = makeWorkspace("UP");
  setManifest(ws, { libraryVersion: "0.0.31" });
  const legacy = path.join(ws, ".worktrees", "api", "UP-T1");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "unpushed.txt"), "work nobody pushed\n");

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(!fs.existsSync(path.join(ws, ".worktrees")), "nothing is left where nothing reads it");

  const kept = fs.readdirSync(path.join(ws, ".workspace")).filter((d) => d.startsWith("legacy-worktrees-"));
  assert.equal(kept.length, 1);
  const moved = path.join(ws, ".workspace", kept[0]);
  assert.equal(fs.readFileSync(path.join(moved, "api", "UP-T1", "unpushed.txt"), "utf8"), "work nobody pushed\n");
  assert.equal(fs.readFileSync(path.join(moved, ".gitignore"), "utf8"), "*\n", "kept out of a workspace repo's status");
  assert.match(out.stdout, new RegExp(`note: preserved the legacy \\.worktrees/ checkouts in \\.workspace/${kept[0]}/ \\(api/UP-T1\\)`));
  rm(ws);
});

test("a migration move onto an existing path stops the upgrade instead of overwriting", () => {
  const ws = makeWorkspace("UP");
  setManifest(ws, { libraryVersion: "0.0.31" });
  for (const dir of ["UP-G1-an-old-slug", "UP-G1"]) {
    fs.mkdirSync(path.join(ws, "goals", dir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(ws, "goals", dir, "goal.md"), `---\nid: UP-G1\n---\n\nfrom ${dir}\n`);
  }

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /Upgrade stopped: moving goals\/UP-G1-an-old-slug to goals\/UP-G1 would overwrite/);
  assert.match(out.stderr, /re-run `awo upgrade`/);
  for (const dir of ["UP-G1-an-old-slug", "UP-G1"]) {
    assert.match(fs.readFileSync(path.join(ws, "goals", dir, "goal.md"), "utf8"), new RegExp(`from ${dir}`), "both copies survive");
  }
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")).libraryVersion,
    "0.0.31",
    "a stopped upgrade does not bump the version"
  );

  // Resolved by hand, the same upgrade completes.
  fs.rmSync(path.join(ws, "goals", "UP-G1-an-old-slug"), { recursive: true });
  assert.equal(awo(ws, ["upgrade"]).code, 0);
  rm(ws);
});

test("awo's own edits to .vscode/settings.json are not drift and never produce a conflict", () => {
  const ws = makeWorkspace("UP");
  const repo = linkRepo(ws);
  const settings = path.join(ws, ".vscode", "settings.json");
  assert.ok(JSON.parse(fs.readFileSync(settings, "utf8"))["git.scanRepositories"], "precondition: connect wrote it");

  setManifest(ws, { libraryVersion: "0.0.1" });
  const plan = awo(ws, ["upgrade", "--dry-run"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.doesNotMatch(plan.stdout, /user-edited|conflict|settings\.json/, plan.stdout);

  // An older template lacked a key the current one ships; awo regenerated the file
  // since. Both moved — but only the template's move is a real change.
  const current = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "templates", "default", ".vscode", "settings.json"), "utf8"));
  const older = { ...current };
  delete older["git-graph.maxDepthOfRepoSearch"];
  const olderText = `${JSON.stringify(older, null, 2)}\n`;
  fs.writeFileSync(settings, `${JSON.stringify({ ...older, "git.scanRepositories": [repo] }, null, 2)}\n`);
  fs.writeFileSync(path.join(ws, ".workspace", "template-base", ".vscode", "settings.json"), olderText);
  const lock = lockOf(ws);
  lock.files[".vscode/settings.json"] = hash(olderText);
  writeLock(ws, lock);

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /settings\.json/, "it must not be reported as customized");
  assert.ok(!fs.existsSync(`${settings}.new`), "no conflict file for a file awo wrote");
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(after["git-graph.maxDepthOfRepoSearch"], 2, "the template change landed");
  assert.deepEqual(after["git.scanRepositories"], [repo], "and awo's own key was regenerated");
  rm(ws, repo);
});

test("upgrade --preview is --dry-run", () => {
  const ws = makeWorkspace("UP");
  setManifest(ws, { libraryVersion: "0.0.1" });
  const manifest = fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8");
  const out = awo(ws, ["upgrade", "--preview"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\(dry run\)/);
  assert.equal(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8"), manifest);
  rm(ws);
});

// ---------------------------------------------------------------------------
// F4 — agent / skill / rule remove
// ---------------------------------------------------------------------------

const generated = (ws: string, block: string): string =>
  new RegExp(`<!-- awo:generated ${block} -->([\\s\\S]*?)<!-- /awo:generated -->`).exec(
    fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")
  )?.[1] ?? "";

test("rule remove refuses while an agent cites the rule, and --force removes it anyway", () => {
  const ws = makeWorkspace();
  const refused = awo(ws, ["rule", "remove", "stay-in-scope"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /rule "stay-in-scope" is still referenced/);
  assert.match(refused.stderr, /agents\/software-engineer\.md: rules: stay-in-scope/);
  assert.match(refused.stderr, /awo rule remove stay-in-scope --force/);
  assert.ok(fs.existsSync(path.join(ws, "rules", "stay-in-scope.md")));

  const forced = awo(ws, ["rule", "remove", "stay-in-scope", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /still referenced: agents\/software-engineer\.md/);
  assert.ok(!fs.existsSync(path.join(ws, "rules", "stay-in-scope.md")));
  assert.doesNotMatch(generated(ws, "rules"), /stay-in-scope/, "the generated list is refreshed");

  // An unreferenced rule goes without ceremony.
  assert.equal(awo(ws, ["rule", "remove", "record-every-run"]).code, 0);
  assert.doesNotMatch(generated(ws, "rules"), /record-every-run/);
  rm(ws);
});

test("agent remove refuses while a live task or AGENTS.md prose names the role", () => {
  const ws = makeWorkspace();
  linkRepo(ws);
  writeGoal(ws, "FD-G1", { tasks: [{ id: "FD-T1", agent: "code-reviewer" }] });

  const refused = awo(ws, ["agent", "remove", "code-reviewer"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /goals\/FD-G1\/tasks\/FD-T1\.md: agent: code-reviewer/);

  const prose = awo(ws, ["agent", "remove", "software-engineer"]);
  assert.equal(prose.code, 1);
  assert.match(prose.stderr, /AGENTS\.md: line \d+/);

  // Once the goal is archived the task is history, not a dependency.
  fs.mkdirSync(path.join(ws, "goals", "archive"), { recursive: true });
  fs.renameSync(path.join(ws, "goals", "FD-G1"), path.join(ws, "goals", "archive", "FD-G1"));
  const removed = awo(ws, ["agent", "remove", "code-reviewer"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.doesNotMatch(generated(ws, "agents"), /code-reviewer/);
  rm(ws);
});

test("a removed template file stays removed through a later upgrade, even without a lock entry", () => {
  const ws = makeWorkspace("UP");
  const rel = "agents/release-engineer.md";
  const lock = lockOf(ws);
  delete lock.files[rel];
  writeLock(ws, lock);

  const out = awo(ws, ["agent", "remove", "release-engineer"]);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(lockOf(ws).files[rel], "the lock now records it, so upgrade reads the absence as a choice");

  setManifest(ws, { libraryVersion: "0.0.1" });
  const upgraded = awo(ws, ["upgrade"]);
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /user-deleted: 1/);
  assert.ok(!fs.existsSync(path.join(ws, rel)), "upgrade must not resurrect a removed role");
  rm(ws);
});

test("skill remove refuses while a role lists the skill, and points back at the catalog", () => {
  const ws = makeWorkspace();
  const refused = awo(ws, ["skill", "remove", "run-tests"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /agents\/software-engineer\.md: skills: run-tests/);

  assert.equal(awo(ws, ["skill", "add", "review-logs"]).code, 0);
  assert.match(generated(ws, "skills"), /review-logs/);
  const removed = awo(ws, ["skill", "remove", "review-logs"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /Reinstall with: awo skill add review-logs/);
  assert.doesNotMatch(generated(ws, "skills"), /review-logs/);

  assert.match(awo(ws, ["skill", "remove", "nope"]).stderr, /No skill "nope" at skills\/nope\.md\. Installed:/);
  rm(ws);
});
