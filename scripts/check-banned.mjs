// AC17: the built web bundle must not carry the method's name or the prompt contents.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const BANNED = ["grill-me", "grilling", "matt pocock", "mattpocock"];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Run with bun so the TypeScript source can be imported directly.
const { promptFragments } = await import("../src/core/prompts.ts");
const fragments = promptFragments().map((f) => f.toLowerCase());

let bad = 0;
for (const file of walk("dist/web")) {
  const text = readFileSync(file, "utf8").toLowerCase();
  for (const term of [...BANNED, ...fragments]) {
    if (text.includes(term)) {
      console.error(`check-banned: ${file} contains "${term.slice(0, 60)}"`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`check-banned: dist/web clean (${BANNED.length} terms, ${fragments.length} prompt fragments)`);
