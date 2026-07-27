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
// The dashboard is prebuilt by vite into dist/dashboard and shipped in the
// package (§7.5) — offline, version-locked, no CDN. Deliberately NOT dist/ui:
// that is where src/ui/*.ts compiles to, and vite's emptyOutDir would wipe it.
const UI_DIR = path.join(PACKAGE_ROOT, "dist", "dashboard");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export interface UiOptions {
  cwd?: string;
  port?: number;
  /** Resolve once the server is listening instead of blocking — used by tests. */
  detached?: boolean;
}

export interface UiHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function send(res: http.ServerResponse, code: number, type: string, body: string | Buffer): void {
  res.writeHead(code, {
    "content-type": type,
    // A local dashboard has no business being cached or embedded elsewhere.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  send(res, code, "application/json", JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * §7.5 — serves a read-mostly dashboard over the local workspace. Binds
 * 127.0.0.1 only (never the LAN), keeps nothing outside the workspace, and
 * leaves no daemon behind. Writes are limited to the lifecycle transitions a
 * human may make, and go through the same state module the CLI uses so
 * §7.4's single-writer rule holds.
 */
export async function runUi(options: UiOptions = {}): Promise<UiHandle> {
  const workspaceRoot = findWorkspaceRoot(options.cwd ?? process.cwd());
  const reader = new FileReader(workspaceRoot);

  if (!(await fs.pathExists(path.join(UI_DIR, "index.html")))) {
    throw new Error(`UI assets missing at ${UI_DIR}. This is a broken awo install.`);
  }

  const clients = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, "text/html; charset=utf-8", await fs.readFile(path.join(UI_DIR, "index.html")));
      }

      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        return sendJson(res, 200, await reader.snapshot());
      }

      if (req.method === "GET" && url.pathname === "/api/task") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(res, 400, { error: "missing ?id=<taskId>" });
        try {
          return sendJson(res, 200, await reader.task(id));
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/run") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(res, 400, { error: "missing ?id=<runId>" });
        try {
          return sendJson(res, 200, { runId: id, markdown: await reader.runDetail(id) });
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const runId = url.searchParams.get("run");
        if (!runId) return sendJson(res, 400, { error: "missing ?run=<runId>" });
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
        if (!taskId || !status) return sendJson(res, 400, { error: "taskId and status required" });
        try {
          const to = await runTaskStatus(taskId, status, { cwd: workspaceRoot, actor: "human", reason });
          return sendJson(res, 200, { taskId, status: to });
        } catch (err) {
          return sendJson(res, 409, { error: (err as Error).message });
        }
      }

      // Static assets from the prebuilt bundle. Resolved inside UI_DIR only —
      // a traversal attempt lands outside and is refused.
      if (req.method === "GET") {
        const asset = path.join(UI_DIR, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
        if (asset.startsWith(UI_DIR + path.sep) && (await fs.pathExists(asset))) {
          const type = CONTENT_TYPES[path.extname(asset)] ?? "application/octet-stream";
          return send(res, 200, type, await fs.readFile(asset));
        }
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    // 0 lets the OS pick a free port, so a busy port never breaks startup.
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  const watcher = chokidar.watch(
    [
      path.join(workspaceRoot, "goals"),
      path.join(workspaceRoot, "logs"),
      path.join(workspaceRoot, ".workspace", "manifest.json"),
    ],
    { ignoreInitial: true, ignored: /\.tmp$/ }
  );

  let pending: NodeJS.Timeout | null = null;
  const notify = (): void => {
    // Coalesce bursts: one run writes state.json, an event line, and an index
    // line in quick succession, and the client refetches the whole snapshot.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      for (const client of clients) client.write(`event: changed\ndata: {}\n\n`);
    }, 80);
  };
  watcher.on("all", notify);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await watcher.close();
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
