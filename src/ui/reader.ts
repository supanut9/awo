import path from "path";
import { readManifest } from "../manifest.js";
import { runList, type RepoStatusEntry } from "../commands/list.js";
import { findGoals, findTasksInGoal, type TaskDefinition } from "../tasks.js";
import { newTaskState, readState, type GoalStatus, type TaskStatus } from "../state.js";
import { readEvents, readIndex, type RunEvent, type RunIndexEntry } from "../runs.js";

export interface ProjectSummary {
  workspaceId: string | null;
  projectKey: string;
  projectName: string;
  libraryVersion: string;
  root: string;
}

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
}

export interface GoalView {
  id: string;
  title: string;
  status: GoalStatus;
  tasks: TaskView[];
}

export interface Stats {
  byStatus: Record<string, number>;
  totalTasks: number;
  totalRuns: number;
  successRate: number | null;
  avgDurationSec: number | null;
  openRuns: number;
}

export interface Snapshot {
  project: ProjectSummary;
  goals: GoalView[];
  repos: RepoStatusEntry[];
  runs: RunIndexEntry[];
  stats: Stats;
  generatedAt: string;
}

/**
 * §7.5 — the boundary the UI is built against. `FileReader` implements it over
 * the local workspace tree; the hosted site (§7.6) implements the same shape
 * over HTTP, so the views are written once.
 */
export interface WorkspaceReader {
  project(): Promise<ProjectSummary>;
  goals(): Promise<GoalView[]>;
  repos(): Promise<RepoStatusEntry[]>;
  runs(): Promise<RunIndexEntry[]>;
  runEvents(runId: string): Promise<RunEvent[]>;
  snapshot(): Promise<Snapshot>;
}

function toView(task: TaskDefinition, state: ReturnType<typeof newTaskState>): TaskView {
  return {
    id: task.id,
    goalId: task.goalId,
    name: task.name,
    status: state.status,
    lastRunOutcome: state.lastRunOutcome,
    lastRunId: state.lastRunId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    attempts: state.attempts,
    blockedReason: state.blockedReason,
    targets: task.targets,
    agent: task.agent,
  };
}

export class FileReader implements WorkspaceReader {
  constructor(private readonly root: string) {}

  async project(): Promise<ProjectSummary> {
    const m = await readManifest(this.root);
    return {
      workspaceId: m.workspaceId ?? null,
      projectKey: m.projectKey,
      projectName: m.projectName ?? m.projectKey,
      libraryVersion: m.libraryVersion,
      root: path.basename(this.root),
    };
  }

  async goals(): Promise<GoalView[]> {
    const out: GoalView[] = [];
    for (const goal of await findGoals(this.root)) {
      const state = await readState(goal.dir, goal.id);
      const tasks = await findTasksInGoal(goal.dir);
      out.push({
        id: goal.id,
        title: goal.title,
        status: state.goalStatus,
        tasks: tasks.map((t) => toView(t, state.tasks[t.id] ?? newTaskState(t.authoredStatus))),
      });
    }
    return out;
  }

  async repos(): Promise<RepoStatusEntry[]> {
    return runList({ cwd: this.root });
  }

  async runs(): Promise<RunIndexEntry[]> {
    return (await readIndex(this.root)).sort((a, b) => b.runId.localeCompare(a.runId));
  }

  async runEvents(runId: string): Promise<RunEvent[]> {
    return readEvents(this.root, runId);
  }

  async snapshot(): Promise<Snapshot> {
    const [project, goals, repos, runs] = await Promise.all([
      this.project(),
      this.goals(),
      this.repos(),
      this.runs(),
    ]);

    const tasks = goals.flatMap((g) => g.tasks);
    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    const finished = runs.filter((r) => r.status !== "running");
    const succeeded = finished.filter((r) => r.status === "success").length;
    const durations = runs
      .map((r) => r.durationSec)
      .filter((d): d is number => typeof d === "number");

    return {
      project,
      goals,
      repos,
      runs,
      stats: {
        byStatus,
        totalTasks: tasks.length,
        totalRuns: runs.length,
        successRate: finished.length > 0 ? succeeded / finished.length : null,
        avgDurationSec:
          durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : null,
        openRuns: tasks.filter((t) => t.status === "running").length,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
