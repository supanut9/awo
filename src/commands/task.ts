import { randomUUID } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import {
  branchPoint,
  cannotFail,
  capTail,
  contentTreeId,
  treeFingerprint,
  changedFiles,
  diagnose,
  EVENT_TAIL_BYTES,
  measure,
  measureBaseline,
  NO_CHANGES,
  type Measurement,
  type TestCounts,
} from "../evidence.js";
import { redactDeep, redactSecrets } from "../redact.js";
import { readManifest, type Manifest } from "../manifest.js";
import { findAllTasks, findTasksInGoal, locateTask, type TaskDefinition } from "../tasks.js";
import {
  assertTransition,
  mutateState,
  newTaskState,
  readState,
  reconcileGoalState,
  RUN_OUTCOMES,
  TASK_STATUSES,
  type Actor,
  type GoalState,
  type RunOutcome,
  type TaskStatus,
} from "../state.js";
import { fallbackHint, invocationHint, resolveModel, type ResolvedModel } from "../models.js";
import { ensureTaskWorktrees, type Worktree } from "../worktrees.js";
import {
  appendEvent,
  appendIndex,
  detailFile,
  dayDataFile,
  allocateRunId,
  readEvents,
  writeDetail,
  AWO_EVENT_KINDS,
  CALLER_EVENT_KINDS,
  type EventKind,
} from "../runs.js";

export interface TaskRow {
  id: string;
  goalId: string;
  name: string;
  status: TaskStatus;
  lastRunOutcome: RunOutcome | null;
  targets: string[];
  agent: string | null;
}

/** Frontmatter is the authored starting point; state.json wins once it exists (§7.2). */
function effectiveState(state: GoalState, task: TaskDefinition) {
  return state.tasks[task.id] ?? newTaskState(task.authoredStatus);
}

interface TaskCheckout {
  repo: string;
  dir: string;
  recordedPath: string;
}

async function taskCheckouts(
  workspaceRoot: string,
  manifest: Manifest,
  task: TaskDefinition,
  worktrees: Worktree[]
): Promise<TaskCheckout[]> {
  const out: TaskCheckout[] = [];
  for (const repo of task.targets) {
    const worktree = worktrees.find((candidate) => candidate.repo === repo && !candidate.error);
    const entry = manifest.repos.find((candidate) => candidate.name === repo);
    if (!entry) continue;
    const recordedPath = worktree?.path ??
      (entry.type === "local" ? entry.path : path.join("repos", repo));
    const dir = path.isAbsolute(recordedPath)
      ? recordedPath
      : path.join(workspaceRoot, recordedPath);
    out.push({ repo, dir, recordedPath });
  }
  return out;
}

async function recordRepositoryBaselines(
  workspaceRoot: string,
  runId: string,
  checkouts: TaskCheckout[]
): Promise<void> {
  for (const checkout of checkouts) {
    const git = simpleGit(checkout.dir);
    const sha = (await git.revparse(["HEAD"]).catch(() => "")).trim();
    if (!sha) continue;
    const status = (await git.raw(["status", "--short"]).catch(() => "")).trim();
    await appendEvent(workspaceRoot, runId, "repo.baseline", {
      repo: checkout.repo,
      sha,
      checkout: checkout.recordedPath,
      dirty: status !== "",
      status,
    });
  }
}

/** Capture what Git can prove instead of relying on the worker to narrate it. */
async function captureRepositoryEvidence(workspaceRoot: string, runId: string): Promise<void> {
  const before = await readEvents(workspaceRoot, runId);
  const baselines = before.filter(
    (event) => event.kind === "repo.baseline" && typeof event.repo === "string" && typeof event.checkout === "string"
  );
  for (const baseline of baselines) {
    const repo = String(baseline.repo);
    const recordedPath = String(baseline.checkout);
    const dir = path.isAbsolute(recordedPath)
      ? recordedPath
      : path.join(workspaceRoot, recordedPath);
    const git = simpleGit(dir);
    if (!(await git.checkIsRepo().catch(() => false))) continue;

    const sha = (await git.revparse(["HEAD"]).catch(() => "")).trim();
    if (
      sha &&
      sha !== String(baseline.sha ?? "") &&
      !before.some((event) => event.kind === "commit" && event.repo === repo && event.sha === sha)
    ) {
      await appendEvent(workspaceRoot, runId, "commit", {
        repo,
        sha,
        previousSha: baseline.sha,
        auto: true,
      });
    }

    const status = (await git.raw(["status", "--short"]).catch(() => "")).trim();
    if (
      status !== String(baseline.status ?? "") &&
      !before.some((event) => event.kind === "repo.diff" && event.repo === repo)
    ) {
      const files = status.split("\n").filter(Boolean);
      await appendEvent(workspaceRoot, runId, "repo.diff", {
        repo,
        files: files.slice(0, 50),
        fileCount: files.length,
        clean: status === "",
        auto: true,
      });
    }
  }
}

export async function runTaskList(options: { cwd?: string; status?: string } = {}): Promise<TaskRow[]> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());

  if (options.status && !TASK_STATUSES.includes(options.status as TaskStatus)) {
    throw new Error(
      `Unknown status "${options.status}". Valid: ${TASK_STATUSES.join(", ")}.`
    );
  }

  const rows: TaskRow[] = [];
  for (const { task, goal } of await findAllTasks(workspaceRoot)) {
    const state = await readState(goal.dir, goal.id);
    const ts = effectiveState(state, task);
    if (options.status && ts.status !== options.status) continue;
    rows.push({
      id: task.id,
      goalId: task.goalId,
      name: task.name,
      status: ts.status,
      lastRunOutcome: ts.lastRunOutcome,
      targets: task.targets,
      agent: task.agent,
    });
  }
  return rows;
}

export interface TaskShowResult {
  task: TaskDefinition;
  status: TaskStatus;
  lastRunId: string | null;
  lastRunOutcome: RunOutcome | null;
  attempts: number;
  blockedReason: string | null;
  goalStatus: string;
}

