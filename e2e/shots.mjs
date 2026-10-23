// Screenshots of every screen, dark + light, desktop (1440×900) + mobile (390×844), for comparing
// against the Designer's boards. Uses the built dist/cli.js and the fake agent CLIs.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/shots.mjs [outDir]          (default /workspace/grillado-shots/v2)
//   AXE=1 also prints axe violations per screen.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = process.argv[2] ?? "/workspace/grillado-shots/v2";
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-shots-"));
const NODE = process.execPath;
mkdirSync(OUT, { recursive: true });

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
async function server(ids, extra = {}, home) {
  home ??= mkdtempSync(path.join(WORK, "home-"));
  const e = { PATH: `${fakeBins(ids)}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, ...extra };
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

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const shots = [];
async function page(theme, vp) {
  const ctx = await browser.newContext({ viewport: vp === "d" ? { width: 1440, height: 900 } : { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
  const pg = await ctx.newPage();
  const snap = async (name) => {
    await pg.mouse.move(0, 0); // no stray hover outline from the last click
    await pg.waitForTimeout(250);
    const file = path.join(OUT, `${name}-${vp}-${theme}.png`);
    await pg.screenshot({ path: file });
    shots.push(file);
    if (process.env.AXE) {
      const r = await new AxeBuilder({ page: pg }).analyze();
      for (const v of r.violations) for (const n of v.nodes.slice(0, 3)) console.log(`axe ${name}-${vp}-${theme}: ${v.id} ${n.target} ${n.any?.[0]?.message ?? ""}`);
    }
  };
  return { ctx, pg, snap };
}
const typeIdea = async (pg, text) => {
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill(text);
  await pg.keyboard.press("Enter");
};

for (const vp of ["d", "m"]) {
  for (const theme of ["dark", "light"]) {
    // 0 · no agent
    {
      const s = await server([]);
      const { ctx, pg, snap } = await page(theme, vp);
      await pg.goto(s.url);
      await pg.getByRole("heading", { name: "No coding agent found" }).waitFor();
      await snap("0c-noagent");
      await ctx.close();
      await s.stop();
    }
    // picker → landing (empty) → firing up → round → your call → waiting → round 2 → confirm → reopen → plating → plan
    {
      const s = await server(["claude", "codex"], { FAKE_DELAY_MS: "2500" });
      const { ctx, pg, snap } = await page(theme, vp);
      await pg.goto(s.url);
      await pg.getByRole("heading", { name: "Which agent should run this?" }).waitFor();
      await snap("0b-picker");
      await pg.getByLabel("Remember my choice").check();
      await pg.getByRole("radio", { name: /Claude Code/ }).click();
      await pg.getByRole("button", { name: /Continue/ }).click();
      await pg.getByRole("textbox", { name: "What are you planning?" }).waitFor();
      await snap("1-landing-empty");
      await pg.getByRole("textbox", { name: "What are you planning?" }).fill("Shared shopping list for my household");
      await snap("1-landing-typed");
      await pg.keyboard.press("Enter");
      await pg.getByText("Sizing up your idea").waitFor();
      await snap("2-firing-up");
      await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
      await snap("3-round");
      await pg.locator("[data-testid=question] legend").nth(1).focus();
      await pg.keyboard.press("2");
      await snap("3-round-yourcall");
      if (vp === "m") {
        await pg.getByRole("button", { name: /^Decisions/ }).click();
        await snap("3-round-tree-sheet");
        await pg.keyboard.press("Escape");
      }
      await pg.getByRole("button", { name: /Send answers/ }).click();
      await pg.getByText("Preparing round 2").waitFor();
      await snap("3-waiting");
      await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
      await pg.getByRole("button", { name: /Send answers/ }).click();
      await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15000 });
      await snap("4-confirm");
      await pg.getByRole("button", { name: "Reopen Platform" }).click();
      await snap("4-reopen");
      await pg.keyboard.press("Escape");
      await pg.getByRole("button", { name: /Yes, plate it/ }).click();
      await pg.getByText(/Plating your plan/).waitFor();
      await snap("5-plating");
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      await snap("6-plan");
      await ctx.close();
      await s.stop();
      // Landing with recent sessions, same home.
      const s2 = await server(["claude", "codex"], {}, s.home);
      const p2 = await page(theme, vp);
      await p2.pg.goto(s2.url);
      await p2.pg.getByRole("textbox", { name: "What are you planning?" }).waitFor();
      await p2.snap("1-landing");
      await p2.ctx.close();
      await s2.stop();
    }
    // wrapped early → plan with open decisions; long → nudge
    {
      const s = await server(["claude"], { FAKE_MODE: "long" });
      const { ctx, pg, snap } = await page(theme, vp);
      await pg.goto(s.url);
      await typeIdea(pg, "A notes app");
      for (const t of ["Build it for yourself first?", "Start with the capture flow?", "Include search in v1?", "Sync across devices?"]) {
        await pg.getByText(t).first().waitFor({ timeout: 15000 });
        if (vp === "m" && t === "Start with the capture flow?") await snap("3-round-wrap"); // ghost Wrap it up, 1+ settled
        await pg.getByRole("button", { name: /Send answers/ }).click();
        await pg.getByText(t).first().waitFor({ state: "detached", timeout: 15000 });
      }
      await pg.getByTestId("nudge").waitFor({ timeout: 15000 });
      await snap("3-round-nudge");
      await pg.locator(".bar").getByRole("button", { name: "Wrap it up" }).click();
      await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15000 });
      await snap("4-confirm-early");
      await pg.getByRole("button", { name: /Yes, plate it/ }).click();
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      await snap("6-plan-early");
      await ctx.close();
      await s.stop();
    }
    // banners
    for (const [mode, name] of [
      ["auth", "0d-banner-auth"],
      ["rate", "0d-banner-rate"],
      ["garbage", "0d-banner-malformed"],
    ]) {
      const s = await server(["claude", "codex"], { FAKE_MODE: mode });
      const { ctx, pg, snap } = await page(theme, vp);
      await pg.goto(s.url);
      await pg.getByRole("radio", { name: /Claude Code/ }).click();
      await pg.getByRole("button", { name: /Continue/ }).click();
      await typeIdea(pg, "A tiny CRM");
      await pg.getByTestId("problem").waitFor({ timeout: 20000 });
      await snap(name);
      if (mode === "auth") {
        await s.stop();
        await pg.getByRole("heading", { name: "Grillado was stopped" }).waitFor({ timeout: 10000 });
        await snap("7-stopped");
      }
      await ctx.close();
      await s.stop();
    }
  }
}
await browser.close();
rmSync(WORK, { recursive: true, force: true });
console.log(shots.join("\n"));
