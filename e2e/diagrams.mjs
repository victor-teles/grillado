// Item 5 end-to-end: Add diagrams from ⋯ (popover, run bar, streaming suggestion, Edit/Accept,
// replace pair, slash "Diagram by {agent}", nothing-to-add toast, failure bar), the figure (theme,
// full screen, zoom, Text view, Enter → editor with live preview and errors, broken source), mobile
// sheet / bar / Tap to zoom / Source | Preview switch, and axe (dark/light × desktop/mobile).
// One server and one browser at a time; only processes started here are killed.
//   node e2e/diagrams.mjs            checks only
//   SHOTS=dir VIDEO=1 node e2e/diagrams.mjs   also writes screenshots (and a desktop clip) to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-dg-"));
// Every agent's install command (review-pr22 r4 #1): each not-installed card is rendered for real, no text swapped in.
const AGENTS = [...readFileSync(path.join(ROOT, "src/core/providers/adapters.ts"), "utf8").matchAll(/id: "([^"]+)",\s*displayName: "([^"]+)",\s*bin: "([^"]+)",\s*installHint: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2], bin: m[3], hint: m[4] }));
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
async function server(extra = {}, bin = fakeBins(["claude", "codex"])) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const e = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, ...extra };
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
    bin,
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
// Holds until no finite CSS animation or transition is running (spinners loop forever and are skipped).
const settle = (pg, timeout = 5000) =>
  pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout }).catch(() => {});
