import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

interface RunResult { code: number; stdout: string; stderr: string; }

function awo(cwd: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/**
 * A scripted `gh` on PATH — the same mechanism as pr.integration.test.ts, written in
 * Node so a scenario file can describe several repos, PR states, paged review threads
 * and per-account tokens. Every call is logged with the GH_TOKEN it received, so
 * tests can assert which identity each call ran as. The real GitHub API is never hit.
 */
const FAKE_GH = String.raw`
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const file = process.env.FAKE_GH_SCENARIO;
const sc = JSON.parse(fs.readFileSync(file, "utf8"));
const repo = path.basename(process.cwd());
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, repo, token: process.env.GH_TOKEN || null }) + "\n");
function out(v) { process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n"); process.exit(0); }
function fail(msg, code) { process.stderr.write(msg + "\n"); process.exit(code || 1); }
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function login() {
  if (process.env.GH_TOKEN) {
    const hit = Object.entries(sc.tokens || {}).find(([, t]) => t === process.env.GH_TOKEN);
    return hit ? hit[0] : null;
  }
  return sc.active || "dev-account";
}
const [a, b] = args;
if (a === "auth" && b === "status") out("Logged in");
if (a === "auth" && b === "token") {
  // Like gh, an environment token wins over the stored one.
  if (process.env.GH_TOKEN) out(process.env.GH_TOKEN);
  const t = (sc.tokens || {})[flag("--user")];
  if (t) out(t);
  fail("no oauth token found for " + flag("--user"));
}
if (a === "api" && b === "user") { const l = login(); if (l) out(l); fail("HTTP 401: Bad credentials"); }
if (a === "repo" && b === "view") out({ nameWithOwner: "acme/" + repo, viewerPermission: "MAINTAIN", defaultBranchRef: { name: "main" } });
if (a === "label" && b === "list") out(sc.labels || []);
if (a === "pr" && b === "edit") out("");
if (a === "pr" && b === "list") out((sc.lists || {})[repo + ":" + flag("--head")] || []);
if (a === "pr" && b === "view") {
  const n = args[2];
  if (flag("--json") === "title,body") out({ title: "implements the task", body: "" });
  const pr = (sc.prs || {})[repo + "#" + n];
  if (!pr) fail("no pull requests found for " + repo + "#" + n);
  out(Object.assign({
    number: Number(n), url: "https://github.example/acme/" + repo + "/pull/" + n,
    headRefName: "feature/x", headRefOid: "sha-" + n, isDraft: false, mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    state: "OPEN", mergedAt: null, mergeCommit: null,
  }, pr));
}
if (a === "api" && b === "graphql") {
  const number = (args.find((x) => x.startsWith("number=")) || "").slice(7);
  const cursor = (args.find((x) => x.startsWith("cursor=")) || "").slice(7);
  const pages = (sc.threads || {})[repo + "#" + number] || [[]];
  const idx = cursor ? Number(cursor.replace("page-", "")) : 0;
  const more = idx + 1 < pages.length;
  out({ data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: more, endCursor: more ? "page-" + (idx + 1) : null }, nodes: pages[idx] || [],
  } } } } });
}
if (a === "api" && args.includes("PUT")) {
  const n = /pulls\/(\d+)\/merge/.exec(args.join(" "))[1];
  const key = repo + "#" + n;
  sc.prs[key] = Object.assign({}, sc.prs[key], { state: "MERGED", mergedAt: "2026-11-22T00:00:00Z", mergeCommit: { oid: "merge-" + n } });
  fs.writeFileSync(file, JSON.stringify(sc));
  out("{}");
}
fail("unexpected gh invocation: " + args.join(" "), 2);
`;

interface GhCall { args: string[]; repo: string; token: string | null; }

interface Scenario {
  active?: string;
  tokens?: Record<string, string>;
  labels?: Array<{ name: string }>;
  prs: Record<string, Record<string, unknown>>;
  lists?: Record<string, Array<{ number: number; state: string }>>;
  threads?: Record<string, unknown[][]>;
}

interface FakeGh {
  env: NodeJS.ProcessEnv;
  calls: () => GhCall[];
  update: (change: (s: Scenario) => void) => void;
  cleanup: () => void;
}

function fakeGh(initial: Scenario): FakeGh {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "awo-d2-gh-"));
  const script = path.join(bin, "fake-gh.cjs");
  const scenario = path.join(bin, "scenario.json");
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(script, FAKE_GH);
  fs.writeFileSync(scenario, JSON.stringify(initial));
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GH_LOG: log,
      FAKE_GH_SCENARIO: scenario,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
    calls: () =>
      fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GhCall),
    update: (change) => {
      const s = JSON.parse(fs.readFileSync(scenario, "utf8")) as Scenario;
      change(s);
      fs.writeFileSync(scenario, JSON.stringify(s));
    },
    cleanup: () => fs.rmSync(bin, { recursive: true, force: true }),
  };
}

