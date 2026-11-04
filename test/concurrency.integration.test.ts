import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const moduleUrl = (name: string) => pathToFileURL(path.join(ROOT, "dist", name)).href;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "awo-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function worker(source: string) {
  return exec(process.execPath, ["--input-type=module", "-e", source]);
}

test("state mutations preserve all updates across processes and overlapping promises", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "tasks"));
  for (let n = 0; n < 6; n++) {
    await fs.writeFile(path.join(root, "tasks", `T-T${n}.md`),
      `---\nid: T-T${n}\ngoalId: T-G1\nstatus: todo\n---\n`);
  }
  const { mutateState, readState } = await import(moduleUrl("state.js"));
  await mutateState(root, "T-G1", () => {});
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, n) => worker(`
    import { mutateState } from ${JSON.stringify(moduleUrl("state.js"))};
    await Promise.all(Array.from({length: 8}, () => mutateState(${JSON.stringify(root)}, "T-G1",
      s => { s.tasks["T-T${n}"].attempts += 1; })));
  `)));
  assert.deepEqual(results.filter((r) => r.status === "rejected"), [], "all writers must finish");
  const state = await readState(root, "T-G1");
  assert.equal(state.rev, 49);
  for (let n = 0; n < 6; n++) assert.equal(state.tasks[`T-T${n}`].attempts, 8);
  assert.deepEqual((await fs.readdir(root)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
});

test("allocation reserves run IDs before callers write any event, including midnight rollover", async (t) => {
  const root = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => worker(`
    import { allocateRunId } from ${JSON.stringify(moduleUrl("runs.js"))};
    const ids = await Promise.all(Array.from({length: 4}, () =>
      allocateRunId(${JSON.stringify(root)}, "same-slot", new Date("2026-11-03T23:59:59Z"))));
    console.log(JSON.stringify(ids));
  `)));
  const ids = results.flatMap((r) => JSON.parse(r.stdout));
  assert.equal(new Set(ids).size, 24);
  const { allocateRunId } = await import(moduleUrl("runs.js"));
  assert.ok(!ids.includes(await allocateRunId(root, "same-slot", new Date("2026-11-04T00:00:00Z"))));
});

test("concurrent daily detail replacements retain every run section", async (t) => {
  const root = await fixture(t);
  const { writeDetail, readDetail } = await import(moduleUrl("runs.js"));
  const ids = Array.from({ length: 12 }, (_, n) => `2026-11-03T01-00-00_task-${n}`);
  for (const id of ids) await writeDetail(root, id, {}, { summary: "before" });
  await Promise.all(ids.map((id) => writeDetail(root, id, {}, { summary: `updated ${id}` })));
  for (const id of ids) assert.match(await readDetail(root, id), new RegExp(`updated ${id}`));
});

test("a rejected mutation releases its lock without changing the state", async (t) => {
  const root = await fixture(t);
  const { mutateState, readState } = await import(moduleUrl("state.js"));
  await assert.rejects(mutateState(root, "T-G1", () => { throw new Error("rejected transition"); }), /rejected transition/);
  await mutateState(root, "T-G1", () => {});
  assert.equal((await readState(root, "T-G1")).rev, 1);
});

test("an interrupted lock owner fails closed until explicit recovery", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "protected.json");
  await fs.writeFile(file, "original");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withFileLock } from ${JSON.stringify(moduleUrl("file-lock.js"))};
    await withFileLock(${JSON.stringify(file)}, async () => {
      console.log("locked");
      await new Promise(resolve => setTimeout(resolve, 60_000));
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const { withFileLock, atomicWriteFile } = await import(moduleUrl("file-lock.js"));
  await assert.rejects(withFileLock(file, () => atomicWriteFile(file, "wrong"), 40), /stop all writers/);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  // The fixture owner is confirmed dead; this models the documented recovery.
  await fs.rm(`${file}.lock`, { recursive: true });
  await withFileLock(file, () => atomicWriteFile(file, "recovered"));
  assert.equal(await fs.readFile(file, "utf8"), "recovered");
});
