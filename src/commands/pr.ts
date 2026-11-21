import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { findRepo, readManifest, resolveRepoMergePolicy, type Manifest, type RepoEntry } from "../manifest.js";
import {
  findGoals,
  findTasksInGoal,
  locateTask,
  type GoalDefinition,
  type TaskDefinition,
} from "../tasks.js";
import {
  applyTransition,
  mutateState,
  newTaskState,
  readState,
  type GoalState,
  type PullRequestCheckStatus,
  type PullRequestFeedbackState,
  type PullRequestReviewStatus,
  type PullRequestState,
  type TaskState,
  type TaskStatus,
} from "../state.js";
import { redactSecrets } from "../redact.js";
import { retireQa } from "../qa-history.js";
import { runTaskNew } from "./plan.js";

const execFileAsync = promisify(execFile);

interface GhCheck {
  /** Check runs carry `name`; commit statuses (StatusContext) carry `context`. */
  name?: string | null;
  context?: string | null;
  status?: string | null;
  conclusion?: string | null;
  /** StatusContext only: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED. */
  state?: string | null;
}

interface GhPullRequest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reviewDecision: string | null;
  statusCheckRollup: GhCheck[] | null;
  state?: string | null;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
}

const PR_FIELDS =
  "number,url,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,state,mergedAt,mergeCommit";

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    nodes: Array<{
      body: string;
      url: string | null;
      author: { login: string; __typename?: string } | null;
    }>;
  };
}

function repoPath(root: string, repo: string): string {
  return path.join(root, "repos", repo);
}

/** Where, and as whom, one `gh` call runs. */
interface GhTarget {
  cwd: string;
  /** Set only when a repo's account is reached through its stored token (GH_TOKEN). */
  env?: NodeJS.ProcessEnv;
}

async function runGh(target: GhTarget, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: target.cwd,
      env: target.env ?? process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const failure = err as { stderr?: string; message: string };
    const detail = failure.stderr?.trim() || failure.message;
    // Defence in depth: gh does not echo GH_TOKEN, but a token must never ride out in a message.
    throw new Error(`GitHub CLI failed: ${redactSecrets(detail)}`);
  }
}

/**
 * §18.4 — act as the right GitHub identity, without touching the global one.
 *
 * `gh` holds one active account per host. So a workspace on a personal account whose
 * working repos belong to a company will, sooner or later, run `gh pr` as the wrong
 * person — and an assignment, a review or a merge attributed to the wrong identity in
 * a company repo is not something you can quietly undo.
 *
 * 0.7 refused and told you to `gh auth switch`, which flips the account for every
 * other terminal and agent on the machine as well — two workspaces on different
 * accounts then take turns breaking each other. gh already stores a token per
 * logged-in account, so awo reads that account's token and hands it to its OWN `gh`
 * calls as GH_TOKEN. It refuses only when no such token exists. The token is never
 * printed, logged or put in an error message.
 */
export interface GhIdentity extends GhTarget {
  repo: string;
  /** The account the repo declares (`githubAccount`), if any. */
  required: string | null;
  /** The globally active gh account, when it was read. */
  active: string | null;
  /** How the required account is reached. Null when the repo declares none. */
  via: "active" | "stored-token" | null;
}

async function ghLogin(target: GhTarget): Promise<string | null> {
  const raw = await runGh(target, ["api", "user", "--jq", ".login"]).catch(() => "");
  return raw.trim() || null;
}

/** Every failure is swallowed whole: the token is on stdout and must never reach a message. */
async function storedToken(cwd: string, account: string): Promise<string | null> {
  const env = { ...process.env };
  // An inherited token would make gh answer with IT instead of the stored one.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    delete env[name];
  }
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--user", account], { cwd, env });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGithubIdentity(
  root: string,
  repo: string,
  required: string | undefined
): Promise<GhIdentity> {
  const cwd = repoPath(root, repo);
  if (!required) return { repo, cwd, required: null, active: null, via: null };
  const active = await ghLogin({ cwd });
  if (active === required) return { repo, cwd, required, active, via: "active" };

  const token = await storedToken(cwd, required);
  if (token) {
    const env = { ...process.env, GH_TOKEN: token };
    // Trust, but confirm: act with the token only once GitHub says it IS that account.
    if ((await ghLogin({ cwd, env })) === required) {
      return { repo, cwd, env, required, active, via: "stored-token" };
    }
  }
  throw new Error(
    `${repo} must be acted on as "${required}", but gh is active as "${active ?? "unknown"}" ` +
      `and no stored gh token for "${required}" could be read.\n` +
      `  Log in once as ${required}:  gh auth login\n` +
      `  (gh keeps every logged-in account; awo then uses ${required}'s token for ${repo}\n` +
      `   without switching your active account. Declared as githubAccount on ${repo} in\n` +
      `   .workspace/manifest.json — awo refuses rather than open a PR as the wrong person,\n` +
      `   which is not undoable.)`
  );
}

const PASSING_CONCLUSIONS = ["SUCCESS", "SKIPPED", "NEUTRAL"];

type CheckOutcome = "passing" | "failing" | "pending";

function checkName(check: GhCheck): string {
  return check.name ?? check.context ?? "(unnamed)";
}

function checkOutcome(check: GhCheck): CheckOutcome {
  const conclusion = check.conclusion?.toUpperCase();
  if (conclusion && !PASSING_CONCLUSIONS.includes(conclusion)) return "failing";
  if (conclusion && ["COMPLETED", "SUCCESS"].includes(check.status?.toUpperCase() ?? "")) return "passing";
  // Commit statuses report only `state`. Reading status/conclusion alone left every
  // one of them "pending" forever, so a repo whose CI posts statuses never merged.
  const state = conclusion ? undefined : check.state?.toUpperCase();
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  return "pending";
}

function checkStatus(rollup: GhPullRequest["statusCheckRollup"]): PullRequestCheckStatus {
  if (!rollup || rollup.length === 0) return "unknown";
  const outcomes = rollup.map(checkOutcome);
  if (outcomes.includes("failing")) return "failing";
  return outcomes.includes("pending") ? "pending" : "passing";
}

function reviewStatus(decision: string | null): PullRequestReviewStatus {
  switch (decision?.toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes-requested";
    case "REVIEW_REQUIRED": return "pending";
    default: return "not-required";
  }
}

function prState(raw: string | null | undefined): PullRequestState["state"] {
  const value = raw?.toUpperCase();
  return value === "OPEN" || value === "MERGED" || value === "CLOSED" ? value : undefined;
}

