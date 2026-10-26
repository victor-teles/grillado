// Item 6 end-to-end: the Activity tab (rail and mobile sheet). ⌘⌥A, groups, the latest run open,
// durations without a clock, roving keys and Esc, a live Add diagrams run (dot, steps, Stop, one
// polite live region, run bar → Activity), chips that jump, Copy log, your review logged, a failure
// with a soft Try again, mobile ⋯ → Activity and “Back to Activity”, and axe (dark/light × desktop/mobile).
// One server and one browser at a time; only processes started here are killed.
//   node e2e/activity.mjs            checks only
//   SHOTS=dir VIDEO=1 node e2e/activity.mjs   also writes screenshots (and a desktop clip) to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-act-"));
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

async function toPlan(pg, url) {
  await pg.goto(url);
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
}
const planMd = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan.md`)).text());
const TA = ".blk-edit:not(.blk-bd)";
async function axe(pg, name) {
  await pg.waitForTimeout(400); // let fades finish
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
const txt = async (loc) => ((await loc.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
async function openAsk(pg, mobile = false) {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menuitem", { name: /Add diagrams/ }).click();
  await pg.getByTestId("add-diagrams").waitFor();
  await pg.waitForTimeout(100);
}
/** The entrance right after an open: no transition and fully opaque when opened from the keyboard (MF5). */
const entrance = (pg, sel) => pg.$eval(sel, (e) => ({ dur: getComputedStyle(e).transitionDuration, op: getComputedStyle(e).opacity }));

const waitRunEnd = (pg) => pg.waitForFunction(() => !document.querySelector("[data-testid=diagram-run]"), null, { timeout: 20000 });
const act = (pg) => pg.getByTestId("activity");
const row = (pg, re) => act(pg).locator(".ev6").filter({ has: pg.locator(".tx b", { hasText: re }) }).first();
const live = (pg) => txt(pg.getByTestId("activity-live"));
const focusedEntry = (pg) => pg.evaluate(() => document.activeElement?.closest(".ev6")?.querySelector(".tx b")?.textContent ?? document.activeElement?.closest(".gh6")?.textContent ?? document.activeElement?.className ?? "");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
    // ---------------------------------------------------------------- desktop
    const s = await server({ FAKE_DIAGRAM_DELAY_MS: "900" });
    const video = SHOTS && process.env.VIDEO && one ? { dir: path.join(WORK, "video"), size: { width: 1440, height: 900 } } : undefined;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", recordVideo: video, permissions: ["clipboard-read", "clipboard-write"] });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.waitForTimeout(250);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-d-${theme}.png`) });
    };
    await toPlan(pg, s.url);

    // 1. ⌘⌥A opens the rail on Activity; newest first, one group, the latest run open (#56).
    await pg.locator(".doc").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await pg.keyboard.press("Control+Alt+KeyA");
    await act(pg).waitFor({ timeout: 5000 });
    check(`${theme}: ⌘⌥A opens Activity`, (await pg.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")) === "true");
    const titles = await act(pg).locator(".ev6 .tx b").allTextContents();
    if (one) {
      check("newest first: the plan, your confirm, round 2, your answers, round 1", titles[0] === "Wrote the plan" && /^You confirmed/.test(titles[1]) && titles.some((t) => /^Round 2/.test(t)) && /^Round 1/.test(titles[titles.length - 1]), titles.join(" | "));
      check("one group with a sticky header", (await act(pg).locator(".grp6").count()) === 1 && (await act(pg).locator(".gh6").evaluate((e) => getComputedStyle(e).position)) === "sticky" && (await act(pg).locator(".gh6").evaluate((e) => e.getBoundingClientRect().height)) === 36);
      check("group header: Today · from time, runs · total", /^Today · from \d+:\d\d [AP]M\s*4 runs · \d/.test(await txt(act(pg).locator(".gh6"))), await txt(act(pg).locator(".gh6")));
      check("rows are in an <ol>", (await act(pg).locator("ol > li.ev6").count()) === titles.length);
      const plan = row(pg, "Wrote the plan");
      check("the latest run is open by default", (await plan.locator(".evb").getAttribute("aria-expanded")) === "true" && (await plan.locator(".st6").count()) > 0);
      check("other runs start closed", (await row(pg, /^Round 1/).locator(".evb").getAttribute("aria-expanded")) === "false");
      const dur = plan.locator(".evh .dur").first();
      check("durations: “4.2 s” style, tabular, 12px, spoken in aria-label", /^\d+(\.\d)? (ms|s)|min/.test((await dur.evaluate((e) => e.firstChild.textContent)) ?? "") && /(millisecond|second|minute)s?$/.test((await dur.getAttribute("aria-label")) ?? "") && (await dur.evaluate((e) => getComputedStyle(e).fontVariantNumeric)) === "tabular-nums" && (await dur.evaluate((e) => getComputedStyle(e).fontSize)) === "12px", await dur.getAttribute("aria-label"));
      check("row name reads title, status and duration", /Wrote the plan.*finished.*second/.test((await plan.locator(".evb").getAttribute("aria-label")) ?? ""), await plan.locator(".evb").getAttribute("aria-label"));
      check("row grid 16px | 1fr | auto | 14px", /^16px \S+ \S+ 14px$/.test(await plan.locator(".evh").evaluate((e) => getComputedStyle(e).gridTemplateColumns)), await plan.locator(".evh").evaluate((e) => getComputedStyle(e).gridTemplateColumns));
      check("body indented 34px", (await plan.locator(".evbody > div").evaluate((e) => getComputedStyle(e).paddingLeft)) === "34px");
      check("Wrote chips for the plan's sections", (await plan.locator(".chips6[aria-label=Wrote] .chip6").count()) >= 2);
      check("no clock: no ticking timer on any row", (await act(pg).locator("[data-status=running] .evh .dur").count()) === 0);
      check("Copy log is quiet small", /quiet/.test(await plan.getByRole("button", { name: "Copy log" }).getAttribute("class")));
    }
    await snap("i6-list");
    await axe(pg, `${theme} desktop: Activity`);

    // 2. Keyboard: one tab stop, ↑↓ Home End, → opens, ← closes, Esc back to the plan (#61).
    if (one) {
      check("roving tabindex: one row in the tab order", (await act(pg).locator(".evb[tabindex='0'], .gh6 button[tabindex='0']").count()) === 1);
      await act(pg).locator(".evb").first().focus();
      await pg.keyboard.press("ArrowDown");
      check("↓ moves to the next row", /^You confirmed/.test(await focusedEntry(pg)), await focusedEntry(pg));
      await pg.keyboard.press("End");
      check("End: the last row", /^Round 1/.test(await focusedEntry(pg)), await focusedEntry(pg));
      await pg.keyboard.press("ArrowRight");
      check("→ opens a run", (await row(pg, /^Round 1/).locator(".evb").getAttribute("aria-expanded")) === "true");
      const op = await entrance(pg, `.ev6[data-entry] .evbody`).catch(() => ({ dur: "?" }));
      check("keyboard opens are instant", /^0s/.test(op.dur), JSON.stringify(op));
      await pg.keyboard.press("ArrowLeft");
      check("← closes it", (await row(pg, /^Round 1/).locator(".evb").getAttribute("aria-expanded")) === "false");
      await pg.keyboard.press("Home");
      check("Home: the first row", (await focusedEntry(pg)) === "Wrote the plan");
      await pg.keyboard.press("Escape");
      check("Esc returns focus to the plan", await pg.evaluate(() => !!document.activeElement?.closest(".doc, .docwrap")));
    }

    // 3. A live run: the dot, steps as they come, Stop, one live message per run (#61, #62).
    await openAsk(pg);
    await pg.keyboard.press("Control+Enter");
    await pg.getByTestId("diagram-run").waitFor({ timeout: 5000 });
    await act(pg).locator(".ev6[data-status=running]").waitFor({ timeout: 5000 });
    const run = act(pg).locator(".ev6[data-status=running]");
    if (one) {
      check("live run: ember dot, “Adding diagrams”, open, Stop", (await run.locator(".ic .live").count()) === 1 && (await txt(run.locator(".tx b"))) === "Adding diagrams" && (await run.locator(".evb").getAttribute("aria-expanded")) === "true" && (await run.getByRole("button", { name: "Stop" }).count()) === 1);
      check("meta says when it started", /^Started \d/.test(await txt(run.locator(".tx .m"))), await txt(run.locator(".tx .m")));
      check("the running step is in the present", /^Drawing “?Problem/.test(await txt(run.locator(".st6[data-state=running]"))), await txt(run.locator(".steps6")));
      check("live region: started", /Claude Code started adding diagrams/.test(await live(pg)), await live(pg));
      check("one polite live region", (await act(pg).locator("[aria-live]").count()) === 1 && (await pg.getByTestId("activity-live").getAttribute("aria-live")) === "polite");
      check("the Activity tab shows a running dot", (await pg.locator(".rtabs .dot").count()) === 1);
      await snap("i6-live");
      // The run bar's label opens Activity on that run (#66).
      await act(pg).locator(".evb").nth(2).focus();
      await pg.locator("[data-testid=diagram-run] .tolog").click();
      await pg.waitForTimeout(150);
      check("run bar label → Activity on that run", (await focusedEntry(pg)) === "Adding diagrams", await focusedEntry(pg));
    }
    await axe(pg, `${theme} desktop: live run`);
    await waitRunEnd(pg);
    await pg.waitForFunction(() => document.querySelector("[data-testid=activity] .ev6")?.getAttribute("data-status") === "done", null, { timeout: 10000 });
    const done = row(pg, "Added diagrams");
    if (one) {
      check("finished: duration and suggestions in the meta", /1 diagram · 1 section skipped/.test(await txt(done.locator(".tx .m"))) && (await done.locator(".evh .dur").count()) === 1, await txt(done.locator(".tx .m")));
      check("live region: finished, with time and suggestions", /Added diagrams in [\d.]+ (milli)?seconds?\. 1 suggestion to review\./.test(await live(pg)), await live(pg));
      check("steps each have a duration", (await done.locator(".st6 .dur").count()) === (await done.locator(".st6").count()));
      const chip = done.locator(".chips6[aria-label=Suggestions] .chip6").first();
      check("Suggestions chip: section · to review", /Implementation decisions\s*to review/.test(await txt(chip)), await txt(chip));
      await chip.click();
      await pg.waitForTimeout(200);
      check("chip → the suggestion in the plan, focused", (await pg.getByTestId("diagram-suggestion").getAttribute("data-focused").catch(() => null)) !== null || (await pg.evaluate(() => !!document.activeElement?.closest("[data-sg], [data-testid=diagram-suggestion]"))));
      await done.getByRole("button", { name: "Copy log" }).click();
      check("Copy log toast, above the review bar", /Copied the log of “Added diagrams”/.test(await txt(pg.locator(".toast"))) && (await pg.locator(".review").count()) === 1, await txt(pg.locator(".toast")));
      const clip = await pg.evaluate(() => navigator.clipboard.readText());
      check("the log lists steps and durations", /Added diagrams/.test(clip) && /\d+(\.\d)? s|ms/.test(clip), clip.slice(0, 120));
      await snap("i6-done");
    }
    // 4. Your review is logged; the chip then jumps to the accepted section with a flash.
    await pg.getByTestId("diagram-suggestion").getByRole("button", { name: /^Accept/ }).click();
    await act(pg).locator(".ev6 .tx b", { hasText: "You accepted 1 suggestion" }).waitFor({ timeout: 5000 });
    if (one) {
      const chip = done.locator(".chips6[aria-label=Suggestions] .chip6").first();
      check("after Accept: chip says accepted", /accepted/.test(await txt(chip)), await txt(chip));
      await chip.click();
      await pg.waitForTimeout(150);
      check("accepted chip → the section, flashed", await pg.evaluate(() => !!document.querySelector(".doc .blk[data-fl]")));
    }
    await snap("i6-review");

    // 5. A failure: soft Try again, the retry row says it started again (#58).
    {
      const s3 = await server({ FAKE_DIAGRAM: "fail" });
      const fpg = await ctx.newPage();
      await toPlan(fpg, s3.url);
      await openAsk(fpg);
      await fpg.keyboard.press("Control+Enter");
      await fpg.getByTestId("diagram-failed").waitFor({ timeout: 15000 });
      await fpg.keyboard.press("Control+Alt+KeyA");
      const bad = row(fpg, "Couldn’t add diagrams");
      await bad.waitFor({ timeout: 5000 });
      check(`${theme}: failed run is open, says nothing changed or what was kept`, (await bad.locator(".evb").getAttribute("aria-expanded")) === "true" && /nothing was changed|rate|limit/i.test(await txt(bad.locator(".tx .m"))), await txt(bad.locator(".tx .m")));
      const tryBtn = bad.getByRole("button", { name: "Try again" });
      check(`${theme}: Try again is soft`, /soft/.test((await tryBtn.getAttribute("class")) ?? ""));
      if (SHOTS) await fpg.screenshot({ path: path.join(SHOTS, `i6-failed-d-${theme}.png`) });
      await axe(fpg, `${theme} desktop: failed run`);
      if (one) {
        await tryBtn.click();
        await fpg.waitForFunction(() => /started again/.test(document.querySelector("[data-testid=activity] .ev6 .tx .m")?.textContent ?? ""), null, { timeout: 10000 });
        check("the retry says it started again after the run below", true);
      }
      await fpg.close();
      await s3.stop();
    }

    const clip = video ? await pg.video()?.path() : null;
    await ctx.close();
    if (clip) renameSync(clip, path.join(SHOTS, "i6-desktop.webm"));
    await s.stop();

    // ---------------------------------------------------------------- mobile
    const s2 = await server();
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await toPlan(mp, s2.url);
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /^Activity/ }).click();
    await act(mp).waitFor({ timeout: 5000 });
    const sheet = mp.locator(".csheet");
    check(`${theme} mobile: ⋯ → Activity opens the sheet on Activity`, (await txt(sheet.locator(".sh b"))) === "Activity" && (await mp.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")) === "true");
    if (one) {
      check("mobile: 12px row padding, 32px chips", (await act(mp).locator(".evh").first().evaluate((e) => getComputedStyle(e).paddingTop)) === "12px" && (await act(mp).locator(".chip6").first().evaluate((e) => e.getBoundingClientRect().height)) === 32);
    }
    if (SHOTS) {
      await mp.waitForTimeout(250);
      await mp.screenshot({ path: path.join(SHOTS, `i6-sheet-m-${theme}.png`) });
    }
    await axe(mp, `${theme} mobile: Activity sheet`);
    await act(mp).locator(".chips6[aria-label=Wrote] .chip6").first().click();
    await mp.waitForTimeout(250);
    check(`${theme} mobile: a chip closes the sheet and shows “Back to Activity”`, (await mp.locator(".csheet").count()) === 0 && (await mp.getByRole("button", { name: "Back to Activity" }).count()) === 1);
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i6-back-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: Back to Activity`);
    await mp.getByRole("button", { name: "Back to Activity" }).click();
    await act(mp).waitFor({ timeout: 5000 });
    check(`${theme} mobile: back reopens Activity with the same open rows`, (await act(mp).locator(".evb[aria-expanded=true]").count()) >= 1);
    await mctx.close();
    await s2.stop();
  }
} catch (err) {
  failures++;
  console.log(`FAIL  crashed: ${err?.stack ?? err}`);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
