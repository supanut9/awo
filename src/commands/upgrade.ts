import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { v7 as uuidv7 } from "uuid";
import { findWorkspaceRoot } from "../workspace.js";
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
