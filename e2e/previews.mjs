// Option previews ("See before you choose"): a question whose options carry a UI mock, a code sketch
// or a diagram shows a small look at each; Compare shows them side by side (one at a time on a phone,
// with Previous and Next); choosing there doesn't send the round; number keys and Enter work as before;
// Show me another adds one option (up to six), survives a reload and fails without losing anything;
// the chosen preview's source is in the saved plan. Security, in a real browser: a UI mock that tries a
// script, requests, a form and a redirect reaches nothing. Fake agent CLIs; dark, light, 390px; axe.
//   CHROME_PATH=… node e2e/previews.mjs        (SHOTS=<dir> also saves screenshots)
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { until } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-previews-")));
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
const shot = async (pg, name) => SHOTS && pg.screenshot({ path: path.join(SHOTS, `${name}.png`) });

// Anything the mock manages to request lands here.
const hits = [];
const trap = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
  res.end("x");
});
await new Promise((r) => trap.listen(0, "127.0.0.1", r));
const TRAP = `http://127.0.0.1:${trap.address().port}/`;

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
  const log = path.join(home, "calls.jsonl");
  const ctl = path.join(home, "ctl.json");
  writeFileSync(ctl, "{}");
  const e = { PATH: `${fakeBins(["claude"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_LOG: log, FAKE_CTL: ctl, FAKE_PREVIEW_EVIL_URL: TRAP, ...extra };
  const child = spawn(NODE, [path.join(ROOT, "dist/cli.js"), "--no-open", "--no-scan"], { cwd: home, env: e, stdio: ["ignore", "pipe", "pipe"] });
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
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "--version");
    } catch {
      return [];
    }
  };
  return {
    url,
    home,
    calls,
    ctl: (o) => writeFileSync(ctl, JSON.stringify(o)),
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
}
async function axe(pg, name) {
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
const noScroll = (pg) => pg.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".scroll, .solo")].every((e) => e.scrollWidth <= e.clientWidth + 1));
async function startRound(pg, url, idea = "A shared shopping list") {
  await pg.goto(url);
  await pg.locator("textarea.tx").fill(idea);
  await pg.keyboard.press("Enter");
  await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
}
const card = (pg, key) => pg.locator(`[data-testid=question][data-key=${key}]`);
const checked = (pg, key) => card(pg, key).locator("[data-slot=agent-question-option][data-selected]").first().innerText();
const tiles = (pg) => card(pg, "platform").getByTestId("preview-tile");
const selectedTile = (pg) => card(pg, "platform").locator("[data-testid=preview-tile][data-selected] .nm").innerText();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  // ---------------------------------------------------------------- UI mocks, with a hostile one
  const srv = await server({ FAKE_PREVIEWS: "evil" });
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    // The init script runs in the mocks' frames too, where storage is refused (they have an origin of their own).
    await ctx.addInitScript((t) => { try { localStorage.setItem("grillado-theme", t); } catch {} }, theme);
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push(String(e)));
    await startRound(pg, srv.url);
    await tiles(pg).first().waitFor();
    check(`${theme}: the question with previews shows one tile per option`, (await tiles(pg).count()) === 3);
    check(`${theme}: a question without previews shows none`, (await card(pg, "scope").getByTestId("previews").count()) === 0);
    await pg.waitForTimeout(600); // let the frames try whatever they try
    await shot(pg, `round-${theme}`);
    await axe(pg, `${theme} round with previews`);

    if (theme === "dark") {
      // The frame: an empty sandbox, its own policy, and nothing reaches the network or the page.
      const frame = tiles(pg).first().locator("iframe");
      check("a UI mock is in a frame with an empty sandbox", (await frame.getAttribute("sandbox")) === "");
      const doc = await frame.getAttribute("srcdoc");
      check("the frame’s document carries a policy that loads nothing", /Content-Security-Policy" content="default-src 'none'/.test(doc));
      check("a redirect tag in the mock is taken out", !/http-equiv="refresh"/.test(doc));
      check("the page is untouched by the mock’s script", (await pg.title()) !== "escaped" && errors.length === 0, `${await pg.title()} ${errors.join(";")}`);
      const inner = await pg.frames().find((f) => f !== pg.mainFrame() && f.parentFrame() === pg.mainFrame())?.evaluate(() => ({ title: document.title, cookie: (() => { try { return document.cookie; } catch { return "blocked"; } })() })).catch((e) => String(e));
      check("the mock’s script never ran in its frame", typeof inner === "string" || inner?.title !== "ran", JSON.stringify(inner));
      check("the mock rendered", /shopping list/.test(await pg.frameLocator("[data-testid=preview-tile] iframe").first().locator("h1").innerText()));

      // Number keys and clicks choose; the option rows stay in step.
      await pg.locator("body").click({ position: { x: 5, y: 5 } });
      await pg.evaluate(() => document.activeElement?.blur());
      check("the suggested option’s tile starts selected", (await selectedTile(pg)) === "Web app");
      await card(pg, "platform").locator("[role=radio]").first().focus();
      await pg.keyboard.press("2");
      await until(async () => (await selectedTile(pg)) === "Mobile app", "tile 2 selected");
      check("a number key chooses the option and its tile", (await checked(pg, "platform")).includes("Mobile app"));
      await tiles(pg).nth(2).locator(".pv-pick").click();
      await until(async () => (await checked(pg, "platform")).includes("Command line"), "option 3 checked");
      check("a click on a tile chooses its option", (await selectedTile(pg)) === "Command line");

      // Compare: side by side, choose without sending, Escape returns focus.
      const compare = card(pg, "platform").getByTestId("compare");
      await compare.focus();
      await pg.keyboard.press("Enter");
      const dlg = pg.getByTestId("compare-dialog");
      await dlg.waitFor();
      const cols = dlg.getByTestId("compare-col");
      check("Compare shows every option side by side", (await cols.count()) === 3 && (await cols.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size)) === 1);
      check("Compare uses the full width", (await dlg.evaluate((e) => e.getBoundingClientRect().width)) > 1100);
      check("the chosen option is marked in Compare", (await dlg.locator("[data-testid=compare-col][data-selected] b").innerText()) === "Command line");
      await pg.waitForTimeout(400);
      await shot(pg, "compare-dark");
      await axe(pg, "Compare");
      await pg.keyboard.press("1");
      await until(async () => (await dlg.locator("[data-testid=compare-col][data-selected] b").innerText()) === "Web app", "column 1 chosen");
      check("a number key chooses inside Compare", (await checked(pg, "platform")).includes("Web app"));
      await cols.nth(1).getByTestId("compare-choose").click();
      await until(async () => (await checked(pg, "platform")).includes("Mobile app"), "column 2 chosen");
      check("Choose picks the option and the round is not sent", (await pg.getByTestId("question").count()) === 2 && (await dlg.isVisible()));
      // The mock's form can't be sent, even by a real click in the full-size frame.
      await dlg.frameLocator("iframe").first().locator("#send").click({ timeout: 3000 }).catch(() => null);
      await pg.waitForTimeout(500);
      // The click left the keyboard focus inside the mock's frame, where keys stay; back to the dialog first.
      await dlg.locator(".fh b").click();
      await pg.keyboard.press("Escape");
      await until(async () => !(await dlg.isVisible()), "Compare closed");
      const back = await until(() => compare.evaluate((el) => el === document.activeElement), "focus back on Compare", 2000).catch(() => false);
      check("Escape closes Compare and focus returns to its button", back);

      // Show me another: fails without losing anything, then works; survives a reload; stops at six.
      const another = card(pg, "platform").getByTestId("another");
      srv.ctl({ FAKE_ANOTHER: "fail" });
      await another.click();
      await card(pg, "platform").getByTestId("another-error").waitFor({ timeout: 15000 });
      check("a failed request says so and keeps the options", (await tiles(pg).count()) === 3 && (await card(pg, "platform").getByTestId("another-error").innerText()).includes("Couldn’t add another option."));
      check("and the choice made so far is kept", (await checked(pg, "platform")).includes("Mobile app"));
      srv.ctl({ FAKE_ANOTHER: "" });
      await card(pg, "platform").getByRole("button", { name: "Try again" }).click();
      await until(async () => (await tiles(pg).count()) === 4, "a fourth option", 15000);
      check("Try again adds one option with its preview", (await tiles(pg).nth(3).locator(".nm").innerText()) === "Option 4" && (await tiles(pg).nth(3).locator("iframe").count()) === 1);
      const inView = await until(() => tiles(pg).nth(3).evaluate((el) => { const r = el.getBoundingClientRect(); const box = el.parentElement.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; }), "the new tile in view", 4000).catch(() => false);
      check("the new option is brought into view", !!inView);
      check("the new option is a row too, and still nothing was sent", (await card(pg, "platform").locator("[role=radio]").count()) >= 4 && (await checked(pg, "platform")).includes("Mobile app"));
      await pg.reload();
      await tiles(pg).first().waitFor();
      check("the added option survives a reload", (await tiles(pg).count()) === 4);
      for (const n of [5, 6]) {
        await another.click();
        await until(async () => (await tiles(pg).count()) === n, `option ${n}`, 15000);
      }
      check("at six options Show me another is off, and says why", (await another.isDisabled()) && (await card(pg, "platform").getByTestId("previews").innerText()).includes("6 options is the most a question holds"));
      await pg.keyboard.press("Escape");
      await card(pg, "platform").locator("[role=radio]").first().focus();
      await pg.keyboard.press("5");
      await until(async () => (await selectedTile(pg)) === "Option 5", "option 5 by key");
      check("number keys reach the added options", true);
      await axe(pg, "six options with previews");

      // Enter in Compare sends the round with what is chosen.
      await compare.click();
      await dlg.waitFor();
      await pg.keyboard.press("4");
      await until(async () => (await dlg.locator("[data-testid=compare-col][data-selected] b").innerText()) === "Option 4", "option 4 in Compare");
      await pg.keyboard.press("Enter");
      await until(async () => (await card(pg, "storage").count()) === 1, "round 2", 15000);
      check("Enter in Compare sends the round", !(await dlg.isVisible()));
      await pg.getByRole("button", { name: /Send round|Send and wrap up/ }).first().click();
      await pg.getByRole("button", { name: /Yes, plate it/ }).waitFor({ timeout: 15000 });
      await pg.keyboard.press("Enter");
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      const plansDir = path.join(srv.home, "docs", "plans");
      const md = readFileSync(path.join(plansDir, readdirSync(plansDir)[0]), "utf8");
      check("the saved plan has the chosen preview’s source, as HTML", /## Chosen previews\n\n### Platform: Option 4\n\n```html\n<style>/.test(md));
      check("and not the previews of options that weren’t chosen", !md.includes("Web app: shopping list"));
      await pg.waitForTimeout(300);
      check("nothing the mock tried reached the network", hits.length === 0, hits.join(", "));
    }
    await ctx.close();
  }
  await srv.stop();

  // ---------------------------------------------------------------- code sketches and diagrams
  for (const kind of ["code", "diagram"]) {
    const s = await server({ FAKE_PREVIEWS: kind });
    const pg = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await startRound(pg, s.url);
    await tiles(pg).first().waitFor();
    if (kind === "code") {
      check("a code sketch is shown as highlighted text", (await tiles(pg).first().locator("pre.pv-code .tk-c").first().innerText()).includes("// Web app") && (await tiles(pg).first().locator("pre.pv-code .tk-k").count()) > 0);
      check("and never as markup", (await tiles(pg).first().locator("iframe").count()) === 0);
    } else {
      await tiles(pg).first().locator("svg").waitFor({ timeout: 15000 });
      const drawn = await until(async () => (await tiles(pg).locator("svg").count()) === 3, "three diagrams", 15000).catch(() => false);
      check("a diagram is drawn for every option", !!drawn);
    }
    await card(pg, "platform").getByTestId("compare").click();
    await pg.getByTestId("compare-dialog").waitFor();
    if (kind === "diagram") await pg.getByTestId("compare-dialog").locator("svg").first().waitFor({ timeout: 15000 });
    await pg.waitForTimeout(300);
    await shot(pg, `compare-${kind}`);
    await axe(pg, `Compare with ${kind} previews`);
    await pg.keyboard.press("Escape");
    await pg.close();
    await s.stop();
  }

  // ---------------------------------------------------------------- a preview that can't be shown
  const part = await server({ FAKE_PREVIEWS: "partial" });
  const pp = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await startRound(pp, part.url);
  await tiles(pp).first().waitFor();
  check("an option whose preview can’t be shown says so", (await tiles(pp).nth(1).innerText()).includes("No preview for this one") && (await tiles(pp).nth(0).locator("iframe").count()) === 1);
  await tiles(pp).nth(1).locator(".pv-pick").click();
  await until(async () => (await checked(pp, "platform")).includes("Mobile app"), "text option chosen");
  await pp.getByRole("button", { name: "Send round" }).click();
  await until(async () => (await card(pp, "storage").count()) === 1, "round 2 after a text answer", 15000);
  check("and it can still be chosen and sent", true);
  await pp.close();
  await part.stop();

  // ---------------------------------------------------------------- phones
  const ph = await server({ FAKE_PREVIEWS: "ui" });
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await m.newPage();
  await startRound(mp, ph.url);
  await tiles(mp).first().waitFor();
  check("390px: the round with previews doesn’t scroll sideways", await noScroll(mp));
  // A tap in a card that isn't the active one must land where it was aimed: making it active may
  // not change the layout above it (its place in the page, whatever the scroll position).
  const place = () => card(mp, "platform").getByTestId("compare").evaluate((el) => el.getBoundingClientRect().y + (el.closest(".scroll")?.scrollTop ?? 0));
  const before = await place();
  await card(mp, "platform").locator(".q-t").tap();
  await mp.waitForTimeout(500);
  // A few pixels still move (the active card's own rows); a whole line (25px) used to, enough to miss a button.
  check("390px: making a card active doesn’t move its content by a line", Math.abs((await place()) - before) < 8, `${before} → ${await place()}`);
  await mp.reload();
  await tiles(mp).first().waitFor();
  check("390px: the tiles scroll inside their own row", await card(mp, "platform").locator(".pv-row").evaluate((e) => e.scrollWidth > e.clientWidth));
  await shot(mp, "round-phone");
  // The bottom bar covers the foot of the scroll area: bring the button to the middle before tapping it.
  await card(mp, "platform").getByTestId("compare").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await card(mp, "platform").getByTestId("compare").tap();
  const mdlg = mp.getByTestId("compare-dialog");
  await mdlg.waitFor();
  check("390px: Compare shows one option at a time", (await mdlg.getByTestId("compare-col").count()) === 1 && (await mdlg.getByTestId("compare-pos").innerText()) === "1 of 3");
  check("390px: Previous is off on the first", await mdlg.getByTestId("compare-prev").isDisabled());
  await mdlg.getByTestId("compare-next").tap();
  await until(async () => (await mdlg.getByTestId("compare-pos").innerText()) === "2 of 3", "second option");
  check("390px: Next moves to the next option", (await mdlg.locator("[data-testid=compare-col] b").innerText()) === "Mobile app");
  check("390px: moving doesn’t choose", (await checked(mp, "platform")).includes("Web app"));
  await mdlg.getByTestId("compare-choose").tap();
  await until(async () => (await checked(mp, "platform")).includes("Mobile app"), "chosen on the phone");
  check("390px: Choose is its own action, and the round isn’t sent", (await mp.getByTestId("question").count()) === 2);
  await mdlg.getByTestId("compare-next").tap();
  await mdlg.getByTestId("compare-next").isDisabled();
  await mdlg.getByTestId("compare-prev").tap();
  check("390px: Previous goes back", (await mdlg.getByTestId("compare-pos").innerText()) === "2 of 3");
  // The phone's system theme is light and Grillado's is dark: the mock follows Grillado's.
  check("390px: the mock is shown in Grillado’s theme, not the system’s", /color-scheme:dark/.test(await mdlg.locator("iframe").getAttribute("srcdoc")) && !/prefers-color-scheme/.test(await mdlg.locator("iframe").getAttribute("srcdoc")));
  check("390px: Compare fits the screen", await mdlg.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= innerWidth));
  await mp.waitForTimeout(300);
  await shot(mp, "compare-phone");
  await axe(mp, "phone Compare");
  await m.close();
  await ph.stop();
} catch (err) {
  failures++;
  console.log(`FAIL  ${err?.stack ?? err}`);
} finally {
  await browser.close();
  trap.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
