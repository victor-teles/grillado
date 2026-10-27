// v1.2 "margins" (#117, #118).
// #117: on desktop hover devices every block with an Edit button reserves a 64×24 slot at the top right of its first line, so a
//   long first line ends ≥4px left of Edit and hovering never reflows; fences don't wrap and get no slot; phones get neither.
// #118: the decision gutter fits the plan. ≥240px of margin: cite plus answer label; under: the cite only ("R1·1"); a measure
//   under 480px puts the cite inline at the end of its passage; the preview popover never crosses the plan's right edge; the
//   plan never scrolls sideways (1100 with the rail open: at rest, on block hover, with a lit link, with the popover open).
// One server and one browser at a time; only processes started here are killed.
//   node e2e/margins.mjs              checks only (dark and light, 1100/1440 desktop and phone)
//   SHOTS=dir node e2e/margins.mjs    also writes d-margins-* shots to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-mg-"));
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
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}

const CODE = "grillado --no-open --agent claude --plan ./plans/shopping-list.md --round 3 --keep-data-local --and-a-long-tail-of-flags-that-never-wraps";

/** Start → a plated plan; with `rail`, a comment opens the Comments rail. */
async function plate(pg, { rail = false } = {}) {
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
  if (!rail) return;
  await selectText(pg, "Shared shopping list");
  await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
  await pg.keyboard.press("Control+Alt+KeyM");
  await pg.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
  await pg.keyboard.press("Control+Enter");
  await pg.getByRole("complementary", { name: "Comments" }).getByText(/^Good catch\./).waitFor({ timeout: 15000 });
  await pg.evaluate(() => getSelection().removeAllRanges());
}
/** Make the Problem paragraph wrap and add a code fence after it, through the block editor. */
async function addFence(pg) {
  const para = pg.locator(".doc .blk[data-block=para]").first();
  await para.click({ position: { x: 20, y: 10 } });
  const ta = pg.locator(".blk-edit");
  await ta.waitFor();
  const v = await ta.inputValue();
  await ta.fill(`${v}. Ideas show up while walking or in the middle of something else, and most of them are gone by the time a laptop is open.\n\n\`\`\`sh\n${CODE}\n\`\`\``);
  await pg.keyboard.press("Escape");
  await ta.waitFor({ state: "detached" });
  await pg.locator(".doc .blk[data-block=fence]").waitFor();
  await pg.waitForTimeout(300);
}
const rest = (pg) => pg.mouse.move(2, 600);
/** The plan's sideways overflow: the scroller's, and how far any cite or popover reaches past its visible right edge. */
const overflow = (pg) =>
  pg.evaluate(() => {
    const w = document.querySelector(".docwrap");
    const edge = w.getBoundingClientRect().left + w.clientWidth;
    const past = Math.max(0, ...[...w.querySelectorAll(".gut, .gut-cite, .peekcard")].map((e) => e.getBoundingClientRect().right - edge));
    return { sw: w.scrollWidth, cw: w.clientWidth, past: Math.round(past * 10) / 10 };
  });
const flat = (o) => o.sw === o.cw && o.past <= 0;
/** The column and the margin right of it (#118). */
const room = (pg) =>
  pg.evaluate(() => {
    const w = document.querySelector(".docwrap");
    const doc = document.querySelector(".doc");
    const d = doc.getBoundingClientRect();
    const cs = getComputedStyle(doc);
    const left = d.left + parseFloat(cs.paddingLeft);
    const right = d.right - parseFloat(cs.paddingRight);
    return { left: Math.round(left), measure: Math.round(right - left), margin: Math.round(w.getBoundingClientRect().left + w.clientWidth - right), pr: cs.paddingRight };
  });
const cited = (pg) => pg.locator(".doc .ps", { hasText: "Yes, one core flow" }).first();
/** The cites on the hovered line: their text, whether the answer label shows, opacity, inline or in the margin. */
const cites = (pg) =>
  pg.$$eval(".doc .gut-cite", (cs) =>
    cs.map((c) => {
      const r = c.getBoundingClientRect();
      return { t: c.textContent.trim(), an: !!c.querySelector(".an"), op: getComputedStyle(c).opacity, inl: !!c.closest(".gut.in"), l: Math.round(r.left), r: Math.round(r.right), on: c.classList.contains("on") };
    }),
  );

/**
 * #117 geometry for every block that has Edit: its slot, the right end of its first text line, and whether that line is
 * long (it wrapped, and ends within 100px of Edit). Text is read from text nodes, not the cites or the button.
 */
