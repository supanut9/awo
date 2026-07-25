import fs from "fs-extra";
import path from "path";
import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import { fileURLToPath } from "url";

const PROJECT_KEY_TOKEN = "{{PROJECT_KEY}}";
const CREATED_AT_TOKEN = "{{CREATED_AT}}";
const LIBRARY_VERSION_TOKEN = "{{LIBRARY_VERSION}}";
const WORKSPACE_ID_TOKEN = "{{WORKSPACE_ID}}";

// §5: "short, permanent project code (uppercase, 2-5 chars)" — Jira-key
// semantics, so digits after an initial letter are allowed (e.g. AB12).
const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;

// dist/commands/init.js -> package root is two levels up.
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "templates", "default");

export interface InitOptions {
  key: string;
  cwd?: string;
}

function readLibraryVersion(): string {
  const pkg = fs.readJsonSync(path.join(PACKAGE_ROOT, "package.json"));
  return pkg.version as string;
}

async function substituteTokens(filePath: string, replacements: Record<string, string>) {
  const original = await fs.readFile(filePath, "utf8");
  let updated = original;
  for (const [token, value] of Object.entries(replacements)) {
    updated = updated.split(token).join(value);
  }
  if (updated !== original) {
    await fs.writeFile(filePath, updated, "utf8");
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
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
  await fs.move(
    path.join(targetDir, "gitignore"),
    path.join(targetDir, ".gitignore")
  );

  const replacements: Record<string, string> = {
    [PROJECT_KEY_TOKEN]: key,
    [CREATED_AT_TOKEN]: new Date().toISOString(),
    [LIBRARY_VERSION_TOKEN]: readLibraryVersion(),
    // §5: machine identity, permanent, distinct from the human-facing
    // projectKey (which is only unique across ONE user's projects).
    // uuid v7, not v4 — the timestamp prefix makes it k-sortable, so a remote
    // store indexes it without a hot random shard (§7.6).
    [WORKSPACE_ID_TOKEN]: uuidv7(),
  };
  const files = await walkFiles(targetDir);
  for (const file of files) {
    await substituteTokens(file, replacements);
  }

  await writeTemplateLock(targetDir, readLibraryVersion());
}

/**
 * §11.2 — records a hash of every file `init` laid down, AFTER token
 * substitution so the hashes describe what is actually on disk.
 *
 * This is what lets a future `awo upgrade` tell "the user customized this
 * file" from "the template changed this file". A workspace created without
 * it can never be upgraded reliably, and that cannot be fixed after the
 * fact — which is why it ships now, before anything reads it.
 */
async function writeTemplateLock(targetDir: string, libraryVersion: string): Promise<void> {
  const lockPath = path.join(targetDir, ".workspace", "template.lock");
  const files: Record<string, string> = {};

  for (const file of (await walkFiles(targetDir)).sort()) {
    const rel = path.relative(targetDir, file).split(path.sep).join("/");
    if (rel === ".workspace/template.lock") continue;
    const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    files[rel] = `sha256-${hash}`;
  }

  await fs.writeJson(lockPath, { libraryVersion, files }, { spaces: 2 });
}
