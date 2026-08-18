import fs from "fs-extra";
import path from "path";
import matter from "gray-matter";
import { fileURLToPath } from "url";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { findGoals, findAllTasks } from "../tasks.js";
import { newTaskState, readState, reconcileGoalState } from "../state.js";
import { readEvents } from "../runs.js";
import { listWorktrees, unsafeReason } from "../worktrees.js";
import { runAgentOrg } from "./agent-org.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  area: "version" | "repos" | "tasks" | "goals" | "runs" | "workspace";
  message: string;
  fix?: string;
  /**
   * Findings sharing a group are one systemic problem, and the printer collapses
   * them (§11.4).
   *
   * Two weeks of real use turned `doctor` into 166 lines, 78 warnings, of which 74
   * were the same sentence about a different task id. A page nobody reads to the end
   * diagnoses nothing, and "every single task is affected" is a different fact from
   * "this task is affected" — it should read as one finding with a count.
   */
  group?: string;
}

/** One systemic problem: its first few instances, and how many there were. */
export interface FindingGroup {
  key: string;
  severity: Severity;
  findings: Finding[];
}

/**
 * Collapse findings into groups, preserving the order each group first appeared.
 * An ungrouped finding is its own group, so nothing is ever silently merged.
 */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const index = new Map<string, FindingGroup>();

  for (const [at, finding] of findings.entries()) {
    const key = finding.group ?? `${finding.area}:${at}`;
    const existing = index.get(key);
    if (existing) {
      existing.findings.push(finding);
      // A group is as severe as its worst member.
      if (finding.severity === "error") existing.severity = "error";
      else if (finding.severity === "warn" && existing.severity === "info") existing.severity = "warn";
      continue;
    }
    const group: FindingGroup = { key, severity: finding.severity, findings: [finding] };
    index.set(key, group);
    groups.push(group);
  }

  return groups;
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
  const organization = await runAgentOrg({ cwd: root });
  for (const message of organization.errors) {
    add({
      severity: "error",
      area: "workspace",
      message: `agent organization: ${message}`,
      fix: "fix reportsTo, delegatesTo, or reviews in agents/<role>.md",
    });
  }

  // ---- unresolved upgrade conflicts (§11.2) ----
  // `upgrade` writes `<file>.new` beside a file you edited rather than overwriting
  // it, then says so once. Nothing ever mentioned it again, so a stale `.new` could
  // sit next to AGENTS.md — the canonical instruction file — indefinitely, with two
  // versions on disk and agents reading the wrong one.
  const conflicts: string[] = [];
  const scanConflicts = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 2) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "repos" || entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scanConflicts(full, depth + 1);
      else if (entry.name.endsWith(".new")) conflicts.push(path.relative(root, full));
    }
  };
  await scanConflicts(root);

  // ---- repos with no declared verification ----
  // Without one, every measurement carries an inline command, so each agent invents
  // its own — and an agent choosing the verification is the same failure as an agent
  // asserting the result.
  for (const repo of manifest.repos) {
    if (!repo.testCommand) {
      add({
        severity: "info",
        area: "repos",
        message: `${repo.name} has no testCommand, so agents must invent one per run`,
        fix: `awo test-command ${repo.name} "<how this repo runs its tests>"`,
        group: "repos:no-test-command",
      });
    }
  }

  // ---- rules that AGENTS.md never mentions ----
  // Rules are ambient: an agent finds them because AGENTS.md lists them. A rule file
  // added without that line is a rule that exists and is never read — which is how
  // `evidence-not-claims` shipped in 0.0.36 and went unmentioned for four versions.
  const agentsFile = path.join(root, "AGENTS.md");
  const agentsText = await fs.readFile(agentsFile, "utf8").catch(() => "");
  if (agentsText) {
    for (const file of await fs.readdir(path.join(root, "rules")).catch(() => [])) {
      if (!file.endsWith(".md")) continue;
      const id = file.replace(/\.md$/, "");
      if (!agentsText.includes(id)) {
        add({
          severity: "warn",
          area: "workspace",
          message: `rule "${id}" exists but AGENTS.md never mentions it, so agents will not apply it`,
          fix: `add a line for it under "## Always-on rules" in AGENTS.md`,
          group: "workspace:rule-unmentioned",
        });
      }
    }
  }
  for (const rel of conflicts) {
    add({
      severity: "warn",
      area: "workspace",
      message: `unresolved upgrade conflict: ${rel} is waiting to be merged into ${rel.replace(/\.new$/, "")}`,
      fix: `diff ${rel.replace(/\.new$/, "")} ${rel} — then take what you want and delete ${rel}`,
    });
  }

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
      fix: "`awo upgrade` — it runs the migrations between those versions and reconciles scaffolding",
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

    // Evidence follows the authored task kind. Legacy tasks did not declare one,
    // so retroactively calling every investigation "implementation" produced 112
    // false commit warnings in SHOP and buried the real integrity error.
    if (
      task.kindExplicit &&
      (ts.status === "done" || ts.status === "in-review") &&
      ts.lastRunId
    ) {
      const events = await readEvents(root, ts.lastRunId);
      if (
        task.kind === "implementation" &&
        events.some((e) => e.kind === "repo.baseline") &&
        !events.some(
          (e) =>
            e.kind === "commit" ||
            e.kind === "repo.diff" ||
            (e.kind === "note" && e.category === "no-change")
        )
      ) {
        add({
          severity: "warn",
          area: "runs",
          message: `${task.id} is ${ts.status} but its run recorded no commit or diff`,
          fix: "confirm the work exists; a run that changed nothing should not be a success",
          group: "runs:no-commit-or-diff",
        });
      }
      if (
        (task.kind === "implementation" || task.kind === "verification") &&
        !events.some((e) => e.kind === "test")
      ) {
        add({
          severity: "warn",
          area: "runs",
          message: `${task.id} is ${ts.status} with no test evidence in its run`,
          // The old advice was `awo task event <id> test`, which fails on a closed
          // task: there is no open run to append to. A fix that errors is worse than
          // none — it costs the reader the time to find that out.
          fix:
            `rule tests-must-pass — verify it for real: \`awo task recheck ${task.id} --run "<cmd>" --baseline\``,
          group: "runs:no-test-evidence",
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
          group: "runs:never-closed",
        });
      }
    }
  }

  for (const goal of await findGoals(root)) {
    const goalFile = path.join(goal.dir, "goal.md");
    const fm = matter(await fs.readFile(goalFile, "utf8")).data as Record<string, unknown>;
    const declared = new Set((Array.isArray(fm.taskIds) ? fm.taskIds : []).map(String));
    const actual = new Set(goal.taskIds);
    const rawState = await readState(goal.dir, goal.id);
    const reconciliation = reconcileGoalState(rawState, await (await import("../tasks.js")).findTasksInGoal(goal.dir));

    // Missing state for a task that has never run is normal, not a finding — every
    // freshly planned goal is in that state. What is corruption is a goal whose
    // STORED status claims the work is over while authored tasks are absent from
    // state entirely: that is the reading that let SHOP-G1 report done, and no
    // reader should trust it.
    const claimsFinished = rawState.goalStatus === "done" || rawState.goalStatus === "qa-review";
    if (reconciliation.missingTaskIds.length > 0 && claimsFinished) {
      add({
        severity: "error",
        area: "goals",
        message: `${goal.id}: state.json says "${rawState.goalStatus}" but is missing authored task(s): ${reconciliation.missingTaskIds.join(", ")} — that status is not trustworthy`,
        fix: `those tasks are counted as todo on read; run a task transition to persist the correction`,
      });
    }
    if (reconciliation.orphanedTaskIds.length > 0) {
      add({
        severity: "warn",
        area: "goals",
        message: `${goal.id}: state.json contains deleted task(s): ${reconciliation.orphanedTaskIds.join(", ")}`,
        fix: "review the deleted tasks, then run a task transition to persist reconciliation",
      });
    }

    for (const id of actual) {
      if (!declared.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          message: `${goal.id}: task ${id} exists but is not in the goal's taskIds`,
          fix: `add it to \`taskIds:\` in ${path.relative(root, goalFile)}`,
          group: "goals:task-not-in-taskids",
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
          group: "goals:taskid-without-file",
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
          group: "goals:state-without-file",
        });
      }
    }
  }

  // ---- worktrees for work that is finished ----
  // `awo` created these and never removed one. In the SHOP workspace that left 2.0 GB
  // of checkouts for tasks that were all `done`, plus two an agent made by hand and
  // seven `.baseline/` scratch trees. Reported, never removed: `worktree prune` is the
  // command that removes things, and it refuses any checkout still holding work.
  const terminal = new Set<string>();
  for (const { task, goal } of located) {
    const state = await readState(goal.dir, goal.id);
    const status = (state.tasks[task.id] ?? newTaskState(task.authoredStatus)).status;
    if (status === "done" || status === "cancelled") terminal.add(task.id);
  }

  // Without sizes: measuring them walks every file in every checkout, which took
  // this command from 0.27s to 5.7s on a workspace holding 1.5 GB of them.
  // `awo worktree list` is where the number belongs.
  const worktrees = await listWorktrees(root, manifest).catch(() => []);
  const stale = worktrees.filter((w) => w.leaf === ".baseline" || terminal.has(w.leaf));
  if (stale.length > 0) {
    for (const worktree of stale) {
      add({
        severity: "info",
        area: "workspace",
        message:
          worktree.leaf === ".baseline"
            ? `${worktree.path} is a leftover baseline checkout for ${worktree.repo}`
            : `${worktree.path} is still checked out, but ${worktree.leaf} is finished` +
              (unsafeReason(worktree) ? ` — and ${unsafeReason(worktree)}` : ""),
        fix: `${stale.length} stale worktree(s) — \`awo worktree list\` for their size, \`awo worktree prune\` to remove them (it keeps any that still holds work)`,
        group: "workspace:stale-worktree",
      });
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
