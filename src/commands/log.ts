import fs from "fs-extra";
import { findWorkspaceRoot } from "../workspace.js";
import { detailFile, readEvents, readIndex, type RunEvent, type RunIndexEntry } from "../runs.js";

export interface LogListFilter {
  cwd?: string;
  task?: string;
  agent?: string;
  repo?: string;
  status?: string;
}

export async function runLogList(filter: LogListFilter = {}): Promise<RunIndexEntry[]> {
  const workspaceRoot = findWorkspaceRoot(filter.cwd ?? process.cwd());
  let runs = await readIndex(workspaceRoot);

  if (filter.task) runs = runs.filter((r) => r.taskId === filter.task);
  if (filter.agent) runs = runs.filter((r) => r.agent === filter.agent);
  if (filter.repo) runs = runs.filter((r) => r.reposChanged.includes(filter.repo!));
  if (filter.status) runs = runs.filter((r) => r.status === filter.status);

  // runIds are timestamp-prefixed, so lexical sort is chronological (§7.3).
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

export async function runLogShow(
  runId: string,
  options: { cwd?: string } = {}
): Promise<{ detail: string; events: RunEvent[] }> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const file = detailFile(workspaceRoot, runId);

  if (!(await fs.pathExists(file))) {
    const known = (await readIndex(workspaceRoot)).map((r) => r.runId);
    throw new Error(
      known.length > 0
        ? `Unknown run "${runId}". Known runs: ${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}.`
        : `Unknown run "${runId}". No runs recorded yet.`
    );
  }

  return {
    detail: await fs.readFile(file, "utf8"),
    events: await readEvents(workspaceRoot, runId),
  };
}

/**
 * §7.3 `log tail` — reads the event stream of the most recent run. Not a
 * follow/watch yet: that arrives with `awo status --watch` in Phase 2 (§7.5),
 * which is where the file-watching layer belongs.
 */
export async function runLogTail(
  options: { cwd?: string; runId?: string } = {}
): Promise<{ runId: string; events: RunEvent[] }> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());

  let runId = options.runId;
  if (!runId) {
    const runs = await readIndex(workspaceRoot);
    runId = runs.sort((a, b) => b.runId.localeCompare(a.runId))[0]?.runId;
  }
  if (!runId) throw new Error("No runs recorded yet.");

  return { runId, events: await readEvents(workspaceRoot, runId) };
}
