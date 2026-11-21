import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// dist/test/e-authoring.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const moduleUrl = (name: string) => pathToFileURL(path.join(REPO_ROOT, "dist", name)).href;
const execFileAsync = promisify(execFile);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[], input?: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function frontmatter(file: string): string {
  return fs.readFileSync(file, "utf8").split("\n---\n")[0];
}

/**
 * A workspace with a git repo `api` (declared test command) and a plain directory
 * `web` (none), and an approved requirement with three criteria planned into AU-G1.
 */
function makeWorkspace(opts: { policy?: string } = {}): { ws: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awo-authoring-"));
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  execFileSync(process.execPath, [CLI, "init", "--key", "AU"], { cwd: ws });

  const api = path.join(root, "api");
  fs.mkdirSync(api);
  fs.writeFileSync(path.join(api, "t.sh"), '#!/bin/sh\necho "1 passed"\n', { mode: 0o755 });
  const git = (args: string[]) => execFileSync("git", args, { cwd: api, stdio: "ignore" });
  git(["init", "-q", "--initial-branch=main"]);
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  execFileSync(process.execPath, [CLI, "connect", api, "--name", "api"], { cwd: ws });
  execFileSync(process.execPath, [CLI, "test-command", "api", "./t.sh --quiet \"all\""], { cwd: ws });

  const web = path.join(root, "web");
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, "README.md"), "# web\n");
  execFileSync(process.execPath, [CLI, "connect", web, "--name", "web"], { cwd: ws });

  execFileSync(process.execPath, [CLI, "req", "new", "--title", "Thing"], { cwd: ws });
  const req = path.join(ws, "requirements", "AU-R1.md");
  fs.writeFileSync(
    req,
    fs.readFileSync(req, "utf8").replace(
      "- _…_",
      "- Given a cart, when it is empty, then checkout is disabled\n" +
        "- Given a cart, when an item is added, then the total updates\n" +
        "- AC-7: Given a coupon, when it has expired, then it is refused"
    )
  );
  execFileSync(process.execPath, [CLI, "req", "propose", "AU-R1"], { cwd: ws, stdio: "ignore" });
  execFileSync(process.execPath, [CLI, "req", "approve", "AU-R1"], { cwd: ws, stdio: "ignore" });
  execFileSync(
    process.execPath,
    [CLI, "goal", "new", "--from", "AU-R1", ...(opts.policy ? ["--policy", opts.policy] : [])],
    { cwd: ws }
  );
  return { ws, root };
}

const taskFile = (ws: string, id: string) => path.join(ws, "goals", "AU-G1", "tasks", `${id}.md`);

function lastBrief(ws: string): string {
  const day = fs.readdirSync(path.join(ws, "logs")).filter((d) => /^\d{4}-/.test(d))[0];
  const briefs = fs
    .readFileSync(path.join(ws, "logs", day, "runs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === "brief");
  return String(briefs.at(-1)!.text);
}

// --- E1: task new authoring flags --------------------------------------------

test("task new writes the body from --objective/--done-when, with no template placeholder", () => {
  const { ws, root } = makeWorkspace();
  const out = awo(ws, [
    "task", "new", "--goal", "AU-G1", "--name", "Empty cart", "--targets", "api",
    "--objective", "Checkout is disabled for an empty cart.",
    "--done-when", "The button is disabled", "A test covers it",
    "--criteria", "1,AC-7", "--tier", "high", "--output", "docs/notes.md", "--label", "ux",
  ]);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /still the skeleton/);

  const text = fs.readFileSync(taskFile(ws, "AU-T1"), "utf8");
  assert.match(text, /## Objective\nCheckout is disabled for an empty cart\./);
  assert.match(text, /## Done when\n- The button is disabled\n- A test covers it/);
  assert.doesNotMatch(text, /_…_|_What "done" means/, "a body built from flags carries no placeholder");
  const fm = frontmatter(taskFile(ws, "AU-T1"));
  assert.match(fm, /tier: high/);
  assert.match(fm, /criteria:\n {2}- 1\n {2}- AC-7/);
  assert.match(fm, /outputs:\n {2}- docs\/notes\.md/);
  assert.match(fm, /labels:\n {2}- ux/, "--label used to be dropped on the floor");

  // The skeleton is still the default — and the CLI says so.
  const bare = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "Bare", "--targets", "api"]);
  assert.match(bare.stdout, /still the skeleton/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("task new --body-file reads a file or stdin, and refuses ambiguous or framed bodies", () => {
  const { ws, root } = makeWorkspace();
  const bodyPath = path.join(root, "body.md");
  fs.writeFileSync(bodyPath, "## Objective\nFrom a file.\n\n## Done when\n- It is read.\n");
  assert.equal(awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "F", "--targets", "api", "--body-file", bodyPath]).code, 0);
  assert.match(fs.readFileSync(taskFile(ws, "AU-T1"), "utf8"), /From a file\./);

  const piped = awo(
    ws,
    ["task", "new", "--goal", "AU-G1", "--name", "S", "--targets", "api", "--body-file", "-"],
    "## Objective\nFrom stdin.\n"
  );
  assert.equal(piped.code, 0, piped.stderr);
  assert.match(fs.readFileSync(taskFile(ws, "AU-T2"), "utf8"), /From stdin\./);

  const both = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "X", "--targets", "api", "--body-file", bodyPath, "--objective", "y"]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /either a body \(--body-file\) or --objective/);

  fs.writeFileSync(bodyPath, "---\nid: AU-T99\n---\n## Objective\nx\n");
  const framed = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "X", "--targets", "api", "--body-file", bodyPath]);
  assert.equal(framed.code, 1);
  assert.match(framed.stderr, /its own frontmatter/);
  assert.equal(fs.readdirSync(path.join(ws, "goals", "AU-G1", "tasks")).length, 2, "refusals write nothing");
  fs.rmSync(root, { recursive: true, force: true });
});

