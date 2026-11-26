// Plan 002, reading the project: Home's "Reads {project}" chip and its popover (keyboard, the
// checkbox kept across a reload and honoured at Start), a grounded round ("Found in your code",
// "From your code" on the card that has evidence and not on the one without), number keys and Enter
// unchanged, "In your code" in the plan, the header disclosure, phones at 390px, dark and light with
// axe, and a folder outside git (no chip). Fake agent CLIs; one server and one browser at a time.
//   CHROME_PATH=… node e2e/grounded.mjs
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { until } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-grounded-")));
const NODE = process.execPath;
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
function gitProject(name) {
  const root = path.join(WORK, name);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"recipes"}');
  writeFileSync(path.join(root, "README.md"), "# Recipes");
  writeFileSync(path.join(root, ".env"), "TOKEN=x");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});
async function server(cwd, extra = {}) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const log = path.join(home, "calls.jsonl");
  const e = { PATH: `${fakeBins(["claude"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_LOG: log, ...extra };
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
      return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "--version");
    } catch {
      return [];
    }
  };
  return {
    url,
    calls,
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
const isRead = (c) => c.args.includes("Read,Grep,Glob");
const text = (pg, sel) => pg.locator(sel).first().innerText();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const project = gitProject("recipes");
  const srv = await server(project);
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    await pg.goto(srv.url);
    const chip = pg.getByTestId("read-chip");
    await chip.waitFor();
    check(`${theme}: Home names the access before Start`, (await chip.innerText()).includes("Reads recipes"));
    await axe(pg, `${theme} Home with the read chip`);
    if (theme === "dark") {
      // Keyboard: the chip is in the tab order after the agent chip; Enter opens, Escape closes and returns focus.
      await pg.locator("textarea.tx").focus();
      let hops = 0;
      while (hops++ < 6 && !(await chip.evaluate((el) => el === document.activeElement))) await pg.keyboard.press("Tab");
      check("the chip is reachable by Tab", await chip.evaluate((el) => el === document.activeElement));
      await pg.keyboard.press("Enter");
      const pop = pg.getByTestId("read-pop");
      await pop.waitFor();
      check("the popover says what the agent may and can’t do", /can’t change files or go online/.test(await pop.innerText()) && (await pop.innerText()).includes(project));
      await axe(pg, "the read popover");
      await pg.keyboard.press("Escape");
      await until(async () => !(await pop.isVisible()), "popover closed");
      // Radix moves focus back a frame after it closes.
      const back = await until(() => chip.evaluate((el) => el === document.activeElement), "focus back on the chip", 2000).catch(() => false);
      check("Escape closes it and focus returns to the chip", back);

      // Off: the chip changes, survives a reload, and the next session runs tools-off.
      await chip.click();
      await pop.getByRole("checkbox").uncheck();
      await until(async () => (await chip.innerText()).includes("Not reading files"), "chip off");
      await pg.keyboard.press("Escape");
      await pg.reload();
      await chip.waitFor();
      check("off survives a reload", (await chip.innerText()).includes("Not reading files"));
      await pg.locator("textarea.tx").fill("A shopping list");
      await pg.keyboard.press("Enter");
      await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
      const first = srv.calls()[0];
      check("a session started with reading off runs tools-off", first && !isRead(first) && first.cwd !== project, first?.cwd);
      check("its round has no Found in your code", (await pg.getByTestId("found-in-code").count()) === 0);
      await pg.goto(srv.url);
      await chip.waitFor();
      await pg.locator("textarea.tx").waitFor();
      await chip.click();
      await pop.waitFor();
      await pop.getByRole("checkbox").check();
      await until(async () => (await chip.innerText()).includes("Reads recipes"), "chip on");
      await pg.keyboard.press("Escape");

      // A grounded round.
      await pg.locator("textarea.tx").fill("Save recipes offline");
      await pg.keyboard.press("Enter");
      await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
      const last = srv.calls().at(-1);
      check("a session with reading on reads at the project root", isRead(last) && last.cwd === project, last?.cwd);
      const found = pg.getByTestId("found-in-code");
      check("Found in your code counts what this round learned", (await found.innerText()).includes("1 thing it didn’t need to ask"));
      await found.locator("summary").click();
      check("open, it lists the finding with its file", /Stack[\s\S]*Node package[\s\S]*package\.json/.test(await found.innerText()));
      check("and never a sensitive or missing file", !/\.env|nope\.json/.test(await found.innerText()));
      const cards = pg.getByTestId("question");
      check("the card with evidence says From your code", (await cards.nth(0).getByTestId("from-code").innerText()).includes("package.json"));
      check("a path the agent gave as absolute shows relative", (await cards.nth(0).getByTestId("from-code").innerText()).includes("README.md") && !(await cards.nth(0).innerText()).includes(WORK));
      check("the card without evidence has no line", (await cards.nth(1).getByTestId("from-code").count()) === 0);
      await cards.nth(0).getByRole("button", { name: "package.json" }).click();
      check("a file chip shows its note", (await text(pg, "[data-testid=from-code] .note")).includes("Scripts and dependencies"));
      check("the header names what it reads", (await text(pg, "[data-testid=project-context] summary")).startsWith("Reads recipes"));
      await axe(pg, "a grounded round");

      // Number keys and Enter work as before: pick option 2 on the first card, then send.
      await pg.locator("body").click({ position: { x: 5, y: 5 } });
      await pg.evaluate(() => document.activeElement?.blur());
      await pg.keyboard.press("2");
      await until(async () => (await cards.nth(0).locator("[data-selected]").first().innerText()).includes("No, the full vision"), "option 2 picked", 3000).catch(() => null);
      check("number keys still pick an option", (await cards.nth(0).locator("[data-selected]").first().innerText()).includes("No, the full vision"));
      await pg.getByRole("button", { name: "Send and wrap up" }).click();
      await pg.getByRole("button", { name: /Yes, plate it/ }).waitFor({ timeout: 15000 });
      await pg.keyboard.press("Enter");
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      check("the plan lists the files it touches", /In your code[\s\S]*package\.json[\s\S]*Add the new script/.test(await text(pg, "[data-testid=plan]")));
      check("and none Grillado couldn’t check", !/src\/nope\.ts|\.env/.test(await text(pg, "[data-testid=plan]")));
    }
    await ctx.close();
  }

  // Phones: nothing scrolls sideways on Home or the round; the project name truncates.
  const long = gitProject("a-really-long-project-name-that-would-push-the-row-apart");
  const srv2 = await server(long);
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await m.newPage();
  await mp.goto(srv2.url);
  await mp.getByTestId("read-chip").waitFor();
  check("390px Home: no sideways scroll with a long project name", await noScroll(mp));
  check("390px: the composer row stays on one line", await mp.evaluate(() => { const r = [...document.querySelectorAll(".composer .ar > *")].map((e) => e.getBoundingClientRect().top); return Math.max(...r) - Math.min(...r) < 8; }));
  await mp.locator("textarea.tx").fill("Save recipes offline");
  await mp.getByRole("button", { name: "Start" }).tap();
  await mp.getByTestId("question").first().waitFor({ timeout: 15000 });
  await mp.getByTestId("found-in-code").locator("summary").tap();
  check("390px round: no sideways scroll with findings open", await noScroll(mp));
  await axe(mp, "phone grounded round");
  await m.close();
  await srv2.stop();

  // Outside git: no chip, and the session behaves as before.
  const plain = path.join(WORK, "plain");
  mkdirSync(plain);
  const srv3 = await server(plain);
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await p.goto(srv3.url);
  await p.locator("textarea.tx").waitFor();
  check("outside a git repository there is no chip", (await p.getByTestId("read-chip").count()) === 0);
  await p.locator("textarea.tx").fill("A shopping list");
  await p.keyboard.press("Enter");
  await p.getByTestId("question").first().waitFor({ timeout: 15000 });
  check("and the round runs tools-off", srv3.calls().every((c) => !isRead(c)));
  await srv3.stop();
  await srv.stop();
} catch (err) {
  failures++;
  console.log(`FAIL  ${err?.stack ?? err}`);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
