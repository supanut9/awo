import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, writeManifest, type GitRepoEntry } from "../manifest.js";
import { regenerateCodeWorkspace } from "../vscode-workspace.js";

export interface AddOptions {
  url: string;
  ref?: string;
  name?: string;
  cwd?: string;
}

function deriveName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "");
}

export async function runAdd(options: AddOptions): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const name = options.name ?? deriveName(options.url);
  const manifest = await readManifest(workspaceRoot);

  if (manifest.repos.some((r) => r.name === name)) {
    throw new Error(
      `A repo named "${name}" is already registered. Use --name to pick a different one, or \`awo remove ${name}\` first.`
    );
  }

  const targetPath = path.join(workspaceRoot, "repos", name);
  if (await fs.pathExists(targetPath)) {
    throw new Error(
      `${targetPath} already exists. Remove it (or run \`awo remove ${name}\`) before adding.`
    );
  }

  const cloneArgs = options.ref ? ["--branch", options.ref] : [];
  await simpleGit().clone(options.url, targetPath, cloneArgs);

  const ref = options.ref ?? (await simpleGit(targetPath).revparse(["--abbrev-ref", "HEAD"])).trim();

  const entry: GitRepoEntry = { name, type: "git", url: options.url, ref };
  manifest.repos.push(entry);
  await writeManifest(workspaceRoot, manifest);
  await regenerateCodeWorkspace(workspaceRoot);
}
