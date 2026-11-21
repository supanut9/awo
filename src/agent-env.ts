/**
 * Who is at the keyboard — a human, or an agent runtime acting for one.
 *
 * The human gates (`req approve`, `goal verdict`) and the run record both need to
 * say honestly which it was. Measured on the real workspaces: every approval and
 * every verdict was typed by an agent, and most were logged as "human". Detection
 * is environmental and therefore advisory — an agent can lie — but the default
 * record should be the truth, not the flattering version.
 */

export type AgentRuntime = "claude" | "codex" | "gemini" | "agent";

export interface AgentEnvironment {
  /** True when the process looks like it was started by an agent runtime. */
  isAgent: boolean;
  runtime: AgentRuntime | null;
  /** The env var that gave it away, for messages and audit records. */
  source: string | null;
  /** `AWO_AGENT`, when the orchestrator named the acting agent explicitly. */
  agentName: string | null;
}

const MARKERS: ReadonlyArray<{ env: string; runtime: AgentRuntime }> = [
  { env: "CLAUDECODE", runtime: "claude" },
  { env: "CLAUDE_CODE_ENTRYPOINT", runtime: "claude" },
  { env: "CODEX_SANDBOX", runtime: "codex" },
  { env: "CODEX_SANDBOX_NETWORK_DISABLED", runtime: "codex" },
  { env: "CODEX_THREAD_ID", runtime: "codex" },
  { env: "CODEX_MANAGED_BY_NPM", runtime: "codex" },
  { env: "GEMINI_CLI", runtime: "gemini" },
];

/**
 * `AWO_HUMAN=1` is the explicit "a person typed this" override — for a human
 * running awo through an agent's shell passthrough (e.g. Claude Code's `!`).
 */
export function detectAgentEnvironment(env: NodeJS.ProcessEnv = process.env): AgentEnvironment {
  const agentName = env.AWO_AGENT?.trim() || null;
  if (env.AWO_HUMAN === "1" || env.AWO_HUMAN === "true") {
    return { isAgent: false, runtime: null, source: "AWO_HUMAN", agentName };
  }
  for (const marker of MARKERS) {
    const value = env[marker.env];
    if (value !== undefined && value !== "" && value !== "0") {
      return { isAgent: true, runtime: marker.runtime, source: marker.env, agentName };
    }
  }
  if (agentName) return { isAgent: true, runtime: "agent", source: "AWO_AGENT", agentName };
  return { isAgent: false, runtime: null, source: null, agentName: null };
}

/** A short, stable label for run records: `claude`, `codex`, `human`, … */
export function actorLabel(env: AgentEnvironment = detectAgentEnvironment()): string {
  if (!env.isAgent) return "human";
  return env.agentName ?? env.runtime ?? "agent";
}
