import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest, type GoalPolicyName, type Manifest } from "../manifest.js";
import {
  findGoals,
  findAllTasks,
  TASK_KINDS,
  type CompletionPolicy,
  type TaskKind,
} from "../tasks.js";
import {
  invocationHint,
  planModeApprovesInSession,
  resolveModel,
  TIERS,
  type ResolvedModel,
  type Tier,
} from "../models.js";
import { allocateRunId, writeDetail } from "../runs.js";
import { mutateState, newTaskState } from "../state.js";
import { atomicWriteFile, withFileLock } from "../file-lock.js";


/**
 * A requirement has no goal yet, so it cannot live in the goal folder the spec
 * shows. It sits at `requirements/<KEY>-R#.md` until `goal new --from` moves it in as
 * `requirement.md` — which is also what an agent did unprompted during the
 * first dogfood.
 */
function requirementPath(root: string, id: string): string {
  return path.join(root, "requirements", `${id}.md`);
}

type IdLetter = "R" | "G" | "T";

/**
 * The highest number ever issued per id kind, kept beside the manifest.
 *
 * Scanning files alone cannot be monotonic: delete the newest task and its number
 * is free again. A reissued id is not harmless — `task run` reuses an existing
 * `feature/<id>` branch, so the new task silently starts on the old one's commits.
 */
function idCounterFile(root: string): string {
  return path.join(root, ".workspace", "id-counters.json");
}

async function readIdCounters(root: string): Promise<Partial<Record<IdLetter, number>>> {
  const raw = (await fs.readJson(idCounterFile(root)).catch(() => null)) as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Partial<Record<IdLetter, number>>)
    : {};
}

async function highestUsedId(root: string, key: string, letter: IdLetter): Promise<number> {
  let highest = 0;
  const pattern = new RegExp(`^${key}-${letter}(\\d+)`);

  const consider = (name: string): void => {
    const m = pattern.exec(name);
    if (m) highest = Math.max(highest, Number(m[1]));
  };

  // `requirements/archive` is included for the same reason the goal folders are
  // walked below: an id that leaves the directory this scan reads becomes free, and
  // gets handed to a second requirement. That already happened once with R1, and
  // shelving a requirement moves its file — so the archive must be scanned or every
  // suspension would set up a collision.
  for (const rel of ["goals", "requirements", path.join("requirements", "archive")]) {
    const dir = path.join(root, rel);
    if (await fs.pathExists(dir)) {
      for (const entry of await fs.readdir(dir)) consider(entry);
    }
  }
  // findGoals includes goals/archive/, and each goal's taskIds are read from its
  // task files — so archived work holds on to its numbers too.
  for (const goal of await findGoals(root)) {
    consider(path.basename(goal.dir));
    consider(goal.id);
    for (const taskId of goal.taskIds) consider(taskId);

    // A transformed requirement lives INSIDE the goal folder as
    // requirement.md, so its id is no longer visible in goals/'s listing.
    // Missing this reissued R1 to a second requirement while the first was
    // still referenced by goal.md's requirementId.
    const goalFm = matter(await fs.readFile(path.join(goal.dir, "goal.md"), "utf8")).data as Record<
      string,
      unknown
    >;
    if (typeof goalFm.requirementId === "string") consider(goalFm.requirementId);
    // A task deleted from disk is still named here until someone edits it out.
    if (Array.isArray(goalFm.taskIds)) goalFm.taskIds.forEach((t) => consider(String(t)));

    const reqFile = path.join(goal.dir, "requirement.md");
    if (await fs.pathExists(reqFile)) {
      const reqFm = matter(await fs.readFile(reqFile, "utf8")).data as Record<string, unknown>;
      if (typeof reqFm.id === "string") consider(reqFm.id);
    }
  }
  return highest;
}

/**
 * Allocate the next id — highest ever used + 1, never a gap — and create what it
 * names while holding the allocation lock.
 *
 * Gap-filling reissued numbers that had already meant something, and nothing
 * serialized allocation: two `task new` calls at the same moment could compute the
 * same "next" id, and the second write would replace the first file. Creation
 * happens inside the lock so the next allocator sees the file, and every create
 * uses an exclusive flag so anything the scan missed fails loudly instead.
 */
