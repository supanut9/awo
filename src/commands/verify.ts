import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import matter from "gray-matter";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findTasksInGoal, type TaskKind } from "../tasks.js";
import { mutateState, newTaskState, readState } from "../state.js";
import { invocationHint, resolveModel, type ResolvedModel } from "../models.js";
import { readEvents, allocateRunId, dayDir, dayRecordFile, writeDetail } from "../runs.js";
import { runTaskVerify } from "./task.js";
import { runReqNew, runTaskNew } from "./plan.js";
import { runLogAdd } from "./log.js";
import { runGoalReadiness } from "./readiness.js";
import { retireQa } from "../qa-history.js";
import { describeActor, resolveHumanGate, type DecisionActor } from "../human-gate.js";
import { assertGoalWritable } from "../lifecycle.js";

/**
 * §7.1 QA gate, made operable.
 *
 * The gate is the only step that judges the goal *as a whole*, and the dogfood
 * showed it is what makes parallel low-tier work safe: six tasks each passed their
 * own checks and composed into a functionally broken feature, which only a
 * high-tier review across all six branches caught (§9 item 47). Yet assembling it
 * was entirely manual — collecting worktree paths, diffs, the definition-of-done
 * and the run history by hand, then remembering to record the verdict.
 *
 * This command does the assembly. Consistent with §9 item 2 it does not execute:
 * it writes a brief, resolves the *high* tier, and prints the invocation. The
 * verdict comes back through `awo goal verdict`.
 */
export interface VerifyTaskEntry {
  id: string;
  name: string;
  status: string;
  targets: string[];
  branch: string;
  worktree: string | null;
  commits: string[];
  files: string[];
  untested: boolean;
}

export interface GoalVerifyResult {
  goalId: string;
  /** `logs/<date>/qa/<runId>.md` — the brief itself, workspace-relative. */
  briefPath: string;
  /** The day's `runs.md`, whose section for this run links to the brief. */
  recordPath: string;
  briefRunId: string;
  model: ResolvedModel;
  invocation: string;
  tasks: VerifyTaskEntry[];
  unfinished: string[];
}

