// v1.2 polish §6 end-to-end: the phone tap path to a diagram's source (#105) and the plan editor's
// hint under the preview (#106). Phone: the caption row's quiet Edit (44px hit area), a tap elsewhere
// still zooms, full screen title · ⋯ · Close with an action sheet holding Edit source, nothing to
// edit while a run is busy. Desktop stays as it was. axe in dark and light on both.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/phone-edit.mjs           checks only
//   SHOTS=dir node e2e/phone-edit.mjs also writes screenshots to dir
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-pe-"));
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
  return { url, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
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
const CAP = "How an edit on a phone reaches everyone";
const FLOW = `\n## Sync\nEdits sync local-first when a phone is back online.\n\n\`\`\`mermaid\nflowchart LR\n  accTitle: ${CAP}\n  accDescr: An edit queues offline, then merges per item.\n  A([Edit on a phone]) --> B{Online?}\n  B -->|no| C[Queue on the phone]\n  C -.-> B\n  B -->|yes| D{Same item?}\n  D -->|no| E([Saved for everyone])\n  D -->|yes| F[Merge per item] --> E\n\`\`\`\n`;
async function addFlow(pg) {
  const md = await planMd(pg);
  await pg.evaluate(async (m) => {
    const r = await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: m }) });
    if (!r.ok) throw new Error(await r.text());
  }, md + FLOW);
  const fig = pg.locator(".doc figure.mm5").filter({ hasText: CAP });
  await fig.waitFor({ timeout: 8000 });
  await fig.scrollIntoViewIfNeeded();
  await fig.locator(".mmw svg").waitFor({ timeout: 10000 });
  return fig;
}
async function axe(pg, name) {
  await pg.waitForTimeout(400); // let fades finish
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""}`).join("; "));
}
const shot = async (pg, name) => SHOTS && (await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
const rect = (loc) => loc.evaluate((e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
/** The colour a token resolves to here, for comparing with computed colours. */
const tokenColor = (pg, v) => pg.evaluate((v) => { const s = document.createElement("span"); s.style.color = `var(${v})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; }, v);
const BLUE = "--primary";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const theme of ["dark", "light"]) {
    const one = theme === "dark";
    // ------------------------------------------------------------------ phone
    {
      const s = await server();
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      await ctx.addInitScript(() => {
        const ES = window.EventSource;
        window.EventSource = class extends ES {
          set onmessage(f) {
            super.onmessage = (m) => {
              if (!window.__busy) return f(m);
              const d = JSON.parse(m.data);
              if (d.type === "session") d.session.busy = true;
              f(new MessageEvent("message", { data: JSON.stringify(d) }));
            };
          }
        };
      });
      const pg = await ctx.newPage();
      await toPlan(pg, s.url);
      const fig = await addFlow(pg);
      const ed = fig.locator("figcaption .fed");
      // 1. Caption row: the caption at the left, a quiet Edit at the right end.
      {
        const cap = fig.locator("figcaption");
        const { c, e, f } = await fig.evaluate((g) => { const r = (x) => JSON.parse(JSON.stringify(x.getBoundingClientRect())); return { c: r(g.querySelector("figcaption .ct")), e: r(g.querySelector("figcaption .fed")), f: r(g) }; });
        check(`${theme} phone: the caption row reads the caption, then Edit at its right end (#105)`, (await cap.locator(".ct").textContent()) === CAP && (await ed.textContent()) === "Edit" && c.left < e.left && Math.abs(c.top + c.height / 2 - (e.top + e.height / 2)) <= 2 && f.right - e.right <= 24, JSON.stringify({ c, e, f: f.right }));
        check(`${theme} phone: Edit is labelled with the caption`, (await ed.getAttribute("aria-label")) === `Edit source: ${CAP}`);
        const st = await ed.evaluate((b) => { const cs = getComputedStyle(b); const bf = getComputedStyle(b, "::before"); const r = b.getBoundingClientRect(); const svg = b.querySelector("svg").getBoundingClientRect(); return { color: cs.color, bg: cs.backgroundColor, size: cs.fontSize, h: r.height, icon: svg.width, before: [bf.top, bf.bottom] }; });
        check(`${theme} phone: Edit is muted 13px with a 16px pencil, 28px to see, no blue`, st.color === (await tokenColor(pg, "--muted-foreground")) && st.color !== (await tokenColor(pg, BLUE)) && st.size === "13px" && st.h === 28 && st.icon === 16 && /rgba\(0, 0, 0, 0\)|transparent/.test(st.bg), JSON.stringify(st));
        // 44px to tap: points 7px above and below the visual box still land on Edit.
        const hit = await ed.evaluate((b) => { const r = b.getBoundingClientRect(); const x = r.left + r.width / 2; const at = (y) => b.contains(document.elementFromPoint(x, y)); return { up: at(r.top - 7), down: at(r.bottom - 1 + 7), h: r.height + 16 }; });
        check(`${theme} phone: Edit takes taps over 44px (::before −8px)`, hit.up && hit.down && hit.h >= 44, JSON.stringify(hit));
        await pg.evaluate(() => document.activeElement?.blur());
        await fig.evaluate((f) => f.scrollIntoView({ block: "center" }));
        await shot(pg, `m-fig-${theme}`);
        if (one) {
          await pg.addStyleTag({ content: ".fcap .fed::before{outline:1px dashed var(--muted-foreground)}" }).then((h) => h.evaluate((e) => (e.id = "hitshow")));
          await shot(pg, `m-fighit-${theme}`);
          await pg.evaluate(() => document.getElementById("hitshow")?.remove());
        }
        await axe(pg, `${theme} phone: figure with the caption Edit`);
      }
      // 2. Edit opens the same source editor; Done leaves the plan as it was.
      {
        const before = await planMd(pg);
        await ed.tap();
        const blk = pg.locator(".blk[data-editing]");
        await blk.locator("textarea").waitFor({ timeout: 5000 });
        check(`${theme} phone: Edit opens the diagram's source editor, on Source`, (await blk.locator("textarea").inputValue()).includes(`accTitle: ${CAP}`) && (await pg.locator(".acc4 [role=radio][aria-checked=true]").textContent()) === "Source");
        if (one) {
          const order = await blk.evaluate((b) => { const h = b.querySelector(".blk-hint"); const p = b.querySelector(".blk-preview"); return { after: !!(p && h && p.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) }; });
          check("phone: the editor's hint comes after the preview (#106)", order.after);
        }
        await shot(pg, `m-editor-${theme}`);
        await pg.locator(".acc4").getByRole("button", { name: "Done" }).tap();
        await pg.waitForTimeout(400);
        check(`${theme} phone: Done with no change leaves the plan as it was`, (await planMd(pg)) === before);
      }
      // 3. A tap anywhere else on the figure still zooms.
      const fig2 = pg.locator(".doc figure.mm5").filter({ hasText: CAP });
      await fig2.locator(".mmw svg").waitFor({ timeout: 8000 });
      await fig2.scrollIntoViewIfNeeded();
      {
        const r = await rect(fig2.locator(".mmw"));
        await pg.touchscreen.tap(r.left + 40, r.top + r.height / 2);
        await pg.locator(".fs5").waitFor({ timeout: 5000 });
        check(`${theme} phone: a tap on the diagram still opens full screen`, (await pg.locator(".blk[data-editing]").count()) === 0);
      }
      // 4. Full screen: title · ⋯ · Close, all 44px; Diagram | Text and zoom in the bottom bar.
      const more = pg.getByRole("button", { name: "More actions" });
      {
        await pg.waitForTimeout(300);
        const hd = await pg.locator(".fs5 .fh").evaluate((h) => [...h.children].filter((c) => getComputedStyle(c).display !== "none" && c.getBoundingClientRect().width > 0 && !c.classList.contains("sp")).map((c) => ({ t: c.tagName, l: c.getAttribute("aria-label") ?? c.textContent, w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })));
        check(`${theme} phone: the full-screen header is title · ⋯ · Close`, hd.length === 3 && hd[0].t === "B" && hd[1].l === "More actions" && hd[2].l === "Close full screen" && hd.slice(1).every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(hd));
        const title = await pg.locator(".fs5 .fh b").evaluate((b) => ({ txt: b.textContent, cut: getComputedStyle(b).textOverflow === "ellipsis" && getComputedStyle(b).whiteSpace === "nowrap", right: b.getBoundingClientRect().right }));
        const mr = await rect(more);
        check(`${theme} phone: the title is the caption and truncates before ⋯`, title.txt === CAP && title.cut && title.right <= mr.left, JSON.stringify(title));
        check(`${theme} phone: ⋯ says it opens a dialog, closed`, (await more.getAttribute("aria-haspopup")) === "dialog" && (await more.getAttribute("aria-expanded")) === "false");
        const bar = await pg.locator(".fs5 .mzb").evaluate((m) => { const seg = m.querySelector(".seg2").getBoundingClientRect(); const z = m.querySelector(".zg, .zoom, [role=group]")?.getBoundingClientRect() ?? m.lastElementChild.getBoundingClientRect(); return { segL: Math.round(seg.left), zR: Math.round(z.right), segR: Math.round(seg.right), zL: Math.round(z.left), w: innerWidth }; });
        check(`${theme} phone: Diagram | Text sits bottom-left, zoom bottom-right`, bar.segL <= 20 && bar.zR >= bar.w - 20 && bar.segR < bar.zL, JSON.stringify(bar));
        check(`${theme} phone: no Edit source button in the full-screen header`, (await pg.locator(".fs5 .fh").getByRole("button", { name: /Edit source/ }).count()) === 0);
        await shot(pg, `m-fs-${theme}`);
        await axe(pg, `${theme} phone: full screen`);
      }
      // 5. ⋯ opens the sheet titled with the caption; the scrim and Escape close only the sheet.
      const sheet = pg.getByRole("dialog", { name: CAP }).and(pg.locator(".psheet"));
      {
        await more.tap();
        await sheet.waitFor({ timeout: 3000 });
        const row = sheet.getByRole("button", { name: "Edit source" });
        const rr = await rect(row);
        check(`${theme} phone: ⋯ opens a sheet titled with the caption, one 48px Edit source row`, (await sheet.getByRole("button").count()) === 1 && rr.height === 48 && (await row.locator("svg").count()) === 1 && (await sheet.getAttribute("aria-modal")) === "true", JSON.stringify(rr));
        await pg.waitForTimeout(250);
        const fill = { bg: await more.evaluate((b) => getComputedStyle(b).backgroundColor), muted: await pg.evaluate(() => { const s = document.createElement("span"); s.style.background = "var(--muted)"; document.body.append(s); const c = getComputedStyle(s).backgroundColor; s.remove(); return c; }) };
        check(`${theme} phone: ⋯ shows it's open, with the grey fill`, (await more.getAttribute("aria-expanded")) === "true" && fill.bg === fill.muted, JSON.stringify(fill));
        check(`${theme} phone: focus moves into the sheet`, await row.evaluate((b) => b === document.activeElement));
        await pg.waitForTimeout(250);
        await shot(pg, `m-fsmenu-${theme}`);
        await axe(pg, `${theme} phone: full-screen action sheet`);
        await pg.touchscreen.tap(200, 120);
        await sheet.waitFor({ state: "detached", timeout: 3000 });
        check(`${theme} phone: the scrim closes the sheet, full screen stays`, (await pg.locator(".fs5").count()) === 1 && (await more.getAttribute("aria-expanded")) === "false");
        await more.tap();
        await sheet.waitFor({ timeout: 3000 });
        await pg.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached", timeout: 3000 });
        await pg.waitForTimeout(100);
        check(`${theme} phone: Escape closes only the sheet and puts focus back on ⋯`, (await pg.locator(".fs5").count()) === 1 && (await more.evaluate((b) => b === document.activeElement)));
      }
      // 6. Edit source closes full screen and opens the editor.
      {
        await more.tap();
        await sheet.waitFor({ timeout: 3000 });
        await sheet.getByRole("button", { name: "Edit source" }).tap();
        await pg.locator(".fs5").waitFor({ state: "detached", timeout: 3000 });
        const blk = pg.locator(".blk[data-editing]");
        await blk.locator("textarea").waitFor({ timeout: 5000 });
        check(`${theme} phone: Edit source closes full screen and opens the source editor`, (await blk.locator("textarea").inputValue()).includes(`accTitle: ${CAP}`) && (await pg.locator(".psheet").count()) === 0);
        await pg.waitForTimeout(300);
        check(`${theme} phone: the editor keeps focus after the sheet's history entry goes`, (await blk.locator("textarea").evaluate((t) => t === document.activeElement)) && (await blk.count()) === 1);
        await pg.locator(".acc4").getByRole("button", { name: "Done" }).tap();
        await pg.waitForTimeout(300);
      }
      // 7. Read-only (the agent is busy on this session): no Edit on the caption, no ⋯ in full screen.
      // The fake agent can't hold a plated plan busy, so the page marks its live updates busy.
      {
        await pg.evaluate(() => (window.__busy = true));
        const md = await planMd(pg);
        await pg.evaluate(async (m) => void (await fetch(`/api/sessions/${location.pathname.split("/").pop()}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: `${m}\nOne more line.\n` }) })), md);
        await pg.locator(".ped[data-readonly]").waitFor({ timeout: 5000 });
        const f = pg.locator(".doc figure.mm5").filter({ hasText: CAP });
        await f.locator(".mmw svg").waitFor({ timeout: 8000 });
        await f.scrollIntoViewIfNeeded();
        check(`${theme} phone: read-only, the caption has no Edit`, (await f.locator(".fed").count()) === 0 && (await f.locator("figcaption").textContent()) === CAP);
        await f.locator(".tapz").tap();
        await pg.locator(".fs5").waitFor({ timeout: 5000 });
        check(`${theme} phone: read-only, full screen has no ⋯`, (await more.count()) === 0 && (await pg.getByRole("button", { name: "Close full screen" }).count()) === 1);
        await pg.getByRole("button", { name: "Close full screen" }).tap();
      }
      await ctx.close();
      await s.stop();
    }
    // ---------------------------------------------------------------- desktop
    {
      const s = await server();
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const pg = await ctx.newPage();
      await toPlan(pg, s.url);
      const fig = await addFlow(pg);
      const cap = await fig.locator("figcaption").evaluate((c) => ({ cls: c.className, align: getComputedStyle(c).textAlign, txt: c.textContent }));
      check(`${theme} desktop: the caption is unchanged, centred, with no Edit in it`, cap.cls === "" && cap.align === "center" && cap.txt === CAP && (await fig.locator(".fed").count()) === 0, JSON.stringify(cap));
      await fig.hover();
      await fig.getByRole("button", { name: /Full screen|Open full screen/ }).first().click();
      await pg.locator(".fs5").waitFor();
      check(`${theme} desktop: full screen keeps Diagram | Text and Edit source in its header, no ⋯`, (await pg.locator(".fs5 .fh [role=radiogroup]").count()) === 1 && (await pg.locator(".fs5 .fh").getByRole("button", { name: /Edit source/ }).count()) === 1 && (await pg.getByRole("button", { name: "More actions" }).count()) === 0);
      await axe(pg, `${theme} desktop: full screen`);
      await pg.keyboard.press("Escape");
      await pg.locator(".fs5").waitFor({ state: "detached" });
      // #106: the hint sits under the preview, not between the source and what it renders.
      await fig.focus();
      await pg.keyboard.press("Enter");
      const blk = pg.locator(".blk[data-editing]");
      await blk.locator(".blk-preview .mmw svg, .blk-preview svg").first().waitFor({ timeout: 8000 });
      const pos = await blk.evaluate((b) => { const ta = b.querySelector("textarea").getBoundingClientRect(); const p = b.querySelector(".blk-preview").getBoundingClientRect(); const h = b.querySelector(".blk-hint").getBoundingClientRect(); return { ta: Math.round(ta.bottom), pTop: Math.round(p.top), pBot: Math.round(p.bottom), hTop: Math.round(h.top) }; });
      check(`${theme} desktop: the editor's hint is below the live preview (#106)`, pos.pTop >= pos.ta && pos.hTop >= pos.pBot, JSON.stringify(pos));
      await blk.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await shot(pg, `d-hint-${theme}`);
      await axe(pg, `${theme} desktop: editor with the hint under the preview`);
      await pg.keyboard.press("Escape");
      await ctx.close();
      await s.stop();
    }
  }
} catch (e) {
  check("run finished", false, String(e?.stack ?? e).split("\n").slice(0, 12).join(" / "));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
