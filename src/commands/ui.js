import fs from "fs-extra";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import { findWorkspaceRoot } from "../workspace.js";
import { FileReader } from "../ui/reader.js";
import { runTaskStatus } from "./task.js";
// dist/commands/ui.js -> package root is two levels up.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_DIR = path.join(PACKAGE_ROOT, "ui");
function send(res, code, type, body) {
    res.writeHead(code, {
        "content-type": type,
        // A local dashboard has no business being cached or embedded elsewhere.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(body);
}
function sendJson(res, code, body) {
    send(res, code, "application/json", JSON.stringify(body));
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
/**
 * §7.5 — serves a read-mostly dashboard over the local workspace. Binds
 * 127.0.0.1 only (never the LAN), keeps nothing outside the workspace, and
 * leaves no daemon behind. Writes are limited to the lifecycle transitions a
 * human may make, and go through the same state module the CLI uses so
 * §7.4's single-writer rule holds.
 */
export async function runUi(options = {}) {
    const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
    const reader = new FileReader(workspaceRoot);
    if (!(await fs.pathExists(path.join(UI_DIR, "index.html")))) {
        throw new Error(`UI assets missing at ${UI_DIR}. This is a broken awo install.`);
    }
    const clients = new Set();
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        try {
            if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
                return send(res, 200, "text/html; charset=utf-8", await fs.readFile(path.join(UI_DIR, "index.html")));
            }
            if (req.method === "GET" && url.pathname === "/api/snapshot") {
                return sendJson(res, 200, await reader.snapshot());
            }
            if (req.method === "GET" && url.pathname === "/api/events") {
                const runId = url.searchParams.get("run");
                if (!runId)
                    return sendJson(res, 400, { error: "missing ?run=<runId>" });
                return sendJson(res, 200, await reader.runEvents(runId));
            }
            // Live updates: one SSE stream, nudged whenever watched files change.
            if (req.method === "GET" && url.pathname === "/api/stream") {
                res.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-store",
                    connection: "keep-alive",
                });
                res.write("retry: 2000\n\n");
                clients.add(res);
                req.on("close", () => clients.delete(res));
                return;
            }
            // The only writes the UI may perform (§7.4): human lifecycle moves.
            if (req.method === "POST" && url.pathname === "/api/task/status") {
                const { taskId, status, reason } = JSON.parse((await readBody(req)) || "{}");
                if (!taskId || !status)
                    return sendJson(res, 400, { error: "taskId and status required" });
                try {
                    const to = await runTaskStatus(taskId, status, { cwd: workspaceRoot, actor: "human", reason });
                    return sendJson(res, 200, { taskId, status: to });
                }
                catch (err) {
                    return sendJson(res, 409, { error: err.message });
                }
            }
            return sendJson(res, 404, { error: "not found" });
        }
        catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    });
    const port = await new Promise((resolve, reject) => {
        server.on("error", reject);
        // 0 lets the OS pick a free port, so a busy port never breaks startup.
        server.listen(options.port ?? 0, "127.0.0.1", () => {
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
    });
    const watcher = chokidar.watch([
        path.join(workspaceRoot, "goals"),
        path.join(workspaceRoot, "logs"),
        path.join(workspaceRoot, ".workspace", "manifest.json"),
    ], { ignoreInitial: true, ignored: /\.tmp$/ });
    let pending = null;
    const notify = () => {
        // Coalesce bursts: one run writes state.json, an event line, and an index
        // line in quick succession, and the client refetches the whole snapshot.
        if (pending)
            clearTimeout(pending);
        pending = setTimeout(() => {
            for (const client of clients)
                client.write(`event: changed\ndata: {}\n\n`);
        }, 80);
    };
    watcher.on("all", notify);
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            await watcher.close();
            for (const client of clients)
                client.end();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