async function withNextId<T>(
  root: string,
  key: string,
  letter: IdLetter,
  create: (id: string) => Promise<T>
): Promise<T> {
  return withFileLock(idCounterFile(root), async () => {
    const counters = await readIdCounters(root);
    const issued = typeof counters[letter] === "number" ? counters[letter]! : 0;
    const n = Math.max(await highestUsedId(root, key, letter), issued) + 1;
    const result = await create(`${key}-${letter}${n}`);
    await atomicWriteFile(idCounterFile(root), `${JSON.stringify({ ...counters, [letter]: n }, null, 2)}\n`);
    return result;
  });
}

/** Write a file that must not exist yet. */
async function createExclusive(root: string, file: string, text: string): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  try {
    await fs.writeFile(file, text, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `${path.relative(root, file)} already exists, so its id cannot be issued again. Nothing was overwritten.\n` +
        `  A file placed there by hand is invisible to id allocation until it has a matching \`id:\`; ` +
        `fix or move it, then re-run the command.`
    );
  }
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

  // Frontmatter is serialized by the YAML library, never string-interpolated:
  // a title or source containing ":" or "#" would otherwise produce a file
  // that no longer parses.
  const imported = options.bodyFile
    ? await fs.readFile(path.resolve(options.cwd ?? process.cwd(), options.bodyFile), "utf8")
    : "";

  return withNextId(root, projectKey, "R", async (id) => {
    const file = requirementPath(root, id);
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
    await createExclusive(root, file, body);
    return { id, file: path.relative(root, file) };
  });
}

export interface GoalNewResult {
  id: string;
  dir: string;
  requirementId: string;
  policy: GoalPolicyName;
  /** The asset directory carried in with the requirement, if it had one. */
  movedAssets: string | null;
}

/**
 * How strictly a goal proves itself, by name (see `GoalPolicyName`).
 *
 * Every goal used to be strict, so a workspace that did not want a QA verdict for a
 * one-line change got there by editing `completionPolicy` by hand after the fact —
 * the only goals that ever reached `done` in one workspace did exactly that.
 * Choosing at creation is the honest version of the same decision.
 */
export const GOAL_POLICIES: Record<GoalPolicyName, CompletionPolicy> = {
  light: { qaRequired: false, acceptanceEvidenceRequired: false },
  standard: { qaRequired: false, acceptanceEvidenceRequired: true },
  strict: { qaRequired: true, acceptanceEvidenceRequired: true },
};

/** Why a task or goal exists — planned up front, or found by a later step. */
export const ORIGINS = ["plan", "qa-gap", "pr-feedback", "follow-up"] as const;
export type Origin = (typeof ORIGINS)[number];

function assertOrigin(origin: string | undefined): Origin {
  if (origin === undefined) return "plan";
  if (!ORIGINS.includes(origin as Origin)) {
    throw new Error(`Unknown origin "${origin}". Valid: ${ORIGINS.join(", ")}.`);
  }
  return origin as Origin;
}

function resolveGoalPolicy(manifest: Manifest, requested: string | undefined): GoalPolicyName {
  const declared = manifest.goals?.defaultPolicy;
  const name = requested ?? declared ?? "strict";
  if (!(name in GOAL_POLICIES)) {
    throw new Error(
      requested !== undefined
        ? `Unknown --policy "${requested}". Valid: ${Object.keys(GOAL_POLICIES).join(", ")}.`
        : `Invalid goals.defaultPolicy "${String(declared)}" in .workspace/manifest.json. ` +
            `Valid: ${Object.keys(GOAL_POLICIES).join(", ")}.`
    );
  }
  return name as GoalPolicyName;
}

