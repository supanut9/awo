import fs from "fs-extra";
import path from "path";

export interface GitRepoEntry {
  name: string;
  type: "git";
  url: string;
  ref: string;
  testCommand?: string;
}

export interface LocalRepoEntry {
  name: string;
  type: "local";
  path: string;
  testCommand?: string;
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
