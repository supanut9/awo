import fs from "fs-extra";
import path from "path";
import { type RunOutcome } from "./state.js";

/**
 * §7.3 — one folder per day, holding exactly two files.
 *
 * The layout got here by three wrong turns, each fixing the last one's real
 * problem and creating a new one:
 *
 *  - `logs/runs/<date>/<runId>.{md,events.jsonl,worker.log}` — one flat directory
 *    per day with three filename variants per run: 39 files after a single day.
 *  - `logs/<taskId>/<stamp>/` (0.0.32) — grouped by task, which made "every attempt
 *    at T2" an `ls` but gave up chronological browsing and grew one top-level
 *    directory per task forever.
 *  - `logs/<date>/<slot>/<time>/` (0.0.33) — three levels of nesting before a file,
 *    with `_adhoc`, task and goal directories mixed under each day, and machine
 *    names like `16-33-45-180Z` as leaves.
 *
 * What all three share is that the *number of filesystem entries grows with the
 * number of runs*. A day of real work is unreadable however you nest it. So a day
 * is now two files that grow internally instead of many that multiply:
 *
 * ```
 * logs/2026-07-28/runs.jsonl   every event and every run row, append-only
 * logs/2026-07-28/runs.md      every run's written record, one marked section each
 * logs/2026-07-28/workers/     raw worker stdout, only when one was dispatched
 * ```
 *
 * `.jsonl` and not `.json`: a JSON document has to be read-parse-rewritten to add a
 * row, so two workers finishing together silently lose one of the writes. Appending
 * a line is atomic, and parallel workers are the normal case here, not an edge one.
 *
 * Worker output stays out of both files. It is the spawned CLI's raw stdout —
 * unbounded, hundreds of KB, and interleaved nonsense if two workers share a file —
 * where `runs.jsonl` and `runs.md` are what awo itself recorded.
 */

/** `<date>T<HH-MM-SS>_<slot>` — sortable, readable, unique per second per slot. */
export function newRunId(taskId: string, at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 19).replace(/[:.]/g, "-")}_${taskId}`;
}

/**
 * A runId that no run in its day already holds.
 *
 * Milliseconds used to be carried in the runId purely to avoid collisions when a
 * task ran twice inside one second — which happened, and produced two runs sharing
 * an id, one events stream and a duplicate index row. Now that a run's identity is
 * checked against the day it lands in, the id can stay readable and uniqueness is
 * enforced where it actually matters: at allocation.
 */
export async function allocateRunId(
  workspaceRoot: string,
  taskId: string,
  at: Date = new Date()
): Promise<string> {
  const taken = new Set((await readDayLines(workspaceRoot, at.toISOString().slice(0, 10))).map((l) => l.runId));
  const when = new Date(at.getTime());
  for (let bump = 0; bump < 120; bump += 1) {
    const candidate = newRunId(taskId, when);
    if (!taken.has(candidate)) return candidate;
    when.setSeconds(when.getSeconds() + 1);
  }
  // 120 runs of one task inside two minutes is a runaway loop, not a real workload.
  throw new Error(`could not allocate a runId for ${taskId}: 120 consecutive seconds are taken`);
}

/** The day a runId belongs to, the slot it is for, and its time of day. */
export function runSlot(runId: string): { date: string; slot: string; time: string } {
  const cut = runId.indexOf("_");
  const stamp = cut < 0 ? runId : runId.slice(0, cut);
  const suffix = cut < 0 ? "" : runId.slice(cut + 1);
  return {
    date: stamp.slice(0, 10),
    slot: suffix || "adhoc",
    // Tolerates the old `15-48-08-430Z` form as well as `15-48-08`.
    time: stamp.slice(11, 19) || stamp,
  };
}

export type EventKind =
  /**
   * What the worker was told, recorded when the run opens.
   *
   * 28 of 28 records from the first real multi-agent run said "User prompt: _not
   * recorded_". The prompt flag existed but sat on `task complete`, at the end,
   * optional — so nobody passed it, and the log could show what a worker did with no
   * trace of what it was asked. An instruction nobody kept is an instruction nobody
   * can hold the worker to.
   */
  | "brief"
  | "run.start"
  | "repo.baseline"
  | "step.start"
  | "step.end"
  | "repo.diff"
  | "test"
  | "commit"
  | "note"
  | "run.end";

export interface RunEvent {
  t: string;
  kind: EventKind;
  [key: string]: unknown;
}

function logsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, "logs");
}

export function dayDir(workspaceRoot: string, runId: string): string {
  return path.join(logsRoot(workspaceRoot), runSlot(runId).date);
}

/** The day's structured data: every event, and one row per completed run. */
export function dayDataFile(workspaceRoot: string, runId: string): string {
  return path.join(dayDir(workspaceRoot, runId), "runs.jsonl");
}

/** The day's prose: every run's record, each behind a machine-readable marker. */
export function dayRecordFile(workspaceRoot: string, runId: string): string {
  return path.join(dayDir(workspaceRoot, runId), "runs.md");
}

/** Where a run's record lives. The file is shared; the section inside is not. */
export function detailFile(workspaceRoot: string, runId: string): string {
  return dayRecordFile(workspaceRoot, runId);
}

/** Raw stdout+stderr of a dispatched worker. Absent when a human drove the run. */
export function workerLogFile(workspaceRoot: string, runId: string): string {
  const { slot, time } = runSlot(runId);
  return path.join(dayDir(workspaceRoot, runId), "workers", `${time}-${slot}.log`);
}

/** The marker `publish` and `log show` split the day's records on. */
export function recordMarker(runId: string): string {
  return `<!-- awo:run ${runId} -->`;
}

// ---------------------------------------------------------------------------
// day file I/O
// ---------------------------------------------------------------------------

interface DayLine {
  type: "event" | "run";
  runId: string;
  [key: string]: unknown;
}

async function readDayLines(workspaceRoot: string, date: string): Promise<DayLine[]> {
  const file = path.join(logsRoot(workspaceRoot), date, "runs.jsonl");
  if (!(await fs.pathExists(file))) return [];
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as DayLine);
}

async function appendDayLine(workspaceRoot: string, runId: string, line: DayLine): Promise<void> {
  const file = dayDataFile(workspaceRoot, runId);
  await fs.ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(line)}\n`);
}

