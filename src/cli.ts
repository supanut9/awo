#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runConnect } from "./commands/connect.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";

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

program.parseAsync(process.argv);
