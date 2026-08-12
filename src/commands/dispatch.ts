import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, resolvePullRequestMergePolicy } from "../manifest.js";
import { appendEvent, workerLogFile } from "../runs.js";
import { runTaskComplete, runTaskRun, type TaskRunResult } from "./task.js";

/**
 * §12.6 — actually spawn the worker.
 *
 * Deferred for a long time on purpose: it makes awo an agent runtime, and a runaway
 * worker in a linked repo is a bad afternoon. The prerequisites named in §12.6 are
 * now met — `task run` creates the worktree (branched from the dependency, with
 * dependencies linked), the sandbox grant is narrowed to the git dir, and a task
 * cannot close as success without test evidence.
 *
 * Two failures from the dogfood shape this command:
 *
 *  - §9 item 35: a one-shot orchestrator ended its turn saying it would "continue
 *    when the worker reports back", killing the child and stranding the work. So
 *    dispatch **blocks until the worker exits** — by construction, not by
 *    instruction.
 *  - §9 item 41: when a Codex orchestrator could not spawn a Codex worker, it
 *    quietly did the work itself. So a spawn failure here **fails the task loudly**
 *    rather than falling back to something.
 */
export interface DispatchResult {
  taskId: string;
  runId: string;
  model: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  outputPath: string;
  outcome: "success" | "failed" | "skipped";
  completed: boolean;
}

export async function runDispatch(
  taskId: string,
  options: {
    cwd?: string;
    timeoutMinutes?: number;
    dryRun?: boolean;
    /** Extra text appended to the worker's prompt. */
    instruction?: string;
    /** Leave the run open for the caller to close. */
    noComplete?: boolean;
  } = {}
): Promise<DispatchResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());

  if (options.dryRun) {
    // Resolve everything without opening a run, so a dry run is inspectable and
    // leaves no state behind.
    const { runTaskShow } = await import("./task.js");
    const shown = await runTaskShow(taskId, { cwd: root });
    const { resolveModel, invocationHint } = await import("../models.js");
    const model = await resolveModel(root, shown.task.agent, shown.task.tier);
    return {
      taskId,
      runId: "(none — dry run)",
      model: `${model.runtime}:${model.model}`,
      command: invocationHint(model, taskId, { cwd: "<worktree>" }),
      exitCode: null,
      timedOut: false,
      outputPath: "(none)",
      outcome: "skipped",
      completed: false,
    };
  }

  // Refuse plan mode before opening a run, not after.
  //
  // A spawned worker has no human to approve its plan and no stdin to be asked on
  // (that is closed deliberately — see runWorker). It would print a plan, wait, and
  // be killed by the timeout with the run still open. The failure mode is 45 minutes
  // of nothing, so this is an error with the two real options named.
  {
    const { runTaskShow } = await import("./task.js");
    const shown = await runTaskShow(taskId, { cwd: root });
    const { resolveModel } = await import("../models.js");
    const resolved = await resolveModel(root, shown.task.agent, shown.task.tier);
    if (resolved.mode === "plan") {
      throw new Error(
        `${taskId} resolves to ${resolved.runtime}:${resolved.model} in plan mode, which cannot be dispatched.\n` +
          `  Plan mode waits for a human to approve the plan, and a spawned worker has nobody to ask —\n` +
          `  it would print a plan and sit there until the timeout killed it, run still open.\n` +
          `  Either run it yourself, interactively:  awo task run ${taskId}\n` +
          `  or drop \`mode: plan\` from ${shown.task.agent ?? "the role"} in the models policy for dispatched work.\n` +
          `  (Plan mode belongs on the planning steps — \`awo goal plan\`, \`awo req refine --plan\`.)`
      );
    }
  }

  const opened: TaskRunResult = await runTaskRun(taskId, {
    cwd: root,
    instruction: options.instruction,
  });
  const runId = opened.runId;
  const mergePolicy = resolvePullRequestMergePolicy(await readManifest(root));

  const usable = opened.worktrees.filter((w) => !w.error);
  const cwd = usable[0] ? path.join(root, usable[0].path) : root;

  // The brief comes from `task run`, which already recorded it — so what the worker
  // is told and what the log says it was told cannot drift apart.
  const prompt = opened.brief;

  const argv = buildArgv(opened, prompt, usable.flatMap((w) => w.writablePaths));

  // The worker's own output is part of the audit trail — a summary in the run log is
  // not enough to diagnose a worker that went wrong.
  const outputPath = workerLogFile(root, runId);
  await fs.ensureDir(path.dirname(outputPath));

  await appendEvent(root, runId, "step.start", {
    label: `dispatching to ${opened.model.runtime}:${opened.model.model}`,
    command: argv.join(" "),
  });

  const timeoutMs = (options.timeoutMinutes ?? 45) * 60_000;
  const { code, timedOut } = await runWorker(argv, cwd, outputPath, timeoutMs);

  await appendEvent(root, runId, "step.end", {
    label: timedOut ? `worker timed out after ${options.timeoutMinutes ?? 45}m` : `worker exited ${code}`,
    ok: code === 0 && !timedOut,
  });

  const outcome: DispatchResult["outcome"] = code === 0 && !timedOut ? "success" : "failed";

  let completed = false;
  if (!options.noComplete) {
    // A dispatched worker rarely records its own `test` event, so an honest
    // success needs the reason stated rather than the evidence faked.
    await runTaskComplete(taskId, {
      cwd: root,
      outcome,
      summary: timedOut
        ? `Worker timed out after ${options.timeoutMinutes ?? 45} minutes.`
        : `Worker (${opened.model.runtime}:${opened.model.model}) exited ${code}. Output: ${path.relative(root, outputPath)}`,
      untested: outcome === "success" ? "dispatched worker did not record a test event" : undefined,
      note: [`worker output: ${path.relative(root, outputPath)}`],
    }).then(() => {
      completed = true;
    });
  }

  return {
    taskId,
    runId,
    model: `${opened.model.runtime}:${opened.model.model}`,
    command: argv.join(" "),
    exitCode: code,
    timedOut,
    outputPath: path.relative(root, outputPath),
    outcome,
    completed,
  };
}

/** Built as argv rather than a shell string: no quoting bugs, no injection. */
function buildArgv(opened: TaskRunResult, prompt: string, writable: string[]): string[] {
  const { runtime, model, effort } = opened.model;
  const allow = [...new Set(writable)].flatMap((p) => ["--add-dir", p]);

  switch (runtime) {
    case "codex":
      return [
        "codex",
        "exec",
        "-m",
        model,
        ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
        "-s",
        "workspace-write",
        "--skip-git-repo-check",
        ...allow,
        prompt,
      ];
    case "gemini":
      return ["gemini", "-m", model, "-p", prompt];
    default:
      return ["claude", "--model", model, "--permission-mode", "acceptEdits", "-p", prompt];
  }
}

function runWorker(
  argv: string[],
  cwd: string,
  outputPath: string,
  timeoutMs: number
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(outputPath);
    // stdin closed deliberately: a worker that waits on stdin it will never get
    // hangs forever, which is how a dogfood run lost 20 minutes (§9 item 35).
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout?.pipe(out);
    child.stderr?.pipe(out);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.on("error", (err) => {
      // A missing CLI must fail the task, never silently become someone else's job.
      out.write(`\nawo: failed to spawn ${argv[0]}: ${err.message}\n`);
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      resolve({ code, timedOut });
    });
  });
}
