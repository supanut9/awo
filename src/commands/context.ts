import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { FileReader, RunLedger, runStats, type ProjectSummary, type Snapshot } from "../ui/reader.js";
import { readLibraryVersion } from "../template.js";
import { resolveOrchestrator } from "../models.js";
import type { RunIndexEntry } from "../runs.js";
import { findGoals, findTasksInGoal, goalArchiveDir } from "../tasks.js";
import { newTaskState, readState, reconcileGoalState, type GoalStatus, type TaskStatus } from "../state.js";
import { runList, type RepoStatusEntry } from "./list.js";
import { findArchivableGoals, type ArchivableGoal } from "./goal-archive.js";
import { awaitingVerdict, effectiveGoalStatus } from "./show.js";

/** An open run with nothing recorded for this long is presumed abandoned. */
const STALE_RUN_HOURS = 24;

export interface ContextGoal {
  id: string;
  title: string;
  status: GoalStatus;
  total: number;
  done: number;
  cancelled: number;
  inReview: number;
  blocked: number;
  qaRequired: boolean;
  /** Governed, every task in review or done, no passing verdict yet. */
  awaitingVerdict: boolean;
}

/** A live task that needs a look: running or blocked. */
export interface ContextTask {
  id: string;
  goalId: string;
  name: string;
  status: TaskStatus;
  blockedReason: string | null;
  lastRunId: string | null;
  /** Running tasks: hours since the open run last recorded anything. */
  idleHours: number | null;
  /** Running with no event for 24 h — reported, never offered as the next step. */
  stale: boolean;
}

export interface ContextStats {
  workerRuns: number;
  workerSuccessRate: number | null;
  medianWorkerDurationSec: number | null;
  journalEntries: number;
  medianJournalDurationSec: number | null;
}

export interface ContextResult {
  project: ProjectSummary;
  installedVersion: string;
  orchestrator: string;
  repos: RepoStatusEntry[];
  /** Live goals only — the digest answers "what is in flight". */
  goals: ContextGoal[];
  archivedGoals: number;
  /** Task counts across live goals; archived goals' tasks are history, not load. */
  tasks: { total: number; byStatus: Record<string, number> };
  attention: ContextTask[];
  looseRequirements: string[];
  recent: RunIndexEntry[];
  stats: ContextStats;
  /** Finished goals still sitting in the live list, waiting to be filed away. */
  archivable: ArchivableGoal[];
  next: string;
  /** `--full` only: the whole dashboard snapshot, as 0.7 returned it. */
  snapshot?: Snapshot;
}

interface LiveTask {
  id: string;
  goalId: string;
  name: string;
  status: TaskStatus;
  blockedReason: string | null;
  lastRunId: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  dependsOn: string[];
  governed: boolean;
}

async function countArchivedGoals(root: string): Promise<number> {
  const archive = goalArchiveDir(root);
  const entries = await fs.readdir(archive, { withFileTypes: true }).catch(() => []);
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory() && (await fs.pathExists(path.join(archive, e.name, "goal.md")))) n += 1;
  }
  return n;
}

/** When the open run last showed signs of life: owner heartbeat, last event, or start. */
async function idleHours(ledger: RunLedger, task: LiveTask, now: number): Promise<number | null> {
  const stamps: number[] = [];
  if (task.heartbeatAt) stamps.push(Date.parse(task.heartbeatAt));
  if (task.lastRunId) {
    const last = (await ledger.events(task.lastRunId)).at(-1);
    if (last?.t) stamps.push(Date.parse(last.t));
  }
  if (task.startedAt) stamps.push(Date.parse(task.startedAt));
  const latest = Math.max(...stamps.filter((t) => !Number.isNaN(t)));
  return Number.isFinite(latest) ? Math.max(0, (now - latest) / 3_600_000) : null;
}

