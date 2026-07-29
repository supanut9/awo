import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, resolvePullRequestMergePolicy } from "../manifest.js";
import { locateTask } from "../tasks.js";
import {
  mutateState,
  newTaskState,
  readState,
  type PullRequestCheckStatus,
  type PullRequestFeedbackState,
  type PullRequestReviewStatus,
  type PullRequestState,
} from "../state.js";
import { runTaskNew } from "./plan.js";

const execFileAsync = promisify(execFile);

interface GhPullRequest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ status?: string | null; conclusion?: string | null }> | null;
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: Array<{ body: string; url: string | null; author: { login: string } | null }> };
}

function repoPath(root: string, repo: string): string {
  return path.join(root, "repos", repo);
}

async function runGh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const failure = err as { stderr?: string; message: string };
    const detail = failure.stderr?.trim() || failure.message;
    throw new Error(`GitHub CLI failed: ${detail}`);
  }
}

function checkStatus(rollup: GhPullRequest["statusCheckRollup"]): PullRequestCheckStatus {
  if (!rollup || rollup.length === 0) return "unknown";
  let pending = false;
  for (const check of rollup) {
    const conclusion = check.conclusion?.toUpperCase();
    if (conclusion && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion)) return "failing";
    if (!conclusion || !["COMPLETED", "SUCCESS"].includes(check.status?.toUpperCase() ?? "")) pending = true;
  }
  return pending ? "pending" : "passing";
}

function reviewStatus(decision: string | null): PullRequestReviewStatus {
  switch (decision?.toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes-requested";
    case "REVIEW_REQUIRED": return "pending";
    default: return "not-required";
  }
}

function snapshot(repo: string, pr: GhPullRequest, feedback: Record<string, PullRequestFeedbackState> = {}): PullRequestState {
  return {
    repo,
    number: pr.number,
    url: pr.url,
    branch: pr.headRefName,
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    mergeState: pr.mergeStateStatus,
    checks: checkStatus(pr.statusCheckRollup),
    reviews: reviewStatus(pr.reviewDecision),
    lastCheckedAt: new Date().toISOString(),
    feedback,
  };
}

async function viewPr(root: string, repo: string, number: number): Promise<PullRequestState> {
  const raw = await runGh(repoPath(root, repo), [
    "pr", "view", String(number),
    "--json", "number,url,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
  ]);
  return snapshot(repo, JSON.parse(raw) as GhPullRequest);
}

async function linkedTask(taskId: string, cwd?: string) {
  const root = findWorkspaceRoot(cwd ?? process.cwd());
  const located = await locateTask(root, taskId);
  const state = await readState(located.goal.dir, located.goal.id);
  const taskState = state.tasks[taskId] ?? newTaskState(located.task.authoredStatus);
  if (!taskState.pullRequest) {
    throw new Error(`${taskId} is not linked to a PR. Use \`awo pr link ${taskId} --repo <repo> --number <n>\`.`);
  }
  return { root, ...located, taskState };
}

export async function runPrLink(options: { taskId: string; repo: string; number: number; cwd?: string }): Promise<PullRequestState> {
  if (!Number.isInteger(options.number) || options.number < 1) throw new Error("--number must be a positive PR number.");
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  if (!manifest.repos.some((entry) => entry.name === options.repo)) {
    throw new Error(`Unknown linked repo "${options.repo}". Use a name from \`awo list\`.`);
  }
  const { task, goal } = await locateTask(root, options.taskId);
  if (!task.targets.includes(options.repo)) {
    throw new Error(`${options.taskId} does not target "${options.repo}"; link a PR only to a repo this task owns.`);
  }
  const pr = await viewPr(root, options.repo, options.number);
  await mutateState(goal.dir, goal.id, (state) => {
    const taskState = (state.tasks[task.id] ??= newTaskState(task.authoredStatus));
    taskState.pullRequest = pr;
  });
  return pr;
}

export async function runPrStatus(taskId: string, options: { cwd?: string } = {}): Promise<PullRequestState> {
  const linked = await linkedTask(taskId, options.cwd);
  const fresh = await viewPr(linked.root, linked.taskState.pullRequest!.repo, linked.taskState.pullRequest!.number);
  await mutateState(linked.goal.dir, linked.goal.id, (state) => {
    const taskState = (state.tasks[taskId] ??= newTaskState(linked.task.authoredStatus));
    fresh.feedback = taskState.pullRequest?.feedback ?? {};
    taskState.pullRequest = fresh;
  });
  return fresh;
}

export interface PreflightResult {
  repo: string;
  authenticated: boolean;
  permission: string;
  defaultBranch: string;
}

export async function runPrPreflight(options: { repo?: string; cwd?: string } = {}): Promise<PreflightResult[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  const repos = options.repo ? manifest.repos.filter((entry) => entry.name === options.repo) : manifest.repos;
  if (repos.length === 0) throw new Error(`Unknown linked repo "${options.repo}".`);
  const results: PreflightResult[] = [];
  for (const repo of repos) {
    await runGh(repoPath(root, repo.name), ["auth", "status"]);
    const raw = await runGh(repoPath(root, repo.name), ["repo", "view", "--json", "nameWithOwner,viewerPermission,defaultBranchRef"]);
    const data = JSON.parse(raw) as { viewerPermission?: string; defaultBranchRef?: { name?: string } | null };
    results.push({
      repo: repo.name,
      authenticated: true,
      permission: data.viewerPermission ?? "UNKNOWN",
      defaultBranch: data.defaultBranchRef?.name ?? "UNKNOWN",
    });
  }
  return results;
}

