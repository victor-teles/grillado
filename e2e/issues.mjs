// v1.3 item 2 end-to-end: "Send to issues" (HANDOFF-ENGINEER-item2 §1–§9). The ⋯ item, the sheet
// (destination, labels, preview, approval card), nothing written before the confirm, a partial run and
// Retry failed, the strip and the decision chips, an update with an issue edited in GitHub and one
// deleted, gh fix-its, Linear connect/bad key/disconnect, phones at 390 and 320, both themes, axe.
// Never talks to GitHub or Linear: a fake gh (test/fixtures/fake-gh.mjs) and a local Linear mock.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/issues.mjs                 checks only
//   SHOTS=dir node e2e/issues.mjs       also writes the frames to dir
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-is-"));
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

// ---------------------------------------------------------------- fakes
const bin = mkdtempSync(path.join(WORK, "bin-"));
// The agent's knobs (FAKE_SPLIT_DELAY_MS…) live in a file too, so one server can see a slow split.
const ACTL = path.join(bin, "agent-ctl.sh");
// Every split the agent runs is logged, so the e2e can tell that opening the sheet ran nothing (BIG-3 B).
const SPLIT_LOG = path.join(bin, "splits.log");
const splits = () => (existsSync(SPLIT_LOG) ? readFileSync(SPLIT_LOG, "utf8").split("\n").filter(Boolean).length : 0);
const actl = (env = {}) => writeFileSync(ACTL, Object.entries({ FAKE_SPLIT_LOG: SPLIT_LOG, ...env }).map(([k, v]) => `export ${k}=${v}\n`).join(""));
actl();
for (const id of ["claude", "codex", "pi"]) {
  writeFileSync(path.join(bin, id), `#!/bin/sh\n. "${ACTL}"\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" ${id} "$@"\n`);
  chmodSync(path.join(bin, id), 0o755);
}
// gh: the fake, with its knobs in a file so one server can see gh missing, logged out, public…
const GHDIR = mkdtempSync(path.join(WORK, "gh-"));
const CTL = path.join(GHDIR, "ctl.sh");
const ctl = (env = {}) => writeFileSync(CTL, Object.entries(env).map(([k, v]) => `export ${k}=${v}\n`).join(""));
ctl();
writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n. "${CTL}"\n[ "$GH_MISSING" = 1 ] && exit 127\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-gh.mjs")}" "$@"\n`);
chmodSync(path.join(bin, "gh"), 0o755);
const ghCalls = () => (existsSync(path.join(GHDIR, "argv.jsonl")) ? readFileSync(path.join(GHDIR, "argv.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args) : []);
const isWrite = (a) => (a[0] === "issue" && ["create", "edit", "close", "delete"].includes(a[1])) || (a[0] === "label" && a[1] === "create") || (a[0] === "api" && a.some((x, i) => (x === "-X" || x === "--method") && /POST|PATCH|PUT|DELETE/.test(a[i + 1] ?? "")));
const ghState = () => JSON.parse(readFileSync(path.join(GHDIR, "state.json"), "utf8"));
const ghEdit = (fn) => {
  const st = ghState();
  fn(st);
  writeFileSync(path.join(GHDIR, "state.json"), JSON.stringify(st, null, 2));
};

// Linear: GraphQL on 127.0.0.1 (the CLI only accepts a loopback GRILLADO_LINEAR_URL).
const linearReqs = [];
const linear = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const { query } = JSON.parse(raw || "{}");
    linearReqs.push(query);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "lin_api_good") return send(400, { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] });
    if (/viewer/.test(query)) return send(200, { data: { viewer: { id: "u1", name: "Victor" } } });
    if (/teams\(/.test(query)) return send(200, { data: { teams: { nodes: [{ id: "team-1", name: "Core", key: "COR" }] } } });
    if (/projects\(/.test(query)) return send(200, { data: { team: { projects: { nodes: [{ id: "proj-1", name: "Grillado" }] } } } });
    if (/labels\(/.test(query)) return send(200, { data: { team: { labels: { nodes: [{ id: "label-1", name: "feature", color: "#5e6ad2" }] } } } });
    if (/issues\(/.test(query)) return send(200, { data: { issues: { nodes: [] } } });
    send(400, { errors: [{ message: "mock: unsupported" }] });
  });
});
await new Promise((r) => linear.listen(0, "127.0.0.1", r));
const LINEAR_URL = `http://127.0.0.1:${linear.address().port}/graphql`;

// The project: a git folder whose origin is on GitHub (local git only).
const proj = mkdtempSync(path.join(WORK, "proj-"));
execFileSync("git", ["init", "-q", proj]);
execFileSync("git", ["-C", proj, "remote", "add", "origin", "git@github.com:victor-teles/grillado.git"]);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
/** BIG-3: option B, false (DECISIONS #186; Victor chose B on 2026-10-28). The e2e follows whichever value it has. */
const SPLIT_ON_OPEN = /const SPLIT_ON_OPEN = (true|false);/.exec(readFileSync(path.join(ROOT, "web/src/app/issues/IssuesSheet.tsx"), "utf8"))?.[1] === "true";
console.log(`BIG-3: SPLIT_ON_OPEN = ${SPLIT_ON_OPEN}`);
async function server({ cwd = proj, config, scan = false, pre = "", homeSetup } = {}) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  homeSetup?.(home);
  if (config) {
    mkdirSync(path.join(home, ".grillado"), { recursive: true });
    writeFileSync(path.join(home, ".grillado", "config.json"), JSON.stringify(config));
  }
  const env = { PATH: `${pre}${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_GH_DIR: GHDIR, GRILLADO_LINEAR_URL: LINEAR_URL };
  const child = spawn(NODE, [CLI, "--no-open", ...(scan ? [] : ["--no-scan"]), "--port", String(await freePort())], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  return { url, dir: env.GRILLADO_HOME, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}

// ---------------------------------------------------------------- helpers
const pickIfAsked = async (pg, name) => {
  const r = pg.getByRole("radio", { name });
  await r.or(pg.getByRole("textbox", { name: "What are you planning?" })).first().waitFor({ timeout: 15000 });
  if (await r.isVisible()) {
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
async function axe(pg, name) {
  await pg.waitForTimeout(400);
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
async function shot(pg, name, theme) {
  if (!SHOTS) return;
  await pg.waitForFunction(() => !document.querySelector(".toast,.gr-notice"), null, { timeout: 6000 }).catch(() => {});
  await settle(pg);
  await pg.waitForTimeout(250);
  await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
}
const settle = (pg) => pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
const active = (pg) => pg.evaluate(() => { const a = document.activeElement; return `${a?.getAttribute("role") ?? a?.tagName}:${a?.getAttribute("aria-label") ?? a?.textContent?.trim()}`; });
const sheet = (pg) => pg.getByTestId("issues-sheet");
const go = (pg) => sheet(pg).getByTestId("issues-confirm");
const foot = (pg) => sheet(pg).locator(".iac");
/** The card's first line, with the · separators spaced as they read. */
const sum = async (pg) => (await foot(pg).locator(".iac-t").textContent()).replace(/\s*·\s*/g, " · ").trim();
const menuItems = async (pg) => {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menu").waitFor();
  return pg.getByRole("menu").getByRole("menuitem").allTextContents();
};
async function openSheet(pg) {
  await menuItems(pg);
  await pg.getByTestId("menu-issues").click();
  await sheet(pg).waitFor();
  await sheet(pg).locator(".ir:not(.sk)").first().waitFor({ timeout: 10000 });
  await settle(pg);
}
/** Targets under 44px, counting a ::after hit area (#172). The 40px destination tabs are as spec'd. */
const smallTargets = (pg, scope) =>
  pg.evaluate((scope) => {
    const out = [];
    for (const root of document.querySelectorAll(scope))
      for (const el of root.querySelectorAll("button,a[href],[role=checkbox],[role=option],textarea,input,[tabindex='0']")) {
        if (el.getAttribute("role") === "tab" || el.closest(".sr-only")) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
        let w = r.width;
        let h = r.height;
        const a = getComputedStyle(el, "::after");
        if (a.content && a.content !== "none" && a.position === "absolute") {
          const px = (v) => (v === "auto" ? 0 : parseFloat(v) || 0);
          w = Math.max(w, r.width - px(a.left) - px(a.right));
          h = Math.max(h, r.height - px(a.top) - px(a.bottom));
        }
        if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}[${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 28)}] ${w.toFixed(0)}×${h.toFixed(0)}`);
      }
    return [...new Set(out)];
  }, scope);
/**
 * Review r2 must: hit areas, measured by tapping. Every control in the scope is scrolled into view and probed
 * with elementFromPoint: through its centre, top to bottom and left to right, it must own ≥44px (the 40px tabs
 * ≥40px), and no point of its own box may land on another control (a hit area covering it).
 */
