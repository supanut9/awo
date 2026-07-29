import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { refreshManagedBlocks } from "../managed-blocks.js";

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
  // The AGENTS.md list is generated from the directory, so installing something is
  // the whole of installing it — no line to add, and nothing to forget.
  await refreshManagedBlocks(root);
  return { name, file: path.relative(root, target) };
}


/**
 * §17 — scaffold a rule of your own.
 *
 * The point of this command is what it does NOT ask you to do: there is no list to
 * register the rule in. AGENTS.md's always-on rules are generated from this
 * directory, so the file being here IS the registration.
 */
export async function runRuleNew(
  id: string,
  options: { cwd?: string; summary: string; severity?: string; appliesTo?: string }
): Promise<{ id: string; file: string }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Rule id must be kebab-case letters, digits and dashes; got "${id}".`);
  }

  const file = path.join(root, "rules", `${id}.md`);
  if (await fs.pathExists(file)) {
    throw new Error(`rules/${id}.md already exists.`);
  }

  const severity = options.severity ?? "required";
  if (!["required", "recommended"].includes(severity)) {
    throw new Error(`--severity must be required or recommended; got "${severity}".`);
  }
  const appliesTo = (options.appliesTo ?? "all")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const body = [
    "---",
    `id: ${id}`,
    `name: ${id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}`,
    `appliesTo: [${appliesTo.join(", ")}]`,
    `severity: ${severity}`,
    `summary: ${/[:#]/.test(options.summary) ? JSON.stringify(options.summary) : options.summary}`,
    "---",
    "",
    "_State the policy here: what an agent must or must not do, and why._",
    "",
    "_A rule an agent cannot check itself against is a suggestion. Where possible say",
    "how compliance is verified — a command, a file that must exist, a log event._",
    "",
  ].join("\n");

  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, body);
  await refreshManagedBlocks(root);

  return { id, file: path.relative(root, file) };
}