interface Workspace { ws: string; cleanup: () => void; }

/** The fake gh names a repo by its checkout's real directory, so each lives at <tmp>/<name>. */
function makeWorkspace(repos: string[] = ["api"]): Workspace {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "awo-d2-"));
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), "awo-d2-repos-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TEST"], { cwd: ws });
  for (const name of repos) {
    const dir = path.join(holder, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
    execFileSync(process.execPath, [CLI, "connect", dir, "--name", name], { cwd: ws });
  }
  return {
    ws,
    cleanup: () => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(holder, { recursive: true, force: true });
    },
  };
}

function writeGoal(ws: string, dir: string, id: string, extra = ""): string {
  const goal = path.join(ws, "goals", dir);
  fs.mkdirSync(path.join(goal, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goal, "goal.md"), `---\nid: ${id}\ntitle: ${id} goal\nstatus: planning\n${extra}---\n\n## Objective\nDemo.\n`);
  return goal;
}

function writeTask(goal: string, id: string, goalId: string, targets: string[]): void {
  fs.writeFileSync(
    path.join(goal, "tasks", `${id}-work.md`),
    `---\nid: ${id}\ngoalId: ${goalId}\nname: Work ${id}\ntargets: [${targets.join(", ")}]\ndependsOn: []\nstatus: todo\n---\n\n## Objective\nDo ${id}.\n`
  );
}

function taskState(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status, lastRunOutcome: null, lastRunId: null, startedAt: null, finishedAt: null,
    attempts: 0, worktree: null, blockedReason: null, ...extra,
  };
}

interface StoredPr {
  repo: string;
  number: number;
  state?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommit?: string | null;
  feedback: Record<string, { taskId: string | null; resolved: boolean; url: string | null }>;
}

interface StoredTask {
  status: string;
  pullRequest?: StoredPr;
  pullRequests?: Record<string, StoredPr>;
  transitions?: Array<{ from: string; to: string; actor: string; reason: string | null }>;
}

function readGoalState(goal: string): { tasks: Record<string, StoredTask> } {
  return JSON.parse(fs.readFileSync(path.join(goal, "state.json"), "utf8"));
}

function writeGoalState(goal: string, goalId: string, tasks: Record<string, Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(goal, "state.json"),
    JSON.stringify({ rev: 1, goalId, goalStatus: "planning", updatedAt: "", tasks }, null, 2)
  );
}

