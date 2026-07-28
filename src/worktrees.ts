import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { type Manifest } from "./manifest.js";

export interface Worktree {
  repo: string;
  /** Workspace-relative, as §4 specifies: repos/.worktrees/<repo>/<taskId>. */
  path: string;
  branch: string;
  created: boolean;
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
      out.push({ repo: name, path: rel, branch, created: false });
      continue;
    }

    await fs.ensureDir(path.dirname(abs));
    const branches = await git.branchLocal();
    try {
      // Reuse the branch if a previous attempt made it, so a retried task does
      // not lose the work already committed on it.
      await git.raw(
        branches.all.includes(branch)
          ? ["worktree", "add", abs, branch]
          : ["worktree", "add", "-b", branch, abs]
      );
      out.push({ repo: name, path: rel, branch, created: true });
    } catch {
      // A worktree that cannot be created must not silently look like isolation.
      out.push({ repo: name, path: rel, branch, created: false });
    }
  }

  return out;
}
