import fs from "fs-extra";
import os from "os";
import path from "path";
import type { Db } from "mongodb";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { FileReader } from "../ui/reader.js";
import { workerLogFile } from "../runs.js";
import { readState, type GoalStatus } from "../state.js";
import { findGoals } from "../tasks.js";
import { redactSecrets } from "../redact.js";
import { runAgentOrg } from "./agent-org.js";

/**
 * The shape of every published document, stamped on each one.
 *
 * A hosted reader cannot tell "this field is absent because the workspace has none"
 * from "this field is absent because an older awo never wrote it" — the dashboard
 * guessed from emptiness, and an empty requirements list read as "update awo".
 * Absent means 1 (everything before 0.8). Bump it whenever a reader would need to
 * know: 2 added suspended/cancelled requirements, goal `archived`/`archivedStatus`,
 * run `finishedAt`, field-aware redaction and the summary-after-full purge.
 */
export const PROJECTION_VERSION = 2;

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
  redacted: {
    workerLogs: number;
    outputTails: number;
    /** Runs whose brief, orchestrator instruction or recorded user prompt was withheld. */
    prompts: number;
    /** Local checkout/worktree path fields withheld. */
    checkoutPaths: number;
    /** String fields in which a credential was masked. Always on, whatever the detail. */
    secrets: number;
  };
  /**
   * Event documents deleted because this `summary` publish followed a `full` one.
   * Replacing the other collections drops their prose naturally; event documents are
   * not rewritten at summary detail, so without this they would keep serving the
   * prose the workspace just stopped sharing.
   */
  purgedEvents: number;
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
  // Only an explicit `false` turns a redaction off. Spreading the declared object
  // let `"prompts": null` (or a hand-edited typo of the type) silently disable it.
  const declaredRedact = (typeof declared.redact === "object" && declared.redact !== null
    ? declared.redact
    : {}) as Partial<Record<keyof PublishConfig["redact"], unknown>>;
  const config: PublishConfig = {
    database: declared.database ?? DEFAULTS.database,
    collectionPrefix: declared.collectionPrefix ?? DEFAULTS.collectionPrefix,
    detail: declared.detail === "full" ? "full" : DEFAULTS.detail,
    redact: {
      prompts: declaredRedact.prompts === false ? false : DEFAULTS.redact.prompts,
      filePaths: declaredRedact.filePaths === false ? false : DEFAULTS.redact.filePaths,
    },
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
 * What `publish --watch` listens to.
 *
 * `logs/` as a directory, not a file: runs are recorded in `logs/<date>/runs.jsonl`,
 * one folder per day, and the watcher used to name `logs/runs.jsonl` — a layout
 * retired long ago — so no completed run ever triggered a sync. Watching the folder
 * is also what picks up tomorrow's day directory, which does not exist yet when the
 * watcher starts.
 */
export function publishWatchTargets(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, "goals"),
    path.join(workspaceRoot, "requirements"),
    path.join(workspaceRoot, "logs"),
    path.join(workspaceRoot, ".workspace", "manifest.json"),
  ];
}

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** What a day folder holds that the projection reads: run rows/events and records. */
const DAY_FILES = new Set(["runs.jsonl", "runs.md"]);

/**
 * True for a path the watcher must not react to.
 *
 * Under `logs/` only a day folder and its `runs.jsonl`/`runs.md` matter. Worker
 * stdout (`logs/<date>/workers/`) is streamed while a dispatched worker runs and
 * would turn every line of its output into a publish; anything else there (QA
 * briefs, legacy layouts) is not part of the projection. Returning true for a
 * directory also stops chokidar descending into it.
 */
