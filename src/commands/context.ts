import { findWorkspaceRoot } from "../workspace.js";
import { FileReader } from "../ui/reader.js";
import { readLibraryVersion } from "../template.js";
import { resolveOrchestrator } from "../models.js";
import type { Snapshot } from "../ui/reader.js";
import type { RunIndexEntry } from "../runs.js";

export interface ContextResult {
  snapshot: Snapshot;
  installedVersion: string;
  orchestrator: string;
  looseRequirements: string[];
  recent: RunIndexEntry[];
  next: string;
}

/**
 * §13 — a compact, always-current orientation digest for a session that has just
 * started.
 *
 * Deliberately **derived, never stored.** A `CONTEXT.md` that agents maintain would
 * be a second source of truth for state that already lives in the manifest,
 * `state.json` and the run index — and it would rot exactly like a stale comment,
 * with no way to tell that it had. §3.1's rule (derived artifacts, one source of
 * truth) applies to summaries too. The token saving is real but comes from *not
 * scanning*, not from caching: one command reads the few files that matter and
 * prints ~20 lines, instead of an agent globbing the tree to work it out.
 */
export async function runContext(options: { cwd?: string } = {}): Promise<ContextResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const reader = new FileReader(root);

  const snapshot = await reader.snapshot();
  const orchestrator = await resolveOrchestrator(root);

  // Requirements still sitting in intake — invisible on the board, so a new
  // session would otherwise never learn they exist.
  const fs = await import("fs-extra");
  const path = await import("path");
  const looseRequirements = (
    await fs.default.readdir(path.default.join(root, "requirements")).catch(() => [])
  )
    .filter((f: string) => f.endsWith(".md"))
    .map((f: string) => f.replace(/\.md$/, ""));

  const tasks = snapshot.goals.flatMap((g) => g.tasks);
  const blocked = tasks.filter((t) => t.status === "blocked");
  const running = tasks.filter((t) => t.status === "running");
  const review = tasks.filter((t) => t.status === "in-review");
  const todo = tasks.filter((t) => t.status === "todo");

  // The single most useful line: what a session should actually do next.
  let next: string;
  if (running.length > 0) {
    next = `${running[0].id} is running — close it with \`awo task complete ${running[0].id} --outcome <success|failed>\``;
  } else if (review.length > 0) {
    next = `verify ${review[0].id} — \`awo task verify ${review[0].id}\``;
  } else if (blocked.length > 0) {
    next = `unblock ${blocked[0].id} (${blocked[0].blockedReason ?? "no reason recorded"}) — \`awo task status ${blocked[0].id} todo\``;
  } else if (todo.length > 0) {
    next = `start ${todo[0].id} — \`awo task run ${todo[0].id}\``;
  } else if (looseRequirements.length > 0) {
    next = `turn ${looseRequirements[0]} into a goal — \`awo goal new --from ${looseRequirements[0]}\``;
  } else if (snapshot.goals.length === 0) {
    next = `nothing planned yet — \`awo req new --title "…"\``;
  } else {
    next = "all tasks are done — verify the goal's definition-of-done";
  }

  return {
    snapshot,
    installedVersion: readLibraryVersion(),
    orchestrator: `${orchestrator.runtime}:${orchestrator.model}`,
    looseRequirements,
    recent: snapshot.runs.slice(0, 3),
    next,
  };
}

/** ~20 lines an agent can read instead of scanning the tree. */
export function formatContext(c: ContextResult): string {
  const { project, repos, goals, stats } = c.snapshot;
  const lines: string[] = [];

  const skew =
    project.libraryVersion === c.installedVersion
      ? ""
      : `  (workspace ${project.libraryVersion}, cli ${c.installedVersion})`;
  lines.push(`${project.projectKey} · ${project.projectName} · awo ${c.installedVersion}${skew}`);
  lines.push(`orchestrator  ${c.orchestrator}`);

  const present = repos.filter((r) => r.status === "present").length;
  const bad = repos.filter((r) => r.status !== "present");
  lines.push(
    `repos         ${repos.length} linked, ${present} present${bad.length ? ` — ATTENTION: ${bad.map((r) => `${r.name}:${r.status}`).join(", ")}` : ""}`
  );

  if (goals.length === 0) lines.push("goals         none yet");
  for (const g of goals) {
    const done = g.tasks.filter((t) => t.status === "done").length;
    lines.push(`goal          ${g.id} ${g.status} — ${done}/${g.tasks.length} done · ${g.title}`);
  }

  const byStatus = Object.entries(stats.byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (byStatus) lines.push(`tasks         ${byStatus}`);

  for (const g of goals) {
    for (const t of g.tasks.filter((x) => x.status === "blocked" || x.status === "running")) {
      lines.push(
        `              ${t.id} ${t.status}${t.blockedReason ? ` — ${t.blockedReason}` : ""}`
      );
    }
  }

  if (c.looseRequirements.length > 0) {
    lines.push(`in intake     ${c.looseRequirements.join(", ")} (not yet a goal)`);
  }

  if (c.recent.length === 0) {
    lines.push("recent runs   none");
  } else {
    for (const r of c.recent) {
      const how = [r.tier, r.effort ? `effort=${r.effort}` : null, r.attempts && r.attempts > 1 ? `try#${r.attempts}` : null]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `run           ${r.taskId ?? r.agent ?? "adhoc"} ${r.status}${how ? ` ${how}` : ""}${r.durationSec !== null ? ` ${r.durationSec}s` : ""}`
      );
    }
  }

  if (stats.totalRuns > 0 && stats.successRate !== null) {
    lines.push(
      `history       ${stats.totalRuns} runs · ${Math.round(stats.successRate * 100)}% success`
    );
  }

  lines.push(`NEXT          ${c.next}`);
  return lines.join("\n");
}
