import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { FileReader } from "../ui/reader.js";
import { workerLogFile } from "../runs.js";
import { runAgentOrg } from "./agent-org.js";

/**
 * §7.6 — optional publishing of a workspace's state to MongoDB, so a hosted
 * dashboard can show projects that are not on the viewer's machine.
 *
 * Governed by §3.8: local stays canonical, this is an **opt-in push of a
 * projection**, never a mirror and never blocking. A workspace with no publish
 * config makes no network calls at all — no account, no telemetry.
 *
 * The connection string is supplied by the user (their cluster, their data). That
 * was their explicit choice; the caveat recorded in §7.6 stands — a URI grants far
 * more than "write these four collections", so use a least-privilege user scoped to
 * one database.
 */
export interface PublishConfig {
  database: string;
  /** Prefix so a shared cluster can host several tools without collision. */
  collectionPrefix: string;
  /**
   * `summary` — statuses, counts and model/tier/effort only. Nothing describing
   * the work itself leaves the machine.
   * `full` — additionally the requirement/goal/task **bodies**, each run's
   * markdown record and its event stream, so a hosted dashboard can show what the
   * local one does. That prose describes private code and private prompts, so it
   * is opt-in rather than the default.
   */
  detail: "summary" | "full";
  redact: { prompts: boolean; filePaths: boolean };
}

export interface PublishResult {
  workspaceId: string;
  database: string;
  detail: "summary" | "full";
  counts: { requirements: number; goals: number; tasks: number; runs: number; events: number; agents: number };
  /**
   * What the active redaction settings actually withheld.
   *
   * Reported because this is how a privacy control is kept honest. `redact.filePaths`
   * read `config.redact.filePaths ? r.reposChanged : r.reposChanged` — both branches
   * identical — so the flag did nothing at all, and nothing in the output would ever
   * have said so.
   */
  redacted: { workerLogs: number; outputTails: number; prompts: number };
  dryRun: boolean;
  uriHost: string | null;
}

const DEFAULTS: PublishConfig = {
  database: "awo",
  collectionPrefix: "awo_",
  // §7.6 — statuses and counts travel by default; prose about private code does not.
  detail: "summary",
  redact: { prompts: true, filePaths: true },
};

/** The URI lives in credentials/, gitignored, per-machine (§3.7's one exception). */
export function credentialPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".workspace", "credentials", "mongo.env");
}

export async function readPublishConfig(
  workspaceRoot: string
): Promise<{ config: PublishConfig; uri: string | null }> {
  const manifest = await readManifest(workspaceRoot);
  const declared = (manifest.publish ?? {}) as Partial<PublishConfig>;
  const config: PublishConfig = {
    database: declared.database ?? DEFAULTS.database,
    collectionPrefix: declared.collectionPrefix ?? DEFAULTS.collectionPrefix,
    detail: declared.detail === "full" ? "full" : DEFAULTS.detail,
    redact: { ...DEFAULTS.redact, ...(declared.redact ?? {}) },
  };

  const file = credentialPath(workspaceRoot);
  if (!(await fs.pathExists(file))) return { config, uri: null };

  const raw = await fs.readFile(file, "utf8");
  const match = raw.match(/^\s*(?:MONGO_URI|MONGODB_URI)\s*=\s*(.+)$/m);
  const uri = match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
  return { config, uri };
}

/** Host only — never log or print a URI, it carries credentials. */
function hostOf(uri: string): string | null {
  try {
    return new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"))
      .host;
  } catch {
    return null;
  }
}

/**
 * Auto-sync. §3.8 requires publishing to be non-blocking, so this is a *watcher*
 * rather than a hook inside the commands: nothing in `task run` or `task complete`
 * waits on the network, and a dead connection degrades the dashboard, never the
 * work. Changes are debounced because one run writes state.json, an event line and
 * an index line within a second of each other.
 */
