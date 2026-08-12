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

export interface TaskView {
  id: string;
  goalId: string;
  name: string;
  status: TaskStatus;
  lastRunOutcome: string | null;
  lastRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  blockedReason: string | null;
  targets: string[];
  agent: string | null;
  kind: string;
}

export interface GoalView {
  id: string;
  title: string;
  status: string;
  tasks: TaskView[];
}

export interface AgentView {
  id: string;
  tier: string | null;
  reportsTo: string | null;
  delegatesTo: string[];
  reviews: string[];
  taskCount: number;
  openTasks: number;
}

export interface RequirementView {
  id: string;
  title: string;
  status: "draft" | "proposed" | "approved" | "rejected";
  source: string;
  goalId: string | null;
  file: string;
  criteria: { total: number; covered: number; exceptions: number };
}

export interface RepoView {
  name: string;
  type: string;
  status: string;
}

export interface RunIndexEntry {
  runId: string;
  taskId: string | null;
  agent: string | null;
  tier?: string;
  model?: string;
  effort?: string;
  attempts?: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number | null;
  reposChanged: string[];
}

export interface TierStat {
  key: string;
  tier: string;
  effort: string | null;
  runs: number;
  succeeded: number;
  successRate: number;
  avgAttempts: number;
  avgDurationSec: number | null;
  totalDurationSec: number;
}

export interface Snapshot {
  project: { workspaceId: string | null; projectKey: string; projectName: string; libraryVersion: string };
  requirements: RequirementView[];
  goals: GoalView[];
  agents: AgentView[];
  repos: RepoView[];
  runs: RunIndexEntry[];
  stats: {
    byStatus: Record<string, number>;
    totalTasks: number;
    totalRuns: number;
    successRate: number | null;
    avgDurationSec: number | null;
    openRuns: number;
    untestedSuccesses: number;
    byTier: TierStat[];
  };
}

export interface RunEvent {
  t: string;
  kind: string;
  [key: string]: unknown;
}

export interface TaskDetail extends TaskView {
  body: string;
  dependsOn: string[];
  file: string;
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
