import fs from "fs-extra";
import path from "path";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, writeManifest, type RepoEntry } from "../manifest.js";

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

/**
 * §16.8 — declare how a repo verifies itself, once.
 *
 * `awo task event --run "<cmd>"` and `awo task recheck` both need a command, and
 * `testCommand` was read from the manifest but settable only by hand-editing it. So
 * in practice every measurement carried its command inline, which means each agent
 * invented one — and an agent choosing the verification command is the same failure
 * as an agent asserting the result.
 */
export async function runSetTestCommand(
  name: string,
  command: string | undefined,
  options: { cwd?: string } = {}
): Promise<{ name: string; testCommand: string | null }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  const repo = manifest.repos.find((r) => r.name === name);
  if (!repo) {
    throw new Error(
      manifest.repos.length > 0
        ? `No repo "${name}". Linked: ${manifest.repos.map((r) => r.name).join(", ")}.`
        : `No repo "${name}". Link one with \`awo connect <path>\` or \`awo add <url>\`.`
    );
  }

  if (command === undefined) return { name, testCommand: repo.testCommand ?? null };

  if (command.trim() === "") delete repo.testCommand;
  else repo.testCommand = command.trim();
  await writeManifest(root, manifest);
  return { name, testCommand: repo.testCommand ?? null };
}