function snapshot(repo: string, pr: GhPullRequest, feedback: Record<string, PullRequestFeedbackState> = {}): PullRequestState {
  const merged = prState(pr.state) === "MERGED" || Boolean(pr.mergedAt);
  const state = prState(pr.state) ?? (merged ? "MERGED" : undefined);
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
    ...(state ? { state } : {}),
    merged,
    mergedAt: pr.mergedAt ?? null,
    mergeCommit: pr.mergeCommit?.oid ?? null,
  };
}

interface PrView {
  pr: PullRequestState;
  /** Per-check outcomes, for `requiredChecks` — the snapshot only keeps the rollup. */
  checks: Array<{ name: string; outcome: CheckOutcome }>;
}

async function viewPr(gh: GhIdentity, number: number): Promise<PrView> {
  const raw = JSON.parse(
    await runGh(gh, ["pr", "view", String(number), "--json", PR_FIELDS])
  ) as GhPullRequest;
  return {
    pr: snapshot(gh.repo, raw),
    checks: (raw.statusCheckRollup ?? []).map((c) => ({ name: checkName(c), outcome: checkOutcome(c) })),
  };
}

/**
 * One command's view of GitHub. A goal-branch PR is linked to many tasks (atlas-shop
 * links one PR to a whole goal), so identities, PR reads and review threads are
 * fetched once per repo / PR per command, not once per task.
 */
interface PrContext {
  root: string;
  manifest: Manifest;
  identities: Map<string, Promise<GhIdentity>>;
  views: Map<string, Promise<PrView>>;
  threads: Map<string, Promise<ThreadScan>>;
  fullNames: Map<string, Promise<string>>;
}

async function prContext(cwd?: string): Promise<PrContext> {
  const root = findWorkspaceRoot(cwd ?? process.cwd());
  return {
    root,
    manifest: await readManifest(root),
    identities: new Map(),
    views: new Map(),
    threads: new Map(),
    fullNames: new Map(),
  };
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = map.get(key);
  if (!hit) {
    hit = load();
    map.set(key, hit);
  }
  return hit;
}

function identityFor(ctx: PrContext, repo: string): Promise<GhIdentity> {
  return cached(ctx.identities, repo, () =>
    resolveGithubIdentity(ctx.root, repo, findRepo(ctx.manifest, repo)?.githubAccount)
  );
}

function viewFor(ctx: PrContext, repo: string, number: number): Promise<PrView> {
  return cached(ctx.views, `${repo}#${number}`, async () => viewPr(await identityFor(ctx, repo), number));
}

function fullNameFor(ctx: PrContext, repo: string): Promise<string> {
  return cached(ctx.fullNames, repo, async () => {
    const raw = await runGh(await identityFor(ctx, repo), ["repo", "view", "--json", "nameWithOwner"]);
    return (JSON.parse(raw) as { nameWithOwner: string }).nameWithOwner;
  });
}

/** Every PR linked to a task, by repo. State written before 0.8 has only `pullRequest`. */
export function linkedPullRequests(ts: TaskState | undefined): Record<string, PullRequestState> {
  if (!ts) return {};
  const map: Record<string, PullRequestState> = { ...(ts.pullRequests ?? {}) };
  if (ts.pullRequest && !map[ts.pullRequest.repo]) map[ts.pullRequest.repo] = ts.pullRequest;
  return map;
}

/**
 * Store a fresh snapshot in `pullRequests[repo]`, keeping `pullRequest` as the most
 * recently LINKED one so pre-0.8 readers still see a PR. Measured in the real
 * workspaces: 5 PR links were overwritten, because a task had exactly one PR slot.
 */
function storeSnapshot(ts: TaskState, fresh: PullRequestState, link = false): PullRequestState {
  const previous = linkedPullRequests(ts)[fresh.repo];
  // The thread → repair-task map belongs to one PR; a different PR in that repo starts clean.
  const pr: PullRequestState = {
    ...fresh,
    feedback: previous?.number === fresh.number ? { ...(previous.feedback ?? {}) } : {},
  };
  ts.pullRequests = { ...linkedPullRequests(ts), [pr.repo]: pr };
  if (link || !ts.pullRequest || ts.pullRequest.repo === pr.repo) ts.pullRequest = pr;
  return pr;
}

/** Apply a change to both stored copies of one repo's snapshot. */
function updateStored(ts: TaskState, repo: string, change: (pr: PullRequestState) => void): void {
  if (ts.pullRequests?.[repo]) change(ts.pullRequests[repo]);
  if (ts.pullRequest?.repo === repo && ts.pullRequest !== ts.pullRequests?.[repo]) change(ts.pullRequest);
}

function prRefs(prs: PullRequestState[]): string {
  return prs.map((p) => `${p.repo}#${p.number}`).join(", ");
}

/**
 * F6 — a merged PR is the end of the work it carries.
 *
 * Measured in atlas-sales-crm: 112 of 129 tasks sat in `in-review` (median 15 days),
 * and a merged PR never moved one of them. So once every PR linked to a task has
 * merged, the task moves in-review -> done. A governed goal is
 * the exception: its tasks finish together on the goal verdict, so the task stays in
 * review and only the snapshot says merged. A task that is not in review — still
 * running, say — is never moved: a merge on GitHub does not close an awo run.
 */
function settleMergedTask(
  state: GoalState,
  task: TaskDefinition,
  goal: GoalDefinition,
  ts: TaskState,
  dryRun = false
): { moved: boolean; note: string | null } {
  const prs = Object.values(linkedPullRequests(ts));
  const merged = prs.filter((p) => p.merged);
  if (merged.length === 0) {
    const closed = prs.filter((p) => p.state === "CLOSED");
    return { moved: false, note: closed.length > 0 ? `closed without merging: ${prRefs(closed)}` : null };
  }
  const waiting = prs.filter((p) => !p.merged);
  if (waiting.length > 0) {
    return { moved: false, note: `merged ${prRefs(merged)}; ${task.id} still waits on ${prRefs(waiting)}` };
  }
  const reason = `${merged.map((p) => `PR #${p.number}`).join(", ")} merged`;
  if (ts.status === "done") return { moved: false, note: null };
  if (ts.status !== "in-review") {
    const next =
      ts.status === "running" ? ` — finish the run first: awo task complete ${task.id} --outcome success` : "";
    return { moved: false, note: `${reason}, but ${task.id} is ${ts.status}, so it was not moved${next}` };
  }
  if (goal.completionPolicy.qaRequired) {
    return {
      moved: false,
      note: `${reason}; ${goal.id} is governed, so ${task.id} stays in review until \`awo goal verdict ${goal.id}\``,
    };
  }
  if (dryRun) return { moved: false, note: `${reason} — would move ${task.id} in-review -> done` };
  moveToDoneOnMerge(state, task, ts, reason);
  return { moved: true, note: `${reason} — ${task.id} moved in-review -> done` };
}

