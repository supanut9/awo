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
 * A runId splits into the slot it files under and its timestamp.
 *
 * §7.3 originally sharded by date — `logs/runs/<YYYY-MM-DD>/<runId>.md` — which
 * put every run of every task in one flat directory, four filename variants deep
 * (`.md`, `.events.jsonl`, `.worker.log`). One day of real work produced 39 files
 * there, and answering "show me every attempt at SHOP-T2" meant globbing a date
 * you had to already know.
 *
 * Filing by task instead makes that an `ls`, and bounds the directory naturally: a
 * task has a handful of runs, where a date has all of them. Work with no task —
 * intake, planning, audits — files under `_adhoc`. A goal-level artefact (the QA
 * gate brief) files under its goal, so `logs/<KEY>-G1/` holds every gate it went
 * through instead of only the most recent overwriting the last.
 *
 * The runId itself is UNCHANGED, so index entries, state and already-published
 * Mongo documents keep their keys; only the path derived from it moves.
 */
export function runSlot(runId: string): { slot: string; stamp: string } {
  const cut = runId.indexOf("_");
  if (cut < 0) return { slot: ADHOC_SLOT, stamp: runId };
  const suffix = runId.slice(cut + 1);
  return {
    slot: /^[A-Za-z][A-Za-z0-9]*-[GT]\d+$/.test(suffix) ? suffix : ADHOC_SLOT,
    stamp: runId.slice(0, cut),
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

/** `logs/<taskId|_adhoc>/<timestamp>/` — one directory per run. */
export function runDir(workspaceRoot: string, runId: string): string {
  const { slot, stamp } = runSlot(runId);
  return path.join(logsRoot(workspaceRoot), slot, stamp);
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
 * Pre-0.0.32 locations, still read so a workspace that has not run `awo upgrade`
 * can still show its history instead of appearing to have lost it.
 */
export function legacyPaths(workspaceRoot: string, runId: string): {
  events: string;
  detail: string;
  worker: string;
  index: string;
} {
  const dir = path.join(logsRoot(workspaceRoot), "runs", runId.slice(0, 10));
  return {
    events: path.join(dir, `${runId}.events.jsonl`),
    detail: path.join(dir, `${runId}.md`),
    worker: path.join(dir, `${runId}.worker.log`),
    index: path.join(logsRoot(workspaceRoot), "runs.jsonl"),
  };
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
  const legacy = legacyPaths(workspaceRoot, runId)[which];
  return (await fs.pathExists(legacy)) ? legacy : current;
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
  if (!(await fs.pathExists(file))) file = legacyPaths(workspaceRoot, "x").index;
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
