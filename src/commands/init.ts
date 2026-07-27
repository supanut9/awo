import fs from "fs-extra";
import path from "path";
import { v7 as uuidv7 } from "uuid";
import {
  TEMPLATE_DIR,
  buildLock,
  readLibraryVersion,
  renderTemplate,
  walkFiles,
  writeLock,
} from "../template.js";

// §5: "short, permanent project code (uppercase, 2-5 chars)" — Jira-key
// semantics, so digits after an initial letter are allowed (e.g. AB12).
const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;

export interface InitOptions {
  key: string;
  cwd?: string;
}

export async function runInit(options: InitOptions): Promise<void> {
  const { key } = options;
  const targetDir = path.resolve(options.cwd ?? process.cwd());

  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid --key "${key}": must be 2-5 uppercase chars, starting with a letter (e.g. PROM, AB12).`
    );
  }

  if (!(await fs.pathExists(TEMPLATE_DIR))) {
    throw new Error(
      `Template directory missing at ${TEMPLATE_DIR}. This is a broken awo install.`
    );
  }

  const existing = await fs.readdir(targetDir).catch(() => []);
  if (existing.length > 0) {
    throw new Error(
      `Target directory ${targetDir} is not empty. Run \`awo init\` in an empty directory.`
    );
  }

  await fs.copy(TEMPLATE_DIR, targetDir);

  // Shipped un-dotted so npm's gitignore-based pack pruning can't drop it
  // (or the files it excludes, like repos/.gitkeep) from the published tarball.
  await fs.move(path.join(targetDir, "gitignore"), path.join(targetDir, ".gitignore"));

  const libraryVersion = readLibraryVersion();
  const values = {
    projectKey: key,
    createdAt: new Date().toISOString(),
    libraryVersion,
    // §5: machine identity, permanent, distinct from the human-facing
    // projectKey (which is only unique across ONE user's projects).
    // uuid v7, not v4 — the timestamp prefix makes it k-sortable, so a remote
    // store indexes it without a hot random shard (§7.6).
    workspaceId: uuidv7(),
  };

  for (const file of await walkFiles(targetDir)) {
    const original = await fs.readFile(file, "utf8");
    const updated = renderTemplate(original, values);
    if (updated !== original) await fs.writeFile(file, updated, "utf8");
  }

  // §11.2 — the baseline a later `awo upgrade` reconciles against.
  await writeLock(targetDir, await buildLock(targetDir, key, libraryVersion));
}
