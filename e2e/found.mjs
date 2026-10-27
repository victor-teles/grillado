// v1.3 item 1 end-to-end: Found in this project (handoff §1–§6; §8 is Victor's and not built).
// The group on Home (scan, rows, Show more, partial, empty, ×), the import timeline (Importing… →
// ✓ Imported → the link + tag, focus kept), free-text imports through the fake agent (running,
// Waiting, Stop, a usage-limit failure, Try again), provenance on the plan (meta line, Update,
// gone, compacted) and its Activity entry, Recent after import, cache-first rows on a second
// launch, no motion under data-kbd, and axe in dark and light on desktop and phones.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/found.mjs                 checks only
//   SHOTS=dir node e2e/found.mjs       also writes frames to dir/<section>/
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const FIX = path.join(ROOT, "test/fixtures/found");
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-found-e2e-")));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
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
for (const id of ["claude", "codex"]) {
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
const HOUR_AGO = (Date.now() - 3600_000) / 1000;

/** A project "flatlist" (git, main) and a HOME with Claude Code, Codex and Cursor data from the fixtures. */
function world(name = "flatlist", { sources = true } = {}) {
  const tmp = mkdtempSync(path.join(WORK, "w-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, name);
  mkdirSync(home, { recursive: true });
  if (sources) {
    cpSync(path.join(FIX, "repo"), root, { recursive: true });
    renameSync(path.join(root, "_node_modules"), path.join(root, "node_modules"));
    renameSync(path.join(root, "gitignore.txt"), path.join(root, ".gitignore"));
  } else mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "pkg", "web"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const plansDir = path.join(home, ".claude", "plans");
  const claude = path.join(home, ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  const fill = (src, dest, sub = (s) => s) => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, sub(readFileSync(src, "utf8").replaceAll("__ROOT__", root).replaceAll("__PLANS__", plansDir)));
  };
  if (sources) {
    for (const f of readdirSync(path.join(FIX, "claude"))) fill(path.join(FIX, "claude", f), path.join(claude, f));
    fill(path.join(FIX, "brave-otter.md"), path.join(plansDir, "brave-otter.md"));
    fill(path.join(FIX, "freetext.jsonl"), path.join(claude, "free-a.jsonl"));
    fill(path.join(FIX, "freetext.jsonl"), path.join(claude, "free-b.jsonl"), (s) => s.replaceAll("claude-free", "claude-free-b").replace("offline conflict rules for the shopping list", "undo for checked items"));
    const day = new Date().toISOString().slice(0, 10).split("-");
    const codex = path.join(home, ".codex", "sessions", ...day);
    for (const f of readdirSync(path.join(FIX, "codex"))) fill(path.join(FIX, "codex", f), path.join(codex, f));
    cpSync(path.join(FIX, "home-cursor"), path.join(home, ".cursor", "plans"), { recursive: true });
  }
  for (const dir of [home, root]) for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) utimesSync(path.join(e.parentPath, e.name), HOUR_AGO, HOUR_AGO);
  const ctl = path.join(home, "fake-ctl.json");
  writeFileSync(ctl, "{}");
  return { home, root, claude, ctl, setCtl: (o) => writeFileSync(ctl, JSON.stringify(o)) };
}

/** The web app on its own port, launched from the project folder. */
async function server(w, extra = {}) {
  const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: w.home, GRILLADO_HOME: path.join(w.home, ".grillado"), FAKE_STATE_DIR: w.home, FAKE_CTL: w.ctl, ...extra };
  const child = spawn(NODE, [CLI, "--no-open", "--port", String(await freePort())], { env, cwd: w.root, stdio: ["ignore", "pipe", "pipe"] });
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

async function axe(pg, name) {
  await pg.waitForTimeout(300);
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
const settle = (pg) => pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 4000 }).catch(() => {});
async function shot(pg, section, name) {
  if (!SHOTS) return;
  const dir = path.join(SHOTS, section);
  mkdirSync(dir, { recursive: true });
  await settle(pg);
  await pg.waitForTimeout(250);
  await pg.screenshot({ path: path.join(dir, `${name}.png`) });
}
const txt = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
/** What a reader sees: the drawn separators (::before) read as " · ", aria-hidden dots spaced. */
const seen = (loc) =>
  loc.evaluate((e) => {
    const sg = e.querySelectorAll(e.classList.contains("fp") ? ":scope > span" : ":scope > .sg");
    if (sg.length) return [...sg].map((x) => x.textContent.replace(/\s+/g, " ").trim()).join(" · ");
    return e.innerText.replace(/\s+/g, " ").trim();
  });
