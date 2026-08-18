import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, findTasksInGoal } from "../tasks.js";
import {
  mutateState,
  newTaskState,
  readState,
  reconcileGoalState,
  type GoalStatus,
  type TaskStatus,
} from "../state.js";
import { runGoalTrace } from "./traceability.js";
import { runLogAdd } from "./log.js";

export type ReadinessBlockerCode =
  | "no-tasks"
  | "inconsistent-state"
  | "unfinished-task"
  | "acceptance-criteria-unavailable"
  | "missing-criterion-evidence"
  | "unapproved-exception"
  | "qa-brief-missing"
  | "qa-verdict-missing"
  | "qa-verdict-unattributed"
  | "qa-gap"
  | "goal-not-done";

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  message: string;
  taskId?: string;
  criterion?: number;
}

export interface GoalReadiness {
  goalId: string;
  status: GoalStatus;
  ready: boolean;
  canPassVerdict: boolean;
  policy: { qaRequired: boolean; acceptanceEvidenceRequired: boolean };
  tasks: { total: number; byStatus: Record<string, number> };
  criteria: { total: number; covered: number; exceptions: number; missing: number } | null;
  qa: {
    briefRunId: string | null;
    verdict: "pass" | "gap" | null;
    summary: string | null;
    verdictBy: string | null;
  };
  blockers: ReadinessBlocker[];
}

/** One readiness calculation shared by the CLI and the verdict gate. */
export async function runGoalReadiness(
  goalId: string,
  options: { cwd?: string } = {}
): Promise<GoalReadiness> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = (await findGoals(root)).find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);

  const authored = await findTasksInGoal(goal.dir);
  const raw = await readState(goal.dir, goal.id);
  const reconciliation = reconcileGoalState(raw, authored);
  const state = reconciliation.state;
  const blockers: ReadinessBlocker[] = [];
  const byStatus: Record<string, number> = {};

  for (const task of authored) {
    const status = (state.tasks[task.id] ?? newTaskState(task.authoredStatus)).status;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (!(["done", "in-review", "cancelled"] as TaskStatus[]).includes(status)) {
      blockers.push({
        code: "unfinished-task",
        taskId: task.id,
        message: `${task.id} is ${status}`,
      });
    }
  }

  if (authored.length === 0) {
    blockers.push({ code: "no-tasks", message: `${goal.id} has no authored tasks` });
  }
  if (state.goalStatus === "inconsistent") {
    const details = [
      reconciliation.missingTaskIds.length
        ? `missing state: ${reconciliation.missingTaskIds.join(", ")}`
        : null,
      reconciliation.orphanedTaskIds.length
        ? `orphaned state: ${reconciliation.orphanedTaskIds.join(", ")}`
        : null,
    ].filter(Boolean);
    blockers.push({
      code: "inconsistent-state",
      message: `${goal.id} has inconsistent authored/runtime state${details.length ? ` (${details.join("; ")})` : ""}`,
    });
  }

  let criteria: GoalReadiness["criteria"] = null;
  if (goal.completionPolicy.acceptanceEvidenceRequired) {
    try {
      const trace = await runGoalTrace(goal.id, { cwd: root });
      let covered = 0;
      let exceptions = 0;
      let missing = 0;
      for (const row of trace) {
        const passing = row.evidence.some((item) => item.kind === "test" || item.kind === "manual");
        const acceptedException = row.evidence.some(
          (item) => item.kind === "exception" && Boolean(item.acceptedBy?.trim())
        );
        const unapprovedException = row.evidence.some(
          (item) => item.kind === "exception" && !item.acceptedBy?.trim()
        );
        if (passing) {
          covered += 1;
        } else if (acceptedException) {
          exceptions += 1;
        } else {
          missing += 1;
          blockers.push({
            code: unapprovedException ? "unapproved-exception" : "missing-criterion-evidence",
            criterion: row.index,
            message: unapprovedException
              ? `criterion ${row.index} has an exception with no accepting human`
              : `criterion ${row.index} has no passing evidence or accepted exception`,
          });
        }
      }
      criteria = { total: trace.length, covered, exceptions, missing };
    } catch (err) {
      blockers.push({
        code: "acceptance-criteria-unavailable",
        message: (err as Error).message,
      });
    }
  }

  const qa = {
    briefRunId: raw.qa?.briefRunId ?? null,
    verdict: raw.qa?.verdict ?? null,
    summary: raw.qa?.summary ?? null,
    verdictBy: raw.qa?.verdictBy ?? null,
  };
  if (goal.completionPolicy.qaRequired) {
    if (!qa.briefRunId) {
      blockers.push({
        code: "qa-brief-missing",
        message: `no QA brief is attached; run \`awo goal verify ${goal.id}\``,
      });
    }
    if (qa.verdict === "gap") {
      blockers.push({ code: "qa-gap", message: `the latest QA verdict is GAP` });
    } else if (qa.verdict !== "pass") {
      blockers.push({
        code: "qa-verdict-missing",
        message: `no passing QA verdict is recorded`,
      });
    } else if (!qa.verdictBy) {
      blockers.push({
        code: "qa-verdict-unattributed",
        message: `the passing QA verdict does not name the responsible human`,
      });
    }
  }

  const preVerdict = blockers.filter(
    (blocker) =>
      blocker.code !== "qa-verdict-missing" &&
      blocker.code !== "qa-verdict-unattributed" &&
      blocker.code !== "qa-gap"
  );
  const ready = blockers.length === 0 && state.goalStatus === "done";
  if (blockers.length === 0 && state.goalStatus !== "done") {
    blockers.push({
      code: "goal-not-done",
      message: `${goal.id} rolls up to ${state.goalStatus}, not done`,
    });
  }

  return {
    goalId: goal.id,
    status: state.goalStatus,
    ready,
    canPassVerdict: preVerdict.length === 0,
    policy: goal.completionPolicy,
    tasks: { total: authored.length, byStatus },
    criteria,
    qa,
    blockers,
  };
}

export interface GoalReconcileResult {
  goalId: string;
  added: string[];
  removed: string[];
  status: GoalStatus;
  runId: string;
}

/** Persist the conservative read-time overlay and leave an audit record. */
export async function runGoalReconcile(
  goalId: string,
  options: { cwd?: string } = {}
): Promise<GoalReconcileResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = (await findGoals(root)).find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);

  const authored = await findTasksInGoal(goal.dir);
  const before = await readState(goal.dir, goal.id);
  const difference = reconcileGoalState(before, authored);
  const state = await mutateState(goal.dir, goal.id, (draft) => {
    if (difference.missingTaskIds.length > 0 || difference.orphanedTaskIds.length > 0) {
      delete draft.qa;
    }
  });
  const log = await runLogAdd({
    cwd: root,
    label: `reconcile-${goal.id}`,
    agent: "orchestrator",
    outcome: "success",
    summary:
      `Reconciled ${goal.id}: added ${difference.missingTaskIds.length}, ` +
      `removed ${difference.orphanedTaskIds.length}; status is ${state.goalStatus}.`,
    note: [
      ...(difference.missingTaskIds.length
        ? [`Added: ${difference.missingTaskIds.join(", ")}`]
        : []),
      ...(difference.orphanedTaskIds.length
        ? [`Removed: ${difference.orphanedTaskIds.join(", ")}`]
        : []),
    ],
  });
  return {
    goalId: goal.id,
    added: difference.missingTaskIds,
    removed: difference.orphanedTaskIds,
    status: state.goalStatus,
    runId: log.runId,
  };
}
