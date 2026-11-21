#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command, Option } from "commander";
import { aliasOption, aliasOptions } from "./cli-alias.js";
import { findWorkspaceRoot } from "./workspace.js";
import { describeModel } from "./models.js";
import {
  ageInDays,
  findCriteria,
  isArchivedStatus,
  listRequirements,
  requirementSince,
  runReqDecide,
  runReqPropose,
  runReqRefine,
  runReqResume,
  runReqShelve,
  runReqShow,
} from "./commands/intake.js";
import { detectAgentEnvironment } from "./agent-env.js";
import { describeActor } from "./human-gate.js";
import { runAuto } from "./commands/autorun.js";
import { listConflicts, runResolve } from "./commands/resolve.js";
import { runCatalogRemove, runRuleNew, type CatalogRemoveResult } from "./commands/catalog.js";
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
  runTaskResume,
  runTaskRun,
  runTaskShow,
  runTaskStatus,
  runTaskVerify,
} from "./commands/task.js";
import { formatEvents, runLogAdd, runLogList, runLogShow, runLogTail } from "./commands/log.js";
import { findGoalsNeedingVerdict, formatGoalShow, formatPr, runGoalShow } from "./commands/show.js";
import { aliasOption, aliasOptions } from "./cli-alias.js";
import { runUi } from "./commands/ui.js";
import { parseCriteriaRefs, runGoalNew, runGoalPlan, runReqNew, runTaskNew } from "./commands/plan.js";
import {
  runGoalArchive,
  runGoalRestore,
  runGoalList,
  formatGoalProgress,
} from "./commands/goal-archive.js";
import { runGoalClose } from "./commands/goal-close.js";
import { runGoalTrace, runTaskEvidence } from "./commands/traceability.js";
import {
  runPrFinalize,
  runPrLink,
  runPrMeta,
  runPrPreflight,
  runPrReconcile,
  runPrStatus,
  type PrSyncRow,
} from "./commands/pr.js";
import { runSync, syncHadProblems } from "./commands/sync.js";
import { doctorExitCode, groupFindings, runDoctor } from "./commands/doctor.js";
import { listWorktrees, pruneWorktrees, stripDependencyDirs, unsafeReason } from "./worktrees.js";
import { readManifest } from "./manifest.js";
import { findAllTasks } from "./tasks.js";
import { newTaskState, readState } from "./state.js";
import { planHasWork, runUpgrade } from "./commands/upgrade.js";
import { runCatalogAdd, runCatalogList, type CatalogKind } from "./commands/catalog.js";
import {
  runAgentSkillList,
  runAgentSkillSync,
  formatSyncResults,
} from "./commands/agent-skills.js";
import { formatContext, runContext } from "./commands/context.js";
import { runGoalVerdict, runGoalVerify } from "./commands/verify.js";
import { runGoalReadiness, runGoalReconcile } from "./commands/readiness.js";
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
  .version(version, "-v, --version", "print the installed awo version")
  // Set before any .command(): commander copies these into each subcommand when it
  // is created. Extra positionals used to be dropped silently — `awo log tail T12`
  // printed some other run, and `awo task complete T3 success` ignored "success" —
  // so a guessed argument now fails loudly with the usage instead.
  .allowExcessArguments(false)
  .showSuggestionAfterError(true);

program
  .command("version")
  .description("Show installed package/build provenance (independent of workspace version).")
  .option("--verbose", "include executable path and immutable build metadata")
  .option("--json", "machine-readable provenance")
  .action((opts: { verbose?: boolean; json?: boolean }) => {
    const file = path.join(PACKAGE_ROOT, "dist", "build-info.json");
    const build = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const info = { version, executable: fileURLToPath(import.meta.url), build };
    if (opts.json || opts.verbose) console.log(JSON.stringify(info, null, 2));
    else console.log(version);
  });

