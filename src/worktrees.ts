import { spawn } from "node:child_process";
import os from "node:os";
import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { atomicWriteFile, isDeadLocalOwner, type LockOwner } from "./file-lock.js";
import { type Manifest, type RepoEntry } from "./manifest.js";
import { mutateState, readState, type TaskState } from "./state.js";
import { findAllTasks, type GoalDefinition } from "./tasks.js";

type Git = ReturnType<typeof simpleGit>;

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
  /**
   * The branch point actually used — the ref the branch was cut from and its sha
   * at that moment. Recorded on the task so the diff base, the baseline and QA all
   * agree on what "the task's change" means, even after a rebase.
   */
  base?: { ref: string; sha: string | null } | null;
  /** True when git already had a worktree on this branch and we reused it. */
  reused: boolean;
  /** Set when isolation could NOT be established — never advertise a path then. */
  error: string | null;
  /**
   * Things the caller should surface but that did not stop isolation: a fetch that
   * failed (so the base may be stale), a configured base branch that does not
   * exist, or a cut from the shared checkout's HEAD because nothing better existed.
   */
  warnings?: string[];
}

/** Goal-level inputs to choosing a task worktree's base (see GoalDefinition). */
export interface WorktreeBaseOptions {
  /** Goal-branch delivery: tasks integrate into this branch when it exists. */
  deliveryBranch?: string | null;
  /** Per-repo base branch for this goal, overriding the manifest's `baseBranch`. */
  baseBranches?: Record<string, string>;
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
  dependsOn: string[] = [],
  baseOptions: WorktreeBaseOptions = {}
): Promise<Worktree[]> {
  const out: Worktree[] = [];

  for (const name of targets) {
    const entry = manifest.repos.find((r) => r.name === name);
    if (!entry) continue;

    // Resolve through the manifest, not repos/<name>: that is a symlink for
    // local repos, and git worktree metadata should reference the real path.
    const repoPath = repoPathFor(workspaceRoot, entry);
    const git = simpleGit(repoPath);
    if (!(await git.checkIsRepo().catch(() => false))) continue;

    const rel = path.join("repos", ".worktrees", name, taskId);
    const abs = path.join(workspaceRoot, rel);
    const branch = `feature/${taskId}`;
    const failed = (error: string): Worktree => ({
      repo: name,
      path: rel,
      branch,
      created: false,
      reused: false,
      error,
      gitDirPath: path.join(repoPath, ".git"),
      writablePaths: [],
    });

    if (await fs.pathExists(abs)) {
      // The directory being there proves nothing about what it is. The SHOP
      // workspace had a hand-made `ALMO-261` checkout and two empty `SHOP-T42`
      // directories from a failed `worktree add` at exactly these paths; reusing
      // them on existence alone sent a worker into a directory that was not this
      // task's checkout. Reuse only what git says is this repo's worktree on this
      // task's branch.
      const verdict = await validateExistingPath(git, repoPath, name, abs, rel, branch, taskId);
      if (verdict === "reuse") {
        // `worktree prune --deps` may have stripped the dependency link while the
        // task sat idle; without it the suite cannot run (§9 item 45).
        await linkDependencies(repoPath, abs);
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
      if (verdict !== "empty") {
        out.push(failed(verdict));
        continue;
      }
      // An empty directory holds nothing to lose, and `git worktree add` accepts
      // one — so create the worktree in it rather than refusing.
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
    const branchExists = branches.all.includes(branch);

    // Only a NEW branch needs a base; an existing one already has its history.
    const base = branchExists
      ? null
      : await resolveTaskBase(git, repoPath, entry, taskId, dependsOn, baseOptions, branches.all);
    if (base && "error" in base) {
      out.push(failed(base.error));
      continue;
    }

    // Cut from the resolved sha, not the ref name: the recorded base and the actual
    // branch point then cannot disagree, and a remote-tracking start point does not
    // make git set `origin/main` as the task branch's upstream.
    const args = base
      ? ["worktree", "add", "-b", branch, abs, base.sha]
      : ["worktree", "add", abs, branch];
    try {
      await git.raw(args).catch(async (err: Error) => {
        // A registration whose directory was deleted by hand blocks the path with
        // "missing but already registered worktree" until someone runs prune.
        if (!/missing but already registered/i.test(err.message)) throw err;
        await git.raw(["worktree", "prune"]);
        await git.raw(args);
      });
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
        basedOn: base?.basedOn ?? null,
        base: base ? { ref: base.ref, sha: base.sha } : null,
        ...(base && base.warnings.length > 0 ? { warnings: base.warnings } : {}),
      });
    } catch (err) {
      // A worktree that cannot be created must not look like isolation.
      out.push(failed((err as Error).message.split("\n")[0]));
    }
  }

  return out;
}

function repoPathFor(workspaceRoot: string, entry: RepoEntry): string {
  return entry.type === "local" ? entry.path : path.join(workspaceRoot, "repos", entry.name);
}

