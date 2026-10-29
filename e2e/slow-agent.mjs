// A slow agent (Grok CLI 1.0.70 rounds take minutes): while a round runs, the status line has a
// quiet "Rounds can take a few minutes." under it, at the first round and between rounds. When a run
// still goes past the timeout, the card says the agent is running slow (not that it failed), with
// Retry, and Retry carries on. Light and dark, desktop and 320 px, nothing runs off a phone, axe.
// Uses the built dist/cli.js and the fake grok with a short GRILLADO_TIMEOUT_MS (never a real agent).
// One server and one browser at a time; only processes started here are killed.
//   node e2e/slow-agent.mjs            checks only
//   SHOTS=dir node e2e/slow-agent.mjs  also writes screenshots to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-slow-"));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const NOTE = "Rounds can take a few minutes.";
const PLATE_NOTE = "Plans can take a few minutes.";
const TITLE = "Grok is running slow";
const BODY = "Nothing came back in time. Your answers are saved.";
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
  const e = { PATH: `${fakeBins(["grok"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_CTL: ctl, ...extra };
  // A third question call times out below: the cap (#33) has to leave room for it.
  const child = spawn(NODE, [path.join(ROOT, "dist/cli.js"), "--no-open", "--max-rounds", "3"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
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
    /** The fake agent's env for the next run. */
    mode: (env) => writeFileSync(ctl, JSON.stringify(env)),
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
}

async function axe(pg, name) {
  await pg.mouse.move(0, 0);
  await pg.waitForFunction(() => document.getAnimations().every((x) => !(x instanceof CSSTransition) || x.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""}`).join("; "));
}

