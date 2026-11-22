import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findCriteriaDetailed, normalizeCriterionLabel, type ParsedCriterion } from "./intake.js";
import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, locateTask, type GoalDefinition } from "../tasks.js";
import {
  mutateState,
  readState,
  type GoalState,
  type CriterionEvidence,
  type CriterionEvidenceKind,
} from "../state.js";
import { readEvents, readIndex, runSlot } from "../runs.js";
import { actorLabel } from "../agent-env.js";
import { retireQa } from "../qa-history.js";
import { assertGoalWritable } from "../lifecycle.js";
import { resolveHumanGate } from "../human-gate.js";
import { readManifest } from "../manifest.js";

export interface CriterionTrace {
  index: number;
  criterion: string;
  /** The explicit `AC-n` label, when the requirement declares one. */
  label: string | null;
  /** Hash of the criterion's current text. */
  hash: string;
  evidence: CriterionEvidence[];
  /** Evidence attached to an earlier wording of this criterion — re-attach it. */
  staleEvidence: CriterionEvidence[];
  status: "covered" | "exception" | "unapproved-exception" | "missing" | "stale";
}

async function criteriaForGoal(root: string, goalId: string, knownGoal?: GoalDefinition) {
  const goal = knownGoal ?? (await findGoals(root)).find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);
  const requirement = path.join(goal.dir, "requirement.md");
  if (!(await fs.pathExists(requirement))) {
    throw new Error(`${goalId} has no requirement.md, so acceptance criteria cannot be traced.`);
  }
  const parsed = matter(await fs.readFile(requirement, "utf8"));
  const criteria = findCriteriaDetailed(parsed.content);
  if (criteria.length === 0) {
    throw new Error(`${goalId}'s requirement has no acceptance criteria to trace.`);
  }
  return { goal, criteria };
}

/**
 * The evidence that belongs to one criterion.
 *
 * `state.criteria` is keyed by position, which an amendment that inserts a
 * criterion silently re-points. A labelled entry therefore follows its label
 * wherever the criterion now sits; unlabelled (and legacy) entries stay positional,
 * and so does a labelled entry whose label the document no longer declares.
 */
function evidenceFor(state: GoalState, criterion: ParsedCriterion, labels: Set<string>): CriterionEvidence[] {
  const all = state.criteria ?? {};
  const own = (all[String(criterion.index)] ?? []).filter(
    (item) => !item.criterionLabel || item.criterionLabel === criterion.label || !labels.has(item.criterionLabel)
  );
  if (!criterion.label) return own;
  const moved = Object.entries(all)
    .filter(([key]) => key !== String(criterion.index))
    .flatMap(([, entries]) => entries.filter((item) => item.criterionLabel === criterion.label));
  return [...own, ...moved];
}

/** Only entries that recorded a hash can be judged stale; legacy ones keep counting. */
function isStale(item: CriterionEvidence, criterion: ParsedCriterion): boolean {
  return Boolean(item.criterionHash) && item.criterionHash !== criterion.hash;
}

const passes = (item: CriterionEvidence) => item.kind === "test" || item.kind === "manual";
const acceptedException = (item: CriterionEvidence) => item.kind === "exception" && Boolean(item.acceptedBy?.trim());

export function traceCriterion(state: GoalState, criterion: ParsedCriterion, labels: Set<string>): CriterionTrace {
  const evidence = evidenceFor(state, criterion, labels);
  const fresh = evidence.filter((item) => !isStale(item, criterion));
  const staleEvidence = evidence.filter((item) => isStale(item, criterion));
  const status: CriterionTrace["status"] = fresh.some(passes)
    ? "covered"
    : fresh.some(acceptedException)
      ? "exception"
      : staleEvidence.some((item) => passes(item) || acceptedException(item))
        ? "stale"
        : fresh.some((item) => item.kind === "exception")
          ? "unapproved-exception"
          : "missing";
  return {
    index: criterion.index,
    criterion: criterion.text,
    label: criterion.label,
    hash: criterion.hash,
    evidence,
    staleEvidence,
    status,
  };
}

