import { execFile } from "child_process";
import { promisify } from "util";
import { findWorkspaceRoot } from "../workspace.js";
import { refreshManagedBlocks } from "../managed-blocks.js";
import {
  readAgentSkills,
  findInstalled,
  type DeclaredSkill,
  type InstalledWhere,
  type InstallState,
} from "../agent-skills.js";

const run = promisify(execFile);

/**
 * The `skills` CLI's name for Claude Code's skill directory. It validates this
 * against a fixed list and exits non-zero on anything else — `--agent claude`
 * fails, which is the kind of thing worth pinning in one constant rather than
 * rediscovering from a stack trace.
 */
const AGENT = "claude-code";

/** Cloning a repo over the network; the default 60s is not always enough. */
const INSTALL_TIMEOUT_MS = 180_000;

export type SyncOutcome = "installed" | "present" | "adopted" | "skipped" | "failed";

export interface SyncResult {
  name: string;
  outcome: SyncOutcome;
  where?: InstalledWhere;
  /** How many skills the entry installs — >1 for a bundle. */
  count?: number;
  requires?: string[];
  error?: string;
}

export interface ListedSkill extends DeclaredSkill {
  installed: InstallState;
}

export async function runAgentSkillList(options: { cwd?: string } = {}): Promise<ListedSkill[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const declared = await readAgentSkills(root);
  const installed = await findInstalled(root, declared);
  return declared.map((entry) => ({
    ...entry,
    installed: installed.get(entry.name) ?? { where: "absent", missing: entry.skills },
  }));
}

/**
 * Install declared external skills into the workspace's `.claude/skills/`.
 *
 * `--copy` rather than the CLI's default symlink: a symlink points into a
 * per-machine store, so a cloned workspace resolves to nothing and the skill is
 * silently absent rather than loudly missing. Copies travel.
 *
 * A skill already present *user-globally* is still installed here. That is not
 * redundant work: `~/.claude/skills` is this machine's, and the whole contract of
 * a workspace is that cloning it reproduces the setup — including for a headless
 * or scheduled run that never had the user's home directory.
 */
export async function runAgentSkillSync(
  names: string[] = [],
  options: { cwd?: string; all?: boolean; dryRun?: boolean } = {}
): Promise<SyncResult[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const declared = await readAgentSkills(root);

  if (declared.length === 0) {
    throw new Error(
      "No external agent skills are declared. Add them to .workspace/agent-skills.json."
    );
  }

  for (const name of names) {
    if (!declared.some((s) => s.name === name)) {
      throw new Error(
        `"${name}" is not declared in .workspace/agent-skills.json. ` +
          `Declared: ${declared.map((s) => s.name).join(", ")}.`
      );
    }
  }

  const wanted = declared.filter((skill) =>
    names.length > 0 ? names.includes(skill.name) : options.all || skill.tier === "default"
  );

  const installed = await findInstalled(root, declared);
  const results: SyncResult[] = [];

  for (const entry of wanted) {
    const before = installed.get(entry.name);
    if (before?.where === "workspace") {
      results.push({ name: entry.name, outcome: "present", where: "workspace" });
      continue;
    }
    if (options.dryRun) {
      results.push({ name: entry.name, outcome: "skipped", count: entry.skills.length });
      continue;
    }

    try {
      // One invocation for the whole bundle, so a 28-skill source clones once
      // instead of once per skill.
      //
      // `--skill` must be REPEATED, one flag per name. A comma-separated value is
      // taken as a single literal skill name: `--skill "a,b"` fails with "No
      // matching skills found for: a,b" — which reads like the repo is wrong
      // rather than the flag, and exits non-zero having installed nothing.
      await run(
        "npx",
        [
          "-y",
          "skills@latest",
          "add",
          entry.source,
          ...entry.skills.flatMap((name) => ["--skill", name]),
          "--agent",
          AGENT,
          "--yes",
          "--copy",
        ],
        { cwd: root, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
      );
      results.push({
        name: entry.name,
        outcome: before?.where === "user" ? "adopted" : "installed",
        count: entry.skills.length,
        requires: entry.requires,
      });
    } catch (err) {
      // Never abort the loop: one unreachable repo should not leave the other
      // skills uninstalled and the workspace in a half-configured state.
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr ?? e.message ?? "").trim().split("\n").slice(-3).join(" ").trim();
      results.push({ name: entry.name, outcome: "failed", error: detail || "install failed" });
    }
  }

  // Re-read from disk rather than trusting the CLI's exit code: a zero exit that
  // installed nothing is exactly the "no failure means it worked" mistake, and the
  // only honest answer to "is it installed?" is looking.
  const after = await findInstalled(root, declared);
  for (const result of results) {
    if (result.outcome !== "installed" && result.outcome !== "adopted") continue;
    const state = after.get(result.name);
    if (state && state.where !== "workspace") {
      result.outcome = "failed";
      result.error =
        state.missing.length > 0
          ? `reported success but ${state.missing.join(", ")} is not in .claude/skills`
          : "reported success but nothing landed in .claude/skills";
    }
  }

  // The AGENTS.md block is generated from the declaration plus what is on disk, so
  // installing something is the whole of installing it — same contract as the
  // catalog: nothing to remember to write down.
  await refreshManagedBlocks(root);
  return results;
}

export function formatSyncResults(results: SyncResult[]): string {
  if (results.length === 0) return "nothing to sync.";
  const lines: string[] = [];
  for (const r of results) {
    const mark =
      r.outcome === "installed" || r.outcome === "adopted"
        ? "+"
        : r.outcome === "present"
          ? "="
          : r.outcome === "failed"
            ? "!"
            : " ";
    const bundle = r.count && r.count > 1 ? ` (${r.count} skills)` : "";
    const note =
      r.outcome === "adopted"
        ? " (was user-global only; now in this workspace)"
        : r.outcome === "present"
          ? " already in .claude/skills"
          : r.outcome === "failed"
            ? ` ${r.error}`
            : r.outcome === "skipped"
              ? " would install"
              : "";
    lines.push(`  ${mark} ${r.name}${bundle}${note}`);
    for (const step of r.requires ?? []) lines.push(`      needs: ${step}`);
  }
  const failed = results.filter((r) => r.outcome === "failed").length;
  if (failed > 0) lines.push(`\n${failed} skill(s) failed to install.`);
  return lines.join("\n");
}
