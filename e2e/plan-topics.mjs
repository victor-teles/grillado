// Open lines and Out of scope lines of a written plan can both be acted on.
//  1. An open line the plan writer listed by itself (no decision block, no queued topic) is counted
//     open, so it is also shown: the "still needs an answer" banner, and "Not asked yet" on the
//     Decisions tab. "Answer remaining questions" asks it, and the plan is written again with 0 open.
//  2. Each line under "Out of scope" has "Plan it": Bring into this plan (the agent asks about it and
//     the plan is written again with it in scope), or Start a new plan (Home's composer, filled in;
//     nothing is sent until the user sends it).
// Uses the built dist/cli.js (or GRILLADO_CLI) and the fake claude; never a real agent.
//   node e2e/plan-topics.mjs            checks only
//   SHOTS=dir node e2e/plan-topics.mjs  also writes screenshots to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = process.env.GRILLADO_CLI ?? path.join(ROOT, "dist/cli.js");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-topics-"));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPEN = "Recover the exact size limits approved in round 2; the state does not include them.";
const SCOPE = ["Offline mode.", "Sharing a list with people **outside** the household."];
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});
async function server(extra = {}) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const bin = mkdtempSync(path.join(WORK, "bin-"));
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" claude "$@"\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const e = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, ...extra };
  const child = spawn(NODE, [CLI, "--no-open", "--max-rounds", "2"], { cwd: home, env: e, stdio: ["ignore", "pipe", "pipe"] });
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
async function axe(pg, name) {
  await pg.mouse.move(0, 0);
  await pg.waitForFunction(() => document.getAnimations().every((x) => !(x instanceof CSSTransition) || x.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""}`).join("; "));
}
const sideways = (pg) => pg.evaluate(() => document.scrollingElement.scrollWidth > document.documentElement.clientWidth);

/** From Home to a written plan: two rounds with the suggested picks, then Yes, plate it. */
async function toPlan(pg, url) {
  await pg.goto(url);
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
  await pg.keyboard.press("Enter");
  for (let i = 0; i < 2; i++) {
    await pg.getByRole("button", { name: /Send round/ }).click({ timeout: 20000 });
    await pg.getByRole("button", { name: /Send round/ }).waitFor({ state: "detached", timeout: 10000 });
  }
  await plate(pg);
}
async function plate(pg) {
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 20000 });
  await pg.getByRole("tab", { name: /Decisions/ }).waitFor({ timeout: 20000 });
  await pg.locator(".planv:not([data-waiting])").waitFor();
}
/** The one question of a round made from a line of the plan: answer it, then write the plan again. */
async function answerAndPlate(pg) {
  await pg.getByRole("button", { name: /Send round/ }).click({ timeout: 20000 });
  await plate(pg);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    for (const vp of [{ tag: "desktop", width: 1440, height: 900 }, { tag: "390", width: 390, height: 844, touch: true }]) {
      const at = `${theme} ${vp.tag}`;
      const s = await server({ FAKE_PLAN_OPEN: OPEN, FAKE_PLAN_SCOPE: SCOPE.join("|") });
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.touch, isMobile: !!vp.touch, reducedMotion: "reduce" });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const pg = await ctx.newPage();
      const shot = async (name) => SHOTS && pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${vp.tag}.png`) });
      await toPlan(pg, s.url);

      // 1. The writer's own open line: counted, shown, and askable.
      const tab = pg.getByRole("tab", { name: /Decisions/ });
      check(`${at}: the Decisions tab counts 1 open`, /1 open/.test(await tab.innerText()), await tab.innerText());
      const banner = pg.getByTestId("plan-open-actions");
      check(`${at}: the plan says 1 decision still needs an answer`, /1 decision still needs an answer/.test(await banner.innerText().catch(() => "")), await banner.innerText().catch(() => "no banner"));
      await tab.click();
      const notAsked = pg.locator("section[aria-labelledby=not-asked]");
      check(`${at}: the Decisions tab lists it under Not asked yet`, (await notAsked.innerText().catch(() => "")).includes(OPEN), await notAsked.innerText().catch(() => "no section"));
      await shot("1-open-line");
      if (at === "dark desktop") await axe(pg, `${at}: Decisions tab with a line not asked yet`);
      await banner.getByRole("button", { name: "Answer remaining questions" }).click();
      const title = pg.locator("[data-slot=agent-question-title]");
      await title.first().waitFor({ timeout: 20000 });
      check(`${at}: the agent asks that line, as one question`, (await title.count()) === 1 && (await title.first().innerText()).includes("Recover the exact size limits"), await title.first().innerText());
      await answerAndPlate(pg);
      check(`${at}: once answered, the plan has nothing open`, !/open/.test(await tab.innerText()) && (await banner.count()) === 0, await tab.innerText());

      // 2. Out of scope: the hint, and "Plan it" on each line.
      await pg.getByRole("tab", { name: "Document" }).click();
      const hint = pg.getByTestId("scope-hint");
      check(`${at}: Out of scope says its lines can still be picked up`, (await hint.innerText().catch(() => "")) === "Left out for now. Any line can still join this plan or start a new one.", await hint.innerText().catch(() => "no hint"));
      const menus = pg.getByTestId("scope-menu");
      check(`${at}: every Out of scope line has Plan it, named for its line`, (await menus.count()) === 2 && (await menus.nth(1).getAttribute("aria-label")) === "Plan it: Sharing a list with people outside the household.", `${await menus.count()} ${await menus.nth(1).getAttribute("aria-label")}`);
      if (vp.touch) check(`${at}: on touch, Plan it shows without hover`, (await menus.first().evaluate((el) => getComputedStyle(el).opacity)) === "1");
      else {
        check(`${at}: Plan it stays out of the way until its line is hovered`, (await menus.first().evaluate((el) => getComputedStyle(el).opacity)) === "0");
        await pg.locator(".doc li", { hasText: "Offline mode." }).hover();
        const shown = await menus.first().evaluate((el) => new Promise((r) => {
          const t0 = performance.now();
          const tick = () => (getComputedStyle(el).opacity === "1" ? r(true) : performance.now() - t0 > 2000 ? r(false) : requestAnimationFrame(tick));
          tick();
        }));
        check(`${at}: hovering the line shows it`, shown);
      }
      check(`${at}: nothing scrolls sideways`, !(await sideways(pg)));
      await shot("2-out-of-scope");
      if (at === "light desktop" || at === "dark 390") await axe(pg, `${at}: plan with Out of scope lines`);
      if (!vp.touch) await pg.locator(".doc li", { hasText: "Offline mode." }).hover();
      await menus.first().click();
      const items = pg.getByRole("menuitem");
      check(`${at}: the menu offers this plan or a new one`, (await items.allInnerTexts()).map((t) => t.split("\n")[0]).join(" | ") === "Bring into this plan | Start a new plan", (await items.allInnerTexts()).join(" | "));
      check(`${at}: clicking Plan it doesn't open the block for editing`, (await pg.locator(".doc textarea, .doc .cm-editor").count()) === 0);
      await shot("3-menu");

      // Start a new plan: Home's composer, filled in and not sent.
      const planUrl = pg.url();
      await pg.getByTestId("scope-new").click();
      const idea = pg.getByRole("textbox", { name: "What are you planning?" });
      await idea.waitFor({ timeout: 10000 });
      check(`${at}: Start a new plan fills the idea with the line`, (await idea.inputValue()) === "Offline mode.", await idea.inputValue());
      const context = pg.getByRole("textbox", { name: /Context for the agent/ });
      check(`${at}: and says which plan it follows`, (await context.inputValue().catch(() => "")) === "This follows the plan “Plan: Shared shopping list for my household”, which left it out of scope.", await context.inputValue().catch(() => "no context"));
      check(`${at}: nothing is sent until you send it`, new URL(pg.url()).pathname === "/" && (await idea.evaluate((el) => el === document.activeElement)));
      await shot("4-new-plan");
      await pg.goto(planUrl);
      await pg.getByRole("tab", { name: /Decisions/ }).waitFor({ timeout: 20000 });

      // Bring into this plan: one question about it, then the plan is written again with it in scope.
      if (!vp.touch) await pg.locator(".doc li", { hasText: "Offline mode." }).hover();
      await pg.getByTestId("scope-menu").first().click();
      await pg.getByTestId("scope-in").click();
      await title.first().waitFor({ timeout: 20000 });
      const intro = await pg.locator(".intro").innerText();
      check(`${at}: the round says where its question came from`, /Adding to your plan/.test(intro) && /You brought this in from Out of scope\./.test(intro), intro.replace(/\n/g, " / "));
      check(`${at}: and asks about that line only`, (await title.count()) === 1 && (await title.first().innerText()).includes("Offline mode"), await title.first().innerText());
      await shot("5-round");
      await answerAndPlate(pg);
      // Each h2 of the plan with the lines under it; a line still out of scope ends in its Plan it button.
      const sections = await pg.locator("#ppanel-doc").evaluate((el) => {
        const out = {};
        let h = "";
        for (const node of el.querySelectorAll("h2, li")) {
          if (node.tagName === "H2") h = node.textContent.trim();
          else (out[h] ??= []).push(node.textContent.trim());
        }
        return out;
      });
      check(`${at}: the plan is written again with the line in scope`, (sections["Now in scope"] ?? []).join("|") === "Offline mode.", JSON.stringify(sections));
      check(`${at}: the other line is still out of scope, with its own Plan it`, (sections["Out of scope"] ?? []).join("|") === "Sharing a list with people outside the household.Plan it" && (await pg.getByTestId("scope-menu").count()) === 1, JSON.stringify(sections["Out of scope"]));
      await ctx.close();
      await s.stop();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
