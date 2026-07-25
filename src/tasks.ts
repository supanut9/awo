import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { TASK_STATUSES, type TaskStatus } from "./state.js";

export interface TaskDefinition {
  id: string;
  goalId: string;
  name: string;
  targets: string[];
  dependsOn: string[];
  agent: string | null;
  /** Frontmatter `status:` is the AUTHORED starting state only (§7.2). */
  authoredStatus: TaskStatus;
  file: string;
  body: string;
}

export interface GoalDefinition {
  id: string;
  title: string;
  dir: string;
  taskIds: string[];
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

async function goalDirs(workspaceRoot: string): Promise<string[]> {
  const goalsRoot = path.join(workspaceRoot, "goals");
  if (!(await fs.pathExists(goalsRoot))) return [];
  const entries = await fs.readdir(goalsRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(goalsRoot, e.name))
    .sort();
}

export async function readTaskFile(file: string): Promise<TaskDefinition> {
  const parsed = matter(await fs.readFile(file, "utf8"));
  const fm = parsed.data as Record<string, unknown>;

  if (typeof fm.id !== "string" || fm.id.trim() === "") {
    throw new Error(`${file} is missing an \`id:\` in its frontmatter.`);
  }
  if (typeof fm.goalId !== "string" || fm.goalId.trim() === "") {
    throw new Error(`${file} is missing a \`goalId:\` in its frontmatter.`);
  }

  const authored = typeof fm.status === "string" ? fm.status : "todo";
  if (!TASK_STATUSES.includes(authored as TaskStatus)) {
    throw new Error(
      `${file} has status "${authored}", which is not a task lifecycle state. Valid: ${TASK_STATUSES.join(", ")}.`
    );
  }

  return {
    id: fm.id.trim(),
    goalId: fm.goalId.trim(),
    name: typeof fm.name === "string" ? fm.name : fm.id.trim(),
    targets: asArray(fm.targets),
    dependsOn: asArray(fm.dependsOn),
    agent: typeof fm.agent === "string" ? fm.agent : null,
    authoredStatus: authored as TaskStatus,
    file,
    body: parsed.content.trim(),
  };
}

export async function findGoals(workspaceRoot: string): Promise<GoalDefinition[]> {
  const goals: GoalDefinition[] = [];
  for (const dir of await goalDirs(workspaceRoot)) {
    const goalFile = path.join(dir, "goal.md");
    if (!(await fs.pathExists(goalFile))) continue;

    const fm = matter(await fs.readFile(goalFile, "utf8")).data as Record<string, unknown>;
    const id = typeof fm.id === "string" ? fm.id.trim() : path.basename(dir);
    const tasks = await findTasksInGoal(dir);
    goals.push({
      id,
      title: typeof fm.title === "string" ? fm.title : id,
      dir,
      taskIds: tasks.map((t) => t.id),
    });
  }
  return goals;
}

export async function findTasksInGoal(goalDir: string): Promise<TaskDefinition[]> {
  const tasksDir = path.join(goalDir, "tasks");
  if (!(await fs.pathExists(tasksDir))) return [];
  const files = (await fs.readdir(tasksDir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(tasksDir, f));

  const tasks: TaskDefinition[] = [];
  for (const file of files) tasks.push(await readTaskFile(file));
  return tasks;
}

export interface LocatedTask {
  task: TaskDefinition;
  goal: GoalDefinition;
}

export async function findAllTasks(workspaceRoot: string): Promise<LocatedTask[]> {
  const located: LocatedTask[] = [];
  for (const goal of await findGoals(workspaceRoot)) {
    for (const task of await findTasksInGoal(goal.dir)) {
      located.push({ task, goal });
    }
  }
  return located;
}

export async function locateTask(workspaceRoot: string, taskId: string): Promise<LocatedTask> {
  const all = await findAllTasks(workspaceRoot);
  const hit = all.find((t) => t.task.id === taskId);
  if (!hit) {
    const known = all.map((t) => t.task.id);
    throw new Error(
      known.length > 0
        ? `Unknown task "${taskId}". Known tasks: ${known.join(", ")}.`
        : `Unknown task "${taskId}". No tasks exist yet — author one under goals/<goal>/tasks/.`
    );
  }
  return hit;
}
