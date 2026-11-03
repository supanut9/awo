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
  /** Evidence contracts differ for code, investigation, QA, and human decisions. */
  kind: TaskKind;
  /** Legacy tasks had no kind; do not retroactively impose implementation evidence. */
  kindExplicit: boolean;
  /** Frontmatter `status:` is the AUTHORED starting state only (§7.2). */
  authoredStatus: TaskStatus;
  /**
   * §12 — optional per-task override. Tier is a property of the WORK, not only
   * of the role: "define the data model" is thinking-heavy even when the role
   * that does it normally runs low.
   */
  tier: "high" | "standard" | "low" | null;
  /**
   * Labels to put on this task's PR. Applied only if the repo already HAS them —
   * awo never creates a label, because inventing project vocabulary from a task
   * file is how a label list turns into forty near-duplicates nobody filters by.
   */
  labels: string[];
  file: string;
  body: string;
}

export const TASK_KINDS = [
  "implementation",
  "investigation",
  "verification",
  "decision",
  "deployment-data",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface CompletionPolicy {
  qaRequired: boolean;
  acceptanceEvidenceRequired: boolean;
}

export interface GoalDefinition {
  id: string;
  title: string;
  dir: string;
  targets: string[];
  taskIds: string[];
  completionPolicy: CompletionPolicy;
  /** True when the goal directory currently sits under `goals/archive/`. */
  archived: boolean;
}

/**
 * Pre-0.0.2 task files were authored with the old single-vocabulary
 * `pending | running | success | failed | skipped` (§7.4 explains why that
 * conflated lifecycle with outcome). Translate on read rather than failing:
 * an old workspace pulling a new `awo` must keep working, and the authored
 * `status:` is only a starting point anyway.
 */
const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {
  pending: "todo",
  success: "done",
  failed: "blocked",
  skipped: "cancelled",
};

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

export function goalsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "goals");
}

/**
 * Where a finished or abandoned goal is kept (§7.2), mirroring
 * `requirements/archive/`.
 *
 * A goal whose work is over stayed in `goals/` forever, so the list an agent
 * scans to answer "what is actually live?" grew without bound and every session
 * paid to skim goals that were closed months ago. The status is still the truth;
 * the directory follows it.
 */
export function goalArchiveDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "goals", "archive");
}

async function goalDirs(workspaceRoot: string): Promise<string[]> {
  const goalsRoot = goalsDir(workspaceRoot);
  if (!(await fs.pathExists(goalsRoot))) return [];

  const read = async (dir: string): Promise<string[]> =>
    (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      // `archive` is a container, not a goal — without this it reads as one with
      // no goal.md and every archived goal underneath it goes unseen.
      .filter((e) => path.join(dir, e.name) !== goalArchiveDir(workspaceRoot))
      .map((e) => path.join(dir, e.name));

  return [...(await read(goalsRoot)), ...(await read(goalArchiveDir(workspaceRoot)))].sort();
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

  const raw = typeof fm.status === "string" ? fm.status : "todo";
  const authored = LEGACY_STATUS_ALIASES[raw] ?? raw;
  if (!TASK_STATUSES.includes(authored as TaskStatus)) {
    throw new Error(
      `${file} has status "${raw}", which is not a task lifecycle state. Valid: ${TASK_STATUSES.join(", ")}.`
    );
  }

  return {
    id: fm.id.trim(),
    goalId: fm.goalId.trim(),
    name: typeof fm.name === "string" ? fm.name : fm.id.trim(),
    targets: asArray(fm.targets),
    dependsOn: asArray(fm.dependsOn),
    agent: typeof fm.agent === "string" ? fm.agent : null,
    kind: TASK_KINDS.includes(fm.kind as TaskKind) ? (fm.kind as TaskKind) : "implementation",
    kindExplicit: TASK_KINDS.includes(fm.kind as TaskKind),
    authoredStatus: authored as TaskStatus,
    tier:
      fm.tier === "high" || fm.tier === "standard" || fm.tier === "low" ? fm.tier : null,
    labels: asArray(fm.labels),
    file,
    body: parsed.content.trim(),
  };
}

function completionPolicy(value: unknown): CompletionPolicy {
  const policy = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    qaRequired: policy.qaRequired === true,
    acceptanceEvidenceRequired: policy.acceptanceEvidenceRequired === true,
  };
}

/**
 * Every goal, archived ones included, unless asked otherwise.
 *
 * Including the archive is the safe default and deliberately so: `locateTask`,
 * `awo log show`, and the traceability chain all resolve a task through its goal,
 * so hiding archived goals here would make every historical task unlocatable and
 * silently break history — which is the opposite of what archiving is for.
 * Filtering belongs in the few places that want the short list of live work.
 */
export async function findGoals(
  workspaceRoot: string,
  options: { includeArchived?: boolean } = {}
): Promise<GoalDefinition[]> {
  const includeArchived = options.includeArchived ?? true;
  const archiveRoot = goalArchiveDir(workspaceRoot);

  const goals: GoalDefinition[] = [];
  for (const dir of await goalDirs(workspaceRoot)) {
    const goalFile = path.join(dir, "goal.md");
    if (!(await fs.pathExists(goalFile))) continue;

    const archived = path.dirname(dir) === archiveRoot;
    if (archived && !includeArchived) continue;

    const fm = matter(await fs.readFile(goalFile, "utf8")).data as Record<string, unknown>;
    const id = typeof fm.id === "string" ? fm.id.trim() : path.basename(dir);
    const tasks = await findTasksInGoal(dir);
    goals.push({
      id,
      title: typeof fm.title === "string" ? fm.title : id,
      dir,
      targets: asArray(fm.targets),
      taskIds: tasks.map((t) => t.id),
      completionPolicy: completionPolicy(fm.completionPolicy),
      archived,
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
