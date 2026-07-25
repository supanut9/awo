import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, type RepoEntry } from "../manifest.js";

export type RepoStatus = "missing" | "present" | "dirty";

export interface RepoStatusEntry {
  name: string;
  type: RepoEntry["type"];
  status: RepoStatus;
}

export async function runList(options: { cwd?: string } = {}): Promise<RepoStatusEntry[]> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(workspaceRoot);

  const results: RepoStatusEntry[] = [];
  for (const repo of manifest.repos) {
    const linkPath = path.join(workspaceRoot, "repos", repo.name);
    const exists = await fs.pathExists(linkPath);

    if (!exists) {
      results.push({ name: repo.name, type: repo.type, status: "missing" });
      continue;
    }

    if (repo.type === "git") {
      const status = await simpleGit(linkPath).status();
      results.push({
        name: repo.name,
        type: repo.type,
        status: status.isClean() ? "present" : "dirty",
      });
    } else {
      results.push({ name: repo.name, type: repo.type, status: "present" });
    }
  }
  return results;
}
