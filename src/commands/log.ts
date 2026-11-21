import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import {
  appendIndex,
  detailFile,
  readDetail,
  allocateRunId,
  readEvents,
  writeDetail,
  type RunEvent,
  type RunIndexEntry,
} from "../runs.js";
import { RUN_OUTCOMES, readState, type RunOutcome } from "../state.js";
import { locateTask } from "../tasks.js";
import { RunLedger } from "../ui/reader.js";
import { actorLabel } from "../agent-env.js";
import { findGoalOrThrow } from "./show.js";

/** runIds are `<date>T<time>_<slot>`; anything else given to `log show/tail` is a task id. */
const RUN_ID = /^\d{4}-\d{2}-\d{2}T/;

/** A `log add` row may point at the task or goal it was about, without becoming a task run. */
export interface JournalIndexEntry extends RunIndexEntry {
  linkedTaskId?: string;
  linkedGoalId?: string;
}

export interface LogListFilter {
  cwd?: string;
  task?: string;
  goal?: string;
  agent?: string;
  repo?: string;
  status?: string;
  tier?: string;
  effort?: string;
  /** Newest n runs only. */
  limit?: number;
}

export async function runLogList(filter: LogListFilter = {}): Promise<JournalIndexEntry[]> {
  const workspaceRoot = findWorkspaceRoot(filter.cwd ?? process.cwd());
  let runs = (await new RunLedger(workspaceRoot).index()) as JournalIndexEntry[];

  if (filter.task) runs = runs.filter((r) => r.taskId === filter.task || r.linkedTaskId === filter.task);
  if (filter.goal) {
    const goal = await findGoalOrThrow(workspaceRoot, filter.goal);
    const taskIds = new Set(goal.taskIds);
    runs = runs.filter(
      (r) =>
        (r.taskId !== null && taskIds.has(r.taskId)) ||
        r.linkedGoalId === goal.id ||
        (r.linkedTaskId !== undefined && taskIds.has(r.linkedTaskId))
    );
  }
  if (filter.agent) runs = runs.filter((r) => r.agent === filter.agent);
  if (filter.repo) runs = runs.filter((r) => r.reposChanged.includes(filter.repo!));
  if (filter.status) runs = runs.filter((r) => r.status === filter.status);
  if (filter.tier) runs = runs.filter((r) => r.tier === filter.tier);
  if (filter.effort) runs = runs.filter((r) => r.effort === filter.effort);

  // runIds are timestamp-prefixed, so lexical sort is chronological (§7.3).
  runs = runs.sort((a, b) => b.runId.localeCompare(a.runId));
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit < 0) {
      throw new Error(`--limit must be a whole number; got "${filter.limit}".`);
    }
    if (filter.limit > 0) runs = runs.slice(0, filter.limit);
  }
  return runs;
}

/** The newest runs — completed or still open — for "did you mean" lists. */
async function newestRunIds(ledger: RunLedger, count: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const date of [...(await ledger.days())].reverse()) {
    for (const line of await ledger.day(date)) ids.add(line.runId);
    if (ids.size >= count) break;
  }
  if (ids.size === 0) for (const r of await ledger.index()) ids.add(r.runId);
  return [...ids].sort().reverse().slice(0, count);
}

async function unknownRun(workspaceRoot: string, id: string, extra = ""): Promise<Error> {
  // Newest, not oldest: the run someone is looking for is almost always recent,
  // and the old list named the five first runs the workspace ever had.
  const known = await newestRunIds(new RunLedger(workspaceRoot), 5);
  return new Error(
    known.length > 0
      ? `Unknown run "${id}"${extra}. Newest runs: ${known.join(", ")} — \`awo log list --limit 20\` for more.`
      : `Unknown run "${id}"${extra}. No runs recorded yet.`
  );
}

/**
 * A task's most recent run, open or closed. `state.lastRunId` is authoritative;
 * the day files are the fallback for tasks whose state predates it.
 */
export async function latestRunOfTask(workspaceRoot: string, taskId: string): Promise<string> {
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const state = await readState(goal.dir, goal.id);
  const last = state.tasks[task.id]?.lastRunId;
  if (last) return last;
  const ledger = new RunLedger(workspaceRoot);
  for (const date of [...(await ledger.days())].reverse()) {
    const hit = (await ledger.runsWithEvents(date)).filter((id) => id.endsWith(`_${task.id}`)).at(-1);
    if (hit) return hit;
  }
  throw new Error(`${task.id} has no runs yet — start one with \`awo task run ${task.id}\`.`);
}

