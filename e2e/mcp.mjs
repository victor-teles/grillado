// v1.2 item 1 end-to-end: `grillado mcp` over stdio with the official MCP SDK client, against a
// temp data dir. Every tool and the plan resources, with the web app running (start_plan links to
// the session, which the browser opens; add_comment lands in the open rail live) and without it.
// Uses the built dist/cli.js and the fake agents. One server and one browser at a time; only
// processes started here are killed.
//   node e2e/mcp.mjs
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-mcp-e2e-"));
const NODE = process.execPath;
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const bin = mkdtempSync(path.join(WORK, "bin-"));
writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" claude "$@"\n`);
chmodSync(path.join(bin, "claude"), 0o755);
const HOME = mkdtempSync(path.join(WORK, "home-"));
const DATA = path.join(HOME, ".grillado");
const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME, GRILLADO_HOME: DATA, FAKE_STATE_DIR: HOME };

const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function webApp() {
  const child = spawn(NODE, [CLI, "--no-open", "--port", String(await freePort())], { env, stdio: ["ignore", "pipe", "pipe"] });
  started.add(child);
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
  });
  return { url, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}

async function mcpClient(args = [], name = "e2e-coder") {
  const transport = new StdioClientTransport({ command: NODE, args: [CLI, "mcp", ...args], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const textOf = (r) => r.content.map((x) => x.text).join("\n");

// stdout carries the protocol only: every line a raw `grillado mcp` writes is JSON-RPC.
{
  const child = spawn(NODE, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  started.add(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })}\n`);
  await new Promise((r) => setTimeout(r, 1500));
  child.kill("SIGKILL");
  const lines = out.split("\n").filter(Boolean);
  check("stdout is JSON-RPC only", lines.length >= 1 && lines.every((l) => JSON.parse(l).jsonrpc === "2.0"), `${lines.length} lines`);
  check("logs go to stderr", /grillado mcp: serving/.test(err), err.trim());
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const app = await webApp();
const m = await mcpClient();
try {
  const c = m.client;
  const { tools } = await c.listTools();
  check("five tools", JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(["add_comment", "get_decisions", "get_plan", "list_plans", "start_plan"]));
  check("no banned words in tool or server descriptions", !/grill-me|grilling|pocock/i.test(JSON.stringify(tools)));
  check("list_plans with no plans says so", /No plans yet/.test(textOf(await call(c, "list_plans"))));

  // Plate a plan in the browser, the normal way.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const pg = await ctx.newPage();
  await pg.goto(app.url);
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
  await pg.keyboard.press("Enter");
  await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });

  const launch = await pg.evaluate(async () => (await (await fetch("/api/state")).json()).mcp);
  check("the web app knows the command that starts `grillado mcp` (local build: node + absolute path)", JSON.stringify(launch) === JSON.stringify({ command: "node", args: [CLI, "mcp"], line: `node ${CLI} mcp` }), JSON.stringify(launch));
  const list = (await call(c, "list_plans")).structuredContent.plans;
  const plan = list[0];
  check("list_plans: the plated plan, not a draft", list.length === 1 && plan.status === "plated" && plan.draft === false, JSON.stringify(plan));

  const got = await call(c, "get_plan", { plan: plan.id });
  const md = got.structuredContent.markdown;
  check("get_plan: the plan's Markdown", got.content[0].text === md && md.startsWith("# "), md.slice(0, 40));
  check("get_plan: resolved decisions with answers", got.structuredContent.decisions.length >= 3 && got.structuredContent.decisions.every((d) => d.answer), `${got.structuredContent.decisions.length} decisions`);

  const dec = (await call(c, "get_decisions", { plan: plan.id })).structuredContent;
  check("get_decisions: keys, answers, rounds", dec.decisions.every((d) => d.key && d.answer && d.round >= 1) && Array.isArray(dec.open), dec.decisions.map((d) => d.key).join(","));

  const { resources } = await c.listResources();
  check("one resource per plan", resources.length === 1 && resources[0].uri === `grillado://plans/${plan.id}` && resources[0].mimeType === "text/markdown");
  const read = await c.readResource({ uri: resources[0].uri });
  check("reading the resource gives the plan's Markdown", read.contents[0].text === md);

  const unknown = await call(c, "get_plan", { plan: "2026-01-01-nope" });
  check("unknown plan id: clear error", unknown.isError && textOf(unknown) === 'No plan with id "2026-01-01-nope". Call list_plans to see the ids.', textOf(unknown));
  let rejected = "";
  await c.readResource({ uri: "grillado://plans/2026-01-01-nope" }).catch((e) => (rejected = e.message));
  check("unknown plan resource: clear error", /No plan with id "2026-01-01-nope"/.test(rejected), rejected);

  // add_comment: in the open plan's rail, live, as from the coding agent.
  const quote = md.split("\n").find((l) => /^[A-Z]/.test(l) && l.length > 20).slice(0, 30);
  const added = await call(c, "add_comment", { plan: plan.id, quote, text: "I'll build this part first." });
  check("add_comment succeeds", !added.isError, textOf(added));
  const toggle = pg.getByRole("button", { name: "Comments 1" });
  await toggle.waitFor({ timeout: 5000 });
  check("the plan updates live (no reload): comment count and the quote marked", (await pg.locator("mark.cmk").first().textContent()).length > 0);
  await toggle.click();
  const rail = pg.getByRole("complementary", { name: "Comments" });
  await rail.getByText("I'll build this part first.").waitFor({ timeout: 5000 });
  check("the comment is in the Comments rail", true);
  check("it shows as from the coding agent", (await rail.locator(".msg .who b").first().textContent()) === "Coding agent");
  check("its client name is kept", (await rail.locator(".msg .who b").first().getAttribute("title")) === "e2e-coder");
  check("add_comment: a quote not in the plan is a clear error", /That quote isn't in the plan/.test(textOf(await call(c, "add_comment", { plan: plan.id, quote: "zzz not there", text: "x" }))));

  // start_plan: the URL opens the new session in the browser, which starts its first round.
  const sp = (await call(c, "start_plan", { idea: "Garden watering planner" })).structuredContent;
  check("start_plan returns a local URL to the session", new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/${sp.id}\\?t=`).test(sp.url ?? ""), sp.url);
  const p2 = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await p2.goto(sp.url);
  await p2.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  check("the web app opens it and asks the first round", p2.url().endsWith(`/s/${sp.id}`), p2.url());
  await pg.goto(app.url.replace(/\/\?t=.*/, "/"));
  await pg.getByText("Garden watering planner").first().waitFor({ timeout: 5000 });
  check("Home lists it under recent", true);
  const draft = await call(c, "get_plan", { plan: sp.id });
  check("get_plan on it: a draft, marked as one", draft.structuredContent.draft === true && /^# Draft: Garden watering planner/.test(draft.content[0].text));
  check("add_comment on a draft: clear error", /still a draft/.test(textOf(await call(c, "add_comment", { plan: sp.id, quote: "x", text: "y" }))));
  check("bad input is rejected at the boundary", (await call(c, "start_plan", { idea: "   " })).isError === true);
  await ctx.close();
  await p2.context().close();
} finally {
  await m.close();
  await app.stop();
  await browser.close();
}

// Without the web app: everything still works from the files, and start_plan says how to open it.
{
  const m2 = await mcpClient();
  const c = m2.client;
  const plans = (await call(c, "list_plans")).structuredContent.plans;
  check("works with the web app stopped", plans.length === 2);
  const sp = (await call(c, "start_plan", { idea: "Offline idea" })).structuredContent;
  check("start_plan with the app stopped: no URL, says to run grillado", sp.url === null && /npx grillado/.test(sp.next), sp.next);
  await m2.close();
  const other = path.join(WORK, "other");
  const m3 = await mcpClient(["--data-dir", other]);
  check("--data-dir points it at another data dir", /No plans yet/.test(textOf(await call(m3.client, "list_plans"))));
  await m3.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