export async function runPublishWatch(options: {
  cwd?: string;
  debounceMs?: number;
  onPublish?: (r: PublishResult | Error) => void;
}): Promise<{ stop: () => Promise<void> }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { default: chokidar } = await import("chokidar");

  const watcher = chokidar.watch(
    [
      path.join(root, "goals"),
      path.join(root, "requirements"),
      path.join(root, "logs", "runs.jsonl"),
      path.join(root, ".workspace", "manifest.json"),
    ],
    { ignoreInitial: true, ignored: /\.tmp$/ }
  );

  let pending: NodeJS.Timeout | null = null;
  let inFlight = false;
  const trigger = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      // Never overlap: a slow publish must not queue up behind itself and turn a
      // burst of edits into a pile of concurrent connections.
      if (inFlight) {
        trigger();
        return;
      }
      inFlight = true;
      try {
        options.onPublish?.(await runPublish({ cwd: root }));
      } catch (err) {
        // A failed push is reported, never thrown: it must not kill the watcher.
        options.onPublish?.(err as Error);
      } finally {
        inFlight = false;
      }
    }, options.debounceMs ?? 2000);
  };

  watcher.on("all", trigger);
  return {
    stop: async () => {
      if (pending) clearTimeout(pending);
      await watcher.close();
    },
  };
}

