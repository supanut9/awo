import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { invocationHint, planModeApprovesInSession, resolveModel } from "../models.js";
import { allocateRunId, writeDetail } from "../runs.js";

/**
 * §16 — the one human gate that cannot be delegated.
 *
 * Requirements arrive two ways and both are normal: a real PM has already written
 * one in JIRA, or someone says "we need an FAQ on the product page" with nothing
 * behind it. Treating those identically is wrong — the first is already specified,
 * the second is a wish.
 *
 *   draft ──(PM agent adds acceptance criteria)──▶ proposed ──(human)──▶ approved
 *                                                      └────────────▶ rejected
 *
 * `goal new --from` refuses anything not approved. That is the gate, and it is
 * deliberately on the *shortest* artefact in the workflow: defects concentrate at
 * specification-implementation mismatch, so twenty minutes here is worth more than
 * a day spent reading diffs — which is the whole argument for putting the human
 * upstream rather than at the end.
 */
export const REQ_STATUSES = [
  "draft",
  "proposed",
  "approved",
  "rejected",
  "suspended",
  "cancelled",
] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

/**
 * Statuses whose file lives in `requirements/archive/` rather than in intake.
 *
 * Flipping a status and leaving the file where it was made `requirements/` a pile
 * of things nobody intends to build, which is noise exactly where the workflow
 * wants a short list of what is actually wanted. The status is still the truth;
 * the directory follows it.
 *
 * `rejected` is here as a deliberate choice: a rejection is meant to be revised
 * and re-proposed, and `req propose` moves it back into intake when that happens,
 * so the round trip stays possible without leaving the file in the way meanwhile.
 */
export const ARCHIVED_STATUSES: readonly ReqStatus[] = ["rejected", "suspended", "cancelled"];

export function isArchivedStatus(status: ReqStatus): boolean {
  return ARCHIVED_STATUSES.includes(status);
}

export interface Requirement {
  id: string;
  file: string;
  title: string;
  status: ReqStatus;
  source: string;
  goalId: string | null;
  body: string;
  data: Record<string, unknown>;
  /** True when the file currently sits in `requirements/archive/`. */
  archived: boolean;
}

export function requirementsDir(root: string): string {
  return path.join(root, "requirements");
}

/** Where a requirement nobody intends to build right now is kept (§7.2). */
export function requirementArchiveDir(root: string): string {
  return path.join(root, "requirements", "archive");
}

/** Both places a requirement file may legitimately be, intake first. */
function candidatePaths(root: string, id: string): string[] {
  return [
    path.join(requirementsDir(root), `${id}.md`),
    path.join(requirementArchiveDir(root), `${id}.md`),
  ];
}

export async function readRequirement(root: string, id: string): Promise<Requirement> {
  // Intake first, then the archive: a rejected or suspended requirement must stay
  // readable and revisable, or archiving it would amount to deleting it.
  let file: string | null = null;
  for (const candidate of candidatePaths(root, id)) {
    if (await fs.pathExists(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) {
    const known = await listRequirements(root, { includeArchived: true });
    throw new Error(
      known.length > 0
        ? `No requirement "${id}". Known: ${known.map((r) => `${r.id} (${r.status})`).join(", ")}.`
        : `No requirement "${id}". Capture one with \`awo req new --title "…"\`.`
    );
  }
  const parsed = matter(await fs.readFile(file, "utf8"));
  const data = parsed.data as Record<string, unknown>;
  return {
    id,
    file: path.relative(root, file),
    title: String(data.title ?? id),
    // Anything unrecognised reads as draft rather than throwing: a hand-authored
    // requirement should be usable, just not approvable without going through the
    // gate.
    status: (REQ_STATUSES as readonly string[]).includes(String(data.status))
      ? (data.status as ReqStatus)
      : "draft",
    source: String(data.source ?? "unspecified"),
    goalId: (data.goalId as string | null) ?? null,
    body: parsed.content,
    data,
    archived: path.dirname(file) === requirementArchiveDir(root),
  };
}

/**
 * Requirements in intake. Archived ones are excluded unless asked for, which is
 * the whole point: the default answer to "what are we working on?" should not
 * include what was parked or killed.
 */
export async function listRequirements(
  root: string,
  options: { includeArchived?: boolean } = {}
): Promise<Requirement[]> {
  const dirs = options.includeArchived
    ? [requirementsDir(root), requirementArchiveDir(root)]
    : [requirementsDir(root)];

  const ids = new Set<string>();
  for (const dir of dirs) {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (f.endsWith(".md")) ids.add(f.replace(/\.md$/, ""));
    }
  }

  const out: Requirement[] = [];
  for (const id of [...ids].sort()) out.push(await readRequirement(root, id));
  return out;
}

/** Every requirement id on disk, wherever it sits — what ID allocation must see. */
export async function allRequirementIds(root: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const dir of [requirementsDir(root), requirementArchiveDir(root)]) {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (f.endsWith(".md")) ids.add(f.replace(/\.md$/, ""));
    }
  }
  return [...ids];
}

