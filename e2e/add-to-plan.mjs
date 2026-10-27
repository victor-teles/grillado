// v1.2 polish §5 (DECISIONS #104), Add to plan: a decision no passage cites yet gets a quiet
// "Add to plan" (the row's action area on hover or focus, always in its DecisionCard header; on
// phones in place of the chevron). One run, then one line under the answer: running · Stop, ready
// · Review, none · Try again, failed · Try again; Stop is back to rest. Review opens the plan on the
// suggestion; Accept makes it a normal decision, Reject puts it back. While any run is busy the
// button is disabled with "{agent} is busy". One Activity row per run, a polite live region.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/add-to-plan.mjs            checks only (dark and light, desktop and phone)
//   SHOTS=dir node e2e/add-to-plan.mjs  also writes d-ap-rest, d-ap-busy, d-ap-run, d-ap-ready, d-ap-plan,
//                                       d-ap-card, d-ap-card-ready, d-ap-none, d-ap-fail, m-ap-rest, m-ap-run
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-ap-"));
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
    home,
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.on("exit", r);
        child.kill("SIGINT");
      }),
  };
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
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    }
    return false;
  }, text);
async function axe(pg, name) {
  // Let fades settle first, so contrast is read at rest, not mid-transition.
  await pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 2000 }).catch(() => {});
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
async function toPlan(pg) {
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
const sid = (pg) => pg.evaluate(() => location.pathname.split("/").pop());
const sessionJson = (pg) => pg.evaluate(async () => (await fetch(`/api/sessions/${location.pathname.split("/").pop()}`)).json());
/** The colour a CSS variable resolves to, as getComputedStyle reports colours. */
const tokenColour = (pg, v) =>
  pg.evaluate((v) => {
    const x = document.createElement("span");
    x.style.color = `var(${v})`;
    document.body.append(x);
    const c = getComputedStyle(x).color;
    x.remove();
    return c;
  }, v);
const tokenBg = (pg, v) =>
  pg.evaluate((v) => {
    const x = document.createElement("span");
    x.style.background = `var(${v})`;
    document.body.append(x);
    const c = getComputedStyle(x).backgroundColor;
    x.remove();
    return c;
  }, v);

const FLOW_ENV = { FAKE_PLAN_OMIT: "storage,platform" };
const rowOf = (pg, key) => pg.locator(`.drow[data-key="${key}"]`);
const apState = (pg, key) => pg.evaluate((k) => document.querySelector(`.drow[data-key="${k}"] .apl`)?.dataset.ap ?? "rest", key);
const waitAp = (pg, key, want, timeout = 10000) => pg.waitForFunction(([k, w]) => (document.querySelector(`.drow[data-key="${k}"] .apl`)?.dataset.ap ?? "rest") === w, [key, want], { timeout }).then(() => true, () => false);
const live = (pg) => pg.evaluate(() => document.querySelector("[data-ap-live]")?.textContent ?? "");
const waitLive = (pg, want) => pg.waitForFunction((w) => document.querySelector("[data-ap-live]")?.textContent === w, want, { timeout: 10000 }).then(() => true, () => false);
const toDecisions = async (pg) => {
  await pg.locator("#ptab-decisions").click();
  await pg.locator(".drow").first().waitFor();
};
const toDocument = async (pg) => {
  await pg.locator("#ptab-doc").click();
  await pg.getByTestId("plan").waitFor();
};
/** What the row shows: its line, the button (hidden or not, disabled), the orphan note, a chevron. */
const rowInfo = (pg, key) =>
  pg.evaluate((k) => {
    const r = document.querySelector(`.drow[data-key="${k}"]`);
    const apb = r.querySelector(".apb");
    const b = apb?.querySelector("button");
    const line = r.querySelector(".apl");
    return {
      line: line ? [...line.children].map((c) => c.textContent.trim()).filter(Boolean).join(" ") : "",
      links: line ? [...line.querySelectorAll(".lnk")].map((x) => x.textContent.trim()) : [],
      btn: b ? { text: b.textContent.trim(), vis: getComputedStyle(apb).visibility, dis: b.getAttribute("aria-disabled"), colour: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), op: getComputedStyle(b.closest(".drow-ra") ?? b).opacity } : null,
      orph: !!r.querySelector(".orph"),
      show: !!r.querySelector('[aria-label^="Show in plan"]'),
      chev: !!r.querySelector(":scope > svg"),
      x: Math.round(r.querySelector(".drow-a").getBoundingClientRect().x),
    };
  }, key);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    // ================================================================ desktop: run, Stop, Review, Accept, Reject
    const s = await server({ ...FLOW_ENV, FAKE_ADDPLAN_DELAY_MS: "4000" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const snap = async (name) => {
      if (!SHOTS) return;
      await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await pg.waitForTimeout(260);
      await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await pg.goto(s.url);
    await toPlan(pg);
    await toDecisions(pg);
    const blue = await tokenColour(pg, "--primary");

    // rest: the orphan note, Add to plan in place of Show in plan; quiet until hover or focus
    let r = await rowInfo(pg, "storage");
    check(`${theme}: an orphan row says Not in the plan text yet, with Add to plan instead of Show in plan`, r.orph && !r.show && r.btn?.text === "Add to plan" && r.btn.vis === "visible" && r.line === "", JSON.stringify(r));
    check(`${theme}: a cited decision keeps Show in plan, no Add to plan`, (await rowInfo(pg, "scope")).show && !(await rowInfo(pg, "scope")).btn);
    check(`${theme}: Add to plan is not shown until the row is hovered or focused`, r.btn.op === "0", r.btn.op);
    await rowOf(pg, "storage").hover();
    await pg.waitForTimeout(250);
    r = await rowInfo(pg, "storage");
    check(`${theme}: hover shows it, quiet and never blue`, r.btn.op === "1" && r.btn.colour !== blue && r.btn.bg !== blue, JSON.stringify(r.btn));
    await snap("d-ap-rest");
    await axe(pg, `${theme} desktop: orphan rows at rest`);
    // keyboard: → from the row lands on Add to plan
    await rowOf(pg, "storage").focus();
    await pg.keyboard.press("ArrowRight");
    check(`${theme}: → from the row focuses Add to plan`, await pg.evaluate(() => document.activeElement?.textContent.trim() === "Add to plan"));
    const x0 = r.x;

    // running: the line, the button hidden (no column shift), Stop; the live region; the other orphan is busy
    await pg.keyboard.press("Enter");
    const T0 = Date.now();
    check(`${theme}: running, "Claude Code writing it into the plan · Stop"`, await waitAp(pg, "storage", "running", 3000));
    r = await rowInfo(pg, "storage");
    check(`${theme}: the line and Stop; the orphan note and button gone (button by visibility)`, r.line === "Claude Code writing it into the plan Stop" && r.links.join() === "Stop" && !r.orph && r.btn?.vis === "hidden" && r.x === x0, JSON.stringify(r));
    const dot = await pg.evaluate(() => {
      const d = document.querySelector('.drow[data-key="storage"] .apl .dot');
      return d ? { bg: getComputedStyle(d).backgroundColor, anim: d.getAnimations().length } : null;
    });
    check(`${theme}: a static --muted-foreground dot`, dot?.bg === (await tokenBg(pg, "--muted-foreground")) && dot.anim === 0, JSON.stringify(dot));
    check(`${theme}: focus goes to Stop when the button hides`, await pg.waitForFunction(() => document.activeElement?.textContent.trim() === "Stop", null, { timeout: 1000 }).then(() => true, () => false), await pg.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    check(`${theme}: live region says Writing it into the plan`, await waitLive(pg, "Writing it into the plan"), await live(pg));
    const busy = await rowInfo(pg, "platform");
    const tip = await pg.evaluate(() => {
      const b = document.querySelector('.drow[data-key="platform"] .apb button');
      const t = b && document.getElementById(b.getAttribute("aria-describedby") ?? "");
      return t ? { text: t.textContent, role: t.getAttribute("role") } : null;
    });
    check(`${theme}: while it runs, another orphan's Add to plan is disabled, "Claude Code is busy"`, busy.btn?.dis === "true" && tip?.text === "Claude Code is busy" && tip.role === "tooltip", JSON.stringify({ busy: busy.btn, tip }));
    await rowOf(pg, "platform").hover();
    await pg.locator('.drow[data-key="platform"] .apb button').hover();
    await pg.waitForTimeout(700); // the tip waits 400ms, then fades in
    const tipVis = await pg.evaluate(() => getComputedStyle(document.querySelector('.drow[data-key="platform"] .aptip')).opacity);
    check(`${theme}: hovering the disabled button shows the tip`, tipVis === "1", tipVis);
    const off = await pg.evaluate(() => {
      const b = document.querySelector('.drow[data-key="platform"] .apb button');
      return { c: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor };
    });
    check(`${theme}: …and it stays dim on hover (--subtle-foreground, no fill)`, off.c === (await tokenColour(pg, "--subtle-foreground")) && off.bg === "rgba(0, 0, 0, 0)", JSON.stringify(off));
    await snap("d-ap-busy");
    await pg.locator('.drow[data-key="platform"] .apb button').click({ force: true }); // Playwright waits on aria-disabled
    const after1 = { el: Date.now() - T0, p: await apState(pg, "platform"), s: await apState(pg, "storage"), run: (await sessionJson(pg)).addPlanRun };
    check(`${theme}: clicking it does nothing`, after1.p === "rest" && after1.s === "running" && after1.run?.decision === "storage", JSON.stringify(after1));
    await rowOf(pg, "storage").hover();
    await snap("d-ap-run");
    await axe(pg, `${theme} desktop: running`);

    // Stop: back to rest with no note
    await rowOf(pg, "storage").getByRole("button", { name: "Stop adding it to the plan" }).click();
    const stopped = await waitAp(pg, "storage", "rest", 5000);
    check(`${theme}: Stop goes back to rest, no note`, stopped, stopped ? "" : JSON.stringify({ run: (await sessionJson(pg)).addPlanRun, adding: (await sessionJson(pg)).adding, toast: await pg.evaluate(() => document.querySelector(".toast, [role=alert]")?.textContent) }));
    r = await rowInfo(pg, "storage");
    check(`${theme}: …the orphan note and Add to plan are back`, r.orph && r.btn?.vis === "visible" && r.line === "", JSON.stringify(r));

    // ready → Review → the plan on the suggestion, its cite lit, bar and pill
    await rowOf(pg, "storage").hover();
    await rowOf(pg, "storage").getByRole("button", { name: /^Add to plan/ }).click();
    check(`${theme}: ready, "1 suggestion to review · Review"`, await waitAp(pg, "storage", "ready", 20000));
    r = await rowInfo(pg, "storage");
    check(`${theme}: the ready line`, r.line === "1 suggestion to review Review" && r.links.join() === "Review", JSON.stringify(r));
    check(`${theme}: live region says 1 suggestion to review`, await waitLive(pg, "1 suggestion to review"), await live(pg));
    const sj = await sessionJson(pg);
    const sug = (sj.suggestions ?? []).find((x) => x.id === sj.addPlanRun?.suggestion);
    check(`${theme}: one pending suggestion, with the decision as its source`, sug?.status === "pending" && sug.source?.kind === "decision" && sug.source.id === "storage" && /\[R2:storage\]/.test(sug.after), JSON.stringify(sug));
    check(`${theme}: the plan text hasn't changed`, !/R2:storage/.test(sj.plan.markdown.replace(/```[\s\S]*?```/g, "")));
    await snap("d-ap-ready");
    await axe(pg, `${theme} desktop: ready`);
    await rowOf(pg, "storage").getByRole("button", { name: "Review the suggestion" }).click();
    await pg.getByTestId("plan").waitFor();
    const rv = await pg.waitForFunction(
      (id) => {
        const ins = document.querySelector(`ins.sg[data-sg="${id}"]`);
        const pill = document.querySelector(".ipill");
        const bar = document.querySelector(".review");
        return ins && pill && bar ? { doc: document.querySelector("#ptab-doc")?.getAttribute("aria-selected"), f: ins.classList.contains("f"), bar: bar.textContent.replace(/\s+/g, " ").trim(), pill: pill.textContent.replace(/\s+/g, " ").trim(), raw: /\[R2:storage\]/.test(ins.textContent), lit: [...document.querySelectorAll(".gut-cite")].filter((c) => /Keep data local first/.test(c.getAttribute("aria-label") ?? "")).map((c) => c.classList.contains("on")) } : null;
      },
      sug?.id,
      { timeout: 5000 },
    ).then((h) => h.jsonValue(), () => null);
    check(`${theme}: Review opens the Document tab on the suggestion, focused, with the 1/1 pill and the bar`, rv?.doc === "true" && rv.f && /^1\/1/.test(rv.pill) && /^1 suggestion from Claude Code/.test(rv.bar), JSON.stringify(rv));
    check(`${theme}: the inserted cite isn't shown raw`, rv && !rv.raw, JSON.stringify(rv));
    check(`${theme}: its margin cite is there and lit`, rv?.lit?.length === 1 && rv.lit[0] === true, JSON.stringify(rv?.lit));
    await snap("d-ap-plan");
    await axe(pg, `${theme} desktop: reviewing the suggestion`);
    await pg.locator(".ipill").getByRole("button", { name: /^Accept/ }).click();
    await pg.waitForFunction(() => !document.querySelector("ins.sg"), null, { timeout: 5000 });
    const acc = await sessionJson(pg);
    check(`${theme}: Accept writes it into the plan with its cite`, /\[R2:storage\]/.test(acc.plan.markdown.replace(/```[\s\S]*?```/g, "")), acc.plan.markdown.slice(-200));
    await toDecisions(pg);
    r = await rowInfo(pg, "storage");
    check(`${theme}: …and the row is a normal decision (Show in plan, no note, no line)`, !r.orph && r.show && !r.btn && r.line === "", JSON.stringify(r));

    // the other orphan: from its DecisionCard in the document, then Reject puts it back
    await toDocument(pg);
    const card = pg.locator('.dz[data-key="platform"]');
    await card.scrollIntoViewIfNeeded();
    const cb = await card.evaluate((el) => {
      const b = el.querySelector(".dz-h .apb button");
      return { orph: /Not in the plan text yet/.test(el.querySelector(".dz-h").textContent), btn: b?.textContent.trim(), vis: b ? getComputedStyle(b.closest(".apb")).visibility : "", colour: b ? getComputedStyle(b).color : "" };
    });
    check(`${theme}: the orphan's DecisionCard header always has Add to plan, never blue`, cb.orph && cb.btn === "Add to plan" && cb.vis === "visible" && cb.colour !== blue, JSON.stringify(cb));
    await pg.locator(".toast").waitFor({ state: "detached", timeout: 10000 }).catch(() => {}); // the Accepted toast and flash go first
    await card.hover();
    await snap("d-ap-card");
    await card.locator(".dz-h").getByRole("button", { name: /^Add to plan/ }).click();
    const cl = await pg.waitForFunction(() => document.querySelector('.dz[data-key="platform"] .dz-h .apl')?.dataset.ap ?? null, null, { timeout: 3000 }).then((h) => h.jsonValue(), () => null);
    check(`${theme}: the card header shows the running line`, cl === "running", String(cl));
    await pg.waitForFunction(() => document.querySelector('.dz[data-key="platform"] .dz-h .apl')?.dataset.ap === "ready", null, { timeout: 20000 });
    await card.hover();
    await snap("d-ap-card-ready");
    await axe(pg, `${theme} desktop: DecisionCard, ready`);
    await card.getByRole("button", { name: "Review the suggestion" }).click();
    await pg.locator(".ipill").waitFor({ timeout: 5000 });
    await pg.locator(".ipill").getByRole("button", { name: /^Reject/ }).click();
    await pg.waitForFunction(() => !document.querySelector("ins.sg"), null, { timeout: 5000 });
    await toDecisions(pg);
    r = await rowInfo(pg, "platform");
    check(`${theme}: Reject puts it back to Not in the plan text yet, with Add to plan`, r.orph && r.btn?.vis === "visible" && r.line === "" && !r.show, JSON.stringify(r));

    // one Activity row per run
    await toDocument(pg);
    await pg.locator(".doc").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await pg.keyboard.press("Control+Alt+KeyA");
    const titles = await pg.waitForFunction(() => {
      const t = [...document.querySelectorAll(".ev6 .tx b")].map((e) => e.textContent.trim()).filter((t) => /decision to the plan/.test(t));
      return t.length >= 3 ? t : null;
    }, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => []);
    await snap("d-ap-activity");
    check(`${theme}: Activity has "Added a decision to the plan" (twice) and the stopped run`, titles.filter((t) => t.startsWith("Added a decision to the plan")).length === 2 && titles.some((t) => t.startsWith("Stopped adding a decision to the plan")), JSON.stringify(titles));
    await ctx.close();
    await s.stop();

    // ================================================================ desktop: none, failed, Try again
    for (const [mode, want, line, liveWant] of [
      ["none", "none", "Claude Code found no place for it Try again", "No place found"],
      ["fail-once", "failed", "Couldn’t add it Try again", "Couldn’t add it"],
    ]) {
      const s3 = await server({ ...FLOW_ENV, FAKE_ADDPLAN: mode, FAKE_ADDPLAN_DELAY_MS: "300" });
      const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
      await c3.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const p3 = await c3.newPage();
      await p3.goto(s3.url);
      await toPlan(p3);
      await toDecisions(p3);
      await rowOf(p3, "storage").hover();
      await rowOf(p3, "storage").getByRole("button", { name: /^Add to plan/ }).click();
      check(`${theme}: ${mode}: the row says "${line}"`, await waitAp(p3, "storage", want, 10000));
      const r3 = await rowInfo(p3, "storage");
      check(`${theme}: ${mode}: line text, button hidden`, r3.line === line && r3.btn?.vis === "hidden" && !r3.orph, JSON.stringify(r3));
      check(`${theme}: ${mode}: live region says ${liveWant}`, await waitLive(p3, liveWant), await live(p3));
      if (want === "failed") {
        const ic = await p3.evaluate(() => {
          const e = document.querySelector('.drow[data-key="storage"] .apl .err');
          const t = document.querySelector('.drow[data-key="storage"] .apl .t');
          return { icon: e ? getComputedStyle(e).color : "", svg: !!e?.querySelector("svg"), text: t ? getComputedStyle(t).color : "" };
        });
        check(`${theme}: failed: a --destructive-ink alert icon, the words in foreground`, ic.svg && ic.icon === (await tokenColour(p3, "--destructive-ink")) && ic.text === (await tokenColour(p3, "--foreground")), JSON.stringify(ic));
      }
      await rowOf(p3, "storage").hover();
      if (SHOTS) {
        await p3.waitForTimeout(260);
        await p3.screenshot({ path: path.join(SHOTS, `d-ap-${want === "failed" ? "fail" : "none"}-${theme}.png`) });
      }
      await axe(p3, `${theme} desktop: ${want}`);
      await rowOf(p3, "storage").getByRole("button", { name: "Try again to add it to the plan" }).click();
      const after = mode === "none" ? "none" : "ready";
      check(`${theme}: ${mode}: Try again runs it again (→ ${after})`, await p3.waitForFunction(() => document.querySelector('.drow[data-key="storage"] .apl')?.dataset.ap === "running", null, { timeout: 3000 }).then(() => true, () => false) && (await waitAp(p3, "storage", after, 10000)));
      await c3.close();
      await s3.stop();
    }

    // ================================================================ phone: in place of the chevron, 44px
    const s2 = await server({ ...FLOW_ENV, FAKE_ADDPLAN_DELAY_MS: "3000" });
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    const msnap = async (name) => {
      if (!SHOTS) return;
      await mp.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
      await mp.waitForTimeout(260);
      await mp.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    };
    await mp.goto(s2.url);
    await toPlan(mp);
    await toDecisions(mp);
    const m = await mp.evaluate(() => {
      const r = document.querySelector('.drow[data-key="storage"]');
      const b = r.querySelector(".mapl");
      const br = b?.getBoundingClientRect();
      const hb = b && getComputedStyle(b, "::before");
      return { b: b?.textContent.trim(), w: br && Math.round(br.width), h: br && Math.round(br.height), hit: hb ? `${hb.top} ${hb.bottom}` : "", chev: !!r.querySelector(":scope > svg"), other: !!document.querySelector('.drow[data-key="scope"] > svg') };
    });
    check(`${theme} phone: Add to plan replaces the chevron on an orphan row (others keep theirs)`, m.b === "Add to plan" && !m.chev && m.other, JSON.stringify(m));
    check(`${theme} phone: a 44px target`, m.h >= 44, JSON.stringify(m));
    await msnap("m-ap-rest");
    await axe(mp, `${theme} phone: orphan rows at rest`);
    await mp.locator('.drow[data-key="storage"] .mapl').tap();
    check(`${theme} phone: tapping it runs (it doesn't open the card)`, (await waitAp(mp, "storage", "running", 3000)) && (await mp.locator("#ptab-decisions[aria-selected=true]").count()) === 1);
    const mr = await rowInfo(mp, "storage");
    check(`${theme} phone: running shows the line and no chevron or button`, mr.line === "Claude Code writing it into the plan Stop" && !mr.chev && !mr.btn, JSON.stringify(mr));
    await msnap("m-ap-run");
    await axe(mp, `${theme} phone: running`);
    check(`${theme} phone: ready`, await waitAp(mp, "storage", "ready", 20000));
    await axe(mp, `${theme} phone: ready`);
    await mctx.close();
    await s2.stop();
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 4).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
