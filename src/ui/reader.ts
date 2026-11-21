import { evaluateGoalReadiness } from "../commands/readiness.js";
import path from "path";
import { readManifest } from "../manifest.js";
import { runList, type RepoStatusEntry } from "../commands/list.js";
import { findGoals, findTasksInGoal, locateTask, type TaskDefinition } from "../tasks.js";
import { newTaskState, readState, reconcileGoalState, type GoalStatus, type TaskStatus } from "../state.js";
import { readDay, readDetail, readEvents, readIndex, runSlot, type RunEvent, type RunIndexEntry } from "../runs.js";
import { runAgentOrg } from "../commands/agent-org.js";
import { findCriteriaDetailed, listRequirements, REQ_STATUSES, type Requirement, type ReqStatus } from "../commands/intake.js";
import { traceCriterion } from "../commands/traceability.js";
import fs from "fs-extra";
import matter from "gray-matter";

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
  kind: string;
}

export interface GoalView {
  id: string;
  title: string;
  status: GoalStatus;
  tasks: TaskView[];
  /** Filed under `goals/archive/`. Carried, not filtered out, so the dashboard
   *  can still show finished work; `awo context` is the view that hides it. */
  archived: boolean;
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

/** A requirement stays visible whether it is still in intake or has moved under a goal. */
export interface RequirementView {
  id: string;
  title: string;
  status: ReqStatus;
  source: string;
  goalId: string | null;
  file: string;
  criteria: { total: number; covered: number; exceptions: number };
  /**
   * True for a suspended, cancelled or rejected requirement, whose file lives in
   * `requirements/archive/`.
   *
   * Published rather than dropped: the decision not to build something, and why, is
   * part of the record a reviewer needs. `awo req list` hides these by default so
   * intake stays short; a dashboard has room to show them and should.
   */
  archived: boolean;
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
  /**
   * Task runs only. `totalRuns`/`successRate` also count `log add` journal rows,
   * which are always "success" — on atlas-shop that read as 99% success while
   * 736 measured test commands had failed.
   */
  workerRuns?: number;
  workerSuccessRate?: number | null;
  medianWorkerDurationSec?: number | null;
  /** `log add` records: planning, intake, audits — not work a worker did. */
  journalEntries?: number;
  medianJournalDurationSec?: number | null;
}

export interface Snapshot {
  project: ProjectSummary;
  requirements: RequirementView[];
  goals: GoalView[];
  agents: AgentView[];
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
  requirements(): Promise<RequirementView[]>;
  goals(): Promise<GoalView[]>;
  agents(): Promise<AgentView[]>;
  repos(): Promise<RepoStatusEntry[]>;
  runs(): Promise<RunIndexEntry[]>;
  runEvents(runId: string): Promise<RunEvent[]>;
  snapshot(): Promise<Snapshot>;
}

type DayLine = Awaited<ReturnType<typeof readDay>>[number];

/**
 * The run log, each day file read at most once per request.
 *
 * Every reader used to go through `readEvents(runId)`, which re-reads and
 * re-parses the run's whole day file — fine for one run, but the dashboard asked
 * once per successful run: 2.3 s of `awo context` on atlas-shop (3,931 runs, 25 MB
 * of day files). Scope an instance to one request; a long-lived one would serve
 * stale events, since day files are appended to while runs are open.
 */
export class RunLedger {
  private dayNames: Promise<string[]> | null = null;
  private readonly dayLines = new Map<string, Promise<DayLine[]>>();

  constructor(private readonly root: string) {}

