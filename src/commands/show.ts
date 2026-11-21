import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import {
  findGoals,
  findTasksInGoal,
  locateGoal,
  type CompletionPolicy,
  type GoalDefinition,
  type TaskDefinition,
} from "../tasks.js";
import {
  newTaskState,
  readState,
  reconcileGoalState,
  TASK_STATUSES,
  type GoalState,
  type GoalStatus,
  type PullRequestState,
  type RunOutcome,
  type TaskState,
  type TaskStatus,
} from "../state.js";
import { evaluateGoalReadiness, type GoalReadiness } from "./readiness.js";
import { findCriteria } from "./intake.js";

/**
 * A governed goal whose work is all in review or done, with no passing verdict.
 *
 * This is the state atlas-sales-crm sat in for weeks — 112 of 129 tasks in review,
 * zero verdicts recorded — while every view described the goal as merely
 * "qa-review" next to dozens of others. Named, so it can be listed and ranked.
 */
export function awaitingVerdict(goal: GoalDefinition, statuses: TaskStatus[], raw: GoalState): boolean {
  if (!goal.completionPolicy.qaRequired) return false;
  const live = statuses.filter((s) => s !== "cancelled");
  if (live.length === 0) return false;
  if (!live.every((s) => s === "in-review" || s === "done")) return false;
  return raw.qa?.verdict !== "pass";
}

/**
 * The status a goal should be reported with. Archived goals report the status
 * frozen when they were filed (`archivedStatus`), so later reconciliation of a
 * moved folder cannot rewrite history; live goals reconcile, and a rollup of
 * `done` still has to pass readiness to be called done.
 */
export async function effectiveGoalStatus(
  root: string,
  goal: GoalDefinition,
  raw: GoalState,
  tasks: TaskDefinition[]
): Promise<GoalStatus> {
  if (goal.archived && raw.archivedStatus) return raw.archivedStatus;
  const status = reconcileGoalState(raw, tasks).state.goalStatus;
  return status === "done" ? (await evaluateGoalReadiness(root, goal, raw, tasks)).status : status;
}

export interface PullRequestSummary {
  repo: string;
  number: number;
  url: string;
  branch: string;
  /** GitHub's state when last observed; null on snapshots taken before 0.8. */
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  merged: boolean;
  mergedAt: string | null;
  checks: string;
  reviews: string;
  lastCheckedAt: string;
}

function summarisePr(pr: PullRequestState): PullRequestSummary {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    branch: pr.branch,
    state: pr.state ?? null,
    merged: pr.merged ?? pr.state === "MERGED",
    mergedAt: pr.mergedAt ?? null,
    checks: pr.checks,
    reviews: pr.reviews,
    lastCheckedAt: pr.lastCheckedAt,
  };
}