interface MeasuredTest {
  runId: string;
  at: string;
  command: string;
  repo: string | null;
  exitCode: number | null;
  passed: boolean;
}

/**
 * Every test awo itself ran for this task, oldest first.
 *
 * Only `verified` events count — the ones `task event --run` measured. Completed
 * runs come from the day index; the open (or last) run may not be indexed yet, so
 * it is read directly, as is a run the caller named.
 */
async function measuredTests(
  root: string,
  taskId: string,
  lastRunId: string | null,
  namedRun: string | null
): Promise<MeasuredTest[]> {
  const runIds = new Set<string>();
  for (const row of await readIndex(root)) if (row.taskId === taskId) runIds.add(row.runId);
  if (lastRunId) runIds.add(lastRunId);
  if (namedRun && runSlot(namedRun).slot === taskId) runIds.add(namedRun);

  const tests: MeasuredTest[] = [];
  for (const runId of runIds) {
    for (const event of await readEvents(root, runId)) {
      if (event.kind !== "test" || event.verified !== true) continue;
      const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
      // The receipt rules `task complete` applies: a tree that changed while the
      // command ran, an inconclusive result awaiting a human, or a command that
      // never reached a test does not verify a criterion either.
      const treeMoved = typeof event.treeId === "string" && typeof event.treeIdAfter === "string" &&
        event.treeId !== event.treeIdAfter;
      const inconclusive = event.needsHuman === true || event.diagnosis === "not-runnable" || event.diagnosis === "unknown";
      tests.push({
        runId,
        at: event.t,
        command: typeof event.command === "string" ? event.command : "",
        repo: typeof event.repo === "string" ? event.repo : null,
        exitCode,
        passed: exitCode === 0 && event.timedOut !== true && !treeMoved && !inconclusive,
      });
    }
  }
  return tests.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId));
}

function describeTest(test: MeasuredTest): string {
  return `\`${test.command}\`${test.repo ? ` in ${test.repo}` : ""} (exit ${test.exitCode ?? "?"}, run ${test.runId})`;
}

/**
 * `--kind test` evidence binds to a measurement, not to a sentence about one.
 *
 * Measured on the real workspaces: 66% (shop) and 50% (auth) of criterion "test"
 * references were prose — "verified on UAT", "unit tests pass" — that pointed at
 * nothing anyone could re-check. A reference is now resolved to a passing test
 * event awo itself ran for this task: by runId, by exact command, then by a
 * command substring; omitted, the task's latest passing measurement. A command's
 * latest measurement supersedes its earlier ones, exactly as at completion, so an
 * old pass cannot stand in for a check that has since failed.
 */
async function resolveMeasurement(
  root: string,
  taskId: string,
  lastRunId: string | null,
  ref: string | null
): Promise<MeasuredTest> {
  const tests = await measuredTests(root, taskId, lastRunId, ref);
  const guidance =
    `  Record it with \`awo task event ${taskId} test --run "<the command>"\` first,\n` +
    `  or attach what was checked by hand with --kind manual --ref "<where the proof is>".`;
  if (tests.length === 0) {
    throw new Error(`${taskId} has no measured test to bind this evidence to.\n${guidance}`);
  }
  const latestOf = (test: MeasuredTest) =>
    tests.filter((other) => other.repo === test.repo && other.command === test.command).at(-1)!;

  if (!ref) {
    const chosen = [...tests].reverse().find((test) => test.passed && latestOf(test).passed);
    if (chosen) return chosen;
    const latest = tests.at(-1)!;
    throw new Error(
      `${taskId} has no passing measured test: the latest measurement of ${describeTest(latest)} failed.\n` +
        `  Fix it and measure again with \`awo task event ${taskId} test --run "${latest.command}"\`.`
    );
  }

  const byRun = tests.filter((test) => test.runId === ref);
  const exact = tests.filter((test) => test.command.trim() === ref);
  const matches = byRun.length > 0
    ? byRun
    : exact.length > 0
      ? exact
      : tests.filter((test) => test.command.includes(ref));
  if (matches.length === 0) {
    const known = [...new Set(tests.map((test) => test.command))].map((command) => `    ${command}`).join("\n");
    throw new Error(
      `No measured test of ${taskId} matches "${ref}" (by runId or command). Measured:\n${known}\n${guidance}`
    );
  }
  const candidate = matches.at(-1)!;
  const latest = latestOf(candidate);
  if (!candidate.passed || !latest.passed) {
    const failed = candidate.passed ? latest : candidate;
    throw new Error(
      `The latest measurement of that command failed: ${describeTest(failed)}.\n` +
        `  Evidence binds to a passing measurement. Fix it and measure again with\n` +
        `  \`awo task event ${taskId} test --run "${failed.command}"\`.`
    );
  }
  return candidate;
}

