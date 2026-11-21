import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, findTasksInGoal, goalsDir, goalArchiveDir, type GoalDefinition } from "../tasks.js";
import { mutateState, readState, reconcileGoalState } from "../state.js";
import type { GoalState, GoalStatus, PullRequestState } from "../state.js";
import { evaluateGoalReadiness } from "./readiness.js";

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
async function reconciledStatus(root: string, goal: GoalDefinition): Promise<GoalStatus> {
  const tasks = await findTasksInGoal(goal.dir);
  const raw = await readState(goal.dir, goal.id);
  const status = reconcileGoalState(raw, tasks).state.goalStatus;
  return status === "done"
    ? (await evaluateGoalReadiness(root, goal, raw, tasks)).status
    : status;
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
  /** Linked PRs that were not merged when the goal was archived (`--unmerged-ok`). */
  unmerged: UnmergedPullRequest[];
}

export interface UnmergedPullRequest {
  taskId: string;
  repo: string;
  number: number;
  url: string;
  /** `OPEN`, `CLOSED`, or null when the snapshot predates 0.8 and never recorded it. */
  state: PullRequestState["state"] | null;
}

/**
 * Every linked PR that is not known to be merged. A snapshot taken before 0.8 has
 * no `state`/`merged`, and "unknown" is not "merged": shop had 2 clean PRs in 105
 * goals, so archiving on an unverified assumption is how unmerged work disappears.
 */
function unmergedPullRequests(state: GoalState): UnmergedPullRequest[] {
  const out: UnmergedPullRequest[] = [];
  for (const [taskId, ts] of Object.entries(state.tasks)) {
    const seen = new Set<string>();
    for (const pr of [...Object.values(ts.pullRequests ?? {}), ...(ts.pullRequest ? [ts.pullRequest] : [])]) {
      const key = `${pr.repo}#${pr.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (pr.merged === true || pr.state === "MERGED") continue;
      out.push({ taskId, repo: pr.repo, number: pr.number, url: pr.url, state: pr.state ?? null });
    }
  }
  return out;
}

function isTerminal(status: GoalStatus): boolean {
  return TERMINAL.includes(status);
}

export async function runGoalArchive(
  goalId: string,
  options: { cwd?: string; force?: boolean; unmergedOk?: boolean } = {}
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

  const status = await reconciledStatus(root, goal);
  // Archiving live work would hide it from `awo context`, which is the one place a
  // session looks to find out what is in flight. `--force` exists for a goal that
  // was abandoned without ever being marked cancelled, and says so out loud.
  if (!isTerminal(status) && !options.force) {
    throw new Error(
      `${goalId} is "${status}", not ${TERMINAL.join(" or ")} — archiving it would hide live work.\n` +
        `Finish it, cancel it, or pass --force if it was abandoned without being marked.`
    );
  }

  const unmerged = unmergedPullRequests(await readState(goal.dir, goal.id));
  if (unmerged.length > 0 && !options.unmergedOk) {
    throw new Error(
      `${goalId} has linked pull requests that are not merged:\n` +
        unmerged
          .map(
            (pr) =>
              `  ${pr.taskId}  ${pr.repo}#${pr.number}  ` +
              (pr.state
                ? `${pr.state}  ${pr.url}`
                : `state unknown (snapshot predates 0.8) — refresh: awo pr status ${pr.taskId}`)
          )
          .join("\n") +
        `\nMerge or close them first, or archive anyway with --unmerged-ok.`
    );
  }

  const target = path.join(goalArchiveDir(root), goalId);
  if (await fs.pathExists(target)) {
    throw new Error(`${path.relative(root, target)} already exists — resolve it by hand.`);
  }

  await fs.ensureDir(goalArchiveDir(root));
  await fs.move(goal.dir, target);
  // Frozen after the move, so a failed move never leaves a live goal claiming to
  // be archived. Readers show this instead of re-deriving a status that later
  // tooling (readiness rules, reconciliation) might compute differently.
  await mutateState(target, goalId, (state) => {
    state.archivedStatus = status;
    state.archivedAt = new Date().toISOString();
  });

  return {
    id: goalId,
    from: path.relative(root, goal.dir),
    to: path.relative(root, target),
    status,
    unmerged,
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

  const status = await reconciledStatus(root, goal);
  await fs.move(goal.dir, target);
  // Live again: the frozen status no longer describes it.
  const restored = await readState(target, goalId);
  if (restored.archivedStatus !== undefined || restored.archivedAt !== undefined) {
    await mutateState(target, goalId, (state) => {
      delete state.archivedStatus;
      delete state.archivedAt;
    });
  }

  return {
    id: goalId,
    from: path.relative(root, goal.dir),
    to: path.relative(root, target),
    status,
    unmerged: [],
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
    const raw = await readState(goal.dir, goal.id);
    const state = reconcileGoalState(raw, tasks).state;
    const statuses = Object.values(state.tasks).map((t) => t.status);
    rows.push({
      id: goal.id,
      title: goal.title,
      // An archived goal reports what it was when it was filed away.
      status: goal.archived && raw.archivedStatus
        ? raw.archivedStatus
        : state.goalStatus === "done"
          ? (await evaluateGoalReadiness(root, goal, raw, tasks)).status
          : state.goalStatus,
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
    const status = await reconciledStatus(workspaceRoot, goal);
    if (isTerminal(status)) out.push({ id: goal.id, title: goal.title, status });
  }
  return out;
}