/**
 * §7.4 — append-only progress stream, written DURING the run. This is what makes
 * progress observable at all, and why the day file is line-appended rather than
 * rewritten: an event must survive the process that wrote it dying.
 */
export async function appendEvent(
  workspaceRoot: string,
  runId: string,
  kind: EventKind,
  fields: Record<string, unknown> = {}
): Promise<RunEvent> {
  const event: RunEvent = { t: new Date().toISOString(), kind, ...fields };
  await appendDayLine(workspaceRoot, runId, { type: "event", runId, ...event });
  return event;
}

export async function readEvents(workspaceRoot: string, runId: string): Promise<RunEvent[]> {
  const { date } = runSlot(runId);
  const own = (await readDayLines(workspaceRoot, date))
    .filter((l) => l.type === "event" && l.runId === runId)
    .map(({ type: _type, runId: _runId, ...rest }) => rest as unknown as RunEvent);
  if (own.length > 0) return own;
  return readLegacyEvents(workspaceRoot, runId);
}

export interface RunIndexEntry {
  runId: string;
  taskId: string | null;
  agent: string | null;
  /**
   * §12 — what actually ran, so the log can answer "do low-effort runs fail or
   * retry more often?". Without these the tier/effort mapping stays a guess: the
   * policy is a hypothesis and the index is the only place evidence accumulates.
   */
  tier?: string;
  model?: string;
  effort?: string;
  attempts?: number;
  status: "running" | RunOutcome;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number | null;
  reposChanged: string[];
  detailFile: string;
}

/** §7.3 — one row per completed run, in its day's file. */
export async function appendIndex(workspaceRoot: string, entry: RunIndexEntry): Promise<void> {
  await appendDayLine(workspaceRoot, entry.runId, { type: "run", ...entry });
}

/**
 * Every run ever recorded, newest last.
 *
 * Reads each day's file rather than one global index. A global index duplicated
 * what the day files already hold, and duplication is how they drift: 0.0.33 moved
 * the files and left 24 index pointers dangling (§9 finding 61). One writer, one
 * copy.
 */
export async function readIndex(workspaceRoot: string): Promise<RunIndexEntry[]> {
  const root = logsRoot(workspaceRoot);
  const entries: RunIndexEntry[] = [];
  for (const name of (await fs.readdir(root).catch(() => [])) as string[]) {
    if (!(await fs.stat(path.join(root, name)).catch(() => null))?.isDirectory()) continue;
    for (const line of await readDayLines(workspaceRoot, name)) {
      if (line.type === "run") {
        const { type: _type, ...rest } = line;
        entries.push(rest as unknown as RunIndexEntry);
      }
    }
  }
  if (entries.length > 0) return entries.sort((a, b) => a.runId.localeCompare(b.runId));
  return readLegacyIndex(workspaceRoot);
}

/**
 * §7.3 — the readable record, written once at the end of a run, appended to its
 * day as a marked section. Replaces its own section if one already exists, so a
 * re-closed run updates rather than duplicating.
 */
