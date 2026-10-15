// Copies the review rubric (agents/) and the comment templates (templates/) into the plugin so the bot and the plugin share one source.
// Run before every release of the plugin:  node scripts/sync-plugin.mjs
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins", "magicians-team-review");
const RUBRIC = join(PLUGIN, "rubric"), TEMPLATES = join(PLUGIN, "templates");

mkdirSync(RUBRIC, { recursive: true });
for (const f of readdirSync(join(ROOT, "agents")).filter(x => x.endsWith(".md"))) cpSync(join(ROOT, "agents", f), join(RUBRIC, f));

for (const kind of ["github", "jira"]) {
  const dest = join(TEMPLATES, kind);
  if (existsSync(dest)) rmSync(dest, { recursive: true });
  cpSync(join(ROOT, "templates", kind), dest, { recursive: true });
}

// Same hash the bot stores with each review (rubricVersion in server.mjs), so both outputs show the same rules version.
const h = createHash("sha1");
for (const f of ["base.md", "cross-pr.md", "admin.md", "api.md", "webstore.md", "db.md"]) { try { h.update(readFileSync(join(ROOT, "agents", f), "utf8")); } catch { /* missing file */ } }
const version = h.digest("hex").slice(0, 8);
writeFileSync(join(RUBRIC, "VERSION"), version + "\n");

console.log(`Plugin synced. Rules version ${version}.`);
