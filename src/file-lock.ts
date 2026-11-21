import fs from "fs-extra";
import { rmSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** What a lock directory records about the process holding it. */
export interface LockOwner {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * Whether `pid` names a running process on THIS host. Signal 0 checks existence
 * without delivering anything; EPERM means it exists but belongs to someone else,
 * which is still alive. A reused pid reads as alive — the safe direction.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(raw: unknown): LockOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.pid !== "number" || typeof o.hostname !== "string") return null;
  return { pid: o.pid, hostname: o.hostname, acquiredAt: String(o.acquiredAt ?? "") };
}

async function readOwner(lock: string): Promise<LockOwner | null> {
  return parseOwner(await fs.readJson(path.join(lock, "owner.json")).catch(() => null));
}

/**
 * Provably abandoned: recorded on this host by a process that no longer exists.
 * Anything else — another host, a live pid, no owner file yet — cannot be proven
 * dead from here, so it is never reclaimed.
 */
export function isDeadLocalOwner(owner: LockOwner | null): boolean {
  return !!owner && owner.hostname === os.hostname() && owner.pid !== process.pid && !isProcessAlive(owner.pid);
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.acquiredAt === b.acquiredAt;
}

/**
 * Remove a lock whose owner is provably dead, under a second mutex so two waiters
 * that both saw the same dead owner cannot both reclaim — the second would delete
 * the lock the first had just taken. The owner is re-read inside the guard; if it
 * changed, someone else already recovered it.
 */
async function reclaimIfAbandoned(lock: string): Promise<boolean> {
  const observed = await readOwner(lock);
  if (!observed || !isDeadLocalOwner(observed)) return false;
  const guard = `${lock}-reclaim`;
  try {
    await fs.mkdir(guard);
  } catch {
    return false;
  }
  try {
    const again = await readOwner(lock);
    if (!again || !sameOwner(again, observed) || !isDeadLocalOwner(again)) return false;
    await fs.remove(lock);
    return true;
  } finally {
    await fs.remove(guard).catch(() => undefined);
  }
}

// Locks this process holds, so an interrupt can release them. Without this a
// Ctrl+C during a state write left `state.json.lock` behind and every later
// command timed out until someone deleted it by hand.
const held = new Set<string>();
let handlersInstalled = false;

function releaseHeldSync(): void {
  for (const lock of held) {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // Best effort: the process is going away regardless.
    }
  }
  held.clear();
}

function onSignal(signal: NodeJS.Signals): void {
  releaseHeldSync();
  uninstallHandlers();
  // Only re-raise when nobody else is listening: `awo ui` and `publish --watch`
  // install their own graceful-stop handlers, and those decide when to exit.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", releaseHeldSync);
}

function uninstallHandlers(): void {
  if (!handlersInstalled) return;
  handlersInstalled = false;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("exit", releaseHeldSync);
}

/** Cross-process exclusion. Never steal a lock based on age: a slow live writer
 * must not lose ownership. A lock is reclaimed only when its recorded owner ran on
 * this host and that pid is gone — the one case that is provable, not guessed. */
export async function withFileLock<T>(
  file: string,
  action: () => Promise<T>,
  timeoutMs = 30_000
): Promise<T> {
  const lock = `${file}.lock`;
  await fs.ensureDir(path.dirname(file));
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimIfAbandoned(lock)) continue;
      if (Date.now() - started >= timeoutMs) {
        const owner = await fs.readFile(path.join(lock, "owner.json"), "utf8").catch(() => "unknown owner");
        throw new Error(`Timed out waiting for ${lock}. Owner: ${owner.trim()}. ` +
          `Do not remove a live lock. If its owning process has stopped, stop all writers, ` +
          `remove this lock directory, then retry. The protected file has not been overwritten.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 30));
    }
  }
  held.add(lock);
  installHandlers();
  try {
    await fs.writeJson(path.join(lock, "owner.json"), {
      pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString(),
    } satisfies LockOwner);
    return await action();
  } finally {
    held.delete(lock);
    if (held.size === 0) uninstallHandlers();
    await fs.remove(lock);
  }
}

export interface StaleLock {
  lock: string;
  owner: unknown;
  reason: string;
}

/** A lock without an owner file is normal for the instant after `mkdir`; this long, it is not. */
const OWNERLESS_GRACE_MS = 60_000;

/**
 * Lock directories that will never be released on their own, for `doctor`.
 * Reported, not removed: `withFileLock` reclaims the provable ones itself the next
 * time anything waits on them, and the rest need a person to confirm the owner
 * is really gone.
 */
export async function findStaleLocks(root: string): Promise<StaleLock[]> {
  const out: StaleLock[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith(".lock") || entry.name.endsWith(".lock-reclaim")) {
        const stale = await staleness(full);
        if (stale) out.push(stale);
        continue;
      }
      if (depth > 0 && entry.name !== "node_modules" && entry.name !== ".git") {
        await visit(full, depth - 1);
      }
    }
  };
  // `.workspace/` (run-id reservations), `goals/**` (state.json, archived goals
  // included) and `logs/<day>/` (the daily run record) — every place awo locks.
  await visit(path.join(root, ".workspace"), 3);
  await visit(path.join(root, "goals"), 4);
  await visit(path.join(root, "logs"), 1);
  return out.sort((a, b) => a.lock.localeCompare(b.lock));
}

async function staleness(lock: string): Promise<StaleLock | null> {
  const raw = await fs.readJson(path.join(lock, "owner.json")).catch(() => undefined);
  const owner = parseOwner(raw);
  if (owner) {
    if (!isDeadLocalOwner(owner)) return null;
    return {
      lock,
      owner,
      reason: `owner pid ${owner.pid} on this host is no longer running — the next writer reclaims it`,
    };
  }
  const age = Date.now() - ((await fs.stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
  if (age < OWNERLESS_GRACE_MS) return null;
  return {
    lock,
    owner: raw ?? null,
    reason:
      `no owner recorded for ${Math.round(age / 1000)}s, so awo cannot prove it abandoned — ` +
      `stop all awo processes, then remove ${lock}`,
  };
}

/** Reader-safe replacement; callers lock the entire read/modify/write operation. */
export async function atomicWriteFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.ensureDir(path.dirname(file));
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.remove(tmp);
  }
}