export async function runGoalNew(options: {
  from: string;
  title?: string;
  cwd?: string;
  /** light | standard | strict; defaults to `goals.defaultPolicy`, else strict. */
  policy?: string;
  origin?: string;
}): Promise<GoalNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  const policy = resolveGoalPolicy(manifest, options.policy);
  const origin = assertOrigin(options.origin);

  const reqFile = requirementPath(root, options.from);
  if (!(await fs.pathExists(reqFile))) {
    // Distinguish "no such requirement" from "shelved". Both are missing from
    // intake, and only one of them is a typo.
    const archived = path.join(root, "requirements", "archive", `${options.from}.md`);
    if (await fs.pathExists(archived)) {
      const { readRequirement } = await import("./intake.js");
      const shelved = await readRequirement(root, options.from);
      throw new Error(
        `${options.from} is ${shelved.status} and lives in ${shelved.file}, so planning cannot start from it.\n` +
          (shelved.data.decisionNote ? `  Reason given: ${String(shelved.data.decisionNote)}\n` : "") +
          `  Bring it back deliberately first:  awo req resume ${options.from}`
      );
    }
    const loose = (await fs.readdir(path.join(root, "requirements")).catch(() => []))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    throw new Error(
      loose.length > 0
        ? `No requirement "${options.from}" at requirements/${options.from}.md. Available: ${loose.join(", ")}.`
        : `No requirement "${options.from}" at requirements/${options.from}.md. Create one with \`awo req new --title "…"\`.`
    );
  }

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

  return withNextId(root, manifest.projectKey, "G", async (id) => {
    // Read inside the lock: two `goal new --from` on one requirement would otherwise
    // both pass the check above and plan it twice.
    if (!(await fs.pathExists(reqFile))) {
      throw new Error(`${options.from} was planned by another \`awo goal new\` a moment ago. Nothing was written.`);
    }
    const parsed = matter(await fs.readFile(reqFile, "utf8"));
    const fm = parsed.data as Record<string, unknown>;
    const title = options.title ?? (typeof fm.title === "string" ? fm.title : options.from);

    // Directory is the ID alone. A slug here was truncated at 40 characters, so real
    // titles produced names cut mid-word with a trailing hyphen, and editing a title
    // would have stranded the path. The title lives in frontmatter, where it can change.
    const dir = path.join(root, "goals", id);
    await fs.ensureDir(path.dirname(dir));
    // Not ensureDir: an existing directory is a collision to refuse, not reuse.
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      throw new Error(`goals/${id}/ already exists, so ${id} cannot be issued again. Nothing was written.`);
    }

    try {
      await fs.ensureDir(path.join(dir, "tasks"));
      await createExclusive(root, path.join(dir, "goal.md"), matter.stringify(
        `\n## Objective
_One paragraph: the outcome we want._

## Definition of done
- _Measurable success criteria._

## Scope & constraints
_In scope / out of scope / non-goals / constraints._

## Task breakdown
_Short rationale for how this goal splits into its tasks._

## Decisions so far
<!-- An INDEX, not a store: one line per resolved decision task, enough to judge
     relevance, pointing at the task that holds the detail. A decision written out
     in two places disagrees with itself within a fortnight. -->

## Not yet specified
<!-- Questions you can tell are coming but cannot phrase sharply yet. The test is
     whether you can state the question now, not whether you can answer it: a sharp
     question is a decision task, a vague area belongs here. See skills/chart-the-unknown.
     Delete this section when the goal was never foggy. -->
`,
        {
          id,
          title,
          // No authored `status:`. state.json is canonical, and a `status: planning`
          // written once and never updated outlived the planning phase in 93 of 113
          // goal files in the largest workspace — readers believed it.
          requirementId: options.from,
          targets: [],
          taskIds: [],
          completionPolicy: { ...GOAL_POLICIES[policy] },
          origin,
          createdAt: new Date().toISOString(),
        }
      ));

      // The requirement moves into the goal folder, becoming requirement.md (§4).
      fm.goalId = id;
      await createExclusive(root, path.join(dir, "requirement.md"), matter.stringify(parsed.content, fm));
    } catch (err) {
      // The requirement is still in intake, so the half-made goal is the only thing
      // to undo.
      await fs.remove(dir).catch(() => {});
      throw err;
    }
    await fs.remove(reqFile);

    // A requirement and the files it links are one artifact, so the sibling asset
    // directory moves with it.
    //
    // It did not, and the document's relative links then resolved to nothing:
    // SHOP-R2 lost all nine of its Figma exports on 2026-08-03, they were moved by
    // hand, and the workspace grew a shell script and a required rule to stop it
    // happening again. That is a lot of process for a directory rename.
    const assets = path.join(root, "requirements", `${options.from}-assets`);
    const movedAssets = (await fs.pathExists(assets))
      ? await fs
          .move(assets, path.join(dir, `${options.from}-assets`), { overwrite: false })
          .then(() => true)
          .catch(() => false)
      : false;

    return {
      id,
      dir: path.relative(root, dir),
      requirementId: options.from,
      policy,
      movedAssets: movedAssets ? `${options.from}-assets` : null,
    };
  });
}