test("targets may be empty only for investigation and decision tasks; bad criteria and tiers are refused", () => {
  const { ws, root } = makeWorkspace();
  const impl = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "Code", "--objective", "x"]);
  assert.equal(impl.code, 1);
  assert.match(impl.stderr, /implementation work needs at least one target repo: --targets <repo> \(linked: api, web\)/);
  assert.match(impl.stderr, /--kind investigation or --kind decision/);

  for (const kind of ["investigation", "decision"]) {
    const ok = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", kind, "--kind", kind, "--objective", "x"]);
    assert.equal(ok.code, 0, ok.stderr);
  }
  assert.match(frontmatter(taskFile(ws, "AU-T1")), /targets: \[\]/);

  const badCriterion = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "c", "--targets", "api", "--criteria", "4"]);
  assert.equal(badCriterion.code, 1);
  assert.match(badCriterion.stderr, /AU-G1 has no acceptance criterion 4 — goals\/AU-G1\/requirement\.md lists 3/);
  const badLabel = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "c", "--targets", "api", "--criteria", "AC-9"]);
  assert.match(badLabel.stderr, /no acceptance criterion AC-9/);
  const garbage = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "c", "--targets", "api", "--criteria", "first"]);
  assert.match(garbage.stderr, /--criteria takes the goal's acceptance-criterion numbers/);
  const badTier = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "c", "--targets", "api", "--tier", "max"]);
  assert.match(badTier.stderr, /Unknown tier "max"/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- E2: createdAt / origin, no authored status ------------------------------

test("new tasks and goals record createdAt and origin, and no authored status", () => {
  const { ws, root } = makeWorkspace();
  const goalFm = frontmatter(path.join(ws, "goals", "AU-G1", "goal.md"));
  assert.doesNotMatch(goalFm, /^status:/m, "state.json is canonical; a stale `status: planning` misled readers");
  assert.match(goalFm, /^origin: plan$/m);
  assert.match(goalFm, /^createdAt: '?\d{4}-\d{2}-\d{2}T/m);

  awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "a", "--targets", "api"]);
  awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "b", "--targets", "api", "--origin", "qa-gap"]);
  const t1 = frontmatter(taskFile(ws, "AU-T1"));
  assert.doesNotMatch(t1, /^status:/m);
  assert.match(t1, /^origin: plan$/m);
  assert.match(t1, /^createdAt: '?\d{4}-\d{2}-\d{2}T/m);
  assert.match(frontmatter(taskFile(ws, "AU-T2")), /^origin: qa-gap$/m);
  // The default status still reads as todo everywhere.
  assert.match(awo(ws, ["task", "list"]).stdout, /AU-T1\ttodo/);

  const bad = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "c", "--targets", "api", "--origin", "whim"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown origin "whim". Valid: plan, qa-gap, pr-feedback, follow-up/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- E3: id allocation --------------------------------------------------------

test("ids are monotonic: never gap-filled, never reissued after the newest file is deleted", () => {
  const { ws, root } = makeWorkspace();
  awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "one", "--targets", "api"]);
  // A hand-authored file further up the range: the next id goes past it, not into the gap.
  fs.writeFileSync(taskFile(ws, "AU-T5"), "---\nid: AU-T5\ngoalId: AU-G1\nname: hand\ntargets: [api]\n---\n\nx\n");
  assert.match(awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "two", "--targets", "api"]).stdout, /AU-T6 created/);

  // Delete the newest task (and edit it out of taskIds): its number stays spent, so
  // a new task cannot inherit an old feature/AU-T6 branch.
  fs.rmSync(taskFile(ws, "AU-T6"));
  const goalMd = path.join(ws, "goals", "AU-G1", "goal.md");
  fs.writeFileSync(goalMd, fs.readFileSync(goalMd, "utf8").replace(/\n {2}- AU-T6/, ""));
  assert.match(awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "three", "--targets", "api"]).stdout, /AU-T7 created/);

  // Requirements and goals follow the same rule.
  assert.match(awo(ws, ["req", "new", "--title", "Next"]).stdout, /AU-R2 created/);
  fs.rmSync(path.join(ws, "requirements", "AU-R2.md"));
  assert.match(awo(ws, ["req", "new", "--title", "After"]).stdout, /AU-R3 created/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("concurrent task new calls get distinct ids and all land in the goal's taskIds", async () => {
  const { ws, root } = makeWorkspace();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      execFileAsync(process.execPath, [CLI, "task", "new", "--goal", "AU-G1", "--name", `p${n}`, "--targets", "api"], { cwd: ws })
    )
  );
  const ids = results.map((r) => /(AU-T\d+) created/.exec(r.stdout)?.[1]);
  assert.equal(new Set(ids).size, 6, `ids must be distinct: ${ids.join(", ")}`);
  const goalMd = fs.readFileSync(path.join(ws, "goals", "AU-G1", "goal.md"), "utf8");
  for (const id of ids) assert.match(goalMd, new RegExp(`- ${id}\\n`), `${id} must be wired into taskIds`);
  assert.equal(fs.readdirSync(path.join(ws, "goals", "AU-G1", "tasks")).length, 6);
  assert.ok(!fs.existsSync(path.join(ws, ".workspace", "id-counters.json.lock")), "the allocation lock is released");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file the scan cannot see is never overwritten: creation is exclusive", () => {
  const { ws, root } = makeWorkspace();
  // Sits at AU-T1's path but claims another id, so allocation still picks AU-T1.
  const squatter = "---\nid: OTHER-1\ngoalId: AU-G1\nname: hand\n---\n\nkeep me\n";
  fs.writeFileSync(taskFile(ws, "AU-T1"), squatter);
  const out = awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "x", "--targets", "api"]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /AU-T1\.md already exists.*Nothing was overwritten/s);
  assert.equal(fs.readFileSync(taskFile(ws, "AU-T1"), "utf8"), squatter);
  assert.doesNotMatch(fs.readFileSync(path.join(ws, "goals", "AU-G1", "goal.md"), "utf8"), /AU-T1/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- E4: goal policy ----------------------------------------------------------

test("goal new --policy chooses the completion policy; the manifest can set the default", () => {
  const policyOf = (ws: string) => frontmatter(path.join(ws, "goals", "AU-G1", "goal.md"));

  const strict = makeWorkspace();
  assert.match(policyOf(strict.ws), /qaRequired: true\n {2}acceptanceEvidenceRequired: true/, "strict stays the default");
  fs.rmSync(strict.root, { recursive: true, force: true });

  const light = makeWorkspace({ policy: "light" });
  assert.match(policyOf(light.ws), /qaRequired: false\n {2}acceptanceEvidenceRequired: false/);
  fs.rmSync(light.root, { recursive: true, force: true });

  const standard = makeWorkspace({ policy: "standard" });
  assert.match(policyOf(standard.ws), /qaRequired: false\n {2}acceptanceEvidenceRequired: true/);

  // goals.defaultPolicy applies when --policy is not given.
  const ws = standard.ws;
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.goals = { defaultPolicy: "light" };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  awo(ws, ["req", "new", "--title", "Two", "--proposed"]);
  const req = path.join(ws, "requirements", "AU-R2.md");
  fs.writeFileSync(req, fs.readFileSync(req, "utf8").replace("- _…_", "- Given x, when y, then z"));
  awo(ws, ["req", "approve", "AU-R2"]);
  const made = awo(ws, ["goal", "new", "--from", "AU-R2"]);
  assert.match(made.stdout, /AU-G2 created .*light policy/);
  assert.match(frontmatter(path.join(ws, "goals", "AU-G2", "goal.md")), /qaRequired: false\n {2}acceptanceEvidenceRequired: false/);

  awo(ws, ["req", "new", "--title", "Three", "--proposed"]);
  const req3 = path.join(ws, "requirements", "AU-R3.md");
  fs.writeFileSync(req3, fs.readFileSync(req3, "utf8").replace("- _…_", "- Given x, when y, then z"));
  awo(ws, ["req", "approve", "AU-R3"]);
  const bad = awo(ws, ["goal", "new", "--from", "AU-R3", "--policy", "loose"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown --policy "loose". Valid: light, standard, strict/);
  assert.ok(fs.existsSync(req3), "a refused goal leaves the requirement in intake");
  fs.rmSync(standard.root, { recursive: true, force: true });
});

// --- E5: the brief ------------------------------------------------------------

test("the brief splits worker and orchestrator duties and carries test lines, skills, criteria and policy", () => {
  const { ws, root } = makeWorkspace();
  const manifestPath = path.join(ws, ".workspace", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.repos.find((r: { name: string }) => r.name === "web").mergePolicy = "authorized-maintainer";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  awo(ws, [
    "task", "new", "--goal", "AU-G1", "--name", "Cart", "--targets", "api,web",
    "--agent", "software-engineer", "--objective", "Disable checkout.", "--done-when", "disabled",
    "--criteria", "2,AC-7",
  ]);
  const run = awo(ws, ["task", "run", "AU-T1", "--instruction", "Keep it small."]);
  assert.equal(run.code, 0, run.stderr);
  const brief = lastBrief(ws);

  // What existing callers relied on is still there.
  assert.match(brief, /You are software-engineer working task AU-T1 \(goal AU-G1\)/);
  assert.match(brief, /isolated git worktree on feature\/AU-T1/);
  assert.match(brief, /--run "<cmd>"/);

  // One exact measure line per target, using the declared command (quoted), or a
  // placeholder that says to ask.
  assert.match(brief, /awo task event AU-T1 test --repo api --run "\.\/t\.sh --quiet \\"all\\"" --baseline/);
  assert.match(brief, /web: no testCommand is declared — ask the orchestrator .*do not invent one/);
  assert.match(brief, /- api: repos\/\.worktrees\/api\/AU-T1 on feature\/AU-T1/);
  assert.match(brief, /awo task complete AU-T1 --outcome success --summary/);
  assert.match(brief, /Do NOT push, open, or merge a PR unless the orchestrator's instruction says so/);
  assert.match(brief, /## Not your job \(orchestrator\)/);
  assert.match(brief, /Merge policy: human-only for api \(a human approves and merges\); authorized-maintainer for web/);
  assert.match(brief, /## From the orchestrator\nKeep it small\./);

  // Skills from the agent's frontmatter, as files to open.
  assert.match(brief, /## Skills to open first\n- skills\/create-task-worktree\.md\n- skills\/run-tests\.md\n- skills\/create-commit\.md/);

  // Only the criteria the task declared.
  assert.match(brief, /## Acceptance criteria this task serves \(AU-G1\)\n2\. Given a cart, when an item is added/);
  assert.match(brief, /AC-7\. AC-7: Given a coupon/);
  assert.doesNotMatch(brief, /when it is empty, then checkout is disabled/);

  // The six-line command card.
  const card = brief.split("## Command card\n")[1].split("\n\n")[0].split("\n");
  assert.equal(card.length, 6);
  assert.deepEqual(
    card.map((l) => l.split(/\s{2,}/)[0].split(" ").slice(0, 4).join(" ")),
    [
      "awo task event AU-T1", "awo task event AU-T1", "awo task complete AU-T1",
      "awo task evidence AU-T1", "awo task recheck AU-T1", "awo log add --agent",
    ]
  );
  // The body comes last, verbatim.
  assert.ok(brief.trimEnd().endsWith("## Done when\n- disabled"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a task with no targets is briefed as no-repo work, with all goal criteria when it declares none", () => {
  const { ws, root } = makeWorkspace();
  awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "Options", "--kind", "investigation",
    "--objective", "Compare coupon engines.", "--output", "docs/coupons.md"]);
  assert.equal(awo(ws, ["task", "run", "AU-T1"]).code, 0);
  const brief = lastBrief(ws);
  assert.match(brief, /This task changes no repo, so it has no worktree\./);
  assert.match(brief, /1\. Deliver: docs\/coupons\.md\./);
  assert.match(brief, /--summary "<the finding or decision>"/);
  assert.doesNotMatch(brief, /WARNING: no worktree isolation/);
  assert.match(brief, /## Goal acceptance criteria \(AU-G1\) — this task declares none/);
  assert.match(brief, /1\. Given a cart, when it is empty/);
  assert.match(brief, /3\. AC-7: Given a coupon/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("composeBrief prints each target's recorded base branch when it is provided", async () => {
  const { composeBrief } = await import(moduleUrl("commands/task.js"));
  const brief: string = composeBrief({
    taskId: "X-T1",
    agent: null,
    body: "## Objective\nx",
    branch: "feature/X-T1",
    isolated: true,
    targets: [
      {
        repo: "api",
        worktree: "repos/.worktrees/api/X-T1",
        branch: "feature/X-T1",
        testCommand: null,
        base: { ref: "origin/develop", sha: "0123456789abcdef" },
        mergePolicy: "human-only",
      },
    ],
  });
  assert.match(brief, /api: repos\/\.worktrees\/api\/X-T1 on feature\/X-T1, cut from origin\/develop @ 0123456/);
  // An old-style call with no gathered context still produces a usable brief.
  const legacy: string = composeBrief({ taskId: "X-T2", agent: "qa-engineer", body: "b", isolated: false });
  assert.match(legacy, /You are qa-engineer working task X-T2\./);
  assert.match(legacy, /WARNING: no worktree isolation/);
  assert.match(legacy, /awo task event X-T2 test --run "<cmd>" --baseline/);
});

// --- E6: models -----------------------------------------------------------------

test("the built-in low tier is sonnet and hints are runnable: cd for Claude, quoted paths, Codex-only effort", async () => {
  const { invocationHint, fallbackHint, describeModel } = await import(moduleUrl("models.js"));
  const ctx = { cwd: "repos/.worktrees/api/my task", allow: ["/tmp/a repo/.git"] };

  const claude: string = invocationHint({ runtime: "claude", model: "sonnet", effort: "medium" }, "T1", ctx);
  assert.equal(
    claude,
    `cd "repos/.worktrees/api/my task" && claude --model sonnet --add-dir "/tmp/a repo/.git" "Follow instructions/ship-a-change.md for T1."`
  );
  assert.doesNotMatch(claude, / -C /, "Claude Code has no -C flag");

  const codex: string = invocationHint({ runtime: "codex", model: "gpt-5-codex", effort: "high" }, "T1", ctx);
  assert.match(codex, /^codex exec -m gpt-5-codex -c model_reasoning_effort=high -s workspace-write -C "repos\/\.worktrees\/api\/my task" --add-dir "\/tmp\/a repo\/\.git" "/);

  // A prompt keeps its command substitution live, but its quotes are escaped.
  const plan: string = invocationHint({ runtime: "claude", model: "opus" }, "G1", { cwd: ".", prompt: '$(awo log show r1) "x"' });
  assert.match(plan, /claude --model opus "\$\(awo log show r1\) \\"x\\""$/);

  const fb: string = fallbackHint({ runtime: "claude", model: "sonnet", fallback: { runtime: "gemini", model: "g" } }, "T1", ctx);
  assert.match(fb, /^cd "repos\/\.worktrees\/api\/my task" && gemini -m g -p "/);

  assert.equal(describeModel({ runtime: "codex", model: "m", effort: "high" }), "codex:m effort=high");
  assert.equal(describeModel({ runtime: "claude", model: "opus", effort: "high" }), "claude:opus effort=high (Codex-only; not passed to claude)");

  // No policy: the low-tier role resolves to sonnet.
  const { ws, root } = makeWorkspace();
  awo(ws, ["task", "new", "--goal", "AU-G1", "--name", "x", "--targets", "web", "--agent", "software-engineer", "--objective", "x"]);
  const out = awo(ws, ["task", "run", "AU-T1"]);
  assert.match(out.stdout, /low tier/);
  assert.match(out.stdout, /model:\s+claude:sonnet/);
  assert.doesNotMatch(out.stdout, /haiku/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- E7: templates --------------------------------------------------------------

test("the template names only commands and layouts that exist, and splits worker from orchestrator", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-template-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TPL"], { cwd: ws });
  const read = (rel: string) => fs.readFileSync(path.join(ws, rel), "utf8");
  const all = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );
  const everything = all(ws)
    .filter((f) => !f.includes(`${path.sep}template-base${path.sep}`))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

  for (const ghost of [/awo skill new/, /awo agent new/, /awo rule add/, /logs\/index\.jsonl/, /--data '\{"repo"/, /status: refined/, /`refined`\./]) {
    assert.doesNotMatch(everything, ghost, `template still mentions ${ghost}`);
  }

  assert.deepEqual(JSON.parse(read(".workspace/connectors.json")), { connectors: [] });
  assert.match(read(".gitignore"), /^\/\.workspace\/local\/$/m);
  assert.match(read(".gitignore"), /^\/\.workspace\/scratch\/$/m);

  const agents = read("AGENTS.md");
  assert.match(agents, /## Command card/);
  assert.match(agents, /awo task event <T> test --repo <repo> --run "<cmd>" --baseline/);
  assert.match(agents, /Never turn the workspace root into a git repository/);

  const ship = read("instructions/ship-a-change.md");
  assert.match(ship, /## Worker — inside the run[\s\S]*## Orchestrator — after the run closes[\s\S]*awo pr link/);
  assert.match(ship, /A worker does \*\*not\*\* push, open, link or merge a PR/);

  assert.match(read("skills/run-tests.md"), /awo task event <task> test --repo <repo> --run "<testCommand>" --baseline/);
  assert.match(read("skills/create-task-worktree.md"), /`awo task run <taskId>` creates the worktree/);
  assert.match(read("skills/create-task-worktree.md"), /repos\/\.worktrees\/<repo>\/<taskId>` on branch\n {3}`feature\/<taskId>`/);
  assert.doesNotMatch(read("skills/create-task-worktree.md"), /git -C repos/);
  assert.match(read("skills/verify-acceptance-criteria.md"), /--pass --summary "/);
  assert.match(read("skills/verify-acceptance-criteria.md"), /measured test run of the task/);
  const capture = read("instructions/capture-requirement.md");
  assert.match(capture, /awo req propose[\s\S]*awo req approve[\s\S]*awo goal new/);
  assert.match(read("rules/record-every-run.md"), /captured from git automatically/);
  assert.match(read("catalog/skills/review-logs.md"), /logs\/<date>\/runs\.jsonl/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("the plan brief teaches the authoring flags", () => {
  const { ws, root } = makeWorkspace();
  const out = awo(ws, ["goal", "plan", "AU-G1"]);
  const briefRunId = /awo log show (\S+)/.exec(out.stdout)?.[1];
  const brief = awo(ws, ["log", "show", briefRunId!]).stdout;
  assert.match(brief, /awo task new --goal AU-G1 --name "…" --targets <repo> --objective "…"/);
  assert.match(brief, /--body-file <path> \(or --body-file - to read stdin\)/);
  assert.match(brief, /omit --targets, name what it delivers with\n {2}--output <path>/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- E8: init --name ------------------------------------------------------------

test("init --name sets the human-facing project name; an empty one is refused", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-name-"));
  const out = awo(ws, ["init", "--key", "NM", "--name", "Northwind Mobile"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /project key NM \(Northwind Mobile\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8"));
  assert.equal(manifest.projectName, "Northwind Mobile");
  assert.equal(manifest.projectKey, "NM");
  assert.match(awo(ws, ["context"]).stdout, /NM · Northwind Mobile/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "awo-name-"));
  const refused = awo(empty, ["init", "--key", "NM", "--name", "  "]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--name must not be empty/);
  assert.deepEqual(fs.readdirSync(empty), [], "a refused init writes nothing");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