export async function runTaskShow(
  taskId: string,
  options: { cwd?: string } = {}
): Promise<TaskShowResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const tasks = await findTasksInGoal(goal.dir);
  const state = reconcileGoalState(await readState(goal.dir, goal.id), tasks).state;
  const ts = effectiveState(state, task);
  return {
    task,
    status: ts.status,
    lastRunId: ts.lastRunId,
    lastRunOutcome: ts.lastRunOutcome,
    attempts: ts.attempts,
    blockedReason: ts.blockedReason,
    goalStatus: state.goalStatus,
  };
}

export async function runTaskStatus(
  taskId: string,
  to: string,
  options: { cwd?: string; actor?: Actor; reason?: string; goalVerdict?: boolean } = {}
): Promise<TaskStatus> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (!TASK_STATUSES.includes(to as TaskStatus)) {
    throw new Error(`Unknown status "${to}". Valid: ${TASK_STATUSES.join(", ")}.`);
  }
  const target = to as TaskStatus;
  const actor: Actor = options.actor ?? "human";

  const { task, goal } = await locateTask(workspaceRoot, taskId);
  if (target === "done" && goal.completionPolicy.qaRequired && !options.goalVerdict) {
    throw new Error(
      `${task.id} belongs to a governed goal, so one task cannot be approved independently.\n` +
        `  Attach goal-level QA with \`awo goal verify ${goal.id}\`, then record the verdict with\n` +
        `  \`awo goal verdict ${goal.id} --pass --summary "…" --who "<human>"\`.`
    );
  }
  const current = effectiveState(await readState(goal.dir, goal.id), task);
  assertTransition(task.id, current.status, target, actor);

  await mutateState(goal.dir, goal.id, (state) => {
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    assertTransition(task.id, ts.status, target, actor);
    if (ts.status !== target) delete state.qa;
    ts.status = target;
    ts.blockedReason = target === "blocked" ? (options.reason ?? ts.blockedReason) : null;
    state.tasks[task.id] = ts;
  });
  return target;
}

/**
 * The instruction a worker receives. Composed by awo rather than by whoever is
 * driving, so it is identical whether a human pastes it or `dispatch` spawns it —
 * and so it is always in the log.
 */
export function composeBrief(input: {
  taskId: string;
  agent: string | null;
  body: string;
  branch?: string;
  isolated: boolean;
  instruction?: string;
}): string {
  return [
    `You are ${input.agent ?? "software-engineer"} working task ${input.taskId}.`,
    `Follow instructions/ship-a-change.md and the workspace's rules in AGENTS.md.`,
    input.isolated
      ? `You are in an isolated git worktree on ${input.branch}. Work ONLY here — never in repos/<name> directly.`
      : `WARNING: no worktree isolation was established. Be conservative.`,
    `Record what you ran with \`awo task event ${input.taskId} test --run "<cmd>" --baseline\` —`,
    `a claim that tests passed is refused at the gate. Then commit on this branch.`,
    `Do not push and do not open a PR.`,
    input.instruction ? `\n## From the orchestrator\n${input.instruction}` : "",
    "",
    input.body,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface TaskRunResult {
  /** Exactly what the worker is told. Also recorded as the run's `brief` event. */
  brief: string;
  taskId: string;
  runId: string;
  eventsFile: string;
  targets: string[];
  agent: string | null;
  body: string;
  /** §12 — who should do this work, and how to hand it to them. */
  model: ResolvedModel;
  invocation: string;
  /** Where to go if the primary is out of quota (§12.8). */
  fallbackInvocation: string | null;
  /** §7.1 — isolation, created rather than merely required. */
  worktrees: Worktree[];
}

/**
 * §9 item 2, decided: `task run` ORCHESTRATES — it resolves dependencies,
 * validates targets, moves lifecycle state, and opens the run's event stream.
 * The agent then does the actual work and closes the run with `task complete`.
 * This command deliberately does not execute the task's steps itself.
 */
export async function runTaskRun(
  taskId: string,
  options: {
    cwd?: string;
    noWorktree?: boolean;
    instruction?: string;
    /**
     * Skip the dependsOn gate. Only `recheck` sets this: it verifies work that is
     * already committed, so refusing because a *predecessor* is unverified blocks
     * the very act of verifying anything downstream of it.
     */
    ignoreDependencies?: boolean;
  } = {}
): Promise<TaskRunResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const state = await readState(goal.dir, goal.id);
  const current = effectiveState(state, task);

  if (current.status === "running") {
    throw new Error(
      `${task.id} is already running (run ${current.lastRunId}). Close it with \`awo task complete ${task.id} --outcome <success|failed>\` first.`
    );
  }
  if (current.status === "cancelled") {
    throw new Error(`${task.id} is cancelled. Move it back to todo before running it.`);
  }
  if (current.status === "done") {
    throw new Error(`${task.id} is already done. Move it to todo if it genuinely needs redoing.`);
  }

  // §7.2 open question, decided: validate `targets` against the manifest and
  // fail fast rather than discovering a missing repo mid-run.
  const known = new Set(manifest.repos.map((r) => r.name));
  const unknown = task.targets.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `${task.id} targets repos not in the manifest: ${unknown.join(", ")}. Link them with \`awo connect\`/\`awo add\`, or fix the task's \`targets:\`.`
    );
  }

  // A governed goal verifies the feature only after every task has completed, so
  // successful `in-review` work must unblock dependent build tasks. Requiring
  // `done` here deadlocked every strict dependency chain before goal-level QA.
  const unmet: string[] = [];
  for (const depId of task.dependsOn) {
    const dep = await locateTask(workspaceRoot, depId).catch(() => null);
    if (!dep) {
      unmet.push(`${depId} (not found)`);
      continue;
    }
    const depState = effectiveState(await readState(dep.goal.dir, dep.goal.id), dep.task);
    if (depState.status !== "done" && depState.status !== "in-review") {
      unmet.push(`${depId} (${depState.status})`);
    }
  }

  if (unmet.length > 0 && !options.ignoreDependencies) {
    await mutateState(goal.dir, goal.id, (s) => {
      const ts = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
      if (ts.status === "todo") ts.status = "queued";
      assertTransition(task.id, ts.status, "blocked", "runner");
      ts.status = "blocked";
      ts.blockedReason = `unmet dependencies: ${unmet.join(", ")}`;
      s.tasks[task.id] = ts;
    });
    throw new Error(
      `${task.id} has unmet dependencies: ${unmet.join(", ")}. Marked blocked.`
    );
  }

  // Resolve the model before touching state. An unsupported effort or a malformed
  // policy is a config error; throwing after the task is already `running` left an
  // open run that `doctor` then reported as abandoned.
  const model = await resolveModel(workspaceRoot, task.agent, task.tier);

  const runId = await allocateRunId(workspaceRoot, task.id);
  const startedAt = new Date().toISOString();

  await mutateState(goal.dir, goal.id, (s) => {
    // Any new execution makes an earlier goal-level QA brief/verdict stale.
    delete s.qa;
    const ts = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
    if (ts.status === "running") throw new Error(`${task.id} is already running (run ${ts.lastRunId}).`);
    if (ts.status === "todo") {
      assertTransition(task.id, ts.status, "queued", "runner");
      ts.status = "queued";
    }
    assertTransition(task.id, ts.status, "running", "runner");
    ts.status = "running";
    ts.lastRunId = runId;
    ts.lastRunOutcome = null;
    ts.startedAt = startedAt;
    ts.finishedAt = null;
    ts.blockedReason = null;
    ts.attempts += 1;
    s.tasks[task.id] = ts;
  });

  const worktreesForRun = options.noWorktree
    ? []
    : await ensureTaskWorktrees(workspaceRoot, manifest, task.id, task.targets, [...task.dependsOn].reverse());

  const worktrees = worktreesForRun;
  // A worker sandboxed to the workspace needs to write the worktree's git
  // metadata to commit (§9 item 40) — but ONLY that. Granting the repo itself
  // hands it the real checkout, and it edits that instead of the worktree
  // (§9 item 42: the fix caused the violation it was meant to prevent).
  const usable = worktrees.filter((w) => !w.error);

  // `state.worktree` was initialised to null and never written, so 100 tasks in the
  // SHOP workspace all claimed no checkout while 14 sat on disk. Record where the
  // worker was actually put; `awo worktree` reconciles against git regardless, but
  // state should not assert something false.
  if (usable[0]) {
    const where = usable[0].path;
    await mutateState(goal.dir, goal.id, (s) => {
      const t = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
      t.worktree = where;
      s.tasks[task.id] = t;
    });
  }

  const workerContext = {
    cwd: usable[0] ? usable[0].path : undefined,
    allow: [...new Set(usable.flatMap((w) => w.writablePaths))],
  };

  for (const wt of worktrees.filter((w) => w.created)) {
    await appendEvent(workspaceRoot, runId, "step.start", {
      label: `worktree ready for ${wt.repo} at ${wt.path} on ${wt.branch}`,
      repo: wt.repo,
    });
  }

  const runCheckouts = await taskCheckouts(workspaceRoot, manifest, task, usable);
  await appendEvent(workspaceRoot, runId, "run.start", {
    taskId: task.id,
    goalId: goal.id,
    agent: task.agent,
    targets: task.targets,
    checkouts: runCheckouts.map(({ repo, recordedPath }) => ({ repo, checkout: recordedPath })),
    tier: model.tier,
    tierFrom: model.tierSource,
    model: `${model.runtime}:${model.model}`,
    ...(model.effort ? { effort: model.effort } : {}),
  });
  await recordRepositoryBaselines(
    workspaceRoot,
    runId,
    runCheckouts
  );

  // Recorded at open, not at close, and composed here rather than by the caller —
  // so the log holds what the worker was told even if the run is abandoned, and
  // whether a human pasted the invocation or `dispatch` spawned it.
  const isolated = worktrees.some((w) => !w.error);
  const brief = composeBrief({
    taskId: task.id,
    agent: task.agent,
    body: task.body,
    branch: worktrees.find((w) => !w.error)?.branch,
    isolated,
    instruction: options.instruction,
  });
  await appendEvent(workspaceRoot, runId, "brief", {
    text: brief,
    ...(options.instruction ? { instruction: options.instruction } : {}),
  });

  return {
    brief,
    model,
    worktrees,
    invocation: invocationHint(model, task.id, workerContext),
    fallbackInvocation: fallbackHint(model, task.id, workerContext),
    taskId: task.id,
    runId,
    eventsFile: path.relative(workspaceRoot, dayDataFile(workspaceRoot, runId)),
    targets: task.targets,
    agent: task.agent,
    body: task.body,
  };
}

