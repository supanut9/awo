import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-workspace-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TEST"], { cwd: tmpDir });
  return tmpDir;
}

function makeLocalGitRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-source-repo-"));
  git(repoDir, "init", "--initial-branch=main", "--quiet");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init", "--quiet");
  return repoDir;
}

test("awo connect symlinks an existing local repo without cloning", () => {
  const workspace = makeWorkspace();
  const localRepo = makeLocalGitRepo();

  execFileSync(process.execPath, [CLI, "connect", localRepo], { cwd: workspace });

  const linkPath = path.join(workspace, "repos", path.basename(localRepo));
  const stat = fs.lstatSync(linkPath);
  assert.ok(stat.isSymbolicLink(), "repos/<name> must be a symlink, not a clone");
  assert.equal(fs.realpathSync(linkPath), fs.realpathSync(localRepo));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, ".workspace", "manifest.json"), "utf8"));
  assert.equal(manifest.repos.length, 1);
  assert.equal(manifest.repos[0].name, path.basename(localRepo));
  assert.equal(manifest.repos[0].type, "local");
  assert.equal(fs.realpathSync(manifest.repos[0].path), fs.realpathSync(localRepo));

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(localRepo, { recursive: true, force: true });
});

test("awo connect rejects a duplicate name and a missing path", () => {
  const workspace = makeWorkspace();
  const localRepo = makeLocalGitRepo();

  execFileSync(process.execPath, [CLI, "connect", localRepo], { cwd: workspace });
  assert.throws(() => {
    execFileSync(process.execPath, [CLI, "connect", localRepo], { cwd: workspace, stdio: "pipe" });
  });
  assert.throws(() => {
    execFileSync(process.execPath, [CLI, "connect", "/no/such/path", "--name", "ghost"], {
      cwd: workspace,
      stdio: "pipe",
    });
  });

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(localRepo, { recursive: true, force: true });
});

test("awo add clones a repo and registers it as type:git", () => {
  const workspace = makeWorkspace();
  const sourceRepo = makeLocalGitRepo();

  execFileSync(process.execPath, [CLI, "add", sourceRepo, "--name", "cloned-repo"], { cwd: workspace });

  const clonePath = path.join(workspace, "repos", "cloned-repo");
  assert.ok(fs.statSync(clonePath).isDirectory());
  assert.ok(fs.existsSync(path.join(clonePath, ".git")));
  assert.ok(!fs.lstatSync(clonePath).isSymbolicLink(), "add must clone, not symlink");

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, ".workspace", "manifest.json"), "utf8"));
  assert.equal(manifest.repos.length, 1);
  assert.equal(manifest.repos[0].name, "cloned-repo");
  assert.equal(manifest.repos[0].type, "git");
  assert.equal(manifest.repos[0].url, sourceRepo);

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(sourceRepo, { recursive: true, force: true });
});

test("awo list reports present, missing, and dirty status", () => {
  const workspace = makeWorkspace();
  const localRepo = makeLocalGitRepo();
  const sourceRepo = makeLocalGitRepo();

  execFileSync(process.execPath, [CLI, "connect", localRepo, "--name", "linked"], { cwd: workspace });
  execFileSync(process.execPath, [CLI, "add", sourceRepo, "--name", "cloned"], { cwd: workspace });

  // Make the cloned copy dirty.
  fs.writeFileSync(path.join(workspace, "repos", "cloned", "untracked.txt"), "x");

  const out = execFileSync(process.execPath, [CLI, "list"], { cwd: workspace }).toString();
  assert.match(out, /linked\s+local\s+present/);
  assert.match(out, /cloned\s+git\s+dirty/);

  // Break the local link by removing its target, then list again.
  fs.rmSync(localRepo, { recursive: true, force: true });
  const out2 = execFileSync(process.execPath, [CLI, "list"], { cwd: workspace }).toString();
  assert.match(out2, /linked\s+local\s+missing/);

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(sourceRepo, { recursive: true, force: true });
});

test("awo remove unregisters a repo and cleans up repos/<name>", () => {
  const workspace = makeWorkspace();
  const localRepo = makeLocalGitRepo();

  execFileSync(process.execPath, [CLI, "connect", localRepo, "--name", "linked"], { cwd: workspace });
  execFileSync(process.execPath, [CLI, "remove", "linked"], { cwd: workspace });

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, ".workspace", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.repos, []);
  assert.ok(!fs.existsSync(path.join(workspace, "repos", "linked")));
  // The connected source directory itself must be untouched.
  assert.ok(fs.existsSync(localRepo));

  assert.throws(() => {
    execFileSync(process.execPath, [CLI, "remove", "linked"], { cwd: workspace, stdio: "pipe" });
  });

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(localRepo, { recursive: true, force: true });
});

test("connect/add/remove keep the *.code-workspace file in sync", () => {
  const workspace = makeWorkspace();
  const localRepo = makeLocalGitRepo();
  const sourceRepo = makeLocalGitRepo();
  const workspaceFile = path.join(workspace, "TEST.code-workspace");

  execFileSync(process.execPath, [CLI, "connect", localRepo, "--name", "linked"], { cwd: workspace });
  let ws = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  assert.deepEqual(ws.folders, [
    { name: "TEST", path: "." },
    { name: "linked", path: fs.realpathSync(localRepo) },
  ]);

  execFileSync(process.execPath, [CLI, "add", sourceRepo, "--name", "cloned"], { cwd: workspace });
  ws = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  assert.deepEqual(ws.folders, [
    { name: "TEST", path: "." },
    { name: "linked", path: fs.realpathSync(localRepo) },
    { name: "cloned", path: "repos/cloned" },
  ]);

  execFileSync(process.execPath, [CLI, "remove", "linked"], { cwd: workspace });
  ws = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  assert.deepEqual(ws.folders, [
    { name: "TEST", path: "." },
    { name: "cloned", path: "repos/cloned" },
  ]);

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(localRepo, { recursive: true, force: true });
  fs.rmSync(sourceRepo, { recursive: true, force: true });
});
