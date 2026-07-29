import fs from "fs-extra";
import path from "path";
import { v7 as uuidv7 } from "uuid";
import { refreshManagedBlocks } from "../managed-blocks.js";
import { recordBase } from "./resolve.js";
import { readManifest, writeManifest } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";
import {
  TEMPLATE_DIR,
  buildLock,
  readLibraryVersion,
  renderTemplate,
  templateFiles,
  templateSourcePath,
  toWorkspacePath,
  walkFiles,
  writeLock,
} from "../template.js";

// §5: "short, permanent project code (uppercase, 2-5 chars)" — Jira-key
// semantics, so digits after an initial letter are allowed (e.g. AB12).
const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;

export interface InitOptions {
  key: string;
  cwd?: string;
  /**
   * Adopt a directory that already holds a project.
   *
   * The empty-directory rule was right for a greenfield hub and wrong for every
   * real adoption. A project that has been worked on for months already HAS a hub:
   * symlinked repos, a CLAUDE.md with the rules people actually follow, and a pile
   * of decision docs. Telling that user to start somewhere else means either
   * abandoning that material or maintaining two hubs.
   *
   * So `--adopt` adds awo to what is there: every file that already exists is left
   * untouched and reported, and existing repos are discovered rather than re-linked
   * by hand.
   */
  adopt?: boolean;
}

export interface InitResult {
  /** Template files skipped because the workspace already had them. */
  kept: string[];
  /** Repos discovered and registered during an adopt. */
  adoptedRepos: { name: string; path: string }[];
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const { key } = options;
  const targetDir = path.resolve(options.cwd ?? process.cwd());

  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid --key "${key}": must be 2-5 uppercase chars, starting with a letter (e.g. PROM, AB12).`
    );
  }

  if (!(await fs.pathExists(TEMPLATE_DIR))) {
    throw new Error(
      `Template directory missing at ${TEMPLATE_DIR}. This is a broken awo install.`
    );
  }

  const existing = await fs.readdir(targetDir).catch(() => []);
  if (await fs.pathExists(path.join(targetDir, ".workspace", "manifest.json"))) {
    throw new Error(
      `${targetDir} is already an awo workspace. To bring it up to date: \`awo upgrade\`.`
    );
  }
  if (existing.length > 0 && !options.adopt) {
    throw new Error(
      `Target directory ${targetDir} is not empty.\n` +
        `  For an empty hub:            run \`awo init\` in an empty directory\n` +
        `  To add awo to this project:  awo init --key ${key} --adopt\n` +
        `  (--adopt writes only what is missing, keeps every file you already have,\n` +
        `   and registers repos it finds instead of asking you to link them again)`
    );
  }

  const kept: string[] = [];
  if (options.adopt) {
    // File by file, so an existing file is never a casualty of adopting. fs.copy's
    // overwrite:false throws on the first collision rather than skipping it, which
    // would leave a half-scaffolded workspace.
    for (const rel of await templateFiles()) {
      const from = templateSourcePath(rel);
      const to = path.join(targetDir, ...toWorkspacePath(rel).split("/"));
      if (await fs.pathExists(to)) {
        kept.push(toWorkspacePath(rel));
        continue;
      }
      await fs.ensureDir(path.dirname(to));
      await fs.copy(from, to);
    }
  } else {
    await fs.copy(TEMPLATE_DIR, targetDir);
  }

  // Shipped un-dotted so npm's gitignore-based pack pruning can't drop it
  // (or the files it excludes, like repos/.gitkeep) from the published tarball.
  // The adopt path already writes it through toWorkspacePath(), so there is nothing
  // un-dotted left to move — and moving a file that isn't there aborted the whole
  // adopt half-done.
  const undotted = path.join(targetDir, "gitignore");
  if (await fs.pathExists(undotted)) {
    await fs.move(undotted, path.join(targetDir, ".gitignore"), { overwrite: false });
  }

  const libraryVersion = readLibraryVersion();
  const values = {
    projectKey: key,
    createdAt: new Date().toISOString(),
    libraryVersion,
    // §5: machine identity, permanent, distinct from the human-facing
    // projectKey (which is only unique across ONE user's projects).
    // uuid v7, not v4 — the timestamp prefix makes it k-sortable, so a remote
    // store indexes it without a hot random shard (§7.6).
    workspaceId: uuidv7(),
  };

  for (const file of await walkFiles(targetDir)) {
    const original = await fs.readFile(file, "utf8");
    const updated = renderTemplate(original, values);
    if (updated !== original) await fs.writeFile(file, updated, "utf8");
  }

  // §17 — generate the rules/skills/agents lists from what was actually laid down,
  // so they are correct by construction rather than by someone remembering.
  await refreshManagedBlocks(targetDir);

  // §17.2 — keep the pristine rendered template. A later upgrade needs this third
  // point to merge template changes around your edits instead of asking about both.
  for (const rel of await templateFiles()) {
    const onDisk = path.join(targetDir, ...toWorkspacePath(rel).split("/"));
    if (await fs.pathExists(onDisk)) {
      await recordBase(targetDir, toWorkspacePath(rel), renderTemplate(
        await fs.readFile(templateSourcePath(rel), "utf8"),
        values
      ));
    }
  }

  // §11.2 — the baseline a later `awo upgrade` reconciles against.
  await writeLock(targetDir, await buildLock(targetDir, key, libraryVersion));

  const adoptedRepos = options.adopt ? await adoptExistingRepos(targetDir) : [];
  return { kept, adoptedRepos };
}

/**
 * Register repos the project already has.
 *
 * A hand-rolled hub links its repos as symlinks at the top level — which is exactly
 * what `awo connect` does, one directory deeper. So adopting means moving those
 * links under `repos/`, not asking anyone to re-link nine repos by name.
 *
 * Nothing is deleted: a symlink is moved (same target), and a real checkout sitting
 * inside the hub is linked to rather than relocated, because moving someone's actual
 * code is not a thing an adopt command should do.
 */
async function adoptExistingRepos(root: string): Promise<{ name: string; path: string }[]> {
  const skip = new Set([
    "repos", "logs", "goals", "requirements", "agents", "rules", "skills",
    "instructions", "catalog", ".workspace", ".vscode", ".git", "node_modules",
  ]);
  const found: { name: string; path: string }[] = [];

  for (const name of await fs.readdir(root)) {
    if (skip.has(name) || name.startsWith(".")) continue;

    const entry = path.join(root, name);
    const stat = await fs.lstat(entry).catch(() => null);
    if (!stat) continue;

    const isLink = stat.isSymbolicLink();
    if (!isLink && !stat.isDirectory()) continue;

    const real = isLink ? path.resolve(path.dirname(entry), await fs.readlink(entry)) : entry;
    if (!(await fs.pathExists(path.join(real, ".git")))) continue;

    const target = path.join(root, "repos", name);
    if (await fs.pathExists(target)) continue;

    await fs.ensureDir(path.join(root, "repos"));
    if (isLink) {
      await fs.remove(entry);
      await fs.ensureSymlink(real, target, "dir");
    } else {
      await fs.ensureSymlink(real, target, "dir");
    }
    found.push({ name, path: real });
  }

  if (found.length > 0) {
    const manifest = await readManifest(root);
    manifest.repos = [
      ...manifest.repos,
      ...found.map((r) => ({ name: r.name, type: "local" as const, path: r.path })),
    ];
    await writeManifest(root, manifest);
    await regenerateCodeWorkspace(root);
  }
  return found;
}
