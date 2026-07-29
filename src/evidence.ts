import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";

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
  /** Parsed counts, when the runner's output is recognisable. */
  passed?: number;
  failed?: number;
}

const TAIL_BYTES = 8 * 1024;

export async function measure(
  command: string,
  cwd: string,
  timeoutMinutes = 30
): Promise<Measurement> {
  const startedAt = Date.now();
  const { code, out, timedOut } = await run(command, cwd, timeoutMinutes * 60_000);
  return {
    command,
    cwd,
    exitCode: code,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    timedOut,
    tail: out.length > TAIL_BYTES ? `…\n${out.slice(-TAIL_BYTES)}` : out,
    ...parseCounts(out),
  };
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Through a shell on purpose: the value of this is that an agent can hand over
    // whatever the repo's real test command is, pipes and all.
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk: Buffer): void => {
      out += chunk.toString();
      // Keep memory bounded on a runner that prints per-test lines for 20 minutes.
      if (out.length > 512 * 1024) out = out.slice(-256 * 1024);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}\nawo: could not run: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

/** Recognises the common runners. Absent counts are simply not reported. */
function parseCounts(out: string): { passed?: number; failed?: number } {
  const patterns: [RegExp, "passed" | "failed"][] = [
    [/Tests:\s+(?:.*?)(\d+) passed/i, "passed"],
    [/Tests:\s+(\d+) failed/i, "failed"],
    [/(\d+) passing/i, "passed"],
    [/(\d+) failing/i, "failed"],
    [/(\d+) passed/i, "passed"],
    [/(\d+) failed/i, "failed"],
    [/ok (\d+)\b/i, "passed"],
  ];
  const found: { passed?: number; failed?: number } = {};
  for (const [re, key] of patterns) {
    if (found[key] !== undefined) continue;
    const m = re.exec(out);
    if (m) found[key] = Number(m[1]);
  }
  return found;
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
  | "unknown";

export interface Verdict {
  diagnosis: Diagnosis;
  explanation: string;
  /** True when nothing mechanical can settle it and a human must. */
  needsHuman: boolean;
}

/**
 * A failing test means either the code is wrong or the test is wrong, and which
 * one is decidable in most cases — but only against a baseline. Without one,
 * "11 pre-existing baseline failures" is a sentence an agent writes and nobody
 * can check.
 *
 * The one case that stays ambiguous is a diff that touches a test and the code it
 * covers together, because editing the test until it passes is indistinguishable
 * from fixing a wrong test by looking at either file. The tiebreak cannot be the
 * test or the code; it has to be something that predates both, which is the
 * acceptance criteria — and if those do not settle it, it is a spec gap and the
 * task belongs in `blocked` with the question, not closed on a guess.
 */
export function diagnose(head: Measurement, base: Measurement | null, changed: ChangedFiles): Verdict {
  if (head.exitCode === 0) {
    return changed.testsAndCodeTogether.length > 0
      ? {
          diagnosis: "test-and-code-changed",
          explanation:
            `Passing, but this change edits tests and the code they cover together ` +
            `(${changed.testsAndCodeTogether.slice(0, 3).join(", ")}). A test edited into ` +
            `agreement with the code proves nothing — check the assertions against the ` +
            `goal's acceptance criteria.`,
          needsHuman: true,
        }
      : { diagnosis: "pass", explanation: "Command exited 0.", needsHuman: false };
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
}

const TEST_PATH = /(^|\/)(__tests__|__spec__|tests?|spec)\//i;
const TEST_NAME = /\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|Test\.java$|_spec\.rb$/i;

/** What this branch changed relative to where it started. */
export async function changedFiles(repoDir: string, baseRef: string): Promise<ChangedFiles> {
  const git = simpleGit(repoDir);
  const raw = await git.raw(["diff", "--name-status", `${baseRef}...HEAD`]).catch(() => "");
  const rows = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split("\t"));

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

  return { all, tests, newTests, testsAndCodeTogether };
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
 * installed — the same trick task worktrees use.
 */
export async function measureBaseline(
  repoDir: string,
  ref: string,
  command: string,
  scratchDir: string,
  timeoutMinutes = 30
): Promise<{ measurement: Measurement | null; error?: string }> {
  const git = simpleGit(repoDir);
  // NOT under repoDir/.git: inside a worktree that is a FILE, not a directory, so
  // creating anything beneath it fails. The caller supplies a scratch path it owns.
  const tmp = path.join(scratchDir, ref.slice(0, 12));
  try {
    await fs.remove(tmp);
    await fs.ensureDir(path.dirname(tmp));
    await git.raw(["worktree", "add", "--detach", tmp, ref]);
    const deps = path.join(repoDir, "node_modules");
    if (await fs.pathExists(deps)) {
      await fs.ensureSymlink(deps, path.join(tmp, "node_modules"), "dir").catch(() => {});
    }
    return { measurement: await measure(command, tmp, timeoutMinutes) };
  } catch (err) {
    // Reported, never swallowed: a silently absent baseline turns every failure into
    // "unknown", which is the answer this whole mechanism exists to avoid.
    return { measurement: null, error: (err as Error).message };
  } finally {
    await git.raw(["worktree", "remove", "--force", tmp]).catch(() => {});
    await fs.remove(tmp).catch(() => {});
  }
}
