import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(packageRoot, "templates", "default");

if (!fs.existsSync(templateDir)) {
  console.error(`awo: embedded template missing at ${templateDir} — this install is broken.`);
  process.exit(1);
}
