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

/**
 * A worktree awo's isolation directory holds right now, with everything needed to
 * decide whether removing it would destroy work.
 *
 * Discovered from `git worktree list` rather than from state.json, for two reasons.
 * State only ever knew about worktrees awo created — and the SHOP workspace had two
 * (`ALMO-261`, `ALMO-265`) that agents made by hand while following the
 * goal-branch flow. And `state.worktree` was initialised to `null` and never
 * written, so it knew about none of them either.
 */
export interface ExistingWorktree {
  repo: string;
  /** Workspace-relative: repos/.worktrees/<repo>/<leaf>. */
  path: string;
  absPath: string;
  /** The directory name under the repo — a task id for one awo created. */
  leaf: string;
  branch: string | null;
  /** Uncommitted changes in the checkout. */
  dirty: boolean;
  /** Commits on this branch that no other branch contains. */
  unmergedCommits: number;
  /** Other refs that already contain this branch's tip. */
  containedIn: string[];
  /** False for a directory git has no record of — hand-made, or a failed `worktree add`. */
  registered: boolean;
  /**
   * Set only for unregistered directories: whether the directory holds anything at
   * all. Decided by one `readdir` rather than by `bytes`, which may be unmeasured.
   */
  empty?: boolean;
  /**
   * Apparent size, and 0 unless the caller asked for sizes.
   *
   * Opt-in because measuring it means walking every file in every checkout, and the
   * SHOP workspace holds 1.5 GB of them: computing it unconditionally took `doctor`
   * from 0.27s to 5.7s. A command that runs at the start of every session cannot pay
   * for a number only `worktree list` prints.
   */
  bytes: number;
}

/** Removing this destroys nothing: it is clean, and its commits live elsewhere. */
export function isSafeToRemove(worktree: ExistingWorktree): boolean {
  // A directory git has no record of cannot be reasoned about — nothing says where
  // its commits went, or whether it has any. Empty, it is obviously safe; otherwise
  // it is reported and kept until a person looks at it.
  if (!worktree.registered) return worktree.empty === true;
  return !worktree.dirty && (worktree.unmergedCommits === 0 || worktree.containedIn.length > 0);
}

/** Why removing this would lose something, or null when it would not. */
export function unsafeReason(worktree: ExistingWorktree): string | null {
  if (isSafeToRemove(worktree)) return null;
  if (!worktree.registered) return "git has no record of it, so its work cannot be accounted for";
  if (worktree.dirty) return "uncommitted changes in the checkout";
  return `${worktree.unmergedCommits} commit(s) no other branch contains`;
}

function worktreeRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, "repos", ".worktrees");
}

