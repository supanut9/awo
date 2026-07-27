import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findAllTasks, locateTask } from "../tasks.js";
import { assertTransition, mutateState, newTaskState, readState, RUN_OUTCOMES, TASK_STATUSES, } from "../state.js";
import { appendEvent, appendIndex, detailFile, eventsFile as eventsFilePath, newRunId, readEvents, writeDetail, } from "../runs.js";
/** Frontmatter is the authored starting point; state.json wins once it exists (§7.2). */
function effectiveState(state, task) {
    return state.tasks[task.id] ?? newTaskState(task.authoredStatus);
}
export async function runTaskList(options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    if (options.status && !TASK_STATUSES.includes(options.status)) {
        throw new Error(`Unknown status "${options.status}". Valid: ${TASK_STATUSES.join(", ")}.`);
    }
    const rows = [];
    for (const { task, goal } of await findAllTasks(workspaceRoot)) {
        const state = await readState(goal.dir, goal.id);
        const ts = effectiveState(state, task);
        if (options.status && ts.status !== options.status)
            continue;
        rows.push({
            id: task.id,
            goalId: task.goalId,
            name: task.name,
            status: ts.status,
            lastRunOutcome: ts.lastRunOutcome,
            targets: task.targets,
            agent: task.agent,
        });
    }
    return rows;
}
export async function runTaskShow(taskId, options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    const { task, goal } = await locateTask(workspaceRoot, taskId);
    const state = await readState(goal.dir, goal.id);
    const ts = effectiveState(state, task);
    return {
        task,
        status: ts.status,
        lastRunId: ts.lastRunId,
        lastRunOutcome: ts.lastRunOutcome,
        attempts: ts.attempts,
        blockedReason: ts.blockedReason,
        goalStatus: state.goalStatus,
    };
}
export async function runTaskStatus(taskId, to, options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    if (!TASK_STATUSES.includes(to)) {
        throw new Error(`Unknown status "${to}". Valid: ${TASK_STATUSES.join(", ")}.`);
    }
    const target = to;
    const actor = options.actor ?? "human";
    const { task, goal } = await locateTask(workspaceRoot, taskId);
    const current = effectiveState(await readState(goal.dir, goal.id), task);
    assertTransition(task.id, current.status, target, actor);
    await mutateState(goal.dir, goal.id, (state) => {
        const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);
        ts.status = target;
        ts.blockedReason = target === "blocked" ? (options.reason ?? ts.blockedReason) : null;
        state.tasks[task.id] = ts;
    });
    return target;
}
/**
 * §9 item 2, decided: `task run` ORCHESTRATES — it resolves dependencies,
 * validates targets, moves lifecycle state, and opens the run's event stream.
 * The agent then does the actual work and closes the run with `task complete`.
 * This command deliberately does not execute the task's steps itself.
 */
export async function runTaskRun(taskId, options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    const manifest = await readManifest(workspaceRoot);
    const { task, goal } = await locateTask(workspaceRoot, taskId);
    const state = await readState(goal.dir, goal.id);
    const current = effectiveState(state, task);
    if (current.status === "running") {
        throw new Error(`${task.id} is already running (run ${current.lastRunId}). Close it with \`awo task complete ${task.id} --outcome <success|failed>\` first.`);
    }
    if (current.status === "cancelled") {
        throw new Error(`${task.id} is cancelled. Move it back to todo before running it.`);
    }
    if (current.status === "done") {
        throw new Error(`${task.id} is already done. Move it to todo if it genuinely needs redoing.`);
    }
    // §7.2 open question, decided: validate `targets` against the manifest and
    // fail fast rather than discovering a missing repo mid-run.
    const known = new Set(manifest.repos.map((r) => r.name));
    const unknown = task.targets.filter((t) => !known.has(t));
    if (unknown.length > 0) {
        throw new Error(`${task.id} targets repos not in the manifest: ${unknown.join(", ")}. Link them with \`awo connect\`/\`awo add\`, or fix the task's \`targets:\`.`);
    }
    // Dependencies must be `done` — `in-review` is not yet verified.
    const unmet = [];
    for (const depId of task.dependsOn) {
        const dep = await locateTask(workspaceRoot, depId).catch(() => null);
        if (!dep) {
            unmet.push(`${depId} (not found)`);
            continue;
        }
        const depState = effectiveState(await readState(dep.goal.dir, dep.goal.id), dep.task);
        if (depState.status !== "done")
            unmet.push(`${depId} (${depState.status})`);
    }
    if (unmet.length > 0) {
        await mutateState(goal.dir, goal.id, (s) => {
            const ts = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
            if (ts.status === "todo")
                ts.status = "queued";
            assertTransition(task.id, ts.status, "blocked", "runner");
            ts.status = "blocked";
            ts.blockedReason = `unmet dependencies: ${unmet.join(", ")}`;
            s.tasks[task.id] = ts;
        });
        throw new Error(`${task.id} has unmet dependencies: ${unmet.join(", ")}. Marked blocked.`);
    }
    const runId = newRunId(task.id);
    const startedAt = new Date().toISOString();
    await mutateState(goal.dir, goal.id, (s) => {
        const ts = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
        if (ts.status === "todo") {
            assertTransition(task.id, ts.status, "queued", "runner");
            ts.status = "queued";
        }
        assertTransition(task.id, ts.status, "running", "runner");
        ts.status = "running";
        ts.lastRunId = runId;
        ts.lastRunOutcome = null;
        ts.startedAt = startedAt;
        ts.finishedAt = null;
        ts.blockedReason = null;
        ts.attempts += 1;
        s.tasks[task.id] = ts;
    });
    await appendEvent(workspaceRoot, runId, "run.start", {
        taskId: task.id,
        goalId: goal.id,
        agent: task.agent,
        targets: task.targets,
    });
    return {
        taskId: task.id,
        runId,
        eventsFile: path.relative(workspaceRoot, eventsFilePath(workspaceRoot, runId)),
        targets: task.targets,
        agent: task.agent,
        body: task.body,
    };
}
export async function runTaskEvent(taskId, kind, options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    const { task, goal } = await locateTask(workspaceRoot, taskId);
    const ts = effectiveState(await readState(goal.dir, goal.id), task);
    if (ts.status !== "running" || !ts.lastRunId) {
        throw new Error(`${task.id} has no open run — start one with \`awo task run ${task.id}\` before recording events.`);
    }
    const fields = {};
    if (options.label)
        fields.label = options.label;
    if (options.message)
        fields.msg = options.message;
    if (options.data) {
        try {
            Object.assign(fields, JSON.parse(options.data));
        }
        catch {
            throw new Error(`--data must be valid JSON; got: ${options.data}`);
        }
    }
    await appendEvent(workspaceRoot, ts.lastRunId, kind, fields);
}
/**
 * Closes an open run: final event, run detail (§7.3), index line, and the
 * lifecycle transition. `--gate` routes a success to `in-review` instead of
 * `done`, so the QA gate (§7.1) stays a real step.
 */
