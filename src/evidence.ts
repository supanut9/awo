import { createHash } from "node:crypto";
import { execFile, spawn } from "child_process";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { prepareDependencyDirs, runsInstaller, writeBaselineLease } from "./worktrees.js";
import { detachable, superviseGroup } from "./process-group.js";

/**
 * §16 — evidence is a measurement, never a claim.
 *
 * `tests-must-pass` used to be satisfied by any `test` event existing, so a run
 * closed on the strength of an agent typing "full jest suite green". Across the
 * dogfood's 24 runs there were 5 such events, every one prose, and two tasks
 * reached `done` with a commit and no test event at all.
 *
 * That is not a discipline problem, it is a measurement problem — and it matters
 * more than it looks, because agent-authored tests are usually not oracles:
 * published analysis of agent test patches found ~80% carry weak or no assertions,
 * and ~18% for Codex specifically. A workflow that accepts "tests passed" as a
 * string inherits all of it.
 *
 * So awo runs the command itself and records what happened.
 */
export interface Measurement {
  command: string;
  cwd: string;
  exitCode: number | null;
  durationSec: number;
  timedOut: boolean;
  /** Trailing output, capped — enough to see the failure, not the whole suite. */
  tail: string;
  /** Parsed passing cases, when the runner's output is recognisable. */
  passed?: number;
  /** Parsed failing cases, when the runner's output is recognisable. */
  failed?: number;
  /** What the runner reported, cases and suites kept apart. */
  counts: TestCounts;
}

/**
 * Test counts, with suites never mistaken for cases.
 *
 * The generic `(\d+) passed` pattern read vitest's `Test Files  61 passed` line
 * before its `Tests  527 passed` line, and "61 tests" reached a PR description and
 * a Jira card. Each runner is now recognised by its own summary format, and an
 * output nobody recognises says `unknown` rather than guessing.
 */
export interface TestCounts {
  /** Test cases the runner reported, failed and skipped included. */
  cases?: number;
  passed?: number;
  /** Test files, packages or suites — whatever the runner groups cases into. */
  suites?: number;
  failed?: number;
  skipped?: number;
  parser: "vitest" | "jest" | "node-test" | "mocha" | "go" | "pytest" | "unknown";
}

const TAIL_BYTES = 8 * 1024;
/** What an event may carry; the measurement artifact keeps the longer tail. */
export const EVENT_TAIL_BYTES = 2 * 1024;

export function capTail(text: string, bytes: number): string {
  return text.length > bytes ? `…\n${text.slice(-bytes)}` : text;
}

/**
 * A command that cannot fail measures nothing: `npm test || true` exits 0 whatever
 * the suite did, and a pass recorded from it would be a claim with extra steps.
 */
const CANNOT_FAIL = /(?:\|\||;)\s*(?:true|:|exit\s+0)\s*;?\s*$/;

export function cannotFail(command: string): boolean {
  return CANNOT_FAIL.test(command.trim());
}

export async function measure(
  command: string,
  cwd: string,
  timeoutMinutes = 30
): Promise<Measurement> {
  const startedAt = Date.now();
  const { code, out, timedOut } = await run(command, cwd, timeoutMinutes * 60_000);
  const counts = parseCounts(out);
  return {
    command,
    cwd,
    exitCode: code,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    timedOut,
    tail: capTail(out, TAIL_BYTES),
    ...(counts.passed !== undefined ? { passed: counts.passed } : {}),
    ...(counts.failed !== undefined ? { failed: counts.failed } : {}),
    counts,
  };
}

const BASH = "/bin/bash";

