import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "cli.js");
const moduleUrl = (name: string) => pathToFileURL(path.join(REPO_ROOT, "dist", name)).href;

type Doc = Record<string, unknown>;

function awo(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function makeWorkspace(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awo-gui-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "awo-guirepo-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  awo(dir, ["init", "--key", "GU"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# api\n");
  awo(dir, ["connect", repo, "--name", "api"]);
  writeGoal(dir, "GU-G1", "Live goal", ["GU-T1"]);
  return dir;
}

function writeGoal(ws: string, goalId: string, title: string, taskIds: string[]): void {
  const goalDir = path.join(ws, "goals", goalId);
  fs.mkdirSync(path.join(goalDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(goalDir, "goal.md"), `---\nid: ${goalId}\ntitle: ${title}\n---\n\nx\n`);
  for (const id of taskIds) {
    fs.writeFileSync(
      path.join(goalDir, "tasks", `${id}.md`),
      `---\nid: ${id}\ngoalId: ${goalId}\nname: Task ${id}\ntargets: [api]\nagent: software-engineer\nstatus: todo\n---\n\nDo it.\n`
    );
  }
}

function setPublish(ws: string, publish: Record<string, unknown>): void {
  const file = path.join(ws, ".workspace", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  manifest.publish = publish;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function workspaceId(ws: string): string {
  return JSON.parse(fs.readFileSync(path.join(ws, ".workspace", "manifest.json"), "utf8")).workspaceId;
}

/** One finished run on GU-T1, carrying a credential, a workspace path and a brief. */
function finishRun(ws: string): void {
  awo(ws, ["task", "run", "GU-T1", "--no-worktree", "--instruction", "orchestrator-only-instruction"]);
  awo(ws, ["task", "event", "GU-T1", "note", "--message", `DB_PASSWORD=hunter2 see ${ws}/goals/GU-G1`]);
  awo(ws, ["task", "complete", "GU-T1", "--outcome", "success", "--untested", "fixture", "--summary", "done"]);
}

async function project(ws: string, publish: Record<string, unknown>): Promise<Record<string, Doc[] | Doc> & { redacted: Doc }> {
  const { buildProjection, readPublishConfig } = await import(moduleUrl("commands/publish.js"));
  setPublish(ws, publish);
  const { config } = await readPublishConfig(ws);
  return buildProjection(ws, workspaceId(ws), config);
}

test("publish projection: projectionVersion everywhere, archived goals, shelved requirements, run finishedAt", async (t) => {
  const ws = makeWorkspace(t);
  finishRun(ws);

  awo(ws, ["req", "new", "--title", "Parked idea"]);
  awo(ws, ["req", "suspend", "GU-R1", "--why", "not this quarter"]);

  // An archived goal, with the status frozen at archive time. The freeze itself is
  // `goal archive`'s job; the projection's job is to carry it.
  writeGoal(ws, "GU-G2", "Old goal", ["GU-T2"]);
  awo(ws, ["goal", "archive", "GU-G2", "--force"]);
  const archivedState = path.join(ws, "goals", "archive", "GU-G2", "state.json");
  const state = fs.existsSync(archivedState)
    ? JSON.parse(fs.readFileSync(archivedState, "utf8"))
    : { rev: 1, goalId: "GU-G2", goalStatus: "cancelled", updatedAt: "", tasks: {} };
  state.archivedStatus = "cancelled";
  state.archivedAt = "2026-11-01T00:00:00.000Z";
  fs.writeFileSync(archivedState, JSON.stringify(state));

  const p = await project(ws, { detail: "summary" });
  const all = [p.project as Doc, ...(["requirements", "goals", "tasks", "runs", "agents"] as const).flatMap((k) => p[k] as Doc[])];
  assert.ok(all.length > 5);
  for (const doc of all) assert.equal(doc.projectionVersion, 2, `${String(doc._id)} must carry projectionVersion`);
  assert.equal((p.project as Doc).detail, "summary");

  const goals = p.goals as Doc[];
  const live = goals.find((g) => g.goalId === "GU-G1")!;
  const old = goals.find((g) => g.goalId === "GU-G2")!;
  assert.equal(live.archived, false);
  assert.equal(live.archivedStatus, null);
  assert.equal(old.archived, true);
  assert.equal(old.archivedStatus, "cancelled", "archivedStatus comes from the goal's state");
  assert.equal(old.archivedAt, "2026-11-01T00:00:00.000Z");

  const requirement = (p.requirements as Doc[]).find((r) => r.requirementId === "GU-R1")!;
  assert.equal(requirement.status, "suspended");
  assert.equal(requirement.archived, true);

  const run = (p.runs as Doc[])[0];
  assert.match(String(run.finishedAt), /^\d{4}-\d{2}-\d{2}T/, "a closed run publishes when it finished");
  assert.equal((p.events as Doc[]).length, 0, "summary detail sends no event streams");
});

test("publish redaction is field-aware: briefs, checkout paths and prompts withheld by default, secrets always masked", async (t) => {
  const ws = makeWorkspace(t);
  finishRun(ws);

  const guarded = await project(ws, { detail: "full" });
  const events = guarded.events as Doc[];
  assert.equal(events.length, 1);
  const stream = events[0].events as Doc[];
  const brief = stream.find((e) => e.kind === "brief")!;
  assert.equal(brief.text, undefined, "the brief embeds the orchestrator's instruction");
  assert.equal(brief.textRedacted, true);
  assert.equal(brief.instructionRedacted, true);
  const start = stream.find((e) => e.kind === "run.start")!;
  for (const checkout of start.checkouts as Doc[]) {
    assert.equal(checkout.checkout, undefined, "local checkout paths stay local");
    assert.equal(checkout.checkoutRedacted, true);
  }
  assert.match(String(events[0].markdown), /### User prompt\n_redacted/, "the record's prompt section is withheld");

  const text = JSON.stringify(guarded);
  assert.doesNotMatch(text, /hunter2/, "credentials are masked in every published string");
  assert.doesNotMatch(text, /orchestrator-only-instruction/);
  assert.ok(!text.includes(ws), "the workspace's absolute path never leaves the machine");
  assert.ok(!text.includes(fs.realpathSync(ws)));
  assert.match(text, /<workspace>\/goals\/GU-G1/, "prose keeps its meaning with the path prefix replaced");
  const redacted = guarded.redacted as Record<string, number>;
  assert.ok(redacted.prompts >= 1);
  assert.ok(redacted.checkoutPaths >= 1);

  // Both redactions explicitly off: prompts and paths travel, credentials still do not.
  const open = await project(ws, { detail: "full", redact: { prompts: false, filePaths: false } });
  const openStream = (open.events as Doc[])[0].events as Doc[];
  assert.match(String(openStream.find((e) => e.kind === "brief")!.text), /orchestrator-only-instruction/);
  assert.ok(((openStream.find((e) => e.kind === "run.start")!.checkouts as Doc[])[0].checkout as string).length > 0);
  assert.doesNotMatch(JSON.stringify(open), /hunter2/);

  // An unset or non-boolean prompts flag means redacted, never "off".
  const nulled = await project(ws, { detail: "full", redact: { prompts: null, filePaths: false } });
  const nulledBrief = ((nulled.events as Doc[])[0].events as Doc[]).find((e) => e.kind === "brief")!;
  assert.equal(nulledBrief.textRedacted, true);

  // And the CLI says what it withheld.
  setPublish(ws, { detail: "full" });
  assert.match(awo(ws, ["publish", "--dry-run"]), /withheld by redact settings:.*prompt\(s\).*checkout path\(s\)/);
});

test("stripPrompt withholds the current ### record section, even when the prompt contains headings", async () => {
  const { stripPrompt, sanitizeDocument, redactionPolicy } = await import(moduleUrl("commands/publish.js"));
  const record = [
    "<!-- awo:run 2026-11-22T10-00-00_GU-T1 -->",
    "## 10:00:00 · GU-T1",
    "",
    "### User prompt",
    "secret plan",
    "## a heading inside the prompt",
    "more secret plan",
    "",
    "### Interpreted intent",
    "kept",
  ].join("\n");
  const out = stripPrompt(record);
  assert.doesNotMatch(out, /secret plan/);
  assert.match(out, /### User prompt\n_redacted/);
  assert.match(out, /### Interpreted intent\nkept/);
  assert.equal(stripPrompt("no prompt here"), "no prompt here");

  const tally = { prompts: 0, checkoutPaths: 0, secrets: 0 };
  const policy = redactionPolicy(
    { database: "awo", collectionPrefix: "awo_", detail: "summary", redact: { prompts: false, filePaths: false } },
    "/work/space",
    "/home/someone"
  );
  const doc = sanitizeDocument(
    { blockedReason: "export API_KEY=abc123 then retry in /home/someone/x", worktree: "/work/space/.wt/a" },
    policy,
    tally
  );
  // Summary detail withholds paths and prompts whatever `redact` says.
  assert.deepEqual(doc, { blockedReason: "export API_KEY=*** then retry in ~/x", worktreeRedacted: true });
  assert.deepEqual(tally, { prompts: 0, checkoutPaths: 1, secrets: 1 });
});

/** Just enough of a Mongo database to watch what writeProjection asks for. */
function fakeDb() {
  const store = new Map<string, Map<string, Doc>>();
  const coll = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const rows = store.get(name)!;
    const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
      Object.entries(filter).every(([key, cond]) =>
        cond && typeof cond === "object" && "$nin" in (cond as object)
          ? !((cond as { $nin: unknown[] }).$nin.includes(doc[key]))
          : doc[key] === cond
      );
    return {
      replaceOne: async (filter: { _id: string }, doc: Doc) => void rows.set(filter._id, doc),
      createIndex: async () => "ok",
      bulkWrite: async (ops: { replaceOne: { filter: { _id: string }; replacement: Doc } }[]) => {
        for (const op of ops) rows.set(op.replaceOne.filter._id, op.replaceOne.replacement);
      },
      deleteMany: async (filter: Record<string, unknown>) => {
        let deletedCount = 0;
        for (const [id, doc] of rows) {
          if (!matches(doc, filter)) continue;
          rows.delete(id);
          deletedCount += 1;
        }
        return { deletedCount };
      },
    };
  };
  return { db: { collection: coll }, store };
}

test("a summary publish after a full one deletes the full-detail event documents it left behind", async (t) => {
  const ws = makeWorkspace(t);
  finishRun(ws);
  const { writeProjection } = await import(moduleUrl("commands/publish.js"));
  const { db, store } = fakeDb();
  const config = (detail: string) => ({ database: "awo", collectionPrefix: "awo_", detail, redact: { prompts: true, filePaths: true } });

  const full = await project(ws, { detail: "full" });
  assert.deepEqual(await writeProjection(db, config("full"), full), { purgedEvents: 0 });
  assert.equal(store.get("awo_events")!.size, 1);

  const summary = await project(ws, { detail: "summary" });
  assert.deepEqual(await writeProjection(db, config("summary"), summary), { purgedEvents: 1 });
  assert.equal(store.get("awo_events")!.size, 0, "prose the workspace stopped sharing must not stay on the cluster");
  assert.equal((store.get("awo_projects")!.get(workspaceId(ws)) as Doc).detail, "summary");
  assert.equal(store.get("awo_runs")!.size, 1, "the run index itself is summary-safe and stays");
});

test("publish --watch follows logs/<date>/runs.jsonl, including day folders created after it started", async (t) => {
  const ws = makeWorkspace(t);
  const { publishWatchTargets, isIgnoredByPublishWatch, runPublishWatch } = await import(moduleUrl("commands/publish.js"));

  const targets: string[] = publishWatchTargets(ws);
  assert.ok(targets.includes(path.join(ws, "logs")), "the logs folder, so new day folders are seen");
  assert.ok(!targets.includes(path.join(ws, "logs", "runs.jsonl")), "the retired flat layout is not the target");
  const day = path.join(ws, "logs", "2031-01-02");
  assert.equal(isIgnoredByPublishWatch(ws, day), false);
  assert.equal(isIgnoredByPublishWatch(ws, path.join(day, "runs.jsonl")), false);
  assert.equal(isIgnoredByPublishWatch(ws, path.join(day, "runs.md")), false);
  assert.equal(isIgnoredByPublishWatch(ws, path.join(day, "workers")), true, "streamed worker stdout is not a sync trigger");
  assert.equal(isIgnoredByPublishWatch(ws, path.join(day, "workers", "10-00-00-GU-T1.log")), true);
  assert.equal(isIgnoredByPublishWatch(ws, path.join(ws, "logs", "runs.jsonl")), true);
  assert.equal(isIgnoredByPublishWatch(ws, path.join(ws, "goals", "GU-G1", "state.json")), false);

  const seen: unknown[] = [];
  const handle = await runPublishWatch({ cwd: ws, dryRun: true, debounceMs: 50, onPublish: (r: unknown) => seen.push(r) });
  t.after(() => handle.stop());
  await handle.ready;

  fs.mkdirSync(path.join(day, "workers"), { recursive: true });
  fs.writeFileSync(path.join(day, "workers", "10-00-00-GU-T1.log"), "worker output\n");
  await new Promise((r) => setTimeout(r, 600));
  // The day folder's creation may itself fire; worker output alone must not keep firing.
  const afterWorker = seen.length;
  fs.appendFileSync(path.join(day, "workers", "10-00-00-GU-T1.log"), "more output\n");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.length, afterWorker, "appending worker stdout does not publish");

  fs.writeFileSync(path.join(day, "runs.jsonl"), `${JSON.stringify({ type: "event", runId: "x", t: "", kind: "note" })}\n`);
  const deadline = Date.now() + 5000;
  while (seen.length === afterWorker && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(seen.length > afterWorker, "a run recorded in a new day folder triggers a publish");
  const last = seen[seen.length - 1];
  assert.ok(!(last instanceof Error), `the dry-run publish succeeded: ${String(last)}`);
  assert.equal((last as { dryRun: boolean }).dryRun, true);
});

test("agent org counts open work from runtime state, live goals by default", async (t) => {
  const ws = makeWorkspace(t);
  writeGoal(ws, "GU-G2", "Old goal", ["GU-T2"]);
  awo(ws, ["goal", "archive", "GU-G2", "--force"]);
  finishRun(ws);

  const org = (args: string[] = []) =>
    (JSON.parse(awo(ws, ["agent", "org", "--json", ...args])).agents as Doc[]).find(
      (a) => a.id === "software-engineer"
    )!;

  // GU-T1's file still says `status: todo`; its state says done.
  const liveOnly = org();
  assert.equal(liveOnly.taskCount, 1, "archived goals are not current workload");
  assert.equal(liveOnly.openTasks, 0, "a finished task is not open work, whatever its file was authored with");

  const everything = org(["--all"]);
  assert.equal(everything.taskCount, 2);
  assert.equal(everything.openTasks, 1, "the archived goal's untouched task is still todo");
});
