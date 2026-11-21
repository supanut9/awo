import { findAllTasks, type GoalDefinition, type LocatedTask, type TaskDefinition } from "./tasks.js";
import { newTaskState, readState, type GoalState, type TaskState, type TaskStatus } from "./state.js";

/**
 * Lifecycle policy that `task run` and `awo run` must agree on.
 *
 * They each had their own copy and the copies drifted: `task run` accepted an
 * `in-review` dependency (so a governed goal's chain could reach goal-level QA),
 * while `awo run` demanded `done` and read every dependency's status from the
 * dependent's own goal — so a cross-goal dependency looked `todo` forever and the
 * autorun stopped on work that `task run` would have started.
 */

/**
 * A dependency is satisfied once its work is committed and closed. Requiring
 * `done` deadlocked every strict dependency chain: a governed goal verifies the
 * feature only after all of its tasks have completed into review.
 */
export function dependencySatisfied(status: TaskStatus): boolean {
  return status === "done" || status === "in-review";
}

export interface UnmetDependency {
  id: string;
  /** Null when no task file carries this id. */
  status: TaskStatus | null;
  goalId: string | null;
}

export async function unmetDependencies(
  workspaceRoot: string,
  task: Pick<TaskDefinition, "dependsOn">,
  inventory?: LocatedTask[]
): Promise<UnmetDependency[]> {
  if (task.dependsOn.length === 0) return [];
  const all = inventory ?? (await findAllTasks(workspaceRoot));
  const states = new Map<string, GoalState>();
  const unmet: UnmetDependency[] = [];
  for (const depId of task.dependsOn) {
    const dep = all.find((located) => located.task.id === depId);
    if (!dep) {
      unmet.push({ id: depId, status: null, goalId: null });
      continue;
    }
    // The dependency's status lives in ITS goal's state.json, wherever that goal is.
    let state = states.get(dep.goal.dir);
    if (!state) {
      state = await readState(dep.goal.dir, dep.goal.id);
      states.set(dep.goal.dir, state);
    }
    const status = (state.tasks[depId] ?? newTaskState(dep.task.authoredStatus)).status;
    if (!dependencySatisfied(status)) unmet.push({ id: depId, status, goalId: dep.goal.id });
  }
  return unmet;
}

export function describeUnmet(unmet: UnmetDependency[]): string {
  return unmet.map((d) => `${d.id} (${d.status ?? "not found"})`).join(", ");
}

/** The next command for each unmet dependency — a refusal should say what to type. */
export function unmetDependencyHints(unmet: UnmetDependency[]): string[] {
  return unmet.map((d) => {
    switch (d.status) {
      case null:
        return `${d.id}: no task file has this id — fix \`dependsOn:\` in the task file`;
      case "running":
        return `${d.id}: finish its open run — awo task resume ${d.id}`;
      case "cancelled":
        return `${d.id}: cancelled — drop it from \`dependsOn:\`, or restore it: awo task status ${d.id} todo`;
      default:
        return `${d.id}: run it first — awo task run ${d.id}`;
    }
  });
}

/**
 * Before 0.8 the dependency gate wrote `blocked` with this exact prefix, so a task
 * parked that way is still waiting on dependencies — not on a human or a failure —
 * and `awo run` may start it once they are satisfied.
 */
export function blockedByDependency(ts: Pick<TaskState, "status" | "blockedReason">): boolean {
  return ts.status === "blocked" && (ts.blockedReason ?? "").startsWith("unmet dependencies");
}

/**
 * Archived goals are history. A run or status change there rewrote a goal that
 * `context` no longer shows, so nobody saw the work it reopened.
 */
export function assertGoalWritable(goal: Pick<GoalDefinition, "id" | "archived">, taskId?: string): void {
  if (!goal.archived) return;
  throw new Error(
    `${taskId ? `${taskId} belongs to ` : ""}${goal.id}, which is archived and read-only — ` +
      `restore first: awo goal restore ${goal.id}`
  );
}

/**
 * The placeholder lines `awo task new` writes when no body is given (plan.ts).
 * Measured on atlas-shop: 22% of first briefs handed to a worker were this
 * template, so the worker invented the task from its title.
 */
export const TASK_TEMPLATE_PLACEHOLDERS: readonly string[] = [
  `_What "done" means for this unit._`,
  `1. _…_`,
  `- _…_`,
];

/** Placeholder lines still present in a task body; `[""]` for an empty body. */
export function unwrittenTemplateLines(body: string): string[] {
  if (body.trim() === "") return [""];
  const lines = new Set(body.split("\n").map((line) => line.trim()));
  return TASK_TEMPLATE_PLACEHOLDERS.filter((placeholder) => lines.has(placeholder));
}
