import fs from "fs-extra";
import path from "path";
/** §7.3 — `<ISO-timestamp>_<taskId>`: sortable, unique, human-readable. */
export function newRunId(taskId, at = new Date()) {
    return `${at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}_${taskId}`;
}
/** The date shard a runId belongs to (`logs/runs/<YYYY-MM-DD>/`). */
export function runDateShard(runId) {
    return runId.slice(0, 10);
}
function logsRoot(workspaceRoot) {
    return path.join(workspaceRoot, "logs");
}
export function runDir(workspaceRoot, runId) {
    return path.join(logsRoot(workspaceRoot), "runs", runDateShard(runId));
}
export function eventsFile(workspaceRoot, runId) {
    return path.join(runDir(workspaceRoot, runId), `${runId}.events.jsonl`);
}
export function detailFile(workspaceRoot, runId) {
    return path.join(runDir(workspaceRoot, runId), `${runId}.md`);
}
export function indexFile(workspaceRoot) {
    return path.join(logsRoot(workspaceRoot), "runs.jsonl");
}
/**
 * §7.4 — append-only progress stream. One line per meaningful step, written
 * DURING the run; this is what makes progress observable at all.
 */
export async function appendEvent(workspaceRoot, runId, kind, fields = {}) {
    const event = { t: new Date().toISOString(), kind, ...fields };
    await fs.ensureDir(runDir(workspaceRoot, runId));
    await fs.appendFile(eventsFile(workspaceRoot, runId), `${JSON.stringify(event)}\n`);
    return event;
}
export async function readEvents(workspaceRoot, runId) {
    const file = eventsFile(workspaceRoot, runId);
    if (!(await fs.pathExists(file)))
        return [];
    const raw = await fs.readFile(file, "utf8");
    return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
/** §7.3 — the query index. Append-only; one line per completed run. */
export async function appendIndex(workspaceRoot, entry) {
    await fs.ensureDir(logsRoot(workspaceRoot));
    await fs.appendFile(indexFile(workspaceRoot), `${JSON.stringify(entry)}\n`);
}
export async function readIndex(workspaceRoot) {
    const file = indexFile(workspaceRoot);
    if (!(await fs.pathExists(file)))
        return [];
    const raw = await fs.readFile(file, "utf8");
    return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
/** §7.3 — the readable record, written once at the end of a run. */
export async function writeDetail(workspaceRoot, runId, frontmatter, sections) {
    const yaml = Object.entries(frontmatter)
        .map(([k, v]) => {
        if (Array.isArray(v)) {
            return v.length === 0 ? `${k}: []` : `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
        }
        return `${k}: ${v === null ? "null" : v}`;
    })
        .join("\n");
    const body = [
        "## User prompt",
        sections.prompt?.trim() || "_not recorded_",
        "",
        "## Interpreted intent",
        sections.interpreted?.trim() || "_not recorded_",
        "",
        "## Summary of changes",
        sections.summary?.trim() || "_not recorded_",
        "",
        "## Notes / follow-ups",
        sections.notes && sections.notes.length > 0
            ? sections.notes.map((n) => `- ${n}`).join("\n")
            : "- none",
        "",
    ].join("\n");
    const file = detailFile(workspaceRoot, runId);
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, `---\n${yaml}\n---\n\n${body}`);
    return file;
}