export async function runPublish(
  options: { cwd?: string; dryRun?: boolean } = {}
): Promise<PublishResult> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const manifest = await readManifest(root);
  const { config, uri } = await readPublishConfig(root);

  if (!manifest.workspaceId) {
    throw new Error(
      "This workspace has no workspaceId, so a shared store cannot key it (§5). Run `awo upgrade` to backfill one."
    );
  }
  if (!uri && !options.dryRun) {
    throw new Error(
      `No connection string. Put one in ${path.relative(root, credentialPath(root))} as:\n` +
        `  MONGO_URI=mongodb+srv://…\n` +
        `That path is gitignored and per-machine. Publishing stays off until it exists.`
    );
  }

  const [snapshot, organization] = await Promise.all([new FileReader(root).snapshot(), runAgentOrg({ cwd: root })]);

  // A projection, not the files. Keyed on workspaceId because projectKey collides
  // across users (§5).
  const wid = manifest.workspaceId;
  const project = {
    _id: wid,
    workspaceId: wid,
    projectKey: snapshot.project.projectKey,
    projectName: snapshot.project.projectName,
    libraryVersion: snapshot.project.libraryVersion,
    repos: snapshot.repos.map((r) => ({ name: r.name, type: r.type, status: r.status })),
    stats: snapshot.stats,
    updatedAt: new Date().toISOString(),
  };

  const full = config.detail === "full";
  const reader = new FileReader(root);

  // `full` carries the prose a hosted dashboard needs to be useful: the goal's
  // definition-of-done, the requirement it came from, each task's objective and
  // steps, every run's markdown record and its event stream.
  const goalBodies = new Map<string, { goal: string; requirement: string }>();
  if (full) {
    const { findGoals } = await import("../tasks.js");
    for (const g of await findGoals(root)) {
      const read = async (f: string): Promise<string> =>
        (await fs.pathExists(path.join(g.dir, f)))
          ? await fs.readFile(path.join(g.dir, f), "utf8")
          : "";
      goalBodies.set(g.id, { goal: await read("goal.md"), requirement: await read("requirement.md") });
    }
  }

  const goals = snapshot.goals.map((g) => ({
    _id: `${wid}:${g.id}`,
    workspaceId: wid,
    goalId: g.id,
    title: g.title,
    status: g.status,
    taskIds: g.tasks.map((t) => t.id),
    ...(full
      ? {
          body: goalBodies.get(g.id)?.goal ?? "",
          requirementBody: goalBodies.get(g.id)?.requirement ?? "",
        }
      : {}),
  }));

  // Requirement state is useful to a hosted reviewer even with summary detail: it
  // shows what is waiting for a human decision without publishing the criterion
  // prose. The full body is an explicit opt-in, just like goal and task bodies.
  const requirements = await Promise.all(
    snapshot.requirements.map(async (r) => ({
      _id: `${wid}:${r.id}`,
      workspaceId: wid,
      requirementId: r.id,
      title: r.title,
      status: r.status,
      source: r.source,
      goalId: r.goalId,
      criteria: r.criteria,
      ...(full ? { body: await fs.readFile(path.join(root, r.file), "utf8").catch(() => "") } : {}),
    }))
  );

  const tasks = snapshot.goals.flatMap((g) =>
    g.tasks.map((t) => ({
      _id: `${wid}:${t.id}`,
      workspaceId: wid,
      goalId: g.id,
      taskId: t.id,
      name: t.name,
      status: t.status,
      agent: t.agent,
      kind: t.kind,
      targets: t.targets,
      lastRunOutcome: t.lastRunOutcome,
      lastRunId: t.lastRunId,
      attempts: t.attempts,
      blockedReason: t.blockedReason,
    }))
  );

  // Relationship fields are deliberately summary-safe: they explain handoffs but
  // confer no authority. Agent prose remains full-detail only in the workspace.
  const agents = organization.agents.map((agent) => ({
    _id: `${wid}:${agent.id}`,
    workspaceId: wid,
    agentId: agent.id,
    tier: agent.tier,
    reportsTo: agent.reportsTo,
    delegatesTo: agent.delegatesTo,
    reviews: agent.reviews,
    taskCount: agent.taskCount,
    openTasks: agent.openTasks,
  }));

  if (full) {
    // Task bodies come from the reader so the hosted view sees exactly what the
    // local drawer shows, rather than a second parse of the same files.
    for (const t of tasks) {
      const detail = await reader.task(t.taskId).catch(() => null);
      if (detail) {
        (t as Record<string, unknown>).body = detail.body;
        (t as Record<string, unknown>).dependsOn = detail.dependsOn;
        (t as Record<string, unknown>).file = detail.file;
      }
    }
  }

  const runs = snapshot.runs.map((r) => ({
    _id: `${wid}:${r.runId}`,
    workspaceId: wid,
    runId: r.runId,
    taskId: r.taskId,
    agent: r.agent,
    tier: r.tier ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    attempts: r.attempts ?? null,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationSec: r.durationSec,
    // Repo names are structural, so they travel either way. `redact.filePaths` is
    // about paths WITHIN a repo — and this line used to read
    // `config.redact.filePaths ? r.reposChanged : r.reposChanged`, both branches
    // identical, so the flag did nothing here at all. It applies where paths
    // actually appear: the run's markdown record, below.
    reposChanged: r.reposChanged,
  }));

  // One document per run holding its markdown record and event stream. Kept out of
  // the run index docs so a board query never drags the prose along with it.
  const events: Record<string, unknown>[] = [];
  const redacted = { workerLogs: 0, outputTails: 0, prompts: 0 };
  if (full) {
    for (const r of snapshot.runs) {
      const [stream, markdown, workerLog] = await Promise.all([
        reader.runEvents(r.runId).catch(() => []),
        reader.runDetail(r.runId).catch(() => ""),
        readWorkerLog(root, r.runId),
      ]);
      if (config.redact.filePaths) {
        if (workerLog) redacted.workerLogs += 1;
        redacted.outputTails += stream.filter((e) => typeof e.tail === "string").length;
      }
      if (config.redact.prompts && markdown !== stripPrompt(markdown)) redacted.prompts += 1;

      events.push({
        _id: `${wid}:${r.runId}`,
        workspaceId: wid,
        runId: r.runId,
        taskId: r.taskId,
        events: config.redact.filePaths ? stream.map(stripOutputTail) : stream,
        markdown: config.redact.prompts ? stripPrompt(markdown) : markdown,
        // A dispatched worker's stdout is the only record of *how* it reached its
        // answer, and the first thing you want when a run went wrong. Absent for
        // runs a human drove — and withheld under `redact.filePaths`, because raw
        // stdout is nothing but paths, stack traces and source excerpts.
        ...(workerLog && !config.redact.filePaths ? { workerLog } : {}),
      });
    }
  }

  const result: PublishResult = {
    workspaceId: wid,
    database: config.database,
    detail: config.detail,
    counts: {
      requirements: requirements.length,
      goals: goals.length,
      tasks: tasks.length,
      runs: runs.length,
      events: events.length,
      agents: agents.length,
    },
    redacted,
    dryRun: Boolean(options.dryRun),
    uriHost: uri ? hostOf(uri) : null,
  };

  if (options.dryRun) return result;

  // Imported lazily so a workspace that never publishes never loads the driver.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const db = client.db(config.database);
    const c = (name: string): string => `${config.collectionPrefix}${name}`;

    await db.collection(c("projects")).replaceOne({ _id: wid } as never, project as never, {
      upsert: true,
    });
    // Indexes, created idempotently on every publish: without them every dashboard
    // query is a collection scan, and nobody is going to run createIndex by hand.
    await Promise.all([
      db.collection(c("goals")).createIndex({ workspaceId: 1, goalId: 1 }),
      db.collection(c("requirements")).createIndex({ workspaceId: 1, requirementId: 1 }),
      db.collection(c("tasks")).createIndex({ workspaceId: 1, status: 1 }),
      db.collection(c("runs")).createIndex({ workspaceId: 1, runId: -1 }),
      db.collection(c("events")).createIndex({ workspaceId: 1, runId: 1 }),
      db.collection(c("agents")).createIndex({ workspaceId: 1, agentId: 1 }),
      db.collection(c("projects")).createIndex({ updatedAt: -1 }),
    ]).catch(() => undefined);

    for (const [name, docs] of [
      ["requirements", requirements],
      ["goals", goals],
      ["tasks", tasks],
      ["runs", runs],
      ["events", events],
      ["agents", agents],
    ] as const) {
      if (docs.length === 0) continue;
      await db.collection(c(name)).bulkWrite(
        docs.map((d) => ({
          replaceOne: { filter: { _id: d._id } as never, replacement: d as never, upsert: true },
        }))
      );
    }
    // Rows for tasks/goals that no longer exist would otherwise linger forever.
    await db
      .collection(c("tasks"))
      .deleteMany({ workspaceId: wid, taskId: { $nin: tasks.map((t) => t.taskId) } } as never);
    await db
      .collection(c("goals"))
      .deleteMany({ workspaceId: wid, goalId: { $nin: goals.map((g) => g.goalId) } } as never);
    await db
      .collection(c("requirements"))
      .deleteMany({ workspaceId: wid, requirementId: { $nin: requirements.map((r) => r.requirementId) } } as never);
    await db
      .collection(c("agents"))
      .deleteMany({ workspaceId: wid, agentId: { $nin: agents.map((agent) => agent.agentId) } } as never);
  } finally {
    await client.close().catch(() => undefined);
  }

  return result;
}

