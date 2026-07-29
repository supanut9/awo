import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const INSTALLED = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
}).version;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[]): RunResult {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-upg-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "UP"], { cwd: dir });
  return dir;
}

const hash = (buf: string | Buffer): string =>
  `sha256-${createHash("sha256").update(buf).digest("hex")}`;

function readLock(ws: string): { libraryVersion: string; files: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "template.lock"), "utf8"));
}
function writeLock(ws: string, lock: unknown): void {
  fs.writeFileSync(path.join(ws, ".workspace", "template.lock"), JSON.stringify(lock, null, 2));
}
function manifest(ws: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8"));
}
function setManifest(ws: string, patch: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(ws, ".workspace", "manifest.json"),
    JSON.stringify({ ...manifest(ws), ...patch }, null, 2)
  );
}

/** Make the workspace look like it came from an older version. */
function pretendOlder(ws: string, version: string): void {
  setManifest(ws, { libraryVersion: version });
}

/**
 * Walk a requirement through intake so a test can get to planning.
 *
 * Every one of these call sites used to be `goal new --from` on a bare skeleton.
 * The approval gate (§16) makes that an error on purpose, so the helper does what a
 * PM agent and a human would: write checkable criteria, propose, approve.
 */
function approveRequirement(ws: string, id: string): void {
  const file = path.join(ws, "requirements", `${id}.md`);
  const text = fs.readFileSync(file, "utf8");
  // Idempotent: a test that already walked the gate itself must not walk it twice.
  if (/^status:\s*approved\s*$/m.test(text)) return;
  if (!/Given /.test(text)) {
    fs.writeFileSync(
      file,
      text.replace("- _…_", "- Given a precondition, when the action happens, then the outcome holds")
    );
  }
  execFileSync(process.execPath, [CLI, "req", "propose", id], { cwd: ws, stdio: "ignore" });
  execFileSync(process.execPath, [CLI, "req", "approve", id], { cwd: ws, stdio: "ignore" });
}

test("a freshly-initialized workspace has nothing to upgrade", () => {
  const ws = makeWorkspace();
  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`Already at ${INSTALLED}; nothing to do`));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("an unmodified scaffolding file is replaced; a customized one is never overwritten", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");

  const untouched = path.join(ws, "rules", "no-push-to-main.md");
  const customized = path.join(ws, "AGENTS.md");

  // Simulate "the template changed this file" by editing it AND recording the
  // edited hash in the lock: current == lock, but template differs.
  fs.appendFileSync(untouched, "\nstale line from an older template\n");
  const lock = readLock(ws);
  lock.files["rules/no-push-to-main.md"] = hash(fs.readFileSync(untouched));

  // A real CONFLICT needs both sides to have moved: the user edited the file,
  // AND the template changed since the baseline. Faking a baseline that matches
  // neither disk nor template is what makes both true.
  const myEdit = "\n## My own house rule\nAlways rebase.\n";
  fs.appendFileSync(customized, myEdit);
  lock.files["AGENTS.md"] = hash("what an older template shipped");
  writeLock(ws, lock);

  const dry = awo(ws, ["upgrade", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /0\.0\.1 -> /);
  assert.match(dry.stdout, /\(dry run\)/);
  assert.match(dry.stdout, /replace: 1/);
  assert.match(dry.stdout, /conflict: 1/);
  assert.match(dry.stdout, /! AGENTS\.md — customized/);
  // A dry run must change nothing at all.
  assert.equal(manifest(ws).libraryVersion, "0.0.1");
  assert.ok(!fs.existsSync(`${customized}.new`));

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);

  // Unmodified file: restored to the template's version.
  assert.ok(
    !fs.readFileSync(untouched, "utf8").includes("stale line"),
    "an unmodified file must be replaced by the template version"
  );
  // Customized file: untouched, new version alongside.
  assert.ok(
    fs.readFileSync(customized, "utf8").includes("Always rebase."),
    "a customized file must never be overwritten"
  );
  assert.ok(fs.existsSync(`${customized}.new`), "the new version must be written as .new");
  assert.ok(!fs.readFileSync(`${customized}.new`, "utf8").includes("Always rebase."));
  assert.match(out.stdout, /Review and merge: AGENTS\.md\.new/);

  // Replaced files are backed up (§11.4).
  const backup = path.join(ws, ".workspace", "upgrade-backups", `0.0.1-to-${INSTALLED}`);
  assert.ok(fs.existsSync(path.join(backup, "rules", "no-push-to-main.md")));
  assert.match(out.stdout, /backed up to \.workspace\/upgrade-backups/);

  // Version and lock are both moved forward.
  assert.equal(manifest(ws).libraryVersion, INSTALLED);
  assert.equal(readLock(ws).libraryVersion, INSTALLED);
  // §11.2 — the lock records what the TEMPLATE provides, not what is on disk.
  // Recording the edited content would make the edit the new baseline, and the
  // next upgrade would then treat the customized file as unmodified and
  // overwrite it. This assertion is the regression guard for that.
  assert.notEqual(
    readLock(ws).files["AGENTS.md"],
    hash(fs.readFileSync(customized)),
    "the lock must not adopt the user's edit as the baseline"
  );

  // Idempotent, and crucially the edit survives a second run.
  const second = awo(ws, ["upgrade"]);
  assert.match(second.stdout, /nothing to do/);
  assert.ok(
    fs.readFileSync(customized, "utf8").includes("Always rebase."),
    "a second upgrade must not clobber the edit either"
  );
  fs.rmSync(ws, { recursive: true, force: true });
});