/** A run id as given, or the latest run of the task id given instead. */
async function resolveRunRef(workspaceRoot: string, ref: string): Promise<string | null> {
  if (RUN_ID.test(ref)) return ref;
  try {
    return await latestRunOfTask(workspaceRoot, ref);
  } catch (err) {
    if (/^Unknown task "/.test((err as Error).message)) return null;
    throw err;
  }
}

export interface LogShowResult {
  runId: string;
  detail: string;
  events: RunEvent[];
  /** No written record yet — the run is still open, so its events stand in. */
  open: boolean;
}

/**
 * The written record of a run. Accepts a task id (its latest run), and falls back
 * to the event stream for a run that is still open: "unknown run" for a run that
 * was visibly in progress sent agents hunting through the day files by hand.
 */
export async function runLogShow(
  ref: string,
  options: { cwd?: string } = {}
): Promise<LogShowResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const runId = await resolveRunRef(workspaceRoot, ref);
  if (!runId) throw await unknownRun(workspaceRoot, ref, " (and no task has that id)");

  const detail = await readDetail(workspaceRoot, runId);
  const events = await readEvents(workspaceRoot, runId);
  if (detail.trim() !== "") return { runId, detail, events, open: false };
  if (events.length > 0) return { runId, detail: "", events, open: true };
  throw await unknownRun(workspaceRoot, runId);
}

/**
 * §7.3 `log tail` — the event stream of one run: the newest run that has events
 * (open runs included), a task's latest run, or a named run.
 *
 * It used to read only the index of COMPLETED runs, so while a worker was mid-run
 * it showed some other, finished run — and the hint after a failed measurement
 * pointed agents at it: the wrong run 74 times out of 75 on the real workspaces.
 * `log add` entries have no events and are skipped rather than shown empty.
 */
export async function runLogTail(
  options: { cwd?: string; runId?: string; task?: string } = {}
): Promise<{ runId: string; events: RunEvent[]; open: boolean }> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const ledger = new RunLedger(workspaceRoot);

  let runId = options.runId ? await resolveRunRef(workspaceRoot, options.runId) : null;
  if (options.runId && !runId) throw await unknownRun(workspaceRoot, options.runId, " (and no task has that id)");
  if (!runId && options.task) runId = await latestRunOfTask(workspaceRoot, options.task);
  if (!runId) {
    for (const date of [...(await ledger.days())].reverse()) {
      runId = (await ledger.runsWithEvents(date)).at(-1) ?? null;
      if (runId) break;
    }
  }
  if (!runId) {
    // Pre-day-file layouts keep their events elsewhere; the index still names them.
    runId = (await ledger.index()).at(-1)?.runId ?? null;
  }
  if (!runId) throw new Error("No runs recorded yet.");

  const events = await ledger.events(runId);
  if (events.length === 0) {
    const detail = await readDetail(workspaceRoot, runId);
    if (detail.trim() === "") throw await unknownRun(workspaceRoot, runId);
    throw new Error(`${runId} recorded no events (a \`log add\` entry) — read it with \`awo log show ${runId}\`.`);
  }
  return { runId, events, open: !events.some((e) => e.kind === "run.end") };
}

/** Lines of a brief shown by `log tail`; the whole thing is one `log show` away. */
const BRIEF_PREVIEW_LINES = 6;

export function formatEvents(events: RunEvent[], options: { runId: string; fullBrief?: boolean }): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const brief = e.kind === "brief" && typeof e.text === "string" ? e.text : null;
    const rest = Object.entries(e)
      .filter(([k]) => k !== "t" && k !== "kind" && !(brief !== null && k === "text"))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    lines.push(`${e.t}  ${e.kind}${rest ? `  ${rest}` : ""}`);
    if (brief === null) continue;
    // A brief is hundreds of lines; printed whole it buried every event after it.
    const text = brief.split("\n");
    const shown = options.fullBrief ? text : text.slice(0, BRIEF_PREVIEW_LINES);
    for (const line of shown) lines.push(`    ${line}`);
    if (shown.length < text.length) {
      lines.push(`    … ${text.length - shown.length} more lines — full brief: \`awo log show ${options.runId}\``);
    }
  }
  return lines;
}

export interface LogAddResult {
  runId: string;
  detail: string;
  /** Who the entry was recorded for, after defaults. */
  agent: string;
  /** Non-fatal problems worth telling the caller about (printed on stderr). */
  warnings: string[];
}

/** Runtime labels `--agent` may legitimately carry even though they are not roles. */
const RUNTIME_LABELS = new Set(["claude", "codex", "gemini", "human", "orchestrator", "agent"]);

