import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { refreshManagedBlocks } from "../managed-blocks.js";
import { readManifest } from "../manifest.js";
import { findAllTasks } from "../tasks.js";
import { readAgentSkills } from "../agent-skills.js";
import {
  hashForLock,
  readLock,
  renderTemplate,
  templateFiles,
  templateSourcePath,
  writeLock,
} from "../template.js";

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

/** What `remove` can take out: installed roles, awo skills, and rules. */
export type RemovableKind = CatalogKind | "rule";

const INSTALLED_DIR: Record<RemovableKind, string> = { agent: "agents", skill: "skills", rule: "rules" };

export interface CatalogReference {
  /** Workspace-relative file. */
  file: string;
  /** Where in it: a frontmatter field or a line number. */
  detail: string;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** The name as a whole token, so `run-tests` never matches `run-tests-e2e`. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}

async function frontmatterOf(file: string): Promise<Record<string, unknown> | null> {
  try {
    return matter(await fs.readFile(file, "utf8")).data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Everything that would dangle if `name` disappeared.
 *
 * Deleting a rule file is easy; finding the three agents whose `rules:` still name
 * it is the part people skip, and a role that cites a missing rule reads as if the
 * rule applies while nothing enforces it.
 */
export async function findCatalogReferences(
  root: string,
  kind: RemovableKind,
  name: string
): Promise<CatalogReference[]> {
  const refs: CatalogReference[] = [];

  for (const file of (await fs.readdir(path.join(root, "agents")).catch(() => [] as string[])).sort()) {
    if (!file.endsWith(".md") || (kind === "agent" && file === `${name}.md`)) continue;
    const data = await frontmatterOf(path.join(root, "agents", file));
    if (!data) continue;
    const fields: string[] =
      kind === "skill" ? ["skills"] : kind === "rule" ? ["rules"] : ["reportsTo", "delegatesTo", "reviews"];
    for (const field of fields) {
      if (asList(data[field]).includes(name)) refs.push({ file: `agents/${file}`, detail: `${field}: ${name}` });
    }
  }

  if (kind === "rule") {
    for (const file of (await fs.readdir(path.join(root, "skills")).catch(() => [] as string[])).sort()) {
      if (!file.endsWith(".md")) continue;
      const data = await frontmatterOf(path.join(root, "skills", file));
      const requires = data?.requires as Record<string, unknown> | undefined;
      if (requires && asList(requires.rules).includes(name)) {
        refs.push({ file: `skills/${file}`, detail: `requires.rules: ${name}` });
      }
    }
  }

  if (kind === "agent") {
    // Live goals only: an archived task naming a retired role is history, not a
    // dependency, and refusing over it would make a role impossible to retire.
    for (const { task, goal } of await findAllTasks(root)) {
      if (goal.archived || task.agent !== name) continue;
      refs.push({ file: path.relative(root, task.file), detail: `agent: ${name}` });
    }
  }

  // AGENTS.md prose outside the generated blocks — those are regenerated below and
  // are the one place a mention is expected.
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => "");
  let generated = false;
  for (const [i, line] of agents.split("\n").entries()) {
    if (line.includes("<!-- awo:generated")) generated = true;
    const closes = line.includes("<!-- /awo:generated -->");
    if (!generated && mentions(line, name)) refs.push({ file: "AGENTS.md", detail: `line ${i + 1}` });
    if (closes) generated = false;
  }

  return refs;
}

export interface CatalogRemoveResult {
  name: string;
  file: string;
  /** References left dangling because `--force` was given. */
  references: CatalogReference[];
  /** Set when the catalog still ships it, so it can be reinstalled. */
  reinstall: string | null;
}

/**
 * The counterpart to `agent add` / `rule new`: take an agent, skill or rule out,
 * and leave nothing pointing at it.
 *
 * Without it the only way to retire a role was `rm agents/<name>.md` by hand, which
 * left AGENTS.md's generated list stale until some later command refreshed it and
 * left every reference dangling.
 */
export async function runCatalogRemove(
  kind: RemovableKind,
  name: string,
  options: { cwd?: string; force?: boolean } = {}
): Promise<CatalogRemoveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new Error(`"${name}" is not a valid ${kind} name.`);
  }

  const dir = INSTALLED_DIR[kind];
  const rel = `${dir}/${name}.md`;
  const file = path.join(root, dir, `${name}.md`);
  if (!(await fs.pathExists(file))) {
    const installed = (await fs.readdir(path.join(root, dir)).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    const external =
      kind === "skill" &&
      (await readAgentSkills(root).catch(() => [])).some((s) => s.name === name || s.skills.includes(name));
    throw new Error(
      external
        ? `"${name}" is an external agent skill, not an awo skill — it is declared in .workspace/agent-skills.json; remove it there.`
        : `No ${kind} "${name}" at ${rel}. Installed: ${installed.join(", ") || "none"}.`
    );
  }

  const references = await findCatalogReferences(root, kind, name);
  if (references.length > 0 && !options.force) {
    throw new Error(
      `${kind} "${name}" is still referenced:\n` +
        references.map((r) => `  - ${r.file}: ${r.detail}`).join("\n") +
        `\nRemove those references first, or delete it anyway (they will dangle):\n` +
        `  awo ${kind} remove ${name} --force`
    );
  }

  // A template-shipped file must read as deleted-by-you to the next `awo upgrade`,
  // or it comes straight back. Upgrade already treats a missing file with a lock
  // entry as a deliberate deletion; make sure the entry is there.
  const lock = await readLock(root);
  if (lock && lock.files[rel] === undefined && (await templateFiles()).includes(rel)) {
    const { projectKey } = await readManifest(root);
    lock.files[rel] = hashForLock(renderTemplate(await fs.readFile(templateSourcePath(rel), "utf8"), { projectKey }));
    await writeLock(root, lock);
  }

  await fs.remove(file);
  // AGENTS.md's lists are generated from the directory, so removing the file IS the
  // unregistration — refresh them now rather than leave a stale line behind.
  await refreshManagedBlocks(root);

  const catalogSource = kind === "rule" ? null : path.join(root, DIRS[kind].from, `${name}.md`);
  return {
    name,
    file: rel,
    references,
    reinstall: catalogSource && (await fs.pathExists(catalogSource)) ? `awo ${kind} add ${name}` : null,
  };
}
