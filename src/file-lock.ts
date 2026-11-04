import fs from "fs-extra";
import { open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** Cross-process exclusion. Never steal a lock based on age: a slow live writer
 * must not lose ownership. After an interrupted process, recovery is explicit. */
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
      if (Date.now() - started >= timeoutMs) {
        const owner = await fs.readFile(path.join(lock, "owner.json"), "utf8").catch(() => "unknown owner");
        throw new Error(`Timed out waiting for ${lock}. Owner: ${owner.trim()}. ` +
          `Do not remove a live lock. If its owning process has stopped, stop all writers, ` +
          `remove this lock directory, then retry. The protected file has not been overwritten.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 30));
    }
  }
  try {
    await fs.writeJson(path.join(lock, "owner.json"), {
      pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString(),
    });
    return await action();
  } finally {
    await fs.remove(lock);
  }
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
