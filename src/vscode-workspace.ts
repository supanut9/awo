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
}