export async function writeDetail(
  workspaceRoot: string,
  runId: string,
  frontmatter: Record<string, unknown>,
  sections: { prompt?: string; interpreted?: string; summary?: string; notes?: string[] }
): Promise<string> {
  const meta = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(", ") || "none" : v === null ? "—" : v}`)
    .join("\n");

  const { time, slot } = runSlot(runId);
  const section = [
    recordMarker(runId),
    `## ${time.replace(/-/g, ":")} · ${slot}`,
    "",
    meta,
    "",
    "### User prompt",
    sections.prompt?.trim() || "_not recorded_",
    "",
    "### Interpreted intent",
    sections.interpreted?.trim() || "_not recorded_",
    "",
    "### Summary of changes",
    sections.summary?.trim() || "_not recorded_",
    "",
    "### Notes / follow-ups",
    sections.notes && sections.notes.length > 0
      ? sections.notes.map((n) => `- ${n}`).join("\n")
      : "- none",
    "",
  ].join("\n");

  const file = dayRecordFile(workspaceRoot, runId);
  await fs.ensureDir(path.dirname(file));
  const existing = (await fs.readFile(file, "utf8").catch(() => "")) as string;

  if (existing.includes(recordMarker(runId))) {
    await fs.writeFile(file, replaceSection(existing, runId, section));
  } else {
    const header = existing.trim() === "" ? `# Runs on ${runSlot(runId).date}\n\n` : "";
    await fs.appendFile(file, `${header}${section}\n`);
  }
  return file;
}

/** One run's record, extracted from its day. */
export async function readDetail(workspaceRoot: string, runId: string): Promise<string> {
  const file = dayRecordFile(workspaceRoot, runId);
  const text = (await fs.readFile(file, "utf8").catch(() => "")) as string;
  const found = extractSection(text, runId);
  if (found) return found;
  return readLegacyDetail(workspaceRoot, runId);
}

function sectionBounds(text: string, runId: string): { start: number; end: number } | null {
  const start = text.indexOf(recordMarker(runId));
  if (start < 0) return null;
  const next = text.indexOf("<!-- awo:run ", start + 1);
  return { start, end: next < 0 ? text.length : next };
}

function extractSection(text: string, runId: string): string {
  const at = sectionBounds(text, runId);
  return at ? text.slice(at.start, at.end).trim() : "";
}

function replaceSection(text: string, runId: string, section: string): string {
  const at = sectionBounds(text, runId);
  if (!at) return `${text}${section}\n`;
  return `${text.slice(0, at.start)}${section}\n${text.slice(at.end)}`;
}

// ---------------------------------------------------------------------------
// earlier layouts, still read
// ---------------------------------------------------------------------------

/**
 * Every location a run's files have ever lived, newest layout first, so a
 * workspace that has not run `awo upgrade` still shows its history rather than
 * appearing to have lost it.
 */
function legacyCandidates(
  workspaceRoot: string,
  runId: string
): { events: string; detail: string; worker: string }[] {
  const logs = logsRoot(workspaceRoot);
  const { date, slot, time } = runSlot(runId);
  const cut = runId.indexOf("_");
  const stamp = cut < 0 ? runId : runId.slice(0, cut);
  const stampSlot = cut < 0 ? "_adhoc" : runId.slice(cut + 1);
  const dirs = [
    // 0.0.33/0.0.34: <date>/<slot>/<time>/
    path.join(logs, date, stampSlot, stamp.slice(11) || time),
    // 0.0.32: <slot>/<stamp>/
    path.join(logs, stampSlot, stamp),
  ];
  return [
    ...dirs.map((dir) => ({
      events: path.join(dir, "events.jsonl"),
      detail: path.join(dir, "record.md"),
      worker: path.join(dir, "worker.log"),
    })),
    // pre-0.0.32: runs/<date>/<runId>.<ext>
    {
      events: path.join(logs, "runs", date, `${runId}.events.jsonl`),
      detail: path.join(logs, "runs", date, `${runId}.md`),
      worker: path.join(logs, "runs", date, `${runId}.worker.log`),
    },
  ];
}

async function readLegacyEvents(workspaceRoot: string, runId: string): Promise<RunEvent[]> {
  for (const layout of legacyCandidates(workspaceRoot, runId)) {
    if (!(await fs.pathExists(layout.events))) continue;
    return (await fs.readFile(layout.events, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RunEvent);
  }
  return [];
}

async function readLegacyDetail(workspaceRoot: string, runId: string): Promise<string> {
  for (const layout of legacyCandidates(workspaceRoot, runId)) {
    if (await fs.pathExists(layout.detail)) return fs.readFile(layout.detail, "utf8");
  }
  return "";
}

async function readLegacyIndex(workspaceRoot: string): Promise<RunIndexEntry[]> {
  for (const name of ["index.jsonl", "runs.jsonl"]) {
    const file = path.join(logsRoot(workspaceRoot), name);
    if (!(await fs.pathExists(file))) continue;
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RunIndexEntry);
  }
  return [];
}

/** The current path if it exists, else the newest earlier one that does. */
export async function resolveRunFile(
  workspaceRoot: string,
  runId: string,
  which: "events" | "detail" | "worker"
): Promise<string> {
  const current =
    which === "worker" ? workerLogFile(workspaceRoot, runId) : dayRecordFile(workspaceRoot, runId);
  if (which !== "detail" && (await fs.pathExists(current))) return current;
  if (which === "detail" && (await fs.pathExists(current))) return current;
  for (const layout of legacyCandidates(workspaceRoot, runId)) {
    if (await fs.pathExists(layout[which])) return layout[which];
  }
  return current;
}