function setStatus(goal: string, taskId: string, status: string): void {
  const file = path.join(goal, "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.tasks[taskId].status = status;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function editManifest(ws: string, change: (m: Record<string, any>) => void): void {
  const file = path.join(ws, ".workspace", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  change(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function thread(id: string, login: string, body: string, extra: Record<string, unknown> = {}): unknown {
  const { typename, ...rest } = extra as { typename?: string };
  return {
    id, isResolved: false, isOutdated: false,
    comments: { nodes: [{ body, url: `https://github.example/comment/${id}`, author: { login, __typename: typename ?? "User" } }] },
    ...rest,
  };
}

const merged = (n: number) => ({ state: "MERGED", mergedAt: "2026-11-20T10:00:00Z", mergeCommit: { oid: `m${n}` } });

function viewCalls(gh: FakeGh, repo: string, number: number): number {
  return gh.calls().filter((c) => c.repo === repo && c.args[0] === "pr" && c.args[1] === "view" && c.args[2] === String(number) && c.args.includes("--json") && !c.args.includes("title,body")).length;
}

test("a merged PR moves an in-review task to done — unless the goal is governed or the task is not in review", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({ prs: { "api#42": {}, "api#43": {}, "api#44": {} } });
  try {
    const g1 = writeGoal(ws, "TEST-G1-light", "TEST-G1");
    const g2 = writeGoal(ws, "TEST-G2-governed", "TEST-G2", "completionPolicy:\n  qaRequired: true\n");
    writeTask(g1, "TEST-T1", "TEST-G1", ["api"]);
    writeTask(g2, "TEST-T2", "TEST-G2", ["api"]);
    writeTask(g1, "TEST-T3", "TEST-G1", ["api"]);
    writeGoalState(g1, "TEST-G1", { "TEST-T1": taskState("in-review"), "TEST-T3": taskState("running") });
    writeGoalState(g2, "TEST-G2", { "TEST-T2": taskState("in-review") });

    for (const [task, n] of [["TEST-T1", "42"], ["TEST-T2", "43"], ["TEST-T3", "44"]]) {
      const linked = awo(ws, ["pr", "link", task, "--number", n, "--no-meta"], gh.env);
      assert.equal(linked.code, 0, linked.stderr);
    }
    assert.equal(readGoalState(g1).tasks["TEST-T1"].status, "in-review", "an open PR moves nothing");

    gh.update((s) => {
      Object.assign(s.prs["api#42"], merged(42));
      Object.assign(s.prs["api#43"], merged(43));
      Object.assign(s.prs["api#44"], merged(44));
    });

    const light = awo(ws, ["pr", "status", "TEST-T1"], gh.env);
    assert.equal(light.code, 0, light.stderr);
    assert.match(light.stdout, /api#42\tMERGED\tchecks=passing/);
    assert.match(light.stdout, /PR #42 merged — TEST-T1 moved in-review -> done/);
    const t1 = readGoalState(g1).tasks["TEST-T1"];
    assert.equal(t1.status, "done");
    assert.deepEqual(
      { state: t1.pullRequest?.state, merged: t1.pullRequest?.merged, mergedAt: t1.pullRequest?.mergedAt, mergeCommit: t1.pullRequest?.mergeCommit },
      { state: "MERGED", merged: true, mergedAt: "2026-11-20T10:00:00Z", mergeCommit: "m42" }
    );
    const last = t1.transitions?.at(-1);
    assert.deepEqual(
      { from: last?.from, to: last?.to, actor: last?.actor, reason: last?.reason },
      { from: "in-review", to: "done", actor: "qa", reason: "PR #42 merged" }
    );

    const governed = awo(ws, ["pr", "status", "TEST-T2"], gh.env);
    assert.equal(governed.code, 0, governed.stderr);
    assert.match(governed.stdout, /TEST-G2 is governed, so TEST-T2 stays in review until `awo goal verdict TEST-G2`/);
    const t2 = readGoalState(g2).tasks["TEST-T2"];
    assert.equal(t2.status, "in-review", "a governed goal finishes on its verdict, not on a merge");
    assert.equal(t2.pullRequest?.merged, true, "the snapshot still records the merge for every view");

    const running = awo(ws, ["pr", "status", "TEST-T3"], gh.env);
    assert.equal(running.code, 0, running.stderr);
    assert.match(running.stdout, /TEST-T3 is running, so it was not moved — finish the run first: awo task complete TEST-T3/);
    assert.equal(readGoalState(g1).tasks["TEST-T3"].status, "running");
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("pr status --all refreshes every linked PR in live goals, skips archived goals, and reuses merged snapshots", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({ prs: { "api#42": {}, "api#43": merged(43), "api#99": {} } });
  try {
    const live = writeGoal(ws, "TEST-G1-live", "TEST-G1");
    writeTask(live, "TEST-T1", "TEST-G1", ["api"]);
    writeTask(live, "TEST-T2", "TEST-G1", ["api"]);
    writeTask(live, "TEST-T3", "TEST-G1", ["api"]);
    const old = path.join(ws, "goals", "archive", "TEST-G9-old");
    fs.mkdirSync(path.join(old, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(old, "goal.md"), "---\nid: TEST-G9\ntitle: Old\nstatus: planning\n---\n");
    writeTask(old, "TEST-T9", "TEST-G9", ["api"]);
    // Pre-0.8 state: a single `pullRequest` slot and no snapshot state fields.
    const legacy = (n: number) => ({
      repo: "api", number: n, url: `https://github.example/acme/api/pull/${n}`, branch: "feature/x",
      headSha: `sha-${n}`, isDraft: false, mergeState: "CLEAN", checks: "passing", reviews: "approved",
      lastCheckedAt: "2026-11-01T00:00:00Z", feedback: {},
    });
    writeGoalState(live, "TEST-G1", {
      "TEST-T1": taskState("in-review", { pullRequest: legacy(42) }),
      "TEST-T2": taskState("in-review", { pullRequest: legacy(43) }),
      "TEST-T3": taskState("todo"),
    });
    writeGoalState(old, "TEST-G9", { "TEST-T9": taskState("in-review", { pullRequest: legacy(99) }) });

    const neither = awo(ws, ["pr", "status"], gh.env);
    assert.equal(neither.code, 1);
    assert.match(neither.stderr, /awo pr status --all/);

    const all = awo(ws, ["pr", "status", "--all"], gh.env);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^TASK\s+PR\s+STATE\s+CHECKS\s+REVIEWS\s+MERGE\s+NOTE$/m);
    assert.match(all.stdout, /^TEST-T1\s+api#42\s+OPEN\s+passing\s+approved\s+CLEAN$/m);
    assert.match(all.stdout, /^TEST-T2\s+api#43\s+MERGED\s+.*TEST-T2 moved in-review -> done$/m);
    assert.doesNotMatch(all.stdout, /TEST-T9|TEST-T3/, "archived goals and unlinked tasks are not listed");
    assert.match(all.stdout, /2 PR\(s\) across 2 task\(s\); 1 moved to done/);
    assert.equal(viewCalls(gh, "api", 99), 0, "an archived goal's PR is never fetched");

    const t2 = readGoalState(live).tasks["TEST-T2"];
    assert.equal(t2.status, "done");
    assert.equal(t2.pullRequests?.api?.merged, true, "legacy state gains the per-repo map");

    const again = awo(ws, ["pr", "status", "--all"], gh.env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(viewCalls(gh, "api", 43), 1, "a merged snapshot is terminal; --all does not re-fetch it");
    assert.equal(viewCalls(gh, "api", 42), 2);
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("a multi-repo task keeps one PR per repo, --repo selects one, and done waits for every merge", () => {
  const { ws, cleanup } = makeWorkspace(["api", "web"]);
  const gh = fakeGh({ prs: { "api#42": {}, "web#7": {} } });
  try {
    const goal = writeGoal(ws, "TEST-G1-both", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api", "web"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("in-review") });

    const ambiguous = awo(ws, ["pr", "link", "TEST-T1", "--number", "42"], gh.env);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /TEST-T1 targets api, web; say which repo the PR is in/);
    assert.match(ambiguous.stderr, /awo pr link TEST-T1 --repo <api\|web>/);

    assert.equal(awo(ws, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42", "--no-meta"], gh.env).code, 0);
    assert.equal(awo(ws, ["pr", "link", "TEST-T1", "--repo", "web", "--number", "7", "--no-meta"], gh.env).code, 0);
    const linked = readGoalState(goal).tasks["TEST-T1"];
    assert.deepEqual(Object.keys(linked.pullRequests ?? {}).sort(), ["api", "web"], "the second link must not overwrite the first");
    assert.equal(linked.pullRequest?.repo, "web", "pullRequest stays the most recently linked PR");

    const before = gh.calls().length;
    const one = awo(ws, ["pr", "status", "TEST-T1", "--repo", "api"], gh.env);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /api#42\tOPEN/);
    assert.doesNotMatch(one.stdout, /web#7/);
    assert.ok(gh.calls().slice(before).every((c) => c.repo === "api"), "--repo touches only that repo");

    const missing = awo(ws, ["pr", "finalize", "TEST-T1", "--repo", "docs"], gh.env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no PR linked in "docs" \(linked: api, web\)/);

    gh.update((s) => Object.assign(s.prs["api#42"], merged(42)));
    const half = awo(ws, ["pr", "status", "TEST-T1"], gh.env);
    assert.equal(half.code, 0, half.stderr);
    assert.match(half.stdout, /api#42\tMERGED/);
    assert.match(half.stdout, /web#7\tOPEN/);
    assert.match(half.stdout, /TEST-T1 still waits on web#7/);
    assert.equal(readGoalState(goal).tasks["TEST-T1"].status, "in-review");

    gh.update((s) => Object.assign(s.prs["web#7"], merged(7)));
    const both = awo(ws, ["pr", "status", "TEST-T1"], gh.env);
    assert.equal(both.code, 0, both.stderr);
    assert.match(both.stdout, /PR #42, PR #7 merged — TEST-T1 moved in-review -> done/);
    assert.equal(readGoalState(goal).tasks["TEST-T1"].status, "done");
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("pr link infers --repo and --number from the branch, and --goal links one PR to a whole goal", () => {
  const { ws, cleanup } = makeWorkspace(["api", "web"]);
  const gh = fakeGh({
    prs: { "api#42": {}, "api#51": {} },
    lists: {
      "api:feature/TEST-T1": [{ number: 42, state: "OPEN" }],
      "api:goal/checkout": [{ number: 50, state: "CLOSED" }, { number: 51, state: "OPEN" }],
    },
  });
  try {
    const perTask = writeGoal(ws, "TEST-G1-per-task", "TEST-G1");
    writeTask(perTask, "TEST-T1", "TEST-G1", ["api"]);
    writeTask(perTask, "TEST-T6", "TEST-G1", ["api"]);
    const branch = writeGoal(ws, "TEST-G2-goal-branch", "TEST-G2", "pullRequestStrategy: goal-branch\ndeliveryBranch: goal/checkout\n");
    writeTask(branch, "TEST-T2", "TEST-G2", ["api"]);
    writeTask(branch, "TEST-T3", "TEST-G2", ["api"]);
    writeTask(branch, "TEST-T4", "TEST-G2", ["web"]);
    writeTask(branch, "TEST-T5", "TEST-G2", ["api"]);
    writeGoalState(branch, "TEST-G2", { "TEST-T5": taskState("cancelled") });

    const inferred = awo(ws, ["pr", "link", "TEST-T1", "--no-meta"], gh.env);
    assert.equal(inferred.code, 0, inferred.stderr);
    assert.match(inferred.stdout, /found api#42 by head branch feature\/TEST-T1/);
    assert.match(inferred.stdout, /TEST-T1 -> api#42/);
    assert.ok(
      gh.calls().some((c) => c.args.join(" ") === "pr list --head feature/TEST-T1 --state all --json number,state"),
      "the PR is found by the task's head branch"
    );
    assert.equal(readGoalState(perTask).tasks["TEST-T1"].pullRequest?.state, "OPEN", "linking stores a refreshed snapshot");

    const none = awo(ws, ["pr", "link", "TEST-T6"], gh.env);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No PR in api has head branch "feature\/TEST-T6"/);
    assert.match(none.stderr, /awo pr link TEST-T6 --repo api --number <n>/);

    const goalTask = awo(ws, ["pr", "link", "TEST-T2", "--no-meta"], gh.env);
    assert.equal(goalTask.code, 0, goalTask.stderr);
    assert.match(goalTask.stdout, /found api#51 by head branch goal\/checkout/, "a goal-branch task's PR comes from the delivery branch");

    const unclear = awo(ws, ["pr", "link", "--goal", "TEST-G2"], gh.env);
    assert.equal(unclear.code, 1);
    assert.match(unclear.stderr, /TEST-G2's tasks target api, web/);

    const whole = awo(ws, ["pr", "link", "--goal", "TEST-G2", "--repo", "api"], gh.env);
    assert.equal(whole.code, 0, whole.stderr);
    assert.match(whole.stdout, /TEST-T2 -> api#51/);
    assert.match(whole.stdout, /TEST-T3 -> api#51/);
    assert.doesNotMatch(whole.stdout, /TEST-T4|TEST-T5/, "only live tasks that target the repo are linked");
    const state = readGoalState(branch);
    assert.equal(state.tasks["TEST-T3"].pullRequests?.api?.number, 51);
    assert.equal(state.tasks["TEST-T4"].pullRequest, undefined);
    assert.equal(state.tasks["TEST-T5"].pullRequest, undefined);
    assert.ok(gh.calls().some((c) => c.args[0] === "pr" && c.args[1] === "edit" && c.args[2] === "51"), "metadata is applied once for the goal PR");
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("pr finalize honours per-repo mergePolicy and requiredChecks: none, or a named list", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({
    prs: {
      "api#42": { statusCheckRollup: [] },
      "api#43": {
        mergeStateStatus: "UNSTABLE",
        statusCheckRollup: [
          { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { context: "ci/legacy", state: "SUCCESS" },
        ],
      },
    },
  });
  try {
    const goal = writeGoal(ws, "TEST-G1-demo", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api"]);
    writeTask(goal, "TEST-T2", "TEST-G1", ["api"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("in-review"), "TEST-T2": taskState("in-review") });
    awo(ws, ["pr", "link", "TEST-T1", "--number", "42", "--no-meta"], gh.env);
    awo(ws, ["pr", "link", "TEST-T2", "--number", "43", "--no-meta"], gh.env);
    // The workspace stays human-only; only this repo authorizes a maintainer merge.
    editManifest(ws, (m) => {
      m.pullRequests = { ...m.pullRequests, mergePolicy: "human-only" };
      m.repos[0].mergePolicy = "authorized-maintainer";
    });
    const merges = () => gh.calls().filter((c) => c.args.includes("PUT")).length;

    const strict = awo(ws, ["pr", "finalize", "TEST-T1"], gh.env);
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /blocked\tPR is not merge-ready: .*checks=unknown/, "undeclared keeps the strict rule");

    editManifest(ws, (m) => { m.repos[0].requiredChecks = "none"; });
    const noCi = awo(ws, ["pr", "finalize", "TEST-T1"], gh.env);
    assert.equal(noCi.code, 0, noCi.stderr + noCi.stdout);
    assert.match(noCi.stdout, /^merged\t/m);
    assert.match(noCi.stdout, /TEST-T1 moved in-review -> done/, "the merge is recorded at once");
    assert.ok(gh.calls().some((c) => c.args.join(" ") === "api --method PUT repos/acme/api/pulls/42/merge -f merge_method=squash -f sha=sha-42"));
    assert.equal(readGoalState(goal).tasks["TEST-T1"].status, "done");

    editManifest(ws, (m) => { m.repos[0].requiredChecks = ["lint"]; });
    const red = awo(ws, ["pr", "finalize", "TEST-T2"], gh.env);
    assert.equal(red.code, 1);
    assert.match(red.stdout, /required check\(s\) not passing: lint=failing/);

    editManifest(ws, (m) => { m.repos[0].requiredChecks = ["e2e"]; });
    const absent = awo(ws, ["pr", "finalize", "TEST-T2"], gh.env);
    assert.equal(absent.code, 1);
    assert.match(absent.stdout, /e2e=missing/);

    editManifest(ws, (m) => { m.repos[0].requiredChecks = ["test", "ci/legacy"]; });
    const before = merges();
    const listed = awo(ws, ["pr", "finalize", "TEST-T2"], gh.env);
    assert.equal(listed.code, 0, listed.stderr + listed.stdout);
    assert.match(listed.stdout, /^merged\t/m, "only the named checks gate; a red informational check does not");
    assert.equal(merges(), before + 1);
    assert.doesNotMatch(gh.calls().map((c) => c.args.join(" ")).join("\n"), /pr review|--auto|pr merge/, "never approves, never enables auto-merge");

    editManifest(ws, (m) => { m.repos[0].mergePolicy = "human-only"; m.repos[0].requiredChecks = "none"; });
    setStatus(goal, "TEST-T1", "in-review");
    gh.update((s) => { s.prs["api#44"] = { statusCheckRollup: [] }; });
    awo(ws, ["pr", "link", "TEST-T1", "--number", "44", "--no-meta"], gh.env);
    const human = awo(ws, ["pr", "finalize", "TEST-T1"], gh.env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /^ready-for-human\t/m, "a human-only repo never merges");
    assert.equal(merges(), before + 1);
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("pr finalize refuses unfinished work, and --dry-run reads GitHub but writes nothing", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({
    prs: { "api#42": {} },
    threads: { "api#42": [[thread("T-1", "reviewer-a", "Please cover the empty cart.")]] },
  });
  try {
    const goal = writeGoal(ws, "TEST-G1-demo", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("running") });
    awo(ws, ["pr", "link", "TEST-T1", "--number", "42", "--no-meta"], gh.env);
    editManifest(ws, (m) => { m.pullRequests = { ...m.pullRequests, mergePolicy: "authorized-maintainer" }; });

    const callsBefore = gh.calls().length;
    const unfinished = awo(ws, ["pr", "finalize", "TEST-T1"], gh.env);
    assert.equal(unfinished.code, 1);
    assert.match(unfinished.stderr, /TEST-T1 is running; pr finalize merges only work completed in awo/);
    assert.match(unfinished.stderr, /awo task complete TEST-T1 --outcome success/);
    assert.equal(gh.calls().length, callsBefore, "a refusal touches GitHub not at all");

    setStatus(goal, "TEST-T1", "in-review");
    const stateFile = path.join(goal, "state.json");
    const snapshot = fs.readFileSync(stateFile, "utf8");
    const tasks = fs.readdirSync(path.join(goal, "tasks")).sort();
    const goalMd = fs.readFileSync(path.join(goal, "goal.md"), "utf8");
    const mutating = () =>
      gh.calls().filter((c) => c.args.includes("PUT") || (c.args[0] === "pr" && c.args[1] === "edit")).length;

    const reviewDry = awo(ws, ["pr", "finalize", "TEST-T1", "--dry-run"], gh.env);
    assert.equal(reviewDry.code, 1, reviewDry.stderr);
    assert.match(reviewDry.stdout, /blocked\tdry run: 1 unresolved GitHub review thread\(s\) remain\. A real run would create one repair task for 1 untracked thread/);

    gh.update((s) => { s.threads = {}; });
    const cleanDry = awo(ws, ["pr", "finalize", "TEST-T1", "--dry-run"], gh.env);
    assert.equal(cleanDry.code, 0, cleanDry.stderr);
    assert.match(cleanDry.stdout, /^would-merge\tdry run: authorized-maintainer policy would immediately squash-merge api#42 at sha-42/m);

    gh.update((s) => Object.assign(s.prs["api#42"], merged(42)));
    const mergedDry = awo(ws, ["pr", "finalize", "TEST-T1", "--dry-run"], gh.env);
    assert.equal(mergedDry.code, 0, mergedDry.stderr);
    assert.match(mergedDry.stdout, /^already-merged\t.*would move TEST-T1 in-review -> done/m);

    assert.equal(fs.readFileSync(stateFile, "utf8"), snapshot, "a dry run must not write state");
    assert.deepEqual(fs.readdirSync(path.join(goal, "tasks")).sort(), tasks, "a dry run must not create tasks");
    assert.equal(fs.readFileSync(path.join(goal, "goal.md"), "utf8"), goalMd);
    assert.equal(mutating(), 0, "a dry run must not merge or edit the PR");
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("pr reconcile pages through every thread, skips bots and ignored authors, and files ONE repair task per pass", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({
    prs: { "api#42": {} },
    threads: {
      "api#42": [
        [
          thread("H-1", "reviewer-a", "Handle the empty cart.\nIt currently throws."),
          thread("B-1", "review-assistant", "Consider renaming this.", { typename: "Bot" }),
          thread("R-1", "reviewer-a", "Already fixed.", { isResolved: true }),
        ],
        [
          thread("H-2", "reviewer-b", "Add a boundary test for qty=0."),
          thread("B-2", "dependabot[bot]", "Bump a dependency."),
          thread("I-1", "lint-helper", "Style nit."),
          thread("O-1", "reviewer-b", "Old comment.", { isOutdated: true }),
        ],
      ],
    },
  });
  try {
    const goal = writeGoal(ws, "TEST-G1-demo", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("in-review") });
    awo(ws, ["pr", "link", "TEST-T1", "--number", "42", "--no-meta"], gh.env);
    editManifest(ws, (m) => { m.pullRequests = { ...m.pullRequests, ignoreAuthors: ["Lint-Helper"] }; });

    const first = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /api#42\t2 unresolved review thread\(s\)/, "threads past the first page count");
    assert.match(first.stdout, /skipped: 3 thread\(s\) by bots or pullRequests.ignoreAuthors/);
    assert.match(first.stdout, /^created: TEST-T2$/m);
    assert.ok(gh.calls().some((c) => c.args.includes("cursor=page-1")), "the second page is requested by cursor");

    const repair = fs.readdirSync(path.join(goal, "tasks")).filter((f) => f.startsWith("TEST-T2"));
    assert.equal(repair.length, 1, "one aggregated task, not one per thread");
    const body = fs.readFileSync(path.join(goal, "tasks", repair[0]), "utf8");
    assert.match(body, /- \[ \] https:\/\/github\.example\/comment\/H-1 — Handle the empty cart\.\n/);
    assert.match(body, /- \[ \] https:\/\/github\.example\/comment\/H-2 — Add a boundary test for qty=0\./);
    assert.doesNotMatch(body, /B-1|B-2|I-1|R-1|O-1|It currently throws/);
    assert.equal(fs.readdirSync(path.join(goal, "tasks")).length, 2);
    const feedback = readGoalState(goal).tasks["TEST-T1"].pullRequests?.api?.feedback ?? {};
    assert.deepEqual(Object.keys(feedback).sort(), ["H-1", "H-2"]);
    assert.ok(Object.values(feedback).every((f) => f.taskId === "TEST-T2"));

    const repeat = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.doesNotMatch(repeat.stdout, /created:/);

    gh.update((s) => {
      (s.threads!["api#42"][1] as unknown[]).push(thread("H-3", "reviewer-a", "One more: log the failure."));
    });
    const next = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /^created: TEST-T3$/m);
    const third = fs.readdirSync(path.join(goal, "tasks")).find((f) => f.startsWith("TEST-T3"))!;
    const thirdBody = fs.readFileSync(path.join(goal, "tasks", third), "utf8");
    assert.match(thirdBody, /comment\/H-3/);
    assert.doesNotMatch(thirdBody, /comment\/H-1|comment\/H-2/, "a later pass lists only the new threads");
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("a crash between recording review threads and filing the repair task never duplicates it", () => {
  const { ws, cleanup } = makeWorkspace();
  const gh = fakeGh({
    prs: { "api#42": {} },
    threads: { "api#42": [[thread("H-1", "reviewer-a", "Handle the empty cart."), thread("H-2", "reviewer-b", "Add a test.")]] },
  });
  try {
    const goal = writeGoal(ws, "TEST-G1-demo", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("in-review") });
    awo(ws, ["pr", "link", "TEST-T1", "--number", "42", "--no-meta"], gh.env);
    const goalMd = path.join(goal, "goal.md");
    const repairTasks = () => fs.readdirSync(path.join(goal, "tasks")).filter((f) => !f.startsWith("TEST-T1"));

    if (process.getuid?.() !== 0) {
      // Task creation fails part-way (goal.md cannot be updated, so it rolls back).
      fs.chmodSync(goalMd, 0o444);
      const failed = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
      fs.chmodSync(goalMd, 0o644);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /Could not create the repair task/);
      assert.match(failed.stderr, /awo pr reconcile TEST-T1 --repo api/);
      assert.equal(repairTasks().length, 0);
      const recorded = readGoalState(goal).tasks["TEST-T1"].pullRequests?.api?.feedback ?? {};
      assert.deepEqual(Object.keys(recorded).sort(), ["H-1", "H-2"], "threads are persisted BEFORE the task is created");
      assert.ok(Object.values(recorded).every((f) => f.taskId === null));
    }

    const retry = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
    assert.equal(retry.code, 0, retry.stderr);
    assert.match(retry.stdout, /^created: TEST-T2$/m);
    assert.equal(repairTasks().length, 1);

    // A crash AFTER the task file was written but before its id was recorded.
    const file = path.join(goal, "state.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const copy of [state.tasks["TEST-T1"].pullRequest, state.tasks["TEST-T1"].pullRequests.api]) {
      for (const f of Object.values(copy.feedback) as Array<{ taskId: string | null }>) f.taskId = null;
    }
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    const adopt = awo(ws, ["pr", "reconcile", "TEST-T1"], gh.env);
    assert.equal(adopt.code, 0, adopt.stderr);
    assert.doesNotMatch(adopt.stdout, /created:/);
    assert.match(adopt.stdout, /linked existing repair task: TEST-T2/);
    assert.equal(repairTasks().length, 1, "the marker finds the task an interrupted pass created");
    const after = readGoalState(goal).tasks["TEST-T1"];
    assert.ok(Object.values(after.pullRequests?.api?.feedback ?? {}).every((f) => f.taskId === "TEST-T2"));
    assert.ok(Object.values(after.pullRequest?.feedback ?? {}).every((f) => f.taskId === "TEST-T2"));
  } finally {
    gh.cleanup();
    cleanup();
  }
});

test("a repo's githubAccount is reached through its stored gh token, passed only as GH_TOKEN and never printed", () => {
  const { ws, cleanup } = makeWorkspace();
  const workToken = "gho_FAKE_work_token_0123456789";
  const gh = fakeGh({
    active: "personal-account",
    tokens: { "personal-account": "gho_FAKE_personal_env_token", "work-account": workToken },
    labels: [{ name: "shop" }],
    prs: { "api#42": {} },
  });
  try {
    const goal = writeGoal(ws, "TEST-G1-demo", "TEST-G1");
    writeTask(goal, "TEST-T1", "TEST-G1", ["api"]);
    writeGoalState(goal, "TEST-G1", { "TEST-T1": taskState("in-review") });
    editManifest(ws, (m) => { m.repos[0].githubAccount = "work-account"; });
    // An inherited token for the other account must not leak into the lookup.
    const env = { ...gh.env, GH_TOKEN: "gho_FAKE_personal_env_token" };

    const linked = awo(ws, ["pr", "link", "TEST-T1", "--number", "42"], env);
    assert.equal(linked.code, 0, linked.stderr);
    assert.match(linked.stdout, /TEST-T1 -> api#42/);
    assert.match(linked.stdout, /assignee: work-account/, "the PR is assigned as the repo's account");
    const status = awo(ws, ["pr", "status", "TEST-T1"], env);
    assert.equal(status.code, 0, status.stderr);
    const pre = awo(ws, ["pr", "preflight"], env);
    assert.equal(pre.code, 0, pre.stderr);
    assert.match(pre.stdout, /account work-account via its stored gh token \(active account: personal-account\)/);

    const calls = gh.calls();
    assert.ok(calls.some((c) => c.args.join(" ") === "auth token --user work-account" && c.token === null), "the lookup runs without the inherited token");
    const acting = calls.filter((c) => (c.args[0] === "pr" || c.args[0] === "label") && c.repo === "api");
    assert.ok(acting.length >= 4);
    assert.ok(acting.every((c) => c.token === workToken), "every PR call runs as the declared account");
    for (const out of [linked, status, pre]) {
      assert.ok(!`${out.stdout}${out.stderr}`.includes(workToken), "the token is never printed");
    }
    assert.ok(!fs.readFileSync(path.join(goal, "state.json"), "utf8").includes(workToken), "nor stored");

    gh.update((s) => { delete s.tokens!["work-account"]; });
    const before = gh.calls().length;
    const refused = awo(ws, ["pr", "status", "TEST-T1"], { ...gh.env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /api must be acted on as "work-account", but gh is active as "personal-account"/);
    assert.match(refused.stderr, /Log in once as work-account: {2}gh auth login/);
    assert.ok(
      gh.calls().slice(before).every((c) => c.args[0] !== "pr"),
      "without the account's token, no PR call is made as anyone else"
    );
  } finally {
    gh.cleanup();
    cleanup();
  }
});
