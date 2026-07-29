import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import {
  branchPoint,
  changedFiles,
  diagnose,
  measure,
  measureBaseline,
  type Measurement,
} from "../evidence.js";
import { readManifest } from "../manifest.js";
import { findAllTasks, locateTask, type TaskDefinition } from "../tasks.js";
import {
  assertTransition,
  mutateState,
  newTaskState,
  readState,
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
  const state = await readState(goal.dir, goal.id);
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
  options: { cwd?: string; actor?: Actor; reason?: string } = {}
): Promise<TaskStatus> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (!TASK_STATUSES.includes(to as TaskStatus)) {
    throw new Error(`Unknown status "${to}". Valid: ${TASK_STATUSES.join(", ")}.`);
  }
  const target = to as TaskStatus;
  const actor: Actor = options.actor ?? "human";

  const { task, goal } = await locateTask(workspaceRoot, taskId);
  const current = effectiveState(await readState(goal.dir, goal.id), task);
  assertTransition(task.id, current.status, target, actor);

  await mutateState(goal.dir, goal.id, (state) => {
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    ts.status = target;
    ts.blockedReason = target === "blocked" ? (options.reason ?? ts.blockedReason) : null;
    state.tasks[task.id] = ts;
  });
  return target;
}

export interface TaskRunResult {
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
  options: { cwd?: string; noWorktree?: boolean } = {}
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

  // Dependencies must be `done` — `in-review` is not yet verified.
  const unmet: string[] = [];
  for (const depId of task.dependsOn) {
    const dep = await locateTask(workspaceRoot, depId).catch(() => null);
    if (!dep) {
      unmet.push(`${depId} (not found)`);
      continue;
    }
    const depState = effectiveState(await readState(dep.goal.dir, dep.goal.id), dep.task);
    if (depState.status !== "done") unmet.push(`${depId} (${depState.status})`);
  }

  if (unmet.length > 0) {
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
    const ts = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
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

  await appendEvent(workspaceRoot, runId, "run.start", {
    taskId: task.id,
    goalId: goal.id,
    agent: task.agent,
    targets: task.targets,
    tier: model.tier,
    tierFrom: model.tierSource,
    model: `${model.runtime}:${model.model}`,
    ...(model.effort ? { effort: model.effort } : {}),
  });

  return {
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
  const worktree = path.join(workspaceRoot, "repos", ".worktrees", repoName, task.id);
  const repoDir = (await fs.pathExists(worktree))
    ? worktree
    : path.join(workspaceRoot, "repos", repoName);
  if (!(await fs.pathExists(repoDir))) {
    throw new Error(`no repo at ${path.relative(workspaceRoot, repoDir)} to run "${options.run}" in.`);
  }

  // A cloned repo has a declared ref; a symlinked local checkout does not, so the
  // base is whatever branch that checkout is on — which is what its task worktrees
  // were branched from.
  const entry = manifest.repos.find((r) => r.name === repoName);
  const baseRef =
    entry && entry.type === "git"
      ? entry.ref
      : (await simpleGit(path.join(workspaceRoot, "repos", repoName))
          .revparse(["--abbrev-ref", "HEAD"])
          .catch(() => "HEAD")).trim();
  const measured = await measure(options.run, repoDir, options.timeoutMinutes);
  const changed = await changedFiles(repoDir, baseRef);

  let base: Measurement | null = null;
  let baselineError: string | undefined;
  if (options.baseline) {
    const point = await branchPoint(repoDir, baseRef);
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

  const verdict = diagnose(measured, base, changed);

  await appendEvent(workspaceRoot, ts.lastRunId, kind as EventKind, {
    ...fields,
    repo: repoName,
    verified: true,
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
 * lifecycle transition. `--gate` routes a success to `in-review` instead of
 * `done`, so the QA gate (§7.1) stays a real step.
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

  // §7.1 `tests-must-pass` was unenforceable: a task could close as `success` with
  // no evidence of anything having run, and six such tasks composed into a broken
  // feature (§9 item 47). A successful run must therefore carry a `test` event, or
  // say out loud why it cannot.
  if (outcome === "success" && !options.untested) {
    const priorEvents = await readEvents(workspaceRoot, runId);
    const measuredPasses = priorEvents.filter(
      (e) => e.kind === "test" && e.verified === true && e.exitCode === 0
    );
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

  await appendEvent(workspaceRoot, runId, "run.end", { outcome });

  const finishedAt = new Date().toISOString();
  const durationSec = ts.startedAt
    ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(ts.startedAt)) / 1000))
    : null;

  const events = await readEvents(workspaceRoot, runId);

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
    outcome === "success" ? (options.gate ? "in-review" : "done") : "blocked";

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
      prompt: options.prompt,
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
  options: { cwd?: string; approve: boolean; reason?: string } = { approve: true }
): Promise<TaskStatus> {
  return runTaskStatus(taskId, options.approve ? "done" : "todo", {
    cwd: options.cwd,
    actor: "qa",
    reason: options.reason,
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
}

export async function runTaskRecheck(
  taskId: string,
  options: { cwd?: string; run?: string; baseline?: boolean; repo?: string; timeoutMinutes?: number } = {}
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

  // Human-initiated correction, so the transition is attributed to a human.
  await runTaskStatus(task.id, before.status === "done" ? "todo" : "todo", {
    cwd: workspaceRoot,
    actor: "human",
    reason: "re-opened to attach missing test evidence",
  });

  await runTaskRun(task.id, { cwd: workspaceRoot });
  const measured = await runTaskEvent(task.id, "test", {
    cwd: workspaceRoot,
    run: command,
    baseline: options.baseline,
    repo: options.repo,
    timeoutMinutes: options.timeoutMinutes,
    label: `retrospective verification of work closed before the evidence gate`,
  });

  const events = await readEvents(workspaceRoot, (await readState(goal.dir, goal.id)).tasks[task.id]!.lastRunId!);
  const test = events.filter((e) => e.kind === "test").at(-1);
  const passed = test?.exitCode === 0;

  await runTaskComplete(task.id, {
    cwd: workspaceRoot,
    outcome: passed ? "success" : "failed",
    // A pass that still needs a human goes to review, not straight back to done.
    gate: passed && measured.needsHuman === true,
    summary: passed
      ? `Re-checked with \`${command}\`: ${measured.diagnosis}. Original run closed with no evidence.`
      : `Re-checked with \`${command}\`: ${measured.diagnosis}. It does not pass, so the original close was wrong.`,
    note: [`re-opened from ${before.status} to attach evidence the original run never had`],
  });

  const after = effectiveState(await readState(goal.dir, goal.id), task);
  return {
    taskId: task.id,
    runId: after.lastRunId ?? "(none)",
    previousStatus: before.status,
    status: after.status,
    diagnosis: measured.diagnosis ?? "unknown",
    passed,
  };
}