/**
 * Fields awo writes itself — on measured events, on the run envelope, and on the
 * events it captures from Git. A caller's `--data` could set every one of them:
 * `--data '{"verified":true,"exitCode":0}'` was indistinguishable from a
 * measurement awo ran, and `{"type":"run"}` turned an event into an index row.
 */
const RESERVED_EVENT_FIELDS = new Set([
  "t", "ts", "kind", "type", "runId",
  "verified", "measured", "measurement", "exitCode", "timedOut", "durationSec",
  "passed", "failed", "counts", "tail", "artifact",
  "fingerprint", "treeFingerprint", "treeFingerprintAfter", "treeId", "treeIdAfter",
  "checkout", "headSha", "baseSha", "baseline", "baselineExitCode", "baselineFailed", "baselineError",
  "diagnosis", "needsHuman", "explanation", "auto",
]);

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** The spellings agents reached for that edit distance alone does not map. */
const KIND_SYNONYMS: Record<string, string> = {
  tests: "test", testing: "test", diff: "repo.diff", start: "step.start", step: "step.start",
  end: "step.end", done: "step.end", msg: "note", message: "note", log: "note", info: "note",
};

function assertEventKind(kind: string): void {
  if ((CALLER_EVENT_KINDS as readonly string[]).includes(kind)) return;
  if ((AWO_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`"${kind}" events are written by awo itself. Kinds you record: ${CALLER_EVENT_KINDS.join(", ")}.`);
  }
  const lower = kind.toLowerCase();
  const guess = KIND_SYNONYMS[lower] ??
    [...CALLER_EVENT_KINDS].sort((x, y) => editDistance(lower, x) - editDistance(lower, y))[0];
  const close = KIND_SYNONYMS[lower] !== undefined || editDistance(lower, guess) <= 3;
  throw new Error(
    `Unknown event kind "${kind}".${close ? ` Did you mean "${guess}"?` : ""}\n` +
      `  Kinds: ${CALLER_EVENT_KINDS.join(", ")}.`
  );
}

