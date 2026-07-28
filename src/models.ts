import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { readManifest } from "./manifest.js";

/**
 * §12 — model tiering. `orchestrator` roles exercise judgment (refine, decompose,
 * verify, review) and are worth a high-end model; `worker` roles execute against
 * an already-written spec and run well on a cheaper one.
 *
 * awo does not spawn anything (§9 item 2 — it orchestrates and logs). This layer
 * is declarative: it resolves which runtime+model *should* do a piece of work,
 * tells whoever is driving, and records what actually did it in the run log.
 */
export const TIERS = ["orchestrator", "worker"] as const;
export type Tier = (typeof TIERS)[number];

export interface ModelChoice {
  runtime: string;
  model: string;
}

export interface ModelPolicy {
  orchestrator?: ModelChoice;
  worker?: ModelChoice;
  byRole?: Record<string, ModelChoice>;
}

export interface ResolvedModel extends ModelChoice {
  tier: Tier;
  /** Where the choice came from, so `task run` can explain itself. */
  source: "byRole" | "tier" | "default";
}

/** Used when the manifest declares no policy at all. */
const FALLBACK: Record<Tier, ModelChoice> = {
  orchestrator: { runtime: "claude", model: "opus" },
  worker: { runtime: "claude", model: "sonnet" },
};

/**
 * Which tier a role belongs to when its agent file doesn't say. Judgment work
 * defaults to orchestrator; execution work to worker.
 */
const DEFAULT_TIER_BY_ROLE: Record<string, Tier> = {
  "product-manager": "orchestrator",
  "tech-lead": "orchestrator",
  "qa-engineer": "orchestrator",
  "code-reviewer": "orchestrator",
  "software-engineer": "worker",
  "data-engineer": "worker",
  "release-engineer": "worker",
  "marketing-specialist": "worker",
  audit: "orchestrator",
};

export interface AgentDefinition {
  id: string;
  tier: Tier;
  /** An explicit `model:` in the agent file pins it regardless of tier. */
  model: ModelChoice | null;
  file: string;
}

function parseChoice(value: unknown): ModelChoice | null {
  if (typeof value === "string") {
    // "codex:gpt-5-codex" or just "opus" (runtime inferred later)
    const [a, b] = value.split(":");
    return b ? { runtime: a, model: b } : { runtime: "", model: a };
  }
  if (value && typeof value === "object") {
    const v = value as { runtime?: unknown; model?: unknown };
    if (typeof v.model === "string") {
      return { runtime: typeof v.runtime === "string" ? v.runtime : "", model: v.model };
    }
  }
  return null;
}

export async function readAgent(workspaceRoot: string, id: string): Promise<AgentDefinition | null> {
  for (const dir of ["agents", path.join("catalog", "agents")]) {
    const file = path.join(workspaceRoot, dir, `${id}.md`);
    if (!(await fs.pathExists(file))) continue;

    const fm = matter(await fs.readFile(file, "utf8")).data as Record<string, unknown>;
    const declared = typeof fm.tier === "string" && TIERS.includes(fm.tier as Tier)
      ? (fm.tier as Tier)
      : (DEFAULT_TIER_BY_ROLE[id] ?? "worker");

    return { id, tier: declared, model: parseChoice(fm.model), file };
  }
  return null;
}

/**
 * Resolution order, most specific first:
 *   1. the agent file's own `model:`
 *   2. the manifest's `models.byRole[<agent>]`
 *   3. the manifest's `models[<tier>]`
 *   4. built-in fallback for that tier
 */
export async function resolveModel(
  workspaceRoot: string,
  agentId: string | null
): Promise<ResolvedModel> {
  const manifest = await readManifest(workspaceRoot);
  const policy = (manifest.models ?? {}) as ModelPolicy;

  const agent = agentId ? await readAgent(workspaceRoot, agentId) : null;
  const tier: Tier = agent?.tier ?? "worker";

  const tierDefault = policy[tier] ?? FALLBACK[tier];
  const fill = (c: ModelChoice): ModelChoice => ({
    runtime: c.runtime || tierDefault.runtime || FALLBACK[tier].runtime,
    model: c.model,
  });

  if (agent?.model) return { ...fill(agent.model), tier, source: "default" };
  if (agentId && policy.byRole?.[agentId]) {
    return { ...fill(policy.byRole[agentId]), tier, source: "byRole" };
  }
  return { ...fill(tierDefault), tier, source: policy[tier] ? "tier" : "default" };
}

/** The command to hand this task to the resolved worker, for humans to copy. */
export function invocationHint(choice: ModelChoice, taskId: string): string {
  const prompt = `Follow instructions/ship-a-change.md for ${taskId}.`;
  switch (choice.runtime) {
    case "codex":
      return `codex exec -m ${choice.model} "${prompt}"`;
    case "gemini":
      return `gemini -m ${choice.model} -p "${prompt}"`;
    default:
      return `claude --model ${choice.model} "${prompt}"`;
  }
}
