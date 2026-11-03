import fs from "fs-extra";
import os from "os";
import path from "path";

/**
 * §7.2 — external agent skills, declared here and installed by the `skills` CLI.
 *
 * awo's own skills are flat markdown in `skills/`, model-agnostic, and read by an
 * agent that was told to read them. The open ecosystem's skills are a different
 * runtime: a directory with a `SKILL.md`, installed under `.claude/skills/`, and
 * surfaced by the harness itself. Both are useful and neither replaces the other.
 *
 * The tempting shortcut is to transcribe an ecosystem skill into awo's format.
 * That loses on every axis: upstream keeps shipping versions we would never see,
 * the `references/` directories that hold the actual payload get dropped (the SEO
 * skill's SKILL.md is an index; `vercel-react-best-practices` is 70 rules in files
 * beside it), a CLI-backed skill like `agent-browser` becomes an inert stub whose
 * real content is served by `agent-browser skills get core`, and we would be
 * redistributing other people's licensed content inside this package.
 *
 * So awo declares and delegates. This file is the declaration — with a tier and,
 * critically, a `summary` written as a trigger condition — and `awo skill sync`
 * shells out to `npx skills add`. Reproducibility is the `skills-lock.json` that
 * CLI already writes; there is no second lockfile to keep honest.
 */

export const AGENT_SKILLS_FILE = path.join(".workspace", "agent-skills.json");

/** `default` installs on sync; `catalog` waits to be named. */
export type SkillTier = "default" | "catalog";

export interface DeclaredSkill {
  /**
   * The entry's name. For a single skill this is also its directory name; for a
   * bundle it is only a label, and `skills` holds the real names.
   */
  name: string;
  /** `owner/repo` or a full GitHub URL, passed straight to `skills add`. */
  source: string;
  tier: SkillTier;
  /**
   * When to reach for it, not what it is. This is the only line that reaches an
   * agent's context, via the generated block in AGENTS.md — the same contract
   * `summary:` has in awo's own skill files, and for the same measured reason.
   */
  summary: string;
  /**
   * The skill names to install, normalised to `[name]` for a plain entry.
   *
   * Bundles exist because some sources are one coherent capability split across
   * many skills — `larksuite/cli` ships 28. Listing those individually would put
   * 28 lines in AGENTS.md for one decision ("we use Lark"), and a list that long
   * stops being read, which is the exact failure this whole block exists to fix.
   */
  skills: string[];
  /** Manual steps the install cannot do — a global npm binary, a credential. */
  requires?: string[];
}

export type InstalledWhere = "workspace" | "user";

/**
 * `partial` is its own state, not a rounding of "installed" or "missing". A bundle
 * with three of its members present behaves like a working setup right up to the
 * moment something reaches for the fourth.
 */
export interface InstallState {
  where: InstalledWhere | "partial" | "absent";
  /** Members not found anywhere. Empty when `where` is workspace or user. */
  missing: string[];
}

export type InstalledMap = Map<string, InstallState>;

function fail(message: string): never {
  throw new Error(`${AGENT_SKILLS_FILE}: ${message}`);
}

/**
 * Parse and validate the declaration. A malformed entry is an error rather than a
 * skipped line: a skill silently dropped from the list is a skill nobody notices
 * is missing, which is the failure `evidence-not-claims` exists to prevent.
 */
