import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findTasksInGoal, type GoalDefinition, type TaskDefinition } from "../tasks.js";
import {
  newTaskState,
  readState,
  reconcileGoalState,
  type GoalState,
  type GoalStatus,
  type PullRequestState,
} from "../state.js";
import { evaluateGoalReadiness, type ReadinessBlocker, type ReadinessBlockerCode } from "./readiness.js";
import { runGoalArchive } from "./goal-archive.js";
import { isSafeToRemove, listWorktrees, pruneWorktrees, unsafeReason } from "../worktrees.js";

/**
 * `awo goal close` — the last step from "worker finished" to "goal truthfully done,
 * merged, archived and cleaned up".
 *
 * Every piece existed and nothing joined them: readiness listed blockers as prose,
 * `goal archive` filed a goal away without asking whether its PRs merged, and
 * worktrees outlived their goals by weeks (117 of 126 worktree pointers dangling,
 * 3.1 GB of checkouts in atlas-shop). The only goals that reached `done` in
 * atlas-sales-crm got there by switching QA off. So this command answers one
 * question — what stands between this goal and closed? — with the exact command
 * for each item, and when the answer is "nothing", does the closing itself.
 */

export type GoalCloseBlockerCode = ReadinessBlockerCode | "pr-not-merged" | "worktree-holds-work";

export interface GoalCloseBlocker {
  code: GoalCloseBlockerCode;
  message: string;
  /** What to run, in order. Alternatives are listed after the main path. */
  commands: string[];
  taskId?: string;
  criterion?: number;
}

export interface GoalCloseResult {
  goalId: string;
  status: GoalStatus;
  dryRun: boolean;
  closed: boolean;
  blockers: GoalCloseBlocker[];
  /** Worktrees removed — or, on a dry run, the ones that would be. */
  pruned: string[];
  /** Worktrees left in place, with the reason. */
  kept: { path: string; reason: string }[];
  archivedTo: string | null;
}

function quote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Every PR linked to a task, deduplicated: `pullRequest` mirrors one of `pullRequests`. */
function linkedPullRequests(state: GoalState, taskId: string): PullRequestState[] {
  const ts = state.tasks[taskId];
  const out = new Map<string, PullRequestState>();
  for (const pr of [...Object.values(ts?.pullRequests ?? {}), ...(ts?.pullRequest ? [ts.pullRequest] : [])]) {
    out.set(pr.url || `${pr.repo}#${pr.number}`, pr);
  }
  return [...out.values()];
}

function explain(
  blocker: ReadinessBlocker,
  goal: GoalDefinition,
  authored: TaskDefinition[],
  statusOf: (id: string) => string
): GoalCloseBlocker {
  const id = goal.id;
  const verdict = `awo goal verdict ${id} --pass --summary "…" --who "<human>"`;
  const live = authored.filter((t) => statusOf(t.id) !== "cancelled");
  // Evidence belongs to the task whose work covers the criterion; only a goal with a
  // single live task can name it without guessing.
  const evidenceTask = live.length === 1 ? live[0].id : "<task>";
  const base = { code: blocker.code, message: blocker.message, taskId: blocker.taskId, criterion: blocker.criterion };

  switch (blocker.code) {
    case "unfinished-task": {
      const task = blocker.taskId ?? "<task>";
      const status = statusOf(task);
      if (status === "running") {
        return {
          ...base,
          message: `${task} has an open run — close it`,
          commands: [
            `awo task complete ${task} --outcome success --summary "…"`,
            `awo task complete ${task} --outcome failed --summary "abandoned"`,
          ],
        };
      }
      if (status === "blocked") {
        return {
          ...base,
          message: `${task} is blocked — unblock and run it, or cancel it if it is no longer wanted`,
          commands: [`awo task status ${task} todo`, `awo task run ${task}`, `awo task status ${task} cancelled`],
        };
      }
      return {
        ...base,
        message: `${task} is ${status} — run it, or cancel it if it is no longer wanted`,
        commands: [`awo task run ${task}`, `awo task status ${task} cancelled`],
      };
    }
    case "no-tasks":
      return {
        ...base,
        message: `${id} has no tasks — plan it, or archive it as abandoned`,
        commands: [`awo goal plan ${id}`, `awo goal archive ${id} --force`],
      };
    case "inconsistent-state":
      return { ...base, commands: [`awo goal reconcile ${id}`] };
    case "acceptance-criteria-unavailable":
      return { ...base, commands: [`awo goal trace ${id}`] };
    case "missing-criterion-evidence":
      return {
        ...base,
        commands: [
          `awo task evidence ${evidenceTask} --criterion ${blocker.criterion ?? "<n>"} --kind test --ref "<runId|command>"`,
          `awo task evidence ${evidenceTask} --criterion ${blocker.criterion ?? "<n>"} --kind manual --ref "<evidence>"`,
        ],
      };
    case "unapproved-exception":
      return {
        ...base,
        commands: [
          `awo task evidence ${evidenceTask} --criterion ${blocker.criterion ?? "<n>"} --kind exception --ref "<why>" --who "<human>"`,
        ],
      };
    case "qa-brief-missing":
      return { ...base, message: "no QA brief is attached", commands: [`awo goal verify ${id}`, verdict] };
    case "qa-verdict-missing":
    case "qa-verdict-unattributed":
      return { ...base, commands: [verdict] };
    case "qa-gap":
      return {
        ...base,
        message: "the latest QA verdict is GAP — finish its repair task, then run the gate again",
        commands: [`awo goal verify ${id}`, verdict],
      };
    case "goal-not-done": {
      // Not governed, so nothing verifies in-review work for you: each task needs its
      // own QA decision.
      const inReview = authored.filter((t) => statusOf(t.id) === "in-review").map((t) => t.id);
      return {
        ...base,
        message:
          inReview.length > 0
            ? `${inReview.join(", ")} ${inReview.length === 1 ? "is" : "are"} still in review`
            : blocker.message,
        commands: inReview.length > 0 ? inReview.map((t) => `awo task verify ${t}`) : [`awo goal readiness ${id}`],
      };
    }
    default:
      // A readiness blocker this command does not know yet still blocks; readiness
      // itself explains it.
      return { ...base, commands: [`awo goal readiness ${id}`] };
  }
}