export function isIgnoredByPublishWatch(workspaceRoot: string, file: string): boolean {
  if (file.endsWith(".tmp")) return true;
  const rel = path.relative(path.join(workspaceRoot, "logs"), file);
  if (rel === "") return false;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (!DAY_DIR.test(parts[0])) return true;
  if (parts.length === 1) return false;
  return parts.length > 2 || !DAY_FILES.has(parts[1]);
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
  /** Rebuild the projection on every change without connecting (`--watch --dry-run`). */
  dryRun?: boolean;
  onPublish?: (r: PublishResult | Error) => void;
}): Promise<{ stop: () => Promise<void>; ready: Promise<void> }> {
  const root = findWorkspaceRoot(options.cwd ?? process.cwd());
  const { default: chokidar } = await import("chokidar");

  const watcher = chokidar.watch(publishWatchTargets(root), {
    ignoreInitial: true,
    ignored: (file: string) => isIgnoredByPublishWatch(root, file),
  });
  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

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
        options.onPublish?.(await runPublish({ cwd: root, dryRun: options.dryRun }));
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
    ready,
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

  const wid = manifest.workspaceId;
  const projection = await buildProjection(root, wid, config);
  const result: PublishResult = {
    workspaceId: wid,
    database: config.database,
    detail: config.detail,
    counts: {
      requirements: projection.requirements.length,
      goals: projection.goals.length,
      tasks: projection.tasks.length,
      runs: projection.runs.length,
      events: projection.events.length,
      agents: projection.agents.length,
    },
    redacted: projection.redacted,
    purgedEvents: 0,
    dryRun: Boolean(options.dryRun),
    uriHost: uri ? hostOf(uri) : null,
  };

  if (options.dryRun) return result;

  // Imported lazily so a workspace that never publishes never loads the driver.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const written = await writeProjection(client.db(config.database), config, projection);
    result.purgedEvents = written.purgedEvents;
  } finally {
    await client.close().catch(() => undefined);
  }

  return result;
}

type Doc = Record<string, unknown> & { _id: string; workspaceId: string; projectionVersion: number };

/** Everything one publish sends, already redacted. */
export interface Projection {
  workspaceId: string;
  detail: PublishConfig["detail"];
  project: Doc;
  requirements: Doc[];
  goals: Doc[];
  tasks: Doc[];
  runs: Doc[];
  events: Doc[];
  agents: Doc[];
  redacted: PublishResult["redacted"];
}

/**
 * Build the documents a publish would send, without connecting. Exported so the
 * projection can be inspected (and tested) exactly as it would leave the machine.
 */