/**
 * The one lifecycle write this module makes: a merged PR is an external fact, so
 * it moves the task as `qa` — through the same audited transition every other
 * lifecycle move uses, so the board's history says why it became done.
 */
function moveToDoneOnMerge(state: GoalState, task: TaskDefinition, ts: TaskState, reason: string): void {
  state.tasks[task.id] = ts;
  applyTransition(state, task.id, "done", "qa", { reason, authoredStatus: task.authoredStatus });
  retireQa(state, `${task.id} done: ${reason}`);
}

/** A task and the linked PRs one command acts on. */
interface TaskPrs {
  task: TaskDefinition;
  goal: GoalDefinition;
  prs: PullRequestState[];
}

function byRepo(prs: PullRequestState[]): PullRequestState[] {
  return [...prs].sort((a, b) => a.repo.localeCompare(b.repo));
}

async function taskPrs(ctx: PrContext, taskId: string, repo?: string): Promise<TaskPrs & { ts: TaskState }> {
  const { task, goal } = await locateTask(ctx.root, taskId);
  const state = await readState(goal.dir, goal.id);
  const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
  const linked = linkedPullRequests(ts);
  if (Object.keys(linked).length === 0) {
    throw new Error(
      `${taskId} is not linked to a PR. Use \`awo pr link ${taskId}\` (infers --repo and --number), ` +
        `or \`awo pr link ${taskId} --repo <repo> --number <n>\`.`
    );
  }
  if (repo) {
    if (!linked[repo]) {
      throw new Error(
        `${taskId} has no PR linked in "${repo}" (linked: ${Object.keys(linked).join(", ")}).\n` +
          `  Link one:  awo pr link ${taskId} --repo ${repo} --number <n>`
      );
    }
    return { task, goal, ts, prs: [linked[repo]] };
  }
  return { task, goal, ts, prs: byRepo(Object.values(linked)) };
}

/** `--all`: every task with a linked PR in a live (non-archived) goal. */
async function liveLinkedTasks(ctx: PrContext, repo?: string): Promise<TaskPrs[]> {
  const out: TaskPrs[] = [];
  for (const goal of await findGoals(ctx.root, { includeArchived: false })) {
    const state = await readState(goal.dir, goal.id);
    if (state.archivedStatus) continue;
    for (const task of await findTasksInGoal(goal.dir)) {
      const prs = Object.values(linkedPullRequests(state.tasks[task.id])).filter((p) => !repo || p.repo === repo);
      if (prs.length > 0) out.push({ task, goal, prs: byRepo(prs) });
    }
  }
  return out;
}

/**
 * §18 — a PR should say whose it is and what it belongs to.
 *
 * Labels are applied ONLY if the repository already has them. awo never creates
 * one: a label is shared project vocabulary, and letting every task invent its own
 * is how a label list becomes forty near-duplicates that nobody can filter by.
 * Anything unavailable is reported by name rather than silently dropped — a label
 * you thought was applied is worse than one you know was not.
 */
export interface PrMetadataResult {
  assignee: string | null;
  applied: string[];
  /** Requested but absent from the repo, with the reason stated to the caller. */
  unavailable: string[];
  /** True when the PR body/title never mentions the task it is linked to. */
  titleMissingTask: boolean;
}

async function repoLabels(gh: GhIdentity): Promise<Set<string>> {
  const raw = await runGh(gh, ["label", "list", "--limit", "200", "--json", "name"]).catch(() => "[]");
  const parsed = JSON.parse(raw || "[]") as { name: string }[];
  return new Set(parsed.map((l) => l.name));
}

/**
 * Put the task's identity on its PR: assignee, labels, and a check that the PR
 * actually references the task. `reference` is the id the PR should mention — the
 * task, or the goal for a goal-branch PR.
 */
export async function applyPrMetadata(
  gh: GhIdentity,
  number: number,
  reference: string,
  options: { taskLabels: string[]; policyLabels: string[]; assignee?: string; dryRun?: boolean } = {
    taskLabels: [],
    policyLabels: [],
  }
): Promise<PrMetadataResult> {
  const available = await repoLabels(gh);

  // Task labels first, then project-wide ones; de-duplicated, order preserved so a
  // task's own vocabulary reads first on the PR.
  const wanted = [...new Set([...options.taskLabels, ...options.policyLabels])];
  const applied = wanted.filter((l) => available.has(l));
  const unavailable = wanted.filter((l) => !available.has(l));

  // With an injected token this is the repo's declared account, not the active one.
  const assignee = options.assignee ?? (await ghLogin(gh));

  // Does the PR mention the task at all? A PR that does not name its task cannot be
  // traced back from GitHub, which is the only place a reviewer is looking.
  const view = JSON.parse(
    await runGh(gh, ["pr", "view", String(number), "--json", "title,body"]).catch(() => "{}")
  ) as { title?: string; body?: string };
  const titleMissingTask = !`${view.title ?? ""}\n${view.body ?? ""}`.includes(reference);

  if (!options.dryRun && (applied.length > 0 || assignee)) {
    const args = ["pr", "edit", String(number)];
    for (const l of applied) args.push("--add-label", l);
    if (assignee) args.push("--add-assignee", assignee);
    await runGh(gh, args);
  }

  return { assignee, applied, unavailable, titleMissingTask };
}

/** Re-apply assignee and labels to the task's linked PR(s); `repo` selects one. */
export async function runPrMeta(
  taskId: string,
  options: { cwd?: string; dryRun?: boolean; label?: string[]; assignee?: string; repo?: string } = {}
): Promise<Array<PrMetadataResult & { repo: string; number: number }>> {
  const ctx = await prContext(options.cwd);
  const { task, prs } = await taskPrs(ctx, taskId, options.repo);
  const results: Array<PrMetadataResult & { repo: string; number: number }> = [];
  for (const pr of prs) {
    const result = await applyPrMetadata(await identityFor(ctx, pr.repo), pr.number, taskId, {
      taskLabels: [...task.labels, ...(options.label ?? [])],
      policyLabels: ctx.manifest.pullRequests?.labels ?? [],
      assignee: options.assignee ?? ctx.manifest.pullRequests?.assignee,
      dryRun: options.dryRun,
    });
    results.push({ ...result, repo: pr.repo, number: pr.number });
  }
  return results;
}

