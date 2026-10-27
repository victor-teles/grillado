// v1.2 item 1 end-to-end: the "Use in your editor" popover and sheet (handoff §3–§9). Entry points
// (plan ⋯, desktop Home header, phone More sheet; not the desktop More menu), the snippets as the
// server gives the command, the default tab, Copy → Copied → Copy, a failing clipboard, keyboard
// and focus, editor comments and Recent rows from MCP, axe in dark and light on desktop and phones.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/editor.mjs                 checks only
//   SHOTS=dir node e2e/editor.mjs       also writes the d-* / m-* frames to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-ue-"));
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
const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});
const bin = mkdtempSync(path.join(WORK, "bin-"));
for (const id of ["claude", "codex", "pi"]) {
  writeFileSync(path.join(bin, id), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" ${id} "$@"\n`);
  chmodSync(path.join(bin, id), 0o755);
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** The web app on its own port; `data` relative to a temp HOME (".grillado" is the default dir). */
async function server(data = ".grillado") {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, data), FAKE_STATE_DIR: home };
  const child = spawn(NODE, [CLI, "--no-open", "--no-scan", "--port", String(await freePort())], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  return { url, env, dir: env.GRILLADO_HOME, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}
async function mcp(env, name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: NODE, args: [CLI, "mcp"], env, stderr: "pipe" }));
  return client;
}