/** Everything inside the viewport's width: no sideways scroll, and these boxes end before the right edge. */
const fits = (pg, sels) =>
  pg.evaluate((sels) => {
    const w = document.documentElement.clientWidth;
    const over = [];
    if (document.scrollingElement.scrollWidth > w) over.push(`page ${document.scrollingElement.scrollWidth}>${w}`);
    for (const s of sels)
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.left < 0 || r.right > w + 0.5 || el.scrollWidth > el.clientWidth + 1) over.push(`${s} ${Math.round(r.left)}–${Math.round(r.right)} of ${w}`);
      }
    return over;
  }, sels);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["light", "dark"]) {
    for (const vp of [{ tag: "desktop", width: 1440, height: 900 }, { tag: "320", width: 320, height: 640 }]) {
      const at = `${theme} ${vp.tag}`;
      const s = await server({ GRILLADO_TIMEOUT_MS: "5000" });
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "no-preference" });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const pg = await ctx.newPage();
      const shot = async (name) => SHOTS && pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${vp.tag}.png`) });
      const note = pg.getByTestId("wait-note");

      // The first round: "Sizing up your idea…" with the note under it.
      s.mode({ FAKE_DELAY_MS: "2500" });
      await pg.goto(s.url);
      const pick = pg.getByRole("radio", { name: /Grok/ });
      if (await pick.isVisible().catch(() => false)) {
        await pick.click();
        await pg.getByRole("button", { name: /Continue/ }).click();
      }
      await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await pg.keyboard.press("Enter");
      await note.waitFor({ timeout: 10000 });
      check(`${at}: the first round's wait says “${NOTE}”`, (await note.innerText()) === NOTE);
      check(`${at}: the note sits right under the status line, outside the live region`, await pg.evaluate(() => {
        const n = document.querySelector("[data-testid=wait-note]");
        return n.previousElementSibling?.matches(".status[role=status]") && !n.closest("[aria-live]");
      }));
      check(`${at}: first round fits`, (await fits(pg, [".intro .status", "[data-testid=wait-note]"])).length === 0, (await fits(pg, [".intro .status", "[data-testid=wait-note]"])).join("; "));
      await shot("1-first-round");
      if (at === "dark desktop") await axe(pg, `${at}: first round waiting`);
      await pg.getByRole("button", { name: /Send round/ }).waitFor({ timeout: 15000 });
      check(`${at}: the note goes once the questions are in`, (await note.count()) === 0);

      // Between rounds: "Preparing round 2 · reading your answers" with the note.
      await pg.getByRole("button", { name: /Send round/ }).click();
      await note.waitFor({ timeout: 10000 });
      const status = (await pg.locator(".intro .status").innerText()).trim();
      check(`${at}: between rounds, the status line and the note`, /Preparing round 2/.test(status) && (await note.innerText()) === NOTE, status);
      check(`${at}: between rounds fits`, (await fits(pg, [".intro .status", "[data-testid=wait-note]", ".bar"])).length === 0, (await fits(pg, [".intro .status", "[data-testid=wait-note]", ".bar"])).join("; "));
      await shot("2-between-rounds");
      if (at === "light 320") await axe(pg, `${at}: between rounds`);
      await pg.getByRole("button", { name: /Send round/ }).waitFor({ timeout: 15000 });

      // Past the timeout: slow, not failed. Retry stays, and carries on.
      s.mode({ FAKE_DELAY_MS: "15000" });
      await pg.getByRole("button", { name: /Send round/ }).click();
      const card = pg.locator("[data-testid=problem][data-code=timeout]");
      await card.waitFor({ timeout: 15000 });
      const text = await card.innerText();
      check(`${at}: the timeout card says “${TITLE}”`, text.includes(TITLE) && text.includes(BODY), text.replace(/\s+/g, " "));
      check(`${at}: and never that the reply failed`, !/didn.t come through|fail|stopped responding/i.test(text));
      check(`${at}: the card is the quiet kind (clock, info tone)`, (await card.getAttribute("data-tone")) === "info");
      check(`${at}: Retry is there`, await card.getByRole("button", { name: "Retry" }).isVisible());
      const focused = () => pg.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`);
      await pg.waitForFunction(() => document.activeElement?.textContent?.trim() === "Retry", null, { timeout: 3000 }).catch(() => {});
      check(`${at}: focus moves to Retry, not the page (review-pr26 #4)`, (await focused()) === "BUTTON:Retry", await focused());
      check(`${at}: timeout card fits`, (await fits(pg, ["[data-testid=problem]", "[data-testid=problem] button"])).length === 0, (await fits(pg, ["[data-testid=problem]", "[data-testid=problem] button"])).join("; "));
      await pg.mouse.move(0, 0);
      await shot("3-timeout");
      if (theme === "dark") await axe(pg, `${at}: timeout card`);
      // A real failure (an unreadable reply on Retry): the error card, focus on its Retry.
      s.mode({ FAKE_MODE: "garbage" });
      await card.getByRole("button", { name: "Retry" }).click();
      const errCard = pg.locator("[data-testid=problem]:not([data-code=timeout])");
      await errCard.waitFor({ timeout: 30000 });
      const et = (await errCard.innerText()).replace(/\s+/g, " ");
      check(`${at}: an unreadable reply shows the error card, with curly apostrophes`, !/'/.test(et), et);
      await pg.waitForFunction(() => document.activeElement?.textContent?.trim() === "Retry", null, { timeout: 3000 }).catch(() => {});
      check(`${at}: after the error, focus moves to Retry (review-pr26 #4)`, (await focused()) === "BUTTON:Retry", await focused());
      check(`${at}: error card fits`, (await fits(pg, ["[data-testid=problem]", "[data-testid=problem] button"])).length === 0);
      await pg.mouse.move(0, 0);
      await shot("4-error");
      if (theme === "light") await axe(pg, `${at}: error card`);
      s.mode({});
      await errCard.getByRole("button", { name: "Retry" }).click();
      await pg.getByRole("button", { name: /Yes, plate it/ }).waitFor({ timeout: 15000 });
      check(`${at}: Retry carries on to the confirm step`, (await pg.locator("[data-testid=problem]").count()) === 0);

      await ctx.close();
      await s.stop();

      // review-pr26 r2 must 1 + 2: at 60 s just "Still cooking…" (the note stays, Stop appears); Stop gives its own quiet card.
      const s2 = await server({ GRILLADO_TIMEOUT_MS: "120000" });
      const phone = vp.tag === "320";
      const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "no-preference", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
      await ctx2.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const p2 = await ctx2.newPage();
      await p2.clock.install();
      const shot2 = async (name) => SHOTS && p2.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${vp.tag}.png`) });
      s2.mode({ FAKE_DELAY_MS: "110000" });
      await p2.goto(s2.url);
      const pick2 = p2.getByRole("radio", { name: /Grok/ });
      if (await pick2.isVisible().catch(() => false)) {
        await pick2.click();
        await p2.getByRole("button", { name: /Continue/ }).click();
      }
      await p2.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await p2.keyboard.press("Enter");
      await p2.getByTestId("wait-note").waitFor({ timeout: 10000 });
      // #26 follow-ups 2: before Stop appears (20 s) and after (65 s), the status line is the same height on a phone.
      const statusH = async (sel) => Math.round(((await p2.locator(sel).first().boundingBox())?.height ?? 0) * 10) / 10;
      await p2.clock.fastForward("00:20");
      await p2.locator(".intro .status").getByText("Still cooking…").waitFor({ timeout: 5000 });
      const h20 = await statusH(".intro .status");
      await p2.mouse.move(0, 0);
      await shot2("7-twenty-seconds");
      await p2.clock.fastForward("00:45");
      const stop = p2.locator(".intro .status").getByRole("button", { name: "Stop" });
      await stop.waitFor({ timeout: 5000 });
      const h65 = await statusH(".intro .status");
      if (phone) check(`${at}: on a phone the status line keeps its height when Stop appears at 60 s`, h20 === h65 && h65 >= 44, `${h20} → ${h65}`);
      const label = (await p2.locator(".intro .status > span:not(.ember)").first().innerText()).trim();
      check(`${at}: at 60 s the status says just “Still cooking…”`, label === "Still cooking…", label);
      check(`${at}: at 60 s the note stays, and nothing says “taking a while”`, (await p2.getByTestId("wait-note").innerText()) === NOTE && !/taking a while/i.test(await p2.locator("main, body").first().innerText()));
      if (phone) {
        const h = (await stop.boundingBox())?.height ?? 0;
        check(`${at}: on a phone the 60 s Stop is at least 44 px tall`, h >= 44, `${h}`);
      }
      check(`${at}: the 60 s state fits`, (await fits(p2, [".intro .status", "[data-testid=wait-note]"])).length === 0, (await fits(p2, [".intro .status", "[data-testid=wait-note]"])).join("; "));
      await p2.mouse.move(0, 0);
      await shot2("5-sixty-seconds");
      if (theme === "dark") await axe(p2, `${at}: 60 s`);
      await stop.click();
      const sc = p2.locator("[data-testid=problem][data-stopped]");
      await sc.waitFor({ timeout: 10000 });
      const st = (await sc.innerText()).replace(/\s+/g, " ").trim();
      check(`${at}: after Stop, “You stopped Grok” / “Your answers are saved. Retry when you’re ready.”`, st.includes("You stopped Grok") && st.includes("Your answers are saved. Retry when you’re ready."), st);
      check(`${at}: the stopped card is quiet (info tone), never “Can’t reach the agent”`, (await sc.getAttribute("data-tone")) === "info" && !/Can.t reach|couldn.t|fail/i.test(st));
      await p2.waitForFunction(() => document.activeElement?.textContent?.trim() === "Retry", null, { timeout: 3000 }).catch(() => {});
      const f2 = await p2.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`);
      check(`${at}: after Stop, focus moves to Retry`, f2 === "BUTTON:Retry", f2);
      if (phone) {
        const h = (await sc.getByRole("button", { name: "Retry" }).boundingBox())?.height ?? 0;
        check(`${at}: on a phone the card's Retry is at least 44 px tall`, h >= 44, `${h}`);
      }
      check(`${at}: the stopped card fits`, (await fits(p2, ["[data-testid=problem]", "[data-testid=problem] button"])).length === 0);
      await p2.mouse.move(0, 0);
      await shot2("6-stopped");
      if (theme === "light") await axe(p2, `${at}: stopped card`);
      s2.mode({});
      await sc.getByRole("button", { name: "Retry" }).click();
      await p2.getByRole("button", { name: /Send round/ }).waitFor({ timeout: 15000 });
      check(`${at}: Retry after Stop gets the round`, (await p2.locator("[data-testid=problem]").count()) === 0);

      // #26 follow-ups 3: plating says "Still writing the plan…" from 15 s with the same quiet note as rounds,
      // never "taking a while"; Stop comes at 60 s without moving anything on a phone.
      const plate = p2.getByRole("button", { name: /Yes, plate it/ });
      for (let i = 0; i < 6 && !(await plate.isVisible().catch(() => false)); i++) {
        await p2.getByRole("button", { name: /Send round|Yes, plate it/ }).first().waitFor({ timeout: 15000 });
        if (await plate.isVisible().catch(() => false)) break;
        await p2.getByRole("button", { name: /Send round/ }).click();
        await p2.getByRole("button", { name: /Send round|Yes, plate it/ }).first().waitFor({ timeout: 15000 });
      }
      s2.mode({ FAKE_DELAY_MS: "110000" });
      // The page clock is still 65 s ahead from the round above; plating counts from its own start.
      await p2.clock.setSystemTime(Date.now());
      await plate.click();
      const pst = p2.locator(".status[role=status]").first();
      await pst.getByText(/Plating your plan from/).waitFor({ timeout: 10000 });
      check(`${at}: plating starts with “Plating your plan from …”, the note under it`, (await p2.getByTestId("wait-note").innerText()) === PLATE_NOTE);
      await p2.clock.fastForward("00:20");
      await pst.getByText("Still writing the plan…").waitFor({ timeout: 5000 });
      const ph20 = await statusH(".status[role=status]");
      check(`${at}: at 15 s plating says just “Still writing the plan…”, with “${PLATE_NOTE}”`, (await pst.innerText()).trim() === "Still writing the plan…" && (await p2.getByTestId("wait-note").innerText()) === PLATE_NOTE, (await pst.innerText()).trim());
      check(`${at}: plating at 20 s fits`, (await fits(p2, [".status", "[data-testid=wait-note]"])).length === 0, (await fits(p2, [".status", "[data-testid=wait-note]"])).join("; "));
      await p2.mouse.move(0, 0);
      await shot2("8-plating-twenty-seconds");
      await p2.clock.fastForward("00:45");
      const pstop = pst.getByRole("button", { name: "Stop" });
      await pstop.waitFor({ timeout: 5000 });
      const plabel = (await pst.locator("> span").first().innerText()).trim();
      check(`${at}: at 60 s plating still says “Still writing the plan…”, never “taking a while”`, plabel === "Still writing the plan…" && !/taking a while/i.test(await p2.locator("body").innerText()), plabel);
      const ph65 = await statusH(".status[role=status]");
      if (phone) check(`${at}: on a phone the plating status keeps its height when Stop appears`, ph20 === ph65 && ph65 >= 44, `${ph20} → ${ph65}`);
      check(`${at}: plating at 60 s fits`, (await fits(p2, [".status", "[data-testid=wait-note]"])).length === 0, (await fits(p2, [".status", "[data-testid=wait-note]"])).join("; "));
      await p2.mouse.move(0, 0);
      await shot2("9-plating-sixty-seconds");
      if (theme === "dark") await axe(p2, `${at}: plating at 60 s`);
      s2.mode({});
      await pstop.click();
      await p2.locator("[data-testid=problem][data-stopped]").waitFor({ timeout: 10000 });
      await ctx2.close();
      await s2.stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