/** What one `pr link` acts on: a single task, or every live task of a goal on one repo. */
interface LinkScope {
  repo: string;
  goal: GoalDefinition;
  tasks: TaskDefinition[];
  /** The head branch to search when `--number` is omitted. */
  branch: string | null;
  /** The id the PR should mention: the task, or the goal for a goal-branch PR. */
  reference: string;
  labels: string[];
  /** The command to repeat with an explicit `--number`, for messages. */
  retry: string;
}

function assertKnownRepo(manifest: Manifest, repo: string): void {
  if (!findRepo(manifest, repo)) {
    throw new Error(`Unknown linked repo "${repo}". Use a name from \`awo list\`.`);
  }
}

async function taskLinkScope(ctx: PrContext, taskId: string, repo?: string): Promise<LinkScope> {
  const { task, goal } = await locateTask(ctx.root, taskId);
  let chosen = repo;
  if (!chosen) {
    if (task.targets.length !== 1) {
      throw new Error(
        task.targets.length === 0
          ? `${taskId} has no targets, so there is no repo to link a PR in.`
          : `${taskId} targets ${task.targets.join(", ")}; say which repo the PR is in:\n` +
              `  awo pr link ${taskId} --repo <${task.targets.join("|")}>`
      );
    }
    chosen = task.targets[0];
  }
  assertKnownRepo(ctx.manifest, chosen);
  if (!task.targets.includes(chosen)) {
    throw new Error(`${taskId} does not target "${chosen}"; link a PR only to a repo this task owns.`);
  }
  const branch =
    goal.pullRequestStrategy === "goal-branch" && goal.deliveryBranch ? goal.deliveryBranch : `feature/${task.id}`;
  return {
    repo: chosen,
    goal,
    tasks: [task],
    branch,
    reference: task.id,
    labels: task.labels,
    retry: `awo pr link ${taskId} --repo ${chosen}`,
  };
}

async function goalLinkScope(ctx: PrContext, goalId: string, repo?: string): Promise<LinkScope> {
  const goals = await findGoals(ctx.root);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    throw new Error(`Unknown goal "${goalId}". Known goals: ${goals.map((g) => g.id).join(", ") || "none"}.`);
  }
  if (goal.archived) {
    throw new Error(`${goalId} is archived; restore it before linking work to it:  awo goal restore ${goalId}`);
  }
  const state = await readState(goal.dir, goal.id);
  const live = (await findTasksInGoal(goal.dir)).filter(
    (t) => (state.tasks[t.id]?.status ?? t.authoredStatus) !== "cancelled"
  );
  let chosen = repo;
  if (!chosen) {
    const repos = [...new Set(live.flatMap((t) => t.targets))].sort();
    if (repos.length !== 1) {
      throw new Error(
        repos.length === 0
          ? `${goalId} has no live task that targets a repo.`
          : `${goalId}'s tasks target ${repos.join(", ")}; say which repo the PR is in:\n` +
              `  awo pr link --goal ${goalId} --repo <${repos.join("|")}>`
      );
    }
    chosen = repos[0];
  }
  assertKnownRepo(ctx.manifest, chosen);
  const tasks = live.filter((t) => t.targets.includes(chosen!));
  if (tasks.length === 0) throw new Error(`No live task of ${goalId} targets "${chosen}".`);
  return {
    repo: chosen,
    goal,
    tasks,
    branch: goal.deliveryBranch,
    reference: goal.id,
    labels: [...new Set(tasks.flatMap((t) => t.labels))],
    retry: `awo pr link --goal ${goalId} --repo ${chosen}`,
  };
}

/**
 * F8 — a required option awo can work out is a retry loop for every agent. The
 * branch a task's PR comes from is known (`feature/<task>`, or the goal's delivery
 * branch), so ask GitHub which PR has it as its head. Merged ones count, so a PR
 * can still be linked after the fact.
 */
async function inferPrNumber(gh: GhIdentity, scope: LinkScope): Promise<number> {
  if (!scope.branch) {
    throw new Error(
      `${scope.goal.id} declares no deliveryBranch, so its PR cannot be inferred.\n  ${scope.retry} --number <n>`
    );
  }
  const raw = await runGh(gh, ["pr", "list", "--head", scope.branch, "--state", "all", "--json", "number,state"]);
  const found = JSON.parse(raw || "[]") as Array<{ number: number; state?: string }>;
  const open = found.filter((p) => prState(p.state) === "OPEN");
  const merged = found.filter((p) => prState(p.state) === "MERGED");
  if (open.length === 1) return open[0].number;
  if (open.length === 0 && merged.length === 1) return merged[0].number;
  if (found.length === 0) {
    throw new Error(
      `No PR in ${gh.repo} has head branch "${scope.branch}". Open one first ` +
        `(gh pr create --head ${scope.branch}), or name it:\n  ${scope.retry} --number <n>`
    );
  }
  const listed = found.map((p) => `#${p.number} (${p.state ?? "unknown"})`).join(", ");
  throw new Error(
    `Cannot tell which PR in ${gh.repo} to link for head branch "${scope.branch}": ${listed}.\n` +
      `  ${scope.retry} --number <n>`
  );
}

export interface PrLinkResult {
  repo: string;
  number: number;
  url: string;
  /** The head branch searched when `--number` was omitted. */
  inferredFrom: string | null;
  /** One row per task the PR is now linked to, after the immediate refresh. */
  linked: Array<{ taskId: string; taskStatus: TaskStatus; movedToDone: boolean; note: string | null }>;
  pr: PullRequestState;
  metadata?: PrMetadataResult;
}