/**
 * Write the new status, and put the file where that status belongs.
 *
 * The directory follows the status rather than being chosen separately, so the two
 * cannot disagree — a `cancelled` requirement sitting in intake, or a `draft` one
 * hidden in the archive, are both states nothing here can produce.
 *
 * Returns where the file ended up, workspace-relative.
 */
async function setStatus(
  root: string,
  req: Requirement,
  status: ReqStatus,
  extra: Record<string, unknown> = {}
): Promise<{ file: string; moved: boolean; movedAssets: string | null }> {
  const from = path.join(root, req.file);
  const wantArchived = isArchivedStatus(status);
  const targetDir = wantArchived ? requirementArchiveDir(root) : requirementsDir(root);
  const to = path.join(targetDir, `${req.id}.md`);

  const next: Record<string, unknown> = { ...req.data, status, ...extra };
  // An explicit `undefined` means "drop this key". Leaving it in place would ask the
  // YAML dumper to serialise undefined, which throws.
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  await fs.ensureDir(targetDir);
  await fs.writeFile(from, matter.stringify(req.body, next));

  let movedAssets: string | null = null;
  if (path.resolve(from) !== path.resolve(to)) {
    await fs.move(from, to, { overwrite: true });

    // The same rule as `goal new`: a requirement and the files it links are one
    // artifact, so the sibling asset directory travels with it. Leaving it behind
    // breaks every relative link in the document, which is how SHOP-R2 lost nine
    // Figma exports.
    const assetsFrom = path.join(path.dirname(from), `${req.id}-assets`);
    if (await fs.pathExists(assetsFrom)) {
      const assetsTo = path.join(targetDir, `${req.id}-assets`);
      await fs.move(assetsFrom, assetsTo, { overwrite: true }).catch(() => undefined);
      movedAssets = path.relative(root, assetsTo);
    }
  }

  return {
    file: path.relative(root, to),
    moved: path.resolve(from) !== path.resolve(to),
    movedAssets,
  };
}

// ---------------------------------------------------------------------------
// acceptance criteria
// ---------------------------------------------------------------------------

/**
 * Criteria have to be checkable, so "checkable" is checked.
 *
 * Given-When-Then is the shape of a test, which is the point: criteria written this
 * way convert human review into machine checks instead of adding to it. A bullet
 * list is accepted too, but the scaffold's own placeholder is not — a requirement
 * that reached `proposed` carrying `- _…_` is how a spec gap gets past everybody.
 */
export function findCriteria(body: string): string[] {
  const section = /##\s*(?:draft\s+)?acceptance criteria\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i.exec(body);
  if (!section) return [];
  return section[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l) || /^given\b/i.test(l))
    .map((l) => l.replace(/^([-*]|\d+\.)\s+/, "").trim())
    .filter((l) => l !== "" && !/^_.*_$/.test(l) && l !== "…" && !/^todo$/i.test(l));
}

export interface ProposeResult {
  id: string;
  criteria: string[];
  file: string;
  /** True when proposing pulled the file back out of the archive. */
  restored: boolean;
}