function run(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  // Through a shell on purpose: the value of this is that an agent can hand over
  // whatever the repo's real test command is, pipes and all. Under pipefail, so
  // `npm test | tee out.log` reports the suite's exit and not tee's.
  const child = detachable && fs.existsSync(BASH)
    ? spawn(BASH, ["-o", "pipefail", "-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(command, { cwd, shell: true, detached: detachable, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const take = (chunk: string): void => {
    out += chunk;
    // Keep memory bounded on a runner that prints per-test lines for 20 minutes.
    if (out.length > 512 * 1024) out = out.slice(-256 * 1024);
  };
  child.stdout?.setEncoding("utf8").on("data", take);
  child.stderr?.setEncoding("utf8").on("data", take);
  return superviseGroup(child, timeoutMs).then(({ code, timedOut, error }) =>
    error
      ? { code: 127, out: `${out}\nawo: could not run: ${error.message}`, timedOut: false }
      : { code, out, timedOut }
  );
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Sums `<n> <word>` across every line `re` (global, one capture) matches. */
function sumMatches(text: string, re: RegExp, word: string): number | undefined {
  let total: number | undefined;
  // A fresh copy: matchAll inherits lastIndex, so a reused global regex skips matches.
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    const item = new RegExp(`(\\d+)\\s+${word}\\b`, "i").exec(m[1]);
    if (item) total = (total ?? 0) + Number(item[1]);
  }
  return total;
}

function add(...values: (number | undefined)[]): number | undefined {
  return values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
}

/**
 * Recognises the common runners by their own summary lines. Every occurrence is
 * summed, so a monorepo script that runs the suite once per package reports the
 * whole run rather than its last package.
 */
export function parseCounts(raw: string): TestCounts {
  const out = raw.replace(ANSI, "").replace(/\r/g, "");

  // vitest: ` Test Files  1 failed | 60 passed (61)` / `      Tests  2 failed | 525 passed (527)`
  const vitestCases = /^[ \t]*Tests[ \t]{2,}(\d.*)$/gm;
  if (new RegExp(vitestCases.source, "m").test(out)) {
    const files = /^[ \t]*Test Files[ \t]{2,}(\d.*)$/gm;
    const failed = sumMatches(out, vitestCases, "failed");
    const passed = sumMatches(out, vitestCases, "passed");
    const skipped = add(sumMatches(out, vitestCases, "skipped"), sumMatches(out, vitestCases, "todo"));
    return {
      parser: "vitest",
      cases: add(failed, passed, skipped),
      passed,
      failed: failed ?? 0,
      skipped,
      suites: add(sumMatches(out, files, "failed"), sumMatches(out, files, "passed"), sumMatches(out, files, "skipped")),
    };
  }

  // jest: `Test Suites: 1 failed, 60 passed, 61 total` / `Tests:       2 failed, 525 passed, 527 total`
  const jestCases = /^Tests:[ \t]+(.*)$/gm;
  if (new RegExp(jestCases.source, "m").test(out)) {
    const failed = sumMatches(out, jestCases, "failed");
    const passed = sumMatches(out, jestCases, "passed");
    const skipped = add(sumMatches(out, jestCases, "skipped"), sumMatches(out, jestCases, "todo"));
    return {
      parser: "jest",
      cases: sumMatches(out, jestCases, "total") ?? add(failed, passed, skipped),
      passed,
      failed: failed ?? 0,
      skipped,
      suites: sumMatches(out, /^Test Suites:[ \t]+(.*)$/gm, "total"),
    };
  }

  // node --test (spec `ℹ tests 527`, TAP `# tests 527`)
  const nodeLine = (word: string): number | undefined => {
    let total: number | undefined;
    for (const m of out.matchAll(new RegExp(`^(?:ℹ|#)[ \\t]+${word}[ \\t]+(\\d+)[ \\t]*$`, "gm"))) {
      total = (total ?? 0) + Number(m[1]);
    }
    return total;
  };
  if (nodeLine("tests") !== undefined && nodeLine("pass") !== undefined) {
    return {
      parser: "node-test",
      cases: nodeLine("tests"),
      passed: nodeLine("pass"),
      failed: add(nodeLine("fail"), nodeLine("cancelled")) ?? 0,
      skipped: add(nodeLine("skipped"), nodeLine("todo")),
      suites: nodeLine("suites"),
    };
  }

  // mocha: `  527 passing (2s)` / `  2 pending` / `  1 failing`
  const mocha = (word: string): number | undefined => {
    let total: number | undefined;
    for (const m of out.matchAll(new RegExp(`^[ \\t]*(\\d+) ${word}\\b`, "gm"))) total = (total ?? 0) + Number(m[1]);
    return total;
  };
  if (mocha("passing") !== undefined || mocha("failing") !== undefined) {
    const passed = mocha("passing") ?? 0;
    const failed = mocha("failing") ?? 0;
    const skipped = mocha("pending");
    return { parser: "mocha", cases: passed + failed + (skipped ?? 0), passed, failed, skipped };
  }

  // go test: `ok  \tpkg\t0.01s`, `FAIL\tpkg\t0.01s`, `--- FAIL: TestX (0.00s)` (cases need -v)
  const count = (re: RegExp): number => [...out.matchAll(re)].length;
  const goPackages = count(/^(?:ok|FAIL)[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\)|\[[^\]]+\])/gm);
  const goPass = count(/^[ \t]*--- PASS: /gm);
  const goFail = count(/^[ \t]*--- FAIL: /gm);
  const goSkip = count(/^[ \t]*--- SKIP: /gm);
  if (goPackages > 0 || goPass + goFail + goSkip > 0) {
    return {
      parser: "go",
      // Without -v go prints only the failures, so a case total would be a guess.
      cases: goPass + goSkip > 0 ? goPass + goFail + goSkip : undefined,
      passed: goPass + goSkip > 0 ? goPass : undefined,
      failed: goFail,
      skipped: goSkip > 0 ? goSkip : undefined,
      suites: goPackages > 0 ? goPackages : undefined,
    };
  }

  // pytest: `==== 1 failed, 525 passed, 2 skipped in 5.20s ====` (also `-q`'s bare form)
  const pytestItem = "\\d+ (?:passed|failed|skipped|xfailed|xpassed|errors?|deselected|warnings?)";
  const pytestLine = new RegExp(`^[= ]*(${pytestItem}(?:, ${pytestItem})*)(?: in [\\d.]+s(?: \\([^)]*\\))?)?[= ]*$`, "gm");
  const summary = [...out.matchAll(pytestLine)].at(-1)?.[1];
  if (summary) {
    const item = (word: string): number | undefined => {
      const m = new RegExp(`(\\d+) ${word}\\b`).exec(summary);
      return m ? Number(m[1]) : undefined;
    };
    const passed = add(item("passed"), item("xpassed"));
    const failed = add(item("failed"), item("errors?")) ?? 0;
    const skipped = add(item("skipped"), item("xfailed"));
    return { parser: "pytest", cases: add(passed, failed, skipped), passed, failed, skipped };
  }

  return { parser: "unknown" };
}

