import fs from "fs-extra";
import path from "path";
function manifestPath(workspaceRoot) {
    return path.join(workspaceRoot, ".workspace", "manifest.json");
}
export async function readManifest(workspaceRoot) {
    const file = manifestPath(workspaceRoot);
    let raw;
    try {
        raw = await fs.readJson(file);
    }
    catch (err) {
        throw new Error(`Could not read ${file}: ${err.message}`);
    }
    const manifest = raw;
    if (typeof manifest.projectKey !== "string" ||
        typeof manifest.libraryVersion !== "string" ||
        !Array.isArray(manifest.repos)) {
        throw new Error(`${file} is malformed — missing projectKey, libraryVersion, or repos.`);
    }
    return manifest;
}
export async function writeManifest(workspaceRoot, manifest) {
    await fs.writeJson(manifestPath(workspaceRoot), manifest, { spaces: 2 });
}