export interface GoalPlanResult {
  goalId: string;
  briefRunId: string;
  model: ResolvedModel;
  invocation: string;
  /** How to execute after approval, when the runtime cannot lift its own sandbox. */
  executeInvocation: string | null;
  planMode: boolean;
  approvesInSession: boolean;
  existingTasks: string[];
  targets: string[];
  /** Repos in `targets` with no declared test command — a planning blocker. */
  targetsWithoutTests: string[];
}

/**
 * §7.2 — the tech-lead's decomposition step, in plan mode by default.
 *
 * `instructions/plan-a-goal.md` and `agents/tech-lead.md` have both said "own `awo
 * goal plan`" since the template shipped, and the command did not exist: planning
 * was freehand `awo task new` calls with nothing between the goal and 39 task files.
 * SHOP-G1 is what that looks like — the first opportunity to disagree with the shape
 * of the work arrived after every file had been written.
 *
 * So this command does not create tasks. It assembles what a planner needs, records
 * the brief, and hands back an invocation that is read-only until a human approves
 * the breakdown. On approval the same session runs `awo task new` per task, which
 * keeps ID allocation and the goal's `taskIds` where they belong — with the CLI.
 */
export async function runGoalPlan(
  goalId: string,
  options: { cwd?: string; write?: boolean } = {}
): Promise<GoalPlanResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);

  const goals = await findGoals(root);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    throw new Error(
      goals.length > 0
        ? `Unknown goal "${goalId}". Known goals: ${goals.map((g) => g.id).join(", ")}.`
        : `Unknown goal "${goalId}". Create one with \`awo goal new --from <req-id>\`.`
    );
  }

  const goalBody = await fs.readFile(path.join(goal.dir, "goal.md"), "utf8");
  const reqFile = path.join(goal.dir, "requirement.md");
  const reqBody = (await fs.pathExists(reqFile)) ? await fs.readFile(reqFile, "utf8") : "";

  const { findTasksInGoal } = await import("../tasks.js");
  const existing = await findTasksInGoal(goal.dir);

  const fm = matter(goalBody).data as Record<string, unknown>;
  const targets = (Array.isArray(fm.targets) ? fm.targets : []).map(String);
  const declared = new Map(manifest.repos.map((r) => [r.name, r]));
  const unknownTargets = targets.filter((t) => !declared.has(t));
  if (unknownTargets.length > 0) {
    throw new Error(
      `${goal.id} targets repos that are not linked: ${unknownTargets.join(", ")}. ` +
        `Link them with \`awo connect\`/\`awo add\`, or fix \`targets:\` in ${path.relative(root, path.join(goal.dir, "goal.md"))}.`
    );
  }
  // Named before planning rather than discovered during it: a task whose repo cannot
  // state how it verifies itself is a task whose agent will invent a command, and an
  // agent choosing the verification is the same failure as an agent asserting the result.
  const targetsWithoutTests = targets.filter((t) => !declared.get(t)?.testCommand);

  // Decomposition is judgment, so it runs at the high tier whatever the tasks will use.
  const model = await resolveModel(root, "tech-lead", "high");
  const planMode = !options.write;

  const availableAgents = await installedAgents(root);
  const brief = buildPlanBrief({
    goalId: goal.id,
    goalBody,
    reqBody,
    existing: existing.map((t) => `${t.id} — ${t.name} (${t.authoredStatus})`),
    targets,
    targetsWithoutTests,
    availableAgents,
    planMode,
  });

  const briefRunId = await allocateRunId(root, goal.id);
  await writeDetail(
    root,
    briefRunId,
    {
      kind: "plan-brief",
      goal: goal.id,
      model: `${model.runtime}:${model.model}`,
      mode: planMode ? "plan" : "write",
      existingTasks: existing.length,
    },
    { interpreted: `Task decomposition brief for ${goal.id}`, summary: brief }
  );

  const context = { cwd: ".", prompt: `$(awo log show ${briefRunId})` };
  const approvesInSession = planModeApprovesInSession(model.runtime);

  return {
    goalId: goal.id,
    briefRunId,
    model,
    invocation: invocationHint(model, goal.id, { ...context, planMode }),
    // Codex holds `-s read-only` for the life of the process, so approval cannot be
    // followed by writes in the same run. Hand over the second command explicitly
    // instead of leaving the user waiting for a prompt that will never appear.
    executeInvocation:
      planMode && !approvesInSession ? invocationHint(model, goal.id, context) : null,
    planMode,
    approvesInSession,
    existingTasks: existing.map((t) => t.id),
    targets,
    targetsWithoutTests,
  };
}