/** `1`, `1,3,5`, `AC-17`, or a mix — deduplicated, in document order. */
function selectCriteria(
  spec: number | string | Array<number | string>,
  criteria: ParsedCriterion[],
  goalId: string
): ParsedCriterion[] {
  const tokens = (Array.isArray(spec) ? spec : [spec])
    .flatMap((value) => String(value).split(","))
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("--criterion needs a number (1), a list (1,3,5) or a label (AC-17).");
  }
  const labels = criteria.map((c) => c.label).filter((label): label is string => label !== null);
  const chosen = new Map<number, ParsedCriterion>();
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1) throw new Error("--criterion must be a positive 1-based acceptance-criterion number.");
      const criterion = criteria[n - 1];
      if (!criterion) {
        throw new Error(`${goalId} has ${criteria.length} acceptance criteria; ${n} is out of range.`);
      }
      chosen.set(criterion.index, criterion);
      continue;
    }
    const label = normalizeCriterionLabel(token);
    if (!label) {
      throw new Error(
        `--criterion "${token}" is neither a criterion number nor an AC-n label. ` +
          `Use a number (1), a list (1,3,5) or a label (AC-17).`
      );
    }
    const criterion = criteria.find((c) => c.label === label);
    if (!criterion) {
      throw new Error(
        labels.length > 0
          ? `${goalId} has no criterion labelled ${label}. Labels: ${labels.join(", ")}.`
          : `${goalId}'s criteria carry no AC-n labels; use the number from \`awo goal trace ${goalId}\`.`
      );
    }
    chosen.set(criterion.index, criterion);
  }
  return [...chosen.values()].sort((a, b) => a.index - b.index);
}

export interface TaskEvidenceResult {
  taskId: string;
  goalId: string;
  attached: Array<{
    index: number;
    label: string | null;
    evidence: CriterionEvidence;
    /** False when identical evidence was already recorded (QA is then untouched). */
    added: boolean;
  }>;
}

