import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { type Manifest } from "./manifest.js";

export interface Worktree {
  repo: string;
  /** Workspace-relative where possible: repos/.worktrees/<repo>/<taskId>. */
  path: string;
  branch: string;
  created: boolean;
  /** The repo whose .git the worktree points into — a worker must be able to write it. */
  gitOwnerPath: string;
  /** True when git already had a worktree on this branch and we reused it. */
  reused: boolean;
  /** Set when isolation could NOT be established — never advertise a path then. */
  error: string | null;
}

/**
 * §7.1 rule `isolate-task-worktrees` — until now this was honour-system: nothing
 * created the worktree, so a worker either edited the shared checkout or invented
 * its own location. In the dogfood an agent created `<workspace>/.worktrees/…`
 * instead of `repos/.worktrees/…`, which is outside the gitignored path (§9
 * item 34). `task run` now creates them, so the location is not a guess.
 *
 * Best-effort per repo: a target that isn't a git repo is skipped rather than
 * failing the run, because not every linked directory has to be one.
 */
export async function ensureTaskWorktrees(
  workspaceRoot: string,
  manifest: Manifest,
  taskId: string,
  targets: string[]
): Promise<Worktree[]> {
  const out: Worktree[] = [];

  for (const name of targets) {
    const entry = manifest.repos.find((r) => r.name === name);
    if (!entry) continue;

    // Resolve through the manifest, not repos/<name>: that is a symlink for
    // local repos, and git worktree metadata should reference the real path.
    const repoPath = entry.type === "local" ? entry.path : path.join(workspaceRoot, "repos", name);
    const git = simpleGit(repoPath);
    if (!(await git.checkIsRepo().catch(() => false))) continue;

    const rel = path.join("repos", ".worktrees", name, taskId);
    const abs = path.join(workspaceRoot, rel);
    const branch = `feature/${taskId}`;

    if (await fs.pathExists(abs)) {
      out.push({ repo: name, path: rel, branch, created: false, reused: true, error: null, gitOwnerPath: repoPath });
      continue;
    }

    // git allows a branch to be checked out in only ONE worktree. If a previous
    // attempt (or a hand-made worktree) already holds this branch, reuse THAT
    // path — it is where the prior work lives, and creating a second one simply
    // fails. Without this, a resumed task advertised a directory git had refused
    // to create, so "isolation" pointed at nothing (§9 item 37).
    const existing = await worktreeForBranch(git, branch);
    if (existing) {
      const insideWorkspace = existing.startsWith(workspaceRoot + path.sep);
      out.push({
        repo: name,
        path: insideWorkspace ? path.relative(workspaceRoot, existing) : existing,
        branch,
        created: false,
        reused: true,
        error: null,
        gitOwnerPath: repoPath,
      });
      continue;
    }

    await fs.ensureDir(path.dirname(abs));
    const branches = await git.branchLocal();
    try {
      await git.raw(
        branches.all.includes(branch)
          ? ["worktree", "add", abs, branch]
          : ["worktree", "add", "-b", branch, abs]
      );
      out.push({ repo: name, path: rel, branch, created: true, reused: false, error: null, gitOwnerPath: repoPath });
    } catch (err) {
      // A worktree that cannot be created must not look like isolation.
      out.push({
        repo: name,
        path: rel,
        branch,
        created: false,
        reused: false,
        error: (err as Error).message.split("\n")[0],
        gitOwnerPath: repoPath,
      });
    }
  }

  return out;
}

/** The worktree path currently holding `branch`, if any. */
async function worktreeForBranch(
  git: ReturnType<typeof simpleGit>,
  branch: string
): Promise<string | null> {
  const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    if (line.trim() === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}