export async function runGoalVerify(
  goalId: string,
  options: { cwd?: string } = {}
): Promise<GoalVerifyResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);

  const goal = (await findGoals(root)).find((g) => g.id === goalId);
  if (!goal) {
    const known = (await findGoals(root)).map((g) => g.id);
    throw new Error(
      known.length > 0
        ? `Unknown goal "${goalId}". Known goals: ${known.join(", ")}.`
        : `Unknown goal "${goalId}". None exist yet.`
    );
  }
  assertGoalWritable(goal);

  const tasks = await findTasksInGoal(goal.dir);
  const state = await readState(goal.dir, goal.id);

  const entries: VerifyTaskEntry[] = [];
  for (const task of tasks) {
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    const branch = `feature/${task.id}`;

    // Find the worktree holding this task's branch, in whichever target repo has it.
    let worktree: string | null = null;
    let commits: string[] = [];
    let files: string[] = [];
    for (const name of task.targets) {
      const entry = manifest.repos.find((r) => r.name === name);
      if (!entry) continue;
      const repoPath =
        entry.type === "local" ? entry.path : path.join(root, "repos", name);
      const git = simpleGit(repoPath);
      if (!(await git.checkIsRepo().catch(() => false))) continue;

      const list = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
      let candidate: string | null = null;
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ")) candidate = line.slice(9).trim();
        if (line.trim() === `branch refs/heads/${branch}` && candidate) {
          worktree = candidate;
          break;
        }
      }
      if (!worktree) continue;

      const wt = simpleGit(worktree);
      commits = (await wt.raw(["log", "--oneline", "-5"]).catch(() => ""))
        .split("\n")
        .filter(Boolean);
      files = (await wt.raw(["show", "--stat", "--format=", "HEAD"]).catch(() => ""))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      break;
    }

    // A task closed with --untested is the gate's highest-priority suspicion.
    const untested = ts.lastRunId
      ? !(await readEvents(root, ts.lastRunId)).some((e) => e.kind === "test")
      : true;

    entries.push({
      id: task.id,
      name: task.name,
      status: ts.status,
      targets: task.targets,
      branch,
      worktree: worktree ? path.relative(root, worktree) : null,
      commits,
      files,
      untested,
    });
  }

  const unfinished = entries
    .filter((t) => t.status !== "done" && t.status !== "in-review" && t.status !== "cancelled")
    .map((t) => `${t.id} (${t.status})`);
  if (unfinished.length > 0) {
    throw new Error(
      `${goal.id} is not ready for goal-level QA: ${unfinished.join(", ")}\n` +
        `  Finish the work first, then run \`awo goal readiness ${goal.id}\`.`
    );
  }

  const goalBody = await fs.readFile(path.join(goal.dir, "goal.md"), "utf8");
  const reqPath = path.join(goal.dir, "requirement.md");
  const reqBody = (await fs.pathExists(reqPath)) ? await fs.readFile(reqPath, "utf8") : "";

  // The gate is judgment work: always the high tier, whatever the tasks used.
  const model = await resolveModel(root, "qa-engineer", "high");

  const brief = buildBrief(goal.id, goalBody, reqBody, entries);

  // The brief is recorded like any other work — a run, addressable by runId and
  // listed by `awo log list` — but the brief itself is its own file. Written to
  // logs/verify-<goal>.md it was overwritten by the next gate on the same goal;
  // embedded in the day's runs.md it put a goal + requirement + every task's diff
  // stat (tens of KB on shop) into the file every reader of the day has to parse.
  const briefRunId = await allocateRunId(root, goal.id);
  const briefFile = path.join(dayDir(root, briefRunId), "qa", `${briefRunId}.md`);
  const briefPath = path.relative(root, briefFile);
  await fs.outputFile(briefFile, `${brief}\n`);
  const recordPath = await writeDetail(
    root,
    briefRunId,
    {
      kind: "qa-gate",
      goal: goal.id,
      model: `${model.runtime}:${model.model}`,
      tasks: entries.length,
      brief: briefPath,
    },
    {
      interpreted: `QA gate for ${goal.id}`,
      summary:
        `QA brief: [${briefPath}](${path.relative(path.dirname(dayRecordFile(root, briefRunId)), briefFile)})\n\n` +
        `Tasks under review: ${entries.map((t) => `${t.id} (${t.status}${t.untested ? ", untested" : ""})`).join(", ") || "none"}`,
    }
  );
  await mutateState(goal.dir, goal.id, (draft) => {
    // A new brief supersedes the old record; a verdict on it is kept, not lost.
    retireQa(draft, `superseded by QA brief ${briefRunId}`);
    draft.qa = {
      briefRunId,
      briefRecordedAt: new Date().toISOString(),
      verdict: null,
      summary: null,
      verdictRunId: null,
      verdictRecordedAt: null,
      verdictBy: null,
      model: `${model.runtime}:${model.model}`,
    };
  });

  return {
    goalId: goal.id,
    briefPath,
    recordPath: path.relative(root, recordPath),
    briefRunId,
    model,
    // Read-only, and carrying the brief rather than a task prompt. The brief has
    // its own file, so the prompt is that file — reproducible byte for byte.
    invocation: invocationHint(model, goal.id, {
      cwd: ".",
      readOnly: true,
      prompt: `$(cat ${briefPath})`,
    }),
    tasks: entries,
    unfinished,
  };
}

