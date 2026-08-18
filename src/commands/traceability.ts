import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";
import { findCriteria } from "./intake.js";
import { findWorkspaceRoot } from "../workspace.js";
import { findGoals, locateTask } from "../tasks.js";
import {
  mutateState,
  readState,
  type CriterionEvidence,
  type CriterionEvidenceKind,
} from "../state.js";

export interface CriterionTrace {
  index: number;
  criterion: string;
  evidence: CriterionEvidence[];
  status: "covered" | "exception" | "unapproved-exception" | "missing";
}

async function criteriaForGoal(root: string, goalId: string) {
  const goal = (await findGoals(root)).find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Unknown goal "${goalId}".`);
  const requirement = path.join(goal.dir, "requirement.md");
  if (!(await fs.pathExists(requirement))) {
    throw new Error(`${goalId} has no requirement.md, so acceptance criteria cannot be traced.`);
  }
  const parsed = matter(await fs.readFile(requirement, "utf8"));
  const criteria = findCriteria(parsed.content);
  if (criteria.length === 0) {
    throw new Error(`${goalId}'s requirement has no acceptance criteria to trace.`);
  }
  return { goal, criteria };
}

export async function runTaskEvidence(options: {
  taskId: string;
  criterion: number;
  kind: CriterionEvidenceKind;
  ref: string;
  who?: string;
  cwd?: string;
}): Promise<CriterionEvidence> {
  if (!Number.isInteger(options.criterion) || options.criterion < 1) {
    throw new Error("--criterion must be a positive 1-based acceptance-criterion number.");
  }
  if (!(["test", "manual", "exception"] as string[]).includes(options.kind)) {
    throw new Error("--kind must be test, manual, or exception.");
  }
  if (options.ref.trim() === "") throw new Error("--ref cannot be empty.");
  if (options.kind === "exception" && !options.who?.trim()) {
    throw new Error("--kind exception requires --who <human> so the acceptance is attributable.");
  }

  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { task, goal } = await locateTask(root, options.taskId);
  const { criteria } = await criteriaForGoal(root, goal.id);
  if (options.criterion > criteria.length) {
    throw new Error(`${goal.id} has ${criteria.length} acceptance criteria; ${options.criterion} is out of range.`);
  }

  const evidence: CriterionEvidence = {
    taskId: task.id,
    kind: options.kind,
    ref: options.ref.trim(),
    recordedAt: new Date().toISOString(),
    ...(options.kind === "exception" ? { acceptedBy: options.who!.trim() } : {}),
  };
  await mutateState(goal.dir, goal.id, (state) => {
    delete state.qa;
    state.criteria ??= {};
    const entries = (state.criteria[String(options.criterion)] ??= []);
    if (!entries.some((item) => item.taskId === evidence.taskId && item.kind === evidence.kind && item.ref === evidence.ref)) {
      entries.push(evidence);
    }
  });
  return evidence;
}

export async function runGoalTrace(goalId: string, options: { cwd?: string } = {}): Promise<CriterionTrace[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { goal, criteria } = await criteriaForGoal(root, goalId);
  const state = await readState(goal.dir, goal.id);
  return criteria.map((criterion, i) => {
    const evidence = state.criteria?.[String(i + 1)] ?? [];
    const status = evidence.some((item) => item.kind === "test" || item.kind === "manual")
      ? "covered"
      : evidence.some((item) => item.kind === "exception" && item.acceptedBy?.trim())
        ? "exception"
        : evidence.some((item) => item.kind === "exception")
          ? "unapproved-exception"
          : "missing";
    return { index: i + 1, criterion, evidence, status };
  });
}
