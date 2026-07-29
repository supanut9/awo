import fs from "fs-extra";
import path from "path";

/**
 * §7.4 — task LIFECYCLE, distinct from a run's OUTCOME. A board shows this;
 * `success`/`failed` describe a run and live in `lastRunOutcome`.
 */
export const TASK_STATUSES = [
  "todo",
  "queued",
  "running",
  "blocked",
  "in-review",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_OUTCOMES = ["success", "failed", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Who is performing a transition. `cancelled` is reachable only by a human. */
export type Actor = "runner" | "qa" | "human";

/**
 * §7.4's transition table. Anything absent here is invalid and rejected —
 * that rejection is what keeps a board trustworthy under concurrent writers.
 */
const TRANSITIONS: ReadonlyArray<{ from: TaskStatus; to: TaskStatus; actors: Actor[] }> = [
  { from: "todo", to: "queued", actors: ["runner", "human"] },
  { from: "queued", to: "running", actors: ["runner"] },
  { from: "todo", to: "running", actors: ["runner"] },
  { from: "running", to: "in-review", actors: ["runner"] },
  { from: "running", to: "done", actors: ["runner"] },
  { from: "running", to: "blocked", actors: ["runner"] },
  { from: "queued", to: "blocked", actors: ["runner"] },
  { from: "in-review", to: "done", actors: ["qa", "human"] },
  { from: "in-review", to: "todo", actors: ["qa", "human"] },
  { from: "blocked", to: "todo", actors: ["human"] },
  { from: "blocked", to: "queued", actors: ["human"] },
  { from: "done", to: "todo", actors: ["human"] },
  // `cancelled` from anywhere, human only — never an agent (§7.4).
  ...TASK_STATUSES.filter((s) => s !== "cancelled").map((from) => ({
    from,
    to: "cancelled" as TaskStatus,
    actors: ["human" as Actor],
  })),
];

export interface TaskState {
  status: TaskStatus;
  lastRunOutcome: RunOutcome | null;
  lastRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  worktree: string | null;
  blockedReason: string | null;
  /** Runtime link to the PR that implements this task; never authored into task.md. */
  pullRequest?: PullRequestState;
}

export type PullRequestCheckStatus = "passing" | "failing" | "pending" | "unknown";
export type PullRequestReviewStatus =
  | "approved"
  | "changes-requested"
  | "pending"
  | "not-required";

export interface PullRequestFeedbackState {
  id: string;
  body: string;
  url: string | null;
  author: string | null;
  resolved: boolean;
  taskId: string | null;
}

/** A last-observed GitHub PR snapshot, kept in ignored state.json. */
export interface PullRequestState {
  repo: string;
  number: number;
  url: string;
  branch: string;
  headSha: string;
  isDraft: boolean;
  mergeState: string;
  checks: PullRequestCheckStatus;
  reviews: PullRequestReviewStatus;
  lastCheckedAt: string;
  feedback: Record<string, PullRequestFeedbackState>;
}

export type CriterionEvidenceKind = "test" | "manual" | "exception";

export interface CriterionEvidence {
  taskId: string;
  kind: CriterionEvidenceKind;
  ref: string;
  recordedAt: string;
}

/** §7.2 — a goal's status is rolled up from its tasks, never hand-authored. */
export type GoalStatus =
  | "planning"
  | "in-progress"
  | "qa-review"
  | "blocked"
  | "done"
  | "cancelled";

export interface GoalState {
  rev: number;
  goalId: string;
  goalStatus: GoalStatus;
  updatedAt: string;
  tasks: Record<string, TaskState>;
  /** 1-based acceptance-criterion index -> evidence gathered for the criterion. */
  criteria?: Record<string, CriterionEvidence[]>;
}

export function newTaskState(status: TaskStatus = "todo"): TaskState {
  return {
    status,
    lastRunOutcome: null,
    lastRunId: null,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    worktree: null,
    blockedReason: null,
  };
}

export function isValidTransition(from: TaskStatus, to: TaskStatus, actor: Actor): boolean {
  if (from === to) return true;
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
}

export function assertTransition(
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  actor: Actor
): void {
  if (isValidTransition(from, to, actor)) return;
  const allowed = TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map(
    (t) => t.to
  );
  const hint =
    to === "cancelled" && actor !== "human"
      ? " `cancelled` is human-only — no agent may set it."
      : allowed.length > 0
        ? ` From "${from}", ${actor} may move to: ${allowed.join(", ")}.`
        : ` ${actor} may not move a task out of "${from}".`;
  throw new Error(`Invalid transition for ${taskId}: "${from}" -> "${to}".${hint}`);
}

/** §7.4 — derived from task states, stored only for cheap reads. */
export function rollupGoalStatus(tasks: Record<string, TaskState>): GoalStatus {
  const all = Object.values(tasks).map((t) => t.status);
  if (all.length === 0) return "planning";

  const live = all.filter((s) => s !== "cancelled");
  if (live.length === 0) return "cancelled";
  if (live.some((s) => s === "blocked")) return "blocked";
  if (live.some((s) => s === "running")) return "in-progress";
  if (live.every((s) => s === "done")) return "done";
  if (live.every((s) => s === "done" || s === "in-review")) return "qa-review";
  if (live.some((s) => s === "queued" || s === "in-review")) return "in-progress";
  return "planning";
}

function statePath(goalDir: string): string {
  return path.join(goalDir, "state.json");
}

export async function readState(goalDir: string, goalId: string): Promise<GoalState> {
  const file = statePath(goalDir);
  if (!(await fs.pathExists(file))) {
    return { rev: 0, goalId, goalStatus: "planning", updatedAt: "", tasks: {} };
  }
  const raw = (await fs.readJson(file)) as GoalState;
  if (typeof raw.rev !== "number" || typeof raw.tasks !== "object" || raw.tasks === null) {
    throw new Error(`${file} is malformed — missing rev or tasks.`);
  }
  return raw;
}

/**
 * §7.4 concurrency rules: the ONLY writer of state.json. Atomic via
 * tmp+rename so a reader never sees a partial file, and optimistic on `rev` —
 * if the file changed under us, re-read and re-apply the mutation rather than
 * blindly overwriting.
 */
export async function mutateState(
  goalDir: string,
  goalId: string,
  mutate: (state: GoalState) => void,
  attemptsLeft = 5
): Promise<GoalState> {
  const before = await readState(goalDir, goalId);
  const next: GoalState = JSON.parse(JSON.stringify(before));
  mutate(next);

  next.goalId = goalId;
  next.goalStatus = rollupGoalStatus(next.tasks);
  next.rev = before.rev + 1;
  next.updatedAt = new Date().toISOString();

  const file = statePath(goalDir);
  const current = await readState(goalDir, goalId);
  if (current.rev !== before.rev) {
    if (attemptsLeft <= 1) {
      throw new Error(
        `state.json for ${goalId} kept changing under concurrent writes; giving up rather than clobbering it.`
      );
    }
    return mutateState(goalDir, goalId, mutate, attemptsLeft - 1);
  }

  await fs.ensureDir(goalDir);
  const tmp = `${file}.tmp`;
  await fs.writeJson(tmp, next, { spaces: 2 });
  await fs.rename(tmp, file);
  return next;
}