const found = (pg) => pg.getByTestId("found");
const rowOf = (pg, title) => found(pg).getByTestId("found-row").filter({ has: pg.locator(".nm", { hasText: title }) });
async function expand(pg) {
  const b = found(pg).getByRole("button", { name: /^Show \d+ more$/ });
  if (await b.count()) await b.click();
}
const inner = async (loc) => (await loc.innerText()).replace(/\s+/g, " ").trim();
const parts = (loc) => loc.evaluate((e) => [...e.children].map((x) => x.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · "));
const live = (pg) => txt(pg.getByTestId("found-live"));
const active = (pg) => pg.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`);
const select = (pg, id) => pg.evaluate((id) => fetch("/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, remember: false }) }).then((r) => r.ok), id);
async function home(pg, url) {
  await pg.goto(url);
  await select(pg, "claude");
  await pg.reload();
  await found(pg).waitFor({ timeout: 10000 });
  await pg.waitForFunction(() => !document.querySelector("[data-testid=found] [aria-busy=true]"), null, { timeout: 10000 });
}
/** The View the server sends, edited, for states a real scan can't hold still (skeleton, partial, a row that couldn't be read). */
async function fakeView(pg, edit) {
  await pg.route("**/api/found", async (route) => {
    const res = await route.fetch();
    const v = await res.json();
    await route.fulfill({ response: res, json: edit(v) });
  });
}

const RECIPE = "Family recipe app";
const BUDGET = "Home budget tracker";
const FREE_A = /offline conflict rules/;
const FREE_B = /undo for checked items/;

let lastPage = null;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of (process.env.THEMES ?? "dark,light").split(",")) {
    const one = theme === "dark";
    const t = (n) => `${n}-${theme}`;
    const w = world();
    let s = await server(w);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addInitScript((th) => localStorage.setItem("grillado-theme", th), theme);
    const pg = await ctx.newPage();
    lastPage = pg;

    // ---------------------------------------------------------------- §1 the group on Home
    await pg.goto(s.url);
    await select(pg, "claude");
    await fakeView(pg, (v) => ({ ...v, state: "scanning", cached: false, rows: [] }));
    await pg.reload();
    await found(pg).waitFor({ timeout: 10000 });
    const sec = found(pg).locator("section.found");
    check(`${theme} §1 scanning: 3 skeleton rows, aria-hidden, aria-busy, "Looking for plans…"`, (await found(pg).locator("li[aria-hidden=true] .sk").count()) === 6 && (await sec.getAttribute("aria-busy")) === "true" && (await txt(found(pg).locator(".fh .busy"))) === "Looking for plans…");
    if (one) {
      if (process.env.DEBUG_SK) console.log(await found(pg).locator("ul > li").first().evaluate((li) => [li, ...li.querySelectorAll("*")].map((e) => `${e.className} ${e.getBoundingClientRect().height} ${getComputedStyle(e).display} ${getComputedStyle(e).padding} ${getComputedStyle(e).lineHeight}`)));
      var skH = await found(pg).locator("section.found").evaluate((e) => e.getBoundingClientRect().height);
    }
    await shot(pg, "1-group", t("d-scan"));
    await axe(pg, `${theme} desktop: Home scanning`);
    await pg.unroute("**/api/found");
    await pg.reload();
    await found(pg).waitFor();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    check(`${theme} §1 header: "Found in this project · flatlist main" and Look again`, /^Found in this project · flatlist\s*main\s*Look again$/.test(await seen(found(pg).locator(".fh"))), await seen(found(pg).locator(".fh")));
    if (one) {
      const h = await found(pg).locator("section.found").evaluate((e) => e.getBoundingClientRect().height);
      check("§1 3+ results: the skeleton block is the found block's height (Recent never moves)", h === skH, `${skH} → ${h}`);
    }
    check(`${theme} §1 section labelled by its h2, not busy`, (await sec.getAttribute("aria-labelledby")) === "found-title" && (await sec.getAttribute("aria-busy")) === null);
    const n = await pg.evaluate(() => fetch("/api/found").then((r) => r.json()).then((v) => v.rows.length));
    if (one) console.log("rows:", await pg.evaluate(() => fetch("/api/found").then((r) => r.json()).then((v) => v.rows.map((r) => `${r.app}/${r.kind} ${r.title ?? r.idea} ${r.status} ${r.date}`))));
    check(`${theme} §1 3 rows then "Show ${n - 3} more" in a 32px bottom line`, (await seen(found(pg).locator(".slot"))) === `Show ${n - 3} more` && (await found(pg).locator(".slot").evaluate((e) => e.getBoundingClientRect().height)) === 32);
    check(`${theme} §1 polite live: "Found ${n} plans in flatlist"`, (await live(pg)) === `Found ${n} plans in flatlist`, await live(pg));
    check(`${theme} §1 the group sits between the composer and Recent`, await pg.evaluate(() => { const f = document.querySelector("[data-testid=found]"); return f.previousElementSibling?.classList.contains("composer") && (f.nextElementSibling?.classList.contains("recent") || f.nextElementSibling?.classList.contains("note")); }));
    check(`${theme} §1 one mount point`, (await pg.locator("[data-testid=found]").count()) === 1);
    if (one) {
      const gap = await pg.evaluate(() => { const f = document.querySelector("[data-testid=found]"); const c = document.querySelector(".composer"); return Math.round(f.getBoundingClientRect().top - c.getBoundingClientRect().bottom); });
      check("§1 40px under the composer", gap === 40, String(gap));
      check("§1 no blue in the group: Import is soft", (await found(pg).locator(".btn.soft.sm.imp").count()) >= 1 && (await found(pg).locator(".btn.primary").count()) === 0);
    }
    await shot(pg, "1-group", t("d-found"));
    await axe(pg, `${theme} desktop: Home with Found`);

    // Show n more: expands in place, focus moves to the first new row, the line goes.
    await found(pg).getByRole("button", { name: /^Show \d+ more$/ }).click();
    check(`${theme} §1 Show more: every row, the bottom line goes`, (await found(pg).getByTestId("found-row").count()) === n && (await found(pg).locator(".slot").count()) === 0);
    const fourth = found(pg).getByTestId("found-row").nth(3);
    check(`${theme} §1 Show more: focus on the first new row`, await fourth.evaluate((li) => li.contains(document.activeElement)), await active(pg));
    await shot(pg, "1-group", t("d-more"));

    // Partial (the 1.5 s budget): one Look again, in the bottom line.
    await fakeView(pg, (v) => ({ ...v, partial: true }));
    await pg.reload();
    await pg.waitForFunction(() => document.querySelector("[data-testid=found] .slot")?.textContent?.includes("1.5"), null, { timeout: 10000 });
    check(`${theme} §1 partial: "Show n more · Showing what we found in 1.5 s · Look again", one Look again`, /^Show \d+ more · Showing what we found in 1\.5 s · Look again$/.test(await seen(found(pg).locator(".slot"))) && (await found(pg).getByRole("button", { name: "Look again" }).count()) === 1, await seen(found(pg).locator(".slot")));
    await shot(pg, "1-group", t("d-partial"));
    await pg.unroute("**/api/found");

    // ---------------------------------------------------------------- §2 rows
    await pg.reload();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    await found(pg).getByRole("button", { name: /^Show \d+ more$/ }).click();
    const meta = async (title) => seen(rowOf(pg, title).locator(".meta"));
    check(`${theme} §2 structured session: "Claude Code session · Oct 20 · 3 questions answered"`, (await meta(RECIPE)) === "Claude Code session · Oct 20 · 3 questions answered", await meta(RECIPE));
    check(`${theme} §2 plan file: "Plan file · docs/plans/billing.md · … · 1 decision"`, /^Plan file · docs\/plans\/billing\.md · \w{3} \d+ · 1 decision$/.test(await meta("Billing v2")), await meta("Billing v2"));
    check(`${theme} §2 Codex in a subfolder on another branch: "Codex session · in pkg/web · feat/dash · …"`, /^Codex session · in pkg\/web · feat\/dash · \w{3} \d+ · \d+ questions? answered$/.test(await meta("Order delay dashboard")), await meta("Order delay dashboard"));
    check(`${theme} §2 free text: "… · in pkg/web · sync-rework · Oct 12 · 6 answers to turn into decisions"`, /^Claude Code session · in pkg\/web · sync-rework · Oct 12 · 6 answers to turn into decisions$/.test(await seen(rowOf(pg, FREE_A).locator(".meta"))), await seen(rowOf(pg, FREE_A).locator(".meta")));
    check(`${theme} §2 Cursor plan label`, /^Cursor plan · /.test(await meta("Onboarding checklist")));
    check(`${theme} §2 rows aren't Tab stops; the buttons are`, (await found(pg).locator("li[tabindex='0'], .frow[tabindex='0']").count()) === 0 && (await rowOf(pg, RECIPE).getByRole("button", { name: "Import" }).count()) === 1);
    check(`${theme} §2 separators are drawn in the gap (::before), never typed`, !(await found(pg).locator(".frow .meta").first().innerHTML()).includes("·"));
    if (one) {
      const r = await rowOf(pg, RECIPE).locator(".frow").evaluate((e) => ({ h: e.getBoundingClientRect().height, pad: getComputedStyle(e).paddingLeft, ml: getComputedStyle(e).marginLeft }));
      check("§2 row: 56px, padding 10px, bleeding 10px", r.h === 56 && r.pad === "10px" && r.ml === "-10px", JSON.stringify(r));
      // Keyboard focus ring on Import.
      await pg.keyboard.press("Tab");
      await rowOf(pg, RECIPE).getByRole("button", { name: "Import" }).focus();
      await shot(pg, "2-rows", t("d-kbd"));
    }
    // A row that couldn't be read, and one in progress (states a scan of these fixtures doesn't hold).
    await fakeView(pg, (v) => ({ ...v, rows: v.rows.map((r, i) => (i === 1 ? { ...r, status: "error" } : i === 2 ? { ...r, status: "in_progress", date: new Date(Date.now() - 60_000).toISOString() } : r)) }));
    await pg.reload();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    const r2 = found(pg).getByTestId("found-row").nth(1);
    const r3 = found(pg).getByTestId("found-row").nth(2);
    check(`${theme} §2 couldn't read: words in destructive ink, quiet "Try again"`, /^Couldn’t read this (session|plan) · /.test(await seen(r2.locator(".meta"))) && (await r2.locator(".meta .er").count()) === 1 && (await r2.getByRole("button", { name: "Try again" }).getAttribute("class"))?.includes("quiet"), await seen(r2.locator(".meta")));
    check(`${theme} §2 in progress: "started 1 min ago" and muted "In progress"`, (await seen(r3.locator(".meta"))).includes("started 1 min ago") && (await txt(r3.locator(".act"))) === "In progress", await seen(r3.locator(".meta")));
    await shot(pg, "2-rows", t("d-err-progress"));
    await axe(pg, `${theme} desktop: rows that couldn't be read / in progress`);
    await pg.unroute("**/api/found");

    // ---------------------------------------------------------------- §3 import (base flow, no toast)
    await pg.reload();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    await expand(pg);
    await pg.evaluate(() => {
      window.__labels = [];
      new MutationObserver((ms) => {
        for (const m of ms) if (m.attributeName === "data-l") window.__labels.push(m.target.getAttribute("data-l"));
      }).observe(document.querySelector("[data-testid=found]"), { attributes: true, subtree: true, attributeFilter: ["data-l"] });
    });
    const recipe = rowOf(pg, RECIPE);
    const impBtn = recipe.getByRole("button", { name: "Import" });
    const w0 = await impBtn.evaluate((e) => e.getBoundingClientRect().width);
    await impBtn.click();
    await recipe.locator(".imp[data-l=c]").waitFor({ timeout: 5000 });
    const w1 = await recipe.locator(".imp").evaluate((e) => e.getBoundingClientRect().width);
    check(`${theme} §3 Importing… then ✓ Imported, the width never changes`, JSON.stringify(await pg.evaluate(() => window.__labels)).startsWith('["b","c"') && w0 === w1, `${JSON.stringify(await pg.evaluate(() => window.__labels))} ${w0}/${w1}`);
    check(`${theme} §3 ✓ Imported: aria-disabled, focus kept on it, live "Imported ‘Family recipe app’"`, (await recipe.locator(".imp").getAttribute("aria-disabled")) === "true" && (await recipe.locator(".imp").evaluate((e) => e === document.activeElement)) && (await live(pg)) === `Imported ‘${RECIPE}’`, `${await active(pg)} ${await live(pg)}`);
    await shot(pg, "3-import", t("d-imported-t0500"));
    const t0 = Date.now();
    await recipe.locator("a.frow").waitFor({ timeout: 5000 });
    const held = Date.now() - t0;
    check(`${theme} §3 after the 1.5 s hold the row is a link to the plan with the "Imported" tag`, (await txt(recipe.locator(".tag"))) === "Imported" && /^\/s\//.test((await recipe.locator("a.frow").getAttribute("href")) ?? "") && held > 700, `held ${held}`);
    check(`${theme} §3 focus moves to the row's new link (#142)`, await recipe.locator("a.frow").evaluate((e) => e === document.activeElement), await active(pg));
    if (one) {
      await recipe.locator("a.frow").hover();
      await shot(pg, "3-import", t("d-imported-t2000-hover"));
    }
    await axe(pg, `${theme} desktop: imported row`);
    // A failed structured import: words, Try again.
    await fakeView(pg, (v) => v);
    await pg.route("**/api/found/import", (route) => route.fulfill({ status: 422, json: { error: "Couldn't read this source.", code: "unreadable" } }));
    const budget = rowOf(pg, BUDGET);
    await budget.getByRole("button", { name: "Import" }).click();
    await budget.getByRole("button", { name: "Try again" }).waitFor({ timeout: 5000 });
    check(`${theme} §3 failure: "Couldn't import · Couldn't read the source · Nothing was saved" + Try again, live "Couldn't import ‘…’"`, (await seen(budget.locator(".meta"))) === "Couldn’t import · Couldn’t read the source · Nothing was saved" && (await live(pg)) === `Couldn’t import ‘${BUDGET}’`, `${await seen(budget.locator(".meta"))} | ${await live(pg)}`);
    await shot(pg, "3-import", t("d-import-failed"));
    await pg.unroute("**/api/found/import");
    await pg.unroute("**/api/found");
    await budget.getByRole("button", { name: "Try again" }).click();
    await budget.locator("a.frow").waitFor({ timeout: 6000 });
    check(`${theme} §3 Try again imports it`, (await txt(budget.locator(".tag"))) === "Imported");

    // ---------------------------------------------------------------- §6 Recent after import (next load)
    await pg.reload();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    check(`${theme} §6 next load: imported sources are gone from Found`, (await rowOf(pg, RECIPE).count()) === 0 && (await rowOf(pg, BUDGET).count()) === 0);
    const rec = pg.locator(".recent .rrow").filter({ hasText: /recipe app/i });
    check(`${theme} §6 Recent: "From Claude Code session · Plated · …" with the .src1 pattern`, /^From Claude Code session · Plated · /.test(await seen(rec.locator(".meta"))) && (await rec.locator(".src1").count()) === 1, await seen(rec.locator(".meta")));
    await shot(pg, "6-recent", t("d-next"));
    await axe(pg, `${theme} desktop: Home after import`);

    // ---------------------------------------------------------------- §4 free text through the fake agent
    w.setCtl({ FAKE_IMPORT_DELAY_MS: "2500" });
    await expand(pg);
    const fa = rowOf(pg, FREE_A);
    const fb = rowOf(pg, FREE_B);
    await fa.getByRole("button", { name: "Import" }).click();
    await fa.getByRole("button", { name: "Stop" }).waitFor({ timeout: 5000 });
    check(`${theme} §4 running: "● Claude Code is turning 6 answers into decisions" + quiet Stop`, (await seen(fa.locator(".meta"))) === "Claude Code is turning 6 answers into decisions" && (await fa.locator(".meta .dot[aria-hidden=true]").count()) === 1 && (await fa.getByRole("button", { name: "Stop" }).getAttribute("class"))?.includes("quiet"), await seen(fa.locator(".meta")));
    await fb.getByRole("button", { name: "Import" }).click();
    await fb.getByText("Waiting").waitFor({ timeout: 5000 });
    check(`${theme} §4 one at a time: the next shows muted "Waiting"`, (await txt(fb.locator(".act"))) === "Waiting");
    await shot(pg, "4-free-text", t("d-freerun"));
    await axe(pg, `${theme} desktop: free-text running + waiting`);
    // Stop the running one: it goes back to New, and the waiting one starts.
    await fa.getByRole("button", { name: "Stop" }).click();
    await fa.getByRole("button", { name: "Import" }).waitFor({ timeout: 5000 });
    check(`${theme} §4 Stop leaves the row as New; focus on its Import`, /^Claude Code session · in pkg\/web/.test(await seen(fa.locator(".meta"))) && (await fa.getByRole("button", { name: "Import" }).evaluate((e) => e === document.activeElement)), await active(pg));
    await fb.getByRole("button", { name: "Stop" }).waitFor({ timeout: 5000 });
    check(`${theme} §4 the waiting one starts in order`, (await seen(fb.locator(".meta"))).startsWith("Claude Code is turning"));
    await fb.locator(".imp[data-l=c]").waitFor({ timeout: 10000 });
    check(`${theme} §4 success follows §3: ✓ Imported`, (await live(pg)).startsWith("Imported ‘"));
    await fb.locator("a.frow").waitFor({ timeout: 5000 });
    // A usage-limit failure, then Try again.
    w.setCtl({ FAKE_IMPORT: "fail" });
    await fa.getByRole("button", { name: "Import" }).click();
    await fa.getByRole("button", { name: "Try again" }).waitFor({ timeout: 10000 });
    check(`${theme} §4 failure: "Couldn't import · Claude Code hit its usage limit · Nothing was saved"`, (await seen(fa.locator(".meta"))) === "Couldn’t import · Claude Code hit its usage limit · Nothing was saved" && (await fa.locator(".meta .er").count()) === 1, await seen(fa.locator(".meta")));
    await shot(pg, "4-free-text", t("d-freefail"));
    await axe(pg, `${theme} desktop: free-text failure`);
    await pg.reload();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    await expand(pg);
    check(`${theme} §4 the failure is still there after a reload (kept per row)`, (await seen(rowOf(pg, FREE_A).locator(".meta"))).startsWith("Couldn’t import"));
    w.setCtl({});
    await rowOf(pg, FREE_A).getByRole("button", { name: "Try again" }).click();
    await rowOf(pg, FREE_A).locator("a.frow").waitFor({ timeout: 10000 });
    check(`${theme} §4 Try again imports it`, true);

    // A free-text import has decisions and no plan text yet: it opens at Confirm (#20), like any session.
    await rowOf(pg, FREE_A).locator("a.frow").click();
    await pg.getByText("Is it done?").waitFor({ timeout: 10000 });
    check(`${theme} §4 the free-text import opens at Confirm with its 6 decisions`, (await pg.getByText("6 decisions settled, nothing open.", { exact: false }).count()) === 1);
    await shot(pg, "4-free-text", t("d-confirm"));

    // ---------------------------------------------------------------- §5 provenance in the plan
    const openPlan = async (re) => {
      await pg.goto(s.url);
      await pg.locator(".recent .rrow").filter({ hasText: re }).first().click();
      await pg.getByTestId("plan").waitFor({ timeout: 10000 });
    };
    const openActivity = async () => {
      await pg.locator(".doc").click({ position: { x: 5, y: 5 } }).catch(() => {});
      await pg.keyboard.press("Control+Alt+KeyA");
      await act.waitFor({ timeout: 5000 });
    };
    const act = pg.getByTestId("activity");
    const pm = pg.getByTestId("plan-meta");
    await openPlan(/recipe app/i);
    const pmText = await seen(pm);
    check(`${theme} §5 meta: "n decisions · Imported from a Claude Code session, Oct 20"`, /^\d+ decisions? · Imported from a Claude Code session, Oct 20$/.test(pmText), pmText);
    await openActivity();
    const entry = act.locator(".ev6").first();
    check(`${theme} §5 Activity: the import is the first entry, "Imported from a Claude Code session"`, (await txt(entry.locator(".tx b"))) === "Imported from a Claude Code session", await txt(entry.locator(".tx")));
    const body = await inner(entry.locator(".evbody"));
    check(`${theme} §5 Activity body: Source (path, not mono), Imported (idea, 3 questions, plan text), Left out`, /^Source ~\/.*structured\.jsonl Imported The opening idea, 3 questions with your answers, and the plan text Left out Tool calls and file contents$/.test(body), body);
    check(`${theme} §5 Activity meta: "… · 3 answers · flatlist"`, /· 3 answers · flatlist$/.test(await parts(entry.locator(".tx .m"))), await parts(entry.locator(".tx .m")));
    const gh = await parts(act.locator(".gh6").last());
    check(`${theme} §5 Activity: the import is its own session dated from the source, "Tue, Oct 20 · h:mm AM · 1 entry"`, /^Tue, Oct 20 · \d+:\d\d [AP]M · 1 entry$/.test(gh), gh);
    await shot(pg, "5-provenance", t("p-imp"));
    await axe(pg, `${theme} desktop: imported plan + Activity`);

    // Compacted: the budget plan.
    await openPlan(/budget/i);
    check(`${theme} §5 compacted: "· Part of the session was compacted"`, (await seen(pm)).endsWith("· Part of the session was compacted"), await seen(pm));
    await openActivity();
    check(`${theme} §5 Activity "Missing": the opening idea came from its summary`, (await inner(act.locator(".ev6").first().locator(".evbody"))).includes("Missing The start of the session was compacted; the opening idea came from its summary"), await txt(act.locator(".ev6").first()));
    await shot(pg, "5-provenance", t("p-compact"));

    // Source changed → Update, from the plan's meta line.
    const file = path.join(w.claude, "structured.jsonl");
    const Q = { header: "Share", question: "Can friends see recipes?", options: [{ label: "No (Recommended)", description: "" }, { label: "Yes", description: "" }] };
    appendFileSync(file, `${JSON.stringify({ sessionId: "claude-struct", cwd: w.root, timestamp: "2026-10-20T11:00:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu9", name: "AskUserQuestion", input: { questions: [Q] } }] } })}\n${JSON.stringify({ sessionId: "claude-struct", cwd: w.root, timestamp: "2026-10-20T11:01:00.000Z", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu9", content: "ok" }] }, toolUseResult: { answers: { [Q.question]: "No" } } })}\n`);
    utimesSync(file, HOUR_AGO + 120, HOUR_AGO + 120);
    await pg.goto(s.url);
    await found(pg).getByRole("button", { name: "Look again" }).click();
    await pg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length > 0, null, { timeout: 10000 });
    await expand(pg);
    const ch = rowOf(pg, RECIPE);
    await ch.waitFor({ timeout: 10000 });
    check(`${theme} §2 changed: the title links to the plan, "Source changed" (fg 500) first, Update (soft)`, (await ch.locator(".nm a").count()) === 1 && (await seen(ch.locator(".meta"))).startsWith("Source changed · Claude Code session") && (await ch.getByRole("button", { name: "Update" }).getAttribute("class"))?.includes("soft"), await seen(ch.locator(".meta")));
    await shot(pg, "2-rows", t("d-changed"));
    await axe(pg, `${theme} desktop: changed row`);
    await ch.locator(".nm a").click();
    await pg.getByTestId("plan").waitFor({ timeout: 10000 });
    check(`${theme} §5 changed: "· Source changed · Update"`, (await seen(pm)).endsWith("· Source changed · Update") && (await pm.locator("button.fp-up").count()) === 1, await txt(pm));
    await shot(pg, "5-provenance", t("p-changed"));
    await axe(pg, `${theme} desktop: plan whose source changed`);
    await pm.getByRole("button", { name: "Update" }).click();
    await pg.waitForFunction(() => !document.querySelector("[data-testid=plan-meta] .fp-up"), null, { timeout: 10000 });
    check(`${theme} §5 Update re-imports into the same plan: the tail goes`, !(await seen(pm)).includes("Source changed") && (await seen(pm)).includes("Imported from a Claude Code session"), await seen(pm));
    await openActivity();
    check(`${theme} §5 Activity logs "Updated from a Claude Code session"`, (await act.locator(".ev6 .tx b").allTextContents()).includes("Updated from a Claude Code session"), (await act.locator(".ev6 .tx b").allTextContents()).join(" | "));

    // Gone: the recipe session file is deleted.
    rmSync(file);
    await openPlan(/recipe app/i);
    check(`${theme} §5 gone: "· Source no longer on disk"`, (await seen(pm)).endsWith("· Source no longer on disk"), await seen(pm));
    await openActivity();
    check(`${theme} §5 Activity "Now": the session file is no longer on disk`, (await inner(act.locator(".ev6").first().locator(".evbody"))).includes("Now The session file is no longer on disk. The plan is unchanged."), await txt(act.locator(".ev6").first()));
    await shot(pg, "5-provenance", t("p-gone"));

    // ---------------------------------------------------------------- §1 cache first on a second launch
    await s.stop();
    s = await server(w);
    const cpg = await ctx.newPage();
    lastPage = cpg;
    await cpg.addInitScript(() => {
      window.__skeleton = false;
      new MutationObserver(() => {
        if (document.querySelector("[data-testid=found] .sk")) window.__skeleton = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await cpg.goto(s.url);
    await select(cpg, "claude");
    await cpg.reload();
    await found(cpg).waitFor({ timeout: 10000 });
    await cpg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length > 0, null, { timeout: 10000 });
    check(`${theme} §1 second launch: the cached rows show at once, no skeleton`, (await cpg.evaluate(() => window.__skeleton)) === false);
    // data-kbd: nothing moves.
    await cpg.keyboard.press("Tab");
    await cpg.evaluate(() => document.documentElement.setAttribute("data-kbd", ""));
    await fakeView(cpg, (v) => ({ ...v, state: "scanning", cached: false, rows: [] }));
    await cpg.reload();
    await cpg.evaluate(() => document.documentElement.setAttribute("data-kbd", ""));
    await found(cpg).locator(".sk").first().waitFor({ timeout: 10000 });
    await cpg.unroute("**/api/found");
    await cpg.evaluate(() => {
      window.__moved = 0;
      const o = new MutationObserver(() => {
        window.__moved += document.getAnimations().length;
      });
      o.observe(document.querySelector("[data-testid=found]"), { childList: true, subtree: true });
    });
    await cpg.evaluate(() => fetch("/api/found/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    await cpg.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length > 0, null, { timeout: 10000 });
    check(`${theme} §7 under data-kbd the rows arrive with no motion`, (await cpg.evaluate(() => document.getAnimations().length + window.__moved)) === 0);
    await cpg.close();
    await s.stop();

    // ---------------------------------------------------------------- §1 empty, × and dismissed
    const we = world("empty-app", { sources: false });
    const se = await server(we);
    const epg = await ctx.newPage();
    await epg.goto(se.url);
    await select(epg, "claude");
    await epg.reload();
    await found(epg).waitFor({ timeout: 10000 });
    await epg.locator(".fempty").waitFor({ timeout: 10000 });
    check(`${theme} §1 empty: "No plans found in empty-app · Look again" and ×, no header`, (await seen(epg.locator(".fempty"))) === "No plans found in empty-app · Look again" && (await epg.getByRole("button", { name: "Hide for this project" }).count()) === 1 && (await found(epg).locator(".fh").count()) === 0, await seen(epg.locator(".fempty")));
    check(`${theme} §1 empty: live "No plans found in empty-app"`, (await live(epg)) === "No plans found in empty-app");
    await shot(epg, "1-group", t("d-empty"));
    await axe(epg, `${theme} desktop: Home empty`);
    await epg.getByRole("button", { name: "Hide for this project" }).click();
    await found(epg).waitFor({ state: "detached", timeout: 5000 });
    await epg.reload();
    await epg.locator(".composer").waitFor();
    await epg.waitForTimeout(600);
    check(`${theme} §1 × hides the group for this project, remembered`, (await found(epg).count()) === 0);
    await shot(epg, "1-group", t("d-dismissed"));
    await epg.close();
    await se.stop();
    await ctx.close();

    // ---------------------------------------------------------------- phones
    const wm = world();
    const sm = await server(wm);
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await mctx.addInitScript((th) => localStorage.setItem("grillado-theme", th), theme);
    const mp = await mctx.newPage();
    await home(mp, sm.url);
    await mp.waitForFunction(() => document.querySelectorAll("[data-testid=found-row]").length === 3, null, { timeout: 10000 });
    const m = await mp.evaluate(() => {
      const r = document.querySelector("[data-testid=found-row] .frow").getBoundingClientRect();
      const b = document.querySelector("[data-testid=found-row] .act .btn").getBoundingClientRect();
      const look = document.querySelector(".fh .look").getBoundingClientRect();
      return { row: r.height, btn: b.height, look: look.height, sideways: document.documentElement.scrollWidth > innerWidth };
    });
    check(`${theme} phone: 60px rows, 44px Import and Look again, no sideways scroll`, m.row === 60 && m.btn === 44 && m.look === 44 && !m.sideways, JSON.stringify(m));
    await shot(mp, "1-group", t("m-found"));
    await axe(mp, `${theme} phone: Home with Found`);
    await expand(mp);
    await rowOf(mp, RECIPE).getByRole("button", { name: "Import" }).click();
    await rowOf(mp, RECIPE).locator(".imp[data-l=c]").waitFor({ timeout: 5000 });
    await shot(mp, "3-import", t("m-imported"));
    await rowOf(mp, RECIPE).locator("a.frow").waitFor({ timeout: 5000 });
    await mp.reload();
    await found(mp).waitFor();
    const mrec = mp.locator(".recent .rrow").filter({ hasText: /recipe app/i });
    await mrec.waitFor({ timeout: 5000 });
    const two = await mrec.evaluate((a) => a.querySelector(".meta").getBoundingClientRect().top >= a.querySelector(".nm").getBoundingClientRect().bottom - 1);
    check(`${theme} phone §6: Recent "From Claude Code session" row on two lines, title over meta (#110)`, two);
    await shot(mp, "6-recent", t("m-next"));
    await axe(mp, `${theme} phone: Home after import`);
    await mrec.click();
    await mp.getByTestId("plan").waitFor({ timeout: 10000 });
    check(`${theme} phone §5: provenance meta`, (await seen(mp.getByTestId("plan-meta"))).includes("Imported from a Claude Code session, Oct 20"));
    await shot(mp, "5-provenance", t("p-m-imp"));
    await axe(mp, `${theme} phone: imported plan`);
    // Empty on a phone: the × is 44px.
    const wme = world("empty-app", { sources: false });
    const sme = await server(wme);
    const mep = await mctx.newPage();
    await mep.goto(sme.url);
    await select(mep, "claude");
    await mep.reload();
    await mep.locator(".fempty").waitFor({ timeout: 10000 });
    const x = await mep.getByRole("button", { name: "Hide for this project" }).evaluate((e) => e.getBoundingClientRect().height);
    check(`${theme} phone: empty × is 44px`, x === 44, String(x));
    await shot(mep, "1-group", t("m-empty"));
    await axe(mep, `${theme} phone: Home empty`);
    await sme.stop();
    await sm.stop();
    await mctx.close();
  }
} catch (err) {
  failures++;
  console.log(`FAIL  crashed: ${err?.stack ?? err}`);
  if (process.env.CRASH_SHOT) await lastPage?.screenshot({ path: process.env.CRASH_SHOT }).catch(() => {});
} finally {
  await browser.close();
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
