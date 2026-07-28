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
 *    data modelling and review need thinking, so they run high. Mechanical code
 *    changes run low to save tokens, because the thinking already happened
 *    upstream. (Thinking budget is a separate axis from permission mode — see
 *    the note on `mode` below, and §12.7.)
 *
 * awo resolves and records which runtime+model should do a piece of work; it does
 * not spawn anything (§9 item 2, §12.4).
 */
export const TIERS = ["high", "standard", "low"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * §12.10 — reasoning effort is "how long the model should think", not a different
 * intelligence level. Restricted to three on purpose: xhigh/max exist on some
 * runtimes but are quality-first settings whose gain has to be *measured* before
 * it is worth the latency and cost, and offering them invites reaching for them
 * by default. `medium` is the balanced starting point.
 */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Effort that matches each tier's kind of work — see §12.10's decision test. */
const EFFORT_BY_TIER: Record<Tier, Effort> = {
  high: "high",
  standard: "medium",
  low: "low",
};

export interface ModelChoice {
  runtime: string;
  model: string;
  /**
   * Reasoning budget, not permission mode (§12.7). This is what thinking-heavy
   * work actually wants, and it is the only way to tier when an account has just
   * one model available: same model, more thinking. Codex takes it as
   * `-c model_reasoning_effort=<effort>`.
   */
  effort?: string;
  /**
   * Where to go when the primary is unavailable — quota exhausted, rate limited,
   * or the CLI not installed. Declared rather than guessed, because the right
   * substitute is a judgment call: a cheaper model on the same runtime may be
   * worse than the same class of model on another.
   */
  fallback?: { runtime: string; model: string };
  /**
   * Optional permission/interaction mode passed through to the runtime.
   *
   * Deliberately UNSET by default, including for the orchestrator. Plan mode is
   * read-only-until-approved: an orchestrator in plan mode could not run
   * `task run`, write state, or spawn a worker — the actions that are its whole
   * job — and a *spawned* worker in plan mode would produce a plan, wait for an
   * approval that never arrives, and never close its run. Plan mode is a
   * human-approval tool for an interactive session, not a tier setting. Left
   * available for anyone who genuinely wants it on a specific role.
   */
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
    const v = value as { runtime?: unknown; model?: unknown; mode?: unknown; effort?: unknown };
    if (typeof v.model === "string") {
      const fb = (v as { fallback?: unknown }).fallback;
      const parsedFb =
        fb && typeof fb === "object" && typeof (fb as { model?: unknown }).model === "string"
          ? {
              runtime: String((fb as { runtime?: unknown }).runtime ?? ""),
              model: String((fb as { model?: unknown }).model),
            }
          : typeof fb === "string" && fb.includes(":")
            ? { runtime: fb.split(":")[0], model: fb.split(":")[1] }
            : undefined;
      return {
        runtime: typeof v.runtime === "string" ? v.runtime : "",
        model: v.model,
        ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
        ...(v.effort !== undefined ? { effort: parseEffort(v.effort, "the models policy") ?? undefined } : {}),
        ...(parsedFb ? { fallback: parsedFb } : {}),
      };
    }
  }
  return null;
}

function parseEffort(value: unknown, where: string): Effort | null {
  if (typeof value !== "string") return null;
  if (!EFFORTS.includes(value as Effort)) {
    throw new Error(
      `Invalid effort "${value}" in ${where}. Only ${EFFORTS.join(", ")} are selectable — ` +
        `higher settings are quality-first and should be proven to help before being used.`
    );
  }
  return value as Effort;
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

  // Parse the tier entry rather than trusting it: reading it straight from JSON
  // skipped effort validation, so an unsupported effort was silently accepted.
  // Effort also defaults from the tier, so a policy naming only a model still gets
  // a sensible thinking budget instead of the runtime's default.
  const declaredTier = policy.tiers?.[tier] ? parseChoice(policy.tiers[tier]) : null;
  const base = declaredTier ?? FALLBACK[tier];
  const tierChoice: ModelChoice = { ...base, effort: base.effort ?? EFFORT_BY_TIER[tier] };
  const fill = (c: ModelChoice): ModelChoice => ({
    ...c,
    runtime: c.runtime || tierChoice.runtime || FALLBACK[tier].runtime,
    mode: c.mode ?? tierChoice.mode,
    effort: c.effort ?? tierChoice.effort,
    fallback: c.fallback ?? tierChoice.fallback,
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

/**
 * Where the worker should run, and what else it must be allowed to touch.
 *
 * A worktree's `.git` is a pointer to `<repo>/.git/worktrees/<name>`, which lives
 * OUTSIDE the workspace. A worker sandboxed to the workspace can therefore edit
 * files but cannot commit — git has to write that external gitdir. The invocation
 * must grant it, or isolation silently costs you the commit (§9 item 40).
 */
export interface WorkerContext {
  /** Directory the worker should treat as its root. */
  cwd?: string;
  /** Extra paths the worker must be able to write — e.g. the repo holding .git. */
  allow?: string[];
}

/** The command the orchestrator would run to hand this task to a worker. */
export function invocationHint(
  choice: ModelChoice,
  taskId: string,
  context: WorkerContext = {}
): string {
  return invocationFor(choice.runtime, choice.model, choice.mode, taskId, choice.effort, context);
}

/** The same command for the declared fallback, if any. */
export function fallbackHint(
  choice: ModelChoice,
  taskId: string,
  context: WorkerContext = {}
): string | null {
  if (!choice.fallback) return null;
  return invocationFor(
    choice.fallback.runtime,
    choice.fallback.model,
    undefined,
    taskId,
    undefined,
    context
  );
}

function invocationFor(
  runtime: string,
  model: string,
  mode: string | undefined,
  taskId: string,
  effort?: string,
  context: WorkerContext = {}
): string {
  const prompt = `Follow instructions/ship-a-change.md for ${taskId}.`;
  const cwd = context.cwd ? ` -C ${context.cwd}` : "";
  const allow = (context.allow ?? []).map((p) => ` --add-dir ${p}`).join("");

  switch (runtime) {
    case "codex": {
      const eff = effort ? ` -c model_reasoning_effort=${effort}` : "";
      return `codex exec -m ${model}${eff} -s workspace-write${cwd}${allow} "${prompt}"`;
    }
    case "gemini":
      return `gemini -m ${model} -p "${prompt}"`;
    default: {
      const m = mode === "plan" ? " --permission-mode plan" : "";
      return `claude --model ${model}${m}${cwd}${allow} "${prompt}"`;
    }
  }
}