export interface TaskEventResult {
  taskId: string;
  kind: string;
  measured: boolean;
  diagnosis?: string;
  needsHuman?: boolean;
  explanation?: string;
  command?: string;
  repo?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  counts?: TestCounts;
  /** The last lines the command printed, when it did not pass. */
  tailLines?: string[];
}

export async function runTaskEvent(
  taskId: string,
  kind: string,
  options: {
    cwd?: string;
    label?: string;
    message?: string;
    data?: string;
    /** Commit sha, for `commit` events. */
    sha?: string;
    /** Command for awo to RUN and measure, instead of a claim about one. */
    run?: string;
    /** Also run it at the branch point, so a failure can be attributed. */
    baseline?: boolean;
    repo?: string;
    timeoutMinutes?: number;
    checkout?: string;
    base?: string;
  } = {}
): Promise<TaskEventResult> {
  assertEventKind(kind);
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const ts = effectiveState(await readState(goal.dir, goal.id), task);

  if (ts.status !== "running" || !ts.lastRunId) {
    throw new Error(
      `${task.id} has no open run — start one with \`awo task run ${task.id}\` before recording events.`
    );
  }

  const fields: Record<string, unknown> = {};
  if (options.label) fields.label = options.label;
  if (options.message) fields.msg = options.message;
  if (options.data) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.data);
    } catch {
      throw new Error(`--data must be valid JSON; got: ${options.data}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--data must be a JSON object, e.g. '{"repo":"api","files":3}'; got: ${options.data}`);
    }
    const reserved = Object.keys(parsed).filter((key) => RESERVED_EVENT_FIELDS.has(key));
    if (reserved.length > 0) {
      throw new Error(
        `--data may not set ${reserved.map((key) => `"${key}"`).join(", ")}: awo writes ${reserved.length === 1 ? "it" : "them"} ` +
          `itself, only for what it measured.\n` +
          `  To record a measured test:  awo task event ${task.id} test --run "<the command>"`
      );
    }
    Object.assign(fields, parsed);
  }
  if (options.sha) fields.sha = options.sha;

  // A test event is a measurement or nothing. "test --label 'suite green'" was the
  // claim that let half the per-criterion evidence be prose; with no --run, awo
  // runs the command the repo declared instead of recording the sentence.
  const manifest = await readManifest(workspaceRoot);
  const requestedRepo = options.repo ?? (typeof fields.repo === "string" ? fields.repo : undefined);
  let command = options.run;
  if (!command && kind === "test") {
    const target = requestedRepo ?? task.targets[0];
    if (!target) {
      throw new Error(
        `${task.id} has no targets, so there is no declared test command to run.\n` +
          `  Pass one:  awo task event ${task.id} test --repo <name> --run "<the command>"`
      );
    }
    command = manifest.repos.find((r) => r.name === target)?.testCommand;
    if (!command) {
      throw new Error(
        `No test command is declared for ${target}, and a test event is a measurement awo runs, not a claim.\n` +
          `  Declare it once:  awo test-command ${target} "<cmd>"\n` +
          `  Or pass one now:  awo task event ${task.id} test --run "<cmd>"`
      );
    }
  }
  if (!command) {
    await appendEvent(workspaceRoot, ts.lastRunId, kind as EventKind, fields);
    return { taskId: task.id, kind, measured: false };
  }
  if (cannotFail(command)) {
    throw new Error(
      `Refusing to measure "${command}": it ends in a clause that turns any failure into exit 0, ` +
        `so it would record a pass whatever the suite did.\n` +
        `  Drop the trailing \`|| true\` / \`; true\` / \`|| :\` and rerun.`
    );
  }

  // --run makes this event a measurement: awo executes the command in the task's
  // worktree and records what actually happened. A `test` event carrying `verified`
  // is the only thing `task complete --gate` will accept.
  const repoName = requestedRepo ?? task.targets[0];
  if (!repoName) {
    throw new Error(
      `${task.id} has no targets, so there is no repo to run "${command}" in. Pass --repo <name>.`
    );
  }
  if (!task.targets.includes(repoName)) throw new Error(`${task.id} does not target ${repoName}.`);
  const entry = manifest.repos.find((r) => r.name === repoName);
  if (!entry) throw new Error(`Unknown repo ${repoName}.`);
  const events = await readEvents(workspaceRoot, ts.lastRunId);
  const recorded = events.find((event) => event.kind === "repo.baseline" && event.repo === repoName);
  const start = events.find((event) => event.kind === "run.start");
  const startedCheckout = Array.isArray(start?.checkouts)
    ? start.checkouts.find((item: { repo: string; checkout: string }) => item.repo === repoName)?.checkout
    : undefined;
  const conventional = path.join(workspaceRoot, "repos", ".worktrees", repoName, task.id);
  const checkout = options.checkout ?? (typeof recorded?.checkout === "string" ? recorded.checkout : undefined)
    ?? (typeof startedCheckout === "string" ? startedCheckout : undefined)
    ?? (task.targets[0] === repoName ? ts.worktree : null)
    ?? (await fs.pathExists(conventional) ? conventional : null);
  if (!checkout) {
    throw new Error(`No recorded checkout for ${task.id}/${repoName}. Pass --checkout <path>; refusing to guess the shared checkout.`);
  }
  const repoDir = path.resolve(workspaceRoot, checkout);
  if (!(await fs.pathExists(repoDir))) throw new Error(`Recorded checkout is missing: ${repoDir}. Restore it or pass --checkout <path>.`);
  const git = simpleGit(repoDir);
  const isGit = await git.checkIsRepo();
  const headSha = isGit ? (await git.revparse(["HEAD"])).trim() : null;
  const baseRef = options.base ?? (typeof recorded?.sha === "string" && recorded.sha ? recorded.sha : undefined)
    ?? (entry.type === "git" ? entry.ref : undefined);
  if (isGit && !baseRef) throw new Error(`No pinned base for ${task.id}/${repoName}; pass --base <ref>.`);
  const resolvedBase = isGit ? (await git.revparse([`${baseRef}^{commit}`])).trim() : null;
  const baseSha = isGit ? await branchPoint(repoDir, resolvedBase!) : null;
  if (isGit && !baseSha) throw new Error(`No merge-base between HEAD and ${baseRef}.`);
  const beforeTree = isGit ? await treeFingerprint(repoDir) : null;
  const beforeContent = isGit ? await contentTreeId(repoDir) : null;
  const measured = await measure(command, repoDir, options.timeoutMinutes);
  const afterTree = isGit ? await treeFingerprint(repoDir) : null;
  const afterContent = isGit ? await contentTreeId(repoDir) : null;
  const changed = isGit ? await changedFiles(repoDir, baseSha!) : NO_CHANGES;

  let base: Measurement | null = null;
  let baselineError: string | undefined;
  if (options.baseline) {
    const point = isGit ? await branchPoint(repoDir, baseSha!) : null;
    if (!point) {
      baselineError = `no merge-base between HEAD and ${baseRef}`;
    } else {
      const scratch = path.join(workspaceRoot, "repos", ".worktrees", ".baseline", repoName);
      const attempt = await measureBaseline(
        repoDir,
        point,
        command,
        scratch,
        options.timeoutMinutes
      );
      base = attempt.measurement;
      baselineError = attempt.error;
    }
  }

  const verdict = beforeContent !== afterContent
    ? { diagnosis: "unknown", needsHuman: true, explanation: "The tested tree changed while the command ran; rerun against a stable tree." }
    : diagnose(measured, base, changed, { qaRequired: goal.completionPolicy.qaRequired });
  const artifact = path.join("logs", ts.lastRunId.slice(0, 10), "measurements", `${randomUUID()}.json`);
  await fs.outputJson(
    path.join(workspaceRoot, artifact),
    redactDeep({ candidate: measured, baseline: base, baselineError }),
    { spaces: 2 }
  );

  await appendEvent(workspaceRoot, ts.lastRunId, kind as EventKind, {
    ...fields,
    repo: repoName,
    verified: true,
    checkout: repoDir,
    headSha,
    baseSha,
    // The content tree is what a receipt is checked against; the HEAD-bound
    // fingerprint stays for readers of earlier receipts.
    treeId: beforeContent,
    treeIdAfter: afterContent,
    treeFingerprint: beforeTree,
    treeFingerprintAfter: afterTree,
    artifact,
    command: measured.command,
    exitCode: measured.exitCode,
    durationSec: measured.durationSec,
    ...(measured.passed !== undefined ? { passed: measured.passed } : {}),
    ...(measured.failed !== undefined ? { failed: measured.failed } : {}),
    counts: measured.counts,
    ...(measured.timedOut ? { timedOut: true } : {}),
    ...(base ? { baselineExitCode: base.exitCode, baselineFailed: base.failed } : {}),
    ...(baselineError ? { baselineError } : {}),
    diagnosis: verdict.diagnosis,
    needsHuman: verdict.needsHuman,
    explanation: verdict.explanation,
    // The full tail lives in the artifact; the day file is read whole by every
    // `log` and `context` call, so the event carries only enough to see why.
    ...(measured.exitCode === 0 ? {} : { tail: capTail(measured.tail, EVENT_TAIL_BYTES) }),
  });

  return {
    taskId: task.id,
    kind,
    measured: true,
    diagnosis: verdict.diagnosis,
    needsHuman: verdict.needsHuman,
    explanation: verdict.explanation,
    command: measured.command,
    repo: repoName,
    exitCode: measured.exitCode,
    timedOut: measured.timedOut,
    counts: measured.counts,
    ...(measured.exitCode === 0 || measured.tail.trim() === ""
      ? {}
      : { tailLines: redactSecrets(measured.tail).replace(/\s+$/, "").split("\n").slice(-20) }),
  };
}