export async function runPrLink(options: {
  taskId?: string;
  /** Link the PR to every live task of this goal that targets the repo (goal-branch delivery). */
  goal?: string;
  repo?: string;
  number?: number;
  cwd?: string;
  /** Skip assignee/label application. Linking still records the PR. */
  noMeta?: boolean;
}): Promise<PrLinkResult> {
  if (options.number !== undefined && (!Number.isInteger(options.number) || options.number < 1)) {
    throw new Error("--number must be a positive PR number.");
  }
  if (options.taskId && options.goal) throw new Error("Give a task id or --goal <goalId>, not both.");
  if (!options.taskId && !options.goal) {
    throw new Error(
      "Name what the PR implements:  awo pr link <taskId>\n" +
        "  or, for one goal-branch PR covering a whole goal:  awo pr link --goal <goalId> --repo <repo>"
    );
  }
  const ctx = await prContext(options.cwd);
  const scope = options.goal
    ? await goalLinkScope(ctx, options.goal, options.repo)
    : await taskLinkScope(ctx, options.taskId!, options.repo);
  const gh = await identityFor(ctx, scope.repo);
  const number = options.number ?? (await inferPrNumber(gh, scope));
  const view = await viewPr(gh, number);

  // Linking IS a refresh: the snapshot and a merge's consequence land in one write.
  const linked: PrLinkResult["linked"] = [];
  await mutateState(scope.goal.dir, scope.goal.id, (state) => {
    for (const task of scope.tasks) {
      const ts = (state.tasks[task.id] ??= newTaskState(task.authoredStatus));
      storeSnapshot(ts, view.pr, true);
      const settled = settleMergedTask(state, task, scope.goal, ts);
      linked.push({ taskId: task.id, taskStatus: ts.status, movedToDone: settled.moved, note: settled.note });
    }
  });

  const result: PrLinkResult = {
    repo: scope.repo,
    number,
    url: view.pr.url,
    inferredFrom: options.number === undefined ? scope.branch : null,
    linked,
    pr: view.pr,
  };
  if (options.noMeta) return result;

  // Applied at link time, because that is the moment the PR and the task become one
  // thing. Failing to label must not lose the link, though — the state write above
  // is the part that matters, so a metadata failure is reported, not thrown.
  result.metadata = await applyPrMetadata(gh, number, scope.reference, {
    taskLabels: scope.labels,
    policyLabels: ctx.manifest.pullRequests?.labels ?? [],
    assignee: ctx.manifest.pullRequests?.assignee,
  }).catch(() => undefined);
  return result;
}

async function selectTargets(
  ctx: PrContext,
  command: string,
  taskId: string | undefined,
  options: { all?: boolean; repo?: string }
): Promise<TaskPrs[]> {
  if (taskId && options.all) throw new Error("Give a task id or --all, not both.");
  if (options.all) return liveLinkedTasks(ctx, options.repo);
  if (!taskId) {
    throw new Error(`Name a task, or use --all for every linked PR in live goals:  awo pr ${command} --all`);
  }
  const target = await taskPrs(ctx, taskId, options.repo);
  // One task: a wrong-identity repo is a refusal, exactly as before, not a table row.
  for (const pr of target.prs) await identityFor(ctx, pr.repo);
  return [target];
}

/**
 * Refresh linked PRs: one task (all its PRs, or `repo`), or `all` — every linked PR
 * in live goals. A merged PR settles its task (see settleMergedTask).
 */
export async function runPrStatus(
  taskId: string | undefined,
  options: { cwd?: string; all?: boolean; repo?: string } = {}
): Promise<PrSyncRow[]> {
  const ctx = await prContext(options.cwd);
  const rows: PrSyncRow[] = [];
  for (const target of await selectTargets(ctx, "status", taskId, options)) {
    rows.push(...(await syncTask(ctx, target, { reuseMerged: options.all })));
  }
  return rows;
}

export interface PreflightResult {
  /** The account this repo must be acted on as, when it declares one. */
  requiredAccount?: string;
  activeAccount?: string;
  /** How the required account is reached: already active, or through its stored token. */
  accountVia?: "active" | "stored-token";
  /** Why the required account cannot be used (no stored token). */
  accountError?: string;
  repo: string;
  authenticated: boolean;
  permission: string;
  defaultBranch: string;
}

export async function runPrPreflight(options: { repo?: string; cwd?: string } = {}): Promise<PreflightResult[]> {
  const ctx = await prContext(options.cwd);
  const repos = options.repo ? ctx.manifest.repos.filter((entry) => entry.name === options.repo) : ctx.manifest.repos;
  if (repos.length === 0) throw new Error(`Unknown linked repo "${options.repo}".`);
  const results: PreflightResult[] = [];
  for (const repo of repos) {
    // Reported, not enforced: preflight exists to tell you the state of things, and a
    // diagnostic that throws on the first repo cannot report the other eight.
    let identity: GhIdentity | null = null;
    let accountError: string | undefined;
    try {
      identity = await identityFor(ctx, repo.name);
    } catch (err) {
      accountError = (err as Error).message;
    }
    const target: GhTarget = identity ?? { cwd: repoPath(ctx.root, repo.name) };
    await runGh(target, ["auth", "status"]);
    const raw = await runGh(target, ["repo", "view", "--json", "nameWithOwner,viewerPermission,defaultBranchRef"]);
    const data = JSON.parse(raw) as { viewerPermission?: string; defaultBranchRef?: { name?: string } | null };
    const active = identity?.active ?? (await ghLogin({ cwd: target.cwd }));

    results.push({
      repo: repo.name,
      authenticated: true,
      permission: data.viewerPermission ?? "UNKNOWN",
      defaultBranch: data.defaultBranchRef?.name ?? "UNKNOWN",
      ...(repo.githubAccount ? { requiredAccount: repo.githubAccount } : {}),
      ...(active ? { activeAccount: active } : {}),
      ...(identity?.via ? { accountVia: identity.via } : {}),
      ...(accountError ? { accountError } : {}),
    });
  }
  return results;
}

const THREADS_QUERY =
  "query($owner:String!, $name:String!, $number:Int!, $cursor:String) { repository(owner:$owner, name:$name) { " +
  "pullRequest(number:$number) { reviewThreads(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } " +
  "nodes { id isResolved isOutdated comments(first:1) { nodes { body url author { login __typename } } } } } } } }";

/** 5,000 threads. A PR past that is not one awo should be guessing about. */
const MAX_THREAD_PAGES = 50;

interface ThreadScan {
  /** Every open (unresolved, not outdated) thread, bots included — resolution is read from this. */
  openIds: Set<string>;
  /** Open threads a person asked for, which become repair work. */
  actionable: ReviewThread[];
  /** Open threads by bots or `pullRequests.ignoreAuthors`. */
  skipped: number;
}

