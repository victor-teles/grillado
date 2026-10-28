// The designer's four findings from recording the v1.3 demo on main 1d5e106 with real Grok:
//   MUST 1  Plan actions: the save path is one line inside the menu, cut in the middle, the whole path in its title and the clipboard.
//   MUST 2  Found keeps the original agent: a Claude Code import with only Grok installed runs on Grok, says so
//           in one quiet line, and plates without a picker or an "isn't installed" card first.
//   NTH 1   "Is it done?": a long answer truncates and its "Your call" tag never does; on a phone the tag goes under it.
//   NTH 2   Decisions are named by their short title, never the internal R·n code (that stays in title attributes).
// And review-pr27 nice 1: reloading a session page never flashes Home while its GET is in flight.
// Desktop (1440) and 320, light and dark. One server and one browser at a time; only processes started here are killed.
//   node e2e/demo-findings.mjs                 checks only
//   SHOTS=dir node e2e/demo-findings.mjs       also writes the frames to dir
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { quiet, until } from "./wait.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-demo-e2e-")));
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

// Only Grok is installed: no claude, no codex on PATH.
const bin = mkdtempSync(path.join(WORK, "bin-"));
writeFileSync(path.join(bin, "grok"), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" grok "$@"\n`);
chmodSync(path.join(bin, "grok"), 0o755);

const LONG_LABEL = "Where the family’s recipes come from, and who keeps every one of them up to date on every phone in the house";
// The designer's short answer that a phone cut to "Everyone at …" (review-pr28 must 1).
const HOME_ANSWER = "Everyone at home, my partner and the two kids";
const LONG_ANSWER = "Typed in by hand from the recipe cards in the kitchen drawer, one at a time, with a photo of each card kept next to it so nothing written in the margins is ever lost";

/** A project with one Claude Code interview (the partial fixture: three answered, one torn), its answer and header made long. */
function world() {
  const tmp = mkdtempSync(path.join(WORK, "w-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "pantry");
  mkdirSync(path.join(root, "src"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const claude = path.join(home, ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(claude, { recursive: true });
  const src = readFileSync(path.join(ROOT, "test/fixtures/found/claude/partial.jsonl"), "utf8")
    .replaceAll("__ROOT__", root)
    .replace('"header": "Recipes"', `"header": "${LONG_LABEL}"`)
    .replace('"Where do recipes come from?": "Typed in"', `"Where do recipes come from?": "${LONG_ANSWER}"`)
    .replace('"Who uses the app first?": "Just my family"', `"Who uses the app first?": "${HOME_ANSWER}"`);
  if (!src.includes(LONG_LABEL) || !src.includes(LONG_ANSWER) || !src.includes(HOME_ANSWER)) throw new Error("the fixture changed: can't lengthen its row");
  const f = path.join(claude, "partial.jsonl");
  writeFileSync(f, src);
  const ago = (Date.now() - 3600_000) / 1000;
  utimesSync(f, ago, ago);
  const ctl = path.join(home, "fake-ctl.json");
  writeFileSync(ctl, "{}");
  return { home, root, ctl };
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function server(w) {
  const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: w.home, GRILLADO_HOME: path.join(w.home, ".grillado"), FAKE_STATE_DIR: w.home, FAKE_CTL: w.ctl };
  const child = spawn(NODE, [CLI, "--no-open", "--port", String(await freePort())], { env, cwd: w.root, stdio: ["ignore", "pipe", "pipe"] });
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
  return { url, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}

const VIEWS = [
  { tag: "desktop", w: 1440, h: 900, phone: false },
  { tag: "m320", w: 320, h: 720, phone: true },
];
const THEMES = ["light", "dark"];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
async function page(srv, vp, theme) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: vp.phone, hasTouch: vp.phone });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(srv.url).origin });
  await ctx.addInitScript((th) => localStorage.setItem("grillado-theme", th), theme);
  const pg = await ctx.newPage();
  return { ctx, pg };
}
async function shot(pg, name) {
  if (!SHOTS) return;
  await quiet(pg).catch(() => {});
  await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, lh: parseFloat(getComputedStyle(e).lineHeight) }; });
const CODE = /\bR\d+·\d+\b/;

