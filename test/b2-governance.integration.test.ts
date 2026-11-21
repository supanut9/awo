import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/b2-governance.integration.test.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const load = (name: string) => import(pathToFileURL(path.join(REPO_ROOT, "dist", name)).href);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function awo(cwd: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env, stdio: "pipe" }),
      stderr: "",
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** An agent runtime's shell: Claude Code sets CLAUDECODE, and nobody set AWO_HUMAN. */
const AGENT: NodeJS.ProcessEnv = { ...process.env, AWO_HUMAN: "", CLAUDECODE: "1" };

/** A person at the keyboard with a known (fictional) git identity, or none. */
function humanEnv(gitName: string | null): NodeJS.ProcessEnv {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "awo-gitcfg-"));
  const file = path.join(config, "gitconfig");
  fs.writeFileSync(file, gitName ? `[user]\n\tname = ${gitName}\n` : "");
  return { ...process.env, AWO_HUMAN: "1", GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" };
}

const CRITERIA =
  "## Draft acceptance criteria\n" +
  "- AC-1: Given a cart, when checkout runs, then tax is applied\n" +
  "- AC-2: Given an empty cart, when checkout runs, then it is refused\n";

function makeWorkspace(options: { git?: boolean } = {}): { ws: string; repo: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-b2-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "GV"], { cwd: ws, stdio: "ignore" });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-b2repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  if (options.git) {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  }
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: ws, stdio: "ignore" });
  return { ws, repo };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const reqFile = (ws: string, id: string) => path.join(ws, "requirements", `${id}.md`);

/** A requirement with real criteria, proposed and waiting on a human. */
function proposedRequirement(ws: string, title = "Tax at checkout"): string {
  const created = awo(ws, ["req", "new", "--title", title]);
  const id = /(GV-R\d+) created/.exec(created.stdout)![1];
  const file = reqFile(ws, id);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Draft acceptance criteria\n- _…_\n", CRITERIA));
  assert.equal(awo(ws, ["req", "propose", id]).code, 0);
  return id;
}

async function frontmatter(ws: string, id: string): Promise<Record<string, unknown>> {
  const { runReqShow } = await load("commands/intake.js");
  return (await runReqShow(id, { cwd: ws })).frontmatter;
}

function goalState(ws: string, goalId = "GV-G1"): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ws, "goals", goalId, "state.json"), "utf8"));
}

