import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, findAllTasks, type TaskDefinition } from "../tasks.js";
import { newTaskState, readState, type GoalState, type TaskStatus } from "../state.js";
import { readEvents } from "../runs.js";
import { runDispatch } from "./dispatch.js";

/**
 * §16.4 — `awo run`: scoped autonomy.
 *
 * "Should it just run continuously, or should I be able to say run T1 through T3?"
 * Both, because they are different situations — but the scope is always explicit
 * and the *stopping conditions are not negotiable in one respect*: it never renders
 * the QA verdict.
 *
 * A machine grading its own work is the one thing that cannot be automated away
 * here. Everything up to the gate is measurable, and 0.0.36 made it measured; the
 * verdict is a judgment against acceptance criteria, which is the human's half of
 * the deal. So `--yolo` relaxes stopping on failure. It does not, and will not,
 * relax that.
 */
export type StopReason =
  | "reached-gate"
  | "until-reached"
  | "task-failed"
  | "needs-human"
  | "nothing-ready"
  | "blocked-dependency"
  | "budget";

export interface RunStep {
  taskId: string;
  agent: string | null;
  model: string;
  outcome: "success" | "failed" | "skipped";
  runId: string;
  needsHuman: boolean;
}

export interface AutoRunResult {
  goalId: string;
  planned: string[];
  steps: RunStep[];
  stoppedBecause: StopReason;
  message: string;
  dryRun: boolean;
}

const RUNNABLE: TaskStatus[] = ["todo", "blocked"];

/** Frontmatter is the authored starting point; state.json wins once it exists (§7.2). */
function effectiveState(state: GoalState, task: TaskDefinition) {
  return state.tasks[task.id] ?? newTaskState(task.authoredStatus);
}

export async function runAuto(options: {
  cwd?: string;
  goal: string;
  /** Stop after this task, inclusive. */
  until?: string;
  /** Keep going past a failed task. Never past the gate. */
  yolo?: boolean;
  dryRun?: boolean;
  maxTasks?: number;
  timeoutMinutes?: number;
}): Promise<AutoRunResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goals = await findGoals(root);
  const goal = goals.find((g) => g.id === options.goal);
  if (!goal) {
    throw new Error(
      goals.length > 0
        ? `Unknown goal "${options.goal}". Known: ${goals.map((g) => g.id).join(", ")}.`
        : `Unknown goal "${options.goal}". No goals exist yet.`
    );
  }

  const all = await findAllTasks(root);
  const order = topological(all.filter((l) => l.goal.id === goal.id).map((l) => l.task));

  if (options.until && !order.some((t) => t.id === options.until)) {
    throw new Error(
      `--until ${options.until} is not a task of ${goal.id}. Its tasks: ${order.map((t) => t.id).join(", ")}.`
    );
  }

  const cut = options.until ? order.findIndex((t) => t.id === options.until) + 1 : order.length;
  const scope = order.slice(0, cut);

  const result: AutoRunResult = {
    goalId: goal.id,
    planned: scope.map((t) => t.id),
    steps: [],
    stoppedBecause: "reached-gate",
    message: "",
    dryRun: options.dryRun === true,
  };

  if (options.dryRun) {
    result.message = describePlan(scope, options);
    result.stoppedBecause = options.until ? "until-reached" : "reached-gate";
    return result;
  }

  const limit = options.maxTasks ?? 25;

  for (const task of scope) {
    if (result.steps.length >= limit) {
      result.stoppedBecause = "budget";
      result.message = `Stopped after ${limit} tasks — raise it with --max-tasks if that was intentional.`;
      return result;
    }

    const state = effectiveState(await readState(goal.dir, goal.id), task);

    // Already finished, or already waiting on a human. Neither is this command's
    // business: re-running a done task would discard its evidence, and re-running an
    // in-review one would pre-empt the verdict.
    if (state.status === "done" || state.status === "in-review" || state.status === "cancelled") {
      continue;
    }
    if (!RUNNABLE.includes(state.status)) {
      result.stoppedBecause = "nothing-ready";
      result.message = `${task.id} is ${state.status}, which this command will not touch. Deal with it, then re-run.`;
      return result;
    }

    const unmet = await unmetDependencies(root, task, goal.dir, goal.id);
    if (unmet.length > 0) {
      result.stoppedBecause = "blocked-dependency";
      result.message =
        `${task.id} depends on ${unmet.join(", ")}, which ${unmet.length === 1 ? "is" : "are"} not done.\n` +
        `  In-review dependencies need your verdict first — that is the gate doing its job.`;
      return result;
    }

    const dispatched = await runDispatch(task.id, {
      cwd: root,
      timeoutMinutes: options.timeoutMinutes,
    });

    const events = await readEvents(root, dispatched.runId);
    const needsHuman = events.some((e) => e.kind === "test" && e.needsHuman === true);

    result.steps.push({
      taskId: task.id,
      agent: task.agent ?? null,
      model: dispatched.model,
      outcome: dispatched.outcome,
      runId: dispatched.runId,
      needsHuman,
    });

    if (needsHuman) {
      // Inconclusive evidence always stops, --yolo or not: continuing would build
      // the next task on top of a result nobody has judged.
      result.stoppedBecause = "needs-human";
      result.message =
        `${task.id} produced evidence that needs a human — \`awo log show ${dispatched.runId}\`.\n` +
        `  Not continuing: the next task would build on a result nobody has judged.`;
      return result;
    }

    if (dispatched.outcome !== "success" && !options.yolo) {
      result.stoppedBecause = "task-failed";
      result.message =
        `${task.id} ${dispatched.outcome} (worker exited ${dispatched.exitCode}).\n` +
        `  Output: ${dispatched.outputPath}\n` +
        `  Pass --yolo to keep going past failures.`;
      return result;
    }
  }

  result.stoppedBecause = options.until ? "until-reached" : "reached-gate";
  result.message = options.until
    ? `Reached ${options.until} as asked. ${result.steps.length} task(s) run.`
    : `All ${result.steps.length} task(s) in scope are done or in review.\n` +
      `  The verdict is yours — this command never renders it:\n` +
      `    awo goal verify ${goal.id}`;
  return result;
}