const w = world();
const srv = await server(w);
try {
  // ---------------------------------------------------------------- MUST 2: import a Claude Code interview with only Grok installed
  let sid = "";
  {
    const { ctx, pg } = await page(srv, VIEWS[0], "light");
    await pg.goto(srv.url);
    const row = pg.getByTestId("found-row").filter({ hasText: "chore rota" });
    await row.getByRole("button", { name: "Import" }).waitFor({ timeout: 15000 });
    check("MUST 2: Found lists the Claude Code interview", /Claude Code session/.test((await row.textContent()) ?? ""), (await row.textContent()) ?? "");
    await row.getByRole("button", { name: "Import" }).click();
    const rec = pg.locator(".recent .rrow").filter({ hasText: /chore rota/i }).first();
    await rec.waitFor({ timeout: 10000 });
    sid = /\/s\/([\w-]+)/.exec((await rec.getAttribute("href")) ?? "")?.[1] ?? "";
    check("MUST 2: the import made a plan", !!sid, (await rec.getAttribute("href")) ?? "");
    await ctx.close();
  }
  const sessionUrl = (u) => u.replace(/\/\?t=/, `/s/${sid}?t=`);

  // ---------------------------------------------------------------- the confirm screen in every view: MUST 2's line and NTH 1's row
  for (const vp of VIEWS)
    for (const theme of THEMES) {
      const tag = `${vp.tag}-${theme}`;
      const { ctx, pg } = await page(srv, vp, theme);
      await pg.goto(sessionUrl(srv.url));
      await pg.getByRole("button", { name: /Yes, plate it/ }).waitFor({ timeout: 10000 });
      const note = pg.getByTestId("agent-note").first();
      await note.waitFor({ timeout: 5000 }).catch(() => {});
      check(`MUST 2 ${tag}: the quiet line "Using Grok · Claude Code isn’t installed"`, (await note.count()) === 1 && (await note.textContent()) === "Using Grok · Claude Code isn’t installed" && (await note.isVisible()), (await note.count()) ? await note.textContent() : "none");
      check(`MUST 2 ${tag}: no failure card first`, (await pg.getByText("Install it, then retry").count()) === 0 && (await pg.locator("[role=alert]").filter({ hasText: /isn’t installed/ }).count()) === 0);
      await shot(pg, `must2-agent-note-${tag}`);

      // NTH 1: the long row's answer truncates; "Your call" is whole, after it on desktop and under it at 320.
      const dr = pg.locator(".dr").filter({ hasText: LONG_ANSWER.slice(0, 30) }).first();
      await dr.scrollIntoViewIfNeeded();
      const va = await rect(dr.locator(".va"));
      const ycL = dr.locator(".yc");
      const yc = await rect(ycL);
      const v = await rect(dr.locator(".v"));
      check(`NTH 1 ${tag}: "Your call" is whole (not "Yo…")`, (await ycL.textContent()) === "Your call" && yc.sw <= yc.cw + 0.5 && yc.r <= v.r + 0.5, JSON.stringify(yc));
      if (vp.phone) check(`NTH 1 ${tag}: the long answer wraps, then stops at three lines`, va.sw <= va.cw + 0.5 && va.sh > va.ch && Math.round(va.ch / va.lh) === 3 && va.r <= v.r + 0.5, JSON.stringify(va));
      else check(`NTH 1 ${tag}: the long answer is what truncates`, va.sw > va.cw && va.r <= v.r + 0.5, JSON.stringify(va));
      check(`review-pr28 must 1 ${tag}: the cut answer's whole text is in its title`, (await dr.locator(".va").getAttribute("title")) === LONG_ANSWER);
      // review-pr28 must 1: a short answer is never cut, at any width (on a phone it wraps).
      const home = pg.locator(".dr .va").filter({ hasText: "Everyone at home" }).first();
      const hr = await rect(home);
      check(`review-pr28 must 1 ${tag}: "${HOME_ANSWER}" is not cut`, (await home.textContent()) === HOME_ANSWER && hr.sw <= hr.cw + 0.5 && hr.sh <= hr.ch + 0.5 && hr.r <= vp.w + 0.5, JSON.stringify(hr));
      const cut = await pg.locator(".dr .va").evaluateAll((es) => es.filter((e) => e.textContent.length < 60 && (e.scrollWidth > e.clientWidth + 0.5 || e.scrollHeight > e.clientHeight + 0.5)).map((e) => e.textContent));
      check(`review-pr28 must 1 ${tag}: no short answer is cut`, cut.length === 0, JSON.stringify(cut));
      if (vp.phone) check(`NTH 1 ${tag}: on a phone the tag sits under the answer`, yc.t >= va.b - 1, `${yc.t} vs ${va.b}`);
      else check(`NTH 1 ${tag}: on desktop the tag stays on the answer's line, after it`, Math.abs(yc.t + yc.b - va.t - va.b) / 2 < 4 && yc.l >= va.r - 0.5, `${JSON.stringify(yc)} ${JSON.stringify(va)}`);
      await shot(pg, `nth1-yourcall-${tag}`);
      await ctx.close();
    }

  // ---------------------------------------------------------------- MUST 2: plate on Grok, no picker, no failure first
  {
    const { ctx, pg } = await page(srv, VIEWS[0], "light");
    await pg.addInitScript(() => {
      window.__bad = [];
      new MutationObserver(() => {
        const t = document.body?.innerText ?? "";
        if (/Install it, then retry|Choose an agent|Pick an agent/.test(t)) window.__bad.push(t.slice(0, 200));
        if (document.querySelector("[role=dialog]")) window.__bad.push("dialog");
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await pg.goto(sessionUrl(srv.url));
    await pg.getByRole("button", { name: /Yes, plate it/ }).click();
    await pg.getByTestId("plan").waitFor({ timeout: 30000 });
    const bad = await pg.evaluate(() => window.__bad);
    check("MUST 2: plating runs on Grok straight away: no picker, no “isn’t installed” card", bad.length === 0, bad.slice(0, 2).join(" | "));
    const meta = pg.getByTestId("agent-note");
    check("MUST 2: the plan's provenance line keeps the quiet note", (await meta.count()) >= 1 && (await meta.first().textContent()) === "Using Grok · Claude Code isn’t installed", (await meta.count()) ? await meta.first().textContent() : "none");
    await ctx.close();
  }

  // ---------------------------------------------------------------- the plan in every view: MUST 1's menu and NTH 2's names
  const planFile = path.join(w.home, ".grillado", "sessions", sid, "plan.md");
  for (const vp of VIEWS)
    for (const theme of THEMES) {
      const tag = `${vp.tag}-${theme}`;
      const { ctx, pg } = await page(srv, vp, theme);
      await pg.goto(sessionUrl(srv.url));
      await pg.getByTestId("plan").waitFor({ timeout: 10000 });
      await pg.locator(".dz").first().waitFor({ timeout: 10000 });

      // NTH 2: decision cards name the decision, not its code.
      const card = pg.locator(".dz").filter({ has: pg.locator(".dz-id", { hasText: LONG_LABEL.slice(0, 20) }) }).first();
      await card.scrollIntoViewIfNeeded();
      if (!vp.phone) await card.hover();
      const id = card.locator(".dz-id");
      await until(async () => (await id.evaluate((e) => getComputedStyle(e.parentElement).opacity)) === "1", "the card's meta line", 5000).catch(() => {});
      const ir = await rect(id);
      const cr = await rect(card);
      check(`NTH 2 ${tag}: the card's meta names the decision by its short title, the R·n code only in its title`, LONG_LABEL.startsWith((await id.textContent()) ?? "-") && ((await id.textContent()) ?? "").length >= 40 && /^R\d+·\d+$/.test((await id.getAttribute("title")) ?? ""), `${await id.textContent()} | ${await id.getAttribute("title")}`);
      check(`NTH 2 ${tag}: a long title ends in an ellipsis inside the card`, ir.sw > ir.cw && ir.r <= cr.r + 0.5 && (await id.evaluate((e) => getComputedStyle(e).textOverflow)) === "ellipsis", JSON.stringify({ ir, cr: cr.r }));
      const shown = await pg.locator(".dz").evaluateAll((els) => els.map((e) => e.innerText).join(" "));
      check(`NTH 2 ${tag}: no card shows an R·n code`, !CODE.test(shown), (CODE.exec(shown) ?? [""])[0]);
      await shot(pg, `nth2-cards-${tag}`);

      // MUST 1: the save path in Plan actions.
      await pg.getByRole("button", { name: "Plan actions" }).click();
      const menu = pg.locator("[role=menu]").first();
      await menu.waitFor({ timeout: 5000 });
      const pp = pg.getByTestId("plan-path");
      const m = await rect(menu);
      const p = await rect(pp);
      const head = await rect(pp.locator(".pp-h"));
      const tail = await rect(pp.locator(".pp-t"));
      check(`MUST 1 ${tag}: the path's box sits inside the menu`, p.l >= m.l - 0.5 && p.r <= m.r + 0.5 && m.r <= vp.w + 0.5 && m.l >= -0.5, JSON.stringify({ p, m }));
      check(`MUST 1 ${tag}: one line (16px), cut in the middle: the start ends in “…”, “plan.md” whole`, Math.round(p.b - p.t) <= 17 && head.sw > head.cw && (await pp.locator(".pp-t").textContent()) === "plan.md" && tail.r <= m.r + 0.5, JSON.stringify({ h: p.b - p.t, head, tail }));
      check(`MUST 1 ${tag}: the whole path in the title attribute and the text`, (await pg.locator(".pmenu-path").getAttribute("title")) === planFile && (await pp.textContent()) === planFile, (await pg.locator(".pmenu-path").getAttribute("title")) ?? "");
      check(`MUST 1 ${tag}: mono only for the path`, (await pp.evaluate((e) => getComputedStyle(e).fontFamily)) !== (await pg.locator(".pmenu-path").evaluate((e) => getComputedStyle(e).fontFamily)));
      await shot(pg, `must1-menu-${tag}`);
      await pg.evaluate(() => navigator.clipboard.writeText(""));
      await pg.getByRole("menuitem", { name: "Show file location" }).click();
      await pg.getByText("Copied the path to plan.md").first().waitFor({ timeout: 5000 }).catch(() => {});
      const clip = await pg.evaluate(() => navigator.clipboard.readText());
      check(`MUST 1 ${tag}: Show file location copies the whole path`, clip === planFile && (await pg.getByText("Copied the path to plan.md").count()) >= 1, clip);

      // NTH 2: the Decisions list's meta line names it too, never the code.
      if (await menu.isVisible()) await pg.keyboard.press("Escape");
      await menu.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      const tabs = pg.getByRole("tab", { name: /Decisions/ });
      await tabs.first().waitFor({ timeout: 5000 });
      {
        await tabs.first().click();
        const drow = pg.locator(".drow").filter({ hasText: "Where do recipes come from?" }).first();
        await drow.waitFor({ timeout: 5000 });
        if (!vp.phone) {
          await drow.hover();
          const dm = drow.locator(".drow-m");
          const t = (await dm.textContent()) ?? "";
          const r = await rect(dm);
          const rr = await rect(drow);
          check(`NTH 2 ${tag}: the Decisions row's meta has the title, not the code, and truncates in the row`, LONG_LABEL.startsWith(t.slice(0, 40)) && !CODE.test(t) && /^R\d+·\d+$/.test((await dm.getAttribute("title")) ?? "") && r.r <= rr.r + 0.5 && r.sw > r.cw, `${t} | ${JSON.stringify(r)}`);
        }
        const all = await pg.locator(".drow").evaluateAll((els) => els.map((e) => e.innerText).join(" "));
        check(`NTH 2 ${tag}: no Decisions row shows an R·n code`, !CODE.test(all), (CODE.exec(all) ?? [""])[0]);
        await shot(pg, `nth2-rows-${tag}`);
      }
      await ctx.close();
    }

  // ---------------------------------------------------------------- review-pr27 nice 1: a reload at /s/:id never shows Home
  // Every frame from the first paint is sampled; half the reloads hold the session GET 400 ms so the loading frame is seen.
  for (const [vp, theme] of [[VIEWS[0], "light"], [VIEWS[1], "dark"]]) {
    const tag = `${vp.tag}-${theme}`;
    const { ctx, pg } = await page(srv, vp, theme);
    await pg.addInitScript(() => {
      const w = (window.__fr = { home: 0, busy: 0, frames: 0 });
      const tick = () => {
        w.frames++;
        if (document.getElementById("idea-label") || document.querySelector(".composer")) w.home++;
        if (document.querySelector("[data-testid=session-loading][aria-busy=true]")) w.busy++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    let hold = false;
    await pg.route(/\/api\/sessions\/[^/?]+(\?.*)?$/, async (route) => {
      if (hold && route.request().method() === "GET") await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await pg.goto(sessionUrl(srv.url));
    await pg.getByTestId("plan").waitFor({ timeout: 10000 });
    const seen = [];
    for (let i = 0; i < 16; i++) {
      hold = i % 2 === 1;
      await pg.reload();
      await pg.getByTestId("plan").waitFor({ timeout: 10000 });
      await pg.waitForTimeout(100);
      seen.push({ hold, ...(await pg.evaluate(() => window.__fr)) });
    }
    const homes = seen.filter((x) => x.home > 0);
    check(`review-pr27 nice 1 ${tag}: 16 reloads of a session page never paint Home`, homes.length === 0, JSON.stringify(homes.slice(0, 3)));
    const held = seen.filter((x) => x.hold);
    check(`review-pr27 nice 1 ${tag}: while the session loads, an empty busy session frame shows instead`, held.every((x) => x.busy > 0), JSON.stringify(held.map((x) => x.busy)));
    await ctx.close();
  }
} finally {
  await browser.close();
  await srv.stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
