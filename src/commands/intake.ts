import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { invocationHint, resolveModel } from "../models.js";
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
export const REQ_STATUSES = ["draft", "proposed", "approved", "rejected"] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

export interface Requirement {
  id: string;
  file: string;
  title: string;
  status: ReqStatus;
  source: string;
  goalId: string | null;
  body: string;
  data: Record<string, unknown>;
}

function requirementsDir(root: string): string {
  return path.join(root, "requirements");
}

export async function readRequirement(root: string, id: string): Promise<Requirement> {
  const file = path.join(requirementsDir(root), `${id}.md`);
  if (!(await fs.pathExists(file))) {
    const known = await listRequirements(root);
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
  };
}

export async function listRequirements(root: string): Promise<Requirement[]> {
  const dir = requirementsDir(root);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"));
  const out: Requirement[] = [];
  for (const f of files.sort()) out.push(await readRequirement(root, f.replace(/\.md$/, "")));
  return out;
}

async function setStatus(
  root: string,
  req: Requirement,
  status: ReqStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const file = path.join(root, req.file);
  const next = { ...req.data, status, ...extra };
  await fs.writeFile(file, matter.stringify(req.body, next));
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
}

/** Move draft -> proposed. The agent's step: it must have written criteria first. */
export async function runReqPropose(
  id: string,
  options: { cwd?: string } = {}
): Promise<ProposeResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);
  if (req.status === "approved") throw new Error(`${id} is already approved.`);

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

  await setStatus(root, req, "proposed", { proposedAt: new Date().toISOString() });
  return { id, criteria };
}

export interface ApproveResult {
  id: string;
  title: string;
  status: ReqStatus;
  criteria: string[];
  runId: string;
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
  await setStatus(root, req, status, {
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

  return { id, title: req.title, status, criteria, runId };
}

export interface RefineResult {
  id: string;
  briefRunId: string;
  model: string;
  invocation: string;
}

/** Hand the requirement to the PM role to turn a wish into checkable criteria. */
export async function runReqRefine(
  id: string,
  options: { cwd?: string } = {}
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
    invocation: invocationHint(model, req.id, {
      cwd: ".",
      prompt: `$(awo log show ${briefRunId})`,
    }),
  };
}