export async function runGoalClose(
  goalId: string,
  options: { cwd?: string; dryRun?: boolean; unmergedOk?: boolean } = {}
): Promise<GoalCloseResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goals = await findGoals(root);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    const live = goals.filter((g) => !g.archived).map((g) => g.id);
    throw new Error(
      live.length > 0
        ? `Unknown goal "${goalId}". Live goals: ${live.join(", ")}.`
        : `Unknown goal "${goalId}". There are no live goals.`
    );
  }
  if (goal.archived) {
    throw new Error(
      `${goalId} is already closed and archived at ${path.relative(root, goal.dir)}. Reopen it with: awo goal restore ${goalId}`
    );
  }

  const authored = await findTasksInGoal(goal.dir);
  const raw = await readState(goal.dir, goal.id);
  const readiness = await evaluateGoalReadiness(root, goal, raw, authored);
  const rolled = reconcileGoalState(raw, authored).state;
  const statusOf = (id: string): string => (rolled.tasks[id] ?? newTaskState()).status;

  const blockers: GoalCloseBlocker[] = [];
  // A goal whose every task was cancelled has nothing to verify or evidence; it is
  // closed by filing it away, which `goal archive` already allows.
  if (rolled.goalStatus !== "cancelled") {
    for (const blocker of readiness.blockers) blockers.push(explain(blocker, goal, authored, statusOf));
  }

  // ---- linked PRs that have not merged ----
  // Archiving froze goals whose PRs were still open; in atlas-shop only 2 of 105
  // goals had cleanly merged PRs. A closed goal must mean the work landed.
  for (const task of authored) {
    if (statusOf(task.id) === "cancelled") continue;
    for (const pr of linkedPullRequests(rolled, task.id)) {
      if (pr.merged === true || pr.state === "MERGED" || options.unmergedOk) continue;
      const name = `${pr.repo}#${pr.number}`;
      blockers.push(
        pr.state === "CLOSED"
          ? {
              code: "pr-not-merged",
              taskId: task.id,
              message: `${task.id}'s PR ${name} was closed without merging — if its work landed another way, say so`,
              commands: [`awo goal close ${goal.id} --unmerged-ok`],
            }
          : {
              code: "pr-not-merged",
              taskId: task.id,
              message: pr.state
                ? `${task.id}'s PR ${name} is still open — refresh the snapshot; if it really is open, merge it`
                : `${task.id}'s PR ${name} has no merge state on record — refresh the snapshot`,
              commands: ["awo pr reconcile --all", `awo pr finalize ${task.id}`],
            }
      );
    }
  }

  // ---- this goal's worktrees ----
  // Clean, merged checkouts are removed on close; one that still holds work stops the
  // close, because archiving would hide the only pointer to it. An unfinished task's
  // checkout is expected and already covered by its task blocker.
  const manifest = await readManifest(root);
  const ids = new Set(authored.map((t) => t.id));
  const worktrees = (await listWorktrees(root, manifest).catch(() => [])).filter((w) => ids.has(w.leaf));
  const finished = (id: string): boolean => ["done", "in-review", "cancelled"].includes(statusOf(id));
  for (const worktree of worktrees) {
    if (isSafeToRemove(worktree) || !finished(worktree.leaf)) continue;
    blockers.push({
      code: "worktree-holds-work",
      taskId: worktree.leaf,
      message: `${worktree.path}: ${unsafeReason(worktree)} — merge or discard that work first (--force discards it)`,
      commands: [
        `git -C ${quote(worktree.path)} status --short && git -C ${quote(worktree.path)} log --oneline -5`,
        `awo worktree prune --task ${worktree.leaf} --force`,
      ],
    });
  }

  const result: GoalCloseResult = {
    goalId: goal.id,
    status: rolled.goalStatus === "cancelled" ? "cancelled" : readiness.status,
    dryRun: Boolean(options.dryRun),
    closed: false,
    blockers,
    pruned: [],
    kept: [],
    archivedTo: null,
  };

  if (blockers.length > 0) return result;

  if (options.dryRun) {
    result.pruned = worktrees.filter(isSafeToRemove).map((w) => w.path);
    result.archivedTo = path.relative(root, path.join(root, "goals", "archive", goal.id));
    return result;
  }

  // Archive first: it is the step that can still refuse, and a refused close must not
  // have already deleted anything.
  const archived = await runGoalArchive(goal.id, { cwd: root, unmergedOk: options.unmergedOk });
  result.archivedTo = archived.to;
  result.status = archived.status;
  result.closed = true;

  for (const r of await pruneWorktrees(root, manifest, { select: (w) => ids.has(w.leaf) })) {
    if (r.removed) result.pruned.push(r.worktree.path);
    else result.kept.push({ path: r.worktree.path, reason: r.keptBecause ?? "kept" });
  }
  return result;
}
