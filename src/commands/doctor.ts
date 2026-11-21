import fs from "fs-extra";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import matter from "gray-matter";
import { fileURLToPath } from "url";
import { simpleGit } from "simple-git";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import {
  findGoals,
  findAllTasks,
  goalArchiveDir,
  TASK_KINDS,
  type GoalDefinition,
  type LocatedTask,
} from "../tasks.js";
import {
  newTaskState,
  readState,
  reconcileGoalState,
  TASK_STATUSES,
  type GoalState,
  type TaskState,
} from "../state.js";
import { readEvents, type RunEvent } from "../runs.js";
import { listWorktrees, unsafeReason } from "../worktrees.js";
import { redactSecrets } from "../redact.js";
import { findStaleLocks } from "../file-lock.js";
import { unwrittenTemplateLines } from "../lifecycle.js";
import { runAgentOrg } from "./agent-org.js";
import { readAgentSkills, findInstalled } from "../agent-skills.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  area: "version" | "repos" | "tasks" | "goals" | "runs" | "workspace" | "requirements";
  /**
   * Stable identifier for the kind of problem (`run-abandoned`, `disk-space-low`).
   * The message is prose and gets reworded; scripts and agents key on this.
   */
  code?: string;
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


/** Pre-0.0.2 status names that `readTaskFile` still translates on read. */
const LEGACY_TASK_STATUSES = ["pending", "success", "failed", "skipped"];

