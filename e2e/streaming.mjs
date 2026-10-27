// #97 end to end: streamed comment replies for Claude Code only. Before the first delta the
// "{agent} replying" row is unchanged; then the author line, the text so far and a static caret
// (aria-busy), Stop in the row and the Reply box disabled; done drops the caret, shows the time and
// announces "{agent} replied" once; Stop keeps the partial text with "(stopped)" and Apply feedback;
// an error keeps it with "Couldn't reply · Try again", and Try again replaces it. A banned name never
// reaches the screen. The rail follows the text only when it was at the bottom. Codex replies whole,
// as before. Desktop and phone, dark and light, axe.
// Uses the built dist/cli.js and the fake CLIs (never a real agent). One server and one browser at a
// time; only processes started here are killed.
//   node e2e/streaming.mjs            checks only
//   SHOTS=dir node e2e/streaming.mjs  also writes screenshots to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-st-"));
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
  const ctl = path.join(home, "ctl.json");
  writeFileSync(ctl, "{}");
  const e = { PATH: `${fakeBins(["claude", "codex"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_CTL: ctl, ...extra };
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
    /** Switch the fake agent's mode for the next run. */
    mode: (env) => writeFileSync(ctl, JSON.stringify(env)),
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
}

async function toPlan(pg, url, agent = "Claude Code") {
  await pg.goto(url);
  await pg.getByRole("radio", { name: new RegExp(agent) }).click();
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
const tokenColour = (pg, v) =>
  pg.evaluate((v) => {
    const x = document.createElement("span");
    x.style.color = `var(${v})`;
    document.body.append(x);
    const c = getComputedStyle(x).color;
    x.remove();
    return c;
  }, v);
async function axe(pg, name) {
  await pg.mouse.move(0, 0);
  await pg.waitForTimeout(300);
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""}`).join("; "));
}

/**
 * Watches the page from now on: every text the rail ever showed for agent messages (for the banned
 * check), whether a streaming message ever appeared, what the polite status said, and which nodes
 * changed outside the streamed text while it streamed.
 */