/** Spellings that name a model, not a role: `opus`, `gpt-5.4-mini`, `claude:haiku`. */
function looksLikeModel(name: string): boolean {
  return /[:/]/.test(name) || /(opus|sonnet|haiku|gpt-?\d|^o\d|gemini-|codex-|llama|mistral|deepseek|qwen|grok)/i.test(name);
}

/** A runId-safe slug from a free-text label or title. */
function slugify(text: string): string {
  return (
    text
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "adhoc"
  );
}

/**
 * §7.3 — record work that isn't a task run: intake, planning, an audit pass, an
 * ad-hoc prompt. The log format already allows `taskId: null` for exactly this;
 * before this command existed, everything an agent did before `task run` left no
 * trace at all, and agents improvised by hand-writing entries (§9 item 14).
 *
 * Unlike `task run`, this records an already-finished piece of work, so there is
 * no live event stream — just the index line and the readable detail.
 *
 * Mined from real invocations: agents wrote `log add "<summary>"`, `--title`,
 * `--status`, and left out `--agent` far more often than they got the required
 * flags right, and each miss cost a retry. Everything but the summary now has a
 * default, and the summary can come from where they put it.
 */
export async function runLogAdd(options: {
  cwd?: string;
  agent?: string;
  summary?: string;
  label?: string;
  prompt?: string;
  interpreted?: string;
  note?: string[];
  repo?: string[];
  model?: string[];
  outcome?: string;
  startedAt?: string;
  durationSec?: number;
  /** The task this work was about. Linked, not a task run: `taskId` stays null. */
  task?: string;
  /** The goal this work was about. */
  goal?: string;
}): Promise<LogAddResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const warnings: string[] = [];

  let notes = options.note ?? [];
  let summary = options.summary?.trim();
  if (!summary && notes.length > 0) {
    summary = notes[0].trim();
    notes = notes.slice(1);
  }
  if (!summary) {
    throw new Error(
      `log add needs a summary of what was done — \`awo log add "<summary>"\` (or \`-m "<summary>"\`).`
    );
  }

  const explicitAgent = options.agent?.trim();
  const agent = explicitAgent || process.env.AWO_AGENT?.trim() || actorLabel() || "orchestrator";
  if (explicitAgent && !RUNTIME_LABELS.has(explicitAgent) && looksLikeModel(explicitAgent)) {
    const onRoster = await fs.pathExists(path.join(workspaceRoot, "agents", `${explicitAgent}.md`));
    if (!onRoster) {
      warnings.push(
        `--agent "${explicitAgent}" is not an agent in agents/ and looks like a model name — record models with \`--model ${explicitAgent}\` and the role with --agent.`
      );
    }
  }

  let linkedTaskId: string | undefined;
  let linkedGoalId: string | undefined;
  if (options.task) {
    const located = await locateTask(workspaceRoot, options.task);
    linkedTaskId = located.task.id;
    linkedGoalId = located.goal.id;
  }
  if (options.goal) linkedGoalId = (await findGoalOrThrow(workspaceRoot, options.goal)).id;

  const outcome = (options.outcome ?? "success") as RunOutcome;
  if (!RUN_OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown outcome "${options.outcome}". Valid: ${RUN_OUTCOMES.join(", ")}.`);
  }

  const label = slugify(options.label ?? "adhoc");
  const finishedAt = new Date().toISOString();
  const startedAt = options.startedAt ?? finishedAt;
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new Error(`--started must be an ISO timestamp; got "${options.startedAt}".`);
  }

  const runId = await allocateRunId(workspaceRoot, label, new Date(startedAt));
  const durationSec =
    options.durationSec ??
    Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));

  await writeDetail(
    workspaceRoot,
    runId,
    {
      runId,
      taskId: null,
      ...(linkedTaskId ? { linkedTask: linkedTaskId } : {}),
      ...(linkedGoalId ? { linkedGoal: linkedGoalId } : {}),
      agent,
      models: options.model ?? [],
      status: outcome,
      startedAt,
      finishedAt,
      durationSec,
      reposChanged: options.repo ?? [],
    },
    {
      prompt: options.prompt,
      interpreted: options.interpreted,
      summary,
      notes,
    }
  );

  const entry: JournalIndexEntry = {
    runId,
    taskId: null,
    agent,
    status: outcome,
    startedAt,
    finishedAt,
    durationSec,
    reposChanged: options.repo ?? [],
    detailFile: path.relative(path.join(workspaceRoot, "logs"), detailFile(workspaceRoot, runId)),
    ...(linkedTaskId ? { linkedTaskId } : {}),
    ...(linkedGoalId ? { linkedGoalId } : {}),
  };
  await appendIndex(workspaceRoot, entry);

  return { runId, detail: path.relative(workspaceRoot, detailFile(workspaceRoot, runId)), agent, warnings };
}