/** Dependency order, with any cycle surfaced rather than silently reordered. */
function topological(tasks: TaskDefinition[]): TaskDefinition[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const out: TaskDefinition[] = [];

  // Stable: ties break on the natural task order, so a plan is reproducible.
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tasks) {
      if (done.has(t.id)) continue;
      const deps = (t.dependsOn ?? []).filter((d) => byId.has(d));
      if (deps.every((d) => done.has(d))) {
        out.push(t);
        done.add(t.id);
        progress = true;
      }
    }
  }
  // Anything left is in a cycle; append it so the caller can see it rather than
  // having tasks silently vanish from the plan.
  for (const t of tasks) if (!done.has(t.id)) out.push(t);
  return out;
}

async function unmetDependencies(
  root: string,
  task: TaskDefinition,
  goalDir: string,
  goalId: string
): Promise<string[]> {
  const state = await readState(goalDir, goalId);
  const all = await findAllTasks(root);
  const unmet: string[] = [];
  for (const dep of task.dependsOn ?? []) {
    const def = all.find((l) => l.task.id === dep)?.task;
    if (!def) continue;
    if (effectiveState(state, def).status !== "done") unmet.push(dep);
  }
  return unmet;
}

function describePlan(
  scope: TaskDefinition[],
  options: { until?: string; yolo?: boolean }
): string {
  const lines = [
    `${scope.length} task(s), in dependency order:`,
    ...scope.map((t, i) => `  ${i + 1}. ${t.id}  ${t.agent ?? "unassigned"}  -> ${t.targets.join(", ") || "no repo"}`),
    "",
    "Stops when:",
    options.until ? `  - ${options.until} completes (--until)` : "  - every task is done or in review",
    options.yolo ? "  - never on failure (--yolo)" : "  - a task fails",
    "  - evidence needs a human — always, --yolo included",
    "  - a dependency is in review and needs your verdict",
    "",
    "Never: the QA verdict. `awo goal verify` stays yours.",
  ];
  return lines.join("\n");
}
