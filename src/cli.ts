#!/usr/bin/env node
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
import { runLogList, runLogShow, runLogTail } from "./commands/log.js";
import { runUi } from "./commands/ui.js";

const program = new Command();

program
  .name("awo")
  .description("Scaffolds and orchestrates AI-agent development workspaces.");

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

const task = program.command("task").description("Inspect and run tasks (§7.2/§7.4).");

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
    "Open a run for a task: resolves dependsOn, validates targets, moves state to running, starts the event stream. The agent then does the work and closes it with `task complete`."
  )
  .action(async (taskId: string) => {
    try {
      const r = await runTaskRun(taskId);
      console.log(`${r.taskId} is running — run ${r.runId}`);
      console.log(`agent:   ${r.agent ?? "unassigned"}`);
      console.log(`targets: ${r.targets.join(", ") || "none"}`);
      console.log(`events:  ${r.eventsFile}`);
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

program.parseAsync(process.argv);