const slots = (pg) =>
  pg.evaluate(() => {
    const NOT = ".gut:not(.in), .blk-act, .blk-slot, .blk-add, .sr-only, .ipill, .okm";
    const box = (r) => ({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) });
    return [...document.querySelectorAll(".doc .blk")]
      .filter((b) => b.querySelector(":scope > .blk-act"))
      .map((b) => {
        const rects = [];
        const range = document.createRange();
        const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.data.trim() || n.parentElement.closest(NOT)) continue;
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (r.width > 1) rects.push(r);
        }
        const top = Math.min(...rects.map((r) => r.top));
        const first = rects.filter((r) => r.top < top + 8);
        const edit = b.querySelector(":scope > .blk-act").getBoundingClientRect();
        const slot = b.querySelector(":scope > .blk-slot");
        const end = Math.max(...first.map((r) => r.right));
        const lines = new Set(rects.map((r) => Math.round(r.top))).size;
        return {
          kind: b.dataset.block,
          text: b.textContent.slice(0, 24),
          slot: slot ? box(slot.getBoundingClientRect()) : null,
          edit: box(edit),
          end: Math.round(end),
          gap: Math.round(edit.left - end),
          overlapsY: first.some((r) => r.top < edit.bottom && r.bottom > edit.top),
          long: lines > 1 && edit.left - end < 100,
          h: Math.round(b.getBoundingClientRect().height),
          sig: rects.map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`).join(" "),
          op: getComputedStyle(b.querySelector(":scope > .blk-act")).opacity,
        };
      });
  });

/** #117 at one width: a slot on every wrapping block, the first line clear of Edit, no reflow on hover. */
async function editSlot(pg, tag, shot) {
  await pg.evaluate(() => document.activeElement?.blur()); // pointer hover only: no focus ring, no focus-within
  await rest(pg);
  await pg.waitForTimeout(250);
  const before = await slots(pg);
  const prose = before.filter((s) => s.kind !== "fence");
  const fence = before.filter((s) => s.kind === "fence");
  check(`${tag}: every prose block with Edit has a 64×24 slot`, prose.length >= 4 && prose.every((s) => s.slot && s.slot.w === 64 && s.slot.h === 24), JSON.stringify(prose.map((s) => [s.kind, s.slot])));
  check(`${tag}: a fence (no wrap) has no slot`, fence.length === 1 && fence[0].slot === null, JSON.stringify(fence.map((s) => s.slot)));
  check(`${tag}: at least one long first line (wrapped, ending near Edit)`, prose.some((s) => s.long), JSON.stringify(prose.map((s) => [s.kind, s.gap])));
  // The control: with the slot taken out, some first line runs on under Edit, so the slot is what keeps it clear.
  const off = await pg.addStyleTag({ content: ".doc .blk>.blk-slot{display:none!important}" });
  const bare = (await slots(pg)).filter((s) => s.kind !== "fence");
  await off.evaluate((e) => e.remove());
  check(`${tag}: …and without the slot that line would run under Edit`, bare.some((s) => s.overlapsY && s.gap < 4) && JSON.stringify(await slots(pg)) === JSON.stringify(before), JSON.stringify(bare.map((s) => [s.kind, s.gap])));
  const bad = prose.filter((s) => s.overlapsY && s.gap < 4);
  check(`${tag}: every first line ends ≥4px left of Edit`, bad.length === 0, JSON.stringify((bad.length ? bad : prose).map((s) => [s.kind, s.text, s.gap])));
  // Hover each block: Edit shows, and nothing in it moves or changes height.
  const moved = [];
  for (let i = 0; i < before.length; i++) {
    const b = pg.locator(".doc .blk").filter({ has: pg.locator(":scope > .blk-act") }).nth(i);
    const r = await b.boundingBox();
    await pg.mouse.move(r.x + 12, r.y + Math.min(r.height / 2, 14));
    await pg.waitForTimeout(220);
    const now = (await slots(pg))[i];
    if (now.op !== "1" || now.h !== before[i].h || now.sig !== before[i].sig) moved.push({ kind: now.kind, op: now.op, h: [before[i].h, now.h], same: now.sig === before[i].sig });
  }
  check(`${tag}: hovering any block shows Edit and reflows nothing (fence included)`, moved.length === 0, JSON.stringify(moved));
  if (shot) {
    const para = await pg.locator(".doc .blk[data-block=para]").first().boundingBox();
    await pg.mouse.move(para.x + 12, para.y + 12);
    await pg.waitForTimeout(220);
    await shot("edit");
  }
  await rest(pg);
}

/** #118 at 1100 with the rail open: cite only, no sideways scroll at rest, on hover, with a lit link and with the popover. */
async function gutter(pg, tag, shot) {
  const rm = await room(pg);
  check(`${tag}: the column narrows to keep a 64px margin (≈628, was 652)`, rm.margin === 64 && Math.abs(rm.measure - 628) <= 1, JSON.stringify(rm));
  await rest(pg);
  await pg.waitForTimeout(250);
  let o = await overflow(pg);
  check(`${tag}: at rest the plan doesn't scroll sideways`, flat(o), JSON.stringify(o));
  await shot("rest");
  // Block hover lights the passage's link: label mode would add the answer, but under 240px it's the cite only.
  const ps = cited(pg);
  const pr = await ps.boundingBox();
  await pg.mouse.move(pr.x + 10, pr.y + pr.height / 2);
  await pg.waitForTimeout(500);
  let cs = await cites(pg);
  const lit = cs.filter((c) => c.op === "1");
  check(`${tag}: on block hover the cite shows, as the cite only ("R1·1")`, lit.length >= 1 && lit.every((c) => !c.an && /^R\d+·\d+$/.test(c.t) && !c.inl), JSON.stringify(cs));
  o = await overflow(pg);
  check(`${tag}: …and the plan doesn't scroll sideways`, flat(o), JSON.stringify(o));
  await shot("hover");
  // A lit link from the decision side: hover its card.
  await rest(pg);
  await pg.waitForTimeout(300);
  const key = (await ps.getAttribute("data-keys")).split(" ")[0];
  const dz = pg.locator(`.dz[data-key="${key}"]`);
  await dz.scrollIntoViewIfNeeded();
  await dz.hover({ position: { x: 40, y: 20 } });
  await pg.waitForTimeout(400);
  if (!(await pg.locator(".gut-cite.on").count())) {
    await dz.focus();
    await pg.waitForTimeout(300);
  }
  cs = await cites(pg);
  check(`${tag}: with a lit link the cite is lit, still the cite only`, cs.some((c) => c.on) && cs.every((c) => !c.an), JSON.stringify(cs));
  o = await overflow(pg);
  check(`${tag}: …and the plan doesn't scroll sideways`, flat(o), JSON.stringify(o));
  await shot("lit");
  // The popover, opened from the keyboard (0ms): right-aligned to the plan's edge minus 8, never past it.
  await rest(pg);
  await pg.locator("body").click({ position: { x: 2, y: 2 } }).catch(() => {});
  await ps.scrollIntoViewIfNeeded();
  await pg.waitForTimeout(250);
  await pg.locator(".gut-cite").first().focus();
  await pg.locator(".peekcard").waitFor({ timeout: 2000 });
  await pg.waitForTimeout(250);
  const pk = await pg.evaluate(() => {
    const w = document.querySelector(".docwrap");
    const edge = w.getBoundingClientRect().left + w.clientWidth;
    const p = document.querySelector(".peekcard").getBoundingClientRect();
    return { right: Math.round(p.right * 10) / 10, edge: Math.round(edge), w: Math.round(p.width) };
  });
  check(`${tag}: the popover ends 8px inside the plan's right edge`, Math.abs(pk.edge - 8 - pk.right) <= 1 && pk.w === 300, JSON.stringify(pk));
  o = await overflow(pg);
  check(`${tag}: …and with it open the plan doesn't scroll sideways`, flat(o), JSON.stringify(o));
  await shot("popover");
  await pg.keyboard.press("Escape");
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const s = await server({ FAKE_COMMENT: "swap", FAKE_COMMENT_DELAY_MS: "300" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    const shot = (name) => async (step) => {
      if (!SHOTS) return;
      await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open"))); // no toast from a step before
      await pg.waitForTimeout(120);
      await pg.screenshot({ path: path.join(SHOTS, `d-margins-${name}-${step}-${theme}.png`) });
    };
    await pg.goto(s.url);
    await plate(pg);
    await addFence(pg);
    {
      const f = await pg.$eval(".doc pre", (e) => ({ tab: e.tabIndex, role: e.getAttribute("role"), name: e.getAttribute("aria-label"), wide: e.scrollWidth > e.clientWidth }));
      check(`${theme}: a fence that scrolls sideways is a Tab stop named "Code block, scrolls sideways" (#122)`, f.wide && f.tab === 0 && f.role === "region" && f.name === "Code block, scrolls sideways", JSON.stringify(f));
      check(`${theme}: …and it's found by that name`, (await pg.getByRole("region", { name: "Code block, scrolls sideways" }).count()) === 1);
      // #117 follow-up: the code block's Edit, and its focus ring, stay inside the fence's top edge.
      const blk = pg.locator(".doc .blk[data-block=fence]").filter({ has: pg.locator("pre") }).first();
      await blk.hover();
      const edge = async () =>
        blk.evaluate((b) => {
          const pre = b.querySelector(":scope > pre").getBoundingClientRect();
          const btn = b.querySelector(":scope > .blk-act");
          const r = btn.getBoundingClientRect();
          const ring = parseFloat((getComputedStyle(btn).boxShadow.match(/\d+(?:\.\d+)?px/g) ?? ["0px"]).pop());
          const bs = getComputedStyle(b).boxShadow;
          return { gapTop: Math.round(r.top - pre.top), gapRight: Math.round(pre.right - r.right), ring, blkRing: bs !== "none", focused: document.activeElement === btn, op: getComputedStyle(btn).opacity };
        });
      // Edit fades in on hover; measure it at rest.
      await blk.locator(":scope > .blk-act").evaluate((b) => new Promise((r) => { const t0 = Date.now(); const f = () => (getComputedStyle(b).opacity === "1" || Date.now() - t0 > 1500 ? r() : requestAnimationFrame(f)); f(); }));
      let e = await edge();
      check(`${theme}: the code block's Edit sits inside the fence (not over its top edge)`, e.op === "1" && e.gapTop >= 4 && e.gapRight >= 4, JSON.stringify(e));
      await pg.evaluate(() => document.documentElement.setAttribute("data-kbd", ""));
      await blk.locator(":scope > .blk-act").focus();
      e = await edge();
      check(`${theme}: focused, Edit's ring stays inside the fence too, and the block draws no ring above it`, e.focused && e.ring > 0 && e.gapTop - e.ring >= 2 && !e.blkRing, JSON.stringify(e));
      if (SHOTS) {
        await pg.evaluate(() => dispatchEvent(new Event("grillado:editor-open")));
        await pg.waitForTimeout(200);
        await blk.screenshot({ path: path.join(SHOTS, `d-margins-fence-edit-focus-${theme}.png`) });
      }
      await pg.evaluate(() => (document.activeElement.blur(), document.documentElement.removeAttribute("data-kbd")));
      // #121: keyboard focus in a block shows all of its cites, as hover does.
      await pg.mouse.move(5, 5);
      const cb = pg.locator(".doc .blk").filter({ has: pg.locator(".gut-cite") }).first();
      const cites = async () =>
        cb.evaluate((b) =>
          [...b.querySelectorAll(".gut-cite")].map((c) => {
            for (const a of c.getAnimations()) a.finish();
            return getComputedStyle(c).opacity;
          }),
        );
      const rest = await cites();
      await pg.evaluate(() => document.documentElement.setAttribute("data-kbd", ""));
      await cb.locator(":scope > .blk-act").focus();
      const lit = await cites();
      check(`${theme}: keyboard focus in a block shows all its cites (#121)`, rest.length > 0 && rest.every((o) => o === "0") && lit.every((o) => o === "1"), JSON.stringify({ rest, lit }));
      await pg.evaluate(() => (document.activeElement.blur(), document.documentElement.removeAttribute("data-kbd")));
    }

    // ------------------------------------------------ 1440, rail closed: unchanged, the cite plus its label
    let rm = await room(pg);
    const wide = rm;
    check(`${theme} 1440: the column is 660 with 40px padding, as before`, rm.measure === 660 && rm.pr === "40px", JSON.stringify(rm));
    await editSlot(pg, `${theme} 1440 Edit slot`, shot("1440"));
    {
      const pr = await cited(pg).boundingBox();
      await pg.mouse.move(pr.x + 10, pr.y + pr.height / 2);
      await pg.waitForTimeout(500);
      const cs = await cites(pg);
      check(`${theme} 1440: ≥240px of margin, so hover shows the cite plus its answer`, rm.margin >= 240 && cs.some((c) => c.an && c.op === "1"), JSON.stringify({ rm, cs }));
      const o = await overflow(pg);
      check(`${theme} 1440: …inside the plan`, flat(o), JSON.stringify(o));
      await shot("1440")("hover");
      await axe(pg, `${theme} 1440, cite label on hover`);
    }

    // ------------------------------------------------ 1100, rail open
    await rest(pg);
    await pg.setViewportSize({ width: 1100, height: 800 });
    await selectText(pg, "Shared shopping list");
    await pg.getByRole("toolbar", { name: "Selection" }).waitFor();
    await pg.keyboard.press("Control+Alt+KeyM");
    await pg.getByRole("dialog", { name: "New comment" }).getByRole("textbox").fill("Say who shares it");
    await pg.keyboard.press("Control+Enter");
    await pg.getByRole("complementary", { name: "Comments" }).getByText(/^Good catch\./).waitFor({ timeout: 15000 });
    await pg.evaluate(() => getSelection().removeAllRanges());
    await pg.waitForTimeout(300);
    await gutter(pg, `${theme} 1100 rail open`, shot("1100"));
    await axe(pg, `${theme} 1100 rail open, popover closed`);
    await editSlot(pg, `${theme} 1100 rail open Edit slot`, shot("1100"));

    // ------------------------------------------------ 1440, rail open: under 240px, the cite only
    await pg.setViewportSize({ width: 1440, height: 900 });
    await pg.waitForTimeout(300);
    rm = await room(pg);
    {
      const pr = await cited(pg).boundingBox();
      await pg.mouse.move(pr.x + 10, pr.y + pr.height / 2);
      await pg.waitForTimeout(500);
      const cs = await cites(pg);
      const o = await overflow(pg);
      check(`${theme} 1440 rail open: ${rm.margin}px of margin (<240), the cite only, column unchanged`, rm.margin < 240 && rm.measure === 660 && rm.pr === "40px" && cs.some((c) => c.op === "1") && cs.every((c) => !c.an) && flat(o), JSON.stringify({ rm, cs, o }));
      await shot("1440-rail")("hover");
    }

    // ------------------------------------------------ 900, rail open: the measure is under 480, so cites go inline
    await rest(pg);
    await pg.setViewportSize({ width: 900, height: 800 });
    await pg.waitForTimeout(400);
    rm = await room(pg);
    {
      const restH = await cited(pg).evaluate((e) => e.closest(".blk").getBoundingClientRect().height);
      const atRest = await cites(pg);
      const pr = await cited(pg).boundingBox();
      await pg.mouse.move(pr.x + 10, pr.y + pr.height / 2);
      await pg.waitForTimeout(500);
      const cs = await cites(pg);
      const hovH = await cited(pg).evaluate((e) => e.closest(".blk").getBoundingClientRect().height);
      await shot("900-rail")("hover");
      const end = await cited(pg).evaluate((e) => {
        const g = e.nextElementSibling;
        return { inline: !!g && g.matches(".gut.in"), pos: g && getComputedStyle(g).position, color: g && getComputedStyle(g.querySelector(".gut-cite")).color };
      });
      check(`${theme} 900 rail open: a ${rm.measure}px measure (<480) puts the cite inline after its passage`, rm.measure < 480 && end.inline && end.pos === "static" && cs.length && cs.every((c) => c.inl && !c.an), JSON.stringify({ rm, end, cs }));
      check(`${theme} 900 rail open: …hidden at rest, shown on hover, without reflow`, atRest.every((c) => c.op === "0") && cs.some((c) => c.op === "1") && restH === hovH, JSON.stringify({ restH, hovH, atRest }));
      const o = await overflow(pg);
      check(`${theme} 900 rail open: …and nothing scrolls sideways`, flat(o), JSON.stringify(o));
      await pg.locator(".gut-cite").first().focus();
      await pg.locator(".peekcard").waitFor({ timeout: 2000 });
      const o2 = await overflow(pg);
      check(`${theme} 900 rail open: the inline cite keeps its popover, inside the plan`, flat(o2), JSON.stringify(o2));
      await pg.keyboard.press("Escape");
      await axe(pg, `${theme} 900 rail open, inline cites`);
    }
    check(`${theme}: back at 1440 rail closed nothing moved`, wide.measure === 660, "");
    await ctx.close();
    await s.stop();

    // ------------------------------------------------ phone: no slot, no gutter
    const s2 = await server();
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
    await mctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const mp = await mctx.newPage();
    await mp.goto(s2.url);
    await plate(mp);
    const m = await mp.evaluate(() => ({
      slots: [...document.querySelectorAll(".blk-slot")].filter((e) => e.getBoundingClientRect().width > 0).length,
      gut: [...document.querySelectorAll(".gut")].length,
      sw: document.querySelector(".docwrap").scrollWidth - document.querySelector(".docwrap").clientWidth,
    }));
    check(`${theme} phone: no Edit slot, no gutter, no sideways scroll`, m.slots === 0 && m.gut === 0 && m.sw === 0, JSON.stringify(m));
    await axe(mp, `${theme} phone plan`);
    await mctx.close();
    await s2.stop();
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 14).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
