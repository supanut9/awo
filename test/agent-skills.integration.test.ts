import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/agent-skills.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

interface ListedSkill {
  name: string;
  source: string;
  tier: "default" | "catalog";
  summary: string;
  skills: string[];
  installed: { where: "workspace" | "user" | "partial" | "absent"; missing: string[] };
}

function initWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-agent-skills-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TST"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function writeDeclaration(root: string, value: unknown): void {
  fs.writeFileSync(path.join(root, ".workspace", "agent-skills.json"), JSON.stringify(value, null, 2));
}

/** Presence is decided by `<root>/.claude/skills/<name>/SKILL.md` — nothing else. */
function placeSkill(root: string, name: string): void {
  const dir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

function listExternal(root: string): ListedSkill[] {
  return JSON.parse(
    execFileSync(process.execPath, [CLI, "skill", "external", "--json"], {
      cwd: root,
      encoding: "utf8",
    })
  ) as ListedSkill[];
}

/** Run the CLI expecting failure, and return what it complained about. */
function expectFailure(root: string, args: string[]): string {
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`expected \`awo ${args.join(" ")}\` to fail`);
}

test("a declaration defaults tier to catalog and skills to [name]", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [{ name: "seo", source: "addyosmani/web-quality-skills", summary: "use when…" }],
  });
  const [skill] = listExternal(root);
  assert.equal(skill.tier, "catalog");
  assert.deepEqual(skill.skills, ["seo"]);
});

test("a declaration with no summary is rejected", () => {
  // The summary is the only line that reaches an agent's context, so an entry
  // without one renders a bare name — which is precisely what gets skipped.
  const root = initWorkspace();
  writeDeclaration(root, { external: [{ name: "seo", source: "a/b" }] });
  assert.match(expectFailure(root, ["skill", "external"]), /summary is required/);
});

test("a duplicate name is rejected", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [
      { name: "seo", source: "a/b", summary: "x" },
      { name: "seo", source: "c/d", summary: "y" },
    ],
  });
  assert.match(expectFailure(root, ["skill", "external"]), /declared more than once/);
});

test("an unknown tier is rejected", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [{ name: "seo", source: "a/b", summary: "x", tier: "later" }],
  });
  assert.match(expectFailure(root, ["skill", "external"]), /must be "default" or "catalog"/);
});

test("install state separates workspace, partial and absent", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [
      { name: "here", source: "a/b", summary: "x" },
      { name: "gone", source: "a/b", summary: "x" },
      { name: "bundle", source: "a/b", summary: "x", skills: ["one", "two"] },
    ],
  });
  placeSkill(root, "here");
  placeSkill(root, "one"); // half the bundle

  const byName = new Map(listExternal(root).map((s) => [s.name, s]));
  assert.equal(byName.get("here")?.installed.where, "workspace");
  assert.equal(byName.get("gone")?.installed.where, "absent");
  // A half-installed bundle is its own state: it looks fine until something
  // reaches for the member that isn't there.
  assert.equal(byName.get("bundle")?.installed.where, "partial");
  assert.deepEqual(byName.get("bundle")?.installed.missing, ["two"]);
});

test("the generated agent-skills block in AGENTS.md tracks the declaration", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [
      { name: "mine", source: "a/b", summary: "use when y happens", tier: "default" },
      { name: "absent", source: "a/b", summary: "use when z happens", tier: "catalog" },
    ],
  });
  placeSkill(root, "mine");

  // Any catalog write refreshes the managed blocks; `skill add` is the cheapest.
  execFileSync(process.execPath, [CLI, "skill", "add", "write-migration"], {
    cwd: root,
    stdio: "ignore",
  });

  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const block = agents
    .split("<!-- awo:generated agent-skills -->")[1]
    .split("<!-- /awo:generated -->")[0];

  assert.match(block, /- `mine` — use when y happens/);
  // An uninstalled skill still gets a line, carrying the command that installs it —
  // hiding it would mean an agent cannot know the option existed.
  assert.match(block, /- `absent`.*awo skill sync absent/s);
});

test("awo skill sync refuses a name that is not declared", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [{ name: "declared", source: "a/b", summary: "use when z happens" }],
  });
  // Fails rather than silently installing something unvetted from the ecosystem.
  assert.match(expectFailure(root, ["skill", "sync", "undeclared"]), /not declared/);
});

test("awo skill sync --dry-run installs nothing", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [{ name: "declared", source: "a/b", summary: "use when z happens", tier: "default" }],
  });

  const out = execFileSync(process.execPath, [CLI, "skill", "sync", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(out, /declared/);
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "declared")), false);
});

test("the shipped template declares find-skills, research and diagnosing-bugs by default", () => {
  const root = initWorkspace();
  const byDefault = listExternal(root)
    .filter((s) => s.tier === "default")
    .map((s) => s.name);

  // `use-declared-skills` names research and diagnosing-bugs specifically, so
  // leaving them opt-in would make the rule point at nothing.
  assert.ok(byDefault.includes("research"), `research not default-tier: ${byDefault.join(", ")}`);
  assert.ok(byDefault.includes("diagnosing-bugs"));
  assert.ok(byDefault.includes("find-skills"));
});

test("doctor warns about a declared default-tier skill that is missing", () => {
  const root = initWorkspace();
  writeDeclaration(root, {
    external: [{ name: "missing-one", source: "a/b", summary: "use when q happens", tier: "default" }],
  });

  // doctor exits non-zero when it finds anything, so capture either way.
  let out = "";
  try {
    out = execFileSync(process.execPath, [CLI, "doctor"], { cwd: root, encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string };
    out = e.stdout ?? "";
  }
  assert.match(out, /missing-one/);
});
