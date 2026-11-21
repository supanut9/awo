import fs from "fs-extra";
import path from "path";

export interface GitRepoEntry {
  name: string;
  type: "git";
  url: string;
  ref: string;
  testCommand?: string;
  /**
   * The `gh` account this repo must be acted on as.
   *
   * A workspace on a personal account whose repos belong to a company is the normal
   * case, not an edge one — and `gh` keeps one active account per host, so the wrong
   * identity is one `gh auth switch` away at all times. Declaring it here lets awo
   * refuse instead of opening a PR as the wrong person, which is not undoable.
   */
  githubAccount?: string;
  /**
   * The branch task worktrees are cut from when nothing more specific applies
   * (a dependency's branch, then the goal's `deliveryBranch`/`baseBranches`).
   * Absent means the remote's default branch (`origin/HEAD`), fetched first —
   * never whatever the shared checkout happens to have checked out.
   */
  baseBranch?: string;
  /** Per-repo override of `pullRequests.mergePolicy`. */
  mergePolicy?: PullRequestMergePolicy;
  /**
   * Which checks `pr finalize` waits for. `"none"` declares the repo has no CI, so
   * an absent check run is not "unknown" — it is expected. A list names the checks
   * that must pass; others are informational.
   */
  requiredChecks?: "none" | string[];
}

export interface LocalRepoEntry {
  name: string;
  type: "local";
  path: string;
  testCommand?: string;
  /** See GitRepoEntry.githubAccount. */
  githubAccount?: string;
  /** See GitRepoEntry.baseBranch. */
  baseBranch?: string;
  /** See GitRepoEntry.mergePolicy. */
  mergePolicy?: PullRequestMergePolicy;
  /** See GitRepoEntry.requiredChecks. */
  requiredChecks?: "none" | string[];
}

export type RepoEntry = GitRepoEntry | LocalRepoEntry;

export interface ModelChoiceEntry {
  runtime?: string;
  model: string;
  /** e.g. "plan" for Claude Code's plan mode. */
  mode?: string;
}

/**
 * §12 — model policy. `orchestrator` is the intermediary the human talks to and
 * is not a worker; `tiers` maps a kind of work (high/standard/low) to a
 * runtime+model; `byRole` pins a specific agent. All optional.
 */
export interface ModelPolicyEntry {
  orchestrator?: ModelChoiceEntry;
  tiers?: Partial<Record<"high" | "standard" | "low", ModelChoiceEntry>>;
  byRole?: Record<string, ModelChoiceEntry>;
}

/**
 * Who may perform the final merge. Approval is never delegated to an AI worker;
 * `authorized-maintainer` only permits an existing maintainer credential to merge
 * after the repository's own required checks and reviews are satisfied.
 */
export type PullRequestMergePolicy = "human-only" | "authorized-maintainer";

export interface PullRequestPolicy {
  mergePolicy?: PullRequestMergePolicy;
  /** Applied to every PR, on top of the task's own. Existing labels only. */
  labels?: string[];
  /**
   * Who owns the PR. Omitted means the authenticated `gh` user — the person whose
   * credentials opened it, which is the only assignee awo can infer honestly.
   */
  assignee?: string;
  /**
   * Review-thread authors `pr reconcile` never turns into repair work, on top of
   * bots (which are always skipped). Logins, case-insensitive; a `[bot]` suffix is optional.
   */
  ignoreAuthors?: string[];
}

/**
 * How strictly a goal must prove itself before it is `done`.
 * - `light`: measured checks per task, no per-criterion evidence, no goal verdict.
 * - `standard`: per-criterion evidence, no goal-level verdict.
 * - `strict`: per-criterion evidence AND a goal-level QA verdict (the governed default).
 */
export type GoalPolicyName = "light" | "standard" | "strict";

export interface GovernancePolicy {
  /**
   * May an agent record a human gate (`req approve`, `goal verdict`) on a named
   * human's instruction (`--delegated-by`)? Default true — delegation is allowed
   * but always recorded as delegation. `false` makes those gates human-terminal only.
   */
  allowDelegation?: boolean;
}

export interface Manifest {
  libraryVersion: string;
  /**
   * Machine identity — uuid v7, generated once at init, permanent and never
   * displayed. Distinct from projectKey, which is human-facing and only unique
   * across one user's projects (§5). Optional on read so workspaces created
   * before this field existed still load.
   */
  workspaceId?: string;
  projectKey: string;
  projectName: string;
  createdAt: string;
  /** §12 — model tiering policy. Absent means built-in defaults apply. */
  models?: ModelPolicyEntry;
  /** PR authority. Absent preserves the safe human-only default. */
  pullRequests?: PullRequestPolicy;
  /** Who may pass the human gates, and whether delegation is allowed. */
  governance?: GovernancePolicy;
  /** Defaults for new goals. */
  goals?: { defaultPolicy?: GoalPolicyName };
  /**
   * §7.6 — optional publishing of a projection to MongoDB. Absent means no
   * publishing and no network calls; the connection string never lives here, only
   * in .workspace/credentials/mongo.env (gitignored, per-machine).
   */
  publish?: {
    database?: string;
    collectionPrefix?: string;
    redact?: { prompts?: boolean; filePaths?: boolean };
  };
  repos: RepoEntry[];
}

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".workspace", "manifest.json");
}

export async function readManifest(workspaceRoot: string): Promise<Manifest> {
  const file = manifestPath(workspaceRoot);
  let raw: unknown;
  try {
    raw = await fs.readJson(file);
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }

  const manifest = raw as Partial<Manifest>;
  if (
    typeof manifest.projectKey !== "string" ||
    typeof manifest.libraryVersion !== "string" ||
    !Array.isArray(manifest.repos)
  ) {
    throw new Error(`${file} is malformed — missing projectKey, libraryVersion, or repos.`);
  }
  return manifest as Manifest;
}

export async function writeManifest(workspaceRoot: string, manifest: Manifest): Promise<void> {
  await fs.writeJson(manifestPath(workspaceRoot), manifest, { spaces: 2 });
}

export function resolvePullRequestMergePolicy(manifest: Manifest): PullRequestMergePolicy {
  const policy = manifest.pullRequests?.mergePolicy ?? "human-only";
  if (policy !== "human-only" && policy !== "authorized-maintainer") {
    throw new Error(
      `Invalid pullRequests.mergePolicy "${String(policy)}". Valid: human-only, authorized-maintainer.`
    );
  }
  return policy;
}

/** The effective merge policy for one repo: its own override, else the workspace's. */
export function resolveRepoMergePolicy(manifest: Manifest, repoName: string): PullRequestMergePolicy {
  const repo = manifest.repos.find((r) => r.name === repoName);
  const policy = repo?.mergePolicy ?? resolvePullRequestMergePolicy(manifest);
  if (policy !== "human-only" && policy !== "authorized-maintainer") {
    throw new Error(
      `Invalid mergePolicy "${String(policy)}" on repo ${repoName}. Valid: human-only, authorized-maintainer.`
    );
  }
  return policy;
}

export function findRepo(manifest: Manifest, repoName: string): RepoEntry | undefined {
  return manifest.repos.find((r) => r.name === repoName);
}

export function delegationAllowed(manifest: Manifest): boolean {
  return manifest.governance?.allowDelegation !== false;
}
