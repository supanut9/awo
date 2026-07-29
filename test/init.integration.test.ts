import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/init.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "PROM-workspace");

// Fields the generator fills in per-run rather than copying verbatim from the
// template; compared for well-formedness instead of exact fixture equality.
const DYNAMIC_MANIFEST_FIELDS = new Set(["libraryVersion", "createdAt", "workspaceId"]);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** v7's first 48 bits are a big-endian millisecond Unix timestamp. */
function uuidV7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

test("awo --version reports the package version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim();
  assert.equal(out, pkg.version);
});

test("awo init --key PROM matches the PROM-workspace reference", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-init-"));

  execFileSync(process.execPath, [CLI, "init", "--key", "PROM"], { cwd: tmpDir });

  // .workspace/template-base/ is a pristine copy of the template itself, kept for
  // three-way merges (§17.2). Comparing it against the fixture would duplicate every
  // template file in the fixture for no added coverage.
  const derived = (f: string): boolean => f.startsWith(path.join(".workspace", "template-base"));
  const actualFiles = listFilesRecursive(tmpDir).filter((f) => !derived(f));
  const expectedFiles = listFilesRecursive(FIXTURE);
  assert.deepEqual(actualFiles, expectedFiles, "generated file tree must match the fixture exactly");

  for (const relPath of expectedFiles) {
    const actualPath = path.join(tmpDir, relPath);
    const expectedPath = path.join(FIXTURE, relPath);

    if (relPath === path.join(".workspace", "manifest.json")) {
      const actual = JSON.parse(fs.readFileSync(actualPath, "utf8"));
      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

      for (const key of Object.keys(expected)) {
        if (DYNAMIC_MANIFEST_FIELDS.has(key)) continue;
        assert.deepEqual(actual[key], expected[key], `manifest.json field "${key}" mismatch`);
      }

      assert.equal(typeof actual.libraryVersion, "string");
      assert.ok(actual.libraryVersion.length > 0, "libraryVersion must be set");

      const createdAt = new Date(actual.createdAt);
      assert.ok(!Number.isNaN(createdAt.getTime()), "createdAt must be a valid ISO timestamp");
      assert.ok(Date.now() - createdAt.getTime() < 60_000, "createdAt must be close to init time");

      // §5: generated per workspace, so it can't byte-match the fixture — but it
      // must be a real uuid v7 and must not be the fixture's placeholder.
      assert.match(actual.workspaceId, UUID_V7, "workspaceId must be a uuid v7");
      assert.notEqual(
        actual.workspaceId,
        expected.workspaceId,
        "workspaceId must be generated, not copied from the template"
      );
      // v7 is time-ordered; its embedded timestamp proves it was minted now.
      assert.ok(
        Date.now() - uuidV7Timestamp(actual.workspaceId) < 60_000,
        "workspaceId's v7 timestamp must be close to init time"
      );
      continue;
    }

    if (relPath === path.join(".workspace", "template.lock")) {
      // §11.2: hashes are stable except for manifest.json, which embeds the
      // per-run workspaceId/createdAt/libraryVersion. Compare the file set
      // exactly, and every hash except that one.
      const actual = JSON.parse(fs.readFileSync(actualPath, "utf8"));
      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

      assert.equal(typeof actual.libraryVersion, "string");
      assert.deepEqual(
        Object.keys(actual.files).sort(),
        Object.keys(expected.files).sort(),
        "template.lock must cover exactly the files init laid down"
      );
      assert.ok(
        !("\.workspace/template.lock" in actual.files),
        "template.lock must not hash itself"
      );

      for (const [file, hash] of Object.entries(actual.files)) {
        assert.match(hash as string, /^sha256-[0-9a-f]{64}$/, `${file} hash malformed`);
        if (file === ".workspace/manifest.json") continue;
        assert.equal(hash, expected.files[file], `template.lock hash drifted for ${file}`);
      }
      continue;
    }

    const actual = fs.readFileSync(actualPath);
    const expected = fs.readFileSync(expectedPath);
    assert.ok(actual.equals(expected), `content mismatch for ${relPath}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("awo init installs a human-only PR approval boundary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-init-human-approval-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "PROM"], { cwd: tmpDir });

  const rule = fs.readFileSync(path.join(tmpDir, "rules", "human-approval-required.md"), "utf8");
  const workflow = fs.readFileSync(path.join(tmpDir, "instructions", "pm-to-pr.md"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, ".workspace", "manifest.json"), "utf8"));
  assert.match(rule, /MUST NOT[\s\S]*submit an approving review/);
  assert.match(rule, /human-only[\s\S]*ready for human approval/);
  assert.match(rule, /authorized-maintainer[\s\S]*may merge/);
  assert.match(workflow, /pullRequests\.mergePolicy/);
  assert.equal(manifest.pullRequests.mergePolicy, "human-only");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("awo init rejects a non-empty target directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-init-nonempty-"));
  fs.writeFileSync(path.join(tmpDir, "existing.txt"), "hello");

  assert.throws(() => {
    execFileSync(process.execPath, [CLI, "init", "--key", "PROM"], { cwd: tmpDir, stdio: "pipe" });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("awo init rejects an invalid --key", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-init-badkey-"));

  assert.throws(() => {
    execFileSync(process.execPath, [CLI, "init", "--key", "prom"], { cwd: tmpDir, stdio: "pipe" });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("init refuses a non-empty directory, and says how to adopt it instead", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-adopt-"));
  fs.writeFileSync(path.join(dir, "ANALYTICS_SPEC.md"), "spec\n");

  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [CLI, "init", "--key", "SHOP"], { cwd: dir, stdio: "pipe" });
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    code = e.status ?? 1;
    stderr = e.stderr?.toString() ?? "";
  }
  assert.equal(code, 1);
  assert.match(stderr, /is not empty/);
  assert.match(stderr, /awo init --key SHOP --adopt/, "it must name the way forward");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adopt adds awo to an existing project without touching a single existing file", () => {
  // The shape a real hand-rolled hub has: symlinked repos, a CLAUDE.md carrying the
  // rules people actually follow, and a pile of decision docs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awo-adoptroot-"));
  const hub = path.join(root, "hub");
  fs.mkdirSync(hub);

  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q . && git add -A && git commit -qm base --allow-empty", {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b.c" },
  });
  fs.symlinkSync(repo, path.join(hub, "api"), "dir");

  const claude = "# CLAUDE.md\n\n## Deploys — use the Cloud Build trigger, NOT gcloud builds submit\n";
  fs.writeFileSync(path.join(hub, "CLAUDE.md"), claude);
  fs.writeFileSync(path.join(hub, "ANALYTICS_SPEC.md"), "spec\n");

  const out = execFileSync(process.execPath, [CLI, "init", "--key", "SHOP", "--adopt"], {
    cwd: hub,
    encoding: "utf8",
  });

  // Nothing of the user's was overwritten, and it says so file by file.
  assert.equal(fs.readFileSync(path.join(hub, "CLAUDE.md"), "utf8"), claude);
  assert.equal(fs.readFileSync(path.join(hub, "ANALYTICS_SPEC.md"), "utf8"), "spec\n");
  assert.match(out, /Kept your existing 1 file\(s\)/);
  assert.match(out, /CLAUDE\.md/);
  assert.match(out, /does not yet point at AGENTS\.md/, "the collision must be explained");

  // The scaffolding that was missing did land.
  assert.ok(fs.existsSync(path.join(hub, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(hub, "rules", "tests-must-pass.md")));
  assert.ok(fs.existsSync(path.join(hub, ".workspace", "manifest.json")));
  assert.ok(fs.existsSync(path.join(hub, ".gitignore")), "the un-dotted gitignore still lands");

  // The existing repo was discovered and moved under repos/, not re-linked by hand.
  assert.match(out, /Adopted 1 repo\(s\)/);
  assert.ok(!fs.existsSync(path.join(hub, "api")), "the root symlink is moved, not duplicated");
  assert.equal(fs.realpathSync(path.join(hub, "repos", "api")), fs.realpathSync(repo));

  const manifest = JSON.parse(fs.readFileSync(path.join(hub, ".workspace", "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.repos.map((r: { name: string; type: string }) => [r.name, r.type]),
    [["api", "local"]]
  );

  // Adopting twice is an error with a useful next step, not a mess.
  let stderr = "";
  try {
    execFileSync(process.execPath, [CLI, "init", "--key", "SHOP", "--adopt"], { cwd: hub, stdio: "pipe" });
  } catch (err) {
    stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
  }
  assert.match(stderr, /already an awo workspace/);
  assert.match(stderr, /awo upgrade/);
  fs.rmSync(root, { recursive: true, force: true });
});