const gone = (loc, timeout = 5000) => loc.first().waitFor({ state: "detached", timeout }).catch(() => {});
async function axe(pg, name) {
  await settle(pg); // let fades finish
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
// Mobile Source | Preview (§11): the switch in the accessory row replaces the preview under the source.
const shown = (loc) => loc.first().evaluate((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none"; }).catch(() => false);
async function mobileSwitch(pg, root, theme, what, shot) {
  const ta = root.locator("textarea");
  const sw = pg.locator(".acc4").getByRole("radiogroup", { name: "Show" });
  const src = sw.getByRole("radio", { name: "Source" });
  const pv = sw.getByRole("radio", { name: "Preview" });
  await ta.waitFor();
  check(`${theme} mobile ${what}: Source | Preview switch and Done in the accessory row`, (await sw.count()) === 1 && (await pg.locator(".acc4").getByRole("button", { name: "Done" }).count()) === 1 && (await pg.locator(".acc4").getByRole("button", { name: "Block" }).count()) === 0);
  check(`${theme} mobile ${what}: opens on Source, the preview isn't under it`, (await src.getAttribute("aria-checked")) === "true" && (await shown(ta)) && !(await shown(root.locator(".lp5"))) && (await ta.evaluate((e) => e === document.activeElement)));
  {
    // MF-SP2: Source, Preview and Done keep their look but take taps over at least 44px of the 48px row.
    const hits = await pg.locator(".acc4 .mseg button, .acc4 .btn").evaluateAll((bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect(), x = r.left + r.width / 2, bf = getComputedStyle(b, "::before");
        const hit = r.height - (parseFloat(bf.top) || 0) - (parseFloat(bf.bottom) || 0);
        const top = r.top + r.height / 2 - hit / 2 + 1, bot = r.top + r.height / 2 + hit / 2 - 1;
        return { t: b.textContent.trim(), hit, reach: b.contains(document.elementFromPoint(x, top)) && b.contains(document.elementFromPoint(x, bot)) };
      }),
    );
    check(`${theme} mobile ${what}: Source, Preview and Done take taps over at least 44px`, hits.length >= 3 && hits.every((h) => h.hit >= 44 && h.reach), JSON.stringify(hits));
  }
  check(`${theme} mobile ${what}: nothing else sits on the accessory row`, await pg.evaluate(() => { const a = document.querySelector(".acc4").getBoundingClientRect(); return [...document.querySelectorAll(".mbar, .toast")].every((e) => { const r = e.getBoundingClientRect(); return r.height === 0 || r.bottom <= a.top || r.top >= a.bottom; }); }));
  await root.evaluate((e) => e.scrollIntoView({ block: "start" }));
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `${shot}-source-m-${theme}.png`) });
  await axe(pg, `${theme} mobile ${what}: Source`);
  await pv.tap();
  await root.locator(".lp5 svg").waitFor({ timeout: 8000 });
  await pg.waitForTimeout(150);
  check(`${theme} mobile ${what}: Preview hides the source and shows the drawing`, (await root.locator("[data-view=preview]").count()) + (await root.evaluate((e) => (e.matches("[data-view=preview]") ? 1 : 0))) === 1 && !(await shown(ta)) && (await shown(root.locator(".lp5 svg"))));
  check(`${theme} mobile ${what}: Preview is checked and focused; the edit stays open`, (await pv.getAttribute("aria-checked")) === "true" && (await pv.evaluate((e) => e === document.activeElement)) && (await ta.count()) === 1);
  check(`${theme} mobile ${what}: Preview brings the block to the top`, (await root.evaluate((e) => e.getBoundingClientRect().top - e.closest(".docwrap").getBoundingClientRect().top)) <= 64, String(await root.evaluate((e) => e.getBoundingClientRect().top - e.closest(".docwrap").getBoundingClientRect().top)));
  check(`${theme} mobile ${what}: the preview fits the width, on screen above the row`, await root.locator(".lp5").evaluate((e) => { const r = e.getBoundingClientRect(), a = document.querySelector(".acc4").getBoundingClientRect(); return r.right <= innerWidth && r.top >= 0 && r.top < a.top && e.querySelector("svg").getBoundingClientRect().width <= r.width; }));
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `${shot}-preview-m-${theme}.png`) });
  await axe(pg, `${theme} mobile ${what}: Preview`);
  await src.tap();
  await pg.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", null, { timeout: 5000 }).catch(() => {});
  check(`${theme} mobile ${what}: Source brings the source back, focused`, (await src.getAttribute("aria-checked")) === "true" && (await shown(ta)) && (await ta.evaluate((e) => e === document.activeElement)));
  // keyboard: ←/→ move the checked option (one tab stop)
  await src.focus();
  await pg.keyboard.press("ArrowRight");
  check(`${theme} mobile ${what}: → on the switch picks Preview`, (await pv.getAttribute("aria-checked")) === "true" && (await pv.evaluate((e) => e === document.activeElement)) && (await src.getAttribute("tabindex")) === "-1");
  await pg.keyboard.press("ArrowLeft");
  check(`${theme} mobile ${what}: ← back to Source`, (await src.getAttribute("aria-checked")) === "true");
  await pv.tap();
  await pg.locator(".acc4").getByRole("button", { name: "Done" }).tap();
  await gone(pg.locator(".acc4"));
  check(`${theme} mobile ${what}: Done from Preview finishes the edit`, (await pg.locator(".acc4").count()) === 0 && (await ta.count()) === 0);
}
// MF-SP1: a broken source shows the error bar (message, Details, announced) in Source and in Preview.
async function mobileError(pg, root, theme, what, shot) {
  const ta = root.locator("textarea");
  const sw = pg.locator(".acc4").getByRole("radiogroup", { name: "Show" });
  await ta.waitFor();
  const orig = await ta.inputValue();
  const bad = /\n```\s*$/.test(orig) ? orig.replace(/\n```\s*$/, '\n  N9{"Same item?"\n```') : `${orig}\n  N9{"Same item?"`;
  await ta.fill(bad);
  const bar = root.locator(".merr");
  await bar.waitFor({ timeout: 5000 });
  const ok = async () => (await shown(bar)) && /Line \d+: a shape isn't closed/.test(await txt(bar)) && (await bar.getAttribute("role")) === "status" && (await bar.getByRole("button", { name: "Details" }).count()) === 1;
  check(`${theme} mobile ${what}: error bar in Source (message, Details, announced)`, (await ok()) && (await ta.getAttribute("aria-invalid")) === "true" && (await ta.getAttribute("aria-describedby"))?.includes(await bar.getAttribute("id")), await txt(bar));
  await root.evaluate((e) => e.scrollIntoView({ block: "start" }));
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `${shot}-error-source-m-${theme}.png`) });
  await axe(pg, `${theme} mobile ${what}: error in Source`);
  await sw.getByRole("radio", { name: "Preview" }).tap();
  await root.locator(".lp5.dim").waitFor({ timeout: 5000 }).catch(() => {});
  await settle(pg);
  check(`${theme} mobile ${what}: error bar stays in Preview, over the dimmed last good version`, (await ok()) && (await root.locator(".lp5.dim").count()) === 1 && /Last version that worked/.test(await txt(root.locator(".lp5 .lbl"))));
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `${shot}-error-preview-m-${theme}.png`) });
  await axe(pg, `${theme} mobile ${what}: error in Preview`);
  await sw.getByRole("radio", { name: "Source" }).tap();
  await ta.fill(orig);
  await gone(bar, 8000);
  check(`${theme} mobile ${what}: fixing the source clears the bar`, (await bar.count()) === 0);
  await pg.locator(".acc4").getByRole("button", { name: "Done" }).tap();
  await gone(pg.locator(".acc4"));
}
const txt = async (loc) => ((await loc.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
async function openAsk(pg, mobile = false) {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menuitem", { name: /Add diagrams/ }).click();
  await pg.getByTestId("add-diagrams").waitFor();
  await pg.waitForTimeout(100);
}
/** Every element of every drawn diagram has no filter, and node shapes keep a 1px border (MF1). */
const flatNodes = (pg) =>
  pg.evaluate(() => {
    const svgs = [...document.querySelectorAll(".doc .mmw svg")];
    const filtered = svgs.flatMap((s) => [s, ...s.querySelectorAll("*")]).filter((e) => getComputedStyle(e).filter !== "none").length;
    const shapes = svgs.flatMap((s) => [...s.querySelectorAll(".node rect, .node polygon, .node path.basic, .node .label-container")]).filter((e) => !e.classList.contains("background"));
    const edged = shapes.filter((e) => parseFloat(getComputedStyle(e).strokeWidth) >= 1 && getComputedStyle(e).stroke !== "none").length;
    return { svgs: svgs.length, filtered, shapes: shapes.length, edged };
  });
/** Counts any "Loading diagram…" placeholder that appears in the plan from now on (MF3). */
const watchPlaceholders = (pg) =>
  pg.evaluate(() => {
    window.__ph = 0;
    window.__phObs?.disconnect();
    window.__phObs = new MutationObserver(() => document.querySelector(".doc .ph5") && window.__ph++);
    window.__phObs.observe(document.body, { subtree: true, childList: true });
  });
const placeholders = (pg) => pg.evaluate(() => (window.__phObs?.disconnect(), window.__ph));
/** The entrance right after an open: no transition and fully opaque when opened from the keyboard (MF5). */
const entrance = (pg, sel) => pg.$eval(sel, (e) => ({ dur: getComputedStyle(e).transitionDuration, op: getComputedStyle(e).opacity }));
const waitRunEnd = (pg) => pg.waitForFunction(() => !document.querySelector("[data-testid=diagram-run]"), null, { timeout: 20000 });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
    // ---------------------------------------------------------------- desktop
    const s = await server({ FAKE_DIAGRAM_DELAY_MS: "900" });
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

    // 1. ⋯ → Add diagrams… (first item), the popover, blue handed over from Copy Markdown (§18 C).
    await pg.getByRole("button", { name: "Plan actions" }).click();
    const items = await pg.$$eval("[role=menuitem]", (els) => els.map((e) => e.textContent.trim()));
    if (one) check("⋯ → Add diagrams… is the first item", items[0] === "Add diagrams…", items.join(" | "));
    await pg.keyboard.press("Escape");
    await openAsk(pg);
    const ask = pg.getByTestId("add-diagrams");
    if (one) {
      check("popover title and copy", /Add diagrams/.test(await txt(ask.locator(".ah"))) && /Claude Code suggests flowcharts and state diagrams/.test(await txt(ask.locator(".ds"))));
      const secs = await ask.locator(".grp").first().locator(".ck5").allTextContents();
      check("one checkbox per section, all checked", secs.join(",") === "Problem,Implementation decisions" && (await ask.locator(".grp").first().locator("input:checked").count()) === 2, secs.join(","));
      check("both kinds checked", (await ask.locator(".kinds input:checked").count()) === 2);
      check("first checked section has focus", await pg.evaluate(() => document.activeElement?.closest(".ck5")?.textContent === "Problem"));
      await ask.locator(".kinds .ck5", { hasText: "Flowcharts" }).click();
      await ask.locator(".kinds .ck5", { hasText: "State diagrams" }).click();
      check("the last kind can't be unchecked", (await ask.locator(".kinds input:checked").count()) === 1 && !!(await ask.locator(".kinds input:checked").getAttribute("aria-describedby")));
      await ask.locator(".kinds .ck5", { hasText: "Flowcharts" }).click();
      check("Copy Markdown hands its blue to Add diagrams (§18 C)", await pg.$eval(".copy-md", (e) => getComputedStyle(e).backgroundColor !== getComputedStyle(document.querySelector(".ask5 .btn.primary")).backgroundColor));
      await ask.getByRole("button", { name: "Clear all" }).click();
      check("Add diagrams is disabled with no section", await ask.locator(".btn.primary").isDisabled());
      await pg.keyboard.press("Escape");
      await pg.waitForTimeout(150);
      check("Esc closes and returns focus to ⋯", (await pg.getByTestId("add-diagrams").count()) === 0 && (await pg.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Plan actions");
      // MF5: with full motion, a pointer open keeps its entrance; ⌘K (a key press) appears at once.
      await pg.emulateMedia({ reducedMotion: "no-preference" });
      await openAsk(pg);
      const viaPointer = await entrance(pg, ".pop5");
      check("pointer-opened popover keeps its 160ms entrance", /0\.16s/.test(viaPointer.dur), JSON.stringify(viaPointer));
      await pg.keyboard.press("Escape");
      await pg.waitForTimeout(150);
      await pg.keyboard.press("Control+k");
      await pg.getByTestId("add-diagrams").waitFor();
      const viaKey = await entrance(pg, ".pop5");
      check("⌘K opens the popover at once: no transition, fully opaque (MF5)", viaKey.dur === "0s" && viaKey.op === "1", JSON.stringify(viaKey));
      await pg.keyboard.press("Escape");
      await pg.waitForTimeout(150);
      await pg.emulateMedia({ reducedMotion: "reduce" });
      await openAsk(pg);
    }
    await ask.locator(".in5").fill("what happens offline");
    await snap("i5-popover");
    await axe(pg, `${theme} desktop: Add diagrams popover`);

    // 2. ⌘↵ starts one run: the run bar in the review bar's slot, one section at a time.
    await pg.keyboard.press("Control+Enter");
    await pg.getByTestId("diagram-run").waitFor({ timeout: 5000 });
    if (one) {
      check("run bar: agent, real count, Stop", /Claude Code is adding diagrams\s*0 of 2 sections\s*Stop/.test(await txt(pg.getByTestId("diagram-run"))), await txt(pg.getByTestId("diagram-run")));
      check("one section at a time: inline row", /Claude Code is drawing a diagram for “Problem”/.test(await txt(pg.getByTestId("diagram-drawing"))));
      await pg.getByRole("button", { name: "Plan actions" }).click();
      check("⋯ → Add diagrams… disabled while it runs", (await pg.getByRole("menuitem", { name: /Add diagrams/ }).getAttribute("aria-disabled")) === "true");
      await pg.keyboard.press("Escape");
      await pg.waitForFunction(() => /1 of 2/.test(document.querySelector("[data-testid=diagram-run]")?.textContent ?? ""), null, { timeout: 8000 });
      check("count moves per finished section", true);
    }
    await snap("i5-run");
    await axe(pg, `${theme} desktop: run bar`);
    await waitRunEnd(pg);
    const sg = pg.getByTestId("diagram-suggestion");
    await sg.first().locator(".mmw svg").waitFor({ timeout: 15000 });
    if (one) {
      const bar = await txt(pg.locator(".review"));
      check("review bar: 1 suggestion, 1 skipped, duration as “4.2 s” (§18 B)", /1 suggestion from Claude Code\s*1 section skipped · \d+\.\d s/.test(bar), bar);
      check("suggestion header", /\+?\s*Suggested flowchart · Claude Code/.test(await txt(sg.locator(".sgt"))), await txt(sg.locator(".sgt")));
      check("suggestion is a labelled group", (await sg.getAttribute("aria-label")) === "Suggested flowchart from Claude Code: Implementation decisions flow");
      check("the SVG is hidden; the group carries the name (read once)", (await sg.locator(".mmw svg").getAttribute("aria-hidden")) === "true" && /Implementation decisions flow$/.test((await sg.getAttribute("aria-label")) ?? ""));
      check("not in plan.md yet", !(await planMd(pg)).includes("```mermaid"));
      check("Accept is soft, Accept all owns the blue", (await sg.getByRole("button", { name: /^Accept/ }).getAttribute("class")).includes("soft") && (await pg.locator(".review .btn.primary").count()) === 1);
    }
    await sg.click({ position: { x: 30, y: 30 } });
    if (one) check("focused: 1 of 1 and shortcuts", /1 of 1/.test(await txt(sg.locator(".hd"))) && /⌫/.test(await txt(sg.locator(".hd"))));
    await snap("i5-suggestion");
    await axe(pg, `${theme} desktop: suggestion`);

    if (one) {
      // 3. Edit: change it, finish → accepted with your changes (#42).
      await sg.getByRole("button", { name: "Edit" }).click();
      const ed = sg.locator("textarea");
      await ed.waitFor();
      check("Edit opens the source with a live preview", (await sg.locator(".lp5 svg").count()) === 1 || (await sg.locator(".lp5").count()) === 1);
      const v = await ed.inputValue();
      await ed.fill(v.replace("|then|", "|next|"));
      await pg.waitForTimeout(500);
      await snap("i5-sgedit");
      await watchPlaceholders(pg);
      await pg.keyboard.press("Escape");
      await pg.locator(".doc figure.mm5 .mmw svg").waitFor({ timeout: 8000 });
      await pg.waitForTimeout(500);
      const md = await planMd(pg);
      check("Edit + finish accepts with your changes", md.includes("```mermaid\nflowchart TD") && md.includes("|next|") && !md.includes("|then|"), md.slice(md.indexOf("```mermaid"), md.indexOf("```mermaid") + 120));
      check("the suggestion is gone", (await sg.count()) === 0);
      check("finishing an edit draws the figure from the SVG it had: no “Loading diagram…” (MF3)", (await placeholders(pg)) === 0);
    } else {
      await watchPlaceholders(pg);
      await sg.getByRole("button", { name: /^Accept/ }).click();
      await pg.locator(".doc figure.mm5 .mmw svg").waitFor({ timeout: 8000 });
      await pg.waitForTimeout(300);
      check(`${theme}: Accept turns the block into a figure with no “Loading diagram…” flash (MF3)`, (await placeholders(pg)) === 0);
      // The lone "Accepted · ⌘Z to undo" keeps off the text: in the gutter when there's room (review of #7).
      const cov = await pg.evaluate(() => {
        const n = document.querySelector(".review.lone");
        if (!n) return { none: true };
        const a = n.getBoundingClientRect();
        const hit = [...document.querySelectorAll(".doc .blk")].some((b) => {
          const r = b.getBoundingClientRect();
          return r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom;
        });
        return { hit };
      });
      check(`${theme}: the Accepted note doesn't cover the plan's text`, cov.none || cov.hit === false, JSON.stringify(cov));
    }
    {
      const f = await flatNodes(pg);
      check(`${theme}: flat nodes, no drop shadow, 1px border (MF1)`, f.svgs > 0 && f.filtered === 0 && f.shapes > 0 && f.edged === f.shapes, JSON.stringify(f));
    }

    // 4. The figure: a tab stop, caption, F → full screen, zoom, Text view, Esc back.
    const fig = pg.locator(".doc figure.mm5").first();
    if (one) {
      check("figure: tab stop, diagram role description", (await fig.getAttribute("tabindex")) === "0" && (await fig.getAttribute("aria-roledescription")) === "diagram");
      check("figure: caption from accTitle", (await txt(fig.locator("figcaption"))) === "Implementation decisions flow");
      check("Mermaid themed from the tokens (Inter, base theme)", await fig.evaluate((f) => /Inter/.test(getComputedStyle(f.querySelector("svg text, svg .nodeLabel") ?? f).fontFamily)));
      check("no ELK: dagre layout", !(await pg.evaluate(() => [...document.scripts].some((x) => /elk/i.test(x.src)))));
    }
    await fig.hover();
    await snap("i5-figure");
    await fig.focus();
    if (one) await pg.emulateMedia({ reducedMotion: "no-preference" });
    await pg.keyboard.press("f");
    const fs = pg.locator(".fs5");
    await fs.waitFor();
    if (one) {
      const viaF = await entrance(pg, ".fs5");
      check("F opens full screen at once: no transition, fully opaque (MF5)", viaF.dur === "0s" && viaF.op === "1", JSON.stringify(viaF));
      await pg.emulateMedia({ reducedMotion: "reduce" });
      await pg.waitForTimeout(150);
      check("full screen opens at 150% for a small diagram (MF2)", (await txt(fs.locator(".zv"))) === "150%", await txt(fs.locator(".zv")));
      check("full screen: dialog with caption", (await fs.getAttribute("role")) === "dialog" && /Implementation decisions flow/.test(await txt(fs.locator(".fh b"))));
      const z0 = await txt(fs.locator(".zv"));
      await pg.keyboard.press("+");
      const z1 = await txt(fs.locator(".zv"));
      check("zoom steps (+)", z0 !== z1 && /%$/.test(z1), `${z0} → ${z1}`);
      await pg.keyboard.press("-");
      await pg.keyboard.press("0");
      const zf = await txt(fs.locator(".zv"));
      check("0 fits, never past 300% (MF2)", /%$/.test(zf) && parseInt(zf) <= 300, zf);
      await pg.keyboard.press("-");
      const zd = parseInt(await txt(fs.locator(".zv")));
      check("− from Fit snaps to the step below (MF2)", [50, 75, 100, 150, 200, 300].includes(zd) && zd < parseInt(zf), `${zf} → ${zd}`);
      check("hint bar", /Drag to pan\s*⌘\s*scroll or pinch to zoom\s*0\s*fit\s*Esc\s*close/.test(await txt(fs.locator(".fhint"))), await txt(fs.locator(".fhint")));
      if (zd > 150) await pg.keyboard.press("-"); // shoot at the 150% it opens at
    }
    await snap("i5-full");
    await axe(pg, `${theme} desktop: full screen`);
    await fs.getByRole("radio", { name: "Text" }).click();
    if (one) check("Text view: counts and arrows", /Flowchart · 3 shapes, 2 arrows/.test(await txt(fs.locator(".tvc"))) && (await fs.locator(".tvc li").count()) === 2, await txt(fs.locator(".tvc")));
    await snap("i5-fulltext");
    await axe(pg, `${theme} desktop: full screen text`);
    await pg.keyboard.press("Escape");
    await fs.waitFor({ state: "detached" });
    await pg.waitForTimeout(100);
    if (one) check("Esc closes and returns focus to the figure", await pg.evaluate(() => document.activeElement?.matches("figure.mm5")));

    if (one) {
      // 5. Replacing a diagram: the section is tagged, checking it asks for a pair.
      await openAsk(pg);
      const row = ask.locator(".ck5", { hasText: "Implementation decisions" });
      check("section with a diagram: unchecked, “Has a diagram”", /Has a diagram/.test(await txt(row)) && !(await row.locator("input").isChecked()));
      await ask.getByRole("button", { name: "Clear all" }).click();
      await row.click();
      await ask.getByRole("button", { name: /^Add diagrams/ }).click();
      await waitRunEnd(pg);
      await pg.getByTestId("diagram-removed").waitFor({ timeout: 15000 });
      check("replace: removed + suggested pair", /Removed · Claude Code/.test(await txt(pg.getByTestId("diagram-removed"))) && (await pg.locator(".sgb5.rep").count()) === 1);
      await snap("i5-replace");
      await axe(pg, "dark desktop: replace pair");
      await pg.locator(".sgb5.rep").getByRole("button", { name: /^Reject/ }).click();
      await pg.getByTestId("diagram-removed").waitFor({ state: "detached" });
      check("Reject keeps the old one", (await pg.locator(".doc figure.mm5").count()) === 1 && (await planMd(pg)).includes("|next|"));

      // 6. "/" → Diagram by Claude Code, for the section you're in; Problem has nothing to draw → toast.
      await pg.locator(".doc .blk[data-block=para] p").first().click();
      await pg.locator(TA).waitFor();
      await pg.keyboard.press("Control+End");
      await pg.keyboard.press("Enter");
      await pg.keyboard.press("Enter");
      await pg.keyboard.type("/diagram");
      await pg.locator(".slm").waitFor();
      const opts = await pg.$$eval(".slm [role=option]", (els) => els.map((e) => e.textContent.trim()));
      check("slash menu has “Diagram by Claude Code”", opts.some((t) => /^Diagram by Claude Code/.test(t)), opts.join(" | "));
      await pg.locator(".slm [role=option]", { hasText: "Diagram by Claude Code" }).click();
      await pg.getByTestId("diagram-run").waitFor({ timeout: 5000 });
      check("slash: one-section run with the inline row", /“Problem”/.test(await txt(pg.getByTestId("diagram-drawing"))));
      await waitRunEnd(pg);
      await pg.getByTestId("diagram-none").waitFor({ timeout: 5000 });
      check("nothing to add: toast", /No diagrams: Claude Code found nothing a diagram would make clearer/.test(await txt(pg.getByTestId("diagram-none"))));
      await snap("i5-none");
      await pg.getByTestId("diagram-none").getByRole("button", { name: "Dismiss" }).click();

      // 6b. Accept all on a batch with a new diagram and a replacement; one ⌘Z undoes the whole batch (PO, #6).
      const before = await planMd(pg);
      const grown = before.replace(/(## Problem\n[^\n]*\n)/, "$1\n- Phones go offline\n- Lists sync later\n");
      await pg.evaluate(async (md) => {
        const r = await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: md }) });
        if (!r.ok) throw new Error(await r.text());
      }, grown);
      await pg.getByText("Lists sync later").waitFor({ timeout: 8000 });
      await openAsk(pg);
      await ask.getByRole("button", { name: "Clear all" }).click();
      await ask.locator(".ck5", { hasText: "Problem" }).click();
      await ask.locator(".ck5", { hasText: "Implementation decisions" }).click();
      await ask.getByRole("button", { name: /^Add diagrams/ }).click();
      await waitRunEnd(pg);
      await pg.waitForFunction(() => document.querySelectorAll("[data-testid=diagram-suggestion]").length === 2, null, { timeout: 15000 });
      check("batch: one new diagram and one replacement", (await pg.locator(".sgb5.rep").count()) === 1 && (await pg.getByTestId("diagram-removed").count()) === 1);
      const base = await planMd(pg);
      await pg.locator(".review").getByRole("button", { name: /^Accept all/ }).click();
      await pg.waitForFunction(() => !document.querySelector("[data-testid=diagram-suggestion]"), null, { timeout: 8000 });
      await pg.waitForTimeout(400);
      const acc = await planMd(pg);
      check("Accept all accepts the new diagram and the replacement", (acc.match(/```mermaid/g) ?? []).length === 2 && acc.includes("accTitle: Problem flow") && !acc.includes("|next|"), acc.slice(0, 400));
      await pg.locator("body").click({ position: { x: 5, y: 300 } });
      await pg.keyboard.press("Control+z");
      await pg.waitForFunction(() => document.querySelectorAll("[data-testid=diagram-suggestion]").length === 2, null, { timeout: 8000 });
      await pg.waitForTimeout(400);
      check("one ⌘Z undoes the whole batch", (await planMd(pg)) === base && (await pg.getByTestId("diagram-removed").count()) === 1, (await planMd(pg)).slice(0, 300));
      await snap("i5-undo-batch");
      await pg.locator(".review").getByRole("button", { name: /^Reject all/ }).click();
      await pg.waitForFunction(() => !document.querySelector("[data-testid=diagram-suggestion]"), null, { timeout: 8000 });
      check("Reject all leaves the plan as it was", (await planMd(pg)) === base);

      // 6c. "/" on a focused figure adds a block below it, like Edit and decision cards (#5 follow-up).
      check("figure announces Enter, F and “/”", (await fig.getAttribute("aria-keyshortcuts")) === "Enter F /" && (await fig.getAttribute("aria-description")) === "Slash adds a block below");
      const mdSlash = await planMd(pg);
      await fig.focus();
      await pg.keyboard.press("/");
      await pg.locator(".slm").waitFor({ timeout: 5000 });
      check("“/” on a figure opens the slash menu in a new block below", (await pg.locator(TA).inputValue()) === "/");
      await pg.keyboard.press("Escape");
      await pg.keyboard.press("Escape");
      await pg.locator(TA).waitFor({ state: "detached" });
      await pg.waitForTimeout(300);
      check("Esc twice leaves the plan as it was", (await planMd(pg)) === mdSlash);

      // 7. Enter on a focused figure edits it: live preview, error after 1s, dimmed last good version.
      await fig.focus();
      await pg.keyboard.press("Enter");
      await pg.locator(TA).waitFor();
      check("opening a block clears the Undo toast", (await pg.locator(".toast").count()) === 0);
      check("desktop: no Source | Preview switch; the preview sits under the source", (await pg.locator(".mseg, .acc4").count()) === 0 && (await pg.locator(".blk[data-editing]").getAttribute("data-view")) === null);
      check("editor hint: Mermaid · ⌘↵ draw now · Esc finish", (await txt(pg.locator(".blk[data-editing] .blk-hint"))) === "Mermaid · ⌘↵ draw now · Esc finish", await txt(pg.locator(".blk[data-editing] .blk-hint")));
      await pg.locator(".blk[data-editing] .lp5 svg").waitFor({ timeout: 8000 });
      await pg.keyboard.press("Control+End");
      await pg.keyboard.press("ArrowUp");
      await pg.keyboard.press("End");
      await pg.keyboard.type('\n  N9{"Same item?"');
      await pg.waitForTimeout(500);
      check("no error before 1s of quiet", (await pg.locator(".merr").count()) === 0);
      await pg.locator(".merr").waitFor({ timeout: 5000 });
      check("error message names the line and the missing }", /Line \d+: a shape isn't closed\. Add the missing } after “Same item\?”\./.test(await txt(pg.locator(".merr"))), await txt(pg.locator(".merr")));
      check("textarea aria-invalid", (await pg.locator(TA).getAttribute("aria-invalid")) === "true");
      check("last good version dimmed with its label", (await pg.locator(".lp5.dim").count()) === 1 && /Last version that worked/.test(await txt(pg.locator(".lp5 .lbl"))));
      await pg.locator(".blk[data-editing] .lp5").evaluate((e) => e.scrollIntoView({ block: "center" }));
      await snap("i5-editerr");
      await axe(pg, "dark desktop: editor error");
      await pg.keyboard.press("Escape");
      await pg.locator(".err5").waitFor({ timeout: 8000 });
      check("broken saved source: error figure with lines", /This diagram can't be drawn/.test(await txt(pg.locator(".err5"))) && (await pg.locator(".err5 .src5 .bad").count()) === 1, await txt(pg.locator(".err5")));
      await snap("i5-errfig");
      await axe(pg, "dark desktop: error figure");
    }
    // 8. Wide and state diagrams: break-out to 820, the floor then crop with its bar, curved state edges.
    {
      const md = await planMd(pg);
      const chain = (n, long) => Array.from({ length: n }, (_, i) => `  S${i}["${long ? `Step ${i + 1} of the flow` : `Step ${i + 1}`}"]${i < n - 1 ? ` -->|then| S${i + 1}` : ""}`).join("\n");
      const extra = [
        "\n## Wide flow\nA longer flow.\n\n```mermaid\nflowchart LR\n  accTitle: Checkout flow\n  accDescr: Four steps from the list to the receipt.\n" + chain(4) + "\n```\n",
        "\n## Long flow\nAn even longer one.\n\n```mermaid\nflowchart LR\n  accTitle: Every step of a sync\n  accDescr: Fourteen steps in a row.\n" + chain(14, true) + "\n```\n",
        "\n## List states\nHow a list changes.\n\n```mermaid\nstateDiagram-v2\n  direction LR\n  accTitle: List states\n  accDescr: A list goes from draft to shared to archived, and back.\n  [*] --> Draft\n  Draft --> Shared: share\n  Shared --> Draft: unshare\n  Shared --> Archived: archive\n  Archived --> Shared: restore\n  Archived --> [*]\n```\n",
      ].join("");
      await pg.evaluate(async (m) => {
        const r = await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: m }) });
        if (!r.ok) throw new Error(await r.text());
      }, md + extra);
      await pg.getByText("How a list changes.").waitFor({ timeout: 8000 });
      const figs = pg.locator(".doc figure.mm5");
      const [wide, crop, state] = [figs.nth(-3), figs.nth(-2), figs.nth(-1)];
      for (const f of [wide, crop, state]) {
        await f.scrollIntoViewIfNeeded();
        await f.locator(".mmw svg").waitFor({ timeout: 10000 });
      }
      if (one) {
        check("a wide diagram breaks out of the column, uncropped", /\bbrk\b/.test(await wide.getAttribute("class")) && !/\bcrop\b/.test(await wide.getAttribute("class")), await wide.getAttribute("class"));
        check("a very wide diagram crops with “Showing part of this diagram”", (await crop.getAttribute("class")).includes("crop") && (await crop.locator(".ovb").isVisible()), await crop.getAttribute("class"));
      }
      const f = await flatNodes(pg);
      check(`${theme}: flat nodes on flowcharts and state diagrams (MF1)`, f.filtered === 0 && f.edged === f.shapes, JSON.stringify(f));
      await wide.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await snap("i5-wide");
      await crop.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await snap("i5-crop");
      await state.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await snap("i5-state");
      await axe(pg, `${theme} desktop: wide, cropped and state diagrams`);
    }

    const clip = video ? await pg.video()?.path() : null;
    await ctx.close();
    if (clip) renameSync(clip, path.join(SHOTS, "i5-desktop.webm"));
    await s.stop();

    // ---------------------------------------------------------------- the agent stops responding
    {
      const s3 = await server({ FAKE_DIAGRAM: "fail" });
      const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await fctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const fp = await fctx.newPage();
      await toPlan(fp, s3.url);
      await openAsk(fp);
      await fp.keyboard.press("Control+Enter");
      await fp.getByTestId("diagram-failed").waitFor({ timeout: 15000 });
      check("failure bar: hit its usage limit · Nothing was changed · Try again", /Claude Code hit its usage limit\s*Nothing was changed\s*Dismiss\s*Try again/.test(await txt(fp.getByTestId("diagram-failed"))), await txt(fp.getByTestId("diagram-failed")));
      check("Try again is the blue one", (await fp.getByTestId("diagram-failed").locator(".btn.primary").textContent()) === "Try again" && (await fp.$eval(".copy-md", (e) => !e.matches(".btn.primary") || getComputedStyle(e).backgroundColor !== getComputedStyle(document.querySelector("[data-testid=diagram-failed] .btn.primary")).backgroundColor)));
      if (SHOTS) await fp.screenshot({ path: path.join(SHOTS, `i5-failed-d-${theme}.png`) });
      await axe(fp, `${theme} desktop: failure bar`);
      await fp.getByRole("button", { name: "Try again" }).click();
      await fp.getByTestId("diagram-failed").waitFor({ timeout: 15000 });
      check("Try again re-sends the rest", true);
      await fctx.close();
      await s3.stop();
    }

    // ---------------------------------------------------------------- mobile failure bar (review-pr22 #2)
    // Both phrases; the reason and what was kept on one row, Dismiss and Try again on their own row,
    // everything inside the screen at 390, 360 and 320.
    for (const code of ["rate_limit", "not_found"]) {
      const sf = await server(code === "rate_limit" ? { FAKE_DIAGRAM: "fail" } : {});
      const fctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
      await fctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const fm = await fctx.newPage();
      await toPlan(fm, sf.url);
      // The CLI gone after the plan was made: the run can't start it (ENOENT → not_found).
      if (code === "not_found") renameSync(path.join(sf.bin, "claude"), path.join(sf.bin, "claude.off"));
      await openAsk(fm, true);
      await fm.locator(".csheet.ask5 .btn.primary").tap();
      const bar = fm.getByTestId("diagram-failed");
      await bar.waitFor({ timeout: 15000 });
      const words = code === "rate_limit" ? "Claude Code hit its usage limit" : "Claude Code isn’t installed";
      for (const width of [390, 360, 320]) {
        await fm.setViewportSize({ width, height: 844 });
        await settle(fm);
        const g = await bar.evaluate((b) => {
          const box = (e) => {
            const r = e.getBoundingClientRect();
            return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) };
          };
          const btns = [...b.querySelectorAll(".r2 .btn")].map((e) => ({ name: e.textContent.trim(), ...box(e) }));
          const why = box(b.querySelector(".lb5"));
          return { vw: innerWidth, vh: innerHeight, bar: box(b), btns, why, text: b.textContent.replace(/\s+/g, " ").trim(), scroll: document.documentElement.scrollWidth - innerWidth };
        });
        const inside = (x) => x.l >= 0 && x.r <= g.vw && x.t >= 0 && x.b <= g.vh;
        check(`${theme} phone ${width} failure bar (${code}): says "${words}" and what was kept`, g.text.startsWith(words) && /Nothing was changed|suggestions? kept/.test(g.text), g.text);
        check(`${theme} phone ${width} failure bar (${code}): Dismiss and Try again on their own row, inside the screen, 44px`, g.btns.length === 2 && g.btns[0].name === "Dismiss" && g.btns[1].name === "Try again" && g.btns.every((x) => inside(x) && x.h >= 44) && g.btns[0].t >= g.why.b && g.btns[0].r <= g.btns[1].l && inside(g.bar) && g.scroll <= 0, JSON.stringify(g));
        if (SHOTS && width !== 360) await fm.screenshot({ path: path.join(SHOTS, `i5-failed-m${width}-${code}-${theme}.png`) });
      }
      await axe(fm, `${theme} phone 320: failure bar (${code})`);
      await fctx.close();
      await sf.stop();
    }

    // ---------------------------------------------------------------- question round, the CLI gone (review-pr22 #3)
    {
      const qctl = path.join(mkdtempSync(path.join(WORK, "ctl-")), "ctl.json");
      writeFileSync(qctl, "{}");
      const sq = await server({ FAKE_CTL: qctl });
      const qctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await qctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const qp = await qctx.newPage();
      await qp.goto(sq.url);
      await qp.getByRole("radio", { name: /Claude Code/ }).click();
      await qp.getByRole("button", { name: /Continue/ }).click();
      await qp.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await qp.keyboard.press("Enter");
      await qp.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
      renameSync(path.join(sq.bin, "claude"), path.join(sq.bin, "claude.off"));
      await qp.getByRole("button", { name: /Send round/ }).click();
      const sentAt = Date.now();
      const card = qp.getByTestId("problem");
      if (!(await card.waitFor({ timeout: 20000 }).then(() => true, () => false))) {
        if (SHOTS) await qp.screenshot({ path: path.join(SHOTS, `card-not-found-${theme}-missing.png`) });
        throw new Error(`no problem card: ${(await qp.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " ⏎ ")}`);
      }
      const c = await card.evaluate((b) => ({ code: b.dataset.code, title: b.querySelector(".t")?.textContent, body: b.querySelector(".t + p")?.textContent, cmd: b.querySelector(".cmd.well code")?.textContent, btns: [...b.querySelectorAll(".acts button")].map((x) => x.textContent.trim()) }));
      check(`${theme} question round, CLI gone: "Claude Code isn’t installed", how to install it, answers kept`, c.code === "not_found" && c.title === "Claude Code isn’t installed" && c.cmd === "npm i -g @anthropic-ai/claude-code" && c.body === "Grillado runs your own Claude Code. Install it, then retry. Your answers are kept.", JSON.stringify(c));
      check(`${theme} question round, CLI gone: Retry stays (and Switch agent, with another agent ready)`, c.btns.at(-1) === "Retry" && c.btns.includes("Switch agent"), JSON.stringify(c.btns));
      const cardShot = async (name) => {
        if (!SHOTS) return;
        const bb = await card.boundingBox();
        const vw = qp.viewportSize().width;
        const x = Math.max(0, bb.x - 16);
        await qp.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x, y: Math.max(0, bb.y - 16), width: Math.min(vw - x, bb.width + 32), height: bb.height + 32 } });
      };
      await cardShot(`card-not-found-${theme}`);
      await qp.setViewportSize({ width: 1440, height: 900 });
      await settle(qp);
      await axe(qp, `${theme} desktop: not-installed card`);
      // review-pr22 r3 #2: a Retry well after the send starts its own turn, so it reads as working, not "Still cooking…".
      if (one) {
        const left = 16_500 - (Date.now() - sentAt);
        if (left > 0) await qp.waitForTimeout(left); // a wall-clock wait on purpose: the timer under test is 15 s
        renameSync(path.join(sq.bin, "claude.off"), path.join(sq.bin, "claude"));
        writeFileSync(qctl, JSON.stringify({ FAKE_DELAY_MS: "3000" }));
        await card.getByRole("button", { name: "Retry" }).click();
        const st = qp.locator(".intro .status");
        await st.waitFor({ timeout: 5000 });
        const label = (await st.textContent()).trim();
        check(`${theme} Retry ${Math.round((Date.now() - sentAt) / 1000)} s after the send: the normal working line, not "Still cooking…"`, label === "Preparing round 2 · reading your answers", label);
        if (SHOTS) await qp.screenshot({ path: path.join(SHOTS, `retry-working-${theme}.png`) });
        await st.waitFor({ state: "detached", timeout: 15000 });
      }
      await qctx.close();
      await sq.stop();
    }

    // ---------------------------------------------------------------- every agent's not-installed card (review-pr22 r3 #1, r4 #1–#3)
    for (const ag of AGENTS) {
      const sa = await server({}, fakeBins(AGENTS.map((x) => x.bin)));
      const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
      await actx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const ap = await actx.newPage();
      await ap.goto(sa.url);
      await ap.locator(`[role=radio][data-id="${ag.id}"]`).click();
      await ap.getByRole("button", { name: /Continue/ }).click();
      await ap.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await ap.keyboard.press("Enter");
      await ap.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
      renameSync(path.join(sa.bin, ag.bin), path.join(sa.bin, `${ag.bin}.off`));
      await ap.getByRole("button", { name: /Send round/ }).click();
      const card = ap.getByTestId("problem");
      await card.waitFor({ timeout: 20000 });
      const well = card.locator(".cmd.well");
      const c = await card.evaluate((b) => ({ title: b.querySelector(".t")?.textContent, cmd: b.querySelector(".cmd.well code")?.textContent, name: b.querySelector(".cmd.well")?.getAttribute("aria-label"), label: getComputedStyle(b.querySelector(".cmd.well .lb .a"), "::after").content }));
      check(`${theme} ${ag.name} not installed: "${ag.name} isn’t installed" and its own command in the well, Copy visible`, c.title === `${ag.name} isn’t installed` && c.cmd === ag.hint && c.name === `Copy ${ag.hint}` && c.label === '"Copy"', JSON.stringify(c));
      // The lines the command is laid out on, from each character's box; a space or a word's last "/" ends a line, never a letter or a hyphen.
      const layout = () =>
        card.evaluate((b) => {
          const box = (e) => {
            const r = e.getBoundingClientRect();
            return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
          };
          const w = b.querySelector(".cmd.well");
          const code = w.querySelector("code");
          const tops = [];
          const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode())
            for (let i = 0; i < n.data.length; i++) {
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + 1);
              const rc = [...r.getClientRects()].find((x) => x.width > 0);
              tops.push(rc ? Math.round(rc.top) : null);
            }
          const text = code.textContent;
          const lines = [];
          const breaks = [];
          let cur = "";
          let top = null;
          for (let i = 0; i < text.length; i++) {
            const t = tops[i] ?? top;
            if (top !== null && t !== null && t > top + 4) {
              lines.push(cur);
              breaks.push(i);
              cur = "";
            }
            if (t !== null) top = t;
            cur += text[i];
          }
          lines.push(cur);
          return { vw: innerWidth, text, lines: lines.map((x) => x.trim()), breaks, card: box(b), well: box(w), code: box(code), copy: box(w.querySelector(".cbtn")), scroll: document.documentElement.scrollWidth - innerWidth };
        });
      const within = (a, o) => a.l >= o.l && a.r <= o.r && a.t >= o.t && a.b <= o.b;
      const okBreak = (t, i) => (t[i - 1] === " " && !/^[^\w@./~-]+$/.test(t.slice(0, i - 1).split(" ").at(-1))) || (t[i - 1] === "/" && t[i - 2] !== "/" && !/[/ ]/.test(t[i]) && !/^[^ ]*\//.test(t.slice(i)));
      for (const width of [390, 360, 320]) {
        await ap.setViewportSize({ width, height: 844 });
        await settle(ap);
        const g = await layout();
        check(`${theme} phone ${width} ${ag.name}: "${ag.hint}" wraps only between words or after a word's last single "/", never mid-word or after a hyphen (${g.lines.join(" ⏎ ")})`, g.text === ag.hint && g.breaks.every((i) => okBreak(g.text, i) && g.text[i - 1] !== "-"), JSON.stringify(g.lines));
        check(`${theme} phone ${width} ${ag.name}: the command and Copy inside the card, no horizontal scroll`, within(g.well, g.card) && within(g.code, g.well) && within(g.copy, g.well) && g.card.r <= g.vw && g.scroll <= 0, JSON.stringify(g));
        if (ag.id === "grok" && width === 320) check(`${theme} phone 320 Grok: "curl -fsSL" / "https://x.ai/cli/" / "install.sh | bash"`, JSON.stringify(g.lines) === JSON.stringify(["curl -fsSL", "https://x.ai/cli/", "install.sh | bash"]), JSON.stringify(g.lines));
        if (SHOTS && (width !== 360 || ag.id === "grok")) {
          const bb = await card.boundingBox();
          await ap.screenshot({ path: path.join(SHOTS, `card-not-found-${ag.id}-m${width}-${theme}.png`), clip: { x: 0, y: Math.max(0, bb.y - 16), width, height: bb.height + 32 } });
        }
      }
      // Copy: the exact command on the clipboard, the name says Copied + the command (axe clean while it shows), then back.
      await ap.setViewportSize({ width: 1440, height: 900 });
      await settle(ap);
      await ap.evaluate(() => navigator.clipboard.writeText("-"));
      await well.click();
      await ap.waitForFunction(() => document.querySelector(".cmd.well .cbtn.done"), null, { timeout: 2000 });
      await settle(ap);
      const clip = await ap.evaluate(() => navigator.clipboard.readText());
      const d = await well.evaluate((e) => ({ name: e.getAttribute("aria-label"), shown: [...e.querySelectorAll(".cbtn .lb > *")].map((x) => [getComputedStyle(x, "::after").content, getComputedStyle(x).opacity]) }));
      check(`${theme} ${ag.name} Copy: the clipboard holds exactly "${ag.hint}"`, clip === ag.hint, JSON.stringify(clip));
      check(`${theme} ${ag.name} Copy: "✓ Copied" shows, and the name is "Copied ${ag.hint}"`, d.name === `Copied ${ag.hint}` && d.shown[1][0] === '"Copied"' && d.shown[1][1] === "1" && d.shown[0][1] === "0", JSON.stringify(d));
      if (SHOTS && (ag.id === "grok" || ag.id === "claude")) {
        const bb = await card.boundingBox();
        await ap.screenshot({ path: path.join(SHOTS, `card-not-found-${ag.id}-copied-${theme}.png`), clip: { x: Math.max(0, bb.x - 16), y: Math.max(0, bb.y - 16), width: bb.width + 32, height: bb.height + 32 } });
      }
      if (ag.id === "grok") {
        const r = await new AxeBuilder({ page: ap }).analyze(); // right away, while Copied still shows
        check(`axe: ${theme} desktop: not-installed card in its Copied state`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target}`).join("; "));
      }
      await ap.waitForFunction(() => !document.querySelector(".cmd.well .cbtn.done"), null, { timeout: 3000 });
      check(`${theme} ${ag.name} Copy: back to Copy`, (await well.getAttribute("aria-label")) === `Copy ${ag.hint}`);
      await actx.close();
      await sa.stop();
    }

    // ---------------------------------------------------------------- mobile
    const s2 = await server({ FAKE_DIAGRAM_DELAY_MS: "600" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await toPlan(mp, s2.url);
    await openAsk(mp, true);
    if (one) check("mobile: a sheet with a full-width Add diagrams", (await mp.locator(".csheet.ask5").count()) === 1 && (await mp.locator(".csheet.ask5 .af .btn.primary").textContent()) === "Add diagrams");
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i5-sheet-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: Add diagrams sheet`);
    await mp.locator(".csheet.ask5 .btn.primary").tap();
    await mp.getByTestId("diagram-run").waitFor({ timeout: 5000 });
    if (one) check("mobile: run bar", /Claude Code is adding diagrams/.test(await txt(mp.getByTestId("diagram-run"))));
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i5-run-m-${theme}.png`) });
    await waitRunEnd(mp);
    // The drawn diagram, not the header's "+" icon (also an svg): waiting on that let the test tap
    // Edit while the first Mermaid load was still compiling and drawing on the phone page.
    await mp.getByTestId("diagram-suggestion").locator(".mmw svg").first().waitFor({ timeout: 15000 });
    await mp.getByTestId("diagram-suggestion").scrollIntoViewIfNeeded();
    {
      const hd = mp.getByTestId("diagram-suggestion").locator(".hd");
      check(`${theme} mobile: suggestion header is the title, Edit as a 44px icon (MF4)`, (await hd.getByRole("button", { name: /^(Accept|Reject)/ }).count()) === 0 && (await hd.getByRole("button", { name: "Edit diagram source" }).evaluate((b) => b.getBoundingClientRect().width >= 44)));
      check(`${theme} mobile: the title stays on one line (MF4)`, await hd.locator(".sgt").evaluate((e) => e.getBoundingClientRect().height <= 24), String(await hd.locator(".sgt").evaluate((e) => e.getBoundingClientRect().height)));
      check(`${theme} mobile: the bar reads “Suggestion 1 of 1” (MF4)`, /Suggestion 1 of 1/.test(await txt(mp.locator(".mbar .r1 b"))), await txt(mp.locator(".mbar .r1 b")));
    }
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i5-suggestion-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: suggestion`);
    {
      const sg = mp.getByTestId("diagram-suggestion");
      await sg.locator(".hd").getByRole("button", { name: "Edit diagram source" }).tap();
      // If the editor doesn't open, say what the page was doing instead of a bare 30s timeout.
      if (!(await sg.locator(".ned5 textarea").waitFor({ timeout: 5000 }).then(() => true, () => false)))
        check(`${theme} mobile: tapping Edit diagram source opens the editor`, false, JSON.stringify(await mp.evaluate(() => ({ suggestions: document.querySelectorAll("[data-testid=diagram-suggestion]").length, editor: !!document.querySelector(".ned5"), active: `${document.activeElement?.tagName}.${document.activeElement?.className}`, dialogs: document.querySelectorAll("[role=dialog]").length }))));
      await mobileSwitch(mp, sg.locator(".ned5"), theme, "suggestion edit", "i5-msugg");
      check(`${theme} mobile: the suggestion is still there to review`, (await mp.getByTestId("diagram-suggestion").count()) === 1);
      await sg.locator(".hd").getByRole("button", { name: "Edit diagram source" }).tap();
      await mobileError(mp, sg.locator(".ned5"), theme, "suggestion edit", "i5-msugg");
      check(`${theme} mobile: an unchanged suggestion is still there after the error round trip`, (await mp.getByTestId("diagram-suggestion").count()) === 1);
    }
    await mp.locator(".mbar").getByRole("button", { name: /^Accept/ }).tap();
    const mfig = mp.locator(".doc figure.mm5").first();
    await mfig.locator(".mmw svg").waitFor({ timeout: 8000 });
    await mfig.scrollIntoViewIfNeeded();
    if (one) check("mobile: figure fits with “Tap to zoom”", /Tap to zoom/.test(await txt(mfig.locator(".tapz"))) && (await mfig.evaluate((f) => f.querySelector("svg").getBoundingClientRect().width <= f.getBoundingClientRect().width)));
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i5-figure-m-${theme}.png`) });
    await mfig.locator(".tapz").tap();
    await mp.locator(".fs5").waitFor();
    if (one) check("mobile: full screen at 100%", (await txt(mp.locator(".fs5 .zv"))) === "100%");
    await settle(mp); // the fade is over before the shot
    check(`${theme} mobile: full screen Close is on screen, 44px`, await mp.getByRole("button", { name: "Close full screen" }).evaluate((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.width >= 44; }));
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i5-full-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: full screen`);
    await mp.getByRole("button", { name: "Close full screen" }).tap();
    await mp.locator(".fs5").waitFor({ state: "detached" });
    {
      // The plan's own block editor (Enter on the focused figure, e.g. with a hardware keyboard).
      const before = await planMd(mp);
      await mfig.focus();
      await mp.keyboard.press("Enter");
      await mobileSwitch(mp, mp.locator(".blk[data-editing]"), theme, "plan diagram", "i5-medit");
      await gone(mp.locator(".blk[data-editing]"));
      await settle(mp);
      check(`${theme} mobile: finishing from Preview leaves the plan as it was`, (await planMd(mp)) === before);
      await mp.locator(".doc figure.mm5 .mmw svg").first().waitFor({ timeout: 8000 });
      await mp.locator(".doc figure.mm5").first().focus();
      await mp.keyboard.press("Enter");
      await mobileError(mp, mp.locator(".blk[data-editing]"), theme, "plan diagram", "i5-medit");
      await gone(mp.locator(".blk[data-editing]"));
      await settle(mp);
      check(`${theme} mobile: the error round trip leaves the plan as it was`, (await planMd(mp)) === before);
      await mp.locator(".doc figure.mm5 .mmw svg").first().waitFor({ timeout: 8000 });
      // Tapping out of Preview finishes too (here on the title, which opens that block instead).
      await mp.locator(".doc figure.mm5").first().focus();
      await mp.keyboard.press("Enter");
      await mp.locator(".acc4").getByRole("radio", { name: "Preview" }).tap();
      await mp.locator(".doc h1").first().tap();
      await gone(mp.locator("[data-view], .mseg"));
      check(`${theme} mobile: tapping out of Preview finishes the edit`, (await mp.locator("[data-view], .mseg").count()) === 0 && !(await mp.locator(".doc figure.mm5").first().evaluate((f) => !!f.closest("[data-editing]"))));
    }
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
