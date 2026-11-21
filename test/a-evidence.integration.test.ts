import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/test/a-evidence.integration.test.js -> repo root is two levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const load = (name: string) => import(pathToFileURL(path.join(ROOT, "dist", name)).href);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a spawnSync would block every other case running beside it. */
function awo(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", message);
}

interface Fixture {
  ws: string;
  repos: Record<string, string>;
  goalFile: string;
  runId: () => string;
  events: () => Record<string, unknown>[];
  rows: () => Record<string, unknown>[];
}

/**
 * A workspace with one goal and one task over real git repos, the run already
 * open in the shared checkouts (`--no-worktree`) so the test edits what awo measures.
 */
async function workspace(
  t: { after: (fn: () => void) => void },
  opts: { targets?: string[]; qaRequired?: boolean; files?: Record<string, string>; open?: boolean } = {}
): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "awo-lane-a-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  assert.equal((await awo(ws, ["init", "--key", "TST"])).code, 0);
  const targets = opts.targets ?? ["api"];
  const repos: Record<string, string> = {};
  for (const name of targets) {
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const files = opts.files ?? { "src/pricing.ts": "export const rate = 0.1;\n" };
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    commitAll(repo, "base");
    assert.equal((await awo(ws, ["connect", repo, "--name", name])).code, 0);
    repos[name] = repo;
  }
  const goalDir = path.join(ws, "goals", "TST-G1");
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  const goalFile = path.join(goalDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    `---\nid: TST-G1\ntitle: Lane A\nstatus: planning\n${opts.qaRequired ? "completionPolicy:\n  qaRequired: true\n" : ""}---\n`
  );
  fs.writeFileSync(
    path.join(goalDir, "tasks", "TST-T1.md"),
    `---\nid: TST-T1\ngoalId: TST-G1\nname: Lane A task\ntargets: [${targets.join(", ")}]\nstatus: todo\n---\n\n## Objective\nDo it.\n`
  );
  if (opts.open !== false) {
    const opened = await awo(ws, ["task", "run", "TST-T1", "--no-worktree"]);
    assert.equal(opened.code, 0, opened.stderr);
  }
  const state = () => JSON.parse(fs.readFileSync(path.join(goalDir, "state.json"), "utf8"));
  const lines = () =>
    fs
      .readdirSync(path.join(ws, "logs"))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .flatMap((d) => fs.readFileSync(path.join(ws, "logs", d, "runs.jsonl"), "utf8").split("\n"))
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const runId = () => state().tasks["TST-T1"].lastRunId as string;
  return {
    ws,
    repos,
    goalFile,
    runId,
    events: () => lines().filter((l) => l.type === "event" && l.runId === runId()),
    rows: () => lines().filter((l) => l.type === "run"),
  };
}

const status = (f: Fixture): string => {
  const state = JSON.parse(fs.readFileSync(path.join(path.dirname(f.goalFile), "state.json"), "utf8"));
  return state.tasks["TST-T1"].status;
};
const lastTest = (f: Fixture): Record<string, unknown> => f.events().filter((e) => e.kind === "test").at(-1)!;
const FAIL = `node -e "console.log('boom: expected 1 got 2'); process.exit(1)"`;

