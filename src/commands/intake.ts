import { createHash } from "node:crypto";
import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { invocationHint, planModeApprovesInSession, resolveModel } from "../models.js";
import { allocateRunId, writeDetail } from "../runs.js";
import {
  describeActor,
  resolveDecider,
  resolveHumanGate,
  type DecisionActor,
  type DecisionOptions,
} from "../human-gate.js";

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
  return findCriteriaDetailed(body).map((criterion) => criterion.text);
}

export interface ParsedCriterion {
  /** 1-based position — what `state.criteria` has always been keyed by. */
  index: number;
  /** An explicit `AC-17` label, normalised; the stable identity when present. */
  label: string | null;
  text: string;
  /** Short hash of the whitespace-normalised text, to detect later edits. */
  hash: string;
}

/** `ac17`, `AC-17`, `ac-17` → `AC-17`, so a label is looked up however it is typed. */
export function normalizeCriterionLabel(raw: string): string | null {
  const match = /^ac-?(\d+[a-z]?)$/i.exec(raw.trim());
  return match ? `AC-${match[1].toUpperCase()}` : null;
}

export function criterionHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** The digest an approval is pinned to: every criterion's text, in order. */
export function criteriaDigest(criteria: Array<{ text: string; hash?: string }>): string {
  // Per-criterion hashes when present: they cover nested conditions the text omits.
  return createHash("sha256")
    .update(criteria.map((criterion) => criterion.hash ?? criterion.text.replace(/\s+/g, " ").trim()).join("\n"))
    .digest("hex");
}

/**
 * A leading label in the three shapes the real requirements use — `AC-17: …`,
 * `**AC-17** — …`, `AC-17 — …` — plus the bare `AC-17 A Row …` form SHOP-G109 is
 * written in. `AC-1/AC-2` is a reference, not a label, so a separator is required;
 * and so is the hyphen — SHOP-G24's "**AC1 and AC2 conflict**" is prose about two
 * criteria, while SHOP-G52's "**AC-4 — MET 2026-09-18.**" is AC-4.
 */
const LABEL = /^(?:\*\*|__)?\[?(ac-\d+[a-z]?)\]?:?(?:\*\*|__)?(?=[\s:—–.)]|$)/i;

/** A heading that says its criteria are history, not terms. */
const RETIRED_HEADING = /\b(superseded|obsolete|withdrawn|retired|deprecated)\b/i;

/** `~~…~~ — RETIRED`, optionally after a bold or `XX-001 —` lead-in. */
const STRUCK_ITEM = /^(?:\*\*|__)?(?:[a-z]{1,6}-?\d+[a-z]?(?:\*\*|__)?\s*(?:[:—–-]\s*)?)?(?:\*\*|__)?~~/i;

/**
 * Criteria are read the way a person reads the document, not by the first regex
 * match. Measured on the real workspaces, the old single-section parser:
 *  - returned 0 for `## Acceptance criteria (final design F2, …)` — trailing text
 *    after the heading made the whole section invisible;
 *  - stopped at the first section, so SHOP-G109's amendments (AC-17..AC-41) never
 *    reached trace, readiness or the approval record;
 *  - counted indented sub-bullets as criteria, shifting every later index;
 *  - kept `~~struck~~` criteria that the requirement itself marks RETIRED.
 *
 * So: every section whose heading contains "acceptance criteria" is read in order
 * (amendments included, retired headings skipped); only top-level items count
 * (column 0–3); an item that opens with a strike is retired; and an explicitly
 * labelled `AC-n` item after the first criteria section counts wherever it sits —
 * a label is a declaration, and an amendment headed "Added 2026-11-11: …" is still
 * an amendment. A label already seen is not counted twice.
 */
export function findCriteriaDetailed(body: string): Array<ParsedCriterion> {
  // A PM ticket pasted under "Raw requirement" often carries its own criteria
  // section; the refined section replaces it (SHOP-G1 read 37 + 10 with both).
  // The verbatim copy is only the answer when nothing else declares criteria.
  const refined = parseCriteria(body, false);
  return refined.length > 0 ? refined : parseCriteria(body, true);
}