/** Move draft -> proposed. The agent's step: it must have written criteria first. */
export async function runReqPropose(
  id: string,
  options: { cwd?: string } = {}
): Promise<ProposeResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);
  if (req.status === "approved") throw new Error(`${id} is already approved.`);
  if (req.status === "cancelled") {
    throw new Error(
      `${id} was cancelled, so re-proposing it would quietly undo that decision.\n` +
        `  Reopen it deliberately first:  awo req resume ${id}\n` +
        `  ${req.data.decisionNote ? `(cancelled: ${String(req.data.decisionNote)})` : ""}`.trimEnd()
    );
  }

  const criteria = findCriteria(req.body);
  if (criteria.length === 0) {
    throw new Error(
      `${id} has no acceptance criteria, so there is nothing for a human to approve.\n` +
        `  Write them under "## Draft acceptance criteria" in ${req.file}, one per line,\n` +
        `  preferably as Given / When / Then — that shape is also the shape of a test,\n` +
        `  which is how criteria become machine-checked instead of adding review work.\n` +
        `  The scaffold's placeholder does not count.`
    );
  }

  // A rejected or suspended requirement being proposed again is the revise-and-
  // re-propose path, so this is also what brings it back into intake.
  const placed = await setStatus(root, req, "proposed", { proposedAt: new Date().toISOString() });
  return { id, criteria, file: placed.file, restored: req.archived };
}

export interface ApproveResult {
  id: string;
  title: string;
  status: ReqStatus;
  criteria: string[];
  runId: string;
  /** Where the file is now — a rejection moves it into the archive. */
  file: string;
  moved: boolean;
}

/**
 * The human decision, recorded as a run so the audit trail shows who let the work
 * start and on what terms.
 */
export async function runReqDecide(
  id: string,
  options: { cwd?: string; approve?: boolean; reject?: boolean; why?: string; who?: string } = {}
): Promise<ApproveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);

  if (options.approve === options.reject) {
    throw new Error("pass exactly one of --approve or --reject.");
  }
  if (options.reject && !options.why) {
    throw new Error("--reject needs --why: a rejection with no reason cannot be acted on.");
  }
  if (req.status === "draft") {
    throw new Error(
      `${id} is still a draft — nothing has proposed acceptance criteria for you to judge.\n` +
        `  Have the PM role refine it first:  awo req refine ${id}`
    );
  }

  const criteria = findCriteria(req.body);
  const status: ReqStatus = options.approve ? "approved" : "rejected";
  const placed = await setStatus(root, req, status, {
    decidedAt: new Date().toISOString(),
    decidedBy: options.who ?? "human",
    ...(options.why ? { decisionNote: options.why } : {}),
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    { kind: "intake-decision", requirement: id, decision: status, by: options.who ?? "human" },
    {
      interpreted: `Human ${status} ${id}: ${req.title}`,
      summary: [
        options.why ? `**Reason:** ${options.why}` : "",
        "",
        `**Acceptance criteria at the time of the decision (${criteria.length}):**`,
        ...criteria.map((c) => `- ${c}`),
      ]
        .filter(Boolean)
        .join("\n"),
    }
  );

  return { id, title: req.title, status, criteria, runId, file: placed.file, moved: placed.moved };
}

/**
 * The goal a requirement was planned into, if any.
 *
 * `goal new --from` moves `requirements/<id>.md` to `goals/<goalId>/requirement.md`,
 * so a planned requirement cannot be found by id in `requirements/` at all — both
 * the goal's `requirementId` and the moved document's own `id` are checked.
 */
export async function plannedGoalFor(root: string, id: string): Promise<string | null> {
  const { findGoals } = await import("../tasks.js");
  for (const goal of await findGoals(root).catch(() => [])) {
    const goalFm = matter(
      await fs.readFile(path.join(goal.dir, "goal.md"), "utf8").catch(() => "")
    ).data as Record<string, unknown>;
    if (goalFm.requirementId === id) return goal.id;

    const moved = path.join(goal.dir, "requirement.md");
    if (await fs.pathExists(moved)) {
      const fm = matter(await fs.readFile(moved, "utf8")).data as Record<string, unknown>;
      if (fm.id === id) return goal.id;
    }
  }
  return null;
}

