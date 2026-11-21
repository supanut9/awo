import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleUrl = (name: string) => pathToFileURL(path.join(ROOT, "dist", name)).href;

test("redactSecrets masks credential assignments, mysql -p, URL passwords and known tokens", async () => {
  const { redactSecrets, redactDeep } = await import(moduleUrl("redact.js"));
  assert.equal(
    redactSecrets("DB_PASSWORD=hunter2 API_KEY='abc def' npm test"),
    "DB_PASSWORD=*** API_KEY=*** npm test"
  );
  assert.equal(redactSecrets("mysql -uroot -psecret db"), "mysql -uroot -p*** db");
  assert.equal(
    redactSecrets("psql postgres://app:s3cr3t@localhost/db"),
    "psql postgres://app:***@localhost/db"
  );
  assert.equal(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123"), "token ***");
  assert.equal(redactSecrets("npm test -- --grep password"), "npm test -- --grep password");
  assert.deepEqual(redactDeep({ cmd: "TOKEN=x y", n: 1, list: ["SECRET=z"] }), {
    cmd: "TOKEN=*** y",
    n: 1,
    list: ["SECRET=***"],
  });
});

test("detectAgentEnvironment reads runtime markers, honours AWO_HUMAN and AWO_AGENT", async () => {
  const { detectAgentEnvironment, actorLabel } = await import(moduleUrl("agent-env.js"));
  assert.equal(detectAgentEnvironment({}).isAgent, false);
  const claude = detectAgentEnvironment({ CLAUDECODE: "1" });
  assert.equal(claude.isAgent, true);
  assert.equal(claude.runtime, "claude");
  assert.equal(actorLabel(claude), "claude");
  assert.equal(detectAgentEnvironment({ CODEX_SANDBOX: "seatbelt" }).runtime, "codex");
  assert.equal(detectAgentEnvironment({ CLAUDECODE: "1", AWO_HUMAN: "1" }).isAgent, false);
  const named = detectAgentEnvironment({ CLAUDECODE: "1", AWO_AGENT: "software-engineer" });
  assert.equal(actorLabel(named), "software-engineer");
});

test("aliasOption maps a hidden spelling onto the canonical option", async () => {
  const { Command } = await import(pathToFileURL(path.join(ROOT, "node_modules", "commander", "index.js")).href);
  const { aliasOptions } = await import(moduleUrl("cli-alias.js"));
  let seen: Record<string, unknown> = {};
  const program = new Command().exitOverride();
  const cmd = program
    .command("event")
    .option("--message <text>")
    .action((opts: Record<string, unknown>) => {
      seen = opts;
    });
  aliasOptions(cmd, "message", "--msg <text>", "--note <text>");
  await program.parseAsync(["node", "awo", "event", "--msg", "hello"]);
  assert.equal(seen.message, "hello");
  await program.parseAsync(["node", "awo", "event", "--message", "kept", "--note", "ignored"]);
  assert.equal(seen.message, "kept");
  assert.ok(!cmd.helpInformation().includes("--msg"));
});