export function parseAgentSkills(raw: unknown): DeclaredSkill[] {
  if (raw === null || typeof raw !== "object") fail("must be a JSON object.");
  const external = (raw as Record<string, unknown>).external;
  if (external === undefined) return [];
  if (!Array.isArray(external)) fail(`"external" must be an array.`);

  const seen = new Set<string>();
  return external.map((entry, at) => {
    const where = `external[${at}]`;
    if (entry === null || typeof entry !== "object") fail(`${where} must be an object.`);
    const e = entry as Record<string, unknown>;

    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      fail(`${where}.name must be a skill name in kebab-case; got ${JSON.stringify(e.name)}.`);
    }
    if (seen.has(name)) fail(`${where}.name "${name}" is declared more than once.`);
    seen.add(name);

    const source = typeof e.source === "string" ? e.source.trim() : "";
    if (source === "") fail(`${where}.source is required (owner/repo or a GitHub URL).`);

    const tier = e.tier === undefined ? "catalog" : e.tier;
    if (tier !== "default" && tier !== "catalog") {
      fail(`${where}.tier must be "default" or "catalog"; got ${JSON.stringify(e.tier)}.`);
    }

    const summary = typeof e.summary === "string" ? e.summary.trim() : "";
    // Enforced, not merely encouraged: a declaration with no trigger line renders a
    // bare name into AGENTS.md, and a bare name in a list is what an agent skips.
    if (summary === "") fail(`${where}.summary is required — say when to reach for it, not what it is.`);

    const requires = e.requires === undefined ? undefined : e.requires;
    if (requires !== undefined && (!Array.isArray(requires) || requires.some((r) => typeof r !== "string"))) {
      fail(`${where}.requires must be an array of strings.`);
    }

    let skills: string[];
    if (e.skills === undefined) {
      skills = [name];
    } else if (!Array.isArray(e.skills) || e.skills.some((s) => typeof s !== "string")) {
      fail(`${where}.skills must be an array of skill names.`);
    } else if (e.skills.length === 0) {
      fail(`${where}.skills is empty — omit it for a single skill, or list the bundle's members.`);
    } else {
      skills = (e.skills as string[]).map((s) => s.trim());
    }

    return { name, source, tier, summary, skills, requires: requires as string[] | undefined };
  });
}

export async function readAgentSkills(workspaceRoot: string): Promise<DeclaredSkill[]> {
  const file = path.join(workspaceRoot, AGENT_SKILLS_FILE);
  if (!(await fs.pathExists(file))) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    fail(`is not valid JSON — ${(err as Error).message}`);
  }
  return parseAgentSkills(raw);
}

const skillDir = (root: string, name: string): string => path.join(root, ".claude", "skills", name);

/**
 * Which declared skills are actually present, and from where.
 *
 * The workspace/user distinction is the whole point of reporting it. A skill in
 * `~/.claude/skills` works on this machine and nowhere else — it does not travel
 * with a cloned workspace and is not there in a headless or cron run. That is a
 * different state from "installed", so it gets a different word.
 */
export async function findInstalled(
  workspaceRoot: string,
  declared: DeclaredSkill[],
  options: { home?: string } = {}
): Promise<InstalledMap> {
  const home = options.home ?? os.homedir();
  const found: InstalledMap = new Map();

  for (const entry of declared) {
    let inWorkspace = 0;
    let inUser = 0;
    const missing: string[] = [];

    for (const member of entry.skills) {
      if (await fs.pathExists(path.join(skillDir(workspaceRoot, member), "SKILL.md"))) inWorkspace++;
      else if (await fs.pathExists(path.join(skillDir(home, member), "SKILL.md"))) inUser++;
      else missing.push(member);
    }

    const total = entry.skills.length;
    const where: InstallState["where"] =
      inWorkspace === total
        ? "workspace"
        : inWorkspace + inUser === total
          ? "user"
          : inWorkspace + inUser > 0
            ? "partial"
            : "absent";
    found.set(entry.name, { where, missing });
  }
  return found;
}

/** One line per declared skill, for the generated block in AGENTS.md. */
export async function describeAgentSkills(workspaceRoot: string): Promise<string[]> {
  const declared = await readAgentSkills(workspaceRoot);
  if (declared.length === 0) return [];
  const installed = await findInstalled(workspaceRoot, declared);

  return declared.map((entry) => {
    const state = installed.get(entry.name);
    // An uninstalled skill still gets a line, carrying the command that installs
    // it. Hiding it would mean an agent cannot know the option existed.
    const note =
      state?.where === "workspace"
        ? ""
        : state?.where === "user"
          ? " _(user-global only — not in this workspace)_"
          : state?.where === "partial"
            ? ` _(partly installed; missing ${state.missing.join(", ")} — \`awo skill sync ${entry.name}\`)_`
            : ` _(not installed — \`awo skill sync ${entry.name}\`)_`;
    const bundle = entry.skills.length > 1 ? ` (${entry.skills.length} skills)` : "";
    return `- \`${entry.name}\`${bundle} — ${entry.summary}${note}`;
  });
}
