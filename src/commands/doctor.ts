import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { fileURLToPath } from "url";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findAllTasks } from "../tasks.js";
import { newTaskState, readState } from "../state.js";
import { readEvents } from "../runs.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  area: "version" | "repos" | "tasks" | "goals" | "runs" | "workspace";
  message: string;
  fix?: string;
}

/**
 * §11.4 — reports what's wrong or drifting without changing anything. Read-only
 * on purpose: a diagnostic that silently repairs things hides the problem it
 * was run to find.
 */
export async function runDoctor(options: { cwd?: string } = {}): Promise<Finding[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const findings: Finding[] = [];
  const add = (f: Finding): void => {
    findings.push(f);
  };

  const manifest = await readManifest(root);

  // ---- version skew (§11) ----
  const installed = (
    JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

  if (manifest.libraryVersion !== installed) {
    add({
      severity: "info",
      area: "version",
      message: `workspace is at ${manifest.libraryVersion}, installed awo is ${installed}`,
      fix: "`awo upgrade` (not built yet) — harmless while no scaffolding has changed",
    });
  }
  if (!manifest.workspaceId) {
    add({
      severity: "warn",
      area: "version",
      message: "manifest has no workspaceId — this workspace predates it (§5)",
      fix: "harmless locally; needed only if the workspace ever publishes to a shared store",
    });
  }
  if (!(await fs.pathExists(path.join(root, ".workspace", "template.lock")))) {
    add({
      severity: "warn",
      area: "version",
      message: "no .workspace/template.lock — predates the lockfile (§11.2)",
      fix: "a future `awo upgrade` will be conservative: it will overwrite nothing and write .new files instead",
    });
  }

  // ---- repos ----
  if (manifest.repos.length === 0) {
    add({
      severity: "info",
      area: "repos",
      message: "no repos linked",
      fix: "`awo add <url>` or `awo connect <path>`",
    });
  }
  for (const repo of manifest.repos) {
    const target = path.join(root, "repos", repo.name);
    const link = await fs.lstat(target).catch(() => null);

    if (!link) {
      add({
        severity: "error",
        area: "repos",
        message: `${repo.name}: missing from repos/`,
        fix: "`awo sync`",
      });
      continue;
    }
    if (repo.type === "local") {
      if (!(await fs.pathExists(repo.path))) {
        add({
          severity: "error",
          area: "repos",
          message: `${repo.name}: source path no longer exists (${repo.path})`,
          fix: `\`awo connect <new-path> --name ${repo.name}\` after \`awo remove ${repo.name}\``,
        });
      } else if (link.isSymbolicLink()) {
        const current = await fs.readlink(target);
        if (path.resolve(current) !== path.resolve(repo.path)) {
          add({
            severity: "warn",
            area: "repos",
            message: `${repo.name}: symlink points at ${current}, manifest says ${repo.path}`,
            fix: "`awo sync`",
          });
        }
      }
    }
  }

  // ---- tasks & goals ----
  const known = new Set(manifest.repos.map((r) => r.name));
  const located = await findAllTasks(root);
  const taskIds = new Set(located.map((t) => t.task.id));

  for (const { task, goal } of located) {
    for (const target of task.targets) {
      if (!known.has(target)) {
        add({
          severity: "error",
          area: "tasks",
          message: `${task.id}: targets "${target}", which is not in the manifest`,
          fix: `link it, or fix \`targets:\` in ${path.relative(root, task.file)}`,
        });
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        add({
          severity: "error",
          area: "tasks",
          message: `${task.id}: dependsOn "${dep}", which does not exist`,
          fix: `fix \`dependsOn:\` in ${path.relative(root, task.file)}`,
        });
      }
    }

    // An abandoned run: state says running, but the event stream never closed.
    const state = await readState(goal.dir, goal.id);
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);

    // Work claimed with no evidence. The QA gate caught six such tasks composing
    // into a broken feature (§9 item 47); this is the cheap version of that check.
    if ((ts.status === "done" || ts.status === "in-review") && ts.lastRunId) {
      const events = await readEvents(root, ts.lastRunId);
      if (!events.some((e) => e.kind === "commit" || e.kind === "repo.diff")) {
        add({
          severity: "warn",
          area: "runs",
          message: `${task.id} is ${ts.status} but its run recorded no commit or diff`,
          fix: "confirm the work exists; a run that changed nothing should not be a success",
        });
      }
      if (!events.some((e) => e.kind === "test")) {
        add({
          severity: "warn",
          area: "runs",
          message: `${task.id} is ${ts.status} with no test evidence in its run`,
          fix: "rule tests-must-pass — record `awo task event <id> test`, or re-close with --untested \"<why>\"",
        });
      }
    }

    if (ts.status === "running" && ts.lastRunId) {
      const events = await readEvents(root, ts.lastRunId);
      if (!events.some((e) => e.kind === "run.end")) {
        add({
          severity: "warn",
          area: "runs",
          message: `${task.id}: run ${ts.lastRunId} was opened but never closed`,
          fix: `\`awo task complete ${task.id} --outcome failed\`, or move it back with \`awo task status ${task.id} todo\``,
        });
      }
    }
  }

  for (const goal of await findGoals(root)) {
    const goalFile = path.join(goal.dir, "goal.md");
    const fm = matter(await fs.readFile(goalFile, "utf8")).data as Record<string, unknown>;
    const declared = new Set((Array.isArray(fm.taskIds) ? fm.taskIds : []).map(String));
    const actual = new Set(goal.taskIds);

    for (const id of actual) {
      if (!declared.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          message: `${goal.id}: task ${id} exists but is not in the goal's taskIds`,
          fix: `add it to \`taskIds:\` in ${path.relative(root, goalFile)}`,
        });
      }
    }
    for (const id of declared) {
      if (!actual.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          message: `${goal.id}: taskIds lists ${id}, but no such task file exists`,
          fix: `remove it from \`taskIds:\` in ${path.relative(root, goalFile)}`,
        });
      }
    }

    // State entries for tasks that were deleted.
    const state = await readState(goal.dir, goal.id);
    for (const id of Object.keys(state.tasks)) {
      if (!actual.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          message: `${goal.id}: state.json tracks ${id}, which has no task file`,
          fix: "harmless, but it will linger until state.json is edited or the task returns",
        });
      }
    }
  }

  // ---- un-transformed requirements (§9 item 22) ----
  const loose = (await fs.readdir(path.join(root, "goals")).catch(() => []))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  for (const id of loose) {
    add({
      severity: "info",
      area: "workspace",
      message: `${id} is still an un-transformed requirement`,
      fix: `\`awo goal new --from ${id}\``,
    });
  }

  return findings;
}

export function doctorExitCode(findings: Finding[]): number {
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}