async function unresolvedThreads(root: string, pr: PullRequestState): Promise<ReviewThread[]> {
  const query = `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated comments(first:1) { nodes { body url author { login } } } } } } } }`;
  const repoName = await runGh(repoPath(root, pr.repo), ["repo", "view", "--json", "nameWithOwner"]);
  const fullName = (JSON.parse(repoName) as { nameWithOwner: string }).nameWithOwner;
  const [owner, name] = fullName.split("/", 2);
  const raw = await runGh(repoPath(root, pr.repo), ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`]);
  const parsed = JSON.parse(raw) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: ReviewThread[] } } } } };
  return (parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved && !thread.isOutdated);
}

export interface ReconcileResult { pr: PullRequestState; createdTaskIds: string[]; unresolved: number; warning: string | null; }

export async function runPrReconcile(taskId: string, options: { cwd?: string } = {}): Promise<ReconcileResult> {
  const linked = await linkedTask(taskId, options.cwd);
  const fresh = await viewPr(linked.root, linked.taskState.pullRequest!.repo, linked.taskState.pullRequest!.number);
  let threads: ReviewThread[] = [];
  let warning: string | null = null;
  try { threads = await unresolvedThreads(linked.root, fresh); }
  catch (err) { warning = `Could not read review threads: ${(err as Error).message}`; }

  const existing = linked.taskState.pullRequest?.feedback ?? {};
  const createdTaskIds: string[] = [];
  for (const thread of threads) {
    if (existing[thread.id]?.taskId) continue;
    const comment = thread.comments.nodes[0];
    const feedbackTask = await runTaskNew({
      cwd: linked.root,
      goal: linked.goal.id,
      name: `Resolve PR #${fresh.number} review feedback`,
      targets: [fresh.repo],
      agent: "software-engineer",
      body: `\n## Objective\nResolve this unresolved GitHub review thread on PR #${fresh.number}.\n\n## Review feedback\n${comment?.body ?? "No comment body returned by GitHub."}\n\n## Steps\n1. Inspect the requested change and affected code.\n2. Implement and test the correction.\n3. Reply and resolve the review thread in GitHub.\n\n## Done when\n- The review concern is addressed with evidence.\n- The GitHub review thread is resolved.\n`,
    });
    createdTaskIds.push(feedbackTask.id);
    existing[thread.id] = {
      id: thread.id, body: comment?.body ?? "", url: comment?.url ?? null,
      author: comment?.author?.login ?? null, resolved: false, taskId: feedbackTask.id,
    };
  }
  if (!warning) {
    for (const [id, feedback] of Object.entries(existing)) {
      const open = threads.some((thread) => thread.id === id);
      feedback.resolved = !open;
    }
  }
  fresh.feedback = existing;
  await mutateState(linked.goal.dir, linked.goal.id, (state) => {
    const taskState = (state.tasks[taskId] ??= newTaskState(linked.task.authoredStatus));
    taskState.pullRequest = fresh;
  });
  return { pr: fresh, createdTaskIds, unresolved: threads.length, warning };
}

export interface FinalizeResult { action: "ready-for-human" | "merged" | "blocked"; reason: string; pr: PullRequestState; }

export async function runPrFinalize(taskId: string, options: { cwd?: string; dryRun?: boolean } = {}): Promise<FinalizeResult> {
  const linked = await linkedTask(taskId, options.cwd);
  const manifest = await readManifest(linked.root);
  // A status rollup cannot tell us whether a non-required review thread is still
  // actionable. Reconcile immediately before finalization so no old snapshot can
  // bypass the feedback loop.
  const reconciled = await runPrReconcile(taskId, { cwd: linked.root });
  const pr = reconciled.pr;
  const policy = resolvePullRequestMergePolicy(manifest);
  if (reconciled.warning) {
    return { action: "blocked", reason: reconciled.warning, pr };
  }
  if (reconciled.unresolved > 0) {
    return { action: "blocked", reason: `${reconciled.unresolved} unresolved GitHub review thread(s) remain.`, pr };
  }
  if (pr.isDraft || pr.mergeState.toUpperCase() !== "CLEAN" || pr.checks !== "passing") {
    return { action: "blocked", reason: `PR is not merge-ready: draft=${pr.isDraft}, mergeState=${pr.mergeState}, checks=${pr.checks}.`, pr };
  }
  if (policy === "human-only") return { action: "ready-for-human", reason: "mergePolicy is human-only; AWO will not approve or merge this PR.", pr };
  const repoInfo = await runGh(repoPath(linked.root, pr.repo), ["repo", "view", "--json", "nameWithOwner"]);
  const fullName = (JSON.parse(repoInfo) as { nameWithOwner: string }).nameWithOwner;
  if (options.dryRun) return { action: "merged", reason: "dry run: authorized maintainer policy would immediately squash-merge this clean PR.", pr };
  // The REST merge endpoint is immediate-or-fail. Unlike a CLI merge flow, it
  // cannot enable auto-merge or place work in a merge queue on this agent's behalf.
  await runGh(repoPath(linked.root, pr.repo), [
    "api", "--method", "PUT", `repos/${fullName}/pulls/${pr.number}/merge`,
    "-f", "merge_method=squash", "-f", `sha=${pr.headSha}`,
  ]);
  return { action: "merged", reason: "immediately squash-merged under authorized-maintainer policy; AWO did not approve the PR.", pr };
}
