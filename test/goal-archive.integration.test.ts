import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/goal-archive.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

function awo(root: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
}

/** Run expecting failure; return the complaint. */
function awoFails(root: string, args: string[]): string {
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`expected \`awo ${args.join(" ")}\` to fail`);
}

/**
 * A workspace with one goal carrying one task.
 *
 * The intake gate is real: a goal cannot be created from a requirement that has no
 * approved acceptance criteria, so the fixture writes them rather than trying to
 * skip to `goal new`.
 */
function workspaceWithGoal(): { root: string; goalId: string; taskId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awo-goal-archive-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TST"], { cwd: root, stdio: "ignore" });

  awo(root, ["req", "new", "--title", "Something worth doing", "--source", "test"]);

  const req = path.join(root, "requirements", "TST-R1.md");
  fs.writeFileSync(
    req,
    fs.readFileSync(req, "utf8").replace("- _…_", "- Given a thing, When it happens, Then it works")
  );

  awo(root, ["req", "propose", "TST-R1"]);
  awo(root, ["req", "approve", "TST-R1", "--who", "tester"]);
  awo(root, ["goal", "new", "--from", "TST-R1"]);
  awo(root, ["task", "new", "--goal", "TST-G1", "--name", "Do the thing"]);
  return { root, goalId: "TST-G1", taskId: "TST-T1" };
}

/** Force a goal's rolled-up status without running the whole lifecycle. */
function setGoalStatus(root: string, goalDir: string, status: string): void {
  const file = path.join(root, goalDir, "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.goalStatus = status;
  for (const id of Object.keys(state.tasks ?? {})) state.tasks[id].status = "done";
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

test("archiving refuses a goal that is still live", () => {
  const { root, goalId } = workspaceWithGoal();
  // Archiving in-flight work would hide it from `awo context`, the one digest a
  // session actually reads.
  assert.match(awoFails(root, ["goal", "archive", goalId]), /would hide live work/);
  assert.ok(fs.existsSync(path.join(root, "goals", goalId)));
});

test("--force archives a goal abandoned without being marked", () => {
  const { root, goalId } = workspaceWithGoal();
  awo(root, ["goal", "archive", goalId, "--force"]);
  assert.ok(fs.existsSync(path.join(root, "goals", "archive", goalId)));
});

test("archiving moves the whole folder — tasks and state travel with it", () => {
  const { root, goalId, taskId } = workspaceWithGoal();
  setGoalStatus(root, path.join("goals", goalId), "done");

  const out = awo(root, ["goal", "archive", goalId]);
  assert.match(out, /archived/);

  const archived = path.join(root, "goals", "archive", goalId);
  assert.equal(fs.existsSync(path.join(root, "goals", goalId)), false, "must not be left behind");
  assert.ok(fs.existsSync(path.join(archived, "goal.md")));
  assert.ok(fs.existsSync(path.join(archived, "state.json")));
  assert.ok(fs.existsSync(path.join(archived, "tasks", `${taskId}.md`)));
  // The requirement came in with the goal and must not be orphaned by the move.
  assert.ok(fs.existsSync(path.join(archived, "requirement.md")));
});

test("an archived goal's tasks stay resolvable, so history is not lost", () => {
  const { root, goalId, taskId } = workspaceWithGoal();
  setGoalStatus(root, path.join("goals", goalId), "done");
  awo(root, ["goal", "archive", goalId]);

  // findGoals includes the archive by default precisely so this keeps working —
  // hiding archived goals would make every historical task unlocatable.
  const shown = awo(root, ["task", "show", taskId]);
  assert.match(shown, new RegExp(taskId));
});

test("archive and restore round-trip", () => {
  const { root, goalId } = workspaceWithGoal();
  setGoalStatus(root, path.join("goals", goalId), "done");

  awo(root, ["goal", "archive", goalId]);
  assert.match(awoFails(root, ["goal", "archive", goalId]), /already archived/);

  awo(root, ["goal", "restore", goalId]);
  assert.ok(fs.existsSync(path.join(root, "goals", goalId, "goal.md")));
  assert.equal(fs.existsSync(path.join(root, "goals", "archive", goalId)), false);
});

test("goal list shows live by default and archived on request", () => {
  const { root, goalId } = workspaceWithGoal();
  assert.match(awo(root, ["goal", "list"]), new RegExp(goalId));

  setGoalStatus(root, path.join("goals", goalId), "done");
  awo(root, ["goal", "archive", goalId]);

  assert.match(awo(root, ["goal", "list"]), /No live goals/);
  assert.match(awo(root, ["goal", "list", "--archived"]), new RegExp(goalId));
  assert.match(awo(root, ["goal", "list", "--all"]), new RegExp(goalId));
});

test("a stored `done` that no longer matches its tasks does not count as archivable", () => {
  const { root, goalId } = workspaceWithGoal();

  // Exactly what SHOP-G12 looked like: state.json says done, but a task added
  // afterwards is still open. Reading the stored status raw would archive a goal
  // with live work in it; reconciling reports `inconsistent` and refuses.
  const stateFile = path.join(root, "goals", goalId, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.goalStatus = "done";
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  awo(root, ["task", "new", "--goal", goalId, "--name", "Added after the fact"]);

  assert.doesNotMatch(awo(root, ["context"]), /to archive/);
  assert.match(awoFails(root, ["goal", "archive", goalId]), /would hide live work/);
});

test("context hides archived goals but still counts them", () => {
  const { root, goalId } = workspaceWithGoal();
  setGoalStatus(root, path.join("goals", goalId), "done");

  // Before archiving, context should be nudging that it is ready to be filed.
  assert.match(awo(root, ["context"]), /to archive/);

  awo(root, ["goal", "archive", goalId]);
  const after = awo(root, ["context"]);
  assert.match(after, /1 archived/);
  assert.doesNotMatch(after, /^goal {10}/m);
});
