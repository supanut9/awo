// Pre-publish guard: the workspace template ships *embedded* in the package
// (§10, "Template delivery — embedded, not fetched"), so a tarball without it
// produces an `awo` that cannot init anything. Runs from `prepublishOnly`.
//
// Not a postinstall hook: `init` already fails loudly at runtime if the
// template is missing, and a throwing postinstall breaks consumers' installs
// without being able to fix anything.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`awo: ${msg}`);
  process.exit(1);
};

// 1. The template exists in the source tree at all.
const templateDir = path.join(packageRoot, "templates", "default");
if (!fs.existsSync(templateDir)) {
  fail(`embedded template missing at ${templateDir} — this checkout is broken.`);
}

// 2. The manifest template is present, since `init`'s whole contract is
//    substituting tokens into it.
const manifestTemplate = path.join(templateDir, ".workspace", "manifest.json");
if (!fs.existsSync(manifestTemplate)) {
  fail(`template is missing .workspace/manifest.json at ${manifestTemplate}.`);
}

// 3. The template actually makes it into the tarball. This is the check that
//    matters at publish time: `files` silently dropping templates/ would ship a
//    package that installs fine and then fails on first use.
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
);
const files = (packed[0]?.files ?? []).map((f) => f.path);

const missing = [
  "templates/default/.workspace/manifest.json",
  "templates/default/AGENTS.md",
  "dist/cli.js",
  // The prebuilt dashboard (§7.5) — without it `awo ui` serves nothing.
  "dist/dashboard/index.html",
  "dist/dashboard/app.js",
].filter((required) => !files.includes(required));

if (missing.length > 0) {
  fail(
    `the packed tarball is missing required files:\n  ${missing.join("\n  ")}\n` +
      `Check the "files" field in package.json.`
  );
}

console.log(`awo: template verified — ${files.length} files will be published.`);
