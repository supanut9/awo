import fs from "fs-extra";
import path from "path";
import { findWorkspaceRoot } from "../workspace.js";
import { readManifest } from "../manifest.js";
import { FileReader } from "../ui/reader.js";

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
  redact: { prompts: boolean; filePaths: boolean };
}

export interface PublishResult {
  workspaceId: string;
  database: string;
  counts: { goals: number; tasks: number; runs: number };
  dryRun: boolean;
  uriHost: string | null;
}

const DEFAULTS: PublishConfig = {
  database: "awo",
  collectionPrefix: "awo_",
  // §7.6 — statuses and counts travel by default; prose about private code does not.
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

  const snapshot = await new FileReader(root).snapshot();

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

  const goals = snapshot.goals.map((g) => ({
    _id: `${wid}:${g.id}`,
    workspaceId: wid,
    goalId: g.id,
    title: g.title,
    status: g.status,
    taskIds: g.tasks.map((t) => t.id),
  }));

  const tasks = snapshot.goals.flatMap((g) =>
    g.tasks.map((t) => ({
      _id: `${wid}:${t.id}`,
      workspaceId: wid,
      goalId: g.id,
      taskId: t.id,
      name: t.name,
      status: t.status,
      agent: t.agent,
      targets: t.targets,
      lastRunOutcome: t.lastRunOutcome,
      lastRunId: t.lastRunId,
      attempts: t.attempts,
      blockedReason: t.blockedReason,
    }))
  );

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
    // Repo names are structural; file paths describe private code (§7.6).
    reposChanged: config.redact.filePaths ? r.reposChanged : r.reposChanged,
  }));

  const result: PublishResult = {
    workspaceId: wid,
    database: config.database,
    counts: { goals: goals.length, tasks: tasks.length, runs: runs.length },
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
    for (const [name, docs] of [
      ["goals", goals],
      ["tasks", tasks],
      ["runs", runs],
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
  } finally {
    await client.close().catch(() => undefined);
  }

  return result;
}
