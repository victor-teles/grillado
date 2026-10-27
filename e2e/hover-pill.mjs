// v1.1 polish #103, Accept/Reject on hover: a precise pointer resting 120ms on a suggestion that
// isn't focused gets a compact floating "✓ Accept · Reject" (no i/n, no keys), 6px after the
// insertion's last line or 4px below it, that never reflows the text, hides 160ms after the pointer
// leaves it and the suggestion, and runs the #102 sequence; nothing on the focused suggestion, on
// phones or for the keyboard. Also: a click on a suggestion inside a comment's anchor focuses it.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/hover-pill.mjs                 checks only (dark and light, desktop and phone)
//   SHOTS=dir node e2e/hover-pill.mjs       also writes d-hover, d-hoverf and d-hover-below to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-hp-"));
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


/** The hover pill and the geometry the placement rule is about, for suggestion `id`. */
const hp = (pg, id) =>
  pg.evaluate((id) => {
    const wrap = document.querySelector(".docwrap");
    const doc = document.querySelector(".doc");
    const pill = document.querySelector(".ipill.hp");
    const end = [...document.querySelectorAll(`ins.sg[data-sg="${id}"]`)].pop() ?? [...document.querySelectorAll(`del.sg[data-sg="${id}"]`)].pop();
    const last = end && [...end.getClientRects()].filter((r) => r.width > 0).pop();
    const d = doc.getBoundingClientRect();
    const col = d.right - parseFloat(getComputedStyle(doc).paddingRight);
    const er = end && end.getBoundingClientRect();
    const out = { lay: er && `${doc.scrollHeight}:${er.top}:${er.left}:${er.width}`, col, last: last && { right: last.right, top: last.top, bottom: last.bottom, mid: (last.top + last.bottom) / 2 }, n: document.querySelectorAll(".ipill.hp").length };
    if (end) out.hov = end.classList.contains("hov");
    if (end) out.tint = getComputedStyle(end).backgroundColor;
    if (!pill) return out;
    const p = pill.getBoundingClientRect();
    return {
      ...out,
      for: pill.dataset.hp,
      left: p.left,
      right: p.right,
      top: p.top,
      bottom: p.bottom,
      w: p.width,
      mid: (p.top + p.bottom) / 2,
      pos: getComputedStyle(pill).position,
      parent: pill.parentElement === wrap,
      hidden: pill.getAttribute("aria-hidden"),
      tabs: [...pill.querySelectorAll("button")].map((b) => b.tabIndex),
      text: [...pill.querySelectorAll("button")].map((b) => b.textContent.trim()),
      extras: pill.querySelectorAll(".ix, .kb").length,
      op: +getComputedStyle(pill).opacity,
      dur: getComputedStyle(pill).transitionDuration,
    };
  }, id);
/** The middle of the last line of a suggestion (its insertion, else its deletion). */
const spot = (pg, id) =>
  pg.evaluate((id) => {
    const end = [...document.querySelectorAll(`ins.sg[data-sg="${id}"]`)].pop() ?? [...document.querySelectorAll(`del.sg[data-sg="${id}"]`)].pop();
    const r = [...end.getClientRects()].filter((x) => x.width > 0).pop();
    return { x: r.left + Math.min(r.width / 2, 40), y: (r.top + r.bottom) / 2 };
  }, id);
const plainSpot = (pg) =>
  pg.evaluate(() => {
    const h = [...document.querySelectorAll("[data-testid=plan] h2")].find((e) => /Implementation/.test(e.textContent));
    const r = h.getBoundingClientRect();
    return { x: r.left + 20, y: (r.top + r.bottom) / 2 };
  });