/**
 * A passing receipt counts only for the content it tested.
 *
 * Receipts written since 0.8.0 carry `treeId`, the git tree of the tested
 * content, so committing exactly what was tested keeps the receipt valid. Older
 * receipts carry only the HEAD-bound `treeFingerprint` and keep that comparison.
 */
async function assertFreshReceipt(
  taskId: string,
  event: Record<string, unknown>,
  current: Map<string, string>
): Promise<void> {
  const byContent = typeof event.treeId === "string";
  if (!byContent && typeof event.treeFingerprint !== "string") return; // Legacy/non-Git receipt.
  const tested = byContent ? event.treeId : event.treeFingerprint;
  const after = byContent ? event.treeIdAfter : event.treeFingerprintAfter;
  if (after !== tested) {
    throw new Error(`${taskId}: the tested tree changed during ${event.command}; rerun against a stable tree.`);
  }
  if (typeof event.checkout !== "string") {
    throw new Error(`${taskId}: the test receipt has no checkout; rerun the measurement.`);
  }
  const key = `${byContent ? "tree" : "fingerprint"}:${event.checkout}`;
  if (!current.has(key)) {
    const checkout = event.checkout;
    const now = await (byContent ? contentTreeId(checkout) : treeFingerprint(checkout)).catch((error: Error) => {
      throw new Error(`${taskId}: cannot read the tested checkout ${checkout} (${error.message}). Restore it, or rerun the check.`);
    });
    current.set(key, now);
  }
  if (current.get(key) !== tested) {
    throw new Error(`${taskId}: stale test receipt for ${event.command}; the checkout tree changed after testing. Rerun the check.`);
  }
}

export interface TaskCompleteResult {
  taskId: string;
  runId: string;
  outcome: RunOutcome;
  status: TaskStatus;
  detail: string;
}

/**
 * Closes an open run: final event, run detail (§7.3), index line, and the
 * lifecycle transition. `--gate`, or a goal policy requiring QA, routes a success
 * to `in-review` instead of `done`.
 */
