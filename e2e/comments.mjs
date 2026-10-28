// Item 3 end-to-end: comment → reply → follow-up → Apply feedback (plan stays editable) → review
// (accept one, undo, reject one, accept all) → manual Resolve, on desktop and mobile, plus ⌘B/⌘I in
// the block editor and the Markdown view, and axe. Uses the built dist/cli.js and the fake agents.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/comments.mjs            checks only
//   SHOTS=dir VIDEO=1 node e2e/comments.mjs   also writes screenshots (and a desktop clip) to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-cm-"));
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

async function toPlan(pg, url, home) {
  await pg.goto(url);
  await pg.getByRole("radio", { name: /Claude Code/ }).click();
  await pg.getByRole("button", { name: /Continue/ }).click();
  if (home) await home();
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
  await pg.keyboard.press("Enter");
  await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });
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
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    }
    return false;
  }, text);
/** Fix-up of #4, MF1: the comment popover's rules (.cpop) must never restyle Home's idea box (form.composer). */
async function homeComposer(pg, label) {
  await pg.getByRole("textbox", { name: "What are you planning?" }).waitFor();
  const g = await pg.evaluate(() => {
    const f = document.querySelector("form.composer");
    const cs = getComputedStyle(f);
    const r = f.getBoundingClientRect();
    const lede = document.querySelector(".hero .lede").getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.background = "var(--sel)";
    document.body.append(probe);
    const sel = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { pos: cs.position, radius: cs.borderRadius, bg: cs.backgroundColor === sel, top: r.top, ledeBottom: lede.bottom, left: r.left, right: r.right, vw: innerWidth, w: r.width, pad: getComputedStyle(f.querySelector("textarea")).padding };
  });
  check(`MF1 ${label}: Home's idea box is in the page flow, not a popover`, g.pos !== "fixed" && g.pos !== "absolute" && g.radius === "20px" && g.bg && g.pad === "0px", JSON.stringify(g));
  check(`MF1 ${label}: Home's idea box sits below the lede and inside the screen`, g.top >= g.ledeBottom && g.left >= 0 && g.right <= g.vw && g.w > 300, JSON.stringify(g));
}
/** Computed transition of the first match (fix-up of #4, MF2). */
const motion = (pg, sel) => pg.$eval(sel, (e) => ({ dur: getComputedStyle(e).transitionDuration, prop: getComputedStyle(e).transitionProperty, op: getComputedStyle(e).opacity }));
/** The last input was a pointer (main.tsx drops html[data-kbd] on pointerdown). */
const pointer = (pg) => pg.evaluate(() => dispatchEvent(new PointerEvent("pointerdown")));
const railColour = (pg) =>
  pg.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.background = "var(--rail)";
    document.querySelector(".planv").append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
const planMd = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text());
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
/** Visible buttons painted in the primary blue. */
const blues = (pg) =>
  pg.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.background = "var(--primary)";
    document.body.append(probe);
    const blue = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll("button, a")].filter((b) => b.checkVisibility() && getComputedStyle(b).backgroundColor === blue).map((b) => b.textContent.trim());
  });