/** Every review thread, page by page. 0.7 read only the first 100 and called the rest resolved. */
async function reviewThreads(ctx: PrContext, pr: PullRequestState): Promise<ReviewThread[]> {
  const gh = await identityFor(ctx, pr.repo);
  const [owner, name] = (await fullNameFor(ctx, pr.repo)).split("/", 2);
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const args = [
      "api", "graphql", "-f", `query=${THREADS_QUERY}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const parsed = JSON.parse(await runGh(gh, args)) as {
      errors?: Array<{ message: string }>;
      data?: { repository?: { pullRequest?: { reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: ReviewThread[];
      } } } };
    };
    if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join("; "));
    const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
    threads.push(...(connection?.nodes ?? []));
    const next = connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
    if (!next || next === cursor) return threads;
    cursor = next;
  }
  throw new Error(`${pr.repo}#${pr.number} has more than ${MAX_THREAD_PAGES * 100} review threads; not guessing which are open.`);
}

function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * An automated reviewer's comment is not a person's request for a change, and each
 * one used to become its own repair task. GraphQL reports a bot's login WITHOUT the
 * `[bot]` suffix REST shows, so the actor type is checked as well as the suffix.
 */
function isIgnoredAuthor(
  author: { login: string; __typename?: string } | null | undefined,
  ignore: Set<string>
): boolean {
  if (!author) return false;
  if (author.__typename === "Bot" || author.login.toLowerCase().endsWith("[bot]")) return true;
  return ignore.has(normalizeLogin(author.login));
}

function scanFor(ctx: PrContext, pr: PullRequestState): Promise<ThreadScan> {
  return cached(ctx.threads, `${pr.repo}#${pr.number}`, async () => {
    const listed = ctx.manifest.pullRequests?.ignoreAuthors;
    const ignore = new Set((Array.isArray(listed) ? listed : []).map((l) => normalizeLogin(String(l))));
    const open = (await reviewThreads(ctx, pr)).filter((t) => !t.isResolved && !t.isOutdated);
    const actionable = open.filter((t) => !isIgnoredAuthor(t.comments.nodes[0]?.author, ignore));
    return { openIds: new Set(open.map((t) => t.id)), actionable, skipped: open.length - actionable.length };
  });
}

/** Written into every repair task, so a retry can find what an interrupted pass created. */
const REPAIR_MARKER = /<!-- awo:pr-repair repo=(\S+) pr=(\d+) threads=(\S+) -->/;

/** thread id -> repair task id, read from the goal's task files. */
async function repairTasksFor(goal: GoalDefinition, repo: string, number: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const task of await findTasksInGoal(goal.dir)) {
    const m = REPAIR_MARKER.exec(task.body);
    if (!m || m[1] !== repo || Number(m[2]) !== number) continue;
    for (const id of m[3].split(",")) if (!map.has(id)) map.set(id, task.id);
  }
  return map;
}

