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

test("req -> goal -> task walks the whole pipeline and allocates IDs in order", () => {
  const ws = makeWorkspace();

  const req = awo(ws, ["req", "new", "--title", "Add SSO login", "--source", "stakeholder: Priya"]);
  assert.equal(req.code, 0, req.stderr);
  assert.match(req.stdout, /PL-R1 created at goals\/PL-R1\.md/);

  const reqBody = fs.readFileSync(path.join(ws, "goals", "PL-R1.md"), "utf8");
  assert.match(reqBody, /id: PL-R1/);
  assert.match(reqBody, /status: draft/);
  assert.match(reqBody, /source: 'stakeholder: Priya'|source: "stakeholder: Priya"|source: stakeholder/);
  assert.match(reqBody, /## Raw requirement/);

  // A second requirement takes the next number, not R1 again.
  assert.match(awo(ws, ["req", "new", "--title", "Second ask"]).stdout, /PL-R2/);

  const goal = awo(ws, ["goal", "new", "--from", "PL-R1"]);
  assert.equal(goal.code, 0, goal.stderr);
  assert.match(goal.stdout, /PL-G1 created at goals\/PL-G1-add-sso-login\//);

  const goalDir = path.join(ws, "goals", "PL-G1-add-sso-login");
  // The requirement moved into the goal folder (§4) and gained its goalId.
  assert.ok(!fs.existsSync(path.join(ws, "goals", "PL-R1.md")), "requirement must move, not be copied");
  const moved = fs.readFileSync(path.join(goalDir, "requirement.md"), "utf8");
  assert.match(moved, /goalId: PL-G1/);
  assert.match(fs.readFileSync(path.join(goalDir, "goal.md"), "utf8"), /requirementId: PL-R1/);

  const t1 = awo(ws, [
    "task", "new", "--goal", "PL-G1", "--name", "Add OIDC config",
    "--targets", "api", "--agent", "software-engineer",
  ]);
  assert.equal(t1.code, 0, t1.stderr);
  assert.match(t1.stdout, /PL-T1 created at goals\/PL-G1-add-sso-login\/tasks\/PL-T1-add-oidc-config\.md/);

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

  // T2 depends on T1, so it must refuse until T1 is done.
  awo(ws, ["task", "complete", "PL-T1", "--outcome", "success"]);
  assert.equal(awo(ws, ["task", "run", "PL-T2"]).code, 0);

  const goals = awo(ws, ["goal", "list"]);
  assert.match(goals.stdout, /PL-G1\t1\/2 done/);

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
  awo(ws, ["goal", "new", "--from", "PL-R1"]);
  const goalDir = path.join(ws, "goals", "PL-G1-thing");

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

test("ID allocation skips numbers already used by hand-authored files", () => {
  const ws = makeWorkspace();
  awo(ws, ["req", "new", "--title", "One"]);
  awo(ws, ["goal", "new", "--from", "PL-R1"]);

  // Someone hand-authors PL-T1 and PL-T2; the next allocation must be T3.
  const tasksDir = path.join(ws, "goals", "PL-G1-one", "tasks");
  for (const n of [1, 2]) {
    fs.writeFileSync(
      path.join(tasksDir, `PL-T${n}-manual.md`),
      `---\nid: PL-T${n}\ngoalId: PL-G1\nname: Manual ${n}\nstatus: todo\n---\n\nx\n`
    );
  }
  const next = awo(ws, ["task", "new", "--goal", "PL-G1", "--name", "Third"]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /PL-T3 created/);
  fs.rmSync(ws, { recursive: true, force: true });
});
