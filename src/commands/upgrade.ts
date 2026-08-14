import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { v7 as uuidv7 } from "uuid";
import { findWorkspaceRoot } from "../workspace.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";
import { refreshManagedBlocks } from "../managed-blocks.js";
import { basePath, recordBase, threeWayMerge } from "./resolve.js";
import { runSlot, workerLogFile, writeDetail, appendIndex, appendEvent, type RunIndexEntry, type RunEvent, type EventKind } from "../runs.js";
import { readManifest, writeManifest, type Manifest } from "../manifest.js";
import {
  buildLock,
  hashForLock,
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

// Kept in version order, and applied in that order (see planUpgrade). An entry
// removed by accident is silent — a workspace simply never gets the fix — so the
// suite asserts each one by name.
const MIGRATIONS: Migration[] = [
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
  {
    version: "0.0.32",
    description: "restructure logs, goals and requirements; clear stale worktrees",
    apply: async ({ root }) => restructureWorkspace(root),
  },
  {
    version: "0.0.35",
    description: "collapse each day's runs into logs/<date>/{runs.jsonl,runs.md}",
    apply: async ({ root }) => collapseLogsIntoDayFiles(root),
  },
  {
    version: "0.3.0",
    description: "move shelved requirements into requirements/archive/",
    apply: async ({ root }) => shelveArchivedRequirements(root),
  },
];

/**
 * 0.3.0 — the directory a requirement sits in now follows its status.
 *
 * Existing workspaces have `rejected` requirements in `requirements/` from before
 * that rule existed, and leaving them there is the noise the rule exists to remove:
 * `awo req list` reads intake, so they would keep appearing as live work.
 *
 * Reads the frontmatter directly rather than through `intake.ts`. A migration
 * describes a layout that no longer exists, and calling today's helpers is how
 * 0.0.33 left 24 dangling pointers (§9 finding 61) — a later change to what
 * "archived" means must not silently rewrite what this migration did.
 */
async function shelveArchivedRequirements(root: string): Promise<boolean> {
  const SHELVED = new Set(["rejected", "suspended", "cancelled"]);
  const dir = path.join(root, "requirements");
  if (!(await fs.pathExists(dir))) return false;

  const archive = path.join(dir, "archive");
  let moved = false;

  for (const name of (await fs.readdir(dir).catch(() => [])) as string[]) {
    if (!name.endsWith(".md")) continue;
    const from = path.join(dir, name);
    const text = await fs.readFile(from, "utf8").catch(() => "");
    const status = /^status:\s*"?([a-z-]+)"?\s*$/m.exec(text)?.[1];
    if (!status || !SHELVED.has(status)) continue;

    await fs.ensureDir(archive);
    await fs.move(from, path.join(archive, name), { overwrite: true });

    // Assets travel with the document that links them, or its relative links break.
    const id = name.replace(/\.md$/, "");
    const assets = path.join(dir, `${id}-assets`);
    if (await fs.pathExists(assets)) {
      await fs.move(assets, path.join(archive, `${id}-assets`), { overwrite: true }).catch(
        () => undefined
      );
    }
    moved = true;
  }

  return moved;
}

/**
 * 0.0.35 — every earlier log layout collapses into two files per day.
 *
 * Deliberately reads the filesystem directly instead of calling runs.ts helpers.
 * The previous three migrations called them, and when the helpers' meaning changed
 * those migrations silently started moving files to the *new* locations — which is
 * how 0.0.33 left 24 index pointers dangling (§9 finding 61). A migration describes
 * a layout that no longer exists; it has to spell that layout out itself.
 *
 * Handles, in order of precedence:
 *   0.0.33/34  logs/<date>/<slot>/<time>/{record.md,events.jsonl,worker.log}
 *   0.0.32     logs/<slot>/<stamp>/{...}
 *   pre-0.0.32 logs/runs/<date>/<runId>.{md,events.jsonl,worker.log}
 * plus the run rows in logs/index.jsonl or logs/runs.jsonl.
 */
async function collapseLogsIntoDayFiles(root: string): Promise<boolean> {
  const logs = path.join(root, "logs");
  if (!(await fs.pathExists(logs))) return false;

  const isDate = (n: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(n);
  const dirs = async (p: string): Promise<string[]> =>
    (await fs.readdir(p, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

  /** Everything found on disk, keyed by runId. */
  const found = new Map<string, { events: string; detail: string; worker: string }>();
  const remove: string[] = [];
  const put = (runId: string, part: "events" | "detail" | "worker", file: string): void => {
    const at = found.get(runId) ?? { events: "", detail: "", worker: "" };
    if (!at[part]) at[part] = file;
    found.set(runId, at);
  };

  // 0.0.33/34 and 0.0.32 both nest run directories; tell them apart by whether the
  // top-level name is a date.
  for (const top of await dirs(logs)) {
    if (top === "workers") continue;
    if (isDate(top) && (await fs.pathExists(path.join(logs, top, "runs.jsonl")))) continue;

    const level1 = path.join(logs, top);
    for (const mid of await dirs(level1)) {
      const level2 = path.join(level1, mid);
      const inner = await dirs(level2);
      if (isDate(top)) {
        // <date>/<slot>/<time>/ — note the day directory is also where the new
        // files go, so only the slot directory beneath it may be removed. Removing
        // level1 here deleted the runs.jsonl and runs.md just written into it.
        for (const time of inner.length > 0 ? inner : []) {
          collect(path.join(level2, time), `${top}T${time}_${mid.replace(/^_/, "")}`);
        }
        if (inner.length === 0) collect(level2, `${top}T00-00-00_${mid.replace(/^_/, "")}`);
        remove.push(level2);
        continue;
      } else if (top === "runs") {
        // pre-0.0.32 files sit directly in runs/<date>/
        continue;
      } else {
        // <slot>/<stamp>/
        collect(level2, `${mid}_${top.replace(/^_/, "")}`);
      }
    }
    if (!isDate(top)) remove.push(level1);
  }

  // pre-0.0.32: runs/<date>/<runId>.<ext>
  const flat = path.join(logs, "runs");
  for (const date of await dirs(flat)) {
    for (const name of await fs.readdir(path.join(flat, date)).catch(() => [])) {
      const runId = name.replace(/\.events\.jsonl$|\.worker\.log$|\.md$/, "");
      const file = path.join(flat, date, name);
      put(runId, name.endsWith(".events.jsonl") ? "events" : name.endsWith(".worker.log") ? "worker" : "detail", file);
    }
  }
  if (await fs.pathExists(flat)) remove.push(flat);

  function collect(dir: string, runId: string): void {
    for (const [name, part] of [
      ["events.jsonl", "events"],
      ["record.md", "detail"],
      ["brief.md", "detail"],
      ["worker.log", "worker"],
    ] as const) {
      put(runId, part, path.join(dir, name));
    }
  }

  // Run rows, from whichever global index this workspace has.
  const rows = new Map<string, RunIndexEntry>();
  for (const name of ["index.jsonl", "runs.jsonl"]) {
    const file = path.join(logs, name);
    if (!(await fs.pathExists(file))) continue;
    for (const line of (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim())) {
      const row = JSON.parse(line) as RunIndexEntry;
      rows.set(row.runId, row);
    }
    remove.push(file);
  }

  if (found.size === 0 && rows.size === 0) return false;

  // Write in runId order so each day's files read chronologically.
  for (const runId of [...new Set([...rows.keys(), ...found.keys()])].sort()) {
    const at = found.get(runId);

    for (const line of at && (await fs.pathExists(at.events))
      ? (await fs.readFile(at!.events, "utf8")).split("\n").filter((l) => l.trim())
      : []) {
      const e = JSON.parse(line) as RunEvent;
      const { t: _t, kind, ...rest } = e;
      await appendEvent(root, runId, kind as EventKind, rest);
    }

    const detail = at && (await fs.pathExists(at.detail)) ? await fs.readFile(at.detail, "utf8") : "";
    const row = rows.get(runId);
    if (detail || row) {
      await writeDetail(
        root,
        runId,
        {
          status: row?.status ?? "migrated",
          agent: row?.agent ?? null,
          model: row?.model,
          tier: row?.tier,
          effort: row?.effort,
          repos: row?.reposChanged ?? [],
        },
        { summary: detail || "_record not found on disk_" }
      );
    }
    if (row) await appendIndex(root, { ...row, detailFile: path.join(runSlot(runId).date, "runs.md") });

    if (at && at.worker && (await fs.pathExists(at.worker))) {
      const { date, slot, time } = runSlot(runId);
      const to = path.join(logs, date, "workers", `${time}-${slot}.log`);
      await fs.ensureDir(path.dirname(to));
      await fs.move(at.worker, to, { overwrite: true });
    }
  }

  for (const target of remove) await fs.remove(target);
  return true;
}

/**
 * The 0.0.32 layout change, as a migration rather than file reconciliation because
 * it MOVES user content — which reconciliation is forbidden to touch (§11.2).
 *
 * Everything here is idempotent and additive-then-move: nothing is deleted that
 * has not first been copied, so a half-finished migration re-runs cleanly.
 */
async function restructureWorkspace(root: string): Promise<boolean> {
  let changed = false;

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
  /** Template changes merged into a file you had edited, with no conflict. */
  mergedFiles: string[];
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
    const newHash = hashForLock(rendered);
    const lockHash = lock?.files[rel];

    if (!(await fs.pathExists(onDisk))) {
      // Deletion is a choice; §11.2 says leave it deleted.
      plans.push({ path: rel, action: lockHash ? "user-deleted" : "add" });
      continue;
    }

    const currentHash = hashForLock(await fs.readFile(onDisk));

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
    mergedFiles: [],
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
  const mergedFiles: string[] = [];
  let touchedAnything = false;

  for (const file of plan.files) {
    if (!CHANGED_ACTIONS.has(file.action)) continue;

    const onDisk = path.join(root, ...file.path.split("/"));
    const rendered = renderTemplate(
      await fs.readFile(templateSourcePath(file.path), "utf8"),
      { projectKey: manifest.projectKey }
    );

    if (file.action === "conflict") {
      // §17.2 — try a three-way merge before asking. Two-way comparison cannot tell
      // "the user added a line" from "the template changed a line", so any edit at
      // all used to mean a conflict file on every upgrade thereafter.
      const ours = await fs.readFile(onDisk, "utf8");
      const base = (await fs.readFile(basePath(root, file.path), "utf8").catch(() => null)) as
        | string
        | null;
      const outcome = await threeWayMerge(ours, base, rendered);

      if (outcome.merged !== null && outcome.conflicts === 0) {
        await fs.ensureDir(path.dirname(path.join(backupDir, file.path)));
        await fs.copy(onDisk, path.join(backupDir, file.path));
        await fs.writeFile(onDisk, outcome.merged, "utf8");
        await recordBase(root, file.path, rendered);
        mergedFiles.push(file.path);
        touchedAnything = true;
        continue;
      }

      // Genuinely overlapping, or no base to merge from. Never overwrite; write the
      // new version alongside and let `awo resolve` deal with it.
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
    // Whatever the template said this time is the base for next time.
    await recordBase(root, file.path, rendered);
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

  // Derived artifacts are regenerated on every upgrade, unconditionally.
  //
  // The .code-workspace is generated from the manifest but was only rewritten by
  // add/connect/remove/sync — so when 0.0.38 changed WHERE its settings have to live,
  // an upgraded workspace kept a stale file and Git Graph still saw nothing until
  // someone happened to run `awo sync`. A fix nobody receives is not a fix.
  await regenerateCodeWorkspace(root);
  await refreshManagedBlocks(root);

  return {
    ...plan,
    unreviewable: !isRepo,
    applied: true,
    backupDir: touchedAnything && (await fs.pathExists(backupDir)) ? path.relative(root, backupDir) : null,
    conflictFiles,
    mergedFiles,
    migrationsRun,
  };
}
