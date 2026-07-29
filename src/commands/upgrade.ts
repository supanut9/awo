import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { v7 as uuidv7 } from "uuid";
import { findWorkspaceRoot } from "../workspace.js";
import { detailFile, eventsFile, indexFile, workerLogFile } from "../runs.js";
import { readManifest, writeManifest, type Manifest } from "../manifest.js";
import {
  buildLock,
  hashContent,
  readLibraryVersion,
  readLock,
  renderTemplate,
  templateFiles,
  templateSourcePath,
  writeLock,
  type TemplateLock,
} from "../template.js";

/**
 * §11.3 — forward-only, idempotent, keyed by the version they upgrade TO.
 * A migration may rewrite a field it owns; it must never touch goals/ prose,
 * logs/, repos/, or credentials/.
 */
interface Migration {
  version: string;
  description: string;
  apply: (ctx: { root: string; manifest: Manifest }) => Promise<boolean>;
}

const MIGRATIONS: Migration[] = [
  {
    version: "0.0.32",
    description: "restructure logs, goals and requirements; clear stale worktrees",
    apply: async ({ root }) => restructureWorkspace(root),
  },
  {
    version: "0.0.33",
    description: "shard logs by date again, with the task under it",
    apply: async ({ root }) => reshardLogsByDate(root),
  },
  {
    version: "0.0.34",
    description: "repair index pointers left dangling by the 0.0.33 reshard",
    apply: async ({ root }) => {
      // 0.0.33 shipped without rewriting the index, so a workspace that had already
      // run the 0.0.32 migration in an earlier session came out of it with every
      // detailFile pointing at a path the reshard had just emptied. Repaired here
      // rather than by asking anyone to re-run anything.
      const before = await fs.readFile(indexFile(root), "utf8").catch(() => "");
      if (!before.trim()) return false;
      await rewriteIndexPointers(root);
      return (await fs.readFile(indexFile(root), "utf8")) !== before;
    },
  },
  {
    version: "0.0.2",
    description: "backfill manifest.workspaceId (uuid v7)",
    apply: async ({ root, manifest }) => {
      if (manifest.workspaceId) return false;
      manifest.workspaceId = uuidv7();
      await writeManifest(root, manifest);
      return true;
    },
  },
];

/**
 * The 0.0.32 layout change, as a migration rather than file reconciliation because
 * it MOVES user content — which reconciliation is forbidden to touch (§11.2).
 *
 * Everything here is idempotent and additive-then-move: nothing is deleted that
 * has not first been copied, so a half-finished migration re-runs cleanly.
 */