function setManifest(ws: string, edit: (m: Record<string, any>) => void): void {
  const file = path.join(ws, ".workspace", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

/**
 * A governed goal with one in-review task that carries a measured passing test and
 * evidence for both criteria — everything up to the point where a verdict is due.
 */
function goalAwaitingVerdict(): { ws: string; repo: string } {
  const { ws, repo } = makeWorkspace({ git: true });
  const id = proposedRequirement(ws);
  assert.equal(awo(ws, ["req", "approve", id, "--who", "lead-reviewer"]).code, 0);
  assert.equal(awo(ws, ["goal", "new", "--from", id]).code, 0);
  awo(ws, ["task", "new", "--goal", "GV-G1", "--name", "Tax", "--targets", "api"]);
  awo(ws, ["task", "run", "GV-T1"]);
  awo(ws, ["task", "event", "GV-T1", "test", "--run", "true"]);
  const done = awo(ws, ["task", "complete", "GV-T1", "--outcome", "success", "--gate", "--unchanged", "fixture"]);
  assert.equal(done.code, 0, done.stderr);
  const evidence = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1,2", "--kind", "test"]);
  assert.equal(evidence.code, 0, evidence.stderr);
  assert.equal(awo(ws, ["goal", "verify", "GV-G1"]).code, 0);
  return { ws, repo };
}

// ---------------------------------------------------------------------------
// B2-3 — the criteria parser
// ---------------------------------------------------------------------------

test("criteria parser reads every criteria section, top-level un-struck items only, with stable labels", async () => {
  const { findCriteria, findCriteriaDetailed } = await load("commands/intake.js");

  // Measured on CRM-G38: trailing text after the heading made the section invisible.
  assert.deepEqual(
    findCriteria("## Acceptance criteria (final design F2, F4, L2)\n- one\n- two\n"),
    ["one", "two"]
  );

  const body = [
    "## Raw requirement",
    "### Acceptance Criteria (PM's own)",
    "- the verbatim ticket's criterion, refined below",
    "",
    "## Acceptance criteria (final design F2, …)",
    "- AC-1: First criterion",
    "  - a sub-bullet is detail, not a criterion",
    "- **AC-2** — Second criterion",
    "  continued on the next line",
    "- ~~AC-3: retired criterion~~ — VOID with FR-001",
    "3. AC-4 Fourth, in the bare form",
    "- **AC1 and AC2 conflict** is prose about criteria, not a label",
    "",
    "## Superseded — acceptance criteria of the earlier design (kept for history)",
    "- AC-90: from the old design",
    "",
    "## Added 2026-11-11: amendment",
    "- a design note, not a criterion",
    "- AC-5 — declared in an amendment",
    "- AC-1: a reference to an existing label is not a second criterion",
    "",
    "### Amendment acceptance criteria",
    "Given an unlabelled amendment, when it is read, then it counts",
    "",
    "```",
    "- AC-6: inside a code fence",
    "```",
  ].join("\n");

  const parsed = findCriteriaDetailed(body) as Array<{ index: number; label: string | null; text: string; hash: string }>;
  assert.deepEqual(
    parsed.map((c) => c.label),
    ["AC-1", "AC-2", "AC-4", null, "AC-5", null]
  );
  assert.equal(parsed[1].text, "**AC-2** — Second criterion continued on the next line");
  assert.ok(!parsed.some((c) => /sub-bullet|retired|old design|design note|verbatim|code fence/.test(c.text)));
  assert.deepEqual(parsed.map((c) => c.index), [1, 2, 3, 4, 5, 6]);
  assert.match(parsed[0].hash, /^[0-9a-f]{16}$/);
  // The legacy shape is unchanged for existing callers.
  assert.deepEqual(findCriteria(body), parsed.map((c) => c.text));

  // Only when nothing else declares criteria do the verbatim ticket's count.
  assert.deepEqual(
    findCriteria("## Raw requirement\n### Acceptance Criteria\n- from the ticket\n"),
    ["from the ticket"]
  );
});

// ---------------------------------------------------------------------------
// B2-2 — approval only from proposed, with criteria, pinned by digest
// ---------------------------------------------------------------------------

test("req approve only accepts a proposed requirement with criteria, and pins their digest", async () => {
  const { ws, repo } = makeWorkspace();

  awo(ws, ["req", "new", "--title", "Still a draft"]);
  const draft = awo(ws, ["req", "approve", "GV-R1", "--who", "lead-reviewer"]);
  assert.equal(draft.code, 1);
  assert.match(draft.stderr, /awo req propose GV-R1/);

  // `--proposed` skips refinement, but a placeholder is still nothing to approve.
  awo(ws, ["req", "new", "--title", "Empty proposal", "--proposed"]);
  const empty = awo(ws, ["req", "approve", "GV-R2", "--who", "lead-reviewer"]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no acceptance criteria/);

  const rejected = proposedRequirement(ws, "Rejected once");
  assert.equal(awo(ws, ["req", "reject", rejected, "--why", "too vague"]).code, 0);
  const afterReject = awo(ws, ["req", "approve", rejected, "--who", "lead-reviewer"]);
  assert.equal(afterReject.code, 1);
  assert.match(afterReject.stderr, /propose it again/);

  const parked = proposedRequirement(ws, "Parked");
  awo(ws, ["req", "suspend", parked, "--why", "not this quarter"]);
  const afterSuspend = awo(ws, ["req", "approve", parked, "--who", "lead-reviewer"]);
  assert.equal(afterSuspend.code, 1);
  assert.match(afterSuspend.stderr, new RegExp(`awo req resume ${parked}`));

  const good = proposedRequirement(ws, "Good one");
  const approved = awo(ws, ["req", "approve", good, "--who", "lead-reviewer"]);
  assert.equal(approved.code, 0, approved.stderr);
  const fm = await frontmatter(ws, good);
  assert.equal(fm.status, "approved");
  assert.equal(fm.decidedBy, "lead-reviewer");
  assert.equal(fm.via, "human");
  assert.match(String(fm.criteriaDigest), /^[0-9a-f]{64}$/);

  const again = awo(ws, ["req", "approve", good, "--who", "lead-reviewer"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already approved/);

  // The digest makes a later edit to the approved terms visible.
  const shown = JSON.parse(awo(ws, ["req", "show", good, "--json"]).stdout);
  assert.equal(shown.decision.criteriaChangedSinceApproval, false);
  fs.writeFileSync(reqFile(ws, good), fs.readFileSync(reqFile(ws, good), "utf8").replace("tax is applied", "tax is waived"));
  const edited = awo(ws, ["req", "show", good]);
  assert.match(edited.stdout, /CRITERIA CHANGED SINCE APPROVAL/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B2-1 — honest human gates
// ---------------------------------------------------------------------------

test("--who never defaults to the literal \"human\": git identity, else unknown", async () => {
  const { ws, repo } = makeWorkspace();
  const named = proposedRequirement(ws, "Named by git");
  assert.equal(awo(ws, ["req", "approve", named], humanEnv("Test Person")).code, 0);
  assert.equal((await frontmatter(ws, named)).decidedBy, "Test Person");

  const anonymous = proposedRequirement(ws, "No identity");
  assert.equal(awo(ws, ["req", "approve", anonymous], humanEnv(null)).code, 0);
  assert.equal((await frontmatter(ws, anonymous)).decidedBy, "unknown");

  // A role is not a person.
  const role = proposedRequirement(ws, "Role");
  const refused = awo(ws, ["req", "approve", role, "--who", "human"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /names a role or a placeholder/);
  cleanup(ws, repo);
});

test("under an agent runtime req approve needs --delegated-by, and records the delegation", async () => {
  const { ws, repo } = makeWorkspace();
  const id = proposedRequirement(ws);

  const refused = awo(ws, ["req", "approve", id, "--who", "lead-reviewer"], AGENT);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /human decision/);
  assert.match(refused.stderr, /own terminal/);
  assert.match(refused.stderr, /AWO_HUMAN=1/);
  assert.match(refused.stderr, /--delegated-by "<who>" --instruction "<their words, verbatim>"/);
  assert.equal((await frontmatter(ws, id)).status, "proposed", "a refusal changes nothing");

  const placeholder = awo(ws, ["req", "approve", id, "--delegated-by", "<human>"], AGENT);
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.stderr, /placeholder/);

  const delegated = awo(
    ws,
    ["req", "approve", id, "--delegated-by", "lead-reviewer", "--instruction", "approve it, the criteria are right"],
    AGENT
  );
  assert.equal(delegated.code, 0, delegated.stderr);
  assert.match(delegated.stdout, /delegated — recorded by claude/);
  const fm = await frontmatter(ws, id);
  assert.equal(fm.decidedBy, "lead-reviewer");
  assert.equal(fm.via, "claude");
  assert.deepEqual(fm.delegation, {
    by: "lead-reviewer",
    instruction: "approve it, the criteria are right",
    via: "claude",
  });

  // A person typing through the agent's shell says so explicitly.
  const second = proposedRequirement(ws, "Second");
  const passthrough = awo(ws, ["req", "approve", second, "--who", "lead-reviewer"], { ...AGENT, AWO_HUMAN: "1" });
  assert.equal(passthrough.code, 0, passthrough.stderr);
  assert.equal((await frontmatter(ws, second)).via, "human");

  // Non-gated decisions are still recorded honestly: the agent, not "human".
  const third = proposedRequirement(ws, "Third");
  assert.equal(awo(ws, ["req", "reject", third, "--why", "duplicate"], AGENT).code, 0);
  const rejected = await frontmatter(ws, third);
  assert.equal(rejected.decidedBy, "claude");
  assert.equal(rejected.via, "claude");
  cleanup(ws, repo);
});

test("governance.allowDelegation: false makes the gates human-terminal only", async () => {
  const { ws, repo } = makeWorkspace();
  setManifest(ws, (m) => {
    m.governance = { allowDelegation: false };
  });
  const id = proposedRequirement(ws);

  const refused = awo(ws, ["req", "approve", id, "--delegated-by", "lead-reviewer", "--instruction", "go"], AGENT);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /allowDelegation: false/);
  assert.match(refused.stderr, /own terminal/);
  assert.equal((await frontmatter(ws, id)).status, "proposed");

  const humanDelegating = awo(ws, ["req", "approve", id, "--delegated-by", "lead-reviewer"]);
  assert.equal(humanDelegating.code, 1);
  assert.match(humanDelegating.stderr, /Delegation is disabled/);

  assert.equal(awo(ws, ["req", "approve", id, "--who", "lead-reviewer"]).code, 0);
  cleanup(ws, repo);
});

test("goal verdict under an agent needs --delegated-by; verdicts record delegation and keep their history", () => {
  const { ws, repo } = goalAwaitingVerdict();

  const refused = awo(ws, ["goal", "verdict", "GV-G1", "--pass", "--summary", "meets DoD", "--who", "lead-reviewer"], AGENT);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /AWO_HUMAN=1/);
  assert.match(refused.stderr, /--delegated-by/);
  assert.equal(goalState(ws).qa.verdict, null, "a refused verdict records nothing");

  const pass = awo(
    ws,
    ["goal", "verdict", "GV-G1", "--pass", "--summary", "meets DoD", "--delegated-by", "lead-reviewer", "--instruction", "ship it"],
    AGENT
  );
  assert.equal(pass.code, 0, pass.stderr);
  let state = goalState(ws);
  assert.equal(state.qa.verdict, "pass");
  assert.equal(state.qa.verdictBy, "lead-reviewer");
  assert.deepEqual(state.qa.delegation, { by: "lead-reviewer", instruction: "ship it", via: "claude" });

  // A GAP found later replaces the PASS; the PASS is retired into history, not lost.
  const gap = awo(
    ws,
    ["goal", "verdict", "GV-G1", "--gap", "--new-scope", "--summary", "needs a second provider", "--delegated-by", "lead-reviewer"],
    AGENT
  );
  assert.equal(gap.code, 0, gap.stderr);
  state = goalState(ws);
  assert.equal(state.qa.verdict, "gap");
  assert.equal(state.qa.delegation.instruction, null);
  const retired = state.qaHistory.at(-1);
  assert.equal(retired.verdict, "pass");
  assert.match(retired.retiredReason, /superseded by the GAP verdict/);
  assert.ok(retired.retiredAt);

  setManifest(ws, (m) => {
    m.governance = { allowDelegation: false };
  });
  const locked = awo(ws, ["goal", "verdict", "GV-G1", "--gap", "--new-scope", "--summary", "x", "--delegated-by", "lead-reviewer"], AGENT);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /allowDelegation: false/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B2-4 / B2-5 — criterion evidence
// ---------------------------------------------------------------------------

test("test evidence binds to a measured passing test of the task, never to prose", () => {
  const { ws, repo } = makeWorkspace({ git: true });
  const id = proposedRequirement(ws);
  awo(ws, ["req", "approve", id, "--who", "lead-reviewer"]);
  awo(ws, ["goal", "new", "--from", id]);
  awo(ws, ["task", "new", "--goal", "GV-G1", "--name", "Tax", "--targets", "api"]);

  const nothing = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "test", "--ref", "unit tests pass"]);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /awo task event GV-T1 test --run/);
  assert.match(nothing.stderr, /--kind manual/);

  awo(ws, ["task", "run", "GV-T1"]);
  const checkout = path.join(ws, "repos", ".worktrees", "api", "GV-T1");
  fs.writeFileSync(path.join(checkout, "marker"), "x");
  awo(ws, ["task", "event", "GV-T1", "test", "--run", "test -f marker"]);
  awo(ws, ["task", "event", "GV-T1", "test", "--run", "true"]);

  // Prose that matches no measured command is refused, with what was measured.
  const prose = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "test", "--ref", "verified on UAT"]);
  assert.equal(prose.code, 1);
  assert.match(prose.stderr, /No measured test of GV-T1 matches "verified on UAT"/);
  assert.match(prose.stderr, /test -f marker/);

  // A later failure of the same command supersedes its earlier pass.
  fs.rmSync(path.join(checkout, "marker"));
  awo(ws, ["task", "event", "GV-T1", "test", "--run", "test -f marker"]);
  const superseded = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "test", "--ref", "marker"]);
  assert.equal(superseded.code, 1);
  assert.match(superseded.stderr, /latest measurement of that command failed/);

  // Omitted ref: the latest passing measurement still current — `true`.
  const latest = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "AC-2", "--kind", "test"]);
  assert.equal(latest.code, 0, latest.stderr);
  assert.match(latest.stdout, /criterion 2 \(AC-2\) <- test evidence from GV-T1 — measured `true` exit 0/);
  const entry = goalState(ws).criteria["2"][0];
  assert.equal(entry.verified, true);
  assert.equal(entry.by, "human");
  assert.equal(entry.criterionLabel, "AC-2");
  assert.match(entry.criterionHash, /^[0-9a-f]{16}$/);
  assert.equal(entry.measurement.command, "true");
  assert.equal(entry.measurement.exitCode, 0);
  assert.equal(entry.measurement.repo, "api");

  // By runId: the run whose latest measurement passed.
  const byRun = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "test", "--ref", entry.measurement.runId]);
  assert.equal(byRun.code, 1, "that run's latest measurement is the failed `test -f marker`");
  assert.match(byRun.stderr, /failed/);

  const manualNoRef = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "manual"]);
  assert.equal(manualNoRef.code, 1);
  assert.match(manualNoRef.stderr, /--kind manual needs --ref/);
  const manual = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1", "--kind", "manual", "--ref", "https://example.test/check"]);
  assert.equal(manual.code, 0, manual.stderr);
  assert.equal(goalState(ws).criteria["1"][0].by, "human");
  cleanup(ws, repo);
});

