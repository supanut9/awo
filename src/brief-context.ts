import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { findCriteria } from "./commands/intake.js";
import { resolveRepoMergePolicy, type Manifest } from "./manifest.js";
import { readAgent } from "./models.js";
import type { BriefInput } from "./commands/task.js";
import type { GoalDefinition, TaskDefinition } from "./tasks.js";
import type { Worktree } from "./worktrees.js";

/**
 * A goal with forty criteria would bury the task body under them. A task that
 * declares its criteria gets exactly those; one that does not gets this many and a
 * pointer to the rest.
 */
const UNDECLARED_CRITERIA_SHOWN = 8;

/**
 * Everything `composeBrief` prints beyond the task body, read from the workspace:
 * per-target worktree, base, test command and merge policy; the role's skills; the
 * goal's acceptance criteria; declared outputs.
 *
 * Kept apart from `composeBrief` so the brief stays a pure function of its input —
 * the same text whether `task run`, a resume or a test composes it.
 */
export async function briefContext(
  workspaceRoot: string,
  manifest: Manifest,
  task: TaskDefinition,
  goal: GoalDefinition,
  worktrees: Worktree[]
): Promise<
  Pick<BriefInput, "goalId" | "targets" | "skills" | "criteria" | "criteriaDeclared" | "criteriaOmitted" | "outputs">
> {
  const fm = matter(await fs.readFile(task.file, "utf8")).data as Record<string, unknown>;

  const targets = task.targets.map((repo) => {
    const wt = worktrees.find((w) => w.repo === repo && !w.error);
    const entry = manifest.repos.find((r) => r.name === repo);
    let mergePolicy: string;
    try {
      mergePolicy = resolveRepoMergePolicy(manifest, repo);
    } catch {
      // An invalid policy is the orchestrator's to fix; the worker's brief must not
      // fail to exist because of it.
      mergePolicy = "invalid (see .workspace/manifest.json)";
    }
    const base = wt?.base?.ref
      ? { ref: wt.base.ref, sha: wt.base.sha }
      : wt?.basedOn
        ? { ref: wt.basedOn, sha: null }
        : null;
    return {
      repo,
      worktree: wt?.path ?? null,
      branch: wt?.branch ?? null,
      testCommand: entry?.testCommand ?? null,
      base,
      mergePolicy,
    };
  });

  return {
    goalId: goal.id,
    targets,
    skills: await skillFiles(workspaceRoot, task.agent ?? "software-engineer"),
    ...(await criteriaFor(workspaceRoot, goal, fm.criteria)),
    outputs: Array.isArray(fm.outputs) ? fm.outputs.map(String) : [],
  };
}

/** The role's `skills:`, as the files to open — or how to get one that is missing. */
async function skillFiles(workspaceRoot: string, agentId: string): Promise<string[]> {
  const agent = await readAgent(workspaceRoot, agentId).catch(() => null);
  const out: string[] = [];
  for (const skill of agent?.skills ?? []) {
    if (await fs.pathExists(path.join(workspaceRoot, "skills", `${skill}.md`))) {
      out.push(`skills/${skill}.md`);
    } else if (await fs.pathExists(path.join(workspaceRoot, "catalog", "skills", `${skill}.md`))) {
      out.push(`catalog/skills/${skill}.md (not installed: awo skill add ${skill})`);
    } else {
      out.push(skill);
    }
  }
  return out;
}

async function criteriaFor(
  workspaceRoot: string,
  goal: GoalDefinition,
  declaredRaw: unknown
): Promise<Pick<BriefInput, "criteria" | "criteriaDeclared" | "criteriaOmitted">> {
  const reqFile = path.join(goal.dir, "requirement.md");
  if (!(await fs.pathExists(reqFile))) return {};
  const all = findCriteria(matter(await fs.readFile(reqFile, "utf8")).content);
  const declared = Array.isArray(declaredRaw) ? declaredRaw : [];
  const file = path.relative(workspaceRoot, reqFile);

  if (declared.length > 0) {
    return {
      criteriaDeclared: true,
      criteria: declared.map((ref) => {
        const asNumber = typeof ref === "number" ? ref : /^\d+$/.test(String(ref)) ? Number(ref) : null;
        const text =
          asNumber !== null
            ? all[asNumber - 1]
            : all.find((c) => new RegExp(`^\\W*${String(ref)}\\b`, "i").test(c));
        return {
          ref: String(ref),
          text: text ?? `(not found in ${file} — ask the orchestrator before relying on it)`,
        };
      }),
    };
  }

  const shown = all.slice(0, UNDECLARED_CRITERIA_SHOWN);
  return {
    criteriaDeclared: false,
    criteria: shown.map((text, i) => ({ ref: String(i + 1), text })),
    ...(all.length > shown.length ? { criteriaOmitted: { count: all.length - shown.length, file } } : {}),
  };
}
