import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";

export type CatalogKind = "agent" | "skill";

const DIRS: Record<CatalogKind, { from: string; to: string }> = {
  agent: { from: path.join("catalog", "agents"), to: "agents" },
  skill: { from: path.join("catalog", "skills"), to: "skills" },
};

/**
 * §7.1 — the catalog ships with the workspace but is not installed. Installing
 * meant copying files by hand, which agents duly improvised (§9 item 14) and
 * which silently cost quality: with `data-engineer` uninstalled, a planner had
 * no role for schema work and assigned it to a low-tier implementer instead
 * (§9 item 33).
 */
export async function runCatalogList(
  kind: CatalogKind,
  options: { cwd?: string } = {}
): Promise<{ available: string[]; installed: string[] }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { from, to } = DIRS[kind];

  const read = async (dir: string): Promise<string[]> =>
    (await fs.readdir(path.join(root, dir)).catch(() => []))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();

  const installed = await read(to);
  const available = (await read(from)).filter((n) => !installed.includes(n));
  return { available, installed };
}

export async function runCatalogAdd(
  kind: CatalogKind,
  name: string,
  options: { cwd?: string } = {}
): Promise<{ name: string; file: string }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { from, to } = DIRS[kind];

  const source = path.join(root, from, `${name}.md`);
  const target = path.join(root, to, `${name}.md`);

  if (!(await fs.pathExists(source))) {
    const { available } = await runCatalogList(kind, options);
    throw new Error(
      available.length > 0
        ? `No ${kind} "${name}" in the catalog. Available: ${available.join(", ")}.`
        : `No ${kind} "${name}" in the catalog, and nothing else is left to install.`
    );
  }
  if (await fs.pathExists(target)) {
    throw new Error(`${kind} "${name}" is already installed at ${path.relative(root, target)}.`);
  }

  await fs.ensureDir(path.dirname(target));
  await fs.copy(source, target);
  return { name, file: path.relative(root, target) };
}