// ---------------------------------------------------------------------------
// Deciding what a failure means
// ---------------------------------------------------------------------------

export type Diagnosis =
  | "pass"
  | "pre-existing"
  | "regression"
  | "new-contract"
  | "test-and-code-changed"
  | "not-runnable"
  | "unknown";

export interface Verdict {
  diagnosis: Diagnosis;
  explanation: string;
  /** True when nothing mechanical can settle it and a human must. */
  needsHuman: boolean;
}

/**
 * "Not executable" and "command not found": the command never reached a test.
 * Exit 2 is shell misuse — but it is also what GNU make returns when any recipe
 * fails, so it counts only when the output shows no test ran at all. Otherwise a
 * `make test` suite with old failures plus a new regression read as "not runnable".
 */
function couldNotRun(m: Measurement): boolean {
  if (m.exitCode === 126 || m.exitCode === 127) return true;
  if (m.exitCode !== 2) return false;
  const c = m.counts;
  return m.passed === undefined && m.failed === undefined && c.cases === undefined &&
    c.passed === undefined && c.failed === undefined;
}

/**
 * A failing test means either the code is wrong or the test is wrong, and which
 * one is decidable in most cases — but only against a baseline. Without one,
 * "11 pre-existing baseline failures" is a sentence an agent writes and nobody
 * can check.
 *
 * The one case that stays ambiguous is a diff that rewrites what an existing test
 * asserts, because editing the test until it passes is indistinguishable from
 * fixing a wrong test by looking at either file. The tiebreak cannot be the test
 * or the code; it has to be something that predates both, which is the
 * acceptance criteria — and if those do not settle it, it is a spec gap and the
 * task belongs in `blocked` with the question, not closed on a guess.
 */