const watch = (pg) =>
  pg.evaluate(() => {
    const w = { seen: [], streamed: false, live: [], outside: 0, appended: 0 };
    window.__w = w;
    const status = [...document.querySelectorAll("[role=status][aria-live=polite]")];
    new MutationObserver((recs) => {
      for (const r of recs) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (status.some((s) => s.contains(el))) {
          const t = el.closest("[role=status]")?.textContent ?? "";
          if (t) w.live.push(t);
          continue;
        }
        const streaming = document.querySelector(".th .msg[data-streaming]");
        if (streaming) {
          w.streamed = true;
          const span = streaming.querySelector("p > span:first-child");
          if (span && span.contains(r.target) && r.type === "childList") w.appended += r.addedNodes.length;
          else if (el && el.closest(".th") === streaming.closest(".th") && !span?.contains(r.target)) w.outside++;
        }
      }
      for (const m of document.querySelectorAll(".th .msg p")) w.seen.push(m.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
const watched = (pg) => pg.evaluate(() => window.__w);
const streamingMsg = (pg) => pg.locator(".th .msg[data-streaming]");
const streamGeom = (pg) =>
  pg.evaluate(() => {
    const m = document.querySelector(".th .msg[data-streaming]");
    if (!m) return null;
    const caret = m.querySelector(".caret");
    const cs = getComputedStyle(caret);
    const th = m.closest(".th");
    const p = m.querySelector("p");
    const last = p.querySelector("span:first-child");
    const r = document.createRange();
    r.selectNodeContents(last);
    const rects = r.getClientRects();
    const end = rects[rects.length - 1];
    const cr = caret.getBoundingClientRect();
    return {
      busy: m.getAttribute("aria-busy"),
      live: m.getAttribute("aria-live"),
      author: m.querySelector(".who b").textContent,
      authorMuted: m.querySelector(".who b").classList.contains("m"),
      who: m.querySelector(".who").textContent,
      stop: !!m.querySelector(".who .stop"),
      stopH: Math.round(m.querySelector(".who .stop").getBoundingClientRect().height),
      text: last.textContent,
      caretW: Math.round(cr.width * 10) / 10,
      caretBg: cs.backgroundColor,
      caretAnim: cs.animationName,
      caretHidden: caret.getAttribute("aria-hidden"),
      afterText: end ? Math.abs(cr.left - end.right) <= 3 : true,
      pAnim: getComputedStyle(p).animationName + "/" + getComputedStyle(p).transitionDuration,
      reply: th.querySelector("textarea.reply")?.disabled,
      apply: !!th.querySelector(".apply"),
    };
  });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    // ---------------------------------------------------------------- desktop
    const s = await server({ FAKE_COMMENT_DELAY_MS: "900", FAKE_STREAM_MS: "90" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.mouse.move(600, 880);
      await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await pg.waitForTimeout(150);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await toPlan(pg, s.url);
    const rail = pg.getByRole("complementary", { name: "Comments" });
    const muted = await tokenColour(pg, "--muted-foreground");
    const muteBg = await pg.evaluate(() => {
      const x = document.createElement("span");
      x.style.background = "var(--muted-foreground)";
      document.body.append(x);
      const c = getComputedStyle(x).backgroundColor;
      x.remove();
      return c;
    });

    // 1 · a reply that streams to the end.
    await watch(pg);
    await selectText(pg, "Shared shopping list");
    await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
    await pg.keyboard.press("Control+Alt+KeyM");
    const composer = pg.getByRole("dialog", { name: "New comment" });
    await composer.getByRole("textbox").fill("Say who shares it");
    await pg.keyboard.press("Control+Enter");
    await rail.getByText("Say who shares it").waitFor();
    const wait = rail.locator(".msg[aria-live=polite]").filter({ hasText: "Claude Code replying" });
    await wait.waitFor();
    const w0 = await wait.evaluate((m) => ({ who: m.querySelector(".who b")?.textContent, muted: m.querySelector(".who b")?.classList.contains("m"), p: !!m.querySelector("p"), caret: !!m.querySelector(".caret"), stop: !!m.querySelector(".stop"), dots: !!m.querySelector(".live, .dots, .spin, [class*=skel]") }));
    check(`${theme}: before the first delta the row is unchanged: “Claude Code replying” · Stop, no text, caret, dots or skeleton`, w0.who === "Claude Code replying" && w0.muted && !w0.p && !w0.caret && w0.stop && !w0.dots, JSON.stringify(w0));
    await snap("d-stream-wait");
    if (theme === "dark") await axe(pg, `${theme} desktop: replying, before the first delta`);

    await streamingMsg(pg).waitFor({ timeout: 10000 });
    await pg.waitForFunction(() => (document.querySelector(".th .msg[data-streaming] p > span:first-child")?.textContent.length ?? 0) >= 8);
    const g1 = await streamGeom(pg);
    await pg.waitForTimeout(400);
    const g2 = await streamGeom(pg);
    check(`${theme}: streaming shows the author line “Claude Code” (not muted), “replying” and Stop, no time`, g1.author === "Claude Code" && !g1.authorMuted && g1.stop && /^Claude Code\s*replying\s*Stop$/.test(g1.who), JSON.stringify(g1));
    check(`${theme}: the message is aria-busy, not a live region (the text is not read out as it grows)`, g1.busy === "true" && g1.live === null, JSON.stringify(g1));
    check(`${theme}: the text grows by appending (each sample extends the last)`, g2 && g2.text.length > g1.text.length && g2.text.startsWith(g1.text), `${g1.text} → ${g2?.text}`);
    check(`${theme}: a static 2px caret in --muted-foreground right after the last character, no blink`, g1.caretW === 2 && g1.caretBg === muteBg && g1.caretAnim === "none" && g1.caretHidden === "true" && g1.afterText, JSON.stringify(g1));
    check(`${theme}: chunks appear with no fade`, g1.pAnim === "none/0s", g1.pAnim);
    check(`${theme}: the Reply box is disabled while it streams; no Apply feedback yet`, g1.reply === true && !g1.apply, JSON.stringify(g1));
    if (theme === "dark") await axe(pg, `${theme} desktop: streaming`);
    await pg.waitForFunction(() => !document.querySelector(".th .msg[data-streaming]") && /^Good catch\..*"\.$/.test([...document.querySelectorAll(".crail .th .msg p")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
    const w1 = await watched(pg);
    check(`${theme}: deltas are appended as text nodes, nothing else in the thread changes while it streams`, w1.appended >= 3 && w1.outside <= 2, `appended ${w1.appended}, outside ${w1.outside}`);
    const done = await rail.locator(".th .msg").last().evaluate((m) => ({ streaming: m.hasAttribute("data-streaming"), busy: m.getAttribute("aria-busy"), caret: !!m.querySelector(".caret"), time: m.querySelector(".who .m")?.textContent ?? "", text: m.querySelector("p").textContent }));
    await pg.waitForTimeout(300);
    const live = (await watched(pg)).live.filter((t) => /replied/.test(t));
    check(`${theme}: done: the caret and aria-busy go, the time appears`, !done.streaming && !done.busy && !done.caret && /\d:\d\d/.test(done.time), JSON.stringify(done));
    check(`${theme}: done: one polite “Claude Code replied”, and the text is not announced`, live.length >= 1 && new Set(live).size === 1 && live[0] === "Claude Code replied", JSON.stringify((await watched(pg)).live));
    check(`${theme}: done: Apply feedback is offered and Reply is enabled again`, (await rail.getByRole("button", { name: "Apply feedback" }).count()) === 1 && (await rail.getByRole("textbox", { name: "Reply" }).isEnabled()));
    await snap("d-stream-done");

    // 2 · Stop mid-stream keeps the partial text, with "(stopped)", and offers Apply feedback.
    s.mode({ FAKE_STREAM: "hold" });
    await rail.getByRole("textbox", { name: "Reply" }).fill("And who changes it?");
    await rail.getByRole("textbox", { name: "Reply" }).press("Enter");
    await streamingMsg(pg).waitFor({ timeout: 10000 });
    await pg.waitForFunction(() => (document.querySelector(".th .msg[data-streaming] p > span:first-child")?.textContent.length ?? 0) >= 30, null, { timeout: 15000 });
    await pg.waitForTimeout(2500); // the fake holds halfway
    await snap("d-stream-mid");
    const held = (await streamGeom(pg)).text;
    await streamingMsg(pg).getByRole("button", { name: "Stop" }).click();
    const stopped = rail.locator(".th .msg").filter({ has: pg.locator(".stopped") });
    await stopped.waitFor({ timeout: 10000 });
    const st = await stopped.evaluate((m) => ({ text: m.querySelector("p").textContent, mark: m.querySelector(".stopped").textContent, colour: getComputedStyle(m.querySelector(".stopped")).color, time: m.querySelector(".who .m")?.textContent ?? "", author: m.querySelector(".who b").textContent }));
    check(`${theme}: Stop keeps what was written, followed by “ (stopped)” in --muted-foreground`, st.text === `${held} (stopped)` && st.mark === "(stopped)" && st.colour === muted && st.author === "Claude Code" && /\d:\d\d/.test(st.time), JSON.stringify(st));
    check(`${theme}: stopped: Apply feedback is offered on the partial text; no retry row, nothing retried`, (await rail.getByRole("button", { name: "Apply feedback" }).count()) === 1 && (await rail.getByText("Couldn't reply").count()) === 0 && (await rail.getByRole("button", { name: "Try again" }).count()) === 0);
    await pg.waitForTimeout(1200);
    check(`${theme}: stopped: no new run starts on its own`, (await streamingMsg(pg).count()) === 0 && (await rail.getByText(/replying/).count()) === 0);
    await snap("d-stream-stopped");
    await axe(pg, `${theme} desktop: stopped`);

    // 3 · An error mid-stream keeps the partial text; Try again replaces it.
    s.mode({ FAKE_STREAM: "fail" });
    await pg.keyboard.press("Escape");
    await selectText(pg, "Yes, one core flow");
    await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
    await pg.keyboard.press("Control+Alt+KeyM");
    await composer.getByRole("textbox").fill("Is one flow enough?");
    await pg.keyboard.press("Control+Enter");
    const th2 = rail.locator(".th").filter({ hasText: "Is one flow enough?" });
    await th2.locator(".crow[role=alert]").waitFor({ timeout: 15000 });
    const er = await th2.evaluate((t) => ({ partial: t.querySelector(".msg[data-partial] p")?.textContent ?? "", row: t.querySelector(".crow[role=alert]").textContent, caret: !!t.querySelector(".caret"), busy: !!t.querySelector("[aria-busy]") }));
    check(`${theme}: error mid-stream: the partial text stays, then “Couldn't reply · Try again”`, er.partial.length >= 10 && /^Good catch/.test(er.partial) && /^Couldn't reply\s*·?\s*Try again$/.test(er.row.trim()) && !er.caret && !er.busy, JSON.stringify(er));
    await snap("d-stream-error");
    if (theme === "dark") await axe(pg, `${theme} desktop: error mid-stream`);
    s.mode({});
    await th2.getByRole("button", { name: "Try again" }).click();
    await th2.locator(".msg[data-partial]").waitFor({ state: "detached", timeout: 10000 });
    await th2.locator(".msg p", { hasText: /^Good catch\./ }).last().waitFor({ timeout: 15000 });
    await pg.waitForFunction((id) => !document.querySelector(`[data-thread="${id}"] [data-streaming]`), await th2.getAttribute("data-thread"));
    const after = await th2.evaluate((t) => [...t.querySelectorAll(".msg")].map((m) => m.querySelector(".who b").textContent));
    check(`${theme}: Try again replaces the partial message: one reply from Claude Code`, JSON.stringify(after) === JSON.stringify(["You", "Claude Code"]), JSON.stringify(after));

    // 4 · A banned name never reaches the screen, even partly (the reply is asked again).
    s.mode({ FAKE_COMMENT: "leak-once" });
    await th2.getByRole("textbox", { name: "Reply" }).fill("And the cost?");
    await th2.getByRole("textbox", { name: "Reply" }).press("Enter");
    await th2.locator(".msg p", { hasText: /^Sure, that works too/ }).waitFor({ timeout: 20000 });
    const seen = (await watched(pg)).seen;
    check(`${theme}: a reply that names the hidden method never shows it, not even “gril…”`, !seen.some((t) => /gril/i.test(t)) && seen.length > 0, seen.filter((t) => /gril/i.test(t)).slice(0, 2).join(" | "));
    s.mode({});
    await ctx.close();
    await s.stop();

    // 5 · Scroll anchoring: the rail follows the streamed text only if it was already at the bottom;
    // scrolled up, it stays where the reader left it (§1 #97 rendering).
    {
      const sa = await server({ FAKE_STREAM_MS: "160" });
      const sctx = await browser.newContext({ viewport: { width: 1440, height: 520 } });
      await sctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const sp = await sctx.newPage();
      await toPlan(sp, sa.url);
      await selectText(sp, "Shared shopping list");
      await sp.getByRole("toolbar", { name: "Selection" }).waitFor();
      await sp.keyboard.press("Control+Alt+KeyM");
      await sp.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it. ".repeat(14).trim());
      await sp.keyboard.press("Control+Enter");
      const srail = sp.getByRole("complementary", { name: "Comments" });
      const reply = srail.getByRole("textbox", { name: "Reply" });
      await sp.waitForFunction(() => !document.querySelector(".th .msg[data-streaming]") && /^Good catch/.test([...document.querySelectorAll(".crail .th .msg p")].at(-1)?.textContent ?? ""), null, { timeout: 20000 });
      // The rail's scroll box, and a sampler that records it while the reply streams.
      const sample = (scrollUp) =>
        sp.evaluate(async (up) => {
          const m = document.querySelector(".th .msg[data-streaming]");
          let box = m.parentElement;
          while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
          box.scrollTop = box.scrollHeight;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          if (up) box.scrollTop -= up;
          await new Promise((r) => requestAnimationFrame(r));
          const start = { top: box.scrollTop, sh: box.scrollHeight, overflow: box.scrollHeight > box.clientHeight };
          const out = [];
          while (document.querySelector(".th .msg[data-streaming]")) {
            out.push({ top: box.scrollTop, gap: box.scrollHeight - box.scrollTop - box.clientHeight, sh: box.scrollHeight });
            await new Promise((r) => setTimeout(r, 60));
          }
          return { start, out };
        }, scrollUp);
      // At the bottom: it follows.
      await reply.fill("And who changes it?");
      await reply.press("Enter");
      await sp.locator(".th .msg[data-streaming]").waitFor({ timeout: 10000 });
      const a = await sample(0);
      const aGrew = Math.max(...a.out.map((x) => x.sh)) > a.start.sh;
      check(`${theme}: at the bottom, the rail stays at the bottom as the reply grows`, a.start.overflow && aGrew && a.out.length >= 5 && a.out.every((x) => x.gap < 4), JSON.stringify({ start: a.start, n: a.out.length, maxGap: Math.max(...a.out.map((x) => x.gap)), sh: [a.out[0]?.sh, a.out.at(-1)?.sh] }));
      await sp.waitForFunction(() => !document.querySelector(".crail .th .stop"), null, { timeout: 15000 });
      // Scrolled up: it stays where the reader left it.
      await reply.fill("Who else can add items?");
      await reply.press("Enter");
      await sp.locator(".th .msg[data-streaming]").waitFor({ timeout: 10000 });
      const b = await sample(150);
      const bGrew = Math.max(...b.out.map((x) => x.sh)) > b.start.sh;
      check(`${theme}: scrolled up, the rail does not move while the reply grows`, bGrew && b.out.length >= 5 && b.out.every((x) => Math.abs(x.top - b.start.top) <= 1) && b.out.at(-1).gap > b.out[0].gap, JSON.stringify({ start: b.start, n: b.out.length, tops: [...new Set(b.out.map((x) => x.top))], gaps: [b.out[0]?.gap, b.out.at(-1)?.gap] }));
      await sctx.close();
      await sa.stop();
    }

    // ---------------------------------------------------------------- phone
    const s2 = await server({ FAKE_COMMENT_DELAY_MS: "600", FAKE_STREAM_MS: "90" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    const msnap = async (name) => {
      if (!SHOTS) return;
      await mp.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await mp.waitForTimeout(260);
      await mp.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await toPlan(mp, s2.url);
    s2.mode({ FAKE_STREAM: "hold" });
    await selectText(mp, "Shared shopping");
    const mtb = mp.getByRole("toolbar", { name: "Selection" });
    await mtb.waitFor();
    await mtb.getByRole("button", { name: "Comment" }).click();
    const d = mp.getByRole("dialog", { name: "New comment" });
    await d.getByRole("textbox").fill("Say who shares it");
    await d.getByRole("button", { name: /^Comment/ }).click();
    await d.waitFor({ state: "detached" });
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /Comments/ }).click();
    const sheet = mp.getByRole("dialog", { name: "Comments" });
    await sheet.locator(".msg[data-streaming]").waitFor({ timeout: 15000 });
    await mp.waitForFunction(() => (document.querySelector(".th .msg[data-streaming] p > span:first-child")?.textContent.length ?? 0) >= 10, null, { timeout: 15000 });
    await mp.waitForTimeout(2500);
    const mg = await streamGeom(mp);
    check(`${theme} phone: the reply streams in the sheet with the caret and aria-busy; Stop is 44px`, mg.busy === "true" && mg.caretW === 2 && mg.stopH >= 44 && mg.reply === true, JSON.stringify(mg));
    await msnap("m-stream-mid");
    await axe(mp, `${theme} phone: streaming`);
    await sheet.locator(".msg[data-streaming]").getByRole("button", { name: "Stop" }).click();
    await sheet.locator(".msg .stopped").waitFor({ timeout: 10000 });
    check(`${theme} phone: Stop keeps the text with “(stopped)” and offers Apply feedback`, (await sheet.locator(".msg p", { hasText: mg.text }).textContent()) === `${mg.text} (stopped)` && (await sheet.getByRole("button", { name: "Apply feedback" }).count()) === 1);
    await msnap("m-stream-stopped");
    await axe(mp, `${theme} phone: stopped`);
    await mctx.close();
    await s2.stop();
  }

  // ---------------------------------------------------------------- other agents: unchanged
  const s3 = await server({ FAKE_COMMENT_DELAY_MS: "900" });
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  await toPlan(p3, s3.url, "Codex");
  await watch(p3);
  const rail3 = p3.getByRole("complementary", { name: "Comments" });
  await selectText(p3, "Shared shopping list");
  await p3.getByRole("toolbar", { name: "Selection" }).waitFor();
  await p3.keyboard.press("Control+Alt+KeyM");
  await p3.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
  await p3.keyboard.press("Control+Enter");
  await rail3.locator(".msg[aria-live=polite]").filter({ hasText: "Codex replying" }).waitFor();
  check("Codex: “Codex replying” · Stop while it works, as today", true);
  await rail3.getByText(/^Good catch\./).waitFor({ timeout: 15000 });
  const w3 = await watched(p3);
  const partial = w3.seen.filter((t) => t && !/^(Say who shares it|Good catch\..*)$/.test(t));
  check("Codex: no streaming message ever, and the reply appears whole at once (no typewriter)", !w3.streamed && partial.length === 0, JSON.stringify(partial.slice(0, 3)));
  await ctx3.close();
  await s3.stop();
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
