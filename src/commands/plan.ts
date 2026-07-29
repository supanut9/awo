import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findAllTasks } from "../tasks.js";


/**
 * A requirement has no goal yet, so it cannot live in the goal folder the spec
 * shows. It sits at `requirements/<KEY>-R#.md` until `goal new --from` moves it in as
 * `requirement.md` — which is also what an agent did unprompted during the
 * first dogfood.
 */
function requirementPath(root: string, id: string): string {
  return path.join(root, "requirements", `${id}.md`);
}

async function nextId(root: string, key: string, letter: "R" | "G" | "T"): Promise<string> {
  const used = new Set<number>();
  const pattern = new RegExp(`^${key}-${letter}(\\d+)`);

  const consider = (name: string): void => {
    const m = pattern.exec(name);
    if (m) used.add(Number(m[1]));
  };

  for (const rel of ["goals", "requirements"]) {
    const dir = path.join(root, rel);
    if (await fs.pathExists(dir)) {
      for (const entry of await fs.readdir(dir)) consider(entry);
    }
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
  /** Content from an existing ticket, so an already-specified ask is not retyped. */
  bodyFile?: string;
  /** Skip refinement: a human PM already wrote the criteria. Still needs approval. */
  proposed?: boolean;
}): Promise<ReqNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { projectKey } = await readManifest(root);
  const id = await nextId(root, projectKey, "R");
  const file = requirementPath(root, id);

  // Frontmatter is serialized by the YAML library, never string-interpolated:
  // a title or source containing ":" or "#" would otherwise produce a file
  // that no longer parses.
  const imported = options.bodyFile
    ? await fs.readFile(path.resolve(options.cwd ?? process.cwd(), options.bodyFile), "utf8")
    : "";

  const body = matter.stringify(
    imported
      ? `\n# ${options.title}\n\n${imported.trim()}\n`
      : `\n# ${options.title}\n\n## Raw requirement
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
      // `--proposed` says a human already specified this, so it skips refinement —
      // but never approval. Only a person can accept the terms of the work.
      status: options.proposed ? "proposed" : "draft",
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
    const loose = (await fs.readdir(path.join(root, "requirements")).catch(() => []))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    throw new Error(
      loose.length > 0
        ? `No requirement "${options.from}" at requirements/${options.from}.md. Available: ${loose.join(", ")}.`
        : `No requirement "${options.from}" at requirements/${options.from}.md. Create one with \`awo req new --title "…"\`.`
    );
  }

  const parsed = matter(await fs.readFile(reqFile, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  const title = options.title ?? (typeof fm.title === "string" ? fm.title : options.from);

  const id = await nextId(root, projectKey, "G");
  // Directory is the ID alone. A slug here was truncated at 40 characters, so real
  // titles produced names cut mid-word with a trailing hyphen, and editing a title
  // would have stranded the path. The title lives in frontmatter, where it can change.
  // §16 — the gate. Planning from an unapproved requirement is how a wish becomes
  // six tasks and a broken feature: every task inherits the ambiguity, and the cost
  // of resolving it multiplies by the number of workers already building on it.
  const { readRequirement, findCriteria } = await import("./intake.js");
  const req = await readRequirement(root, options.from);
  if (req.status !== "approved") {
    throw new Error(
      `${options.from} is ${req.status}, not approved — planning cannot start from it.\n` +
        (req.status === "draft"
          ? `  Have the PM role write acceptance criteria:  awo req refine ${options.from}\n`
          : req.status === "proposed"
            ? `  It is waiting on you:  awo req approve ${options.from}\n` +
              `  (${findCriteria(req.body).length} acceptance criteria to read in ${req.file})\n`
            : `  It was rejected${req.data.decisionNote ? `: ${String(req.data.decisionNote)}` : ""}.\n` +
              `  Revise ${req.file}, then:  awo req propose ${options.from}\n`)
    );
  }

  const dir = path.join(root, "goals", id);
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
  const file = path.join(goal.dir, "tasks", `${id}.md`);

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