export async function buildProjection(
  root: string,
  wid: string,
  config: PublishConfig
): Promise<Projection> {
  const [snapshot, organization] = await Promise.all([new FileReader(root).snapshot(), runAgentOrg({ cwd: root })]);

  // A projection, not the files. Keyed on workspaceId because projectKey collides
  // across users (§5).
  const project = {
    _id: wid,
    workspaceId: wid,
    projectKey: snapshot.project.projectKey,
    projectName: snapshot.project.projectName,
    libraryVersion: snapshot.project.libraryVersion,
    // Lets a reader tell "no bodies because summary" from "no bodies yet".
    detail: config.detail,
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
  // `archivedStatus` is frozen in state.json at archive time, so later
  // reconciliation cannot rewrite how the goal actually ended. Read only for
  // archived goals: on a live (restored) goal a leftover value would be stale.
  const archive = new Map<string, { status: GoalStatus | null; at: string | null }>();
  for (const g of await findGoals(root)) {
    if (g.archived) {
      const state = await readState(g.dir, g.id).catch(() => null);
      archive.set(g.id, { status: state?.archivedStatus ?? null, at: state?.archivedAt ?? null });
    }
    if (full) {
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
    archived: g.archived,
    archivedStatus: g.archived ? archive.get(g.id)?.status ?? null : null,
    archivedAt: g.archived ? archive.get(g.id)?.at ?? null : null,
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
      archived: r.archived,
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
    finishedAt: r.finishedAt ?? null,
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
  const redacted: PublishResult["redacted"] = {
    workerLogs: 0,
    outputTails: 0,
    prompts: 0,
    checkoutPaths: 0,
    secrets: 0,
  };
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

      events.push({
        _id: `${wid}:${r.runId}`,
        workspaceId: wid,
        runId: r.runId,
        taskId: r.taskId,
        events: config.redact.filePaths ? stream.map(stripOutputTail) : stream,
        // The record's "User prompt" section is withheld by the field-aware pass
        // below, together with the brief and the orchestrator instruction.
        markdown,
        // A dispatched worker's stdout is the only record of *how* it reached its
        // answer, and the first thing you want when a run went wrong. Absent for
        // runs a human drove — and withheld under `redact.filePaths`, because raw
        // stdout is nothing but paths, stack traces and source excerpts.
        ...(workerLog && !config.redact.filePaths ? { workerLog } : {}),
      });
    }
  }

  // Redaction runs last, over every document, so no field can be added above and
  // reach the cluster unexamined.
  const policy = redactionPolicy(config, root);
  const finish = (doc: Record<string, unknown>): Doc =>
    sanitizeDocument({ ...doc, projectionVersion: PROJECTION_VERSION } as Doc, policy, redacted);

  return {
    workspaceId: wid,
    detail: config.detail,
    project: finish(project),
    requirements: requirements.map(finish),
    goals: goals.map(finish),
    tasks: tasks.map(finish),
    runs: runs.map(finish),
    events: events.map(finish),
    agents: agents.map(finish),
    redacted,
  };
}

/** The subset of the driver this module writes through — a seam for tests. */
export type ProjectionStore = Pick<Db, "collection">;

/**
 * Write a projection. Replace-by-id for every document, then delete what the
 * workspace no longer has, so the hosted copy converges on the local one.
 */
export async function writeProjection(
  db: ProjectionStore,
  config: PublishConfig,
  projection: Projection
): Promise<{ purgedEvents: number }> {
  const wid = projection.workspaceId;
  const { project, requirements, goals, tasks, runs, events, agents } = projection;
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

  // Event documents are the only full-detail rows that a summary publish does not
  // overwrite. Switching `detail` back to summary is a decision to stop sharing that
  // prose, so the copies already on the cluster go too — deliberately, and counted
  // so the CLI can say it happened. Under `full`, only runs that no longer exist go.
  const purge = await db
    .collection(c("events"))
    .deleteMany(
      (projection.detail === "full"
        ? { workspaceId: wid, runId: { $nin: events.map((e) => e.runId) } }
        : { workspaceId: wid }) as never
    );
  return { purgedEvents: projection.detail === "full" ? 0 : purge.deletedCount ?? 0 };
}

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

/**
 * Remove the verbatim request from a run record. The prompt is the most likely
 * place for something the author would not choose to send to a shared cluster.
 *
 * Matches `##` and `###`, up to the next heading or the end. The record has written
 * `### User prompt` since runs moved into day files, and this used to look for
 * `## User prompt` followed by another `## ` heading — which a single extracted
 * record never contains — so the prompt was published verbatim with
 * `redact.prompts` on, and the "withheld" count said 0.
 */
export function stripPrompt(markdown: string): string {
  const heading = /^(#{2,3}) User prompt[ \t]*$/m.exec(markdown);
  if (!heading) return markdown;
  const level = heading[1];
  const bodyStart = heading.index + heading[0].length;
  const rest = markdown.slice(bodyStart);
  // Anchored on the section the record always writes next, so a prompt that itself
  // contains markdown headings cannot end the match early and leak its own tail.
  const next =
    new RegExp(`^#{2,3} Interpreted intent\\b`, "m").exec(rest) ??
    new RegExp(`^#{1,${level.length}} `, "m").exec(rest);
  const end = next ? bodyStart + next.index : markdown.length;
  return (
    `${markdown.slice(0, heading.index)}${level} User prompt\n` +
    `_redacted — set publish.redact.prompts to false to include it_\n\n${markdown.slice(end)}`
  );
}

/** What may leave the machine, decided once per publish from the config. */
export interface RedactionPolicy {
  /** Brief text, orchestrator instruction and the record's "User prompt" section. */
  allowPrompts: boolean;
  /** Local checkout and worktree paths. */
  allowCheckoutPaths: boolean;
  /**
   * Absolute prefixes rewritten inside every string when paths are withheld, longest
   * first. Checkout paths also turn up in prose ("worktree ready for api at /Users/…"),
   * and a home directory usually names the person who owns the machine.
   */
  pathPrefixes: { prefix: string; replacement: string }[];
}

/**
 * Prose about the work is opt-in twice over: it needs `detail: "full"`, and then
 * each redaction must be switched off explicitly. At summary detail nothing that
 * carries a prompt or a local path is sent, whatever `redact` says.
 */
export function redactionPolicy(
  config: PublishConfig,
  workspaceRoot: string,
  home: string = os.homedir()
): RedactionPolicy {
  const full = config.detail === "full";
  const prefixes = new Map<string, string>();
  const add = (prefix: string, replacement: string): void => {
    const clean = prefix.replace(/[/\\]+$/, "");
    if (clean.length > 1 && !prefixes.has(clean)) prefixes.set(clean, replacement);
  };
  add(workspaceRoot, "<workspace>");
  try {
    // macOS hands out /var/… paths that are really /private/var/…; either may appear.
    add(fs.realpathSync(workspaceRoot), "<workspace>");
  } catch {
    // An unresolvable root still has its literal form scrubbed.
  }
  if (home) add(home, "~");
  return {
    allowPrompts: full && !config.redact.prompts,
    allowCheckoutPaths: full && !config.redact.filePaths,
    pathPrefixes: [...prefixes.entries()]
      .map(([prefix, replacement]) => ({ prefix, replacement }))
      .sort((a, b) => b.prefix.length - a.prefix.length),
  };
}

/** Fields whose value is a local checkout location, wherever they appear. */
const CHECKOUT_PATH_FIELDS = new Set(["checkout", "worktree", "worktreePath", "recordedPath", "cwd"]);
/** Fields whose value is what a worker or agent was asked to do. */
const PROMPT_FIELDS = new Set(["prompt", "instruction", "brief"]);

/**
 * Field-aware redaction of one published document.
 *
 * Every string goes through `redactSecrets` — real day logs carried `*_PASSWORD=`
 * and `mysql -p…` verbatim — whatever the detail level. On top of that, fields are
 * judged by what they are rather than by pattern-matching their text: a `brief`
 * event's text and any instruction/prompt field are prompts; `checkout`/`worktree`
 * fields are local paths. A withheld field is replaced by `<name>Redacted: true`,
 * matching the existing `tailRedacted`, so a reader can say what was held back.
 */
export function sanitizeDocument<T>(
  doc: T,
  policy: RedactionPolicy,
  tally: Pick<PublishResult["redacted"], "prompts" | "checkoutPaths" | "secrets">
): T {
  let promptWithheld = false;
  const scrubPaths = (text: string): string => {
    if (policy.allowCheckoutPaths) return text;
    let out = text;
    for (const { prefix, replacement } of policy.pathPrefixes) out = out.split(prefix).join(replacement);
    return out;
  };
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") {
      let text = value;
      if (key === "markdown" && !policy.allowPrompts) {
        const stripped = stripPrompt(text);
        if (stripped !== text) promptWithheld = true;
        text = stripped;
      }
      const masked = redactSecrets(text);
      if (masked !== text) tally.secrets += 1;
      return scrubPaths(masked);
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, null));
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const isBrief = record.kind === "brief";
      const out: Record<string, unknown> = {};
      for (const [field, item] of Object.entries(record)) {
        if (typeof item === "string" && !policy.allowPrompts &&
          (PROMPT_FIELDS.has(field) || (isBrief && field === "text"))) {
          promptWithheld = true;
          out[`${field}Redacted`] = true;
          continue;
        }
        if (typeof item === "string" && !policy.allowCheckoutPaths && CHECKOUT_PATH_FIELDS.has(field)) {
          tally.checkoutPaths += 1;
          out[`${field}Redacted`] = true;
          continue;
        }
        out[field] = walk(item, field);
      }
      return out;
    }
    return value;
  };
  const result = walk(doc, null) as T;
  if (promptWithheld) tally.prompts += 1;
  return result;
}