export interface ShelveResult {
  id: string;
  title: string;
  status: ReqStatus;
  file: string;
  movedAssets: string | null;
  runId: string;
}

/**
 * Park a requirement, or drop it — and take the file out of intake either way.
 *
 * `suspended` is "not now": the work is still wanted, the timing is not. `cancelled`
 * is "not at all". Both keep the document, because the reasoning is the part worth
 * having later; what they stop is a requirement nobody intends to act on competing
 * for attention with the ones that are live.
 *
 * A reason is required. "Why is SHOP-R8 not being built?" is the question this
 * record exists to answer, and a status alone cannot.
 */
export async function runReqShelve(
  id: string,
  status: Extract<ReqStatus, "suspended" | "cancelled">,
  options: { cwd?: string; why?: string; who?: string } = {}
): Promise<ShelveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());

  // A requirement already distilled into a goal is no longer intake's to retire: the
  // tasks, runs and evidence hang off the goal, and moving the document would not
  // stop any of it. Checked first because `goal new` moved the document INTO the
  // goal folder, so it is not in requirements/ to be read.
  const planned = await plannedGoalFor(root, id);
  if (planned) {
    throw new Error(
      `${id} has already been planned as ${planned}, so shelving the requirement would\n` +
        `  change nothing about the work. Stop the goal's tasks instead:\n` +
        `    awo task list --goal ${planned}\n` +
        `    awo task status <taskId> cancelled --reason "…"`
    );
  }

  const req = await readRequirement(root, id);

  if (!options.why) {
    throw new Error(
      `--why is required to ${status === "suspended" ? "suspend" : "cancel"} ${id}.\n` +
        `  A requirement set aside with no reason is one nobody can pick up again,\n` +
        `  or argue with.`
    );
  }
  if (req.status === status) {
    throw new Error(`${id} is already ${status} (${req.file}).`);
  }
  const previousStatus = req.status;
  const placed = await setStatus(root, req, status, {
    [status === "suspended" ? "suspendedAt" : "cancelledAt"]: new Date().toISOString(),
    [status === "suspended" ? "suspendedBy" : "cancelledBy"]: options.who ?? "human",
    decisionNote: options.why,
    // Remembered so `resume` puts it back where it was rather than guessing.
    resumesTo: previousStatus,
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    { kind: "intake-decision", requirement: id, decision: status, by: options.who ?? "human" },
    {
      interpreted: `${status === "suspended" ? "Suspended" : "Cancelled"} ${id}: ${req.title}`,
      summary: [
        `**Reason:** ${options.why}`,
        `**Was:** ${previousStatus}`,
        `**File:** ${placed.file}`,
        "",
        status === "suspended"
          ? `Resume with \`awo req resume ${id}\`, which returns it to \`${previousStatus}\` in intake.`
          : `Reopening a cancelled requirement is deliberate: \`awo req resume ${id}\`.`,
      ].join("\n"),
    }
  );

  return {
    id,
    title: req.title,
    status,
    file: placed.file,
    movedAssets: placed.movedAssets,
    runId,
  };
}

