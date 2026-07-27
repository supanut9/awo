import path from "path";
import { readManifest } from "../manifest.js";
import { runList } from "../commands/list.js";
import { findGoals, findTasksInGoal } from "../tasks.js";
import { newTaskState, readState } from "../state.js";
import { readEvents, readIndex } from "../runs.js";
function toView(task, state) {
    return {
        id: task.id,
        goalId: task.goalId,
        name: task.name,
        status: state.status,
        lastRunOutcome: state.lastRunOutcome,
        lastRunId: state.lastRunId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        attempts: state.attempts,
        blockedReason: state.blockedReason,
        targets: task.targets,
        agent: task.agent,
    };
}
export class FileReader {
    root;
    constructor(root) {
        this.root = root;
    }
    async project() {
        const m = await readManifest(this.root);
        return {
            workspaceId: m.workspaceId ?? null,
            projectKey: m.projectKey,
            projectName: m.projectName ?? m.projectKey,
            libraryVersion: m.libraryVersion,
            root: path.basename(this.root),
        };
    }
    async goals() {
        const out = [];
        for (const goal of await findGoals(this.root)) {
            const state = await readState(goal.dir, goal.id);
            const tasks = await findTasksInGoal(goal.dir);
            out.push({
                id: goal.id,
                title: goal.title,
                status: state.goalStatus,
                tasks: tasks.map((t) => toView(t, state.tasks[t.id] ?? newTaskState(t.authoredStatus))),
            });
        }
        return out;
    }
    async repos() {
        return runList({ cwd: this.root });
    }
    async runs() {
        return (await readIndex(this.root)).sort((a, b) => b.runId.localeCompare(a.runId));
    }
    async runEvents(runId) {
        return readEvents(this.root, runId);
    }
    async snapshot() {
        const [project, goals, repos, runs] = await Promise.all([
            this.project(),
            this.goals(),
            this.repos(),
            this.runs(),
        ]);
        const tasks = goals.flatMap((g) => g.tasks);
        const byStatus = {};
        for (const t of tasks)
            byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        const finished = runs.filter((r) => r.status !== "running");
        const succeeded = finished.filter((r) => r.status === "success").length;
        const durations = runs
            .map((r) => r.durationSec)
            .filter((d) => typeof d === "number");
        return {
            project,
            goals,
            repos,
            runs,
            stats: {
                byStatus,
                totalTasks: tasks.length,
                totalRuns: runs.length,
                successRate: finished.length > 0 ? succeeded / finished.length : null,
                avgDurationSec: durations.length > 0
                    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
                    : null,
                openRuns: tasks.filter((t) => t.status === "running").length,
            },
            generatedAt: new Date().toISOString(),
        };
    }
}