function buildBrief(
  goalId: string,
  goalBody: string,
  reqBody: string,
  tasks: VerifyTaskEntry[]
): string {
  const lines = [
    `You are qa-engineer running the goal-level QA gate for ${goalId}.`,
    `Rule: acceptance-criteria-required. Skill: verify-acceptance-criteria. READ ONLY —`,
    `do not modify anything, and do not fix what you find.`,
    "",
    `Judge the goal AS A WHOLE. Individually passing tasks are not evidence that the`,
    `feature works: the tasks below were built largely in parallel, so the likely`,
    `defects are CONTRACTS BETWEEN them — response shapes, DTO fields, identifiers,`,
    `route paths, auth expectations, status handling. Inspect the real diffs.`,
    "",
    "## Goal",
    goalBody.trim(),
    "",
  ];

  if (reqBody.trim()) {
    lines.push("## Requirement it came from", reqBody.trim(), "");
  }

  lines.push("## Delivered work");
  for (const t of tasks) {
    lines.push(
      `### ${t.id} — ${t.name}  [${t.status}]`,
      `targets: ${t.targets.join(", ") || "none"}`,
      `branch: ${t.branch}`,
      `worktree: ${t.worktree ?? "NOT FOUND — no worktree holds this branch"}`,
      ...(t.untested ? ["NOTE: this task closed WITHOUT test evidence — treat with suspicion"] : []),
      ...(t.commits.length ? ["commits:", ...t.commits.map((c) => `  ${c}`)] : ["commits: none"]),
      ...(t.files.length ? ["files:", ...t.files.map((f) => `  ${f}`)] : []),
      ""
    );
  }

  lines.push(
    "## What to produce",
    "For every Definition-of-done item: PASS or GAP, with the evidence you used",
    "(file and line). Then a verdict line: `VERDICT: PASS` or `VERDICT: GAP`, followed",
    "by a prioritised list of what must change. Be blunt — a false pass is worse than a",
    "harsh review. Say explicitly whether the branches compose.",
    "",
    `(If history helps: each task's runs are listed by \`awo log list --task <taskId>\` and`,
    `recorded under logs/<date>/ — runs.md holds the written records, runs.jsonl the events.)`
  );

  return lines.join("\n");
}

export interface GoalVerdictResult {
  goalId: string;
  pass: boolean;
  verifiedTasks: string[];
  filedRequirement: string | null;
  createdTask: string | null;
  /** Who is answerable for the verdict, and the delegation if an agent recorded it. */
  actor: DecisionActor;
}

/**
 * Record the gate's outcome. On PASS the in-review tasks are verified, which rolls
 * the goal up to `done` (§7.4). An in-scope GAP becomes an explicit repair task on
 * this goal; only a human-attributed `--new-scope` finding re-enters intake.
 */