const pickIfAsked = async (pg, name) => {
  const r = pg.getByRole("radio", { name });
  if (await r.isVisible({ timeout: 1500 }).catch(() => false)) {
    await r.click();
    await pg.getByRole("button", { name: /Continue/ }).click();
  }
};
async function plate(pg, url, idea) {
  await pg.goto(url);
  await pickIfAsked(pg, /Claude Code/);
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill(idea);
  await pg.keyboard.press("Enter");
  await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });
  return pg.url().split("/s/")[1].split("?")[0];
}
const select = (pg, id) => pg.evaluate((id) => fetch("/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, remember: false }) }).then((r) => r.ok), id);
async function axe(pg, name) {
  await pg.waitForTimeout(400);
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
/** Frames: toasts and banners from earlier steps are gone first, fades are done. */
async function shot(pg, name, theme) {
  if (!SHOTS) return;
  await pg.waitForFunction(() => !document.querySelector(".toast,.gr-notice"), null, { timeout: 6000 }).catch(() => {});
  await pg.waitForTimeout(350);
  await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
}
const ue = (pg) => pg.getByTestId("use-in-editor");
/** The open animation (160ms scale/opacity) is done, so boxes and focus are final. */
const settle = (pg) => pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
const code = (pg) => ue(pg).getByTestId("ue-code").textContent();
const active = (pg) => pg.evaluate(() => { const a = document.activeElement; return `${a?.getAttribute("role") ?? a?.tagName}:${a?.getAttribute("aria-label") ?? a?.textContent?.trim()}`; });
const selectedTab = (pg) => ue(pg).locator('[role=tab][aria-selected="true"]').textContent();
const failClipboard = (pg) =>
  pg.evaluate(() => {
    window.__clip = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    window.__exec = document.execCommand;
    document.execCommand = () => false;
  });
const fixClipboard = (pg) =>
  pg.evaluate(() => {
    navigator.clipboard.writeText = window.__clip;
    document.execCommand = window.__exec;
  });
const openFromPlan = async (pg) => {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menuitem", { name: "Use in your editor…" }).click();
  await ue(pg).waitFor();
    await settle(pg);
};

const LOCAL = {
  claude: `claude mcp add --scope user grillado -- ${NODE} ${CLI} mcp`,
  cursor: `{\n  "mcpServers": {\n    "grillado": {\n      "type": "stdio",\n      "command": ${JSON.stringify(NODE)},\n      "args": [${JSON.stringify(CLI)}, "mcp"]\n    }\n  }\n}`,
  codex: `[mcp_servers.grillado]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(CLI)}, "mcp"]`,
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const app = await server();
let planId = "";
let plannedTitle = "";
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
    // ------------------------------------------------------------ desktop
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(app.url).origin });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    if (one) {
      planId = await plate(pg, app.url, "Shared shopping list for my flat");
      plannedTitle = await pg.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}`)).json()).plan.title, planId);
      // A session started by Cursor over MCP shows on Home as from Cursor (§9).
      const cur = await mcp(app.env, "cursor-vscode");
      await cur.callTool({ name: "start_plan", arguments: { idea: "A booking page for my barber shop" } });
      await cur.close();
    }
    await pg.goto(app.url);
    await pickIfAsked(pg, /Claude Code/);
    const entry = pg.getByRole("button", { name: "Use in your editor" });
    await entry.waitFor();
    const recent = pg.locator(".rrow", { hasText: "A booking page for my barber shop" });
    check(`${theme}: Recent says where a start_plan session came from`, (await recent.locator(".meta").textContent()) === "From Cursor · waiting for your answers");
    check(`${theme}: Home entry is quiet, not blue`, !(await entry.getAttribute("class")).includes("primary") && (await entry.getAttribute("aria-haspopup")) === "dialog");
    if (one) {
      await pg.getByRole("button", { name: "More" }).click();
      check("desktop header More has no “Use in your editor” row (Q5)", (await pg.getByRole("menuitem", { name: /Use in your editor/ }).count()) === 0);
      await pg.keyboard.press("Escape");
    }
    await shot(pg, "d-home", theme);
    await entry.click();
    await ue(pg).waitFor();
    await settle(pg);
    check(`${theme}: Home button opens the popover, aria-expanded`, (await entry.getAttribute("aria-expanded")) === "true");
    check(`${theme}: agent Claude Code → Claude Code tab`, (await selectedTab(pg)) === "Claude Code");
    check(`${theme}: focus goes to the selected tab`, (await active(pg)) === "tab:Claude Code");
    check(`${theme}: the Claude command is the server's, verbatim`, (await code(pg)) === LOCAL.claude, await code(pg));
    check(`${theme}: from Home, “Then ask” is one sentence with no copy`, (await ue(pg).locator(".ask button").count()) === 0 && /To build one of your Grillado plans/.test(await ue(pg).locator(".ask").textContent()));
    await shot(pg, "d-homepop", theme);
    await axe(pg, `${theme} desktop: popover from Home`);
    await pg.keyboard.press("Escape");
    check(`${theme}: Esc closes and focus returns to the Home button`, (await ue(pg).count()) === 0 && (await active(pg)) === "BUTTON:Use in your editor");

    if (one) {
      // §7: Codex in use → Codex; another agent → the last tab picked; nothing stored → Claude Code.
      await select(pg, "codex");
      await pg.reload();
      await pg.getByRole("button", { name: "Use in your editor" }).click();
      check("agent Codex → Codex tab", (await selectedTab(pg)) === "Codex");
      await ue(pg).getByRole("tab", { name: "Cursor" }).click();
      check("picking a tab stores it", (await pg.evaluate(() => localStorage.getItem("grillado.editor"))) === "cursor");
      await pg.keyboard.press("Escape");
      await select(pg, "pi");
      await pg.reload();
      await pg.getByRole("button", { name: "Use in your editor" }).click();
      check("another agent + stored cursor → Cursor tab", (await selectedTab(pg)) === "Cursor");
      await pg.keyboard.press("Escape");
      await pg.evaluate(() => localStorage.removeItem("grillado.editor"));
      await pg.reload();
      await pg.getByRole("button", { name: "Use in your editor" }).click();
      check("another agent, nothing stored → Claude Code tab", (await selectedTab(pg)) === "Claude Code");
      // A click outside closes without moving focus.
      await pg.mouse.click(200, 700);
      check("a click outside closes", (await ue(pg).count()) === 0);
      await select(pg, "claude");
    }

    // ---------------- from the plan
    await pg.goto(`${new URL(app.url).origin}/s/${planId}${new URL(app.url).search}`);
    await pg.getByTestId("plan").waitFor({ timeout: 15000 });
    await pg.getByRole("button", { name: "Plan actions" }).click();
    const items = await pg.getByRole("menuitem").allTextContents();
    const at = items.indexOf("Use in your editor…");
    check(`${theme}: ⋯ has “Use in your editor…” first in the file group`, at > 0 && items[at + 1] === "Download .md" && /Add diagrams/.test(items[at - 1]), items.join(" | "));
    await shot(pg, "d-menu", theme);
    await pg.getByRole("menuitem", { name: "Use in your editor…" }).click();
    await ue(pg).waitFor();
    await settle(pg);
    check(`${theme}: the plan's ⋯ opens the popover anchored under ⋯, right-aligned`, await pg.evaluate(() => { const a = document.querySelector('[aria-label="Plan actions"]').getBoundingClientRect(); const p = document.querySelector("[data-testid=use-in-editor]").getBoundingClientRect(); return Math.abs(p.top - a.bottom - 6) < 2 && Math.abs(p.right - a.right) < 2 && Math.round(p.width) === 480; }));
    check(`${theme}: Copy Markdown stays the one blue button`, (await pg.locator(".btn.primary:visible").count()) === 1);
    const cm = await pg.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.background = "var(--primary)";
      document.body.append(probe);
      const blue = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { bg: getComputedStyle(document.querySelector(".copy-md")).backgroundColor, blue, open: !!document.querySelector(".ue.pop5") };
    });
    check(`${theme} MF1 (#111): .copy-md keeps its primary blue while .ue is open`, cm.open && cm.bg === cm.blue, JSON.stringify(cm));
    const tabs = await ue(pg).getByRole("tab").first().evaluate((b) => `${getComputedStyle(b).fontSize}/${getComputedStyle(b).fontWeight}`);
    check(`${theme}: tab labels are 14/500`, tabs === "14px/500", tabs);
    const selBg = await ue(pg).locator(".well pre").evaluate((e) => {
      const probe = document.createElement("span");
      probe.style.background = "color-mix(in oklab, var(--primary) 30%, transparent)";
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { got: getComputedStyle(e, "::selection").backgroundColor, want };
    });
    check(`${theme}: .ue ::selection is primary at 30%`, selBg.got === selBg.want, JSON.stringify(selBg));
    const request = `Build the Grillado plan “${plannedTitle}”.`;
    check(`${theme}: “Then ask Claude Code” with the request for this plan`, (await ue(pg).locator(".ask .sl").textContent()) === "Then ask Claude Code" && (await ue(pg).locator(".rq span").textContent()) === request);
    await shot(pg, "d-pop", theme);
    await axe(pg, `${theme} desktop: popover from the plan`);
    const copyBtn = ue(pg).getByRole("button", { name: "Copy the Claude Code command" });
    const w0 = (await copyBtn.boundingBox()).width;
    await copyBtn.hover();
    await shot(pg, "d-hover", theme);
    await copyBtn.click();
    const copied = ue(pg).getByRole("button", { name: "Copied" });
    await copied.waitFor({ timeout: 1000 });
    check(`${theme}: Copy writes exactly the snippet`, (await pg.evaluate(() => navigator.clipboard.readText())) === LOCAL.claude);
    check(`${theme}: Copied is announced politely`, (await ue(pg).locator("[aria-live=polite]").textContent()) === "Copied the Claude Code command");
    check(`${theme}: the button keeps its width`, Math.abs((await copied.boundingBox()).width - w0) < 0.5);
    await shot(pg, "d-copied", theme);
    if (one) {
      await pg.waitForTimeout(900);
      await copied.click(); // a click during Copied restarts the hold
      await pg.waitForTimeout(900);
      check("a click during Copied restarts the 1500ms hold", (await ue(pg).getByRole("button", { name: "Copied" }).count()) === 1);
    }
    await ue(pg).getByRole("button", { name: "Copy the Claude Code command" }).waitFor({ timeout: 2500 });
    check(`${theme}: back to Copy after the hold`, true);
    check(`${theme}: the label reads Copy again`, (await ue(pg).locator(".cbtn .lb .a").evaluate((e) => getComputedStyle(e).opacity)) === "1");

    // the switch: arrows select, Home/End, stored
    await ue(pg).getByRole("tab", { name: "Claude Code" }).focus();
    await pg.keyboard.press("ArrowRight");
    check(`${theme}: → selects Cursor and moves focus`, (await selectedTab(pg)) === "Cursor" && (await active(pg)) === "tab:Cursor");
    check(`${theme}: Cursor config verbatim (user-level ~/.cursor/mcp.json, type stdio)`, (await code(pg)) === LOCAL.cursor && /~\/\.cursor\/mcp\.json/.test(await ue(pg).locator(".step .sl").textContent()));
    await shot(pg, "d-pop-cursor", theme);
    await pg.keyboard.press("End");
    check(`${theme}: End → Codex`, (await selectedTab(pg)) === "Codex");
    check(`${theme}: Codex config verbatim, plus the codex mcp add line`, (await code(pg)) === LOCAL.codex && (await ue(pg).locator(".alt code").textContent()) === `codex mcp add grillado -- ${NODE} ${CLI} mcp`);
    await shot(pg, "d-pop-codex", theme);
    const alt = await ue(pg).locator(".sn.alt").evaluate((p) => {
      const code = p.querySelector("code").getClientRects();
      const last = code[code.length - 1];
      const b = p.querySelector(".copy-inl").getBoundingClientRect();
      const cs = getComputedStyle(p.querySelector(".copy-inl"));
      const ring = parseFloat(cs.outlineOffset || "2") + 2; // :focus-visible ring, 2px at 2px offset
      const note = p.nextElementSibling.getBoundingClientRect();
      const prev = p.previousElementSibling.getBoundingClientRect();
      return { onLast: Math.abs((b.top + b.bottom) / 2 - (last.top + last.bottom) / 2) <= 3 && b.left >= last.right - 1, below: note.top - (b.bottom + ring), above: b.top - ring - prev.bottom };
    });
    check(`${theme}: Codex “Or run” copy sits on the code's last line, ring ≥4px clear of the note`, alt.onLast && alt.below >= 4 && alt.above >= 4, JSON.stringify(alt));
    // Tab order (§8): tab → Copy → Or run → request → Close → tab
    const order = [];
    for (let i = 0; i < 5; i++) {
      await pg.keyboard.press("Tab");
      order.push(await active(pg));
    }
    check(`${theme}: Tab cycles inside the popover in the handoff's order`, JSON.stringify(order) === JSON.stringify(["BUTTON:Copy the Codex config", "BUTTON:Copy the codex mcp add command", "BUTTON:Copy the request", "BUTTON:Close", "tab:Codex"]), order.join(" → "));
    if (one) {
      await pg.keyboard.press("Tab");
      await pg.keyboard.press("Tab");
      await shot(pg, "d-kbd-alt", theme);
      await pg.keyboard.press("Enter");
      check("Enter on Or run copies the codex mcp add line", (await pg.evaluate(() => navigator.clipboard.readText())) === `codex mcp add grillado -- ${NODE} ${CLI} mcp`);
      await pg.keyboard.press("Home");
    }
    await ue(pg).getByRole("tab", { name: "Claude Code" }).click();

    // A failing clipboard: no Copied, the snippet is selected, ⌘C / Ctrl+C hint; clears on a tab switch.
    await failClipboard(pg);
    await ue(pg).getByRole("button", { name: "Copy the Claude Code command" }).click();
    const err = ue(pg).locator(".err1[role=status]");
    await err.waitFor({ timeout: 1000 });
    check(`${theme}: failed copy shows the hint, not Copied`, /Couldn’t reach the clipboard\. The command is selected, so press (⌘C|Ctrl\+C)\./.test(await err.textContent()) && (await ue(pg).getByRole("button", { name: "Copied" }).count()) === 0);
    check(`${theme}: and selects the snippet`, (await pg.evaluate(() => getSelection().toString())) === LOCAL.claude);
    await shot(pg, "d-fail", theme);
    await ue(pg).getByRole("tab", { name: "Cursor" }).click();
    check(`${theme}: the hint clears on a tab switch`, (await err.count()) === 0);
    check(`${theme}: …and so does the failed copy's selection`, (await pg.evaluate(() => getSelection().toString())) === "");
    await fixClipboard(pg);
    await pg.keyboard.press("Escape");
    check(`${theme}: Esc returns focus to ⋯`, (await ue(pg).count()) === 0 && (await active(pg)) === "BUTTON:Plan actions");

    // Keyboard open: Enter on ⋯, no animation, focus on the tab; Enter on Copy swaps at once.
    await pg.evaluate(() => localStorage.setItem("grillado.editor", "claude"));
    await pg.getByRole("button", { name: "Plan actions" }).focus();
    await pg.keyboard.press("Enter");
    await pg.getByRole("menuitem", { name: "Use in your editor…" }).waitFor();
    for (let i = 0; i < 8 && !(await active(pg)).includes("Use in your editor"); i++) {
      await pg.keyboard.press("ArrowDown");
      await pg.waitForTimeout(40);
    }
    await pg.keyboard.press("Enter");
    await ue(pg).waitFor();
    await settle(pg);
    await pg.waitForTimeout(50);
    check(`${theme}: from the keys the popover appears at once`, await ue(pg).evaluate((e) => getComputedStyle(e).opacity === "1" && e.getAnimations().length === 0));
    check(`${theme}: and focus is on the selected tab`, (await active(pg)) === "tab:Claude Code", await active(pg));
    await shot(pg, "d-kbd-tab", theme);
    await pg.keyboard.press("Tab");
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(30);
    check(`${theme}: Enter on Copy: Copied at once, focus stays`, (await active(pg)) === "BUTTON:Copied" && (await ue(pg).locator(".cbtn .lb .b").evaluate((e) => getComputedStyle(e).opacity)) === "1");
    await shot(pg, "d-kbd-copied", theme);
    await pg.keyboard.press("Escape");

    // §9: a comment from Claude Code over MCP: “Claude Code · from your editor”, no time, rail stays shut.
    if (one) {
      const cc = await mcp(app.env, "claude-code");
      const md = await pg.evaluate(async (id) => (await fetch(`/api/sessions/${id}/plan.md`)).text(), planId);
      const quote = md.split("\n").find((l) => /^[A-Z]/.test(l) && l.length > 20).slice(0, 24);
      await cc.callTool({ name: "add_comment", arguments: { plan: planId, quote, text: "While building sync I found renames and ticks need different rules. Should a losing rename stay as a note?" } });
      await cc.close();
    }
    const toggle = pg.getByRole("button", { name: /^Comments 1/ });
    await toggle.waitFor({ timeout: 8000 });
    if (one) {
      // N2: the live arrival only bumps the count; the rail stays shut.
      check(`${theme}: the rail doesn't open by itself`, (await pg.getByRole("complementary", { name: "Comments" }).count()) === 0);
      await shot(pg, "d-live-arrival", theme);
    }
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    const rail = pg.getByRole("complementary", { name: "Comments" });
    const who = rail.locator(".msg .who").first();
    await who.waitFor();
    if (one) {
      // N2: a thread that arrived after page load fades in (160ms opacity, --d-quick); older ones don't.
      const th = rail.locator(".th.in1");
      check(`${theme}: the new thread fades in over 160ms`, (await th.count()) === 1 && /opacity 0\.16s/.test(await th.evaluate((e) => getComputedStyle(e).transition)), await th.count() ? await th.evaluate((e) => getComputedStyle(e).transition) : "none");
      check(`${theme}: its label names the editor (N1)`, /^Comment on .+ from Claude Code: “/.test((await th.getAttribute("aria-label")) ?? ""), await th.getAttribute("aria-label"));
    }
    check(`${theme}: editor comment: name from the client, “from your editor”, no time`, (await who.textContent()) === "Claude Codefrom your editor" && (await who.locator("svg").count()) === 1);
    await shot(pg, "d-rail", theme);
    await axe(pg, `${theme} desktop: rail with an editor comment`);
    await ctx.close();

    // ------------------------------------------------------------ phones
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true });
    await mctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(app.url).origin });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await mp.goto(app.url);
    await mp.getByRole("button", { name: "More" }).waitFor();
    check(`${theme} phone: no header button on Home`, (await mp.getByRole("button", { name: "Use in your editor" }).count()) === 0);
    await mp.getByRole("button", { name: "More" }).tap();
    const rows = await mp.getByRole("menuitem").allTextContents();
    const ri = rows.findIndex((r) => r === "Use in your editor…");
    check(`${theme} phone: More sheet row between the theme and Quit`, ri > 0 && /theme/.test(rows[ri - 1]) && /Quit/.test(rows[rows.length - 1]), rows.join(" | "));
    const rowH = async () => (await mp.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.offsetHeight)));
    const moreH = await rowH();
    check(`${theme} phone: More menu rows are at least 44px`, moreH.every((h) => h >= 44), moreH.join(","));
    await shot(mp, "m-home", theme);
    await mp.getByRole("menuitem", { name: "Use in your editor…" }).tap();
    await ue(mp).waitFor();
    check(`${theme} phone: a bottom sheet (modal)`, (await ue(mp).getAttribute("aria-modal")) === "true");
    await shot(mp, "m-homesheet", theme);
    await axe(mp, `${theme} phone: sheet from Home`);
    await ue(mp).getByRole("button", { name: "Close" }).tap();
    check(`${theme} phone: Close returns focus to More`, (await ue(mp).count()) === 0 && (await active(mp)) === "BUTTON:More", `${await ue(mp).count()} ${await active(mp)}`);

    await mp.goto(`${new URL(app.url).origin}/s/${planId}${new URL(app.url).search}`);
    await mp.getByTestId("plan").waitFor({ timeout: 15000 });
    await mp.getByRole("button", { name: "Plan actions" }).tap();
    const mitems = await mp.getByRole("menuitem").allTextContents();
    const mi = mitems.indexOf("Use in your editor…");
    check(`${theme} phone: ⋯ sheet has the row after Comments' group`, mi > 0 && mitems[mi + 1] === "Download .md" && /Activity|Comments/.test(mitems[mi - 1]), mitems.join(" | "));
    const dotsH = await rowH();
    check(`${theme} phone: ⋯ menu rows are at least 44px`, dotsH.every((h) => h >= 44), dotsH.join(","));
    await shot(mp, "m-menu", theme);
    await mp.getByRole("menuitem", { name: "Use in your editor…" }).tap();
    await ue(mp).waitFor();
    const big = ue(mp).getByRole("button", { name: "Copy command for Claude Code" });
    const bb = await big.boundingBox();
    check(`${theme} phone: Copy is a full-width 44px button under the well`, bb.height >= 44 && bb.width > 300 && /Copy command/.test(await big.textContent()));
    const targets = await ue(mp).locator("button").evaluateAll((bs) => bs.filter((b) => b.offsetParent).map((b) => Math.round(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))));
    check(`${theme} phone: every target in the sheet is 44px`, targets.every((t) => t >= 44), targets.join(","));
    await shot(mp, "m-sheet", theme);
    await axe(mp, `${theme} phone: sheet from the plan`);
    await big.tap();
    await ue(mp).getByRole("button", { name: "Copied" }).waitFor({ timeout: 1000 });
    check(`${theme} phone: Copy command → Copied`, (await mp.evaluate(() => navigator.clipboard.readText())) === LOCAL.claude);
    await shot(mp, "m-copied", theme);
    await mp.waitForTimeout(1600);
    await failClipboard(mp);
    await ue(mp).getByRole("button", { name: "Copy command for Claude Code" }).tap();
    await ue(mp).locator(".err1").waitFor({ timeout: 1000 });
    check(`${theme} phone: failed copy says long-press`, /so long-press it and choose Copy\./.test(await ue(mp).locator(".err1").textContent()));
    await shot(mp, "m-fail", theme);
    await fixClipboard(mp);
    await ue(mp).getByRole("tab", { name: "Cursor" }).tap();
    await shot(mp, "m-sheet-cursor", theme);
    await ue(mp).getByRole("tab", { name: "Codex" }).tap();
    const malt = await ue(mp).locator(".sn.alt").evaluate((p) => {
      const code = p.querySelector("code").getClientRects();
      const last = code[code.length - 1];
      const b = p.querySelector(".copy-inl").getBoundingClientRect();
      const note = p.nextElementSibling.getBoundingClientRect();
      const prev = p.previousElementSibling.getBoundingClientRect();
      return { onLast: Math.abs((b.top + b.bottom) / 2 - (last.top + last.bottom) / 2) <= 3 && b.left >= last.right - 1, below: note.top - (b.bottom + 4), above: b.top - 4 - prev.bottom, h: b.height };
    });
    check(`${theme} phone: Codex “Or run” copy (44px) sits on the code's last line, ring ≥4px clear`, malt.onLast && malt.h >= 44 && malt.below >= 4 && malt.above >= 4, JSON.stringify(malt));
    await mp.locator(".cscrim").tap({ position: { x: 20, y: 20 } });
    check(`${theme} phone: a scrim tap closes, focus back on ⋯`, (await ue(mp).count()) === 0 && (await active(mp)) === "BUTTON:Plan actions", `${await ue(mp).count()} ${await active(mp)}`);
    await mctx.close();
  }

  // Reduced motion: the popover only fades (no scale).
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1, reducedMotion: "reduce" });
    await ctx.addInitScript(() => localStorage.setItem("grillado-theme", "dark"));
    const pg = await ctx.newPage();
    await pg.goto(`${new URL(app.url).origin}/s/${planId}${new URL(app.url).search}`);
    await pg.getByTestId("plan").waitFor({ timeout: 15000 });
    await openFromPlan(pg);
    check("reduced motion: no scale on the popover", await ue(pg).evaluate((e) => getComputedStyle(e).transform === "none"));
    await shot(pg, "d-reduced-pop", "dark");
    await ctx.close();
  }
} finally {
  await app.stop();
}

