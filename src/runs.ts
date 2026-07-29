import fs from "fs-extra";
import path from "path";
import { type RunOutcome } from "./state.js";

/**
 * §7.3 — `<ISO-timestamp>_<taskId>`: sortable, unique, human-readable.
 *
 * Milliseconds are kept deliberately. Truncating to seconds collided when the
 * same task was run twice inside one second: both runs shared a runId, appended
 * to the same events file, and wrote duplicate index entries — breaking the
 * uniqueness §7.3 relies on to link index, detail and state.
 */
export function newRunId(taskId: string, at: Date = new Date()): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}_${taskId}`;
}

/**
 * A runId splits into the date it happened, the slot it belongs to, and the time.
 *
 * §7.3 first sharded by date alone — `logs/runs/<date>/<runId>.md` — which put
 * every run of every task in one flat directory: 39 files after a single day, and
 * four filename variants per run to parse. 0.0.32 filed by task instead, which
 * fixed that but lost the thing date-sharding was good at, namely "show me what
 * happened on Tuesday" and a directory that stays small as the project ages.
 *
 * So: date first, then the task under it. Browsing is chronological, each day's
 * directory holds only that day's work, and a day's runs are already grouped by
 * the task they belong to rather than interleaved by timestamp.
 *
 * The cost, stated plainly: every run of one task is no longer a single `ls` —
 * it spans the days it ran on. `awo log list --task <id>` answers that from the
 * index, which is what an index is for, and the index never moved.
 *
 * Work with no task — intake, planning, audits — files under `_adhoc`. A
 * goal-level artefact (the QA gate brief) files under its goal, so a goal keeps
 * every gate it went through instead of the newest overwriting the last.
 *
 * The runId itself is UNCHANGED, so index entries, state and already-published
 * Mongo documents keep their keys; only the path derived from it moves.
 */
export function runSlot(runId: string): { date: string; slot: string; time: string } {
  const cut = runId.indexOf("_");
  const stamp = cut < 0 ? runId : runId.slice(0, cut);
  const suffix = cut < 0 ? "" : runId.slice(cut + 1);
  return {
    date: stamp.slice(0, 10),
    slot: /^[A-Za-z][A-Za-z0-9]*-[GT]\d+$/.test(suffix) ? suffix : ADHOC_SLOT,
    // The date is already the parent directory, so it is not repeated here.
    time: stamp.slice(11) || stamp,
  };
}

/** Leading underscore so it sorts away from real task IDs and can never collide. */
const ADHOC_SLOT = "_adhoc";

export type EventKind =
  | "run.start"
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

/** `logs/<date>/<taskId|goalId|_adhoc>/<time>/` — one directory per run. */
export function runDir(workspaceRoot: string, runId: string): string {
  const { date, slot, time } = runSlot(runId);
  return path.join(logsRoot(workspaceRoot), date, slot, time);
}

// Fixed names inside the run directory. The runId is the directory now, so it no
// longer has to be repeated in every filename — and a new artefact is a new file
// rather than a new suffix to parse.
export function eventsFile(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), "events.jsonl");
}

export function detailFile(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), "record.md");
}

/** stdout+stderr of a dispatched worker. Absent when a human drove the run. */
export function workerLogFile(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), "worker.log");
}

export function indexFile(workspaceRoot: string): string {
  return path.join(logsRoot(workspaceRoot), "index.jsonl");
}

/**
 * Every earlier location, newest first, so a workspace that has not run
 * `awo upgrade` still shows its history instead of appearing to have lost it.
 */
export function legacyPaths(
  workspaceRoot: string,
  runId: string
): { events: string; detail: string; worker: string }[] {
  const { date, slot, time } = runSlot(runId);
  const stamp = `${date}T${time}`;
  return [
    // 0.0.32: task first, no date shard.
    {
      events: path.join(logsRoot(workspaceRoot), slot, stamp, "events.jsonl"),
      detail: path.join(logsRoot(workspaceRoot), slot, stamp, "record.md"),
      worker: path.join(logsRoot(workspaceRoot), slot, stamp, "worker.log"),
    },
    // pre-0.0.32: date shard, runId repeated in every filename.
    {
      events: path.join(logsRoot(workspaceRoot), "runs", date, `${runId}.events.jsonl`),
      detail: path.join(logsRoot(workspaceRoot), "runs", date, `${runId}.md`),
      worker: path.join(logsRoot(workspaceRoot), "runs", date, `${runId}.worker.log`),
    },
  ];
}

export function legacyIndexFile(workspaceRoot: string): string {
  return path.join(logsRoot(workspaceRoot), "runs.jsonl");
}

/** The current path if it exists, else the legacy one, else the current path. */
export async function resolveRunFile(
  workspaceRoot: string,
  runId: string,
  which: "events" | "detail" | "worker"
): Promise<string> {
  const current =
    which === "events"
      ? eventsFile(workspaceRoot, runId)
      : which === "detail"
        ? detailFile(workspaceRoot, runId)
        : workerLogFile(workspaceRoot, runId);
  if (await fs.pathExists(current)) return current;
  for (const layout of legacyPaths(workspaceRoot, runId)) {
    if (await fs.pathExists(layout[which])) return layout[which];
  }
  return current;
}

/**
 * §7.4 — append-only progress stream. One line per meaningful step, written
 * DURING the run; this is what makes progress observable at all.
 */
export async function appendEvent(
  workspaceRoot: string,
  runId: string,
  kind: EventKind,
  fields: Record<string, unknown> = {}
): Promise<RunEvent> {
  const event: RunEvent = { t: new Date().toISOString(), kind, ...fields };
  await fs.ensureDir(runDir(workspaceRoot, runId));
  await fs.appendFile(eventsFile(workspaceRoot, runId), `${JSON.stringify(event)}\n`);
  return event;
}

export async function readEvents(workspaceRoot: string, runId: string): Promise<RunEvent[]> {
  const file = await resolveRunFile(workspaceRoot, runId, "events");
  if (!(await fs.pathExists(file))) return [];
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);
}

export interface RunIndexEntry {
  runId: string;
  taskId: string | null;
  agent: string | null;
  /**
   * §12 — what actually ran, so the log can answer "do low-effort runs fail or
   * retry more often?". Without these the tier/effort mapping stays a guess:
   * the policy is a hypothesis and the index is the only place the evidence can
   * accumulate.
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

/** §7.3 — the query index. Append-only; one line per completed run. */
export async function appendIndex(
  workspaceRoot: string,
  entry: RunIndexEntry
): Promise<void> {
  await fs.ensureDir(logsRoot(workspaceRoot));
  await fs.appendFile(indexFile(workspaceRoot), `${JSON.stringify(entry)}\n`);
}

export async function readIndex(workspaceRoot: string): Promise<RunIndexEntry[]> {
  let file = indexFile(workspaceRoot);
  if (!(await fs.pathExists(file))) file = legacyIndexFile(workspaceRoot);
  if (!(await fs.pathExists(file))) return [];
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunIndexEntry);
}

/** §7.3 — the readable record, written once at the end of a run. */
export async function writeDetail(
  workspaceRoot: string,
  runId: string,
  frontmatter: Record<string, unknown>,
  sections: { prompt?: string; interpreted?: string; summary?: string; notes?: string[] }
): Promise<string> {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return v.length === 0 ? `${k}: []` : `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      }
      return `${k}: ${v === null ? "null" : v}`;
    })
    .join("\n");

  const body = [
    "## User prompt",
    sections.prompt?.trim() || "_not recorded_",
    "",
    "## Interpreted intent",
    sections.interpreted?.trim() || "_not recorded_",
    "",
    "## Summary of changes",
    sections.summary?.trim() || "_not recorded_",
    "",
    "## Notes / follow-ups",
    sections.notes && sections.notes.length > 0
      ? sections.notes.map((n) => `- ${n}`).join("\n")
      : "- none",
    "",
  ].join("\n");

  const file = detailFile(workspaceRoot, runId);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, `---\n${yaml}\n---\n\n${body}`);
  return file;
}
