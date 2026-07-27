import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findAllTasks } from "../tasks.js";

/**
 * §7.2 — these commands own the *mechanical* half of the pipeline: allocating
 * the next ID, placing files in the goal-centric layout, and wiring `taskIds`.
 * The *content* stays agent-driven (the `refine-requirement` and `plan-a-goal`
 * instructions), which is why each writes a skeleton with the section headings
 * §7.2 specifies rather than trying to invent prose.
 */

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * A requirement has no goal yet, so it cannot live in the goal folder the spec
 * shows. It sits at `goals/<KEY>-R#.md` until `goal new --from` moves it in as
 * `requirement.md` — which is also what an agent did unprompted during the
 * first dogfood.
 */
function requirementPath(root: string, id: string): string {
  return path.join(root, "goals", `${id}.md`);
}

async function nextId(root: string, key: string, letter: "R" | "G" | "T"): Promise<string> {
  const used = new Set<number>();
  const pattern = new RegExp(`^${key}-${letter}(\\d+)`);

  const consider = (name: string): void => {
    const m = pattern.exec(name);
    if (m) used.add(Number(m[1]));
  };

  const goalsRoot = path.join(root, "goals");
  if (await fs.pathExists(goalsRoot)) {
    for (const entry of await fs.readdir(goalsRoot)) consider(entry);
  }
  for (const goal of await findGoals(root)) {
    consider(path.basename(goal.dir));
    consider(goal.id);

    // A transformed requirement lives INSIDE the goal folder as
    // requirement.md, so its id is no longer visible in goals/'s listing.
    // Missing this reissued R1 to a second requirement while the first was
    // still referenced by goal.md's requirementId.
    const goalFm = matter(await fs.readFile(path.join(goal.dir, "goal.md"), "utf8")).data as Record<
      string,
      unknown
    >;
    if (typeof goalFm.requirementId === "string") consider(goalFm.requirementId);

    const reqFile = path.join(goal.dir, "requirement.md");
    if (await fs.pathExists(reqFile)) {
      const reqFm = matter(await fs.readFile(reqFile, "utf8")).data as Record<string, unknown>;
      if (typeof reqFm.id === "string") consider(reqFm.id);
    }
  }
  for (const { task } of await findAllTasks(root)) consider(task.id);

  let n = 1;
  while (used.has(n)) n += 1;
  return `${key}-${letter}${n}`;
}

export interface ReqNewResult {
  id: string;
  file: string;
}

export async function runReqNew(options: {
  title: string;
  cwd?: string;
  source?: string;
}): Promise<ReqNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { projectKey } = await readManifest(root);
  const id = await nextId(root, projectKey, "R");
  const file = requirementPath(root, id);

  // Frontmatter is serialized by the YAML library, never string-interpolated:
  // a title or source containing ":" or "#" would otherwise produce a file
  // that no longer parses.
  const body = matter.stringify(
    `\n# ${options.title}\n\n## Raw requirement
_Verbatim of what was asked._

## Clarifications
_Q&A gathered during intake._

## Draft acceptance criteria
- _…_
`,
    {
      id,
      type: "requirement",
      title: options.title,
      status: "draft",
      source: options.source ?? "unspecified",
      createdAt: new Date().toISOString(),
      goalId: null,
    }
  );

  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, body);
  return { id, file: path.relative(root, file) };
}

export interface GoalNewResult {
  id: string;
  dir: string;
  requirementId: string;
}

export async function runGoalNew(options: {
  from: string;
  title?: string;
  cwd?: string;
}): Promise<GoalNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { projectKey } = await readManifest(root);

  const reqFile = requirementPath(root, options.from);
  if (!(await fs.pathExists(reqFile))) {
    const loose = (await fs.readdir(path.join(root, "goals")).catch(() => []))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    throw new Error(
      loose.length > 0
        ? `No requirement "${options.from}" at goals/${options.from}.md. Available: ${loose.join(", ")}.`
        : `No requirement "${options.from}" at goals/${options.from}.md. Create one with \`awo req new --title "…"\`.`
    );
  }

  const parsed = matter(await fs.readFile(reqFile, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  const title = options.title ?? (typeof fm.title === "string" ? fm.title : options.from);

  const id = await nextId(root, projectKey, "G");
  const dir = path.join(root, "goals", `${id}-${slug(title)}`);
  await fs.ensureDir(path.join(dir, "tasks"));

  // The requirement moves into the goal folder, becoming requirement.md (§4).
  fm.goalId = id;
  await fs.writeFile(path.join(dir, "requirement.md"), matter.stringify(parsed.content, fm));
  await fs.remove(reqFile);

  await fs.writeFile(
    path.join(dir, "goal.md"),
    matter.stringify(
      `\n## Objective
_One paragraph: the outcome we want._

## Definition of done
- _Measurable success criteria._

## Scope & constraints
_In scope / out of scope / non-goals / constraints._

## Task breakdown
_Short rationale for how this goal splits into its tasks._
`,
      {
        id,
        title,
        status: "planning",
        requirementId: options.from,
        targets: [],
        taskIds: [],
        createdAt: new Date().toISOString(),
      }
    )
  );

  return { id, dir: path.relative(root, dir), requirementId: options.from };
}

export interface TaskNewResult {
  id: string;
  file: string;
  goalId: string;
}

export async function runTaskNew(options: {
  goal: string;
  name: string;
  targets?: string[];
  dependsOn?: string[];
  agent?: string;
  cwd?: string;
}): Promise<TaskNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);

  const goals = await findGoals(root);
  const goal = goals.find((g) => g.id === options.goal);
  if (!goal) {
    throw new Error(
      goals.length > 0
        ? `Unknown goal "${options.goal}". Known goals: ${goals.map((g) => g.id).join(", ")}.`
        : `Unknown goal "${options.goal}". Create one with \`awo goal new --from <req-id>\`.`
    );
  }

  // Same fail-fast rule as `task run` (§9 item 2): a target that isn't linked
  // is a mistake worth catching at authoring time, not at run time.
  const known = new Set(manifest.repos.map((r) => r.name));
  const unknown = (options.targets ?? []).filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `Targets not in the manifest: ${unknown.join(", ")}. Link them with \`awo connect\`/\`awo add\` first.`
    );
  }

  for (const dep of options.dependsOn ?? []) {
    const exists = (await findAllTasks(root)).some((t) => t.task.id === dep);
    if (!exists) throw new Error(`dependsOn references unknown task "${dep}".`);
  }

  const id = await nextId(root, manifest.projectKey, "T");
  const file = path.join(goal.dir, "tasks", `${id}-${slug(options.name)}.md`);

  await fs.writeFile(
    file,
    matter.stringify(
      `\n## Objective
_What "done" means for this unit._

## Steps
1. _…_

## Done when
- _…_
`,
      {
        id,
        goalId: goal.id,
        name: options.name,
        targets: options.targets ?? [],
        dependsOn: options.dependsOn ?? [],
        ...(options.agent ? { agent: options.agent } : {}),
        status: "todo",
      }
    )
  );

  // Keep the goal's taskIds in sync — it's the down-link in the traceability
  // chain, and nothing else maintains it.
  const goalFile = path.join(goal.dir, "goal.md");
  const parsed = matter(await fs.readFile(goalFile, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  const ids = Array.isArray(fm.taskIds) ? fm.taskIds.map(String) : [];
  if (!ids.includes(id)) ids.push(id);
  fm.taskIds = ids;
  await fs.writeFile(goalFile, matter.stringify(parsed.content, fm));

  return { id, file: path.relative(root, file), goalId: goal.id };
}
