import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, writeManifest } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";

export interface RemoveOptions {
  name: string;
  cwd?: string;
  /** Also delete a cloned checkout — only after it proves to hold nothing unpushed. */
  deleteCheckout?: boolean;
  dryRun?: boolean;
}

export interface RemoveResult {
  name: string;
  type: "git" | "local";
  /** Workspace-relative `repos/<name>`. */
  path: string;
  /** What happened (or would) to `repos/<name>`. */
  checkout: "unlinked" | "kept" | "deleted" | "missing";
  notes: string[];
  dryRun: boolean;
}

/**
 * Unregister a repo. Until 0.8 this also `rm -rf`'d `repos/<name>` whatever it was —
 * for a clone, that is the only copy of any unpushed branch, stash or uncommitted
 * edit in it (F25). Now a connected repo loses only its link, and a clone stays on
 * disk unless `--delete-checkout` asks for it AND the clone proves it holds nothing
 * that exists nowhere else.
 */
export async function runRemove(options: RemoveOptions): Promise<RemoveResult> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);

  const entry = manifest.repos.find((r) => r.name === options.name);
  if (!entry) {
    throw new Error(`No repo named "${options.name}" is registered.`);
  }

  const rel = path.join("repos", options.name);
  const linkPath = path.join(workspaceRoot, rel);
  const stat = await fs.lstat(linkPath).catch(() => null);
  const notes: string[] = [];
  let checkout: RemoveResult["checkout"];

  if (!stat) {
    checkout = "missing";
  } else if (entry.type === "local") {
    if (stat.isSymbolicLink()) {
      checkout = "unlinked";
      if (options.deleteCheckout) {
        notes.push(`${options.name} is a connected repo; awo removes only its link, never ${entry.path}.`);
      }
    } else {
      checkout = "kept";
      notes.push(`${rel} is not the link awo made, so it was left in place — inspect it.`);
    }
  } else if (stat.isSymbolicLink()) {
    checkout = "unlinked";
  } else if (options.deleteCheckout) {
    const blockers = await cloneBlockers(workspaceRoot, options.name, linkPath);
    if (blockers.length > 0) {
      throw new Error(
        `Refusing to delete ${rel}: ${blockers.join("; ")}. Push, commit or prune what it holds ` +
          `(\`awo worktree prune --task <id>\`), or run \`awo remove ${options.name}\` without ` +
          `--delete-checkout to unregister it and keep the clone. Nothing was changed.`
      );
    }
    checkout = "deleted";
  } else {
    checkout = "kept";
    notes.push(
      `The clone at ${rel} was kept on disk. \`--delete-checkout\` deletes it, and only when it is ` +
        `clean, fully pushed and has no task worktrees.`
    );
  }

  const leftover = await taskWorktreeDirs(workspaceRoot, options.name);
  if (leftover.length > 0 && checkout !== "deleted") {
    notes.push(
      `${leftover.length} task worktree(s) remain under repos/.worktrees/${options.name}; once ` +
        `unregistered awo no longer lists or prunes them — run \`awo worktree prune --all\` first if they are finished.`
    );
  }

  if (!options.dryRun) {
    manifest.repos = manifest.repos.filter((r) => r.name !== options.name);
    await writeManifest(workspaceRoot, manifest);
    await regenerateCodeWorkspace(workspaceRoot);
    if (checkout === "unlinked") await fs.unlink(linkPath);
    if (checkout === "deleted") await fs.remove(linkPath);
  }

  return { name: options.name, type: entry.type, path: rel, checkout, notes, dryRun: !!options.dryRun };
}

/** Everything that makes deleting a clone lose work. Empty means it is safe. */
async function cloneBlockers(workspaceRoot: string, name: string, clone: string): Promise<string[]> {
  const git = simpleGit(clone);
  if (!(await git.checkIsRepo().catch(() => false))) {
    return ["it is not a git repository, so awo cannot tell what it holds"];
  }
  const out: string[] = [];
  const status = await git.raw(["status", "--porcelain"]).catch(() => null);
  if (status === null) out.push("git status failed");
  else if (status.trim()) out.push(`${status.trim().split("\n").length} uncommitted or untracked change(s)`);

  const unpushed = await git.raw(["rev-list", "--count", "--branches", "--not", "--remotes"]).catch(() => null);
  const count = unpushed === null ? NaN : Number.parseInt(unpushed.trim(), 10);
  if (!Number.isFinite(count)) out.push("could not count unpushed commits");
  else if (count > 0) out.push(`${count} commit(s) on local branches that no remote has`);

  const stashes = (await git.raw(["stash", "list"]).catch(() => "")).trim();
  if (stashes) out.push(`${stashes.split("\n").length} stash entr(ies)`);

  const worktrees = (await git.raw(["worktree", "list", "--porcelain"]).catch(() => ""))
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
  if (worktrees > 1) out.push(`${worktrees - 1} worktree(s) of it still registered`);
  else if ((await taskWorktreeDirs(workspaceRoot, name)).length > 0) {
    out.push(`task worktree directories remain under repos/.worktrees/${name}`);
  }
  return out;
}

async function taskWorktreeDirs(workspaceRoot: string, name: string): Promise<string[]> {
  return fs.readdir(path.join(workspaceRoot, "repos", ".worktrees", name)).catch(() => []);
}
