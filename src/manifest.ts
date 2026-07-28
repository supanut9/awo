import fs from "fs-extra";
import path from "path";

export interface GitRepoEntry {
  name: string;
  type: "git";
  url: string;
  ref: string;
  testCommand?: string;
}

export interface LocalRepoEntry {
  name: string;
  type: "local";
  path: string;
  testCommand?: string;
}

export type RepoEntry = GitRepoEntry | LocalRepoEntry;

export interface ModelChoiceEntry {
  runtime?: string;
  model: string;
}

/** §12 — which runtime+model should do which kind of work. Optional. */
export interface ModelPolicyEntry {
  orchestrator?: ModelChoiceEntry;
  worker?: ModelChoiceEntry;
  byRole?: Record<string, ModelChoiceEntry>;
}

export interface Manifest {
  libraryVersion: string;
  /**
   * Machine identity — uuid v7, generated once at init, permanent and never
   * displayed. Distinct from projectKey, which is human-facing and only unique
   * across one user's projects (§5). Optional on read so workspaces created
   * before this field existed still load.
   */
  workspaceId?: string;
  projectKey: string;
  projectName: string;
  createdAt: string;
  /** §12 — model tiering policy. Absent means built-in defaults apply. */
  models?: ModelPolicyEntry;
  repos: RepoEntry[];
}

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".workspace", "manifest.json");
}

export async function readManifest(workspaceRoot: string): Promise<Manifest> {
  const file = manifestPath(workspaceRoot);
  let raw: unknown;
  try {
    raw = await fs.readJson(file);
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }

  const manifest = raw as Partial<Manifest>;
  if (
    typeof manifest.projectKey !== "string" ||
    typeof manifest.libraryVersion !== "string" ||
    !Array.isArray(manifest.repos)
  ) {
    throw new Error(`${file} is malformed — missing projectKey, libraryVersion, or repos.`);
  }
  return manifest as Manifest;
}

export async function writeManifest(workspaceRoot: string, manifest: Manifest): Promise<void> {
  await fs.writeJson(manifestPath(workspaceRoot), manifest, { spaces: 2 });
}
