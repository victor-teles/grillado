// Plan 003, while the agent reads the project: "Reading {project}…" with the last three things it
// opened and a file count, Skip reading from 10 s (the round comes back without reading), "Ask
// without reading" when a reading run fails, and "Not right" on a finding (keyboard, undo). Dark and
// light with axe, 390px, reduced motion. Fake agent CLIs; one server and one browser at a time.
//   CHROME_PATH=… node e2e/reading.mjs
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { until } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-reading-")));
const NODE = process.execPath;
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function fakeBins() {
  const dir = mkdtempSync(path.join(WORK, "bin-"));
  writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" claude "$@"\n`);
  chmodSync(path.join(dir, "claude"), 0o755);
  return dir;
}
function gitProject() {
  const root = path.join(mkdtempSync(path.join(WORK, "p-")), "recipes");
  mkdirSync(path.join(root, "src", "editor"), { recursive: true });
  for (const f of ["package.json", "README.md", "src/editor/autosave.ts", "src/store.ts"]) writeFileSync(path.join(root, f), "x");
  writeFileSync(path.join(root, ".env"), "TOKEN=x");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});
async function server(cwd, ctl) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const log = path.join(home, "calls.jsonl");
  const e = { PATH: `${fakeBins()}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_LOG: log, FAKE_CTL: ctl };
  const child = spawn(NODE, [path.join(ROOT, "dist/cli.js"), "--no-open", "--no-scan"], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] });
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
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "--version");
    } catch {
      return [];
    }
  };
  return { url, calls };
}
async function axe(pg, name) {
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
const isRead = (c) => c.args.includes("Read,Grep,Glob");
const noScroll = (pg) => pg.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".scroll")].every((e) => e.scrollWidth <= e.clientWidth + 1));
const setCtl = (file, o) => writeFileSync(file, JSON.stringify(o));
async function start(pg, url, idea) {
  await pg.goto(url);
  await pg.getByTestId("read-chip").waitFor();
  await pg.locator("textarea.tx").fill(idea);
  await pg.keyboard.press("Enter");
}

const TRAIL = "Glob:**/*,Read:package.json,Read:.env,Grep:autosave,Read:src/editor/autosave.ts,Read:README.md,Read:src/store.ts";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const project = gitProject();
  const ctl = path.join(WORK, "ctl.json");
  setCtl(ctl, { FAKE_READ_TRAIL: TRAIL, FAKE_READ_TRAIL_MS: "1800" });
  const srv = await server(project, ctl);

  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: theme === "light" ? "reduce" : "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    await start(pg, srv.url, `Offline drafts ${theme}`);
    const status = pg.locator(".reads [role=status]");
    await status.waitFor({ timeout: 10000 });
    check(`${theme}: the wait names the project it reads`, (await status.innerText()).includes("Reading recipes…"));
    const trail = pg.getByTestId("reading-trail");
    await trail.waitFor({ timeout: 10000 });
    await until(async () => (await trail.locator("li").count()) === 3, "three trail lines", 12000).catch(() => null);
    const lines = await trail.locator("li").allInnerTexts();
    check(`${theme}: at most three recent lines, never a secret`, lines.length <= 3 && lines.length > 0 && !lines.some((l) => l.includes(".env")), lines.join(" | "));
    check(`${theme}: searches show as the agent sent them`, (await trail.innerText()).includes("search: autosave") || lines.some((l) => l.includes("autosave")));
    const note = pg.getByTestId("wait-note");
    await until(async () => /\d+ files? read · Reading a project can take a few minutes\./.test(await note.innerText()), "count line", 8000).catch(() => null);
    check(`${theme}: the count line says how many files`, /\d+ files? read · Reading a project can take a few minutes\./.test(await note.innerText()), await note.innerText());
    if (theme === "light") {
      const t = await trail.locator("li").last().evaluate((el) => getComputedStyle(el).transitionDuration);
      check("reduced motion: trail lines appear without a transition", t === "0s", t);
    }
    await axe(pg, `${theme} reading wait`);
    // Skip reading shows from 10 s and brings the round back without reading.
    const skip = pg.getByTestId("skip-reading");
    await skip.waitFor({ timeout: 15000 });
    const before = srv.calls().length;
    await skip.click();
    await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
    const rerun = srv.calls().slice(before);
    check(`${theme}: Skip reading reruns the round without reading`, rerun.length >= 1 && rerun.every((c) => !isRead(c)), rerun.map((c) => c.cwd).join(","));
    check(`${theme}: and the round has no Found in your code`, (await pg.getByTestId("found-in-code").count()) === 0);
    await ctx.close();
  }

  // Phones: the wait screen never scrolls sideways, long paths truncate.
  {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const mp = await m.newPage();
    await start(mp, srv.url, "Offline drafts on a phone");
    await mp.getByTestId("reading-trail").waitFor({ timeout: 10000 });
    check("390px: the reading wait has no sideways scroll", await noScroll(mp));
    await axe(mp, "phone reading wait");
    await m.close();
  }

  // Ask without reading: a reading run that fails can be asked again without reading.
  {
    setCtl(ctl, { FAKE_MODE: "garbage" });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    await start(pg, srv.url, "Offline drafts that fail");
    const ask = pg.getByTestId("ask-without-reading");
    await ask.waitFor({ timeout: 15000 });
    check("a failed reading run offers Ask without reading, with Retry still the primary", (await pg.getByTestId("problem").locator(".btn.primary").innerText()).includes("Retry"));
    setCtl(ctl, {});
    const before = srv.calls().length;
    await ask.click();
    await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
    check("Ask without reading brings a round, without reading", srv.calls().slice(before).every((c) => !isRead(c)));

    // Not right on a finding, by keyboard, then undo. A fresh reading session (no trail this time).
    await start(pg, srv.url, "Offline drafts to correct");
    await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
    const found = pg.getByTestId("found-in-code");
    await found.locator("summary").focus();
    await pg.keyboard.press("Enter");
    const notRight = found.getByRole("button", { name: /^Not right/ });
    await notRight.focus();
    await pg.keyboard.press("Enter");
    const input = found.getByLabel("What’s true instead?");
    await input.waitFor();
    check("Not right opens a field with focus in it", await input.evaluate((el) => el === document.activeElement));
    await pg.keyboard.type("It’s a Bun workspace");
    const rounds = srv.calls().length;
    await pg.keyboard.press("Enter");
    const row = found.getByTestId("finding").first();
    await until(async () => (await row.getAttribute("data-corrected")) !== null, "corrected", 5000).catch(() => null);
    check("Enter saves the correction, struck through with yours beneath", (await row.getAttribute("data-corrected")) !== null && (await row.locator("del").count()) === 1 && (await row.innerText()).includes("It’s a Bun workspace"));
    check("and doesn’t send the round", srv.calls().length === rounds && (await pg.getByTestId("question").count()) > 0);
    await axe(pg, "a corrected finding");
    await row.getByRole("button", { name: "Undo" }).click();
    await until(async () => (await row.getAttribute("data-corrected")) === null, "undone", 5000).catch(() => null);
    check("Undo puts the finding back", (await row.getAttribute("data-corrected")) === null);
    // Escape cancels and returns focus to Not right.
    await found.getByRole("button", { name: /^Not right/ }).click();
    await found.getByLabel("What’s true instead?").waitFor();
    await pg.keyboard.press("Escape");
    const back = await until(() => found.getByRole("button", { name: /^Not right/ }).evaluate((el) => el === document.activeElement), "focus back", 2000).catch(() => false);
    check("Escape cancels and focus returns to Not right", back);
    await ctx.close();
  }
} catch (err) {
  failures++;
  console.log(`FAIL  ${err?.stack ?? err}`);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
