import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/d1-worktrees.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const mod = (name: string) => import(pathToFileURL(path.join(REPO_ROOT, "dist", name)).href);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function awo(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function commit(cwd: string, file: string, text: string, message = file): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  // Only the named file: `-A` would also stage awo's own node_modules link.
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** realpath'd temp root: git reports `/private/var/…` on macOS, so tests use the same. */
function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awo-d1-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A bare origin, a seed clone that can push to it, and `api` — the clone awo connects. */
function repoWithOrigin(root: string): { origin: string; seed: string; api: string } {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const api = path.join(root, "api");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  commit(seed, "README.md", "# api\n", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", origin, api);
  return { origin, seed, api };
}

function localRepo(root: string, name = "api"): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "README.md", "# api\n", "init");
  return repo;
}

/** A workspace with `api` connected and one goal holding the given tasks. */
function workspace(
  root: string,
  repo: string,
  tasks: { id: string; dependsOn?: string[] }[] = [{ id: "DW-T1" }]
): string {
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  execFileSync(process.execPath, [CLI, "init", "--key", "DW"], { cwd: ws, stdio: "ignore" });
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: ws, stdio: "ignore" });
  const goalDir = path.join(ws, "goals", "DW-G1-demo");
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goalDir, "goal.md"), `---\nid: DW-G1\ntitle: Demo\nstatus: planning\n---\n\nDemo.\n`);
  for (const task of tasks) {
    fs.writeFileSync(
      path.join(goalDir, "tasks", `${task.id}-x.md`),
      `---\nid: ${task.id}\ngoalId: DW-G1\nname: ${task.id}\ntargets: [api]\ndependsOn: [${(task.dependsOn ?? []).join(", ")}]\nstatus: todo\n---\n\nDo it.\n`
    );
  }
  return ws;
}

function writeState(ws: string, tasks: Record<string, Record<string, unknown>>): void {
  const full: Record<string, unknown> = {};
  for (const [id, fields] of Object.entries(tasks)) {
    full[id] = {
      status: "todo",
      lastRunOutcome: null,
      lastRunId: null,
      startedAt: null,
      finishedAt: null,
      attempts: 1,
      worktree: null,
      blockedReason: null,
      ...fields,
    };
  }
  fs.writeFileSync(
    path.join(ws, "goals", "DW-G1-demo", "state.json"),
    JSON.stringify({ rev: 1, goalId: "DW-G1", goalStatus: "planning", updatedAt: "", tasks: full }, null, 2)
  );
}

function readTaskState(ws: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ws, "goals", "DW-G1-demo", "state.json"), "utf8")).tasks[id];
}

async function ensure(
  ws: string,
  taskId: string,
  dependsOn: string[] = [],
  baseOptions: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  const { ensureTaskWorktrees } = await mod("worktrees.js");
  const { readManifest } = await mod("manifest.js");
  const [wt] = await ensureTaskWorktrees(ws, await readManifest(ws), taskId, ["api"], dependsOn, baseOptions);
  return wt;
}

const wtPath = (ws: string, id: string) => path.join(ws, "repos", ".worktrees", "api", id);
const headOf = (dir: string) => git(dir, "rev-parse", "HEAD").trim();

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}

// ---------------------------------------------------------------------------
// D1-1 base resolution
// ---------------------------------------------------------------------------

