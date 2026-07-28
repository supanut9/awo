#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runConnect } from "./commands/connect.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import {
  runTaskComplete,
  runTaskEvent,
  runTaskList,
  runTaskRun,
  runTaskShow,
  runTaskStatus,
  runTaskVerify,
} from "./commands/task.js";
import { runLogAdd, runLogList, runLogShow, runLogTail } from "./commands/log.js";
import { runUi } from "./commands/ui.js";
import { runGoalNew, runReqNew, runTaskNew } from "./commands/plan.js";
import { runSync, syncHadProblems } from "./commands/sync.js";
import { doctorExitCode, runDoctor } from "./commands/doctor.js";
import { planHasWork, runUpgrade } from "./commands/upgrade.js";
import { runCatalogAdd, runCatalogList, type CatalogKind } from "./commands/catalog.js";

// dist/cli.js -> package root is one level up.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")
) as { version: string };

// Every command resolves paths from the current directory (§3 decision 7).
// If that directory has been deleted out from under the shell — which happens
// when a workspace is removed and recreated while a terminal sits in it —
// process.cwd() throws a bare `ENOENT: uv_cwd` before any command runs. Turn
// that into something actionable.
try {
  process.cwd();
} catch {
  console.error(
    "awo: your shell's current directory no longer exists (it was deleted or replaced).\n" +
      "Re-enter it with an absolute path, or open a new terminal:\n" +
      "  cd \"$PWD\""
  );
  process.exit(1);
}

const program = new Command();

program
  .name("awo")
  .description("Scaffolds and orchestrates AI-agent development workspaces.")
  .version(version, "-v, --version", "print the installed awo version");