async function realOrSelf(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

/**
 * "reuse" when `abs` is this repo's registered worktree on `branch`, "empty" when
 * it is an empty directory git can create into, otherwise the refusal to report.
 */
async function validateExistingPath(
  git: Git,
  repoPath: string,
  repoName: string,
  abs: string,
  rel: string,
  branch: string,
  taskId: string
): Promise<"reuse" | "empty" | string> {
  const real = await realOrSelf(abs);
  let match: RegisteredWorktree | undefined;
  for (const w of await registeredWorktrees(git)) {
    if ((await realOrSelf(w.worktreePath)) === real) match = w;
  }
  if (match) {
    if (match.branch === branch) return "reuse";
    return (
      `${rel} is a ${repoName} worktree on ${match.branch ?? `a detached HEAD`}, not ${branch}, ` +
      `so it is not ${taskId}'s checkout. Inspect it, remove it ` +
      `(\`git -C ${repoPath} worktree remove ${abs}\`) or move it aside, then re-run \`awo task run ${taskId}\`.`
    );
  }
  const entries = await fs.readdir(abs).catch(() => null);
  if (entries && entries.length === 0) return "empty";
  return (
    `${rel} exists but git has no record of it as a ${repoName} worktree, so whatever it holds ` +
    `is not ${taskId}'s checkout. Inspect it, move it aside (\`mv ${abs} ${abs}.orphan\`), ` +
    `then re-run \`awo task run ${taskId}\`.`
  );
}

// ---------------------------------------------------------------------------
// Choosing a new task branch's base
// ---------------------------------------------------------------------------

interface ResolvedBase {
  ref: string;
  sha: string;
  basedOn: string | null;
  warnings: string[];
}

/**
 * Where a new task branch starts. Measured on the real workspaces: cutting from
 * whatever the shared checkout had checked out — never fetched — flagged 158
 * passing runs `test-and-code-changed` (the diff included everything main had
 * gained since the last pull) and cost 19 manual rebases (F9). So, in order:
 * the dependency's branch, the goal's delivery branch, the goal's per-repo base,
 * the repo's `baseBranch`, the remote's default branch — each fetched first — and
 * the shared HEAD only when nothing else exists, with a warning.
 */
async function resolveTaskBase(
  git: Git,
  repoPath: string,
  entry: RepoEntry,
  taskId: string,
  dependsOn: string[],
  options: WorktreeBaseOptions,
  localBranches: string[]
): Promise<ResolvedBase | { error: string }> {
  const deps = [...new Set(dependsOn.map((dep) => `feature/${dep}`))].filter((b) =>
    localBranches.includes(b)
  );
  if (deps.length > 0) {
    // A dependent task must build ON its dependencies' work (§9 item 44). With
    // several, only a branch that already contains the others holds all of it;
    // picking one of two diverged branches silently drops the other's commits.
    const tip = await descendantOf(repoPath, deps);
    if (!tip) {
      return {
        error:
          `${taskId} depends on ${deps.join(", ")}, which have diverged in ${entry.name}: no one of ` +
          `them contains the others, and awo will not pick one and drop the rest. Merge them into ` +
          `one (e.g. in ${deps[0]}'s worktree: \`git merge ${deps[1]}\`), or delete a branch that is ` +
          `already merged (\`git -C ${repoPath} branch -d <branch>\`), then re-run \`awo task run ${taskId}\`.`,
      };
    }
    return { ref: tip, sha: await revParse(git, tip), basedOn: tip, warnings: [] };
  }

  const resolver = new BaseResolver(git, repoPath);
  const warnings: string[] = [];
  const named: { branch: string; why: string; optional: boolean }[] = [];
  // The delivery branch may legitimately not exist yet (the goal's first task
  // creates it), so its absence is not worth a warning; a configured base is.
  if (options.deliveryBranch) {
    named.push({ branch: options.deliveryBranch, why: "the goal's deliveryBranch", optional: true });
  }
  const goalBase = options.baseBranches?.[entry.name];
  if (goalBase) named.push({ branch: goalBase, why: `the goal's baseBranches.${entry.name}`, optional: false });
  if (entry.baseBranch) named.push({ branch: entry.baseBranch, why: `${entry.name}'s baseBranch`, optional: false });

  const done = (hit: { ref: string; sha: string }): ResolvedBase => ({
    ...hit,
    basedOn: null,
    warnings: [...warnings, ...resolver.notes],
  });

  for (const candidate of named) {
    if (!isPlainBranchName(candidate.branch)) {
      warnings.push(`${candidate.why} "${candidate.branch}" is not a valid branch name — ignored.`);
      continue;
    }
    const hit = await resolver.resolve(candidate.branch);
    if (hit) return done(hit);
    if (!candidate.optional) {
      warnings.push(`${candidate.why} "${candidate.branch}" exists neither locally nor on origin — ignored.`);
    }
  }

  const fallbacks = [await resolver.remoteDefault(), "main", "master"].filter(
    (b, i, all): b is string => !!b && all.indexOf(b) === i
  );
  for (const branch of fallbacks) {
    const hit = await resolver.resolve(branch);
    if (hit) return done(hit);
  }

  const head = await revParse(git, "HEAD").catch(() => "");
  if (!head) {
    return { error: `${entry.name} has no commits yet, so there is nothing to branch ${taskId} from. Commit once, then re-run \`awo task run ${taskId}\`.` };
  }
  warnings.push(
    `No base branch could be resolved for ${entry.name} (no dependency branch, goal or repo base, ` +
      `or origin default), so ${taskId} was cut from the shared checkout's HEAD (${head.slice(0, 12)}). ` +
      `Set "baseBranch" for ${entry.name} in .workspace/manifest.json.`
  );
  return done({ ref: "HEAD", sha: head });
}

/** The branch among `branches` that contains every other one, or null when they diverge. */
async function descendantOf(repoPath: string, branches: string[]): Promise<string | null> {
  for (const candidate of branches) {
    let containsAll = true;
    for (const other of branches) {
      if (other !== candidate && !(await isAncestor(repoPath, other, candidate))) {
        containsAll = false;
        break;
      }
    }
    if (containsAll) return candidate;
  }
  return null;
}

async function isAncestor(repoPath: string, ancestor: string, of: string): Promise<boolean> {
  return (await gitExitCode(repoPath, ["merge-base", "--is-ancestor", ancestor, of])) === 0;
}

/**
 * A git command's exit status. Not through simple-git: it resolves a non-zero exit
 * that printed nothing to stderr, so `merge-base --is-ancestor` and
 * `check-ignore -q` — which answer "no" exactly that way — would always read "yes".
 */
function gitExitCode(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function revParse(git: Git, ref: string): Promise<string> {
  return (await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
}

async function refSha(git: Git, ref: string): Promise<string | null> {
  return (await revParse(git, ref).catch(() => "")) || null;
}

/** Branch names come from goal frontmatter and the manifest; never let one read as a git option. */
function isPlainBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.includes("..");
}

/** Overridable for slow links; the default keeps an offline `task run` snappy. */
function fetchTimeoutMs(): number {
  const fromEnv = Number(process.env.AWO_FETCH_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10_000;
}

interface NetworkResult {
  ok: boolean;
  stdout: string;
  /** First line of stderr, or why the command never finished. */
  message: string;
  /** Raw stderr, for telling "no such ref" apart from "no network". */
  stderr: string;
}

/**
 * A git command that talks to the remote, with a hard timeout, in its own session
 * so ssh or a credential helper cannot stop to prompt on the terminal of a run
 * nobody is watching — it fails instead, and the run continues from what is local.
 */
function networkGit(repoPath: string, args: string[]): Promise<NetworkResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repoPath, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = fetchTimeoutMs();
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve({ ok: false, stdout, stderr, message: `timed out after ${Math.round(timeout / 1000)}s` });
    }, timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, message: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, message: stderr.trim().split("\n")[0] ?? "" });
    });
  });
}