export async function runTaskComplete(taskId, options) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    if (!RUN_OUTCOMES.includes(options.outcome)) {
        throw new Error(`Unknown outcome "${options.outcome}". Valid: ${RUN_OUTCOMES.join(", ")}.`);
    }
    const outcome = options.outcome;
    const { task, goal } = await locateTask(workspaceRoot, taskId);
    const ts = effectiveState(await readState(goal.dir, goal.id), task);
    if (ts.status !== "running" || !ts.lastRunId) {
        throw new Error(`${task.id} has no open run to complete (status: ${ts.status}).`);
    }
    const runId = ts.lastRunId;
    await appendEvent(workspaceRoot, runId, "run.end", { outcome });
    const finishedAt = new Date().toISOString();
    const durationSec = ts.startedAt
        ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(ts.startedAt)) / 1000))
        : null;
    const events = await readEvents(workspaceRoot, runId);
    const reposChanged = [
        ...new Set(events
            .filter((e) => e.kind === "repo.diff" && typeof e.repo === "string")
            .map((e) => e.repo)),
    ];
    const nextStatus = outcome === "success" ? (options.gate ? "in-review" : "done") : "blocked";
    await writeDetail(workspaceRoot, runId, {
        runId,
        taskId: task.id,
        goalId: goal.id,
        agent: task.agent ?? "null",
        status: outcome,
        startedAt: ts.startedAt ?? finishedAt,
        finishedAt,
        durationSec: durationSec ?? "null",
        reposChanged,
    }, {
        prompt: options.prompt,
        interpreted: options.interpreted,
        summary: options.summary,
        notes: options.note,
    });
    await appendIndex(workspaceRoot, {
        runId,
        taskId: task.id,
        agent: task.agent,
        status: outcome,
        startedAt: ts.startedAt ?? finishedAt,
        finishedAt,
        durationSec,
        reposChanged,
        detailFile: path.relative(path.join(workspaceRoot, "logs"), detailFile(workspaceRoot, runId)),
    });
    await mutateState(goal.dir, goal.id, (s) => {
        const t = s.tasks[task.id] ?? newTaskState(task.authoredStatus);
        assertTransition(task.id, t.status, nextStatus, "runner");
        t.status = nextStatus;
        t.lastRunOutcome = outcome;
        t.finishedAt = finishedAt;
        t.blockedReason =
            nextStatus === "blocked" ? (options.summary ?? `run ${runId} ${outcome}`) : null;
        s.tasks[task.id] = t;
    });
    return {
        taskId: task.id,
        runId,
        outcome,
        status: nextStatus,
        detail: path.relative(workspaceRoot, detailFile(workspaceRoot, runId)),
    };
}
/** Convenience for the QA gate (§7.1): approve or reject an in-review task. */
export async function runTaskVerify(taskId, options = { approve: true }) {
    return runTaskStatus(taskId, options.approve ? "done" : "todo", {
        cwd: options.cwd,
        actor: "qa",
        reason: options.reason,
    });
}
