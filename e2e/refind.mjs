// v1.1 polish #114, a comment's anchor after an accept: re-found by quote + position inside its own
// section (never another section or the title); its own Apply-feedback suggestion, accepted, takes it
// onto the inserted text; anything else that removes its text leaves it "text changed" (item 3 §3.6),
// still On its section. During a held accept (#102) nothing is re-found until the write lands.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/refind.mjs                 checks only (dark and light, desktop and phone)
//   SHOTS=dir node e2e/refind.mjs       also writes d-follow-hold, d-follow, d-detached, m-follow, m-detached
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-rf-"));
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
function fakeBins(ids) {
  const dir = mkdtempSync(path.join(WORK, "bin-"));
  for (const id of ids) {
    writeFileSync(path.join(dir, id), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" ${id} "$@"\n`);
    chmodSync(path.join(dir, id), 0o755);
  }
  return dir;
}
const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});
async function server(extra = {}) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const e = { PATH: `${fakeBins(["claude", "codex"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, ...extra };
  const child = spawn(NODE, [path.join(ROOT, "dist/cli.js"), "--no-open"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
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
  return {
    url,
    home,
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
}
const selectText = (pg, text) =>
  pg.evaluate((t) => {
    const doc = document.querySelector("[data-testid=plan]");
    const w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0 || n.parentElement.closest("button, .sr-only, h1")) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }
    return false;
  }, text);
const planMd = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text());
const pointer = (pg) => pg.evaluate(() => dispatchEvent(new PointerEvent("pointerdown")));
async function axe(pg, name) {
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
/** Pause each hold transition (del/ins.sg, .okm) as it starts, so `step()` can set it to the fake clock. */
const holdTransitions = (pg) =>
  pg.addInitScript(() => {
    const held = (window.__held = []);
    addEventListener(
      "transitionrun",
      (e) => {
        if (!(e.target instanceof Element) || !e.target.matches("del.sg, ins.sg, .okm")) return;
        for (const a of e.target.getAnimations()) {
          if (a.transitionProperty !== e.propertyName || held.some((h) => h.a === a)) continue;
          a.pause();
          held.push({ a, at: performance.now() });
        }
      },
      true,
    );
    window.__step = () => {
      for (const h of held) h.a.currentTime = Math.min(performance.now() - h.at, h.a.effect.getTiming().duration);
    };
    window.__release = () => {
      for (const h of held.splice(0)) h.a.finish();
    };
  });
const step = (pg) => pg.evaluate(() => window.__step());
/** Poll from Node, not the page's rAF (which the installed clock owns). */
async function until(pg, fn, arg, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pg.evaluate(fn, arg)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what} :: ${await pg.evaluate(() => document.elementFromPoint(0, 0) && [...document.querySelectorAll("[data-sg]")].map((e) => e.outerHTML.slice(0, 80)).join(" | "))}`);
}



/** Every comment anchor in the plan: its text, whether it's in the title, the section it's under, its first box. */
const anc = (pg) =>
  pg.evaluate(() =>
    [...document.querySelectorAll("[data-testid=plan] mark.cmk")].map((m) => {
      let h = null;
      for (const e of document.querySelectorAll("[data-testid=plan] h1, [data-testid=plan] h2")) if (e.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) h = e;
      const r = [...m.getClientRects()].find((x) => x.width > 0);
      const c = m.cloneNode(true);
      c.querySelectorAll(".sr-only").forEach((x) => x.remove());
      return { text: c.textContent.replace(/\s+/g, " ").trim(), h1: !!m.closest("h1"), under: h?.textContent.trim() ?? "", left: r && Math.round(r.left), top: r && Math.round(r.top) };
    }),
  );
const ancText = (list) => list.map((a) => a.text).join("");
const planFile = (home) => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "plan.md" ? [path.join(d, e.name)] : []));
  return walk(home)[0];
};
/** Edit plan.md the way another editor would: Problem's paragraph only, never the title. */
function editOnDisk(home, from, to) {
  const f = planFile(home);
  const md = readFileSync(f, "utf8");
  const i = md.indexOf("## Problem");
  const j = md.indexOf(from, i);
  if (i < 0 || j < 0) throw new Error(`"${from}" is not under Problem`);
  writeFileSync(f, md.slice(0, j) + to + md.slice(j + from.length));
}
const LOST = "The text this was on changed, so it is no longer marked in the plan. Claude Code still sees the quote.";
const NEW = "One list the whole household shares";

