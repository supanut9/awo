import fs from "fs-extra";
import matter from "gray-matter";
import path from "path";

/**
 * §17 — the lists in AGENTS.md are derived, so awo derives them.
 *
 * They used to be hand-maintained, and both failure modes showed up in the same
 * week: `evidence-not-claims` shipped as a required rule and was missing from the
 * list for four versions (present on disk, ambient in name only), and every user who
 * added a rule line earned a permanent `AGENTS.md.new` on every upgrade thereafter,
 * because editing the file at all marks it user-edited.
 *
 * A list of what is in `rules/` is not content. It is a directory listing. So the
 * three lists live inside markers awo owns and refreshes:
 *
 *   <!-- awo:generated rules -->
 *   - `no-db-migrations` — write migration files, never execute them.
 *   <!-- /awo:generated -->
 *
 * Adding a rule is now dropping a file in `rules/`. Nothing to edit, nothing to
 * conflict, nothing to forget. Everything outside the markers is yours.
 */
export const BLOCKS = ["rules", "skills", "agents", "instructions"] as const;
export type BlockName = (typeof BLOCKS)[number];

const OPEN = (name: string): string => `<!-- awo:generated ${name} -->`;
const CLOSE = "<!-- /awo:generated -->";

/** One line per file, from its frontmatter. */
async function describe(dir: string): Promise<string[]> {
  const files = (await fs.readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  const lines: string[] = [];
  for (const file of files) {
    const parsed = matter(await fs.readFile(path.join(dir, file), "utf8"));
    const data = parsed.data as Record<string, unknown>;
    const id = String(data.id ?? file.replace(/\.md$/, ""));
    // `summary` is the one-line form written for this list; `name` is the human
    // title. Falling back through both means an existing rule file needs no edit.
    const summary = String(data.summary ?? data.name ?? "").trim();
    lines.push(summary ? `- \`${id}\` — ${summary}` : `- \`${id}\``);
  }
  return lines;
}

/**
 * Rewrite every generated block in AGENTS.md. Returns the names actually replaced,
 * so a caller can tell whether the file still has the markers at all — a workspace
 * predating them, or one where someone deleted them, must not be silently ignored.
 */
export async function refreshManagedBlocks(
  workspaceRoot: string
): Promise<{ replaced: BlockName[]; missing: BlockName[] }> {
  const file = path.join(workspaceRoot, "AGENTS.md");
  const original = (await fs.readFile(file, "utf8").catch(() => "")) as string;
  if (original === "") return { replaced: [], missing: [...BLOCKS] };

  let text = original;
  const replaced: BlockName[] = [];
  const missing: BlockName[] = [];

  for (const name of BLOCKS) {
    const open = OPEN(name);
    const start = text.indexOf(open);
    if (start < 0) {
      missing.push(name);
      continue;
    }
    const bodyStart = start + open.length;
    const end = text.indexOf(CLOSE, bodyStart);
    if (end < 0) {
      missing.push(name);
      continue;
    }
    const lines = await describe(path.join(workspaceRoot, name));
    const body = lines.length > 0 ? `\n${lines.join("\n")}\n` : "\n_none installed_\n";
    text = `${text.slice(0, bodyStart)}${body}${text.slice(end)}`;
    replaced.push(name);
  }

  if (text !== original) await fs.writeFile(file, text);
  return { replaced, missing };
}

/**
 * The generated blocks are stripped before hashing for `template.lock`.
 *
 * Otherwise every workspace that installs an agent from the catalog looks
 * "user-edited" to `awo upgrade` and starts producing conflict files — which is the
 * exact problem this feature removes, reintroduced through the back door.
 */
export function stripManagedBlocks(text: string): string {
  let out = text;
  for (const name of BLOCKS) {
    const open = OPEN(name);
    const start = out.indexOf(open);
    if (start < 0) continue;
    const end = out.indexOf(CLOSE, start);
    if (end < 0) continue;
    out = `${out.slice(0, start + open.length)}\n${out.slice(end)}`;
  }
  return out;
}
