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
const TITLE = "Grok is running slow";
const BODY = "It hasn’t answered yet, so Grillado stopped waiting. Your answers are saved.";
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
      check(`${at}: and never that the reply failed`, !/didn.t come through|Nothing came back|fail/i.test(text));
      check(`${at}: the card is the quiet kind (clock, info tone)`, (await card.getAttribute("data-tone")) === "info");
      check(`${at}: Retry is there`, await card.getByRole("button", { name: "Retry" }).isVisible());
      const focused = () => pg.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.textContent?.trim()}`);
      await pg.waitForFunction(() => document.activeElement?.textContent?.trim() === "Retry", null, { timeout: 3000 }).catch(() => {});
      check(`${at}: focus moves to Retry, not the page (review-pr26 #4)`, (await focused()) === "BUTTON:Retry", await focused());
      check(`${at}: timeout card fits`, (await fits(pg, ["[data-testid=problem]", "[data-testid=problem] button"])).length === 0, (await fits(pg, ["[data-testid=problem]", "[data-testid=problem] button"])).join("; "));
      await pg.mouse.move(0, 0);
      await shot("3-timeout");
      if (theme === "dark") await axe(pg, `${at}: timeout card`);
      s.mode({});
      await card.getByRole("button", { name: "Retry" }).click();
      await pg.getByRole("button", { name: /Yes, plate it/ }).waitFor({ timeout: 15000 });
      check(`${at}: Retry carries on to the confirm step`, (await card.count()) === 0);

      await ctx.close();
      await s.stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