program
  .command("init")
  .description("Scaffold a new awo workspace in the current directory.")
  .requiredOption("--key <key>", "short, permanent project code (2-5 uppercase letters, e.g. PROM)")
  .option("--name <projectName>", "human-readable project name (default: the key)")
  .option(
    "--adopt",
    "add awo to a directory that already has a project: keeps every existing file, discovers repos"
  )
  .action(async (opts: { key: string; name?: string; adopt?: boolean }) => {
    try {
      const r = await runInit({ key: opts.key, name: opts.name, adopt: opts.adopt });
      console.log(
        `awo workspace initialized with project key ${opts.key}${opts.name ? ` (${opts.name.trim()})` : ""}.`
      );

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
        const first = await runPublish({ dryRun: opts.dryRun });
        console.log(
          `${first.dryRun ? "would sync" : "synced"} ${first.detail} · ${first.counts.requirements} requirements · ${first.counts.goals} goals · ${first.counts.tasks} tasks · ${first.counts.runs} runs · ${first.counts.agents} agents` +
            `${first.uriHost ? ` -> ${first.uriHost}/${first.database}` : ""}`
        );
        console.log("watching for changes — Ctrl+C to stop.");
        const handle = await runPublishWatch({
          dryRun: opts.dryRun,
          onPublish: (r) => {
            const at = new Date().toLocaleTimeString();
            if (r instanceof Error) console.error(`${at}  sync failed: ${r.message}`);
            else {
              console.log(`${at}  ${r.dryRun ? "would sync" : "synced"} ${r.counts.requirements} requirements · ${r.counts.tasks} tasks · ${r.counts.runs} runs · ${r.counts.agents} agents`);
              if (r.purgedEvents > 0) {
                console.log(`${at}  removed ${r.purgedEvents} event document(s) left by an earlier full-detail publish`);
              }
            }
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
        const { workerLogs, outputTails, prompts, checkoutPaths } = r.redacted;
        const withheld = [
          workerLogs > 0 ? `${workerLogs} worker log(s)` : null,
          outputTails > 0 ? `${outputTails} captured command output(s)` : null,
          prompts > 0 ? `${prompts} prompt(s)` : null,
          checkoutPaths > 0 ? `${checkoutPaths} checkout path(s)` : null,
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
      // Secrets are masked at every detail level; saying so is how anyone finds out a
      // credential was sitting in a log in the first place.
      if (r.redacted.secrets > 0) {
        console.log(`  masked credentials in ${r.redacted.secrets} field(s) before sending — the local logs still hold them`);
      }
      if (r.purgedEvents > 0) {
        console.log(
          `  removed ${r.purgedEvents} event document(s) left on the cluster by an earlier full-detail publish`
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
  .option("--json", "machine-readable output: the same digest (live goals, capped recent runs)")
  .option("--full", "include the whole dashboard snapshot (every goal, requirement and run) — slow on big workspaces")
  .action(async (opts: { json?: boolean; full?: boolean }) => {
    try {
      const c = await runContext({ full: opts.full });
      console.log(opts.json || opts.full ? JSON.stringify(c, null, 2) : formatContext(c));
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

const upgrade = program
  .command("upgrade")
  .description(
    "Bring this workspace up to the INSTALLED awo version (not npm's latest): run migrations and reconcile scaffolding (§11). Use `npx @supanut9/awo@latest upgrade` to target the newest release."
  )
  .option("--dry-run", "show what would change without touching anything (alias: --preview)")
  .option("--to <version>", "assert the intended target version (must match the installed awo)")
  .option("--force", "proceed even with uncommitted changes in the workspace");
// `--preview` is the word people reach for before a risky command.
aliasOption(upgrade, "--preview", "dryRun");
upgrade
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
      for (const note of r.notes) console.log(`  note: ${note}`);
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
  .option("--json", "machine-readable findings")
  .option("--scope <scope>", "active (live goals) or all (includes archived history)", "active")
  .option("--secrets", "also scan logs/ for recorded credentials (reports file and count, never the value)")
  .action(async (opts: { all?: boolean; json?: boolean; scope: string; secrets?: boolean }) => {
    try {
      if (opts.scope !== "active" && opts.scope !== "all") throw new Error("--scope must be active or all");
      const findings = await runDoctor({ scope: opts.scope, secrets: opts.secrets });
      if (opts.json) {
        console.log(JSON.stringify(findings, null, 2));
        process.exitCode = doctorExitCode(findings);
        return;
      }
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
 * Each task's lifecycle status, read from state rather than from the authored
 * `status:`, which is only a starting point (§7.2).
 */
async function taskStatuses(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { task, goal } of await findAllTasks(root)) {
    const state = await readState(goal.dir, goal.id);
    out.set(task.id, (state.tasks[task.id] ?? newTaskState(task.authoredStatus)).status);
  }
  return out;
}

/** Tasks in a terminal state, so pruning defaults to work that is provably over. */
function finishedIn(statuses: Map<string, string>): Set<string> {
  return new Set([...statuses].filter(([, s]) => s === "done" || s === "cancelled").map(([id]) => id));
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
        const verdict = reason
          ? `KEEP — ${reason}`
          : `safe to remove${w.mergedBy ? ` (${w.mergedBy})` : ""}`;
        console.log(`${w.path}\t${w.branch ?? "—"}\t${mb}MB\t${verdict}`);
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
    "Remove worktrees for finished tasks. Keeps any that is dirty or holds commits that are not merged, pushed or squash-merged. With --deps, strip rebuildable dependency/build directories from idle worktrees instead."
  )
  .option("--task <taskId...>", "prune only these tasks' worktrees")
  .option("--all", "consider every worktree, not only those of finished tasks")
  .option("--force", "remove even a dirty or unmerged worktree — this discards work")
  .option("--deps", "keep the worktrees; delete their gitignored node_modules/.next/dist/.turbo/.cache/build (idle tasks only)")
  .option("--dry-run", "show what would be removed without touching anything")
  .action(async (opts: { task?: string[]; all?: boolean; force?: boolean; deps?: boolean; dryRun?: boolean }) => {
    try {
      const root = findWorkspaceRoot(process.cwd());
      const manifest = await readManifest(root);
      const statuses = await taskStatuses(root);
      const finished = finishedIn(statuses);

      if (opts.deps) {
        // Default scope is every worktree, not only finished ones: the point is the
        // disk held by checkouts that must stay, like tasks waiting in review.
        const running = new Set([...statuses].filter(([, s]) => s === "running").map(([id]) => id));
        const results = await stripDependencyDirs(root, manifest, {
          select: (w) => (opts.task ? opts.task.includes(w.leaf) : true),
          running,
          dryRun: opts.dryRun,
        });
        let freed = 0;
        for (const r of results) {
          if (r.skippedBecause) {
            console.log(`skipped ${r.worktree.path}  (${r.skippedBecause})`);
            continue;
          }
          freed += r.bytes;
          for (const item of r.removed) {
            const what = item.link ? "link only" : `${Math.round(item.bytes / 1024 ** 2)}MB`;
            console.log(`${opts.dryRun ? "would strip" : "stripped"} ${item.path}  (${what})`);
          }
        }
        if (results.length === 0) console.log("No task worktrees to strip.");
        console.log(
          `\n${Math.round(freed / 1024 ** 2)}MB ${opts.dryRun ? "would be freed (dry run — nothing was touched)" : "freed"}.` +
            ` The next \`awo task run\` re-links node_modules; rebuild the rest when you resume a task.`
        );
        return;
      }

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
          // Mirror pruneWorktrees: --force never removes an active baseline or a
          // non-empty directory git has no record of.
          const forced = opts.force && (w.baseline ? !w.active : w.registered || w.empty === true);
          const reason = forced ? null : unsafeReason(w);
          console.log(`${reason ? "keep  " : "remove"} ${w.path}${reason ? `  (${reason})` : ""}`);
        }
        console.log("\n(dry run — nothing was touched)");
        return;
      }

      const results = await pruneWorktrees(root, manifest, { select, force: opts.force, withSizes: true });
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
            ? `; ${kept} kept because they still hold work — each line says why. Inspect them; \`--force\` discards uncommitted or unmerged work, but awo never deletes what git refused to remove.`
            : ".")
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("remove <name>")
  .description(
    "Unregister a repo. A connected repo loses only its repos/ link; a clone stays on disk unless --delete-checkout."
  )
  .option("--delete-checkout", "also delete a cloned checkout — refused unless it is clean, fully pushed and has no task worktrees")
  .option("--dry-run", "show what would happen without changing anything")
  .action(async (name: string, opts: { deleteCheckout?: boolean; dryRun?: boolean }) => {
    try {
      const r = await runRemove({ name, deleteCheckout: opts.deleteCheckout, dryRun: opts.dryRun });
      const will = r.dryRun ? "would be " : "";
      const what = {
        unlinked: `${r.path} ${will}unlinked`,
        kept: `${r.path} ${will}kept on disk`,
        deleted: `${r.path} ${will}deleted`,
        missing: `${r.path} is already gone`,
      }[r.checkout];
      console.log(`${r.dryRun ? "Would remove" : "Removed"} ${name} — ${what}.`);
      for (const note of r.notes) console.log(`  ${note}`);
      if (r.dryRun) console.log("(dry run — nothing was changed)");
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
  .option("--stale <days>", "only those unchanged for at least <days> days, oldest first, with their age")
  .action(async (opts: { all?: boolean; archived?: boolean; stale?: string }) => {
    try {
      const root = findWorkspaceRoot(process.cwd());
      const every = await listRequirements(root, { includeArchived: true });
      const rows = opts.archived
        ? every.filter((r) => r.archived)
        : opts.all
          ? every
          : every.filter((r) => !r.archived);

      if (opts.stale !== undefined) {
        const days = Number(opts.stale);
        if (!Number.isFinite(days) || days < 0) {
          throw new Error(`--stale needs a number of days (e.g. --stale 14); got "${opts.stale}".`);
        }
        // Age is time in the current status: a proposal nobody has decided on, an
        // approval nobody has planned, a draft nobody refined.
        const aged = [];
        for (const r of rows) aged.push({ r, age: ageInDays(await requirementSince(root, r)) ?? 0 });
        const stale = aged.filter((row) => row.age >= days).sort((a, b) => b.age - a.age || a.r.id.localeCompare(b.r.id));
        if (stale.length === 0) {
          console.log(`Nothing unchanged for ${days}+ days${opts.all || opts.archived ? "" : " in intake"}.`);
          return;
        }
        for (const { r, age } of stale) {
          console.log(`${r.id}\t${r.status}\t${age}d\t${findCriteria(r.body).length} criteria\t${r.title}`);
        }
        return;
      }

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
  .command("show <reqId>")
  .description("One requirement: status and age, criteria with their labels, and the decision record.")
  .option("--json", "machine-readable result")
  .action(async (reqId: string, opts: { json?: boolean }) => {
    try {
      const r = await runReqShow(reqId);
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(`${r.id} — ${r.title}`);
      console.log(`status:   ${r.status}${r.ageDays !== null ? ` for ${r.ageDays}d` : ""}${r.archived ? " (archived)" : ""}`);
      console.log(`file:     ${r.file}`);
      console.log(`source:   ${r.source}`);
      console.log(`goal:     ${r.goalId ?? "unplanned"}`);
      if (r.decision) {
        const d = r.decision;
        const delegation = d.delegation as { by?: string; instruction?: string | null; via?: string } | null;
        console.log(
          `decision: ${d.decidedBy ?? "unknown"}${d.via ? ` via ${d.via}` : ""}${d.decidedAt ? ` at ${d.decidedAt}` : ""}`
        );
        if (delegation?.by) {
          console.log(
            `          delegated by ${delegation.by}, recorded by ${delegation.via ?? "an agent"}` +
              (delegation.instruction ? ` — "${delegation.instruction}"` : " — no instruction quoted")
          );
        }
        if (d.note) console.log(`note:     ${d.note}`);
        if (d.criteriaChangedSinceApproval) {
          console.log(`digest:   CRITERIA CHANGED SINCE APPROVAL — the approval was of different terms`);
        } else if (d.approvedDigest) {
          console.log(`digest:   ${d.approvedDigest.slice(0, 16)} (matches the current criteria)`);
        }
      }
      console.log(`criteria (${r.criteria.length}):`);
      for (const c of r.criteria) console.log(`  ${c.index}\t${c.label ?? "—"}\t${c.text}`);
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

/** `--reason` for `--why`, `--by` for `--who`: the spellings agents reach for first. */
function intakeAliases(command: Command): Command {
  aliasOption(command, "--reason <text>", "why");
  aliasOption(command, "--by <name>", "who");
  return command;
}

for (const [name, flag] of [
  ["approve", "approve"],
  ["reject", "reject"],
] as const) {
  const decide = req
    .command(`${name} <reqId>`)
    .description(
      flag === "approve"
        ? "Accept the terms of the work. Planning cannot start without this."
        : "Send it back, with the reason recorded."
    )
    .option("--why <text>", "reason (required to reject)")
    .option("--who <name>", "who decided (default: your git user.name)")
    .option("--delegated-by <human>", "an agent recording a person's decision: who made it (required under an agent runtime)")
    .option("--instruction <quote>", "with --delegated-by: the person's instruction, verbatim");
  intakeAliases(decide).action(
    async (reqId: string, opts: { why?: string; who?: string; delegatedBy?: string; instruction?: string }) => {
      try {
        const r = await runReqDecide(reqId, { ...opts, [flag]: true });
        console.log(`${r.id} ${r.status} — ${r.title}`);
        console.log(`decided by ${describeActor(r.actor)}`);
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
    }
  );
}

for (const name of ["suspend", "cancel"] as const) {
  // `--why` is validated by runReqShelve rather than `requiredOption`, so the
  // hidden `--reason` alias can satisfy it (commander checks required options
  // before alias hooks run).
  const shelve = req
    .command(`${name} <reqId>`)
    .description(
      name === "suspend"
        ? "Park a requirement: still wanted, not now. Moves it to requirements/archive/."
        : "Drop a requirement for good. Moves it to requirements/archive/."
    )
    .option("--why <text>", "why it is being set aside — required")
    .option("--who <name>", "who decided (default: your git user.name, or the agent)");
  intakeAliases(shelve).action(async (reqId: string, opts: { why?: string; who?: string }) => {
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

const resume = req
  .command("resume <reqId>")
  .description("Bring a shelved requirement back into intake, at the status it left from.")
  .option("--why <text>", "why it is coming back")
  .option("--who <name>", "who decided (default: your git user.name, or the agent)");
intakeAliases(resume).action(async (reqId: string, opts: { why?: string; who?: string }) => {
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

/** Shared by `agent|skill|rule remove`: what went, and what it left dangling. */
function reportRemoval(kind: string, r: CatalogRemoveResult): void {
  console.log(`removed ${kind} ${r.name} (${r.file}); AGENTS.md's list regenerated`);
  for (const ref of r.references) console.log(`  ! still referenced: ${ref.file}: ${ref.detail}`);
  if (r.reinstall) console.log(`Reinstall with: ${r.reinstall}`);
}

rule
  .command("remove <id>")
  .description("Delete a rule and regenerate AGENTS.md. Refuses while an agent or skill still cites it.")
  .option("--force", "delete it even though something still references it")
  .action(async (id: string, opts: { force?: boolean }) => {
    try {
      reportRemoval("rule", await runCatalogRemove("rule", id, { force: opts.force }));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

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
  .option(
    "--policy <policy>",
    "light (measured tasks only) | standard (+ per-criterion evidence) | strict (+ goal QA verdict); default goals.defaultPolicy, else strict"
  )
  .option("--origin <origin>", "why it exists: plan (default) | qa-gap | pr-feedback | follow-up")
  .action(async (opts: { from: string; title?: string; policy?: string; origin?: string }) => {
    try {
      const g = await runGoalNew(opts);
      console.log(`${g.id} created at ${g.dir}/ (from ${g.requirementId}, ${g.policy} policy)`);
      // Say it, so a reader knows the document's relative links still resolve.
      if (g.movedAssets) console.log(`  brought ${g.movedAssets}/ along with it`);
      console.log(
        `Then add tasks: awo task new --goal ${g.id} --name "…" --targets <repo> --objective "…" --done-when "…"`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("archive <goalId>")
  .description("Move a finished or cancelled goal into goals/archive/, so the live list is only live work.")
  .option("--force", "archive a goal that is not done or cancelled (abandoned without being marked)")
  .option("--unmerged-ok", "archive even though linked pull requests are not merged")
  .action(async (goalId: string, opts: { force?: boolean; unmergedOk?: boolean }) => {
    try {
      const r = await runGoalArchive(goalId, { force: opts.force, unmergedOk: opts.unmergedOk });
      console.log(`${r.id} (${r.status}) archived: ${r.from} -> ${r.to}`);
      if (r.unmerged.length > 0) {
        console.log(`  archived with ${r.unmerged.length} unmerged pull request(s): ${r.unmerged.map((pr) => `${pr.repo}#${pr.number}`).join(", ")}`);
      }
      console.log(`Its tasks, state and runs moved with it; it is read-only until restored. Undo with: awo goal restore ${r.id}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("restore <goalId>")
  .description("Pull an archived goal back into goals/.")
  .action(async (goalId: string) => {
    try {
      const r = await runGoalRestore(goalId);
      console.log(`${r.id} (${r.status}) restored: ${r.from} -> ${r.to}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("close <goalId>")
  .description(
    "Close a goal: list every blocker as the exact command that clears it; when nothing blocks, archive it and prune its clean, merged worktrees."
  )
  .option("--dry-run", "list blockers and what would be archived/pruned, change nothing")
  .option("--unmerged-ok", "close even though linked PRs are not merged (closed, or the work landed another way)")
  .option("--json", "machine-readable result")
  .action(async (goalId: string, opts: { dryRun?: boolean; unmergedOk?: boolean; json?: boolean }) => {
    try {
      const r = await runGoalClose(goalId, { dryRun: opts.dryRun, unmergedOk: opts.unmergedOk });
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
      } else if (r.blockers.length > 0) {
        console.log(`${r.goalId} (${r.status}) cannot close yet — ${r.blockers.length} blocker(s):`);
        for (const b of r.blockers) {
          console.log(`  ✗ ${b.message}`);
          for (const command of b.commands) console.log(`      ${command}`);
        }
        console.log(opts.dryRun ? "\n(dry run — nothing was touched)" : "\nNothing was changed.");
      } else if (r.dryRun) {
        console.log(`${r.goalId} (${r.status}) can close — nothing blocks it.`);
        console.log(`  would archive -> ${r.archivedTo}`);
        for (const p of r.pruned) console.log(`  would prune ${p}`);
        console.log("\n(dry run — nothing was touched)");
      } else {
        console.log(`${r.goalId} (${r.status}) closed: archived to ${r.archivedTo}`);
        for (const p of r.pruned) console.log(`  pruned ${p}`);
        for (const k of r.kept) console.log(`  kept   ${k.path}  (${k.reason})`);
        console.log(`Undo the archive with: awo goal restore ${r.goalId}`);
      }
      if (r.blockers.length > 0 && !opts.dryRun) process.exitCode = 1;
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
      console.log(`model:   ${describeModel(r.model)}  (high tier — decomposition is judgment work)`);
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
  .command("readiness <goalId>")
  .description("Report every blocker between the goal's current state and a truthful QA-ready result.")
  .option("--json", "machine-readable result")
  .action(async (goalId: string, opts: { json?: boolean }) => {
    try {
      const r = await runGoalReadiness(goalId);
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`${r.goalId} ${r.ready ? "READY" : "NOT READY"} (${r.status})`);
        console.log(`tasks: ${Object.entries(r.tasks.byStatus).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`);
        if (r.criteria) {
          console.log(
            `criteria: ${r.criteria.covered} covered, ${r.criteria.exceptions} accepted exception, ${r.criteria.missing} missing` +
              (r.criteria.stale ? ` (${r.criteria.stale} edited since their evidence)` : "")
          );
        }
        console.log(
          `qa: ${r.qa.briefRunId ?? "no brief"} · ${r.qa.verdict ?? "no verdict"}` +
            `${r.qa.verdictBy ? ` by ${r.qa.verdictBy}` : ""}`
        );
        for (const blocker of r.blockers) console.log(`- ${blocker.code}: ${blocker.message}`);
      }
      if (!r.ready) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("reconcile <goalId>")
  .description("Persist authored-task/runtime-state reconciliation and record the repair in the run log.")
  .action(async (goalId: string) => {
    try {
      const r = await runGoalReconcile(goalId);
      console.log(`${r.goalId} reconciled — ${r.status}`);
      console.log(`added:   ${r.added.join(", ") || "none"}`);
      console.log(`removed: ${r.removed.join(", ") || "none"}`);
      console.log(`log:     ${r.runId}`);
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
      console.log(`brief:   ${r.briefPath} (${r.briefRunId}, linked from ${r.recordPath})`);
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
      console.log(
        detectAgentEnvironment().isAgent
          ? `then the human decides; on their instruction record it with:\n` +
              `  awo goal verdict ${goalId} --pass|--gap --summary "…" --delegated-by "<who>" --instruction "<their words>"`
          : `then record: awo goal verdict ${goalId} --pass|--gap --summary "…" --who "<your name>"`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("trace <goalId>")
  .description("Show each acceptance criterion and the test/manual/exception evidence recorded against it.")
  .option("--json", "machine-readable result")
  .action(async (goalId: string, opts: { json?: boolean }) => {
    try {
      const rows = await runGoalTrace(goalId);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.index}\t${row.status}\t${row.criterion}`);
        for (const evidence of row.evidence) {
          // A test reference that never bound to a measurement is a claim, and says so.
          const how =
            evidence.kind === "test"
              ? evidence.measurement
                ? `measured: ${evidence.measurement.command} -> exit ${evidence.measurement.exitCode ?? "?"} (run ${evidence.measurement.runId})`
                : "claimed (not bound to a measured test)"
              : evidence.kind === "exception"
                ? evidence.acceptedBy ? `accepted by ${evidence.acceptedBy}` : "NOT accepted by anyone"
                : evidence.by ? `by ${evidence.by}` : "";
          const stale = row.staleEvidence.includes(evidence)
            ? "\tSTALE: criterion edited since evidence — re-attach"
            : "";
          console.log(`  ${evidence.kind}\t${evidence.taskId}\t${evidence.ref}${how ? `\t${how}` : ""}${stale}`);
        }
        for (const evidence of row.staleEvidence.slice(0, 1)) {
          console.log(
            `  re-attach: awo task evidence ${evidence.taskId} --criterion ${row.label ?? row.index} --kind ${evidence.kind}` +
              (evidence.kind === "test" ? "" : ` --ref "${evidence.ref}"`) +
              (evidence.kind === "exception" && evidence.acceptedBy ? ` --who "${evidence.acceptedBy}"` : "")
          );
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const verdict = goal
  .command("verdict <goalId>")
  .description("Record the QA gate's outcome: --pass enforces readiness; --gap creates an in-goal repair task unless --new-scope is explicit.")
  .option("--pass", "the goal meets its definition of done")
  .option("--gap", "it does not — create a repair task on this goal")
  .option("--new-scope", "the gap is outside the approved goal — file a new requirement")
  .option("--targets <repos>", "repair-task repos; defaults to the goal targets", (v) => v.split(","))
  .option("--agent <agent>", "repair-task owner (default: software-engineer)")
  .option("--kind <kind>", "repair-task evidence contract")
  .requiredOption("--summary <text>", "the verdict, in one or two sentences")
  .option("--who <human>", "human responsible for the verdict; required by governed goals")
  .option("--delegated-by <human>", "an agent recording a person's verdict: who made it (required under an agent runtime)")
  .option("--instruction <quote>", "with --delegated-by: the person's instruction, verbatim")
  .option("--note <text...>", "the prioritised changes, risks, follow-ups")
  .option("--model <model>", "which model produced the verdict");
aliasOption(verdict, "--by <human>", "who");
verdict
  .action(async (goalId: string, opts: {
    pass?: boolean;
    gap?: boolean;
    newScope?: boolean;
    targets?: string[];
    agent?: string;
    kind?: "implementation" | "investigation" | "verification" | "decision" | "deployment-data";
    summary: string;
    who?: string;
    delegatedBy?: string;
    instruction?: string;
    note?: string[];
    model?: string;
  }) => {
    try {
      if (opts.pass === Boolean(opts.gap)) {
        throw new Error("Pass exactly one of --pass or --gap.");
      }
      const r = await runGoalVerdict(goalId, { ...opts, pass: Boolean(opts.pass) });
      console.log(`${goalId}: ${r.pass ? "PASS" : "GAP"} recorded.`);
      console.log(`decided by ${describeActor(r.actor)}`);
      if (r.verifiedTasks.length > 0) console.log(`verified: ${r.verifiedTasks.join(", ")}`);
      if (r.createdTask) {
        console.log(`repair:   ${r.createdTask} — stays on ${goalId}; run goal-level QA again after it closes`);
      }
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
  .description("List goals with rolled-up task status — live by default, so the list is what is in flight.")
  .option("--archived", "list archived goals instead")
  .option("--all", "list both")
  .option("--needs-verdict", "only governed goals whose tasks are all in review or done, with no passing verdict")
  .option("--json", "machine-readable output")
  .action(async (opts: { archived?: boolean; all?: boolean; needsVerdict?: boolean; json?: boolean }) => {
    try {
      // Reads goals directly rather than grouping task rows: a goal that has no
      // tasks yet is still a goal, and grouping by task made it invisible.
      let rows = await runGoalList({ archived: opts.archived, all: opts.all });
      if (opts.needsVerdict) {
        const waiting = await findGoalsNeedingVerdict(findWorkspaceRoot(process.cwd()));
        rows = rows.filter((r) => waiting.has(r.id));
      }
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(
          opts.needsVerdict
            ? "No goals are waiting on a verdict."
            : opts.archived
              ? "No archived goals."
              : "No live goals. Start with `awo req new --title \"…\"`."
        );
        return;
      }
      for (const r of rows) {
        const where = r.archived ? "\t[archived]" : "";
        console.log(`${r.id}\t${r.status}\t${formatGoalProgress(r)}${where}\t${r.title}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

goal
  .command("show <goalId>")
  .description("One goal: status, policy, criteria coverage, tasks with PRs, worktrees — what a verdict needs.")
  .option("--json", "machine-readable output")
  .action(async (goalId: string, opts: { json?: boolean }) => {
    try {
      const g = await runGoalShow(goalId);
      console.log(opts.json ? JSON.stringify(g, null, 2) : formatGoalShow(g));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const task = program.command("task").description("Inspect and run tasks (§7.2/§7.4).");

task
  .command("new")
  .description("Create the next task under a goal (allocates <KEY>-T# and wires taskIds).")
  .requiredOption("--goal <goalId>", "goal this task belongs to")
  .requiredOption("--name <name>", "what the task does")
  .option("--targets <repos>", "comma-separated repo names from the manifest (optional for investigation/decision)", (v) => v.split(","))
  .option("--depends-on <taskIds>", "comma-separated task ids that must finish first", (v) => v.split(","))
  .option("--agent <agent>", "agent that should run it")
  .option("--kind <kind>", "evidence contract: implementation, investigation, verification, decision, deployment-data")
  .option("--objective <text>", "the outcome, written into the body as ## Objective")
  .option("--done-when <text...>", "checkable completion conditions, written into the body as ## Done when")
  .option("--body-file <path>", "the whole markdown body from a file, or - to read it from stdin")
  .option("--criteria <refs>", "goal acceptance criteria this task serves: 1-based numbers or AC-<n>, comma-separated")
  .option("--tier <tier>", "override the role's model tier for this task: high | standard | low")
  .option("--output <path...>", "what it delivers besides commits, e.g. docs/research/options.md")
  .option("--origin <origin>", "why it exists: plan (default) | qa-gap | pr-feedback | follow-up")
  .option("--label <name...>", "PR labels for this task — applied only if the repo already has them")
  .action(
    async (opts: {
      goal: string;
      name: string;
      targets?: string[];
      dependsOn?: string[];
      agent?: string;
      kind?: "implementation" | "investigation" | "verification" | "decision" | "deployment-data";
      objective?: string;
      doneWhen?: string[];
      bodyFile?: string;
      criteria?: string;
      tier?: string;
      output?: string[];
      origin?: string;
      label?: string[];
    }) => {
    try {
      const body =
        opts.bodyFile === undefined
          ? undefined
          : opts.bodyFile === "-"
            ? fs.readFileSync(0, "utf8")
            : fs.readFileSync(path.resolve(opts.bodyFile), "utf8");
      const t = await runTaskNew({
        goal: opts.goal,
        name: opts.name,
        targets: opts.targets,
        dependsOn: opts.dependsOn,
        agent: opts.agent,
        kind: opts.kind,
        body,
        objective: opts.objective,
        doneWhen: opts.doneWhen,
        criteria: opts.criteria ? parseCriteriaRefs([opts.criteria]) : undefined,
        tier: opts.tier,
        outputs: opts.output,
        origin: opts.origin,
        labels: opts.label,
        enforceTargets: true,
      });
      console.log(`${t.id} created at ${t.file}`);
      if (body === undefined && !opts.objective && !opts.doneWhen?.length) {
        // Said here because `task run` hands the body to a worker verbatim: an
        // unwritten skeleton becomes the worker's whole instruction.
        console.log(`Its body is still the skeleton — write the Objective and Done when in ${t.file} before running it.`);
      }
      console.log(`Run it with: awo task run ${t.id}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("list [goalId]")
  .description("List tasks with their lifecycle status — live goals only unless a goal or --all is given.")
  .option("--goal <goalId>", "only this goal's tasks (archived goals included)")
  .option("--status <status>", "only tasks in this lifecycle state (e.g. blocked)")
  .option("--all", "include tasks of archived goals")
  .option("--json", "machine-readable output")
  .action(async (goalArg: string | undefined, opts: { goal?: string; status?: string; all?: boolean; json?: boolean }) => {
    try {
      const rows = await runTaskList({ goal: goalArg ?? opts.goal, status: opts.status, all: opts.all });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(
          opts.status
            ? `No tasks with status "${opts.status}".`
            : goalArg ?? opts.goal
              ? `${goalArg ?? opts.goal} has no tasks yet — \`awo goal plan ${goalArg ?? opts.goal}\` or \`awo task new --goal ${goalArg ?? opts.goal}\`.`
              : opts.all
                ? "No tasks yet. Author one under goals/<goal>/tasks/."
                : "No tasks in live goals. `awo task list --all` includes archived goals."
        );
        return;
      }
      for (const r of rows) {
        const outcome = r.lastRunOutcome ? ` (last run: ${r.lastRunOutcome})` : "";
        const goalCol = `${r.goalId}${r.goalArchived ? " [archived]" : ""}`;
        console.log(`${r.id}\t${r.status}${outcome}\t${goalCol}\t${r.name}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("show <taskId>")
  .description("Print a task definition plus its state: goal policy, worktrees, base, PRs, owner, last measured tests.")
  .option("--json", "machine-readable output")
  .action(async (taskId: string, opts: { json?: boolean }) => {
    try {
      const r = await runTaskShow(taskId);
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      const policy = [
        r.goal.policy.qaRequired ? "QA verdict" : null,
        r.goal.policy.acceptanceEvidenceRequired ? "acceptance evidence" : null,
      ].filter(Boolean);
      console.log(`${r.task.id} — ${r.task.name}`);
      console.log(`status:   ${r.status}${r.blockedReason ? ` (${r.blockedReason})` : ""}`);
      console.log(
        `goal:     ${r.task.goalId} (${r.goal.status})${r.goal.archived ? " [archived]" : ""} · policy: ${policy.length ? `${policy.join(" + ")} required` : "task verification only"}`
      );
      console.log(`kind:     ${r.task.kind}${r.task.dependsOn.length ? ` · depends on ${r.task.dependsOn.join(", ")}` : ""}`);
      console.log(`targets:  ${r.task.targets.join(", ") || "none"}`);
      console.log(`agent:    ${r.task.agent ?? "unassigned"}`);
      console.log(`attempts: ${r.attempts}`);
      console.log(`last run: ${r.lastRunId ?? "none"}${r.lastRunOutcome ? ` — ${r.lastRunOutcome}` : ""}`);
      const onDisk = r.worktrees.filter((w) => w.exists);
      if (onDisk.length > 0) {
        for (const w of onDisk) console.log(`worktree: ${w.path}${w.branch ? ` on ${w.branch}` : ""}`);
      } else if (r.worktree) {
        console.log(`worktree: ${r.worktree} (recorded; not on disk)`);
      }
      for (const [repo, base] of Object.entries(r.base ?? {})) {
        console.log(`base:     ${repo} ${base.ref}${base.sha ? `@${base.sha.slice(0, 10)}` : ""}`);
      }
      if (r.pullRequests.length > 0) console.log(`PRs:      ${r.pullRequests.map(formatPr).join(", ")}`);
      if (r.owner) {
        console.log(
          `owner:    ${r.owner.actor} (pid ${r.owner.pid ?? "?"} on ${r.owner.host}) since ${r.owner.startedAt} · last seen ${r.owner.heartbeatAt}`
        );
      }
      if (r.lastTransition) {
        const t = r.lastTransition;
        console.log(`moved:    ${t.from} → ${t.to} by ${t.by} at ${t.at}${t.reason ? ` — ${t.reason}` : ""}`);
      }
      for (const m of r.measurements) {
        const counts = m.passed !== undefined || m.failed !== undefined ? ` ${m.passed ?? 0} passed/${m.failed ?? 0} failed` : "";
        console.log(
          `tested:   ${m.repo ?? "(no repo)"} exit ${m.exitCode ?? "?"}${counts} · ${m.diagnosis ?? "no diagnosis"}${m.needsHuman ? " (needs a human)" : ""} · ${m.runId}`
        );
      }
      if (r.task.body) console.log(`\n${r.task.body}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

task
  .command("evidence <taskId>")
  .description("Link a task's measured test, manual check, or accepted exception to acceptance criteria.")
  .requiredOption("--criterion <which>", "criterion number (1), list (1,3,5) or label (AC-17)")
  .requiredOption("--kind <kind>", "test | manual | exception")
  .option(
    "--ref <text>",
    "test: the measured command or its runId (default: the latest passing one); manual: where the proof is; exception: the decision"
  )
  .option("--who <human>", "human accepting an exception; required for --kind exception")
  .action(async (taskId: string, opts: { criterion: string; kind: "test" | "manual" | "exception"; ref?: string; who?: string }) => {
    try {
      const r = await runTaskEvidence({ taskId, ...opts });
      for (const item of r.attached) {
        const which = `criterion ${item.index}${item.label ? ` (${item.label})` : ""}`;
        const measured = item.evidence.measurement
          ? ` — measured \`${item.evidence.measurement.command}\` exit ${item.evidence.measurement.exitCode ?? "?"} in ${item.evidence.measurement.runId}`
          : "";
        console.log(
          `${which} <- ${item.evidence.kind} evidence from ${r.taskId}${measured}${item.added ? "" : " (already recorded)"}`
        );
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const taskStatus = task
  .command("status <taskId> <status>")
  .description(
    "Move a task's lifecycle state by hand: park it (`blocked --reason`), restore it (`todo`), or cancel it — the only way to reach `cancelled`."
  )
  .option("--reason <reason>", "why — recorded on the transition; required for blocked")
  .action(async (taskId: string, status: string, opts: { reason?: string }) => {
    try {
      const to = await runTaskStatus(taskId, status, { reason: opts.reason });
      console.log(`${taskId} -> ${to}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
aliasOption(taskStatus, "--why <reason>", "reason");

task
  .command("run <taskId>")
  .description(
    "Open a run for a task: resolves dependsOn, validates targets, creates the isolated worktrees, moves state to running, starts the event stream. The agent then does the work and closes it with `task complete`."
  )
  .option("--no-worktree", "skip worktree creation (work in the shared checkout)")
  .option("--instruction <text>", "what you are telling this worker — recorded in the run")
  .option("--reopen", "open a repair round on an in-review task (needs --reason)")
  .option("--reason <text>", "why this run is opened — required with --reopen")
  .option("--allow-empty-body", "run a task whose body is still the `task new` template")
  .option("--model <model>", "the model that will actually execute (`opus`, or `codex:gpt-5`), recorded on the run")
  .option("--runtime <runtime>", "the runtime that will actually execute (claude, codex, gemini), recorded on the run")
  .action(
    async (
      taskId: string,
      opts: {
        worktree?: boolean;
        instruction?: string;
        reopen?: boolean;
        reason?: string;
        allowEmptyBody?: boolean;
        model?: string;
        runtime?: string;
      }
    ) => {
      try {
        const r = await runTaskRun(taskId, {
          noWorktree: opts.worktree === false,
          instruction: opts.instruction,
          reopen: opts.reopen,
          reason: opts.reason,
          allowEmptyBody: opts.allowEmptyBody,
          model: opts.model,
          runtime: opts.runtime,
          reuseOpenRun: true,
        });
        if (r.alreadyRunning) {
          // Idempotent: re-typing `task run` is how a worker re-reads its brief.
          console.log(`${r.taskId} is already running — run ${r.runId} (nothing changed)`);
          console.log(`events:  ${r.eventsFile}`);
          for (const c of r.checkouts) {
            console.log(`work in: ${c.path}  (${c.repo}${c.branch ? ` on ${c.branch}` : ""}${c.exists ? "" : " — MISSING on disk"})`);
          }
          if (r.checkouts.length === 0) console.log(`work in: no recorded checkout`);
          console.log(`hand to: ${r.invocation}`);
          console.log(`\n${r.briefFrom ? `(brief unchanged since run ${r.briefFrom})\n` : ""}${r.brief}`);
          console.log(
            `\nA fresh worker taking over should run \`awo task resume ${r.taskId}\` — it records the hand-over and shows the events so far.`
          );
          return;
        }
        console.log(`${r.taskId} is running — run ${r.runId}`);
        if (r.reopenReason) console.log(`reopened: ${r.reopenReason}`);
        else if (r.rejectedBecause) console.log(`rejected in review: ${r.rejectedBecause}`);
        console.log(`agent:   ${r.agent ?? "unassigned"} — ${r.model.tier} tier (from ${r.model.tierSource})`);
        console.log(`model:   ${r.model.runtime}:${r.model.model}${r.model.effort ? ` effort=${r.model.effort}` : ""}${r.model.mode ? ` (${r.model.mode} mode)` : ""}`);
        if (r.executedModel) console.log(`runs as: ${r.executedModel} (recorded as the executed model)`);
        console.log(`targets: ${r.targets.join(", ") || "none"}`);
        console.log(`events:  ${r.eventsFile}`);
        for (const wt of r.worktrees) {
          if (wt.error) {
            console.log(`WARNING: no isolation for ${wt.repo} — ${wt.error}`);
            continue;
          }
          const from = wt.base?.ref ?? wt.basedOn;
          console.log(
            `work in: ${wt.path}  (${wt.repo} on ${wt.branch}${from ? ` from ${from}` : ""}${wt.reused ? ", reused" : ""})`
          );
          for (const w of wt.warnings ?? []) console.log(`  note: ${w}`);
        }
        if (r.targets.length === 0) console.log(`work in: no repository — this task has no targets`);
        else if (r.worktrees.length === 0) console.log(`work in: shared checkout — NO worktree isolation`);
        console.log(`hand to: ${r.invocation}`);
        if (r.fallbackInvocation) console.log(`if quota: ${r.fallbackInvocation}`);
        if (r.body) console.log(`\n${r.body}`);
        console.log(
          `\nMeasure with \`awo task event ${r.taskId} test --run "<cmd>"\`, then close with \`awo task complete ${r.taskId} --summary "…"\`.`
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

task
  .command("resume <taskId>")
  .description(
    "Hand a task's OPEN run to a fresh worker: prints its brief, worktrees, events so far and last measurement per repo, and records the hand-over."
  )
  .action(async (taskId: string) => {
    try {
      const r = await runTaskResume(taskId);
      const was = r.previousOwner
        ? `, held by ${r.previousOwner.actor}${r.previousOwner.pid ? ` (pid ${r.previousOwner.pid} on ${r.previousOwner.host})` : ""}, last seen ${r.previousOwner.heartbeatAt}`
        : "";
      console.log(`${r.taskId} — resuming run ${r.runId} (opened ${r.startedAt ?? "unknown"}${was})`);
      console.log(`now held by ${r.owner.actor}${r.owner.pid ? ` (pid ${r.owner.pid} on ${r.owner.host})` : ""}`);
      for (const c of r.checkouts) {
        console.log(`work in: ${c.path}  (${c.repo}${c.branch ? ` on ${c.branch}` : ""}${c.exists ? "" : " — MISSING on disk"})`);
      }
      if (r.checkouts.length === 0) console.log(`work in: no recorded checkout`);
      const kinds = Object.entries(r.events.byKind).map(([k, n]) => `${k}×${n}`).join(", ");
      console.log(`so far:  ${r.events.total} event(s) — ${kinds || "none"}`);
      for (const line of r.events.recent) console.log(`  ${line}`);
      console.log(`last measurement:`);
      if (r.measurements.length === 0) {
        console.log(`  none yet — measure with \`awo task event ${r.taskId} test --run "<cmd>" --baseline\``);
      }
      for (const m of r.measurements) {
        console.log(
          `  ${m.repo}: \`${m.command ?? "test"}\` exit ${m.exitCode ?? "?"}${m.diagnosis ? ` — ${m.diagnosis}` : ""}${m.needsHuman ? " (needs a human)" : ""}  at ${m.at}`
        );
      }
      console.log(`hand to: ${r.invocation}`);
      console.log(`\n--- brief${r.briefFrom ? ` (unchanged since run ${r.briefFrom})` : ""} ---`);
      console.log(r.brief ?? "(no brief recorded for this run)");
      console.log(
        `\nMeasure with \`awo task event ${r.taskId} test --run "<cmd>"\`, then close with \`awo task complete ${r.taskId} --summary "…"\`.`
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
      else if (r.completionError) console.log(`run left open — closing it was refused:\n${r.completionError}`);
      else console.log(`run left open — close it with \`awo task complete ${r.taskId} --outcome <o>\``);
      if (r.outcome !== "success" || r.completionError) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const taskEvent = task
  .command("event <taskId> <kind>")
  .description(
    "Append a progress event to the task's open run. Kinds: step.start, step.end, repo.diff, test, commit, note. " +
      "A test event is always measured: --run <cmd>, or the repo's declared testCommand."
  )
  .option("--label <label>", "human label for the step")
  .option("--message <message>", "free-text message (note events)")
  .option("--data <json>", "extra JSON fields, e.g. '{\"repo\":\"api\",\"files\":3}'")
  .option(
    "--run <command>",
    "run this command and record what happened (test events default to the repo's testCommand)"
  )
  .option("--baseline", "also run it at the branch point, so a failure can be attributed")
  .option("--repo <name>", "which target repo to run in (default: the task's first target)")
  .option("--checkout <path>", "explicit checkout; otherwise use the recorded task checkout")
  .option("--base <ref>", "explicit comparison base; otherwise use the pinned run baseline")
  .option("--timeout <minutes>", "kill the command after this long (default 30)", (v) => parseInt(v, 10))
  .option("--no-fail", "exit 0 even when the measured command fails (default: exit 3)")
  .action(
    async (
      taskId: string,
      kind: string,
      opts: {
        label?: string;
        message?: string;
        data?: string;
        sha?: string;
        run?: string;
        baseline?: boolean;
        repo?: string;
        timeout?: number;
        checkout?: string;
        base?: string;
        fail?: boolean;
      }
    ) => {
    try {
      const { fail, timeout, ...rest } = opts;
      const r = await runTaskEvent(taskId, kind, { ...rest, timeoutMinutes: timeout });
      if (!r.measured) {
        console.log(`recorded ${kind} for ${taskId}.`);
        return;
      }
      const exit = r.timedOut ? "timed out" : `exit ${r.exitCode}`;
      console.log(`recorded ${kind} for ${taskId} — ${r.diagnosis} (${r.repo}: ${r.command}, ${exit})`);
      if (r.explanation) console.log(`  ${r.explanation}`);
      const c = r.counts;
      if (c && c.parser !== "unknown") {
        const parts = [
          c.cases !== undefined ? `${c.cases} cases` : null,
          c.suites !== undefined ? `${c.suites} suites` : null,
          c.failed !== undefined ? `${c.failed} failed` : null,
          c.skipped ? `${c.skipped} skipped` : null,
        ].filter(Boolean);
        if (parts.length > 0) console.log(`  counts: ${parts.join(", ")} (${c.parser})`);
      }
      if (r.tailLines && r.tailLines.length > 0) {
        console.log("  last output:");
        for (const line of r.tailLines) console.log(`    | ${line}`);
      }
      if (r.needsHuman) {
        console.log(`  this one needs a human: \`awo log tail --task ${r.taskId}\` for the full record`);
      }
      // A measured failure is a failure of this command too, so a script or an
      // agent loop sees it without parsing the text. 3, not 1: awo itself worked.
      if (r.exitCode !== 0 && fail !== false) process.exitCode = 3;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
// Mined from real invocations: agents reach for these spellings far more often than `--help`.
aliasOptions(taskEvent, "message", "--note <text>", "--msg <text>", "--text <text>", "-m <text>");
taskEvent.addOption(new Option("--sha <sha>", "commit sha (commit events)").hideHelp());

task
  .command("recheck <taskId>")
  .description("Attach real evidence to a task that was closed without any. Opens a new run.")
  .option("--run <command>", "command to verify with (default: the repo's testCommand)")
  .option("--baseline", "also run it at the branch point, so a failure can be attributed")
  .option("--repo <name>", "which target repo to run in")
  .option("--checkout <path>", "explicit checkout for verification")
  .option("--base <ref>", "explicit comparison base; otherwise preserve the earlier run base")
  .option("--timeout <minutes>", "kill the command after this long (default 30)", (v) => parseInt(v, 10))
  .action(
    async (
      taskId: string,
      opts: { run?: string; baseline?: boolean; repo?: string; timeout?: number; base?: string; checkout?: string }
    ) => {
      try {
        const r = await runTaskRecheck(taskId, { ...opts, timeoutMinutes: opts.timeout });
        console.log(
          `${r.taskId}: ${r.previousStatus} -> ${r.status} — ${r.diagnosis} (run ${r.runId})`
        );
        if (r.inconclusive) {
          console.log(
            r.diagnosis === "not-runnable"
              ? "  That command could not run at HEAD or at the branch point, so it proves nothing\n" +
                  "  about this task — and the task is now blocked rather than done until a\n" +
                  "  command that actually runs verifies it."
              : "  That command fails at the branch point too, so it proves nothing about this\n" +
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
  .option("--outcome <outcome>", "success | failed | skipped (default: success)")
  .option("--failed", "shorthand for --outcome failed")
  .option("--skipped", "shorthand for --outcome skipped")
  .option("--summary <text>", "what was done (goes in the run log)")
  .option("--prompt <text>", "verbatim user request")
  .option("--interpreted <text>", "the agent's own reading of the request")
  .option("--note <text...>", "deferred items, risks, follow-ups")
  .option("--gate", "route a success to in-review for the QA gate instead of done")
  .option("--untested <why>", "close as success without test evidence, stating why (tests-must-pass)")
  // Commander reserves every `--no-*` flag for boolean negation, so a reasoned
  // exception needs a positive flag name or the supplied string is discarded.
  .option("--unchanged <why>", "implementation intentionally produced no commit or diff")
  .option("--model <model>", "the model that actually did the work, e.g. claude:opus (if not the resolved one)")
  .action(async (taskId: string, opts: Record<string, never>) => {
    try {
      const input = opts as unknown as {
        outcome?: string;
        failed?: boolean;
        skipped?: boolean;
        unchanged?: string;
      };
      const { failed, skipped, unchanged, ...rest } = input;
      const asked = [
        ...new Set([input.outcome, failed ? "failed" : undefined, skipped ? "skipped" : undefined].filter(Boolean)),
      ];
      if (asked.length > 1) {
        throw new Error(`Conflicting outcomes: ${asked.join(" and ")}. Pass one of --outcome, --failed, --skipped.`);
      }
      const r = await runTaskComplete(taskId, { ...rest, outcome: asked[0], noChange: unchanged });
      console.log(`${r.taskId} run ${r.runId} -> ${r.outcome}; task is now ${r.status}.`);
      console.log(`log: ${r.detail}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const taskVerify = task
  .command("verify <taskId>")
  .description("QA gate: approve an in-review task (-> done) or reject it (-> todo).")
  .option("--reject", "send it back to todo instead of approving")
  .option("--reason <reason>", "why — recorded on the transition and shown to the next run")
  .action(async (taskId: string, opts: { reject?: boolean; reason?: string }) => {
    try {
      const to = await runTaskVerify(taskId, { approve: !opts.reject, reason: opts.reason });
      console.log(`${taskId} -> ${to}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
aliasOption(taskVerify, "--why <reason>", "reason");

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

/** Columns padded to their widest cell; the last column is left ragged. */
function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd());
  }
}

function prStateLabel(row: PrSyncRow): string {
  return row.pr.state ?? (row.pr.merged ? "MERGED" : "OPEN");
}

/** `--all`: one compact line per linked PR, then a one-line tally. */
function reportPrTable(rows: PrSyncRow[], withThreads: boolean): void {
  if (rows.length === 0) {
    console.log("No linked PRs in live goals.");
    return;
  }
  const header = ["TASK", "PR", "STATE", "CHECKS", "REVIEWS", "MERGE"];
  if (withThreads) header.push("THREADS", "CREATED");
  header.push("NOTE");
  const body = rows.map((r) => {
    const cells = [r.taskId, `${r.repo}#${r.number}`, prStateLabel(r), r.pr.checks, r.pr.reviews, r.pr.mergeState];
    if (withThreads) cells.push(String(r.unresolved), r.createdTaskIds.join(",") || "-");
    cells.push(r.error ? `ERROR: ${r.error.split("\n")[0]}` : (r.warning ?? r.note ?? ""));
    return cells;
  });
  printTable([header, ...body]);
  const tasks = new Set(rows.map((r) => r.taskId));
  const moved = new Set(rows.filter((r) => r.movedToDone).map((r) => r.taskId));
  const errors = rows.filter((r) => r.error).length;
  console.log(
    `${rows.length} PR(s) across ${tasks.size} task(s); ${moved.size} moved to done` +
      (errors > 0 ? `; ${errors} could not be read` : "")
  );
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
        if (row.requiredAccount && row.accountError) {
          console.log(
            `  ! ${row.repo} must be acted on as ${row.requiredAccount}, but gh is active as ` +
              `${row.activeAccount ?? "unknown"} and has no stored token for it — gh auth login (as ${row.requiredAccount})`
          );
          process.exitCode = 1;
        } else if (row.accountVia === "stored-token") {
          console.log(
            `  account ${row.requiredAccount} via its stored gh token (active account: ` +
              `${row.activeAccount ?? "unknown"}) — as required by ${row.repo}`
          );
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
  .command("link [taskId]")
  .description("Link a task (or with --goal, every task of a goal) to a GitHub PR and refresh it.")
  .option("--repo <repo>", "linked repository name (default: the task's only target)")
  .option("--number <n>", "GitHub PR number (default: the PR whose head is the task's branch)", (v) => parseInt(v, 10))
  .option("--goal <goalId>", "link one goal-branch PR to every live task of this goal that targets --repo")
  .option("--no-meta", "link only: do not set assignee or labels")
  .action(
    async (
      taskId: string | undefined,
      opts: { repo?: string; number?: number; goal?: string; meta?: boolean }
    ) => {
      try {
        const linked = await runPrLink({
          taskId,
          goal: opts.goal,
          repo: opts.repo,
          number: opts.number,
          noMeta: opts.meta === false,
        });
        if (linked.inferredFrom) console.log(`found ${linked.repo}#${linked.number} by head branch ${linked.inferredFrom}`);
        for (const row of linked.linked) {
          console.log(`${row.taskId} -> ${linked.repo}#${linked.number} ${linked.url}`);
          if (row.note) console.log(`  ${row.note}`);
        }
        if (linked.metadata) reportPrMetadata(linked.metadata, taskId ?? opts.goal ?? "");
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

pr
  .command("meta <taskId>")
  .description("Set the linked PR's assignee and labels from the task. Existing labels only.")
  .option("--repo <repo>", "only the PR in this repo (default: every linked PR)")
  .option("--label <name...>", "extra labels on top of the task's own")
  .option("--assignee <login>", "override the assignee (default: the authenticated gh user)")
  .option("--dry-run", "show what would change without touching the PR")
  .action(
    async (taskId: string, opts: { repo?: string; label?: string[]; assignee?: string; dryRun?: boolean }) => {
      try {
        for (const r of await runPrMeta(taskId, opts)) {
          console.log(`${taskId} -> ${r.repo}#${r.number}${opts.dryRun ? " (dry run)" : ""}`);
          reportPrMetadata(r, taskId);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    }
  );

pr
  .command("status [taskId]")
  .description("Refresh linked PR(s): state, checks, reviews, merge state. A merged PR settles its task.")
  .option("--repo <repo>", "only the PR in this repo (default: every linked PR)")
  .option("--all", "every linked PR of every task in live (non-archived) goals")
  .action(async (taskId: string | undefined, opts: { repo?: string; all?: boolean }) => {
    try {
      const rows = await runPrStatus(taskId, opts);
      if (opts.all) {
        reportPrTable(rows, false);
      } else {
        for (const row of rows) {
          if (!row.refreshed) {
            console.error(`${row.repo}#${row.number}\t${row.error}`);
            continue;
          }
          const s = row.pr;
          console.log(`${s.repo}#${s.number}\t${prStateLabel(row)}\tchecks=${s.checks}\treviews=${s.reviews}\tmerge=${s.mergeState}${s.isDraft ? "\tdraft" : ""}`);
          console.log(s.url);
        }
        const note = rows.find((r) => r.note)?.note;
        if (note) console.log(note);
      }
      if (rows.some((r) => r.error)) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("reconcile [taskId]")
  .description("Refresh linked PR(s) and file ONE repair task per PR for new unresolved review threads.")
  .option("--repo <repo>", "only the PR in this repo (default: every linked PR)")
  .option("--all", "every linked PR of every task in live (non-archived) goals")
  .action(async (taskId: string | undefined, opts: { repo?: string; all?: boolean }) => {
    try {
      const rows = await runPrReconcile(taskId, opts);
      if (opts.all) {
        reportPrTable(rows, true);
      } else {
        for (const row of rows) {
          if (!row.refreshed) {
            console.error(`${row.repo}#${row.number}\t${row.error}`);
            continue;
          }
          console.log(`${row.repo}#${row.number}\t${row.unresolved} unresolved review thread(s)`);
          if (row.skipped > 0) console.log(`skipped: ${row.skipped} thread(s) by bots or pullRequests.ignoreAuthors`);
          if (row.createdTaskIds.length > 0) console.log(`created: ${row.createdTaskIds.join(", ")}`);
          if (row.adoptedTaskIds.length > 0) console.log(`linked existing repair task: ${row.adoptedTaskIds.join(", ")}`);
          if (row.warning) console.log(`WARNING: ${row.warning}`);
          if (row.error) console.error(row.error);
        }
        const note = rows.find((r) => r.note)?.note;
        if (note) console.log(note);
      }
      if (rows.some((r) => r.error)) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

pr
  .command("finalize <taskId>")
  .description("Apply the repo's mergePolicy to a completed task's PR(s). AWO never approves; human-only never merges.")
  .option("--repo <repo>", "only the PR in this repo (default: every linked PR)")
  .option("--dry-run", "read-only: reads GitHub, but writes no state, creates no task and merges nothing")
  .action(async (taskId: string, opts: { repo?: string; dryRun?: boolean }) => {
    try {
      const results = await runPrFinalize(taskId, opts);
      const many = results.length > 1;
      for (const result of results) {
        console.log(`${result.action}\t${many ? `${result.repo}#${result.number}\t` : ""}${result.reason}`);
      }
      if (results.some((r) => r.action === "blocked")) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const log = program.command("log").description("Run history and audit trail (§7.3).");

log
  .command("list")
  .description("List runs from the index, most recent first.")
  .option("--task <taskId>", "only runs for this task (and log entries linked to it)")
  .option("--goal <goalId>", "only runs for this goal's tasks (and log entries linked to it)")
  .option("--agent <agent>", "only runs by this agent")
  .option("--repo <repo>", "only runs that touched this repo")
  .option("--status <status>", "only runs with this outcome")
  .option("--tier <tier>", "only runs resolved to this tier (high|standard|low)")
  .option("--effort <effort>", "only runs at this reasoning effort")
  .option("--limit <n>", "only the newest n runs", (v) => Number(v))
  .option("--json", "machine-readable output")
  .action(async (opts: { task?: string; goal?: string; agent?: string; repo?: string; status?: string; tier?: string; effort?: string; limit?: number; json?: boolean }) => {
    try {
      const { json, ...filter } = opts;
      const runs = await runLogList(filter);
      if (json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
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

const logAdd = log
  .command("add [summary]")
  .description(
    "Record work that isn't a task run — intake, planning, an audit pass (§7.3 allows taskId: null)."
  )
  .option("-m, --summary <text>", "what was done (or pass it as the first argument)")
  .option("--agent <agent>", "who did the work — a role from agents/ (default: $AWO_AGENT, else the detected runtime)")
  .option("--label <label>", "short slug for the runId (default: adhoc)")
  .option("--prompt <text>", "the request, verbatim")
  .option("--interpreted <text>", "how it was understood")
  .option("--note <text...>", "follow-ups, risks, open questions (the first doubles as the summary if none is given)")
  .option("--repo <name...>", "repos touched, if any")
  .option("--model <model...>", "model(s) used")
  .option("--outcome <outcome>", "success | failed | skipped (default: success)")
  .option("--task <taskId>", "the task this work was about (linked; it does not become a task run)")
  .option("--goal <goalId>", "the goal this work was about")
  .option("--started <iso>", "when it began, if not now")
  .option("--duration <sec>", "seconds it took", (v) => parseInt(v, 10))
  .action(async (summaryArg: string | undefined, opts: Record<string, unknown>) => {
    try {
      const r = await runLogAdd({
        ...(opts as { agent?: string; summary?: string }),
        summary: (opts.summary as string | undefined) ?? summaryArg,
        startedAt: opts.started as string | undefined,
        durationSec: opts.duration as number | undefined,
      });
      for (const w of r.warnings) console.error(`warning: ${w}`);
      console.log(`recorded ${r.runId} (agent: ${r.agent})`);
      console.log(`log: ${r.detail}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
// The spellings agents reached for in the mined invocations; required options
// would reject these before the alias hook runs, hence the action-side checks.
aliasOptions(logAdd, "label", "--title <text>", "--slug <text>");
aliasOption(logAdd, "--status <outcome>", "outcome");
aliasOption(logAdd, "--message <text>", "summary");

log
  .command("show <runOrTaskId>")
  .description("Print the record of one run — or of a task's latest run; an open run shows its events so far.")
  .action(async (ref: string) => {
    try {
      const r = await runLogShow(ref);
      if (!r.open) {
        console.log(r.detail);
        return;
      }
      console.log(`# ${r.runId} (open — no record until \`awo task complete\`; events so far)`);
      for (const line of formatEvents(r.events, { runId: r.runId, fullBrief: true })) console.log(line);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

log
  .command("tail [runOrTaskId]")
  .description("Print the event stream of the newest run (open runs included), a task's latest run, or a named run.")
  .option("--run <runId>", "a specific run instead of the latest")
  .option("--task <taskId>", "the latest run of this task")
  .action(async (ref: string | undefined, opts: { run?: string; task?: string }) => {
    try {
      const { runId, events, open } = await runLogTail({ runId: opts.run ?? ref, task: opts.task });
      console.log(`# ${runId}${open ? " (open)" : ""}`);
      for (const line of formatEvents(events, { runId })) console.log(line);
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
    .description(`Install or remove ${kind}s (catalog: catalog/${kind}s, installed: ${kind}s/) (§7.1).`);

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

  group
    .command("remove <name>")
    .description(
      kind === "agent"
        ? "Uninstall a role. Refuses while a live task, another role, or AGENTS.md prose still names it."
        : "Delete an awo skill. Refuses while a role's `skills:` or AGENTS.md prose still names it."
    )
    .option("--force", "remove it even though something still references it")
    .action(async (name: string, opts: { force?: boolean }) => {
      try {
        reportRemoval(kind, await runCatalogRemove(kind, name, { force: opts.force }));
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  if (kind === "skill") {
    // External agent skills (§7.2) live under the same noun as the catalog because
    // an agent looking for "another skill" should find one command group, not two.
    group
      .command("external")
      .description("Show external agent skills declared in .workspace/agent-skills.json.")
      .option("--json", "machine-readable declaration plus install state")
      .action(async (opts: { json?: boolean }) => {
        try {
          const skills = await runAgentSkillList();
          if (opts.json) {
            console.log(JSON.stringify(skills, null, 2));
            return;
          }
          if (skills.length === 0) {
            console.log("no external agent skills declared.");
            return;
          }
          for (const s of skills) {
            const state =
              s.installed.where === "workspace"
                ? "installed"
                : s.installed.where === "user"
                  ? "user-global only"
                  : s.installed.where === "partial"
                    ? `partial, missing ${s.installed.missing.join(", ")}`
                    : "not installed";
            const bundle = s.skills.length > 1 ? ` (${s.skills.length} skills)` : "";
            console.log(`${s.tier === "default" ? "*" : " "} ${s.name}${bundle}  [${state}]  ${s.source}`);
            console.log(`    ${s.summary}`);
          }
          console.log("\n* = installed by `awo skill sync`; others need naming explicitly.");
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
        }
      });

    group
      .command("sync [names...]")
      .description("Install declared external agent skills into .claude/skills via the skills CLI.")
      .option("--all", "include catalog-tier skills, not just default-tier")
      .option("--dry-run", "report what would be installed, change nothing")
      .action(async (names: string[], opts: { all?: boolean; dryRun?: boolean }) => {
        try {
          const results = await runAgentSkillSync(names, { all: opts.all, dryRun: opts.dryRun });
          console.log(formatSyncResults(results));
          if (results.some((r) => r.outcome === "failed")) process.exitCode = 1;
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
        }
      });
  }

  if (kind === "agent") {
    group
      .command("org")
      .description("Show installed agent reporting, delegation, review relationships, and task workload.")
      .option("--json", "machine-readable organization graph")
      .option("--all", "count tasks in archived goals too (default: live goals only)")
      .action(async (opts: { json?: boolean; all?: boolean }) => {
        try {
          const result = await runAgentOrg({ includeArchived: opts.all });
          console.log(opts.json ? JSON.stringify(result, null, 2) : formatAgentOrg(result));
          if (result.errors.length > 0) process.exitCode = 1;
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
        }
      });
  }
}

// Command aliases for the verbs agents reach for first ("start" a task, "approve"
// one, spell out "requirement"). Attached here rather than in each command's block
// so the canonical definitions stay the single place a command is described.
task.commands.find((c) => c.name() === "run")?.alias("start");
task.commands.find((c) => c.name() === "verify")?.alias("approve");
req.alias("requirement");

program.parseAsync(process.argv);
