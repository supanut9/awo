import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("awo init --key PROM matches the PROM-workspace reference", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-init-"));

  execFileSync(process.execPath, [CLI, "init", "--key", "PROM"], { cwd: tmpDir });

  const actualFiles = listFilesRecursive(tmpDir);
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
