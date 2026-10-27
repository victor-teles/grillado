// v1.2 polish §2 (DECISIONS #98–101), the thread ⋯ menu: Copy link to comment and Delete, on open
// and resolved threads. Desktop: a role=menu popover (Uai DropdownMenu, no motion), keyboard per
// #98. Phone: a 44px ⋯ and an action sheet (scrim, swipe down, Back). Delete has no confirm: the
// thread, its anchor and its count go at once, "Comment deleted · Undo ⌘Z" for 5s (paused on
// hover), Undo brings it back in place and active; a running reply stops first. Copy link copies
// <origin>/s/<id>#comment-<thread>, and opening that link activates the thread, or says it was deleted.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/thread-menu.mjs            checks only (dark and light, desktop and phone)
//   SHOTS=dir node e2e/thread-menu.mjs  also writes d-menu, d-menu-kbd, d-copied, d-deleted, d-link,
//                                       d-link-gone, d-resolved-menu, d-resolved-toast, m-menu, m-deleted
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-tm-"));
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
async function axe(pg, name) {
  // Let fades settle first, so contrast is read at rest, not mid-transition.
  await pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 2000 }).catch(() => {});
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
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
const sid = (pg) => pg.evaluate(() => location.pathname.split("/").pop());
const sessionJson = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}`)).json());
/** The colour a CSS variable resolves to, as getComputedStyle reports colours. */
const tokenColour = (pg, v) =>
  pg.evaluate((v) => {
    const x = document.createElement("span");
    x.style.color = `var(${v})`;
    document.body.append(x);
    const c = getComputedStyle(x).color;
    x.remove();
    return c;
  }, v);
const tokenBg = (pg, v) =>
  pg.evaluate((v) => {
    const x = document.createElement("span");
    x.style.background = `var(${v})`;
    document.body.append(x);
    const c = getComputedStyle(x).backgroundColor;
    x.remove();
    return c;
  }, v);
/** The text of a decision bullet, before its cite (Implementation decisions). */
const bulletText = (pg, i = 0) =>
  pg.evaluate((i) => {
    const li = document.querySelectorAll("[data-testid=plan] li")[i];
    const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest("button, .sr-only") && n.data.trim().length >= 6) return n.data.trim().slice(0, 12).trim();
    return "";
  }, i);
const threadIds = (pg) => pg.evaluate(() => [...document.querySelectorAll(".crail .th[id^='th-']:not(.res)")].map((e) => e.dataset.thread));
const tabCount = (pg) => pg.evaluate(() => document.querySelector("#rtab-comments .c")?.textContent ?? "0");
const toastOf = (pg) =>
  pg.evaluate(() => {
    const t = document.querySelector(".toast");
    if (!t) return null;
    const svg = t.querySelector(":scope > svg");
    return {
      text: [...t.querySelectorAll(":scope > span, :scope > b, :scope > button, :scope > div")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") || t.textContent.replace(/\s+/g, " ").trim(),
      icon: svg ? [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join(" ") : "",
      iconColour: svg ? getComputedStyle(svg).color : "",
      undo: [...t.querySelectorAll("button")].map((b) => b.textContent.trim()),
      nt: t.classList.contains("nt"),
    };
  });
/** Focus moves two frames after the delete lands; wait up to 1s for it. */
const focusId = (pg, id) => pg.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 1000 }).then(() => true, () => false);
const TRASH = "M3 6h18";
const CHECK = "M20 6 9 17l-5-5";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    // ================================================================ desktop
    const s = await server({ FAKE_COMMENT_DELAY_MS: "1200" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference", permissions: ["clipboard-read", "clipboard-write"] });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const clear = () => pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open"))); // drops the toast from a step before
    const snap = async (name, keepToast = false) => {
      if (!SHOTS) return;
      if (!keepToast) await clear();
      await pg.waitForTimeout(260);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await pg.goto(s.url);
    await toPlan(pg);
    const rail = pg.getByRole("complementary", { name: "Comments" });
    const comment = async (quote, text) => {
      const before = (await threadIds(pg)).length;
      check(`${theme}: "${quote}" is in the plan`, await selectText(pg, quote));
      await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
      await pg.keyboard.press("Control+Alt+KeyM");
      await pg.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill(text);
      await pg.keyboard.press("Control+Enter");
      await pg.waitForFunction((n) => document.querySelectorAll(".crail .th[id^='th-']:not(.res)").length > n, before, { timeout: 8000 });
    };
    const b1 = await bulletText(pg, 0);
    const b2 = await bulletText(pg, 1);
    await comment("Shared shopping", "Say who shares it");
    await comment(b1, "Why this one?");
    await comment(b2, "And Android?");
    await pg.waitForFunction(() => document.querySelectorAll(".crail .th .msg").length >= 6, null, { timeout: 15000 });
    const [A, C, B] = await threadIds(pg);
    check(`${theme}: three threads in plan order (Problem, then two in Implementation decisions)`, !!(A && B && C) && (await tabCount(pg)) === "3", `${A} ${C} ${B}`);

    // ---------------------------------------------------------------- #98 the ⋯ button
    const thA = rail.locator(`#th-${A}`);
    const moreA = thA.getByRole("button", { name: "More actions for comment on “Problem”" });
    const btn = await moreA.evaluate((b) => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), pop: b.getAttribute("aria-haspopup"), exp: b.getAttribute("aria-expanded"), after: b.previousElementSibling?.textContent.trim() };
    });
    check(`${theme}: ⋯ is a 28px icon button right after Resolve, aria-haspopup=menu`, btn.w === 28 && btn.h === 28 && btn.pop === "menu" && btn.exp === "false" && btn.after === "Resolve", JSON.stringify(btn));

    // keyboard: Enter, Space and ↓ open on the first item; ↑/↓ move; Esc closes back onto ⋯
    const menu = pg.getByRole("menu", { name: "Comment actions" });
    const focused = () => pg.evaluate(() => document.activeElement?.textContent.trim() ?? "");
    /** Radix moves focus a tick after the key; wait up to 500ms for it to land. */
    const focusOn = (want) => pg.waitForFunction((w) => document.activeElement?.textContent.trim() === w, want, { timeout: 500 }).then(() => true, () => false);
    for (const key of ["Enter", " ", "ArrowDown"]) {
      await moreA.focus();
      await pg.keyboard.press(key === " " ? "Space" : key);
      await menu.waitFor();
      check(`${theme}: ${key === " " ? "Space" : key} opens the menu on its first item`, await focusOn("Copy link to comment"));
      if (key === "Enter") {
        await pg.keyboard.press("ArrowDown");
        check(`${theme}: ↓ moves to Delete`, await focusOn("Delete"), await focused());
        await pg.keyboard.press("ArrowUp");
        check(`${theme}: ↑ moves back to Copy link`, await focusOn("Copy link to comment"));
        const m = await menu.evaluate((el) => {
          const items = [...el.querySelectorAll("[role=menuitem]")];
          const cs = getComputedStyle(el);
          return {
            items: items.map((i) => i.textContent.trim()),
            sep: !!el.querySelector("[role=separator]") && el.querySelector("[role=separator]").getBoundingClientRect().height === 1,
            h: items.map((i) => Math.round(i.getBoundingClientRect().height)),
            w: Math.round(el.getBoundingClientRect().width),
            anim: el.getAnimations().length + (cs.animationName === "none" ? 0 : 1),
            icons: items.map((i) => (i.querySelector("svg path")?.getAttribute("d") ?? "").slice(0, 8)),
            del: getComputedStyle(items[1]).color,
          };
        });
        check(`${theme}: Copy link to comment, a divider, Delete; 34px rows, 200px wide`, m.items.join("|") === "Copy link to comment|Delete" && m.sep && m.h.every((h) => h === 34) && m.w === 200, JSON.stringify(m));
        check(`${theme}: the link and trash icons`, m.icons[0] === "M10 13a5" && m.icons[1].startsWith(TRASH), JSON.stringify(m.icons));
        check(`${theme}: Delete is --destructive-ink`, m.del === (await tokenColour(pg, "--destructive-ink")), m.del);
        check(`${theme}: it opens with no motion`, m.anim === 0, String(m.anim));
        const place = await pg.evaluate(() => {
          const b = document.activeElement.closest("[role=menu]").getBoundingClientRect();
          const t = document.querySelector("[aria-expanded=true][aria-haspopup=menu]").getBoundingClientRect();
          return { right: Math.round(b.right - t.right), below: Math.round(b.top - t.bottom) };
        });
        check(`${theme}: right-aligned under ⋯`, Math.abs(place.right) <= 1 && place.below >= 0 && place.below <= 8, JSON.stringify(place));
        await pg.evaluate(() => document.documentElement.setAttribute("data-kbd", ""));
        await snap("d-menu-kbd", true);
        await axe(pg, `${theme} desktop: thread menu open`);
      }
      await pg.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await moreA.evaluate((b) => new Promise((r) => { const t0 = Date.now(); const f = () => (b === document.activeElement || Date.now() - t0 > 500 ? r() : requestAnimationFrame(f)); f(); }));
      check(`${theme}: Esc closes it and focus is back on ⋯ (${key === " " ? "Space" : key})`, await moreA.evaluate((b) => b === document.activeElement));
    }

    // Tab closes the menu and goes on to the next stop after ⋯; Shift+Tab to the one before (APG menu button).
    for (const shift of [false, true]) {
      // Where a plain Tab goes from ⋯ with the menu shut: that is where Tab from the open menu must land.
      await moreA.focus();
      await pg.keyboard.press(shift ? "Shift+Tab" : "Tab");
      const want = await pg.evaluate(() => {
        const n = document.activeElement;
        n.dataset.tabWant = "1";
        return n.outerHTML.slice(0, 80);
      });
      await moreA.focus();
      await pg.keyboard.press("Enter");
      await menu.waitFor();
      await focusOn("Copy link to comment");
      // #124: the ⋯ keeps its grey fill while its menu is open (read after its fade settles).
      await moreA.evaluate((b) => Promise.all(b.getAnimations().map((a) => a.finished)));
      const fill = await moreA.evaluate((b) => ({ bg: getComputedStyle(b).backgroundColor, c: getComputedStyle(b).color }));
      if (!shift) check(`${theme}: ⋯ keeps the --muted fill and foreground ink while open (#124)`, fill.bg === (await tokenBg(pg, "--muted")) && fill.c === (await tokenColour(pg, "--foreground")), JSON.stringify(fill));
      await pg.keyboard.press(shift ? "Shift+Tab" : "Tab");
      await menu.waitFor({ state: "detached", timeout: 1000 }).catch(() => {});
      const landed = await pg.waitForFunction(() => document.activeElement?.dataset.tabWant === "1", null, { timeout: 1000 }).then(() => true, () => false);
      check(`${theme}: ${shift ? "Shift+Tab" : "Tab"} closes the menu and moves on from ⋯`, (await menu.count()) === 0 && landed, `${want} · ${await pg.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`);
      await pg.evaluate(() => document.querySelectorAll("[data-tab-want]").forEach((e) => delete e.dataset.tabWant));
    }

    // pointer: hovering Delete is the plain row tint, not a red fill (frame d-menu)
    await moreA.click();
    await menu.waitFor();
    const delItem = menu.getByRole("menuitem", { name: "Delete" });
    await delItem.hover();
    const hot = await delItem.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, c: getComputedStyle(e).color }));
    check(`${theme}: Delete's hover is the --accent row tint, text stays --destructive-ink`, hot.bg === (await tokenBg(pg, "--accent")) && hot.c === (await tokenColour(pg, "--destructive-ink")), JSON.stringify(hot));
    await snap("d-menu", true);

    // ---------------------------------------------------------------- #100 Copy link
    await menu.getByRole("menuitem", { name: "Copy link to comment" }).click();
    const copiedAt = Date.now();
    const id = await sid(pg);
    const origin = new URL(s.url).origin;
    const clip = await pg.evaluate(() => navigator.clipboard.readText());
    check(`${theme}: Copy link copies <origin>/s/<id>#comment-<thread>`, clip === `${origin}/s/${id}#comment-${A}`, clip);
    let t = await toastOf(pg);
    check(`${theme}: toast "Link to comment copied", a muted check, no Undo`, t?.text === "Link to comment copied" && t.icon.startsWith(CHECK) && t.undo.length === 0 && t.nt && t.iconColour === (await tokenColour(pg, "--muted-foreground")), JSON.stringify(t));
    check(`${theme}: focus goes back to ⋯ after Copy link`, await moreA.evaluate((b) => b === document.activeElement));
    await pg.mouse.move(700, 880);
    await snap("d-copied", true);
    await pg.waitForTimeout(Math.max(0, 1500 - (Date.now() - copiedAt)));
    check(`${theme}: the copied toast is still up at 1.5s`, !!(await toastOf(pg)));
    await pg.waitForTimeout(800);
    check(`${theme}: …and gone after 2s`, !(await toastOf(pg)));
    // axe with the toast up, held by the pointer so it can't time out mid-run
    await moreA.click();
    await menu.getByRole("menuitem", { name: "Copy link to comment" }).click();
    const cb = await pg.locator(".toast").boundingBox();
    await pg.mouse.move(cb.x + 10, cb.y + cb.height / 2);
    await axe(pg, `${theme} desktop: link copied`);
    await pg.mouse.move(700, 400);
    await clear();

    // ---------------------------------------------------------------- #99 Delete (the middle thread, C)
    const msgsC = await rail.locator(`#th-${C} .msg`).count();
    await rail.locator(`#th-${C}`).getByRole("button", { name: /^More actions/ }).click();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await pg.locator(`#th-${C}`).waitFor({ state: "detached", timeout: 3000 });
    await focusId(pg, `th-${B}`);
    const after = await pg.evaluate((C) => ({ mark: !!document.querySelector(`mark.cmk[data-thread="${C}"]`), focus: document.activeElement?.id, dialog: !!document.querySelector("[role=dialog]") }), C);
    check(`${theme}: no confirm; the thread, its anchor and its count go at once`, !after.mark && !after.dialog && (await tabCount(pg)) === "2" && (await threadIds(pg)).join() === [A, B].join(), JSON.stringify(after));
    check(`${theme}: focus goes to the next thread head`, after.focus === `th-${B}`, String(after.focus));
    t = await toastOf(pg);
    check(`${theme}: toast "Comment deleted · Undo Ctrl+Z", a muted trash icon`, /^Comment deleted Undo ?(Ctrl\+|⌘)Z$/.test(t?.text ?? "") && t.icon.startsWith(TRASH) && t.undo.length === 1 && t.nt, JSON.stringify(t));
    let disk = await sessionJson(pg);
    check(`${theme}: the server dropped the thread`, !disk.comments.some((x) => x.id === C), disk.comments.map((x) => x.id).join());

    // Undo ⌘Z: back in place, with its replies and anchor, and active
    await pg.keyboard.press("Control+z");
    await pg.locator(`#th-${C}`).waitFor({ timeout: 3000 });
    await pg.waitForTimeout(150);
    const back = await pg.evaluate((C) => ({ on: document.getElementById(`th-${C}`).classList.contains("on"), focus: document.activeElement?.id, mark: !!document.querySelector(`mark.cmk[data-thread="${C}"]`), toast: !!document.querySelector(".toast") }), C);
    check(`${theme}: ⌘Z restores it in place, active, anchor back`, (await threadIds(pg)).join() === [A, C, B].join() && back.on && back.focus === `th-${C}` && back.mark && !back.toast, JSON.stringify(back));
    check(`${theme}: …with its replies`, (await rail.locator(`#th-${C} .msg`).count()) === msgsC && (await tabCount(pg)) === "3");

    // the Undo button does the same; the toast waits while hovered
    await rail.locator(`#th-${C}`).getByRole("button", { name: /^More actions/ }).click();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await pg.locator(`#th-${C}`).waitFor({ state: "detached", timeout: 3000 });
    const box = await pg.locator(".toast").boundingBox();
    await pg.mouse.move(box.x + 20, box.y + box.height / 2);
    await pg.waitForTimeout(5600);
    check(`${theme}: the deleted toast is still up after 5.6s while hovered`, (await toastOf(pg))?.text.startsWith("Comment deleted"));
    // shot and axe here, while the hover holds the toast (a slow box can't time it out first)
    await snap("d-deleted", true);
    await axe(pg, `${theme} desktop: comment deleted`);
    check(`${theme}: …and still up after the shot and axe`, (await toastOf(pg))?.text.startsWith("Comment deleted"));
    await pg.mouse.move(700, 400);
    await pg.waitForTimeout(1500);
    check(`${theme}: …and keeps its time left after the pointer leaves`, (await toastOf(pg))?.text.startsWith("Comment deleted"));
    await pg.locator(".toast").getByRole("button", { name: /^Undo/ }).click();
    await pg.locator(`#th-${C}`).waitFor({ timeout: 3000 });
    check(`${theme}: Undo restores it in place`, (await threadIds(pg)).join() === [A, C, B].join());
    // unhovered, it leaves after 5s
    await rail.locator(`#th-${C}`).getByRole("button", { name: /^More actions/ }).click();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await pg.mouse.move(700, 400);
    await pg.waitForTimeout(4600);
    check(`${theme}: the deleted toast is up at 4.6s`, !!(await toastOf(pg)));
    await pg.waitForTimeout(700);
    check(`${theme}: …and gone after 5s; the thread stays deleted`, !(await toastOf(pg)) && !(await threadIds(pg)).includes(C));

    // a reload (the store re-reads the session file) doesn't bring it back
    await pg.reload();
    await rail.waitFor();
    await pg.waitForFunction(() => document.querySelectorAll(".crail .th[id^='th-']").length >= 2, null, { timeout: 8000 });
    check(`${theme}: after a reload it is still gone`, (await threadIds(pg)).join() === [A, B].join());

    // ---------------------------------------------------------------- #99 Delete stops a running reply
    const thB = rail.locator(`#th-${B}`);
    await thB.getByRole("textbox").fill("And iOS?");
    await thB.getByRole("textbox").press("Enter");
    await pg.waitForFunction(async (B) => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}`)).json()).comments.find((x) => x.id === B)?.run?.state === "running", B, { timeout: 4000 });
    const msgsB = (await sessionJson(pg)).comments.find((x) => x.id === B).messages.length;
    await thB.getByRole("button", { name: /^More actions/ }).click();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await pg.locator(`#th-${B}`).waitFor({ state: "detached", timeout: 3000 });
    check(`${theme}: deleting the last open thread moves focus to the one left`, await focusId(pg, `th-${A}`));
    await pg.waitForTimeout(1600); // past the fake agent's reply time
    await pg.keyboard.press("Control+z");
    await pg.locator(`#th-${B}`).waitFor({ timeout: 3000 });
    disk = await sessionJson(pg);
    const rb = disk.comments.find((x) => x.id === B);
    check(`${theme}: the running reply was stopped first: no reply landed, and it reads stopped after Undo`, rb.messages.length === msgsB && rb.run?.state === "stopped", JSON.stringify(rb.run));

    // ---------------------------------------------------------------- #101 Resolve's toast, and ⋯ on resolved threads
    await thA.getByRole("button", { name: "Resolve" }).first().click();
    await pg.locator(`#th-${A}:not(.res)`).waitFor({ state: "detached", timeout: 3000 });
    t = await toastOf(pg);
    check(`${theme}: Resolve shows "Comment resolved · Undo"`, t?.text === "Comment resolved Undo" && t.undo.length === 1 && t.nt, JSON.stringify(t));
    await snap("d-resolved-toast", true);
    await pg.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await pg.locator(`#th-${A}:not(.res)`).waitFor({ timeout: 3000 });
    check(`${theme}: its Undo reopens the thread, active`, await pg.evaluate((A) => document.getElementById(`th-${A}`).classList.contains("on"), A));
    await thA.getByRole("button", { name: "Resolve" }).first().click();
    await clear();
    await rail.getByRole("button", { name: /^Resolved 1/ }).click();
    const res = rail.locator(`.th.res[data-thread="${A}"]`);
    const rmore = res.getByRole("button", { name: "More actions for comment on “Problem”" });
    check(`${theme}: a resolved thread keeps Reopen and gains the same ⋯`, (await res.getByRole("button", { name: "Reopen" }).isVisible()) && (await rmore.isVisible()) && (await rmore.getAttribute("aria-haspopup")) === "menu");
    await rmore.click();
    await menu.waitFor();
    await snap("d-resolved-menu", true);
    await axe(pg, `${theme} desktop: resolved thread menu`);
    await menu.getByRole("menuitem", { name: "Copy link to comment" }).click();
    const rlink = await pg.evaluate(() => navigator.clipboard.readText());
    check(`${theme}: Copy link on a resolved thread`, rlink === `${origin}/s/${id}#comment-${A}`, rlink);

    // ---------------------------------------------------------------- #100 opening a link
    const link = await ctx.newPage();
    await link.setViewportSize({ width: 1440, height: 420 });
    await link.emulateMedia({ reducedMotion: "reduce" });
    await link.goto(`${origin}/s/${id}#comment-${B}`);
    const lrail = link.getByRole("complementary", { name: "Comments" });
    await lrail.waitFor({ timeout: 8000 });
    await link.waitForFunction((B) => document.activeElement?.id === `th-${B}`, B, { timeout: 5000 });
    const lk = await link.evaluate((B) => {
      const m = document.querySelector(`mark.cmk[data-thread="${B}"]`).getBoundingClientRect();
      const w = document.querySelector(".docwrap").getBoundingClientRect();
      return { tab: document.querySelector("#rtab-comments").getAttribute("aria-selected"), on: document.getElementById(`th-${B}`).classList.contains("on"), inView: m.top >= w.top && m.bottom <= w.bottom, top: document.querySelector(".docwrap").scrollTop };
    }, B);
    check(`${theme}: a comment link opens the rail on Comments with the thread active`, lk.tab === "true" && lk.on, JSON.stringify(lk));
    check(`${theme}: …and its anchor scrolled into view at once (reduced motion: no smooth scroll)`, lk.inView && lk.top > 0, JSON.stringify(lk));
    if (SHOTS) {
      await link.waitForTimeout(260);
      await link.screenshot({ path: path.join(SHOTS, `d-link-${theme}.png`) });
    }
    await link.goto(`${origin}/s/${id}#comment-${C}`);
    await lrail.waitFor({ timeout: 8000 });
    await link.getByTestId("comment-gone").waitFor({ timeout: 5000 });
    check(`${theme}: a link to a deleted comment opens the rail with "That comment was deleted"`, (await link.getByTestId("comment-gone").textContent()) === "That comment was deleted");
    if (SHOTS) {
      await link.waitForTimeout(260);
      await link.screenshot({ path: path.join(SHOTS, `d-link-gone-${theme}.png`) });
    }
    await axe(link, `${theme} desktop: link to a deleted comment`);
    // A link to a resolved thread opens the Resolved accordion on it.
    await link.goto(`${origin}/s/${id}#comment-${A}`);
    await link.waitForFunction((A) => document.activeElement?.id === `th-${A}`, A, { timeout: 5000 });
    check(`${theme}: a link to a resolved comment opens Resolved on it`, (await link.locator(".racc").getAttribute("aria-expanded")) === "true");
    await link.close();

    // Delete from the resolved accordion
    await rail.locator(`.th.res[data-thread="${A}"]`).getByRole("button", { name: /^More actions/ }).click();
    await menu.getByRole("menuitem", { name: "Delete" }).click();
    await pg.locator(`.th.res[data-thread="${A}"]`).waitFor({ state: "detached", timeout: 3000 });
    check(`${theme}: Delete on a resolved thread removes it and the accordion`, (await rail.locator(".racc").count()) === 0 && /^Comment deleted/.test((await toastOf(pg))?.text ?? ""));
    await pg.keyboard.press("Control+z");
    await pg.locator(`.th.res[data-thread="${A}"]`).waitFor({ timeout: 3000 });
    check(`${theme}: …and Undo brings it back under Resolved, focused`, await focusId(pg, `th-${A}`));
    await ctx.close();
    await s.stop();

    // ================================================================ phone
    const s2 = await server({ FAKE_COMMENT_DELAY_MS: "300" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference", permissions: ["clipboard-read", "clipboard-write"] });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    const msnap = async (name, keepToast = false) => {
      if (!SHOTS) return;
      if (!keepToast) await mp.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await mp.waitForTimeout(260);
      await mp.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await mp.goto(s2.url);
    await toPlan(mp);
    const mcomment = async (quote, text) => {
      await selectText(mp, quote);
      const mtb = mp.getByRole("toolbar", { name: "Selection" });
      await mtb.waitFor();
      await mtb.getByRole("button", { name: "Comment" }).click();
      const d = mp.getByRole("dialog", { name: "New comment" });
      await d.getByRole("textbox").fill(text);
      await d.getByRole("button", { name: /^Comment/ }).click();
      await d.waitFor({ state: "detached" });
    };
    await mcomment("Shared shopping", "Say who shares it");
    await mcomment(await bulletText(mp), "And Android?");
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /Comments/ }).click();
    const msheet = mp.getByRole("dialog", { name: "Comments" });
    await mp.waitForFunction(() => document.querySelectorAll(".csheet .th .msg").length >= 4, null, { timeout: 15000 });
    const [MA, MB] = await threadIds(mp);
    const mmore = msheet.locator(`#th-${MA}`).getByRole("button", { name: "More actions for comment on “Problem”" });
    const mb = await mmore.evaluate((b) => ({ w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), pop: b.getAttribute("aria-haspopup") }));
    check(`${theme} phone: ⋯ is a 44px target`, mb.w === 44 && mb.h === 44, JSON.stringify(mb));
    await mmore.click();
    const act = mp.getByRole("dialog", { name: "Comment on “Problem”" });
    await act.waitFor();
    const as = await act.evaluate((el) => {
      const rows = [...el.querySelectorAll("button")];
      return {
        modal: el.getAttribute("aria-modal"),
        rows: rows.map((r) => r.textContent.trim()),
        h: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
        fs: rows.map((r) => getComputedStyle(r).fontSize),
        svg: rows.map((r) => Math.round(r.querySelector("svg").getBoundingClientRect().width)),
        del: getComputedStyle(rows[1]).color,
        focus: document.activeElement === rows[0],
        fade: getComputedStyle(el).transitionDuration.split(",")[0].trim() + " " + getComputedStyle(el).transitionProperty,
        bottom: Math.round(innerHeight - el.getBoundingClientRect().bottom),
        scrim: !!document.querySelector(".pscrim"),
      };
    });
    check(`${theme} phone: an action sheet, aria-modal, titled Comment on “Problem”`, as.modal === "true" && as.scrim && as.bottom === 0, JSON.stringify(as));
    check(`${theme} phone: 48px rows, Copy link then Delete, no Cancel; 16px text, 20px icons`, as.rows.join("|") === "Copy link to comment|Delete" && as.h.every((h) => h === 48) && as.fs.every((f) => f === "16px") && as.svg.every((w) => w === 20), JSON.stringify(as));
    check(`${theme} phone: Delete is --destructive-ink; focus starts on the first row`, as.del === (await tokenColour(mp, "--destructive-ink")) && as.focus, JSON.stringify(as));
    check(`${theme} phone: it fades in over 160ms`, as.fade.startsWith("0.16s") && as.fade.includes("opacity"), as.fade);
    await msnap("m-menu"); // as tapped open, before any Tab draws a ring
    await axe(mp, `${theme} phone: action sheet`);
    await mp.keyboard.press("Tab");
    await mp.keyboard.press("Tab");
    check(`${theme} phone: focus is trapped in the sheet`, await act.evaluate((el) => el.contains(document.activeElement) && document.activeElement === el.querySelector("button")));
    // the scrim closes it
    await mp.locator(".pscrim").click({ position: { x: 20, y: 20 } });
    await act.waitFor({ state: "detached" });
    check(`${theme} phone: tapping the scrim closes it, focus back on ⋯`, await mmore.evaluate((b) => b === document.activeElement));
    // Back closes it, and stays on the plan with Comments open
    const url0 = mp.url();
    await mmore.click();
    await act.waitFor();
    await mp.goBack();
    await act.waitFor({ state: "detached" });
    check(`${theme} phone: Back closes it and stays on the plan`, mp.url() === url0 && (await msheet.isVisible()), mp.url());
    // swipe down closes it
    await mmore.click();
    await act.waitFor();
    const gb = await act.locator(".grab").boundingBox();
    await mp.mouse.move(gb.x + 18, gb.y + 2);
    await mp.mouse.down();
    await mp.mouse.move(gb.x + 18, gb.y + 40, { steps: 3 });
    await mp.mouse.move(gb.x + 18, gb.y + 110, { steps: 3 });
    await mp.mouse.up();
    await act.waitFor({ state: "detached" });
    check(`${theme} phone: a swipe down closes it`, !(await act.count()));
    check(`${theme} phone: closing it left no extra history entry`, (await mp.evaluate(() => history.state?.grilladoSheet)) !== true);
    // Copy link
    await mmore.click();
    await act.getByRole("button", { name: "Copy link to comment" }).click();
    await act.waitFor({ state: "detached" });
    const mclip = await mp.evaluate(() => navigator.clipboard.readText());
    check(`${theme} phone: Copy link copies the comment's link, with its toast`, mclip === `${new URL(s2.url).origin}/s/${await sid(mp)}#comment-${MA}` && (await toastOf(mp))?.text === "Link to comment copied", mclip);
    // Delete, then Undo
    await mmore.click();
    await act.getByRole("button", { name: "Delete" }).click();
    await mp.locator(`#th-${MA}`).waitFor({ state: "detached", timeout: 3000 });
    t = await toastOf(mp);
    check(`${theme} phone: Delete removes it at once, with the Undo toast (no shortcut hint on a phone); focus on the next thread`, t?.text === "Comment deleted Undo" && (await focusId(mp, `th-${MB}`)), JSON.stringify(t));
    const mtb = await mp.locator(".toast").boundingBox();
    await mp.mouse.move(mtb.x + 10, mtb.y + mtb.height / 2); // holds it through the shot and axe
    await msnap("m-deleted", true);
    await axe(mp, `${theme} phone: comment deleted`);
    await mp.locator(".toast").getByRole("button", { name: /^Undo/ }).click();
    await mp.locator(`#th-${MA}`).waitFor({ timeout: 3000 });
    check(`${theme} phone: Undo brings it back in place`, (await threadIds(mp)).join() === [MA, MB].join());
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
