import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, type RepoEntry } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";

export type SyncAction =
  | "cloned"
  | "pulled"
  | "up-to-date"
  | "relinked"
  | "linked"
  | "skipped-dirty"
  | "skipped-diverged"
  | "source-missing"
  | "failed";

export interface SyncResult {
  name: string;
  type: RepoEntry["type"];
  action: SyncAction;
  detail?: string;
}

/** Actions that mean the repo is not usable afterwards. */
const PROBLEM_ACTIONS = new Set<SyncAction>(["source-missing", "failed"]);

export function syncHadProblems(results: SyncResult[]): boolean {
  return results.some((r) => PROBLEM_ACTIONS.has(r.action));
}

/**
 * §6 — reconciles `repos/` with the manifest, which is what makes decision
 * §3.1/§3.7 true in practice: `git clone <workspace> && awo sync` restores a
 * working setup with no per-user steps.
 *
 * Deliberately conservative on repos that already exist: it will fast-forward
 * a clean checkout, but never touches one with local changes or divergent
 * commits. Losing an agent's uncommitted work to a housekeeping command would
 * be far worse than leaving it out of date.
 */
export async function runSync(options: { cwd?: string } = {}): Promise<SyncResult[]> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);
  const results: SyncResult[] = [];

  await fs.ensureDir(path.join(workspaceRoot, "repos"));

  for (const repo of manifest.repos) {
    const target = path.join(workspaceRoot, "repos", repo.name);
    try {
      results.push(
        repo.type === "git"
          ? await syncGit(repo.name, repo.url, repo.ref, target)
          : await syncLocal(repo.name, repo.path, target)
      );
    } catch (err) {
      results.push({
        name: repo.name,
        type: repo.type,
        action: "failed",
        detail: (err as Error).message,
      });
    }
  }

  await regenerateCodeWorkspace(workspaceRoot);
  return results;
}

async function syncGit(
  name: string,
  url: string,
  ref: string,
  target: string
): Promise<SyncResult> {
  if (!(await fs.pathExists(target))) {
    await simpleGit().clone(url, target, ref ? ["--branch", ref] : []);
    return { name, type: "git", action: "cloned", detail: ref };
  }

  const git = simpleGit(target);
  const status = await git.status();

  if (!status.isClean()) {
    return {
      name,
      type: "git",
      action: "skipped-dirty",
      detail: `${status.files.length} uncommitted change(s)`,
    };
  }

  await git.fetch();
  const fresh = await git.status();

  if (fresh.ahead > 0) {
    return {
      name,
      type: "git",
      action: "skipped-diverged",
      detail: `${fresh.ahead} unpushed commit(s)`,
    };
  }
  if (fresh.behind === 0) {
    return { name, type: "git", action: "up-to-date", detail: fresh.current ?? ref };
  }

  await git.pull(["--ff-only"]);
  return { name, type: "git", action: "pulled", detail: `${fresh.behind} commit(s)` };
}

async function syncLocal(name: string, sourcePath: string, target: string): Promise<SyncResult> {
  if (!(await fs.pathExists(sourcePath))) {
    return {
      name,
      type: "local",
      action: "source-missing",
      detail: `${sourcePath} no longer exists — reconnect it with \`awo connect\` or drop it with \`awo remove ${name}\``,
    };
  }

  // A `local` link is a symlink, so "syncing" means making sure it exists and
  // still points at the manifest's path. Nothing is ever pulled: the source is
  // the user's own checkout and they own its git state.
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const current = await fs.readlink(target);
    if (path.resolve(current) === path.resolve(sourcePath)) {
      return { name, type: "local", action: "up-to-date" };
    }
    await fs.remove(target);
    await fs.symlink(sourcePath, target, "dir");
    return { name, type: "local", action: "relinked", detail: `was -> ${current}` };
  }

  if (existing) {
    return {
      name,
      type: "local",
      action: "failed",
      detail: `${target} exists but is not a symlink; remove it and re-run sync`,
    };
  }

  await fs.symlink(sourcePath, target, "dir");
  return { name, type: "local", action: "linked" };
}
