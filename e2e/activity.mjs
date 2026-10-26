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
/** The meta line's parts; the "·" between them is drawn by CSS (#83). */
const metaOf = (loc) => loc.locator(".tx .m").first().evaluate((m) => [...m.children].map((c) => c.textContent.trim()).join(" · "), null, { timeout: 5000 }).catch(() => "");
/** Records, for each Activity body and step as it mounts, whether it was animated (#81). */
const recordAnims = (pg) =>
  pg.evaluate(() => {
    window.__anims = [];
    window.__mo?.disconnect();
    window.__mo = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          for (const el of [n, ...n.querySelectorAll(".evbody, .st6")])
            if (el.matches?.(".act6 .evbody, .act6 .st6")) window.__anims.push({ body: el.classList.contains("evbody"), fresh: el.hasAttribute("data-new"), kbd: document.documentElement.hasAttribute("data-kbd"), n: el.getAnimations().length });
        }
    });
    window.__mo.observe(document.body, { childList: true, subtree: true });
  });
const anims = (pg) => pg.evaluate(() => window.__anims ?? []);
/** Left edges (px) of what should sit on the title column (#77). */
const edges = (loc) =>
  loc.evaluate((li) => {
    const x = (sel) => [...li.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().left));
    return { title: x(".tx b")[0], steps: x(".st6 .l"), keys: x(".fin6 .k"), copy: x(".acts6 .btn"), glyph: [...li.querySelectorAll(".st6 .g")].map((e) => Math.round(e.getBoundingClientRect().right)) };
  });
