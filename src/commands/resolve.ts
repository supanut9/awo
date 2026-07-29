import { execFile } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { promisify } from "util";
import { findWorkspaceRoot } from "../workspace.js";
import { refreshManagedBlocks } from "../managed-blocks.js";

const run = promisify(execFile);

/**
 * §17.2 — a three-way merge, so an upgrade stops asking about changes that do not
 * overlap.
 *
 * `awo upgrade` used to compare two versions: yours and the template's. Two-way
 * comparison cannot tell "the user added a line" from "the template changed a line",
 * so *any* edit meant a conflict file, forever. Keeping the pristine rendered
 * template from the last reconcile gives a third point, and then the common case —
 * you added a rule, the template reworded a different paragraph — merges silently.
 *
 * `git merge-file` does the merging. Reimplementing diff3 to be slightly worse is
 * not a good use of anyone's afternoon, and git is already a hard dependency.
 */
export function baseDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".workspace", "template-base");
}

export function basePath(workspaceRoot: string, rel: string): string {
  return path.join(baseDir(workspaceRoot), ...rel.split("/"));
}

/** Remember what the template said, so the next upgrade has something to diff from. */
export async function recordBase(workspaceRoot: string, rel: string, rendered: string): Promise<void> {
  const file = basePath(workspaceRoot, rel);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, rendered);
}

export interface MergeOutcome {
  merged: string | null;
  conflicts: number;
  /** True when there was no stored base, so a merge was impossible. */
  unmergeable: boolean;
}

export async function threeWayMerge(
  ours: string,
  base: string | null,
  theirs: string
): Promise<MergeOutcome> {
  if (base === null) return { merged: null, conflicts: 0, unmergeable: true };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "awo-merge-"));
  try {
    const files = {
      ours: path.join(tmp, "ours"),
      base: path.join(tmp, "base"),
      theirs: path.join(tmp, "theirs"),
    };
    await Promise.all([
      fs.writeFile(files.ours, ours),
      fs.writeFile(files.base, base),
      fs.writeFile(files.theirs, theirs),
    ]);

    try {
      // -p prints to stdout instead of editing in place; exit 0 means clean.
      // -L, not --label: git merge-file has no long form, and passing one exits 129
      // (usage error) which is indistinguishable from "129 conflicts" unless you
      // bound the range — which is exactly the bug this comment replaces.
      const { stdout } = await run("git", [
        "merge-file", "-p",
        "-L", "yours", "-L", "template (previous)", "-L", "template (new)",
        files.ours, files.base, files.theirs,
      ]);
      return { merged: stdout, conflicts: 0, unmergeable: false };
    } catch (err) {
      // A positive exit code is the number of conflicts, not a failure to run; the
      // merged text with markers still comes back on stdout.
      // git merge-file exits with the NUMBER OF CONFLICTS, capped at 127. Anything
      // above that is a real error (129 = usage), so the range matters: treating it
      // as a conflict count reports "129 conflicts" and merges nothing.
      const e = err as { code?: number | string; stdout?: string };
      const code = typeof e.code === "number" ? e.code : -1;
      if (code > 0 && code < 128 && typeof e.stdout === "string") {
        return { merged: e.stdout, conflicts: code, unmergeable: false };
      }
      return { merged: null, conflicts: 0, unmergeable: true };
    }
  } finally {
    await fs.remove(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// awo resolve
// ---------------------------------------------------------------------------

export interface Conflict {
  path: string;
  newPath: string;
  diff: string;
  changedLines: number;
}

export async function listConflicts(workspaceRoot: string): Promise<Conflict[]> {
  const found: Conflict[] = [];
  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 2) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (["repos", ".git", "node_modules", "logs"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith(".new")) {
        const original = full.replace(/\.new$/, "");
        const diff = await diffFiles(original, full);
        found.push({
          path: path.relative(workspaceRoot, original),
          newPath: path.relative(workspaceRoot, full),
          diff,
          changedLines: diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
        });
      }
    }
  };
  await walk(workspaceRoot);
  return found;
}

async function diffFiles(a: string, b: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "--no-index", "--unified=2", a, b]);
    return stdout;
  } catch (err) {
    // git diff exits 1 when files differ, which is the entire point of calling it.
    const e = err as { stdout?: string };
    return typeof e.stdout === "string" ? e.stdout : "(could not diff)";
  }
}

export interface ResolveResult {
  resolved: { path: string; took: "theirs" | "yours" }[];
  remaining: Conflict[];
}

export async function runResolve(options: {
  cwd?: string;
  file?: string;
  theirs?: boolean;
  yours?: boolean;
}): Promise<ResolveResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const conflicts = await listConflicts(root);

  if (!options.theirs && !options.yours) return { resolved: [], remaining: conflicts };
  if (options.theirs && options.yours) {
    throw new Error("pass one of --theirs or --yours, not both.");
  }

  const targets = options.file
    ? conflicts.filter((c) => c.path === options.file || c.newPath === options.file)
    : conflicts;
  if (options.file && targets.length === 0) {
    throw new Error(
      `No unresolved conflict for "${options.file}".` +
        (conflicts.length > 0 ? ` Open ones: ${conflicts.map((c) => c.path).join(", ")}.` : "")
    );
  }

  const resolved: ResolveResult["resolved"] = [];
  for (const c of targets) {
    const original = path.join(root, c.path);
    const incoming = path.join(root, c.newPath);

    if (options.theirs) {
      // The .new is the raw rendered template, so its generated blocks are empty.
      // Taking it verbatim would silently blank the rules list — record it as the
      // base first (it IS what the template says), then let generation refill it.
      await recordBase(root, c.path, await fs.readFile(incoming, "utf8"));
      await fs.move(incoming, original, { overwrite: true });
    } else {
      // Keeping yours still advances the base: the next upgrade must diff against
      // what the template said this time, or it will re-ask the same question.
      await recordBase(root, c.path, await fs.readFile(incoming, "utf8"));
      await fs.remove(incoming);
    }
    resolved.push({ path: c.path, took: options.theirs ? "theirs" : "yours" });
  }

  if (resolved.length > 0) await refreshManagedBlocks(root);

  return { resolved, remaining: await listConflicts(root) };
}
