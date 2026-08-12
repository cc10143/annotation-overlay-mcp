// install-skills.js — copy the repo's distributable skills/ into ~/.claude/skills/
// so they're available to Claude Code in any project. Run after editing skills/:
//   npm run install-skills
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(repoRoot, "skills");
const dest = join(homedir(), ".claude", "skills");

if (!existsSync(src)) {
  console.error("[install-skills] no skills/ dir at " + src);
  process.exit(1);
}

const names = readdirSync(src).filter((n) =>
  existsSync(join(src, n, "SKILL.md"))
);
for (const n of names) {
  cpSync(join(src, n), join(dest, n), { recursive: true, force: true });
  console.log(`[install-skills] installed ${n} → ${join(dest, n)}`);
}
console.log(`[install-skills] done (${names.length} skills)`);