const txt = async (loc) => ((await loc.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
async function openAsk(pg, mobile = false) {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menuitem", { name: /Add diagrams/ }).click();
  await pg.getByTestId("add-diagrams").waitFor();
  await pg.waitForTimeout(100);
}
/** The entrance right after an open: no transition and fully opaque when opened from the keyboard (MF5). */

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
    await recordAnims(pg);
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
      check("durations: “4.2 s” style, tabular, 12px", /^\d+(\.\d)? (ms|s)|min/.test((await dur.evaluate((e) => e.firstChild.textContent)) ?? "") && (await dur.evaluate((e) => getComputedStyle(e).fontVariantNumeric)) === "tabular-nums" && (await dur.evaluate((e) => getComputedStyle(e).fontSize)) === "12px");
      // MF3 (#80): the visible number is hidden, the row button is described by the tooltip.
      const tipId = await plan.locator(".evb").getAttribute("aria-describedby");
      check("MF3: the duration is aria-hidden; the row is described by its tooltip", (await dur.getAttribute("aria-hidden")) === "true" && !!tipId && (await pg.locator(`#${tipId}[role=tooltip]`).count()) === 1 && /^Started .* took /.test(await txt(pg.locator(`#${tipId}`))), tipId ?? "");
      check("MF3: step durations are hidden, spoken in sr-only text", (await plan.locator(".st6 .dur[aria-hidden=true]").count()) === (await plan.locator(".st6 .dur").count()) && /(millisecond|second)s?$/.test(await txt(plan.locator(".st6 .sr-only"))));
      const tip = pg.locator(`#${tipId}`);
      await plan.locator(".tx b").hover({ force: true });
      await pg.waitForTimeout(700);
      const offTitle = await tip.evaluate((e) => getComputedStyle(e).opacity);
      await dur.hover();
      await pg.waitForTimeout(700);
      const onDur = await tip.evaluate((e) => getComputedStyle(e).opacity);
      check("MF3: the tooltip shows on hover over the duration only", offTitle === "0" && onDur === "1", `title ${offTitle}, duration ${onDur}`);
      await pg.mouse.move(5, 5);
      const mount = await anims(pg);
      check("MF2: nothing rises when the tab mounts (default-open body and its steps)", mount.length > 0 && mount.every((a) => a.n === 0), JSON.stringify(mount.slice(0, 3)));
      check("row name reads title, status and duration", /Wrote the plan.*finished.*second/.test((await plan.locator(".evb").getAttribute("aria-label")) ?? ""), await plan.locator(".evb").getAttribute("aria-label"));
      check("row grid 16px | 1fr | auto | 14px", /^16px \S+ \S+ 14px$/.test(await plan.locator(".evh").evaluate((e) => getComputedStyle(e).gridTemplateColumns)), await plan.locator(".evh").evaluate((e) => getComputedStyle(e).gridTemplateColumns));
      const ed = await edges(plan);
      const on = (xs) => xs.length > 0 && xs.every((x) => Math.abs(x - ed.title) <= 1);
      check("MF1: steps, keys and Copy log align to the title column", on(ed.steps) && on(ed.copy) && (ed.keys.length === 0 || on(ed.keys)), JSON.stringify(ed));
      check("MF1: step glyphs hang in the gutter left of the text", ed.glyph.every((x) => x <= ed.title - 4 && x >= ed.title - 10), JSON.stringify(ed.glyph));
      const ck = await plan.locator(".chips6[data-k=Wrote]").evaluate((g) => ({ k: g.querySelector(".k").getBoundingClientRect(), c: g.querySelector(".chip6").getBoundingClientRect() }));
      check("chip-group label sits above its chips, on the title column", ck.k.bottom <= ck.c.top + 1 && Math.abs(ck.c.left - ed.title) <= 1 && Math.abs(ck.k.left - ed.title) <= 1, JSON.stringify(ck));
      check("Wrote chips for the plan's sections", (await plan.locator(".chips6[data-k=Wrote] .chip6").count()) >= 2);
      check("no clock: no ticking timer on any row", (await act(pg).locator("[data-status=running] .evh .dur").count()) === 0);
      check("Copy log is quiet small", /quiet/.test(await plan.getByRole("button", { name: "Copy log" }).getAttribute("class")));
    }
    await snap("i6-list");
    await axe(pg, `${theme} desktop: Activity`);

    // 2. Keyboard: one tab stop, ↑↓ Home End, → opens, ← closes, Esc back to the plan (#61).
    if (one) {
      // The Asked chips (PO, handoff §6): a round row lists its questions; a chip opens Decisions on that row.
      const r1 = row(pg, /^Round 1/);
      await r1.locator(".evb").click();
      const asked = r1.locator(".chips6[data-k=Asked] .chip6");
      check("Asked chips: one per decision asked in the round, “R1·n question”", (await asked.count()) === 2 && /^R1·1\s*\S/.test(await txt(asked.first())), await txt(r1.locator(".chips6[data-k=Asked]")));
      if (SHOTS) {
        await pg.waitForTimeout(400);
        await r1.locator(".chips6[data-k=Asked]").scrollIntoViewIfNeeded();
        await pg.waitForTimeout(250);
        await pg.screenshot({ path: path.join(SHOTS, `i6-asked-d-${theme}.png`) });
      }
      check("roving tabindex: one row in the tab order", (await act(pg).locator(".evb[tabindex='0'], .gh6 button[tabindex='0']").count()) === 1);
      await act(pg).locator(".evb").first().focus();
      await pg.keyboard.press("ArrowDown");
      check("↓ moves to the next row", /^You confirmed/.test(await focusedEntry(pg)), await focusedEntry(pg));
      await pg.keyboard.press("End");
      check("End: the last row", /^Round 1/.test(await focusedEntry(pg)), await focusedEntry(pg));
      await pg.keyboard.press("ArrowLeft");
      check("← closes a run", (await row(pg, /^Round 1/).locator(".evb").getAttribute("aria-expanded")) === "false");
      await recordAnims(pg);
      await pg.keyboard.press("ArrowRight");
      check("→ opens it", (await row(pg, /^Round 1/).locator(".evb").getAttribute("aria-expanded")) === "true");
      const kb = (await anims(pg)).filter((a) => a.body);
      check("MF2: keyboard opens are instant", kb.length === 1 && kb[0].n === 0, JSON.stringify(kb));
      await pg.keyboard.press("ArrowLeft");
      await row(pg, /^Round 1/).locator(".evb").click();
      const pt = (await anims(pg)).filter((a) => a.body);
      check("MF2: a pointer open animates the body, its steps don't rise", pt.length === 2 && pt[1].n > 0 && (await anims(pg)).filter((a) => !a.body).every((a) => a.n === 0), JSON.stringify(pt));
      await row(pg, /^Round 1/).locator(".evb").click();
      await row(pg, /^Round 1/).locator(".evb").focus();
      await pg.keyboard.press("Home");
      const tip0 = await pg.locator(`#${await row(pg, "Wrote the plan").locator(".evb").getAttribute("aria-describedby")}`).evaluate((e) => getComputedStyle(e).opacity);
      check("MF3: keyboard focus on a row shows its tooltip at once", tip0 === "1", tip0);
      await pg.keyboard.press("Home");
      check("Home: the first row", (await focusedEntry(pg)) === "Wrote the plan");
      await pg.keyboard.press("Escape");
      check("Esc returns focus to the plan", await pg.evaluate(() => !!document.activeElement?.closest(".doc, .docwrap")));
    }

    // 3. A live run: the dot, steps as they come, Stop, one live message per run (#61, #62).
    await openAsk(pg);
    await recordAnims(pg);
    await pg.keyboard.press("Control+Enter");
    await pg.getByTestId("diagram-run").waitFor({ timeout: 5000 });
    await act(pg).locator(".ev6[data-status=running]").waitFor({ timeout: 5000 });
    const run = act(pg).locator(".ev6[data-status=running]");
    if (one) {
      check("live run: ember dot, “Adding diagrams”, open, Stop", (await run.locator(".ic .live").count()) === 1 && (await txt(run.locator(".tx b"))) === "Adding diagrams" && (await run.locator(".evb").getAttribute("aria-expanded")) === "true" && (await run.getByRole("button", { name: "Stop" }).count()) === 1);
      check("meta says when it started", /^Started \d/.test(await metaOf(run)), await metaOf(run));
      check("the running step is in the present: “Problem: drawing a diagram”", /^“?Problem”?: drawing a diagram/.test(await txt(run.locator(".st6[data-state=running]"))), await txt(run.locator(".steps6")));
      const stop = await run.evaluate((li) => ({ t: li.querySelector(".tx b").getBoundingClientRect(), s: li.querySelector(".stop6").getBoundingClientRect(), c: li.querySelector(".evh .chev")?.getBoundingClientRect(), col: getComputedStyle(li.querySelector(".stop6")).gridColumnStart }));
      check("MF1: Stop sits in the duration slot, top right before the chevron", stop.col === "3" && Math.abs(stop.s.top + stop.s.height / 2 - (stop.t.top + stop.t.height / 2)) <= 4 && stop.s.right <= (stop.c?.left ?? 1e9), JSON.stringify(stop));
      check("live region: started", /Claude Code started adding diagrams/.test(await live(pg)), await live(pg));
      check("one polite live region", (await act(pg).locator("[aria-live]").count()) === 1 && (await pg.getByTestId("activity-live").getAttribute("aria-live")) === "polite");
      check("the Activity tab shows a running dot", (await pg.locator(".rtabs .dot").count()) === 1);
      // A step that streams in while the body is open fades in, from the keyboard too (#81).
      await pg.keyboard.press("Shift");
      await pg.waitForFunction(() => (window.__anims ?? []).some((a) => a.fresh && !a.body), null, { timeout: 8000 }).catch(() => {});
      const st = (await anims(pg)).filter((a) => a.fresh && !a.body);
      check("MF2: streamed steps fade in, even with data-kbd", st.length > 0 && st.every((a) => a.n > 0) && st.some((a) => a.kbd), JSON.stringify(st));
      // The run bar's label opens Activity on that run (#66).
      await act(pg).locator(".evb").nth(2).focus();
      await pg.locator("[data-testid=diagram-run] .tolog").click();
      await pg.waitForTimeout(150);
      check("run bar label → Activity on that run", (await focusedEntry(pg)) === "Adding diagrams", await focusedEntry(pg));
    }
    await snap("i6-live");
    await axe(pg, `${theme} desktop: live run`);
    await waitRunEnd(pg);
    await pg.waitForFunction(() => document.querySelector("[data-testid=activity] .ev6")?.getAttribute("data-status") === "done", null, { timeout: 10000 });
    const done = row(pg, "Added diagrams");
    if (one) {
      check("finished: duration and suggestions in the meta", /1 diagram · 1 section skipped/.test(await metaOf(done)) && (await done.locator(".evh .dur").count()) === 1, await metaOf(done));
      const order = await done.locator(".acts6 .btn").allTextContents();
      check("Copy log has its icon", (await done.locator(".acts6 .btn svg").count()) === order.length, order.join(" | "));
      check("live region: finished, with time and suggestions", /Added diagrams in [\d.]+ (milli)?seconds?\. 1 suggestion to review\./.test(await live(pg)), await live(pg));
      check("steps each have a duration", (await done.locator(".st6 .dur").count()) === (await done.locator(".st6").count()));
      const chip = done.locator(".chips6[data-k=Suggestions] .chip6").first();
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
      const chip = done.locator(".chips6[data-k=Suggestions] .chip6").first();
      check("after Accept: chip says accepted", /accepted/.test(await txt(chip)), await txt(chip));
      await chip.click();
      await pg.waitForTimeout(150);
      check("accepted diagram chip → the figure itself, flashed", await pg.evaluate(() => !!document.querySelector(".doc figure.mm5[data-fl]")));
      const rv = row(pg, "You accepted 1 suggestion");
      check("review meta lists the section, not the count again", /Implementation decisions/.test(await metaOf(rv)) && !/1 accepted/.test(await metaOf(rv)), await metaOf(rv));
      // MF4 (#84): which version won a plan.md conflict is logged.
      const md = await planMd(pg);
      await pg.evaluate(async (markdown) => {
        await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan-conflict`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown, keep: "mine" }) });
      }, md);
      const fr = row(pg, "plan.md changed on disk");
      await fr.waitFor({ timeout: 5000 }).catch(() => {});
      check("MF4: “kept mine” is logged: plan.md changed on disk · you kept your version", /you kept your version/.test(await metaOf(fr)), await metaOf(fr));
    }
    await snap("i6-review");

    // Asked chips (PO): the chip opens the Decisions tab on that row, flashed and focused; axe both themes.
    {
      const r1 = row(pg, /^Round 1/);
      if ((await r1.locator(".evb").getAttribute("aria-expanded")) !== "true") await r1.locator(".evb").click();
      const chip = r1.locator(".chips6[data-k=Asked] .chip6").first();
      await chip.waitFor({ timeout: 5000 });
      await axe(pg, `${theme} desktop: round row with Asked chips`);
      const key = await chip.getAttribute("data-key");
      await chip.click();
      await pg.waitForTimeout(250);
      const j = await pg.evaluate((k) => ({ tab: document.querySelector("#ptab-decisions")?.getAttribute("aria-selected"), fl: document.querySelector(`.drow[data-key="${k}"]`)?.hasAttribute("data-fl"), focus: document.activeElement?.getAttribute("data-key") }), key);
      check(`${theme}: Asked chip → Decisions tab on that row, flashed and focused`, j.tab === "true" && j.fl === true && j.focus === key, JSON.stringify(j));
      await axe(pg, `${theme} desktop: Decisions after an Asked chip`);
      await pg.locator("#ptab-doc").click();
      await act(pg).waitFor({ timeout: 5000 }).catch(() => {});
    }

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
      check(`${theme}: failed run is open, says nothing changed or what was kept`, (await bad.locator(".evb").getAttribute("aria-expanded")) === "true" && /nothing was changed|rate|limit/i.test(await metaOf(bad)), await metaOf(bad));
      const tryBtn = bad.getByRole("button", { name: "Try again" });
      check(`${theme}: Try again is soft, before Copy log, with icons`, /soft/.test((await tryBtn.getAttribute("class")) ?? "") && (await bad.locator(".acts6 .btn").allTextContents()).map((t) => t.trim()).join("|") === "Try again|Copy log" && (await bad.locator(".acts6 .btn svg").count()) === 2);
      const fl = await bad.evaluate((li) => {
        const l = li.querySelector(".st6[data-state=failed] .l");
        const probe = document.createElement("span");
        probe.style.color = "var(--destructive-ink)";
        li.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return { got: l && getComputedStyle(l).color, want };
      });
      check(`${theme}: MF1: a failed step's label uses destructive ink`, !!fl.got && fl.got === fl.want, JSON.stringify(fl));
      if (SHOTS) await fpg.screenshot({ path: path.join(SHOTS, `i6-failed-d-${theme}.png`) });
      await axe(fpg, `${theme} desktop: failed run`);
      if (one) {
        // "New run above": scrolled down, a new run shows the pill (30px); it goes back to the top.
        await fpg.setViewportSize({ width: 1280, height: 520 });
        for (let i = 0; i < 12 && (await act(fpg).locator(".evb[aria-expanded=false]").count()); i++) await act(fpg).locator(".evb[aria-expanded=false]").first().click();
        await fpg.locator(".rscroll").evaluate((e) => (e.scrollTop = e.scrollHeight));
        await fpg.waitForTimeout(150);
        await fpg.evaluate(() => fetch(`/api/sessions/${location.pathname.split("/").pop()}/diagrams`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "retry" }) }));
        const pill = fpg.locator(".pill6", { hasText: "New run above" });
        await pill.waitFor({ timeout: 8000 }).catch(() => {});
        check("“New run above” pill when scrolled down, 30px", (await pill.count()) === 1 && (await pill.evaluate((e) => e.getBoundingClientRect().height)) === 30);
        if (SHOTS) await fpg.screenshot({ path: path.join(SHOTS, `i6-pill-d-${theme}.png`) });
        await pill.click().catch(() => {});
        await fpg.waitForTimeout(300);
        check("the pill goes back to the top", (await fpg.locator(".rscroll").evaluate((e) => e.scrollTop)) <= 48 && (await fpg.locator(".pill6").count()) === 0);
        await fpg.waitForFunction(() => /started again/.test(document.querySelector("[data-testid=activity] .ev6 .tx .m")?.textContent ?? ""), null, { timeout: 10000 });
        check("the retry says it started again after the run below", true);
        await fpg.setViewportSize({ width: 1440, height: 900 });
      }
      await fpg.close();
      await s3.stop();
    }

    const clip = video ? await pg.video()?.path() : null;
    await ctx.close();
    if (clip) renameSync(clip, path.join(SHOTS, "i6-desktop.webm"));
    await s.stop();

    // ---------------------------------------------------------------- mobile
    const s2 = await server({ FAKE_DIAGRAM_DELAY_MS: "2500" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await toPlan(mp, s2.url);
    await mp.getByRole("button", { name: "Plan actions" }).click();
    await mp.getByRole("menuitem", { name: /^Activity/ }).click();
    await act(mp).waitFor({ timeout: 5000 });
    const sheet = mp.locator(".csheet");
    check(`${theme} mobile: ⋯ → Activity opens the sheet on Activity, the tabs are its header`, (await sheet.locator(".sh b").count()) === 0 && (await mp.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")) === "true");
    if (one) {
      check("mobile: 12px row padding, 32px chips", (await act(mp).locator(".evh").first().evaluate((e) => getComputedStyle(e).paddingTop)) === "12px" && (await act(mp).locator(".chip6").first().evaluate((e) => e.getBoundingClientRect().height)) === 32);
    }
    if (SHOTS) {
      await mp.waitForTimeout(250);
      await mp.screenshot({ path: path.join(SHOTS, `i6-sheet-m-${theme}.png`) });
    }
    await axe(mp, `${theme} mobile: Activity sheet`);
    await act(mp).locator(".chips6[data-k=Wrote] .chip6").first().click();
    await mp.waitForTimeout(250);
    check(`${theme} mobile: a chip closes the sheet and shows a 44px “Back to Activity”`, (await mp.locator(".csheet").count()) === 0 && (await mp.getByRole("button", { name: "Back to Activity" }).count()) === 1 && (await mp.getByRole("button", { name: "Back to Activity" }).evaluate((e) => e.getBoundingClientRect().height)) === 44);
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, `i6-back-m-${theme}.png`) });
    await axe(mp, `${theme} mobile: Back to Activity`);
    await mp.getByRole("button", { name: "Back to Activity" }).click();
    await act(mp).waitFor({ timeout: 5000 });
    check(`${theme} mobile: back reopens Activity with the same open rows`, (await act(mp).locator(".evb[aria-expanded=true]").count()) >= 1);
    // Asked chips on mobile: the chip leaves the sheet for the Decisions row.
    {
      const r1 = row(mp, /^Round 1/);
      if ((await r1.locator(".evb").getAttribute("aria-expanded")) !== "true") await r1.locator(".evb").click();
      const chip = r1.locator(".chips6[data-k=Asked] .chip6").first();
      await chip.waitFor({ timeout: 5000 });
      if (SHOTS) {
        await mp.waitForTimeout(400);
        await chip.scrollIntoViewIfNeeded();
        await mp.waitForTimeout(250);
        await mp.screenshot({ path: path.join(SHOTS, `i6-asked-m-${theme}.png`) });
      }
      await axe(mp, `${theme} mobile: round row with Asked chips`);
      const key = await chip.getAttribute("data-key");
      await chip.click();
      await mp.waitForTimeout(300);
      const j = await mp.evaluate((k) => ({ sheet: !!document.querySelector(".csheet"), tab: document.querySelector("#ptab-decisions")?.getAttribute("aria-selected"), fl: document.querySelector(`.drow[data-key="${k}"]`)?.hasAttribute("data-fl"), focus: document.activeElement?.getAttribute("data-key") }), key);
      check(`${theme} mobile: Asked chip → sheet closes, Decisions on that row`, !j.sheet && j.tab === "true" && j.fl === true && j.focus === key, JSON.stringify(j));
      await axe(mp, `${theme} mobile: Decisions after an Asked chip`);
      await mp.locator("#ptab-doc").click();
    }
    // The ⋯ menu's Activity item shows the live dot while a run is going.
    {
      const md = await planMd(mp);
      const sec = /^## (.+)$/m.exec(md)?.[1];
      await mp.evaluate((sections) => fetch(`/api/sessions/${location.pathname.split("/").pop()}/diagrams`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ sections }) }), [sec]);
      await mp.getByTestId("diagram-run").waitFor({ timeout: 5000 }).catch(() => {});
      await mp.getByRole("button", { name: "Plan actions" }).click();
      const item = mp.getByRole("menuitem", { name: /^Activity/ });
      check(`${theme} mobile: ⋯ Activity shows the live dot during a run`, (await item.locator(".dot6").count()) === 1);
      if (SHOTS) {
        await mp.waitForTimeout(200);
        await mp.screenshot({ path: path.join(SHOTS, `i6-dot-m-${theme}.png`) });
      }
      await mp.keyboard.press("Escape");
      await waitRunEnd(mp).catch(() => {});
    }
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