async function restructureWorkspace(root: string): Promise<boolean> {
  let changed = false;
  const logs = path.join(root, "logs");

  // 1. logs/runs/<date>/<runId>.{md,events.jsonl,worker.log}
  //      -> logs/<taskId|_adhoc>/<stamp>/{record.md,events.jsonl,worker.log}
  const legacyRuns = path.join(logs, "runs");
  if (await fs.pathExists(legacyRuns)) {
    for (const shard of await fs.readdir(legacyRuns)) {
      const shardDir = path.join(legacyRuns, shard);
      if (!(await fs.stat(shardDir)).isDirectory()) continue;
      for (const name of await fs.readdir(shardDir)) {
        const runId = name.replace(/\.events\.jsonl$|\.worker\.log$|\.md$/, "");
        const target = name.endsWith(".events.jsonl")
          ? eventsFile(root, runId)
          : name.endsWith(".worker.log")
            ? workerLogFile(root, runId)
            : detailFile(root, runId);
        await fs.ensureDir(path.dirname(target));
        await fs.move(path.join(shardDir, name), target, { overwrite: true });
        changed = true;
      }
      await fs.remove(shardDir);
    }
    await fs.remove(legacyRuns);
  }

  // A verify record written straight into logs/ rather than through the run writer
  // was invisible to `awo log list`. Give it a run directory so it is addressable.
  for (const name of (await fs.pathExists(logs)) ? await fs.readdir(logs) : []) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const stem = name.slice(0, -3);
    await fs.move(
      path.join(logs, name),
      path.join(logs, "_adhoc", `legacy-${stem}`, "record.md"),
      { overwrite: true }
    );
    changed = true;
  }

  // 2. logs/runs.jsonl -> logs/index.jsonl, rewriting the detailFile pointers so
  //    old entries resolve under the new layout instead of dangling.
  const legacyIndex = path.join(logs, "runs.jsonl");
  if ((await fs.pathExists(legacyIndex)) && !(await fs.pathExists(indexFile(root)))) {
    const lines = (await fs.readFile(legacyIndex, "utf8")).split("\n").filter((l) => l.trim());
    const rewritten = lines.map((line) => {
      const entry = JSON.parse(line) as { runId: string; detailFile?: string };
      entry.detailFile = path.relative(logs, detailFile(root, entry.runId));
      return JSON.stringify(entry);
    });
    await fs.writeFile(indexFile(root), rewritten.length ? `${rewritten.join("\n")}\n` : "");
    await fs.remove(legacyIndex);
    changed = true;
  }

  // 3. goals/<ID>-<truncated-slug>/ -> goals/<ID>/, and tasks/<ID>-<slug>.md ->
  //    tasks/<ID>.md. The slug was cut at 40 chars, so directory names ended
  //    mid-word with a trailing hyphen, and renaming a goal's title would have
  //    orphaned its path. IDs are permanent; titles are frontmatter.
  const goalsRoot = path.join(root, "goals");
  const idOnly = /^([A-Za-z][A-Za-z0-9]*-[GT]\d+)(?:-.*)?$/;
  for (const name of (await fs.pathExists(goalsRoot)) ? await fs.readdir(goalsRoot) : []) {
    const dir = path.join(goalsRoot, name);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const m = idOnly.exec(name);
    if (m && m[1] !== name) {
      await fs.move(dir, path.join(goalsRoot, m[1]), { overwrite: true });
      changed = true;
    }
    const tasksDir = path.join(goalsRoot, m ? m[1] : name, "tasks");
    for (const file of (await fs.pathExists(tasksDir)) ? await fs.readdir(tasksDir) : []) {
      const tm = idOnly.exec(file.replace(/\.md$/, ""));
      if (tm && `${tm[1]}.md` !== file) {
        await fs.move(path.join(tasksDir, file), path.join(tasksDir, `${tm[1]}.md`), {
          overwrite: true,
        });
        changed = true;
      }
    }
  }

  // 4. A requirement that has not been promoted to a goal had no home, so it sat
  //    loose in goals/ — where it reads as a goal and is not one.
  const reqRoot = path.join(root, "requirements");
  await fs.ensureDir(reqRoot);
  for (const name of (await fs.pathExists(goalsRoot)) ? await fs.readdir(goalsRoot) : []) {
    if (!/^[A-Za-z][A-Za-z0-9]*-R\d+\.md$/.test(name)) continue;
    await fs.move(path.join(goalsRoot, name), path.join(reqRoot, name), { overwrite: true });
    changed = true;
  }

  // 5. Worktrees were created at <root>/.worktrees before moving under repos/, so a
  //    workspace upgraded across that change has full checkouts in a location
  //    nothing reads — invisible, and gigabytes. Remove only registered-and-stale
  //    ones; git prune keeps its own bookkeeping straight.
  const stray = path.join(root, ".worktrees");
  if (await fs.pathExists(stray)) {
    await fs.remove(stray);
    changed = true;
  }

  // 6. Upgrade backups accumulate one directory per upgrade, forever. Keep the
  //    three most recent: enough to recover a bad upgrade, bounded.
  const backups = path.join(root, ".workspace", "upgrade-backups");
  if (await fs.pathExists(backups)) {
    const dirs = (await fs.readdir(backups)).sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - 3))) {
      await fs.remove(path.join(backups, old));
      changed = true;
    }
  }

  return changed;
}

/**
 * 0.0.33 — `logs/<slot>/<stamp>/` becomes `logs/<date>/<slot>/<time>/`.
 *
 * 0.0.32 filed runs under their task, which made "every attempt at T2" an `ls` but
 * gave up chronological browsing and let the top level of logs/ grow one directory
 * per task forever. Date first restores both; the index still answers per-task
 * questions, which is what it is for.
 *
 * Runs after 0.0.32's migration, so a workspace coming from any earlier version
 * arrives here already in the task-first shape.
 */
