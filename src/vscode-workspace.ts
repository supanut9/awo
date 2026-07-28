import fs from "fs-extra";
import path from "path";
import { readManifest } from "./manifest.js";

/**
 * VS Code's git integration (and extensions like Git Graph) reliably detect
 * a repo only when it's its own top-level workspace folder — it doesn't
 * consistently scan nested subfolders, or follow symlinks when it does. A
 * generated multi-root *.code-workspace file — one folder entry per repo —
 * sidesteps the nesting problem. For type:git repos, repos/<name> is a real
 * directory (cloned), so that's used directly. For type:local repos,
 * repos/<name> is a symlink — rather than rely on Git Graph resolving it,
 * point the folder entry straight at the repo's real path (already known,
 * from the manifest), removing the symlink from the equation entirely.
 * This is a derived artifact of the manifest, same as repos/ itself:
 * regenerated on every add/connect/remove, never hand-edited.
 */
export async function regenerateCodeWorkspace(workspaceRoot: string): Promise<void> {
  const manifest = await readManifest(workspaceRoot);

  const folders = [
    { name: manifest.projectKey, path: "." },
    ...manifest.repos.map((r) => ({
      name: r.name,
      path: r.type === "local" ? r.path : `repos/${r.name}`,
    })),
  ];

  const file = path.join(workspaceRoot, `${manifest.projectKey}.code-workspace`);
  await fs.writeJson(file, { folders, settings: {} }, { spaces: 2 });

  await updateScanRepositories(workspaceRoot, manifest.repos.map((r) =>
    r.type === "local" ? r.path : path.join(workspaceRoot, "repos", r.name)
  ));
}

/**
 * `git.autoRepositoryDetection: "subFolders"` scans real subdirectories and
 * does NOT follow symlinks — so `type: "local"` repos, which are symlinks under
 * repos/, stay invisible to the Source Control panel on a plain folder open.
 *
 * `git.scanRepositories` takes explicit paths, so listing each repo's real
 * location fixes detection without forcing a multi-root open (which surfaces
 * every linked repo's own CLAUDE.md/AGENTS.md to agents — see §9 item 20).
 *
 * Note this makes .vscode/settings.json diverge from the shipped template, so
 * `awo upgrade` will treat it as user-edited and leave it alone (§11.2's third
 * case). That is the correct outcome: it is workspace-specific derived state.
 */
async function updateScanRepositories(workspaceRoot: string, repoPaths: string[]): Promise<void> {
  const file = path.join(workspaceRoot, ".vscode", "settings.json");
  const existing = (await fs.readJson(file).catch(() => ({}))) as Record<string, unknown>;

  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(
    file,
    { ...existing, "git.scanRepositories": repoPaths },
    { spaces: 2 }
  );
}
