import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Seams between lanes that only exist once they are merged: each lane's own tests
// prove its half; these prove the halves meet.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

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

function awo(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...GIT_ENV, ...env } });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awo-seams-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repo(root: string, gitignore: string): string {
  const dir = path.join(root, "api");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  fs.writeFileSync(path.join(dir, "README.md"), "# api\n");
  git(dir, "add", ".gitignore", "README.md");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function workspace(root: string, repoDir: string, goalFrontmatter = ""): string {
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  execFileSync(process.execPath, [CLI, "init", "--key", "SM"], { cwd: ws, stdio: "ignore" });
  execFileSync(process.execPath, [CLI, "connect", repoDir, "--name", "api"], { cwd: ws, stdio: "ignore" });
  const goalDir = path.join(ws, "goals", "SM-G1-demo");
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goalDir, "goal.md"), `---\nid: SM-G1\ntitle: Demo\n${goalFrontmatter}---\n\nDemo.\n`);
  fs.writeFileSync(
    path.join(goalDir, "tasks", "SM-T1-x.md"),
    `---\nid: SM-T1\ngoalId: SM-G1\nname: Do it\ntargets: [api]\nkind: implementation\n---\n\n## Objective\nChange the readme.\n`
  );
  return ws;
}

function taskState(ws: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ws, "goals", "SM-G1-demo", "state.json"), "utf8")).tasks["SM-T1"];
}

test("a dependency link under a directory-only `node_modules/` ignore never shows up as a change", (t) => {
  const root = tempRoot(t);
  const api = repo(root, "node_modules/\n");
  fs.mkdirSync(path.join(api, "node_modules", "left-pad"), { recursive: true });
  const ws = workspace(root, api);

  const run = awo(ws, ["task", "run", "SM-T1"]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const wt = path.join(ws, "repos", ".worktrees", "api", "SM-T1");
  assert.ok(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink());
  assert.equal(git(wt, "status", "--porcelain").trim(), "", "the link must not be an untracked file");
  assert.match(fs.readFileSync(path.join(api, ".git", "info", "exclude"), "utf8"), /^\/node_modules$/m);
});

test("task run cuts the worktree from the goal's deliveryBranch and records the base", (t) => {
  const root = tempRoot(t);
  const api = repo(root, "node_modules\n");
  git(api, "branch", "feature/goal-x");
  const ws = workspace(root, api, "deliveryBranch: feature/goal-x\n");

  const run = awo(ws, ["task", "run", "SM-T1"]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /from feature\/goal-x/);
  const base = taskState(ws).base?.api;
  assert.equal(base?.ref, "feature/goal-x");
  assert.equal(base?.sha, git(api, "rev-parse", "feature/goal-x").trim());
});

// ---- fixes from the combined Codex + Claude review ----

const distModule = (name: string) => import(new URL(`file://${path.join(REPO_ROOT, "dist", name)}`).href);

test("exit 2 with a parsed test summary is a test result, not 'not runnable' (make's failure exit)", async () => {
  const { diagnose } = await distModule("evidence.js");
  const none = { newTests: [], modifiedTests: [], weakenedTests: [], testFiles: [], codeFiles: [] };
  const make = (failed: number) => ({ command: "make test", exitCode: 2, durationSec: 1, tail: "", passed: 10, failed, counts: { passed: 10, failed, parser: "jest" } });
  assert.notEqual(diagnose(make(3), make(2), none).diagnosis, "not-runnable");
  const bare = { command: "nope", exitCode: 2, durationSec: 0, tail: "", counts: { parser: "unknown" } };
  assert.equal(diagnose(bare, bare, none).diagnosis, "not-runnable");
});

test("a criterion's nested conditions are part of its hash, so editing them is detected", async () => {
  const { findCriteriaDetailed } = await distModule("commands/intake.js");
  const doc = (rule: string) => `## Acceptance criteria\n- AC-1: Access control\n  - only ${rule} may edit\n- AC-2: Audit log\n`;
  const [a1, a2] = findCriteriaDetailed(doc("admins"));
  const [b1, b2] = findCriteriaDetailed(doc("owners"));
  assert.equal(findCriteriaDetailed(doc("admins")).length, 2, "nested bullets are not criteria of their own");
  assert.equal(a1.text, b1.text);
  assert.notEqual(a1.hash, b1.hash);
  assert.equal(a2.hash, b2.hash);
});

test("remove --delete-checkout refuses a clone whose detached HEAD holds the only copy of a commit", (t) => {
  const root = tempRoot(t);
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "# api\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");

  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  execFileSync(process.execPath, [CLI, "init", "--key", "RM"], { cwd: ws, stdio: "ignore" });
  const add = awo(ws, ["add", origin, "--name", "api"]);
  assert.equal(add.code, 0, add.stderr + add.stdout);
  const clone = path.join(ws, "repos", "api");
  git(clone, "checkout", "-q", "--detach");
  fs.writeFileSync(path.join(clone, "only-here.txt"), "x\n");
  git(clone, "add", "only-here.txt");
  git(clone, "commit", "-qm", "detached work");

  const out = awo(ws, ["remove", "api", "--delete-checkout"]);
  assert.notEqual(out.code, 0, out.stdout);
  assert.match(out.stderr + out.stdout, /HEAD, local branches or tags that no remote has/);
  assert.ok(fs.existsSync(path.join(clone, "only-here.txt")));
});