export async function runTaskComplete(
  taskId: string,
  options: {
    cwd?: string;
    /** Defaults to `success`. */
    outcome?: string;
    summary?: string;
    prompt?: string;
    interpreted?: string;
    note?: string[];
    gate?: boolean;
    /** Close as success without test evidence — requires stating why. */
    untested?: string;
    /** Implementation intentionally produced no repository change. */
    noChange?: string;
    /** The model that actually did the work, when it was not the one resolved at run open. */
    model?: string;
  }
): Promise<TaskCompleteResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const requested = options.outcome ?? "success";
  if (!RUN_OUTCOMES.includes(requested as RunOutcome)) {
    // Anything that is not one of the three is almost always the summary typed
    // into the wrong flag, so name the flag that was probably meant.
    throw new Error(
      `Unknown outcome "${requested}". Valid: ${RUN_OUTCOMES.join(", ")} (default: success).\n` +
        `  Did you mean --summary "${requested}"?`
    );
  }
  const outcome = requested as RunOutcome;

  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const ts = effectiveState(await readState(goal.dir, goal.id), task);
  if (ts.status !== "running" || !ts.lastRunId) {
    throw new Error(`${task.id} has no open run to complete (status: ${ts.status}).`);
  }
  const runId = ts.lastRunId;
  await captureRepositoryEvidence(workspaceRoot, runId);
  const priorEvents = await readEvents(workspaceRoot, runId);
  // Where a success lands. Inconclusive evidence may close into review, so the
  // needs-human refusal must follow the destination, not only the --gate flag:
  // a goal that requires QA routes every success to review regardless.
  const toReview = options.gate === true || goal.completionPolicy.qaRequired;
  let untestedRepos: string[] = [];

  // §7.1 `tests-must-pass` was unenforceable: a task could close as `success` with
  // no evidence of anything having run, and six such tasks composed into a broken
  // feature (§9 item 47). A successful run must therefore carry a `test` event, or
  // say out loud why it cannot.
  //
  // `--untested` excuses only the ABSENCE of a measurement. It used to skip this
  // whole block, so a run with a red measured suite closed as success by adding
  // one flag — and `dispatch` added that flag to every success it closed.
  const requiresMeasuredCheck =
    !task.kindExplicit || task.kind === "implementation" || task.kind === "verification";
  if (outcome === "success" && requiresMeasuredCheck) {
    // A command's latest measurement supersedes its earlier attempts. A pass
    // from a different command must never hide a failed check in the same run.
    const latest = new Map<string, (typeof priorEvents)[number]>();
    for (const event of priorEvents) {
      if (event.kind === "test" && event.verified === true) {
        latest.set(JSON.stringify([event.repo ?? null, event.command ?? null]), event);
      }
    }
    const measurements = [...latest.values()];
    // A command that could not run at all is not a result about the code, either way.
    const notRunnable = measurements.filter((event) => event.diagnosis === "not-runnable");
    const results = measurements.filter((event) => event.diagnosis !== "not-runnable");
    const failing = results.filter((event) => event.exitCode !== 0 || event.timedOut === true);
    if (failing.length > 0) {
      throw new Error(
        `${task.id} cannot close as success with failing measured checks.\n` +
          failing.map((event) => `  ${event.repo ?? "repo"}: ${event.command ?? "test"} (exit ${event.exitCode})`).join("\n") +
          `\n  Fix and rerun each failing command; routing to review does not make a failure pass,` +
          ` and --untested excuses a missing check, not a failing one.`
      );
    }
    const measuredPasses = results.filter((event) => event.exitCode === 0);

    // Receipts identify the content actually tested, not whatever happens to be in
    // the checkout at completion. Review cannot repair missing test coverage.
    const currentTrees = new Map<string, string>();
    for (const event of measuredPasses) await assertFreshReceipt(task.id, event, currentTrees);

    // A measurement can pass and still be inconclusive — an existing test whose
    // assertions were rewritten, or new tests asserting a contract nobody has
    // checked against the acceptance criteria. Those may close, but only into review.
    const inconclusive = measuredPasses.filter((e) => e.needsHuman === true);
    if (inconclusive.length > 0 && !toReview) {
      throw new Error(
        `${task.id} has evidence that needs a human, so it cannot go straight to done.\n` +
          inconclusive.map((e) => `  ${e.diagnosis}: ${e.explanation}`).join("\n") +
          `\n  Close it into review instead:\n` +
          `    awo task complete ${task.id} --gate --summary "…"`
      );
    }

    const manifest = await readManifest(workspaceRoot);
    const testHint = (repo: string | undefined): string =>
      repo && manifest.repos.find((r) => r.name === repo)?.testCommand
        ? `awo task event ${task.id} test --repo ${repo}`
        : `awo task event ${task.id} test${repo ? ` --repo ${repo}` : ""} --run "<the command>"`;

    if (measuredPasses.length === 0 && !options.untested) {
      const claims = priorEvents.filter((e) => e.kind === "test" && e.verified !== true);
      if (claims.length > 0) {
        throw new Error(
          `${task.id} cannot close as success on a test event awo did not run.\n` +
            `  ${claims.length} test event(s) recorded, none measured.\n` +
            `  Re-record it as a measurement:\n` +
            `    awo task event ${task.id} test --run "<the command>" --baseline\n` +
            `  (rule: tests-must-pass — a claim is not evidence. Published analysis of\n` +
            `   agent-authored tests found ~80% carry weak or no assertions, so "tests\n` +
            `   passed" as a string is the weakest signal in the workflow.)`
        );
      }
      if (notRunnable.length > 0) {
        throw new Error(
          `${task.id} cannot close as success: the only measured check could not run, which is not evidence.\n` +
            notRunnable.map((event) => `  ${event.repo ?? "repo"}: ${event.command ?? "test"} (exit ${event.exitCode} at HEAD and at the branch point)`).join("\n") +
            `\n  Fix the command and rerun it:  ${testHint(task.targets[0])}\n` +
            `  If tests genuinely cannot run here, say so:  --untested "<why>"`
        );
      }
      throw new Error(
        `${task.id} cannot close as success with no test evidence (rule: tests-must-pass).\n` +
          `Measure what verifies it:  ${testHint(task.targets[0])}\n` +
          `If tests genuinely could not run, say so:  --untested "<why>"`
      );
    }

    // One target's green suite says nothing about another target's change. Every
    // repo the run committed to or changed needs its own passing measurement.
    const changedRepos = [
      ...new Set(
        priorEvents
          .filter((e) => (e.kind === "commit" || e.kind === "repo.diff") && typeof e.repo === "string")
          .map((e) => e.repo as string)
          .filter((repo) => task.targets.includes(repo))
      ),
    ];
    const covered = new Set(measuredPasses.map((e) => e.repo));
    untestedRepos = changedRepos.filter((repo) => !covered.has(repo));
    if (untestedRepos.length > 0 && !options.untested) {
      throw new Error(
        `${task.id} changed ${untestedRepos.join(", ")} but has no passing measured test there.\n` +
          untestedRepos.map((repo) => `  ${testHint(repo)}`).join("\n") +
          `\n  If that repo genuinely cannot be tested, say so:  --untested "<why>"`
      );
    }
  }

  if (outcome === "success" && task.kindExplicit) {
    if (
      (task.kind === "investigation" || task.kind === "decision" || task.kind === "deployment-data") &&
      !options.summary?.trim()
    ) {
      throw new Error(
        `${task.id} is ${task.kind} work, so success requires --summary with the finding, decision, or measured result.`
      );
    }

    if (task.kind === "implementation") {
      const hasGitBaseline = priorEvents.some((event) => event.kind === "repo.baseline");
      const hasChange = priorEvents.some(
        (event) => event.kind === "commit" || event.kind === "repo.diff"
      );
      if (hasGitBaseline && !hasChange && !options.noChange?.trim()) {
        throw new Error(
          `${task.id} is implementation work but Git shows no commit or diff.\n` +
            `  Make the change, or state why no repository change is correct:\n` +
            `    awo task complete ${task.id} --outcome success --unchanged "<reason>" ...`
        );
      }
    }
  }

  if (options.noChange?.trim()) {
    await appendEvent(workspaceRoot, runId, "note", {
      category: "no-change",
      label: options.noChange.trim(),
    });
  }

  // What actually ran, when it was not what run.start resolved: 142 of 145 CRM runs
  // were recorded as `claude:haiku` while the work was done by Opus or Codex.
  const actualModel = options.model?.trim() || undefined;
  const untested = outcome === "success" ? options.untested?.trim() || undefined : undefined;
  await appendEvent(workspaceRoot, runId, "run.end", {
    outcome,
    ...(actualModel ? { actualModel } : {}),
    ...(untested ? { untested, ...(untestedRepos.length > 0 ? { untestedRepos } : {}) } : {}),
  });

  const finishedAt = new Date().toISOString();
  const durationSec = ts.startedAt
    ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(ts.startedAt)) / 1000))
    : null;

  const events = await readEvents(workspaceRoot, runId);
  const briefEvent = events.find((e) => e.kind === "brief");
  const briefText = typeof briefEvent?.text === "string" ? briefEvent.text : undefined;

  // Any event may name a repo — repo.diff, test, commit. Deriving only from
  // repo.diff reported `reposChanged: []` for a run that changed 8 files and
  // committed, because the worker emitted `test` and `commit` instead (§9 item 32).
  let reposChanged = [
    ...new Set(
      events.filter((e) => typeof e.repo === "string").map((e) => e.repo as string)
    ),
  ];
  // A commit is proof the targets were touched, even if no event named a repo.
  if (reposChanged.length === 0 && events.some((e) => e.kind === "commit")) {
    reposChanged = [...task.targets];
  }

  const nextStatus: TaskStatus = outcome === "success" ? (toReview ? "in-review" : "done") : "blocked";
  const start = events.find((e) => e.kind === "run.start");

  await writeDetail(
    workspaceRoot,
    runId,
    {
      runId,
      taskId: task.id,
      goalId: goal.id,
      agent: task.agent ?? "null",
      status: outcome,
      startedAt: ts.startedAt ?? finishedAt,
      finishedAt,
      durationSec: durationSec ?? "null",
      reposChanged,
      ...(typeof start?.model === "string" ? { model: start.model } : {}),
      ...(actualModel ? { actualModel } : {}),
    },
    {
      // Falls back to the brief, so "what was this worker asked to do" is answerable
      // for every run rather than only the ones where someone remembered --prompt.
      prompt: options.prompt ?? briefText,
      interpreted: options.interpreted,
      summary: options.summary,
      // An excused-untested run must say so in its own record, or the exemption
      // is invisible to anyone reading the log later.
      notes: [
        ...(options.note ?? []),
        ...(options.untested
          ? [`UNTESTED: ${options.untested}${untestedRepos.length > 0 ? ` (no passing measurement in: ${untestedRepos.join(", ")})` : ""}`]
          : []),
      ],
    }
  );

  // Carry what was resolved at run.start into the index, so a query can group
  // outcomes by tier/model/effort without re-reading every event stream.
  await appendIndex(workspaceRoot, {
    runId,
    taskId: task.id,
    agent: task.agent,
    ...(typeof start?.tier === "string" ? { tier: start.tier } : {}),
    ...(typeof start?.model === "string" ? { model: start.model } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(typeof start?.effort === "string" ? { effort: start.effort } : {}),
    attempts: ts.attempts,
    status: outcome,
    startedAt: ts.startedAt ?? finishedAt,
    finishedAt,
    durationSec,
    reposChanged,
    detailFile: path.relative(path.join(workspaceRoot, "logs"), detailFile(workspaceRoot, runId)),
  });

  await mutateState(goal.dir, goal.id, (s) => {
    const t = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
    assertTransition(task.id, t.status, nextStatus, "runner");
    t.status = nextStatus;
    t.lastRunOutcome = outcome;
    t.finishedAt = finishedAt;
    t.blockedReason =
      nextStatus === "blocked" ? (options.summary ?? `run ${runId} ${outcome}`) : null;
    s.tasks[task.id] = t;
  });

  return {
    taskId: task.id,
    runId,
    outcome,
    status: nextStatus,
    detail: path.relative(workspaceRoot, detailFile(workspaceRoot, runId)),
  };
}