export function diagnose(
  head: Measurement,
  base: Measurement | null,
  changed: ChangedFiles,
  options: { qaRequired?: boolean } = {}
): Verdict {
  // The same "cannot run" exit on both sides says the command, not the code, is
  // broken — a missing binary, a typo'd script. Recording that as a pre-existing
  // failure made it look like evidence about the suite.
  if (base && couldNotRun(head) && couldNotRun(base)) {
    return {
      diagnosis: "not-runnable",
      explanation:
        `The command could not run at HEAD (exit ${head.exitCode}) or at the branch point ` +
        `(exit ${base.exitCode}) — a missing binary or a malformed command, not a test result. ` +
        `It is not evidence either way; fix the command and rerun.`,
      needsHuman: false,
    };
  }

  if (head.exitCode === 0) {
    // Measured on the real workspaces: 42–58% of all test events were flagged
    // "test-and-code-changed", almost all of them ordinary TDD — a new test file
    // beside new code. Adding tests or assertions is the behaviour this rule wants;
    // only an existing test that LOST assertion lines can have been edited into
    // agreement with the code, so only that is escalated.
    if (changed.weakenedTests.length > 0) {
      const files = changed.weakenedTests.slice(0, 3).join(", ");
      return options.qaRequired
        ? {
            diagnosis: "test-and-code-changed",
            explanation:
              `Passing, but this change removes or rewrites assertions in existing tests (${files}). ` +
              `Recorded for the goal's QA review rather than escalated here: this goal requires QA, ` +
              `which checks the assertions against the acceptance criteria.`,
            needsHuman: false,
          }
        : {
            diagnosis: "test-and-code-changed",
            explanation:
              `Passing, but this change removes or rewrites assertions in existing tests (${files}). ` +
              `A test edited into agreement with the code proves nothing — check the assertions ` +
              `against the goal's acceptance criteria.`,
            needsHuman: true,
          };
    }
    const added = changed.newTests.slice(0, 3);
    const extended = changed.modifiedTests.slice(0, 3);
    const note = added.length > 0
      ? ` Adds tests (${added.join(", ")}); check they assert the acceptance criteria.`
      : extended.length > 0
        ? ` Extends existing tests (${extended.join(", ")}) without removing an assertion.`
        : "";
    return { diagnosis: "pass", explanation: `Command exited 0.${note}`, needsHuman: false };
  }

  if (!base) {
    return {
      diagnosis: "unknown",
      explanation:
        `Failing (exit ${head.exitCode}) with no baseline, so whether this change caused ` +
        `it is unknown. Re-run with --baseline to compare against the branch point.`,
      needsHuman: true,
    };
  }

  if (base.exitCode !== 0) {
    const worse =
      head.failed !== undefined && base.failed !== undefined && head.failed > base.failed;
    return worse
      ? {
          diagnosis: "regression",
          explanation:
            `Already failing at the branch point (${base.failed} failures) but worse now ` +
            `(${head.failed}). The extra failures are this change's.`,
          needsHuman: false,
        }
      : {
          diagnosis: "pre-existing",
          explanation:
            `Failing at the branch point too (exit ${base.exitCode}), and no worse now. ` +
            `Not this task's defect — but it also means this command cannot verify this task.`,
          needsHuman: false,
        };
  }

  return {
    diagnosis: changed.newTests.length > 0 ? "new-contract" : "regression",
    explanation:
      changed.newTests.length > 0
        ? `Passed at the branch point and fails now, and this change adds tests ` +
          `(${changed.newTests.slice(0, 3).join(", ")}). Either the new tests state the ` +
          `intended contract and the code does not meet it, or the tests are wrong — the ` +
          `acceptance criteria decide which.`
        : `Passed at the branch point and fails now, with no new tests. This change broke it.`,
    needsHuman: changed.newTests.length > 0,
  };
}

export interface ChangedFiles {
  all: string[];
  tests: string[];
  newTests: string[];
  /** Test files changed alongside a non-test file with the same stem. */
  testsAndCodeTogether: string[];
  /** Test files that existed at the branch point and were changed. */
  modifiedTests: string[];
  /** Existing test files whose diff removes (or rewrites) an assertion line. */
  weakenedTests: string[];
}

export const NO_CHANGES: ChangedFiles = {
  all: [], tests: [], newTests: [], testsAndCodeTogether: [], modifiedTests: [], weakenedTests: [],
};

const TEST_PATH = /(^|\/)(__tests__|__spec__|tests?|spec)\//i;
const TEST_NAME = /\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|Test\.java$|_spec\.rb$/i;

/**
 * A line that checks something, across the runners awo meets: expect/assert
 * families, chai/should, Go's t.Error/t.Fatal and testify's require/assert,
 * pytest.raises, XCTest. A removed `import assert` counts too — over-matching
 * costs a glance, under-matching lets a weakened test through.
 */
