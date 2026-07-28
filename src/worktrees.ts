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
  /**
   * The worktree's git metadata directory — `<repo>/.git`, which lives outside
   * the workspace. A sandboxed worker needs to WRITE this to commit, but must
   * NOT be granted the repo itself: doing so hands it the real checkout and it
   * will edit that instead of the worktree (§9 item 42).
   */
  gitDirPath: string;
  /**
   * Paths outside the worktree that a sandboxed worker must be able to WRITE.
   * Beyond the git dir this includes linked `node_modules`: build tools write
   * caches there (`.vite-temp`, `.cache`), and a read-only link makes the test
   * suite fail with a permission error rather than a test failure (§9 item 46).
   * These are caches and dependencies, never source — see §9 item 42 for why the
   * distinction matters.
   */
  writablePaths: string[];
  /** The dependency branch this one was cut from, when there was one. */
  basedOn?: string | null;
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
  targets: string[],
  /**
   * Tasks this one depends on, most-recent-first. A dependent task must build ON
   * its dependency's work: branching every task from the repo's current HEAD gave
   * each one an isolated branch that lacked its predecessor's commits, so the
   * chain silently broke (§9 item 44).
   */
  dependsOn: string[] = []
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
      out.push({
        repo: name,
        path: rel,
        branch,
        created: false,
        reused: true,
        error: null,
        gitDirPath: path.join(repoPath, ".git"),
        writablePaths: await writableFor(repoPath, abs),
      });
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
        gitDirPath: path.join(repoPath, ".git"),
        writablePaths: await writableFor(repoPath, existing),
      });
      continue;
    }

    await fs.ensureDir(path.dirname(abs));
    const branches = await git.branchLocal();

    // Base the new branch on the nearest dependency that actually has a branch
    // here, so the dependent task starts from its predecessor's commits.
    const base = dependsOn
      .map((dep) => `feature/${dep}`)
      .find((candidate) => branches.all.includes(candidate));

    try {
      await git.raw(
        branches.all.includes(branch)
          ? ["worktree", "add", abs, branch]
          : base
            ? ["worktree", "add", "-b", branch, abs, base]
            : ["worktree", "add", "-b", branch, abs]
      );
      // A fresh worktree has no node_modules (gitignored), so `run-tests` cannot
      // run and `tests-must-pass` becomes unsatisfiable — the worker reports
      // "jest not found" and calls it unverified (§9 item 45). Link the repo's
      // installed dependencies rather than re-installing: instant, no disk cost,
      // and node resolves through the symlink.
      const linked = await linkDependencies(repoPath, abs);

      out.push({
        repo: name,
        path: rel,
        branch,
        created: true,
        reused: false,
        error: null,
        gitDirPath: path.join(repoPath, ".git"),
        writablePaths: [path.join(repoPath, ".git"), ...linked],
        basedOn: base ?? null,
      });
    } catch (err) {
      // A worktree that cannot be created must not look like isolation.
      out.push({
        repo: name,
        path: rel,
        branch,
        created: false,
        reused: false,
        error: (err as Error).message.split("\n")[0],
        gitDirPath: path.join(repoPath, ".git"),
        writablePaths: [],
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

/**
 * Point a fresh worktree at the repo's already-installed dependencies, and report
 * which external paths the worker will therefore need to write.
 */
async function linkDependencies(repoPath: string, worktreePath: string): Promise<string[]> {
  const linked: string[] = [];
  for (const dir of ["node_modules"]) {
    const source = path.join(repoPath, dir);
    const target = path.join(worktreePath, dir);
    if (!(await fs.pathExists(source))) continue;
    if (await fs.pathExists(target)) {
      linked.push(source);
      continue;
    }
    // Best effort: a failed link leaves the worktree usable, just untestable.
    await fs.symlink(source, target, "dir").then(() => linked.push(source)).catch(() => undefined);
  }
  return linked;
}

/** Paths an existing/reused worktree needs written, recomputed on each run. */
async function writableFor(repoPath: string, worktreePath: string): Promise<string[]> {
  const out = [path.join(repoPath, ".git")];
  const nm = path.join(repoPath, "node_modules");
  if (await fs.pathExists(path.join(worktreePath, "node_modules"))) out.push(nm);
  return out;
}