/** Per-repo fetch-then-pick, remembering whether the remote is reachable at all. */
class BaseResolver {
  private origin: boolean | null = null;
  private offline: string | null = null;
  readonly notes: string[] = [];

  constructor(
    private readonly git: Git,
    private readonly repoPath: string
  ) {}

  private async hasOrigin(): Promise<boolean> {
    if (this.origin === null) {
      this.origin = !!(await this.git.raw(["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
    }
    return this.origin;
  }

  /** Offline, or the remote refused: stop asking it — each attempt costs the timeout. */
  private markOffline(message: string): void {
    if (this.offline) return;
    this.offline = message || "fetch failed";
    this.notes.push(
      `Could not reach origin (${this.offline}); the base was resolved from local refs and may be stale.`
    );
  }

  /** The branch `origin/HEAD` names, read locally — `ls-remote` asks the network once if unset. */
  async remoteDefault(): Promise<string | null> {
    if (!(await this.hasOrigin())) return null;
    const local = (
      await this.git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")
    ).trim();
    if (local.startsWith("refs/remotes/origin/")) return local.slice("refs/remotes/origin/".length);
    if (this.offline) return null;
    const remote = await networkGit(this.repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    if (!remote.ok) {
      this.markOffline(remote.message);
      return null;
    }
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote.stdout);
    return m ? m[1] : null;
  }

  async resolve(branch: string): Promise<{ ref: string; sha: string } | null> {
    let missingOnRemote = false;
    let fetched = false;
    if ((await this.hasOrigin()) && !this.offline) {
      const result = await networkGit(this.repoPath, [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      if (result.ok) fetched = true;
      else if (/couldn't find remote ref/i.test(result.stderr)) missingOnRemote = true;
      else this.markOffline(result.message);
    }

    const remote = missingOnRemote ? null : await refSha(this.git, `refs/remotes/origin/${branch}`);
    const local = await refSha(this.git, `refs/heads/${branch}`);
    if (!remote && !local) return null;
    if (remote && !local) return { ref: `origin/${branch}`, sha: remote };
    if (local && !remote) return { ref: branch, sha: local };

    if (!fetched) {
      // Without a fresh fetch neither side is authoritative: take whichever
      // already contains the other, and the remote-tracking ref if they diverged.
      if (local !== remote && (await isAncestor(this.repoPath, remote!, local!))) return { ref: branch, sha: local! };
      return { ref: `origin/${branch}`, sha: remote! };
    }

    const ahead = Number.parseInt(
      (await this.git.raw(["rev-list", "--count", `${remote}..${local}`]).catch(() => "0")).trim(),
      10
    );
    if (ahead > 0) {
      this.notes.push(
        `Local ${branch} has ${ahead} commit(s) origin/${branch} lacks; they are not in this task's base — push them first if the task needs them.`
      );
    }
    return { ref: `origin/${branch}`, sha: remote! };
  }
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
  /** A registered checkout with no branch — safe only if a ref still reaches its HEAD. */
  detached?: boolean;
  /** `git worktree lock`ed: git refuses to remove it, so neither will awo. */
  locked?: boolean;
  /** A `.baseline/<repo>` scratch tree from `task event --baseline`, never authored work. */
  baseline?: boolean;
  /** Set when a measurement is still running in that baseline tree: who, or why it is assumed. */
  active?: string | null;
  /**
   * How the branch's commits are known to be delivered when no branch contains its
   * tip: squash-merged (patch-equivalent on a base) or its PR recorded as merged.
   */
  mergedBy?: string | null;
}

/** Removing this destroys nothing: it is clean, and its commits live elsewhere. */
export function isSafeToRemove(worktree: ExistingWorktree): boolean {
  // Scratch by construction — unless a measurement is running in it right now.
  if (worktree.baseline) return !worktree.active;
  // A directory git has no record of cannot be reasoned about — nothing says where
  // its commits went, or whether it has any. Empty, it is obviously safe; otherwise
  // it is reported and kept until a person looks at it.
  if (!worktree.registered) return worktree.empty === true;
  if (worktree.dirty || worktree.locked) return false;
  return (
    worktree.unmergedCommits === 0 || worktree.containedIn.length > 0 || !!worktree.mergedBy
  );
}

/** Why removing this would lose something, or null when it would not. */
export function unsafeReason(worktree: ExistingWorktree): string | null {
  if (isSafeToRemove(worktree)) return null;
  if (worktree.baseline) return `a baseline measurement is running in it (${worktree.active})`;
  if (!worktree.registered) return "git has no record of it, so its work cannot be accounted for";
  if (worktree.dirty) return "uncommitted changes in the checkout";
  if (worktree.locked) return "git has it locked (`git worktree unlock` it first if it is really finished)";
  if (worktree.detached) {
    return `detached HEAD with ${worktree.unmergedCommits} commit(s) no branch or remote reaches`;
  }
  return `${worktree.unmergedCommits} commit(s) no other branch contains (nor a remote, a merged PR, or an equivalent patch on the base)`;
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
  // git reports worktree paths as it resolved them (`/private/var/…` on macOS for a
  // `/var/…` workspace), so compare real paths and report workspace-relative ones.
  const realRoot = await realOrSelf(root);
  const baselineRoot = path.join(realRoot, ".baseline");

  const sizeOf = async (dir: string): Promise<number> =>
    options.withSizes ? directoryBytes(dir) : 0;
  const tasks = lazyTaskContext(workspaceRoot);
  const out: ExistingWorktree[] = [];

  // Concurrently, across repos and across each repo's worktrees. Answering "is this
  // safe to remove?" costs three git invocations per checkout, and doing 20 of them
  // in sequence took `doctor` from 0.27s to 1.7s — for a command whose whole job is
  // to be the cheap thing you run before anything else.
  const perRepo = await Promise.all(
    manifest.repos.map(async (entry): Promise<ExistingWorktree[]> => {
      const repoPath = repoPathFor(workspaceRoot, entry);
      const git = simpleGit(repoPath);
      if (!(await git.checkIsRepo().catch(() => false))) return [];
      const evidence = new MergeEvidence(git, repoPath, entry, tasks);

      const registered: (RegisteredWorktree & { rel: string })[] = [];
      for (const w of await registeredWorktrees(git)) {
        // A registration whose directory is gone is git's bookkeeping, not a
        // checkout; the `worktree prune` at the end of a prune drops it.
        if (!(await fs.pathExists(w.worktreePath))) continue;
        const real = await realOrSelf(w.worktreePath);
        // Only ours. A developer's own worktree elsewhere on disk is none of our
        // business, and removing it would be a surprise a tool never earns back.
        // Baseline scratch checkouts are reported per repo below instead.
        if (!real.startsWith(realRoot + path.sep) || real.startsWith(baselineRoot + path.sep)) continue;
        registered.push({ ...w, rel: path.relative(realRoot, real) });
      }

      return Promise.all(
        registered.map(async (w): Promise<ExistingWorktree> => {
          const abs = path.join(root, w.rel);
          const [status, safety, bytes, ownLink] = await Promise.all([
            simpleGit(abs).status().catch(() => null),
            commitSafety(git, abs, w.branch),
            sizeOf(abs),
            hasOwnDependencyLink(abs),
          ]);
          // The `node_modules` link awo made is not the worker's change: under a
          // `node_modules/` pattern (directories only) git calls it untracked, and
          // every linked worktree looked dirty and was kept forever.
          const changes = (status?.files ?? []).filter(
            (f) => !(ownLink && f.path === "node_modules" && f.index === "?")
          );
          const found: ExistingWorktree = {
            repo: entry.name,
            path: path.relative(workspaceRoot, abs),
            absPath: abs,
            leaf: path.basename(abs),
            branch: w.branch,
            dirty: status === null || changes.length > 0,
            unmergedCommits: safety.unmergedCommits,
            containedIn: safety.containedIn,
            registered: true,
            bytes,
            ...(w.branch ? {} : { detached: true }),
            ...(w.locked ? { locked: true } : {}),
          };
          // Squash merges leave no ref containing the tip, so after the usual GitHub
          // flow every finished task looked like unmerged work and prune kept all of
          // them: 117 of 126 `state.worktree` pointers in the real workspaces
          // dangled, and the SHOP disk filled (F10). Only asked when needed — it
          // costs a patch-id pass over the base.
          if (
            w.branch &&
            safety.head &&
            !found.dirty &&
            !found.locked &&
            found.unmergedCommits > 0 &&
            found.containedIn.length === 0
          ) {
            found.mergedBy = await evidence.deliveredBy(w.branch, safety.head, found.leaf);
          }
          return found;
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
      const isRepo = !empty && (await git.checkIsRepo().catch(() => false));
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
  // they are safe — unless a measurement is running in one right now, which the
  // lease it writes says (removing it mid-run failed that measurement).
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
      baseline: true,
      active: await activeBaseline(abs),
    });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface RegisteredWorktree {
  worktreePath: string;
  branch: string | null;
  locked: boolean;
}

/** `git worktree list --porcelain`, minus the main checkout. */
async function registeredWorktrees(git: Git): Promise<RegisteredWorktree[]> {
  const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  const out: RegisteredWorktree[] = [];
  let current: string | null = null;
  let branch: string | null = null;
  let locked = false;
  let bare = false;
  let first = true;
  const flush = (): void => {
    // The first record is the main checkout (or the bare repo itself) — never ours.
    if (current && !first && !bare) out.push({ worktreePath: current, branch, locked });
    if (current) first = false;
    current = null;
    branch = null;
    locked = false;
    bare = false;
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length).trim();
    } else if (line === "locked" || line.startsWith("locked ")) {
      locked = true;
    } else if (line === "bare") {
      bare = true;
    }
  }
  flush();
  return out;
}

/**
 * How much work would be lost. A branch whose tip another ref already contains has
 * been merged somewhere — which under `goal-feature-branch` is the delivery branch,
 * not main, so "merged into the default branch" is the wrong question to ask. A
 * remote branch counts too: once pushed, removing the checkout loses nothing.
 */
async function commitSafety(
  git: Git,
  worktreePath: string,
  branch: string | null
): Promise<{ unmergedCommits: number; containedIn: string[]; head: string | null }> {
  const head = (await simpleGit(worktreePath).revparse(["HEAD"]).catch(() => "")).trim();
  if (!head) return { unmergedCommits: 0, containedIn: [], head: null };

  const [containedRaw, uniqueRaw] = await Promise.all([
    git
      .raw(["for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads", "refs/remotes"])
      .catch(() => ""),
    // `--exclude` patterns are matched against the ref name with `refs/heads/`
    // already stripped, because `--branches` is what expands them. Passing the full
    // `refs/heads/<branch>` excludes nothing, the branch counts as reaching its own
    // tip, and every worktree reports 0 unmerged commits — which is the answer that
    // makes a prune destructive.
    git
      .raw([
        "rev-list",
        "--count",
        head,
        "--not",
        ...(branch ? [`--exclude=${branch}`] : []),
        "--branches",
        "--remotes",
      ])
      .catch(() => null),
  ]);

  const containedIn = containedRaw
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "" && ref !== `refs/heads/${branch}` && !ref.endsWith("/HEAD"))
    .map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ""));

  // Commits unique to this tip, measured against every other branch and remote ref
  // — the question `git log --not --branches --remotes` answers. A detached HEAD
  // nothing reaches is exactly the work a careless prune would destroy. An answer
  // git could not give is treated as unknown work, never as none.
  const unmerged = uniqueRaw === null ? 1 : Number.parseInt(uniqueRaw.trim(), 10);
  return { unmergedCommits: Number.isFinite(unmerged) ? unmerged : 1, containedIn, head };
}

interface TaskContext {
  state: TaskState | null;
  goal: GoalDefinition;
}

/** Task states and goals, read once and only if some worktree needs them. */
function lazyTaskContext(workspaceRoot: string): () => Promise<Map<string, TaskContext>> {
  let memo: Promise<Map<string, TaskContext>> | null = null;
  return () => {
    memo ??= (async () => {
      const out = new Map<string, TaskContext>();
      const states = new Map<string, Promise<Record<string, TaskState>>>();
      for (const { task, goal } of await findAllTasks(workspaceRoot).catch(() => [])) {
        let s = states.get(goal.dir);
        if (!s) {
          s = readState(goal.dir, goal.id)
            .then((state) => state.tasks)
            .catch(() => ({}));
          states.set(goal.dir, s);
        }
        out.set(task.id, { state: (await s)[task.id] ?? null, goal });
      }
      return out;
    })();
    return memo;
  };
}

/** The PR recorded as merged for this repo's copy of the branch, described. */
function mergedPullRequest(state: TaskState | null | undefined, repo: string, branch: string): string | null {
  if (!state) return null;
  const candidates = [
    ...Object.entries(state.pullRequests ?? {}).map(([key, pr]) => ({ key, pr })),
    ...(state.pullRequest ? [{ key: state.pullRequest.repo, pr: state.pullRequest }] : []),
  ];
  for (const { key, pr } of candidates) {
    if (!(pr.merged === true || pr.state === "MERGED")) continue;
    // The same `feature/<task>` name exists in every repo a task targets; a merged
    // PR in one says nothing about the others.
    if ((pr.repo ?? key) !== repo) continue;
    if (pr.branch && pr.branch !== branch) continue;
    return `pull request #${pr.number} is recorded as merged`;
  }
  return null;
}

/**
 * Whether a branch no ref contains was nonetheless delivered: its PR is recorded as
 * merged, every commit has a patch-equivalent on a base (`git cherry` — rebase
 * merges), or its whole diff matches one commit there (a squash merge). Memoised
 * per repo, because the base's patch ids are the expensive part.
 */
class MergeEvidence {
  private readonly patchIds = new Map<string, Promise<Set<string>>>();
  private refs: Promise<string[]> | null = null;

  constructor(
    private readonly git: Git,
    private readonly repoPath: string,
    private readonly entry: RepoEntry,
    private readonly tasks: () => Promise<Map<string, TaskContext>>
  ) {}

  async deliveredBy(branch: string, head: string, leaf: string): Promise<string | null> {
    const context = (await this.tasks()).get(leaf);
    const pr = mergedPullRequest(context?.state, this.entry.name, branch);
    if (pr) return pr;
    for (const base of await this.bases(context?.goal)) {
      if (await this.cherryEquivalent(base, head)) return `every commit has a patch-equivalent on ${base}`;
      if (await this.squashEquivalent(base, head)) return `squash-merged into ${base}`;
    }
    return null;
  }

  /** Existing refs a task branch may have been merged into, remote-tracking first. */
  private async bases(goal: GoalDefinition | undefined): Promise<string[]> {
    const names = [
      goal?.baseBranches?.[this.entry.name],
      goal?.deliveryBranch ?? undefined,
      this.entry.baseBranch,
      ...(await this.defaultNames()),
    ].filter((b): b is string => !!b && isPlainBranchName(b));
    const out: string[] = [];
    for (const name of [...new Set(names)]) {
      for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
        if (await refSha(this.git, ref)) out.push(ref.replace(/^refs\/(heads|remotes)\//, ""));
      }
    }
    return out;
  }

  private defaultNames(): Promise<string[]> {
    this.refs ??= (async () => {
      const symbolic = (
        await this.git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")
      ).trim();
      const remoteDefault = symbolic.startsWith("refs/remotes/origin/")
        ? symbolic.slice("refs/remotes/origin/".length)
        : null;
      return [remoteDefault, "main", "master"].filter((b): b is string => !!b);
    })();
    return this.refs;
  }

  private async cherryEquivalent(base: string, head: string): Promise<boolean> {
    const lines = (await this.git.raw(["cherry", base, head]).catch(() => ""))
      .split("\n")
      .filter((l) => l.trim() !== "");
    return lines.length > 0 && lines.every((l) => l.startsWith("-"));
  }

  private async squashEquivalent(base: string, head: string): Promise<boolean> {
    const point = (await this.git.raw(["merge-base", base, head]).catch(() => "")).trim();
    if (!point) return false;
    const [own] = await patchIdsOf(this.repoPath, [
      "diff", "--no-ext-diff", "--no-textconv", point, head,
    ]);
    if (!own) return false;
    let ids = this.patchIds.get(base);
    if (!ids) {
      // Bounded: a squash merged further back than this is reported as unmerged,
      // which keeps the checkout — the safe way to be wrong.
      ids = patchIdsOf(this.repoPath, [
        "log", "-p", "--no-merges", "--no-ext-diff", "--no-textconv", "--max-count=500", base,
      ]).then((list) => new Set(list));
      this.patchIds.set(base, ids);
    }
    return (await ids).has(own);
  }
}

/** `git <producer> | git patch-id --stable`, returning the patch ids in order. */
function patchIdsOf(repoPath: string, producer: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const source = spawn("git", ["-C", repoPath, ...producer], { stdio: ["ignore", "pipe", "ignore"] });
    const sink = spawn("git", ["-C", repoPath, "patch-id", "--stable"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    sink.stdin?.on("error", () => undefined);
    source.stdout?.pipe(sink.stdin!);
    sink.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const fail = (): void => resolve([]);
    source.on("error", fail);
    sink.on("error", fail);
    sink.on("close", () =>
      resolve(
        out
          .split("\n")
          .map((l) => l.split(" ")[0])
          .filter((id) => /^[0-9a-f]{40,64}$/.test(id))
      )
    );
  });
}

/**
 * Whether a measurement still runs in a `.baseline/<repo>` tree: a lease naming a
 * live process on this host, a lease from another host (unverifiable, so kept), or
 * a directory so new its lease may not be written yet. Null when idle.
 */
async function activeBaseline(dir: string): Promise<string | null> {
  for (const leaf of await fs.readdir(dir).catch(() => [])) {
    const measurement = path.join(dir, leaf);
    const stat = await fs.stat(measurement).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const lease = parseLease(await fs.readJson(path.join(measurement, BASELINE_LEASE)).catch(() => null));
    if (lease) {
      if (!isDeadLocalOwner(lease)) return `pid ${lease.pid} on ${lease.hostname}`;
      continue;
    }
    if (Date.now() - stat.mtimeMs < BASELINE_LEASE_GRACE_MS) return `${leaf} was created moments ago`;
  }
  return null;
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
  options: {
    select: (worktree: ExistingWorktree) => boolean;
    force?: boolean;
    /** Measure each candidate first, so the caller can report what was freed. */
    withSizes?: boolean;
  }
): Promise<PrunedWorktree[]> {
  const results: PrunedWorktree[] = [];
  const keep = (worktree: ExistingWorktree, keptBecause: string): void => {
    results.push({ worktree, removed: false, keptBecause });
  };

  for (const worktree of await listWorktrees(workspaceRoot, manifest, { withSizes: options.withSizes })) {
    if (!options.select(worktree)) continue;
    const entry = manifest.repos.find((r) => r.name === worktree.repo);
    const repoPath = entry ? repoPathFor(workspaceRoot, entry) : path.join(workspaceRoot, "repos", worktree.repo);

    if (worktree.baseline) {
      // Not even `--force`: a live measurement is not work to discard, it is a
      // command in progress, and pulling its checkout away just fails it.
      if (worktree.active) {
        keep(worktree, unsafeReason(worktree)!);
        continue;
      }
      const gone = await removeBaselineTree(repoPath, worktree.absPath);
      results.push({ worktree, removed: gone, keptBecause: gone ? null : "the baseline directory could not be deleted" });
      continue;
    }

    if (!options.force && !isSafeToRemove(worktree)) {
      keep(worktree, unsafeReason(worktree)!);
      continue;
    }

    if (!worktree.registered) {
      // Deleted directly only when it is positively scratch — empty. `rmdir`, not a
      // recursive remove, so a file appearing in the meantime makes it fail. A
      // hand-made checkout git knows nothing about is left for a person, even
      // under `--force`: nothing says whose work it is.
      if (worktree.empty) {
        const gone = await fs.rmdir(worktree.absPath).then(() => true, () => false);
        results.push({ worktree, removed: gone, keptBecause: gone ? null : "it is no longer empty" });
      } else {
        keep(
          worktree,
          `git has no record of it, so awo will not delete it — inspect it, then \`rm -rf ${worktree.absPath}\` yourself if it is disposable`
        );
      }
      continue;
    }

    // Drop awo's own dependency link first: git counts an untracked symlink as a
    // reason to refuse, and unlinking never touches the shared install it points at.
    // A link someone committed is the branch's content, not ours — left alone.
    if (
      (await hasOwnDependencyLink(worktree.absPath)) &&
      (await gitExitCode(worktree.absPath, ["ls-files", "--error-unmatch", "node_modules"])) !== 0
    ) {
      await fs.unlink(path.join(worktree.absPath, "node_modules")).catch(() => undefined);
    }
    // `git worktree remove` so the repo's administrative record goes too. A plain
    // rm leaves a registration pointing at nothing, and git then refuses to reuse
    // the path until someone runs `worktree prune` by hand.
    const refusal = await simpleGit(repoPath)
      .raw(["worktree", "remove", ...(options.force ? ["--force"] : []), worktree.absPath])
      .then(() => null)
      .catch((err: Error) => err.message.split("\n").find((l) => l.trim()) ?? "git refused");

    if (refusal === null) {
      results.push({ worktree, removed: true, keptBecause: null });
      continue;
    }
    // Git's refusal is the last word. Until 0.8 a refusal fell through to a
    // recursive delete — so a dirty or locked checkout git had just declined to
    // remove was destroyed anyway (F25).
    keep(worktree, `git refused to remove it: ${refusal.replace(/^fatal:\s*/, "")}`);
  }

  // Drop stale administrative records left by anything removed outside git.
  for (const entry of manifest.repos) {
    await simpleGit(repoPathFor(workspaceRoot, entry)).raw(["worktree", "prune"]).catch(() => undefined);
  }

  await clearWorktreePointers(
    workspaceRoot,
    results.filter((r) => r.removed).map((r) => r.worktree.absPath)
  );
  return results;
}

/**
 * A baseline tree is awo's own scratch: detached checkouts of a branch point every
 * task branch still reaches. Deregister each checkout git knows about (`--force`:
 * the test command will have left build output behind), then delete the rest.
 */
async function removeBaselineTree(repoPath: string, dir: string): Promise<boolean> {
  const git = simpleGit(repoPath);
  const real = await realOrSelf(dir);
  for (const w of await registeredWorktrees(git)) {
    if ((await realOrSelf(w.worktreePath)).startsWith(real + path.sep)) {
      await git.raw(["worktree", "remove", "--force", w.worktreePath]).catch(() => undefined);
    }
  }
  const gone = await fs.remove(dir).then(() => true, () => false);
  await git.raw(["worktree", "prune"]).catch(() => undefined);
  return gone;
}

/**
 * Null every `state.worktree` that points at a removed checkout or at nothing at
 * all. Measured on the real workspaces: 117 of 126 pointers dangled (F10), so
 * `context` and doctor kept advertising directories that no longer existed.
 */
export async function clearWorktreePointers(workspaceRoot: string, removed: string[] = []): Promise<number> {
  const gone = new Set(await Promise.all(removed.map((p) => path.resolve(p))));
  const byGoal = new Map<string, { goal: GoalDefinition; taskIds: string[] }>();
  for (const { task, goal } of await findAllTasks(workspaceRoot).catch(() => [])) {
    const group = byGoal.get(goal.dir) ?? { goal, taskIds: [] };
    group.taskIds.push(task.id);
    byGoal.set(goal.dir, group);
  }

  let cleared = 0;
  for (const { goal, taskIds } of byGoal.values()) {
    const state = await readState(goal.dir, goal.id).catch(() => null);
    if (!state) continue;
    const stale: string[] = [];
    for (const id of taskIds) {
      const pointer = state.tasks[id]?.worktree;
      if (!pointer) continue;
      const abs = path.resolve(workspaceRoot, pointer);
      if (gone.has(abs) || !(await fs.pathExists(abs))) stale.push(id);
    }
    if (stale.length === 0) continue;
    await mutateState(goal.dir, goal.id, (s) => {
      for (const id of stale) {
        const t = s.tasks[id];
        if (t?.worktree) {
          t.worktree = null;
          cleared += 1;
        }
      }
    });
  }
  return cleared;
}

/** The worktree path currently holding `branch`, if any. */
async function worktreeForBranch(git: Git, branch: string): Promise<string | null> {
  const raw = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  let current: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    if (line.trim() === `branch refs/heads/${branch}` && current) {
      if (await fs.pathExists(current)) return current;
      // Registered, but the directory was deleted by hand: advertising it would
      // point the worker at nothing (§9 item 37). Drop the stale record instead,
      // which frees the branch for a fresh worktree.
      await git.raw(["worktree", "prune"]).catch(() => undefined);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency directories
// ---------------------------------------------------------------------------

/** Rebuildable output a worktree accumulates; deleted only when gitignored. */
const DEPENDENCY_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", ".cache", "build"]);

export interface StrippedDependencies {
  worktree: ExistingWorktree;
  /** Workspace-relative paths removed (or that would be, on a dry run). */
  removed: { path: string; bytes: number; link: boolean }[];
  bytes: number;
  /** Set when nothing was touched in this worktree, and why. */
  skippedBecause: string | null;
}

/**
 * `worktree prune --deps`: free the disk a kept worktree's dependencies and build
 * output occupy, without removing the checkout. A task in review cannot be pruned
 * — its branch is not merged — but its `node_modules`, `.next` and `dist` are
 * rebuildable; the SHOP disk filled with exactly those (F10, Nov 20).
 *
 * Only gitignored directories are deleted, so nothing tracked can go. A symlinked
 * `node_modules` (how task worktrees share the repo's install) is unlinked, never
 * followed: deleting through it would wipe the shared checkout's dependencies.
 * The next `task run` re-links it.
 */
export async function stripDependencyDirs(
  workspaceRoot: string,
  manifest: Manifest,
  options: {
    select: (worktree: ExistingWorktree) => boolean;
    /** Task ids whose worktree is in use right now; never touched. */
    running: Set<string>;
    dryRun?: boolean;
  }
): Promise<StrippedDependencies[]> {
  const out: StrippedDependencies[] = [];
  for (const worktree of await listWorktrees(workspaceRoot, manifest)) {
    if (worktree.baseline || !worktree.registered || !options.select(worktree)) continue;
    const skip = (why: string): void => {
      out.push({ worktree, removed: [], bytes: 0, skippedBecause: why });
    };
    if (options.running.has(worktree.leaf)) {
      skip("its task is running");
      continue;
    }

    const git = simpleGit(worktree.absPath);
    const ignored = (
      await git
        .raw(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .catch(() => null)
    );
    if (ignored === null) {
      skip("git could not list its ignored files");
      continue;
    }
    const candidates = new Set(
      ignored
        .split("\0")
        .map((p) => p.replace(/\/$/, ""))
        .filter((p) => p !== "" && DEPENDENCY_DIRS.has(path.basename(p)))
    );
    // The link awo itself creates. A `node_modules/` pattern matches directories
    // only, so git reports the symlink as untracked rather than ignored; it is
    // still ours to remove as long as git does not track it.
    const link = path.join(worktree.absPath, "node_modules");
    if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) {
      const tracked = (await gitExitCode(worktree.absPath, ["ls-files", "--error-unmatch", "node_modules"])) === 0;
      if (!tracked) candidates.add("node_modules");
    }

    const removed: StrippedDependencies["removed"] = [];
    for (const rel of [...candidates].sort()) {
      const abs = path.join(worktree.absPath, rel);
      const stat = await fs.lstat(abs).catch(() => null);
      if (!stat) continue;
      const isLink = stat.isSymbolicLink();
      if (!isLink && !stat.isDirectory()) continue;
      if (!isLink) {
        // Belt and braces over the listing: the directory itself must be ignored and
        // must hold nothing git tracks, so a committed `dist/` can never go.
        const ignoredItself = (await gitExitCode(worktree.absPath, ["check-ignore", "-q", rel])) === 0;
        const tracked = (await git.raw(["ls-files", "--", rel]).catch(() => "x")).trim() !== "";
        if (!ignoredItself || tracked) continue;
      }
      const bytes = isLink ? 0 : await directoryBytes(abs);
      if (!options.dryRun) {
        const ok = isLink
          ? await fs.unlink(abs).then(() => true, () => false)
          : await fs.remove(abs).then(() => true, () => false);
        if (!ok) continue;
      }
      removed.push({ path: path.relative(workspaceRoot, abs), bytes, link: isLink });
    }
    out.push({
      worktree,
      removed,
      bytes: removed.reduce((a, r) => a + r.bytes, 0),
      skippedBecause: removed.length === 0 ? "no gitignored dependency or build directories" : null,
    });
  }
  return out;
}

/**
 * Whether a shell command installs dependencies. Matched per `&&`/`;`/`|` segment
 * so `npm ci && npm test` counts and `yarn test` does not.
 */
export function runsInstaller(command: string): boolean {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .some((segment) =>
      /^(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|bun\s+(?:install|i)|yarn\s+install)(?:\s|$)/.test(segment) ||
      /^yarn(?:\s+-\S+)*\s*$/.test(segment)
    );
}

/**
 * Make an install command safe to run in a task worktree whose `node_modules` is
 * the link to the repo's shared install. `npm ci` deletes `node_modules` before
 * installing — through the link, that wiped the shared checkout's dependencies
 * and broke every other worktree using them (F11). Swap the link for an empty
 * private directory first. Returns a note for the record, or null when nothing
 * needed doing.
 */
export async function prepareDependencyDirs(checkout: string, command: string): Promise<string | null> {
  if (!runsInstaller(command)) return null;
  const modules = path.join(checkout, "node_modules");
  if (!(await fs.lstat(modules).catch(() => null))?.isSymbolicLink()) return null;
  const target = await fs.readlink(modules).catch(() => "the shared install");
  await fs.unlink(modules);
  await fs.mkdir(modules);
  return (
    `node_modules was a link to ${target}; replaced it with an empty directory so ` +
    `\`${command}\` installs privately instead of rewriting the shared dependencies.`
  );
}

// ---------------------------------------------------------------------------
// Baseline leases
// ---------------------------------------------------------------------------

/** Written into each baseline measurement directory while the measurement runs. */
export const BASELINE_LEASE = ".awo-active";
/** A measurement directory younger than this may not have its lease written yet. */
const BASELINE_LEASE_GRACE_MS = 60_000;

function parseLease(raw: unknown): LockOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pid !== "number" || typeof o.hostname !== "string") return null;
  return { pid: o.pid, hostname: o.hostname, acquiredAt: String(o.acquiredAt ?? "") };
}

/** Claim a baseline measurement directory for this process, so prune leaves it alone. */
export async function writeBaselineLease(dir: string, detail: Record<string, unknown> = {}): Promise<string> {
  const file = path.join(dir, BASELINE_LEASE);
  const lease: LockOwner & Record<string, unknown> = {
    ...detail,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  await atomicWriteFile(file, JSON.stringify(lease) + "\n");
  return file;
}

/** Whether `node_modules` in a checkout is a symlink — how awo shares the repo's install. */
async function hasOwnDependencyLink(checkout: string): Promise<boolean> {
  return !!(await fs.lstat(path.join(checkout, "node_modules")).catch(() => null))?.isSymbolicLink();
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