/** Every PR linked to a task: the per-repo map plus the legacy single slot. */
export function taskPullRequests(ts: TaskState): PullRequestSummary[] {
  const out: PullRequestSummary[] = [];
  const seen = new Set<string>();
  for (const pr of [...Object.values(ts.pullRequests ?? {}), ...(ts.pullRequest ? [ts.pullRequest] : [])]) {
    const key = `${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(summarisePr(pr));
  }
  return out;
}

export function formatPr(pr: PullRequestSummary): string {
  const state = pr.merged ? "merged" : pr.state ? pr.state.toLowerCase() : "state unknown";
  return `${pr.repo}#${pr.number} ${state}`;
}

export interface TaskWorktreeView {
  repo: string;
  /** Workspace-relative: repos/.worktrees/<repo>/<taskId>. */
  path: string;
  exists: boolean;
  /** The branch checked out there, read from git when the worktree exists. */
  branch: string | null;
}

/** Where `task run` puts each target's checkout, and whether it is still there. */
export async function taskWorktrees(
  root: string,
  task: Pick<TaskDefinition, "id" | "targets">,
  options: { readBranch?: boolean } = {}
): Promise<TaskWorktreeView[]> {
  const out: TaskWorktreeView[] = [];
  for (const repo of task.targets) {
    const rel = path.join("repos", ".worktrees", repo, task.id);
    const abs = path.join(root, rel);
    const exists = await fs.pathExists(abs);
    let branch: string | null = null;
    if (exists && options.readBranch) {
      branch =
        (await simpleGit(abs).revparse(["--abbrev-ref", "HEAD"]).catch(() => ""))
          .trim() || null;
    }
    out.push({ repo, path: rel, exists, branch });
  }
  return out;
}

/** The goal's requirement id and how many acceptance criteria it declares. */
async function requirementOf(goal: GoalDefinition): Promise<{ id: string | null; criteria: number | null }> {
  const goalFm = matter(await fs.readFile(path.join(goal.dir, "goal.md"), "utf8")).data as Record<string, unknown>;
  const declared =
    typeof goalFm.requirementId === "string" && goalFm.requirementId.trim() ? goalFm.requirementId.trim() : null;
  const reqFile = path.join(goal.dir, "requirement.md");
  if (!(await fs.pathExists(reqFile))) return { id: declared, criteria: null };
  const req = matter(await fs.readFile(reqFile, "utf8"));
  const reqFm = req.data as Record<string, unknown>;
  return {
    id: declared ?? (typeof reqFm.id === "string" ? reqFm.id : null),
    criteria: findCriteria(req.content).length,
  };
}

export async function findGoalOrThrow(root: string, goalId: string): Promise<GoalDefinition> {
  const goal = await locateGoal(root, goalId);
  if (goal) return goal;
  const goals = await findGoals(root);
  const live = goals.filter((g) => !g.archived).map((g) => g.id);
  throw new Error(
    goals.length === 0
      ? `Unknown goal "${goalId}". No goals exist yet — \`awo goal new --from <req-id>\`.`
      : `Unknown goal "${goalId}". Live goals: ${live.join(", ") || "none"} (\`awo goal list --all\` for every goal).`
  );
}

export interface GoalShowTask {
  id: string;
  name: string;
  status: TaskStatus;
  lastRunOutcome: RunOutcome | null;
  attempts: number;
  agent: string | null;
  kind: string;
  pullRequests: PullRequestSummary[];
}

export interface GoalShowResult {
  id: string;
  title: string;
  dir: string;
  archived: boolean;
  archivedAt: string | null;
  status: GoalStatus;
  policy: CompletionPolicy;
  requirementId: string | null;
  /** Acceptance criteria in the goal's requirement.md; null when it has none. */
  criteriaCount: number | null;
  deliveryBranch: string | null;
  pullRequestStrategy: GoalDefinition["pullRequestStrategy"];
  awaitingVerdict: boolean;
  readiness: Pick<GoalReadiness, "ready" | "canPassVerdict" | "criteria" | "qa" | "blockers">;
  counts: Record<string, number>;
  total: number;
  tasks: GoalShowTask[];
  pullRequests: (PullRequestSummary & { taskId: string })[];
  worktrees: (TaskWorktreeView & { taskId: string })[];
}

/** §7.2 — one goal, everything a reviewer needs before a verdict, read-only. */
export async function runGoalShow(goalId: string, options: { cwd?: string } = {}): Promise<GoalShowResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const goal = await findGoalOrThrow(root, goalId);
  const tasks = await findTasksInGoal(goal.dir);
  const raw = await readState(goal.dir, goal.id);
  const state = reconcileGoalState(raw, tasks).state;
  const readiness = await evaluateGoalReadiness(root, goal, raw, tasks);

  const counts: Record<string, number> = {};
  const rows: GoalShowTask[] = [];
  const pullRequests: GoalShowResult["pullRequests"] = [];
  const worktrees: GoalShowResult["worktrees"] = [];
  for (const task of tasks) {
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
    counts[ts.status] = (counts[ts.status] ?? 0) + 1;
    const prs = taskPullRequests(ts);
    pullRequests.push(...prs.map((pr) => ({ ...pr, taskId: task.id })));
    for (const wt of await taskWorktrees(root, task)) if (wt.exists) worktrees.push({ ...wt, taskId: task.id });
    rows.push({
      id: task.id,
      name: task.name,
      status: ts.status,
      lastRunOutcome: ts.lastRunOutcome,
      attempts: ts.attempts,
      agent: task.agent,
      kind: task.kind,
      pullRequests: prs,
    });
  }

  const requirement = await requirementOf(goal);
  return {
    id: goal.id,
    title: goal.title,
    dir: path.relative(root, goal.dir),
    archived: goal.archived,
    archivedAt: raw.archivedAt ?? null,
    status: await effectiveGoalStatus(root, goal, raw, tasks),
    policy: goal.completionPolicy,
    requirementId: requirement.id,
    criteriaCount: requirement.criteria,
    deliveryBranch: goal.deliveryBranch,
    pullRequestStrategy: goal.pullRequestStrategy,
    awaitingVerdict: !goal.archived && awaitingVerdict(goal, rows.map((r) => r.status), raw),
    readiness: {
      ready: readiness.ready,
      canPassVerdict: readiness.canPassVerdict,
      criteria: readiness.criteria,
      qa: readiness.qa,
      blockers: readiness.blockers,
    },
    counts,
    total: tasks.length,
    tasks: rows,
    pullRequests,
    worktrees,
  };
}

