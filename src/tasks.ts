import fs from "fs-extra";
import { readFile, readdir, stat } from "node:fs/promises";
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
  /**
   * Goal-branch delivery: tasks integrate into this branch (one PR per repo for
   * the goal) instead of shipping one PR per task. Null means per-task delivery.
   */
  deliveryBranch: string | null;
  /** Per-repo base branch for this goal's work, overriding the manifest's. */
  baseBranches: Record<string, string>;
  pullRequestStrategy: "task" | "goal-branch";
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
  return parseTaskFile(file, await fs.readFile(file, "utf8")).task;
}

function parseTaskFile(file: string, content: string): { task: TaskDefinition; warning: string | null } {
  const parsed = matter(content);
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

  const kindKnown = TASK_KINDS.includes(fm.kind as TaskKind);
  // An unrecognised kind keeps the old behaviour (treated as implementation) but is
  // no longer silent: a typo like `kind: investigaton` quietly imposed the code
  // evidence contract on work that has no code to show.
  const warning =
    fm.kind !== undefined && fm.kind !== null && !kindKnown
      ? `${file} has kind "${String(fm.kind)}", which is not a task kind — treated as implementation. Valid: ${TASK_KINDS.join(", ")}.`
      : null;

  return {
    warning,
    task: {
      id: fm.id.trim(),
      goalId: fm.goalId.trim(),
      name: typeof fm.name === "string" ? fm.name : fm.id.trim(),
      targets: asArray(fm.targets),
      dependsOn: asArray(fm.dependsOn),
      agent: typeof fm.agent === "string" ? fm.agent : null,
      kind: kindKnown ? (fm.kind as TaskKind) : "implementation",
      kindExplicit: kindKnown,
      authoredStatus: authored as TaskStatus,
      tier:
        fm.tier === "high" || fm.tier === "standard" || fm.tier === "low" ? fm.tier : null,
      labels: asArray(fm.labels),
      file,
      body: parsed.content.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// per-process inventory cache
// ---------------------------------------------------------------------------

/**
 * Every command used to re-read and re-parse every task file, often several times
 * per process (`findGoals` parsed each one for `taskIds`, then `findAllTasks` and
 * the reader parsed it again). Measured on atlas-shop (1,335 task files): 0.55 s
 * per scan, three or four scans per `awo context`.
 *
 * Keyed on the file's stat, not memoised blindly: a command that writes a task
 * file and then reads the inventory (or a long-lived `awo ui` process) must see
 * the new content. A `stat` is two orders of magnitude cheaper than read + YAML.
 */
interface CachedTaskFile {
  key: string;
  task: TaskDefinition | null;
  error: string | null;
  warning: string | null;
  /** The id, when the frontmatter still yields one — so a broken file is nameable. */
  id: string | null;
}

const taskFileCache = new Map<string, CachedTaskFile>();
const goalFileCache = new Map<string, { key: string; data: Record<string, unknown> }>();
const reportedProblems = new Set<string>();

async function statKey(file: string): Promise<string | null> {
  const st = await stat(file, { bigint: true }).catch(() => null);
  return st && st.isFile() ? `${st.mtimeNs}:${st.size}:${st.ino}` : null;
}

function salvageId(content: string, file: string): string | null {
  const match = /^id:\s*["']?([A-Za-z0-9._-]+)/m.exec(content);
  if (match) return match[1];
  const base = path.basename(file, ".md");
  return /^[A-Za-z0-9]+-[A-Za-z]+\d+/.exec(base)?.[0] ?? null;
}

const inflightTaskFiles = new Map<string, Promise<CachedTaskFile>>();

async function loadTaskFile(file: string): Promise<CachedTaskFile | null> {
  const key = await statKey(file);
  if (key === null) return null;
  const cached = taskFileCache.get(file);
  if (cached && cached.key === key) return cached;

  // Readers run concurrently (the dashboard snapshot scans goals, requirements and
  // agents in parallel); share one read instead of racing three.
  const flightKey = `${file}\0${key}`;
  const pending = inflightTaskFiles.get(flightKey);
  if (pending) return pending;
  const load = (async (): Promise<CachedTaskFile> => {
    const content = await readFile(file, "utf8");
    let entry: CachedTaskFile;
    try {
      const { task, warning } = parseTaskFile(file, content);
      entry = { key, task, error: null, warning, id: task.id };
    } catch (err) {
      entry = { key, task: null, error: (err as Error).message, warning: null, id: salvageId(content, file) };
    }
    taskFileCache.set(file, entry);
    return entry;
  })().finally(() => inflightTaskFiles.delete(flightKey));
  inflightTaskFiles.set(flightKey, load);
  return load;
}

function cloneTask(task: TaskDefinition): TaskDefinition {
  return { ...task, targets: [...task.targets], dependsOn: [...task.dependsOn], labels: [...task.labels] };
}

function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}

/**
 * Once per file per process, on stderr — stdout may be `--json` an agent parses.
 * A malformed task file used to fail every command in the workspace (even
 * `awo context`), which is how one bad edit stopped every agent at once.
 */
function reportProblem(file: string, entry: CachedTaskFile): void {
  const message = entry.error ?? entry.warning;
  if (!message) return;
  const key = `${file}\0${message}`;
  if (reportedProblems.has(key)) return;
  reportedProblems.add(key);
  const text = message.split(file).join(displayPath(file));
  console.error(
    entry.error
      ? `awo: skipped malformed task file — ${text} Fix the file; \`awo doctor\` lists every one.`
      : `awo: warning — ${text}`
  );
}

async function taskFilesIn(goalDir: string): Promise<string[]> {
  const tasksDir = path.join(goalDir, "tasks");
  const names = await readdir(tasksDir).catch(() => [] as string[]);
  return names
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(tasksDir, f));
}

async function readGoalFrontmatter(goalFile: string): Promise<Record<string, unknown> | null> {
  const key = await statKey(goalFile);
  if (key === null) return null;
  const cached = goalFileCache.get(goalFile);
  if (cached && cached.key === key) return cached.data;
  const data = matter(await readFile(goalFile, "utf8")).data as Record<string, unknown>;
  goalFileCache.set(goalFile, { key, data });
  return data;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
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
  return (await scanGoals(workspaceRoot, options.includeArchived ?? true)).map((g) => g.goal);
}

async function scanGoals(
  workspaceRoot: string,
  includeArchived: boolean
): Promise<{ goal: GoalDefinition; tasks: TaskDefinition[] }[]> {
  const archiveRoot = goalArchiveDir(workspaceRoot);
  const out: { goal: GoalDefinition; tasks: TaskDefinition[] }[] = [];
  for (const dir of await goalDirs(workspaceRoot)) {
    const archived = path.dirname(dir) === archiveRoot;
    if (archived && !includeArchived) continue;
    const scanned = await goalDefinition(dir, archived);
    if (scanned) out.push(scanned);
  }
  return out;
}

/**
 * One goal by id. Goal folders are named after the goal (`<id>` or `<id>-<slug>`),
 * so look there first — `goal show` on atlas-shop otherwise parsed all 1,335 task
 * files to find one goal — and fall back to the full scan when the folder name
 * does not say.
 */
export async function locateGoal(workspaceRoot: string, goalId: string): Promise<GoalDefinition | null> {
  const archiveRoot = goalArchiveDir(workspaceRoot);
  if (/^[A-Za-z0-9._-]+$/.test(goalId) && !goalId.startsWith(".")) {
    for (const dir of await goalDirs(workspaceRoot)) {
      const name = path.basename(dir);
      if (name !== goalId && !name.startsWith(`${goalId}-`)) continue;
      const scanned = await goalDefinition(dir, path.dirname(dir) === archiveRoot);
      if (scanned?.goal.id === goalId) return scanned.goal;
    }
  }
  return (await findGoals(workspaceRoot)).find((g) => g.id === goalId) ?? null;
}

async function goalDefinition(
  dir: string,
  archived: boolean
): Promise<{ goal: GoalDefinition; tasks: TaskDefinition[] } | null> {
  const fm = await readGoalFrontmatter(path.join(dir, "goal.md"));
  if (!fm) return null;
  const id = typeof fm.id === "string" ? fm.id.trim() : path.basename(dir);
  const tasks = await findTasksInGoal(dir);
  const goal: GoalDefinition = {
    id,
    title: typeof fm.title === "string" ? fm.title : id,
    dir,
    targets: asArray(fm.targets),
    taskIds: tasks.map((t) => t.id),
    completionPolicy: completionPolicy(fm.completionPolicy),
    archived,
    deliveryBranch:
      typeof fm.deliveryBranch === "string" && fm.deliveryBranch.trim()
        ? fm.deliveryBranch.trim()
        : null,
    baseBranches: stringRecord(fm.baseBranches),
    pullRequestStrategy: fm.pullRequestStrategy === "goal-branch" ? "goal-branch" : "task",
  };
  return { goal, tasks };
}

/**
 * The goal's authored tasks. A malformed task file is skipped with a warning by
 * default, so one bad edit cannot stop every reader; `strict` makes it throw,
 * and the state writer uses that — skipping there would read the broken task's
 * state entry as orphaned and delete it.
 */
export async function findTasksInGoal(
  goalDir: string,
  options: { strict?: boolean } = {}
): Promise<TaskDefinition[]> {
  const files = await taskFilesIn(goalDir);
  const entries = await Promise.all(files.map((file) => loadTaskFile(file)));
  const tasks: TaskDefinition[] = [];
  entries.forEach((entry, i) => {
    if (!entry) return;
    if (entry.error && options.strict) throw new Error(entry.error);
    reportProblem(files[i], entry);
    if (entry.task) tasks.push(cloneTask(entry.task));
  });
  return tasks;
}

export interface LocatedTask {
  task: TaskDefinition;
  goal: GoalDefinition;
}

export async function findAllTasks(workspaceRoot: string): Promise<LocatedTask[]> {
  return (await scanGoals(workspaceRoot, true)).flatMap(({ goal, tasks }) =>
    tasks.map((task) => ({ task, goal }))
  );
}

/**
 * Fast path: task files are named after their id (`<id>.md`, or `<id>-<slug>.md`
 * in hand-authored workspaces), so try those before parsing the whole inventory.
 * Every single-task command (`task show/run/event/complete`) resolved its task by
 * scanning all 1,335 task files on atlas-shop. The parsed id must still match —
 * the filename is a hint, the frontmatter is the truth — and a miss falls back to
 * the full scan, so a renamed file is never "Unknown".
 */
async function locateByFilename(
  workspaceRoot: string,
  taskId: string
): Promise<{ hit: LocatedTask | null; error: string | null }> {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId.startsWith(".")) return { hit: null, error: null };
  const archiveRoot = goalArchiveDir(workspaceRoot);
  let error: string | null = null;
  for (const dir of await goalDirs(workspaceRoot)) {
    const names = await readdir(path.join(dir, "tasks")).catch(() => [] as string[]);
    const candidates = names
      .filter((n) => n.endsWith(".md") && (n === `${taskId}.md` || n.startsWith(`${taskId}-`)))
      .sort();
    for (const name of candidates) {
      const entry = await loadTaskFile(path.join(dir, "tasks", name));
      if (!entry) continue;
      if (entry.error && entry.id === taskId) error ??= entry.error;
      if (entry.task?.id !== taskId) continue;
      const scanned = await goalDefinition(dir, path.dirname(dir) === archiveRoot);
      if (scanned) return { hit: { task: cloneTask(entry.task), goal: scanned.goal }, error: null };
    }
  }
  return { hit: null, error };
}

export async function locateTask(workspaceRoot: string, taskId: string): Promise<LocatedTask> {
  const fast = await locateByFilename(workspaceRoot, taskId);
  if (fast.hit) return fast.hit;

  const all = await findAllTasks(workspaceRoot);
  const hit = all.find((t) => t.task.id === taskId);
  if (!hit) {
    // The task exists but its file does not parse: say that, not "unknown".
    const broken = fast.error ?? (await listTaskParseErrors(workspaceRoot)).find(
      (p) => p.severity === "error" && p.id === taskId
    )?.message;
    if (broken) throw new Error(broken);
    const known = all.map((t) => t.task.id);
    // On a real workspace the full list was 1,335 ids in one error line; the
    // nearest ones are what a typo needs.
    const near = known.filter((id) => id.startsWith(taskId.replace(/\d+$/, ""))).slice(-10);
    const shown = known.length > 20 ? (near.length > 0 ? near : known.slice(-10)) : known;
    throw new Error(
      known.length > 0
        ? `Unknown task "${taskId}". Known tasks: ${shown.join(", ")}${shown.length < known.length ? `, … (${known.length} total — \`awo task list --all\`)` : ""}.`
        : `Unknown task "${taskId}". No tasks exist yet — author one under goals/<goal>/tasks/.`
    );
  }
  return hit;
}

export interface TaskFileProblem {
  /** Absolute path of the task file. */
  file: string;
  /** The id the file declares, when it can still be read off it. */
  id: string | null;
  severity: "error" | "warning";
  message: string;
}

/**
 * Task files that were skipped (errors) or read with a caveat (warnings) — for
 * `awo doctor`, which reports what every other command only mentions on stderr.
 */
export async function listTaskParseErrors(workspaceRoot: string): Promise<TaskFileProblem[]> {
  const problems: TaskFileProblem[] = [];
  for (const dir of await goalDirs(workspaceRoot)) {
    const files = await taskFilesIn(dir);
    const entries = await Promise.all(files.map((file) => loadTaskFile(file)));
    for (const [i, entry] of entries.entries()) {
      const file = files[i];
      if (!entry) continue;
      if (entry.error) problems.push({ file, id: entry.id, severity: "error", message: entry.error });
      else if (entry.warning) problems.push({ file, id: entry.id, severity: "warning", message: entry.warning });
    }
  }
  return problems;
}
