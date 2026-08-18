import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

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

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-plan-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "PL"], { cwd: dir });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-planrepo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: dir });
  return dir;
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

test("req -> goal -> task walks the whole pipeline and allocates IDs in order", () => {
  const ws = makeWorkspace();

  const req = awo(ws, ["req", "new", "--title", "Add SSO login", "--source", "stakeholder: Priya"]);
  assert.equal(req.code, 0, req.stderr);
  assert.match(req.stdout, /PL-R1 created at requirements\/PL-R1\.md/);

  const reqBody = fs.readFileSync(path.join(ws, "requirements", "PL-R1.md"), "utf8");
  assert.match(reqBody, /id: PL-R1/);
  assert.match(reqBody, /status: draft/);
  assert.match(reqBody, /source: 'stakeholder: Priya'|source: "stakeholder: Priya"|source: stakeholder/);
  assert.match(reqBody, /## Raw requirement/);
  approveRequirement(ws, "PL-R1");

  // A second requirement takes the next number, not R1 again.
  assert.match(awo(ws, ["req", "new", "--title", "Second ask"]).stdout, /PL-R2/);

  const goal = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(goal.code, 0, goal.stderr);
  assert.match(goal.stdout, /PL-G1 created at goals\/PL-G1\//);

  const goalDir = path.join(ws, "goals", "PL-G1");
  // The requirement moved into the goal folder (§4) and gained its goalId.
  assert.ok(!fs.existsSync(path.join(ws, "requirements", "PL-R1.md")), "requirement must move, not be copied");
  const moved = fs.readFileSync(path.join(goalDir, "requirement.md"), "utf8");
  assert.match(moved, /goalId: PL-G1/);
  assert.match(fs.readFileSync(path.join(goalDir, "goal.md"), "utf8"), /requirementId: PL-R1/);

  const t1 = awo(ws, [
    "task", "new", "--goal", "PL-G1", "--name", "Add OIDC config",
    "--targets", "api", "--agent", "software-engineer",
  ]);
  assert.equal(t1.code, 0, t1.stderr);
  assert.match(t1.stdout, /PL-T1 created at goals\/PL-G1\/tasks\/PL-T1\.md/);

  const t2 = awo(ws, [
    "task", "new", "--goal", "PL-G1", "--name", "Login UI",
    "--targets", "api", "--depends-on", "PL-T1",
  ]);
  assert.equal(t2.code, 0, t2.stderr);

  // taskIds on the goal are kept in sync — nothing else maintains that link.
  const goalMd = fs.readFileSync(path.join(goalDir, "goal.md"), "utf8");
  assert.match(goalMd, /PL-T1/);
  assert.match(goalMd, /PL-T2/);

  // And the result is immediately runnable by the §7.4 machinery.
  const listed = awo(ws, ["task", "list"]);
  assert.match(listed.stdout, /PL-T1\ttodo/);
  assert.match(listed.stdout, /PL-T2\ttodo/);

  const run = awo(ws, ["task", "run", "PL-T1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /PL-T1 is running/);

  // Strict goals keep successful work in review, but that must still unblock
  // dependent implementation work or every dependency chain deadlocks before QA.
  awo(ws, ["task", "complete", "PL-T1", "--outcome", "success", "--untested", "fixture"]);
  assert.match(awo(ws, ["task", "show", "PL-T1"]).stdout, /status:   in-review/);
  assert.match(
    awo(ws, ["context"]).stdout,
    /NEXT.*start PL-T2/,
    "an in-review predecessor must not hide the next runnable task"
  );
  assert.equal(awo(ws, ["task", "run", "PL-T2"]).code, 0);

  const goals = awo(ws, ["goal", "list"]);
  assert.match(goals.stdout, /PL-G1\t0\/2 done/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("a requirement id is never reissued after it moves into a goal folder", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "First ask"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  // PL-R1 now lives at goals/PL-G1/requirement.md, invisible in the
  // goals/ listing — but it is still referenced by goal.md's requirementId, so
  // reusing the number would give two requirements the same id.
  const second = awo(ws, ["req", "new", "--title", "Second ask"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /PL-R2 created/, "must not reissue PL-R1");
  assert.ok(!fs.existsSync(path.join(ws, "requirements", "PL-R1.md")));

  // Same for goal ids after a goal exists.
  approveRequirement(ws, "PL-R2");
  awo(ws, ["goal", "new", "--from", "PL-R2"]);
  assert.match(
    fs.readdirSync(path.join(ws, "goals")).join(" "),
    /PL-G1.*PL-G2|PL-G2.*PL-G1/
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal new rejects an unknown requirement and names what exists", () => {
  const ws = makeWorkspace();
  const empty = awo(ws, ["goal", "new", "--from", "PL-R9"]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /No requirement "PL-R9"/);
  assert.match(empty.stderr, /awo req new/);

  awo(ws, ["req", "new", "--title", "Real one"]);
  const wrong = awo(ws, ["goal", "new", "--from", "PL-R7"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Available: PL-R1/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("task new validates goal, targets and dependsOn before writing anything", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Thing"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  const goalDir = path.join(ws, "goals", "PL-G1");

  const badGoal = awo(ws, ["task", "new", "--goal", "PL-G9", "--name", "x"]);
  assert.equal(badGoal.code, 1);
  assert.match(badGoal.stderr, /Unknown goal "PL-G9".*Known goals: PL-G1/s);

  const badTarget = awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "x", "--targets", "nope"]);
  assert.equal(badTarget.code, 1);
  assert.match(badTarget.stderr, /Targets not in the manifest: nope/);

  const badDep = awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "x", "--depends-on", "PL-T7"]);
  assert.equal(badDep.code, 1);
  assert.match(badDep.stderr, /unknown task "PL-T7"/);

  assert.deepEqual(
    fs.readdirSync(path.join(goalDir, "tasks")),
    [],
    "no task file may be written when validation fails"
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("task new atomically reopens a stored done goal and invalidates its QA verdict", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Thing"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Original", "--targets", "api"]);

  const stateFile = path.join(ws, "goals", "PL-G1", "state.json");
  const doneTask = {
    status: "done", lastRunOutcome: "success", lastRunId: "old-run",
    startedAt: null, finishedAt: new Date().toISOString(), attempts: 1,
    worktree: null, blockedReason: null,
  };
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      rev: 2, goalId: "PL-G1", goalStatus: "done", updatedAt: new Date().toISOString(),
      tasks: { "PL-T1": doneTask },
      qa: {
        briefRunId: "old-brief", briefRecordedAt: new Date().toISOString(), verdict: "pass",
        summary: "old pass", verdictRunId: "old-verdict", verdictRecordedAt: new Date().toISOString(),
        model: "fixture",
      },
    }, null, 2)
  );

  const created = awo(ws, [
    "task", "new", "--goal", "PL-G1", "--name", "Late-discovered work", "--targets", "api",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    goalStatus: string; tasks: Record<string, { status: string }>; qa?: unknown;
  };
  assert.equal(state.tasks["PL-T2"].status, "todo");
  assert.equal(state.goalStatus, "planning");
  assert.equal(state.qa, undefined, "new work makes an earlier QA pass stale immediately");
  assert.match(awo(ws, ["goal", "list"]).stdout, /PL-G1\t1\/2 done/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("ID allocation skips numbers already used by hand-authored files", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "One"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  // Someone hand-authors PL-T1 and PL-T2; the next allocation must be T3.
  const tasksDir = path.join(ws, "goals", "PL-G1", "tasks");
  for (const n of [1, 2]) {
    fs.writeFileSync(
      path.join(tasksDir, `PL-T${n}.md`),
      `---\nid: PL-T${n}\ngoalId: PL-G1\nname: Manual ${n}\nstatus: todo\n---\n\nx\n`
    );
  }
  const next = awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Third"]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /PL-T3 created/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("doctor reports a clean workspace, and finds broken targets, deps and links", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Thing"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Work", "--targets", "api"]);

  const clean = awo(ws, ["doctor"]);
  assert.equal(clean.code, 0, "a healthy workspace must exit 0");
  assert.match(clean.stdout, /No problems found\.|0 error\(s\)/);

  // Break things: a bad target, a bad dependency, and a missing repo link.
  const tasksDir = path.join(ws, "goals", "PL-G1", "tasks");
  fs.writeFileSync(
    path.join(tasksDir, "PL-T9.md"),
    `---\nid: PL-T9\ngoalId: PL-G1\nname: Broken\ntargets: [ghost]\ndependsOn: [PL-T42]\nstatus: todo\n---\n\nx\n`
  );
  fs.rmSync(path.join(ws, "repos", "api"), { recursive: true, force: true });

  const broken = awo(ws, ["doctor"]);
  assert.equal(broken.code, 1, "errors must set a non-zero exit code");
  assert.match(broken.stdout, /targets "ghost", which is not in the manifest/);
  assert.match(broken.stdout, /dependsOn "PL-T42", which does not exist/);
  assert.match(broken.stdout, /api: missing from repos\//);
  assert.match(broken.stdout, /taskIds/, "an unlisted task must be reported");

  // sync puts the missing link back.
  const synced = awo(ws, ["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.match(synced.stdout, /api\tlinked|api\tup-to-date/);
  assert.match(awo(ws, ["doctor"]).stdout, /0 error\(s\)|ghost/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("doctor flags a run that was opened but never closed", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Thing"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Work", "--targets", "api"]);
  awo(ws, ["task", "run", "PL-T1"]);

  const out = awo(ws, ["doctor"]);
  assert.match(out.stdout, /PL-T1: run .* was opened but never closed/);
  assert.match(out.stdout, /awo task complete PL-T1/);

  awo(ws, ["task", "complete", "PL-T1", "--outcome", "success", "--untested", "fixture"]);
  assert.ok(
    !/never closed/.test(awo(ws, ["doctor"]).stdout),
    "closing the run must clear the warning"
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sync relinks a local repo whose symlink points at the wrong path", () => {
  const ws = makeWorkspace();
  const link = path.join(ws, "repos", "api");
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(os.tmpdir(), link, "dir");

  const out = awo(ws, ["sync"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /api\trelinked/);
  assert.match(awo(ws, ["list"]).stdout, /api\tlocal\tpresent/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sync reports a local repo whose source has disappeared, and exits non-zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-gone-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "GN"], { cwd: dir });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-gonerepo-"));
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "temp"], { cwd: dir });
  fs.rmSync(repo, { recursive: true, force: true });

  const out = awo(dir, ["sync"]);
  assert.equal(out.code, 1, "an unusable repo must set a non-zero exit code");
  assert.match(out.stdout, /temp\tsource-missing/);
  assert.match(awo(dir, ["doctor"]).stdout, /source path no longer exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("context orients a new session and says what to do next", () => {
  const ws = makeWorkspace();

  // Empty workspace: the next step is intake, not a scan.
  let out = awo(ws, ["context"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^PL · PL · awo /m);
  assert.match(out.stdout, /repos {9}1 linked, 1 present/);
  assert.match(out.stdout, /goals {9}none yet/);
  assert.match(out.stdout, /NEXT.*awo req new/);

  // A requirement in intake is surfaced — it is invisible on the board otherwise.
  awo(ws, ["req", "new", "--title", "Thing"]);
  out = awo(ws, ["context"]);
  assert.match(out.stdout, /in intake {5}PL-R1 \(not yet a goal\)/);
  assert.match(out.stdout, /NEXT.*awo req refine PL-R1/);

  approveRequirement(ws, "PL-R1");

  out = awo(ws, ["context"]);
  assert.match(out.stdout, /NEXT.*awo goal new --from PL-R1/);

  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Work", "--targets", "api"]);
  out = awo(ws, ["context"]);
  assert.match(out.stdout, /goal {10}PL-G1 planning — 0\/1 done/);
  assert.match(out.stdout, /NEXT.*awo task run PL-T1/);

  // An open run is the most urgent thing, and a blocked task explains itself.
  awo(ws, ["task", "run", "PL-T1", "--no-worktree"]);
  assert.match(awo(ws, ["context"]).stdout, /NEXT.*PL-T1 is running/);

  awo(ws, ["task", "complete", "PL-T1", "--outcome", "failed", "--summary", "tests red"]);
  out = awo(ws, ["context"]);
  assert.match(out.stdout, /PL-T1 blocked — tests red/);
  assert.match(out.stdout, /NEXT.*unblock PL-T1/);
  assert.match(out.stdout, /history {7}1 runs · 0% success/);

  // --json is the same data for a machine.
  const j = JSON.parse(awo(ws, ["context", "--json"]).stdout);
  assert.equal(j.snapshot.project.projectKey, "PL");
  assert.match(j.next, /unblock PL-T1/);
  assert.equal(j.recent.length, 1);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("only medium and high effort are selectable; low is normalized", () => {
  const ws = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const set = (effort: string): void => {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.models = { tiers: { low: { runtime: "codex", model: "gpt-5.4-mini", effort } } };
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  };
  awo(ws, ["req", "new", "--title", "T"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "W", "--targets", "api", "--agent", "software-engineer"]);

  set("high");
  assert.match(awo(ws, ["task", "run", "PL-T1", "--no-worktree"]).stdout, /effort=high/);
  awo(ws, ["task", "complete", "PL-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "PL-T1", "todo"]);

  // `low` was dropped on evidence (§9 item 47) but must not break a policy that
  // still says it — tolerate and normalize, per §11.5.
  set("low");
  assert.match(awo(ws, ["task", "run", "PL-T1", "--no-worktree"]).stdout, /effort=medium/);
  awo(ws, ["task", "complete", "PL-T1", "--outcome", "failed"]);
  awo(ws, ["task", "status", "PL-T1", "todo"]);

  // xhigh/max exist on some runtimes but are not offered: their gain must be
  // measured, and offering them invites reaching for them by default.
  set("xhigh");
  const bad = awo(ws, ["task", "run", "PL-T1", "--no-worktree"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Invalid effort "xhigh"/);
  assert.match(bad.stderr, /Only medium and high are selectable/);

  // A config error must not have opened a run — the task is still runnable.
  assert.match(awo(ws, ["task", "show", "PL-T1"]).stdout, /status: {3}todo/);

  // With no effort declared, the tier supplies one rather than leaving it to the
  // runtime default.
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m.models = { tiers: { low: { runtime: "codex", model: "gpt-5.4-mini" } } };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  assert.match(awo(ws, ["task", "run", "PL-T1", "--no-worktree"]).stdout, /effort=medium/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal verify attaches the gate, readiness enforces evidence, and verdict routes pass vs gap", () => {
  const ws = makeWorkspace();
  const repoPath = JSON.parse(
    fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")
  ).repos[0].path as string;
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repoPath });

  awo(ws, ["req", "new", "--title", "Feature"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Tested bit", "--targets", "api"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Untested bit", "--targets", "api"]);

  const anonymousException = awo(ws, [
    "task", "evidence", "PL-T1", "--criterion", "1", "--kind", "exception", "--ref", "not applicable",
  ]);
  assert.equal(anonymousException.code, 1);
  assert.match(anonymousException.stderr, /requires --who <human>/);

  // One task with evidence, one excused — the gate must be able to tell them apart.
  awo(ws, ["task", "run", "PL-T1"]);
  // Measured, because an unmeasured claim no longer satisfies the gate.
  awo(ws, ["task", "event", "PL-T1", "test", "--run", "true"]);
  awo(ws, ["task", "complete", "PL-T1", "--outcome", "success", "--gate", "--unchanged", "fixture"]);
  awo(ws, ["task", "run", "PL-T2"]);
  awo(ws, ["task", "complete", "PL-T2", "--outcome", "success", "--gate", "--untested", "no db", "--unchanged", "fixture"]);
  const evidence = awo(ws, [
    "task", "evidence", "PL-T1", "--criterion", "1", "--kind", "test", "--ref", "run true",
  ]);
  assert.equal(evidence.code, 0, evidence.stderr);

  const v = awo(ws, ["goal", "verify", "PL-G1"]);
  assert.equal(v.code, 0, v.stderr);
  // The gate is judgment work, so it always resolves the HIGH tier.
  assert.match(v.stdout, /high tier — the gate is judgment work/);
  assert.match(v.stdout, /PL-T1 in-review — repos\/\.worktrees\/api\/PL-T1/);
  assert.match(v.stdout, /PL-T2 in-review UNTESTED/, "an excused task must be flagged for the reviewer");
  // Read-only in whichever form the runtime offers: codex `-s read-only`, claude
  // plan mode. A reviewer that can edit fixes instead of reporting.
  assert.match(
    v.stdout,
    /-s read-only|--permission-mode plan/,
    "the gate invocation must deny writes"
  );
  assert.ok(!/--add-dir/.test(v.stdout), "a read-only run needs no write grants");

  // The brief is filed as its own run directory, not loose in logs/.
  // The brief is a section of the day's runs.md, addressable by its runId.
  const dayMd = fs.readFileSync(onlyDayFile(ws, "runs.md"), "utf8");
  assert.match(dayMd, /awo:run .*_PL-G1 -->/, "the gate brief must be a marked section");
  const brief = dayMd.slice(dayMd.indexOf("<!-- awo:run"));
  assert.match(brief, /Judge the goal AS A WHOLE/);
  assert.match(brief, /CONTRACTS BETWEEN them/);
  assert.match(brief, /feature\/PL-T1/);
  assert.match(brief, /closed WITHOUT test evidence/);

  // Before the verdict the work is passable, but not yet READY: the QA decision
  // is a first-class part of completion rather than an untracked side effect.
  const beforePass = awo(ws, ["goal", "readiness", "PL-G1", "--json"]);
  assert.equal(beforePass.code, 1);
  const readiness = JSON.parse(beforePass.stdout) as { ready: boolean; canPassVerdict: boolean; blockers: Array<{ code: string }> };
  assert.equal(readiness.ready, false);
  assert.equal(readiness.canPassVerdict, true);
  assert.deepEqual(readiness.blockers.map((b) => b.code), ["qa-verdict-missing"]);

  const bypass = awo(ws, ["task", "verify", "PL-T1"]);
  assert.equal(bypass.code, 1);
  assert.match(bypass.stderr, /cannot be approved independently/);
  assert.match(awo(ws, ["task", "show", "PL-T1"]).stdout, /status:   in-review/);

  // PASS verifies the in-review tasks, which rolls the goal up to done.
  const unattributed = awo(ws, ["goal", "verdict", "PL-G1", "--pass", "--summary", "meets DoD"]);
  assert.equal(unattributed.code, 1);
  assert.match(unattributed.stderr, /requires --who <human>/);
  const pass = awo(ws, ["goal", "verdict", "PL-G1", "--pass", "--summary", "meets DoD", "--who", "supanut", "--model", "gpt-5.6-sol"]);
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /verified: PL-T1, PL-T2/);
  assert.match(awo(ws, ["goal", "list"]).stdout, /PL-G1\t2\/2 done/);
  assert.equal(awo(ws, ["goal", "readiness", "PL-G1"]).code, 0);

  // A finding that is genuinely outside the approved scope re-enters intake.
  const outside = awo(ws, [
    "goal", "verdict", "PL-G1", "--gap", "--new-scope",
    "--summary", "support a second identity provider", "--who", "supanut",
  ]);
  assert.equal(outside.code, 0, outside.stderr);
  assert.match(outside.stdout, /filed: {4}PL-R2/);
  assert.ok(!/repair:/.test(outside.stdout));

  // The normal GAP path stays inside the goal as an explicit repair task.
  const gap = awo(ws, [
    "goal", "verdict", "PL-G1", "--gap", "--summary", "contracts disagree",
    "--who", "supanut", "--note", "unwrap the response",
  ]);
  assert.equal(gap.code, 0, gap.stderr);
  assert.match(gap.stdout, /GAP recorded/);
  assert.match(gap.stdout, /repair: {3}PL-T3/);
  assert.match(awo(ws, ["task", "list"]).stdout, /PL-T3\ttodo/, "an in-scope gap must reopen the goal");
  assert.match(awo(ws, ["goal", "list"]).stdout, /PL-G1\t2\/3 done/);

  // Every verdict is in the log, attributed to qa-engineer.
  const runs = dayRows(ws);
  const gates = runs.filter((r) => String(r.runId).includes("qa-gate-PL-G1"));
  assert.equal(gates.length, 3);
  assert.deepEqual(gates.map((g) => g.status).sort(), ["failed", "failed", "success"]);

  const both = awo(ws, ["goal", "verdict", "PL-G1", "--pass", "--gap", "--summary", "x"]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /exactly one of --pass or --gap/);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("intake gates planning on a human decision, and refuses placeholder criteria", () => {
  const ws = makeWorkspace();

  awo(ws, ["req", "new", "--title", "FAQ on the PDP"]);
  assert.match(awo(ws, ["req", "list"]).stdout, /PL-R1\tdraft\t0 criteria/);

  // A wish cannot be planned from.
  const early = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /is draft, not approved/);
  assert.match(early.stderr, /awo req refine PL-R1/);

  // Nor proposed while the criteria are still the scaffold's placeholder.
  const placeholder = awo(ws, ["req", "propose", "PL-R1"]);
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.stderr, /no acceptance criteria/);

  // Real criteria, in the shape of a test.
  const file = path.join(ws, "requirements", "PL-R1.md");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(
        "## Draft acceptance criteria\n- _…_",
        "## Draft acceptance criteria\n" +
          "- Given 3 published FAQs, when the PDP loads, then all 3 render in order\n" +
          "- Given an unpublished FAQ, when the PDP loads, then it is absent"
      )
  );
  const proposed = awo(ws, ["req", "propose", "PL-R1"]);
  assert.equal(proposed.code, 0, proposed.stderr);
  assert.match(proposed.stdout, /proposed with 2 acceptance criteria/);

  // Proposed is still not approved: only a person accepts the terms.
  const waiting = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(waiting.code, 1);
  assert.match(waiting.stderr, /is proposed, not approved/);
  assert.match(waiting.stderr, /2 acceptance criteria to read/);

  // Rejection needs a reason, because one without is unactionable.
  const noReason = awo(ws, ["req", "reject", "PL-R1"]);
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /--reject needs --why/);

  const approved = awo(ws, ["req", "approve", "PL-R1", "--who", "supanut"]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /approved/);
  assert.match(approved.stdout, /recorded as \d{4}-/, "the decision is in the audit trail");

  assert.equal(awo(ws, ["goal", "new", "--from", "PL-R1"]).code, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a requirement a human PM already specified skips refinement but not approval", () => {
  const ws = makeWorkspace();
  const ticket = path.join(ws, "ticket.md");
  fs.writeFileSync(
    ticket,
    "## Raw requirement\nFrom JIRA SHOP-123.\n\n## Draft acceptance criteria\n- Given a cart, when checkout, then tax is applied\n"
  );

  const created = awo(ws, [
    "req", "new", "--title", "Tax at checkout",
    "--source", "jira:SHOP-123", "--body-file", ticket, "--proposed",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /awo req approve PL-R1/, "it goes straight to the human");
  assert.match(awo(ws, ["req", "list"]).stdout, /PL-R1\tproposed\t1 criteria/);

  // Still gated.
  assert.equal(awo(ws, ["goal", "new", "--from", "PL-R1"]).code, 1);
  awo(ws, ["req", "approve", "PL-R1"]);
  assert.equal(awo(ws, ["goal", "new", "--from", "PL-R1"]).code, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("awo run plans in dependency order and never owns the verdict", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "thing", "--proposed"]);
  const file = path.join(ws, "requirements", "PL-R1.md");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- _…_", "- Given x, when y, then z")
  );
  awo(ws, ["req", "approve", "PL-R1"]);
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  // Declared out of order on purpose: T1 depends on T2.
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Second", "--targets", "api"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "First", "--targets", "api"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Third", "--targets", "api", "--depends-on", "PL-T1"]);

  const plan = awo(ws, ["run", "--goal", "PL-G1", "--dry-run"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /3 task\(s\), in dependency order/);
  assert.ok(
    plan.stdout.indexOf("PL-T1") < plan.stdout.indexOf("PL-T3"),
    "a dependency must be planned before what depends on it"
  );
  assert.match(plan.stdout, /evidence needs a human — always, --yolo included/);
  assert.match(plan.stdout, /Never: the QA verdict/);

  const scoped = awo(ws, ["run", "--goal", "PL-G1", "--until", "PL-T2", "--dry-run"]);
  assert.match(scoped.stdout, /2 task\(s\)/);

  const bad = awo(ws, ["run", "--goal", "PL-G1", "--until", "PL-T9", "--dry-run"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a task of PL-G1/);
  fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * SHOP-R2 lost all nine of its Figma exports when `goal new` moved the document and
 * left its assets behind, and the workspace grew a shell script plus a required rule
 * to compensate. The directory has to travel with the document that links it.
 */
test("goal new carries the requirement's asset directory with it", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Needs a screenshot"]);
  approveRequirement(ws, "PL-R1");

  // A requirement that links a sibling asset directory, as intake produces.
  const assets = path.join(ws, "requirements", "PL-R1-assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "mock.png"), "not really a png");
  const reqFile = path.join(ws, "requirements", "PL-R1.md");
  fs.writeFileSync(
    reqFile,
    `${fs.readFileSync(reqFile, "utf8")}\n![the mock](./PL-R1-assets/mock.png)\n`
  );

  const out = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /brought PL-R1-assets\/ along with it/);

  const moved = path.join(ws, "goals", "PL-G1", "PL-R1-assets", "mock.png");
  assert.ok(fs.existsSync(moved), "the asset must move into the goal folder");
  assert.ok(
    !fs.existsSync(assets),
    "and must not be left behind in requirements/, or there are two copies"
  );

  // The point of moving it: the relative link in the moved document resolves.
  const doc = fs.readFileSync(path.join(ws, "goals", "PL-G1", "requirement.md"), "utf8");
  const link = /!\[[^\]]*\]\(\.\/([^)]+)\)/.exec(doc);
  assert.ok(link, "the moved document still carries its relative link");
  assert.ok(
    fs.existsSync(path.join(ws, "goals", "PL-G1", link[1])),
    `the link ./${link?.[1]} must resolve after the move`
  );

  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal new is unaffected when the requirement has no assets", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Plain requirement"]);
  approveRequirement(ws, "PL-R1");

  const out = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /along with it/);
  assert.ok(fs.existsSync(path.join(ws, "goals", "PL-G1", "requirement.md")));

  fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * `awo goal plan` is the tech-lead's step. Both `instructions/plan-a-goal.md` and
 * `agents/tech-lead.md` claimed to own it since the template shipped, and it did not
 * exist — planning was freehand `awo task new` calls, which is how SHOP-G1 arrived at
 * 39 task files with no point at which anyone could disagree with the shape.
 */
test("goal plan briefs the tech-lead in plan mode, and creates nothing", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "A thing worth planning"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  const out = awo(ws, ["goal", "plan", "PL-G1"]);
  assert.equal(out.code, 0, out.stderr);

  // Plan mode is the whole point: read-only until a human approves.
  assert.match(out.stdout, /--permission-mode plan/);
  assert.match(out.stdout, /high tier — decomposition is judgment work/);
  assert.match(out.stdout, /proposes the breakdown, and waits/);

  // The two approvals must not be conflated — one is a session permission, the
  // other is the workspace's gate before any task runs.
  assert.match(out.stdout, /session permission, not the\s+workspace's human gate/);

  // It briefs a planner; it does not plan. No task may exist yet.
  assert.deepEqual(fs.readdirSync(path.join(ws, "goals", "PL-G1", "tasks")), []);

  // The brief is a real run record, addressable like every other one.
  const briefRunId = /awo log show (\S+)/.exec(out.stdout)?.[1];
  assert.ok(briefRunId, "the brief must be addressable");
  const brief = awo(ws, ["log", "show", briefRunId!]);
  assert.match(brief.stdout, /You are the tech-lead planning PL-G1 into tasks/);
  assert.match(brief.stdout, /You are in PLAN MODE/);
  assert.match(brief.stdout, /awo task new --goal PL-G1/);
  // The planner must not hand-author files or invent ids — the CLI owns both.
  assert.match(brief.stdout, /Do NOT hand-author task files or invent ids/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal plan --write drops the approval gate, and says so", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Planned without a gate"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  const out = awo(ws, ["goal", "plan", "PL-G1", "--write"]);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /--permission-mode plan/);
  assert.match(out.stdout, /no approval gate/);

  const briefRunId = /awo log show (\S+)/.exec(out.stdout)?.[1];
  assert.match(awo(ws, ["log", "show", briefRunId!]).stdout, /You are in WRITE MODE/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal plan tells the planner what already exists and what cannot be verified", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Partly planned already"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Already here", "--targets", "api"]);

  // The goal's targets drive the brief, so declare one.
  const goalFile = path.join(ws, "goals", "PL-G1", "goal.md");
  fs.writeFileSync(goalFile, fs.readFileSync(goalFile, "utf8").replace("targets: []", "targets: [api]"));

  const out = awo(ws, ["goal", "plan", "PL-G1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /exists:\s+PL-T1/);
  // `api` has no testCommand, so tests-must-pass is unsatisfiable there. Named at
  // planning time rather than discovered by an agent inventing a command.
  assert.match(out.stdout, /NO TEST COMMAND: api/);

  const briefRunId = /awo log show (\S+)/.exec(out.stdout)?.[1];
  const brief = awo(ws, ["log", "show", briefRunId!]);
  assert.match(brief.stdout, /Do NOT recreate these/);
  assert.match(brief.stdout, /PL-T1 — Already here \(todo\)/);
  assert.match(brief.stdout, /cannot say how they verify themselves/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("goal plan refuses a goal whose targets are not linked, and an unknown goal", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Bad targets"]);
  approveRequirement(ws, "PL-R1");
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  const goalFile = path.join(ws, "goals", "PL-G1", "goal.md");
  fs.writeFileSync(goalFile, fs.readFileSync(goalFile, "utf8").replace("targets: []", "targets: [ghost]"));

  const bad = awo(ws, ["goal", "plan", "PL-G1"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /targets repos that are not linked: ghost/);

  const missing = awo(ws, ["goal", "plan", "PL-G9"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Unknown goal "PL-G9"/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("req refine --plan proposes criteria for approval instead of editing in place", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Refine me carefully"]);

  const plain = awo(ws, ["req", "refine", "PL-R1"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /--permission-mode plan/);

  const planned = awo(ws, ["req", "refine", "PL-R1", "--plan"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /--permission-mode plan/);
  assert.match(planned.stdout, /Nothing is edited before that/);
  // The session approval must not read as the human decision the workflow needs.
  assert.match(planned.stdout, /The human decision is still\s+awo req approve PL-R1/);

  const briefRunId = /brief:\s+(\S+)/.exec(planned.stdout)?.[1];
  const brief = awo(ws, ["log", "show", briefRunId!]);
  assert.match(brief.stdout, /You are in PLAN MODE/);
  assert.match(brief.stdout, /Edit nothing until it is\napproved/);

  // Refining is a briefing step either way: the requirement is untouched and still
  // a draft until an agent actually runs and proposes it.
  const req = fs.readFileSync(path.join(ws, "requirements", "PL-R1.md"), "utf8");
  assert.match(req, /^status: draft$/m);

  fs.rmSync(ws, { recursive: true, force: true });
});

/** Paths a shelved requirement moves between. */
const intakeFile = (ws: string, id: string): string =>
  path.join(ws, "requirements", `${id}.md`);
const archiveFile = (ws: string, id: string): string =>
  path.join(ws, "requirements", "archive", `${id}.md`);

/**
 * Flipping a status and leaving the file in `requirements/` turned intake into a
 * pile of things nobody intends to build. The status now decides the directory.
 */
test("suspend and cancel move the file out of intake, with the reason recorded", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Parked for later"]);
  awo(ws, ["req", "new", "--title", "Never doing this"]);

  const suspended = awo(ws, ["req", "suspend", "PL-R1", "--why", "waiting on the vendor"]);
  assert.equal(suspended.code, 0, suspended.stderr);
  assert.match(suspended.stdout, /PL-R1 suspended/);
  assert.match(suspended.stdout, /moved out of intake to requirements\/archive\/PL-R1\.md/);
  assert.ok(!fs.existsSync(intakeFile(ws, "PL-R1")), "it must leave intake");
  assert.ok(fs.existsSync(archiveFile(ws, "PL-R1")), "and land in the archive");

  const cancelled = awo(ws, ["req", "cancel", "PL-R2", "--why", "the feature was dropped"]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /PL-R2 cancelled/);
  assert.ok(fs.existsSync(archiveFile(ws, "PL-R2")));

  // The reason is the part worth having later, so it is in the file and in the log.
  const doc = fs.readFileSync(archiveFile(ws, "PL-R1"), "utf8");
  assert.match(doc, /^status: suspended$/m);
  assert.match(doc, /waiting on the vendor/);
  const runId = /recorded as (\S+)/.exec(suspended.stdout)?.[1];
  assert.match(awo(ws, ["log", "show", runId!]).stdout, /waiting on the vendor/);

  // A reason is not optional: "why is this not being built?" is the whole point.
  awo(ws, ["req", "new", "--title", "Third"]);
  const bare = awo(ws, ["req", "suspend", "PL-R3"]);
  assert.equal(bare.code, 1);
  assert.match(`${bare.stdout}${bare.stderr}`, /required option '--why/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("req list shows intake only, and says how much it is not showing", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Live one"]);
  awo(ws, ["req", "new", "--title", "Shelved one"]);
  awo(ws, ["req", "suspend", "PL-R2", "--why", "not now"]);

  const intake = awo(ws, ["req", "list"]);
  assert.match(intake.stdout, /PL-R1/);
  assert.doesNotMatch(intake.stdout, /PL-R2\t/);
  // A short list must never read as the whole story.
  assert.match(intake.stdout, /1 shelved in requirements\/archive\//);

  assert.match(awo(ws, ["req", "list", "--all"]).stdout, /PL-R2\tsuspended/);
  const archived = awo(ws, ["req", "list", "--archived"]);
  assert.match(archived.stdout, /PL-R2\tsuspended/);
  assert.doesNotMatch(archived.stdout, /PL-R1\t/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("resume returns a suspended requirement to the status it left from", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Comes back"]);
  // Reach `proposed` first, so resuming has a status to restore that is not draft.
  const file = intakeFile(ws, "PL-R1");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- _…_", "- Given a thing, when it happens, then it holds")
  );
  awo(ws, ["req", "propose", "PL-R1"]);
  awo(ws, ["req", "suspend", "PL-R1", "--why", "deferred a quarter"]);

  const out = awo(ws, ["req", "resume", "PL-R1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /PL-R1 proposed/);
  assert.match(out.stdout, /back in intake at requirements\/PL-R1\.md/);
  assert.ok(fs.existsSync(intakeFile(ws, "PL-R1")));
  assert.ok(!fs.existsSync(archiveFile(ws, "PL-R1")));

  // Nothing to resume when it is already in intake.
  const again = awo(ws, ["req", "resume", "PL-R1"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already in intake/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("an id is never reissued to a second requirement after the file is shelved", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "First"]);
  awo(ws, ["req", "cancel", "PL-R1", "--why", "dropped"]);

  // The bug this guards: ID allocation scans directories, and a file that leaves
  // the scanned set frees its number. R1 was reissued that way once before.
  const second = awo(ws, ["req", "new", "--title", "Second"]);
  assert.match(second.stdout, /PL-R2 created/);
  assert.ok(fs.existsSync(archiveFile(ws, "PL-R1")), "the cancelled one is still there");
  assert.match(fs.readFileSync(archiveFile(ws, "PL-R1"), "utf8"), /title: First/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("rejecting moves it out, and proposing again brings it back", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Needs another pass"]);
  const file = intakeFile(ws, "PL-R1");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- _…_", "- Given a thing, when it happens, then it holds")
  );
  awo(ws, ["req", "propose", "PL-R1"]);

  const rejected = awo(ws, ["req", "reject", "PL-R1", "--why", "criteria are not checkable"]);
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.match(rejected.stdout, /moved out of intake to requirements\/archive\/PL-R1\.md/);
  assert.match(rejected.stdout, /brings it back/);

  // The revise-and-re-propose round trip has to work from the archive, or archiving
  // a rejection would amount to discarding it.
  const reproposed = awo(ws, ["req", "propose", "PL-R1"]);
  assert.equal(reproposed.code, 0, reproposed.stderr);
  assert.match(reproposed.stdout, /brought back into intake at requirements\/PL-R1\.md/);
  assert.ok(fs.existsSync(intakeFile(ws, "PL-R1")));

  fs.rmSync(ws, { recursive: true, force: true });
});

test("a cancelled requirement cannot be re-proposed or planned by accident", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Killed off"]);
  const file = intakeFile(ws, "PL-R1");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- _…_", "- Given a thing, when it happens, then it holds")
  );
  awo(ws, ["req", "cancel", "PL-R1", "--why", "superseded by PL-R2"]);

  const proposed = awo(ws, ["req", "propose", "PL-R1"]);
  assert.equal(proposed.code, 1);
  assert.match(proposed.stderr, /was cancelled, so re-proposing it would quietly undo that/);
  assert.match(proposed.stderr, /awo req resume PL-R1/);

  // And planning says it is shelved rather than "no such requirement", which is a
  // different problem with a different fix.
  const planned = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(planned.code, 1);
  assert.match(planned.stderr, /is cancelled and lives in requirements\/archive\/PL-R1\.md/);
  assert.match(planned.stderr, /superseded by PL-R2/);
  assert.match(planned.stderr, /awo req resume PL-R1/);

  fs.rmSync(ws, { recursive: true, force: true });
});

test("shelving carries the requirement's assets, and refuses once it is planned", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "Has a mock"]);
  const assets = path.join(ws, "requirements", "PL-R1-assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "mock.png"), "not really a png");

  const out = awo(ws, ["req", "suspend", "PL-R1", "--why", "design not signed off"]);
  assert.match(out.stdout, /brought requirements\/archive\/PL-R1-assets\/ along with it/);
  assert.ok(fs.existsSync(path.join(ws, "requirements", "archive", "PL-R1-assets", "mock.png")));
  assert.ok(!fs.existsSync(assets), "and nothing is left behind to go stale");

  // Once a requirement is a goal, the work lives on the goal — moving the document
  // would change nothing, so it says what would.
  awo(ws, ["req", "new", "--title", "Already planned"]);
  approveRequirement(ws, "PL-R2");
  awo(ws, ["goal", "new", "--from", "PL-R2"]);
  const planned = awo(ws, ["req", "cancel", "PL-R2", "--why", "changed our mind"]);
  assert.equal(planned.code, 1);
  assert.match(planned.stderr, /already been planned as PL-G1/);
  assert.match(planned.stderr, /awo task status <taskId> cancelled/);

  fs.rmSync(ws, { recursive: true, force: true });
});