function firstLine(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "(empty comment)";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

async function createRepairTask(
  ctx: PrContext,
  goal: GoalDefinition,
  pr: PullRequestState,
  threads: PullRequestFeedbackState[]
): Promise<string> {
  const checklist = threads.map((t) => `- [ ] ${t.url ?? `thread ${t.id}`} — ${firstLine(t.body)}`).join("\n");
  const created = await runTaskNew({
    cwd: ctx.root,
    goal: goal.id,
    name: `Resolve PR #${pr.number} review feedback`,
    targets: [pr.repo],
    agent: "software-engineer",
    origin: "pr-feedback",
    body:
      `\n## Objective\nResolve ${threads.length} unresolved GitHub review thread(s) on PR #${pr.number} ` +
      `(${pr.repo}, branch \`${pr.branch}\`).\n\n## Review threads\n${checklist}\n\n` +
      `## Steps\n1. Inspect each requested change and the code it points at.\n` +
      `2. Implement and test the corrections on \`${pr.branch}\`.\n` +
      `3. Reply to and resolve each thread in GitHub.\n\n` +
      `## Done when\n- Every thread above is addressed with evidence.\n- Every thread above is resolved in GitHub.\n\n` +
      `<!-- awo:pr-repair repo=${pr.repo} pr=${pr.number} threads=${threads.map((t) => t.id).join(",")} -->\n`,
  });
  return created.id;
}

/** One linked PR after a refresh. Status, reconcile and finalize all report these. */
export interface PrSyncRow {
  taskId: string;
  goalId: string;
  repo: string;
  number: number;
  /** The refreshed snapshot — or the stored one when GitHub could not be read. */
  pr: PullRequestState;
  taskStatus: TaskStatus;
  movedToDone: boolean;
  note: string | null;
  /** False when GitHub could not be read: `pr` is then the stored snapshot, unchanged. */
  refreshed: boolean;
  /** Why GitHub could not be read, or why the repair task could not be created. */
  error: string | null;
  /** Open review threads a person asked for (reconcile / finalize). */
  unresolved: number;
  /** Open threads by bots or `pullRequests.ignoreAuthors`, never turned into work. */
  skipped: number;
  /** Actionable threads no repair task tracks yet (what a dry run would create work for). */
  newThreads: number;
  createdTaskIds: string[];
  /** Repair tasks an interrupted earlier pass created, linked instead of re-created. */
  adoptedTaskIds: string[];
  warning: string | null;
  checks: PrView["checks"];
}

export type ReconcileResult = PrSyncRow;

interface PrRead {
  stored: PullRequestState;
  view: PrView | null;
  scan: ThreadScan | null;
  warning: string | null;
  error: string | null;
}

/**
 * Refresh one task's PRs and record what follows. Write order is the crash-safety
 * argument: the snapshot and every new thread (taskId still null) are persisted
 * FIRST; only then is the one aggregated repair task created (marked with its thread
 * ids); then its id is filled in. A crash at any point is repaired by the next pass —
 * the threads are already known, and a repair task that exists is found by its
 * marker instead of being created twice.
 */
async function syncTask(
  ctx: PrContext,
  target: TaskPrs,
  options: { threads?: boolean; dryRun?: boolean; reuseMerged?: boolean } = {}
): Promise<PrSyncRow[]> {
  const { task, goal } = target;
  const reads: PrRead[] = await Promise.all(
    target.prs.map(async (stored): Promise<PrRead> => {
      // MERGED is terminal on GitHub; under --all a stored merged snapshot is reused
      // rather than paying a GitHub round-trip per historical PR.
      if (options.reuseMerged && stored.merged) {
        return { stored, view: { pr: stored, checks: [] }, scan: null, warning: null, error: null };
      }
      try {
        const view = await viewFor(ctx, stored.repo, stored.number);
        let scan: ThreadScan | null = null;
        let warning: string | null = null;
        // Review threads on a merged or closed PR cannot be fixed on that PR.
        if (options.threads && !view.pr.merged && view.pr.state !== "CLOSED") {
          try {
            scan = await scanFor(ctx, view.pr);
          } catch (err) {
            warning = `Could not read review threads: ${(err as Error).message}`;
          }
        }
        return { stored, view, scan, warning, error: null };
      } catch (err) {
        return { stored, view: null, scan: null, warning: null, error: (err as Error).message };
      }
    })
  );

  const current = new Map<string, PullRequestState>();
  const pending = new Map<string, PullRequestFeedbackState[]>();
  let settled: { moved: boolean; note: string | null } = { moved: false, note: null };
  let taskStatus: TaskStatus = task.authoredStatus;
  const apply = (state: GoalState): void => {
    const ts = (state.tasks[task.id] ??= newTaskState(task.authoredStatus));
    for (const read of reads) {
      if (!read.view) continue;
      const pr = storeSnapshot(ts, read.view.pr);
      if (read.scan) {
        for (const thread of read.scan.actionable) {
          if (pr.feedback[thread.id]) continue;
          const comment = thread.comments.nodes[0];
          pr.feedback[thread.id] = {
            id: thread.id, body: comment?.body ?? "", url: comment?.url ?? null,
            author: comment?.author?.login ?? null, resolved: false, taskId: null,
          };
        }
        for (const [id, feedback] of Object.entries(pr.feedback)) feedback.resolved = !read.scan.openIds.has(id);
      }
      pending.set(pr.repo, Object.values(pr.feedback).filter((f) => !f.taskId && !f.resolved));
      current.set(pr.repo, pr);
    }
    settled = settleMergedTask(state, task, goal, ts, options.dryRun);
    taskStatus = ts.status;
  };
  if (options.dryRun || reads.every((r) => !r.view)) {
    apply(JSON.parse(JSON.stringify(await readState(goal.dir, goal.id))) as GoalState);
  } else {
    await mutateState(goal.dir, goal.id, apply);
  }

  const created = new Map<string, string[]>();
  const adopted = new Map<string, string[]>();
  const failures = new Map<string, string>();
  if (options.threads && !options.dryRun) {
    const assignments: Array<{ repo: string; ids: string[]; taskId: string }> = [];
    for (const read of reads) {
      const pr = read.view ? current.get(read.stored.repo) : undefined;
      const open = pr ? (pending.get(pr.repo) ?? []) : [];
      if (!pr || open.length === 0) continue;
      const existing = await repairTasksFor(goal, pr.repo, pr.number);
      for (const feedback of open.filter((f) => existing.has(f.id))) {
        const id = existing.get(feedback.id)!;
        assignments.push({ repo: pr.repo, ids: [feedback.id], taskId: id });
        adopted.set(pr.repo, [...new Set([...(adopted.get(pr.repo) ?? []), id])]);
      }
      const fresh = open.filter((f) => !existing.has(f.id));
      if (fresh.length === 0) continue;
      try {
        const id = await createRepairTask(ctx, goal, pr, fresh);
        assignments.push({ repo: pr.repo, ids: fresh.map((f) => f.id), taskId: id });
        created.set(pr.repo, [id]);
      } catch (err) {
        failures.set(
          pr.repo,
          `Could not create the repair task: ${(err as Error).message}\n` +
            `  The threads are recorded; re-run to finish:  awo pr reconcile ${task.id} --repo ${pr.repo}`
        );
      }
    }
    if (assignments.length > 0) {
      await mutateState(goal.dir, goal.id, (state) => {
        const ts = state.tasks[task.id];
        if (!ts) return;
        for (const a of assignments) {
          updateStored(ts, a.repo, (pr) => {
            for (const id of a.ids) if (pr.feedback[id] && !pr.feedback[id].taskId) pr.feedback[id].taskId = a.taskId;
          });
        }
      });
      for (const a of assignments) {
        const pr = current.get(a.repo);
        for (const id of a.ids) if (pr?.feedback[id] && !pr.feedback[id].taskId) pr.feedback[id].taskId = a.taskId;
      }
    }
  }

  return reads.map((read) => {
    const repo = read.stored.repo;
    const tracked = created.has(repo) || adopted.has(repo);
    return {
      taskId: task.id,
      goalId: goal.id,
      repo,
      number: read.stored.number,
      pr: current.get(repo) ?? read.stored,
      taskStatus,
      movedToDone: settled.moved,
      note: settled.note,
      refreshed: read.view !== null,
      error: read.error ?? failures.get(repo) ?? null,
      unresolved: read.scan?.actionable.length ?? 0,
      skipped: read.scan?.skipped ?? 0,
      newThreads: tracked ? 0 : (pending.get(repo)?.length ?? 0),
      createdTaskIds: created.get(repo) ?? [],
      adoptedTaskIds: adopted.get(repo) ?? [],
      warning: read.warning,
      checks: read.view?.checks ?? [],
    };
  });
}

/**
 * Refresh linked PRs and turn new unresolved review threads into ONE repair task per
 * PR per pass (a checklist), skipping bots and `pullRequests.ignoreAuthors`.
 */
export async function runPrReconcile(
  taskId: string | undefined,
  options: { cwd?: string; all?: boolean; repo?: string } = {}
): Promise<PrSyncRow[]> {
  const ctx = await prContext(options.cwd);
  const rows: PrSyncRow[] = [];
  for (const target of await selectTargets(ctx, "reconcile", taskId, options)) {
    rows.push(...(await syncTask(ctx, target, { threads: true, reuseMerged: options.all })));
  }
  return rows;
}

export interface FinalizeResult {
  action: "ready-for-human" | "merged" | "blocked" | "would-merge" | "already-merged";
  reason: string;
  repo: string;
  number: number;
  pr: PullRequestState;
}

function validRequiredChecks(repo: string, value: RepoEntry["requiredChecks"]): RepoEntry["requiredChecks"] {
  if (value === undefined || value === "none") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`Invalid requiredChecks ${JSON.stringify(value)} on repo ${repo}. Valid: "none" or a list of check names.`);
}

/**
 * F20 — `pr finalize` was unusable without CI: an absent check rollup reads
 * "unknown", never "passing". Measured: 95 `gh pr merge` calls against 21
 * `pr finalize`. A repo now declares what it waits for; undeclared keeps the strict
 * rule (every check passing, mergeState CLEAN).
 */