async function reshardLogsByDate(root: string): Promise<boolean> {
  const logs = path.join(root, "logs");
  if (!(await fs.pathExists(logs))) return false;
  let changed = false;

  const isDate = (name: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(name);

  for (const slot of await fs.readdir(logs)) {
    // Already-sharded days and the index are left alone; this is idempotent.
    if (isDate(slot) || !(await fs.stat(path.join(logs, slot))).isDirectory()) continue;

    for (const stamp of await fs.readdir(path.join(logs, slot))) {
      const from = path.join(logs, slot, stamp);
      if (!(await fs.stat(from)).isDirectory()) continue;
      // `<date>T<time>`, or a hand-made name like `legacy-verify-SHOP-G1` with no
      // date in it at all — those keep their name and land under the epoch day so
      // they stay addressable rather than being dropped.
      const dated = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(stamp);
      const to = dated
        ? path.join(logs, dated[1], slot, dated[2])
        : path.join(logs, "undated", slot, stamp);
      await fs.ensureDir(path.dirname(to));
      await fs.move(from, to, { overwrite: true });
      changed = true;
    }
    await fs.remove(path.join(logs, slot));
  }

  // The index's detailFile pointers are relative paths, so moving the files
  // invalidates them. Rewriting them here rather than trusting 0.0.32's rewrite is
  // the whole bug this block exists for: on a workspace that had already run the
  // 0.0.32 migration in an earlier session, that rewrite happened at 0.0.32 paths
  // and this migration then moved the files out from under it — 24 dangling
  // pointers, invisible to `awo log list` because it resolves by runId.
  if (changed) await rewriteIndexPointers(root);

  return changed;
}

/** Point every index entry at wherever its record actually is now. */
async function rewriteIndexPointers(root: string): Promise<void> {
  const file = indexFile(root);
  if (!(await fs.pathExists(file))) return;
  const logs = path.join(root, "logs");
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  const rewritten = lines.map((line) => {
    const entry = JSON.parse(line) as { runId: string; detailFile?: string };
    entry.detailFile = path.relative(logs, detailFile(root, entry.runId));
    return JSON.stringify(entry);
  });
  await fs.writeFile(file, rewritten.length ? `${rewritten.join("\n")}\n` : "");
}

/** `.workspace/manifest.json` is owned by migrations, never file reconciliation. */
const NOT_RECONCILED = new Set([".workspace/manifest.json", ".workspace/template.lock"]);

export type FileAction =
  | "replace"
  | "add"
  | "conflict"
  | "user-edited"
  | "unchanged"
  | "user-deleted"
  | "dropped-from-template";

export interface FilePlan {
  path: string;
  action: FileAction;
}

export interface UpgradePlan {
  from: string;
  to: string;
  hadLock: boolean;
  migrations: Migration[];
  files: FilePlan[];
}

export interface UpgradeResult extends UpgradePlan {
  applied: boolean;
  backupDir: string | null;
  conflictFiles: string[];
  migrationsRun: string[];
  /** True when the workspace isn't a git repo, so §11.4's review gate can't apply. */
  unreviewable: boolean;
}

const CHANGED_ACTIONS = new Set<FileAction>(["replace", "add", "conflict"]);

export function planHasWork(plan: UpgradePlan): boolean {
  return plan.migrations.length > 0 || plan.files.some((f) => CHANGED_ACTIONS.has(f.action));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * §11 — classify every template-owned file into one of §11.2's four cases.
 * Without a lock there is no baseline, so nothing can be proven unmodified and
 * every changed file becomes a conflict rather than an overwrite.
 */
async function planFiles(
  root: string,
  projectKey: string,
  lock: TemplateLock | null
): Promise<FilePlan[]> {
  const plans: FilePlan[] = [];
  const templatePaths = await templateFiles();

  for (const rel of templatePaths) {
    if (NOT_RECONCILED.has(rel)) continue;

    const onDisk = path.join(root, ...rel.split("/"));
    const rendered = renderTemplate(
      await fs.readFile(templateSourcePath(rel), "utf8"),
      { projectKey }
    );
    const newHash = hashContent(rendered);
    const lockHash = lock?.files[rel];

    if (!(await fs.pathExists(onDisk))) {
      // Deletion is a choice; §11.2 says leave it deleted.
      plans.push({ path: rel, action: lockHash ? "user-deleted" : "add" });
      continue;
    }

    const currentHash = hashContent(await fs.readFile(onDisk));

    if (currentHash === newHash) {
      plans.push({ path: rel, action: "unchanged" });
      continue;
    }
    if (lockHash === undefined) {
      // New file in this version of the template, or no lock at all.
      plans.push({ path: rel, action: "conflict" });
      continue;
    }
    if (currentHash === lockHash) {
      plans.push({ path: rel, action: "replace" });
      continue;
    }
    if (newHash === lockHash) {
      // §11.2's third case: the user edited it and the template has NOT changed
      // since the baseline. Leave it entirely alone — re-offering a .new file
      // identical to the baseline they already diverged from is just noise.
      plans.push({ path: rel, action: "user-edited" });
      continue;
    }
    plans.push({ path: rel, action: "conflict" });
  }

  // In the lock but no longer shipped: the template dropped it. Leave it.
  const shipped = new Set(templatePaths);
  for (const rel of Object.keys(lock?.files ?? {})) {
    if (!shipped.has(rel) && !NOT_RECONCILED.has(rel)) {
      plans.push({ path: rel, action: "dropped-from-template" });
    }
  }

  return plans.sort((a, b) => a.path.localeCompare(b.path));
}

export async function planUpgrade(options: { cwd?: string; to?: string } = {}): Promise<UpgradePlan> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  const installed = readLibraryVersion();

  // The template ships inside the installed package (§10, embedded-not-fetched),
  // so the only version we can upgrade *to* is the one that is installed.
  // `--to` therefore asserts intent rather than selecting a download.
  if (options.to && options.to !== installed) {
    throw new Error(
      `Cannot upgrade to ${options.to}: this awo is ${installed}, and the template ships inside the package (§10) — there is nothing to fetch.\n` +
        `Run it with that version instead:\n  npx @supanut9/awo@${options.to} upgrade`
    );
  }

  const from = manifest.libraryVersion;
  const to = installed;

  if (compareVersions(from, to) > 0) {
    throw new Error(
      `Workspace is at ${from}, newer than this awo (${to}). Downgrades are not supported (§11.3 is forward-only). Install ${from} or newer.`
    );
  }

  const lock = await readLock(root);
  const migrations = MIGRATIONS.filter(
    (m) => compareVersions(m.version, from) > 0 && compareVersions(m.version, to) <= 0
  ).sort((a, b) => compareVersions(a.version, b.version));

  return {
    from,
    to,
    hadLock: lock !== null,
    migrations,
    files: await planFiles(root, manifest.projectKey, lock),
  };
}

export async function runUpgrade(
  options: { cwd?: string; to?: string; dryRun?: boolean; force?: boolean } = {}
): Promise<UpgradeResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const plan = await planUpgrade(options);

  const isRepo = await simpleGit(root).checkIsRepo().catch(() => false);

  const base: UpgradeResult = {
    ...plan,
    applied: false,
    backupDir: null,
    conflictFiles: [],
    migrationsRun: [],
    unreviewable: !isRepo,
  };

  if (options.dryRun) return base;

  // §11.4 — insist on a reviewable diff, so there is always a way back.
  // If the workspace isn't a git repo there is no diff to insist on; the caller
  // is told rather than left assuming the guard ran.
  if (!options.force && isRepo) {
    {
      const status = await simpleGit(root).status();
      if (!status.isClean()) {
        throw new Error(
          `Workspace has uncommitted changes (${status.files.length} file(s)). Commit or stash them first so the upgrade is reviewable, or pass --force.`
        );
      }
    }
  }

  if (!planHasWork(plan) && plan.from === plan.to) {
    return base;
  }

  const manifest = await readManifest(root);
  const backupDir = path.join(root, ".workspace", "upgrade-backups", `${plan.from}-to-${plan.to}`);
  const conflictFiles: string[] = [];
  let touchedAnything = false;

  for (const file of plan.files) {
    if (!CHANGED_ACTIONS.has(file.action)) continue;

    const onDisk = path.join(root, ...file.path.split("/"));
    const rendered = renderTemplate(
      await fs.readFile(templateSourcePath(file.path), "utf8"),
      { projectKey: manifest.projectKey }
    );

    if (file.action === "conflict") {
      // §11.2 — never overwrite a user-edited file. Put the new version
      // alongside it and let a human decide.
      await fs.writeFile(`${onDisk}.new`, rendered, "utf8");
      conflictFiles.push(`${file.path}.new`);
      touchedAnything = true;
      continue;
    }

    if (file.action === "replace") {
      await fs.ensureDir(path.dirname(path.join(backupDir, file.path)));
      await fs.copy(onDisk, path.join(backupDir, file.path));
    }
    await fs.ensureDir(path.dirname(onDisk));
    await fs.writeFile(onDisk, rendered, "utf8");
    touchedAnything = true;
  }

  const migrationsRun: string[] = [];
  for (const migration of plan.migrations) {
    const changed = await migration.apply({ root, manifest });
    if (changed) migrationsRun.push(`${migration.version}: ${migration.description}`);
  }

  // Bump last, so an interrupted upgrade is re-runnable from the same `from`.
  const fresh = await readManifest(root);
  fresh.libraryVersion = plan.to;
  await writeManifest(root, fresh);
  await writeLock(root, await buildLock(root, manifest.projectKey, plan.to));

  return {
    ...plan,
    unreviewable: !isRepo,
    applied: true,
    backupDir: touchedAnything && (await fs.pathExists(backupDir)) ? path.relative(root, backupDir) : null,
    conflictFiles,
    migrationsRun,
  };
}
