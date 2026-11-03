import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, findTasksInGoal, goalsDir, goalArchiveDir } from "../tasks.js";
import { readState, reconcileGoalState } from "../state.js";
import type { GoalStatus } from "../state.js";

/**
 * A goal's status must be RECONCILED against its task files before it is judged,
 * never read raw from `state.json`.
 *
 * Found the hard way: SHOP-G12 had a stored `done` while 8 of its 20 tasks were
 * still open, because tasks were added after the status was last written.
 * Reconciling reports `inconsistent`; the stored value would have let `archive`
 * file away a goal with live work in it — the precise thing its guard exists to
 * prevent. The reader has always reconciled, which is why `awo context` showed
 * `inconsistent` on the same goal this said was done.
 */
async function reconciledStatus(goalDir: string, goalId: string): Promise<GoalStatus> {
  const tasks = await findTasksInGoal(goalDir);
  return reconcileGoalState(await readState(goalDir, goalId), tasks).state.goalStatus;
}

/**
 * §7.2 — a goal whose work is over leaves the live list, the way a shelved
 * requirement leaves intake.
 *
 * The whole directory moves, not just the file: `goal.md`, `requirement.md`,
 * `state.json`, `tasks/` and any requirement assets travel together. That is the
 * lesson `requirement-assets-follow-the-requirement` was written from — assets
 * moved by hand once, nine Figma exports lost their relative links, and it cost a
 * shell script and a required rule. Moving the container keeps every link inside
 * it valid, because none of them cross the boundary.
 */
const TERMINAL: readonly GoalStatus[] = ["done", "cancelled"];

export interface GoalArchiveResult {
  id: string;
  from: string;
  to: string;
  status: GoalStatus;
}

function isTerminal(status: GoalStatus): boolean {
  return TERMINAL.includes(status);
}

export async function runGoalArchive(
  goalId: string,
  options: { cwd?: string; force?: boolean } = {}
): Promise<GoalArchiveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goals = await findGoals(root);
  const goal = goals.find((g) => g.id === goalId);

  if (!goal) {
    const known = goals.map((g) => g.id);
    throw new Error(
      known.length > 0
        ? `Unknown goal "${goalId}". Known goals: ${known.join(", ")}.`
        : `Unknown goal "${goalId}". No goals exist yet.`
    );
  }
  if (goal.archived) {
    throw new Error(`${goalId} is already archived at ${path.relative(root, goal.dir)}.`);
  }

  const status = await reconciledStatus(goal.dir, goalId);
  // Archiving live work would hide it from `awo context`, which is the one place a
  // session looks to find out what is in flight. `--force` exists for a goal that
  // was abandoned without ever being marked cancelled, and says so out loud.
  if (!isTerminal(status) && !options.force) {
    throw new Error(
      `${goalId} is "${status}", not ${TERMINAL.join(" or ")} — archiving it would hide live work.\n` +
        `Finish it, cancel it, or pass --force if it was abandoned without being marked.`
    );
  }

  const target = path.join(goalArchiveDir(root), goalId);
  if (await fs.pathExists(target)) {
    throw new Error(`${path.relative(root, target)} already exists — resolve it by hand.`);
  }

  await fs.ensureDir(goalArchiveDir(root));
  await fs.move(goal.dir, target);

  return {
    id: goalId,
    from: path.relative(root, goal.dir),
    to: path.relative(root, target),
    status,
  };
}

/**
 * Pull an archived goal back into the live list — the counterpart to
 * `req propose` restoring a rejected requirement. Archiving is a filing decision,
 * and a filing decision that cannot be undone is one people avoid making.
 */
export async function runGoalRestore(
  goalId: string,
  options: { cwd?: string } = {}
): Promise<GoalArchiveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = (await findGoals(root)).find((g) => g.id === goalId);

  if (!goal) throw new Error(`Unknown goal "${goalId}".`);
  if (!goal.archived) {
    throw new Error(`${goalId} is not archived; it is already at ${path.relative(root, goal.dir)}.`);
  }

  const target = path.join(goalsDir(root), goalId);
  if (await fs.pathExists(target)) {
    throw new Error(`${path.relative(root, target)} already exists — resolve it by hand.`);
  }

  const status = await reconciledStatus(goal.dir, goalId);
  await fs.move(goal.dir, target);

  return {
    id: goalId,
    from: path.relative(root, goal.dir),
    to: path.relative(root, target),
    status,
  };
}

export interface GoalListRow {
  id: string;
  title: string;
  status: GoalStatus;
  done: number;
  /**
   * Cancelled and closed are reported separately from done on purpose: a goal
   * whose tasks were all cancelled is 0/2 done but 2/2 closed, and collapsing the
   * two reads as "nothing happened here" when the truth is "this was dropped".
   */
  cancelled: number;
  blocked: number;
  total: number;
  archived: boolean;
}

/** The progress column, keeping cancelled work distinguishable from completed work. */
export function formatGoalProgress(row: GoalListRow): string {
  const closed = row.done + row.cancelled;
  return (
    `${row.done}/${row.total} done` +
    (row.cancelled ? `, ${row.cancelled} cancelled, ${closed}/${row.total} closed` : "") +
    (row.blocked ? `, ${row.blocked} blocked` : "")
  );
}

/** Live goals by default — the list is meant to answer "what is in flight". */
export async function runGoalList(
  options: { cwd?: string; archived?: boolean; all?: boolean } = {}
): Promise<GoalListRow[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const rows: GoalListRow[] = [];

  for (const goal of await findGoals(root)) {
    if (!options.all && goal.archived !== Boolean(options.archived)) continue;
    const tasks = await findTasksInGoal(goal.dir);
    const state = reconcileGoalState(await readState(goal.dir, goal.id), tasks).state;
    const statuses = Object.values(state.tasks).map((t) => t.status);
    rows.push({
      id: goal.id,
      title: goal.title,
      status: state.goalStatus,
      done: statuses.filter((s) => s === "done").length,
      cancelled: statuses.filter((s) => s === "cancelled").length,
      blocked: statuses.filter((s) => s === "blocked").length,
      total: goal.taskIds.length,
      archived: goal.archived,
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export interface ArchivableGoal {
  id: string;
  title: string;
  status: GoalStatus;
}

/**
 * Finished goals still sitting in the live list. `awo context` reports these so
 * archiving is something you are reminded to do, rather than a command you have to
 * remember exists — the difference between a tidy list and an aspiration.
 */
export async function findArchivableGoals(workspaceRoot: string): Promise<ArchivableGoal[]> {
  const out: ArchivableGoal[] = [];
  for (const goal of await findGoals(workspaceRoot, { includeArchived: false })) {
    const status = await reconciledStatus(goal.dir, goal.id);
    if (isTerminal(status)) out.push({ id: goal.id, title: goal.title, status });
  }
  return out;
}
