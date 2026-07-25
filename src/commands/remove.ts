import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, writeManifest } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";

export interface RemoveOptions {
  name: string;
  cwd?: string;
}

export async function runRemove(options: RemoveOptions): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);

  const exists = manifest.repos.some((r) => r.name === options.name);
  if (!exists) {
    throw new Error(`No repo named "${options.name}" is registered.`);
  }

  manifest.repos = manifest.repos.filter((r) => r.name !== options.name);
  await writeManifest(workspaceRoot, manifest);
  await regenerateCodeWorkspace(workspaceRoot);

  const linkPath = path.join(workspaceRoot, "repos", options.name);
  await fs.remove(linkPath);
}