export async function runTaskEvidence(options: {
  taskId: string;
  /** `1`, `"1,3,5"`, `"AC-17"`, or an array of those. */
  criterion: number | string | Array<number | string>;
  kind: CriterionEvidenceKind;
  ref?: string;
  who?: string;
  delegatedBy?: string;
  instruction?: string;
  cwd?: string;
}): Promise<TaskEvidenceResult> {
  if (!(["test", "manual", "exception"] as string[]).includes(options.kind)) {
    throw new Error("--kind must be test, manual, or exception.");
  }
  const ref = options.ref?.trim() ?? null;
  if (options.ref !== undefined && ref === "") throw new Error("--ref cannot be empty.");
  if (options.kind !== "test" && !ref) {
    throw new Error(
      options.kind === "manual"
        ? "--kind manual needs --ref <where the proof is: a URL, a screenshot path, a checklist>."
        : "--kind exception needs --ref <the decision or ticket that accepts the gap>."
    );
  }
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  // Accepting a gap is a human decision like an approval: an exception satisfies
  // readiness, so an agent that could name any `--who` could close its own gaps.
  const exceptionActor = options.kind === "exception"
    ? resolveHumanGate({
        command: `awo task evidence ${options.taskId} --criterion ${String(options.criterion)} --kind exception --ref "…"`,
        manifest: await readManifest(root),
        root,
        options: { who: options.who, delegatedBy: options.delegatedBy, instruction: options.instruction },
        requireWho: "--kind exception requires --who <human> so the acceptance is attributable.",
      })
    : null;
  const { task, goal } = await locateTask(root, options.taskId);
  assertGoalWritable(goal, task.id);
  const { criteria } = await criteriaForGoal(root, goal.id);
  const selected = selectCriteria(options.criterion, criteria, goal.id);

  const measurement = options.kind === "test"
    ? await resolveMeasurement(
        root,
        task.id,
        (await readState(goal.dir, goal.id)).tasks[task.id]?.lastRunId ?? null,
        ref
      )
    : null;

  const recordedAt = new Date().toISOString();
  const by = actorLabel();
  const attached: TaskEvidenceResult["attached"] = [];
  await mutateState(goal.dir, goal.id, (state) => {
    state.criteria ??= {};
    for (const criterion of selected) {
      const evidence: CriterionEvidence = {
        taskId: task.id,
        kind: options.kind,
        ref: ref ?? measurement!.command,
        recordedAt,
        ...(exceptionActor ? { acceptedBy: exceptionActor.by, by: exceptionActor.via } : {}),
        criterionHash: criterion.hash,
        ...(criterion.label ? { criterionLabel: criterion.label } : {}),
        ...(measurement
          ? {
              measurement: {
                runId: measurement.runId,
                command: measurement.command,
                repo: measurement.repo,
                exitCode: measurement.exitCode,
                at: measurement.at,
              },
              verified: true,
            }
          : {}),
        by,
      };
      const entries = (state.criteria[String(criterion.index)] ??= []);
      // The same evidence for the same criterion: an entry another labelled
      // criterion left in this positional bucket (after a reorder) is not ours to
      // rewrite, or re-attaching AC-1 would quietly strip AC-2's coverage.
      const same = entries.find(
        (item) =>
          (!item.criterionLabel || !criterion.label || item.criterionLabel === criterion.label) &&
          item.taskId === evidence.taskId &&
          item.kind === evidence.kind &&
          item.ref === evidence.ref &&
          item.acceptedBy === evidence.acceptedBy &&
          item.measurement?.runId === evidence.measurement?.runId &&
          item.measurement?.at === evidence.measurement?.at
      );
      const name = criterion.label ?? `criterion ${criterion.index}`;
      if (!same) {
        retireQa(state, `new evidence for ${name} from ${task.id}`);
        entries.push(evidence);
        attached.push({ index: criterion.index, label: criterion.label, evidence, added: true });
      } else if (same.criterionHash && same.criterionHash !== criterion.hash) {
        // Re-attaching after an edit is a fresh claim about the new wording.
        Object.assign(same, { criterionHash: criterion.hash, recordedAt, by });
        if (criterion.label) same.criterionLabel = criterion.label;
        retireQa(state, `evidence re-attached to the edited ${name} by ${task.id}`);
        attached.push({ index: criterion.index, label: criterion.label, evidence: same, added: true });
      } else {
        // An identical retry, or a legacy entry gaining the hash it never had:
        // nothing about the evidence changed, so neither does QA.
        if (!same.criterionHash) same.criterionHash = criterion.hash;
        if (!same.criterionLabel && criterion.label) same.criterionLabel = criterion.label;
        attached.push({ index: criterion.index, label: criterion.label, evidence: same, added: false });
      }
    }
  });
  return { taskId: task.id, goalId: goal.id, attached };
}

export async function runGoalTrace(goalId: string, options: { cwd?: string; goal?: GoalDefinition; state?: GoalState } = {}): Promise<CriterionTrace[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { goal, criteria } = await criteriaForGoal(root, goalId, options.goal);
  const state = options.state ?? await readState(goal.dir, goal.id);
  const labels = new Set(criteria.map((c) => c.label).filter((label): label is string => label !== null));
  return criteria.map((criterion) => traceCriterion(state, criterion, labels));
}