const hitAudit = (pg, scope) =>
  pg.evaluate((scope) => {
    const SEL = "button,a[href],[role=checkbox],[role=option],[role=tab],textarea,input,select,[tabindex='0']";
    const owner = (x, y) => document.elementFromPoint(x, y)?.closest(SEL) ?? null;
    const name = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("placeholder") ?? "").trim().replace(/\s+/g, " ").slice(0, 24)}]`;
    const out = [];
    const scrolled = [...document.querySelectorAll(".ish-b")].map((e) => [e, e.scrollTop]);
    const wy = window.scrollY;
    const all = [...document.querySelectorAll(scope)].flatMap((r) => [...r.querySelectorAll(SEL)]);
    for (const el of all) {
      if (el.closest(".sr-only") || el.closest("[aria-hidden=true]")) continue;
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      const need = el.getAttribute("role") === "tab" ? 39.5 : 43.5;
      // A link that wraps has several boxes: probe through the first one.
      const b = el.getClientRects()[0] ?? r;
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      let v = 0;
      let h = 0;
      for (let y = Math.floor(b.top - 40); y <= b.bottom + 40; y++) if (owner(cx, y + 0.5) === el) v++;
      for (let x = Math.floor(b.left - 40); x <= b.right + 40; x++) if (owner(x + 0.5, cy) === el) h++;
      if (v < need || h < need) out.push(`${name(el)} owns ${h}×${v}`);
      for (let y = r.top + 1; y < r.bottom; y += 2)
        for (let x = r.left + 1; x < r.right; x += 2) {
          const o = owner(x, y);
          if (o && o !== el && !o.contains(el) && !el.contains(o)) {
            out.push(`${name(o)} covers ${name(el)} at y${Math.round(y - r.top)}`);
            y = r.bottom;
            break;
          }
        }
    }
    for (const [e, y] of scrolled) e.scrollTop = y;
    window.scrollTo(0, wy);
    return [...new Set(out)];
  }, scope);
const planUrl = (app, id) => `${new URL(app.url).origin}/s/${id}${new URL(app.url).search}`;
const errors = [];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const app = await server();
let planId = "";
try {
  // ============================================================== desktop, dark: the whole flow
  {
    const theme = "dark";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    planId = await plate(pg, app.url, "A recipe box for my family");

    // §1 the ⋯ item, after “Use in your editor…”
    const items = await menuItems(pg);
    const at = items.findIndex((t) => t.startsWith("Create issues…"));
    check("⋯ has “Create issues…” right after “Use in your editor…”", at > 0 && items[at - 1] === "Use in your editor…", items.join(" | "));
    check("the item is enabled on a finished plan", (await pg.getByTestId("menu-issues").getAttribute("aria-disabled")) === null);
    await shot(pg, "d-menu", theme);
    await pg.keyboard.press("Escape");

    // §2 the sheet: focus, destination, nothing written
    await openSheet(pg);
    check("the sheet is a modal dialog named “Create issues”", (await sheet(pg).getAttribute("aria-modal")) === "true" && (await pg.getByRole("dialog", { name: "Create issues" }).count()) === 1);
    check("focus starts on the selected destination tab", (await active(pg)) === "tab:GitHub", await active(pg));
    check("Copy Markdown is hidden while the sheet is open", await pg.evaluate(() => document.documentElement.classList.contains("ish-open")));
    const repoBtn = sheet(pg).getByRole("button", { name: "Repository" });
    check("the repository is origin’s", (await repoBtn.textContent()).includes("victor-teles/grillado"));
    await sheet(pg).locator(".ifl .ihn", { hasText: /gh as @/ }).waitFor({ timeout: 5000 });
    check("the hint says where it came from and who gh is", /^From origin · github\.com · gh as @\S+$/.test(await sheet(pg).locator(".ifl .ihn").first().textContent()), await sheet(pg).locator(".ifl .ihn").first().textContent());
    await go(pg).waitFor();
    await pg.waitForFunction(() => !document.querySelector("[data-testid=issues-confirm]")?.disabled, null, { timeout: 8000 }).catch(() => {});
    const btn0 = await go(pg).textContent();
    check("the button says how many and where", /^Create \d+ issues? in victor-teles\/grillado$/.test(btn0), btn0);
    check("the how-line names gh and promises nothing is sent yet", /^Runs gh as @\S+ on this computer\. Nothing is sent before you click\.$/.test(await foot(pg).locator(".iac-n").last().textContent()));
    check("no public line on a private repo", (await sheet(pg).locator(".pub").count()) === 0);

    // §3 the split. BIG-3: option B, "Split only when I ask" (DECISIONS #186). This follows SPLIT_ON_OPEN.
    const src = sheet(pg).locator(".ipv-src").first();
    if (SPLIT_ON_OPEN) {
      await sheet(pg).getByText(/^Split by Claude Code into/).waitFor({ timeout: 15000 });
      check("BIG-3 A (SPLIT_ON_OPEN = true): opening split the plan with the agent", /^Split by Claude Code into/.test(await src.textContent()), await src.textContent());
    } else {
      const before = splits();
      const ask = sheet(pg).locator(".iask");
      await ask.waitFor({ timeout: 8000 });
      await pg.waitForTimeout(1500);
      check("BIG-3 B: opening the sheet runs no split (the agent wasn’t called)", splits() === before, `${before} → ${splits()}`);
      check("BIG-3 B: nothing says it is splitting", (await sheet(pg).getByText(/is splitting the plan/).count()) === 0);
      check("BIG-3 B: the list shows right away, no skeleton (this plan has no user stories, so the parent alone)", (await sheet(pg).locator(".ir.sk").count()) === 0 && (await sheet(pg).locator(".ir:not(.sk)").count()) === 1, String(await sheet(pg).locator(".ir:not(.sk)").count()));
      check("BIG-3 B: the split is offered", /^Right now it’s only the parent issue\. Claude Code can split the plan into slices that each cover their decisions\.\s*Split with Claude Code$/.test(await ask.textContent()), await ask.textContent());
      const sbtn = ask.getByRole("button", { name: "Split with Claude Code" });
      check("BIG-3 B: “Split with Claude Code” is a real button (soft)", (await sbtn.getAttribute("class"))?.includes("btn soft"), await sbtn.getAttribute("class"));
      await sbtn.click();
      await sheet(pg).getByText(/^Split by Claude Code into/).waitFor({ timeout: 15000 });
      check("BIG-3 B: clicking Split runs the agent once", splits() === before + 1, `${before} → ${splits()}`);
    }
    const rows = sheet(pg).locator(".ir:not(.sk)");
    const n = await rows.count();
    check("split: the parent plus slices", n >= 2, String(n));
    {
      // Demo finding: chips name the decision by its short title; the R·n code is only in the title attribute.
      const cov = rows.nth(1).locator(".cov");
      const b = cov.locator("b").first();
      const bt = (await b.textContent()) ?? "";
      check("slices say which decisions they cover, by title (the R·n code only in the title attribute)", /^Covers \S/.test(await cov.textContent()) && !/R\d+·\d/.test(await cov.textContent()) && /^R\d+·\d+$/.test((await b.getAttribute("title")) ?? "") && bt.length > 3, `${await cov.textContent()} | ${await b.getAttribute("title")}`);
      const cut = await b.evaluate((e) => {
        const st = getComputedStyle(e);
        const row = e.closest(".ir").getBoundingClientRect();
        // A long title: lengthen this chip's text and see it end in an ellipsis inside its row.
        const was = e.textContent;
        e.textContent = `${was} ${"and a much longer decision title ".repeat(4)}`;
        const r = e.getBoundingClientRect();
        const out = { ellipsis: st.textOverflow === "ellipsis", nowrap: st.whiteSpace === "nowrap", over: e.scrollWidth > e.clientWidth, inside: r.right <= row.right + 0.5, h: Math.round(r.height) };
        e.textContent = was;
        return out;
      });
      check("a long decision title in Covers ends in an ellipsis on one line, inside the row", cut.ellipsis && cut.nowrap && cut.over && cut.inside && cut.h <= 20, JSON.stringify(cut));
    }
    await shot(pg, "d-sheet", theme);
    await axe(pg, `${theme} desktop: the sheet`);

    // Body disclosure: exactly what is sent (BIG-1: option A, the spec's wording, DECISIONS #185).
    const x = rows.nth(1).locator(".ir-x");
    await x.click();
    const kb = await rows.nth(1).locator(".ir-body pre").textContent();
    check("Body opens the exact body", (await x.getAttribute("aria-expanded")) === "true" && kb.includes("grillado:plan="));
    check("BIG-1 A: a child is its slice, “**Covers:** question answer” (no R·n code), then where it came from", /\n\n\*\*Covers:\*\* \S/.test(kb) && !/R\d+·\d/.test(kb) && /\n\nFrom Grillado plan ‘[^’]+’\n<!-- grillado:plan=[\w-]+ item=[\w-]+ -->\s*$/.test(kb), kb);
    await shot(pg, "d-body", theme);
    await x.click();
    const px = rows.nth(0).locator(".ir-x");
    await px.click();
    const pb = await rows.nth(0).locator(".ir-body pre").textContent();
    const pos = (h) => pb.indexOf(h);
    check("BIG-1 A: the parent is Problem, Solution, the decisions, Out of scope, then where it came from", pos("## Problem\n") === 0 && pos("## Decisions\n- **") > 0 && ["## Problem", "## Solution", "## Decisions", "## Out of scope"].map(pos).filter((i) => i >= 0).every((i, k, a) => !k || a[k - 1] < i) && !pb.includes("User stories") && /\n\nFrom Grillado plan ‘[^’]+’\n<!-- grillado:plan=[\w-]+ item=plan -->\s*$/.test(pb), pb);
    await shot(pg, "d-parentbody", theme);
    await px.click();

    // Selection: the parent is locked while a child is on; the count follows.
    const parentCb = rows.nth(0).getByRole("checkbox");
    check("the parent is locked while any child is selected", (await parentCb.getAttribute("aria-disabled")) === "true");
    await rows.nth(1).getByRole("checkbox").click();
    const btn1 = await go(pg).textContent();
    check("unchecking a child counts one fewer", Number(/\d+/.exec(btn1)[0]) === Number(/\d+/.exec(await go(pg).textContent())[0]) && Number(/\d+/.exec(btn1)[0]) === n - 1, btn1);
    await rows.nth(1).getByRole("checkbox").click();

    // A title edit; Enter moves on, never adds a line.
    const t1 = rows.nth(1).locator("textarea");
    await t1.fill("Keep recipes on the device");
    await t1.press("Enter");
    check("Enter in a title moves to the next title", (await active(pg)).startsWith("TEXTAREA:Issue title") && (await t1.inputValue()) === "Keep recipes on the device");

    // Esc order (§9): the listbox first, then the sheet; focus back on ⋯.
    await repoBtn.click();
    await sheet(pg).getByRole("listbox", { name: "Repositories" }).waitFor();
    check("the repo list tags origin", (await sheet(pg).getByRole("option").first().textContent()).includes("origin"));
    await pg.keyboard.type("acme/payments");
    check("a typed owner/repo can be used", (await sheet(pg).getByRole("option", { name: /Use acme\/payments/ }).count()) === 1);
    await shot(pg, "d-repos", theme);
    await pg.keyboard.press("Escape");
    check("Esc closes the list first, focus back on Repository", (await sheet(pg).count()) === 1 && (await sheet(pg).getByRole("listbox").count()) === 0 && (await active(pg)).includes("victor-teles/grillado"), await active(pg));
    // Labels: add a known one and a new one.
    await sheet(pg).getByRole("button", { name: "Add label" }).click();
    await sheet(pg).getByRole("option", { name: /bug/ }).click();
    await sheet(pg).getByRole("button", { name: "Add label" }).click();
    await pg.keyboard.type("v1.3");
    await sheet(pg).getByRole("option", { name: /Create label “v1\.3”/ }).waitFor();
    await pg.keyboard.press("Enter");
    const what = await foot(pg).locator(".iac-t").textContent();
    check("the card lists labels and the one it creates", /labels bug, v1\.3 · also creates the label v1\.3$/.test(what), what);
    await shot(pg, "d-labels", theme);
    check("nothing was written to GitHub before the confirm", ghCalls().filter(isWrite).length === 0, JSON.stringify(ghCalls().filter(isWrite)));
    // Closing with the pointer fades out over 160ms before the sheet goes (keyboard mode closes at once).
    await sheet(pg).getByRole("button", { name: "Close" }).click();
    const out = await sheet(pg).evaluate((el) => ({ leaving: el.hasAttribute("data-leaving"), dur: getComputedStyle(el).transitionDuration, scrim: getComputedStyle(document.querySelector(".ischrim")).transitionDuration })).catch(() => null);
    check("close fades the sheet and the backdrop out over 160ms", out?.leaving && out.dur.split(",")[0].trim() === "0.16s" && out.scrim === "0.16s", JSON.stringify(out));
    await sheet(pg).waitFor({ state: "detached" });
    await openSheet(pg);
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });
    check("Esc closes the sheet, focus back on ⋯", (await active(pg)) === "BUTTON:Plan actions", await active(pg));

    // Public repos say so (§4).
    ctl({ FAKE_GH_VISIBILITY: "PUBLIC" });
    await openSheet(pg);
    await sheet(pg).locator(".pub").waitFor({ timeout: 5000 }).catch(() => {});
    check("a public repo shows the public line", (await sheet(pg).locator(".pub").textContent().catch(() => "")) === "Public repo: anyone can read these issues");
    check("the hint says public", (await sheet(pg).locator(".ifl .ihn").first().textContent()).includes("· public"));
    await shot(pg, "d-public", theme);
    ctl({ FAKE_GH_FAIL_CREATE: "3" });
    await pg.keyboard.press("Escape");

    // §5 the run: a partial failure, then Retry failed.
    await openSheet(pg);
    await sheet(pg).getByText(/^Split by Claude Code/).waitFor();
    await pg.waitForFunction(() => !document.querySelector("[data-testid=issues-confirm]")?.disabled, null, { timeout: 8000 });
    const before = ghCalls().filter(isWrite).length;
    await go(pg).click();
    await sheet(pg).locator(".iac[data-k=partial],.iac[data-k=done]").waitFor({ timeout: 20000 });
    check("a failed create is a partial run", (await foot(pg).getAttribute("data-k")) === "partial", await foot(pg).textContent());
    check("the summary counts created and failed", /^\d+ created · 1 failed · victor-teles\/grillado$/.test(await sum(pg)), await sum(pg));
    check("the failed row says GitHub’s words", /^GitHub said: \S/.test(await sheet(pg).locator(".ir-why").first().textContent()), await sheet(pg).locator(".ir-why").first().textContent());
    check("Retry failed takes focus", (await active(pg)) === "BUTTON:Retry failed", await active(pg));
    check("the confirm was the first write", before === 0 && ghCalls().filter(isWrite).length > 0);
    await shot(pg, "d-partial", theme);
    await axe(pg, `${theme} desktop: partial run`);
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".iac[data-k=done]").waitFor({ timeout: 20000 });
    check("Retry failed creates only the failed one", (await sum(pg)) === "1 created · victor-teles/grillado", await sum(pg));
    check("Open parent issue links #1", (await sheet(pg).getByRole("link", { name: /Open parent issue/ }).getAttribute("href")) === "https://github.com/victor-teles/grillado/issues/1");
    check("Done takes focus", (await active(pg)) === "BUTTON:Done");
    await shot(pg, "d-done", theme);
    await pg.keyboard.press("Enter");
    await sheet(pg).waitFor({ state: "detached" });

    // §8 the strip and chips.
    const strip = pg.getByTestId("issues-strip");
    await strip.waitFor({ timeout: 8000 });
    await pg.waitForFunction(() => /sub-issues? · victor-teles\/grillado/.test(document.querySelector("[data-testid=issues-strip]")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    check("the strip links the parent and counts the sub-issues", /^Issues#1·\d+sub-issues?·victor-teles\/grillado$/.test((await strip.textContent()).replace(/\s/g, "")), await strip.textContent());
    const chips = pg.locator("[data-testid^=issue-chips-] .ilk");
    await chips.first().waitFor({ timeout: 8000 }).catch(() => {});
    check("decision cards carry their issue chips", (await chips.count()) > 0 && /^(?!R\d+·)\S.* is covered by issue #\d+$/.test(await chips.first().getAttribute("aria-label")), String(await chips.count()));
    const mi = await menuItems(pg);
    check("the item becomes “Update issues…” with where it went", mi.some((t) => t === "Update issues…#1 · victor-teles/grillado"), mi.join(" | "));
    await pg.keyboard.press("Escape");
    await shot(pg, "d-strip", theme);
    await axe(pg, `${theme} desktop: plan with the strip and chips`);

    // §6 update: the plan changes, the parent was edited in GitHub, one sub-issue was deleted.
    const planFile = path.join(app.dir, "sessions", planId, "plan.md");
    const md = readFileSync(planFile, "utf8");
    const lines = md.split("\n");
    const p = lines.findIndex((l, i) => i > 0 && l.trim() && !l.startsWith("#") && !l.startsWith("```"));
    lines[p] = `${lines[p]} Families share one box.`;
    writeFileSync(planFile, lines.join("\n"));
    ghEdit((st) => {
      st.issues[0].body = `${st.issues[0].body}\n\nA note from the team.`;
      st.issues[1].deleted = true;
    });
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    await pg.waitForFunction(() => /changed since export/.test(document.querySelector("[data-testid=issues-strip]")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
    check("the strip says what changed, with Update issues", /\d+ changed since export·Update issues$/.test((await pg.getByTestId("issues-strip").textContent()).replace(/\s*·\s*/g, "·")), await pg.getByTestId("issues-strip").textContent());
    const gone = pg.locator(".ilk.gone");
    check("a deleted sub-issue’s chip offers Recreate", (await gone.count()) === 0 || /#2 missing · Recreate/.test(await gone.first().textContent()), String(await gone.count()));
    await shot(pg, "d-changed", theme);
    await openSheet(pg);
    await pg.getByRole("dialog", { name: "Update issues" }).waitFor();
    check("update mode says where the issues already are", /^Already in victor-teles\/grillado #1/.test(await sheet(pg).locator(".ish-d").textContent()));
    const stale = sheet(pg).getByTestId("split-stale");
    check("an agent split older than the plan says so, with Split again", (await stale.count()) === 1 && (await stale.textContent()).replace(/\s*·\s*/g, " · ") === "The plan changed since this split · Split again", await stale.textContent().catch(() => "(none)"));
    const par = sheet(pg).getByTestId("issue-row-plan");
    check("the parent edited in GitHub is skipped by default", (await par.locator(".ist").textContent()) === "Edited in GitHub · skip");
    check("the deleted one will be recreated", (await sheet(pg).getByText("Missing in GitHub · will recreate").count()) === 1);
    check("button: Recreate 1 issue", (await go(pg).textContent()) === "Recreate 1 issue in victor-teles/grillado", await go(pg).textContent());
    await shot(pg, "d-update", theme);
    await par.getByRole("button", { name: "Overwrite with the plan’s version" }).click();
    check("overwrite flips the row and the button", (await par.locator(".ist").textContent()) === "Edited in GitHub · overwrite" && (await go(pg).textContent()) === "Create 1 and update 1 in victor-teles/grillado", await go(pg).textContent());
    check("the card counts it", /1 update \(1 overwrites edits made in GitHub\) · 1 recreated/.test(await foot(pg).locator(".iac-t").textContent()), await foot(pg).locator(".iac-t").textContent());
    await shot(pg, "d-overwrite", theme);
    await axe(pg, `${theme} desktop: update mode`);
    await go(pg).click();
    await sheet(pg).locator(".iac[data-k=done]").waitFor({ timeout: 20000 });
    check("the update run: 1 created, 1 updated", (await sum(pg)) === "1 created, 1 updated · victor-teles/grillado", `${await sum(pg)} | ${(await sheet(pg).locator(".ir").allTextContents()).join(" || ")}`);
    await pg.keyboard.press("Escape");

    // §7 gh fix-its: missing, then logged out, then fine again.
    ctl({ GH_MISSING: 1 });
    await openSheet(pg);
    const fix = sheet(pg).locator(".ifix");
    await fix.waitFor({ timeout: 8000 });
    check("gh missing: the fix-it with install commands", (await fix.locator("strong").textContent()) === "GitHub CLI isn’t installed" && (await fix.locator("pre").allTextContents()).includes("brew install gh"));
    check("gh missing: the button waits", (await go(pg).isDisabled()) && (await foot(pg).locator(".iac-t").textContent()) === "Install gh to continue");
    await shot(pg, "d-fix-missing", theme);
    await axe(pg, `${theme} desktop: gh missing`);
    ctl({ FAKE_GH_AUTH: "out" });
    await fix.getByRole("button", { name: "Check again" }).click();
    await sheet(pg).getByText("gh isn’t signed in to github.com").waitFor({ timeout: 8000 });
    check("gh logged out: the exact command", (await fix.locator("pre").textContent()) === "gh auth login" && (await foot(pg).locator(".iac-t").textContent()) === "Sign in to gh to continue");
    await shot(pg, "d-fix-auth", theme);
    ctl();
    await fix.getByRole("button", { name: "Check again" }).click();
    await fix.waitFor({ state: "detached", timeout: 8000 });
    check("signed in: the fix-it goes and the repository is back", (await sheet(pg).getByRole("button", { name: "Repository" }).count()) === 1);

    // §2 Linear: a bad key, a good one, disconnect.
    await sheet(pg).getByRole("tab", { name: "GitHub" }).focus();
    await pg.keyboard.press("ArrowRight");
    check("←/→ moves between destinations", (await active(pg)) === "tab:Linear" && (await sheet(pg).getByRole("tab", { name: "Linear" }).getAttribute("aria-selected")) === "true");
    const key = sheet(pg).getByLabel("Linear API key");
    check("the key field is a password field", (await key.getAttribute("type")) === "password");
    await key.fill("lin_api_bad");
    await sheet(pg).getByRole("button", { name: "Connect" }).click();
    await sheet(pg).getByRole("alert").filter({ hasText: "That key didn’t work." }).waitFor({ timeout: 8000 });
    check("a bad key says so, with the settings link", (await sheet(pg).getByRole("link", { name: /Check it in Linear’s API key settings/ }).count()) === 1);
    await shot(pg, "d-linear-bad", theme);
    await key.fill("lin_api_good");
    await sheet(pg).getByRole("button", { name: "Connect" }).click();
    await sheet(pg).locator(".iconn").waitFor({ timeout: 8000 });
    check("connected: who and the last four only", /^ConnectedasVictor·••••good$/.test((await sheet(pg).locator(".iconn > span").first().textContent()).replace(/\s/g, "")), await sheet(pg).locator(".iconn").textContent());
    await pg.waitForFunction(() => /in Linear · Team Core$/.test(document.querySelector("[data-testid=issues-confirm]")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    check("the button names the Linear team", /^Create \d+ issues? in Linear · Team Core$/.test(await go(pg).textContent()), await go(pg).textContent());
    check("the how-line names api.linear.app", (await foot(pg).locator(".iac-n").last().textContent()) === "Sends to api.linear.app with your saved key. Nothing is sent before you click.");
    check("the key never comes back to the page", !(await pg.content()).includes("lin_api_good"));
    await shot(pg, "d-linear", theme);
    await axe(pg, `${theme} desktop: Linear connected`);
    await sheet(pg).locator(".iconn").getByRole("button", { name: "Disconnect" }).click();
    check("disconnect asks first", (await sheet(pg).locator(".iconn.ask").textContent()).includes("Disconnect Linear? You’ll paste a key again next time."));
    await shot(pg, "d-linear-ask", theme);
    await sheet(pg).locator(".iconn.ask").getByRole("button", { name: "Disconnect" }).click();
    await sheet(pg).getByLabel("Linear API key").waitFor();
    check("disconnected: the key field is back", true);
    check("nothing was ever written to Linear", !linearReqs.some((q) => /issueCreate|issueUpdate|issueLabelCreate/.test(q)));
    await sheet(pg).getByRole("tab", { name: "Linear" }).focus();
    await pg.keyboard.press("ArrowLeft");
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });

    // Keyboard mode: no motion (html[data-kbd]).
    await pg.getByRole("button", { name: "Plan actions" }).focus();
    await pg.keyboard.press("Enter");
    await pg.getByTestId("menu-issues").waitFor();
    await pg.getByTestId("menu-issues").focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).waitFor();
    const moving = await pg.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.target?.closest?.(".ish") || a.effect?.target?.classList?.contains("ish"))).length);
    check("data-kbd: the sheet opens with no transition", moving === 0, String(moving));
    const kbdMoving = () =>
      pg.evaluate(() => {
        const els = [...document.querySelectorAll(".ish,.ish *,.ischrim,.istrip,.istrip *,.ilks,.ilks *,.copy-md")];
        const bad = els.filter((el) => getComputedStyle(el).transitionDuration.split(",").some((d) => parseFloat(d) > 0));
        return { n: els.length, bad: [...new Set(bad.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`))] };
      });
    const km = await kbdMoving();
    check("data-kbd: every element in the sheet, the strip, the chips and Copy Markdown has a 0s transition", km.n > 20 && km.bad.length === 0, `${km.n} checked; moving: ${km.bad.join(", ")}`);
    await pg.waitForFunction(() => document.activeElement?.getAttribute("role") === "tab", null, { timeout: 3000 }).catch(() => {});
    const kf = await active(pg);
    check("keyboard open: focus on the destination tab", kf === "tab:GitHub", kf);
    await pg.keyboard.press("Escape");
    await ctx.close();
  }

  // ============================================================== desktop light, phones (both themes)
  for (const theme of ["light", "dark"]) {
    for (const vp of theme === "light" ? [{ w: 1440, h: 900 }, { w: 390, h: 844 }, { w: 320, h: 640 }] : [{ w: 390, h: 844 }, { w: 320, h: 640 }]) {
      const phone = vp.w <= 640;
      const tag = phone ? `m${vp.w}` : "d";
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: phone, hasTouch: phone });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const pg = await ctx.newPage();
      pg.on("pageerror", (e) => errors.push(String(e)));
      await pg.goto(planUrl(app, planId));
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      await pg.getByTestId("issues-strip").waitFor({ timeout: 8000 });
      await shot(pg, `${tag}-strip`, theme);
      if (phone) {
        const small = await smallTargets(pg, "[data-testid=issues-strip],[data-testid^=issue-chips-]");
        check(`${theme} ${vp.w}: the strip and chips are 44px targets`, small.length === 0, small.join("; "));
        const hitS = await hitAudit(pg, "[data-testid=issues-strip],[data-testid^=issue-chips-]");
        check(`${theme} ${vp.w}: tapping the strip and chips, each owns 44px and none covers another`, hitS.length === 0, hitS.join("; "));
      }
      await openSheet(pg);
      const box = await sheet(pg).boundingBox();
      if (phone) {
        check(`${theme} ${vp.w}: a bottom sheet, full width`, Math.round(box.x) === 0 && Math.round(box.width) === vp.w && Math.abs(box.y + box.height - vp.h) < 2, JSON.stringify(box));
        check(`${theme} ${vp.w}: no Cancel on phones`, (await foot(pg).getByRole("button", { name: "Cancel" }).count()) === 0);
      } else check(`${theme} desktop: a 560px side sheet`, Math.round(box.width) === 560 && Math.round(box.x + box.width) === vp.w, JSON.stringify(box));
      const over = await pg.evaluate(() => { const s = document.querySelector(".ish-b"); return s.scrollWidth - s.clientWidth; });
      check(`${theme} ${vp.w}: nothing overflows sideways`, over <= 0, String(over));
      const fits = await go(pg).evaluate((b) => b.scrollWidth <= b.clientWidth + 1);
      check(`${theme} ${vp.w}: the confirm text fits`, fits);
      await shot(pg, `${tag}-sheet`, theme);
      await axe(pg, `${theme} ${vp.w}: the sheet`);
      if (phone) {
        const small = await smallTargets(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: the sheet's targets are 44px (links, titles, Split again, the repo link)`, small.length === 0, small.join("; "));
        const hit = await hitAudit(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: tapping the sheet, every control owns 44px and none covers another`, hit.length === 0, hit.join("; "));
        await sheet(pg).getByRole("tab", { name: "Linear" }).click();
        await sheet(pg).getByLabel("Linear API key").waitFor();
        const smallL = await smallTargets(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: Linear's targets are 44px (the settings link)`, smallL.length === 0, smallL.join("; "));
        const hitL = await hitAudit(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: tapping Linear, the key field, Connect and the settings link each own 44px`, hitL.length === 0, hitL.join("; "));
        check(`${theme} ${vp.w}: the Linear key field is 16px (#172)`, (await sheet(pg).getByLabel("Linear API key").evaluate((e) => getComputedStyle(e).fontSize)) === "16px");
        await sheet(pg).getByLabel("Linear API key").fill("lin_api_bad");
        await sheet(pg).getByRole("button", { name: "Connect" }).click();
        await sheet(pg).getByRole("alert").filter({ hasText: "That key didn’t work." }).waitFor({ timeout: 8000 });
        const hitB = await hitAudit(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: tapping a bad key, the field, Connect and the settings link each own 44px`, hitB.length === 0, hitB.join("; "));
        await shot(pg, `${tag}-linear-bad`, theme);
        await sheet(pg).getByLabel("Linear API key").fill("");
        await shot(pg, `${tag}-linear`, theme);
        await sheet(pg).getByRole("tab", { name: "GitHub" }).click();
        await sheet(pg).getByRole("button", { name: "Repository" }).click();
        await shot(pg, `${tag}-repos`, theme);
        await pg.keyboard.press("Escape");
      }
      await pg.keyboard.press("Escape");
      await sheet(pg).waitFor({ state: "detached" });
      if (phone) {
        // The fix-it screens: Copy and the cli.github.com link.
        ctl({ GH_MISSING: 1 });
        await openSheet(pg);
        await sheet(pg).locator(".ifix").waitFor({ timeout: 8000 });
        const small = await smallTargets(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: the gh fix-it's targets are 44px (Copy, cli.github.com)`, small.length === 0, small.join("; "));
        const hitF = await hitAudit(pg, "[data-testid=issues-sheet]");
        check(`${theme} ${vp.w}: tapping the gh fix-it, Copy and cli.github.com each own 44px`, hitF.length === 0, hitF.join("; "));
        await shot(pg, `${tag}-fix-missing`, theme);
        ctl();
        await pg.keyboard.press("Escape");
        await sheet(pg).waitFor({ state: "detached" });
      }
      await ctx.close();
    }
  }
  // ============================================================== review round 2 (PR #25)
  // Must 2, Designer's repro: export from the user stories with one title edited, then reword a story and
  // add one. The stories are read from the plan again, so both changes show (they froze before).
  {
    const theme = "dark";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    const id = await plate(pg, app.url, "A plant watering reminder");
    const file = path.join(app.dir, "sessions", id, "plan.md");
    const noStories = readFileSync(file, "utf8").replace(/\n## User stories\n[\s\S]*?(?=\n## |$)/, "\n").trimEnd();
    writeFileSync(file, `${noStories}\n`);
    actl({ FAKE_SPLIT_DELAY_MS: 2500 });
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    const before = splits();
    await openSheet(pg);
    if (!SPLIT_ON_OPEN) {
      const ask = sheet(pg).locator(".iask");
      await ask.waitFor({ timeout: 8000 });
      await pg.waitForTimeout(1500);
      check("BIG-3 B, no user stories: opening runs no split", splits() === before, `${before} → ${splits()}`);
      check("BIG-3 B, no user stories: the parent issue alone is listed", (await sheet(pg).locator(".ir:not(.sk)").count()) === 1, String(await sheet(pg).locator(".ir:not(.sk)").count()));
      check("BIG-3 B, no user stories: the offer says it's the parent alone", /^Right now it’s only the parent issue\. Claude Code can split the plan into slices/.test(await ask.textContent()), await ask.textContent());
      await shot(pg, "r3-nostories-ask", theme);
      await ask.getByRole("button", { name: "Split with Claude Code" }).click();
    }
    await sheet(pg).getByText(/is splitting the plan/).waitFor({ timeout: 8000 });
    const alt = sheet(pg).locator(".ipv-src").first().getByRole("button").last();
    check("no user stories: while splitting, the way out is “Use the parent issue alone”", (await alt.textContent()) === "Use the parent issue alone", await alt.textContent());
    await shot(pg, "r2-split-nostories", theme);
    await alt.click();
    await sheet(pg).locator(".iask", { hasText: /only the parent issue/ }).waitFor({ timeout: 8000 });
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });

    writeFileSync(file, `${noStories}\n\n## User stories\n\n- As a plant owner, I get a reminder on watering day.\n- As a plant owner, I can snooze a reminder for a day.\n`);
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    const before2 = splits();
    await openSheet(pg);
    if (!SPLIT_ON_OPEN) {
      // Frame d-q-split-ask: the story issues right away, and the split offered.
      const ask = sheet(pg).locator(".iask");
      await ask.waitFor({ timeout: 8000 });
      await pg.waitForTimeout(1500);
      check("BIG-3 B, with stories: opening runs no split", splits() === before2, `${before2} → ${splits()}`);
      check("BIG-3 B, with stories: the parent and one issue per story show right away", (await sheet(pg).locator(".ir:not(.sk)").count()) === 3 && (await sheet(pg).locator(".ir.sk").count()) === 0, String(await sheet(pg).locator(".ir:not(.sk)").count()));
      check("BIG-3 B, with stories: the split is offered as in d-q-split-ask", /^Right now it’s one issue per user story\. Claude Code can split the plan into thinner slices that each cover their decisions\.\s*Split with Claude Code$/.test(await ask.textContent()), await ask.textContent());
      check("BIG-3 B, with stories: “Split with Claude Code” is a soft button", (await ask.getByRole("button", { name: "Split with Claude Code" }).getAttribute("class"))?.includes("btn soft"));
      await shot(pg, "d-split-ask", theme);
      await pg.setViewportSize({ width: 320, height: 640 });
      await pg.waitForTimeout(400);
      await ask.scrollIntoViewIfNeeded();
      const bb = await ask.getByRole("button", { name: "Split with Claude Code" }).boundingBox();
      const ab = await ask.boundingBox();
      check("BIG-3 B at 320: “Split with Claude Code” stacks under the text, full width, 44px", bb.height >= 44 && Math.abs(bb.width - (ab.width - 28)) < 2, JSON.stringify({ bb, ab }));
      await shot(pg, "m320-split-ask", theme);
      await pg.setViewportSize({ width: 1440, height: 900 });
      await pg.waitForTimeout(400);
      // r2 nice 3: by keyboard, Split → the way out → back, focus always lands on a visible control.
      actl({ FAKE_SPLIT_DELAY_MS: 2500 });
      const focused = () => pg.evaluate(() => { const a = document.activeElement; return `${a?.tagName.toLowerCase()}:${a?.textContent?.trim()}:${a?.matches(":focus-visible")}`; });
      await ask.getByRole("button", { name: "Split with Claude Code" }).focus();
      await pg.keyboard.press("Enter");
      await sheet(pg).getByText(/is splitting the plan/).waitFor({ timeout: 8000 });
      await pg.waitForTimeout(100);
      check("keyboard Split: focus moves to the way out, with its ring", (await focused()) === "button:Use the user stories instead:true", await focused());
      await pg.keyboard.press("Enter");
      await ask.waitFor({ timeout: 8000 });
      await pg.waitForFunction(() => document.activeElement?.textContent?.trim() === "Split with Claude Code", null, { timeout: 3000 }).catch(() => {});
      await pg.waitForTimeout(300);
      check("keyboard way out: focus lands on “Split with Claude Code”, with its ring (not the page, not the sheet)", (await focused()) === "button:Split with Claude Code:true", await focused());
      await pg.waitForTimeout(2600);
      check("the way out stopped the split: still one issue per user story", (await sheet(pg).locator(".iask", { hasText: /one issue per user story/ }).count()) === 1);
      actl();
    }
    if (SPLIT_ON_OPEN) {
      await sheet(pg).getByText(/is splitting the plan/).waitFor({ timeout: 8000 });
      const use = sheet(pg).locator(".ipv-src").first().getByRole("button", { name: "Use the user stories instead" });
      check("with user stories: the way out is “Use the user stories instead”", (await use.count()) === 1);
      await use.click();
    }
    actl();
    await sheet(pg).locator(".iask", { hasText: /one issue per user story/ }).waitFor({ timeout: 8000 });
    const rows = sheet(pg).locator(".ir:not(.sk)");
    check("r2: the parent and one issue per story", (await rows.count()) === 3, String(await rows.count()));
    await rows.nth(1).locator("textarea").fill("Watering-day reminder");
    await pg.waitForFunction(() => !document.querySelector("[data-testid=issues-confirm]")?.disabled, null, { timeout: 8000 });
    await go(pg).click();
    await sheet(pg).locator(".iac[data-k=done]").waitFor({ timeout: 20000 });
    check("r2: exported with the edited title", (await sum(pg)) === "3 created · victor-teles/grillado", await sum(pg));
    await sheet(pg).getByRole("button", { name: "Done" }).click();
    await sheet(pg).waitFor({ state: "detached" });

    writeFileSync(file, readFileSync(file, "utf8").replace("I can snooze a reminder for a day.", "I can snooze a reminder for a day or a week.").trimEnd() + "\n- As a flatmate, I see whose turn it is to water.\n");
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    await openSheet(pg);
    await pg.getByRole("dialog", { name: "Update issues" }).waitFor();
    const info = await rows.evaluateAll((rs) => rs.map((r) => ({ t: r.querySelector(".ir-ti")?.value ?? r.querySelector(".ir-tt")?.textContent ?? "", st: r.querySelector(".ist")?.textContent ?? "" })));
    const row = (re) => info.find((x) => re.test(x.t));
    check("r2: the edited title stays, unchanged", row(/^Watering-day reminder$/)?.st.startsWith("Unchanged"), JSON.stringify(info));
    check("r2: the reworded story will update its issue", row(/or a week/)?.st === "Will update", JSON.stringify(info));
    check("r2: the new story is offered", row(/whose turn/)?.st === "New", JSON.stringify(info));
    check("r2: the button sends them (not “Nothing changed since the export”)", (await go(pg).textContent()) === "Create 1 and update 1 in victor-teles/grillado", await go(pg).textContent());
    await shot(pg, "r2-stories-after-edit", theme);
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });
    await ctx.close();
  }

  // ============================================================== review round 4 (PR #25)
  // Must: with a title edited, the first split asks “Split with {agent}?” (under option B it isn’t “again”), and
  // a re-split of the agent’s slices asks “Split again?”. Nice 1: when a split ends, focus stays on Split again
  // or Try again. Nice 2: on phones the error line keeps its icon with “Couldn’t”.
  if (!SPLIT_ON_OPEN) {
    const theme = "dark";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    const id = await plate(pg, app.url, "A plant watering reminder");
    const file = path.join(app.dir, "sessions", id, "plan.md");
    const base = readFileSync(file, "utf8").replace(/\n## User stories\n[\s\S]*?(?=\n## |$)/, "\n").trimEnd();
    writeFileSync(file, `${base}\n\n## User stories\n\n- As a plant owner, I get a reminder on watering day.\n- As a plant owner, I can snooze a reminder for a day.\n`);
    actl();
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    await openSheet(pg);
    const src = sheet(pg).locator(".ipv-src").first();
    const read = async () => ((await src.textContent()) ?? "").replace(/\s*·\s*/g, " · ").trim();
    const focused = () => pg.evaluate(() => { const a = document.activeElement; return `${a?.tagName.toLowerCase()}:${a?.textContent?.trim()}:${a?.matches(":focus-visible")}`; });
    const focusOn = (label) => pg.waitForFunction((l) => document.activeElement?.textContent?.trim() === l, label, { timeout: 4000 }).catch(() => {});
    const ask = sheet(pg).locator(".iask");
    await ask.waitFor({ timeout: 8000 });
    await sheet(pg).locator(".ir:not(.sk)").nth(1).locator("textarea").fill("Watering-day reminder");
    const n0 = splits();
    await ask.getByRole("button", { name: "Split with Claude Code" }).focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".ipv-src", { hasText: /Your title edits are replaced/ }).waitFor({ timeout: 5000 });
    check("r4 must: a title edited, then the first split asks “Split with Claude Code? … · Split · Keep”, not “again”", (await read()) === "Split with Claude Code? Your title edits are replaced. · Split · Keep", await read());
    check("r4 must: asking runs nothing", splits() === n0, `${n0} → ${splits()}`);
    await focusOn("Split");
    check("r4: by keyboard, focus moves to Split, with its ring", (await focused()) === "button:Split:true", await focused());
    await shot(pg, "r4-ask-first", theme);
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".ipv-src", { hasText: /^Split by Claude Code into/ }).waitFor({ timeout: 10000 });
    check("r4 must: Split runs the agent once", splits() === n0 + 1, `${n0} → ${splits()}`);
    await focusOn("Split again");
    check("r4 nice 1: when the split finishes, focus is on Split again, with its ring (not the GitHub tab)", (await focused()) === "button:Split again:true", await focused());
    await shot(pg, "r4-done-focus", theme);

    // A re-split of the agent's slices, with one of them retitled: “Split again?”; Keep keeps.
    await sheet(pg).locator(".ir:not(.sk)").nth(1).locator("textarea").fill("Reminders first");
    await src.getByRole("button", { name: "Split again" }).focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".ipv-src", { hasText: /Your title edits are replaced/ }).waitFor({ timeout: 5000 });
    check("r4 must: a retitled agent slice, then Split again asks “Split again? … · Split again · Keep”", (await read()) === "Split again? Your title edits are replaced. · Split again · Keep", await read());
    check("r4 must: asking again runs nothing", splits() === n0 + 1, `${n0 + 1} → ${splits()}`);
    await shot(pg, "r4-ask-again", theme);
    await src.getByRole("button", { name: "Keep" }).focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".ipv-src", { hasText: /^Split by Claude Code into/ }).waitFor({ timeout: 5000 });
    await focusOn("Split again");
    check("r4: Keep keeps the slices and the edit, focus back on Split again", (await focused()) === "button:Split again:true" && (await sheet(pg).locator(".ir:not(.sk)").nth(1).locator("textarea").inputValue()) === "Reminders first" && splits() === n0 + 1, await focused());

    // A re-split that fails: focus on Try again.
    actl({ FAKE_SPLIT: "fail" });
    await src.getByRole("button", { name: "Split again" }).focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".ipv-src", { hasText: /Your title edits are replaced/ }).waitFor({ timeout: 5000 });
    await pg.keyboard.press("Enter");
    const warn = sheet(pg).locator(".ipv-src.warn");
    await warn.waitFor({ timeout: 10000 });
    check("r4: the failed re-split ran the agent once", splits() === n0 + 2, `${n0 + 1} → ${splits()}`);
    check("r4: the error line", /^Couldn’t split with Claude Code, so it’s .+ · Try again$/.test((await warn.textContent()).replace(/\s*·\s*/g, " · ").trim()), await warn.textContent());
    await focusOn("Try again");
    check("r4 nice 1: when the split fails, focus is on Try again, with its ring (not the GitHub tab)", (await focused()) === "button:Try again:true", await focused());
    await shot(pg, "r4-fail-focus", theme);
    for (const width of [390, 320]) {
      await pg.setViewportSize({ width, height: 700 });
      await pg.waitForTimeout(400);
      await warn.scrollIntoViewIfNeeded();
      const g = await warn.evaluate((p) => {
        const nw = p.querySelector(".iw1");
        const icon = nw.querySelector("svg").getBoundingClientRect();
        const r = document.createRange();
        r.selectNodeContents(nw);
        const word = [...r.getClientRects()].filter((x) => x.width > 0 && x.left >= icon.right - 1);
        return { lines: nw.getClientRects().length, iconTop: icon.top - p.getBoundingClientRect().top, sameLine: word.length > 0 && word.every((x) => Math.abs(x.top + x.height / 2 - (icon.top + icon.height / 2)) < 6) };
      });
      check(`r4 nice 2 at ${width}: the warning icon and “Couldn’t” stay on the first line together`, g.lines === 1 && g.iconTop < 6 && g.sameLine, JSON.stringify(g));
      await shot(pg, `m${width}-r4-fail`, theme);
    }
    actl();
    await pg.keyboard.press("Escape");
    await ctx.close();
  }

  // PO: imported plans with to-dos get the same card (option B), and every label names the agent in use.
  // An imported Cursor plan with to-dos (found by the scan) on a server whose agent is the fake Grok: Grillado
  // has no Cursor agent, so the plan takes the user's pick, Grok.
  if (!SPLIT_ON_OPEN) {
    const proj2 = realpathSync(mkdtempSync(path.join(WORK, "imp-")));
    execFileSync("git", ["init", "-q", "-b", "main", proj2]);
    execFileSync("git", ["-C", proj2, "remote", "add", "origin", "git@github.com:victor-teles/grillado.git"]);
    const gbin = mkdtempSync(path.join(WORK, "gbin-"));
    writeFileSync(path.join(gbin, "grok"), `#!/bin/sh\n. "${ACTL}"\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" grok "$@"\n`);
    chmodSync(path.join(gbin, "grok"), 0o755);
    const TASKS = ["Import bank CSVs", "Tag each expense with a category", "Show the month’s totals per category"];
    const ago = (Date.now() - 3600_000) / 1000;
    const plans = path.join(proj2, ".cursor", "plans");
    mkdirSync(plans, { recursive: true });
    const planMd = path.join(plans, "budget.plan.md");
    writeFileSync(planMd, `---\nname: Home budget tracker\noverview: A shared monthly view of spending.\ntodos:\n${TASKS.map((t, i) => `  - id: t${i + 1}\n    content: ${t}\n    status: pending\n`).join("")}---\n\n# Home budget tracker\n\nSpending is invisible, so the family gets a shared monthly view.\n`);
    utimesSync(planMd, ago, ago);
    // Review r5: a story plan and a parent-only plan, also imported from Cursor with no decisions.
    const R5_PLANS = [
      ["reading.plan.md", "# Reading list\n\nBooks get lost between apps.\n\n## User stories\n\n- As a reader, I save a book I hear about.\n- As a reader, I mark a book as read.\n", "stories", "Group the user stories into slices", "Right now it’s one issue per user story. Grok can group them into a few slices, each one something you can ship on its own.", "Grok found nothing to group, so it’s still one issue per user story", 3],
      ["chores.plan.md", "# Chore wheel\n\nWho does the dishes is a weekly argument.\n", "parent only", "Split the plan into slices", "Right now it’s only the parent issue. Grok can split the plan into a few slices, each one something you can ship on its own.", "Grok found nothing to split, so it’s still the parent alone", 1],
    ];
    for (const [file, md] of R5_PLANS) {
      const f = path.join(plans, file);
      writeFileSync(f, `---\nname: ${md.split("\n")[0].slice(2)}\noverview: ${md.split("\n")[2]}\n---\n\n${md}`);
      utimesSync(f, ago, ago);
    }
    const app3 = await server({ cwd: proj2, scan: true, pre: `${gbin}:`, config: { defaultProvider: "grok" } });
    const theme = "dark";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    await pg.goto(app3.url);
    await pickIfAsked(pg, /Grok/);
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      const v = await pg.evaluate(() => fetch("/api/found").then((r) => r.json()));
      row = (v.rows ?? []).find((r) => /budget/i.test(`${r.title ?? ""} ${r.idea ?? ""}`) && r.kind !== "free") ?? (v.rows ?? []).find((r) => /budget/i.test(`${r.title ?? ""} ${r.idea ?? ""}`));
      if (!row) await pg.waitForTimeout(250);
    }
    check("r4 to-dos: the scan finds the imported plan", !!row, JSON.stringify(row));
    const imp = row ? await pg.evaluate((id) => fetch("/api/found/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => r.json()), row.id) : {};
    check("r4 to-dos: imported", typeof imp.url === "string", JSON.stringify(imp).slice(0, 200));
    await pg.goto(`${new URL(app3.url).origin}${imp.url}${new URL(app3.url).search}`);
    await pg.getByTestId("plan").waitFor({ timeout: 15000 });
    const n0 = splits();
    await openSheet(pg);
    const ask = sheet(pg).locator(".iask");
    await ask.waitFor({ timeout: 8000 }).catch(() => {});
    await pg.waitForTimeout(1500);
    check("r4 to-dos: opening runs no split", splits() === n0, `${n0} → ${splits()}`);
    check("r4 to-dos: the parent and one issue per to-do show right away", (await sheet(pg).locator(".ir:not(.sk)").count()) === 1 + TASKS.length, String(await sheet(pg).locator(".ir:not(.sk)").count()));
    // Review r5 (PO #188, Designer r4): no decisions, so the card offers to group the to-dos; the button stays “Split with {agent}”.
    const tidy = async (l) => ((await l.textContent()) ?? "").replace(/\s*·\s*/g, " · ").replace(/\s+/g, " ").trim();
    const CARD_TODOS = /^Group the to-dos into slices\s*Right now it’s one issue per to-do\. Grok can group them into a few slices, each one something you can ship on its own\.\s*Split with Grok$/;
    check("r5 to-dos: 0 decisions, so the card reads “Group the to-dos into slices …” with the agent in use (Grok)", CARD_TODOS.test(await tidy(ask)), await tidy(ask).catch(() => "(no card)"));
    check("r5 to-dos: the heading is its own line (Inter 500)", (await ask.locator(".iask-h").evaluate((e) => getComputedStyle(e).display === "block" && getComputedStyle(e).fontWeight === "500")) === true);
    check("r5 to-dos: no “decisions” promise and no “Claude Code” in the sheet", !/decisions/.test(await ask.textContent()) && !/Claude Code/.test(await sheet(pg).textContent()));
    await shot(pg, "r5-todos-card-grok", theme);
    await sheet(pg).locator(".ir:not(.sk)").nth(1).locator("textarea").fill("Bank CSV import");
    await ask.getByRole("button", { name: "Split with Grok" }).click();
    const src = sheet(pg).locator(".ipv-src").first();
    await sheet(pg).locator(".ipv-src", { hasText: /Your title edits are replaced/ }).waitFor({ timeout: 5000 });
    let line = await tidy(src);
    check("r5 to-dos: the confirm is unchanged: “Split with Grok? … · Split · Keep”", line === "Split with Grok? Your title edits are replaced. · Split · Keep", line);
    check("r5 to-dos: asking runs nothing", splits() === n0, `${n0} → ${splits()}`);
    actl({ FAKE_SPLIT_DELAY_MS: 2500 });
    await src.getByRole("button", { name: "Split", exact: true }).click();
    await sheet(pg).getByText(/Grok is splitting the plan into slices/).waitFor({ timeout: 8000 });
    const way = sheet(pg).locator(".ipv-src").first().getByRole("button").last();
    check("r5 to-dos: while Grok works, the way out is “Use the plan’s to-dos instead”", (await way.textContent()) === "Use the plan’s to-dos instead", await way.textContent());
    await sheet(pg).locator(".ipv-src", { hasText: /^(Split by Grok into|Couldn’t split)/ }).waitFor({ timeout: 15000 });
    let log = existsSync(SPLIT_LOG) ? readFileSync(SPLIT_LOG, "utf8").trim().split("\n") : [];
    check("r5 to-dos: Split ran the agent exactly once, and it was Grok", splits() === n0 + 1 && log.at(-1) === "grok", `${n0} → ${splits()} · ${log.at(-1)}`);
    line = await tidy(src);
    const kidTitles = await sheet(pg).locator(".ir:not(.sk) textarea").evaluateAll((xs) => xs.slice(1).map((x) => x.value));
    check("r5 to-dos: a valid grouping (each to-do in exactly one slice) gives slices: “Split by Grok into 2 slices · Split again”", line === "Split by Grok into 2 slices · Split again" && kidTitles.length === 2, `${line} · ${JSON.stringify(kidTitles)}`);
    await shot(pg, "r5-todos-grouped-grok", theme);
    // Split again with an empty reply: a plain no-change line, the to-dos stay, nothing looks like a failure.
    actl({ FAKE_GROUP: "empty" });
    await sheet(pg).locator(".ir:not(.sk)").nth(1).locator("textarea").fill("Import and tag");
    await src.getByRole("button", { name: "Split again" }).click();
    await sheet(pg).locator(".ipv-src", { hasText: /Your title edits are replaced/ }).waitFor({ timeout: 5000 });
    await src.getByRole("button", { name: "Split again" }).click();
    const noChange = async (label, want, rows) => {
      const empty = sheet(pg).getByTestId("split-empty");
      await empty.waitFor({ timeout: 15000 });
      const got = await tidy(empty);
      check(`r5 ${label}: an empty reply is a plain no-change line: “${want}”`, got === want && (await sheet(pg).locator(".ir:not(.sk)").count()) === rows, `${got} · ${await sheet(pg).locator(".ir:not(.sk)").count()} rows`);
      const look = await empty.evaluate((e) => ({ warn: e.classList.contains("warn"), icon: !!e.querySelector("svg"), buttons: e.querySelectorAll("button").length, role: e.getAttribute("role") }));
      check(`r5 ${label}: … no warning look, no icon, no Try again, role=status`, !look.warn && !look.icon && look.buttons === 0 && look.role === "status" && !/Couldn’t|Try again/.test(await sheet(pg).textContent()), JSON.stringify(look));
      // Review r6 nice 1: the button that had focus is gone, so focus lands on the line, not on the GitHub tab.
      await pg.waitForFunction(() => document.activeElement?.dataset?.testid === "split-empty", null, { timeout: 3000 }).catch(() => {});
      const at = await pg.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.dataset?.testid ?? document.activeElement?.textContent?.trim()}`);
      check(`r6 ${label}: focus moves to the no-change line`, at === "P:split-empty", at);
    };
    await noChange("to-dos", "Grok found nothing to group, so it’s still one issue per to-do", 1 + TASKS.length);
    check("r5 to-dos: that was one more run", splits() === n0 + 2, `${splits()}`);
    await shot(pg, "r5-todos-nochange-grok", theme);
    actl();
    await pg.keyboard.press("Escape");
    // The zero-decision card and its button in light (Designer r4 nice 1: the soft button gets an edge on --sel).
    {
      const lctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
      await lctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), "light");
      const lp = await lctx.newPage();
      lp.on("pageerror", (e) => errors.push(String(e)));
      await lp.goto(app3.url);
      await pickIfAsked(lp, /Grok/);
      await lp.goto(pg.url());
      await lp.getByTestId("plan").waitFor({ timeout: 15000 });
      await openSheet(lp);
      const lask = sheet(lp).locator(".iask");
      await lask.waitFor({ timeout: 8000 });
      check("r5 to-dos light: the same card", CARD_TODOS.test(await tidy(lask)), await tidy(lask));
      const btn = lask.getByRole("button", { name: "Split with Grok" });
      const st = await btn.evaluate((b) => {
        const cs = getComputedStyle(b);
        const probe = document.createElement("div");
        probe.style.background = "var(--card)";
        b.parentElement.appendChild(probe);
        const card = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { bg: cs.backgroundColor, card, shadow: cs.boxShadow };
      });
      check("r5 nice 1: on the card the soft button is --card with a 1px inset --subtle-foreground edge", st.bg === st.card && /inset/.test(st.shadow) && /1px/.test(st.shadow), JSON.stringify(st));
      await shot(lp, "r5-todos-card-grok", "light");
      if (SHOTS) await lask.screenshot({ path: path.join(SHOTS, "r5-split-button-light.png") });
      await btn.hover();
      await lp.waitForTimeout(400);
      const hv = await btn.evaluate((b) => {
        const probe = document.createElement("div");
        probe.style.background = "var(--muted)";
        b.parentElement.appendChild(probe);
        const muted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { bg: getComputedStyle(b).backgroundColor, muted, shadow: getComputedStyle(b).boxShadow };
      });
      check("r5 nice 1: hover goes to --muted and keeps the edge", hv.bg === hv.muted && /inset/.test(hv.shadow), JSON.stringify(hv));
      if (SHOTS) await lask.screenshot({ path: path.join(SHOTS, "r5-split-button-light-hover.png") });
      await lp.mouse.move(0, 0);
      await btn.focus();
      await lp.keyboard.press("Shift+Tab");
      await lp.keyboard.press("Tab");
      const fr = await btn.evaluate((b) => ({ outline: getComputedStyle(b).outlineStyle, offset: parseFloat(getComputedStyle(b).outlineOffset) || 0, fv: b.matches(":focus-visible") }));
      check("r5 nice 1: the focus ring sits outside the edge", fr.fv && fr.outline !== "none" && fr.offset >= 0, JSON.stringify(fr));
      if (SHOTS) await lask.screenshot({ path: path.join(SHOTS, "r5-split-button-light-focus.png") });
      await lctx.close();
    }
    // Story and parent-only plans with no decisions: their own card copy, and the same plain no-change line.
    for (const [file, md, label, head, body, want, rows] of R5_PLANS) {
      const title = md.split("\n")[0].slice(2);
      let r = null;
      for (let i = 0; i < 40 && !r; i++) {
        const v = await pg.evaluate(() => fetch("/api/found").then((x) => x.json()));
        r = (v.rows ?? []).find((x) => `${x.title ?? ""} ${x.idea ?? ""}`.includes(title));
        if (!r) await pg.waitForTimeout(250);
      }
      check(`r5 ${label}: the scan finds the imported plan`, !!r);
      if (!r) continue;
      const im = await pg.evaluate((id) => fetch("/api/found/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then((x) => x.json()), r.id);
      await pg.goto(`${new URL(app3.url).origin}${im.url}${new URL(app3.url).search}`);
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      const k0 = splits();
      await openSheet(pg);
      const card = sheet(pg).locator(".iask");
      await card.waitFor({ timeout: 8000 });
      const want1 = `${head} ${body} Split with Grok`;
      const got1 = (await tidy(card)).replace(/(\S)(Right now)/, "$1 $2").replace(/\.Split/, ". Split");
      check(`r5 ${label}: 0 decisions, so the card reads “${head} …”`, got1 === want1, got1);
      await shot(pg, `r5-${label.replace(" ", "-")}-card-grok`, theme);
      // By keyboard, so the focus check below is the keyboard path.
      await card.getByRole("button", { name: "Split with Grok" }).focus();
      await pg.keyboard.press("Enter");
      await noChange(label, want, rows);
      if (label === "parent only") await shot(pg, "r6-parent-only-nochange-focus-grok", theme);
      check(`r5 ${label}: one run`, splits() === k0 + 1, `${k0} → ${splits()}`);
      await shot(pg, `r5-${label.replace(" ", "-")}-nochange-grok`, theme);
      await pg.keyboard.press("Escape");
    }
    actl();
    await ctx.close();
    await app3.stop();
  }

  // Must 4 (#179): focus lands on the saved destination's tab, which arrives after the first paint.
  for (const saved of ["linear", "github"]) {
    const where = { linear: "Linear", github: "GitHub" }[saved];
    const app2 = await server({ config: { issues: { last: saved === "linear" ? "github" : "linear", byProject: { [proj]: saved, [realpathSync(proj)]: saved } } } });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const pg = await ctx.newPage();
      pg.on("pageerror", (e) => errors.push(String(e)));
      await plate(pg, app2.url, "A reading list");
      await openSheet(pg);
      await pg.waitForTimeout(600);
      const sel = await sheet(pg).locator("[role=tab][aria-selected=true]").textContent();
      check(`#179 saved ${where}: the sheet opens on it, focus on its tab`, sel.trim() === where && (await active(pg)) === `tab:${where}`, `${sel} · ${await active(pg)}`);
      if (saved === "linear") await shot(pg, "r2-focus-linear", "dark");
      await pg.keyboard.press("Escape");
      await ctx.close();
    } finally {
      await app2.stop();
    }
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await app.stop();
  await browser.close();
  linear.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
