// v1.1 polish #102, the "✓ Accepted" hold: a single accept with others still pending fades the
// deletion (120ms) and drops it, fades the green to plain (220ms), writes plan.md, and holds
// "✓ Accepted" beside the text for 2s without taking layout space; ⌘Z, reject, the keyboard path,
// the last suggestion and phones. Timers run on Playwright's clock; the hold's CSS transitions are
// paused as they start and stepped to the same clock, so each check (and shot) is one exact frame.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/accept-hold.mjs                 checks only (dark and light, desktop and phone)
//   SHOTS=dir node e2e/accept-hold.mjs       also writes the d-acc-t* frames to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { quiet, until as untilNode } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-ah-"));
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
      // A transition whose transitionrun hasn't been dispatched yet (no frame under the paused clock)
      // started at this fake instant: hold it from now.
      for (const el of document.querySelectorAll(".okm"))
        for (const a of el.getAnimations())
          if (a.transitionProperty && !held.some((h) => h.a === a)) {
            a.pause();
            held.push({ a, at: performance.now() });
          }
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

/** Where things are on the page for the suggestion `id` (and the next one). */
const state = (pg, id) =>
  pg.evaluate((id) => {
    const q = (s) => document.querySelector(s);
    const del = q(`del.sg[data-sg="${id}"]`);
    const ins = [...document.querySelectorAll(`ins.sg[data-sg="${id}"]`)].pop();
    const ok = q(".okm");
    const wrap = q(".docwrap");
    const doc = q(".doc");
    const pill = q(".ipill:not(.hp)");
    const r = (el) => el && el.getBoundingClientRect();
    const tint = (el) => el && getComputedStyle(el).backgroundColor;
    let mark = null;
    if (ok) {
      // The accepted text's last line, measured to the end of that line.
      let last = { right: NaN, top: NaN, bottom: NaN };
      if (ins) {
        const l = [...ins.getClientRects()].pop();
        const rg = document.createRange();
        rg.selectNodeContents(ins.closest("p, li, h1, h2, h3, td, blockquote"));
        const mid = (l.top + l.bottom) / 2;
        const end = Math.max(l.right, ...[...rg.getClientRects()].filter((x) => x.width > 1 && x.top <= mid && x.bottom >= mid).map((x) => x.right));
        last = { right: end, top: l.top, bottom: l.bottom };
      }
      const d = r(doc);
      const col = d.right - parseFloat(getComputedStyle(doc).paddingRight);
      const m = r(ok);
      const h0 = doc.scrollHeight;
      const anchor = ins ?? doc.querySelector("p, li");
      const ir = r(anchor);
      ok.style.display = "none";
      const h1 = doc.scrollHeight;
      const ir1 = r(anchor);
      ok.style.display = "";
      mark = {
        left: m.left,
        top: m.top,
        bottom: m.bottom,
        lineEnd: last.right,
        lineMid: (last.top + last.bottom) / 2,
        col,
        pos: getComputedStyle(ok).position,
        parent: ok.parentElement === wrap,
        hidden: ok.getAttribute("aria-hidden"),
        text: ok.textContent,
        svg: ok.querySelector("svg") && r(ok.querySelector("svg")).width,
        font: getComputedStyle(ok).fontSize,
        colour: getComputedStyle(ok).color,
        op: getComputedStyle(ok).opacity,
        bye: ok.classList.contains("bye"),
        dur: getComputedStyle(ok).transitionDuration,
        noLayout: h0 === h1 && ir.top === ir1.top && ir.left === ir1.left,
      };
    }
    const probe = document.createElement("span");
    probe.style.color = "var(--success-ink)";
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return {
      del: del && { cls: del.className, display: getComputedStyle(del).display, op: +getComputedStyle(del).opacity, dur: getComputedStyle(del).transitionDuration },
      ins: ins && { cls: ins.className, tint: tint(ins), op: +getComputedStyle(ins).opacity, dur: getComputedStyle(ins).transitionDuration, deco: getComputedStyle(ins).textDecorationLine },
      mark,
      ink,
      pill: pill && { label: pill.getAttribute("aria-label"), on: pill.previousElementSibling?.getAttribute("data-sg") ?? pill.parentElement.querySelector("ins.sg.f, del.sg.f")?.getAttribute("data-sg") ?? null },
      focused: document.querySelector("ins.sg.f, del.sg.f")?.getAttribute("data-sg") ?? null,
      bar: document.querySelector(".review")?.textContent ?? "",
      live: [...document.querySelectorAll("[aria-live]")].map((e) => e.textContent).join("|"),
    };
  }, id);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
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
      await pg.mouse.move(700, 600); // off the blocks, so no hover Edit in the frame
      await step(pg);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await pg.goto(s.url);
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
    const before = await planMd(pg);
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
    const review = pg.getByRole("toolbar", { name: "Review suggestions" });
    await review.waitFor();
    const ids = await pg.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
    const A = ids[0];
    const B = ids[1];
    check(`${theme}: two suggestions, the first with a deletion`, ids.length === 2 && (await pg.locator(`del.sg[data-sg="${A}"]`).count()) === 1, ids.join(","));

    // Focus with ⌥↓, then act with the mouse.
    const focusSg = async (id) => {
      await pg.locator("[data-testid=plan]").focus();
      for (let i = 0; i < 4 && !(await pg.evaluate((id) => !!document.querySelector(`.f[data-sg="${id}"]`), id)); i++) await pg.keyboard.press("Alt+ArrowDown");
      await until(pg, (id) => !!document.querySelector(`.f[data-sg="${id}"]`), id, `focus ${id}`);
      await pg.locator(".ipill:not(.hp)").waitFor();
      await pointer(pg);
    };
    const focusA = () => focusSg(A);
    const pause = async () => pg.clock.pauseAt((await pg.evaluate(() => Date.now())) + 1000);
    const resume = async () => {
      await pg.evaluate(() => window.__release());
      await pg.clock.resume();
    };
    const pillBtn = (name) => pg.locator(".ipill:not(.hp)").getByRole("button", { name: new RegExp(`^${name}`) });

    // ---- pointer accept: the whole timeline
    await focusA();
    await pause();
    await pillBtn("Accept").click();
    await step(pg);
    let st = await state(pg, A);
    check(`${theme} t0: the deletion starts its 120ms fade`, /\bout\b/.test(st.del?.cls) && st.del.dur === "0.12s", JSON.stringify(st.del));
    check(`${theme} t0: the next suggestion has the pill and focus, the counts skip the held one`, st.focused === B && /Suggestion 1 of 1/.test(st.pill?.label) && /1 of 1/.test(st.bar), JSON.stringify(st.pill) + st.focused + st.bar);
    check(`${theme} t0: the bar says Accepted · ⌘Z to undo`, /Accepted · (⌘|Ctrl\+?)Z to undo/.test(st.bar), st.bar);
    check(`${theme} t0: no mark yet`, !st.mark);
    await pg.clock.runFor(60);
    await step(pg);
    st = await state(pg, A);
    check(`${theme} t60: the deletion is mid-fade, the insertion is still green`, st.del && st.del.op > 0 && st.del.op < 1 && st.ins.tint !== "rgba(0, 0, 0, 0)" && !st.mark, JSON.stringify(st));
    await snap("d-acc-t0060");
    await pg.clock.runFor(60);
    await step(pg);
    st = await state(pg, A);
    check(`${theme} t120: the deletion has left the DOM, the green starts its 220ms fade`, !st.del && /\bok\b/.test(st.ins.cls) && st.ins.dur === "0.22s" && st.ins.deco === "none", JSON.stringify(st));
    check(`${theme} t120: "✓ Accepted" shows, aria-hidden, absolute in .docwrap`, st.mark && st.mark.text === "Accepted" && st.mark.hidden === "true" && st.mark.pos === "absolute" && st.mark.parent, JSON.stringify(st.mark));
    check(`${theme} t120: the mark takes no layout space`, st.mark?.noLayout, JSON.stringify(st.mark));
    const fits = st.mark && st.mark.lineEnd + 8 + 70 <= st.mark.col;
    const want = st.mark && (Math.abs(st.mark.left - (st.mark.lineEnd + 8)) <= 1 || Math.abs(st.mark.left - (st.mark.col + 16)) <= 1);
    check(`${theme} t120: the mark sits 8px after the line end, or 16px past the column`, want && Math.abs((st.mark.top + st.mark.bottom) / 2 - st.mark.lineMid) <= 2, JSON.stringify({ ...st.mark, fits }));
    check(`${theme} t120: the mark is 12px --success-ink with a 14px check`, st.mark?.font === "12px" && st.mark.colour === st.ink && st.mark.svg === 14, JSON.stringify(st.mark));
    check(`${theme} t120: plan.md not written yet`, (await planMd(pg)) === before);
    await pg.clock.runFor(80);
    await snap("d-acc-t0200");
    await pg.clock.runFor(140); // 340: the green is plain, the write goes out
    await pg.waitForFunction(async () => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text()).includes("One list the whole household shares"), null, { timeout: 5000 }).catch(() => {});
    check(`${theme} t340: plan.md has the accepted text`, (await planMd(pg)).includes("One list the whole household shares"));
    await pg.waitForFunction((A) => !document.querySelector(`ins.sg[data-sg="${A}"]`), A, { timeout: 5000 }).catch(() => {});
    st = await state(pg, A);
    check(`${theme} t340: the accepted text is plain and the mark stays`, !st.ins && st.mark && st.mark.op === "1", JSON.stringify(st.mark));
    await pg.clock.runFor(860);
    await snap("d-acc-t1200");
    await pg.clock.runFor(799);
    st = await state(pg, A);
    check(`${theme} t1999: the mark still holds`, st.mark && !st.mark.bye, JSON.stringify(st.mark));
    await pg.clock.runFor(1);
    await step(pg);
    st = await state(pg, A);
    check(`${theme} t2000: the mark fades over 160ms`, st.mark?.bye && st.mark.dur === "0.16s", JSON.stringify(st.mark));
    await pg.clock.runFor(40);
    await snap("d-acc-t2040");
    await pg.clock.runFor(119);
    check(`${theme} t2159: the mark is still there`, (await pg.locator(".okm").count()) === 1);
    await pg.clock.runFor(1);
    check(`${theme} t2160: the mark is gone`, (await pg.locator(".okm").count()) === 0);
    await pg.clock.runFor(40);
    await snap("d-acc-t2200");
    await resume();

    // ---- ⌘Z after the write: back on the server
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });
    check(`${theme}: ⌘Z after the write restores the suggestion and plan.md`, (await planMd(pg)) === before && (await pg.locator(".okm").count()) === 0);

    // ---- axe while "✓ Accepted" holds (axe needs running timers, so this one runs in real time).
    // A full axe pass can outlast the 2 s hold on a loaded machine (it did at load ~15 on 8 cores), so this
    // step stretches the hold through the token the app reads (--d-ok-hold), then puts it back.
    await pg.evaluate(() => document.documentElement.style.setProperty("--d-ok-hold", "12000ms"));
    await focusA();
    await pillBtn("Accept").click();
    await pg.locator(".okm").waitFor({ timeout: 2000 });
    const axeAt = Date.now();
    await axe(pg, `${theme} desktop, holding ✓ Accepted`);
    const axeMs = Date.now() - axeAt;
    console.log(`  (${theme}: axe during the hold took ${axeMs} ms)`);
    check(`${theme}: axe ran while the mark held`, (await pg.locator(".okm").count()) === 1, `axe ${axeMs} ms`);
    await pg.evaluate(() => document.documentElement.style.removeProperty("--d-ok-hold"));
    await pg.locator(".okm").waitFor({ state: "detached", timeout: 16000 });
    await axe(pg, `${theme} desktop, after the hold`);
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });

    // ---- ⌘Z during the hold, before the write
    await focusA();
    await pause();
    await pillBtn("Accept").click();
    await pg.clock.runFor(200);
    check(`${theme}: mark up mid-hold`, (await pg.locator(".okm").count()) === 1);
    await pg.keyboard.press("Control+z");
    st = await state(pg, A);
    check(`${theme}: ⌘Z mid-hold removes the mark at once and restores the suggestion`, !st.mark && st.del && !/\b(out|gone)\b/.test(st.del.cls) && !/\bok\b/.test(st.ins.cls) && st.focused === A, JSON.stringify(st));
    await pg.clock.runFor(500);
    check(`${theme}: …and nothing is written`, (await planMd(pg)) === before);
    await resume();

    // ---- ⌘Z after the write while the mark still holds
    await focusA();
    await pause();
    await pillBtn("Accept").click();
    await pg.clock.runFor(400);
    await pg.waitForFunction((A) => !document.querySelector(`ins.sg[data-sg="${A}"]`), A, { timeout: 5000 });
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });
    check(`${theme}: ⌘Z after the write clears the mark at once`, (await pg.locator(".okm").count()) === 0 && (await planMd(pg)) === before);
    await resume();

    // ---- reject: no mark; the insertion fades 120ms; the bar says Rejected
    await focusA();
    await pause();
    await pillBtn("Reject").click();
    await step(pg);
    st = await state(pg, A);
    check(`${theme}: reject fades the insertion over 120ms, no mark`, /\bout\b/.test(st.ins?.cls) && st.ins.dur === "0.12s" && !st.mark && /Rejected · /.test(st.bar), JSON.stringify(st));
    await pg.clock.runFor(120);
    await resume();
    await pg.waitForFunction((A) => !document.querySelector(`[data-sg="${A}"]`), A, { timeout: 5000 });
    check(`${theme}: reject leaves plan.md alone`, (await planMd(pg)) === before && (await pg.locator(".okm").count()) === 0);
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });

    // ---- keyboard: everything at once, the mark still lasts 2000ms
    await pg.locator("[data-testid=plan]").focus();
    await pg.keyboard.press("Alt+ArrowDown");
    await pg.waitForFunction((A) => document.querySelector(`.f[data-sg="${A}"]`), A);
    await pause();
    await pg.keyboard.press("Control+Enter");
    st = await state(pg, A);
    check(`${theme} ⌘↵: at once (no transitions), the mark shows`, !st.del && st.mark && st.mark.dur === "0s" && (!st.ins || st.ins.dur === "0s"), JSON.stringify(st));
    await pg.waitForFunction(async () => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text()).includes("One list the whole household shares"), null, { timeout: 5000 }).catch(() => {});
    check(`${theme} ⌘↵: writes at once`, (await planMd(pg)).includes("One list the whole household shares"));
    await pg.clock.runFor(1999);
    check(`${theme} ⌘↵: the mark lasts 2000ms`, (await pg.locator(".okm:not(.bye)").count()) === 1);
    await pg.clock.runFor(161);
    check(`${theme} ⌘↵: then goes`, (await pg.locator(".okm").count()) === 0);
    await resume();

    // ---- the plan's width changes during the hold: the mark goes, it isn't moved (#116)
    await pg.keyboard.press("Control+z");
    await pg.locator(`del.sg[data-sg="${A}"]`).waitFor({ timeout: 5000 });
    await focusA();
    await pillBtn("Accept").click();
    await pg.locator(".okm").waitFor({ timeout: 2000 });
    await pg.setViewportSize({ width: 1400, height: 900 });
    await pg.locator(".okm").waitFor({ state: "detached", timeout: 1000 }).catch(() => {});
    check(`${theme}: a resize during the hold drops the mark`, (await pg.locator(".okm").count()) === 0 && /Accepted · /.test(await pg.locator(".review").textContent()));
    await pg.setViewportSize({ width: 1440, height: 900 });
    await pg.waitForFunction(async () => (await (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text()).includes("One list the whole household shares"), null, { timeout: 5000 });

    // ---- the last suggestion keeps today's path: no hold, no mark
    await focusSg(B);
    await pause();
    await pillBtn("Accept").click();
    await pg.waitForFunction((B) => !document.querySelector(`[data-sg="${B}"]`), B, { timeout: 5000 });
    check(`${theme}: the last suggestion has no hold or mark`, (await pg.locator(".okm").count()) === 0 && (await pg.locator(".docwrap .del, del.sg.out").count()) === 0);
    await resume();
    await ctx.close();
    await s.stop();

    // ---------------------------------------------------------------- no room for the mark (#116)
    // 1100px with the rail open: the gutter is too narrow for the margin, so there's no mark and the
    // plan never scrolls sideways; the bar still says "Accepted · ⌘Z to undo".
    {
      const f2 = path.join(mkdtempSync(path.join(WORK, "e2-")), "after2.txt");
      const s3 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300", FAKE_EDIT2_FILE: f2 });
      const c3 = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "no-preference" });
      await c3.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const p3 = await c3.newPage();
      await p3.goto(s3.url);
      await p3.getByRole("radio", { name: /Claude Code/ }).click();
      await p3.getByRole("button", { name: /Continue/ }).click();
      await p3.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await p3.keyboard.press("Enter");
      await p3.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
      await p3.getByRole("button", { name: /Send round/ }).click();
      await p3.getByText("Keep data local first?").waitFor({ timeout: 15000 });
      await p3.getByRole("button", { name: /Send round/ }).click();
      await p3.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
      await p3.getByTestId("plan").waitFor({ timeout: 15000 });
      await selectText(p3, "Shared shopping list");
      await p3.getByRole("toolbar", { name: "Selection" }).waitFor();
      await p3.keyboard.press("Control+Alt+KeyM");
      await p3.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
      await p3.keyboard.press("Control+Enter");
      const rail3 = p3.getByRole("complementary", { name: "Comments" });
      await rail3.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
      // With the rail open, fill "Yes, one core flow" out to just short of the column's edge.
      const fill = await p3.evaluate(() => {
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
          if (col - r.right >= 0 && col - r.right < best.gap) best = { gap: col - r.right, text: span.textContent };
        }
        span.remove();
        const wrap = document.querySelector(".docwrap");
        return { ...best, gutter: wrap.getBoundingClientRect().left + wrap.clientWidth - col };
      });
      writeFileSync(f2, `Yes, one core flow${fill.text}`);
      check(`${theme} 1100px: the line ends ${Math.round(fill.gap)}px from the column, with a ${Math.round(fill.gutter)}px gutter`, fill.gap < 80 && fill.gutter < 16 + 72 + 8, JSON.stringify(fill));
      await rail3.getByRole("button", { name: "Apply feedback" }).click();
      await rail3.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
      const ids3 = await p3.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
      await p3.locator("[data-testid=plan]").focus();
      for (let i = 0; i < 4 && !(await p3.evaluate((id) => !!document.querySelector(`.f[data-sg="${id}"]`), ids3[1])); i++) await p3.keyboard.press("Alt+ArrowDown");
      await pointer(p3);
      await p3.locator(".ipill:not(.hp)").getByRole("button", { name: /^Accept/ }).click();
      // Nothing spills past the 732px scroller: not the hold, and not the decision gutter (#118). Every
      // frame of the hold is measured, from the click until the accepted text is written.
      const hold3 = await p3.evaluate(
        (id) =>
          new Promise((done) => {
            let worst = 0, frames = 0, marks = 0;
            const t0 = performance.now();
            const frame = () => {
              const w = document.querySelector(".docwrap");
              const edge = w.getBoundingClientRect().left + w.clientWidth;
              worst = Math.max(worst, w.scrollWidth - w.clientWidth, ...[...w.querySelectorAll("*")].filter((e) => !e.closest("pre")).map((e) => e.getBoundingClientRect().right - edge));
              marks = Math.max(marks, [...document.querySelectorAll(".okm")].filter((m) => m.style.visibility !== "hidden").length);
              frames++;
              const written = !document.querySelector(`[data-sg="${CSS.escape(id)}"]`);
              if ((written && frames > 2) || performance.now() - t0 > 4000) done({ worst, frames, marks, written });
              else requestAnimationFrame(frame);
            };
            frame();
          }),
        ids3[1],
      );
      check(`${theme} 1100px: no room, so no mark, and nothing of the hold makes the plan scroll sideways`, hold3.written && hold3.worst <= 0 && hold3.marks === 0 && (await p3.locator(".okm").count()) === 0, JSON.stringify(hold3));
      check(`${theme} 1100px: …the bar still says Accepted`, /Accepted · /.test(await p3.locator(".review").textContent()));
      await c3.close();
      await s3.stop();
    }

    // ---------------------------------------------------------------- a cited line (#119)
    // "Yes, one core flow" has the R1·1 cite in the margin and the block's Edit at its top right. The
    // line end is the text's, so the mark lands 8px after it, touching neither; at 1100px a line
    // with room still gets its mark.
    for (const { width, near } of [{ width: 1440 }, { width: 1100 }, { width: 1440, near: true }]) {
      const f4 = path.join(mkdtempSync(path.join(WORK, "e4-")), "after2.txt");
      const s4 = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300", FAKE_EDIT2_FILE: f4 });
      const tag = `${theme} ${width}px cited line${near ? " ending near Edit" : ""}`;
      const c4 = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
      await c4.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const p4 = await c4.newPage();
      await holdTransitions(p4);
      await p4.goto(s4.url);
      await p4.getByRole("radio", { name: /Claude Code/ }).click();
      await p4.getByRole("button", { name: /Continue/ }).click();
      await p4.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await p4.keyboard.press("Enter");
      await p4.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
      await p4.getByRole("button", { name: /Send round/ }).click();
      await p4.getByText("Keep data local first?").waitFor({ timeout: 15000 });
      await p4.getByRole("button", { name: /Send round/ }).click();
      await p4.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
      await p4.getByTestId("plan").waitFor({ timeout: 15000 });
      await selectText(p4, "Shared shopping list");
      await p4.getByRole("toolbar", { name: "Selection" }).waitFor();
      await p4.keyboard.press("Control+Alt+KeyM");
      await p4.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
      await p4.keyboard.press("Control+Enter");
      const rail4 = p4.getByRole("complementary", { name: "Comments" });
      await rail4.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
      if (near) {
        // Fill the line out to end 20–60px short of Edit: the mark would touch it, and with a cite on
        // the line there's no margin fallback, so there's no mark.
        const fill = await p4.evaluate(() => {
          const w = document.createTreeWalker(document.querySelector("[data-testid=plan]"), NodeFilter.SHOW_TEXT);
          let n = w.nextNode();
          while (n && !n.data.includes("Yes, one core flow")) n = w.nextNode();
          const edit = n.parentElement.closest(".blk").querySelector(":scope > .blk-act").getBoundingClientRect();
          const span = document.createElement("span");
          n.parentNode.insertBefore(span, n.nextSibling);
          const words = "shipped first so everyone at home can try it on their own phones this week and tell us what is missing".split(" ");
          let best = { gap: Infinity, text: "" };
          for (let i = 1; i <= words.length; i++) {
            span.textContent = `, ${words.slice(0, i).join(" ")}`;
            const r = [...span.getClientRects()].filter((x) => x.width > 0);
            const g = edit.left - r.at(-1).right;
            if (r.length === 1 && g >= 8 && g < 72 && Math.abs(g - 40) < Math.abs(best.gap - 40)) best = { gap: g, text: span.textContent };
          }
          span.remove();
          return best;
        });
        writeFileSync(f4, `Yes, one core flow${fill.text}`);
        check(`${tag}: the line ends ${Math.round(fill.gap)}px short of Edit`, fill.gap < 72, JSON.stringify(fill));
      }
      await rail4.getByRole("button", { name: "Apply feedback" }).click();
      await rail4.getByText(/suggestions? ready/).waitFor({ timeout: 15000 });
      const ids4 = await p4.evaluate(() => [...new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.getAttribute("data-sg")))]);
      await p4.locator("[data-testid=plan]").focus();
      for (let i = 0; i < 4 && !(await p4.evaluate((id) => !!document.querySelector(`.f[data-sg="${id}"]`), ids4[1])); i++) await p4.keyboard.press("Alt+ArrowDown");
      // A click on the pill's Accept: the pointer is then on the block, so its Edit and cite show.
      await pointer(p4);
      await p4.locator(".ipill").getByRole("button", { name: /^Accept/ }).first().click();
      if (near) {
        await p4.getByText(/^Accepted · /).waitFor({ timeout: 3000 });
        // The mark is placed (or dropped) in the same render that turns the text plain (ins.sg.ok).
        await p4.locator("ins.sg.ok").first().waitFor({ state: "attached", timeout: 3000 });
        const shown = await p4.evaluate(() => [...document.querySelectorAll(".okm")].filter((m) => m.style.visibility !== "hidden").length);
        check(`${tag}: no mark (it would touch Edit, and a cited line has no margin)`, shown === 0 && (await p4.locator(".okm").count()) === 0, `shown ${shown}`);
        check(`${tag}: …the bar still says Accepted`, /Accepted · /.test(await p4.locator(".review").textContent()));
        await p4.evaluate(() => window.__release());
        await c4.close();
        await s4.stop();
        continue;
      }
      await p4.locator(".okm").waitFor({ state: "attached", timeout: 3000 });
      // The pill is gone from under the pointer; a nudge has the page see what it is on now.
      const at = await p4.evaluate(() => {
        const li = [...document.querySelectorAll("[data-testid=plan] li")].find((e) => e.textContent.includes("Yes, one core flow"));
        const r = li.querySelector(".ps").getBoundingClientRect();
        return { x: r.left + 20, y: (r.top + r.bottom) / 2 };
      });
      await p4.mouse.move(at.x, at.y, { steps: 2 });
      // Wait for the block's hover state: its cite and Edit faded in.
      await untilNode(
        () =>
          p4.evaluate(() => {
            const blk = [...document.querySelectorAll("[data-testid=plan] li")].find((e) => e.textContent.includes("Yes, one core flow"))?.closest(".blk");
            const taken = blk ? [...blk.querySelectorAll(":scope > .blk-act, .gut-cite")] : [];
            return !!blk && blk.matches(":hover") && taken.length > 0 && taken.every((e) => getComputedStyle(e).opacity === "1");
          }),
        "the block's hover state",
      ).catch(() => {});
      const g = await p4.evaluate(() => {
        const ok = document.querySelector(".okm");
        const li = [...document.querySelectorAll("[data-testid=plan] li")].find((e) => e.textContent.includes("Yes, one core flow"));
        // The accepted text (by now written, so plain text in the passage).
        const ins = [...li.querySelectorAll("ins.sg")].pop() ?? li.querySelector(".ps");
        const l = [...ins.getClientRects()].filter((r) => r.width > 0).pop();
        const mid = (l.top + l.bottom) / 2;
        // The text's own end on that line, counting no control.
        let end = l.right;
        const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.data.trim() || n.parentElement.closest(".gut, .blk-act, .ipill, .okm, .sr-only")) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          for (const r of rg.getClientRects()) if (r.width > 1 && r.top <= mid && r.bottom >= mid) end = Math.max(end, r.right);
        }
        const box = (e) => {
          const r = e.getBoundingClientRect();
          return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), op: getComputedStyle(e).opacity };
        };
        const blk = li.closest(".blk");
        const m = ok && ok.style.visibility !== "hidden" ? box(ok) : null;
        const taken = [...blk.querySelectorAll(":scope > .blk-act, .gut-cite")].map(box);
        const touch = m ? taken.filter((t) => m.l < t.r && m.r > t.l && m.t < t.b && m.b > t.t) : [];
        return { mark: m, end, taken, touch, cites: blk.querySelectorAll(".gut-cite").length, hover: blk.matches(":hover") };
      });
      check(`${tag}: the pointer is on the block, its cite and its Edit showing`, g.hover && g.cites > 0 && g.taken.length > g.cites && g.taken.every((t) => t.op === "1"), JSON.stringify(g.taken));
      check(`${tag}: the mark is 8px after the text's end`, !!g.mark && Math.abs(g.mark.l - (g.end + 8)) <= 1, JSON.stringify({ mark: g.mark, end: g.end }));
      check(`${tag}: …touching neither the cite nor Edit`, !!g.mark && g.touch.length === 0, JSON.stringify(g.touch));
      if (SHOTS && width === 1440) {
        await p4.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
        await p4.screenshot({ path: path.join(SHOTS, `d-acc-cited-r2-${theme}.png`) });
      }
      await p4.evaluate(() => window.__release());
      await c4.close();
      await s4.stop();
    }

    // ---------------------------------------------------------------- phone: today's behaviour
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
    const mtb = mp.getByRole("toolbar", { name: "Selection" });
    await mtb.getByRole("button", { name: "Comment" }).click();
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
    const mbar = mp.getByRole("toolbar", { name: "Review suggestions" });
    await mbar.waitFor();
    await mbar.getByRole("button", { name: /^Accept suggestion/ }).tap();
    await mp.waitForFunction(() => document.querySelectorAll("[data-sg]").length > 0 && new Set([...document.querySelectorAll("[data-sg]")].map((e) => e.dataset.sg)).size === 1, null, { timeout: 5000 });
    check(`${theme} phone: Accept keeps today's path (no hold, no mark)`, (await mp.locator(".okm, .sg.out, .sg.ok").count()) === 0);
    await quiet(mp);
    await axe(mp, `${theme} phone, after an accept`);
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
