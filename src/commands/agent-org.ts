import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readAgent, type AgentDefinition } from "../models.js";
import { findAllTasks } from "../tasks.js";

export interface AgentOrgNode extends AgentDefinition {
  openTasks: number;
  taskCount: number;
}

export interface AgentOrgResult {
  agents: AgentOrgNode[];
  roots: string[];
  errors: string[];
}

/** Read only installed roles: catalog entries are not part of this workspace's org. */
export async function runAgentOrg(options: { cwd?: string } = {}): Promise<AgentOrgResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const ids = (await fs.readdir(path.join(root, "agents")).catch(() => []))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
  const definitions = (await Promise.all(ids.map((id) => readAgent(root, id)))).filter(
    (agent): agent is AgentDefinition => agent !== null
  );
  const workload = new Map<string, { taskCount: number; openTasks: number }>();
  for (const { task } of await findAllTasks(root)) {
    if (!task.agent) continue;
    const row = workload.get(task.agent) ?? { taskCount: 0, openTasks: 0 };
    row.taskCount += 1;
    if (task.authoredStatus !== "done" && task.authoredStatus !== "cancelled") row.openTasks += 1;
    workload.set(task.agent, row);
  }
  const agents = definitions.map((agent) => ({
    ...agent,
    ...(workload.get(agent.id) ?? { taskCount: 0, openTasks: 0 }),
  }));
  const known = new Set(ids);
  const errors: string[] = [];

  for (const agent of agents) {
    for (const [field, values] of [
      ["reportsTo", agent.reportsTo ? [agent.reportsTo] : []],
      ["delegatesTo", agent.delegatesTo],
      ["reviews", agent.reviews],
    ] as const) {
      for (const id of values) {
        if (!known.has(id)) errors.push(`${agent.id}.${field} references unknown agent "${id}".`);
      }
    }
  }

  for (const agent of agents) {
    const seen = new Set<string>([agent.id]);
    let parent = agent.reportsTo;
    while (parent) {
      if (seen.has(parent)) {
        errors.push(`reportsTo cycle: ${[...seen, parent].join(" -> ")}.`);
        break;
      }
      seen.add(parent);
      parent = agents.find((item) => item.id === parent)?.reportsTo ?? null;
    }
  }

  return {
    agents,
    roots: agents.filter((agent) => !agent.reportsTo || !known.has(agent.reportsTo)).map((agent) => agent.id),
    errors: [...new Set(errors)],
  };
}

export function formatAgentOrg(result: AgentOrgResult): string {
  const byParent = new Map<string | null, AgentOrgNode[]>();
  for (const agent of result.agents) {
    const key = result.agents.some((item) => item.id === agent.reportsTo) ? agent.reportsTo : null;
    byParent.set(key, [...(byParent.get(key) ?? []), agent]);
  }
  const lines: string[] = [];
  const visit = (parent: string | null, depth: number): void => {
    for (const agent of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}${agent.id}  ${agent.openTasks}/${agent.taskCount} open`);
      visit(agent.id, depth + 1);
    }
  };
  visit(null, 0);
  if (result.errors.length > 0) lines.push("", ...result.errors.map((error) => `ERROR: ${error}`));
  return lines.join("\n") || "No installed agents.";
}
