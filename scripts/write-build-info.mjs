import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const hash = createHash('sha256');
function include(relative) {
  const file = path.join(root, relative);
  if (fs.statSync(file).isDirectory()) {
    for (const name of fs.readdirSync(file).sort()) include(path.join(relative, name));
  } else {
    hash.update(relative + '\0'); hash.update(fs.readFileSync(file)); hash.update('\0');
  }
}
for (const name of ['src', 'ui', 'templates', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']) include(name);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const status = git('status', '--porcelain');
const info = { version, commit: git('rev-parse', 'HEAD'), sourceDirty: status === null ? null : status.length > 0, sourceHash: hash.digest('hex') };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// No wall-clock build timestamp: identical source inputs retain identical metadata.
fs.writeFileSync(path.join(root, 'dist/build-info.json'), JSON.stringify(info, null, 2) + '\n');