// Each case builds its own workspace and spawns the CLI, so they run side by side.
describe("lane A — evidence & completion integrity", { concurrency: 4 }, () => {
  // ---------------------------------------------------------------------------
  // A1 — --untested excuses a missing check, never a failing, stale or inconclusive one
  // ---------------------------------------------------------------------------

  test("A1: --untested cannot close a run whose measured check failed", async (t) => {
    const f = await workspace(t);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", FAIL]);
    const out = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "no runner here", "--unchanged", "x"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /failing measured checks/);
    assert.match(out.stderr, /--untested excuses a missing check, not a failing one/);
    assert.equal(status(f), "running", "the run stays open");
  });

  test("A1: --untested cannot launder a stale receipt or an inconclusive pass", async (t) => {
    const f = await workspace(t, { files: { "src/pricing.ts": "export const rate = 0.1;\n", "src/pricing.spec.ts": "expect(rate).toBe(0.1)\n" } });
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.3;\n");
    const stale = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "skip"]);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /stale test receipt/);

    // A rewritten assertion in an existing test needs a human; --untested is no substitute for review.
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(rate).toBe(0.3)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    assert.equal(lastTest(f).needsHuman, true);
    const human = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "skip"]);
    assert.equal(human.code, 1);
    assert.match(human.stderr, /needs a human/);
  });

  // ---------------------------------------------------------------------------
  // A2 — dispatch only excuses a worker that recorded no test, and never swallows a refusal
  // ---------------------------------------------------------------------------

  test("A2: dispatch leaves the run open and reports the gate when the worker's measured test failed", async (t) => {
    const f = await workspace(t, { open: false });
    const bin = path.join(path.dirname(f.ws), "bin");
    fs.mkdirSync(bin);
    // A stand-in worker that measures a failing suite and then exits 0, as a sloppy agent would.
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\n"${process.execPath}" "${CLI}" task event TST-T1 test --run "exit 1" --no-fail >/dev/null 2>&1\nexit 0\n`
    );
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    const out = await awo(f.ws, ["task", "dispatch", "TST-T1", "--timeout", "1"], {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(out.code, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /exited 0 -> success/);
    assert.match(out.stdout, /closing it was refused/);
    assert.match(out.stdout, /failing measured checks/);
    assert.equal(status(f), "running", "a refused close leaves the run open, not closed as success");
    assert.ok(!f.events().some((e) => e.kind === "run.end"));
  });

  test("A2: dispatch still excuses a worker that recorded no test at all", async (t) => {
    const f = await workspace(t, { open: false });
    const bin = path.join(path.dirname(f.ws), "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    const out = await awo(f.ws, ["task", "dispatch", "TST-T1", "--timeout", "1"], {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(status(f), "done");
    const end = f.events().find((e) => e.kind === "run.end")!;
    assert.equal(end.untested, "dispatched worker did not record a test event");
    assert.match(String(end.actualModel), /^claude:/, "the dispatched model is recorded as what ran");
  });

  // ---------------------------------------------------------------------------
  // A3 — callers cannot write awo's fields
  // ---------------------------------------------------------------------------

  test("A3: --data cannot impersonate a measurement or rewrite the envelope", async (t) => {
    const f = await workspace(t);
    for (const data of ['{"verified":true,"exitCode":0}', '{"diagnosis":"pass"}', '{"type":"run"}', '{"kind":"test"}', '{"treeId":"x"}']) {
      const out = await awo(f.ws, ["task", "event", "TST-T1", "note", "--data", data]);
      assert.equal(out.code, 1, data);
      assert.match(out.stderr, /--data may not set/);
    }
    assert.equal((await awo(f.ws, ["task", "event", "TST-T1", "note", "--data", "[1,2]"])).code, 1, "an array is not an object");
    assert.ok(!f.events().some((e) => e.kind === "note"), "nothing was recorded");

    // Even a library caller cannot replace the envelope: it is written last.
    const { appendEvent } = await load("runs.js");
    await appendEvent(f.ws, f.runId(), "note", { kind: "test", t: "forged", runId: "other", type: "run", label: "ok" });
    const note = f.events().find((e) => e.kind === "note")!;
    assert.equal(note.type, "event");
    assert.equal(note.runId, f.runId());
    assert.notEqual(note.t, "forged");
    assert.equal(note.label, "ok");
  });

  // ---------------------------------------------------------------------------
  // A4 — completion follows the destination; outcome defaults to success
  // ---------------------------------------------------------------------------

  test("A4: a needs-human pass closes without --gate when the goal routes success to QA anyway", async (t) => {
    const f = await workspace(t, { files: { "src/pricing.ts": "export const rate = 0.1;\n", "src/pricing.spec.ts": "expect(rate).toBe(0.1)\n" } });
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.3;\n");
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(rate).toBe(0.3)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    assert.equal(lastTest(f).needsHuman, true);
    fs.writeFileSync(f.goalFile, fs.readFileSync(f.goalFile, "utf8").replace("status: planning\n", "status: planning\ncompletionPolicy:\n  qaRequired: true\n"));
    const out = await awo(f.ws, ["task", "complete", "TST-T1", "--summary", "done"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /-> success; task is now in-review/);
  });

  test("A4: --outcome defaults to success, --failed/--skipped are shorthands, prose is not an outcome", async (t) => {
    const f = await workspace(t);
    const prose = await awo(f.ws, ["task", "complete", "TST-T1", "--outcome", "implemented the endpoint"]);
    assert.equal(prose.code, 1);
    assert.match(prose.stderr, /Did you mean --summary "implemented the endpoint"\?/);
    assert.match((await awo(f.ws, ["task", "complete", "TST-T1", "--failed", "--outcome", "success"])).stderr, /Conflicting outcomes/);

    const failed = await awo(f.ws, ["task", "complete", "TST-T1", "--failed", "--summary", "no luck"]);
    assert.equal(failed.code, 0, failed.stderr);
    assert.match(failed.stdout, /-> failed; task is now blocked/);

    await awo(f.ws, ["task", "status", "TST-T1", "todo"]);
    await awo(f.ws, ["task", "run", "TST-T1", "--no-worktree"]);
    const ok = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "nothing to run", "--summary", "fine"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /-> success; task is now done/);
  });

  // ---------------------------------------------------------------------------
  // A5 — every changed target needs its own passing measurement
  // ---------------------------------------------------------------------------

  test("A5: a multi-target task cannot close on one repo's green suite", async (t) => {
    const f = await workspace(t, { targets: ["api", "web"] });
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.2;\n");
    fs.writeFileSync(path.join(f.repos.web, "src/pricing.ts"), "export const rate = 0.2;\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--repo", "api", "--run", "true"]);
    const refused = await awo(f.ws, ["task", "complete", "TST-T1"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /changed web but has no passing measured test there/);
    assert.match(refused.stderr, /--repo web/);

    const excused = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "web has no runner yet"]);
    assert.equal(excused.code, 0, excused.stderr);
    const end = f.events().find((e) => e.kind === "run.end")!;
    assert.deepEqual(end.untestedRepos, ["web"]);
    const record = fs.readFileSync(path.join(f.ws, "logs", f.runId().slice(0, 10), "runs.md"), "utf8");
    assert.match(record, /UNTESTED: web has no runner yet \(no passing measurement in: web\)/);
  });

  test("A5: measuring every changed target satisfies the gate", async (t) => {
    const f = await workspace(t, { targets: ["api", "web"] });
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.2;\n");
    fs.writeFileSync(path.join(f.repos.web, "src/pricing.ts"), "export const rate = 0.2;\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--repo", "api", "--run", "true"]);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--repo", "web", "--run", "true"]);
    const out = await awo(f.ws, ["task", "complete", "TST-T1"]);
    assert.equal(out.code, 0, out.stderr);
  });

  // ---------------------------------------------------------------------------
  // A6 — receipts are keyed on tested content
  // ---------------------------------------------------------------------------

  test("A6: committing exactly the tested content keeps the receipt valid", async (t) => {
    const f = await workspace(t);
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.2;\n");
    fs.writeFileSync(path.join(f.repos.api, "src/new.ts"), "export const fresh = true;\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    const receipt = lastTest(f);
    assert.match(String(receipt.treeId), /^[a-f0-9]{40,64}$/);
    commitAll(f.repos.api, "feat: tested change");
    const out = await awo(f.ws, ["task", "complete", "TST-T1"]);
    assert.equal(out.code, 0, out.stderr);
    // The real index was never touched by the content snapshot.
    assert.equal(git(f.repos.api, "status", "--porcelain"), "");
  });

  test("A6: an edit after testing still stales the receipt, and legacy receipts keep the old comparison", async (t) => {
    const f = await workspace(t);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.9;\n");
    git(f.repos.api, "add", "-A");
    assert.match((await awo(f.ws, ["task", "complete", "TST-T1"])).stderr, /stale test receipt/);

    // A pre-0.8.0 receipt with only the HEAD-bound fingerprint.
    const { appendEvent } = await load("runs.js");
    const { treeFingerprint } = await load("evidence.js");
    const fingerprint = await treeFingerprint(f.repos.api);
    await appendEvent(f.ws, f.runId(), "test", {
      repo: "api", command: "true", verified: true, exitCode: 0, checkout: f.repos.api,
      treeFingerprint: fingerprint, treeFingerprintAfter: fingerprint, diagnosis: "pass", needsHuman: false,
    });
    const legacy = await awo(f.ws, ["task", "complete", "TST-T1"]);
    assert.equal(legacy.code, 0, legacy.stderr);
  });

  test("A6: the content snapshot sees a same-size edit inside git's racy window", async (t) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-lane-a-racy-"));
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    git(repo, "init", "-q", "-b", "main");
    const file = path.join(repo, "rate.ts");
    const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    fs.writeFileSync(file, "rate = 1\n");
    fs.utimesSync(file, second, second);
    commitAll(repo, "base");
    // Same size, same mtime as the cached stat, and the index no older than the
    // entry: only git's racy-entry content check can tell the file changed.
    fs.writeFileSync(file, "rate = 2\n");
    fs.utimesSync(file, second, second);
    fs.utimesSync(path.join(repo, ".git", "index"), second, second);
    const { contentTreeId } = await load("evidence.js");
    assert.notEqual(await contentTreeId(repo), git(repo, "rev-parse", "HEAD^{tree}").trim());
  });

  // ---------------------------------------------------------------------------
  // A7 — a measured failure is a failing exit, with the reason inline
  // ---------------------------------------------------------------------------

  test("A7: task event --run exits 3 on a measured failure and shows why inline", async (t) => {
    const f = await workspace(t);
    const out = await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", FAIL]);
    assert.equal(out.code, 3);
    assert.match(out.stdout, /unknown \(api: .*exit 1\)/);
    assert.match(out.stdout, /Re-run with --baseline/, "the diagnosis explanation is printed");
    assert.match(out.stdout, /\| boom: expected 1 got 2/, "the last output lines are printed");
    assert.match(out.stdout, /awo log tail --task TST-T1/);

    const kept = await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", FAIL, "--no-fail"]);
    assert.equal(kept.code, 0);
    assert.equal((await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"])).code, 0);
  });

  // ---------------------------------------------------------------------------
  // A8 — pipefail, and timeouts kill the whole process group
  // ---------------------------------------------------------------------------

  test("A8: a failing command piped through tee is measured as failing", async (t) => {
    const f = await workspace(t);
    const out = await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", `node -e "process.exit(4)" | cat`]);
    assert.equal(out.code, 3);
    assert.equal(lastTest(f).exitCode, 4);
  });

  test("A8: a timeout kills the command's children, not just its shell", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-lane-a-timeout-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // In its own process, so the other cases' synchronous git calls cannot delay
    // its timer. 0.05 min = 3 s. The background child records its pid and sleeps;
    // the foreground sleep holds the pipe for 60 s. Killing only the shell would
    // leave both running and the measurement waiting on the pipe.
    const evidence = pathToFileURL(path.join(ROOT, "dist", "evidence.js")).href;
    const script =
      `const { measure } = await import(${JSON.stringify(evidence)});` +
      `const m = await measure("sh -c 'echo $$ > child.pid; exec sleep 30' & sleep 60", process.cwd(), 0.05);` +
      `process.stdout.write(JSON.stringify({ timedOut: m.timedOut }));`;
    const started = Date.now();
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: dir });
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      child.on("close", () => resolve(text));
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(JSON.parse(out), { timedOut: true });
    assert.ok(elapsed < 30_000, `measurement returned after ${elapsed} ms`);
    const pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // A killed child can linger as a zombie for a moment before it is reaped.
    for (let i = 0; i < 30 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(), false, "the background child was killed with its group");
  });

  // ---------------------------------------------------------------------------
  // A9 — runner-specific counts
  // ---------------------------------------------------------------------------

  test("A9: vitest's Test Files line is never read as the case count", async (t) => {
    const f = await workspace(t, {
      files: {
        "src/pricing.ts": "export const rate = 0.1;\n",
        "vt.sh": "#!/bin/sh\nprintf ' Test Files  61 passed (61)\\n      Tests  527 passed (527)\\n   Duration  5.2s\\n'\n",
      },
    });
    fs.chmodSync(path.join(f.repos.api, "vt.sh"), 0o755);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "./vt.sh"]);
    const e = lastTest(f);
    assert.equal(e.passed, 527);
    assert.deepEqual(e.counts, { parser: "vitest", cases: 527, passed: 527, failed: 0, suites: 61 });
  });

  test("A9: jest, mocha, go, pytest and unknown output parse into cases and suites", async () => {
    const { parseCounts } = await load("evidence.js");
    assert.deepEqual(
      parseCounts("Test Suites: 1 failed, 60 passed, 61 total\nTests:       2 failed, 1 skipped, 525 passed, 528 total\n"),
      { parser: "jest", cases: 528, passed: 525, failed: 2, skipped: 1, suites: 61 }
    );
    assert.deepEqual(parseCounts("\n  527 passing (2s)\n  2 pending\n  1 failing\n"), {
      parser: "mocha", cases: 530, passed: 527, failed: 1, skipped: 2,
    });
    assert.deepEqual(
      parseCounts("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\texample.com/pkg\t0.010s\nok  \texample.com/other\t0.012s\n"),
      { parser: "go", cases: 2, passed: 1, failed: 1, suites: 2, skipped: undefined }
    );
    assert.deepEqual(parseCounts("===== 1 failed, 525 passed, 2 skipped in 5.20s =====\n"), {
      parser: "pytest", cases: 528, passed: 525, failed: 1, skipped: 2,
    });
    assert.deepEqual(parseCounts("ℹ tests 158\nℹ suites 3\nℹ pass 158\nℹ fail 0\n"), {
      parser: "node-test", cases: 158, passed: 158, failed: 0, skipped: undefined, suites: 3,
    });
    assert.deepEqual(parseCounts("built ok\n"), { parser: "unknown" });
  });

  // ---------------------------------------------------------------------------
  // A10 — only an existing test that loses assertions needs a human
  // ---------------------------------------------------------------------------

  test("A10: a new test file beside new code is ordinary TDD, not needs-human", async (t) => {
    const f = await workspace(t);
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.2;\n");
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(rate).toBe(0.2)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    const e = lastTest(f);
    assert.equal(e.diagnosis, "pass");
    assert.equal(e.needsHuman, false);
    assert.match(String(e.explanation), /Adds tests \(src\/pricing\.spec\.ts\)/);
    assert.equal((await awo(f.ws, ["task", "complete", "TST-T1"])).code, 0);
  });

  test("A10: an existing test that only gains assertions passes; one that loses an assertion needs a human", async (t) => {
    const f = await workspace(t, {
      files: { "src/pricing.ts": "export const rate = 0.1;\n", "src/pricing.spec.ts": "expect(rate).toBe(0.1)\n" },
    });
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.1;\nexport const cap = 5;\n");
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(rate).toBe(0.1)\nexpect(cap).toBe(5)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    assert.equal(lastTest(f).diagnosis, "pass");
    assert.equal(lastTest(f).needsHuman, false);

    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(cap).toBe(5)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    assert.equal(lastTest(f).diagnosis, "test-and-code-changed");
    assert.equal(lastTest(f).needsHuman, true);
  });

  test("A10: in a QA-required goal the hint is recorded but does not escalate", async (t) => {
    const f = await workspace(t, {
      qaRequired: true,
      files: { "src/pricing.ts": "export const rate = 0.1;\n", "src/pricing.spec.ts": "expect(rate).toBe(0.1)\n" },
    });
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.ts"), "export const rate = 0.3;\n");
    fs.writeFileSync(path.join(f.repos.api, "src/pricing.spec.ts"), "expect(rate).toBe(0.3)\n");
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "true"]);
    const e = lastTest(f);
    assert.equal(e.diagnosis, "test-and-code-changed");
    assert.equal(e.needsHuman, false);
    assert.match(String(e.explanation), /goal's QA review/);
  });

  // ---------------------------------------------------------------------------
  // A11 — secrets never reach the log
  // ---------------------------------------------------------------------------

  test("A11: secrets are redacted from every appended event and record", async (t) => {
    const f = await workspace(t);
    await awo(f.ws, ["task", "event", "TST-T1", "note", "--message", "connect with DB_PASSWORD=hunter2"]);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "API_TOKEN=s3cr3tvalue node -e 0"]);
    await awo(f.ws, ["task", "complete", "TST-T1", "--summary", "used mysql -uroot -phunter2 locally"]);
    const day = path.join(f.ws, "logs", f.runId().slice(0, 10));
    const text = fs.readFileSync(path.join(day, "runs.jsonl"), "utf8") + fs.readFileSync(path.join(day, "runs.md"), "utf8");
    assert.ok(!text.includes("hunter2"), "password leaked into the log");
    assert.ok(!text.includes("s3cr3tvalue"), "token leaked into the log");
    assert.match(text, /DB_PASSWORD=\*\*\*/);
    const artifact = String(lastTest(f).artifact);
    assert.ok(!fs.readFileSync(path.join(f.ws, artifact), "utf8").includes("s3cr3tvalue"));
  });

  // ---------------------------------------------------------------------------
  // A12 — a command that cannot run, or cannot fail, is not evidence
  // ---------------------------------------------------------------------------

  test("A12: exit 127 at HEAD and at the base is not-runnable, and completion says so", async (t) => {
    const f = await workspace(t);
    const out = await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", "definitely-not-a-command-xyz", "--baseline"]);
    assert.equal(out.code, 3);
    assert.equal(lastTest(f).diagnosis, "not-runnable");
    assert.equal(lastTest(f).baselineExitCode, 127);
    const refused = await awo(f.ws, ["task", "complete", "TST-T1", "--unchanged", "x"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /could not run, which is not evidence/);
  });

  test("A12: a command that cannot fail is refused before it runs", async (t) => {
    const f = await workspace(t);
    for (const run of ["npm test || true", "npm test; true", "npm test || :"]) {
      const out = await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", run]);
      assert.equal(out.code, 1, run);
      assert.match(out.stderr, /Refusing to measure/);
    }
    assert.ok(!f.events().some((e) => e.kind === "test"));
  });

  // ---------------------------------------------------------------------------
  // A13 — a bare test event runs the declared command
  // ---------------------------------------------------------------------------

  test("A13: `task event <id> test` runs the repo's declared testCommand, and says how to declare one", async (t) => {
    const f = await workspace(t);
    const missing = await awo(f.ws, ["task", "event", "TST-T1", "test", "--label", "suite green"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /awo test-command api "<cmd>"/);
    assert.ok(!f.events().some((e) => e.kind === "test"), "a claim is not recorded");

    assert.equal((await awo(f.ws, ["test-command", "api", "node -e 0"])).code, 0);
    const ran = await awo(f.ws, ["task", "event", "TST-T1", "test"]);
    assert.equal(ran.code, 0, ran.stderr);
    const e = lastTest(f);
    assert.equal(e.verified, true);
    assert.equal(e.command, "node -e 0");
    assert.equal(e.label, undefined);
  });

  // ---------------------------------------------------------------------------
  // A14 — the stored tail is small; the artifact keeps more
  // ---------------------------------------------------------------------------

  test("A14: the event tail is capped near 2 KB while the artifact keeps the longer tail", async (t) => {
    const f = await workspace(t);
    await awo(f.ws, ["task", "event", "TST-T1", "test", "--run", `node -e "for (let i = 0; i < 400; i++) console.log('line ' + i + ' ' + 'x'.repeat(30)); process.exit(1)"`]);
    const e = lastTest(f);
    assert.ok(String(e.tail).length <= 2100, `event tail is ${String(e.tail).length} chars`);
    assert.match(String(e.tail), /line 399/);
    const artifact = JSON.parse(fs.readFileSync(path.join(f.ws, String(e.artifact)), "utf8"));
    assert.ok(artifact.candidate.tail.length > 4000);
  });

  // ---------------------------------------------------------------------------
  // A15 — the spellings agents reach for
  // ---------------------------------------------------------------------------

  test("A15: message aliases, --sha, and kind validation with a suggestion", async (t) => {
    const f = await workspace(t);
    for (const flag of ["--msg", "--note", "--text", "-m"]) {
      const out = await awo(f.ws, ["task", "event", "TST-T1", "note", flag, `via ${flag}`]);
      assert.equal(out.code, 0, `${flag}: ${out.stderr}`);
    }
    assert.deepEqual(
      f.events().filter((e) => e.kind === "note").map((e) => e.msg),
      ["via --msg", "via --note", "via --text", "via -m"]
    );
    assert.equal((await awo(f.ws, ["task", "event", "TST-T1", "commit", "--sha", "abc1234", "--label", "feat: x"])).code, 0);
    assert.equal(f.events().find((e) => e.kind === "commit")!.sha, "abc1234");

    const typo = await awo(f.ws, ["task", "event", "TST-T1", "tests", "--run", "true"]);
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /Unknown event kind "tests"\. Did you mean "test"\?/);
    assert.match((await awo(f.ws, ["task", "event", "TST-T1", "diff"])).stderr, /Did you mean "repo\.diff"/);
    assert.match((await awo(f.ws, ["task", "event", "TST-T1", "run.end"])).stderr, /written by awo itself/);
  });

  // ---------------------------------------------------------------------------
  // A16 — the model that actually ran
  // ---------------------------------------------------------------------------

  test("A16: task complete --model records the model that actually did the work", async (t) => {
    const f = await workspace(t);
    const out = await awo(f.ws, ["task", "complete", "TST-T1", "--untested", "n/a", "--model", "codex:gpt-5"]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(f.events().find((e) => e.kind === "run.end")!.actualModel, "codex:gpt-5");
    const row = f.rows().at(-1)!;
    assert.equal(row.actualModel, "codex:gpt-5");
    assert.ok(typeof row.model === "string" && row.model !== "codex:gpt-5", "the resolved model is kept beside it");
  });

  // ---------------------------------------------------------------------------
  // A17 — a torn or damaged day file does not take the readers down
  // ---------------------------------------------------------------------------

  test("A17: day-file readers skip a torn final line silently and warn once on damage", async (t) => {
    const f = await workspace(t);
    const file = path.join(f.ws, "logs", f.runId().slice(0, 10), "runs.jsonl");
    const read = (): { status: number | null; stderr: string; count: string } => {
      const r = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "dist", "runs.js")).href)});` +
            `const e = await m.readEvents(${JSON.stringify(f.ws)}, ${JSON.stringify(f.runId())});` +
            `await m.readEvents(${JSON.stringify(f.ws)}, ${JSON.stringify(f.runId())});` +
            `process.stdout.write(String(e.length));`,
        ],
        { encoding: "utf8" }
      );
      return { status: r.status, stderr: r.stderr, count: r.stdout };
    };
    const before = Number(read().count);
    assert.ok(before > 0);

    fs.appendFileSync(file, `{"type":"event","runId":"${f.runId()}","kind":"no`);
    const torn = read();
    assert.equal(torn.status, 0, torn.stderr);
    assert.equal(Number(torn.count), before);
    assert.equal(torn.stderr, "", "a writer caught mid-append is not damage");

    // The next append must not fuse onto the fragment; the fragment is now damage.
    const { appendEvent } = await load("runs.js");
    await appendEvent(f.ws, f.runId(), "note", { label: "after the tear" });
    const damaged = read();
    assert.equal(damaged.status, 0, damaged.stderr);
    assert.equal(Number(damaged.count), before + 1);
    assert.equal(damaged.stderr.match(/malformed/g)?.length, 1, "warned once, not per read");
  });
});
