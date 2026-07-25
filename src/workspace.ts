import fs from "fs";
import path from "path";

/**
 * Walks up from `from` looking for a `.workspace/` directory, mirroring how
 * git locates `.git/`. Never falls back to `$HOME` or any global path.
 */
export function findWorkspaceRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(dir, ".workspace"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Not inside an awo workspace");
    dir = parent;
  }
}
