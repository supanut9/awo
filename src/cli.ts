#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { findWorkspaceRoot } from "./workspace.js";
import {
  findCriteria,
  isArchivedStatus,
  listRequirements,
  runReqDecide,
  runReqPropose,
  runReqRefine,
  runReqResume,
  runReqShelve,
} from "./commands/intake.js";
import { runAuto } from "./commands/autorun.js";
import { listConflicts, runResolve } from "./commands/resolve.js";
import { runRuleNew } from "./commands/catalog.js";
import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runConnect } from "./commands/connect.js";
import { runList, runSetTestCommand } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import {
  runTaskComplete,
  runTaskRecheck,
  runTaskEvent,
  runTaskList,
  runTaskRun,
  runTaskShow,
  runTaskStatus,
  runTaskVerify,
} from "./commands/task.js";
import { runLogAdd, runLogList, runLogShow, runLogTail } from "./commands/log.js";
import { runUi } from "./commands/ui.js";
import { runGoalNew, runGoalPlan, runReqNew, runTaskNew } from "./commands/plan.js";
import { runGoalTrace, runTaskEvidence } from "./commands/traceability.js";
import {
  runPrFinalize,
  runPrLink,
  runPrMeta,
  runPrPreflight,
  runPrReconcile,
  runPrStatus,
} from "./commands/pr.js";
import { runSync, syncHadProblems } from "./commands/sync.js";
import { doctorExitCode, groupFindings, runDoctor } from "./commands/doctor.js";
import { listWorktrees, pruneWorktrees, unsafeReason } from "./worktrees.js";
import { readManifest } from "./manifest.js";
import { findAllTasks } from "./tasks.js";
import { newTaskState, readState } from "./state.js";
import { planHasWork, runUpgrade } from "./commands/upgrade.js";
import { runCatalogAdd, runCatalogList, type CatalogKind } from "./commands/catalog.js";
import { formatContext, runContext } from "./commands/context.js";
import { runGoalVerdict, runGoalVerify } from "./commands/verify.js";
import { credentialPath, runPublish, runPublishWatch } from "./commands/publish.js";
import { runDispatch } from "./commands/dispatch.js";
import { formatAgentOrg, runAgentOrg } from "./commands/agent-org.js";

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
  .option(
    "--adopt",
    "add awo to a directory that already has a project: keeps every existing file, discovers repos"
  )
  .action(async (opts: { key: string; adopt?: boolean }) => {
    try {
      const r = await runInit({ key: opts.key, adopt: opts.adopt });
      console.log(`awo workspace initialized with project key ${opts.key}.`);

      if (r.adoptedRepos.length > 0) {
        console.log(`\nAdopted ${r.adoptedRepos.length} repo(s) into repos/:`);
        for (const repo of r.adoptedRepos) console.log(`  ${repo.name} -> ${repo.path}`);
        console.log(`Declare how each one verifies itself:  awo test-command <repo> "<cmd>"`);
      }

      if (r.kept.length > 0) {
        // Named individually rather than counted: the whole promise of --adopt is
        // that nothing of yours was touched, and a number does not demonstrate that.
        console.log(`\nKept your existing ${r.kept.length} file(s), wrote nothing over them:`);
        for (const f of r.kept) console.log(`  ${f}`);
        if (r.kept.includes("CLAUDE.md")) {
          console.log(
            `\nYour CLAUDE.md was kept as-is, so it does not yet point at AGENTS.md.\n` +
              `Add this line near the top so every runtime reads the same instructions:\n` +
              `  > Process and workflow: see AGENTS.md in this directory. It is canonical.`
          );
        }
      }
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
  .command("publish")
  .description(
    "Push a projection of this workspace to MongoDB for a hosted dashboard (§7.6). Off unless .workspace/credentials/mongo.env exists."
  )
  .option("--dry-run", "show what would be sent, without connecting")
  .option("--watch", "keep syncing as the workspace changes (auto-sync)")
  .action(async (opts: { dryRun?: boolean; watch?: boolean }) => {
    try {
      if (opts.watch) {
        const first = await runPublish({});
        console.log(
          `synced ${first.detail} · ${first.counts.requirements} requirements · ${first.counts.goals} goals · ${first.counts.tasks} tasks · ${first.counts.runs} runs · ${first.counts.agents} agents` +
            `${first.uriHost ? ` -> ${first.uriHost}/${first.database}` : ""}`
        );
        console.log("watching for changes — Ctrl+C to stop.");
        const handle = await runPublishWatch({
          onPublish: (r) => {
            const at = new Date().toLocaleTimeString();
            if (r instanceof Error) console.error(`${at}  sync failed: ${r.message}`);
            else console.log(`${at}  synced ${r.counts.requirements} requirements · ${r.counts.tasks} tasks · ${r.counts.runs} runs · ${r.counts.agents} agents`);
          },
        });
        const stop = async (): Promise<void> => {
          await handle.stop();
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return;
      }
      const r = await runPublish(opts);
      console.log(
        `${r.dryRun ? "would publish" : "published"} workspace ${r.workspaceId}` +
          `${r.uriHost ? ` -> ${r.uriHost}/${r.database}` : ""}`
      );
      console.log(
        `  ${r.detail} · requirements ${r.counts.requirements} · goals ${r.counts.goals} · tasks ${r.counts.tasks} · runs ${r.counts.runs} · agents ${r.counts.agents}` +
          `${r.counts.events > 0 ? ` · events ${r.counts.events}` : ""}`
      );
      // Say what the redaction settings actually withheld. A privacy control whose
      // effect is invisible is a privacy control nobody can tell is broken — and
      // `redact.filePaths` was exactly that until 0.1.9.
      if (r.detail === "full") {
        const { workerLogs, outputTails, prompts } = r.redacted;
        const withheld = [
          workerLogs > 0 ? `${workerLogs} worker log(s)` : null,
          outputTails > 0 ? `${outputTails} captured command output(s)` : null,
          prompts > 0 ? `${prompts} prompt(s)` : null,
        ].filter((part): part is string => part !== null);
        console.log(
          withheld.length > 0
            ? `  withheld by redact settings: ${withheld.join(", ")}`
            : `  redact settings withheld nothing — every prompt, path and captured output is being sent`
        );
      }
      if (r.detail === "summary") {
        console.log(
          `  bodies, run logs and event streams stay local. For the hosted dashboard to show them,\n` +
            `  set "publish": { "detail": "full" } in .workspace/manifest.json — that sends prose\n` +
            `  describing your code and prompts, which is why it is not the default.`
        );
      }
      if (r.dryRun && !r.uriHost) {
        console.log(`  no credentials yet — add MONGO_URI to .workspace/credentials/mongo.env`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("context")
  .description(
    "Print a compact orientation digest — where the project stands and what to do next. Run this first in a new session instead of scanning the tree (§13)."
  )
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    try {
      const c = await runContext();
      console.log(opts.json ? JSON.stringify(c, null, 2) : formatContext(c));
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
      // "conflict" is the PLAN's word for "you edited this"; whether it actually
      // conflicted is only known after the merge is attempted.
      for (const f of r.files.filter((f) => f.action === "conflict")) {
        const merged = !opts.dryRun && r.mergedFiles.includes(f.path);
        const asked = r.conflictFiles.includes(`${f.path}.new`);
        console.log(
          merged
            ? `    ~ ${f.path} — you edited it; template changes merged in cleanly`
            : asked
              ? `    ! ${f.path} — you edited the same lines the template changed`
              : `    ! ${f.path} — customized`
        );
      }

      if (opts.dryRun) {
        console.log(`\nRun \`awo upgrade\` to apply.`);
        return;
      }
      if (r.backupDir) console.log(`\nReplaced files backed up to ${r.backupDir}`);
      if (r.conflictFiles.length > 0) {
        console.log(`${r.conflictFiles.length} conflict(s) need you: awo resolve`);
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
  .option("--all", "list every instance instead of collapsing repeated findings")
  .action(async (opts: { all?: boolean }) => {
    try {
      const findings = await runDoctor();
      if (findings.length === 0) {
        console.log("No problems found.");
        return;
      }
      const icon = { error: "✗", warn: "!", info: "·" } as const;

      // One systemic problem prints as one finding with a count. Unabridged, this
      // page was 166 lines for the SHOP workspace, 74 of them the same sentence
      // with a different task id — which reads as 74 problems when it is one.
      const SAMPLES = 3;
      for (const group of groupFindings(findings)) {
        const shown = opts.all ? group.findings : group.findings.slice(0, SAMPLES);
        for (const f of shown) {
          console.log(`${icon[f.severity]} [${f.area}] ${f.message}`);
          if (f.fix) console.log(`    fix: ${f.fix}`);
        }
        const hidden = group.findings.length - shown.length;
        if (hidden > 0) {
          console.log(
            `${icon[group.severity]} [${group.findings[0].area}] …and ${hidden} more like this (${group.findings.length} in total)`
          );
          console.log(`    fix: same cause for all of them — \`awo doctor --all\` lists each one`);
        }
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

// ---- worktree ----
// `awo` created worktrees from the day `task run` existed and never removed one:
// the only mention of `git worktree remove` in the library was a line of prose in a
// skill file asking an agent to do it by hand. Two weeks of real use left 2.0 GB of
// checkouts for finished tasks. Removal has to be a command, not an instruction.
/**
 * Tasks in a terminal state, so pruning defaults to work that is provably over.
 * Read from state rather than from the authored `status:`, which is only a
 * starting point (§7.2).
 */
async function finishedTaskIds(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const { task, goal } of await findAllTasks(root)) {
    const state = await readState(goal.dir, goal.id);
    const status = (state.tasks[task.id] ?? newTaskState(task.authoredStatus)).status;
    if (status === "done" || status === "cancelled") out.add(task.id);
  }
  return out;
}

const worktree = program
  .command("worktree")
  .description("Inspect and remove the task worktrees under repos/.worktrees/.");

worktree
  .command("list")
  .description("Every checkout under repos/.worktrees/, with what it would cost to remove.")
  .action(async () => {
    try {
      const root = findWorkspaceRoot(process.cwd());
      const found = await listWorktrees(root, await readManifest(root), { withSizes: true });
      if (found.length === 0) {
        console.log("No task worktrees.");
        return;
      }
      for (const w of found) {
        const mb = Math.round(w.bytes / 1024 ** 2);
        const reason = unsafeReason(w);
        console.log(
          `${w.path}\t${w.branch ?? "—"}\t${mb}MB\t${reason ? `KEEP — ${reason}` : "safe to remove"}`
        );
      }
      const total = Math.round(found.reduce((a, w) => a + w.bytes, 0) / 1024 ** 2);
      console.log(`\n${found.length} worktree(s), ${total}MB.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

worktree
  .command("prune")
  .description(
    "Remove worktrees for finished tasks. Keeps any that is dirty or holds commits no other branch has."
  )
  .option("--task <taskId...>", "prune only these tasks' worktrees")
  .option("--all", "consider every worktree, not only those of finished tasks")
  .option("--force", "remove even a dirty or unmerged worktree — this discards work")
  .option("--dry-run", "show what would be removed without touching anything")
  .action(async (opts: { task?: string[]; all?: boolean; force?: boolean; dryRun?: boolean }) => {
    try {
      const root = findWorkspaceRoot(process.cwd());
      const manifest = await readManifest(root);
      const finished = await finishedTaskIds(root);

      const select = (w: { leaf: string }): boolean => {
        if (opts.task) return opts.task.includes(w.leaf);
        if (opts.all) return true;
        // Default: only what is provably finished, plus baseline scratch trees,
        // which hold no authored work by construction.
        return w.leaf === ".baseline" || finished.has(w.leaf);
      };

      if (opts.dryRun) {
        const candidates = (await listWorktrees(root, manifest, { withSizes: true })).filter(select);
        if (candidates.length === 0) {
          console.log("Nothing to prune.");
          return;
        }
        for (const w of candidates) {
          const reason = opts.force ? null : unsafeReason(w);
          console.log(`${reason ? "keep  " : "remove"} ${w.path}${reason ? `  (${reason})` : ""}`);
        }
        console.log("\n(dry run — nothing was touched)");
        return;
      }

      const results = await pruneWorktrees(root, manifest, { select, force: opts.force });
      if (results.length === 0) {
        console.log("Nothing to prune.");
        return;
      }
      let freed = 0;
      for (const r of results) {
        if (r.removed) {
          freed += r.worktree.bytes;
          console.log(`removed ${r.worktree.path}`);
        } else {
          console.log(`kept    ${r.worktree.path}  (${r.keptBecause})`);
        }
      }
      const removed = results.filter((r) => r.removed).length;
      const kept = results.length - removed;
      console.log(
        `\n${removed} removed, ${Math.round(freed / 1024 ** 2)}MB freed` +
          (kept > 0
            ? `; ${kept} kept because they still hold work — inspect them, then \`--force\` if you truly want them gone.`
            : ".")
      );
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
  .option("--body-file <path>", "import an existing ticket's text instead of retyping it")
  .option("--proposed", "a human PM already wrote the criteria — skip refinement, not approval")
  .action(async (opts: { title: string; source?: string; bodyFile?: string; proposed?: boolean }) => {
    try {
      const r = await runReqNew(opts);
      console.log(`${r.id} created at ${r.file}`);
      console.log(
        opts.proposed
          ? `Read the criteria, then: awo req approve ${r.id}`
          : `Next: awo req refine ${r.id}   (the PM role writes acceptance criteria)`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

req
  .command("list")
  .description("Requirements in intake. Shelved ones are in requirements/archive/ — pass --all.")
  .option("--all", "include suspended, cancelled and rejected requirements")
  .option("--archived", "show only the shelved ones")
  .action(async (opts: { all?: boolean; archived?: boolean }) => {
    try {
      const root = findWorkspaceRoot(process.cwd());
      const every = await listRequirements(root, { includeArchived: true });
      const rows = opts.archived
        ? every.filter((r) => r.archived)
        : opts.all
          ? every
          : every.filter((r) => !r.archived);

      if (rows.length === 0) {
        console.log(
          opts.archived
            ? "Nothing shelved."
            : every.length > 0
              ? `Nothing in intake. ${every.length} shelved — \`awo req list --archived\`.`
              : 'No requirements yet. Capture one with `awo req new --title "…"`.'
        );
        return;
      }
      for (const r of rows) {
        const criteria = findCriteria(r.body).length;
        console.log(
          `${r.id}\t${r.status}\t${criteria} criteria\t${r.goalId ? `-> ${r.goalId}` : "unplanned"}\t${r.title}`
        );
      }
      // Say what is being left out, so a short list never reads as the whole story.
      const hidden = every.filter((r) => r.archived).length;
      if (!opts.all && !opts.archived && hidden > 0) {
        console.log(`\n${hidden} shelved in requirements/archive/ — \`awo req list --archived\`.`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

req
  .command("refine <reqId>")
  .description("Hand the requirement to the product-manager role to write acceptance criteria.")
  .option("--plan", "propose the criteria for your approval before editing the requirement")
  .action(async (reqId: string, opts: { plan?: boolean }) => {
    try {
      const r = await runReqRefine(reqId, opts);
      console.log(`brief:   ${r.briefRunId}`);
      console.log(`model:   ${r.model}  (high tier — specification is judgment work)`);
      console.log("");
      console.log(r.invocation);
      console.log("");
      if (r.planMode && r.approvesInSession) {
        console.log(
          `Plan mode: it proposes the criteria and waits. Approve, and the same session\n` +
            `writes them into ${r.id}. Nothing is edited before that.`
        );
        console.log("");
      }
      if (r.planMode && r.executeInvocation) {
        console.log(
          `Plan mode: that runtime cannot write after you approve — its sandbox lasts the\n` +
            `whole process. Read the proposal, then apply it with:\n  ${r.executeInvocation}`
        );
        console.log("");
      }
      console.log(`Then it runs: awo req propose ${r.id}`);
      if (r.planMode) {
        console.log(
          `Approving a plan is a session permission. The human decision is still\n` +
            `  awo req approve ${r.id}`
        );
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

req
  .command("propose <reqId>")
  .description("Mark a refined requirement ready for human approval (agents run this).")
  .action(async (reqId: string) => {
    try {
      const r = await runReqPropose(reqId);
      console.log(`${r.id} proposed with ${r.criteria.length} acceptance criteria:`);
      for (const c of r.criteria) console.log(`  - ${c}`);
      if (r.restored) console.log(`\nbrought back into intake at ${r.file}`);
      console.log(`\nWaiting on a human: awo req approve ${r.id}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

for (const [name, flag] of [
  ["approve", "approve"],
  ["reject", "reject"],
] as const) {
  req
    .command(`${name} <reqId>`)
    .description(
      flag === "approve"
        ? "Accept the terms of the work. Planning cannot start without this."
        : "Send it back, with the reason recorded."
    )
    .option("--why <text>", "reason (required to reject)")
    .option("--who <name>", "who decided (default: human)")
    .action(async (reqId: string, opts: { why?: string; who?: string }) => {
      try {
        const r = await runReqDecide(reqId, { ...opts, [flag]: true });
        console.log(`${r.id} ${r.status} — ${r.title}`);
        if (r.status === "approved") {
          console.log(`${r.criteria.length} criteria accepted. Next: awo goal new --from ${r.id}`);
        }
        if (r.moved && isArchivedStatus(r.status)) {
          console.log(`moved out of intake to ${r.file}`);
          console.log(`Revise it there, then \`awo req propose ${r.id}\` brings it back.`);
        }
        console.log(`recorded as ${r.runId}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
}

for (const name of ["suspend", "cancel"] as const) {
  req
    .command(`${name} <reqId>`)
    .description(
      name === "suspend"
        ? "Park a requirement: still wanted, not now. Moves it to requirements/archive/."
        : "Drop a requirement for good. Moves it to requirements/archive/."
    )
    .requiredOption("--why <text>", "why it is being set aside — required")
    .option("--who <name>", "who decided (default: human)")
    .action(async (reqId: string, opts: { why: string; who?: string }) => {
      try {
        const r = await runReqShelve(reqId, name === "suspend" ? "suspended" : "cancelled", opts);
        console.log(`${r.id} ${r.status} — ${r.title}`);
        console.log(`moved out of intake to ${r.file}`);
        if (r.movedAssets) console.log(`  brought ${r.movedAssets}/ along with it`);
        console.log(`recorded as ${r.runId}`);
        console.log(
          name === "suspend"
            ? `Bring it back with: awo req resume ${r.id}`
            : `Its id stays reserved, so nothing will reuse ${r.id}. Reopen: awo req resume ${r.id}`
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
}

req
  .command("resume <reqId>")
  .description("Bring a shelved requirement back into intake, at the status it left from.")
  .option("--who <name>", "who decided (default: human)")
  .action(async (reqId: string, opts: { who?: string }) => {
    try {
      const r = await runReqResume(reqId, opts);
      console.log(`${r.id} ${r.status} — ${r.title}`);
      console.log(`back in intake at ${r.file}`);
      if (r.movedAssets) console.log(`  brought ${r.movedAssets}/ along with it`);
      console.log(`recorded as ${r.runId}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("test-command <repo> [command]")
  .description("Declare how a repo verifies itself. With no command, prints the current one.")
  .action(async (repo: string, command: string | undefined) => {
    try {
      const r = await runSetTestCommand(repo, command);
      console.log(
        r.testCommand
          ? `${r.name}: ${r.testCommand}`
          : `${r.name}: no test command declared — \`task event --run\` will need one each time.`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("resolve [file]")
  .description("Show unresolved upgrade conflicts (*.new) and take one side.")
  .option("--theirs", "take the template's version")
  .option("--yours", "keep yours and delete the .new")
  .action(async (file: string | undefined, opts: { theirs?: boolean; yours?: boolean }) => {
    try {
      const r = await runResolve({ file, ...opts });
      for (const done of r.resolved) {
        console.log(`${done.path} — took ${done.took}`);
      }
      if (r.remaining.length === 0) {
        console.log(r.resolved.length > 0 ? "Nothing left to resolve." : "No conflicts.");
        return;
      }
      for (const c of r.remaining) {
        console.log(`\n${c.path} — ${c.changedLines} changed line(s)`);
        console.log(c.diff.split("\n").slice(4).join("\n"));
      }
      console.log(
        `Take one side:  awo resolve <file> --theirs   |   --yours\n` +
          `Or edit ${r.remaining[0].path} by hand and delete ${r.remaining[0].newPath}.`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const rule = program.command("rule").description("Always-on policy files in rules/.");

rule
  .command("new <id>")
  .description("Scaffold a rule. The AGENTS.md list regenerates itself — nothing to register.")
  .requiredOption("--summary <text>", "the one line that appears in AGENTS.md")
  .option("--severity <level>", "required | recommended (default: required)")
  .option("--applies-to <areas>", "comma-separated, e.g. task_execution,pr")
  .action(
    async (id: string, opts: { summary: string; severity?: string; appliesTo?: string }) => {
      try {
        const r = await runRuleNew(id, opts);
        console.log(`${r.id} created at ${r.file}`);
        console.log(`Listed in AGENTS.md automatically. Write the policy body in that file.`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

program
  .command("run")
  .description("Work a goal's tasks in dependency order, stopping before the QA verdict.")
  .requiredOption("--goal <goalId>", "which goal to work")
  .option("--until <taskId>", "stop after this task, inclusive")
  .option("--yolo", "keep going past a failed task (never past the gate)")
  .option("--dry-run", "show the plan and the stopping conditions, run nothing")
  .option("--max-tasks <n>", "safety cap (default 25)", (v) => parseInt(v, 10))
  .option("--timeout <minutes>", "per-worker timeout (default 45)", (v) => parseInt(v, 10))
  .action(
    async (opts: {
      goal: string;
      until?: string;
      yolo?: boolean;
      dryRun?: boolean;
      maxTasks?: number;
      timeout?: number;
    }) => {
      try {
        const r = await runAuto({
          goal: opts.goal,
          until: opts.until,
          yolo: opts.yolo,
          dryRun: opts.dryRun,
          maxTasks: opts.maxTasks,
          timeoutMinutes: opts.timeout,
        });
        if (r.dryRun) {
          console.log(r.message);
          return;
        }
        for (const s of r.steps) {
          console.log(`  ${s.taskId}\t${s.outcome}\t${s.model}\t${s.runId}`);
        }
        console.log("");
        console.log(`stopped: ${r.stoppedBecause}`);
        console.log(r.message);
        if (r.stoppedBecause === "task-failed" || r.stoppedBecause === "needs-human") {
          process.exitCode = 1;
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

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
      // Say it, so a reader knows the document's relative links still resolve.
      if (g.movedAssets) console.log(`  brought ${g.movedAssets}/ along with it`);
      console.log(`Then add tasks: awo task new --goal ${g.id} --name "…" --targets <repo>`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("plan <goalId>")
  .description(
    "Assemble the tech-lead's task-decomposition brief and hand back a plan-mode invocation: the breakdown is proposed for your approval before any task file exists (§7.2)."
  )
  .option("--write", "skip the approval gate — let the planner create tasks directly")
  .action(async (goalId: string, opts: { write?: boolean }) => {
    try {
      const r = await runGoalPlan(goalId, opts);
      console.log(`brief:   awo log show ${r.briefRunId}`);
      console.log(
        `model:   ${r.model.runtime}:${r.model.model}${r.model.effort ? ` effort=${r.model.effort}` : ""}  (high tier — decomposition is judgment work)`
      );
      console.log(`targets: ${r.targets.join(", ") || "none declared in the goal"}`);
      if (r.existingTasks.length > 0) {
        console.log(`exists:  ${r.existingTasks.join(", ")} — the planner is told not to recreate these`);
      }
      if (r.targetsWithoutTests.length > 0) {
        console.log(
          `\nNO TEST COMMAND: ${r.targetsWithoutTests.join(", ")}\n` +
            `  A task there cannot satisfy tests-must-pass without an agent inventing one.\n` +
            `  awo test-command <repo> "<cmd>"`
        );
      }

      console.log(`\nplan with: ${r.invocation}`);
      if (r.planMode && r.approvesInSession) {
        console.log(
          `\nPlan mode: it explores read-only, proposes the breakdown, and waits. Approve, and\n` +
            `the same session creates the tasks with \`awo task new\`. Nothing is written before that.`
        );
      }
      if (r.planMode && !r.approvesInSession && r.executeInvocation) {
        // Being explicit rather than letting the user wait for a prompt that a
        // process-lifetime sandbox will never show.
        console.log(
          `\nPlan mode: ${r.model.runtime} holds its read-only sandbox for the whole process, so it\n` +
            `cannot write after you approve. Read the plan, then execute it with:\n` +
            `  ${r.executeInvocation}`
        );
      }
      if (!r.planMode) {
        console.log(`\n--write: no approval gate. The planner creates tasks directly.`);
      }
      console.log(
        `\nEvery task lands in \`todo\`. Approving a plan is a session permission, not the\n` +
          `workspace's human gate — review the tasks before \`awo task run\`.`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("verify <goalId>")
  .description(
    "Assemble the goal-level QA gate: the definition-of-done, every task's branch and diff, and the high-tier invocation to review it read-only (§7.1)."
  )
  .action(async (goalId: string) => {
    try {
      const r = await runGoalVerify(goalId);
      console.log(`brief:   ${r.briefPath} (${r.briefRunId})`);
      console.log(`model:   ${r.model.runtime}:${r.model.model}${r.model.effort ? ` effort=${r.model.effort}` : ""}  (high tier — the gate is judgment work)`);
      for (const t of r.tasks) {
        console.log(
          `  ${t.id} ${t.status}${t.untested ? " UNTESTED" : ""} — ${t.worktree ?? "no worktree found"}${t.commits[0] ? ` — ${t.commits[0]}` : ""}`
        );
      }
      if (r.unfinished.length > 0) {
        console.log(`\nNOT READY: ${r.unfinished.join(", ")} — the gate judges finished work.`);
      }
      console.log(`\nreview with: ${r.invocation}`);
      console.log(`then record: awo goal verdict ${goalId} --pass|--gap --summary "…"`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("trace <goalId>")
  .description("Show each acceptance criterion and the test/manual/exception evidence recorded against it.")
  .action(async (goalId: string) => {
    try {
      const rows = await runGoalTrace(goalId);
      for (const row of rows) {
        console.log(`${row.index}\t${row.status}\t${row.criterion}`);
        for (const evidence of row.evidence) {
          console.log(`  ${evidence.kind}\t${evidence.taskId}\t${evidence.ref}`);
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("verdict <goalId>")
  .description("Record the QA gate's outcome: --pass verifies the in-review tasks, --gap files a new requirement.")
  .option("--pass", "the goal meets its definition of done")
  .option("--gap", "it does not — file the finding as a requirement")
  .requiredOption("--summary <text>", "the verdict, in one or two sentences")
  .option("--note <text...>", "the prioritised changes, risks, follow-ups")
  .option("--model <model>", "which model produced the verdict")
  .action(async (goalId: string, opts: { pass?: boolean; gap?: boolean; summary: string; note?: string[]; model?: string }) => {
    try {
      if (opts.pass === Boolean(opts.gap)) {
        throw new Error("Pass exactly one of --pass or --gap.");
      }
      const r = await runGoalVerdict(goalId, { ...opts, pass: Boolean(opts.pass) });
      console.log(`${goalId}: ${r.pass ? "PASS" : "GAP"} recorded.`);
      if (r.verifiedTasks.length > 0) console.log(`verified: ${r.verifiedTasks.join(", ")}`);
      if (r.filedRequirement) {
        console.log(`filed:    ${r.filedRequirement} — turn it into a goal with \`awo goal new --from ${r.filedRequirement}\``);
      }
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
  .option("--kind <kind>", "evidence contract: implementation, investigation, verification, decision, deployment-data")
  .option("--label <name...>", "PR labels for this task — applied only if the repo already has them")
  .action(
    async (opts: {
      goal: string;
      name: string;
      targets?: string[];
      dependsOn?: string[];
      agent?: string;
      kind?: "implementation" | "investigation" | "verification" | "decision" | "deployment-data";
      label?: string[];
    }) => {
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
  .command("evidence <taskId>")
  .description("Link a task's test, manual check, or accepted exception to one acceptance criterion.")
  .requiredOption("--criterion <n>", "1-based acceptance-criterion number", (v) => parseInt(v, 10))
  .requiredOption("--kind <kind>", "test | manual | exception")
  .requiredOption("--ref <text>", "test command/run ID, manual evidence URL, or exception reference")
  .action(async (taskId: string, opts: { criterion: number; kind: "test" | "manual" | "exception"; ref: string }) => {
    try {
      const evidence = await runTaskEvidence({ taskId, ...opts });
      console.log(`criterion ${opts.criterion} <- ${evidence.kind} evidence from ${taskId}`);
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
  .option("--instruction <text>", "what you are telling this worker — recorded in the run")
  .action(async (taskId: string, opts: { worktree?: boolean; instruction?: string }) => {
    try {
      const r = await runTaskRun(taskId, {
        noWorktree: opts.worktree === false,
        instruction: opts.instruction,
      });
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
          `work in: ${wt.path}  (${wt.repo} on ${wt.branch}${wt.basedOn ? ` from ${wt.basedOn}` : ""}${wt.reused ? ", reused" : ""})`
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
  .command("dispatch <taskId>")
  .description(
    "Open a run AND spawn the resolved worker, blocking until it exits (§12.6). Use `task run` if you want to invoke the model yourself."
  )
  .option("--dry-run", "show the model and command without opening a run")
  .option("--timeout <minutes>", "kill the worker after this long (default 45)", (v) => parseInt(v, 10))
  .option("--instruction <text>", "extra guidance appended to the worker's prompt")
  .option("--no-complete", "leave the run open instead of closing it from the exit code")
  .action(async (taskId: string, opts: { dryRun?: boolean; timeout?: number; instruction?: string; complete?: boolean }) => {
    try {
      const r = await runDispatch(taskId, {
        dryRun: opts.dryRun,
        timeoutMinutes: opts.timeout,
        instruction: opts.instruction,
        noComplete: opts.complete === false,
      });
      if (r.exitCode === null && r.runId.startsWith("(none")) {
        console.log(`would dispatch ${r.taskId} to ${r.model}`);
        console.log(`  ${r.command}`);
        return;
      }
      console.log(`${r.taskId} run ${r.runId} — ${r.model}`);
      console.log(`worker:  ${r.timedOut ? "TIMED OUT" : `exited ${r.exitCode}`} -> ${r.outcome}`);
      console.log(`output:  ${r.outputPath}`);
      if (r.completed) console.log(`run closed as ${r.outcome}.`);
      else console.log(`run left open — close it with \`awo task complete ${r.taskId} --outcome <o>\``);
      if (r.outcome !== "success") process.exitCode = 1;
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
  .option(
    "--run <command>",
    "run this command and record what happened — the only form `complete --gate` accepts"
  )
  .option("--baseline", "also run it at the branch point, so a failure can be attributed")
  .option("--repo <name>", "which target repo to run in (default: the task's first target)")
  .option("--timeout <minutes>", "kill the command after this long (default 30)", (v) => parseInt(v, 10))
  .action(
    async (
      taskId: string,
      kind: string,
      opts: {
        label?: string;
        message?: string;
        data?: string;
        run?: string;
        baseline?: boolean;
        repo?: string;
        timeout?: number;
      }
    ) => {
    try {
      const r = await runTaskEvent(taskId, kind, { ...opts, timeoutMinutes: opts.timeout });
      if (!r.measured) {
        console.log(`recorded ${kind} for ${taskId}.`);
      } else {
        console.log(`recorded ${kind} for ${taskId} — ${r.diagnosis}`);
        if (r.needsHuman) {
          console.log("  this one needs a human: `awo log tail` for the explanation");
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("recheck <taskId>")
  .description("Attach real evidence to a task that was closed without any. Opens a new run.")
  .option("--run <command>", "command to verify with (default: the repo's testCommand)")
  .option("--baseline", "also run it at the branch point, so a failure can be attributed")
  .option("--repo <name>", "which target repo to run in")
  .option("--timeout <minutes>", "kill the command after this long (default 30)", (v) => parseInt(v, 10))
  .action(
    async (
      taskId: string,
      opts: { run?: string; baseline?: boolean; repo?: string; timeout?: number }
    ) => {
      try {
        const r = await runTaskRecheck(taskId, { ...opts, timeoutMinutes: opts.timeout });
        console.log(
          `${r.taskId}: ${r.previousStatus} -> ${r.status} — ${r.diagnosis} (run ${r.runId})`
        );
        if (r.inconclusive) {
          console.log(
            "  That command fails at the branch point too, so it proves nothing about this\n" +
              "  task — and the task is now blocked rather than done, which is the honest\n" +
              "  state: it cannot be verified until the base suite is green."
          );
          process.exitCode = 1;
        } else if (!r.passed) {
          console.log("  It does not pass, so the original close was wrong. Left for you to deal with.");
          process.exitCode = 1;
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

task
  .command("complete <taskId>")
  .description("Close the task's open run: writes the log, index line, and lifecycle transition.")
  .requiredOption("--outcome <outcome>", "success | failed | skipped")
  .option("--summary <text>", "what was done (goes in the run log)")
  .option("--prompt <text>", "verbatim user request")
  .option("--interpreted <text>", "the agent's own reading of the request")
  .option("--note <text...>", "deferred items, risks, follow-ups")
  .option("--gate", "route a success to in-review for the QA gate instead of done")
  .option("--untested <why>", "close as success without test evidence, stating why (tests-must-pass)")
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

/**
 * Reported rather than summarised: a label you believe was applied is worse than one
 * you know was not, and awo will not create a label to make the list come out even.
 */
function reportPrMetadata(
  m: { assignee: string | null; applied: string[]; unavailable: string[]; titleMissingTask: boolean },
  taskId: string
): void {
  if (m.assignee) console.log(`  assignee: ${m.assignee}`);
  if (m.applied.length > 0) console.log(`  labels:   ${m.applied.join(", ")}`);
  if (m.unavailable.length > 0) {
    console.log(`  not applied — the repo has no such label: ${m.unavailable.join(", ")}`);
    console.log(`    awo never creates labels. Add it on GitHub first, or drop it from the task.`);
  }
  if (m.titleMissingTask) {
    console.log(`  ! the PR never mentions ${taskId}, so it cannot be traced back from GitHub`);
  }
}

const pr = program.command("pr").description("Link, reconcile, and safely finalize GitHub pull requests.");

pr
  .command("preflight")
  .description("Verify GitHub CLI authentication and repository access before an agent works a PR.")
  .option("--repo <repo>", "one linked repository (default: all linked repositories)")
  .action(async (opts: { repo?: string }) => {
    try {
      const rows = await runPrPreflight(opts);
      for (const row of rows) {
        console.log(`${row.repo}\tauthenticated\tpermission=${row.permission}\tdefault=${row.defaultBranch}`);
        if (row.requiredAccount && row.activeAccount !== row.requiredAccount) {
          console.log(
            `  ! ${row.repo} must be acted on as ${row.requiredAccount}, but gh is active as ` +
              `${row.activeAccount ?? "unknown"} — gh auth switch --user ${row.requiredAccount}`
          );
          process.exitCode = 1;
        } else if (row.requiredAccount) {
          console.log(`  account ${row.activeAccount} — as required by ${row.repo}`);
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("link <taskId>")
  .description("Link a task to an existing GitHub PR and persist its live snapshot.")
  .requiredOption("--repo <repo>", "linked repository name")
  .requiredOption("--number <n>", "GitHub PR number", (v) => parseInt(v, 10))
  .option("--no-meta", "link only: do not set assignee or labels")
  .action(async (taskId: string, opts: { repo: string; number: number; meta?: boolean }) => {
    try {
      const linked = await runPrLink({
        taskId,
        repo: opts.repo,
        number: opts.number,
        noMeta: opts.meta === false,
      });
      console.log(`${taskId} -> ${linked.repo}#${linked.number} ${linked.url}`);
      if (linked.metadata) reportPrMetadata(linked.metadata, taskId);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("meta <taskId>")
  .description("Set the linked PR's assignee and labels from the task. Existing labels only.")
  .option("--label <name...>", "extra labels on top of the task's own")
  .option("--assignee <login>", "override the assignee (default: the authenticated gh user)")
  .option("--dry-run", "show what would change without touching the PR")
  .action(
    async (taskId: string, opts: { label?: string[]; assignee?: string; dryRun?: boolean }) => {
      try {
        const r = await runPrMeta(taskId, opts);
        console.log(`${taskId} -> ${r.repo}#${r.number}${opts.dryRun ? " (dry run)" : ""}`);
        reportPrMetadata(r, taskId);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

pr
  .command("status <taskId>")
  .description("Refresh and show the linked PR's checks, review decision, and merge state.")
  .action(async (taskId: string) => {
    try {
      const status = await runPrStatus(taskId);
      console.log(`${status.repo}#${status.number}\tchecks=${status.checks}\treviews=${status.reviews}\tmerge=${status.mergeState}${status.isDraft ? "\tdraft" : ""}`);
      console.log(status.url);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("reconcile <taskId>")
  .description("Refresh a linked PR and create one repair task for each new unresolved review thread.")
  .action(async (taskId: string) => {
    try {
      const result = await runPrReconcile(taskId);
      console.log(`${result.pr.repo}#${result.pr.number}\t${result.unresolved} unresolved review thread(s)`);
      if (result.createdTaskIds.length > 0) console.log(`created: ${result.createdTaskIds.join(", ")}`);
      if (result.warning) console.log(`WARNING: ${result.warning}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("finalize <taskId>")
  .description("Apply pullRequests.mergePolicy. AWO never approves a PR; human-only never merges.")
  .option("--dry-run", "show an authorized-maintainer merge without calling GitHub")
  .action(async (taskId: string, opts: { dryRun?: boolean }) => {
    try {
      const result = await runPrFinalize(taskId, opts);
      console.log(`${result.action}\t${result.reason}`);
      if (result.action === "blocked") process.exitCode = 1;
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
  .option("--tier <tier>", "only runs resolved to this tier (high|standard|low)")
  .option("--effort <effort>", "only runs at this reasoning effort")
  .action(async (opts: { task?: string; agent?: string; repo?: string; status?: string; tier?: string; effort?: string }) => {
    try {
      const runs = await runLogList(opts);
      if (runs.length === 0) {
        console.log("No runs match.");
        return;
      }
      for (const r of runs) {
        const dur = r.durationSec === null ? "—" : `${r.durationSec}s`;
        const how = [r.tier, r.effort ? `effort=${r.effort}` : null, r.attempts && r.attempts > 1 ? `try#${r.attempts}` : null]
          .filter(Boolean)
          .join(" ");
        console.log(
          `${r.runId}\t${r.status}\t${dur}\t${how || "—"}\t${r.reposChanged.join(",") || "no repos"}`
        );
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

  if (kind === "agent") {
    group
      .command("org")
      .description("Show installed agent reporting, delegation, review relationships, and task workload.")
      .option("--json", "machine-readable organization graph")
      .action(async (opts: { json?: boolean }) => {
        try {
          const result = await runAgentOrg();
          console.log(opts.json ? JSON.stringify(result, null, 2) : formatAgentOrg(result));
          if (result.errors.length > 0) process.exitCode = 1;
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
        }
      });
  }
}

program.parseAsync(process.argv);
