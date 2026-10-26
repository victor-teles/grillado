// Item 4 end-to-end: the slash menu in the block editor, from "+" and "/" in the rich view, and in
// the Markdown view; fields, linked fields, no match, U ids on finish, rendered callout / table /
// tabs / checklist, mobile accessory row, and axe (dark/light × desktop/mobile).
// One server and one browser at a time; only processes started here are killed.
//   node e2e/slash.mjs            checks only
//   SHOTS=dir VIDEO=1 node e2e/slash.mjs   also writes screenshots (and a desktop clip) to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-sl-"));
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
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
}

async function toPlan(pg, url) {
  await pg.goto(url);
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
const planMd = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text());
const TA = ".blk-edit:not(.blk-bd)";
const ta = (pg) => pg.$eval(TA, (el) => ({ v: el.value, a: el.selectionStart, b: el.selectionEnd, sel: el.value.slice(el.selectionStart, el.selectionEnd) }));
async function axe(pg, name) {
  await pg.waitForTimeout(400); // let fades finish
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
const options = (pg) => pg.$$eval(".slm [role=option], .msm [role=option]", (els) => els.map((e) => e.textContent.trim()));
/** Open the block editor on the first paragraph, with the caret on a new line at its end. */
async function newLine(pg) {
  await pg.locator(".doc .blk[data-block=para] p").first().click();
  await pg.locator(TA).waitFor();
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.press("Enter");
}
async function plus(pg, n = 0) {
  const blk = pg.locator(".doc .blk[data-block=para]").nth(n);
  await blk.hover();
  await blk.locator(".blk-add").click();
  await pg.locator(".slm").waitFor();
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
    // ---------------------------------------------------------------- desktop
    const s = await server();
    const video = SHOTS && process.env.VIDEO && one ? { dir: path.join(WORK, "video"), size: { width: 1440, height: 900 } } : undefined;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", recordVideo: video });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.waitForTimeout(250);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-d-${theme}.png`) });
    };
    await toPlan(pg, s.url);
    await pg.mouse.move(700, 880);
    await snap("i4-plan");

    // Typing "/" at a line start opens the menu at once; the textarea points at the list.
    await newLine(pg);
    await pg.keyboard.type("/");
    await pg.locator(".slm").waitFor();
    const all = await options(pg);
    if (one) {
      check("typed / opens the menu", await pg.locator(".slm").isVisible());
      check("13 blocks with item 5's “Diagram by Claude Code” row", all.length === 13 && all.some((t) => /^Diagram by Claude Code/.test(t)), all.join(" | "));
      check("groups in the handoff order", (await pg.$$eval(".slm .sm-g", (e) => e.map((x) => x.textContent))).join(",") === "Plan,Diagrams,Blocks,Text");
      const attrs = await pg.$eval(TA, (el) => ({ role: el.getAttribute("role"), ex: el.getAttribute("aria-expanded"), ac: el.getAttribute("aria-autocomplete"), ad: el.getAttribute("aria-activedescendant"), ctl: el.getAttribute("aria-controls") }));
      const list = await pg.$eval(".slm [role=listbox]", (el) => ({ id: el.id, label: el.getAttribute("aria-label") }));
      check("popup attributes", attrs.ac === "list" && !!attrs.ad && attrs.ctl === list.id && list.label === "Blocks", JSON.stringify({ attrs, list }));
      check("preview column at 1440px", await pg.locator(".slm .sm-p").isVisible());
      check("footer key chips are Inter (§18 D)", /Inter/.test(await pg.$eval(".sm-f .kb4", (el) => getComputedStyle(el).fontFamily)));
      await pg.waitForTimeout(400);
      check("count announced politely", /13 blocks/.test(await pg.locator(".slm .sr-only[role=status]").textContent()));
    }
    await snap("i4-menu");
    await axe(pg, `${theme} desktop: menu open`);
    // Filtering: /dia ranks State diagram first; ↓ moves, wraps.
    await pg.keyboard.type("dia");
    if (one) check("/dia → State diagram, Diagram by Claude Code, Flowchart", (await options(pg)).join(" | ") === "State diagram | Diagram by Claude Code | Flowchartdiagram", (await options(pg)).join(" | "));
    for (let i = 0; i < 3; i++) await pg.keyboard.press("ArrowDown");
    if (one) check("↓ wraps to the first row", (await pg.$eval(".slm [aria-selected=true]", (e) => e.textContent)).includes("State diagram"));
    await snap("i4-filter");
    // Esc closes and keeps the text; a second Esc finishes.
    await pg.keyboard.press("Escape");
    if (one) check("Esc closes the menu, keeps /dia", (await pg.locator(".slm").count()) === 0 && (await ta(pg)).v.endsWith("/dia") && (await pg.locator(TA).count()) === 1);
    if (one) check("hint after the menu closes: Esc to finish", (await pg.locator(".blk[data-editing] .blk-hint").textContent()) === "Markdown · Esc to finish", (await pg.locator(".blk[data-editing] .blk-hint").textContent()));
    // Backspace past "/" closes; typing it again reopens.
    for (let i = 0; i < 4; i++) await pg.keyboard.press("Backspace");
    await pg.keyboard.type("/qs");
    if (one) check("/qs → Question first", (await options(pg))[0] === "Question", (await options(pg)).join(" | "));
    await pg.keyboard.press("Enter");
    const q = await ta(pg);
    if (one) {
      check("Question inserted as a decision fence", q.v.includes("```decision\nquestion: Question\nanswer:\n```"), JSON.stringify(q.v.slice(-60)));
      check("its Question field is selected", q.sel === "Question");
      check("field hint", (await pg.locator(".blk[data-editing] .blk-hint").textContent()) === "Tab next field · Esc finish");
      check("insert announced", /Question inserted\. Question field selected\./.test(await pg.locator(".blk[data-editing] > .sr-only[role=status]").textContent()));
      check("field chip under the textarea", (await pg.locator(".blk-bd .ph.on").textContent()) === "Question");
      // Must-fix 2: a fence typed inside a paragraph turns the editor mono, and the chip (not the browser) shows the field.
      const look = await pg.$eval(TA, (el) => ({ mono: el.classList.contains("mono"), font: getComputedStyle(el).fontFamily, sel: getComputedStyle(el, "::selection").backgroundColor }));
      check("prose block holding a fence is mono", look.mono && /Geist Mono/.test(look.font), JSON.stringify(look));
      check("textarea selection is transparent in field mode", look.sel === "rgba(0, 0, 0, 0)", look.sel);
    }
    await snap("i4-fields");
    await pg.keyboard.type("Which browsers do we support?");
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    await pg.waitForFunction(() => document.body.textContent.includes("Which browsers do we support?"));
    await pg.waitForTimeout(800);
    const md1 = await planMd(pg);
    if (one) {
      check("finished: plan.md has id U1, open", /```decision\nid: U1\nquestion: Which browsers do we support\?\nanswer:\n[\s\S]*?status: open/.test(md1) || (/id: U1/.test(md1) && /status: open/.test(md1)), md1.slice(md1.indexOf("id: U1") - 20, md1.indexOf("id: U1") + 160));
      const card = pg.locator(".dz", { hasText: "Which browsers do we support?" }).first();
      check("card says the agent asks it next round", /Claude Code asks it in the next round/.test(await card.textContent()), (await card.textContent()).slice(0, 200));
      check("label U1 in the Decisions tab or card", /U1/.test(await card.textContent()) || /U1/.test(await pg.textContent("body")));
      // The meta line's "·" sits in the gap, so a wrapped line never starts with it.
      check("card meta separators sit in the gap", await card.evaluate((c) => [...c.querySelectorAll(".dz-h > * + *")].every((e) => getComputedStyle(e, "::before").position === "absolute")));
      check("decision card announces its “/” shortcut", /(^| )\/$/.test((await card.getAttribute("aria-keyshortcuts")) ?? "") && (await card.getAttribute("aria-description")) === "Slash adds a block below", await card.getAttribute("aria-keyshortcuts"));
      // "/" on a focused decision card adds a block below it.
      const md0 = await planMd(pg);
      await card.focus();
      await pg.keyboard.press("/");
      await pg.locator(".slm").waitFor();
      check("/ on a decision card opens a new block below it", (await ta(pg)).v === "/");
      await pg.keyboard.press("Escape");
      await pg.keyboard.press("Escape");
      await pg.locator(TA).waitFor({ state: "detached" });
      await pg.waitForTimeout(800);
      check("…and Esc twice removes it", (await planMd(pg)) === md0);
    }
    await snap("i4-question");

    // No match: ↵ keeps it as text and adds the newline.
    await newLine(pg);
    await pg.keyboard.type("/xyz");
    if (one) check("no match empty state", (await pg.locator(".sm-e").textContent()).includes("No block called “/xyz”"));
    await snap("i4-nomatch");
    if (one) await axe(pg, "dark desktop: no match");
    await pg.keyboard.press("Enter");
    if (one) check("↵ with no match closes and inserts a newline", (await pg.locator(".slm").count()) === 0 && (await ta(pg)).v.endsWith("/xyz\n"));
    await pg.keyboard.press("Backspace");
    for (let i = 0; i < 4; i++) await pg.keyboard.press("Backspace");
    // Tab walks the table's fields.
    await pg.keyboard.type("/table");
    await pg.keyboard.press("Enter");
    const t0 = await ta(pg);
    await pg.keyboard.press("Tab");
    const t1 = await ta(pg);
    if (one) check("Tab moves to the next field", t0.sel === "Column" && t1.sel === "Column" && t1.a > t0.a, `${t0.a} → ${t1.a}`);
    await pg.keyboard.type("Owner");
    // Linked field: the state diagram's first state is typed once.
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    if (one) check("table renders", (await pg.locator(".doc .tbl4 th").count()) === 2 && (await pg.locator(".doc .tbl4 th").nth(1).textContent()) === "Owner");

    // Must-fix 3: "/" is announced on each block's Edit button.
    if (one) {
      const keys = await pg.$$eval(".doc .blk-act", (els) => els.map((e) => e.getAttribute("aria-keyshortcuts")));
      check("Edit buttons announce aria-keyshortcuts=/", keys.length > 0 && keys.every((k) => k === "/"), JSON.stringify(keys.slice(0, 4)));
    }
    // Must-fix 1: the "+" tooltip sits left of "+" in the margin, and hides after a click until the pointer leaves.
    {
      const blk = pg.locator(".doc .blk[data-block=para]").first();
      await blk.hover();
      await blk.locator(".blk-add").hover();
      await pg.waitForTimeout(500);
      const tip = await blk.locator(".blk-add").evaluate((b) => {
        const t = b.querySelector(".tip4");
        const r = t.getBoundingClientRect(), p = b.getBoundingClientRect();
        return { vis: getComputedStyle(t).visibility, right: r.right, plusLeft: p.left, mid: Math.abs(r.top + r.height / 2 - (p.top + p.height / 2)) };
      });
      if (one) check("+ tooltip shows left of +, centred", tip.vis === "visible" && tip.right <= tip.plusLeft && tip.mid < 2, JSON.stringify(tip));
      await snap("i4-tooltip");
    }
    // "+" in the margin: a new block below, menu open; Esc twice on it removes it.
    const before = await planMd(pg);
    await plus(pg);
    if (one) check("+ opens a new block with the menu", (await ta(pg)).v === "/" && (await pg.locator(".slm[data-pointer]").count()) === 1);
    if (one) check("+ tooltip hidden after the click while the pointer stays", (await pg.locator(".blk-add[data-used] .tip4").evaluate((t) => getComputedStyle(t).visibility).catch(() => "gone")) !== "visible");
    await snap("i4-plus");
    await pg.keyboard.press("Escape");
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    await pg.waitForTimeout(800);
    if (one) check("Esc on the empty new block removes it", (await planMd(pg)) === before);
    // "+" → /state: linked first state.
    await plus(pg);
    await pg.keyboard.type("state");
    await pg.keyboard.press("Enter");
    await pg.keyboard.type("Idle");
    if (one) check("linked field mirrors (state diagram)", /\[\*\] --> Idle\n  Idle --> Next state/.test((await ta(pg)).v), (await ta(pg)).v);
    await snap("i4-state");
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    // "/" on a focused block: callout.
    await pg.evaluate(() => {
      document.documentElement.setAttribute("data-kbd", "");
      document.querySelector(".doc .blk[data-block=para] > .blk-act").focus();
    });
    await pg.keyboard.press("/");
    await pg.locator(".slm").waitFor();
    await pg.keyboard.type("warn");
    if (one) check("/warn → Callout (alias warning)", (await options(pg))[0].startsWith("Callout") && (await options(pg))[0].includes("warning"), (await options(pg)).join(" | "));
    await pg.keyboard.press("Enter");
    await pg.keyboard.type("Prices change often");
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    const cal = pg.locator(".doc .cal4[data-kind=warning]");
    await cal.waitFor();
    if (one) {
      check("callout renders", (await cal.textContent()).includes("Prices change often"));
      const fl = await pg.locator(".doc .blk[data-fl]").waitFor({ timeout: 1000 }).then(() => true, () => false);
      const where = await pg.evaluate(() => ({ n: document.querySelectorAll(".doc .blk[data-fl]").length, a: document.activeElement?.className, inFl: !!document.activeElement?.closest(".blk[data-fl]") }));
      check("new block flashes and takes focus", fl && where.n === 1 && where.inFl, JSON.stringify(where));
    }
    await snap("i4-callout");
    // Tabs render with only the open tab showing.
    await plus(pg);
    await pg.keyboard.type("tabs");
    await pg.keyboard.press("Enter");
    await pg.keyboard.type("Web");
    await pg.keyboard.press("Escape");
    await pg.locator(TA).waitFor({ state: "detached" });
    const tabs = pg.locator(".doc .tabs4 [role=tab]");
    if (one) {
      check("tabs render", (await tabs.count()) === 2 && (await tabs.first().getAttribute("aria-selected")) === "true" && (await tabs.first().textContent()) === "Web");
      await tabs.nth(1).click();
      check("second tab opens", (await tabs.nth(1).getAttribute("aria-selected")) === "true");
    }
    await pg.mouse.move(700, 880);
    await snap("i4-rendered");
    await axe(pg, `${theme} desktop: rendered blocks`);

    // Markdown view: "/" in CodeMirror.
    await pg.getByRole("radio", { name: "Markdown" }).click();
    const cm = pg.locator(".doc-raw .cm-content");
    await cm.waitFor();
    await cm.click();
    await pg.keyboard.press("Control+End");
    await pg.keyboard.press("Enter");
    await pg.keyboard.press("Enter");
    await pg.keyboard.type("/dif");
    await pg.locator(".slm").waitFor();
    if (one) check("Markdown view: menu opens, CodeMirror points at it", (await cm.getAttribute("aria-autocomplete")) === "list" && !!(await cm.getAttribute("aria-controls")) && !!(await cm.getAttribute("aria-activedescendant")));
    await snap("i4-markdown");
    if (one) await axe(pg, "dark desktop: Markdown view menu");
    await pg.keyboard.press("Enter");
    await pg.keyboard.type("Last edit wins");
    if (one) check("Markdown view inserts the diff", (await cm.textContent()).includes("- Last edit wins"));
    await pg.locator(".ped-modes").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await pg.getByRole("radio", { name: "Rich" }).click();
    await pg.waitForTimeout(800);
    if (one) check("diff saved", /```diff\n- Last edit wins\n\+ added line\n```/.test(await planMd(pg)));
    const clip = video ? await pg.video()?.path() : null;
    await ctx.close();
    if (clip) renameSync(clip, path.join(SHOTS, "i4-desktop.webm"));
    await s.stop();

    // ---------------------------------------------------------------- mobile
    const s2 = await server();
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await toPlan(mp, s2.url);
    await mp.locator(".doc .blk[data-block=para] p").first().tap();
    await mp.locator(".acc4").waitFor();
    if (one) check("mobile: accessory row", (await mp.locator(".acc4 button").allTextContents()).join(",") === "Block,Done");
    if (one) check("mobile: no + in the margin", !(await mp.locator(".blk-add").first().isVisible().catch(() => false)));
    if (one) check("mobile: hint has no Esc", (await mp.locator(".blk[data-editing] .blk-hint").textContent()) === "Markdown");
    await mp.locator(".acc4 button", { hasText: "Block" }).tap();
    await mp.locator(".msm").waitFor();
    if (one) check("mobile: docked list, no preview", (await mp.locator(".msm [role=option]").count()) === 13 && (await mp.locator(".sm-p").count()) === 0);
    await mp.waitForTimeout(400);
    if (one) check("mobile: menu is opaque and on top", await mp.evaluate(() => { const m = document.querySelector(".msm"); const r = m.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return getComputedStyle(m).opacity === "1" && m.contains(hit); }));
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i4-menu-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: menu open`);
    await mp.locator(".msm [role=option]", { hasText: "Checklist" }).tap();
    if (one) check("mobile: tap inserts", (await ta(mp)).v.includes("- [ ] Task"));
    if (one) check("mobile: a field is selected but the hint never says Tab", (await mp.locator(".blk[data-editing] .blk-hint").textContent()) === "Markdown");
    await mp.keyboard.type("Buy milk");
    await mp.locator(".acc4 button", { hasText: "Done" }).tap();
    await mp.locator(TA).waitFor({ state: "detached" });
    if (one) check("mobile: checklist renders", (await mp.locator(".doc ul.ck4 li").count()) === 1);
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i4-done-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: rendered`);
    await mctx.close();
    await s2.stop();
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 12).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
