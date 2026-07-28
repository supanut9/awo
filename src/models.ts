import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { readManifest } from "./manifest.js";

/**
 * §12 — model tiering.
 *
 * Two distinct ideas that must not be conflated:
 *
 * 1. The **orchestrator** is the intermediary between the human and the work.
 *    It is the session you talk to. It is NOT one of the roles in `agents/` and
 *    has no tier — it is configured once, in the manifest.
 *
 * 2. Every role in `agents/` is a **worker**. Worker does not mean cheap: a
 *    worker's tier follows the *kind of work* it does. Planning, decomposition,
 *    data modelling and review need thinking, so they run high (often in plan
 *    mode). Mechanical code changes run low to save tokens, because the thinking
 *    already happened upstream.
 *
 * awo resolves and records which runtime+model should do a piece of work; it does
 * not spawn anything (§9 item 2, §12.4).
 */
export const TIERS = ["high", "standard", "low"] as const;
export type Tier = (typeof TIERS)[number];

export interface ModelChoice {
  runtime: string;
  model: string;
  /** e.g. Claude Code's plan mode — useful for thinking-heavy work. */
  mode?: string;
}

export interface ModelPolicy {
  /** The coordinating session the human talks to. Not a worker. */
  orchestrator?: ModelChoice;
  tiers?: Partial<Record<Tier, ModelChoice>>;
  byRole?: Record<string, ModelChoice>;
}

export interface ResolvedModel extends ModelChoice {
  tier: Tier;
  /** Where the tier came from, so `task run` can explain itself. */
  tierSource: "task" | "agent" | "default";
  source: "agent-model" | "byRole" | "tier" | "fallback";
}

const FALLBACK: Record<Tier, ModelChoice> = {
  high: { runtime: "claude", model: "opus" },
  standard: { runtime: "claude", model: "sonnet" },
  low: { runtime: "claude", model: "haiku" },
};

export const DEFAULT_ORCHESTRATOR: ModelChoice = {
  runtime: "claude",
  model: "opus",
  mode: "plan",
};

/**
 * Tier by role when the agent file doesn't say — driven by what the work is,
 * not by seniority. Anything unknown lands on `standard`: a wrong guess costs
 * tokens at `high` and costs quality at `low`, so the middle is the safe default.
 */
const DEFAULT_TIER_BY_ROLE: Record<string, Tier> = {
  // thinking: interpreting, decomposing, modelling, judging
  "product-manager": "high",
  "tech-lead": "high",
  "data-engineer": "high",
  "qa-engineer": "high",
  "code-reviewer": "high",
  audit: "high",
  // mechanical: execute a spec that already exists
  "software-engineer": "low",
  "release-engineer": "low",
  "marketing-specialist": "standard",
};

export interface AgentDefinition {
  id: string;
  tier: Tier | null;
  model: ModelChoice | null;
  file: string;
}

function parseChoice(value: unknown): ModelChoice | null {
  if (typeof value === "string") {
    // "codex:gpt-5-codex" or bare "opus" (runtime filled in from the tier)
    const [a, b] = value.split(":");
    return b ? { runtime: a, model: b } : { runtime: "", model: a };
  }
  if (value && typeof value === "object") {
    const v = value as { runtime?: unknown; model?: unknown; mode?: unknown };
    if (typeof v.model === "string") {
      return {
        runtime: typeof v.runtime === "string" ? v.runtime : "",
        model: v.model,
        ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
      };
    }
  }
  return null;
}

function parseTier(value: unknown): Tier | null {
  return typeof value === "string" && TIERS.includes(value as Tier) ? (value as Tier) : null;
}

export async function readAgent(workspaceRoot: string, id: string): Promise<AgentDefinition | null> {
  for (const dir of ["agents", path.join("catalog", "agents")]) {
    const file = path.join(workspaceRoot, dir, `${id}.md`);
    if (!(await fs.pathExists(file))) continue;
    const fm = matter(await fs.readFile(file, "utf8")).data as Record<string, unknown>;
    return { id, tier: parseTier(fm.tier), model: parseChoice(fm.model), file };
  }
  return null;
}

/** The orchestrator's own model — informational; nothing dispatches with it yet. */
export async function resolveOrchestrator(workspaceRoot: string): Promise<ModelChoice> {
  const manifest = await readManifest(workspaceRoot);
  const declared = parseChoice((manifest.models as ModelPolicy | undefined)?.orchestrator);
  if (!declared) return DEFAULT_ORCHESTRATOR;
  return { ...declared, runtime: declared.runtime || DEFAULT_ORCHESTRATOR.runtime };
}

/**
 * Resolution, most specific first:
 *
 *   tier:   task's `tier:`  >  agent's `tier:`  >  role default  >  "standard"
 *   model:  agent's `model:`  >  byRole[agent]  >  tiers[tier]  >  fallback[tier]
 *
 * Tier and model resolve separately on purpose: a task can be flagged as
 * thinking-heavy (`tier: high`) without also having to know which model that
 * means, which is the manifest's business.
 */
export async function resolveModel(
  workspaceRoot: string,
  agentId: string | null,
  taskTier: Tier | null = null
): Promise<ResolvedModel> {
  const manifest = await readManifest(workspaceRoot);
  const policy = (manifest.models ?? {}) as ModelPolicy;
  const agent = agentId ? await readAgent(workspaceRoot, agentId) : null;

  let tier: Tier;
  let tierSource: ResolvedModel["tierSource"];
  if (taskTier) {
    tier = taskTier;
    tierSource = "task";
  } else if (agent?.tier) {
    tier = agent.tier;
    tierSource = "agent";
  } else {
    tier = (agentId && DEFAULT_TIER_BY_ROLE[agentId]) || "standard";
    tierSource = "default";
  }

  const tierChoice = policy.tiers?.[tier] ?? FALLBACK[tier];
  const fill = (c: ModelChoice): ModelChoice => ({
    ...c,
    runtime: c.runtime || tierChoice.runtime || FALLBACK[tier].runtime,
    mode: c.mode ?? tierChoice.mode,
  });

  if (agent?.model) return { ...fill(agent.model), tier, tierSource, source: "agent-model" };
  if (agentId && policy.byRole?.[agentId]) {
    const byRole = parseChoice(policy.byRole[agentId]);
    if (byRole) return { ...fill(byRole), tier, tierSource, source: "byRole" };
  }
  return {
    ...fill(tierChoice),
    tier,
    tierSource,
    source: policy.tiers?.[tier] ? "tier" : "fallback",
  };
}

/** The command the orchestrator would run to hand this task to a worker. */
export function invocationHint(choice: ModelChoice, taskId: string): string {
  const prompt = `Follow instructions/ship-a-change.md for ${taskId}.`;
  switch (choice.runtime) {
    case "codex":
      return `codex exec -m ${choice.model} "${prompt}"`;
    case "gemini":
      return `gemini -m ${choice.model} -p "${prompt}"`;
    default: {
      const mode = choice.mode === "plan" ? " --permission-mode plan" : "";
      return `claude --model ${choice.model}${mode} "${prompt}"`;
    }
  }
}