test("a new task branch is cut from the fetched origin default, not the stale shared checkout", (t) => {
  const root = tempRoot(t);
  const { seed, api } = repoWithOrigin(root);
  // origin moves on; the shared checkout `api` never pulls.
  const fresh = commit(seed, "feature.txt", "new on main\n");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const stale = headOf(api);
  assert.notEqual(stale, fresh);

  const ws = workspace(root, api);
  const out = awo(ws, ["task", "run", "DW-T1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(headOf(wtPath(ws, "DW-T1")), fresh, "the worktree starts at origin/main after a fetch");
  assert.equal(headOf(api), stale, "the shared checkout itself is untouched");
  // Cut from a sha, so the task branch does not track origin/main.
  assert.throws(() => git(wtPath(ws, "DW-T1"), "rev-parse", "--abbrev-ref", "@{upstream}"));
});

test("base precedence: deliveryBranch, then goal baseBranches, then repo baseBranch, then origin/HEAD", async (t) => {
  const root = tempRoot(t);
  const { seed, api } = repoWithOrigin(root);
  const mainSha = headOf(seed);
  git(seed, "checkout", "-q", "-b", "release");
  const releaseSha = commit(seed, "release.txt", "r\n");
  git(seed, "checkout", "-q", "-b", "goal/one");
  const goalSha = commit(seed, "goal.txt", "g\n");
  git(seed, "push", "-q", "origin", "release", "goal/one");

  const ws = workspace(root, api, [{ id: "DW-T1" }, { id: "DW-T2" }, { id: "DW-T3" }, { id: "DW-T4" }, { id: "DW-T5" }]);
  const manifestFile = path.join(ws, ".workspace", "manifest.json");

  // The delivery branch exists only on origin — fetched, then used.
  let wt = await ensure(ws, "DW-T1", [], { deliveryBranch: "goal/one", baseBranches: { api: "release" } });
  assert.equal(wt.error, null);
  assert.deepEqual(wt.base, { ref: "origin/goal/one", sha: goalSha });
  assert.equal(headOf(wtPath(ws, "DW-T1")), goalSha);

  // Not created yet: silently falls through to the goal's per-repo base.
  wt = await ensure(ws, "DW-T2", [], { deliveryBranch: "goal/missing", baseBranches: { api: "release" } });
  assert.deepEqual(wt.base, { ref: "origin/release", sha: releaseSha });
  assert.equal(wt.warnings, undefined, "an absent delivery branch is expected, not a warning");

  // The manifest's baseBranch when the goal says nothing.
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.repos[0].baseBranch = "release";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  wt = await ensure(ws, "DW-T3");
  assert.deepEqual(wt.base, { ref: "origin/release", sha: releaseSha });

  // A configured base that does not exist is reported, then the next rule applies.
  wt = await ensure(ws, "DW-T4", [], { baseBranches: { api: "nope" } });
  assert.deepEqual(wt.base, { ref: "origin/release", sha: releaseSha });
  assert.match(wt.warnings.join("\n"), /baseBranches\.api "nope" exists neither locally nor on origin/);

  // Nothing configured: origin/HEAD.
  delete manifest.repos[0].baseBranch;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  wt = await ensure(ws, "DW-T5");
  assert.deepEqual(wt.base, { ref: "origin/main", sha: mainSha });
});

test("an unreachable origin does not fail the run; the base comes from local refs with a note", async (t) => {
  const root = tempRoot(t);
  const { api } = repoWithOrigin(root);
  const local = headOf(api);
  git(api, "remote", "set-url", "origin", path.join(root, "gone.git"));
  const ws = workspace(root, api);

  const wt = await ensure(ws, "DW-T1");
  assert.equal(wt.error, null);
  assert.deepEqual(wt.base, { ref: "origin/main", sha: local });
  assert.match(wt.warnings.join("\n"), /Could not reach origin/);
});

test("a repo without origin keeps today's behaviour: the local default branch", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const main = headOf(repo);
  git(repo, "checkout", "-q", "-b", "scratch");
  commit(repo, "scratch.txt", "not a base\n");
  const ws = workspace(root, repo);

  const wt = await ensure(ws, "DW-T1");
  assert.deepEqual(wt.base, { ref: "main", sha: main }, "main, not whatever the shared checkout has out");
  assert.equal(wt.warnings, undefined);
});

test("several dependency branches: the descendant wins; diverged ones are refused by name", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  git(repo, "branch", "feature/DW-T1");
  git(repo, "checkout", "-q", "feature/DW-T1");
  commit(repo, "one.txt", "1\n");
  git(repo, "checkout", "-q", "-b", "feature/DW-T2");
  const t2 = commit(repo, "two.txt", "2\n");
  git(repo, "checkout", "-q", "main");
  const ws = workspace(root, repo, [{ id: "DW-T1" }, { id: "DW-T2" }, { id: "DW-T3" }, { id: "DW-T4" }]);

  // Linear: T2 contains T1, whatever order dependsOn lists them in.
  const linear = await ensure(ws, "DW-T3", ["DW-T1", "DW-T2"]);
  assert.equal(linear.error, null);
  assert.equal(linear.basedOn, "feature/DW-T2");
  assert.deepEqual(linear.base, { ref: "feature/DW-T2", sha: t2 });

  // T1 moves on independently: now neither contains the other.
  git(repo, "checkout", "-q", "feature/DW-T1");
  commit(repo, "one-more.txt", "1b\n");
  git(repo, "checkout", "-q", "main");
  const diverged = await ensure(ws, "DW-T4", ["DW-T1", "DW-T2"]);
  assert.match(diverged.error, /feature\/DW-T1, feature\/DW-T2, which have diverged/);
  assert.match(diverged.error, /awo task run DW-T4/);
  assert.ok(!fs.existsSync(wtPath(ws, "DW-T4")), "no worktree is advertised or created");
});

