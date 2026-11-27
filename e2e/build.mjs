// The plan-to-build loop in a real browser, driven from outside with the real `grillado build`
// commands: a plated plan has build steps (Build tab, and the plan file); a step the agent starts
// or finishes shows without a reload; an ask is a card pinned above the plan with "Agent is waiting",
// answered with number keys and Enter, and the answer becomes a cited line in the plan and comes back
// from `build wait`; a withdrawn ask is never a decision; the tab title and Home's Recent show a
// waiting agent; steps can be edited, moved by keyboard, added, removed and reopened; `build` replies
// say what changed in the plan. Fake agent CLIs; dark, light, 390px; axe.
//   CHROME_PATH=… node e2e/build.mjs        (SHOTS=<dir> also saves screenshots)
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { until } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-build-")));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ""}`);
}
const shot = async (pg, name) => SHOTS && pg.screenshot({ path: path.join(SHOTS, `${name}.png`) });

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
async function server() {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const env = { PATH: `${fakeBins(["claude"])}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home };
  const child = spawn(NODE, [CLI, "--no-open", "--no-scan"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
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
  /** A `grillado` command as a coding agent would run it: its stdout, or the error text. */
  const cli = (...args) => {
    try {
      return execFileSync(NODE, [CLI, ...args], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return `EXIT ${err.status}: ${err.stderr}${err.stdout}`;
    }
  };
  return {
    url,
    home,
    cli,
    json: (...args) => JSON.parse(cli(...args, "--json")),
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
const noScroll = (pg) => pg.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".scroll, .solo, .docwrap")].every((e) => e.scrollWidth <= e.clientWidth + 1));
/** From an idea to a written plan: both rounds answered as suggested, confirmed. Returns the plan id. */
async function plate(pg, url) {
  await pg.goto(url);
  await pg.locator("textarea.tx").fill("A shared shopping list");
  await pg.getByRole("button", { name: "Start" }).click();
  await pg.getByTestId("question").first().waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: "Send round" }).click();
  await pg.locator("[data-testid=question][data-key=storage]").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: "Send round" }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });
  return new URL(pg.url()).pathname.split("/").pop();
}
const steps = (pg) => pg.getByTestId("build-step");
const stepTitles = (pg) => steps(pg).locator(".bt").evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const planFile = (srv) => {
  const dir = path.join(srv.home, "docs", "plans");
  return readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8");
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const srv = await server();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    await ctx.addInitScript((t) => { try { localStorage.setItem("grillado-theme", t); } catch {} }, theme);
    const pg = await ctx.newPage();
    const id = await plate(pg, srv.url);
    const tab = pg.getByRole("tab", { name: /^Build/ });
    check(`${theme}: the plan has a Build tab that counts its steps`, (await tab.innerText()).replace(/\s+/g, " ").trim() === "Build 0/3", await tab.innerText());
    check(`${theme}: the document doesn’t show the file’s build sections`, !(await pg.getByTestId("plan").innerText()).includes("Build steps"));
    await tab.click();
    await steps(pg).first().waitFor();
    check(`${theme}: each step has a title and a done check`, (await steps(pg).count()) === 3 && /1\. Build scope: Yes, one core flow/.test(await steps(pg).first().innerText()) && /Done when: The scope choice works end to end/.test(await steps(pg).first().innerText()));
    await axe(pg, `${theme} Build tab`);
    await shot(pg, `build-tab-${theme}`);
    if (theme === "light") {
      await ctx.close();
      await srv.stop();
      continue;
    }

    // ---- the plan file, and the agent's side: next, start
    check("the plan file ends with the build steps, unchecked", /\n<!-- grillado:build -->\n\n## Build steps\n\n- \[ \] 1\. Build scope: Yes, one core flow\n  Done when: /.test(planFile(srv)));
    const got = srv.cli("plan", "get", id);
    check("plan get gives the agent the plan with its build steps", got.includes("## Build steps") && got.includes("- [ ] 2. Build platform: Web app"));
    const next = srv.cli("build", "next", id);
    check("build next gives step 1 with its done check and the revision", /^Step 1: Build scope: Yes, one core flow\nDone when: /.test(next) && next.includes("Plan revision 1 · 0 of 3 steps done."), next);
    srv.cli("build", "start", id);
    await until(async () => (await steps(pg).first().innerText()).includes("In progress"), "step 1 in progress", 8000);
    check("a step the agent starts shows In progress, with no reload", (await tab.innerText()).includes("0/3"));
    check("and the plan file marks it started", planFile(srv).includes("- [~] 1. Build scope: Yes, one core flow (started)"));

    // ---- an ask: pinned card, answered by number key and Enter
    const asked = srv.json("build", "ask", id, "--key", "ask-storage", "--title", "Where should the list be stored?", "--body", "The plan doesn't say.", "--option", "file=A file on disk", "--option", "db=A small database", "--note", "db=Slower to set up, easier to query", "--suggest", "file", "--no-open");
    check("build ask says to wait, and never to answer for the user", asked.ask.state === "open" && /Don't answer it yourself/.test(asked.next) && asked.waitingOnUser.includes("ask-storage"), JSON.stringify(asked).slice(0, 300));
    const card = pg.getByTestId("ask-card");
    await card.waitFor({ timeout: 8000 });
    check("the ask is a card above the plan, marked Agent is waiting at its step", /Agent is waiting\s*· step 1 of 3/.test(await card.locator(".ask-tag").innerText()) && (await card.innerText()).includes("Where should the list be stored?"));
    check("it shows the agent’s options, the suggested one marked and preselected", (await card.locator("[data-slot=agent-question-option]").count()) === 3 && /A file on disk/.test(await card.locator("[data-slot=agent-question-option][data-selected]").first().innerText()));
    check("it is pinned above the tabs’ content, on the Build tab too", await card.evaluate((c) => c.getBoundingClientRect().top < document.querySelector("[data-testid=build-tab]").getBoundingClientRect().top));
    await until(async () => (await pg.title()).startsWith("(1) Agent is waiting"), "tab title", 5000);
    check("the tab title counts the waiting agent", (await pg.title()) === "(1) Agent is waiting · Grillado", await pg.title());
    const waiting = srv.json("build", "wait", id, "--ask", "ask-storage", "--timeout", "0");
    check("build wait times out as waiting, to be run again", waiting.result === "waiting" && /Run the same command again/.test(waiting.next));
    await pg.waitForTimeout(300);
    await shot(pg, "ask-card-dark");
    await axe(pg, "the ask card");

    // Another tab on Home sees the badge.
    const home = await ctx.newPage();
    await home.goto(srv.url);
    await home.getByTestId("ask-badge").waitFor({ timeout: 8000 });
    check("Home’s Recent marks the plan: Agent is waiting", (await home.getByTestId("ask-badge").innerText()) === "Agent is waiting" && (await home.title()).startsWith("(1) Agent is waiting"));
    await shot(home, "recent-badge-dark");

    // Number key 2 chooses the second option, Enter sends: with nothing focused, as on a round.
    await pg.locator("body").click({ position: { x: 5, y: 5 } });
    await pg.evaluate(() => document.activeElement?.blur());
    await pg.keyboard.press("2");
    await until(async () => /A small database/.test(await card.locator("[data-slot=agent-question-option][data-selected]").first().innerText()), "option 2 chosen", 4000);
    check("a number key chooses an option without sending", (await card.count()) === 1);
    await pg.keyboard.press("Enter");
    await until(async () => (await card.count()) === 0, "the card to leave", 8000);
    const answered = srv.json("build", "wait", id, "--ask", "ask-storage", "--timeout", "5");
    check("the answer comes back from build wait", answered.result === "answered" && answered.answer === "A small database" && /\[B:ask-storage\]/.test(answered.next), JSON.stringify(answered).slice(0, 300));
    check("the reply says the plan changed, and what", answered.changed?.what.some((w) => w === "+ decision [B:ask-storage] A small database") && answered.rev === 2, JSON.stringify(answered.changed));
    const file = planFile(srv);
    check("the plan file has the decision, cited, under Implementation decisions", /## Implementation decisions\n[\s\S]*- Where should the list be stored\? A small database\. Decided during the build, at step 1\. \[B:ask-storage\]/.test(file));
    check("and a Build log line for the ask", file.includes("## Build log\n\n- Ask `ask-storage` answered: “A small database” [B:ask-storage]"));
    await until(async () => (await pg.title()) === "Grillado", "title back", 5000);
    check("the tab title is plain again", true);
    await until(async () => (await home.getByTestId("ask-badge").count()) === 0, "badge gone", 8000);
    check("and Home’s badge is gone", true);
    await home.close();
    await pg.getByRole("tab", { name: "Document" }).click();
    const doc = await pg.getByTestId("plan").innerText();
    check("the document shows the decision line, without its citation tag", doc.includes("Where should the list be stored? A small database. Decided during the build, at step 1.") && !doc.includes("[B:ask-storage]"));

    // ---- a withdrawn ask is never a decision
    srv.cli("build", "ask", id, "--key", "ask-sync", "--title", "Sync on every change?", "--option", "y=Yes", "--option", "n=No", "--no-open");
    await card.waitFor({ timeout: 8000 });
    const gone = srv.json("build", "withdraw", id, "--ask", "ask-sync", "--reason", "Found it in the plan");
    check("withdraw says it is not a decision", gone.ask.state === "withdrawn" && /not a decision/.test(gone.next));
    await until(async () => (await card.count()) === 0, "the withdrawn card to leave", 8000);
    await tab.click();
    const asks = pg.getByTestId("build-ask");
    check("the Build tab lists both asks: one answered, one withdrawn", (await asks.count()) === 2 && /You answered: A small database/.test(await asks.nth(0).innerText()) && /Withdrawn by the agent/.test(await asks.nth(1).innerText()));
    check("the plan has no decision for the withdrawn ask", !planFile(srv).includes("[B:ask-sync]") && planFile(srv).includes("- Ask `ask-sync` withdrawn by the agent"));

    // ---- done needs what was verified; the user can reopen
    check("done without what was verified is wrong usage", /EXIT 2: [\s\S]*build done needs --verified/.test(srv.cli("build", "done", id)));
    const done = srv.cli("build", "done", id, "--verified", "bun test test/list.test.ts: 9 pass", "--deviation", "Kept the list in one file");
    check("build done reports the step and points to the next", /^Step 1 done\.\n[\s\S]*1 of 3 steps done\./.test(done), done);
    await until(async () => (await steps(pg).first().getAttribute("data-status")) === "done", "step 1 done", 8000);
    check("a done step shows Done at once, with what was verified and the deviation", /Verified: bun test test\/list\.test\.ts: 9 pass/.test(await steps(pg).first().innerText()) && /Deviation: Kept the list in one file/.test(await steps(pg).first().innerText()) && (await tab.innerText()).includes("1/3"));
    check("the file checks it off and logs it", planFile(srv).includes("- [x] 1. Build scope") && planFile(srv).includes("- Step 1 done. Verified: bun test test/list.test.ts: 9 pass\n  Deviation: Kept the list in one file"));
    check("build next moves on to step 2", /^Step 2: Build platform: Web app/.test(srv.cli("build", "next", id)));
    await shot(pg, "build-progress-dark");

    // The agent reads the plan, then the user edits: the next reply says what changed.
    srv.cli("plan", "get", id);
    check("after reading, nothing is reported as changed", !srv.cli("build", "next", id).includes("The plan changed"));
    await steps(pg).first().hover();
    await steps(pg).first().getByTestId("step-reopen").click();
    await until(async () => (await steps(pg).first().getAttribute("data-status")) === "todo", "step 1 reopened", 8000);
    check("Reopen sets a done step back", (await tab.innerText()).includes("0/3"));
    await steps(pg).nth(1).getByTestId("step-edit").click();
    const title = steps(pg).nth(1).getByTestId("step-title");
    await title.fill("Build the web app shell");
    await title.press("Enter");
    await until(async () => (await stepTitles(pg))[1]?.startsWith("2. Build the web app shell"), "step 2 renamed", 8000);
    check("a step’s title is edited in place, Enter saves", true);
    const after = srv.cli("build", "next", id);
    check("the next build reply says the plan changed, and what", /The plan changed since you last read it \(rev \d+ -> \d+\):/.test(after) && after.includes('~ step 2 edited: "Build the web app shell"') && after.includes("~ step 1 reopened by the user") && after.includes(`Run \`grillado plan get ${id}\` before the next step.`), after);
    check("and it is step 1 again", /^Step 1: Build scope/.test(after));

    // ---- reorder by keyboard, add, remove
    await steps(pg).first().getByTestId("step-down").focus();
    await pg.keyboard.press("Enter");
    await until(async () => (await stepTitles(pg))[0]?.startsWith("1. Build the web app shell"), "moved down", 8000);
    check("Move down, by keyboard, reorders the steps", (await stepTitles(pg))[1].startsWith("2. Build scope"));
    const kept = await until(() => pg.evaluate(() => document.activeElement?.closest("[data-testid=build-step]")?.querySelector(".bt")?.textContent.includes("Build scope")), "focus on the moved step", 3000).catch(() => false);
    check("focus stays on the step that moved", !!kept);
    await pg.keyboard.press("Alt+ArrowUp");
    await until(async () => (await stepTitles(pg))[0]?.startsWith("1. Build scope"), "moved back up", 8000);
    check("Alt+↑ moves it back up", true);
    check("build next follows the user’s order", /^Step 1: Build scope/.test(srv.cli("build", "next", id)));
    const add = pg.getByTestId("step-add");
    await add.locator("summary").click();
    await add.getByTestId("step-title").fill("Share the list by link");
    await add.getByTestId("step-check").fill("A second browser opens the link and sees the list");
    await add.getByTestId("step-check").press("Enter");
    await until(async () => (await steps(pg).count()) === 4, "a fourth step", 8000);
    check("a step can be added, with its done check", /4\. Share the list by link/.test(await steps(pg).nth(3).innerText()) && /Done when: A second browser opens the link/.test(await steps(pg).nth(3).innerText()));
    await steps(pg).nth(1).hover();
    await steps(pg).nth(1).getByTestId("step-remove").click();
    await until(async () => (await steps(pg).count()) === 3, "a step removed", 8000);
    check("a step can be removed", (await stepTitles(pg)).join(" | ") === "1. Build scope: Yes, one core flow | 2. Build storage: Local storage | 3. Share the list by link", (await stepTitles(pg)).join(" | "));
    check("the file follows the edits", /- \[ \] 2\. Build storage[^\n]*\n  Done when: [^\n]*\n- \[ \] 3\. Share the list by link\n  Done when: A second browser opens the link and sees the list\n/.test(planFile(srv)));
    await axe(pg, "Build tab after edits");
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    await pg.getByRole("tab", { name: /^Build/ }).click();
    check("steps and asks survive a reload", (await steps(pg).count()) === 3 && (await pg.getByTestId("build-ask").count()) === 2);

    // ---- Send to issues reuses the steps (checked through the split the sheet would show)
    await ctx.close();
    await srv.stop();
  }

  // ---------------------------------------------------------------- phones
  const srv = await server();
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await m.newPage();
  const id = await plate(mp, srv.url);
  srv.cli("build", "start", id);
  srv.cli("build", "ask", id, "--key", "ask-storage", "--title", "Where should the list be stored when a phone is offline?", "--option", "file=A file on disk", "--option", "db=A small database", "--suggest", "file", "--no-open");
  const mcard = mp.getByTestId("ask-card");
  await mcard.waitFor({ timeout: 8000 });
  check("390px: the ask card fits the screen", await noScroll(mp) && (await mcard.evaluate((c) => c.getBoundingClientRect().right <= innerWidth)));
  await mp.waitForTimeout(300);
  await shot(mp, "ask-card-phone");
  await axe(mp, "phone ask card");
  await mcard.locator("[data-slot=agent-question-option]").nth(1).tap();
  await mcard.getByRole("button", { name: /Send answer/ }).tap();
  await until(async () => (await mcard.count()) === 0, "phone answer sent", 8000);
  check("390px: an ask is answered by tapping an option and Send answer", srv.json("build", "wait", id, "--ask", "ask-storage", "--timeout", "5").answer === "A small database");
  await mp.getByRole("tab", { name: /^Build/ }).tap();
  await mp.getByTestId("build-step").first().waitFor();
  check("390px: the Build tab doesn’t scroll sideways", await noScroll(mp));
  check("390px: step actions are visible without hover, 44px tall", await mp.getByTestId("step-edit").first().evaluate((b) => b.getBoundingClientRect().height >= 44 && getComputedStyle(b.parentElement).opacity === "1"));
  await shot(mp, "build-tab-phone");
  await axe(mp, "phone Build tab");
  await m.close();
  await srv.stop();
} catch (err) {
  failures++;
  console.log(`FAIL  ${err?.stack ?? err}`);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
