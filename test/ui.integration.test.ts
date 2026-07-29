import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-ui-"));
  execFileSync(process.execPath, [CLI, "init", "--key", "UI"], { cwd: dir });

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-uirepo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  execFileSync(process.execPath, [CLI, "connect", repo, "--name", "api"], { cwd: dir });

  const goalDir = path.join(dir, "goals", "UI-G1");
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goalDir, "goal.md"), `---\nid: UI-G1\ntitle: Demo\n---\n\nx\n`);
  fs.writeFileSync(
    path.join(goalDir, "tasks", "UI-T1.md"),
    `---\nid: UI-T1\ngoalId: UI-G1\nname: First\ntargets: [api]\nagent: software-engineer\nstatus: todo\n---\n\nDo it.\n`
  );
  return dir;
}

function awo(cwd: string, args: string[]): void {
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

interface UiHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start `awo ui` the way a user does — as a subprocess — and read the bound
 * URL off stdout. Every other integration test drives the real CLI too.
 */
function startUi(cwd: string): Promise<UiHandle> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [CLI, "ui"], { cwd });
    const timer = setTimeout(() => reject(new Error("awo ui did not report a URL within 10s")), 10_000);
    let buf = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: match[0],
        port: Number(match[1]),
        close: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGTERM");
          }),
      });
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      clearTimeout(timer);
      reject(new Error(`awo ui failed: ${chunk.toString()}`));
    });
  });
}

test("ui serves a snapshot, the page, and a live stream; and writes go through the state module", async (t) => {
  const ws = makeWorkspace();
  let ui: UiHandle | null = null;
  t.after(async () => {
    if (ui) await ui.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  ui = await startUi(ws);
  assert.ok(ui.port > 0, "server must bind a port");
  assert.match(ui.url, /^http:\/\/127\.0\.0\.1:/, "must bind loopback, never the LAN");

  // The page itself.
  const page = await fetch(`${ui.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<title>awo<\/title>/);
  assert.match(html, /id="root"/, "the React root must be present");

  // The prebuilt bundle must be served, or the page renders nothing.
  const bundle = await fetch(`${ui.url}/app.js`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type") ?? "", /javascript/);
  const css = await fetch(`${ui.url}/app.css`);
  assert.equal(css.status, 200);

  // Traversal outside the asset dir is refused.
  const escape = await fetch(`${ui.url}/../package.json`);
  assert.equal(escape.status, 404);

  // Snapshot shape.
  const snap = await (await fetch(`${ui.url}/api/snapshot`)).json();
  assert.equal(snap.project.projectKey, "UI");
  assert.ok(snap.project.workspaceId, "snapshot must expose the workspaceId");
  assert.equal(snap.goals.length, 1);
  assert.equal(snap.goals[0].tasks[0].id, "UI-T1");
  assert.equal(snap.goals[0].tasks[0].status, "todo", "authored status shows before any run");
  assert.deepEqual(
    snap.repos.map((r: { name: string; status: string }) => [r.name, r.status]),
    [["api", "present"]]
  );
  assert.equal(snap.stats.totalTasks, 1);
  assert.equal(snap.stats.totalRuns, 0);
  assert.equal(snap.stats.successRate, null, "no finished runs means no rate, not zero");

  // A run's events are readable through the API.
  awo(ws, ["task", "run", "UI-T1"]);
  awo(ws, ["task", "event", "UI-T1", "step.start", "--label", "Working"]);
  awo(ws, ["task", "complete", "UI-T1", "--outcome", "success", "--untested", "fixture", "--summary", "done"]);

  const after = await (await fetch(`${ui.url}/api/snapshot`)).json();
  assert.equal(after.goals[0].tasks[0].status, "done");
  assert.equal(after.stats.totalRuns, 1);
  assert.equal(after.stats.successRate, 1);

  const runId = after.runs[0].runId;
  const events = await (await fetch(`${ui.url}/api/events?run=${encodeURIComponent(runId)}`)).json();
  assert.deepEqual(
    events.map((e: { kind: string }) => e.kind),
    ["run.start", "step.start", "run.end"]
  );

  const noRun = await fetch(`${ui.url}/api/events`);
  assert.equal(noRun.status, 400);

  // §12.9 — the tiering hypothesis has to be testable from the workspace's own
  // history, so the snapshot carries per-tier outcomes.
  assert.ok(Array.isArray(after.stats.byTier), "analytics must be in the snapshot");
  assert.equal(typeof after.stats.untestedSuccesses, "number");
  const tierRow = after.stats.byTier[0];
  assert.ok(tierRow.runs >= 1);
  assert.ok(tierRow.avgAttempts >= 1, "attempts is what shows a cheap tier giving the saving back");
  assert.equal(tierRow.succeeded, 1);
  assert.equal(tierRow.successRate, 1);

  // Task detail: definition body + state, for the drawer.
  const detail = await (await fetch(`${ui.url}/api/task?id=UI-T1`)).json();
  assert.equal(detail.id, "UI-T1");
  assert.match(detail.body, /Do it\./, "the task's markdown body must come through");
  assert.deepEqual(detail.dependsOn, []);
  assert.match(detail.file, /UI-T1\.md$/);
  assert.equal((await fetch(`${ui.url}/api/task?id=NOPE`)).status, 404);
  assert.equal((await fetch(`${ui.url}/api/task`)).status, 400);

  // Run log: the markdown record written at completion.
  const log = await (await fetch(`${ui.url}/api/run?id=${encodeURIComponent(runId)}`)).json();
  assert.match(log.markdown, /^---/, "run log is markdown with frontmatter");
  assert.match(log.markdown, /taskId: UI-T1/);
  assert.equal((await fetch(`${ui.url}/api/run?id=nope`)).status, 404);

  // Writes: only human lifecycle moves, and invalid ones are refused.
  const bad = await fetch(`${ui.url}/api/task/status`, {
    method: "POST",
    body: JSON.stringify({ taskId: "UI-T1", status: "running" }),
  });
  assert.equal(bad.status, 409, "an invalid transition must be refused, not applied");
  assert.match((await bad.json()).error, /Invalid transition/);

  const ok = await fetch(`${ui.url}/api/task/status`, {
    method: "POST",
    body: JSON.stringify({ taskId: "UI-T1", status: "cancelled" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ws, "goals", "UI-G1", "state.json"), "utf8")).tasks[
      "UI-T1"
    ].status,
    "cancelled",
    "the UI write must land through the same state module the CLI uses"
  );

  const missing = await fetch(`${ui.url}/api/nope`);
  assert.equal(missing.status, 404);
});

test("the SSE stream pushes a change event when workspace files change", async (t) => {
  const ws = makeWorkspace();
  let ui: UiHandle | null = null;
  t.after(async () => {
    if (ui) await ui.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  ui = await startUi(ws);

  const controller = new AbortController();
  const res = await fetch(`${ui.url}/api/stream`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = res.body!.getReader();
  const seen = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no SSE change event within 5s")), 5000);
    (async () => {
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        if (buf.includes("event: changed")) {
          clearTimeout(timer);
          resolve(buf);
          return;
        }
      }
    })().catch(reject);
  });

  // Give chokidar a moment to attach before mutating, or the change is missed.
  await new Promise((r) => setTimeout(r, 400));
  awo(ws, ["task", "run", "UI-T1"]);

  assert.match(await seen, /event: changed/);
  controller.abort();
});