function mergeBlocker(
  pr: PullRequestState,
  checks: PrView["checks"],
  required: RepoEntry["requiredChecks"]
): string | null {
  const notReady = `PR is not merge-ready: draft=${pr.isDraft}, mergeState=${pr.mergeState}, checks=${pr.checks}.`;
  const mergeState = pr.mergeState.toUpperCase();
  if (required === undefined) {
    return pr.isDraft || mergeState !== "CLEAN" || pr.checks !== "passing" ? notReady : null;
  }
  // GitHub reads UNSTABLE when only a check outside the required set is red — still
  // mergeable by its own rules. BLOCKED/BEHIND/DIRTY are GitHub saying no.
  if (pr.isDraft || !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(mergeState)) return notReady;
  if (required === "none") {
    if (pr.checks === "failing" || pr.checks === "pending") {
      return `${notReady} requiredChecks is "none", so no checks are needed — but one reported ${pr.checks}, and awo does not merge over it.`;
    }
    return null;
  }
  const problems: string[] = [];
  for (const name of required) {
    const runs = checks.filter((c) => c.name === name);
    if (runs.length === 0) problems.push(`${name}=missing`);
    else if (runs.some((c) => c.outcome === "failing")) problems.push(`${name}=failing`);
    else if (runs.some((c) => c.outcome === "pending")) problems.push(`${name}=pending`);
  }
  return problems.length > 0
    ? `required check(s) not passing: ${problems.join(", ")} (requiredChecks on ${pr.repo}).`
    : null;
}

function finalizeRefusal(taskId: string, status: TaskStatus): string {
  const next =
    status === "running"
      ? `Finish the run first:  awo task complete ${taskId} --outcome success`
      : `See where it stands:  awo task show ${taskId}`;
  return (
    `${taskId} is ${status}; pr finalize merges only work completed in awo (in-review or done).\n` +
    `  ${next}\n  Then:  awo pr finalize ${taskId}`
  );
}

export async function runPrFinalize(
  taskId: string,
  options: { cwd?: string; dryRun?: boolean; repo?: string } = {}
): Promise<FinalizeResult[]> {
  const ctx = await prContext(options.cwd);
  const target = await taskPrs(ctx, taskId, options.repo);
  // Merging is the last step of finished work, not a way to finish it: a PR merged
  // while its run is open leaves an awo task that can never be closed honestly.
  if (target.ts.status !== "in-review" && target.ts.status !== "done") {
    throw new Error(finalizeRefusal(taskId, target.ts.status));
  }
  for (const pr of target.prs) {
    await identityFor(ctx, pr.repo);
    validRequiredChecks(pr.repo, findRepo(ctx.manifest, pr.repo)?.requiredChecks);
    resolveRepoMergePolicy(ctx.manifest, pr.repo);
  }

  // A status rollup cannot tell whether a review thread is still actionable, so
  // reconcile immediately before finalizing — no old snapshot can bypass the
  // feedback loop. A dry run reads the same things and writes nothing.
  const rows = await syncTask(ctx, target, { threads: true, dryRun: options.dryRun });
  const results: FinalizeResult[] = [];
  for (const row of rows) results.push(await finalizeOne(ctx, target, row, options.dryRun === true));
  return results;
}

async function finalizeOne(ctx: PrContext, target: TaskPrs, row: PrSyncRow, dryRun: boolean): Promise<FinalizeResult> {
  const { pr } = row;
  const base = { repo: row.repo, number: row.number, pr };
  const prefix = dryRun ? "dry run: " : "";
  if (row.error) return { ...base, action: "blocked", reason: row.error };
  if (pr.merged) {
    return { ...base, action: "already-merged", reason: `already merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ""}.${row.note ? ` ${row.note}` : ""}` };
  }
  if (pr.state === "CLOSED") return { ...base, action: "blocked", reason: "PR is closed without merging." };
  if (row.warning) return { ...base, action: "blocked", reason: row.warning };
  if (row.unresolved > 0) {
    const repair =
      dryRun && row.newThreads > 0
        ? ` A real run would create one repair task for ${row.newThreads} untracked thread(s).`
        : "";
    return { ...base, action: "blocked", reason: `${prefix}${row.unresolved} unresolved GitHub review thread(s) remain.${repair}` };
  }
  const repo = findRepo(ctx.manifest, pr.repo);
  const blocker = mergeBlocker(pr, row.checks, validRequiredChecks(pr.repo, repo?.requiredChecks));
  if (blocker) return { ...base, action: "blocked", reason: `${prefix}${blocker}` };
  const skipped = row.skipped > 0 ? ` (${row.skipped} bot/ignored review thread(s) left open)` : "";
  if (resolveRepoMergePolicy(ctx.manifest, pr.repo) === "human-only") {
    return { ...base, action: "ready-for-human", reason: `${prefix}mergePolicy is human-only; AWO will not approve or merge this PR.${skipped}` };
  }
  const gh = await identityFor(ctx, pr.repo);
  const fullName = await fullNameFor(ctx, pr.repo);
  if (dryRun) {
    return {
      ...base,
      action: "would-merge",
      reason: `dry run: authorized-maintainer policy would immediately squash-merge ${pr.repo}#${pr.number} at ${pr.headSha}.${skipped}`,
    };
  }
  // The REST merge endpoint is immediate-or-fail. Unlike a CLI merge flow, it
  // cannot enable auto-merge or place work in a merge queue on this agent's behalf;
  // `sha` makes GitHub refuse if the head moved since the checks above were read.
  await runGh(gh, [
    "api", "--method", "PUT", `repos/${fullName}/pulls/${pr.number}/merge`,
    "-f", "merge_method=squash", "-f", `sha=${pr.headSha}`,
  ]);
  // Record the merge and its lifecycle consequence now, not at the next status call.
  let after = "";
  try {
    ctx.views.delete(`${pr.repo}#${pr.number}`);
    const [refreshed] = await syncTask(ctx, { task: target.task, goal: target.goal, prs: [pr] });
    if (refreshed?.note) after = ` ${refreshed.note}.`;
  } catch {
    after = ` Refresh it with:  awo pr status ${target.task.id}`;
  }
  return {
    ...base,
    action: "merged",
    reason: `immediately squash-merged under authorized-maintainer policy; AWO did not approve the PR.${skipped}${after}`,
  };
}
