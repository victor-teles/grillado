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
// v1.2 item 1: what `grillado mcp` shows a coding agent (tool, input and resource descriptions).
const { mkdtempSync } = await import("node:fs");
const os = await import("node:os");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = await import("../src/cli/mcp.ts");
const { Store } = await import("../src/cli/store.ts");
const [a, b] = InMemoryTransport.createLinkedPair();
await createMcpServer(new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-banned-")))).connect(a);
const client = new Client({ name: "check-banned", version: "0" });
await client.connect(b);
const surface = JSON.stringify([client.getServerVersion(), client.getInstructions(), await client.listTools(), await client.listResourceTemplates()]).toLowerCase();
for (const term of [...BANNED, ...fragments]) {
  if (surface.includes(term)) {
    console.error(`check-banned: the MCP server's tools or resources contain "${term.slice(0, 60)}"`);
    bad++;
  }
}
await client.close();

if (bad) process.exit(1);
console.log(`check-banned: dist/web and the MCP tools clean (${BANNED.length} terms, ${fragments.length} prompt fragments)`);