/**
 * §13 — a compact, always-current orientation digest for a session that has just
 * started.
 *
 * Deliberately **derived, never stored.** A `CONTEXT.md` that agents maintain would
 * be a second source of truth for state that already lives in the manifest,
 * `state.json` and the run index — and it would rot exactly like a stale comment,
 * with no way to tell that it had. §3.1's rule (derived artifacts, one source of
 * truth) applies to summaries too. The token saving is real but comes from *not
 * scanning*, not from caching: one command reads the few files that matter and
 * prints ~20 lines, instead of an agent globbing the tree to work it out.
 *
 * Reads live goals only. It used to build the whole dashboard snapshot — every
 * archived goal, every requirement, every run's events — to print those ~20
 * lines: 4 s and a 2.7 MB `--json` on atlas-shop, which is why agents stopped
 * running it. `--full` still returns the snapshot for the few callers that want it.
 */
export async function runContext(options: { cwd?: string; full?: boolean } = {}): Promise<ContextResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const reader = new FileReader(root);
  const ledger = new RunLedger(root);
  const now = Date.now();

  const [project, orchestrator, repos, archivedGoals, runs] = await Promise.all([
    reader.project(),
    resolveOrchestrator(root),
    runList({ cwd: root }),
    countArchivedGoals(root),
    ledger.index(),
  ]);

  const goals: ContextGoal[] = [];
  const live: LiveTask[] = [];
  const byStatus: Record<string, number> = {};
  for (const goal of await findGoals(root, { includeArchived: false })) {
    const tasks = await findTasksInGoal(goal.dir);
    const raw = await readState(goal.dir, goal.id);
    const state = reconcileGoalState(raw, tasks).state;
    const statuses: TaskStatus[] = [];
    for (const task of tasks) {
      const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
      statuses.push(ts.status);
      byStatus[ts.status] = (byStatus[ts.status] ?? 0) + 1;
      live.push({
        id: task.id,
        goalId: goal.id,
        name: task.name,
        status: ts.status,
        blockedReason: ts.blockedReason,
        lastRunId: ts.lastRunId,
        startedAt: ts.startedAt,
        heartbeatAt: ts.owner?.heartbeatAt ?? null,
        dependsOn: task.dependsOn,
        governed: goal.completionPolicy.qaRequired,
      });
    }
    const count = (s: TaskStatus) => statuses.filter((x) => x === s).length;
    goals.push({
      id: goal.id,
      title: goal.title,
      status: await effectiveGoalStatus(root, goal, raw, tasks),
      total: tasks.length,
      done: count("done"),
      cancelled: count("cancelled"),
      inReview: count("in-review"),
      blocked: count("blocked"),
      qaRequired: goal.completionPolicy.qaRequired,
      awaitingVerdict: awaitingVerdict(goal, statuses, raw),
    });
  }

  const attention: ContextTask[] = [];
  for (const t of live.filter((x) => x.status === "running" || x.status === "blocked")) {
    const idle = t.status === "running" ? await idleHours(ledger, t, now) : null;
    attention.push({
      id: t.id,
      goalId: t.goalId,
      name: t.name,
      status: t.status,
      blockedReason: t.blockedReason,
      lastRunId: t.lastRunId,
      idleHours: idle === null ? null : Math.round(idle * 10) / 10,
      stale: idle !== null && idle >= STALE_RUN_HOURS,
    });
  }

  // Requirements still sitting in intake — invisible on the board, so a new
  // session would otherwise never learn they exist.
  const looseRequirements = (await fs.readdir(path.join(root, "requirements")).catch(() => [] as string[]))
    .filter((f: string) => f.endsWith(".md"))
    .map((f: string) => f.replace(/\.md$/, ""));

  const archivable = await findArchivableGoals(root);
  const next = await nextStep(root, { goals, live, attention, looseRequirements, archivable });
  const stats = runStats(runs);

  return {
    project,
    installedVersion: readLibraryVersion(),
    orchestrator: `${orchestrator.runtime}:${orchestrator.model}`,
    repos,
    goals,
    archivedGoals,
    tasks: { total: live.length, byStatus },
    attention,
    looseRequirements,
    recent: [...runs].sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, 3),
    stats,
    archivable,
    next,
    ...(options.full ? { snapshot: await reader.snapshot() } : {}),
  };
}