async function toPlan(pg) {
  await pg.getByRole("radio", { name: /Claude Code/ }).click();
  await pg.getByRole("button", { name: /Continue/ }).click();
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
  await pg.keyboard.press("Enter");
  await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    // ---------------------------------------------------------------- desktop
    const s = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    await holdTransitions(pg);
    await pg.clock.install();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open"))); // no toast from a step before
      await pg.mouse.move(700, 700);
      await step(pg);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await pg.goto(s.url);
    await toPlan(pg);
    await selectText(pg, "Shared shopping list");
    await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
    await pg.keyboard.press("Control+Alt+KeyM");
    await pg.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
    await pg.keyboard.press("Control+Enter");
    const rail = pg.getByRole("complementary", { name: "Comments" });
    await rail.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
    let a = await anc(pg);
    check(`${theme}: the comment is on "Shared shopping list" under Problem`, a.length === 1 && a[0].text === "Shared shopping list" && !a[0].h1 && a[0].under === "Problem", JSON.stringify(a));
    await rail.getByRole("button", { name: "Apply feedback" }).click();
    await rail.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
    const ids = await pg.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
    const A = ids[0];
    check(`${theme}: two suggestions from the thread, the first rewriting its quote`, ids.length === 2 && (await pg.locator(`del.sg[data-sg="${A}"]`).textContent()).includes("Shared shopping list"), ids.join(","));

    // ---- the #11 repro: accept the thread's own suggestion. The comment follows the inserted text;
    // it never re-attaches to the title, and it doesn't move during the hold.
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && !(await pg.evaluate((id) => !!document.querySelector(`.f[data-sg="${id}"]`), A)); i++) await pg.keyboard.press("Alt+ArrowDown");
    await until(pg, (id) => !!document.querySelector(`.f[data-sg="${id}"]`), A, `focus ${A}`);
    await pointer(pg);
    await pg.clock.pauseAt((await pg.evaluate(() => Date.now())) + 1000);
    await pg.locator(".ipill:not(.hp)").getByRole("button", { name: /^Accept/ }).click();
    await step(pg);
    a = await anc(pg);
    check(`${theme} hold t0: the anchor is still on the text it was on`, a.length >= 1 && ancText(a).startsWith("Shared shopping list") && a.every((x) => !x.h1 && x.under === "Problem"), JSON.stringify(a));
    await pg.clock.runFor(200);
    await step(pg);
    const held = await anc(pg);
    check(`${theme} hold t200: the struck text has left; the anchor holds the insertion, under Problem`, ancText(held) === NEW && held.every((x) => !x.h1 && x.under === "Problem"), JSON.stringify(held));
    await snap("d-follow-hold");
    await pg.clock.runFor(140); // 340: the write goes out
    await pg.waitForFunction(async (t) => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text()).includes(t), NEW, { timeout: 5000 });
    await pg.waitForFunction((A) => !document.querySelector(`[data-sg="${A}"]`), A, { timeout: 5000 });
    a = await anc(pg);
    check(`${theme} after the write: the comment is on the inserted text, not the title (#114)`, a.length === 1 && a[0].text === NEW && !a[0].h1 && a[0].under === "Problem", JSON.stringify(a));
    check(`${theme} after the write: nothing moved since the hold`, a.length === 1 && held.length === 1 && Math.abs(a[0].left - held[0].left) <= 1 && Math.abs(a[0].top - held[0].top) <= 1, JSON.stringify({ held, a }));
    check(`${theme}: the title has no anchor`, (await pg.locator("[data-testid=plan] h1 mark.cmk").count()) === 0);
    const head = (await rail.locator(".th").first().textContent()).replace(/\s+/g, " ");
    check(`${theme}: the thread still reads On “Problem”, with no "text changed" line`, /On [“"]Problem[”"]/.test(head) && !head.includes("text this was on changed"), head.slice(0, 120));
    await pg.evaluate(() => window.__release());
    await pg.clock.resume();
    await pg.waitForTimeout(2300); // the ✓ Accepted mark has gone
    await snap("d-follow");
    await axe(pg, `${theme} desktop: followed`);

    // ---- ⌘Z: the comment goes back onto the text it was on
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });
    a = await anc(pg);
    check(`${theme} ⌘Z: the comment is back on "Shared shopping list" under Problem`, ancText(a).startsWith("Shared shopping list") && a.every((x) => !x.h1 && x.under === "Problem"), JSON.stringify(a));

    // ---- detached: the text changes some other way (here plan.md edited in another editor)
    await rail.locator(".th").first().click({ position: { x: 4, y: 4 } }).catch(() => {});
    await pg.keyboard.press("Escape");
    editOnDisk(s.home, "Shared shopping list for my household", "A list for my household");
    await pg.waitForFunction(() => !document.querySelector("[data-testid=plan] mark.cmk") && document.body.textContent.includes("A list for my household"), null, { timeout: 8000 });
    a = await anc(pg);
    check(`${theme} detached: no anchor anywhere, and none on the title (which still says "Shared shopping list")`, a.length === 0 && /Shared shopping list/.test(await pg.locator("[data-testid=plan] h1").textContent()), JSON.stringify(a));
    check(`${theme} detached: its pending suggestion didn't land on the title either; it no longer fits`, (await pg.locator("[data-testid=plan] h1 [data-sg]").count()) === 0 && (await pg.locator(`[data-sg="${A}"]`).count()) === 0);
    const th = rail.locator(".th").first();
    await th.getByText(LOST).waitFor({ timeout: 5000 });
    check(`${theme} detached: the thread counts the suggestion that no longer fits`, await th.getByText("1 suggestion no longer fits the text").isVisible());
    const t2 = (await th.textContent()).replace(/\s+/g, " ");
    check(`${theme} detached: the thread says the text changed, still On “Problem”, with its quote`, t2.includes(LOST) && /On [“"]Problem[”"]/.test(t2) && t2.includes("“Shared shopping list”"), t2.slice(0, 200));
    const look = await th.evaluate((e) => {
      const p = [...e.querySelectorAll("*")].find((x) => x.childNodes.length && [...x.childNodes].some((n) => n.nodeType === 3 && n.data.includes("The text this was on changed")));
      const cs = getComputedStyle(p);
      return { size: cs.fontSize, colour: cs.color, muted: getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground"), icon: !!p.closest("*").parentElement.querySelector("svg") };
    });
    check(`${theme} detached: the line is the item 3 lost state (12px, muted, link-off icon)`, look.size === "12px" && look.icon, JSON.stringify(look));
    await snap("d-detached");
    await axe(pg, `${theme} desktop: detached`);
    await ctx.close();
    await s.stop();

    // ---------------------------------------------------------------- phone: today's accept path, same anchor rule
    const s2 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    const msnap = async (name) => {
      if (!SHOTS) return;
      await mp.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await mp.waitForTimeout(250);
      await mp.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await mp.goto(s2.url);
    await toPlan(mp);
    await selectText(mp, "Shared shopping list");
    const mtb = mp.getByRole("toolbar", { name: "Selection" });
    await mtb.waitFor();
    await mtb.getByRole("button", { name: "Comment" }).click();
    const sheet = mp.getByRole("dialog", { name: "New comment" });
    await sheet.getByRole("textbox").fill("Say who shares it");
    await sheet.getByRole("button", { name: /^Comment/ }).click();
    const openSheet = async () => {
      await mp.getByRole("button", { name: "Plan actions" }).click();
      await mp.getByRole("menuitem", { name: /Comments/ }).click();
      return mp.getByRole("dialog", { name: "Comments" });
    };
    let msheet = await openSheet();
    await msheet.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
    await msheet.getByRole("button", { name: "Apply feedback" }).click();
    await msheet.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
    await msheet.getByRole("button", { name: "Close comments" }).click();
    const mbar = mp.getByRole("toolbar", { name: "Review suggestions" });
    await mbar.waitFor();
    await mbar.getByRole("button", { name: /^Accept suggestion/ }).click();
    await mp.waitForFunction((t) => document.querySelector("[data-testid=plan]").textContent.includes(t) && document.querySelectorAll("del.sg").length === 0, NEW, { timeout: 8000 });
    await mp.waitForTimeout(300);
    a = await anc(mp);
    check(`${theme} phone: the comment follows the inserted text, not the title`, a.length === 1 && a[0].text === NEW && !a[0].h1 && a[0].under === "Problem", JSON.stringify(a));
    await msnap("m-follow");
    await axe(mp, `${theme} phone: followed`);
    editOnDisk(s2.home, NEW, "A list");
    await mp.waitForFunction(() => !document.querySelector("[data-testid=plan] mark.cmk") && document.querySelector("[data-testid=plan]").textContent.includes("A list for my household"), null, { timeout: 8000 });
    msheet = await openSheet();
    await msheet.getByText(LOST).waitFor({ timeout: 5000 });
    const mt = (await msheet.textContent()).replace(/\s+/g, " ");
    check(`${theme} phone detached: the sheet says the text changed, On “Problem”, and the title has no anchor`, mt.includes(LOST) && /On [“"]Problem[”"]/.test(mt) && (await mp.locator("[data-testid=plan] h1 mark.cmk").count()) === 0, mt.slice(0, 200));
    await msnap("m-detached");
    await axe(mp, `${theme} phone: detached`);
    await mctx.close();
    await s2.stop();
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 4).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
