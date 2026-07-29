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
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function makeWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "awo-pr-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "TEST"], { cwd: workspace });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-pr-repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: workspace });

  const goal = path.join(workspace, "goals", "TEST-G1-demo");
  fs.mkdirSync(path.join(goal, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(goal, "goal.md"),
    "---\nid: TEST-G1\ntitle: Demo goal\nstatus: planning\n---\n\n## Objective\nDemo.\n"
  );
  fs.writeFileSync(
    path.join(goal, "requirement.md"),
    "---\nid: TEST-R1\ntitle: Demo requirement\nstatus: approved\n---\n\n## Draft acceptance criteria\n- Given a valid request, when it is processed, then the response succeeds.\n"
  );
  fs.writeFileSync(
    path.join(goal, "tasks", "TEST-T1-implement.md"),
    "---\nid: TEST-T1\ngoalId: TEST-G1\nname: Implement feature\ntargets: [api]\ndependsOn: []\nstatus: todo\n---\n\n## Objective\nImplement feature.\n"
  );
  return workspace;
}

function fakeGithub(): { env: NodeJS.ProcessEnv; log: string; cleanup: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "awo-fake-gh-"));
  const log = path.join(bin, "calls.log");
  const pr = JSON.stringify({
    number: 42,
    url: "https://github.example/acme/api/pull/42",
    headRefName: "awo/TEST-T1",
    headRefOid: "abc123",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  });
  const failingPr = JSON.stringify({
    number: 42,
    url: "https://github.example/acme/api/pull/42",
    headRefName: "awo/TEST-T1",
    headRefOid: "abc123",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const threads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: "thread-1", isResolved: false, isOutdated: false, comments: { nodes: [
      { body: "Please add a boundary test.", url: "https://github.example/comment/1", author: { login: "reviewer" } },
    ] } },
  ] } } } } });
  const resolvedThreads = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  const script = `#!/bin/sh
echo "$@" >> "$GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  case "$*" in
    *nameWithOwner*) echo '{"nameWithOwner":"acme/api","viewerPermission":"MAINTAIN","defaultBranchRef":{"name":"main"}}' ;;
    *) echo '{"viewerPermission":"MAINTAIN","defaultBranchRef":{"name":"main"}}' ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *title,body*)
      if [ "$GH_PR_UNTITLED" = "1" ]; then
        echo '{"title":"some change","body":"no task reference"}'
      else
        echo '{"title":"TEST-T1 implement feature","body":"closes TEST-T1"}'
      fi
      exit 0 ;;
  esac
  if [ "$GH_UNREADY" = "1" ]; then echo '${failingPr}'; else echo '${pr}'; fi
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  echo '[{"name":"shop"},{"name":"performance"},{"name":"ALMO-263"}]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "supanut9"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if [ "$GH_NO_THREADS" = "1" ]; then echo '${resolvedThreads}'; else echo '${threads}'; fi
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "PUT" ]; then echo merged; exit 0; fi
echo "unexpected gh invocation: $@" >&2
exit 2
`;
  const executable = path.join(bin, "gh");
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, GH_LOG: log },
    log,
    cleanup: () => fs.rmSync(bin, { recursive: true, force: true }),
  };
}

