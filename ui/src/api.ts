/**
 * The dashboard's read model is the server's read model.
 *
 * These used to be hand-copied from src/ui/reader.ts, and the copies drifted: the
 * reader learned `suspended`/`cancelled` requirements and `archived` goals while the
 * UI still typed requirement status as four values, so a shelved requirement fell
 * through every branch and was offered "Plan: awo goal new --from …". `import type`
 * is erased by the bundler, so none of the server code (fs, git) reaches the bundle
 * — only the shapes do, and `typecheck:ui` now fails when they diverge.
 */
import type {
  AgentView,
  GoalView,
  RequirementView,
  Snapshot,
  TaskDetailView,
  TaskView,
} from "../../src/ui/reader";
import type { RepoStatusEntry } from "../../src/commands/list";
import type { RunEvent, RunIndexEntry } from "../../src/runs";
import type { GoalStatus, TaskStatus } from "../../src/state";
import type { ReqStatus } from "../../src/commands/intake";

export type {
  AgentView,
  GoalStatus,
  GoalView,
  ReqStatus,
  RequirementView,
  RunEvent,
  RunIndexEntry,
  Snapshot,
  TaskStatus,
  TaskView,
};
export type RepoView = RepoStatusEntry;
export type TaskDetail = TaskDetailView;

/**
 * Frozen at archive time by `awo goal archive` (state.json `archivedStatus`). Optional
 * because the reader may not carry it yet; when it does, an archived swimlane shows
 * the status the goal actually finished in rather than a later re-derivation.
 */
export type GoalViewWithArchive = GoalView & { archivedStatus?: GoalStatus | null };

/**
 * Board columns, in workflow order. A runtime value, so it cannot be imported from
 * the server module without bundling it; instead the compiler checks both
 * directions — nothing here that is not a status, and no status missing here.
 */
export const TASK_STATUSES = [
  "todo",
  "queued",
  "running",
  "blocked",
  "in-review",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];
type AssertNever<T extends never> = T;
export type EveryTaskStatusHasAColumn = AssertNever<Exclude<TaskStatus, (typeof TASK_STATUSES)[number]>>;

/**
 * Parked (`suspended`) or killed (`cancelled`): kept for the record, but not intake.
 * `rejected` is deliberately not here — a rejection is meant to be revised and
 * proposed again, so it is still work waiting on someone.
 */
export const SHELVED_REQUIREMENT_STATUSES = ["suspended", "cancelled"] as const satisfies readonly ReqStatus[];

export function isShelved(requirement: Pick<RequirementView, "status">): boolean {
  return (SHELVED_REQUIREMENT_STATUSES as readonly string[]).includes(requirement.status);
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  snapshot: () => get<Snapshot>("/api/snapshot"),
  events: (runId: string) => get<RunEvent[]>(`/api/events?run=${encodeURIComponent(runId)}`),
  task: (taskId: string) => get<TaskDetail>(`/api/task?id=${encodeURIComponent(taskId)}`),
  runDetail: (runId: string) => get<{ markdown: string }>(`/api/run?id=${encodeURIComponent(runId)}`),
  async setStatus(taskId: string, status: string, reason?: string): Promise<void> {
    const res = await fetch("/api/task/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, status, reason }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? res.statusText);
    }
  },
};