async function axe(pg, name) {
  await pg.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.closest(".doc") && document.activeElement.blur());
  await pg.mouse.move(0, 0);
  await pg.waitForTimeout(400); // let fades finish
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of SHOTS ? ["dark", "light"] : ["dark"]) {
    // ---------------------------------------------------------------- desktop
    const s = await server({ FAKE_COMMENT_DELAY_MS: "900" });
    const video = SHOTS && process.env.VIDEO && theme === "dark" ? { dir: path.join(WORK, "video"), size: { width: 1440, height: 900 } } : undefined;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"], recordVideo: video });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const snap = async (name) => {
      if (!SHOTS) return;
      if (!(await pg.locator(".seltb, .cpop").count())) await pg.mouse.move(600, 880);
      // A toast left from the step before belongs only in the shot of that step.
      if (name !== "i3-accepted") await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await pg.waitForTimeout(200);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-d-${theme}.png`) });
    };
    const one = theme === "dark";
    await toPlan(pg, s.url, async () => {
      await homeComposer(pg, `desktop ${theme}`);
      await snap("fx4-home");
    });
    const before = await planMd(pg);
    if (one) await axe(pg, "plan, no comments yet");

    if (one) {
      // Fix-up of #4, MF2: with full motion, pointer-opened UI keeps its entrance; key-opened UI appears at once.
      await pg.emulateMedia({ reducedMotion: "no-preference" });
      await pointer(pg);
      await selectText(pg, "Shared shopping list");
      await pg.locator(".seltb").waitFor();
      const tbIn = await motion(pg, ".seltb");
      check("MF2: the selection toolbar enters over 160ms (opacity, scale)", tbIn.dur === "0.16s, 0.16s" && tbIn.prop === "opacity, scale", JSON.stringify(tbIn));
      await pg.locator(".seltb").getByRole("button", { name: /^Comment/ }).click();
      await pg.locator(".cpop").waitFor();
      const popIn = await motion(pg, ".cpop");
      check("MF2: a pointer-opened .cpop rises in over 160ms (opacity, translate)", popIn.dur === "0.16s, 0.16s" && popIn.prop === "opacity, translate", JSON.stringify(popIn));
      await pg.locator(".cpop").getByRole("textbox").press("Escape");
      await pg.locator(".cpop").waitFor({ state: "detached" });
      await selectText(pg, "Shared shopping list");
      await pg.locator(".seltb").waitFor();
      await pg.keyboard.press("Control+Alt+KeyM");
      await pg.locator(".cpop").waitFor();
      const popKey = await motion(pg, ".cpop");
      check("MF2: ⌘⌥M opens .cpop at once (html[data-kbd]): no transition, opaque", popKey.dur === "0s" && popKey.op === "1", JSON.stringify(popKey));
      await pg.locator(".cpop").getByRole("textbox").press("Escape");
      await pg.locator(".cpop").waitFor({ state: "detached" });
      await pg.emulateMedia({ reducedMotion: "reduce" });
      await pointer(pg);
    }

    // Selection toolbar: Comment ⌘⌥M · Edit and nothing else (#27).
    await selectText(pg, "Shared shopping list");
    const tb = pg.getByRole("toolbar", { name: "Selection" });
    await tb.waitFor();
    if (one) {
      const red = await motion(pg, ".seltb");
      check("MF2 reduced motion: the selection toolbar only fades", !/scale|translate|transform/.test(red.prop) && /0\.16s/.test(red.dur), JSON.stringify(red));
    }
    const names = await tb.getByRole("button").allTextContents();
    if (one) check("toolbar has Comment and Edit only (#27)", names.length === 2 && /^Comment/.test(names[0]) && names[1] === "Edit", names.join(" | "));
    await snap("i3-toolbar");
    if (one) await axe(pg, "selection toolbar");
    await pg.keyboard.press("Control+Alt+KeyM");
    const composer = pg.getByRole("dialog", { name: "New comment" });
    await composer.waitFor();
    if (one) check("⌘⌥M opens the composer", await composer.isVisible());
    if (one) check("composer placeholder names the agent", (await composer.getByRole("textbox").getAttribute("placeholder")) === "Comment or ask Claude Code…");
    await composer.getByRole("textbox").fill("Say who shares it");
    if (one) check("composer Comment is the only blue", JSON.stringify(await blues(pg)) === JSON.stringify(["Comment ⌘↵".replace("⌘", "Ctrl+").replace("↵", "Enter")]) || (await blues(pg)).length === 1, (await blues(pg)).join(" | "));
    await snap("i3-composer");
    await pg.keyboard.press("Control+Enter");
    const rail = pg.getByRole("complementary", { name: "Comments" });
    await rail.getByText("Say who shares it").waitFor();
    await rail.getByText(/Claude Code replying/).waitFor();
    await snap("i3-replying");
    await rail.getByText(/^Good catch\./).waitFor({ timeout: 10000 });
    if (one) check("the agent replies to the comment", true);
    const mark = pg.locator("mark.cmk").first();
    if (one) check("anchor drawn on the quote", (await mark.textContent()).includes("Shared shopping list"));
    // Follow-up gets its own answer (N2).
    await rail.getByRole("textbox", { name: "Reply" }).fill("And who changes it?");
    await rail.getByRole("textbox", { name: "Reply" }).press("Enter");
    await rail.getByText(/^Anyone in the household\. Everyone who shares the list can add/).waitFor({ timeout: 10000 });
    if (one) check("the agent answers the follow-up (who changes it), not the first reply again", (await rail.getByText(/^Good catch\./).count()) === 1);
    await snap("i3-replied");

    // Apply feedback: the plan stays editable while it runs (no lock, no caret).
    await rail.getByRole("button", { name: "Apply feedback" }).click();
    await rail.getByText("Claude Code is writing suggestions").waitFor();
    await snap("i3-writing");
    if (one) {
      check("plan not read-only while writing suggestions", (await pg.locator(".ped[data-readonly]").count()) === 0);
      await pg.locator(".doc h2").first().click();
      check("a block opens for editing while writing", await pg.locator(".blk-edit").first().isVisible());
      await pg.keyboard.press("Escape");
    }
    await rail.getByText(/suggestions? ready/).waitFor({ timeout: 10000 });
    const review = pg.getByRole("toolbar", { name: "Review suggestions" });
    await review.waitFor();
    const n = await pg.locator("ins.sg").count();
    if (one) check("suggestions shown in the plan", n >= 2, `${n} insertions`);
    if (one) check("review bar says Suggestions (#29)", /\d suggestions from Claude Code/.test(await review.textContent()));
    if (one) check("save status counts to review", /to review/.test(await pg.getByTestId("save-status").textContent()));
    if (one) check("plan.md has none of the suggestions", (await planMd(pg)) === before);
    await pg.getByRole("button", { name: /^Copy Markdown/ }).click();
    if (one) check("Copy holds accepted text only", !(await pg.evaluate(() => navigator.clipboard.readText())).includes("shared by everyone at home"));
    if (one) check("Accept all is the only blue while reviewing", JSON.stringify(await blues(pg)).includes("Accept all") && (await blues(pg)).length === 1, (await blues(pg)).join(" | "));
    if (one) {
      const txt = `${await review.textContent()} ${await rail.textContent()}`;
      check("no 'edits' wording in the review UI (#29)", !/\bedits?\b/i.test(txt));
    }
    await snap("i3-review");
    if (one) await axe(pg, "rail + review bar");

    // Accept one (⌥↓ then ⌘↵), undo, reject one, accept all.
    await pg.locator("[data-testid=plan]").focus();
    await pg.keyboard.press("Alt+ArrowDown");
    await pg.locator(".ipill").waitFor();
    if (one) check("pill on the focused suggestion with i/n", /^1\/\d/.test(await pg.locator(".ipill .ix").textContent()));
    await snap("i3-focused");
    await pg.keyboard.press("Control+Enter");
    await pg.waitForFunction(() => document.querySelectorAll("ins.sg").length > 0 && document.body.textContent.includes("1 accepted"));
    if (one) check("accept one writes plan.md", (await planMd(pg)).includes("shared by everyone at home"));
    if (one) check("thread row shows partial counts", /1 accepted · \d to review/.test(await rail.textContent()));
    await pg.keyboard.press("Control+z");
    await pg.waitForFunction(() => !document.body.textContent.includes("1 accepted"));
    if (one) check("⌘Z undoes the accept", (await planMd(pg)) === before);
    await pg.keyboard.press("Alt+ArrowDown");
    await pg.keyboard.press("Control+Backspace");
    await pg.waitForFunction(() => document.body.textContent.includes("1 rejected"));
    if (one) check("reject one leaves plan.md alone", (await planMd(pg)) === before);
    await pg.getByRole("button", { name: /^Undo|^Reject all|^Accept all/ }).first().waitFor();
    await pg.keyboard.press("Control+z");
    await pg.waitForFunction(() => !document.body.textContent.includes("1 rejected"));
    await review.getByRole("button", { name: /Accept all/ }).click();
    await pg.getByRole("status").filter({ hasText: /suggestions accepted/ }).first().waitFor();
    if (one) {
      const t = await motion(pg, ".toast");
      check("MF2 reduced motion: the toast only fades (220ms)", !/scale|translate|transform/.test(t.prop) && /0\.22s/.test(t.dur), JSON.stringify(t));
    }
    await snap("i3-accepted");
    const after = await planMd(pg);
    if (one) check("accept all writes every suggestion to plan.md", after.includes("shared by everyone at home") && (await pg.locator("ins.sg").count()) === 0);
    // All accepted: Resolve is offered, the thread stays open (#28).
    await rail.getByText(/\d accepted · in plan\.md/).waitFor();
    if (one) check("all accepted offers Resolve (#28)", await rail.locator("[data-row=accepted]").getByRole("button", { name: "Resolve" }).isVisible());
    if (one) check("thread is not auto-resolved (#28)", (await rail.getByRole("button", { name: /^Resolved/ }).count()) === 0);
    if (one) {
      await pg.getByRole("button", { name: "Undo" }).click();
      await pg.waitForFunction(() => document.querySelectorAll("ins.sg").length > 0);
      check("Undo on the toast brings them back", (await planMd(pg)) === before);
      await review.getByRole("button", { name: /Accept all/ }).click();
      await rail.getByText(/\d accepted · in plan\.md/).waitFor();
    }
    await rail.locator("[data-row=accepted]").getByRole("button", { name: "Resolve" }).click();
    await rail.getByRole("button", { name: /^Resolved 1/ }).waitFor();
    if (one) check("manual Resolve moves the thread to Resolved", true);
    await snap("i3-resolved");

    if (one) {
      // ⌘B / ⌘I keep working in the block editor (#27).
      await pg.locator(".doc p").filter({ hasText: "everyone at home" }).first().click();
      const ta = pg.locator(".blk-edit textarea, textarea.blk-edit").first();
      await ta.waitFor();
      await ta.evaluate((el) => {
        const i = el.value.indexOf("household");
        el.setSelectionRange(i, i + "household".length);
      });
      await pg.keyboard.press("Control+b");
      check("⌘B bolds in the block editor", (await ta.inputValue()).includes("**household**"));
      await pg.keyboard.press("Control+i");
      check("⌘I italicizes in the block editor", (await ta.inputValue()).includes("***household***") || (await ta.inputValue()).includes("_**household**_") || (await ta.inputValue()).includes("***household***"), await ta.inputValue());
      await pg.keyboard.press("Escape");
      // …and in the Markdown view.
      await pg.keyboard.press("Control+Shift+KeyM");
      const cm = pg.locator(".cm-content");
      await cm.waitFor();
      await pg.evaluate(() => {
        const view = document.querySelector(".cm-content").cmView?.view;
        void view;
      });
      await cm.click();
      await pg.keyboard.press("Control+End");
      await pg.keyboard.type("\n\nplain words");
      for (let i = 0; i < 5; i++) await pg.keyboard.press("Shift+ArrowLeft");
      await pg.keyboard.press("Control+b");
      await pg.waitForTimeout(100);
      check("⌘B bolds in the Markdown view", (await cm.textContent()).includes("plain **words**"));
      await pg.keyboard.press("Control+i");
      await pg.waitForTimeout(100);
      check("⌘I italicizes in the Markdown view", /plain \*\*\*words\*\*\*|plain \*\*\*words\*\*\*/.test(await cm.textContent()), (await cm.textContent()).slice(-40));
      // ⌘⌥M in the Markdown view says where commenting works.
      await pg.keyboard.press("Control+Alt+KeyM");
      check("⌘⌥M in Markdown says switch to Rich", await pg.getByText("Switch to Rich to comment").first().isVisible().catch(() => false) || (await pg.locator("[role=status]").allTextContents()).some((t) => t.includes("Switch to Rich")));
      await pg.keyboard.press("Control+Shift+KeyM");
      await axe(pg, "after review, resolved");
      // Fix-up of #4, MF3: the rail and item 6's sticky group header sit on --rail.
      const railC = await railColour(pg);
      check("MF3: .crail is on --rail", (await bg(pg.locator(".crail"))) === railC, `${await bg(pg.locator(".crail"))} vs ${railC}`);
      await rail.getByRole("tab", { name: /Activity/ }).click();
      await pg.locator(".gh6").first().waitFor();
      check("MF3: Activity's sticky group header is on --rail", (await bg(pg.locator(".gh6").first())) === railC, await bg(pg.locator(".gh6").first()));
      await rail.getByRole("tab", { name: /Comments/ }).click();
    }
    await ctx.close();
    if (video) {
      const f = readdirSync(video.dir).find((x) => x.endsWith(".webm"));
      if (f) renameSync(path.join(video.dir, f), path.join(SHOTS, "i3-flow-d-dark.webm"));
    }
    await s.stop();

    if (theme === "dark") {
      // ------------------------------------------------ PO follow-ups: "Applying…" and per-block hiding
      const s3 = await server({ FAKE_COMMENT_DELAY_MS: "1500" });
      const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const p3 = await c3.newPage();
      await toPlan(p3, s3.url);
      const rail3 = p3.getByRole("complementary", { name: "Comments" });
      const comment = async (quote, text) => {
        await selectText(p3, quote);
        await p3.getByRole("toolbar", { name: "Selection" }).waitFor();
        await p3.keyboard.press("Control+Alt+KeyM");
        const d = p3.getByRole("dialog", { name: "New comment" });
        await d.getByRole("textbox").fill(text);
        await p3.keyboard.press("Control+Enter");
        await d.waitFor({ state: "hidden" });
      };
      await comment("Shared shopping list", "Say who shares it");
      await comment("Implementation decisions", "Order these");
      await p3.waitForFunction(() => document.querySelectorAll("[data-thread] .apply").length === 2, null, { timeout: 15000 });
      const ta = rail3.locator("[data-thread]").filter({ hasText: "Say who shares it" });
      const tb2 = rail3.locator("[data-thread]").filter({ hasText: "Order these" });
      await ta.getByRole("button", { name: "Apply feedback" }).click();
      await ta.getByText("Claude Code is writing suggestions").waitFor();
      const other = tb2.locator(".apply");
      // Fix-up of #4, MF2: watch .planv[data-landing] and the tints' transition while this run lands.
      await p3.emulateMedia({ reducedMotion: "no-preference" });
      await p3.evaluate(() => {
        window.__land = [];
        const note = () => {
          const sg = document.querySelector("ins.sg");
          if (sg) window.__land.push({ on: document.querySelector(".planv").hasAttribute("data-landing"), dur: getComputedStyle(sg).transitionDuration });
        };
        new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-landing"] });
      });
      check("while Apply runs, the other thread's Apply is disabled", await other.isDisabled());
      check("…and labelled Applying…", (await other.textContent()).trim() === "Applying…", await other.textContent());
      await ta.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
      await p3.waitForFunction(() => [...document.querySelectorAll("[data-thread] .apply")].some((b) => !b.disabled && b.textContent.trim() === "Apply feedback"));
      check("Apply comes back once the run is done", await tb2.getByRole("button", { name: "Apply feedback" }).isEnabled());
      {
        await p3.waitForTimeout(400);
        const land = await p3.evaluate(() => window.__land);
        check("MF2: the tints fade in (220ms) while .planv[data-landing] is set", land.length > 0 && land[0].on && land[0].dur === "0.22s", JSON.stringify(land.slice(0, 3)));
        check("MF2: data-landing clears ~250ms after the run lands", !(await p3.locator(".planv[data-landing]").count()));
        const rv = await motion(p3, ".review");
        check("MF2: the review bar rises in over 220ms (opacity, translate)", rv.dur === "0.22s, 0.22s" && rv.prop === "opacity, translate", JSON.stringify(rv));
        const ap = await motion(p3, ".th .apply");
        check("MF2: Apply feedback fades in over 160ms", /^opacity/.test(ap.prop) && /^0\.16s/.test(ap.dur), JSON.stringify(ap));
        const th = await motion(p3, ".th");
        check("MF2: threads and anchors change background over 160ms", th.dur === "0.16s, 0.16s" && /background-color/.test(th.prop) && (await motion(p3, "mark.cmk")).dur === "0.16s, 0.16s", JSON.stringify(th));
        await p3.locator("[data-testid=plan]").focus();
        await p3.keyboard.press("Alt+ArrowDown");
        await p3.locator(".ipill").waitFor();
        const sg = await motion(p3, "ins.sg");
        check("MF2: ⌥↓ doesn't replay the tint fade", sg.dur === "0s" && !(await p3.locator(".planv[data-landing]").count()), JSON.stringify(sg));
        const kb = await Promise.all([".review", ".th", "mark.cmk", ".th .apply"].map((x) => motion(p3, x)));
        check("MF2: with the keys (html[data-kbd]) bars, threads and anchors don't move", kb.every((m) => m.dur === "0s"), JSON.stringify(kb.map((m) => m.dur)));
        await p3.keyboard.press("Escape");
        await p3.emulateMedia({ reducedMotion: "reduce" });
        await pointer(p3);
      }
      // Editing one block hides only that block's suggestions (item 3 §4.7, PO call).
      const total = await p3.locator("ins.sg").count();
      // Edit the list block: its suggestion hides, the one in the Problem paragraph stays.
      await p3.locator(".blk").filter({ has: p3.locator("li", { hasText: "Web app" }) }).first().locator(".blk-act").click({ force: true });
      const ed = p3.locator("[data-editing] textarea").first();
      await ed.waitFor();
      const shown = await p3.locator("ins.sg").count();
      check("editing a block keeps other blocks' suggestions visible", total >= 2 && shown >= 1 && shown < total && (await p3.locator("ins.sg").filter({ hasText: "shared by everyone" }).count()) === 1, `${shown} of ${total}`);
      check("the edited block's suggestions are hidden", (await p3.locator("[data-editing] ins.sg").count()) === 0 && (await p3.locator("ins.sg").filter({ hasText: "shipped first" }).count()) === 0);
      // Change the text under that suggestion, then finish: it no longer fits, so it's dropped and flagged.
      await ed.fill((await ed.inputValue()).replace("Yes, one core flow", "One flow"));
      await p3.keyboard.press("Escape");
      await ta.getByText("1 suggestion no longer fits the text").waitFor({ timeout: 10000 });
      check("on save, a suggestion that no longer fits is dropped and flagged", (await p3.locator("ins.sg").count()) === shown);
      await axe(p3, "Applying… and per-block hiding");
      await c3.close();
      await s3.stop();
    }

    // ---------------------------------------------------------------- mobile (#30)
    const s2 = await server({ FAKE_COMMENT_DELAY_MS: "300" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    const msnap = async (name) => {
      if (!SHOTS) return;
      await mp.waitForTimeout(200);
      await mp.screenshot({ path: path.join(SHOTS, `${name}-m-${theme}.png`) });
    };
    await toPlan(mp, s2.url, async () => {
      await homeComposer(mp, `390 ${theme}`);
      await msnap("fx4-home");
    });
    const mbefore = await planMd(mp);
    await selectText(mp, "Shared shopping list");
    const mtb = mp.getByRole("toolbar", { name: "Selection" });
    await mtb.waitFor();
    if (one) check("mobile toolbar: one Comment item", (await mtb.getByRole("button").allTextContents()).join("|") === "Comment");
    await msnap("i3-toolbar");
    await mtb.getByRole("button", { name: "Comment" }).click();
    const sheet = mp.getByRole("dialog", { name: "New comment" });
    await sheet.getByRole("textbox").fill("Say who shares it");
    await msnap("i3-composer");
    if (one) {
      await mp.emulateMedia({ reducedMotion: "no-preference" });
      const sc = await motion(mp, ".cscrim");
      check("MF2: the mobile composer's scrim fades over 300ms", sc.dur === "0.3s" && sc.prop === "opacity", JSON.stringify(sc));
      await mp.emulateMedia({ reducedMotion: "reduce" });
    }
    await sheet.getByRole("button", { name: /^Comment/ }).click();
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /Comments/ }).click();
    const msheet = mp.getByRole("dialog", { name: "Comments" });
    await msheet.getByText(/^Good catch\./).waitFor({ timeout: 10000 });
    // The text streams in before the reply ends; the reply field and Apply come with its end (flaked under load).
    await msheet.locator(".th .reply").waitFor({ timeout: 10000 });
    await msheet.locator(".th .acts .apply").waitFor({ timeout: 10000 });
    await msnap("i3-thread");
    if (one) {
      // Fix-up of #4, MF4: 44px targets, a 16px reply field and a full-width Apply feedback in the thread sheet.
      const g = await mp.evaluate(() => {
        const th = document.querySelector(".csheet .th");
        const reply = th.querySelector(".reply");
        const apply = th.querySelector(".acts .apply");
        // Stop only shows while a reply runs, so measure one built from the same classes.
        const who = th.querySelector(".msg .who");
        const stop = document.createElement("button");
        stop.className = "btn stop";
        stop.textContent = "Stop";
        who.append(stop);
        const sh = stop.getBoundingClientRect().height;
        stop.remove();
        const cs = getComputedStyle(th);
        return { reply: reply.getBoundingClientRect().height, font: getComputedStyle(reply).fontSize, stop: sh, apply: apply.getBoundingClientRect().width, inner: th.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), crail: getComputedStyle(document.querySelector(".csheet .crail")).backgroundColor };
      });
      check("MF4: the mobile reply field is at least 44px at 16px (no iOS zoom)", g.reply >= 44 && g.font === "16px", JSON.stringify(g));
      check("MF4: Stop in the mobile message head is 44px", g.stop >= 44, JSON.stringify(g));
      check("MF4: Apply feedback is full width in the sheet", Math.abs(g.apply - g.inner) <= 1, JSON.stringify(g));
      check("MF3: the sheet's rail stays transparent (on the sheet)", g.crail === "rgba(0, 0, 0, 0)", g.crail);
      await mp.emulateMedia({ reducedMotion: "no-preference" });
      await pointer(mp);
      const sm = await motion(mp, ".csheet");
      check("MF2: the mobile sheet slides (300ms translate)", sm.dur === "0.3s" && sm.prop === "translate", JSON.stringify(sm));
      await mp.emulateMedia({ reducedMotion: "reduce" });
      const sr = await motion(mp, ".csheet");
      check("MF2 reduced motion: the mobile sheet only fades", sr.prop === "opacity" || !/translate|transform/.test(sr.prop), JSON.stringify(sr));
    }
    await msheet.getByRole("button", { name: "Apply feedback" }).click();
    await msheet.getByText(/suggestions? ready/).waitFor({ timeout: 10000 });
    await msheet.getByRole("button", { name: "Close comments" }).click();
    const mbar = mp.getByRole("toolbar", { name: "Review suggestions" });
    await mbar.waitFor();
    if (one) {
      const mb = await motion(mp, ".mbar");
      check("MF2 reduced motion: the mobile bar only fades (220ms)", !/translate|transform|scale/.test(mb.prop) && /0\.22s/.test(mb.dur), JSON.stringify(mb));
      const acc = mbar.getByRole("button", { name: /^Accept suggestion/ });
      check("mobile: Accept for the focused suggestion is blue (#30)", (await blues(mp)).length === 1 && (await acc.getAttribute("class")).includes("primary"), (await blues(mp)).join(" | "));
      check("mobile: Accept all is not on the bar (#30)", (await mbar.getByRole("button", { name: "Accept all" }).count()) === 0);
      await axe(mp, "mobile review bar");
    }
    await msnap("i3-review");
    await mbar.getByRole("button", { name: "More review actions" }).click();
    await mp.getByRole("menuitem", { name: "Accept all" }).waitFor();
    if (one) check("mobile: Accept all is in ⋯ (#30)", await mp.getByRole("menuitem", { name: "Accept all" }).isVisible());
    await msnap("i3-more");
    await mp.keyboard.press("Escape");
    await mbar.getByRole("button", { name: /^Accept suggestion/ }).click();
    await mp.waitForFunction(() => document.querySelectorAll("ins.sg").length === 1 || document.body.textContent.includes("1 of 1"));
    if (one) check("mobile Accept writes plan.md", (await planMd(mp)) !== mbefore);
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
