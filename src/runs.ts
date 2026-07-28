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

/** The date shard a runId belongs to (`logs/runs/<YYYY-MM-DD>/`). */
export function runDateShard(runId: string): string {
  return runId.slice(0, 10);
}

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

export function runDir(workspaceRoot: string, runId: string): string {
  return path.join(logsRoot(workspaceRoot), "runs", runDateShard(runId));
}

export function eventsFile(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), `${runId}.events.jsonl`);
}

export function detailFile(workspaceRoot: string, runId: string): string {
  return path.join(runDir(workspaceRoot, runId), `${runId}.md`);
}

export function indexFile(workspaceRoot: string): string {
  return path.join(logsRoot(workspaceRoot), "runs.jsonl");
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
  const file = eventsFile(workspaceRoot, runId);
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
  const file = indexFile(workspaceRoot);
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