program
  .command("init")
  .description("Scaffold a new awo workspace in the current directory.")
  .requiredOption("--key <key>", "short, permanent project code (2-5 uppercase letters, e.g. PROM)")
  .action(async (opts: { key: string }) => {
    try {
      await runInit({ key: opts.key });
      console.log(`awo workspace initialized with project key ${opts.key}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("add <url>")
  .description(
    "Clone a git repo and register it (type: git). Already have this repo checked out locally? Use `awo connect <path>` instead — don't clone a second copy."
  )
  .option("--ref <ref>", "branch/tag to clone")
  .option("--name <name>", "override the derived repo name")
  .action(async (url: string, opts: { ref?: string; name?: string }) => {
    try {
      await runAdd({ url, ref: opts.ref, name: opts.name });
      console.log(`Cloned and registered ${opts.name ?? url}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("connect <path>")
  .description("Symlink an existing local repo into the workspace and register it (type: local).")
  .option("--name <name>", "override the derived repo name")
  .action(async (repoPath: string, opts: { name?: string }) => {
    try {
      await runConnect({ path: repoPath, name: opts.name });
      console.log(`Connected ${opts.name ?? repoPath}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("Show linked repos and their status (present / missing / dirty).")
  .action(async () => {
    try {
      const results = await runList();
      if (results.length === 0) {
        console.log("No repos linked yet. Use `awo add <url>` or `awo connect <path>`.");
        return;
      }
      for (const r of results) {
        console.log(`${r.name}\t${r.type}\t${r.status}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("sync")
  .description(
    "Reconcile repos/ with the manifest: clone missing git repos, fast-forward clean ones, relink local ones."
  )
  .action(async () => {
    try {
      const results = await runSync();
      if (results.length === 0) {
        console.log("Nothing to sync — no repos linked.");
        return;
      }
      for (const r of results) {
        console.log(`${r.name}\t${r.action}${r.detail ? `\t${r.detail}` : ""}`);
      }
      if (syncHadProblems(results)) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("upgrade")
  .description(
    "Bring this workspace up to the INSTALLED awo version (not npm's latest): run migrations and reconcile scaffolding (§11). Use `npx @supanut9/awo@latest upgrade` to target the newest release."
  )
  .option("--dry-run", "show what would change without touching anything")
  .option("--to <version>", "assert the intended target version (must match the installed awo)")
  .option("--force", "proceed even with uncommitted changes in the workspace")
  .action(async (opts: { dryRun?: boolean; to?: string; force?: boolean }) => {
    try {
      const r = await runUpgrade(opts);

      if (r.from === r.to && !planHasWork(r)) {
        console.log(`Already at ${r.to}; nothing to do.`);
        // The target is the awo you are running, not whatever npm calls latest
        // — migrations ship inside the package, so a newer version has to be
        // executed, not fetched. Say so, or this reads as "you are up to date".
        console.log(
          `This targets the installed awo (${r.to}). For a newer release:\n` +
            `  npx @supanut9/awo@latest upgrade`
        );
        return;
      }

      console.log(`${r.from} -> ${r.to}${opts.dryRun ? "  (dry run)" : ""}`);
      if (r.unreviewable) {
        console.log(
          "This workspace is not a git repo, so there is no diff to review and nothing to revert to.\n" +
            "Replaced files are copied to .workspace/upgrade-backups/ — that is the only way back."
        );
      }
      if (!r.hadLock) {
        console.log(
          "No template.lock: this workspace predates it, so nothing will be overwritten — every changed file is written alongside as .new (§11.2)."
        );
      }

      for (const m of r.migrations) console.log(`  migration ${m.version}: ${m.description}`);

      const counts = new Map<string, number>();
      for (const f of r.files) counts.set(f.action, (counts.get(f.action) ?? 0) + 1);
      for (const [action, n] of [...counts].sort()) {
        if (action === "unchanged") continue;
        console.log(`  ${action}: ${n}`);
      }
      for (const f of r.files.filter((f) => f.action === "conflict")) {
        console.log(`    ! ${f.path} — customized, new version written alongside`);
      }

      if (opts.dryRun) {
        console.log(`\nRun \`awo upgrade\` to apply.`);
        return;
      }
      if (r.backupDir) console.log(`\nReplaced files backed up to ${r.backupDir}`);
      if (r.conflictFiles.length > 0) {
        console.log(`Review and merge: ${r.conflictFiles.join(", ")}`);
      }
      console.log(`Workspace is now at ${r.to}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Diagnose the workspace: version skew, broken links, bad targets, abandoned runs.")
  .action(async () => {
    try {
      const findings = await runDoctor();
      if (findings.length === 0) {
        console.log("No problems found.");
        return;
      }
      const icon = { error: "✗", warn: "!", info: "·" } as const;
      for (const f of findings) {
        console.log(`${icon[f.severity]} [${f.area}] ${f.message}`);
        if (f.fix) console.log(`    fix: ${f.fix}`);
      }
      const errors = findings.filter((f) => f.severity === "error").length;
      const warns = findings.filter((f) => f.severity === "warn").length;
      console.log(`\n${errors} error(s), ${warns} warning(s), ${findings.length - errors - warns} note(s).`);
      process.exitCode = doctorExitCode(findings);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("remove <name>")
  .description("Unlink a repo (removes it from the manifest and from repos/).")
  .action(async (name: string) => {
    try {
      await runRemove({ name });
      console.log(`Removed ${name}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const req = program.command("req").description("Requirement intake (§7.2).");

req
  .command("new")
  .description("Create the next requirement skeleton (allocates <KEY>-R#).")
  .requiredOption("--title <title>", "what is being asked for")
  .option("--source <source>", "where the ask came from (stakeholder, ticket, …)")
  .action(async (opts: { title: string; source?: string }) => {
    try {
      const r = await runReqNew(opts);
      console.log(`${r.id} created at ${r.file}`);
      console.log(`Refine it, then: awo goal new --from ${r.id}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const goal = program.command("goal").description("Goals: the objective distilled from a requirement (§7.2).");

goal
  .command("new")
  .description("Turn a requirement into a goal folder, moving it in as requirement.md.")
  .requiredOption("--from <reqId>", "requirement to transform (e.g. PROM-R1)")
  .option("--title <title>", "goal title (defaults to the requirement's)")
  .action(async (opts: { from: string; title?: string }) => {
    try {
      const g = await runGoalNew(opts);
      console.log(`${g.id} created at ${g.dir}/ (from ${g.requirementId})`);
      console.log(`Then add tasks: awo task new --goal ${g.id} --name "…" --targets <repo>`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("list")
  .description("List goals with rolled-up task status.")
  .action(async () => {
    try {
      const rows = await runTaskList();
      const byGoal = new Map<string, { total: number; done: number; blocked: number }>();
      for (const r of rows) {
        const g = byGoal.get(r.goalId) ?? { total: 0, done: 0, blocked: 0 };
        g.total += 1;
        if (r.status === "done") g.done += 1;
        if (r.status === "blocked") g.blocked += 1;
        byGoal.set(r.goalId, g);
      }
      if (byGoal.size === 0) {
        console.log("No goals yet. Start with `awo req new --title \"…\"`.");
        return;
      }
      for (const [id, g] of byGoal) {
        console.log(`${id}\t${g.done}/${g.total} done${g.blocked ? `, ${g.blocked} blocked` : ""}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const task = program.command("task").description("Inspect and run tasks (§7.2/§7.4).");

task
  .command("new")
  .description("Create the next task skeleton under a goal (allocates <KEY>-T# and wires taskIds).")
  .requiredOption("--goal <goalId>", "goal this task belongs to")
  .requiredOption("--name <name>", "what the task does")
  .option("--targets <repos>", "comma-separated repo names from the manifest", (v) => v.split(","))
  .option("--depends-on <taskIds>", "comma-separated task ids that must finish first", (v) => v.split(","))
  .option("--agent <agent>", "agent that should run it")
  .action(async (opts: { goal: string; name: string; targets?: string[]; dependsOn?: string[]; agent?: string }) => {
    try {
      const t = await runTaskNew(opts);
      console.log(`${t.id} created at ${t.file}`);
      console.log(`Run it with: awo task run ${t.id}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("list")
  .description("List tasks with their lifecycle status.")
  .option("--status <status>", "only tasks in this lifecycle state (e.g. blocked)")
  .action(async (opts: { status?: string }) => {
    try {
      const rows = await runTaskList({ status: opts.status });
      if (rows.length === 0) {
        console.log(
          opts.status
            ? `No tasks with status "${opts.status}".`
            : "No tasks yet. Author one under goals/<goal>/tasks/."
        );
        return;
      }
      for (const r of rows) {
        const outcome = r.lastRunOutcome ? ` (last run: ${r.lastRunOutcome})` : "";
        console.log(`${r.id}\t${r.status}${outcome}\t${r.name}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("show <taskId>")
  .description("Print a task definition plus its current state and last run.")
  .action(async (taskId: string) => {
    try {
      const r = await runTaskShow(taskId);
      console.log(`${r.task.id} — ${r.task.name}`);
      console.log(`status:   ${r.status}${r.blockedReason ? ` (${r.blockedReason})` : ""}`);
      console.log(`goal:     ${r.task.goalId} (${r.goalStatus})`);
      console.log(`targets:  ${r.task.targets.join(", ") || "none"}`);
      console.log(`agent:    ${r.task.agent ?? "unassigned"}`);
      console.log(`attempts: ${r.attempts}`);
      console.log(`last run: ${r.lastRunId ?? "none"}${r.lastRunOutcome ? ` — ${r.lastRunOutcome}` : ""}`);
      if (r.task.body) console.log(`\n${r.task.body}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("status <taskId> <status>")
  .description("Move a task's lifecycle state by hand. The only way to reach `cancelled`.")
  .option("--reason <reason>", "why (recorded when moving to blocked)")
  .action(async (taskId: string, status: string, opts: { reason?: string }) => {
    try {
      const to = await runTaskStatus(taskId, status, { reason: opts.reason });
      console.log(`${taskId} -> ${to}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("run <taskId>")
  .description(
    "Open a run for a task: resolves dependsOn, validates targets, creates the isolated worktrees, moves state to running, starts the event stream. The agent then does the work and closes it with `task complete`."
  )
  .option("--no-worktree", "skip worktree creation (work in the shared checkout)")
  .action(async (taskId: string, opts: { worktree?: boolean }) => {
    try {
      const r = await runTaskRun(taskId, { noWorktree: opts.worktree === false });
      console.log(`${r.taskId} is running — run ${r.runId}`);
      console.log(`agent:   ${r.agent ?? "unassigned"} — ${r.model.tier} tier (from ${r.model.tierSource})`);
      console.log(`model:   ${r.model.runtime}:${r.model.model}${r.model.effort ? ` effort=${r.model.effort}` : ""}${r.model.mode ? ` (${r.model.mode} mode)` : ""}`);
      console.log(`targets: ${r.targets.join(", ") || "none"}`);
      console.log(`events:  ${r.eventsFile}`);
      for (const wt of r.worktrees) {
        if (wt.error) {
          console.log(`WARNING: no isolation for ${wt.repo} — ${wt.error}`);
          continue;
        }
        console.log(
          `work in: ${wt.path}  (${wt.repo} on ${wt.branch}${wt.reused ? ", reused" : ""})`
        );
      }
      if (r.worktrees.length === 0) console.log(`work in: shared checkout — NO worktree isolation`);
      console.log(`hand to: ${r.invocation}`);
      if (r.fallbackInvocation) console.log(`if quota: ${r.fallbackInvocation}`);
      if (r.body) console.log(`\n${r.body}`);
      console.log(
        `\nRecord progress with \`awo task event ${r.taskId} <kind> --label "…"\`, then close with \`awo task complete ${r.taskId} --outcome success\`.`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("event <taskId> <kind>")
  .description(
    "Append a progress event to the task's open run. Kinds: step.start, step.end, repo.diff, test, commit, note."
  )
  .option("--label <label>", "human label for the step")
  .option("--message <message>", "free-text message (note events)")
  .option("--data <json>", "extra JSON fields, e.g. '{\"repo\":\"api\",\"files\":3}'")
  .action(async (taskId: string, kind: string, opts: { label?: string; message?: string; data?: string }) => {
    try {
      await runTaskEvent(taskId, kind, opts);
      console.log(`recorded ${kind} for ${taskId}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("complete <taskId>")
  .description("Close the task's open run: writes the log, index line, and lifecycle transition.")
  .requiredOption("--outcome <outcome>", "success | failed | skipped")
  .option("--summary <text>", "what was done (goes in the run log)")
  .option("--prompt <text>", "verbatim user request")
  .option("--interpreted <text>", "the agent's own reading of the request")
  .option("--note <text...>", "deferred items, risks, follow-ups")
  .option("--gate", "route a success to in-review for the QA gate instead of done")
  .action(async (taskId: string, opts: Record<string, never>) => {
    try {
      const r = await runTaskComplete(taskId, opts as unknown as { outcome: string });
      console.log(`${r.taskId} run ${r.runId} -> ${r.outcome}; task is now ${r.status}.`);
      console.log(`log: ${r.detail}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("verify <taskId>")
  .description("QA gate: approve an in-review task (-> done) or reject it (-> todo).")
  .option("--reject", "send it back to todo instead of approving")
  .option("--reason <reason>", "why it was rejected")
  .action(async (taskId: string, opts: { reject?: boolean; reason?: string }) => {
    try {
      const to = await runTaskVerify(taskId, { approve: !opts.reject, reason: opts.reason });
      console.log(`${taskId} -> ${to}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const log = program.command("log").description("Run history and audit trail (§7.3).");

log
  .command("list")
  .description("List runs from the index, most recent first.")
  .option("--task <taskId>", "only runs for this task")
  .option("--agent <agent>", "only runs by this agent")
  .option("--repo <repo>", "only runs that touched this repo")
  .option("--status <status>", "only runs with this outcome")
  .action(async (opts: { task?: string; agent?: string; repo?: string; status?: string }) => {
    try {
      const runs = await runLogList(opts);
      if (runs.length === 0) {
        console.log("No runs match.");
        return;
      }
      for (const r of runs) {
        const dur = r.durationSec === null ? "—" : `${r.durationSec}s`;
        console.log(`${r.runId}\t${r.status}\t${dur}\t${r.reposChanged.join(",") || "no repos"}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

log
  .command("add")
  .description(
    "Record work that isn't a task run — intake, planning, an audit pass (§7.3 allows taskId: null)."
  )
  .requiredOption("--agent <agent>", "who did the work (agent name or model)")
  .requiredOption("--summary <text>", "what was done")
  .option("--label <label>", "short slug for the runId (default: adhoc)")
  .option("--prompt <text>", "the request, verbatim")
  .option("--interpreted <text>", "how it was understood")
  .option("--note <text...>", "follow-ups, risks, open questions")
  .option("--repo <name...>", "repos touched, if any")
  .option("--model <model...>", "model(s) used")
  .option("--outcome <outcome>", "success | failed | skipped (default: success)")
  .option("--started <iso>", "when it began, if not now")
  .option("--duration <sec>", "seconds it took", (v) => parseInt(v, 10))
  .action(async (opts: Record<string, unknown>) => {
    try {
      const r = await runLogAdd({
        ...(opts as { agent: string; summary: string }),
        startedAt: opts.started as string | undefined,
        durationSec: opts.duration as number | undefined,
      });
      console.log(`recorded ${r.runId}`);
      console.log(`log: ${r.detail}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

log
  .command("show <runId>")
  .description("Print the detailed record for one run.")
  .action(async (runId: string) => {
    try {
      const { detail } = await runLogShow(runId);
      console.log(detail);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

log
  .command("tail")
  .description("Print the event stream of the most recent run.")
  .option("--run <runId>", "a specific run instead of the latest")
  .action(async (opts: { run?: string }) => {
    try {
      const { runId, events } = await runLogTail({ runId: opts.run });
      console.log(`# ${runId}`);
      for (const e of events) {
        const rest = Object.entries(e)
          .filter(([k]) => k !== "t" && k !== "kind")
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" ");
        console.log(`${e.t}  ${e.kind}${rest ? `  ${rest}` : ""}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("ui")
  .description("Serve a local dashboard for this workspace on 127.0.0.1 (board, runs, repos).")
  .option("--port <port>", "port to bind (default: an OS-assigned free port)", (v) => parseInt(v, 10))
  .action(async (opts: { port?: number }) => {
    try {
      const handle = await runUi({ port: opts.port });
      console.log(`awo ui running at ${handle.url}`);
      console.log("Press Ctrl+C to stop.");
      const stop = async (): Promise<void> => {
        await handle.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

for (const kind of ["agent", "skill"] as CatalogKind[]) {
  const group = program
    .command(kind)
    .description(`Install ${kind}s from the workspace catalog (§7.1).`);

  group
    .command("list")
    .description(`Show installed and available ${kind}s.`)
    .action(async () => {
      try {
        const { installed, available } = await runCatalogList(kind);
        console.log(`installed: ${installed.join(", ") || "none"}`);
        console.log(`available: ${available.join(", ") || "none left in the catalog"}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  group
    .command(`add <name>`)
    .description(`Install a ${kind} from catalog/${kind}s into ${kind}s/.`)
    .action(async (name: string) => {
      try {
        const r = await runCatalogAdd(kind, name);
        console.log(`installed ${kind} ${r.name} at ${r.file}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
}

program.parseAsync(process.argv);