// ---------------------------------------------------------------------------
// D1-2 reuse validation
// ---------------------------------------------------------------------------

test("an existing worktree path is reused only when git says it is this task's checkout", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const ws = workspace(root, repo, [{ id: "DW-T1" }, { id: "DW-T2" }, { id: "DW-T3" }, { id: "DW-T4" }]);

  // A hand-made directory at the canonical path: refused, not adopted.
  fs.mkdirSync(wtPath(ws, "DW-T1"), { recursive: true });
  fs.writeFileSync(path.join(wtPath(ws, "DW-T1"), "notes.txt"), "someone's files\n");
  const stray = await ensure(ws, "DW-T1");
  assert.match(stray.error, /git has no record of it as a api worktree/);
  assert.equal(stray.reused, false);

  // A real worktree of this repo, but on another branch: refused.
  git(repo, "worktree", "add", "-q", "-b", "other", wtPath(ws, "DW-T2"));
  const wrong = await ensure(ws, "DW-T2");
  assert.match(wrong.error, /worktree on other, not feature\/DW-T2/);

  // An empty leftover from a failed add: created into, not refused.
  fs.mkdirSync(wtPath(ws, "DW-T3"), { recursive: true });
  const empty = await ensure(ws, "DW-T3");
  assert.equal(empty.error, null);
  assert.equal(empty.created, true);
  assert.equal(git(wtPath(ws, "DW-T3"), "branch", "--show-current").trim(), "feature/DW-T3");

  // The real thing: reused.
  await ensure(ws, "DW-T4");
  const again = await ensure(ws, "DW-T4");
  assert.equal(again.error, null);
  assert.equal(again.reused, true);

  // Through the CLI the refusal is a warning, never a fake isolation path.
  const out = awo(ws, ["task", "run", "DW-T1"]);
  assert.match(out.stdout, /WARNING: no isolation for api — .*no record of it/);
  assert.ok(!/work in: repos\/\.worktrees\/api\/DW-T1/.test(out.stdout));
});

// ---------------------------------------------------------------------------
// D1-3 prune safety
// ---------------------------------------------------------------------------