/** Roles that are installed, so a planner assigns work to one that exists. */
async function installedAgents(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, "agents")).catch(() => []))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

function buildPlanBrief(input: {
  goalId: string;
  goalBody: string;
  reqBody: string;
  existing: string[];
  targets: string[];
  targetsWithoutTests: string[];
  availableAgents: string[];
  planMode: boolean;
}): string {
  const lines = [
    `You are the tech-lead planning ${input.goalId} into tasks.`,
    "",
    input.planMode
      ? `You are in PLAN MODE. Explore and read whatever you need, then present the\n` +
        `proposed task breakdown for approval. Create NOTHING until it is approved.\n` +
        `Once it is, execute the plan yourself with the \`awo task new\` calls below.`
      : `You are in WRITE MODE — no approval gate. Create the tasks directly.`,
    "",
    `## The goal`,
    input.goalBody.trim(),
    "",
  ];

  if (input.reqBody.trim()) {
    lines.push(
      `## The requirement it came from`,
      `Every acceptance criterion below must be covered by at least one task, or`,
      `named as out of scope with a reason.`,
      "",
      input.reqBody.trim(),
      ""
    );
  }

  if (input.existing.length > 0) {
    lines.push(
      `## Tasks that already exist`,
      `Do NOT recreate these. Say plainly whether each still fits the plan:`,
      ...input.existing.map((t) => `- ${t}`),
      ""
    );
  }

  lines.push(
    `## Repos in scope`,
    input.targets.length > 0
      ? input.targets.map((t) => `- ${t}`).join("\n")
      : `- none declared in the goal's \`targets:\` — fix that before planning`,
    ""
  );

  if (input.targetsWithoutTests.length > 0) {
    lines.push(
      `**These repos cannot say how they verify themselves:** ${input.targetsWithoutTests.join(", ")}.`,
      `A task there cannot satisfy \`tests-must-pass\` without an agent inventing a`,
      `command. Declare it first:  awo test-command <repo> "<cmd>"`,
      ""
    );
  }

  lines.push(
    `## What to produce`,
    `A task per unit of work that one agent can finish and verify on its own. For each:`,
    `- **name** — the outcome, not the activity.`,
    `- **targets** — a subset of the goal's targets. A repo you only mention in prose`,
    `  gets no worktree, so the work has nowhere to happen.`,
    `- **dependsOn** — real ordering only. A dependent task branches from its`,
    `  dependency's work, so a missing edge silently breaks the chain.`,
    `- **agent** — one of: ${input.availableAgents.join(", ") || "none installed"}.`,
    `  \`awo agent list\` shows what is still in the catalog; schema and data-model`,
    `  work belongs to \`data-engineer\`, not \`software-engineer\`.`,
    `- **kind** — implementation, investigation, verification, decision, or`,
    `  deployment-data. Evidence requirements follow from it. Investigation and`,
    `  decision work changes no repo: omit --targets, name what it delivers with`,
    `  --output <path>.`,
    `- **criteria** — which of the requirement's acceptance criteria it serves`,
    `  (1-based numbers, or AC-<n> labels). The worker's brief shows exactly those.`,
    `- **--tier high** on a task whose work needs judgment even though its role`,
    `  normally runs low (e.g. "define the data model").`,
    "",
    `Create each one with:`,
    `  awo task new --goal ${input.goalId} --name "…" --targets <repo> --objective "…" \\`,
    `    --done-when "…" "…" [--criteria 1,3] [--depends-on <id>] [--agent <role>] [--kind <kind>] [--tier high]`,
    `It allocates the id, places the file, validates targets, and wires the goal's`,
    `taskIds. Do NOT hand-author task files or invent ids — the command owns both.`,
    `--objective and --done-when become the body, so no task is created as an`,
    `unwritten template. For a longer body, write the markdown to a file and pass`,
    `--body-file <path> (or --body-file - to read stdin) instead.`,
    "",
    `Leave every task in \`todo\`. Planning does not start work.`,
    "",
    `## Boundaries`,
    `- Do not touch repos, write code, or open a PR.`,
    `- Do not mark the goal or any task as anything other than \`todo\`.`,
    input.planMode
      ? `- Approving this plan is a permission in THIS session. It is not the`
        + ` workspace's\n  human-approval gate: the tasks you create still await human`
        + ` review before\n  \`awo task run\` (rule: human-approval-required).`
      : `- The tasks you create await human review before \`awo task run\`.`,
  );

  return lines.join("\n");
}

