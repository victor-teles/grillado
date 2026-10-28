// v1.2 item 1 end-to-end: `grillado mcp` over stdio with the official MCP SDK client, against a
// temp data dir. Every tool and the plan resources, with the web app running (start_plan links to
// the session, which the browser opens; add_comment lands in the open rail live) and without it.
// Uses the built dist/cli.js and the fake agents. One server and one browser at a time; only
// processes started here are killed.
//   node e2e/mcp.mjs
//   SHOTS=dir node e2e/mcp.mjs      also writes the rail and Recent shots (dark and light) to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
  check("seven tools", JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(["add_comment", "get_decisions", "get_plan", "import_source", "list_plans", "list_project_sources", "start_plan"]));
  check("no banned words in tool or server descriptions", !/grill-me|grilling|pocock/i.test(JSON.stringify(tools)));
  check("no create_issues tool (v1.3 item 2: the browser's confirm only)", !tools.some((t) => /issue/.test(t.name)));
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
  // DECISIONS #109: a local build names the absolute Node binary, not a bare `node`.
  check("the web app knows the command that starts `grillado mcp` (local build: absolute node + absolute cli.js)", JSON.stringify(launch) === JSON.stringify({ command: NODE, args: [CLI, "mcp"], line: `${NODE} ${CLI} mcp` }), JSON.stringify(launch));
  if (SHOTS) writeFileSync(path.join(SHOTS, "api-state-mcp-local.json"), `${JSON.stringify(launch, null, 2)}\n`);
  const list = (await call(c, "list_plans")).structuredContent.plans;
  const plan = list[0];
  check("list_plans: the plated plan, not a draft", list.length === 1 && plan.status === "plated" && plan.draft === false, JSON.stringify(plan));

  const got = await call(c, "get_plan", { plan: plan.id });
  const md = got.structuredContent.markdown;
  check("get_plan: the plan's Markdown", got.content[0].text === md && md.startsWith("# "), md.slice(0, 40));
  check("get_plan: resolved decisions with answers", got.structuredContent.decisions.length >= 3 && got.structuredContent.decisions.every((d) => d.answer), `${got.structuredContent.decisions.length} decisions`);
  check("get_plan: issues is null before the plan is sent", got.structuredContent.issues === null && JSON.parse(got.content[1].text).issues === null);

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
  // DECISIONS #107: the editor's name, a plug and "from your editor"; no time, never the raw client name.
  const who = rail.locator(".msg .who").first();
  check("an unknown client reads “Your editor”, from your editor", (await who.textContent()) === "Your editorfrom your editor", await who.textContent());
  check("…with the 12px plug and no time or raw-name tooltip", (await who.locator(".via svg.s12").count()) === 1 && (await who.locator(".m").count()) === 0 && (await who.locator("[title]").count()) === 0);
  const editors = [];
  const lines = ["Yes, one core flow", "Local storage"];
  for (const [i, [client, name]] of [["cursor-vscode", "Cursor"], ["claude-code", "Claude Code"]].entries()) {
    const e = await mcpClient([], client);
    editors.push(e);
    const r = await call(e.client, "add_comment", { plan: plan.id, quote: lines[i], text: `A note from ${client}.` });
    check(`add_comment from ${client}`, !r.isError, textOf(r));
    const t = rail.locator(".th", { hasText: `A note from ${client}.` });
    await t.waitFor({ timeout: 5000 });
    check(`${client} reads “${name}”, from your editor`, (await t.locator(".msg .who").first().textContent()) === `${name}from your editor`);
  }
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

  // Recent (DECISIONS #108): queued rows say who sent them and that they wait; opened ones add the usual status.
  const queued = (await call(editors[0].client, "start_plan", { idea: "Recipe scaler for the cafe" })).structuredContent;
  await pg.reload();
  const row = (t) => pg.locator(".rrow", { hasText: t }).locator(".meta");
  await row("Recipe scaler for the cafe").waitFor({ timeout: 5000 });
  check("Recent: a queued row reads From Cursor · waiting for your answers", (await row("Recipe scaler for the cafe").textContent()) === "From Cursor · waiting for your answers", await row("Recipe scaler for the cafe").textContent());
  check("Recent: “From Cursor” is in the foreground colour", (await row("Recipe scaler for the cafe").locator(".src1").textContent()) === "From Cursor");
  const opened = await row("Garden watering planner").textContent();
  check("Recent: an opened one reads From your editor · status · when", /^From your editor · Round 1 · (just now|\d+ min ago)$/.test(opened), opened);
  check("Recent: rows started in the browser are unchanged", /^(Plated|Wrapped early)/.test(await row("Shared shopping list").textContent()));
  // MF2 (#110): a long queued row must not widen the phone Home; it stacks title over meta.
  await call(editors[0].client, "start_plan", { idea: "A booking page for my barber shop" });
  {
    const token = new URL(app.url).searchParams.get("t");
    const origin = new URL(app.url).origin;
    for (const theme of ["dark", "light"]) {
      const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await mc.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const mp = await mc.newPage();
      await mp.goto(`${origin}/?t=${token}`);
      const long = mp.locator(".rrow", { hasText: "A booking page for my barber shop" });
      await long.waitFor({ timeout: 5000 });
      const g = await mp.evaluate(() => {
        const r = [...document.querySelectorAll(".rrow")].find((x) => x.textContent.includes("A booking page for my barber shop"));
        const nm = r.querySelector(".nm").getBoundingClientRect();
        const meta = r.querySelector(".meta");
        const mr = meta.getBoundingClientRect();
        const solo = document.querySelector(".solo");
        const cs = getComputedStyle(r);
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, solo: solo.scrollWidth - solo.clientWidth, h: r.getBoundingClientRect().height, stacked: mr.top >= nm.bottom - 1, metaFont: getComputedStyle(meta).fontSize, pad: cs.padding, gap: cs.rowGap, right: r.getBoundingClientRect().right, metaText: meta.textContent };
      });
      check(`MF2 390 ${theme}: a long queued row doesn't scroll the phone Home sideways`, g.sw === g.iw && g.solo === 0 && g.right <= g.iw, JSON.stringify(g));
      check(`MF2 390 ${theme}: the queued row stacks title over a 12px meta (min-height 56, 8px 10px, gap 2px)`, g.stacked && g.h >= 56 && g.metaFont === "12px" && g.pad === "8px 10px" && g.gap === "2px" && g.metaText === "From Cursor · waiting for your answers", JSON.stringify(g));
      if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `m-home-390-long-queued-${theme}.png`) });
      await mc.close();
    }
  }
  if (SHOTS) {
    const token = new URL(app.url).searchParams.get("t");
    const origin = new URL(app.url).origin;
    for (const theme of ["dark", "light"]) {
      const sc = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      await sc.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const sp2 = await sc.newPage();
      await sp2.goto(`${origin}/?t=${token}`);
      await sp2.locator(".rrow", { hasText: "Recipe scaler for the cafe" }).waitFor();
      await sp2.screenshot({ path: path.join(SHOTS, `pr9-recent-queued-${theme}.png`) });
      await sp2.goto(`${origin}/s/${plan.id}?t=${token}`);
      await sp2.locator("mark.cmk").first().waitFor();
      await sp2.waitForLoadState("networkidle");
      const tg = sp2.getByRole("button", { name: "Comments 3" });
      if ((await tg.getAttribute("aria-pressed")) !== "true") await tg.click();
      await sp2.getByRole("complementary", { name: "Comments" }).getByText("A note from claude-code.").waitFor({ timeout: 5000 });
      await sp2.waitForTimeout(300);
      await sp2.screenshot({ path: path.join(SHOTS, `pr9-rail-editors-${theme}.png`) });
      await sc.close();
    }
  }
  for (const e of editors) await e.close();
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
  check("works with the web app stopped", plans.length === 4, String(plans.length));
  const sp = (await call(c, "start_plan", { idea: "Offline idea" })).structuredContent;
  check("start_plan with the app stopped: no URL, says to run this build (absolute node, #109)", sp.url === null && sp.next.includes(`Run \`${NODE} ${CLI}\` and open this idea from Recent`), sp.next);
  await m2.close();
  const other = path.join(WORK, "other");
  const m3 = await mcpClient(["--data-dir", other]);
  check("--data-dir points it at another data dir", /No plans yet/.test(textOf(await call(m3.client, "list_plans"))));
  const sp3 = (await call(m3.client, "start_plan", { idea: "Elsewhere" })).structuredContent;
  check("…and start_plan's hint keeps that data dir", sp3.next.includes(`Run \`${NODE} ${CLI} --data-dir ${other}\``), sp3.next);
  await m3.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