/** Convenience for the QA gate (§7.1): approve or reject an in-review task. */
export async function runTaskVerify(
  taskId: string,
  options: { cwd?: string; approve: boolean; reason?: string; goalVerdict?: boolean } = { approve: true }
): Promise<TaskStatus> {
  return runTaskStatus(taskId, options.approve ? "done" : "todo", {
    cwd: options.cwd,
    actor: "qa",
    reason: options.reason,
    goalVerdict: options.goalVerdict,
  });
}

/**
 * §16.6 — attach real evidence to work that was closed without any.
 *
 * `awo doctor` reported "done with no test evidence" and told you to run
 * `awo task event <id> test`, which fails: a closed task has no open run. A
 * diagnostic whose suggested fix errors out is worse than no suggestion, because it
 * costs the reader the time to discover that.
 *
 * The evidence cannot be retro-fitted into the original run — the log is append-only
 * and rewriting it would make the audit trail a story rather than a record. So this
 * opens a NEW run against the same task, measures for real, and closes it. The
 * history then says what actually happened: closed once without evidence, verified
 * later, and by whom.
 */
export interface RecheckResult {
  taskId: string;
  runId: string;
  previousStatus: TaskStatus;
  status: TaskStatus;
  diagnosis: string;
  passed: boolean;
  /** The command could not verify the task, so nothing was learned. */
  inconclusive: boolean;
}