test("PR control layer links live GitHub state, traces criteria, repairs reviews, and honors merge policy", () => {
  const workspace = makeWorkspace();
  const github = fakeGithub();
  try {
    const preflight = awo(workspace, ["pr", "preflight", "--repo", "api"], github.env);
    assert.equal(preflight.code, 0, preflight.stderr);
    assert.match(preflight.stdout, /api\tauthenticated\tpermission=MAINTAIN\tdefault=main/);

    const linked = awo(workspace, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42"], github.env);
    assert.equal(linked.code, 0, linked.stderr);
    assert.match(linked.stdout, /TEST-T1 -> api#42/);

    const status = awo(workspace, ["pr", "status", "TEST-T1"], github.env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /checks=passing\treviews=approved\tmerge=CLEAN/);

    const evidence = awo(workspace, ["task", "evidence", "TEST-T1", "--criterion", "1", "--kind", "test", "--ref", "npm test"], github.env);
    assert.equal(evidence.code, 0, evidence.stderr);
    const trace = awo(workspace, ["goal", "trace", "TEST-G1"], github.env);
    assert.equal(trace.code, 0, trace.stderr);
    assert.match(trace.stdout, /1\tcovered\tGiven a valid request/);
    assert.match(trace.stdout, /test\tTEST-T1\tnpm test/);

    const reconciled = awo(workspace, ["pr", "reconcile", "TEST-T1"], github.env);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.match(reconciled.stdout, /1 unresolved review thread/);
    assert.match(reconciled.stdout, /created: TEST-T2/);
    const repeat = awo(workspace, ["pr", "reconcile", "TEST-T1"], github.env);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.doesNotMatch(repeat.stdout, /created:/, "the same review thread must not create duplicate work");

    const blocked = awo(workspace, ["pr", "finalize", "TEST-T1"], github.env);
    assert.equal(blocked.code, 1, blocked.stderr);
    assert.match(blocked.stdout, /blocked/);
    assert.match(blocked.stdout, /unresolved GitHub review thread/);
    github.env.GH_NO_THREADS = "1";

    github.env.GH_UNREADY = "1";
    const checksBlocked = awo(workspace, ["pr", "finalize", "TEST-T1"], github.env);
    assert.equal(checksBlocked.code, 1, checksBlocked.stderr);
    assert.match(checksBlocked.stdout, /checks=failing/);
    delete github.env.GH_UNREADY;

    const humanOnly = awo(workspace, ["pr", "finalize", "TEST-T1"], github.env);
    assert.equal(humanOnly.code, 0, humanOnly.stderr);
    assert.match(humanOnly.stdout, /ready-for-human/);
    assert.doesNotMatch(fs.readFileSync(github.log, "utf8"), /--method PUT/, "human-only must not merge");

    const manifestPath = path.join(workspace, ".workspace", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.pullRequests.mergePolicy = "authorized-maintainer";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const merged = awo(workspace, ["pr", "finalize", "TEST-T1"], github.env);
    assert.equal(merged.code, 0, merged.stderr);
    assert.match(merged.stdout, /^merged/m);
    const calls = fs.readFileSync(github.log, "utf8");
    assert.match(calls, /api --method PUT repos\/acme\/api\/pulls\/42\/merge -f merge_method=squash -f sha=abc123/);
    assert.doesNotMatch(calls, /pr review .*--approve/, "AWO must never submit an approval");
  } finally {
    github.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("linking a PR assigns it and applies only labels the repo actually has", () => {
  const workspace = makeWorkspace();
  const github = fakeGithub();
  try {
    // The task asks for one real label, one project-wide label, and one that does not
    // exist in the repo.
    const taskFile = path.join(
      workspace, "goals", "TEST-G1-demo", "tasks", "TEST-T1-implement.md"
    );
    fs.writeFileSync(
      taskFile,
      fs.readFileSync(taskFile, "utf8").replace(
        "status: todo",
        "labels: [performance, needs-design]\nstatus: todo"
      )
    );
    const manifestPath = path.join(workspace, ".workspace", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.pullRequests = { ...manifest.pullRequests, labels: ["shop"] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const out = awo(workspace, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42"], github.env);
    assert.equal(out.code, 0, out.stderr);

    assert.match(out.stdout, /assignee: supanut9/);
    assert.match(out.stdout, /labels: {3}performance, shop/);
    // Reported by name, not silently dropped.
    assert.match(out.stdout, /no such label: needs-design/);
    assert.match(out.stdout, /awo never creates labels/);

    // And the gh call proves it: the missing label is absent from the edit.
    const calls = fs.readFileSync(github.env.GH_LOG as string, "utf8");
    assert.match(calls, /pr edit 42 .*--add-label performance/);
    assert.match(calls, /--add-label shop/);
    assert.ok(!/--add-label needs-design/.test(calls), "a label the repo lacks must never be sent");
    assert.match(calls, /--add-assignee supanut9/);
  } finally {
    github.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pr meta re-applies metadata, and warns when the PR never names its task", () => {
  const workspace = makeWorkspace();
  const github = fakeGithub();
  try {
    awo(workspace, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42", "--no-meta"], github.env);
    const linkOnly = fs.readFileSync(github.env.GH_LOG as string, "utf8");
    assert.ok(!/pr edit/.test(linkOnly), "--no-meta must not touch the PR");

    const dry = awo(workspace, ["pr", "meta", "TEST-T1", "--label", "ALMO-263", "--dry-run"], github.env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\(dry run\)/);
    assert.match(dry.stdout, /labels: {3}ALMO-263/);
    assert.ok(!/pr edit/.test(fs.readFileSync(github.env.GH_LOG as string, "utf8")), "dry run edits nothing");

    const applied = awo(workspace, ["pr", "meta", "TEST-T1", "--assignee", "someone"], github.env);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /assignee: someone/);
    assert.match(fs.readFileSync(github.env.GH_LOG as string, "utf8"), /--add-assignee someone/);

    // A PR that never names its task cannot be traced back from GitHub.
    const untitled = awo(workspace, ["pr", "meta", "TEST-T1"], {
      ...github.env,
      GH_PR_UNTITLED: "1",
    });
    assert.match(untitled.stdout, /never mentions TEST-T1/);
  } finally {
    github.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a repo can require a gh account, and awo refuses to act as anyone else", () => {
  const workspace = makeWorkspace();
  const github = fakeGithub();
  try {
    // The fake gh authenticates as supanut9; declare the repo as the company account.
    const manifestPath = path.join(workspace, ".workspace", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.repos = manifest.repos.map((r: { name: string }) =>
      r.name === "api" ? { ...r, githubAccount: "supanutOn" } : r
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const linked = awo(workspace, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42"], github.env);
    assert.equal(linked.code, 1, "linking as the wrong identity must fail");
    assert.match(linked.stderr, /must be acted on as "supanutOn", but gh is active as "supanut9"/);
    assert.match(linked.stderr, /gh auth switch --user supanutOn/, "it must give the fix");
    assert.match(linked.stderr, /not undoable/);

    // Nothing was linked, and no PR was touched.
    const calls = fs.readFileSync(github.env.GH_LOG as string, "utf8");
    assert.ok(!/pr edit/.test(calls), "a wrong-identity run must not edit the PR");

    // preflight REPORTS instead of throwing, so it can still cover every repo.
    const pre = awo(workspace, ["pr", "preflight"], github.env);
    assert.match(pre.stdout, /must be acted on as supanutOn, but gh is active as supanut9/);
    assert.equal(pre.code, 1, "preflight exits non-zero on a mismatch");

    // Matching account: everything proceeds.
    const ok = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    ok.repos = ok.repos.map((r: { name: string }) =>
      r.name === "api" ? { ...r, githubAccount: "supanut9" } : r
    );
    fs.writeFileSync(manifestPath, JSON.stringify(ok, null, 2));
    const good = awo(workspace, ["pr", "link", "TEST-T1", "--repo", "api", "--number", "42"], github.env);
    assert.equal(good.code, 0, good.stderr);
  } finally {
    github.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
