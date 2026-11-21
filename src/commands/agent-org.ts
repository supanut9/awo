import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readAgent, type AgentDefinition } from "../models.js";
import { findGoals, findTasksInGoal } from "../tasks.js";
import { newTaskState, readState, reconcileGoalState, type TaskStatus } from "../state.js";

export interface AgentOrgNode extends AgentDefinition {
  openTasks: number;
  taskCount: number;
}

export interface AgentOrgResult {
  agents: AgentOrgNode[];
  roots: string[];
  errors: string[];
}

export interface AgentOrgOptions {
  cwd?: string;
  /** Count work in archived goals too. Off by default: workload means live work. */
  includeArchived?: boolean;
}

/**
 * Each task's effective status: state.json's runtime status, falling back to the
 * authored one only for a task that has never been touched.
 *
 * Counting `authoredStatus` meant a role's "open" work was whatever the task files
 * said when they were written — nearly always `todo` — so finished, cancelled and
 * archived work stayed open forever and the org view never went down.
 */
async function effectiveTaskStatuses(
  root: string,
  includeArchived: boolean
): Promise<{ agent: string | null; status: TaskStatus }[]> {
  const out: { agent: string | null; status: TaskStatus }[] = [];
  for (const goal of await findGoals(root, { includeArchived })) {
    const tasks = await findTasksInGoal(goal.dir);
    // A workload count is no reason to fail: a malformed state.json is reported by
    // the commands that write it and by doctor, so fall back to the authored status.
    const state = await readState(goal.dir, goal.id)
      .then((raw) => reconcileGoalState(raw, tasks).state)
      .catch(() => null);
    for (const task of tasks) {
      out.push({
        agent: task.agent,
        status: (state?.tasks[task.id] ?? newTaskState(task.authoredStatus)).status,
      });
    }
  }
  return out;
}

/** Read only installed roles: catalog entries are not part of this workspace's org. */
export async function runAgentOrg(options: AgentOrgOptions = {}): Promise<AgentOrgResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const ids = (await fs.readdir(path.join(root, "agents")).catch(() => []))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
  const definitions = (await Promise.all(ids.map((id) => readAgent(root, id)))).filter(
    (agent): agent is AgentDefinition => agent !== null
  );
  const workload = new Map<string, { taskCount: number; openTasks: number }>();
  for (const { agent, status } of await effectiveTaskStatuses(root, options.includeArchived ?? false)) {
    if (!agent) continue;
    const row = workload.get(agent) ?? { taskCount: 0, openTasks: 0 };
    row.taskCount += 1;
    if (status !== "done" && status !== "cancelled") row.openTasks += 1;
    workload.set(agent, row);
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