/**
 * Remove the verbatim request from a run record. The prompt is the most likely
 * place for something the author would not choose to send to a shared cluster.
 */
/**
 * The tail of a dispatched worker's output, capped.
 *
 * Capped rather than complete because a chatty worker can emit megabytes and
 * Mongo's document limit is 16MB — one run must never be able to fail the whole
 * publish. The tail is the useful end: it holds the failure and the summary.
 */
const WORKER_LOG_MAX = 256 * 1024;

async function readWorkerLog(root: string, runId: string): Promise<string> {
  const file = workerLogFile(root, runId);
  try {
    const { size } = await fs.stat(file);
    const text = await fs.readFile(file, "utf8");
    if (size <= WORKER_LOG_MAX) return text;
    return `[…truncated — showing the last ${Math.round(WORKER_LOG_MAX / 1024)}KB of ${Math.round(size / 1024)}KB]\n\n${text.slice(-WORKER_LOG_MAX)}`;
  } catch {
    return "";
  }
}

/**
 * Drop the captured command output from a measurement event.
 *
 * `tail` is the failing end of a test run — stack traces, source excerpts and the
 * paths of every file involved. It is the one field in the event stream that carries
 * file paths mechanically rather than because an agent happened to type one, which
 * makes it what `redact.filePaths` is for.
 *
 * What this does NOT scrub is prose: a summary an agent wrote may name a file, and no
 * pattern match on free text can be trusted to catch that. Withhold prose with
 * `detail: "summary"`, which sends no bodies at all.
 */
function stripOutputTail(event: Record<string, unknown>): Record<string, unknown> {
  if (typeof event.tail !== "string") return event;
  const { tail: _tail, ...rest } = event;
  return { ...rest, tailRedacted: true };
}

function stripPrompt(markdown: string): string {
  return markdown.replace(
    /## User prompt\n[\s\S]*?(?=\n## )/,
    "## User prompt\n_redacted — set publish.redact.prompts to false to include it_\n\n"
  );
}
