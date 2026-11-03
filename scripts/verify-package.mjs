import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awo-package-'));
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
});
try {
  const [pack] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
  const consumer = path.join(temp, 'consumer'); fs.mkdirSync(consumer);
  const flags = process.argv.includes('--offline') ? ['--offline'] : [];
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...flags, path.join(temp, pack.filename)], consumer);
  const cli = path.join(consumer, 'node_modules', '@supanut9', 'awo', 'dist', 'cli.js');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const info = JSON.parse(run(process.execPath, [cli, 'version', '--json'], consumer));
  assert.equal(info.version, version);
  assert.equal(info.build.version, version);
  assert.match(info.build.sourceHash, /^[a-f0-9]{64}$/);
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  run(process.execPath, [cli, 'init', '--key', 'PKG'], workspace);
  const context = JSON.parse(run(process.execPath, [cli, 'context', '--json'], workspace));
  assert.equal(context.snapshot.project.projectKey, 'PKG');
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, '.workspace', 'manifest.json'), 'utf8'));
  assert.equal(manifest.libraryVersion, version);
  console.log(JSON.stringify({ package: pack.filename, shasum: pack.shasum, build: info.build, installedCli: true, init: true, context: true }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