// A custom data dir (Q7): every snippet carries GRILLADO_HOME, and only then.
const app2 = await server("grillado-data");
try {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const id = theme === "dark" ? await plate(pg, app2.url, "Shared shopping list for my flat") : planId;
    if (theme === "dark") planId = id;
    else await pg.goto(`${new URL(app2.url).origin}/s/${id}${new URL(app2.url).search}`);
    await pg.getByTestId("plan").waitFor({ timeout: 15000 });
    await openFromPlan(pg);
    const dir = app2.dir;
    check(`${theme}: custom dir → Claude gets --env before the name`, (await code(pg)) === `claude mcp add --scope user --env GRILLADO_HOME=${dir} grillado -- ${NODE} ${CLI} mcp`, await code(pg));
    await shot(pg, "d-pop-env", theme);
    await ue(pg).getByRole("tab", { name: "Cursor" }).click();
    check(`${theme}: custom dir → Cursor gets "env"`, JSON.parse(await code(pg)).mcpServers.grillado.env.GRILLADO_HOME === dir);
    if (theme === "dark") await shot(pg, "d-pop-cursor-env", theme);
    await ue(pg).getByRole("tab", { name: "Codex" }).click();
    check(`${theme}: custom dir → Codex gets an env table and --env on the add line`, (await code(pg)).endsWith(`[mcp_servers.grillado.env]\nGRILLADO_HOME = "${dir}"`) && (await ue(pg).locator(".alt code").textContent()).startsWith(`codex mcp add --env GRILLADO_HOME=${dir} grillado`));
    if (theme === "dark") await shot(pg, "d-pop-codex-env", theme);
    await axe(pg, `${theme} desktop: popover with a custom data dir`);
    await ctx.close();
  }
} finally {
  await app2.stop();
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
