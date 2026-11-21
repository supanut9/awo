import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import {
  branchPoint,
  treeFingerprint,
  changedFiles,
  diagnose,
  measure,
  measureBaseline,
  type Measurement,
} from "../evidence.js";
import { readManifest, type Manifest } from "../manifest.js";
import { findAllTasks, findTasksInGoal, locateTask, type TaskDefinition } from "../tasks.js";
import {
  applyTransition,
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
  type RunOwner,
  type TaskState,
  type TaskStatus,
} from "../state.js";
import {
  fallbackHint,
  invocationHint,
  resolveModel,
  type ModelChoice,
  type ResolvedModel,
} from "../models.js";
import { ensureTaskWorktrees, type Worktree } from "../worktrees.js";
import {
  appendEvent,
  appendIndex,
  detailFile,
  dayDataFile,
  allocateRunId,
  readEvents,
  writeDetail,
  type EventKind,
  type RunEvent,
} from "../runs.js";
import { actorLabel, detectAgentEnvironment } from "../agent-env.js";
import {
  assertGoalWritable,
  describeUnmet,
  unmetDependencies,
  unmetDependencyHints,
  unwrittenTemplateLines,
} from "../lifecycle.js";

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
  const reason = options.reason?.trim() || null;

  const { task, goal } = await locateTask(workspaceRoot, taskId);
  assertGoalWritable(goal, task.id);
  if (target === "done" && goal.completionPolicy.qaRequired && !options.goalVerdict) {
    throw new Error(
      `${task.id} belongs to a governed goal, so one task cannot be approved independently.\n` +
        `  Attach goal-level QA with \`awo goal verify ${goal.id}\`, then record the verdict with\n` +
        `  \`awo goal verdict ${goal.id} --pass --summary "…" --who "<human>"\`.`
    );
  }
  // A parked task with no reason is indistinguishable from a forgotten one.
  if (target === "blocked" && !reason) {
    throw new Error(
      `Blocking ${task.id} needs a reason the next reader can act on:\n` +
        `  awo task status ${task.id} blocked --reason "<what it is waiting for>"`
    );
  }
  const current = effectiveState(await readState(goal.dir, goal.id), task);
  if (current.status === "running" && target !== "running" && target !== "cancelled") {
    // `running` is left by closing the run, which also records its outcome. The
    // state machine's generic hint ("may move to: cancelled") read as the only exit.
    throw new Error(
      `${task.id} has an open run (${current.lastRunId}); close it rather than moving it by hand:\n` +
        `  awo task complete ${task.id} --outcome failed --summary "<why it is abandoned>"\n` +
        `  (or continue it with \`awo task resume ${task.id}\`)`
    );
  }
  assertTransition(task.id, current.status, target, actor);

  let openRun: string | null = null;
  await mutateState(goal.dir, goal.id, (state) => {
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    if (ts.status !== target) delete state.qa;
    if (ts.status === "running" && target === "cancelled") openRun = ts.lastRunId;
    applyTransition(state, task.id, target, actor, {
      authoredStatus: task.authoredStatus,
      reason,
    });
  });
  // Cancelling a running task abandons its run; say so in that run's own stream,
  // or the log shows a run that simply stops.
  if (openRun) {
    await appendEvent(workspaceRoot, openRun, "note", {
      category: "cancelled",
      label: reason ?? "task cancelled while this run was open",
      by: actorLabel(),
    });
  }
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
  /** Where the worker works, per target, as recorded on `run.start`. */
  checkouts: RunCheckout[];
  /** `runtime:model` that will actually execute, when `--model/--runtime` said so. */
  executedModel: string | null;
  /** The task was already running: this is the open run, unchanged. */
  alreadyRunning: boolean;
  /** The run holding the brief text, when this run's brief is identical and was recorded as a pointer. */
  briefFrom: string | null;
  /** Why a reviewed task was reopened (`--reopen --reason`). */
  reopenReason: string | null;
  /** The reason given when review last sent this task back. */
  rejectedBecause: string | null;
}