export interface TaskNewResult {
  id: string;
  file: string;
  goalId: string;
}

/** The skeleton a task gets when nobody says what it is for. */
const TASK_TEMPLATE_BODY = `\n## Objective
_What "done" means for this unit._

## Steps
1. _…_

## Done when
- _…_
`;

/** Kinds whose work changes no repo, so a task may legitimately have no targets. */
const TARGETLESS_KINDS: readonly TaskKind[] = ["investigation", "decision"];

/**
 * The task body from what the author supplied.
 *
 * 22% of first briefs in the largest workspace were the unwritten skeleton: the
 * planner ran `task new`, meant to fill the file in afterwards, and the worker was
 * dispatched first. Taking the objective and done-when at creation means a body
 * built from flags is finished the moment it exists — it carries no placeholder.
 */
function composeTaskBody(options: { body?: string; objective?: string; doneWhen?: string[] }): string {
  const doneWhen = (options.doneWhen ?? []).map((d) => d.trim()).filter(Boolean);
  const objective = options.objective?.trim() ?? "";
  if (options.body !== undefined) {
    if (objective || doneWhen.length > 0) {
      throw new Error(
        `Pass either a body (--body-file) or --objective/--done-when, not both — ` +
          `the body file would silently replace them. Put the objective in the file.`
      );
    }
    const text = options.body.trim();
    if (!text) throw new Error(`The task body is empty. Write the Objective and Done when, or drop --body-file.`);
    if (matter.test(text)) {
      throw new Error(
        `The task body starts with its own frontmatter. Pass only the markdown body — ` +
          `awo writes the frontmatter (id, goalId, targets, …) itself.`
      );
    }
    return `\n${text}\n`;
  }
  if (!objective && doneWhen.length === 0) return TASK_TEMPLATE_BODY;
  return (
    "\n" +
    [
      objective ? `## Objective\n${objective}\n` : "",
      doneWhen.length > 0 ? `## Done when\n${doneWhen.map((d) => `- ${d}`).join("\n")}\n` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

/** `--criteria 1,3,AC-17` → [1, 3, "AC-17"]. */
export function parseCriteriaRefs(values: string[]): (number | string)[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      if (/^\d+$/.test(v) && Number(v) >= 1) return Number(v);
      if (/^AC-\d+$/i.test(v)) return v.toUpperCase();
      throw new Error(
        `--criteria takes the goal's acceptance-criterion numbers (1-based) or AC-<n> labels, ` +
          `comma-separated (e.g. --criteria 1,3 or --criteria AC-17); got "${v}".`
      );
    });
}

export async function runTaskNew(options: {
  goal: string;
  name: string;
  targets?: string[];
  dependsOn?: string[];
  agent?: string;
  kind?: TaskKind;
  /** PR labels for this task. Applied only if the repo already has them (§18). */
  labels?: string[];
  /** The whole markdown body — from `--body-file`, or a control-plane command. */
  body?: string;
  /** Builds the body instead of the skeleton. Not combinable with `body`. */
  objective?: string;
  doneWhen?: string[];
  /** Goal acceptance criteria this task serves: 1-based numbers or AC-<n> labels. */
  criteria?: (number | string)[];
  tier?: string;
  /** What the task delivers besides commits, e.g. a research document. */
  outputs?: string[];
  origin?: string;
  /**
   * Refuse a task with no targets unless its kind changes no repo. Set by the CLI;
   * control-plane callers (a QA gap, PR feedback) derive targets themselves, and a
   * verdict must not fail half-way because a goal declared none.
   */
  enforceTargets?: boolean;
  cwd?: string;
}): Promise<TaskNewResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);

  if (options.kind && !TASK_KINDS.includes(options.kind)) {
    throw new Error(`Unknown task kind "${options.kind}". Valid: ${TASK_KINDS.join(", ")}.`);
  }
  if (options.tier !== undefined && !TIERS.includes(options.tier as Tier)) {
    throw new Error(`Unknown tier "${options.tier}". Valid: ${TIERS.join(", ")}.`);
  }
  const origin = assertOrigin(options.origin);
  const kind = options.kind ?? "implementation";
  const body = composeTaskBody(options);

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

  // A repo the author only mentioned in prose gets no worktree, so implementation
  // work with no targets has nowhere to happen. Investigation and decision work
  // changes no repo, which is why those two kinds may leave targets empty.
  if (options.enforceTargets && (options.targets ?? []).length === 0 && !TARGETLESS_KINDS.includes(kind)) {
    throw new Error(
      `${kind} work needs at least one target repo: --targets <repo>` +
        (known.size > 0 ? ` (linked: ${[...known].join(", ")})` : ` — link one first with \`awo connect\`/\`awo add\``) +
        `.\n  Work that changes no repo is --kind investigation or --kind decision, which may omit --targets.`
    );
  }

  const criteria = options.criteria ?? [];
  if (criteria.length > 0) await assertCriteriaExist(root, goal.id, goal.dir, criteria);

  return withNextId(root, manifest.projectKey, "T", async (id) => {
    const file = path.join(goal.dir, "tasks", `${id}.md`);
    const taskBody = matter.stringify(body, {
      id,
      goalId: goal.id,
      name: options.name,
      targets: options.targets ?? [],
      dependsOn: options.dependsOn ?? [],
      ...(options.agent ? { agent: options.agent } : {}),
      kind,
      ...(options.tier ? { tier: options.tier } : {}),
      ...(criteria.length > 0 ? { criteria } : {}),
      ...(options.outputs?.length ? { outputs: options.outputs } : {}),
      ...(options.labels?.length ? { labels: options.labels } : {}),
      // No authored `status:` — a new task is `todo`, the default, and state.json
      // owns every status after that. A frontmatter `status: todo` beside a task
      // that has been done for a month is a claim nobody maintains.
      origin,
      createdAt: new Date().toISOString(),
    });

    // Keep the goal's taskIds in sync — it's the down-link in the traceability
    // chain, and nothing else maintains it. Inside the allocation lock, so two
    // concurrent `task new` on one goal cannot each drop the other's id.
    const goalFile = path.join(goal.dir, "goal.md");
    const originalGoal = await fs.readFile(goalFile, "utf8");
    const parsed = matter(originalGoal);
    const fm = parsed.data as Record<string, unknown>;
    const ids = Array.isArray(fm.taskIds) ? fm.taskIds.map(String) : [];
    if (!ids.includes(id)) ids.push(id);
    fm.taskIds = ids;

    // These three writes are one logical operation. Roll authored files back if
    // the atomic state writer fails, so a stored `done` goal cannot survive beside
    // newly-created work (the real SHOP-G12 failure).
    await createExclusive(root, file, taskBody);
    try {
      await fs.writeFile(goalFile, matter.stringify(parsed.content, fm));
      await mutateState(goal.dir, goal.id, (state) => {
        state.tasks[id] = newTaskState("todo");
        delete state.qa;
      });
    } catch (err) {
      await fs.remove(file).catch(() => {});
      await fs.writeFile(goalFile, originalGoal).catch(() => {});
      throw err;
    }

    return { id, file: path.relative(root, file), goalId: goal.id };
  });
}

/**
 * A criterion reference that points at nothing is caught here, at authoring time,
 * for the same reason an unlinked target is: the brief would otherwise hand the
 * worker a criterion that does not exist.
 */
async function assertCriteriaExist(
  root: string,
  goalId: string,
  goalDir: string,
  refs: (number | string)[]
): Promise<void> {
  const reqFile = path.join(goalDir, "requirement.md");
  if (!(await fs.pathExists(reqFile))) return;
  const content = matter(await fs.readFile(reqFile, "utf8")).content;
  const { findCriteria } = await import("./intake.js");
  const count = findCriteria(content).length;
  const missing = refs.filter((ref) =>
    typeof ref === "number" ? ref > count : !new RegExp(`\\b${ref}\\b`, "i").test(content)
  );
  if (missing.length > 0) {
    throw new Error(
      `${goalId} has no acceptance criterion ${missing.join(", ")} — ` +
        `${path.relative(root, reqFile)} lists ${count}. Check the numbering with \`awo goal trace ${goalId}\`.`
    );
  }
}
