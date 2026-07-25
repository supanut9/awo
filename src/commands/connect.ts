import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, writeManifest, type LocalRepoEntry } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";

export interface ConnectOptions {
  path: string;
  name?: string;
  cwd?: string;
}

export async function runConnect(options: ConnectOptions): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const inputPath = path.resolve(options.path);

  // Resolved to the real path (not just made absolute) so the manifest and
  // the generated *.code-workspace never route through an OS-level symlink
  // (e.g. macOS's /tmp -> /private/tmp) on top of our own repos/<name> one.
  let sourcePath: string;
  try {
    sourcePath = await fs.realpath(inputPath);
  } catch {
    throw new Error(`Path does not exist: ${inputPath}`);
  }
  if (!(await fs.stat(sourcePath)).isDirectory()) {
    throw new Error(`Not a directory: ${sourcePath}`);
  }

  const name = options.name ?? path.basename(sourcePath);
  const manifest = await readManifest(workspaceRoot);

  if (manifest.repos.some((r) => r.name === name)) {
    throw new Error(
      `A repo named "${name}" is already registered. Use --name to pick a different one, or \`awo remove ${name}\` first.`
    );
  }

  const linkPath = path.join(workspaceRoot, "repos", name);
  if (await fs.pathExists(linkPath)) {
    throw new Error(
      `${linkPath} already exists. Remove it (or run \`awo remove ${name}\`) before connecting.`
    );
  }

  await fs.symlink(sourcePath, linkPath, "dir");

  const entry: LocalRepoEntry = { name, type: "local", path: sourcePath };
  manifest.repos.push(entry);
  await writeManifest(workspaceRoot, manifest);
  await regenerateCodeWorkspace(workspaceRoot);
}
