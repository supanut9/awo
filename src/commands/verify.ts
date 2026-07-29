import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import matter from "gray-matter";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findTasksInGoal } from "../tasks.js";
import { newTaskState, readState } from "../state.js";
import { invocationHint, resolveModel, type ResolvedModel } from "../models.js";
import { readEvents, readIndex, allocateRunId, writeDetail } from "../runs.js";
import { runTaskVerify } from "./task.js";
import { runReqNew } from "./plan.js";
import { runLogAdd } from "./log.js";

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
  briefPath: string;
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

  const tasks = await findTasksInGoal(goal.dir);
  const state = await readState(goal.dir, goal.id);
  const index = await readIndex(root);

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

  const goalBody = await fs.readFile(path.join(goal.dir, "goal.md"), "utf8");
  const reqPath = path.join(goal.dir, "requirement.md");
  const reqBody = (await fs.pathExists(reqPath)) ? await fs.readFile(reqPath, "utf8") : "";

  // The gate is judgment work: always the high tier, whatever the tasks used.
  const model = await resolveModel(root, "qa-engineer", "high");

  const brief = buildBrief(goal.id, goalBody, reqBody, entries, index.length);

  // The brief is recorded like any other work: a section in the day's runs.md,
  // addressable by runId. Written straight to logs/verify-<goal>.md it was
  // invisible to `awo log list` and silently overwritten by the next gate on the
  // same goal, so a goal's earlier gates were simply gone.
  const briefRunId = await allocateRunId(root, goal.id);
  const briefPath = await writeDetail(
    root,
    briefRunId,
    { kind: "qa-gate", goal: goal.id, model: `${model.runtime}:${model.model}`, tasks: entries.length },
    { interpreted: `QA gate for ${goal.id}`, summary: brief }
  );

  return {
    goalId: goal.id,
    briefPath: path.relative(root, briefPath),
    briefRunId,
    model,
    // Read-only, and carrying the brief rather than a task prompt.
    invocation: invocationHint(model, goal.id, {
      cwd: ".",
      readOnly: true,
      // `log show` extracts this run's section, so the prompt stays reproducible
      // now that the brief shares a file with the rest of the day.
      prompt: `$(awo log show ${briefRunId})`,
    }),
    tasks: entries,
    unfinished,
  };
}

function buildBrief(
  goalId: string,
  goalBody: string,
  reqBody: string,
  tasks: VerifyTaskEntry[],
  runCount: number
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
    `(${runCount} runs are recorded in logs/index.jsonl if history helps.)`
  );

  return lines.join("\n");
}

export interface GoalVerdictResult {
  goalId: string;
  pass: boolean;
  verifiedTasks: string[];
  filedRequirement: string | null;
}

/**
 * Record the gate's outcome. On PASS the in-review tasks are verified, which rolls
 * the goal up to `done` (§7.4). On GAP the finding becomes a **new requirement**
 * rather than a silent fix, per `file-bug` — the goal is not blocked indefinitely,
 * and the gap re-enters the pipeline as work someone chose to schedule.
 */
export async function runGoalVerdict(
  goalId: string,
  options: {
    cwd?: string;
    pass: boolean;
    summary: string;
    note?: string[];
    model?: string;
  }
): Promise<GoalVerdictResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = (await findGoals(root)).find((g) => g.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);

  const tasks = await findTasksInGoal(goal.dir);
  const state = await readState(goal.dir, goal.id);

  await runLogAdd({
    cwd: root,
    label: `qa-gate-${goalId}`,
    agent: "qa-engineer",
    model: options.model ? [options.model] : [],
    outcome: options.pass ? "success" : "failed",
    summary: `${options.pass ? "PASS" : "GAP"} — ${options.summary}`,
    note: options.note,
  });

  const verified: string[] = [];
  if (options.pass) {
    for (const task of tasks) {
      const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
      if (ts.status !== "in-review") continue;
      await runTaskVerify(task.id, { cwd: root, approve: true });
      verified.push(task.id);
    }
  }

  let filed: string | null = null;
  if (!options.pass) {
    const req = await runReqNew({
      cwd: root,
      title: `Gaps found by the ${goalId} QA gate`,
      source: `qa-engineer via verify-acceptance-criteria on ${goalId}`,
    });
    filed = req.id;
  }

  return { goalId, pass: options.pass, verifiedTasks: verified, filedRequirement: filed };
}