test("--dry-run writes nothing, even when the only change is the version number", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.6");
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const lockPath = path.join(ws, ".workspace", "template.lock");
  const before = {
    manifest: fs.readFileSync(manifestPath, "utf8"),
    lock: fs.readFileSync(lockPath, "utf8"),
    mtime: fs.statSync(manifestPath).mtimeMs,
  };

  const out = awo(ws, ["upgrade", "--dry-run"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\(dry run\)/);

  assert.equal(fs.readFileSync(manifestPath, "utf8"), before.manifest, "manifest must be byte-identical");
  assert.equal(fs.readFileSync(lockPath, "utf8"), before.lock, "lock must be byte-identical");
  assert.equal(fs.statSync(manifestPath).mtimeMs, before.mtime, "manifest must not even be rewritten");
  assert.ok(!fs.existsSync(path.join(ws, ".workspace", "upgrade-backups")));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a file the user deleted stays deleted", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");
  const removed = path.join(ws, "rules", "conventional-commits.md");
  fs.rmSync(removed);

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /user-deleted: 1/);
  assert.ok(!fs.existsSync(removed), "deletion is a choice; upgrade must not resurrect it");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a workspace with no template.lock is upgraded conservatively", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");
  fs.rmSync(path.join(ws, ".workspace", "template.lock"));

  // Edit a file so it differs from the template; with no baseline, upgrade
  // cannot prove anything is unmodified, so it must not overwrite.
  const edited = path.join(ws, "AGENTS.md");
  fs.appendFileSync(edited, "\nlocal note\n");

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /No template\.lock/);
  assert.ok(fs.readFileSync(edited, "utf8").includes("local note"), "must not overwrite");
  assert.ok(fs.existsSync(`${edited}.new`));

  // And afterwards a lock exists, so the next upgrade is precise.
  assert.equal(readLock(ws).libraryVersion, INSTALLED);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("migrations run once and are idempotent", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");
  // Pre-workspaceId workspaces have no such field (§5).
  const m = manifest(ws);
  delete m.workspaceId;
  fs.writeFileSync(path.join(ws, ".workspace", "manifest.json"), JSON.stringify(m, null, 2));
  assert.equal(manifest(ws).workspaceId, undefined);

  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /migration 0\.0\.2: backfill manifest\.workspaceId/);

  const id = manifest(ws).workspaceId as string;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/, "must be a uuid v7");

  // Re-running must not mint a new id.
  awo(ws, ["upgrade"]);
  assert.equal(manifest(ws).workspaceId, id);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("--to must match the installed version, and says how to get another", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");

  const wrong = awo(ws, ["upgrade", "--to", "0.0.3"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Cannot upgrade to 0\.0\.3/);
  assert.match(wrong.stderr, /npx @supanut9\/awo@0\.0\.3 upgrade/);
  assert.equal(manifest(ws).libraryVersion, "0.0.1", "a rejected target must change nothing");

  const right = awo(ws, ["upgrade", "--to", INSTALLED]);
  assert.equal(right.code, 0, right.stderr);
  assert.equal(manifest(ws).libraryVersion, INSTALLED);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a workspace newer than the installed awo is refused, not downgraded", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "99.0.0");
  const out = awo(ws, ["upgrade"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /newer than this awo/);
  assert.match(out.stderr, /forward-only/);
  assert.equal(manifest(ws).libraryVersion, "99.0.0");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a workspace with no git repo is warned that nothing can be reviewed or reverted", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");
  assert.ok(!fs.existsSync(path.join(ws, ".git")), "precondition: not a git repo");

  const out = awo(ws, ["upgrade", "--dry-run"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /not a git repo/);
  assert.match(out.stdout, /upgrade-backups/);

  // And it still proceeds — the point is to say so, not to block.
  assert.equal(awo(ws, ["upgrade"]).code, 0);
  assert.equal(manifest(ws).libraryVersion, INSTALLED);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("upgrade refuses a dirty git tree unless forced", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  fs.appendFileSync(path.join(ws, "AGENTS.md"), "\nuncommitted\n");

  const refused = awo(ws, ["upgrade"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /uncommitted changes/);
  assert.equal(manifest(ws).libraryVersion, "0.0.1");

  const forced = awo(ws, ["upgrade", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(manifest(ws).libraryVersion, INSTALLED);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("upgrade never touches goals, logs or the manifest's repos", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.1");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-upgrepo-"));
  awo(ws, ["connect", repo, "--name", "api"]);
  awo(ws, ["req", "new", "--title", "Keep me"]);
  approveRequirement(ws, "UP-R1");
  awo(ws, ["goal", "new", "--from", "UP-R1"]);
  awo(ws, ["task", "new", "--goal", "UP-G1", "--name", "Work", "--targets", "api"]);
  awo(ws, ["task", "run", "UP-T1"]);
  awo(ws, ["task", "complete", "UP-T1", "--outcome", "success", "--untested", "fixture"]);

  const goalsBefore = execFileSync("find", ["goals", "-type", "f"], { cwd: ws, encoding: "utf8" });
  const logsBefore = execFileSync("find", ["logs", "-type", "f"], { cwd: ws, encoding: "utf8" });
  const reposBefore = JSON.stringify(manifest(ws).repos);

  assert.equal(awo(ws, ["upgrade"]).code, 0);

  assert.equal(execFileSync("find", ["goals", "-type", "f"], { cwd: ws, encoding: "utf8" }), goalsBefore);
  assert.equal(execFileSync("find", ["logs", "-type", "f"], { cwd: ws, encoding: "utf8" }), logsBefore);
  assert.equal(JSON.stringify(manifest(ws).repos), reposBefore);
  assert.equal(awo(ws, ["task", "list"]).stdout.includes("UP-T1"), true);
  fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * One test per layout awo has ever shipped.
 *
 * The earlier suite only ever started from the oldest layout, which ran every
 * migration in a single invocation and produced correct results by accident — that
 * is how 0.0.33 shipped leaving 24 index pointers dangling (§9 finding 61). Each
 * shipped version is a real starting point for a real user, so each gets a case.
 */
function seedGoal(ws: string, dirName: string, taskFile: string): void {
  const dir = path.join(ws, "goals", dirName, "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ws, "goals", dirName, "goal.md"), "---\nid: UP-G1\n---\n\ngoal\n");
  fs.writeFileSync(path.join(dir, taskFile), "---\nid: UP-T2\n---\n\ntask\n");
}

function dayLines(ws: string, date: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(ws, "logs", date, "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function assertCollapsed(ws: string, runId: string, date: string): void {
  const day = path.join(ws, "logs", date);
  assert.deepEqual(
    fs.readdirSync(day).sort().filter((f) => f !== "workers"),
    ["runs.jsonl", "runs.md"],
    "a day holds exactly two files"
  );
  const lines = dayLines(ws, date);
  assert.ok(
    lines.some((l) => l.type === "event" && l.runId === runId && l.kind === "test"),
    "the run's events must survive"
  );
  assert.ok(
    lines.some((l) => l.type === "run" && l.runId === runId && l.status === "success"),
    "the run's row must survive"
  );
  const md = fs.readFileSync(path.join(day, "runs.md"), "utf8");
  assert.ok(md.includes(`<!-- awo:run ${runId} -->`), "the record must be a marked section");
  assert.match(md, /record body/, "the record's content must survive");
  assert.ok(!fs.existsSync(path.join(ws, "logs", "index.jsonl")), "no global index remains");
  assert.ok(!fs.existsSync(path.join(ws, "logs", "runs")), "no date-sharded tree remains");
}

test("upgrading from the pre-0.0.32 layout collapses into day files", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.31");
  const runId = "2026-07-28T16-33-45-180Z_UP-T2";

  const old = path.join(ws, "logs", "runs", "2026-07-28");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, `${runId}.md`), "---\nrunId: x\n---\n\nrecord body\n");
  fs.writeFileSync(path.join(old, `${runId}.events.jsonl`), '{"t":"1","kind":"test"}\n');
  fs.writeFileSync(path.join(old, `${runId}.worker.log`), "worker said this\n");
  fs.writeFileSync(
    path.join(ws, "logs", "runs.jsonl"),
    `${JSON.stringify({ runId, taskId: "UP-T2", status: "success", reposChanged: [] })}\n`
  );
  seedGoal(ws, "UP-G1-a-title-truncated-mid-wor", "UP-T2-some-slug.md");
  fs.writeFileSync(path.join(ws, "goals", "UP-R7.md"), "---\nid: UP-R7\n---\n\nintake\n");
  fs.mkdirSync(path.join(ws, ".worktrees", "api", "UP-T1"), { recursive: true });

  execFileSync(process.execPath, [CLI, "upgrade"], { cwd: ws, encoding: "utf8" });

  assertCollapsed(ws, runId, "2026-07-28");
  assert.equal(
    fs.readFileSync(path.join(ws, "logs", "2026-07-28", "workers", "16-33-45-UP-T2.log"), "utf8"),
    "worker said this\n",
    "worker output moves to workers/, not into the shared files"
  );

  // The rest of the 0.0.32 restructure still applies.
  assert.match(fs.readFileSync(path.join(ws, "goals", "UP-G1", "goal.md"), "utf8"), /id: UP-G1/);
  assert.ok(fs.existsSync(path.join(ws, "goals", "UP-G1", "tasks", "UP-T2.md")));
  assert.match(fs.readFileSync(path.join(ws, "requirements", "UP-R7.md"), "utf8"), /intake/);
  assert.ok(!fs.existsSync(path.join(ws, ".worktrees")), "stale worktrees must be cleared");

  // Idempotent: a second upgrade must not duplicate or destroy anything.
  execFileSync(process.execPath, [CLI, "upgrade"], { cwd: ws, encoding: "utf8" });
  assertCollapsed(ws, runId, "2026-07-28");
  assert.equal(
    dayLines(ws, "2026-07-28").filter((l) => l.type === "run").length,
    1,
    "re-running must not duplicate the run row"
  );
});

test("upgrading from the 0.0.32 task-first layout collapses into day files", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.32");
  const runId = "2026-07-28T16-33-45-180Z_UP-T2";

  const dir = path.join(ws, "logs", "UP-T2", "2026-07-28T16-33-45-180Z");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "record.md"), "record body\n");
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"t":"1","kind":"test"}\n');
  fs.writeFileSync(
    path.join(ws, "logs", "index.jsonl"),
    `${JSON.stringify({ runId, taskId: "UP-T2", status: "success", reposChanged: [] })}\n`
  );

  execFileSync(process.execPath, [CLI, "upgrade"], { cwd: ws, encoding: "utf8" });

  assertCollapsed(ws, runId, "2026-07-28");
  assert.ok(!fs.existsSync(path.join(ws, "logs", "UP-T2")), "the task-first tree must be gone");
});

test("upgrading from the 0.0.33/34 date-slot-time layout collapses into day files", () => {
  const ws = makeWorkspace();
  pretendOlder(ws, "0.0.34");
  const runId = "2026-07-28T16-33-45-180Z_UP-T2";

  const dir = path.join(ws, "logs", "2026-07-28", "UP-T2", "16-33-45-180Z");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "record.md"), "record body\n");
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"t":"1","kind":"test"}\n');
  fs.writeFileSync(
    path.join(ws, "logs", "index.jsonl"),
    `${JSON.stringify({
      runId,
      taskId: "UP-T2",
      status: "success",
      reposChanged: [],
      detailFile: path.join("2026-07-28", "UP-T2", "16-33-45-180Z", "record.md"),
    })}\n`
  );

  execFileSync(process.execPath, [CLI, "upgrade"], { cwd: ws, encoding: "utf8" });

  assertCollapsed(ws, runId, "2026-07-28");
  assert.ok(
    !fs.existsSync(path.join(ws, "logs", "2026-07-28", "UP-T2")),
    "the nested run directories must be gone"
  );
  // The pointer that dangled in 0.0.33 now names the file the record is actually in.
  const row = dayLines(ws, "2026-07-28").find((l) => l.type === "run")!;
  assert.equal(row.detailFile, path.join("2026-07-28", "runs.md"));
  assert.ok(fs.existsSync(path.join(ws, "logs", String(row.detailFile))));
});
