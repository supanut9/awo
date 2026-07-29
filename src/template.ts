import fs from "fs-extra";
import path from "path";
import { createHash } from "crypto";
import { stripManagedBlocks } from "./managed-blocks.js";
import { fileURLToPath } from "url";

// dist/template.js -> package root is one level up.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "templates", "default");

export const TOKENS = {
  projectKey: "{{PROJECT_KEY}}",
  createdAt: "{{CREATED_AT}}",
  libraryVersion: "{{LIBRARY_VERSION}}",
  workspaceId: "{{WORKSPACE_ID}}",
} as const;

export interface TemplateValues {
  projectKey: string;
  createdAt?: string;
  libraryVersion?: string;
  workspaceId?: string;
}

export function readLibraryVersion(): string {
  const pkg = fs.readJsonSync(path.join(PACKAGE_ROOT, "package.json")) as { version: string };
  return pkg.version;
}

export function renderTemplate(content: string, values: TemplateValues): string {
  let out = content.split(TOKENS.projectKey).join(values.projectKey);
  if (values.createdAt !== undefined) out = out.split(TOKENS.createdAt).join(values.createdAt);
  if (values.libraryVersion !== undefined)
    out = out.split(TOKENS.libraryVersion).join(values.libraryVersion);
  if (values.workspaceId !== undefined)
    out = out.split(TOKENS.workspaceId).join(values.workspaceId);
  return out;
}

/**
 * `.gitignore` ships un-dotted as `gitignore` so npm's pack pruning can't drop
 * it (see init). Everything else keeps its path.
 */
export function toWorkspacePath(templateRelPath: string): string {
  return templateRelPath === "gitignore" ? ".gitignore" : templateRelPath;
}

export function hashContent(content: string | Buffer): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * The hash `template.lock` and `awo upgrade` compare on.
 *
 * Generated blocks are emptied first, so a workspace that installed an agent from
 * the catalog does not read as "user-edited" and start earning a conflict file on
 * every upgrade — which is the problem generated blocks exist to remove.
 */
export function hashForLock(content: string | Buffer): string {
  return hashContent(stripManagedBlocks(content.toString()));
}

export async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Workspace-relative paths of every file the template lays down, POSIX-style. */
export async function templateFiles(): Promise<string[]> {
  const files = await walkFiles(TEMPLATE_DIR);
  return files
    .map((f) => toWorkspacePath(path.relative(TEMPLATE_DIR, f).split(path.sep).join("/")))
    .sort();
}

export function templateSourcePath(workspaceRelPath: string): string {
  const rel = workspaceRelPath === ".gitignore" ? "gitignore" : workspaceRelPath;
  return path.join(TEMPLATE_DIR, ...rel.split("/"));
}

export interface TemplateLock {
  libraryVersion: string;
  files: Record<string, string>;
}

export function lockPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".workspace", "template.lock");
}

export async function readLock(workspaceRoot: string): Promise<TemplateLock | null> {
  const file = lockPath(workspaceRoot);
  if (!(await fs.pathExists(file))) return null;
  return (await fs.readJson(file)) as TemplateLock;
}

export async function writeLock(workspaceRoot: string, lock: TemplateLock): Promise<void> {
  await fs.writeJson(lockPath(workspaceRoot), lock, { spaces: 2 });
}

/** Files whose content is per-workspace, so their baseline comes from disk. */
const PER_WORKSPACE = new Set([".workspace/manifest.json"]);

/**
 * §11.2 — the baseline a later upgrade reconciles against: **what this version
 * of the template provides**, not what happens to be on disk.
 *
 * That distinction is load-bearing. Recording the on-disk content would make a
 * user's edits the new baseline, so the *next* upgrade would classify their
 * customized file as unmodified and overwrite it. Recording the template's
 * content instead means an unmerged edit stays visible as "user-edited" and is
 * left alone (§11.2's third case).
 */
export async function buildLock(
  workspaceRoot: string,
  projectKey: string,
  libraryVersion: string
): Promise<TemplateLock> {
  const files: Record<string, string> = {};
  for (const rel of await templateFiles()) {
    if (PER_WORKSPACE.has(rel)) {
      const onDisk = path.join(workspaceRoot, ...rel.split("/"));
      if (await fs.pathExists(onDisk)) files[rel] = hashForLock(await fs.readFile(onDisk));
      continue;
    }
    const rendered = renderTemplate(await fs.readFile(templateSourcePath(rel), "utf8"), {
      projectKey,
    });
    files[rel] = hashForLock(rendered);
  }
  return { libraryVersion, files };
}
