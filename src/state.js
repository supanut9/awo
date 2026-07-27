import fs from "fs-extra";
import path from "path";
/**
 * §7.4 — task LIFECYCLE, distinct from a run's OUTCOME. A board shows this;
 * `success`/`failed` describe a run and live in `lastRunOutcome`.
 */
export const TASK_STATUSES = [
    "todo",
    "queued",
    "running",
    "blocked",
    "in-review",
    "done",
    "cancelled",
];
export const RUN_OUTCOMES = ["success", "failed", "skipped"];
/**
 * §7.4's transition table. Anything absent here is invalid and rejected —
 * that rejection is what keeps a board trustworthy under concurrent writers.
 */
const TRANSITIONS = [
    { from: "todo", to: "queued", actors: ["runner", "human"] },
    { from: "queued", to: "running", actors: ["runner"] },
    { from: "todo", to: "running", actors: ["runner"] },
    { from: "running", to: "in-review", actors: ["runner"] },
    { from: "running", to: "done", actors: ["runner"] },
    { from: "running", to: "blocked", actors: ["runner"] },
    { from: "queued", to: "blocked", actors: ["runner"] },
    { from: "in-review", to: "done", actors: ["qa", "human"] },
    { from: "in-review", to: "todo", actors: ["qa", "human"] },
    { from: "blocked", to: "todo", actors: ["human"] },
    { from: "blocked", to: "queued", actors: ["human"] },
    { from: "done", to: "todo", actors: ["human"] },
    // `cancelled` from anywhere, human only — never an agent (§7.4).
    ...TASK_STATUSES.filter((s) => s !== "cancelled").map((from) => ({
        from,
        to: "cancelled",
        actors: ["human"],
    })),
];
export function newTaskState(status = "todo") {
    return {
        status,
        lastRunOutcome: null,
        lastRunId: null,
        startedAt: null,
        finishedAt: null,
        attempts: 0,
        worktree: null,
        blockedReason: null,
    };
}
export function isValidTransition(from, to, actor) {
    if (from === to)
        return true;
    return TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
}
export function assertTransition(taskId, from, to, actor) {
    if (isValidTransition(from, to, actor))
        return;
    const allowed = TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.to);
    const hint = to === "cancelled" && actor !== "human"
        ? " `cancelled` is human-only — no agent may set it."
        : allowed.length > 0
            ? ` From "${from}", ${actor} may move to: ${allowed.join(", ")}.`
            : ` ${actor} may not move a task out of "${from}".`;
    throw new Error(`Invalid transition for ${taskId}: "${from}" -> "${to}".${hint}`);
}
/** §7.4 — derived from task states, stored only for cheap reads. */
export function rollupGoalStatus(tasks) {
    const all = Object.values(tasks).map((t) => t.status);
    if (all.length === 0)
        return "planning";
    const live = all.filter((s) => s !== "cancelled");
    if (live.length === 0)
        return "cancelled";
    if (live.some((s) => s === "blocked"))
        return "blocked";
    if (live.some((s) => s === "running"))
        return "in-progress";
    if (live.every((s) => s === "done"))
        return "done";
    if (live.every((s) => s === "done" || s === "in-review"))
        return "qa-review";
    if (live.some((s) => s === "queued" || s === "in-review"))
        return "in-progress";
    return "planning";
}
function statePath(goalDir) {
    return path.join(goalDir, "state.json");
}
export async function readState(goalDir, goalId) {
    const file = statePath(goalDir);
    if (!(await fs.pathExists(file))) {
        return { rev: 0, goalId, goalStatus: "planning", updatedAt: "", tasks: {} };
    }
    const raw = (await fs.readJson(file));
    if (typeof raw.rev !== "number" || typeof raw.tasks !== "object" || raw.tasks === null) {
        throw new Error(`${file} is malformed — missing rev or tasks.`);
    }
    return raw;
}
/**
 * §7.4 concurrency rules: the ONLY writer of state.json. Atomic via
 * tmp+rename so a reader never sees a partial file, and optimistic on `rev` —
 * if the file changed under us, re-read and re-apply the mutation rather than
 * blindly overwriting.
 */
export async function mutateState(goalDir, goalId, mutate, attemptsLeft = 5) {
    const before = await readState(goalDir, goalId);
    const next = JSON.parse(JSON.stringify(before));
    mutate(next);
    next.goalId = goalId;
    next.goalStatus = rollupGoalStatus(next.tasks);
    next.rev = before.rev + 1;
    next.updatedAt = new Date().toISOString();
    const file = statePath(goalDir);
    const current = await readState(goalDir, goalId);
    if (current.rev !== before.rev) {
        if (attemptsLeft <= 1) {
            throw new Error(`state.json for ${goalId} kept changing under concurrent writes; giving up rather than clobbering it.`);
        }
        return mutateState(goalDir, goalId, mutate, attemptsLeft - 1);
    }
    await fs.ensureDir(goalDir);
    const tmp = `${file}.tmp`;
    await fs.writeJson(tmp, next, { spaces: 2 });
    await fs.rename(tmp, file);
    return next;
}