test("prune never deletes what git refused to remove, even with --force", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const ws = workspace(root, repo, [{ id: "DW-T1" }]);
  await ensure(ws, "DW-T1");
  fs.writeFileSync(path.join(wtPath(ws, "DW-T1"), "wip.txt"), "uncommitted\n");
  git(repo, "worktree", "lock", wtPath(ws, "DW-T1"));
  writeState(ws, { "DW-T1": { status: "done", worktree: "repos/.worktrees/api/DW-T1" } });

  const plain = awo(ws, ["worktree", "prune"]);
  assert.match(plain.stdout, /kept {4}repos\/\.worktrees\/api\/DW-T1 {2}\(uncommitted changes/);

  // --force asks git to discard the dirty work; git still refuses a locked
  // worktree, and awo used to rm -rf it anyway.
  const forced = awo(ws, ["worktree", "prune", "--force"]);
  assert.match(forced.stdout, /kept {4}repos\/\.worktrees\/api\/DW-T1 {2}\(git refused to remove it/);
  assert.ok(fs.existsSync(path.join(wtPath(ws, "DW-T1"), "wip.txt")), "the work is still on disk");

  // A hand-made, non-empty directory git knows nothing about: kept under --force.
  fs.mkdirSync(wtPath(ws, "DW-T9"), { recursive: true });
  fs.writeFileSync(path.join(wtPath(ws, "DW-T9"), "x.txt"), "x\n");
  const handMade = awo(ws, ["worktree", "prune", "--all", "--force"]);
  assert.match(handMade.stdout, /kept {4}repos\/\.worktrees\/api\/DW-T9 {2}\(git has no record of it/);
  assert.ok(fs.existsSync(path.join(wtPath(ws, "DW-T9"), "x.txt")));
});

test("squash-merged, rebase-merged and PR-merged branches count as merged; real work is kept", async (t) => {
  const root = tempRoot(t);
  const { api } = repoWithOrigin(root);
  // `node_modules/` matches directories only, so awo's link shows as untracked —
  // it must neither make the worktree dirty nor block `git worktree remove`.
  commit(api, ".gitignore", "node_modules/\n", "ignore");
  fs.mkdirSync(path.join(api, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(api, "node_modules", "dep", "index.js"), "shared\n");
  git(api, "push", "-q", "origin", "HEAD:main");
  const ws = workspace(root, api, [{ id: "DW-T1" }, { id: "DW-T2" }, { id: "DW-T3" }, { id: "DW-T4" }]);

  for (const id of ["DW-T1", "DW-T2", "DW-T3", "DW-T4"]) await ensure(ws, id);
  assert.ok(fs.lstatSync(path.join(wtPath(ws, "DW-T1"), "node_modules")).isSymbolicLink());
  // T1: two commits, squash-merged on origin as one.
  commit(wtPath(ws, "DW-T1"), "a.txt", "a\n");
  commit(wtPath(ws, "DW-T1"), "b.txt", "b\n");
  // T2: one commit, cherry-picked (rebase-merged) after main moved on.
  const t2 = commit(wtPath(ws, "DW-T2"), "c.txt", "c\n");
  // T3: real, unmerged work.
  commit(wtPath(ws, "DW-T3"), "d.txt", "d\n");
  // T4: unmerged locally, but its PR is recorded as merged.
  commit(wtPath(ws, "DW-T4"), "e.txt", "e\n");

  commit(api, "other.txt", "main moved\n");
  git(api, "merge", "--squash", "-q", "feature/DW-T1");
  git(api, "commit", "-qm", "DW-T1 (#1)");
  git(api, "cherry-pick", t2);
  git(api, "push", "-q", "origin", "HEAD:main");
  // Nothing local contains the task tips any more either.
  git(api, "reset", "-q", "--hard", "HEAD~3");

  const pr = {
    repo: "api", number: 4, url: "", branch: "feature/DW-T4", headSha: "", isDraft: false,
    mergeState: "", checks: "unknown", reviews: "pending", lastCheckedAt: "", feedback: {},
    state: "MERGED", merged: true,
  };
  writeState(ws, {
    "DW-T1": { status: "done", worktree: "repos/.worktrees/api/DW-T1" },
    "DW-T2": { status: "done", worktree: "repos/.worktrees/api/DW-T2" },
    "DW-T3": { status: "done", worktree: "repos/.worktrees/api/DW-T3" },
    "DW-T4": { status: "done", worktree: "repos/.worktrees/api/DW-T4", pullRequest: pr },
  });

  const list = awo(ws, ["worktree", "list"]);
  assert.match(list.stdout, /DW-T1\tfeature\/DW-T1\t\d+MB\tsafe to remove \(squash-merged into origin\/main\)/);
  assert.match(list.stdout, /DW-T2\tfeature\/DW-T2\t\d+MB\tsafe to remove \(every commit has a patch-equivalent on origin\/main\)/);
  assert.match(list.stdout, /DW-T4\t.*safe to remove \(pull request #4 is recorded as merged\)/);

  const out = awo(ws, ["worktree", "prune"]);
  assert.equal(out.code, 0, out.stderr);
  for (const id of ["DW-T1", "DW-T2", "DW-T4"]) {
    assert.match(out.stdout, new RegExp(`removed repos/\\.worktrees/api/${id}`));
    assert.ok(!fs.existsSync(wtPath(ws, id)));
    assert.equal(readTaskState(ws, id).worktree, null, `${id}'s state pointer is cleared`);
  }
  assert.match(out.stdout, /kept {4}repos\/\.worktrees\/api\/DW-T3 {2}\(1 commit\(s\) no other branch/);
  assert.ok(fs.existsSync(wtPath(ws, "DW-T3")));
  assert.equal(readTaskState(ws, "DW-T3").worktree, "repos/.worktrees/api/DW-T3");
  assert.ok(fs.existsSync(path.join(api, "node_modules", "dep", "index.js")), "the shared install survives");
});

test("a detached-HEAD worktree is removable only when some ref still reaches its HEAD", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const ws = workspace(root, repo, []);
  const reachable = path.join(ws, "repos", ".worktrees", "api", "scratch-a");
  const orphan = path.join(ws, "repos", ".worktrees", "api", "scratch-b");
  fs.mkdirSync(path.dirname(reachable), { recursive: true });
  git(repo, "worktree", "add", "-q", "--detach", reachable, "main");
  git(repo, "worktree", "add", "-q", "--detach", orphan, "main");
  commit(orphan, "lost.txt", "only here\n");

  const out = awo(ws, ["worktree", "prune", "--all"]);
  assert.match(out.stdout, /removed repos\/\.worktrees\/api\/scratch-a/);
  assert.match(out.stdout, /kept {4}repos\/\.worktrees\/api\/scratch-b {2}\(detached HEAD with 1 commit\(s\) no branch or remote reaches\)/);
  assert.ok(fs.existsSync(path.join(orphan, "lost.txt")));
});

test("a baseline tree with a live lease is kept even under --force; a dead lease is pruned", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const ws = workspace(root, repo, []);
  const live = path.join(ws, "repos", ".worktrees", ".baseline", "api", "abc-1");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, ".awo-active"), JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  fs.utimesSync(live, new Date(0), new Date(0));

  const kept = awo(ws, ["worktree", "prune", "--force"]);
  assert.match(kept.stdout, /kept {4}repos\/\.worktrees\/\.baseline\/api {2}\(a baseline measurement is running in it \(pid \d+/);
  assert.ok(fs.existsSync(live));

  fs.writeFileSync(path.join(live, ".awo-active"), JSON.stringify({ pid: await deadPid(), hostname: os.hostname() }));
  fs.utimesSync(live, new Date(0), new Date(0));
  const pruned = awo(ws, ["worktree", "prune"]);
  assert.match(pruned.stdout, /removed repos\/\.worktrees\/\.baseline\/api/);
  assert.ok(!fs.existsSync(live));
});

// ---------------------------------------------------------------------------
// D1-4 prune --deps
// ---------------------------------------------------------------------------

test("prune --deps strips ignored dependency and build dirs from idle worktrees, never through a link", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  commit(repo, ".gitignore", "/node_modules\n.next/\ndist/\n", "ignore");
  commit(repo, "build/keep.txt", "tracked build file\n", "tracked build dir");
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "shared install\n");
  const ws = workspace(root, repo, [{ id: "DW-T1" }, { id: "DW-T2" }]);
  await ensure(ws, "DW-T1");
  await ensure(ws, "DW-T2");
  for (const id of ["DW-T1", "DW-T2"]) {
    fs.mkdirSync(path.join(wtPath(ws, id), ".next", "cache"), { recursive: true });
    fs.writeFileSync(path.join(wtPath(ws, id), ".next", "cache", "blob"), Buffer.alloc(2 * 1024 * 1024));
    fs.mkdirSync(path.join(wtPath(ws, id), "dist"), { recursive: true });
    fs.writeFileSync(path.join(wtPath(ws, id), "dist", "out.js"), "built\n");
  }
  writeState(ws, { "DW-T1": { status: "in-review" }, "DW-T2": { status: "running" } });

  const dry = awo(ws, ["worktree", "prune", "--deps", "--dry-run"]);
  assert.match(dry.stdout, /would strip repos\/\.worktrees\/api\/DW-T1\/\.next {2}\(2MB\)/);
  assert.ok(fs.existsSync(path.join(wtPath(ws, "DW-T1"), ".next")), "a dry run touches nothing");

  const out = awo(ws, ["worktree", "prune", "--deps"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /stripped repos\/\.worktrees\/api\/DW-T1\/node_modules {2}\(link only\)/);
  assert.match(out.stdout, /2MB freed/);
  const t1 = wtPath(ws, "DW-T1");
  assert.ok(!fs.existsSync(path.join(t1, ".next")));
  assert.ok(!fs.existsSync(path.join(t1, "dist")));
  assert.ok(!fs.existsSync(path.join(t1, "node_modules")), "the link is gone");
  assert.ok(fs.existsSync(path.join(t1, "build", "keep.txt")), "tracked files are never touched");
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")), "the link target survives");
  assert.match(out.stdout, /skipped repos\/\.worktrees\/api\/DW-T2 {2}\(its task is running\)/);
  assert.ok(fs.existsSync(path.join(wtPath(ws, "DW-T2"), ".next")));
  assert.ok(fs.existsSync(t1), "the worktree itself stays");

  // Reusing the stripped worktree re-links the dependencies.
  const again = await ensure(ws, "DW-T1");
  assert.equal(again.reused, true);
  assert.ok(fs.lstatSync(path.join(t1, "node_modules")).isSymbolicLink());
});

// ---------------------------------------------------------------------------
// D1-5 baseline
// ---------------------------------------------------------------------------

test("measureBaseline prunes stale registrations first, leases its unique dir, and cleans up", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  const gone = path.join(root, "deleted-by-hand");
  git(repo, "worktree", "add", "-q", "--detach", gone, "main");
  fs.rmSync(gone, { recursive: true, force: true });
  assert.match(git(repo, "worktree", "list", "--porcelain"), /deleted-by-hand/);

  const { measureBaseline } = await mod("evidence.js");
  const scratch = path.join(root, "scratch", ".baseline", "api");
  const r = await measureBaseline(repo, headOf(repo), "cat ../.awo-active", scratch, 1);
  assert.equal(r.error, undefined);
  assert.equal(r.measurement.exitCode, 0);
  const lease = JSON.parse(r.measurement.tail);
  assert.equal(lease.pid, process.pid, "the lease names the measuring process while it runs");
  assert.equal(lease.hostname, os.hostname());
  assert.ok(!/deleted-by-hand/.test(git(repo, "worktree", "list", "--porcelain")), "stale record pruned before add");
  assert.deepEqual(fs.readdirSync(scratch), [], "the measurement dir and lease are removed afterwards");
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("an installing command never shares the candidate's node_modules", async (t) => {
  const root = tempRoot(t);
  const repo = localRepo(root);
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "shared\n");
  const { measureBaseline } = await mod("evidence.js");
  const { prepareDependencyDirs, runsInstaller } = await mod("worktrees.js");

  const probe = `test -L node_modules && echo LINKED || echo PRIVATE`;
  const plain = await measureBaseline(repo, headOf(repo), probe, path.join(root, "b1"), 1);
  assert.match(plain.measurement.tail, /LINKED/, "a non-installing command still gets the link");

  // `true ||` keeps npm from actually running; the guard reads the command.
  const installing = await measureBaseline(repo, headOf(repo), `true || npm ci; ${probe}`, path.join(root, "b2"), 1);
  assert.match(installing.measurement.tail, /PRIVATE/);
  assert.match(installing.note, /installs its own/);

  // In a task worktree, the link is swapped for a private dir before an install.
  const ws = workspace(root, repo);
  await ensure(ws, "DW-T1");
  const modules = path.join(wtPath(ws, "DW-T1"), "node_modules");
  assert.equal(await prepareDependencyDirs(wtPath(ws, "DW-T1"), "npm test"), null);
  assert.ok(fs.lstatSync(modules).isSymbolicLink());
  const note = await prepareDependencyDirs(wtPath(ws, "DW-T1"), "npm ci && npm test");
  assert.match(note, /replaced it with an empty directory/);
  assert.ok(fs.lstatSync(modules).isDirectory() && !fs.lstatSync(modules).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(modules), []);
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")), "the shared install is intact");

  for (const cmd of ["npm ci", "npm install", "npm i", "yarn", "yarn --frozen-lockfile", "yarn install", "pnpm install", "bun install", "CI=1 npm ci && npm test", "cd web; pnpm i"]) {
    assert.equal(runsInstaller(cmd), true, cmd);
  }
  for (const cmd of ["npm test", "yarn test", "npm run build", "pnpm run lint", "bun test", "./t.sh"]) {
    assert.equal(runsInstaller(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------------------
// D1-6 remove
// ---------------------------------------------------------------------------

test("awo remove keeps a clone unless --delete-checkout, and refuses to delete unpushed work", (t) => {
  const root = tempRoot(t);
  const { origin } = repoWithOrigin(root);
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  execFileSync(process.execPath, [CLI, "init", "--key", "DW"], { cwd: ws, stdio: "ignore" });
  const manifest = () => JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8"));
  const clone = path.join(ws, "repos", "svc");

  assert.equal(awo(ws, ["add", origin, "--name", "svc"]).code, 0);
  const dry = awo(ws, ["remove", "svc", "--dry-run"]);
  assert.match(dry.stdout, /Would remove svc — repos\/svc would be kept on disk/);
  assert.equal(manifest().repos.length, 1, "a dry run changes nothing");

  const kept = awo(ws, ["remove", "svc"]);
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /Removed svc — repos\/svc kept on disk/);
  assert.deepEqual(manifest().repos, []);
  assert.ok(fs.existsSync(path.join(clone, "README.md")), "the clone is still there");

  // Re-register it (by moving the clone aside and adding again), then commit locally.
  fs.rmSync(clone, { recursive: true, force: true });
  awo(ws, ["add", origin, "--name", "svc"]);
  commit(clone, "local.txt", "unpushed\n");
  const refused = awo(ws, ["remove", "svc", "--delete-checkout"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Refusing to delete repos\/svc: 1 commit\(s\) on HEAD, local branches or tags that no remote has/);
  assert.equal(manifest().repos.length, 1, "a refusal leaves the registration alone");
  assert.ok(fs.existsSync(path.join(clone, "local.txt")));

  git(clone, "push", "-q", "origin", "HEAD:main");
  const deleted = awo(ws, ["remove", "svc", "--delete-checkout"]);
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.match(deleted.stdout, /repos\/svc deleted/);
  assert.ok(!fs.existsSync(clone));

  // A connected repo only ever loses its link.
  const local = localRepo(root, "linked");
  awo(ws, ["connect", local, "--name", "linked"]);
  const unlinked = awo(ws, ["remove", "linked", "--delete-checkout"]);
  assert.match(unlinked.stdout, /repos\/linked unlinked/);
  assert.match(unlinked.stdout, /removes only its link/);
  assert.ok(fs.existsSync(path.join(local, "README.md")));
});

// ---------------------------------------------------------------------------
// D1-7 stale locks
// ---------------------------------------------------------------------------

test("a lock is reclaimed only when its owner was on this host and its pid is gone", async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, "goals", "G", "state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "original");
  const { withFileLock, atomicWriteFile, findStaleLocks } = await mod("file-lock.js");
  const lock = `${file}.lock`;
  const own = (owner: Record<string, unknown>) => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
  };

  // Live owner on this host: never stolen, whatever its age.
  own({ pid: process.pid === 1 ? 2 : 1, hostname: os.hostname(), acquiredAt: "2020-01-01T00:00:00Z" });
  await assert.rejects(withFileLock(file, () => atomicWriteFile(file, "wrong"), 40), /stop all writers/);
  // Dead pid, but recorded by another host: unprovable, so not stolen either.
  const dead = await deadPid();
  own({ pid: dead, hostname: `not-${os.hostname()}`, acquiredAt: "2020-01-01T00:00:00Z" });
  await assert.rejects(withFileLock(file, () => atomicWriteFile(file, "wrong"), 40), /stop all writers/);
  assert.deepEqual(await findStaleLocks(root), [], "neither is reported as stale");
  assert.equal(fs.readFileSync(file, "utf8"), "original");

  // Dead pid on this host: reported, then reclaimed by the next writer.
  own({ pid: dead, hostname: os.hostname(), acquiredAt: "2020-01-01T00:00:00Z" });
  const stale = await findStaleLocks(root);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].lock, lock);
  assert.match(stale[0].reason, new RegExp(`owner pid ${dead} on this host is no longer running`));
  await withFileLock(file, () => atomicWriteFile(file, "recovered"), 2_000);
  assert.equal(fs.readFileSync(file, "utf8"), "recovered");
  assert.ok(!fs.existsSync(lock));
});

test("a SIGTERM during a locked write releases the lock", async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, "protected.json");
  const url = pathToFileURL(path.join(REPO_ROOT, "dist", "file-lock.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withFileLock } from ${JSON.stringify(url)};
    await withFileLock(${JSON.stringify(file)}, async () => {
      console.log("locked");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  assert.ok(fs.existsSync(`${file}.lock`));
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  assert.ok(!fs.existsSync(`${file}.lock`), "the interrupted owner released its lock");
});