export async function runTaskRecheck(
  taskId: string,
  options: { cwd?: string; run?: string; baseline?: boolean; repo?: string; timeoutMinutes?: number; base?: string; checkout?: string } = {}
): Promise<RecheckResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const before = effectiveState(await readState(goal.dir, goal.id), task);

  if (!["done", "in-review"].includes(before.status)) {
    throw new Error(
      `${task.id} is ${before.status}, so there is nothing to re-check — just run it:\n` +
        `  awo task run ${task.id}`
    );
  }

  const manifest = await readManifest(workspaceRoot);
  const repoName = options.repo ?? task.targets[0];
  const command =
    options.run ?? manifest.repos.find((r) => r.name === repoName)?.testCommand ?? null;
  if (!command) {
    throw new Error(
      `No command to verify ${task.id} with.\n` +
        `  Pass one:            awo task recheck ${task.id} --run "npm test"\n` +
        `  Or declare it once:  set "testCommand" on ${repoName ?? "the repo"} in .workspace/manifest.json`
    );
  }

  // A recheck tests newer work against the original comparison baseline, not
  // against the current HEAD that the new run is about to record.
  const prior = before.lastRunId ? await readEvents(workspaceRoot, before.lastRunId) : [];
  const priorTest = prior.filter((event) => event.kind === "test" && event.repo === repoName).at(-1);
  const priorBaseline = prior.find((event) => event.kind === "repo.baseline" && event.repo === repoName);
  const previousBase = priorTest?.baseSha ?? priorBaseline?.sha;

  // Human-initiated correction, so the transition is attributed to a human.
  await runTaskStatus(task.id, before.status === "done" ? "todo" : "todo", {
    cwd: workspaceRoot,
    actor: "human",
    reason: "re-opened to attach missing test evidence",
  });

  await runTaskRun(task.id, {
    cwd: workspaceRoot,
    // The work already exists and is committed; the point is to measure it. Refusing
    // because a predecessor is itself unverified would make an unverified chain
    // permanently unverifiable, which is the opposite of the intent.
    ignoreDependencies: true,
  });
  const measured = await runTaskEvent(task.id, "test", {
    cwd: workspaceRoot,
    run: command,
    baseline: options.baseline,
    repo: options.repo,
    timeoutMinutes: options.timeoutMinutes,
    base: options.base ?? (typeof previousBase === "string" && previousBase ? previousBase : undefined),
    checkout: options.checkout,
    label: `retrospective verification of work closed before the evidence gate`,
  });

  const events = await readEvents(workspaceRoot, (await readState(goal.dir, goal.id)).tasks[task.id]!.lastRunId!);
  const test = events.filter((e) => e.kind === "test").at(-1);
  const passed = test?.exitCode === 0;
  const diagnosis = measured.diagnosis ?? "unknown";

  // The outcome follows the DIAGNOSIS, not the exit code.
  //
  // Treating any non-zero exit as "the original close was wrong" blamed a task for a
  // suite that was already red at its branch point — which the diagnosis had already
  // said was not its defect. A `pre-existing` failure means one thing only: this
  // command cannot verify this task. That is a `skipped` run, and the task keeps the
  // status it had, because nothing was learned about it either way.
  // `not-runnable` is the same kind of non-answer: the command never reached a test.
  const inconclusive = diagnosis === "pre-existing" || diagnosis === "not-runnable";
  const outcome: RunOutcome = passed ? "success" : inconclusive ? "skipped" : "failed";

  await runTaskComplete(task.id, {
    cwd: workspaceRoot,
    outcome,
    // A pass that still needs a human goes to review, not straight back to done.
    gate: passed && measured.needsHuman === true,
    // `skipped` closes the run without evidence, which is honest and needs saying.
    untested:
      outcome === "skipped"
        ? diagnosis === "not-runnable"
          ? `"${command}" could not run at HEAD or at the branch point, so it cannot verify this task`
          : `"${command}" was already failing at the branch point, so it cannot verify this task`
        : undefined,
    // Recheck is verification of already-existing implementation, so the lack of
    // a new diff is expected and must be recorded rather than treated as missing work.
    noChange: passed ? "retrospective verification only; implementation already existed" : undefined,
    summary: passed
      ? `Re-checked with \`${command}\`: ${diagnosis}. Original run closed with no evidence.`
      : diagnosis === "not-runnable"
        ? `Re-checked with \`${command}\`, which could not run at HEAD or at the branch point. ` +
          `Nothing was learned about this task; fix the command and re-check.`
      : diagnosis === "pre-existing"
        ? `Re-checked with \`${command}\`, which fails at the branch point too. Not this task's ` +
          `defect — and not verification either. A command that is already red proves nothing ` +
          `about this change; the task needs a check that passes on the base first.`
        : `Re-checked with \`${command}\`: ${diagnosis}. It does not pass, so the original close was wrong.`,
    note: [`re-opened from ${before.status} to attach evidence the original run never had`],
  });

  // Deliberately NOT restored to `done`.
  //
  // A skipped run leaves the task blocked, and blocked is the truthful state: the
  // task cannot be verified until the base suite is green, and it was only `done`
  // because it closed before there was a gate. Putting it back would also require
  // an illegal transition (blocked -> done), which is the state machine correctly
  // refusing to let a tool launder a status.

  const after = effectiveState(await readState(goal.dir, goal.id), task);
  return {
    taskId: task.id,
    runId: after.lastRunId ?? "(none)",
    previousStatus: before.status,
    status: after.status,
    diagnosis,
    passed,
    inconclusive: outcome === "skipped",
  };
}
