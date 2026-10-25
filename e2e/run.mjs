// End-to-end: pack the package, install it like `npx` would, start it against fake agent CLIs,
// drive the UI in headless Chrome, and check security, concealment, shutdown and a11y.
// One server and one browser at a time; only processes started here are killed.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-e2e-"));
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const BANNED = ["grill-me", "grilling", "matt pocock", "mattpocock"];
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ------------------------------------------------------------------ setup

console.log(`work dir: ${WORK}`);
const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", WORK], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1);
const tarball = path.join(WORK, tgz);
const prefix = path.join(WORK, "prefix");
execFileSync("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { stdio: "ignore" });
const BIN = path.join(prefix, "bin", "grillado");
check("npm pack + install: bin exists", existsSync(BIN), `${(readFileSync(tarball).length / 1024).toFixed(0)} KB tarball`);

const fragments = JSON.parse(
  execFileSync("bun", ["-e", "import {promptFragments} from './src/core/prompts.ts'; console.log(JSON.stringify(promptFragments()))"], { cwd: ROOT, encoding: "utf8" }),
).map((f) => f.toLowerCase());

const NODE = process.execPath;
function fakeBins(ids) {
  const dir = mkdtempSync(path.join(WORK, "bin-"));
  for (const id of ids) {
    writeFileSync(path.join(dir, id), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" ${id} "$@"\n`);
    chmodSync(path.join(dir, id), 0o755);
  }
  return dir;
}
function env(binDir, extra = {}) {
  const home = mkdtempSync(path.join(WORK, "home-"));
  return {
    PATH: `${binDir}:${path.dirname(NODE)}:/usr/bin:/bin`,
    HOME: home,
    GRILLADO_HOME: path.join(home, ".grillado"),
    FAKE_STATE_DIR: home,
    FAKE_LOG: path.join(home, "fake.log"),
    ...extra,
  };
}

const started = new Set();
function cleanup() {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
}
process.on("exit", cleanup);

function startServer(args, e) {
  const child = spawn(BIN, args, { env: e, stdio: ["ignore", "pipe", "pipe"] });
  started.add(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const url = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no URL printed:\n${out}`)), 15_000);
    child.stdout.on("data", () => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([\w-]+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve({ url: m[0], port: Number(m[1]), token: m[2] });
      }
    });
  });
  return { child, url, exited, output: () => out };
}

async function stop(server, signal = "SIGINT") {
  const t0 = Date.now();
  server.child.kill(signal);
  const r = await Promise.race([server.exited, new Promise((res) => setTimeout(() => res({ code: "timeout" }), 3000))]);
  return { ...r, ms: Date.now() - t0 };
}

function runCli(args, e) {
  try {
    const out = execFileSync(BIN, args, { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function raw(port, { path: p = "/", headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function shot(page, name) {
  if (!process.env.SCREENSHOTS) return;
  mkdirSync(process.env.SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `${name}.png`), fullPage: true });
}

function containsBanned(text) {
  const t = text.toLowerCase();
  return [...BANNED, ...fragments].find((x) => t.includes(x));
}

const procAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ CLI flags

{
  const e = env(fakeBins(["claude", "codex"]));
  check("--version", runCli(["--version"], e).out.trim() === "0.1.0");
  const help = runCli(["--help"], e);
  check("--help mentions 127.0.0.1", help.code === 0 && help.out.includes("127.0.0.1"));
  const bad = runCli(["--provider", "nope"], e);
  check("unknown --provider exits 2", bad.code === 2, bad.out.split("\n")[0]);
  const missing = runCli(["--provider", "pi", "--no-open", "--port", "47999"], e);
  check("missing --provider exits 2", missing.code === 2, missing.out.trim().split("\n").at(-1));
  check("help/usage output has no banned text", !containsBanned(help.out + bad.out + missing.out));
}

// ------------------------------------------------------------------ main flow

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const e = env(fakeBins(["claude", "codex"]));
  // Port already taken → next free one (AC11).
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = blocker.address().port;
  const strict = runCli(["--no-open", "--port", String(busyPort)], e);
  check("--port N busy exits with error", strict.code !== 0 && /already in use/.test(strict.out), strict.out.trim().split("\n").at(-1));

  const server = startServer(["--no-open"], e);
  const { url, port, token } = await server.url;
  blocker.close();
  check("server prints URL with token", Boolean(url), url.replace(token, "<token>"));
  check("banner lists detected agents", /Claude Code 9\.9\.9-fake/.test(server.output()) && /pi not found/.test(server.output()));

  // Security (AC10).
  check("API without token → 401", (await raw(port, { path: "/api/state" })).status === 401);
  check("foreign Host → 403", (await raw(port, { path: "/api/state", headers: { host: "evil.example", "x-grillado-token": token } })).status === 403);
  check(
    "foreign Origin → 403",
    (await raw(port, { path: "/api/state", headers: { origin: "http://evil.example", "x-grillado-token": token } })).status === 403,
  );
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  for (const ip of ips) {
    const outcome = await new Promise((resolve) => {
      const s = net.connect({ host: ip, port, timeout: 2000 });
      s.on("connect", () => (s.destroy(), resolve("connected")));
      s.on("error", (err) => resolve(err.code));
      s.on("timeout", () => (s.destroy(), resolve("timeout")));
    });
    check(`non-loopback ${ip}:${port} refused`, outcome !== "connected", outcome);
  }
  if (!ips.length) check("non-loopback interface available for refusal test", false, "none found");
  // Local address column of every listening socket on this port.
  const locals = execFileSync("ss", ["-ltnH", `sport = :${port}`], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/)[3]);
  check("socket bound to 127.0.0.1 only", locals.length > 0 && locals.every((a) => a === `127.0.0.1:${port}`), locals.join(" "));

  // Browser.
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const bodies = [];
  page.on("response", async (res) => {
    if (!res.url().startsWith(`http://127.0.0.1:${port}`)) return;
    try {
      bodies.push({ url: res.url(), text: await res.text() });
    } catch {}
  });
  const sse = [];
  await page.exposeFunction("__sse", (d) => sse.push(d));
  await page.addInitScript(() => {
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      constructor(...a) {
        super(...a);
        this.addEventListener("message", (m) => window.__sse(m.data));
      }
    };
  });

  await page.goto(url);
  check("token in URL is dropped after load", new URL(page.url()).search === "");
  await page.getByRole("heading", { name: "Which agent should run this?" }).waitFor();
  check("picker shown with 2 agents", (await page.getByRole("radio").count()) >= 2);
  check("picker shows each CLI's --version", (await page.getByRole("radiogroup").textContent()).includes("9.9.9-fake"));
  const axePicker = await new AxeBuilder({ page }).analyze();
  check("axe: picker", axePicker.violations.length === 0, axePicker.violations.map((v) => v.id).join(","));
  await page.getByLabel("Remember my choice").check();
  await page.getByRole("radio", { name: /Claude Code/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();

  const ideaBox = page.getByRole("textbox", { name: "What are you planning?" });
  await ideaBox.waitFor();
  const axeHome = await new AxeBuilder({ page }).analyze();
  check("axe: home", axeHome.violations.length === 0, axeHome.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  const config = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "config.json"), "utf8"));
  check("remembered default provider", config.defaultProvider === "claude");
  check("agent chip carries the version", /Claude Code 9\.9\.9-fake/.test((await page.getByRole("banner").getByRole("button", { name: /Agent: Claude Code/ }).textContent()) ?? ""));

  // Keyboard-only from here on.
  await ideaBox.fill("A grilling recipe app for weeknights");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15_000 });
  check("round 1 stacks both questions at once", (await page.getByTestId("question").count()) === 2 && (await page.getByText("Start on the web?").count()) === 1);
  await shot(page, "round");
  await page.waitForURL(/\/s\//);
  const sessionId = new URL(page.url()).pathname.split("/").pop();

  // Reduced motion: cards only fade, the frontier glow doesn't breathe.
  const rm = await page.evaluate(() => ({
    card: getComputedStyle(document.querySelector("[data-testid=question]")).animationName,
    glow: getComputedStyle(document.querySelector(".st-frontier .nd .gl")).animationName,
  }));
  check("prefers-reduced-motion: fade only, no breathing", rm.card === "gr-fade" && rm.glow === "none", JSON.stringify(rm));
  await page.waitForTimeout(400); // heat word and cards finish their entrance before contrast is measured
  const axeRound = await new AxeBuilder({ page }).analyze();
  check("axe: round view (dark)", axeRound.violations.length === 0, axeRound.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  check("tree shows the round's questions as open", (await page.locator("[role=treeitem].st-frontier").count()) === 2);

  // Refresh mid-round restores it (AC14).
  await page.reload();
  await page.getByRole("heading", { name: "2 decisions are ready" }).waitFor();
  check("refresh restores the open round", true);

  // AC15 / stacked submit: suggestions are preselected (and count as answered), so "1" keeps Q1's
  // pick and lands on Send; J moves to Q2, "2" picks its second option, Enter sends the whole round.
  await page.waitForTimeout(150);
  const checked = await page.locator("[data-testid=question] [role=radio][data-state=checked]").first().getAttribute("aria-label");
  check("recommended option preselected", /recommended, preselected/i.test(checked ?? ""), checked);
  check("preselected picks are marked untouched", (await page.locator("[data-slot=agent-question-option][data-untouched]").count()) === 2);
  await page.keyboard.press("1");
  await page.keyboard.press("j");
  await page.keyboard.press("2"); // Mobile app (not recommended)
  check("card shows 'Your call' once the pick moves off the suggestion", (await page.getByText("Your call").count()) === 1);
  check(
    "Send focused once every card is answered",
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Send round"), null, { timeout: 2000 }).then(
      () => true,
      () => false,
    ),
    await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent?.slice(0, 40)}`),
  );
  // A number key on the last open card only moves focus to Send; it never submits.
  await page.keyboard.press("2");
  await page.waitForTimeout(600);
  const notSent = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json"), "utf8"));
  check(
    "number key on the last open card never submits",
    (notSent.rounds[0]?.answers?.length ?? 0) === 0 && (await page.getByRole("heading", { name: "2 decisions are ready" }).count()) === 1 &&
      (await page.evaluate(() => document.activeElement?.textContent?.startsWith("Send round"))),
  );
  await page.keyboard.press("Enter"); // send
  await page.getByText("Keep data local first?").waitFor({ timeout: 15_000 });
  check("round 2 shown after a keyboard stacked submit", true);
  check("round 2 card says what opened it", (await page.getByText("Opened by").textContent())?.includes("Platform"));
  let saved = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json"), "utf8"));
  check(
    "stacked submit sends every answer with accepted_recommendation",
    saved.rounds[0].answers.length === 2 && saved.rounds[0].answers[0].accepted_recommendation === true && saved.rounds[0].answers[1].accepted_recommendation === false,
    JSON.stringify(saved.rounds[0].answers.map((a) => [a.questionId, a.optionId, a.accepted_recommendation])),
  );

  // Light theme from the header menu; axe again.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Light theme" }).click();
  check("theme toggles to light", await page.evaluate(() => document.documentElement.classList.contains("light")));
  await page.waitForTimeout(200);
  const axeRoundLight = await new AxeBuilder({ page }).analyze();
  check("axe: round view (light)", axeRoundLight.violations.length === 0, axeRoundLight.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));

  // "Something else" with free text: option 3 opens the field, Enter saves, Enter sends.
  await page.locator("[data-testid=question] legend").first().focus();
  await page.keyboard.press("3");
  await page.keyboard.type("SQLite on the device");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15_000 });
  check("confirm gate after frontier empties", true);
  await shot(page, "confirm");
  saved = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json"), "utf8"));
  check("no plan before confirm (AC7)", !saved.plan && !existsSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "plan.md")));
  check("free text saved", saved.decisions.storage?.answer === "SQLite on the device", saved.decisions.storage?.answer);
  await page.waitForTimeout(300);
  const axeConfirm = await new AxeBuilder({ page }).analyze();
  check("axe: confirm gate (light)", axeConfirm.violations.length === 0, axeConfirm.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));

  // Reopen dialog lists what depends on the decision and previews it in the tree; Esc cancels.
  await page.getByRole("button", { name: "Reopen Platform" }).click();
  const dlg = page.getByRole("alertdialog", { name: "Reopen “Platform”?" });
  await dlg.waitFor();
  check("reopen dialog lists dependents", (await dlg.textContent()).includes("Storage"));
  check("Cancel focused in reopen dialog", await page.evaluate(() => document.activeElement?.textContent === "Cancel"));
  // The preview lands a frame after the dialog; wait for it instead of racing it.
  await page.locator("[role=treeitem][data-preview]").nth(1).waitFor({ timeout: 2000 }).catch(() => {});
  check("tree previews the re-asks", (await page.locator("[role=treeitem][data-preview]").count()) === 2);
  await page.waitForTimeout(300); // let the 120 ms fade finish before measuring contrast
  const axeDlg = await new AxeBuilder({ page }).analyze();
  check("axe: reopen dialog", axeDlg.violations.length === 0, axeDlg.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  await page.keyboard.press("Escape");
  check("Esc closes the dialog", (await dlg.count()) === 0);

  await page.getByRole("button", { name: "Yes, plate it" }).click();
  await page.getByTestId("plan").waitFor({ timeout: 15_000 });
  await shot(page, "plan");
  const planFile = path.join(e.GRILLADO_HOME, "sessions", sessionId, "plan.md");
  const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
  check("plan.md saved", plan.length > 0, planFile);
  check("plan cites every decision (AC16)", ["[R1:scope]", "[R1:platform]", "[R2:storage]"].every((t) => plan.includes(t)));
  check("plan.md has no banned text / prompt contents (AC17)", !containsBanned(plan.replace(/grilling recipe app/gi, "")));
  check("UI shows file path", (await page.getByTestId("plan-path").textContent()) === planFile);
  const cites = page.locator("[data-testid=plan] .cite");
  check("citations render as R·n chips", (await cites.count()) === 6 && (await cites.nth(1).textContent()) === "R1·2", await cites.allTextContents().then((t) => t.join(" ")));
  check("decision log shows chips, not raw ids", !/\[R\d+:/.test(await page.getByTestId("plan").textContent()));
  await cites.nth(1).click();
  check("citation highlights the log entry", (await page.locator(".tl li[data-hl]").textContent())?.includes("Platform"));
  const axePlan = await new AxeBuilder({ page }).analyze();
  check("axe: plan view (light)", axePlan.violations.length === 0, axePlan.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Dark theme" }).click();
  await page.waitForTimeout(200);
  const axePlanDark = await new AxeBuilder({ page }).analyze();
  check("axe: plan view (dark)", axePlanDark.violations.length === 0, axePlanDark.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));

  // ---- v1.1 plan editor: rich/raw toggle, autosave to plan.md, Mermaid, list markers.
  const axeIds = (r) => r.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(",");
  const onDisk = () => readFileSync(planFile, "utf8");
  const waitDisk = async (pred, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(onDisk())) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  const marker = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=plan] ul")).listStyleType);
  check("plan lists show bullets", marker === "disc", marker);
  await page.getByRole("group", { name: "Plan view" }).getByRole("button", { name: "Markdown" }).click();
  const rawBox = page.getByRole("textbox", { name: "Plan Markdown" });
  check("raw view shows plan.md byte for byte, raw [R1:id]s included", (await rawBox.inputValue()) === plan && plan.includes("[R1:platform]"));
  const axeRaw = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, Markdown view (dark)", axeRaw.violations.length === 0, axeIds(axeRaw));
  const diagrams = "\n## Flow\n\n```mermaid\nflowchart TD\n  A[Idea] --> B[Plan]\n```\n\n```mermaid\n---\nconfig:\n  layout: elk\n---\nflowchart LR\n  C[Asks for ELK] --> D[Gets dagre]\n```\n\n```mermaid\nflowchart TD\n  A -->\n```\n";
  const typed = plan + diagrams;
  await rawBox.fill(typed);
  await shot(page, "plan-editor-markdown-dark");
  check("raw edit autosaves to plan.md", await waitDisk((t) => t === typed));
  await page.getByTestId("save-status").getByText(/^Saved/).waitFor({ timeout: 5000 });
  check("save status says Saved", true);
  await page.getByRole("group", { name: "Plan view" }).getByRole("button", { name: "Document" }).click();
  await page.locator(".mmd[data-state=ok] svg").first().waitFor({ timeout: 15_000 });
  await page.locator(".mmd[data-state=ok] svg").nth(1).waitFor({ timeout: 15_000 });
  check("valid Mermaid blocks render SVGs (under the app's CSP), ELK requests fall back to dagre", (await page.locator(".mmd[data-state=ok] svg").count()) === 2);
  await page.locator(".mmd[data-state=error]").waitFor({ timeout: 5000 });
  check("invalid Mermaid block shows its error and source", ((await page.locator(".mmd[data-state=error] .mmd-err").textContent()) ?? "").includes("can't be drawn") && (await page.locator(".mmd[data-state=error] pre").textContent()).includes("A -->"));
  await page.locator(".mmd").first().scrollIntoViewIfNeeded();
  await shot(page, "plan-editor-diagrams-dark");
  // Edit one block in place in the rich view.
  const para = page.locator("[data-testid=plan] .blk[data-block=para]").first();
  const before = (await para.textContent()) ?? "";
  await para.click({ position: { x: 4, y: 4 } });
  const blockBox = page.getByRole("textbox", { name: /Edit block as Markdown/ });
  await blockBox.waitFor();
  await blockBox.press("End");
  await blockBox.pressSequentially(" Edited in place.");
  await shot(page, "plan-editor-block-edit-dark");
  const axeBlock = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, editing a block (dark)", axeBlock.violations.length === 0, axeIds(axeBlock));
  await blockBox.press("Escape");
  check("Escape closes the block editor", (await blockBox.count()) === 0);
  check("block edit autosaves to plan.md", await waitDisk((t) => t.includes(`${before} Edited in place.`) || t.includes("Edited in place.")));
  const edited = onDisk();
  check("only the edited block changed on disk", edited === typed.replace(`\n${before}\n`, `\n${before} Edited in place.\n`), JSON.stringify(before.slice(0, 40)));
  check("citations survive the edits", ["[R1:scope]", "[R1:platform]", "[R2:storage]"].every((t) => edited.includes(t)));
  const axeDocDark = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor with diagrams (dark)", axeDocDark.violations.length === 0, axeIds(axeDocDark));
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Light theme" }).click();
  await page.locator(".mmd[data-state=ok] svg").first().waitFor();
  await page.waitForTimeout(400);
  const axeDocLight = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor with diagrams (light)", axeDocLight.violations.length === 0, axeIds(axeDocLight));
  await page.locator(".mmd").first().scrollIntoViewIfNeeded();
  await shot(page, "plan-editor-diagrams-light");
  await page.getByRole("group", { name: "Plan view" }).getByRole("button", { name: "Markdown" }).click();
  const axeRawLight = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, Markdown view (light)", axeRawLight.violations.length === 0, axeIds(axeRawLight));
  await shot(page, "plan-editor-markdown-light");
  await page.getByRole("group", { name: "Plan view" }).getByRole("button", { name: "Document" }).click();
  await page.reload();
  await page.getByTestId("plan").waitFor();
  check("edits survive a reload", ((await page.getByTestId("plan").textContent()) ?? "").includes("Edited in place."));
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Dark theme" }).click();

  // Agent ran in an empty temp cwd with the tools-off argv.
  const log = readFileSync(e.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runs = log.filter((l) => l.args[0] !== "--version" && l.args[0] !== "--help");
  check("agent cwd is an empty grillado-agent-* temp dir", runs.every((r) => /grillado-agent-/.test(r.cwd)), runs[0]?.cwd);
  check("claude ran with --tools \"\"", runs.every((r) => r.args.includes("--tools") && r.args[r.args.indexOf("--tools") + 1] === ""));

  // Refresh on the plan restores it.
  await page.reload();
  await page.getByTestId("plan").waitFor();
  check("refresh restores the plated session", true);

  // AC17 over everything the browser received (HTTP + SSE). The idea itself contains a banned word
  // the user typed; it's the user's own text, so strip it before checking.
  const scrub = (t) => t.replace(/grilling recipe app/gi, "");
  const leaks = [...bodies.map((b) => ({ where: b.url, hit: containsBanned(scrub(b.text)) })), ...sse.map((d) => ({ where: "sse", hit: containsBanned(scrub(d)) }))].filter((x) => x.hit);
  check("no banned strings in HTTP/SSE responses (AC17)", leaks.length === 0 && bodies.length > 5 && sse.length > 0, leaks.map((l) => `${l.where}: ${l.hit}`).join("; ") || `${bodies.length} responses, ${sse.length} SSE frames`);

  // Graceful stop (AC13) and the stopped state in the tab.
  const st = await stop(server, "SIGINT");
  check("SIGINT exits 0 within 3s", st.code === 0, `${st.ms} ms`);
  await page.getByRole("heading", { name: "Grillado was stopped" }).waitFor({ timeout: 10_000 });
  check("tab shows 'stopped' state", true);

  // Plan edits survive a restart (v1.1 acceptance): new process, same data dir.
  const sessionPath = `/s/${sessionId}`;
  const again = startServer(["--no-open"], e);
  const { url: url2, port: port2 } = await again.url;
  await page.goto(url2);
  await page.goto(`http://127.0.0.1:${port2}${sessionPath}`);
  await page.getByTestId("plan").waitFor({ timeout: 10_000 });
  await page.locator(".mmd[data-state=ok]").nth(1).waitFor({ timeout: 15_000 }).catch(() => {});
  const restored = (await page.getByTestId("plan").textContent()) ?? "";
  check("plan edits survive a restart", restored.includes("Edited in place.") && (await page.locator(".mmd[data-state=ok]").count()) === 2, restored.slice(0, 80));
  check("restart: second server exits 0", (await stop(again, "SIGINT")).code === 0);
  await context.close();

  // ---------------------------------------------------------------- slow run + SIGTERM kills children
  {
    const e2 = env(fakeBins(["claude"]), { FAKE_MODE: "slow" });
    const s2 = startServer(["--no-open"], e2);
    const { token: t2, port: p2 } = await s2.url;
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: p2, method: "POST", path: "/api/sessions", headers: { "content-type": "application/json", "x-grillado-token": t2 } },
        (res) => (res.resume(), res.on("end", resolve)),
      );
      req.on("error", reject);
      req.end(JSON.stringify({ idea: "x" }));
    });
    let pid;
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const lines = existsSync(e2.FAKE_LOG) ? readFileSync(e2.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      pid = lines.find((l) => l.args[0] === "-p")?.pid;
    }
    check("slow agent run started", Boolean(pid) && procAlive(pid), `pid ${pid}`);
    const r = await stop(s2, "SIGTERM");
    await new Promise((res) => setTimeout(res, 300));
    check("SIGTERM exits 0 within 3s", r.code === 0, `${r.ms} ms`);
    check("in-flight agent process killed", pid && !procAlive(pid));
    const files = readdirSync(path.join(e2.GRILLADO_HOME, "sessions"));
    check("session flushed to disk", files.length === 1);
  }

  // ---------------------------------------------------------------- auth failure in the UI (AC8)
  {
    const e3 = env(fakeBins(["claude"]), { FAKE_MODE: "auth" });
    const s3 = startServer(["--no-open"], e3);
    const { url: u3 } = await s3.url;
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(u3);
    await pg.getByRole("textbox", { name: "What are you planning?" }).fill("A tiny CRM");
    await pg.keyboard.press("Enter");
    const banner = pg.getByTestId("problem");
    await banner.waitFor({ timeout: 15_000 });
    check("auth error shown as 'Log in to …' (AC8)", (await banner.getAttribute("data-code")) === "auth" && /Log in to Claude Code/.test(await banner.textContent()));
    await shot(pg, "auth-error");
    check("auth banner offers retry", (await pg.getByRole("button", { name: "I've logged in, retry" }).count()) === 1);
    const axeErr = await new AxeBuilder({ page: pg }).analyze();
    check("axe: error state", axeErr.violations.length === 0, axeErr.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
    await ctx.close();
    const r = await stop(s3, "SIGINT");
    check("SIGINT (idle) exits 0", r.code === 0, `${r.ms} ms`);
  }

  // ---------------------------------------------------------------- long run: heat goes down, passivity nudge
  {
    const e5 = env(fakeBins(["claude"]), { FAKE_MODE: "long" });
    const s5 = startServer(["--no-open"], e5);
    const { url: u5 } = await s5.url;
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(u5);
    await pg.getByRole("textbox", { name: "What are you planning?" }).fill("A notes app");
    await pg.keyboard.press("Enter");
    const titles = ["Build it for yourself first?", "Start with the capture flow?", "Include search in v1?", "Sync across devices?", "Back up nightly?", "Launch to friends first?"];
    const heat = [];
    const nudges = [];
    for (const [i, t] of titles.entries()) {
      await pg.getByText(t).first().waitFor({ timeout: 15_000 });
      await pg.waitForTimeout(150);
      heat.push(Number(await pg.getByTestId("heat").getAttribute("data-level")));
      nudges.push(await pg.getByTestId("nudge").count());
      if (i === 4) {
        await shot(pg, "nudge");
        check("nudge copy", (await pg.getByTestId("nudge").textContent()).includes("You've kept every suggestion for 4 rounds"));
        const axeN = await new AxeBuilder({ page: pg }).analyze();
        check("axe: nudge", axeN.violations.length === 0, axeN.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
        await pg.getByRole("button", { name: "Review my picks" }).click();
        check("'Review my picks' focuses the first card", await pg.evaluate(() => document.activeElement?.tagName === "LEGEND"));
        await pg.getByRole("button", { name: "Looks right" }).click();
        check("'Looks right' hides the nudge", (await pg.getByTestId("nudge").count()) === 0);
        await pg.locator("[data-testid=question] legend").first().focus();
      }
      await pg.keyboard.press("Enter"); // keep every suggestion and send
      if (i < titles.length - 1) await pg.getByText(t).first().waitFor({ state: "detached", timeout: 15_000 });
    }
    check("heat meter goes down when a round opens many decisions", heat[1] === 3 && heat[2] === 2, heat.join(" → "));
    check("nudge only after 4 all-accept rounds", nudges.slice(0, 4).every((n) => n === 0) && nudges[4] === 1, nudges.join(","));
    await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15_000 });
    const s5json = JSON.parse(readFileSync(path.join(e5.GRILLADO_HOME, "sessions", readdirSync(path.join(e5.GRILLADO_HOME, "sessions"))[0], "session.json"), "utf8"));
    check("'Looks right' is remembered", s5json.nudgeDismissed === true);
    await ctx.close();
    await stop(s5, "SIGINT");
  }

  // ---------------------------------------------------------------- mobile: ghost Wrap it up, early confirm lists Still open first
  {
    const e6 = env(fakeBins(["claude"]), { FAKE_MODE: "long" });
    const s6 = startServer(["--no-open"], e6);
    const { url: u6 } = await s6.url;
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    await pg.goto(u6);
    await pg.getByRole("textbox", { name: "What are you planning?" }).fill("A notes app");
    await pg.keyboard.press("Enter");
    await pg.getByText("Build it for yourself first?").waitFor({ timeout: 15_000 });
    const wrapBtn = pg.locator(".bar").getByRole("button", { name: "Wrap it up" });
    check("mobile bar hides Wrap it up before anything is settled", !(await wrapBtn.isVisible()));
    await pg.getByRole("button", { name: "Send round" }).click();
    await pg.getByText("Start with the capture flow?").waitFor({ timeout: 15_000 });
    check("mobile bar shows Wrap it up once a decision is settled", await wrapBtn.isVisible());
    const [wb, sb] = [await wrapBtn.boundingBox(), await pg.getByRole("button", { name: "Send round" }).boundingBox()];
    check("mobile Wrap it up sits left of Send", wb && sb && wb.x + wb.width <= sb.x);
    await wrapBtn.click();
    await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15_000 });
    check("early confirm says Wrapping up early", (await pg.getByText("Wrapping up early").count()) === 1);
    check("early confirm lists Still open first", (await pg.locator(".dl h2").first().textContent()) === "Still open", await pg.locator(".dl h2").allTextContents().then((t) => t.join(",")));
    const axeM = await new AxeBuilder({ page: pg }).analyze();
    check("axe: early confirm (mobile)", axeM.violations.length === 0, axeM.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target}`).join(","));
    await ctx.close();
    await stop(s6, "SIGINT");
  }

  // ---------------------------------------------------------------- no agent → empty state (AC2)
  {
    const e4 = env(fakeBins([]));
    const s4 = startServer(["--no-open"], e4);
    const { url: u4 } = await s4.url;
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(u4);
    await pg.getByRole("heading", { name: "No coding agent found" }).waitFor();
    const text = await pg.textContent("main");
    check(
      "empty state lists all 4 install commands",
      ["npm i -g @anthropic-ai/claude-code", "npm i -g @openai/codex", "curl -fsSL https://x.ai/cli/install.sh | bash", "npm i -g @mariozechner/pi-coding-agent"].every((c) => text.includes(c)),
    );
    check("no idea input in empty state", (await pg.getByRole("textbox", { name: "What are you planning?" }).count()) === 0);
    const axeEmpty = await new AxeBuilder({ page: pg }).analyze();
    check("axe: empty state", axeEmpty.violations.length === 0, axeEmpty.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
    await ctx.close();
    await stop(s4, "SIGINT");
  }
} catch (err) {
  check("e2e run completed", false, String(err?.stack ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  await browser.close();
  cleanup();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (!process.env.KEEP_E2E) rmSync(WORK, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
