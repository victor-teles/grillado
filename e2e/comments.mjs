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
      if (!(await pg.locator(".seltb, .composer").count())) await pg.mouse.move(600, 880);
      await pg.waitForTimeout(200);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-d-${theme}.png`) });
    };
    await toPlan(pg, s.url);
    const before = await planMd(pg);
    const one = theme === "dark";
    if (one) await axe(pg, "plan, no comments yet");

    // Selection toolbar: Comment ⌘⌥M · Edit and nothing else (#27).
    await selectText(pg, "Shared shopping list");
    const tb = pg.getByRole("toolbar", { name: "Selection" });
    await tb.waitFor();
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
    await rail.getByText(/^Sure, that works too\./).waitFor({ timeout: 10000 });
    if (one) check("the agent answers the follow-up", true);
    await snap("i3-replied");

    // Apply feedback: the plan stays editable while it runs (no lock, no caret).
    await rail.getByRole("button", { name: "Apply feedback" }).click();
    await rail.getByText("Writing suggestions").waitFor();
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
    }
    await ctx.close();
    if (video) {
      const f = readdirSync(video.dir).find((x) => x.endsWith(".webm"));
      if (f) renameSync(path.join(video.dir, f), path.join(SHOTS, "i3-flow-d-dark.webm"));
    }
    await s.stop();

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
    await toPlan(mp, s2.url);
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
    await sheet.getByRole("button", { name: /^Comment/ }).click();
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /Comments/ }).click();
    const msheet = mp.getByRole("dialog", { name: "Comments" });
    await msheet.getByText(/^Good catch\./).waitFor({ timeout: 10000 });
    await msnap("i3-thread");
    await msheet.getByRole("button", { name: "Apply feedback" }).click();
    await msheet.getByText(/suggestions? ready/).waitFor({ timeout: 10000 });
    await msheet.getByRole("button", { name: "Close comments" }).click();
    const mbar = mp.getByRole("toolbar", { name: "Review suggestions" });
    await mbar.waitFor();
    if (one) {
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
