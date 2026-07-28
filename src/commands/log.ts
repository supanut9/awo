import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import {
  appendIndex,
  detailFile,
  newRunId,
  readEvents,
  readIndex,
  writeDetail,
  type RunEvent,
  type RunIndexEntry,
} from "../runs.js";
import { RUN_OUTCOMES, type RunOutcome } from "../state.js";

export interface LogListFilter {
  cwd?: string;
  task?: string;
  agent?: string;
  repo?: string;
  status?: string;
  tier?: string;
  effort?: string;
}

export async function runLogList(filter: LogListFilter = {}): Promise<RunIndexEntry[]> {
  const workspaceRoot = findWorkspaceRoot(filter.cwd ?? process.cwd());
  let runs = await readIndex(workspaceRoot);

  if (filter.task) runs = runs.filter((r) => r.taskId === filter.task);
  if (filter.agent) runs = runs.filter((r) => r.agent === filter.agent);
  if (filter.repo) runs = runs.filter((r) => r.reposChanged.includes(filter.repo!));
  if (filter.status) runs = runs.filter((r) => r.status === filter.status);
  if (filter.tier) runs = runs.filter((r) => r.tier === filter.tier);
  if (filter.effort) runs = runs.filter((r) => r.effort === filter.effort);

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

export interface LogAddResult {
  runId: string;
  detail: string;
}

/**
 * §7.3 — record work that isn't a task run: intake, planning, an audit pass, an
 * ad-hoc prompt. The log format already allows `taskId: null` for exactly this;
 * before this command existed, everything an agent did before `task run` left no
 * trace at all, and agents improvised by hand-writing entries (§9 item 14).
 *
 * Unlike `task run`, this records an already-finished piece of work, so there is
 * no live event stream — just the index line and the readable detail.
 */
export async function runLogAdd(options: {
  cwd?: string;
  agent: string;
  summary: string;
  label?: string;
  prompt?: string;
  interpreted?: string;
  note?: string[];
  repo?: string[];
  model?: string[];
  outcome?: string;
  startedAt?: string;
  durationSec?: number;
}): Promise<LogAddResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());

  const outcome = (options.outcome ?? "success") as RunOutcome;
  if (!RUN_OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown outcome "${options.outcome}". Valid: ${RUN_OUTCOMES.join(", ")}.`);
  }

  const label = (options.label ?? "adhoc").replace(/[^A-Za-z0-9._-]/g, "-");
  const finishedAt = new Date().toISOString();
  const startedAt = options.startedAt ?? finishedAt;
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new Error(`--started must be an ISO timestamp; got "${options.startedAt}".`);
  }

  const runId = newRunId(label, new Date(startedAt));
  const durationSec =
    options.durationSec ??
    Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));

  await writeDetail(
    workspaceRoot,
    runId,
    {
      runId,
      taskId: "null",
      agent: options.agent,
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
      summary: options.summary,
      notes: options.note,
    }
  );

  await appendIndex(workspaceRoot, {
    runId,
    taskId: null,
    agent: options.agent,
    status: outcome,
    startedAt,
    finishedAt,
    durationSec,
    reposChanged: options.repo ?? [],
    detailFile: path.relative(path.join(workspaceRoot, "logs"), detailFile(workspaceRoot, runId)),
  });

  return { runId, detail: path.relative(workspaceRoot, detailFile(workspaceRoot, runId)) };
}