const ASSERTION =
  /\bexpect\s*[(.]|\bassert\w*|\.should\b|\bshould\.|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\brequire\.\w+\s*\(|\bXCTAssert\w*|\bpytest\.raises\b|\bt\.(?:is|deepEqual|equal|ok|notOk|throws|same|match)\s*\(/;

/** What this branch changed relative to where it started. */
export async function changedFiles(repoDir: string, baseRef: string): Promise<ChangedFiles> {
  const git = simpleGit(repoDir);
  // Include the actual tested working tree, not just committed HEAD. A failed
  // diff is unknown evidence, never proof that no files changed.
  const point = (await git.raw(["merge-base", "HEAD", baseRef])).trim();
  const raw = await git.raw(["diff", "--no-renames", "--name-status", "-z", point, "--"]);
  const fields = raw.split("\0").filter(Boolean);
  const rows: string[][] = [];
  for (let i = 0; i < fields.length; i += 2) rows.push([fields[i], fields[i + 1]]);
  const untracked = (await git.raw(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  rows.push(...untracked.map((file) => ["A", file]));

  const all = rows.map((r) => r[r.length - 1]).filter(Boolean);
  const isTest = (f: string): boolean => TEST_PATH.test(f) || TEST_NAME.test(f);
  const tests = all.filter(isTest);
  const newTests = rows.filter((r) => r[0] === "A" && isTest(r[r.length - 1])).map((r) => r[r.length - 1]);

  // "The code a test covers" is approximated by the stem: foo.service.spec.ts and
  // foo.service.ts. Approximate on purpose — a false flag costs a glance, a missed
  // one costs a test quietly rewritten to agree with the code.
  // A test marker takes the extension with it (`pricing.spec.ts` -> `pricing`), so
  // only a plain file needs its own extension stripped — doing it unconditionally
  // turned `foo.service.spec.ts` into `foo` and broke the pairing the other way.
  const stem = (f: string): string => {
    const base = path.basename(f);
    const stripped = base.replace(TEST_NAME, "").replace(/\.(test|spec)$/i, "");
    return stripped === base ? base.replace(/\.[^.]+$/, "") : stripped;
  };
  const codeStems = new Set(all.filter((f) => !isTest(f)).map(stem));
  const testsAndCodeTogether = tests.filter((f) => codeStems.has(stem(f)));

  const { modified, weakened } = tests.length > newTests.length
    ? assertionChanges(
        await git.raw(["-c", "core.quotePath=off", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--diff-filter=DMR", point, "--"]),
        isTest
      )
    : { modified: [], weakened: [] };

  return { all, tests, newTests, testsAndCodeTogether, modifiedTests: modified, weakenedTests: weakened };
}

/**
 * Which existing test files changed, and which of them lost an assertion line.
 * Renames are followed (`-M`), so moving a test file is not mistaken for deleting
 * every assertion in it; a deleted test file did lose them all.
 */
function assertionChanges(diff: string, isTest: (f: string) => boolean): { modified: string[]; weakened: string[] } {
  const modified = new Set<string>();
  const weakened = new Set<string>();
  let oldPath: string | null = null;
  let file: string | null = null;
  let inHunk = false;
  const strip = (p: string): string | null =>
    p === "/dev/null" ? null : p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- ")) oldPath = strip(line.slice(4));
      else if (line.startsWith("+++ ")) file = strip(line.slice(4)) ?? oldPath;
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (!file || oldPath === null || !(isTest(file) || isTest(oldPath))) continue;
    if (line.startsWith("-") || line.startsWith("+")) modified.add(file);
    if (line.startsWith("-") && ASSERTION.test(line.slice(1))) weakened.add(file);
  }
  return { modified: [...modified], weakened: [...weakened] };
}

/** Identity of all non-ignored content that the command can test. */
export async function treeFingerprint(repoDir: string): Promise<string> {
  const git = simpleGit(repoDir);
  const hash = createHash("sha256");
  hash.update(await git.revparse(["HEAD"]));
  hash.update(await git.raw(["diff", "--binary", "HEAD", "--"]));
  const untracked = (await git.raw(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  for (const name of untracked) {
    hash.update(name + "\0");
    const file = path.join(repoDir, name);
    const stat = await fs.lstat(file);
    hash.update(String(stat.mode) + "\0");
    hash.update(stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitIn(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")}: ${String(stderr).trim() || error.message}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * The git tree id of exactly what the command could see: every tracked and
 * untracked, non-ignored file in the checkout, independent of HEAD.
 *
 * `treeFingerprint` folded HEAD in, so the natural sequence "test, then commit
 * exactly what was tested" staled the receipt and forced a pointless rerun. A tree
 * id is the content itself — the same bytes give the same id whether they sit in
 * the working tree or in a commit. Built in a throwaway index (seeded from the
 * real one so unchanged files are not re-hashed); the checkout's own index and
 * staging are never touched.
 */
export async function contentTreeId(repoDir: string): Promise<string> {
  const realIndex = path.resolve(repoDir, (await gitIn(repoDir, ["rev-parse", "--git-path", "index"])).trim());
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "awo-tree-"));
  const index = path.join(scratch, "index");
  try {
    const real = await fs.stat(realIndex).catch(() => null);
    if (real) {
      await fs.copy(realIndex, index);
      // Git trusts a cached stat only for entries older than the index FILE's
      // mtime ("racy git"). A fresh copy is newer than the original, so an edit
      // made in the same second as the cached stat, at the same size, looked
      // clean and the old blob was hashed — the receipt then went stale at
      // completion for no reason. Backdating the copy makes those entries racy
      // again, so git compares their content.
      await fs.utimes(index, real.atime, new Date(real.mtimeMs - 2000));
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await gitIn(repoDir, ["add", "-A"], env);
    return (await gitIn(repoDir, ["write-tree"], env)).trim();
  } finally {
    await fs.remove(scratch).catch(() => {});
  }
}

/** The commit a task's branch started from, for baseline comparison. */
export async function branchPoint(repoDir: string, baseRef: string): Promise<string | null> {
  try {
    return (await simpleGit(repoDir).raw(["merge-base", "HEAD", baseRef])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Runs a command against the branch point without disturbing the worktree.
 *
 * A stash-and-checkout dance in the task's own worktree would risk the agent's
 * uncommitted work, so the baseline runs in a throwaway worktree of the same repo.
 * Node projects need their dependencies, so node_modules is linked in rather than
 * installed — the same trick task worktrees use — unless the command installs.
 */
export async function measureBaseline(
  repoDir: string,
  ref: string,
  command: string,
  scratchDir: string,
  timeoutMinutes = 30
): Promise<{ measurement: Measurement | null; error?: string; note?: string }> {
  const git = simpleGit(repoDir);
  // NOT under repoDir/.git: inside a worktree that is a FILE, not a directory, so
  // creating anything beneath it fails. The caller supplies a scratch path it owns.
  // One fresh directory per measurement — never a fixed path a crashed run left
  // registered — holding the checkout and the lease that tells prune it is in use.
  await fs.ensureDir(scratchDir);
  const dir = await fs.mkdtemp(path.join(scratchDir, `${ref.slice(0, 12)}-`));
  const checkout = path.join(dir, "checkout");
  const notes: string[] = [];
  try {
    await writeBaselineLease(dir, { ref, command });
    // A checkout deleted without git's knowledge keeps its registration, and
    // `worktree add` then fails with "missing but already registered worktree"
    // until someone prunes by hand — one of the ways baselines failed in the real
    // workspaces (F11).
    await git.raw(["worktree", "prune"]).catch(() => {});
    await git.raw(["worktree", "add", "--detach", checkout, ref]);
    const deps = path.join(repoDir, "node_modules");
    if (runsInstaller(command)) {
      // `npm ci` deletes node_modules first; through a link that is the candidate's
      // install — the shared one — which is how baselines damaged it (F11).
      notes.push("The command installs dependencies, so the baseline installs its own instead of linking the candidate's node_modules.");
    } else if (await fs.pathExists(deps)) {
      await fs.ensureSymlink(deps, path.join(checkout, "node_modules"), "dir").catch(() => {});
    }
    const prepared = await prepareDependencyDirs(checkout, command);
    if (prepared) notes.push(prepared);
    const measurement = await measure(command, checkout, timeoutMinutes);
    return { measurement, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
  } catch (err) {
    // Reported, never swallowed: a silently absent baseline turns every failure into
    // "unknown", which is the answer this whole mechanism exists to avoid.
    return { measurement: null, error: (err as Error).message };
  } finally {
    await git.raw(["worktree", "remove", "--force", checkout]).catch(() => {});
    // Takes the lease with it.
    await fs.remove(dir).catch(() => {});
  }
}