/** From the start screen to a plan with a comment on "Shared shopping list" and its two suggestions. */
async function toSuggestions(pg, beforeApply) {
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
  if (beforeApply) await beforeApply();
  await selectText(pg, "Shared shopping list");
  await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
  await pg.keyboard.press("Control+Alt+KeyM");
  const composer = pg.getByRole("dialog", { name: "New comment" });
  await composer.getByRole("textbox").fill("Say who shares it");
  await pg.keyboard.press("Control+Enter");
  const rail = pg.getByRole("complementary", { name: "Comments" });
  await rail.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
  await rail.getByRole("button", { name: "Apply feedback" }).click();
  await rail.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
  await pg.getByRole("toolbar", { name: "Review suggestions" }).waitFor();
  await pg.waitForTimeout(400); // the landing fade
  return pg.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
}
const focusedId = (pg) => pg.evaluate(() => document.querySelector("ins.sg.f, del.sg.f")?.getAttribute("data-sg") ?? null);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    // ---------------------------------------------------------------- desktop, a precise pointer
    const s = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    await holdTransitions(pg);
    await pg.clock.install();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open"))); // no toast from a step before
      await step(pg);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await pg.goto(s.url);
    const ids = await toSuggestions(pg);
    const [A, B] = ids;
    const before = await planMd(pg);
    check(`${theme}: two suggestions, nothing focused yet`, ids.length === 2 && (await focusedId(pg)) === null, `${ids} ${await focusedId(pg)}`);
    await pg.evaluate(() => window.__release()); // the landing fade, done
    const rest = (await hp(pg, B)).tint;
    const pause = async () => pg.clock.pauseAt((await pg.evaluate(() => Date.now())) + 1000);
    const resume = async () => {
      await pg.evaluate(() => window.__release());
      await pg.clock.resume();
    };
    const moveTo = async (p) => pg.mouse.move(p.x, p.y, { steps: 4 });
    const hpBtn = (name) => pg.locator(".ipill.hp").getByRole("button", { name: new RegExp(`^${name}`), includeHidden: true });

    // ---- 120ms of intent, then a 120ms fade-in; floating, no layout space
    const lay0 = (await hp(pg, B)).lay;
    await pause();
    await moveTo(await spot(pg, B));
    await pg.clock.runFor(119);
    check(`${theme}: no pill before 120ms of hover`, (await hp(pg, B)).n === 0);
    await pg.clock.runFor(1);
    await step(pg);
    let h = await hp(pg, B);
    check(`${theme} 120ms: the hover pill shows for the hovered suggestion`, h.n === 1 && h.for === B, JSON.stringify(h));
    // @starting-style fades it in from 0: the transition exists as soon as the pill does.
    const fading = await pg.evaluate(() => document.querySelector(".ipill.hp").getAnimations().some((a) => a.transitionProperty === "opacity" && a.effect.getTiming().duration === 120 && a.effect.getKeyframes()[0]?.opacity === "0"));
    check(`${theme} 120ms: it fades in over 120ms`, h.dur === "0.12s" && fading, JSON.stringify({ op: h.op, dur: h.dur, fading }));
    check(`${theme}: "✓ Accept · Reject", no i/n and no key hints`, h.text?.join("|") === "Accept|Reject" && h.extras === 0, JSON.stringify(h.text));
    check(`${theme}: aria-hidden, and its buttons are no Tab stops`, h.hidden === "true" && h.tabs.every((t) => t === -1), JSON.stringify(h));
    check(`${theme}: absolute in .docwrap, takes no layout space`, h.pos === "absolute" && h.parent && h.lay === lay0, JSON.stringify(h));
    const fits = h.last.right + 6 + h.w <= h.col;
    check(`${theme}: it sits 6px right of the insertion's last line, centred on it`, fits && Math.abs(h.left - (h.last.right + 6)) <= 1 && Math.abs(h.mid - h.last.mid) <= 2, JSON.stringify(h));
    check(`${theme}: the hovered insertion's tint goes up`, h.hov && h.tint !== rest, `${h.tint} vs ${rest}`);
    // Step the fade by hand (the paused clock holds the frame): partway at 60ms, then finished.
    const mid = await pg.evaluate(() => {
      const a = document.querySelector(".ipill.hp").getAnimations().find((x) => x.transitionProperty === "opacity");
      a.pause();
      a.currentTime = 60;
      const op = +getComputedStyle(document.querySelector(".ipill.hp")).opacity;
      a.finish();
      return op;
    });
    check(`${theme}: mid-fade at 60ms, then fully in`, mid > 0 && mid < 1 && (await hp(pg, B)).op === 1, String(mid));
    await snap("d-hover");

    // ---- moving onto the pill keeps it; leaving both hides it 160ms later
    const acc = await hpBtn("Accept").boundingBox();
    await pg.mouse.move(acc.x + acc.width / 2, acc.y + acc.height / 2, { steps: 4 });
    await pg.clock.runFor(600);
    check(`${theme}: moving onto the pill keeps it`, (await hp(pg, B)).n === 1);
    // Designer's nice-to-have on #14: the compact pill's muted Reject turns --foreground on hover.
    const rjBox = await hpBtn("Reject").boundingBox();
    const rjColour = () =>
      pg.evaluate(() => {
        const b = document.querySelector(".ipill.hp .btn.rj");
        for (const a of b.getAnimations()) a.finish();
        const probe = (v) => {
          const x = document.createElement("span");
          x.style.color = `var(${v})`;
          document.body.append(x);
          const c = getComputedStyle(x).color;
          x.remove();
          return c;
        };
        return { c: getComputedStyle(b).color, fg: probe("--foreground"), muted: probe("--muted-foreground") };
      });
    const rjRest = await rjColour();
    await pg.mouse.move(rjBox.x + rjBox.width / 2, rjBox.y + rjBox.height / 2, { steps: 2 });
    await pg.clock.runFor(50);
    const rjHot = await rjColour();
    check(`${theme}: the pill's Reject is muted, and --foreground while hovered`, rjRest.c === rjRest.muted && rjHot.c === rjHot.fg && rjHot.fg !== rjHot.muted, JSON.stringify({ rjRest, rjHot }));
    await snap("d-hover-reject");
    await pg.mouse.move(acc.x + acc.width / 2, acc.y + acc.height / 2, { steps: 2 });
    await pg.clock.runFor(50);
    await moveTo(await plainSpot(pg));
    await pg.clock.runFor(159);
    check(`${theme}: still there 159ms after leaving`, (await hp(pg, B)).n === 1);
    await pg.clock.runFor(1);
    h = await hp(pg, B);
    check(`${theme}: gone 160ms after leaving, the tint back to rest`, h.n === 0 && !h.hov && h.tint === rest, JSON.stringify(h));
    // A quick pass across the gap and back doesn't hide it.
    await moveTo(await spot(pg, B));
    await pg.clock.runFor(120);
    await moveTo(await plainSpot(pg));
    await pg.clock.runFor(100);
    await moveTo(await spot(pg, B));
    await pg.clock.runFor(300);
    check(`${theme}: back within 160ms, the pill stays`, (await hp(pg, B)).n === 1);
    // Leaving the plan altogether.
    await pg.mouse.move(1300, 600, { steps: 4 });
    await pg.clock.runFor(160);
    check(`${theme}: leaving the plan hides it after 160ms`, (await hp(pg, B)).n === 0);

    // ---- the focused suggestion: hover adds nothing; its own pill carries the key hints
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && (await focusedId(pg)) !== B; i++) await pg.keyboard.press("Alt+ArrowDown");
    await pointer(pg);
    await moveTo(await spot(pg, B));
    await pg.clock.runFor(400);
    const kb = await pg.evaluate(() => [...document.querySelectorAll(".ipill:not(.hp) .kb")].map((e) => e.textContent));
    check(`${theme}: hovering the focused suggestion adds nothing`, (await hp(pg, B)).n === 0 && (await pg.locator(".ipill:not(.hp)").count()) === 1);
    check(`${theme}: the focused pill shows its keys (⌘↵, ⌘⌫)`, kb.length === 2 && /(⌘↵|Ctrl\+Enter)/.test(kb[0]) && /(⌘⌫|Ctrl\+Backspace)/.test(kb[1]), JSON.stringify(kb));

    // ---- d-hoverf: A focused (full pill), B hovered (compact pill)
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && (await focusedId(pg)) !== A; i++) await pg.keyboard.press("Alt+ArrowDown");
    await pointer(pg);
    await moveTo(await spot(pg, B));
    await pg.clock.runFor(240);
    h = await hp(pg, B);
    check(`${theme}: with A focused, B's hover pill shows next to A's full pill`, h.n === 1 && h.for === B && (await focusedId(pg)) === A && (await pg.locator(".ipill:not(.hp)").count()) === 1, JSON.stringify(h));
    await snap("d-hoverf");

    // ---- clicking Accept on the hover pill: the §3 sequence for B, then focus to the next (A)
    await hpBtn("Accept").click();
    await step(pg);
    check(`${theme}: Accept on the hover pill acts on the hovered suggestion`, (await hp(pg, B)).n === 0 && (await pg.locator(`ins.sg.ok[data-sg="${B}"]`).count()) === 0 && /Accepted · /.test(await pg.locator(".review").textContent()));
    await pg.clock.runFor(120);
    await step(pg);
    check(`${theme}: …the held accept plays (green fading, ✓ Accepted), focus on the next`, (await pg.locator(`ins.sg.ok[data-sg="${B}"]`).count()) >= 1 && (await pg.locator(".okm").count()) === 1 && (await focusedId(pg)) === A);
    await pg.clock.runFor(220);
    await pg.waitForFunction(async () => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text()).includes("shipped first"), null, { timeout: 5000 }).catch(() => {});
    check(`${theme}: …and writes plan.md at 340ms`, (await planMd(pg)).includes("shipped first"));
    await resume();
    await pg.locator(".okm").waitFor({ state: "detached", timeout: 4000 });
    await pg.keyboard.press("Control+z");
    await pg.locator(`ins.sg[data-sg="${B}"]`).waitFor({ timeout: 5000 });
    check(`${theme}: ⌘Z puts it back`, (await planMd(pg)) === before);

    // ---- Reject on the hover pill (A, nothing else focused on it)
    await pause();
    await pg.mouse.move(1300, 600);
    await pg.clock.runFor(200);
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && (await focusedId(pg)) !== B; i++) await pg.keyboard.press("Alt+ArrowDown");
    await pointer(pg);
    await moveTo(await spot(pg, A));
    await pg.clock.runFor(120);
    await hpBtn("Reject").click();
    await step(pg);
    check(`${theme}: Reject on the hover pill fades A's insertion, no mark`, (await pg.locator(`ins.sg.out[data-sg="${A}"]`).count()) >= 1 && (await pg.locator(".okm").count()) === 0 && /Rejected · /.test(await pg.locator(".review").textContent()));
    await pg.clock.runFor(200);
    await resume();
    await pg.waitForFunction((A) => !document.querySelector(`[data-sg="${A}"]`), A, { timeout: 5000 });
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });
    check(`${theme}: reject then ⌘Z leaves plan.md alone`, (await planMd(pg)) === before);

    // ---- a click on a suggestion inside a comment's anchor focuses the suggestion (item 3 §4.2)
    await pg.mouse.move(1300, 600);
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && (await focusedId(pg)) !== B; i++) await pg.keyboard.press("Alt+ArrowDown");
    const inAnchor = await pg.evaluate((A) => !!document.querySelector(`mark.cmk [data-sg="${A}"]`), A);
    const sp = await spot(pg, A);
    await pg.mouse.click(sp.x, sp.y);
    await until(pg, (A) => !!document.querySelector(`.f[data-sg="${A}"]`), A, "click focuses A").catch(() => {});
    const after = await pg.evaluate(() => ({ f: document.querySelector("ins.sg.f, del.sg.f")?.getAttribute("data-sg"), ae: document.activeElement?.getAttribute("data-sg") ?? document.activeElement?.id ?? document.activeElement?.tagName }));
    check(`${theme}: clicking a suggestion inside a comment's anchor focuses it, not the thread`, inAnchor && after.f === A && after.ae === A, JSON.stringify({ inAnchor, ...after }));
    // The thread is still a click away in the rail, and Enter on the anchor opens it.
    await pg.keyboard.press("Escape");

    // ---- axe with the hover pill up (real time: axe needs running timers)
    await pg.mouse.move(1300, 600);
    await pg.locator("[data-testid=plan]").focus();
    for (let i = 0; i < 4 && (await focusedId(pg)) !== A; i++) await pg.keyboard.press("Alt+ArrowDown");
    await pointer(pg);
    await moveTo(await spot(pg, B));
    await pg.locator(".ipill.hp.in").waitFor({ timeout: 2000 });
    await pg.waitForFunction(() => getComputedStyle(document.querySelector(".ipill.hp")).opacity === "1", null, { timeout: 2000 }).catch(() => {});
    check(`${theme}: in real time the pill fades fully in`, (await hp(pg, B)).op === 1);
    await axe(pg, `${theme} desktop, hover pill up`);
    await ctx.close();
    await s.stop();

    // ---------------------------------------------------------------- no room at the line end: below it
    const f2 = path.join(mkdtempSync(path.join(WORK, "e2-")), "after2.txt");
    const s3 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300", FAKE_EDIT2_FILE: f2 });
    const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx3.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const p3 = await ctx3.newPage();
    await holdTransitions(p3);
    await p3.goto(s3.url);
    // Fill "Yes, one core flow" out to just short of the column's edge, so the pill can't fit after it.
    const ids3 = await toSuggestions(p3, async () => {
      const text = await p3.evaluate(() => {
        const doc = document.querySelector(".doc");
        const col = doc.getBoundingClientRect().right - parseFloat(getComputedStyle(doc).paddingRight);
        const w = document.createTreeWalker(document.querySelector("[data-testid=plan]"), NodeFilter.SHOW_TEXT);
        let n = w.nextNode();
        while (n && !n.data.includes("Yes, one core flow")) n = w.nextNode();
        const span = document.createElement("span");
        n.parentNode.insertBefore(span, n.nextSibling);
        const words = "shipped first so everyone at home can try it on their own phones this week and tell us what is missing before we add the rest".split(" ");
        let best = { gap: Infinity, text: "" };
        for (let i = 1; i <= words.length; i++) {
          span.textContent = `, ${words.slice(0, i).join(" ")}`;
          const r = [...span.getClientRects()].filter((x) => x.width > 0).pop();
          if (col - r.right < best.gap) best = { gap: col - r.right, text: span.textContent };
        }
        span.remove();
        return best;
      });
      check(`${theme}: the long insertion ends ${Math.round(text.gap)}px short of the column (less than the pill needs)`, text.gap < 120, JSON.stringify(text));
      writeFileSync(f2, `Yes, one core flow${text.text}`);
    });
    const B3 = ids3[1];
    await p3.mouse.move(1300, 600);
    await p3.evaluate(() => window.__release());
    const lay3 = (await hp(p3, B3)).lay;
    const sp3 = await spot(p3, B3);
    await p3.mouse.move(sp3.x, sp3.y, { steps: 4 });
    await p3.locator(".ipill.hp.in").waitFor({ timeout: 2000 });
    await p3.evaluate(() => window.__release());
    h = await hp(p3, B3);
    check(`${theme}: no room after the line → 4px below it, right-aligned to its end`, h.n === 1 && h.last.right + 6 + h.w > h.col && Math.abs(h.top - (h.last.bottom + 4)) <= 1 && Math.abs(h.right - h.last.right) <= 1 && h.lay === lay3, JSON.stringify(h));
    if (SHOTS) {
      await p3.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await p3.screenshot({ path: path.join(SHOTS, `d-hover-below-${theme}.png`) });
    }
    await axe(p3, `${theme} desktop, hover pill below the line`);
    await ctx3.close();
    await s3.stop();

    // ---------------------------------------------------------------- the block's Edit (#119)
    // A line that ends about 170px short of the column: the pill would fit before the column's edge
    // but sits on the block's Edit, so it goes below, and that spot keeps off Edit too. The Reject is
    // muted, and a width change drops the pill.
    for (const width of [1100, 1440]) {
      const f5 = path.join(mkdtempSync(path.join(WORK, "e5-")), "after2.txt");
      const s5 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300", FAKE_EDIT2_FILE: f5 });
      const c5 = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
      await c5.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const p5 = await c5.newPage();
      await holdTransitions(p5);
      await p5.goto(s5.url);
      const tag = `${theme} ${width}px, a line ending near Edit`;
      const ids5 = await toSuggestions(p5, async () => {
        const fill = await p5.evaluate(() => {
          const doc = document.querySelector(".doc");
          const col = doc.getBoundingClientRect().right - parseFloat(getComputedStyle(doc).paddingRight);
          const w = document.createTreeWalker(document.querySelector("[data-testid=plan]"), NodeFilter.SHOW_TEXT);
          let n = w.nextNode();
          while (n && !n.data.includes("Yes, one core flow")) n = w.nextNode();
          const span = document.createElement("span");
          n.parentNode.insertBefore(span, n.nextSibling);
          const words = "shipped first so everyone at home can try it on their own phones this week and tell us what is missing before we add the rest".split(" ");
          let best = { gap: Infinity, text: "" };
          for (let i = 1; i <= words.length; i++) {
            span.textContent = `, ${words.slice(0, i).join(" ")}`;
            const r = [...span.getClientRects()].filter((x) => x.width > 0);
            const g = col - r.at(-1).right;
            if (r.length === 1 && Math.abs(g - 170) < Math.abs(best.gap - 170)) best = { gap: g, text: span.textContent };
          }
          span.remove();
          return best;
        });
        check(`${tag}: it ends ${Math.round(fill.gap)}px short of the column`, Math.abs(fill.gap - 170) < 40, JSON.stringify(fill));
        writeFileSync(f5, `Yes, one core flow${fill.text}`);
      });
      const B5 = ids5[1];
      await p5.mouse.move(width - 60, 860);
      await p5.evaluate(() => window.__release());
      const sp5 = await spot(p5, B5);
      await p5.mouse.move(sp5.x, sp5.y, { steps: 4 });
      await p5.locator(".ipill.hp.in").waitFor({ timeout: 2000 });
      await p5.waitForTimeout(300);
      await p5.evaluate(() => window.__release());
      const g = await p5.evaluate((id) => {
        const box = (e) => {
          const r = e.getBoundingClientRect();
          return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), op: getComputedStyle(e).opacity };
        };
        const pill = document.querySelector(".ipill.hp");
        const ins = [...document.querySelectorAll(`ins.sg[data-sg="${id}"]`)].pop();
        const blk = ins.closest(".blk");
        const p = box(pill);
        const edit = box(blk.querySelector(":scope > .blk-act"));
        const cites = [...blk.querySelectorAll(".gut-cite")].map(box);
        const doc = document.querySelector(".doc");
        const d = doc.getBoundingClientRect();
        const cs = getComputedStyle(doc);
        const last = [...ins.getClientRects()].filter((r) => r.width > 0).pop();
        const touch = [edit, ...cites].filter((t) => p.l < t.r && p.r > t.l && p.t < t.b && p.b > t.t);
        const probe = document.createElement("span");
        probe.style.color = "var(--muted-foreground)";
        document.body.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        const [acc, rej] = pill.querySelectorAll("button");
        return {
          p,
          edit,
          touch,
          inCol: p.l >= d.left + parseFloat(cs.paddingLeft) - 1 && p.r <= d.right - parseFloat(cs.paddingRight) + 1,
          below: p.t >= last.bottom,
          inlineWouldHit: last.right + 6 < edit.r && last.right + 6 + p.r - p.l > edit.l,
          rej: getComputedStyle(rej).color,
          acc: getComputedStyle(acc).color,
          muted,
        };
      }, B5);
      check(`${tag}: Edit is showing, and the pill after the line would sit on it`, g.edit.op === "1" && g.inlineWouldHit, JSON.stringify(g));
      check(`${tag}: so the pill goes below the line, inside the column`, g.below && g.inCol, JSON.stringify(g.p));
      check(`${tag}: …touching neither Edit nor a cite`, g.touch.length === 0, JSON.stringify(g.touch));
      check(`${tag}: the compact pill's Reject is muted, Accept isn't`, g.rej === g.muted && g.acc !== g.muted, `${g.rej} / ${g.acc} / ${g.muted}`);
      if (SHOTS) {
        await p5.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
        await p5.screenshot({ path: path.join(SHOTS, `d-hover-edit-${width}-r2-${theme}.png`) });
      }
      if (width === 1440) await axe(p5, `${theme} desktop, hover pill clear of Edit`);
      // A width change drops it (as it does the ✓ Accepted mark, #116): here, the window.
      await p5.setViewportSize({ width: width - 40, height: 900 });
      await p5.waitForTimeout(200);
      check(`${tag}: a resize drops the pill`, (await p5.locator(".ipill.hp").count()) === 0);
      await c5.close();
      await s5.stop();
    }

    // ---------------------------------------------------------------- phone: no hover pill, ever
    const s2 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await mp.goto(s2.url);
    await mp.getByRole("radio", { name: /Claude Code/ }).click();
    await mp.getByRole("button", { name: /Continue/ }).click();
    await mp.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
    await mp.keyboard.press("Enter");
    await mp.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
    await mp.getByRole("button", { name: /Send round/ }).click();
    await mp.getByText("Keep data local first?").waitFor({ timeout: 15000 });
    await mp.getByRole("button", { name: /Send round/ }).click();
    await mp.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
    await mp.getByTestId("plan").waitFor({ timeout: 15000 });
    await selectText(mp, "Shared shopping list");
    await mp.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Comment" }).click();
    const sheet = mp.getByRole("dialog", { name: "New comment" });
    await sheet.getByRole("textbox").fill("Say who shares it");
    await sheet.getByRole("button", { name: /^Comment/ }).click();
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /Comments/ }).click();
    const msheet = mp.getByRole("dialog", { name: "Comments" });
    await msheet.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
    await msheet.getByRole("button", { name: "Apply feedback" }).click();
    await msheet.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
    await msheet.getByRole("button", { name: "Close comments" }).click();
    await mp.getByRole("toolbar", { name: "Review suggestions" }).waitFor();
    const mids = await mp.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
    const msp = await spot(mp, mids[1]);
    await mp.mouse.move(msp.x, msp.y, { steps: 4 });
    await mp.waitForTimeout(400);
    check(`${theme} phone: a pointer over a suggestion shows no hover pill`, (await mp.locator(".ipill.hp").count()) === 0);
    await mp.touchscreen.tap(msp.x, msp.y);
    await mp.waitForTimeout(400);
    check(`${theme} phone: a tap shows no hover pill (the bar is the path)`, (await mp.locator(".ipill.hp").count()) === 0 && (await mp.getByRole("toolbar", { name: "Review suggestions" }).count()) === 1);
    await axe(mp, `${theme} phone, suggestions pending`);
    await mctx.close();
    await s2.stop();
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 14).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
