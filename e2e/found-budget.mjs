// v1.3 item 1 acceptance (spec "## v1.3 backlog"): "The scan never delays the printed URL. An e2e run
// with a 50k-file fixture finishes within budget and shows a partial result." Builds a 50,000-file
// project in a temp folder, launches from it twice (a git repo, so `git ls-files`; then the same tree
// without git, so the walk), and checks, each time:
//   - the URL is printed before the scan ends, and no later than a --no-scan launch (plus slack);
//   - the scan ends within its 1.5 s budget (plus a little slack for the read in flight);
//   - it stops at the 5,000-path budget and is marked partial;
//   - Home shows the rows it found and "Showing what we found in 1.5 s · Look again" (axe clean).
// The fixture is deleted at the end, pass or fail. One server and one browser at a time.
//   node e2e/found-budget.mjs              checks only
//   SHOTS=dir node e2e/found-budget.mjs    also writes a frame to dir/1-group/
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const NODE = process.execPath;
const SHOTS = process.env.SHOTS;
const FILES = 50_000;
const BUDGET_MS = 1500;
const SLACK_MS = Number(process.env.BUDGET_SLACK_MS ?? 300); // one file read in flight past the deadline
const PRINT_SLACK_MS = 500; // node start-up jitter between two launches on a busy box
const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-budget-e2e-")));
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const started = new Set();
const cleanup = () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(WORK, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------- the fixture
const t0 = Date.now();
const home = path.join(WORK, "home");
const root = path.join(WORK, "bigrepo");
const bin = path.join(WORK, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" claude "$@"\n`);
chmodSync(path.join(bin, "claude"), 0o755);
// Plans in a known plan folder are read first, so the rows found before the budget runs out are these.
mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
for (const [f, t] of [["billing.md", "Billing v2"], ["search.md", "Faster search"], ["onboarding.md", "Onboarding checklist"]])
  writeFileSync(path.join(root, "docs", "plans", f), `# ${t}\n\n## Problem\nIt's slow.\n\n## Goals\nMake it fast.\n\n## Decisions\n\n\`\`\`decision\nid: scope\nanswer: Small\n\`\`\`\n\n## Tasks\n- [ ] Ship it\n`);
// 50,000 files: 500 folders of 100, mostly empty sources and a few Markdown files, all 3 levels deep.
let n = 3;
for (let d = 0; n < FILES; d++) {
  const dir = path.join(root, "packages", `p${Math.floor(d / 25)}`, `m${d}`);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 100 && n < FILES; i++, n++) writeFileSync(path.join(dir, i % 20 === 0 ? `notes-${i}.md` : `f${i}.ts`), "");
}
console.log(`fixture: ${n} files in ${Date.now() - t0} ms`);

const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home };

/** Launches from the big project; resolves when the URL is printed, with the ms from spawn to print. */
async function server(extra = []) {
  const at = performance.now();
  const child = spawn(NODE, [CLI, "--no-open", "--port", String(await freePort()), ...extra], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  started.add(child);
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 20000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
  });
  const printedAt = Date.now();
  return { url, printMs: performance.now() - at, printedAt, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  for (const mode of ["git", "walk"]) {
    if (mode === "git") spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    else rmSync(path.join(root, ".git"), { recursive: true, force: true });
    rmSync(path.join(home, ".grillado"), { recursive: true, force: true }); // no cache: a first launch

    const base = await server(["--no-scan"]);
    await base.stop();
    rmSync(path.join(home, ".grillado"), { recursive: true, force: true });
    const s = await server();
    const pg = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await pg.goto(s.url); // the token sets the session cookie
    await pg.evaluate(() => fetch("/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "claude", remember: false }) }));
    const view = async () => pg.evaluate(() => fetch("/api/found").then((r) => r.json()));
    const t = Date.now();
    let v = await view();
    while (v.state !== "done" && Date.now() - t < 15000) {
      await new Promise((r) => setTimeout(r, 50));
      v = await view();
    }
    const scanEnd = Date.parse(v.scannedAt);
    console.log(`${mode}: URL printed after ${Math.round(s.printMs)} ms (--no-scan: ${Math.round(base.printMs)} ms); scan ${v.ms} ms, ${v.paths} paths, partial ${v.partial}, ${v.rows?.length} rows`);
    check(`${mode}: the scan finished`, v.state === "done", v.state);
    check(`${mode}: the URL is printed before the scan ends`, s.printedAt <= scanEnd, `printed ${scanEnd - s.printedAt} ms before it ended`);
    check(`${mode}: the scan doesn't delay the URL (vs --no-scan, +${PRINT_SLACK_MS} ms)`, s.printMs <= base.printMs + PRINT_SLACK_MS, `${Math.round(s.printMs)} vs ${Math.round(base.printMs)} ms`);
    check(`${mode}: the scan ends within its ${BUDGET_MS} ms budget (+${SLACK_MS} ms for the read in flight)`, typeof v.ms === "number" && v.ms <= BUDGET_MS + SLACK_MS, `${v.ms} ms`);
    check(`${mode}: it stops at the 5,000-path budget, long before 50,000`, v.paths > 0 && v.paths <= 5000, String(v.paths));
    check(`${mode}: the result is marked partial`, v.partial === true);
    check(`${mode}: the plans found before the budget ran out are listed`, ["Billing v2", "Faster search", "Onboarding checklist"].every((x) => v.rows.some((r) => r.title === x)), v.rows.map((r) => r.title).join(", "));

    await pg.reload();
    const found = pg.getByTestId("found");
    await found.waitFor({ timeout: 10000 });
    await pg.waitForFunction(() => document.querySelector("[data-testid=found] .slot")?.textContent?.includes("1.5"), null, { timeout: 10000 });
    const slot = (await found.locator(".slot").innerText()).replace(/\s+/g, " ").trim();
    check(`${mode}: Home shows the partial line, with one Look again`, /Showing what we found in 1\.5 s · Look again$/.test(slot) && (await found.getByRole("button", { name: "Look again" }).count()) === 1, slot);
    check(`${mode}: Home lists the rows`, (await found.getByTestId("found-row").count()) === 3);
    const r = await new AxeBuilder({ page: pg }).analyze();
    check(`${mode}: axe on Home with a partial result`, r.violations.length === 0, r.violations.map((x) => `${x.id} ${x.nodes[0]?.target}`).join("; "));
    if (SHOTS && mode === "git") {
      mkdirSync(path.join(SHOTS, "1-group"), { recursive: true });
      await pg.waitForTimeout(400);
      await pg.screenshot({ path: path.join(SHOTS, "1-group", "d-partial-50k-dark.png") });
    }
    await pg.context().close();
    await s.stop();
  }
} catch (err) {
  failures++;
  console.log(`FAIL  crashed: ${err?.stack ?? err}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(`total ${Math.round((Date.now() - t0) / 100) / 10} s`);
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