test("--criterion takes lists and labels; trace and readiness flag criteria edited after evidence", async () => {
  const { ws, repo } = makeWorkspace();
  const id = proposedRequirement(ws);
  awo(ws, ["req", "approve", id, "--who", "lead-reviewer"]);
  awo(ws, ["goal", "new", "--from", id]);
  awo(ws, ["task", "new", "--goal", "GV-G1", "--name", "Tax", "--targets", "api"]);

  const both = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "1,AC-2", "--kind", "manual", "--ref", "checked by hand"]);
  assert.equal(both.code, 0, both.stderr);
  assert.match(both.stdout, /criterion 1 \(AC-1\) <- manual/);
  assert.match(both.stdout, /criterion 2 \(AC-2\) <- manual/);
  const unknown = awo(ws, ["task", "evidence", "GV-T1", "--criterion", "AC-9", "--kind", "manual", "--ref", "x"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no criterion labelled AC-9\. Labels: AC-1, AC-2/);

  // Edit AC-1 after its evidence was attached.
  const requirement = path.join(ws, "goals", "GV-G1", "requirement.md");
  fs.writeFileSync(requirement, fs.readFileSync(requirement, "utf8").replace("tax is applied", "VAT and tax are applied"));

  const trace = awo(ws, ["goal", "trace", "GV-G1"]);
  assert.match(trace.stdout, /^1\tstale\t/m);
  assert.match(trace.stdout, /STALE: criterion edited since evidence — re-attach/);
  assert.match(trace.stdout, /re-attach: awo task evidence GV-T1 --criterion AC-1 --kind manual --ref "checked by hand"/);
  assert.match(trace.stdout, /^2\tcovered\t/m);

  const { runGoalReadiness } = await load("commands/readiness.js");
  const readiness = await runGoalReadiness("GV-G1", { cwd: ws });
  const stale = readiness.blockers.find((b: { code: string }) => b.code === "criterion-edited-since-evidence");
  assert.equal(stale?.criterion, 1);
  assert.equal(readiness.criteria.stale, 1);
  assert.equal(readiness.criteria.covered + readiness.criteria.exceptions + readiness.criteria.missing, 2);

  // Re-attaching confirms the new wording.
  assert.equal(awo(ws, ["task", "evidence", "GV-T1", "--criterion", "AC-1", "--kind", "manual", "--ref", "checked by hand"]).code, 0);
  assert.match(awo(ws, ["goal", "trace", "GV-G1"]).stdout, /^1\tcovered\t/m);

  // Legacy entries (no hash, no measurement) keep counting, and show as claims.
  const file = path.join(ws, "goals", "GV-G1", "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.criteria = { "1": [{ taskId: "GV-T1", kind: "test", ref: "unit tests pass", recordedAt: "2026-10-01" }] };
  fs.writeFileSync(file, JSON.stringify(state));
  const legacy = awo(ws, ["goal", "trace", "GV-G1"]);
  assert.match(legacy.stdout, /^1\tcovered\t/m);
  assert.match(legacy.stdout, /unit tests pass\tclaimed/);
  const after = await runGoalReadiness("GV-G1", { cwd: ws });
  assert.ok(!after.blockers.some((b: { code: string; criterion?: number }) => b.criterion === 1));
  cleanup(ws, repo);
});