export async function runGoalVerdict(
  goalId: string,
  options: {
    cwd?: string;
    pass: boolean;
    summary: string;
    note?: string[];
    model?: string;
    who?: string;
    delegatedBy?: string;
    instruction?: string;
    newScope?: boolean;
    targets?: string[];
    agent?: string;
    kind?: TaskKind;
  }
): Promise<GoalVerdictResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = (await findGoals(root)).find((g) => g.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);
  assertGoalWritable(goal);
  if (options.pass && options.newScope) {
    throw new Error("--new-scope only applies to --gap.");
  }
  // Both PASS and GAP are judgments a person answers for: a PASS closes the goal,
  // a GAP reopens it with new work. Measured: 26 of 26 real verdicts were typed by
  // an agent and recorded as if a human had.
  const actor = resolveHumanGate({
    command: `awo goal verdict ${goal.id} ${options.pass ? "--pass" : "--gap"} --summary "…"`,
    manifest: await readManifest(root),
    root,
    options,
    requireWho: goal.completionPolicy.qaRequired
      ? "A governed goal verdict requires --who <human> so the decision is attributable."
      : undefined,
  });

  const tasks = await findTasksInGoal(goal.dir);
  const state = await readState(goal.dir, goal.id);
  if (!state.qa?.briefRunId) {
    throw new Error(
      `${goal.id} has no attached QA brief. Run \`awo goal verify ${goal.id}\` before recording a verdict.`
    );
  }

  if (options.pass) {
    const readiness = await runGoalReadiness(goal.id, { cwd: root });
    if (!readiness.canPassVerdict) {
      throw new Error(
        `${goal.id} cannot pass QA:\n` +
          readiness.blockers
            .filter((blocker) => blocker.code !== "qa-verdict-missing" && blocker.code !== "qa-gap")
            .map((blocker) => `  - ${blocker.message}`)
            .join("\n") +
          `\n  Inspect all blockers with \`awo goal readiness ${goal.id}\`.`
      );
    }
  }

  const verdictLog = await runLogAdd({
    cwd: root,
    label: `qa-gate-${goalId}`,
    agent: "qa-engineer",
    model: options.model ? [options.model] : [],
    outcome: options.pass ? "success" : "failed",
    summary: `${options.pass ? "PASS" : "GAP"} — ${options.summary}`,
    // The delegating person's words go only in the prompt section, the field
    // publish redaction withholds — never repeated into notes.
    ...(actor.delegation?.instruction ? { prompt: actor.delegation.instruction } : {}),
    note: [
      actor.delegation
        ? `Decision delegated by ${actor.by}; recorded by ${actor.via}` +
          (actor.delegation.instruction ? " (their instruction is recorded as the prompt)" : " (no instruction quoted)")
        : `Decision recorded by ${describeActor(actor)}`,
      ...(options.note ?? []),
    ],
  });

  const verified: string[] = [];
  if (options.pass) {
    for (const task of tasks) {
      const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
      if (ts.status !== "in-review") continue;
      await runTaskVerify(task.id, { cwd: root, approve: true, goalVerdict: true });
      verified.push(task.id);
    }
  }

  let filed: string | null = null;
  let createdTask: string | null = null;
  if (!options.pass) {
    if (options.newScope) {
      const req = await runReqNew({
        cwd: root,
        title: `New scope found by the ${goalId} QA gate: ${options.summary}`,
        source: `qa-engineer via verify-acceptance-criteria on ${goalId}`,
      });
      filed = req.id;
    } else {
      const inheritedTargets = goal.targets.length > 0
        ? goal.targets
        : [...new Set(tasks.flatMap((task) => task.targets))];
      const repair = await runTaskNew({
        cwd: root,
        goal: goal.id,
        name: `QA gap: ${options.summary}`,
        targets: options.targets ?? inheritedTargets,
        agent: options.agent ?? "software-engineer",
        kind: options.kind ?? "implementation",
        body:
          `\n## Objective\n\nClose the in-scope gap found by the ${goal.id} QA gate.\n\n` +
          `## QA finding\n\n${options.summary}\n\n` +
          (options.note?.length ? `## Required changes\n\n${options.note.map((note) => `- ${note}`).join("\n")}\n\n` : "") +
          `## Done when\n\n- The finding is fixed and linked to acceptance evidence.\n- Goal-level QA is run again.\n`,
      });
      createdTask = repair.id;
    }
  }

  await mutateState(goal.dir, goal.id, (draft) => {
    // A second verdict on the same brief (PASS, then a GAP found later) replaces
    // a decision, so the earlier one is retired, not overwritten. A brief-only
    // record is being completed here, and its brief carries over below.
    if (draft.qa?.verdict) retireQa(draft, `superseded by the ${options.pass ? "PASS" : "GAP"} verdict ${verdictLog.runId}`);
    draft.qa = {
      briefRunId: state.qa?.briefRunId ?? null,
      briefRecordedAt: state.qa?.briefRecordedAt ?? null,
      verdict: options.pass ? "pass" : "gap",
      summary: options.summary,
      verdictRunId: verdictLog.runId,
      verdictRecordedAt: new Date().toISOString(),
      verdictBy: actor.by,
      model: options.model ?? state.qa?.model ?? null,
      delegation: actor.delegation,
    };
  });

  return {
    goalId,
    pass: options.pass,
    verifiedTasks: verified,
    filedRequirement: filed,
    createdTask,
    actor,
  };
}