export interface RunCheckout {
  repo: string;
  /** As recorded on `run.start`: workspace-relative where possible. */
  path: string;
  branch: string | null;
  exists: boolean;
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
    /** Open a repair round on an in-review task; requires `reason`. */
    reopen?: boolean;
    reason?: string;
    /** Run a body that is still the `task new` template, as-is. */
    allowEmptyBody?: boolean;
    /** What will actually execute, when it is not what model policy resolved. */
    model?: string;
    runtime?: string;
    /**
     * Return the open run instead of refusing when the task is already running.
     * The CLI sets it — re-typing `task run` is how a worker re-reads its brief.
     * `dispatch` does not, so it can never spawn a second worker into a live run.
     */
    reuseOpenRun?: boolean;
  } = {}
): Promise<TaskRunResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  assertGoalWritable(goal, task.id);
  const state = await readState(goal.dir, goal.id);
  const current = effectiveState(state, task);
  const reason = options.reason?.trim() || null;

  if (current.status === "running") {
    if (options.reuseOpenRun && current.lastRunId) {
      return describeOpenRun(workspaceRoot, task, current);
    }
    throw new Error(
      `${task.id} is already running (run ${current.lastRunId}).\n` +
        `  Continue it:  awo task resume ${task.id}\n` +
        `  Abandon it:   awo task complete ${task.id} --outcome failed --summary "…"`
    );
  }
  if (current.status === "cancelled") {
    throw new Error(`${task.id} is cancelled. Restore it first: awo task status ${task.id} todo`);
  }
  if (current.status === "done") {
    throw new Error(
      `${task.id} is already done. If it genuinely needs redoing: awo task status ${task.id} todo`
    );
  }
  if (current.status === "in-review" && !options.reopen) {
    const decide = goal.completionPolicy.qaRequired
      ? [`  goal QA:  awo goal verify ${goal.id}  (${goal.id} is governed: approval is goal-level)`]
      : [
          `  approve:  awo task verify ${task.id}`,
          `  reject:   awo task verify ${task.id} --reject --reason "…"`,
        ];
    throw new Error(
      `${task.id} is in review (run ${current.lastRunId}). Decide it, or open a repair round:\n` +
        [...decide, `  repair:   awo task run ${task.id} --reopen --reason "<what to fix>"`].join("\n")
    );
  }
  if (options.reopen && !reason) {
    throw new Error(
      `--reopen records a repair round, so say what it repairs:\n` +
        `  awo task run ${task.id} --reopen --reason "<what to fix>"`
    );
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

  // A brief wraps the task body, so an unwritten body briefs the worker with the
  // title alone — 22% of atlas-shop's first briefs were the bare template and the
  // worker invented the task. `recheck` (the only caller that skips dependencies)
  // measures committed work and briefs nobody, so it is exempt.
  if (!options.instruction?.trim() && !options.allowEmptyBody && !options.ignoreDependencies) {
    const unwritten = unwrittenTemplateLines(task.body);
    if (unwritten.length > 0) {
      const what = unwritten[0] === ""
        ? "empty"
        : `still the \`awo task new\` template (${unwritten.join("  ")})`;
      throw new Error(
        `${task.id}'s body is ${what}, so a worker would be briefed with nothing but its title.\n` +
          `  Write it: edit ${path.relative(workspaceRoot, task.file)}, or author tasks with \`awo task new --body-file <file>\`.\n` +
          `  Or brief this run yourself: awo task run ${task.id} --instruction "<what to do>"\n` +
          `  (--allow-empty-body runs it as it is.)`
      );
    }
  }

  // A governed goal verifies the feature only after every task has completed, so
  // successful `in-review` work must unblock dependent build tasks. Requiring
  // `done` here deadlocked every strict dependency chain before goal-level QA.
  //
  // The gate refuses WITHOUT writing state. It used to mark the task `blocked`, and
  // `blocked` then refused the `task run` that would have started it once the
  // dependency landed — a dead end measured 10–12 times on the real workspaces.
  if (!options.ignoreDependencies) {
    const unmet = await unmetDependencies(workspaceRoot, task);
    if (unmet.length > 0) {
      throw new Error(
        `${task.id} has unmet dependencies: ${describeUnmet(unmet)} — nothing was changed.\n` +
          `  A dependency counts once it is in-review or done.\n` +
          unmetDependencyHints(unmet).map((hint) => `  ${hint}`).join("\n")
      );
    }
  }

  // Resolve the model before touching state. An unsupported effort or a malformed
  // policy is a config error; throwing after the task is already `running` left an
  // open run that `doctor` then reported as abandoned.
  const model = await resolveModel(workspaceRoot, task.agent, task.tier);
  const executed = executedChoice(model, { model: options.model, runtime: options.runtime });
  const executedModel = executed === model ? null : `${executed.runtime}:${executed.model}`;
  const rejectedBecause = lastRejection(current);
  const reopened = current.status === "in-review";

  const runId = await allocateRunId(workspaceRoot, task.id);
  const startedAt = new Date().toISOString();
  const owner: RunOwner = {
    runId,
    // awo exits as soon as the run is open; what holds the run is the shell or
    // agent session that typed `task run`.
    pid: process.ppid ?? null,
    host: os.hostname(),
    actor: actorLabel(),
    startedAt,
    heartbeatAt: startedAt,
  };

  await mutateState(goal.dir, goal.id, (s) => {
    // Any new execution makes an earlier goal-level QA brief/verdict stale.
    delete s.qa;
    const prior = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
    if (prior.status === "running") throw new Error(`${task.id} is already running (run ${prior.lastRunId}).`);
    if (prior.status === "in-review" && !options.reopen) {
      throw new Error(`${task.id} moved to in-review meanwhile; reopen it with --reopen --reason "…".`);
    }
    const ts = applyTransition(s, task.id, "running", "runner", {
      authoredStatus: task.authoredStatus,
      reason,
      runId,
    });
    ts.lastRunId = runId;
    ts.lastRunOutcome = null;
    ts.startedAt = startedAt;
    ts.finishedAt = null;
    ts.attempts += 1;
    ts.owner = owner;
  });

  // Investigation and decision tasks may declare `targets: []`: they open a run
  // and record a finding without a repository to isolate.
  const worktreesForRun = options.noWorktree || task.targets.length === 0
    ? []
    : await ensureTaskWorktrees(
        workspaceRoot,
        manifest,
        task.id,
        task.targets,
        [...task.dependsOn].reverse(),
        { deliveryBranch: goal.deliveryBranch, baseBranches: goal.baseBranches }
      );

  const worktrees = worktreesForRun;
  // A worker sandboxed to the workspace needs to write the worktree's git
  // metadata to commit (§9 item 40) — but ONLY that. Granting the repo itself
  // hands it the real checkout, and it edits that instead of the worktree
  // (§9 item 42: the fix caused the violation it was meant to prevent).
  const usable = worktrees.filter((w) => !w.error);

  // `state.worktree` was initialised to null and never written, so 100 tasks in the
  // SHOP workspace all claimed no checkout while 14 sat on disk. Record where the
  // worker was actually put; `awo worktree` reconciles against git regardless, but
  // state should not assert something false. The branch point goes with it, so the
  // diff base, the baseline and QA agree on what "the task's change" means.
  const bases = usable.flatMap((w) => (w.base ? [[w.repo, w.base] as const] : []));
  if (usable[0] || bases.length > 0) {
    const where = usable[0]?.path;
    await mutateState(goal.dir, goal.id, (s) => {
      const t = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
      if (where) t.worktree = where;
      if (bases.length > 0) t.base = { ...(t.base ?? {}), ...Object.fromEntries(bases) };
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
  const intendedModel = `${model.runtime}:${model.model}`;
  await appendEvent(workspaceRoot, runId, "run.start", {
    taskId: task.id,
    goalId: goal.id,
    agent: task.agent,
    targets: task.targets,
    checkouts: runCheckouts.map(({ repo, recordedPath }) => ({ repo, checkout: recordedPath })),
    tier: model.tier,
    tierFrom: model.tierSource,
    // `model` is what policy chose, kept for older readers. It used to be the only
    // model on record: 142 of 145 CRM runs said `claude:haiku` while Opus or Codex
    // did the work. `executedBy`/`executedModel` say what actually ran.
    model: intendedModel,
    intendedModel,
    ...(model.effort ? { effort: model.effort } : {}),
    executedBy: options.runtime?.trim() || actorLabel(detectAgentEnvironment()),
    ...(executedModel ? { executedModel } : {}),
    owner: { pid: owner.pid, host: owner.host, actor: owner.actor },
    ...(reason && reopened ? { reopenReason: reason } : {}),
    ...(reason && !reopened ? { reason } : {}),
    ...(rejectedBecause ? { rejectedBecause } : {}),
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
  // The full text once per distinct brief. Every retry used to re-record it —
  // 3.5 MB of identical briefs in one workspace's logs — so an unchanged brief is
  // now a hash plus the run that holds the text.
  const briefHash = hashBrief(brief);
  const earlier = current.lastRunId ? await readRunBrief(workspaceRoot, current.lastRunId) : null;
  const briefFrom = earlier?.text != null && earlier.hash === briefHash ? earlier.sourceRunId : null;
  await appendEvent(workspaceRoot, runId, "brief", {
    briefHash,
    ...(briefFrom ? { sameAs: briefFrom } : { text: brief }),
    ...(options.instruction ? { instruction: options.instruction } : {}),
  });

  return {
    brief,
    model,
    worktrees,
    checkouts: runCheckouts.map((c) => ({
      repo: c.repo,
      path: c.recordedPath,
      branch: usable.find((w) => w.repo === c.repo)?.branch ?? null,
      exists: true,
    })),
    invocation: invocationHint(executed, task.id, workerContext),
    fallbackInvocation: fallbackHint(model, task.id, workerContext),
    taskId: task.id,
    runId,
    eventsFile: path.relative(workspaceRoot, dayDataFile(workspaceRoot, runId)),
    targets: task.targets,
    agent: task.agent,
    body: task.body,
    executedModel,
    alreadyRunning: false,
    briefFrom,
    reopenReason: reopened ? reason : null,
    rejectedBecause,
  };
}

/**
 * What a caller said will actually execute, as a model choice. `--model` alone
 * keeps the resolved runtime; `--model codex:gpt-5` names both.
 */
function executedChoice(model: ResolvedModel, override: { model?: string; runtime?: string }): ModelChoice {
  let runtime = override.runtime?.trim() || undefined;
  let name = override.model?.trim() || undefined;
  if (name && !runtime && name.includes(":")) {
    runtime = name.slice(0, name.indexOf(":"));
    name = name.slice(name.indexOf(":") + 1);
  }
  if (!runtime && !name) return model;
  const sameRuntime = !runtime || runtime === model.runtime;
  if (!name && !sameRuntime) {
    throw new Error(
      `--runtime ${runtime} needs --model too: the resolved model ${model.model} belongs to ${model.runtime}.`
    );
  }
  return {
    runtime: runtime ?? model.runtime,
    model: name ?? model.model,
    // Effort and mode are runtime-specific settings; they do not carry across.
    ...(sameRuntime && model.effort ? { effort: model.effort } : {}),
    ...(sameRuntime && model.mode ? { mode: model.mode } : {}),
  };
}

/** The reason review last sent this task back, if that is the latest move. */
function lastRejection(ts: TaskState): string | null {
  const last = ts.transitions?.at(-1);
  return last && last.from === "in-review" && last.to === "todo" ? last.reason : null;
}

function hashBrief(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * A run's brief, following the pointer an unchanged brief is recorded as.
 * `sourceRunId` is the run whose event holds the text.
 */
export async function readRunBrief(
  workspaceRoot: string,
  runId: string
): Promise<{ text: string | null; hash: string | null; sourceRunId: string | null } | null> {
  const lastBrief = (events: RunEvent[]) => events.filter((e) => e.kind === "brief").at(-1);
  const event = lastBrief(await readEvents(workspaceRoot, runId).catch(() => []));
  if (!event) return null;
  if (typeof event.text === "string") {
    return {
      text: event.text,
      hash: typeof event.briefHash === "string" ? event.briefHash : hashBrief(event.text),
      sourceRunId: runId,
    };
  }
  if (typeof event.sameAs === "string") {
    const source = lastBrief(await readEvents(workspaceRoot, event.sameAs).catch(() => []));
    const text = typeof source?.text === "string" ? source.text : null;
    return {
      text,
      hash: typeof event.briefHash === "string" ? event.briefHash : null,
      sourceRunId: text === null ? null : event.sameAs,
    };
  }
  return null;
}

/** The checkouts an open run recorded, as they are on disk now. */
async function openRunCheckouts(workspaceRoot: string, events: RunEvent[]): Promise<RunCheckout[]> {
  const start = events.find((e) => e.kind === "run.start");
  const recorded = Array.isArray(start?.checkouts)
    ? (start.checkouts as Array<{ repo?: unknown; checkout?: unknown }>)
    : [];
  const out: RunCheckout[] = [];
  for (const item of recorded) {
    if (typeof item.repo !== "string" || typeof item.checkout !== "string") continue;
    const dir = path.resolve(workspaceRoot, item.checkout);
    const exists = await fs.pathExists(dir);
    const branch = exists
      ? (await simpleGit(dir).revparse(["--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null
      : null;
    out.push({ repo: item.repo, path: item.checkout, branch, exists });
  }
  return out;
}

/**
 * The worker context for an EXISTING run: work in its first checkout, and write
 * each checkout's git metadata so a fresh worker can still commit (§9 item 40).
 */
async function openRunWorkerContext(
  workspaceRoot: string,
  checkouts: RunCheckout[]
): Promise<{ cwd?: string; allow: string[] }> {
  const present = checkouts.filter((c) => c.exists);
  const allow: string[] = [];
  for (const checkout of present) {
    const common = (
      await simpleGit(path.resolve(workspaceRoot, checkout.path))
        .raw(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .catch(() => "")
    ).trim();
    if (common) allow.push(common);
  }
  return { cwd: present[0]?.path, allow: [...new Set(allow)] };
}

/** `task run` on a task that is already running: hand back the open run, change nothing. */
async function describeOpenRun(
  workspaceRoot: string,
  task: TaskDefinition,
  ts: TaskState
): Promise<TaskRunResult> {
  const runId = ts.lastRunId!;
  const events = await readEvents(workspaceRoot, runId);
  const start = events.find((e) => e.kind === "run.start");
  const brief = await readRunBrief(workspaceRoot, runId);
  const checkouts = await openRunCheckouts(workspaceRoot, events);
  const model = await resolveModel(workspaceRoot, task.agent, task.tier);
  const executedModel = typeof start?.executedModel === "string" ? start.executedModel : null;
  const context = await openRunWorkerContext(workspaceRoot, checkouts);
  return {
    brief: brief?.text ?? "",
    taskId: task.id,
    runId,
    eventsFile: path.relative(workspaceRoot, dayDataFile(workspaceRoot, runId)),
    targets: task.targets,
    agent: task.agent,
    body: task.body,
    model,
    invocation: invocationHint(executedChoice(model, { model: executedModel ?? undefined }), task.id, context),
    fallbackInvocation: fallbackHint(model, task.id, context),
    worktrees: [],
    checkouts,
    executedModel,
    alreadyRunning: true,
    briefFrom: brief?.sourceRunId && brief.sourceRunId !== runId ? brief.sourceRunId : null,
    reopenReason: typeof start?.reopenReason === "string" ? start.reopenReason : null,
    rejectedBecause: typeof start?.rejectedBecause === "string" ? start.rejectedBecause : null,
  };
}

export async function runTaskEvent(
  taskId: string,
  kind: string,
  options: {
    cwd?: string;
    label?: string;
    message?: string;
    data?: string;
    /** Command for awo to RUN and measure, instead of a claim about one. */
    run?: string;
    /** Also run it at the branch point, so a failure can be attributed. */
    baseline?: boolean;
    repo?: string;
    timeoutMinutes?: number;
    checkout?: string;
    base?: string;
  } = {}
): Promise<{ measured: boolean; diagnosis?: string; needsHuman?: boolean }> {
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
    try {
      Object.assign(fields, JSON.parse(options.data));
    } catch {
      throw new Error(`--data must be valid JSON; got: ${options.data}`);
    }
  }
  if (!options.run) {
    await appendEvent(workspaceRoot, ts.lastRunId, kind as EventKind, fields);
    return { measured: false };
  }

  // --run makes this event a measurement: awo executes the command in the task's
  // worktree and records what actually happened. A `test` event carrying `verified`
  // is the only thing `task complete --gate` will accept.
  const manifest = await readManifest(workspaceRoot);
  const repoName = options.repo ?? task.targets[0];
  if (!repoName) {
    throw new Error(
      `${task.id} has no targets, so there is no repo to run "${options.run}" in. Pass --repo <name>.`
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
  const measured = await measure(options.run, repoDir, options.timeoutMinutes);
  const afterTree = isGit ? await treeFingerprint(repoDir) : null;
  const changed = isGit ? await changedFiles(repoDir, baseSha!) : { all: [], tests: [], newTests: [], testsAndCodeTogether: [] };

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
        options.run,
        scratch,
        options.timeoutMinutes
      );
      base = attempt.measurement;
      baselineError = attempt.error;
    }
  }

  const verdict = beforeTree !== afterTree
    ? { diagnosis: "unknown", needsHuman: true, explanation: "The tested tree changed while the command ran; rerun against a stable tree." }
    : diagnose(measured, base, changed);
  const artifact = path.join("logs", ts.lastRunId.slice(0, 10), "measurements", `${randomUUID()}.json`);
  await fs.outputJson(path.join(workspaceRoot, artifact), { candidate: measured, baseline: base, baselineError }, { spaces: 2 });

  await appendEvent(workspaceRoot, ts.lastRunId, kind as EventKind, {
    ...fields,
    repo: repoName,
    verified: true,
    checkout: repoDir,
    headSha,
    baseSha,
    treeFingerprint: beforeTree,
    treeFingerprintAfter: afterTree,
    artifact,
    command: measured.command,
    exitCode: measured.exitCode,
    durationSec: measured.durationSec,
    ...(measured.passed !== undefined ? { passed: measured.passed } : {}),
    ...(measured.failed !== undefined ? { failed: measured.failed } : {}),
    ...(measured.timedOut ? { timedOut: true } : {}),
    ...(base ? { baselineExitCode: base.exitCode, baselineFailed: base.failed } : {}),
    ...(baselineError ? { baselineError } : {}),
    diagnosis: verdict.diagnosis,
    needsHuman: verdict.needsHuman,
    explanation: verdict.explanation,
    ...(measured.exitCode === 0 ? {} : { tail: measured.tail }),
  });

  return { measured: true, diagnosis: verdict.diagnosis, needsHuman: verdict.needsHuman };
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
    outcome: string;
    summary?: string;
    prompt?: string;
    interpreted?: string;
    note?: string[];
    gate?: boolean;
    /** Close as success without test evidence — requires stating why. */
    untested?: string;
    /** Implementation intentionally produced no repository change. */
    noChange?: string;
  }
): Promise<TaskCompleteResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (!RUN_OUTCOMES.includes(options.outcome as RunOutcome)) {
    throw new Error(
      `Unknown outcome "${options.outcome}". Valid: ${RUN_OUTCOMES.join(", ")}.`
    );
  }
  const outcome = options.outcome as RunOutcome;

  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const ts = effectiveState(await readState(goal.dir, goal.id), task);
  if (ts.status !== "running" || !ts.lastRunId) {
    throw new Error(`${task.id} has no open run to complete (status: ${ts.status}).`);
  }
  const runId = ts.lastRunId;
  await captureRepositoryEvidence(workspaceRoot, runId);
  const priorEvents = await readEvents(workspaceRoot, runId);

  // §7.1 `tests-must-pass` was unenforceable: a task could close as `success` with
  // no evidence of anything having run, and six such tasks composed into a broken
  // feature (§9 item 47). A successful run must therefore carry a `test` event, or
  // say out loud why it cannot.
  const requiresMeasuredCheck =
    !task.kindExplicit || task.kind === "implementation" || task.kind === "verification";
  if (outcome === "success" && requiresMeasuredCheck && !options.untested) {
    // A command's latest measurement supersedes its earlier attempts. A pass
    // from a different command must never hide a failed check in the same run.
    const latest = new Map<string, (typeof priorEvents)[number]>();
    for (const event of priorEvents) {
      if (event.kind === "test" && event.verified === true) {
        latest.set(JSON.stringify([event.repo ?? null, event.command ?? null]), event);
      }
    }
    const measurements = [...latest.values()];
    const failing = measurements.filter((event) => event.exitCode !== 0 || event.timedOut === true);
    if (failing.length > 0) {
      throw new Error(
        `${task.id} cannot close as success with failing measured checks.\n` +
          failing.map((event) => `  ${event.repo ?? "repo"}: ${event.command ?? "test"} (exit ${event.exitCode})`).join("\n") +
          `\n  Fix and rerun each failing command; routing to review does not make a failure pass.`
      );
    }
    const measuredPasses = measurements.filter((event) => event.exitCode === 0);
    const claims = priorEvents.filter((e) => e.kind === "test" && e.verified !== true);

    if (measuredPasses.length === 0 && claims.length > 0) {
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
    // Receipts identify the tree actually tested, not whatever happens to be in
    // the checkout at completion. Review cannot repair missing test coverage.
    const currentTrees = new Map<string, string>();
    for (const event of measuredPasses) {
      if (typeof event.treeFingerprint !== "string") continue; // Legacy/non-Git receipt.
      if (event.treeFingerprintAfter !== event.treeFingerprint) {
        throw new Error(`${task.id}: the tested tree changed during ${event.command}; rerun against a stable tree.`);
      }
      if (typeof event.checkout !== "string") {
        throw new Error(`${task.id}: the test receipt has no checkout; rerun the measurement.`);
      }
      if (!currentTrees.has(event.checkout)) {
        currentTrees.set(event.checkout, await treeFingerprint(event.checkout));
      }
      if (currentTrees.get(event.checkout) !== event.treeFingerprint) {
        throw new Error(`${task.id}: stale test receipt for ${event.command}; the checkout tree changed after testing. Rerun the check.`);
      }
    }

    // A measurement can pass and still be inconclusive — a test edited alongside the
    // code it covers, or new tests asserting a contract nobody has checked against
    // the acceptance criteria. Those may close, but only into review.
    const inconclusive = measuredPasses.filter((e) => e.needsHuman === true);
    if (inconclusive.length > 0 && !options.gate) {
      throw new Error(
        `${task.id} has evidence that needs a human, so it cannot go straight to done.\n` +
          inconclusive.map((e) => `  ${e.diagnosis}: ${e.explanation}`).join("\n") +
          `\n  Close it into review instead:\n` +
          `    awo task complete ${task.id} --outcome success --gate --summary "…"`
      );
    }

    if (!priorEvents.some((e) => e.kind === "test")) {
      throw new Error(
        `${task.id} cannot close as success with no test evidence (rule: tests-must-pass).\n` +
          `Record what ran:  awo task event ${task.id} test --data '{"repo":"<name>","pass":<n>}'\n` +
          `If tests genuinely could not run, say so:  --untested "<why>"`
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

  await appendEvent(workspaceRoot, runId, "run.end", { outcome });

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

  const nextStatus: TaskStatus =
    outcome === "success" ? (options.gate || goal.completionPolicy.qaRequired ? "in-review" : "done") : "blocked";

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
        ...(options.untested ? [`UNTESTED: ${options.untested}`] : []),
      ],
    }
  );

  // Carry what was resolved at run.start into the index, so a query can group
  // outcomes by tier/model/effort without re-reading every event stream.
  const start = events.find((e) => e.kind === "run.start");
  await appendIndex(workspaceRoot, {
    runId,
    taskId: task.id,
    agent: task.agent,
    ...(typeof start?.tier === "string" ? { tier: start.tier } : {}),
    ...(typeof start?.model === "string" ? { model: start.model } : {}),
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
    const t = applyTransition(s, task.id, nextStatus, "runner", {
      authoredStatus: task.authoredStatus,
      reason: nextStatus === "blocked" ? (options.summary ?? `run ${runId} ${outcome}`) : null,
      runId,
    });
    t.lastRunOutcome = outcome;
    t.finishedAt = finishedAt;
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

export interface RunMeasurementSummary {
  repo: string;
  command: string | null;
  exitCode: number | null;
  diagnosis: string | null;
  needsHuman: boolean;
  at: string;
}

export interface TaskResumeResult {
  taskId: string;
  goalId: string;
  runId: string;
  startedAt: string | null;
  brief: string | null;
  /** The run holding the brief text, when this run recorded a pointer to it. */
  briefFrom: string | null;
  checkouts: RunCheckout[];
  events: { total: number; byKind: Record<string, number>; recent: string[] };
  /** The latest measured test per repo — where the next worker starts from. */
  measurements: RunMeasurementSummary[];
  previousOwner: RunOwner | null;
  owner: RunOwner;
  model: ResolvedModel;
  invocation: string;
}

/**
 * Hand an open run to a fresh worker — after a crash, a quota wall, or a context
 * reset. Two of four real workspaces built their own supervisor and handoff files
 * for exactly this, and an atlas-crm run sat open for 227 hours because nothing
 * said who held it. This re-briefs from the run's own record: what the worker was
 * told, where it works, what happened so far, and what the last measurement said.
 */
export async function runTaskResume(
  taskId: string,
  options: { cwd?: string } = {}
): Promise<TaskResumeResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { task, goal } = await locateTask(workspaceRoot, taskId);
  assertGoalWritable(goal, task.id);
  const ts = effectiveState(await readState(goal.dir, goal.id), task);

  if (ts.status !== "running" || !ts.lastRunId) {
    const next =
      ts.status === "in-review"
        ? `Measure it again: awo task recheck ${task.id} — or open a repair round: awo task run ${task.id} --reopen --reason "<what to fix>"`
        : ts.status === "done"
          ? `Measure it again: awo task recheck ${task.id}`
          : ts.status === "cancelled"
            ? `Restore it first: awo task status ${task.id} todo`
            : `Start one: awo task run ${task.id}`;
    throw new Error(`${task.id} has no open run to resume (status: ${ts.status}).\n  ${next}`);
  }

  const runId = ts.lastRunId;
  const events = await readEvents(workspaceRoot, runId);
  const brief = await readRunBrief(workspaceRoot, runId);
  const checkouts = await openRunCheckouts(workspaceRoot, events);

  const byKind: Record<string, number> = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  const recent = events
    .filter((event) => event.kind !== "brief" && event.kind !== "run.start")
    .slice(-8)
    .map(describeEvent);

  const latest = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.kind === "test" && event.verified === true) latest.set(String(event.repo ?? "repo"), event);
  }
  const measurements: RunMeasurementSummary[] = [...latest.entries()].map(([repo, event]) => ({
    repo,
    command: typeof event.command === "string" ? event.command : null,
    exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
    diagnosis: typeof event.diagnosis === "string" ? event.diagnosis : null,
    needsHuman: event.needsHuman === true,
    at: event.t,
  }));

  const now = new Date().toISOString();
  const previousOwner = ts.owner ?? null;
  const owner: RunOwner = {
    runId,
    pid: process.ppid ?? null,
    host: os.hostname(),
    actor: actorLabel(),
    startedAt: previousOwner?.startedAt ?? ts.startedAt ?? now,
    heartbeatAt: now,
  };

  await mutateState(goal.dir, goal.id, (s) => {
    const t = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
    if (t.status !== "running" || t.lastRunId !== runId) {
      throw new Error(
        `${task.id}'s open run changed while resuming (now ${t.status}, run ${t.lastRunId}). Run \`awo task resume ${task.id}\` again.`
      );
    }
    const next = applyTransition(s, task.id, "running", "runner", {
      authoredStatus: task.authoredStatus,
      reason: `resumed by ${owner.actor}`,
      runId,
    });
    next.owner = owner;
  });
  await appendEvent(workspaceRoot, runId, "run.resume", {
    actor: owner.actor,
    pid: owner.pid,
    host: owner.host,
    previousOwner: previousOwner
      ? {
          actor: previousOwner.actor,
          pid: previousOwner.pid,
          host: previousOwner.host,
          heartbeatAt: previousOwner.heartbeatAt,
        }
      : null,
  });

  const start = events.find((event) => event.kind === "run.start");
  const model = await resolveModel(workspaceRoot, task.agent, task.tier);
  const executedModel = typeof start?.executedModel === "string" ? start.executedModel : undefined;
  const context = await openRunWorkerContext(workspaceRoot, checkouts);

  return {
    taskId: task.id,
    goalId: goal.id,
    runId,
    startedAt: ts.startedAt,
    brief: brief?.text ?? null,
    briefFrom: brief?.sourceRunId && brief.sourceRunId !== runId ? brief.sourceRunId : null,
    checkouts,
    events: { total: events.length, byKind, recent },
    measurements,
    previousOwner,
    owner,
    model,
    invocation: invocationHint(executedChoice(model, { model: executedModel }), task.id, context),
  };
}

function describeEvent(event: RunEvent): string {
  const detail =
    event.kind === "test" && event.verified === true
      ? `${event.repo ?? "repo"}: \`${event.command}\` exit ${event.exitCode}${event.diagnosis ? ` (${event.diagnosis})` : ""}`
      : String(event.label ?? event.msg ?? event.sha ?? event.repo ?? "");
  return `${event.t.slice(11, 19)}  ${event.kind}${detail ? `  ${detail}` : ""}`;
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
  const outcome: RunOutcome = passed ? "success" : diagnosis === "pre-existing" ? "skipped" : "failed";

  await runTaskComplete(task.id, {
    cwd: workspaceRoot,
    outcome,
    // A pass that still needs a human goes to review, not straight back to done.
    gate: passed && measured.needsHuman === true,
    // `skipped` closes the run without evidence, which is honest and needs saying.
    untested:
      outcome === "skipped"
        ? `"${command}" was already failing at the branch point, so it cannot verify this task`
        : undefined,
    // Recheck is verification of already-existing implementation, so the lack of
    // a new diff is expected and must be recorded rather than treated as missing work.
    noChange: passed ? "retrospective verification only; implementation already existed" : undefined,
    summary: passed
      ? `Re-checked with \`${command}\`: ${diagnosis}. Original run closed with no evidence.`
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