test("labelled evidence follows its criterion when an amendment re-numbers the list", async () => {
  const { ws, repo } = makeWorkspace();
  const id = proposedRequirement(ws);
  awo(ws, ["req", "approve", id, "--who", "lead-reviewer"]);
  awo(ws, ["goal", "new", "--from", id]);
  awo(ws, ["task", "new", "--goal", "GV-G1", "--name", "Tax", "--targets", "api"]);
  assert.equal(awo(ws, ["task", "evidence", "GV-T1", "--criterion", "AC-2", "--kind", "manual", "--ref", "seen"]).code, 0);

  const requirement = path.join(ws, "goals", "GV-G1", "requirement.md");
  fs.writeFileSync(
    requirement,
    fs.readFileSync(requirement, "utf8").replace("- AC-2:", "- AC-0: Given anything, when inserted first, then it shifts the rest\n- AC-2:")
  );
  const { runGoalTrace } = await load("commands/traceability.js");
  const rows = await runGoalTrace("GV-G1", { cwd: ws });
  assert.equal(rows[2].label, "AC-2");
  assert.equal(rows[2].status, "covered", "AC-2's evidence moved with it to position 3");
  assert.equal(rows[1].status, "missing", "the inserted criterion inherits nothing");
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B2-6 / B2-7 — QA history and the brief file
// ---------------------------------------------------------------------------

test("QA briefs get their own file, and every overwrite or invalidation keeps the record", () => {
  const { ws, repo } = goalAwaitingVerdict();
  const first = goalState(ws).qa.briefRunId as string;

  const verify = awo(ws, ["goal", "verify", "GV-G1"]);
  assert.equal(verify.code, 0, verify.stderr);
  const second = goalState(ws).qa.briefRunId as string;
  assert.notEqual(first, second);
  const history = goalState(ws).qaHistory;
  assert.equal(history.at(-1).briefRunId, first);
  assert.match(history.at(-1).retiredReason, new RegExp(`superseded by QA brief ${second}`));

  // The brief is a file of its own; the run record links to it.
  const day = second.slice(0, 10);
  const briefFile = path.join(ws, "logs", day, "qa", `${second}.md`);
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.match(brief, /Judge the goal AS A WHOLE/);
  assert.doesNotMatch(brief, /logs\/index\.jsonl/);
  assert.match(brief, /awo log list --task/);
  const record = fs.readFileSync(path.join(ws, "logs", day, "runs.md"), "utf8");
  const section = record.slice(record.indexOf(`<!-- awo:run ${second} -->`)).split("<!-- awo:run ").slice(0, 2).join("");
  assert.match(section, new RegExp(`qa/${second}\\.md`));
  assert.doesNotMatch(section, /Judge the goal AS A WHOLE/);
  assert.match(verify.stdout, new RegExp(`cat logs/${day}/qa/${second}\\.md`));

  // New work retires QA into history instead of deleting it.
  const added = awo(ws, ["task", "new", "--goal", "GV-G1", "--name", "More", "--targets", "api"]);
  assert.equal(added.code, 0, added.stderr);
  let state = goalState(ws);
  assert.equal(state.qa, undefined);
  assert.equal(state.qaHistory.at(-1).briefRunId, second);
  assert.match(state.qaHistory.at(-1).retiredReason, /new task GV-T2/);

  awo(ws, ["goal", "verify", "GV-G1"]); // refuses: GV-T2 is unfinished
  awo(ws, ["task", "status", "GV-T2", "cancelled"]);
  assert.equal(awo(ws, ["goal", "verify", "GV-G1"]).code, 0);
  const third = goalState(ws).qa.briefRunId;
  // Sending reviewed work back is a status change that invalidates the brief.
  assert.equal(awo(ws, ["task", "status", "GV-T1", "todo"]).code, 0);
  state = goalState(ws);
  assert.equal(state.qa, undefined);
  assert.equal(state.qaHistory.at(-1).briefRunId, third);
  assert.match(state.qaHistory.at(-1).retiredReason, /GV-T1 moved in-review -> todo/);
  cleanup(ws, repo);
});

// ---------------------------------------------------------------------------
// B2-8 — req show, req list --stale, aliases
// ---------------------------------------------------------------------------

test("req show, req list --stale and the --reason/--by aliases", () => {
  const { ws, repo } = makeWorkspace();
  const fresh = proposedRequirement(ws, "Fresh");
  const old = proposedRequirement(ws, "Old");
  const older = proposedRequirement(ws, "Older");
  for (const [id, when] of [[old, "2026-01-10T00:00:00.000Z"], [older, "2025-12-01T00:00:00.000Z"]]) {
    const text = fs.readFileSync(reqFile(ws, id), "utf8")
      .replace(/^createdAt: .*$/m, `createdAt: '${when}'`)
      .replace(/^proposedAt: .*$/m, `proposedAt: '${when}'`);
    fs.writeFileSync(reqFile(ws, id), text);
  }

  const stale = awo(ws, ["req", "list", "--stale", "30"]);
  assert.equal(stale.code, 0, stale.stderr);
  const lines = stale.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^${older}\\tproposed\\t\\d+d\\t2 criteria\\tOlder$`));
  assert.match(lines[1], new RegExp(`^${old}\\tproposed\\t\\d+d`));
  assert.doesNotMatch(stale.stdout, new RegExp(fresh));
  assert.equal(awo(ws, ["req", "list", "--stale", "soon"]).code, 1);

  const shown = awo(ws, ["req", "show", fresh]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /status: {3}proposed/);
  assert.match(shown.stdout, /criteria \(2\):\n {2}1\tAC-1\tAC-1: Given a cart/);
  const json = JSON.parse(awo(ws, ["req", "show", fresh, "--json"]).stdout);
  assert.deepEqual(json.criteria.map((c: { label: string }) => c.label), ["AC-1", "AC-2"]);
  assert.equal(json.decision, null);

  // `--reason` / `--by`: the spellings agents reach for.
  const rejected = awo(ws, ["req", "reject", fresh, "--reason", "needs numbers", "--by", "lead-reviewer"]);
  assert.equal(rejected.code, 0, rejected.stderr);
  const decided = JSON.parse(awo(ws, ["req", "show", fresh, "--json"]).stdout);
  assert.equal(decided.decision.decidedBy, "lead-reviewer");
  assert.equal(decided.decision.note, "needs numbers");

  const suspended = awo(ws, ["req", "suspend", old, "--reason", "next quarter", "--by", "lead-reviewer"]);
  assert.equal(suspended.code, 0, suspended.stderr);
  const parked = JSON.parse(awo(ws, ["req", "show", old, "--json"]).stdout);
  assert.equal(parked.frontmatter.suspendedBy, "lead-reviewer");
  assert.equal(parked.frontmatter.decisionNote, "next quarter");
  const resumed = awo(ws, ["req", "resume", old, "--reason", "vendor is ready"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(awo(ws, ["req", "show", old, "--json"]).stdout).frontmatter.resumeNote, "vendor is ready");

  const approve = awo(ws, ["req", "approve", older, "--by", "lead-reviewer"]);
  assert.equal(approve.code, 0, approve.stderr);
  assert.equal(JSON.parse(awo(ws, ["req", "show", older, "--json"]).stdout).decision.decidedBy, "lead-reviewer");

  // A planned requirement is still showable after `goal new` moved its file.
  assert.equal(awo(ws, ["goal", "new", "--from", older]).code, 0);
  const planned = JSON.parse(awo(ws, ["req", "show", older, "--json"]).stdout);
  assert.equal(planned.goalId, "GV-G1");
  assert.match(planned.file, /^goals\/GV-G1\/requirement\.md$/);
  cleanup(ws, repo);
});