  /** Day folders, oldest first. */
  days(): Promise<string[]> {
    this.dayNames ??= (async () => {
      const logs = path.join(this.root, "logs");
      const entries = await fs.readdir(logs, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    })();
    return this.dayNames;
  }

  day(date: string): Promise<DayLine[]> {
    let lines = this.dayLines.get(date);
    if (!lines) {
      lines = readDay(this.root, date);
      this.dayLines.set(date, lines);
    }
    return lines;
  }

  /** Completed runs, oldest first — what `readIndex` returns, from one pass. */
  async index(): Promise<RunIndexEntry[]> {
    const entries: RunIndexEntry[] = [];
    const perDay = await Promise.all(
      (await this.days()).map(async (date) =>
        this.dayLines.has(date) ? (await this.day(date)).filter((l) => l.type === "run") : this.runRows(date)
      )
    );
    for (const rows of perDay) {
      for (const line of rows) {
        const { type: _type, ...rest } = line;
        entries.push(rest as unknown as RunIndexEntry);
      }
    }
    if (entries.length > 0) return entries.sort((a, b) => a.runId.localeCompare(b.runId));
    return readIndex(this.root);
  }

  /**
   * A day's run rows without parsing its events. Events are ~90% of a day file
   * (briefs, test tails), and the index is all `context` and `log list` need:
   * parsing every event of 25 MB of history was most of their time on atlas-shop.
   * A line that does not parse is skipped, as the full reader skips it.
   */
  private async runRows(date: string): Promise<DayLine[]> {
    const file = path.join(this.root, "logs", date, "runs.jsonl");
    // Searched as bytes and decoded per row: decoding the whole file cost more
    // than everything else here put together.
    const buf = await fs.readFile(file).catch(() => Buffer.alloc(0));
    const rows: DayLine[] = [];
    const marker = Buffer.from('"type":"run"');
    for (let at = buf.indexOf(marker); at >= 0; ) {
      const start = at === 0 ? 0 : buf.lastIndexOf(0x0a, at) + 1;
      const newline = buf.indexOf(0x0a, at);
      const end = newline < 0 ? buf.length : newline;
      try {
        const parsed = JSON.parse(buf.toString("utf8", start, end)) as DayLine;
        if (parsed.type === "run") rows.push(parsed);
      } catch {
        // an incomplete trailing line or a hand edit — not this reader's to report
      }
      at = newline < 0 ? -1 : buf.indexOf(marker, end);
    }
    return rows;
  }

  async events(runId: string): Promise<RunEvent[]> {
    const lines = await this.day(runSlot(runId).date);
    const own = lines
      .filter((l) => l.type === "event" && l.runId === runId)
      .map(({ type: _type, runId: _runId, ...rest }) => rest as unknown as RunEvent);
    // A day with a runs.jsonl is in the current layout, so a run with no events
    // there has none (a `log add` entry). Only a day without one can hold an
    // earlier layout worth probing.
    if (own.length > 0 || lines.length > 0) return own;
    return readEvents(this.root, runId);
  }

  /** Runs that have at least one event on this day, oldest first. */
  async runsWithEvents(date: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const line of await this.day(date)) if (line.type === "event") ids.add(line.runId);
    return [...ids].sort();
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Worker runs vs journal entries, shared by the snapshot and `awo context`. */
export function runStats(runs: RunIndexEntry[]): Required<
  Pick<Stats, "workerRuns" | "workerSuccessRate" | "medianWorkerDurationSec" | "journalEntries" | "medianJournalDurationSec">
> {
  const durations = (rs: RunIndexEntry[]) =>
    rs.map((r) => r.durationSec).filter((d): d is number => typeof d === "number");
  const worker = runs.filter((r) => r.taskId !== null && r.taskId !== undefined);
  const journal = runs.filter((r) => r.taskId === null || r.taskId === undefined);
  const finished = worker.filter((r) => r.status !== "running");
  return {
    workerRuns: worker.length,
    workerSuccessRate:
      finished.length > 0 ? finished.filter((r) => r.status === "success").length / finished.length : null,
    medianWorkerDurationSec: median(durations(worker)),
    journalEntries: journal.length,
    medianJournalDurationSec: median(durations(journal)),
  };
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
    kind: task.kind,
  };
}

/**
 * Coverage the way `goal trace` and readiness count it: labelled evidence follows
 * its criterion through renumbering, and evidence attached to an earlier wording
 * does not count. A positional count here showed the board "covered" for criteria
 * readiness was still blocking on.
 */
function coverage(body: string, state?: Awaited<ReturnType<typeof readState>>): RequirementView["criteria"] {
  const criteria = findCriteriaDetailed(body);
  if (!state) return { total: criteria.length, covered: 0, exceptions: 0 };
  const labels = new Set(criteria.map((c) => c.label).filter((label): label is string => label !== null));
  let covered = 0;
  let exceptions = 0;
  for (const criterion of criteria) {
    const status = traceCriterion(state, criterion, labels).status;
    if (status === "covered") covered += 1;
    else if (status === "exception") exceptions += 1;
  }
  return { total: criteria.length, covered, exceptions };
}

function requirementView(
  requirement: Pick<Requirement, "id" | "title" | "status" | "source" | "goalId" | "file" | "body"> & {
    archived?: boolean;
  },
  state?: Awaited<ReturnType<typeof readState>>
): RequirementView {
  return {
    id: requirement.id,
    title: requirement.title,
    status: requirement.status,
    source: requirement.source,
    goalId: requirement.goalId,
    file: requirement.file,
    criteria: coverage(requirement.body, state),
    archived: requirement.archived ?? false,
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

  async requirements(): Promise<RequirementView[]> {
    // Archived included: a hosted reviewer should be able to see that something was
    // parked or killed, and why, rather than watching it vanish from the record.
    const intake = (await listRequirements(this.root, { includeArchived: true })).map((requirement) =>
      requirementView(requirement)
    );
    const planned: RequirementView[] = [];

    for (const goal of await findGoals(this.root)) {
      const file = path.join(goal.dir, "requirement.md");
      if (!(await fs.pathExists(file))) continue;
      const parsed = matter(await fs.readFile(file, "utf8"));
      const data = parsed.data as Record<string, unknown>;
      const status = String(data.status ?? "draft");
      if (!(REQ_STATUSES as readonly string[]).includes(status)) continue;
      const state = await readState(goal.dir, goal.id);
      planned.push(
        requirementView(
          {
            id: String(data.id ?? goal.id),
            title: String(data.title ?? goal.title),
            status: status as ReqStatus,
            source: String(data.source ?? "unspecified"),
            goalId: goal.id,
            file: path.relative(this.root, file),
            body: parsed.content,
          },
          state
        )
      );
    }

    return [...intake, ...planned].sort((a, b) => a.id.localeCompare(b.id));
  }

  async goals(): Promise<GoalView[]> {
    const out: GoalView[] = [];
    for (const goal of await findGoals(this.root)) {
      const tasks = await findTasksInGoal(goal.dir);
      const raw = await readState(goal.dir, goal.id);
      const state = reconcileGoalState(raw, tasks).state;
      out.push({
        id: goal.id,
        title: goal.title,
        // An archived goal shows the status it was filed with: reconciling it again
        // turned archived `done` goals back into `qa-review` on the board.
        status: goal.archived && raw.archivedStatus
          ? raw.archivedStatus
          : state.goalStatus === "done"
            ? (await evaluateGoalReadiness(this.root, goal, raw, tasks)).status
            : state.goalStatus,
        tasks: tasks.map((t) => toView(t, state.tasks[t.id] ?? newTaskState(t.authoredStatus))),
        archived: goal.archived,
      });
    }
    return out;
  }

  async agents(): Promise<AgentView[]> {
    const result = await runAgentOrg({ cwd: this.root });
    return result.agents.map(({ id, tier, reportsTo, delegatesTo, reviews, taskCount, openTasks }) => ({
      id, tier, reportsTo, delegatesTo, reviews, taskCount, openTasks,
    }));
  }

  /** A task's definition plus its state — the drill-down the board links to. */
  async task(taskId: string): Promise<TaskDetailView> {
    const { task, goal } = await locateTask(this.root, taskId);
    const tasks = await findTasksInGoal(goal.dir);
    const state = reconcileGoalState(await readState(goal.dir, goal.id), tasks).state;
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
    return readDetail(this.root, runId);
  }

  async repos(): Promise<RepoStatusEntry[]> {
    return runList({ cwd: this.root });
  }

  async runs(ledger: RunLedger = new RunLedger(this.root)): Promise<RunIndexEntry[]> {
    return (await ledger.index()).sort((a, b) => b.runId.localeCompare(a.runId));
  }

  async runEvents(runId: string): Promise<RunEvent[]> {
    return readEvents(this.root, runId);
  }

  /**
   * A success with no `test` event in its stream. Since v0.0.23 that requires an
   * explicit `--untested "<why>"`, so a non-zero count is a list of exemptions
   * someone chose — worth seeing rather than burying in individual run logs.
   */
  private async countUntestedSuccesses(runs: RunIndexEntry[], ledger: RunLedger): Promise<number> {
    let n = 0;
    for (const r of runs.filter((x) => x.status === "success")) {
      const events = await ledger.events(r.runId);
      if (events.length > 0 && !events.some((e) => e.kind === "test")) n += 1;
    }
    return n;
  }

  async snapshot(): Promise<Snapshot> {
    const ledger = new RunLedger(this.root);
    const [project, requirements, goals, repos, runs, agents] = await Promise.all([
      this.project(),
      this.requirements(),
      this.goals(),
      this.repos(),
      this.runs(ledger),
      this.agents(),
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
      requirements,
      goals,
      agents,
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
        untestedSuccesses: await this.countUntestedSuccesses(runs, ledger),
        byTier,
        ...runStats(runs),
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
