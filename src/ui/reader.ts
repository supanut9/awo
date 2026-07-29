import path from "path";
import { readManifest } from "../manifest.js";
import { runList, type RepoStatusEntry } from "../commands/list.js";
import { findGoals, findTasksInGoal, locateTask, type TaskDefinition } from "../tasks.js";
import { newTaskState, readState, type GoalStatus, type TaskStatus } from "../state.js";
import { detailFile, readEvents, readIndex, type RunEvent, type RunIndexEntry } from "../runs.js";
import fs from "fs-extra";

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

/**
 * §12.9 — the tiering policy is a hypothesis, and this is where it gets tested.
 * Grouped by tier+effort so "is the cheap model actually cheaper?" is a table
 * rather than an argument: more attempts at a lower tier is the saving being
 * given back.
 */
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

export interface Stats {
  byStatus: Record<string, number>;
  totalTasks: number;
  totalRuns: number;
  successRate: number | null;
  avgDurationSec: number | null;
  openRuns: number;
  /** Runs that closed as success without a test event — the evidence gap. */
  untestedSuccesses: number;
  byTier: TierStat[];
}

export interface Snapshot {
  project: ProjectSummary;
  goals: GoalView[];
  repos: RepoStatusEntry[];
  runs: RunIndexEntry[];
  stats: Stats;
  generatedAt: string;
}

export interface TaskDetailView extends TaskView {
  body: string;
  dependsOn: string[];
  file: string;
}

/**
 * §7.5 — the boundary the UI is built against. `FileReader` implements it over
 * the local workspace tree; the hosted site (§7.6) implements the same shape
 * over HTTP, so the views are written once.
 */
export interface WorkspaceReader {
  project(): Promise<ProjectSummary>;
  task(taskId: string): Promise<TaskDetailView>;
  runDetail(runId: string): Promise<string>;
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

  /** A task's definition plus its state — the drill-down the board links to. */
  async task(taskId: string): Promise<TaskDetailView> {
    const { task, goal } = await locateTask(this.root, taskId);
    const state = await readState(goal.dir, goal.id);
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    return {
      ...toView(task, ts),
      body: task.body,
      dependsOn: task.dependsOn,
      file: path.relative(this.root, task.file),
    };
  }

  /** The run's markdown record (§7.3), read verbatim. */
  async runDetail(runId: string): Promise<string> {
    const file = detailFile(this.root, runId);
    if (!(await fs.pathExists(file))) throw new Error(`No run log for "${runId}".`);
    return fs.readFile(file, "utf8");
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

  /**
   * A success with no `test` event in its stream. Since v0.0.23 that requires an
   * explicit `--untested "<why>"`, so a non-zero count is a list of exemptions
   * someone chose — worth seeing rather than burying in individual run logs.
   */
  private async countUntestedSuccesses(runs: RunIndexEntry[]): Promise<number> {
    let n = 0;
    for (const r of runs.filter((x) => x.status === "success")) {
      const events = await readEvents(this.root, r.runId);
      if (events.length > 0 && !events.some((e) => e.kind === "test")) n += 1;
    }
    return n;
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

    const groups = new Map<string, RunIndexEntry[]>();
    for (const r of finished) {
      const key = `${r.tier ?? "—"}${r.effort ? ` / ${r.effort}` : ""}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    const byTier: TierStat[] = [...groups.entries()]
      .map(([key, rs]) => {
        const ok = rs.filter((r) => r.status === "success").length;
        const attempts = rs.reduce((a, r) => a + (r.attempts ?? 1), 0);
        const durs = rs.map((r) => r.durationSec).filter((d): d is number => typeof d === "number");
        const total = durs.reduce((a, b) => a + b, 0);
        return {
          key,
          tier: rs[0].tier ?? "—",
          effort: rs[0].effort ?? null,
          runs: rs.length,
          succeeded: ok,
          successRate: ok / rs.length,
          avgAttempts: attempts / rs.length,
          avgDurationSec: durs.length > 0 ? Math.round(total / durs.length) : null,
          // What the tier actually cost: a cheap run retried three times is not cheap.
          totalDurationSec: total,
        };
      })
      .sort((a, b) => b.runs - a.runs);

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
        untestedSuccesses: await this.countUntestedSuccesses(runs),
        byTier,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