/** Status counts in lifecycle order, with in-review always shown for a goal that has tasks. */
export function formatStatusCounts(counts: Record<string, number>, total: number): string {
  const parts = TASK_STATUSES.filter((s) => (counts[s] ?? 0) > 0 || (s === "in-review" && total > 0)).map(
    (s) => `${counts[s] ?? 0} ${s === "in-review" ? "in review" : s}`
  );
  return `${total} total${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

export function formatGoalShow(g: GoalShowResult): string {
  const lines: string[] = [];
  lines.push(`${g.id} — ${g.title}`);
  const archived = g.archived ? ` [archived${g.archivedAt ? ` ${g.archivedAt.slice(0, 10)}` : ""}]` : "";
  lines.push(`status:    ${g.status}${g.awaitingVerdict ? " — awaiting a verdict" : ""}${archived}`);
  const policy = [
    g.policy.qaRequired ? "QA verdict required" : null,
    g.policy.acceptanceEvidenceRequired ? "acceptance evidence required" : null,
  ].filter(Boolean);
  lines.push(`policy:    ${policy.length ? policy.join(", ") : "none (task verification only)"}`);
  lines.push(`req:       ${g.requirementId ?? "none"}`);
  if (g.deliveryBranch) lines.push(`delivery:  ${g.pullRequestStrategy} into ${g.deliveryBranch}`);

  const c = g.readiness.criteria;
  lines.push(
    `criteria:  ${
      c
        ? `${c.covered}/${c.total} covered${c.exceptions ? `, ${c.exceptions} accepted exception(s)` : ""}${c.missing ? `, ${c.missing} missing` : ""}`
        : g.policy.acceptanceEvidenceRequired
          ? "unavailable"
          : `${g.criteriaCount ?? 0} declared — coverage not required by policy`
    }`
  );
  if (g.policy.qaRequired) {
    const qa = g.readiness.qa;
    lines.push(
      `qa:        verdict ${qa.verdict ?? "none"}${qa.verdictBy ? ` by ${qa.verdictBy}` : ""} · brief ${qa.briefRunId ?? "none"}`
    );
  }
  const blockers = g.readiness.blockers;
  lines.push(
    `ready:     ${g.readiness.ready ? "yes" : `no — ${blockers.length} blocker(s)`}`
  );
  for (const b of blockers.slice(0, 5)) lines.push(`             ${b.message}`);
  if (blockers.length > 5) lines.push(`             … ${blockers.length - 5} more — \`awo goal readiness ${g.id}\``);

  lines.push(`tasks:     ${formatStatusCounts(g.counts, g.total)}`);
  for (const t of g.tasks) {
    const prs = t.pullRequests.map(formatPr).join(", ");
    lines.push(`  ${t.id}\t${t.status}${t.lastRunOutcome ? ` (last run: ${t.lastRunOutcome})` : ""}\t${prs || "—"}\t${t.name}`);
  }
  if (g.pullRequests.length > 0) {
    const merged = g.pullRequests.filter((p) => p.merged).length;
    lines.push(`PRs:       ${g.pullRequests.length} linked, ${merged} merged`);
  }
  if (g.worktrees.length > 0) {
    lines.push(`worktrees: ${g.worktrees.length} on disk — ${g.worktrees.slice(0, 5).map((w) => w.path).join(", ")}${g.worktrees.length > 5 ? ", …" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Governed goals ready for a human's call: every task in review or done, no
 * passing verdict. `awo goal list --needs-verdict`.
 */
export async function findGoalsNeedingVerdict(
  root: string,
  options: { includeArchived?: boolean } = {}
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const goal of await findGoals(root, { includeArchived: options.includeArchived ?? false })) {
    if (!goal.completionPolicy.qaRequired || goal.archived) continue;
    const tasks = await findTasksInGoal(goal.dir);
    const raw = await readState(goal.dir, goal.id);
    const state = reconcileGoalState(raw, tasks).state;
    const statuses = tasks.map((t) => (state.tasks[t.id] ?? newTaskState(t.authoredStatus)).status);
    if (awaitingVerdict(goal, statuses, raw)) out.add(goal.id);
  }
  return out;
}