/** Bring a shelved requirement back into intake, at the status it left from. */
export async function runReqResume(
  id: string,
  options: { cwd?: string; who?: string } = {}
): Promise<ShelveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);

  if (!isArchivedStatus(req.status)) {
    throw new Error(`${id} is ${req.status} and already in intake (${req.file}) — nothing to resume.`);
  }

  // Back to where it was, defaulting to draft: a requirement that returns as
  // `approved` would be plannable without anyone having looked at it again.
  const candidate = String(req.data.resumesTo ?? "draft");
  const back: ReqStatus = (REQ_STATUSES as readonly string[]).includes(candidate)
    && !isArchivedStatus(candidate as ReqStatus)
    && candidate !== "approved"
    ? (candidate as ReqStatus)
    : "draft";

  const was = req.status;
  const placed = await setStatus(root, req, back, {
    resumedAt: new Date().toISOString(),
    resumedBy: options.who ?? "human",
    resumesTo: undefined,
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    { kind: "intake-decision", requirement: id, decision: `resumed (${back})`, by: options.who ?? "human" },
    {
      interpreted: `Resumed ${id} from ${was}: ${req.title}`,
      summary: [
        `**Was:** ${was}${req.data.decisionNote ? ` — ${String(req.data.decisionNote)}` : ""}`,
        `**Now:** ${back}, back in intake at ${placed.file}`,
      ].join("\n"),
    }
  );

  return { id, title: req.title, status: back, file: placed.file, movedAssets: placed.movedAssets, runId };
}

export interface RefineResult {
  id: string;
  briefRunId: string;
  model: string;
  invocation: string;
  planMode: boolean;
  /** False when the runtime cannot lift its sandbox on approval (codex, gemini). */
  approvesInSession: boolean;
  /** The follow-up command for a runtime that needs planning and writing split. */
  executeInvocation: string | null;
}

/** Hand the requirement to the PM role to turn a wish into checkable criteria. */
export async function runReqRefine(
  id: string,
  options: { cwd?: string; plan?: boolean } = {}
): Promise<RefineResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);

  // Specification work is judgment, not typing, so it does not go to the cheap tier.
  const model = await resolveModel(root, "product-manager", "high");

  const brief = [
    `You are the product-manager refining ${req.id} into something a human can approve`,
    `and an agent can be held to. Source: ${req.source}.`,
    "",
    `## The ask`,
    req.body.trim() || `_${req.title}_`,
    "",
    `## What to produce`,
    `Edit ${req.file} in place. Keep the frontmatter. Fill in:`,
    `- **Raw requirement** — verbatim what was asked, so drift is visible later.`,
    `- **Clarifications** — every question you had. If a question genuinely blocks`,
    `  the spec, write it and stop; do not invent an answer.`,
    `- **Draft acceptance criteria** — one per bullet, Given / When / Then where it`,
    `  fits. Each must be checkable by a command or an observation, not an opinion.`,
    `  Say explicitly which ones an automated test can cover and which need a human.`,
    `- **Non-goals** — what this does NOT include. This is where scope creep dies.`,
    "",
    `Then run:  awo req propose ${req.id}`,
    `That refuses to proceed if the criteria are missing or still placeholders.`,
    "",
    `Do NOT plan tasks, touch repos, or write code. Specification only.`,
    ...(options.plan
      ? [
          "",
          `You are in PLAN MODE: read the ask and whatever context you need, then`,
          `present the criteria you intend to write and wait. Edit nothing until it is`,
          `approved. Approval here is a permission in this session — it is NOT the`,
          `human decision that \`awo req approve\` records, which still has to happen.`,
        ]
      : []),
  ].join("\n");

  const briefRunId = await allocateRunId(root, req.id);
  await writeDetail(
    root,
    briefRunId,
    { kind: "intake-brief", requirement: req.id, model: `${model.runtime}:${model.model}` },
    { interpreted: `PM refinement brief for ${req.id}`, summary: brief }
  );

  return {
    id: req.id,
    briefRunId,
    model: `${model.runtime}:${model.model}${model.effort ? ` effort=${model.effort}` : ""}`,
    planMode: Boolean(options.plan),
    approvesInSession: planModeApprovesInSession(model.runtime),
    invocation: invocationHint(model, req.id, {
      cwd: ".",
      planMode: options.plan,
      prompt: `$(awo log show ${briefRunId})`,
    }),
    // Codex cannot lift `-s read-only` on approval, so executing is a second run.
    executeInvocation:
      options.plan && !planModeApprovesInSession(model.runtime)
        ? invocationHint(model, req.id, { cwd: ".", prompt: `$(awo log show ${briefRunId})` })
        : null,
  };
}