/** The verbatim ask is input to the criteria, not a second set of them. */
const RAW_HEADING = /\b(raw requirement|verbatim)\b/i;

function parseCriteria(body: string, includeRaw: boolean): Array<ParsedCriterion> {
  // `sub` holds the item's nested conditions: not criteria of their own, but part
  // of what the criterion says — so part of its hash, or editing a nested
  // permission rule would leave old evidence looking current.
  type Item = { label: string | null; lines: string[]; sub: string[]; subStarted: boolean; bare: boolean };
  const items: Item[] = [];
  const seenLabels = new Set<string>();
  const state = {
    inAc: false,
    acLevel: 0,
    skipLevel: 0, // > 0 while inside a retired criteria heading
    rawLevel: 0, // > 0 while inside the verbatim "Raw requirement"
    seenAc: false,
    fence: null as string | null,
    current: null as Item | null,
    blankSinceItem: false,
    // Content column of the last top-level item, kept even when that item was not
    // counted (struck, unlabelled): its own sub-bullets must not become criteria.
    parentOffset: null as number | null,
  };

  const close = (): void => {
    state.current = null;
    state.blankSinceItem = false;
  };
  const open = (text: string, labelledOnly: boolean, bare: boolean): void => {
    close();
    const match = LABEL.exec(text);
    const label = match ? normalizeCriterionLabel(match[1]) : null;
    if (labelledOnly && !label) return;
    if (label && seenLabels.has(label)) return;
    if (label) seenLabels.add(label);
    state.current = { label, lines: [text], sub: [], subStarted: false, bare };
    items.push(state.current);
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    const fenceMatch = /^\s{0,3}(```|~~~)/.exec(line);
    if (state.fence) {
      if (fenceMatch && fenceMatch[1] === state.fence) state.fence = null;
      continue;
    }
    if (fenceMatch) {
      state.fence = fenceMatch[1];
      close();
      state.parentOffset = null;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      close();
      state.parentOffset = null;
      const level = heading[1].length;
      const text = heading[2];
      if (state.skipLevel > 0 && level <= state.skipLevel) state.skipLevel = 0;
      if (state.rawLevel > 0 && level <= state.rawLevel) state.rawLevel = 0;
      if (state.inAc && level <= state.acLevel) state.inAc = false;
      if (!includeRaw && state.rawLevel === 0 && RAW_HEADING.test(text)) state.rawLevel = level;
      if (state.rawLevel > 0) continue;
      if (/acceptance criteria/i.test(text)) {
        if (RETIRED_HEADING.test(text)) {
          if (state.skipLevel === 0) state.skipLevel = level;
        } else if (!state.inAc) {
          state.inAc = true;
          state.acLevel = level;
          state.seenAc = true;
        }
      }
      continue;
    }
    if (state.skipLevel > 0 || state.rawLevel > 0) continue;
    // Outside a criteria section only labelled items count, and only once the
    // document has started declaring criteria at all.
    const labelledOnly = !state.inAc;
    if (!state.inAc && !state.seenAc) continue;

    if (line.trim() === "") {
      if (state.current) state.blankSinceItem = true;
      continue;
    }

    const indent = line.startsWith("\t") ? 4 : /^ */.exec(line)![0].length;
    const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
    const current = state.current;
    if (bullet) {
      // Markdown nests an item indented to its parent's content column ("  - x"
      // under "- y"), so column 0–3 alone would count sub-bullets as criteria.
      const nested = state.parentOffset !== null && indent >= state.parentOffset;
      if (indent <= 3 && !nested) {
        state.parentOffset = indent + bullet[2].length + Math.min(bullet[3].length, 4);
        const text = bullet[4].trim();
        // An item that opens with a strike is retired in place (`~~…~~ — VOID`).
        if (STRUCK_ITEM.test(text)) close();
        else open(text, labelledOnly, false);
      } else if (current) {
        current.subStarted = true;
        current.sub.push(line.trim());
      }
      continue;
    }

    // A bare "Given …" paragraph at the margin is a criterion in a GWT-prose
    // section; consecutive Given paragraphs are separate criteria.
    if (!labelledOnly && indent === 0 && /^given\b/i.test(line)
      && (!current || current.bare || state.blankSinceItem)) {
      open(line.trim(), false, true);
      state.parentOffset = null;
      continue;
    }

    // Continuation of the open item: a lazy line straight after it, or an indented
    // paragraph — but not the text under one of its sub-bullets.
    if (current && !current.subStarted && (!state.blankSinceItem || indent >= 2)) {
      current.lines.push(line.trim());
      continue;
    }
    if (current && current.subStarted && indent >= 2) {
      current.sub.push(line.trim());
      continue;
    }
    if (indent === 0) {
      close();
      state.parentOffset = null;
    }
  }

  return items
    .map((item) => ({
      label: item.label,
      text: item.lines.join(" ").replace(/\s+/g, " ").trim(),
      nested: item.sub.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean),
    }))
    .filter(({ text }) => text !== "" && !/^_.*_$/.test(text) && text !== "…" && !/^todo$/i.test(text))
    .map((item, i) => ({
      index: i + 1,
      label: item.label,
      text: item.text,
      hash: criterionHash(item.nested.length > 0 ? `${item.text}\n${item.nested.join("\n")}` : item.text),
    }));
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
  /** Who is answerable, how it reached awo, and the delegation if there was one. */
  actor: DecisionActor;
  /** sha256 of the criteria the approval accepted; null for a rejection. */
  criteriaDigest: string | null;
}

/** Why a requirement in this status cannot be approved, and the command that fixes it. */
function approvalRefusal(req: Requirement): string | null {
  switch (req.status) {
    case "proposed":
      return null;
    case "approved":
      return `${req.id} is already approved${req.data.decidedBy ? ` (by ${String(req.data.decidedBy)})` : ""}.`;
    case "draft":
      return (
        `${req.id} is still a draft — nothing has proposed acceptance criteria for you to judge.\n` +
        `  Propose it first:  awo req propose ${req.id}\n` +
        `  (or have the PM role write the criteria:  awo req refine ${req.id})`
      );
    case "rejected":
      return (
        `${req.id} was rejected${req.data.decisionNote ? ` (${String(req.data.decisionNote)})` : ""}.\n` +
        `  Revise it in ${req.file}, then propose it again:  awo req propose ${req.id}\n` +
        `  An approval is of the revised criteria, so it starts from a fresh proposal.`
      );
    case "suspended":
    case "cancelled":
      return (
        `${req.id} is ${req.status}, so approving it would skip the decision to bring it back.\n` +
        `  Reopen it first:  awo req resume ${req.id}`
      );
  }
}

/**
 * The human decision, recorded as a run so the audit trail shows who let the work
 * start and on what terms.
 *
 * Approval is only ever of a `proposed` requirement with at least one criterion,
 * and it pins the digest of the criteria it accepted: measured on atlas-sales-crm,
 * 35 approvals landed less than 60 s after the requirement was written — some
 * straight from draft — so "approved" did not reliably mean "someone read terms".
 */
export async function runReqDecide(
  id: string,
  options: {
    cwd?: string;
    approve?: boolean;
    reject?: boolean;
    why?: string;
  } & DecisionOptions = {}
): Promise<ApproveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirement(root, id);

  if (options.approve === options.reject) {
    throw new Error("pass exactly one of --approve or --reject.");
  }
  if (options.reject && !options.why) {
    throw new Error("--reject needs --why: a rejection with no reason cannot be acted on.");
  }
  if (options.reject && req.status === "draft") {
    throw new Error(
      `${id} is still a draft — nothing has proposed acceptance criteria for you to judge.\n` +
        `  Have the PM role refine it first:  awo req refine ${id}`
    );
  }

  const parsed = findCriteriaDetailed(req.body);
  const criteria = parsed.map((criterion) => criterion.text);
  let actor: DecisionActor;
  if (options.approve) {
    const refusal = approvalRefusal(req);
    if (refusal) throw new Error(refusal);
    if (parsed.length === 0) {
      throw new Error(
        `${id} has no acceptance criteria, so there is nothing to approve.\n` +
          `  Write them under "## Draft acceptance criteria" in ${req.file}, then\n` +
          `  propose it again:  awo req propose ${id}`
      );
    }
    actor = resolveHumanGate({
      command: `awo req approve ${id}`,
      manifest: await readManifest(root),
      root,
      options,
    });
  } else {
    actor = resolveDecider(root, options);
  }

  const status: ReqStatus = options.approve ? "approved" : "rejected";
  const digest = options.approve ? criteriaDigest(parsed) : null;
  const placed = await setStatus(root, req, status, {
    decidedAt: new Date().toISOString(),
    decidedBy: actor.by,
    via: actor.via,
    // `undefined` drops a stale value left by an earlier decision.
    delegation: actor.delegation ?? undefined,
    criteriaDigest: digest ?? undefined,
    decisionNote: options.why ?? undefined,
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    {
      kind: "intake-decision",
      requirement: id,
      decision: status,
      by: actor.by,
      via: actor.via,
      delegatedBy: actor.delegation?.by,
      criteriaDigest: digest ?? undefined,
    },
    {
      prompt: actor.delegation?.instruction ?? undefined,
      interpreted: `${describeActor(actor)} ${status} ${id}: ${req.title}`,
      summary: [
        options.why ? `**Reason:** ${options.why}` : "",
        actor.delegation
          ? `**Delegated by:** ${actor.delegation.by}, recorded by ${actor.delegation.via}` +
            // The quote lives only in the prompt section, which publish redaction
            // withholds; repeating it here would publish a person's words verbatim.
            (actor.delegation.instruction ? " — their instruction is recorded as the prompt" : " — no instruction quoted")
          : "",
        `**Acceptance criteria at the time of the decision (${criteria.length}):**`,
        ...criteria.map((c) => `- ${c}`),
        digest ? `**Criteria digest:** ${digest}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }
  );

  return {
    id,
    title: req.title,
    status,
    criteria,
    runId,
    file: placed.file,
    moved: placed.moved,
    actor,
    criteriaDigest: digest,
  };
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

/** The status-change timestamps a requirement's frontmatter can carry. */
const STATUS_TIMESTAMPS = ["createdAt", "proposedAt", "decidedAt", "suspendedAt", "cancelledAt", "resumedAt"];

/**
 * When the requirement entered its current status: the latest transition stamp,
 * else the file's mtime for a hand-authored one that carries none.
 */
export async function requirementSince(root: string, req: Requirement): Promise<Date | null> {
  let latest: Date | null = null;
  for (const key of STATUS_TIMESTAMPS) {
    const value = req.data[key];
    if (value === undefined || value === null || value === "") continue;
    const at = new Date(value as string | Date);
    if (!Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  if (latest) return latest;
  const stat = await fs.stat(path.join(root, req.file)).catch(() => null);
  return stat ? stat.mtime : null;
}

export function ageInDays(since: Date | null, now: Date = new Date()): number | null {
  return since ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000)) : null;
}

export interface RequirementDetail {
  id: string;
  title: string;
  status: ReqStatus;
  source: string;
  file: string;
  archived: boolean;
  /** The goal it was planned into; its document then lives in that goal's folder. */
  goalId: string | null;
  frontmatter: Record<string, unknown>;
  criteria: ParsedCriterion[];
  criteriaDigest: string;
  decision: {
    decidedAt: string | null;
    decidedBy: string | null;
    via: string | null;
    delegation: unknown;
    note: string | null;
    approvedDigest: string | null;
    /** True when the criteria were edited after the approval; null when nothing was pinned. */
    criteriaChangedSinceApproval: boolean | null;
  } | null;
  since: string | null;
  ageDays: number | null;
}

/** A requirement by id, including one `goal new` already moved into its goal. */
async function readRequirementAnywhere(root: string, id: string): Promise<Requirement> {
  try {
    return await readRequirement(root, id);
  } catch (err) {
    const { findGoals } = await import("../tasks.js");
    for (const goal of await findGoals(root).catch(() => [])) {
      const moved = path.join(goal.dir, "requirement.md");
      if (!(await fs.pathExists(moved))) continue;
      const parsed = matter(await fs.readFile(moved, "utf8"));
      const data = parsed.data as Record<string, unknown>;
      if (data.id !== id) continue;
      return {
        id,
        file: path.relative(root, moved),
        title: String(data.title ?? id),
        status: (REQ_STATUSES as readonly string[]).includes(String(data.status))
          ? (data.status as ReqStatus)
          : "draft",
        source: String(data.source ?? "unspecified"),
        goalId: (data.goalId as string | null) ?? goal.id,
        body: parsed.content,
        data,
        archived: false,
      };
    }
    throw err;
  }
}

/** Everything about one requirement an agent otherwise opens the file to find. */
export async function runReqShow(id: string, options: { cwd?: string } = {}): Promise<RequirementDetail> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const req = await readRequirementAnywhere(root, id);
  const criteria = findCriteriaDetailed(req.body);
  const digest = criteriaDigest(criteria);
  const since = await requirementSince(root, req);
  const text = (key: string) => {
    const value = req.data[key];
    if (value === undefined || value === null || value === "") return null;
    return value instanceof Date ? value.toISOString() : String(value);
  };
  const approvedDigest = text("criteriaDigest");
  const decided = text("decidedAt") !== null || text("decidedBy") !== null;
  return {
    id: req.id,
    title: req.title,
    status: req.status,
    source: req.source,
    file: req.file,
    archived: req.archived,
    goalId: req.goalId,
    frontmatter: req.data,
    criteria,
    criteriaDigest: digest,
    decision: decided
      ? {
          decidedAt: text("decidedAt"),
          decidedBy: text("decidedBy"),
          via: text("via"),
          delegation: req.data.delegation ?? null,
          note: text("decisionNote"),
          approvedDigest,
          criteriaChangedSinceApproval:
            req.status === "approved" && approvedDigest ? approvedDigest !== digest : null,
        }
      : null,
    since: since ? since.toISOString() : null,
    ageDays: ageInDays(since),
  };
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
  options: { cwd?: string; why?: string } & DecisionOptions = {}
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
  const actor = resolveDecider(root, options);
  const placed = await setStatus(root, req, status, {
    [status === "suspended" ? "suspendedAt" : "cancelledAt"]: new Date().toISOString(),
    [status === "suspended" ? "suspendedBy" : "cancelledBy"]: actor.by,
    decisionNote: options.why,
    // Remembered so `resume` puts it back where it was rather than guessing.
    resumesTo: previousStatus,
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    { kind: "intake-decision", requirement: id, decision: status, by: actor.by, via: actor.via },
    {
      interpreted: `${describeActor(actor)} ${status} ${id}: ${req.title}`,
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
  options: { cwd?: string; why?: string } & DecisionOptions = {}
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
  const actor = resolveDecider(root, options);
  const placed = await setStatus(root, req, back, {
    resumedAt: new Date().toISOString(),
    resumedBy: actor.by,
    resumesTo: undefined,
    resumeNote: options.why ?? undefined,
  });

  const runId = await allocateRunId(root, id);
  await writeDetail(
    root,
    runId,
    { kind: "intake-decision", requirement: id, decision: `resumed (${back})`, by: actor.by, via: actor.via },
    {
      interpreted: `${describeActor(actor)} resumed ${id} from ${was}: ${req.title}`,
      summary: [
        ...(options.why ? [`**Reason:** ${options.why}`] : []),
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