function formatAge(ms: number): string {
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

/** Signal 0 tests existence without touching the process; EPERM still means alive. */
function pidAlive(pid: number): boolean {
  // 0 and negatives address process groups, not a process.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Single-quote a path for a copy-pasteable shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface OpenRunLiveness {
  state: "possibly-live" | "quiet" | "abandoned";
  /** Human-readable reason, for the finding. */
  why: string;
}

/**
 * Tell a run that is still being worked from one nobody will ever close.
 *
 * Measured on the real workspaces: CRM-T90 sat open for 227 hours, and doctor's
 * advice for it was `task status <id> todo` — a `running -> todo` move the
 * transition table refuses. "Possibly live" is deliberately weak: a live owner pid
 * on this host or recent activity says someone may still be at it, not that they
 * are, so the advice is phrased for both cases.
 */
export function classifyOpenRun(
  ts: TaskState,
  events: RunEvent[],
  now: number = Date.now(),
  host: string = os.hostname()
): OpenRunLiveness {
  const owner = ts.owner ?? null;
  if (owner && typeof owner.pid === "number" && owner.host === host && pidAlive(owner.pid)) {
    return { state: "possibly-live", why: `its owner process ${owner.pid} is still running on this host` };
  }

  const stamps = [
    ...events.map((e) => Date.parse(String(e.t))),
    owner?.heartbeatAt ? Date.parse(owner.heartbeatAt) : Number.NaN,
    ts.startedAt ? Date.parse(ts.startedAt) : Number.NaN,
  ].filter(Number.isFinite);
  if (stamps.length === 0) return { state: "abandoned", why: "no activity was ever recorded" };

  const idle = now - Math.max(...stamps);
  if (idle < 2 * HOUR) return { state: "possibly-live", why: `last activity ${formatAge(idle)} ago` };
  if (idle > DAY) return { state: "abandoned", why: `no activity for ${formatAge(idle)}` };
  return { state: "quiet", why: `no activity for ${formatAge(idle)}` };
}

/**
 * The disk check, separated from `statfs` so the threshold is testable without
 * filling a disk. Only reports when free space is actually low: a line on every
 * run saying "disk is fine" is the noise that buried real findings before.
 *
 * Measured on the real workspaces: worktree checkouts filled the volume on Nov 20
 * and every agent stopped with ENOSPC at once, with nothing having warned first.
 */
export function diskSpaceFinding(
  stats: { bavail: number; blocks: number; bsize: number },
  worktreeCount: number
): Finding | null {
  if (!stats.blocks || stats.blocks <= 0) return null;
  const free = stats.bavail / stats.blocks;
  if (free >= 0.1) return null;
  const gb = (blocks: number): string => ((blocks * stats.bsize) / 1024 ** 3).toFixed(1);
  return {
    severity: "warn",
    area: "workspace",
    code: "disk-space-low",
    message:
      `the workspace volume has ${(free * 100).toFixed(1)}% free (${gb(stats.bavail)} of ${gb(stats.blocks)} GB); ` +
      `${worktreeCount} task worktree(s) under repos/.worktrees`,
    fix: "`awo worktree list` for their size, then `awo worktree prune` — at 0% every agent stops with ENOSPC",
  };
}

interface MalformedTaskFile {
  file: string;
  problem: string;
  severity: Severity;
  code: string;
}

/**
 * Read every task file on its own, so one bad file is reported by name instead of
 * aborting the whole inventory. `readTaskFile` throws on the first problem, which
 * made a single malformed file take down every command that lists tasks.
 */
async function scanTaskFiles(root: string): Promise<MalformedTaskFile[]> {
  const out: MalformedTaskFile[] = [];
  const goalsRoot = path.join(root, "goals");
  const containers = [goalsRoot, goalArchiveDir(root)];
  for (const container of containers) {
    for (const entry of await fs.readdir(container, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(container, entry.name);
      if (dir === goalArchiveDir(root)) continue;
      const tasksDir = path.join(dir, "tasks");
      for (const name of await fs.readdir(tasksDir).catch(() => [] as string[])) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(tasksDir, name);
        const rel = path.relative(root, file);
        let data: Record<string, unknown>;
        try {
          data = matter(await fs.readFile(file, "utf8")).data as Record<string, unknown>;
        } catch (err) {
          out.push({
            file: rel,
            severity: "error",
            code: "task-file-malformed",
            problem: `its frontmatter does not parse (${(err as Error).message.split("\n")[0]})`,
          });
          continue;
        }
        const problems: string[] = [];
        if (typeof data.id !== "string" || data.id.trim() === "") problems.push("no `id:`");
        if (typeof data.goalId !== "string" || data.goalId.trim() === "") problems.push("no `goalId:`");
        if (
          data.status !== undefined &&
          !(TASK_STATUSES as readonly string[]).includes(String(data.status)) &&
          !LEGACY_TASK_STATUSES.includes(String(data.status))
        ) {
          problems.push(`status "${String(data.status)}" is not a lifecycle state (${TASK_STATUSES.join(", ")})`);
        }
        if (problems.length > 0) {
          out.push({ file: rel, severity: "error", code: "task-file-malformed", problem: problems.join("; ") });
          continue;
        }
        if (data.kind !== undefined && !(TASK_KINDS as readonly string[]).includes(String(data.kind))) {
          out.push({
            file: rel,
            severity: "warn",
            code: "task-kind-unknown",
            problem: `kind "${String(data.kind)}" is not one of ${TASK_KINDS.join(", ")}, so it is treated as implementation`,
          });
        }
      }
    }
  }
  return out;
}

/** A stale lock as Lane D1's `findStaleLocks(root)` reports it (src/file-lock.ts). */
export interface StaleLockReport {
  path: string;
  pid: number | null;
  host: string | null;
  acquiredAt: string | null;
}

function staleLockFindings(root: string, locks: StaleLockReport[]): Finding[] {
  return locks.map((lock) => ({
    severity: "warn" as const,
    area: "workspace" as const,
    code: "lock-stale",
    message:
      `${path.relative(root, lock.path)} is held by a process that is gone` +
      (lock.pid ? ` (pid ${lock.pid}${lock.host ? ` on ${lock.host}` : ""})` : "") +
      (lock.acquiredAt ? `, since ${lock.acquiredAt}` : "") +
      " — every writer to that file will time out",
    fix: `stop all awo writers, then \`rm -r ${shellQuote(path.relative(root, lock.path))}\``,
    group: "workspace:stale-lock",
  }));
}

/**
 * §11.4 — reports what's wrong or drifting without changing anything. Read-only
 * on purpose: a diagnostic that silently repairs things hides the problem it
 * was run to find.
 */
export async function runDoctor(
  options: {
    cwd?: string;
    /**
     * `active` (the default) leaves out archived goals. Measured on atlas-shop:
     * 204 findings under `all`, 19 under `active` — history drowned the live work.
     */
    scope?: "active" | "all";
    /** Also scan logs/ for recorded credentials. Opt-in: it reads every log file. */
    secrets?: boolean;
  } = {}
): Promise<Finding[]> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const scope = options.scope ?? "active";
  const now = Date.now();
  const findings: Finding[] = [];
  const add = (f: Finding): void => {
    findings.push(f);
  };

  const manifest = await readManifest(root);

  // ---- malformed task files ----
  // First, because a single one used to abort every command that lists tasks —
  // this one included — so nothing else below could be reported either.
  const malformed = await scanTaskFiles(root);
  for (const bad of malformed) {
    add({
      severity: bad.severity,
      area: "tasks",
      code: bad.code,
      message: `${bad.file}: ${bad.problem}`,
      fix: `fix the frontmatter in ${bad.file} — every task needs \`id:\`, \`goalId:\` and a valid \`status:\``,
      group: `tasks:${bad.code}`,
    });
  }
  const brokenInventory = malformed.some((m) => m.severity === "error");

  try {
    const organization = await runAgentOrg({ cwd: root });
    for (const message of organization.errors) {
      add({
        severity: "error",
        area: "workspace",
        code: "agent-org-invalid",
        message: `agent organization: ${message}`,
        fix: "fix reportsTo, delegatesTo, or reviews in agents/<role>.md",
      });
    }
  } catch (err) {
    // The org reader lists tasks for workload, so a malformed task file lands here
    // too; that file is already reported above by name.
    if (!brokenInventory) {
      add({
        severity: "error",
        area: "workspace",
        code: "agent-org-unreadable",
        message: `agent organization could not be read: ${(err as Error).message}`,
        fix: "fix the file named above, then re-run `awo doctor`",
      });
    }
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
        code: "repo-no-test-command",
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
          code: "rule-unmentioned",
          message: `rule "${id}" exists but AGENTS.md never mentions it, so agents will not apply it`,
          fix: `add a line for it under "## Always-on rules" in AGENTS.md`,
          group: "workspace:rule-unmentioned",
        });
      }
    }
  }
  // ---- declared external agent skills that are not actually here (§7.2) ----
  // Declaring a skill and installing it are two acts, and only the second one puts
  // anything in the model's context. A skill present only in `~/.claude/skills` is
  // reported separately from a missing one because it is a different failure: it
  // works on this machine and vanishes on a clone, a CI box, or a scheduled run.
  try {
    const declared = await readAgentSkills(root);
    const present = await findInstalled(root, declared);
    for (const skill of declared) {
      const state = present.get(skill.name);
      if (!state || state.where === "workspace") continue;
      // A catalog-tier skill that is simply absent is absent on purpose — that is
      // what opt-in means. A *partly* installed one never is.
      if (skill.tier !== "default" && state.where === "absent") continue;

      const message =
        state.where === "user"
          ? `agent skill "${skill.name}" is only in ~/.claude/skills — a clone of this workspace will not have it`
          : state.where === "partial"
            ? `agent skill "${skill.name}" is partly installed; missing ${state.missing.join(", ")}`
            : `agent skill "${skill.name}" is declared but not installed, so nothing can reach it`;
      add({
        severity: state.where === "user" ? "info" : "warn",
        area: "workspace",
        code: state.where === "user" ? "agent-skill-user-global" : "agent-skill-missing",
        message,
        fix: `awo skill sync ${skill.name}`,
        group:
          state.where === "user"
            ? "workspace:agent-skill-user-global"
            : "workspace:agent-skill-missing",
      });
    }
  } catch (err) {
    add({
      severity: "error",
      area: "workspace",
      code: "agent-skills-invalid",
      message: (err as Error).message,
      fix: "fix .workspace/agent-skills.json — every entry needs name, source and summary",
    });
  }

  for (const rel of conflicts) {
    add({
      severity: "warn",
      area: "workspace",
      code: "upgrade-conflict",
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
      code: "version-skew",
      message: `workspace is at ${manifest.libraryVersion}, installed awo is ${installed}`,
      fix: "`awo upgrade` — it runs the migrations between those versions and reconciles scaffolding",
    });
  }
  if (!manifest.workspaceId) {
    add({
      severity: "warn",
      area: "version",
      code: "manifest-no-workspace-id",
      message: "manifest has no workspaceId — this workspace predates it (§5)",
      fix: "harmless locally; needed only if the workspace ever publishes to a shared store",
    });
  }
  if (!(await fs.pathExists(path.join(root, ".workspace", "template.lock")))) {
    add({
      severity: "warn",
      area: "version",
      code: "template-lock-missing",
      message: "no .workspace/template.lock — predates the lockfile (§11.2)",
      fix: "a future `awo upgrade` will be conservative: it will overwrite nothing and write .new files instead",
    });
  }

  // ---- repos ----
  if (manifest.repos.length === 0) {
    add({
      severity: "info",
      area: "repos",
      code: "repos-none",
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
        code: "repo-link-missing",
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
          code: "repo-source-missing",
          message: `${repo.name}: source path no longer exists (${repo.path})`,
          fix: `\`awo connect <new-path> --name ${repo.name}\` after \`awo remove ${repo.name}\``,
        });
      } else if (link.isSymbolicLink()) {
        const current = await fs.readlink(target);
        if (path.resolve(current) !== path.resolve(repo.path)) {
          add({
            severity: "warn",
            area: "repos",
            code: "repo-link-mismatch",
            message: `${repo.name}: symlink points at ${current}, manifest says ${repo.path}`,
            fix: "`awo sync`",
          });
        }
      }
    }
  }

  // ---- tasks & goals ----
  const known = new Set(manifest.repos.map((r) => r.name));
  let inventory: LocatedTask[] = [];
  let inventoryRead = true;
  try {
    inventory = await findAllTasks(root);
  } catch (err) {
    inventoryRead = false;
    add({
      severity: brokenInventory ? "info" : "error",
      area: "tasks",
      code: "task-inventory-unreadable",
      message: brokenInventory
        ? "task and goal checks were skipped: the task inventory cannot be read while a task file is malformed"
        : `the task inventory could not be read: ${(err as Error).message}`,
      fix: "fix the file named above, then re-run `awo doctor`",
    });
  }
  const located = inventory.filter(({ goal }) => scope !== "active" || !goal.archived);
  // Archived tasks still satisfy references from active work.
  const taskIds = new Set(inventory.map((t) => t.task.id));

  // One read per goal rather than one per task: SHOP holds 1,335 tasks in 113 goals.
  const states = new Map<string, Promise<GoalState>>();
  const stateOf = (goal: GoalDefinition): Promise<GoalState> => {
    let state = states.get(goal.dir);
    if (!state) {
      state = readState(goal.dir, goal.id);
      states.set(goal.dir, state);
    }
    return state;
  };

  // Tasks not running whose recorded worktree is gone: harmless, so one finding with
  // a count rather than one per task (84 of them on atlas-shop's live goals alone).
  const danglingPointers: string[] = [];

  for (const { task, goal } of located) {
    for (const target of task.targets) {
      if (!known.has(target)) {
        add({
          severity: goal.archived ? "info" : "error",
          area: "tasks",
          code: goal.archived ? "task-target-historical" : "task-target-unknown",
          message: `${task.id}: ${goal.archived ? "historical target" : "targets"} "${target}", which is not in the manifest`,
          fix: goal.archived
            ? "preserve historical targets; register this repo again before restoring its work"
            : `link it, or fix \`targets:\` in ${path.relative(root, task.file)}`,
          group: `${goal.archived ? "historical" : "active"}:missing-target:${target}`,
        });
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        add({
          severity: "error",
          area: "tasks",
          code: "task-dependency-missing",
          message: `${task.id}: dependsOn "${dep}", which does not exist`,
          fix: `fix \`dependsOn:\` in ${path.relative(root, task.file)}`,
        });
      }
    }

    const state = await stateOf(goal);
    const ts = state.tasks[task.id] ?? newTaskState(task.authoredStatus);

    // ---- unwritten task bodies ----
    // Only for work still ahead: a finished task's body is history, and flagging
    // it would bury the ones a worker is about to be handed.
    if (
      !goal.archived &&
      (ts.status === "todo" || ts.status === "queued" || ts.status === "blocked" || ts.status === "running") &&
      // One definition of "unwritten" for the gate (`task run`) and the report.
      // 22% of SHOP's first briefs were the bare template handed to a worker.
      unwrittenTemplateLines(task.body).length > 0
    ) {
      add({
        severity: "warn",
        area: "tasks",
        code: "task-body-placeholder",
        message: `${task.id} is ${ts.status} but its body is still the \`awo task new\` template`,
        fix: `write the objective, steps and done-when in ${path.relative(root, task.file)} before it is dispatched`,
        group: "tasks:body-placeholder",
      });
    }

    // ---- dangling worktree pointers ----
    // Measured on the real workspaces: 117 of 126 recorded worktree paths pointed at
    // directories that no longer existed, so every reader that trusted the pointer
    // sent an agent to nothing.
    if (ts.worktree) {
      const abs = path.isAbsolute(ts.worktree) ? ts.worktree : path.join(root, ts.worktree);
      if (!(await fs.pathExists(abs))) {
        if (ts.status === "running") {
          add({
            severity: "warn",
            area: "tasks",
            code: "worktree-pointer-dangling",
            message: `${task.id} (running) records worktree ${ts.worktree}, which no longer exists`,
            fix: `its open run lost its checkout — \`awo task complete ${task.id} --outcome failed --summary "worktree lost"\`, then \`awo task run ${task.id}\` cuts a fresh one`,
            group: "tasks:dangling-pointer:open",
          });
        } else {
          danglingPointers.push(task.id);
        }
      }
    }

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
          code: "run-no-commit-or-diff",
          message: `${task.id} is ${ts.status} but its run recorded no commit or diff`,
          fix: "confirm the work exists; a run that changed nothing should not be a success",
          group: "runs:no-commit-or-diff",
        });
      }
      // A verification task proves a criterion by hand as often as by a suite: a
      // manual check attached to a criterion IS its evidence, and demanding a test
      // event on top of it was a warning nobody could clear honestly.
      const manuallyVerified =
        task.kind === "verification" &&
        Object.values(state.criteria ?? {}).some((list) =>
          (list ?? []).some((evidence) => evidence.taskId === task.id && evidence.kind === "manual")
        );
      if (
        (task.kind === "implementation" || task.kind === "verification") &&
        !manuallyVerified &&
        !events.some((e) => e.kind === "test")
      ) {
        add({
          severity: "warn",
          area: "runs",
          code: "run-no-test-evidence",
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

    // ---- open runs: live, quiet, or abandoned ----
    if (ts.status === "running" && ts.lastRunId) {
      const events = await readEvents(root, ts.lastRunId);
      if (!events.some((e) => e.kind === "run.end")) {
        const liveness = classifyOpenRun(ts, events, now);
        // `running -> todo` is not a legal move (the old advice here); closing the
        // run as failed is, and it keeps the attempt in the history.
        const close = `\`awo task complete ${task.id} --outcome failed --summary "abandoned"\``;
        const resume = `\`awo task resume ${task.id}\``;
        const opened = `${task.id}: run ${ts.lastRunId} was opened but never closed`;
        if (liveness.state === "possibly-live") {
          add({
            severity: "info",
            area: "runs",
            code: "run-open-possibly-live",
            message: `${opened} — possibly live: ${liveness.why}`,
            fix: `leave it while its worker is at it; if the worker has stopped: ${close}`,
            group: "runs:open-possibly-live",
          });
        } else if (liveness.state === "quiet") {
          add({
            severity: "warn",
            area: "runs",
            code: "run-open-quiet",
            message: `${opened} — ${liveness.why}`,
            fix: `if its worker has stopped, continue it with ${resume} or abandon it: ${close}`,
            group: "runs:never-closed",
          });
        } else {
          add({
            severity: "warn",
            area: "runs",
            code: "run-abandoned",
            message: `${opened} — abandoned: ${liveness.why}`,
            fix: close,
            group: "runs:abandoned",
          });
        }
      }
    }
  }

  if (danglingPointers.length > 0) {
    const shown = danglingPointers.slice(0, 5).join(", ");
    add({
      severity: "info",
      area: "tasks",
      code: "worktree-pointer-dangling",
      message:
        `${danglingPointers.length} task(s) record a worktree that no longer exists ` +
        `(${shown}${danglingPointers.length > 5 ? ", …" : ""})`,
      fix: "stale pointers, harmless — `awo worktree prune` clears them, and `awo task run` cuts a fresh checkout when one is needed",
    });
  }

  for (const goal of inventoryRead ? await findGoals(root, { includeArchived: scope !== "active" }) : []) {
    const goalFile = path.join(goal.dir, "goal.md");
    const fm = matter(await fs.readFile(goalFile, "utf8")).data as Record<string, unknown>;
    const declared = new Set((Array.isArray(fm.taskIds) ? fm.taskIds : []).map(String));
    const actual = new Set(goal.taskIds);
    const authored = inventory.filter((t) => t.goal.dir === goal.dir).map((t) => t.task);
    const rawState = await stateOf(goal);
    const reconciliation = reconcileGoalState(rawState, authored);

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
        code: "goal-state-untrustworthy",
        message: `${goal.id}: state.json says "${rawState.goalStatus}" but is missing authored task(s): ${reconciliation.missingTaskIds.join(", ")} — that status is not trustworthy`,
        fix: `those tasks are counted as todo on read; run a task transition to persist the correction`,
      });
    }
    if (reconciliation.orphanedTaskIds.length > 0) {
      add({
        severity: "warn",
        area: "goals",
        code: "goal-state-orphans",
        message: `${goal.id}: state.json contains deleted task(s): ${reconciliation.orphanedTaskIds.join(", ")}`,
        fix: "review the deleted tasks, then run a task transition to persist reconciliation",
      });
    }

    for (const id of actual) {
      if (!declared.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          code: "goal-task-not-in-taskids",
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
          code: "goal-taskid-without-file",
          message: `${goal.id}: taskIds lists ${id}, but no such task file exists`,
          fix: `remove it from \`taskIds:\` in ${path.relative(root, goalFile)}`,
          group: "goals:taskid-without-file",
        });
      }
    }

    // State entries for tasks that were deleted.
    for (const id of Object.keys(rawState.tasks)) {
      if (!actual.has(id)) {
        add({
          severity: "warn",
          area: "goals",
          code: "goal-state-without-file",
          message: `${goal.id}: state.json tracks ${id}, which has no task file`,
          fix: "harmless, but it will linger until state.json is edited or the task returns",
          group: "goals:state-without-file",
        });
      }
    }

    if (goal.archived) continue;
    const rolled = reconciliation.state;
    const statusOf = (id: string): string => (rolled.tasks[id] ?? newTaskState()).status;

    // ---- governed goals stuck before the verdict ----
    // Measured on atlas-sales-crm: 112 of 129 tasks in review, median 15 days, and
    // zero goal verdicts ever recorded. Nothing said the gate was waiting on anyone.
    const awaitingVerdict =
      rolled.goalStatus === "qa-review" || (rolled.goalStatus === "done" && rawState.qa?.verdict !== "pass");
    if (goal.completionPolicy.qaRequired && awaitingVerdict && !rawState.qa?.verdict) {
      const finished = Object.values(rolled.tasks)
        .map((t) => (t.finishedAt ? Date.parse(t.finishedAt) : Number.NaN))
        .filter(Number.isFinite);
      const since = finished.length > 0 ? Math.max(...finished) : Date.parse(rawState.updatedAt);
      if (Number.isFinite(since) && now - since > 7 * DAY) {
        const verdict = `\`awo goal verdict ${goal.id} --pass|--gap --summary "…" --who "<human>"\``;
        add({
          severity: "warn",
          area: "goals",
          code: "goal-qa-review-stale",
          message: `${goal.id} has waited ${formatAge(now - since)} in qa-review with no verdict`,
          fix: rawState.qa?.briefRunId
            ? `the QA brief is attached — review it, then ${verdict}`
            : `\`awo goal verify ${goal.id}\` to assemble the QA brief, then ${verdict}`,
          group: "goals:qa-review-stale",
        });
      }
    }

    // ---- governed goals with finished work and no criterion evidence ----
    const governed =
      goal.completionPolicy.qaRequired || goal.completionPolicy.acceptanceEvidenceRequired;
    const evidenceCount = Object.values(rawState.criteria ?? {}).reduce(
      (n, list) => n + (Array.isArray(list) ? list.length : 0),
      0
    );
    const finishedTasks = authored.filter((t) => ["in-review", "done"].includes(statusOf(t.id)));
    if (governed && evidenceCount === 0 && finishedTasks.length > 0) {
      add({
        severity: "warn",
        area: "goals",
        code: "goal-no-criterion-evidence",
        message: `${goal.id} is governed, ${finishedTasks.length} of its task(s) finished, and no acceptance criterion has any evidence`,
        fix:
          `\`awo goal trace ${goal.id}\` lists the criteria; attach each one: ` +
          `\`awo task evidence ${finishedTasks[0].id} --criterion <n> --kind test|manual --ref "<evidence>"\``,
        group: "goals:no-criterion-evidence",
      });
    }

    // ---- goals that never got past planning ----
    if (rolled.goalStatus === "planning" && authored.length === 0) {
      // gray-matter hands an unquoted ISO timestamp back as a Date.
      const created =
        fm.createdAt instanceof Date
          ? fm.createdAt.getTime()
          : typeof fm.createdAt === "string"
            ? Date.parse(fm.createdAt)
            : Number.NaN;
      const since = Number.isFinite(created) ? created : (await fs.stat(goalFile)).mtimeMs;
      if (now - since > 7 * DAY) {
        add({
          severity: "warn",
          area: "goals",
          code: "goal-planning-empty",
          message: `${goal.id} has been planning for ${formatAge(now - since)} with no tasks`,
          fix: `\`awo goal plan ${goal.id}\` to break it into tasks — or, if it was dropped, \`awo goal archive ${goal.id} --force\``,
          group: "goals:planning-empty",
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
    const state = await stateOf(goal);
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
        code: "worktree-stale",
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

  // ---- disk space on the workspace volume ----
  // `statfs` arrived in Node 18.15; an older runtime simply skips the check.
  const statfs = (fsp as { statfs?: (p: string) => Promise<{ bavail: number; blocks: number; bsize: number }> })
    .statfs;
  if (typeof statfs === "function") {
    const stats = await statfs(root).catch(() => null);
    const low = stats ? diskSpaceFinding(stats, worktrees.filter((w) => w.leaf !== ".baseline").length) : null;
    if (low) add(low);
  }

  // ---- stale locks ----
  // INTEGRATION SEAM (Lane D1-7): replace `[]` with `await findStaleLocks(root)` from
  // ../file-lock.js. The finding shape and advice already live in staleLockFindings.
  const staleLocks: StaleLockReport[] = (await findStaleLocks(root).catch(() => [])).map((found) => {
    const owner = (found.owner && typeof found.owner === "object" ? found.owner : {}) as Record<string, unknown>;
    return {
      path: found.lock,
      pid: typeof owner.pid === "number" ? owner.pid : null,
      host: typeof owner.hostname === "string" ? owner.hostname : typeof owner.host === "string" ? owner.host : null,
      acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : null,
    };
  });
  for (const finding of staleLockFindings(root, staleLocks)) add(finding);

  // ---- the workspace root as a git repo ----
  // VS Code's Source Control and Git Graph pick the top-level repo and stop looking,
  // so a `.git` at the root hides every linked repo under repos/. One with no commits
  // is worse: Git Graph shows an empty history, and `awo upgrade` reads every file as
  // an uncommitted change and refuses to run.
  if (await fs.pathExists(path.join(root, ".git"))) {
    // Not `--quiet`: simple-git only rejects a failing command that wrote to stderr.
    const hasCommits = await simpleGit(root)
      .raw(["rev-parse", "--verify", "HEAD"])
      .then(() => true)
      .catch(() => false);
    const multiRoot = `${manifest.projectKey}.code-workspace`;
    add(
      hasCommits
        ? {
            severity: "info",
            area: "workspace",
            code: "workspace-root-git-repo",
            message: "the workspace root is itself a git repo, so VS Code and Git Graph show it and hide the linked repos under repos/",
            fix: `open ${multiRoot} (one folder per linked repo) rather than the bare folder`,
          }
        : {
            severity: "warn",
            area: "workspace",
            code: "workspace-root-git-empty",
            message:
              "the workspace root is a git repo with no commits — Git Graph shows an empty history instead of the linked repos, and `awo upgrade` sees every file as uncommitted",
            fix: 'commit it so upgrades are reviewable (`git add -A && git commit -m "chore: workspace"`), or remove the accidental repo with `rm -rf .git`',
          }
    );
  }

  // ---- folders under goals/ that are not goals ----
  // Every goal reader skips a directory without goal.md, so whatever an agent filed
  // there (notes, exports, a half-made goal) is invisible to awo and to the next agent.
  for (const container of scope === "all" ? [path.join(root, "goals"), goalArchiveDir(root)] : [path.join(root, "goals")]) {
    for (const entry of await fs.readdir(container, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(container, entry.name);
      if (dir === goalArchiveDir(root) || (await fs.pathExists(path.join(dir, "goal.md")))) continue;
      const rel = path.relative(root, dir);
      add({
        severity: "warn",
        area: "goals",
        code: "goals-folder-not-goal",
        message: `${rel}/ has no goal.md, so no awo command reads anything in it`,
        fix: `move it out of goals/ (e.g. \`mv ${shellQuote(rel)} docs/\`), or restore the goal.md it is missing`,
        group: "goals:folder-not-goal",
      });
    }
  }

  // ---- zero-byte stray files at the workspace root ----
  // atlas-shop's root collected `2`, `5}{n:`, `7}{p95:` … — empty files left by shell
  // redirects an agent mistyped. Dotfiles are skipped: an empty one is usually a marker.
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if ((await fs.stat(path.join(root, entry.name)).catch(() => null))?.size !== 0) continue;
    add({
      severity: "info",
      area: "workspace",
      code: "stray-empty-file",
      message: `${entry.name} is an empty file at the workspace root — usually a stray shell redirect`,
      fix: `rm -- ${shellQuote(entry.name)}`,
      group: "workspace:stray-empty-file",
    });
  }

  // ---- approvals faster than anyone reads ----
  for (const finding of await fastApprovalFindings(root, scope)) add(finding);

  // ---- credentials recorded in logs (opt-in) ----
  if (options.secrets) {
    for (const finding of await secretFindings(root)) add(finding);
  }

  // ---- un-transformed requirements (§9 item 22) ----
  const loose = (await fs.readdir(path.join(root, "goals")).catch(() => []))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  for (const id of loose) {
    add({
      severity: "info",
      area: "workspace",
      code: "requirement-untransformed",
      message: `${id} is still an un-transformed requirement`,
      fix: `\`awo goal new --from ${id}\``,
    });
  }

  return findings;
}

/**
 * Requirements approved within a minute of being written, with no record of a
 * human delegating the approval. Informational: speed alone proves nothing, but
 * measured on atlas-sales-crm, 35 approvals landed in under 60 s and every one
 * was typed by an agent while the audit said "human".
 */
async function fastApprovalFindings(root: string, scope: "active" | "all"): Promise<Finding[]> {
  const files: string[] = [];
  for (const name of await fs.readdir(path.join(root, "requirements")).catch(() => [] as string[])) {
    if (name.endsWith(".md")) files.push(path.join(root, "requirements", name));
  }
  const goalContainers = scope === "all" ? [path.join(root, "goals"), goalArchiveDir(root)] : [path.join(root, "goals")];
  for (const container of goalContainers) {
    for (const entry of await fs.readdir(container, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const file = path.join(container, entry.name, "requirement.md");
      if (await fs.pathExists(file)) files.push(file);
    }
  }

  const out: Finding[] = [];
  for (const file of files) {
    let data: Record<string, unknown>;
    try {
      data = matter(await fs.readFile(file, "utf8")).data as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.status !== "approved") continue;
    // gray-matter hands unquoted ISO timestamps back as Date objects.
    const stamp = (v: unknown): number =>
      v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number.NaN;
    const created = stamp(data.createdAt);
    const decided = stamp(data.decidedAt);
    if (!Number.isFinite(created) || !Number.isFinite(decided)) continue;
    const elapsed = decided - created;
    if (elapsed < 0 || elapsed >= 60_000) continue;
    // Lane B2 records who an agent approved on behalf of; any of these counts.
    if (data.delegation || data.delegatedBy || data.approvalDelegation) continue;

    const id = typeof data.id === "string" ? data.id : path.basename(file, ".md");
    out.push({
      severity: "info",
      area: "requirements",
      code: "requirement-fast-approval",
      message: `${id} was approved ${Math.round(elapsed / 1000)}s after it was written, with no delegation on record`,
      fix:
        `confirm a person read the criteria in ${path.relative(root, file)}; ` +
        `an agent approving for someone records it: \`awo req approve ${id} --delegated-by "<human>"\``,
      group: "requirements:fast-approval",
    });
  }
  return out;
}

/**
 * Credential assignments in recorded logs: file and count only, never the value —
 * a diagnostic that reprints the secret is one more place it leaked to. Measured
 * on the real workspaces: `*_PASSWORD=` and `mysql -p…` sat verbatim in day logs.
 */
async function secretFindings(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = await fs.readFile(full, "utf8").catch(() => "");
      const hits = text.split("\n").filter((line) => line && redactSecrets(line) !== line).length;
      if (hits === 0) continue;
      const rel = path.relative(root, full);
      out.push({
        severity: "warn",
        area: "workspace",
        code: "logs-secret",
        message: `${rel} records ${hits} line(s) with a credential in them`,
        fix: `rotate those credentials — logs are append-only and may be published — then scrub the lines in ${rel} by hand`,
        group: "workspace:logs-secret",
      });
    }
  };
  await walk(path.join(root, "logs"));
  return out;
}

export function doctorExitCode(findings: Finding[]): number {
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}