/** Recursive apparent size, skipping symlinks so linked node_modules is not counted twice. */
async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(at, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else total += (await fs.stat(full).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

/**
 * Every checkout under `repos/.worktrees/`, whoever made it.
 *
 * `awo` created worktrees and never removed one: there is no `git worktree remove`
 * anywhere in the library, only a line of prose in the `create-task-worktree` skill
 * asking an agent to do it. Two weeks of real use left 2.0 GB of checkouts for
 * tasks that were all `done` (§9 — SHOP workspace). This is what a prune command,
 * and a doctor check, need to see.
 */
export async function listWorktrees(
  workspaceRoot: string,
  manifest: Manifest,
  options: { withSizes?: boolean } = {}
): Promise<ExistingWorktree[]> {
  const root = worktreeRoot(workspaceRoot);
  if (!(await fs.pathExists(root))) return [];

  const sizeOf = async (dir: string): Promise<number> =>
    options.withSizes ? directoryBytes(dir) : 0;
  const out: ExistingWorktree[] = [];

  // Concurrently, across repos and across each repo's worktrees. Answering "is this
  // safe to remove?" costs three git invocations per checkout, and doing 20 of them
  // in sequence took `doctor` from 0.27s to 1.7s — for a command whose whole job is
  // to be the cheap thing you run before anything else.
  const perRepo = await Promise.all(
    manifest.repos.map(async (entry): Promise<ExistingWorktree[]> => {
      const repoPath =
        entry.type === "local" ? entry.path : path.join(workspaceRoot, "repos", entry.name);
      const git = simpleGit(repoPath);
      if (!(await git.checkIsRepo().catch(() => false))) return [];

      const registered = (await registeredWorktrees(git)).filter(
        // Only ours. A developer's own worktree elsewhere on disk is none of our
        // business, and removing it would be a surprise a tool never earns back.
        ({ worktreePath }) => worktreePath.startsWith(root + path.sep)
      );

      return Promise.all(
        registered.map(async ({ worktreePath, branch }) => {
          const [status, safety, bytes] = await Promise.all([
            simpleGit(worktreePath).status().catch(() => null),
            commitSafety(git, worktreePath, branch),
            sizeOf(worktreePath),
          ]);
          return {
            repo: entry.name,
            path: path.relative(workspaceRoot, worktreePath),
            absPath: worktreePath,
            leaf: path.basename(worktreePath),
            branch,
            dirty: (status?.files.length ?? 0) > 0,
            unmergedCommits: safety.unmergedCommits,
            containedIn: safety.containedIn,
            registered: true,
            bytes,
          };
        })
      );
    })
  );
  out.push(...perRepo.flat());

  // Directories under repos/.worktrees/<repo>/ that git has no record of.
  //
  // Discovering through `git worktree list` alone misses these, and the SHOP
  // workspace had three: `ALMO-261`, 532KB of a hand-made checkout, and two empty
  // `SHOP-T42` directories left by a `worktree add` that failed. They occupy the
  // path awo wants to reuse, so they have to be visible.
  for (const entry of manifest.repos) {
    const dir = path.join(root, entry.name);
    for (const leaf of await fs.readdir(dir).catch(() => [])) {
      const abs = path.join(dir, leaf);
      if (!(await fs.stat(abs).catch(() => null))?.isDirectory()) continue;
      if (out.some((w) => w.absPath === abs)) continue;

      const empty = (await fs.readdir(abs).catch(() => [])).length === 0;
      const git = simpleGit(abs);
      const isRepo = await git.checkIsRepo().catch(() => false);
      const branch = isRepo
        ? (await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null
        : null;

      out.push({
        repo: entry.name,
        path: path.relative(workspaceRoot, abs),
        absPath: abs,
        leaf,
        branch,
        dirty: isRepo ? ((await git.status().catch(() => null))?.files.length ?? 0) > 0 : false,
        unmergedCommits: 0,
        containedIn: [],
        registered: false,
        empty,
        bytes: await sizeOf(abs),
      });
    }
  }

  // `.baseline/<repo>` scratch checkouts, created by `task event --baseline` to
  // measure a pre-change test run. They hold no authored work by construction, so
  // they are always safe — but they are never cleaned up either.
  for (const name of await fs.readdir(path.join(root, ".baseline")).catch(() => [])) {
    const abs = path.join(root, ".baseline", name);
    if (!(await fs.stat(abs).catch(() => null))?.isDirectory()) continue;
    if (out.some((w) => w.absPath === abs)) continue;
    out.push({
      repo: name,
      path: path.relative(workspaceRoot, abs),
      absPath: abs,
      leaf: ".baseline",
      branch: null,
      dirty: false,
      unmergedCommits: 0,
      containedIn: [],
      registered: true,
      bytes: await sizeOf(abs),
    });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** `git worktree list --porcelain`, minus the main checkout. */
async function registeredWorktrees(
  git: ReturnType<typeof simpleGit>
): Promise<{ worktreePath: string; branch: string | null }[]> {
  const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  const out: { worktreePath: string; branch: string | null }[] = [];
  let current: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (current) out.push({ worktreePath: current, branch });
    current = null;
    branch = null;
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  flush();
  return out;
}

/**
 * How much work would be lost. A branch whose tip another ref already contains has
 * been merged somewhere — which under `goal-feature-branch` is the delivery branch,
 * not main, so "merged into the default branch" is the wrong question to ask.
 */
async function commitSafety(
  git: ReturnType<typeof simpleGit>,
  worktreePath: string,
  branch: string | null
): Promise<{ unmergedCommits: number; containedIn: string[] }> {
  if (!branch) return { unmergedCommits: 0, containedIn: [] };

  const head = (await simpleGit(worktreePath).revparse(["HEAD"]).catch(() => "")).trim();
  if (!head) return { unmergedCommits: 0, containedIn: [] };

  const [containedRaw, uniqueRaw] = await Promise.all([
    git.raw(["branch", "--contains", head]).catch(() => ""),
    // `--exclude` patterns are matched against the ref name with `refs/heads/`
    // already stripped, because `--branches` is what expands them. Passing the full
    // `refs/heads/<branch>` excludes nothing, the branch counts as reaching its own
    // tip, and every worktree reports 0 unmerged commits — which is the answer that
    // makes a prune destructive.
    git
      .raw(["rev-list", "--count", head, "--not", `--exclude=${branch}`, "--branches"])
      .catch(() => "0"),
  ]);

  const containedIn = containedRaw
    .split("\n")
    .map((l) => l.replace(/^[*+]?\s*/, "").trim())
    .filter((l) => l !== "" && l !== branch && !l.startsWith("(") && !l.includes("detached"));

  // Commits unique to this branch, measured against every other local branch — the
  // same question `git log --not --branches` answers, scoped to this tip.
  return { unmergedCommits: Number.parseInt(uniqueRaw.trim(), 10) || 0, containedIn };
}

export interface PrunedWorktree {
  worktree: ExistingWorktree;
  removed: boolean;
  /** Why it was kept, when it was. */
  keptBecause: string | null;
}

/**
 * Remove the worktrees a caller nominates, refusing any that still holds work.
 *
 * Not part of `task complete` on purpose. Under `goal-feature-branch` a task's
 * commits are merged into the repository's delivery branch *after* the task
 * verifies, so deleting the checkout at completion would throw away commits that
 * nothing else has yet. Pruning is therefore explicit, and safe by default.
 */
export async function pruneWorktrees(
  workspaceRoot: string,
  manifest: Manifest,
  options: { select: (worktree: ExistingWorktree) => boolean; force?: boolean }
): Promise<PrunedWorktree[]> {
  const results: PrunedWorktree[] = [];

  for (const worktree of await listWorktrees(workspaceRoot, manifest)) {
    if (!options.select(worktree)) continue;

    if (!options.force && !isSafeToRemove(worktree)) {
      results.push({
        worktree,
        removed: false,
        keptBecause: unsafeReason(worktree),
      });
      continue;
    }

    const entry = manifest.repos.find((r) => r.name === worktree.repo);
    const repoPath =
      entry && entry.type === "local"
        ? entry.path
        : path.join(workspaceRoot, "repos", worktree.repo);

    // `git worktree remove` so the repo's administrative record goes too. A plain
    // rm leaves a registration pointing at nothing, and git then refuses to reuse
    // the path until someone runs `worktree prune` by hand.
    const removed = await simpleGit(repoPath)
      .raw(["worktree", "remove", ...(options.force ? ["--force"] : []), worktree.absPath])
      .then(() => true)
      .catch(() => false);

    if (removed) {
      results.push({ worktree, removed: true, keptBecause: null });
      continue;
    }

    // Never registered with git (a hand-made directory, or `.baseline/`), so there
    // is nothing to deregister and the directory is the whole of it.
    const gone = await fs
      .remove(worktree.absPath)
      .then(() => true)
      .catch(() => false);
    results.push({
      worktree,
      removed: gone,
      keptBecause: gone ? null : "git refused to remove it and the directory could not be deleted",
    });
  }

  // Drop stale administrative records left by anything removed outside git.
  for (const entry of manifest.repos) {
    const repoPath =
      entry.type === "local" ? entry.path : path.join(workspaceRoot, "repos", entry.name);
    await simpleGit(repoPath).raw(["worktree", "prune"]).catch(() => undefined);
  }

  return results;
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