/**
 * The single most useful line: what a session should actually do next.
 *
 * Finishing outranks starting. A goal waiting on a verdict, or work waiting on a
 * review, is the bottleneck the real workspaces sat in for weeks while this line
 * kept saying "start the next task". A run that has been silent for a day is
 * named as probably abandoned, not offered as the thing to do: it pointed every
 * new session at a worker that had died long ago.
 */
async function nextStep(
  root: string,
  view: {
    goals: ContextGoal[];
    live: LiveTask[];
    attention: ContextTask[];
    looseRequirements: string[];
    archivable: ArchivableGoal[];
  }
): Promise<string> {
  const { goals, live, attention, looseRequirements } = view;
  const running = attention.filter((t) => t.status === "running" && !t.stale);
  const stale = attention.filter((t) => t.status === "running" && t.stale);
  const blocked = attention.filter((t) => t.status === "blocked");
  const verdicts = goals.filter((g) => g.awaitingVerdict);
  // In a governed goal, tasks wait in review for the goal-level verdict — they are
  // not individually approvable, so they are not a per-task review backlog.
  const review = live.filter((t) => t.status === "in-review" && !t.governed);
  const todo = live.filter((t) => t.status === "todo");
  const closed = new Set(live.filter((t) => ["done", "in-review", "cancelled"].includes(t.status)).map((t) => t.id));
  const ready = todo.find((t) => t.dependsOn.every((d) => closed.has(d))) ?? todo[0];
  const unplanned = goals.find((g) => g.total === 0);

  if (running.length > 0) {
    return `${running[0].id} is running — close it with \`awo task complete ${running[0].id} --outcome <success|failed>\``;
  }
  if (verdicts.length > 0) {
    const g = verdicts[0];
    const more = verdicts.length > 1 ? ` (+${verdicts.length - 1} more — \`awo goal list --needs-verdict\`)` : "";
    return `${g.id} awaits a verdict (${g.inReview} in review) — \`awo goal readiness ${g.id}\`, then \`awo goal verify ${g.id}\`${more}`;
  }
  if (review.length > 0) {
    const more = review.length > 1 ? ` (${review.length} in review)` : "";
    return `verify ${review[0].id}${more} — \`awo task verify ${review[0].id}\``;
  }
  if (blocked.length > 0) {
    return `unblock ${blocked[0].id} (${blocked[0].blockedReason ?? "no reason recorded"}) — \`awo task status ${blocked[0].id} todo\``;
  }
  if (ready) return `start ${ready.id} — \`awo task run ${ready.id}\``;
  if (unplanned) return `plan ${unplanned.id} into tasks — \`awo goal plan ${unplanned.id}\``;
  if (stale.length > 0) {
    const t = stale[0];
    return `${t.id}'s run looks abandoned (no events for ${Math.round(t.idleHours ?? 0)}h) — inspect \`awo log tail --task ${t.id}\`, then close it with \`awo task complete ${t.id} --outcome failed\``;
  }
  const qaReview = goals.find((g) => g.status === "qa-review");
  if (qaReview) {
    return `inspect ${qaReview.id} completion blockers — \`awo goal readiness ${qaReview.id}\``;
  }
  if (looseRequirements.length > 0) {
    const { readRequirement } = await import("./intake.js");
    const requirement = await readRequirement(root, looseRequirements[0]);
    if (requirement.status === "draft") {
      return `refine ${requirement.id} into checkable criteria — \`awo req refine ${requirement.id}\``;
    } else if (requirement.status === "proposed") {
      return `have a human accept ${requirement.id} — \`awo req approve ${requirement.id}\``;
    } else if (requirement.status === "rejected") {
      return `revise ${requirement.id} and propose it again — \`awo req propose ${requirement.id}\``;
    }
    return `turn ${requirement.id} into a goal — \`awo goal new --from ${requirement.id}\``;
  }
  if (goals.length === 0) {
    return `nothing live — start with \`awo req new --title "…"\``;
  }
  const target = view.archivable[0] ?? goals[0];
  return `all tasks are closed — inspect \`awo goal readiness ${target.id}\` and verify the definition-of-done${
    view.archivable.length > 0 ? `, then \`awo goal archive ${view.archivable[0].id}\`` : ""
  }`;
}

function duration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? `${String(sec % 60).padStart(2, "0")}s` : ""}`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** ~20 lines an agent can read instead of scanning the tree. */
export function formatContext(c: ContextResult): string {
  const { project, repos, goals } = c;
  const lines: string[] = [];

  const skew =
    project.libraryVersion === c.installedVersion
      ? ""
      : `  (workspace ${project.libraryVersion}, cli ${c.installedVersion})`;
  lines.push(`${project.projectKey} · ${project.projectName} · awo ${c.installedVersion}${skew}`);
  lines.push(`orchestrator  ${c.orchestrator}`);

  const present = repos.filter((r) => r.status === "present").length;
  const bad = repos.filter((r) => r.status !== "present");
  lines.push(
    `repos         ${repos.length} linked, ${present} present${bad.length ? ` — ATTENTION: ${bad.map((r) => `${r.name}:${r.status}`).join(", ")}` : ""}`
  );

  // Archived goals are deliberately not listed. This digest answers "what is live
  // right now", and a finished goal is not — it stays one `awo goal restore` away,
  // and the count keeps it from vanishing silently.
  if (goals.length === 0) lines.push("goals         none live");
  for (const g of goals) {
    const cancelledText = g.cancelled
      ? ` + ${g.cancelled} cancelled (${g.done + g.cancelled}/${g.total} closed)`
      : "";
    const reviewText = g.inReview ? `, ${g.inReview} in review` : "";
    const verdictText = g.awaitingVerdict ? " — awaiting verdict" : "";
    lines.push(
      `goal          ${g.id} ${g.status} — ${g.done}/${g.total} done${cancelledText}${reviewText}${verdictText} · ${g.title}`
    );
  }
  if (c.archivedGoals > 0) lines.push(`              (${c.archivedGoals} archived — \`awo goal list --archived\`)`);

  // Finished goals still in the live list. Named, because an archive you have to
  // remember to use is an archive that stays empty.
  if (c.archivable.length > 0) {
    lines.push(
      `to archive    ${c.archivable.map((g) => `${g.id} (${g.status})`).join(", ")} — \`awo goal archive <id>\``
    );
  }

  const byStatus = Object.entries(c.tasks.byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (byStatus) lines.push(`tasks         ${byStatus}`);

  for (const t of c.attention) {
    const detail =
      t.status === "running"
        ? t.stale
          ? ` — stale (abandoned?) no events for ${Math.round(t.idleHours ?? 0)}h`
          : ""
        : t.blockedReason
          ? ` — ${t.blockedReason}`
          : "";
    lines.push(`              ${t.id} ${t.status}${detail}`);
  }

  if (c.looseRequirements.length > 0) {
    lines.push(`in intake     ${c.looseRequirements.join(", ")} (not yet a goal)`);
  }

  if (c.recent.length === 0) {
    lines.push("recent runs   none");
  } else {
    for (const r of c.recent) {
      const how = [r.tier, r.effort ? `effort=${r.effort}` : null, r.attempts && r.attempts > 1 ? `try#${r.attempts}` : null]
        .filter(Boolean)
        .join(" ");
      const who = r.taskId ?? `${r.agent ?? "adhoc"} (log add)`;
      lines.push(
        `run           ${who} ${r.status}${how ? ` ${how}` : ""}${r.durationSec !== null ? ` ${r.durationSec}s` : ""}`
      );
    }
  }

  // Worker runs and journal entries are counted apart: a `log add` row is always
  // "success", so mixing them reported 99% success on atlas-shop while 736
  // measured test commands had failed.
  const s = c.stats;
  const history: string[] = [];
  if (s.workerRuns > 0) {
    history.push(
      `${s.workerRuns} runs${s.workerSuccessRate !== null ? ` · ${Math.round(s.workerSuccessRate * 100)}% success` : ""} · median ${duration(s.medianWorkerDurationSec)}`
    );
  }
  if (s.journalEntries > 0) {
    history.push(`${s.journalEntries} journal entries · median ${duration(s.medianJournalDurationSec)}`);
  }
  if (history.length > 0) lines.push(`history       ${history.join(" · ")}`);

  lines.push(`NEXT          ${c.next}`);
  return lines.join("\n");
}
