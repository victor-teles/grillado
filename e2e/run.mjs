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
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
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
  check("--version", runCli(["--version"], e).out.trim() === VERSION);
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
  const locals = process.platform === "darwin"
    ? execFileSync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }).trim().split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1))
    : execFileSync("ss", ["-ltnH", `sport = :${port}`], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/)[3]);
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
  check(
    "no focus ring at load before any key press (v1.2 review)",
    await page.evaluate(() => {
      const a = document.activeElement;
      return !document.documentElement.hasAttribute("data-kbd") && (!a || a === document.body || getComputedStyle(a).outlineStyle === "none");
    }),
  );
  await page.getByLabel("Remember my choice").check();
  await page.getByRole("radio", { name: /Claude Code/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();

  const ideaBox = page.getByRole("textbox", { name: "What are you planning?" });
  await ideaBox.waitFor();
  const axeHome = await new AxeBuilder({ page }).analyze();
  check("axe: home", axeHome.violations.length === 0, axeHome.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  const foot = (await page.locator(".note.empty").textContent()) ?? "";
  check("home footnote shows the data dir under ~/ (v1.2 review)", foot.includes("~/.grillado") && !foot.includes("/tmp"), foot);
  const config = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "config.json"), "utf8"));
  check("remembered default provider", config.defaultProvider === "claude");
  // v1.2: no agent in the header before a session; the composer carries it.
  check("agent chip carries the version", /Claude Code 9\.9\.9-fake/.test((await page.getByRole("main").getByRole("button", { name: /Agent: Claude Code/ }).textContent()) ?? ""));

  // Keyboard-only from here on.
  await ideaBox.fill("A grilling recipe app for weeknights");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15_000 });
  check("round 1 stacks both questions at once", (await page.getByTestId("question").count()) === 2 && (await page.getByText("Start on the web?").count()) === 1);
  const rc1 = await page.getByTestId("round-counter").textContent();
  check("#36: round 1's counter, 12px under the title", rc1 === "Round 1 of 2" && (await page.getByTestId("round-counter").evaluate((el) => getComputedStyle(el).fontSize === "12px" && el.previousElementSibling?.tagName === "H1")), rc1);
  await shot(page, "round");
  await page.waitForURL(/\/s\//);
  const sessionId = new URL(page.url()).pathname.split("/").pop();

  // Reduced motion (v1.2 §7): nothing animates or loops; transitions are limited to opacity and colour.
  const rm = await page.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    return {
      animated: all.filter((el) => getComputedStyle(el).animationName !== "none").map((el) => el.className?.toString?.() || el.tagName).slice(0, 5),
      card: getComputedStyle(document.querySelector("[data-testid=question]")).transitionProperty,
    };
  });
  check("prefers-reduced-motion: nothing animates; only opacity/colour transitions", rm.animated.length === 0 && !/transform/.test(rm.card), JSON.stringify(rm));
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
  const rc2 = await page.getByTestId("round-counter").textContent();
  check("#36: round N reads Round 2 of 2 · last round, the tag at 500", rc2 === "Round 2 of 2 · last round" && (await page.getByTestId("round-counter").locator(".last").evaluate((el) => getComputedStyle(el).fontWeight === "500")), rc2);
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
  check("confirm gate after the last round", true);
  const st2 = await page.getByTestId("round-status").textContent();
  check("#33: default cap of 2: the status line says round 2 of 2 is done", st2 === "Round 2 of 2 is done.", st2);
  check("#33: the status line is 12px, under the title", (await page.getByTestId("round-status").evaluate((el) => getComputedStyle(el).fontSize === "12px" && el.previousElementSibling?.tagName === "H1")));
  check("#33: no Keep going at the cap", (await page.getByRole("button", { name: "Keep going on a branch" }).count()) === 0);
  const more = page.getByRole("button", { name: "Ask 1 more round", exact: true });
  check("#37: Ask 1 more round, quiet, in Keep going's slot; Yes, plate it keeps the focus", (await more.count()) === 1 && /\bquiet\b/.test((await more.getAttribute("class")) ?? "") && (await page.evaluate(() => document.activeElement?.textContent?.startsWith("Yes, plate it"))));
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
  check(
    "plan.md has a decision block for every answer (AC16)",
    ["key: scope", "key: platform", "key: storage"].every((t) => plan.includes(t)) && (plan.match(/^```decision$/gm) ?? []).length === 3 && plan.includes("[R1:platform]"),
  );
  check("plan.md has no banned text / prompt contents (AC17)", !containsBanned(plan.replace(/grilling recipe app/gi, "")));
  // v1.2: the path lives in the toolbar's ⋯ menu ("Plan actions").
  await page.getByRole("button", { name: "Plan actions" }).click();
  check("UI shows file path (Plan actions menu)", (await page.getByTestId("plan-path").textContent()) === planFile);
  await page.keyboard.press("Escape");
  check("no Decisions log rail (Q1)", (await page.locator("aside.side2").count()) === 0 && (await page.getByText("Decisions log").count()) === 0);
  check("save status persists as 'Plated · saved to plan.md' (replaces the 'Saved to disk' badge)", (await page.getByTestId("save-status").textContent())?.includes("Plated · saved to plan.md"));
  // Item 2 handoff: cites live in the right margin (.gut), one per passage, labelled R·n.
  const cites = page.locator("[data-testid=plan] .gut-cite");
  check("citations render as R·n margin cites", (await cites.count()) === 3 && ((await cites.nth(1).textContent()) ?? "").startsWith("R1·2"), await cites.allTextContents().then((t) => t.join(" ")));
  const [citeBox, docBox] = [await cites.nth(1).boundingBox(), await page.locator("[data-testid=plan] .ps").nth(1).boundingBox()];
  check("margin cites sit to the RIGHT of the text column", !!citeBox && !!docBox && citeBox.x > docBox.x + docBox.width - 1, JSON.stringify([citeBox, docBox]));
  check("document shows cites and decision cards, not raw ids or YAML", !/\[R\d+:|kept_suggestion/.test(await page.getByTestId("plan").textContent()));
  const cards = page.locator("[data-testid=plan] .dz");
  check("each decision renders as a compact card", (await cards.count()) === 3 && (await page.getByRole("group", { name: /^Decision R1·2/ }).count()) === 1);
  // Hovering a passage lights its decision after the 120ms intent delay, and the margin cite shows the answer.
  const ps2 = page.locator("[data-testid=plan] .ps[data-keys~=platform]").first();
  await ps2.hover();
  await page.waitForTimeout(60);
  const early = await page.locator(".dz[data-key=platform].lk").count();
  await page.waitForTimeout(200);
  check("hovering text lights its decision only after the 120ms intent", early === 0 && (await page.locator(".dz[data-key=platform].lk").count()) === 1 && (await ps2.evaluate((e) => e.classList.contains("lk"))));
  const litCite = page.locator(".gut-cite.on").first();
  check("the lit margin cite carries a label with the answer", ((await litCite.textContent()) ?? "").includes("Mobile app"), await litCite.textContent());
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  check("leaving the text clears the link", (await page.locator(".dz.lk, .ps.lk").count()) === 0);
  // Hover a cite: the preview opens after 300ms; Esc closes it; Enter jumps.
  await page.locator("[data-testid=plan] .blk").filter({ has: page.locator(".ps[data-keys~=platform]") }).first().hover();
  await page.locator(".gut-cite", { hasText: "R1·2" }).first().hover();
  await page.getByRole("tooltip").waitFor({ timeout: 2000 });
  check("cite preview shows the question and answer", ((await page.getByRole("tooltip").textContent()) ?? "").includes("Mobile app"));
  await page.locator(".gut-cite", { hasText: "R1·2" }).first().click();
  await page.waitForTimeout(100);
  check("a margin cite moves focus to its decision card", await page.evaluate(() => document.activeElement?.matches(".dz[data-key=platform]")));
  check("focusing a card lights the passages that cite it", (await page.locator("[data-testid=plan] .ps.lk").count()) >= 1 && ((await page.locator(".ps.lk").first().textContent()) ?? "").includes("Mobile app"), (await page.locator("[data-testid=plan] .ps.lk").allTextContents()).join(" | "));
  // v1.1 backlog item 2: each block says who answered and when (meta line, from by: and at:).
  check("decision card says who answered and when", /^(You|You kept the suggestion), [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/.test(((await page.locator(".dz[data-key=platform] .dz-when").textContent()) ?? "").trim()), await page.locator(".dz[data-key=platform] .dz-when").textContent());
  check("card points at its passages (aria-describedby)", !!(await page.locator(".dz[data-key=platform]").getAttribute("aria-describedby")));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const axePlan = await new AxeBuilder({ page }).analyze();
  check("axe: plan view (light)", axePlan.violations.length === 0, axePlan.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
  // Decisions tab (manual activation): arrows move focus, Enter selects.
  await page.getByRole("tab", { name: /Document/ }).focus();
  await page.keyboard.press("ArrowRight");
  check("tabs: arrow keys move focus without switching", (await page.getByRole("tab", { name: /Decisions/ }).getAttribute("aria-selected")) === "false");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Decisions", level: 1 }).waitFor();
  check("Decisions tab lists every answer by round", (await page.locator(".drow").count()) === 3 && (await page.getByRole("heading", { name: "Round 2" }).count()) === 1);
  check("Decisions is a page tab next to Document", (await page.getByRole("tablist").getByRole("tab").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim()).join("|") === "Document|Decisions 3", (await page.getByRole("tablist").getByRole("tab").allTextContents()).join("|"));
  // Roving rows: ↓ moves, Enter shows in plan (checked below via the button).
  await page.locator(".drow").first().focus();
  await page.keyboard.press("ArrowDown");
  check("Decisions rows: arrow keys move between rows", await page.evaluate(() => document.activeElement === document.querySelectorAll(".drow")[1]));
  // The "n resolved" accordion: open when nothing is open, chevron + "Newest first"; collapsing hides the log.
  const accH = page.locator(".acc-h");
  check("'3 resolved' accordion starts open, newest first", (await accH.getAttribute("aria-expanded")) === "true" && ((await accH.textContent()) ?? "").replace(/\s+/g, " ").trim() === "3 resolved Newest first", await accH.textContent());
  await accH.click();
  check("collapsing the accordion hides the rows and names the rounds", (await page.locator("#acc-resolved").isHidden()) && (await accH.getAttribute("aria-expanded")) === "false" && ((await accH.textContent()) ?? "").includes("Rounds 1–2"), await accH.textContent());
  await accH.press("Enter");
  check("Enter on the accordion header opens it again", (await accH.getAttribute("aria-expanded")) === "true" && (await page.locator(".drow").count()) === 3);
  const axeTab = await new AxeBuilder({ page }).analyze();
  check("axe: Decisions tab (light)", axeTab.violations.length === 0, axeTab.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target}`).join(","));
  await page.getByRole("button", { name: "Show in plan: Storage" }).click();
  await page.locator(".dz[data-key=storage][data-fl]").first().waitFor({ timeout: 2000 });
  check("Show in plan returns to the document and highlights the passage", (await page.getByRole("tab", { name: /Document/ }).getAttribute("aria-selected")) === "true");
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
  // The Markdown view is CodeMirror; read and replace its text through the view.
  const rawText = () => page.evaluate(() => document.querySelector("[data-testid=plan-raw] .cm-editor").cmView.state.doc.toString());
  const setRaw = (t) =>
    page.evaluate((t) => {
      const v = document.querySelector("[data-testid=plan-raw] .cm-editor").cmView;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
    }, t);
  const toMode = async (name) => {
    await page.getByRole("radiogroup", { name: "Plan view" }).getByRole("radio", { name }).click();
    if (name === "Markdown") await page.locator("[data-testid=plan-raw][data-ready]").waitFor({ timeout: 10_000 });
    else await page.getByTestId("plan").waitFor();
  };
  const marker = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=plan] ul")).listStyleType);
  check("plan lists show bullets", marker === "disc", marker);
  await toMode("Markdown");
  check("raw view shows plan.md byte for byte, raw [R1:id]s included", (await rawText()) === plan && plan.includes("[R1:platform]"));
  check("raw view is labelled 'plan.md, Markdown source' and says nothing while the text is valid (v1.2 §4)", (await page.getByRole("textbox", { name: "plan.md, Markdown source" }).count()) === 1 && (await page.locator(".ced-status").count()) === 0);
  const axeRaw = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, Markdown view (dark)", axeRaw.violations.length === 0, axeIds(axeRaw));
  // A decision block that doesn't parse gets a line marker and a plain message; rich keeps the last valid card.
  const broken = plan.replace(/(key: platform[\s\S]*?)kept_suggestion: (true|false)/, "$1kept_suggestion: maybe");
  await setRaw(broken);
  await page.locator(".cm-errmsg").waitFor({ timeout: 3000 });
  check("invalid decision block: line marker + plain message in Markdown view", (await page.locator(".cm-errline").count()) === 1 && ((await page.locator(".cm-errmsg").textContent()) ?? "").includes("must be true or false"));
  await toMode("Rich");
  check("invalid decision block: rich view shows the last valid card", (await page.locator(".dz[data-key=platform][data-invalid]").count()) === 1 && ((await page.locator(".dz[data-key=platform] .dz-av").textContent()) ?? "") === "Mobile app");
  await toMode("Markdown");
  await setRaw(plan);
  const diagrams = "\n## Flow\n\n```mermaid\nflowchart TD\n  A[Idea] --> B[Plan]\n```\n\n```mermaid\n---\nconfig:\n  layout: elk\n---\nflowchart LR\n  C[Asks for ELK] --> D[Gets dagre]\n```\n\n```mermaid\nflowchart TD\n  A -->\n```\n";
  const filler = Array.from({ length: 40 }, (_, i) => `\nNote ${i + 1}: a line of filler text so the plan is taller than the window.\n`).join("");
  const typed = plan + diagrams + "\n## Notes\n" + filler;
  await setRaw(typed);
  await shot(page, "plan-editor-markdown-dark");
  check("raw edit autosaves to plan.md", await waitDisk((t) => t === typed));
  await page.getByTestId("save-status").getByText(/^Saved/).waitFor({ timeout: 5000 });
  check("save status says Saved", true);
  // Typing while scrolled down must not jump the page back to the top (steering bug).
  const scrollOf = () => page.evaluate(() => document.querySelector(".docwrap").scrollTop);
  await page.evaluate(() => (document.querySelector(".docwrap").scrollTop = 900));
  await page.waitForTimeout(150);
  const rawBefore = await scrollOf();
  const wrapBox = await page.locator(".docwrap").boundingBox();
  await page.mouse.click(wrapBox.x + wrapBox.width / 2, wrapBox.y + wrapBox.height / 2);
  await page.keyboard.press("End");
  const rawAtClick = await scrollOf();
  await page.keyboard.type("!");
  await page.waitForTimeout(150);
  const rawAfter = await scrollOf();
  check("Markdown view: typing while scrolled down keeps the scroll", rawBefore > 500 && Math.abs(rawAfter - rawAtClick) < 30, `${rawBefore} → ${rawAtClick} → ${rawAfter}`);
  await page.keyboard.press("Backspace");
  check("raw keystrokes save too", await waitDisk((t) => t === typed));
  await toMode("Rich");
  await page.locator(".mmd[data-state=ok] .mmw > svg").first().waitFor({ timeout: 15_000 });
  await page.locator(".mmd").nth(1).scrollIntoViewIfNeeded(); // diagrams draw when they come near the viewport
  await page.locator(".mmd[data-state=ok] .mmw > svg").nth(1).waitFor({ timeout: 15_000 });
  check("valid Mermaid blocks render SVGs (under the app's CSP), ELK requests fall back to dagre", (await page.locator(".mmd[data-state=ok] .mmw > svg").count()) === 2);
  check("diagram figure is named by type and node count, its SVG hidden", /^flowchart diagram, 2 nodes$/.test((await page.locator(".mmd[data-state=ok]").first().getAttribute("aria-label")) ?? "") && (await page.locator(".mmd[data-state=ok] svg").first().getAttribute("aria-hidden")) === "true");
  await page.locator(".mmd[data-state=error]").waitFor({ timeout: 5000 });
  check("invalid Mermaid block shows its error and source", ((await page.locator(".mmd[data-state=error] .err5").textContent()) ?? "").includes("can’t be drawn") && (await page.locator(".mmd[data-state=error] .src5").textContent()).includes("A -->"));
  // Recording bug 3: breaking a diagram while editing autosaves the raw text (plan.md is the source of truth);
  // the live preview keeps the last good render, the rest of the plan is untouched, and fixing it renders again.
  {
    const good = "flowchart TD\n  A[Idea] --> B[Plan]";
    const broken = "flowchart TD\n  A[Idea] --> ";
    await page.locator(".mmd[data-state=ok]").first().hover();
    await page.locator(".mmd[data-state=ok]").first().getByRole("button", { name: "Edit source" }).click();
    const box = page.getByRole("textbox", { name: /Edit block as Markdown/ });
    await box.waitFor();
    await page.locator(".blk-preview .lp5:not(.dim) svg").waitFor({ timeout: 10_000 });
    const src = await box.inputValue();
    await box.fill(src.replace(good, broken));
    await page.locator(".blk-preview .lp5.dim").waitFor({ timeout: 10_000 });
    check("broken diagram while editing: preview keeps the last good render, tagged", (await page.locator(".blk-preview .lp5.dim svg").count()) === 1 && (await page.locator(".blk-preview .lp5 .lbl").textContent()) === "Last version that worked");
    check("broken diagram autosaves as raw text; the rest of plan.md is intact", await waitDisk((t) => t.includes("```mermaid\n" + broken + "\n```") && (t.match(/^```decision$/gm) ?? []).length === 3 && t.includes("Asks for ELK")));
    await box.press("Escape");
    const edited = page.locator("[data-testid=plan] .mmd").first();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=plan] .mmd[data-state=error]").length === 2, null, { timeout: 10_000 }).catch(() => undefined);
    check("after closing, the rich view shows the broken source and its error (no crash)", (await page.locator(".mmd[data-state=error]").count()) === 2 && (await page.locator(".dz").count()) === 3, `${await page.locator(".mmd[data-state=error]").count()} errors, ${await page.locator(".mmd[data-state=ok]").count()} ok, ${await page.locator(".dz").count()} cards, editing=${await page.locator(".blk[data-editing]").count()}`);
    check("the rich view's broken diagram is the edited one, showing its source", (await edited.getAttribute("data-state")) === "error" && ((await edited.locator(".src5").textContent()) ?? "").includes("A[Idea] -->"));
    await edited.hover();
    await edited.getByRole("button", { name: "Edit source" }).click();
    await box.waitFor();
    await box.fill((await box.inputValue()).replace(broken, good));
    await box.press("Escape");
    const fixedOnDisk = await waitDisk((t) => t.includes(good));
    await page.locator(".mmd").nth(1).scrollIntoViewIfNeeded();
    const redrawn = await page.locator(".mmd[data-state=ok] .mmw > svg").nth(1).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    check("fixing the diagram saves and renders it again", fixedOnDisk && redrawn, `on disk ${fixedOnDisk}, redrawn ${redrawn}`);
  }
  await page.locator(".mmd").first().scrollIntoViewIfNeeded();
  await shot(page, "plan-editor-diagrams-dark");
  // The block editor keeps the scroll too.
  const lowPara = page.locator("[data-testid=plan] .blk[data-block=para]", { hasText: "Note 30:" });
  await lowPara.scrollIntoViewIfNeeded();
  await lowPara.click({ position: { x: 4, y: 4 } });
  const lowBox = page.getByRole("textbox", { name: /Edit block as Markdown/ });
  await lowBox.waitFor();
  const blkAtOpen = await scrollOf();
  await lowBox.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  const blkAtCaret = await scrollOf();
  await lowBox.pressSequentially("!");
  await page.waitForTimeout(150);
  const blkAfter = await scrollOf();
  check("block editor: typing while scrolled down keeps the scroll", blkAtOpen > 500 && Math.abs(blkAfter - blkAtCaret) < 30, `${blkAtOpen} → ${blkAtCaret} → ${blkAfter}`);
  await lowBox.press("Backspace");
  await lowBox.press("Escape");
  // Edit one block in place in the rich view.
  const para = page.locator("[data-testid=plan] .blk[data-block=para]").first();
  await para.scrollIntoViewIfNeeded();
  const before = (await para.locator(":scope > :not(.blk-act, .blk-slot)").first().textContent()) ?? "";
  await para.click({ position: { x: 4, y: 4 } });
  const blockBox = page.getByRole("textbox", { name: /Edit block as Markdown/ });
  await blockBox.waitFor();
  await blockBox.press("End");
  await blockBox.pressSequentially(" Edited in place.");
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  await shot(page, "plan-editor-block-edit-dark");
  const axeBlock = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, editing a block (dark)", axeBlock.violations.length === 0, axeIds(axeBlock));
  await blockBox.press("Escape");
  check("Escape closes the block editor", (await blockBox.count()) === 0);
  check("block edit autosaves to plan.md", await waitDisk((t) => t.includes(`${before} Edited in place.`) || t.includes("Edited in place.")));
  const edited = onDisk();
  check("only the edited block changed on disk", edited === typed.replace(`\n${before}\n`, `\n${before} Edited in place.\n`), JSON.stringify(before.slice(0, 40)));
  check("citations and decision blocks survive the edits", ["[R1:scope]", "[R1:platform]", "[R2:storage]", "key: platform"].every((t) => edited.includes(t)));
  // v1.2 §3: every prose block has an "Edit {kind}" button; Tab, Enter, type, Esc puts focus back on it.
  {
    const act = page.locator("[data-testid=plan] .blk[data-block=para] .blk-act").first();
    check("prose blocks carry an 'Edit paragraph: …' button", /^Edit paragraph: /.test((await act.getAttribute("aria-label")) ?? (await act.textContent()) ?? ""), await act.getAttribute("aria-label"));
    check("decision blocks have no Edit button", (await page.locator("[data-testid=plan] .dz .blk-act, [data-testid=plan] .blk:has(.dz) > .blk-act").count()) === 0);
    await act.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    check("Tab reaches the block's Edit button", await act.evaluate((el) => el === document.activeElement));
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement.closest(".blk")).boxShadow);
    check("a focused Edit button highlights its block", ring !== "none", ring);
    await page.keyboard.press("Enter");
    await blockBox.waitFor();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed by keyboard.");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-act"), null, { timeout: 2000 }).catch(() => {});
    check("Esc closes the editor and focus returns to the block's Edit button", (await blockBox.count()) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains("blk-act"))));
    check("the keyboard edit is saved to plan.md", await waitDisk((t) => t.includes("Edited in place. Typed by keyboard.")));
    await page.keyboard.press("Enter");
    await blockBox.waitFor();
    await blockBox.press("Meta+Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("blk-act"), null, { timeout: 2000 }).catch(() => {});
    check("⌘↵ also closes and refocuses the Edit button", (await blockBox.count()) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains("blk-act"))));
  }
  // DECISIONS #22, Markdown view: hand-editing answer: is a Change. Held, dependents named, Cancel restores.
  {
    const keep = onDisk();
    await toMode("Markdown");
    const cur = await rawText();
    const handEdited = cur.replace(/(key: platform\nquestion: [^\n]*\nanswer: )[^\n]*/, "$1Web app, typed by hand");
    await setRaw(handEdited);
    const hold = page.getByTestId("answer-change");
    await hold.waitFor({ timeout: 5000 });
    check("#22 Markdown: a hand-edited answer: warns with the dependents", ((await hold.textContent()) ?? "").includes("Storage"), (await hold.textContent())?.slice(0, 160));
    check("#22 Markdown: the primary is 'Save and re-ask 1'", (await hold.getByRole("button", { name: "Save and re-ask 1" }).count()) === 1);
    await page.waitForTimeout(600);
    check("#22 Markdown: nothing is written while the change is held", onDisk() === keep);
    const axeHold = await new AxeBuilder({ page }).analyze();
    check("axe: answer-change warning (dark)", axeHold.violations.length === 0, axeIds(axeHold));
    await shot(page, "plan-editor-answer-change-dark");
    await hold.getByRole("button", { name: "Cancel" }).click();
    await hold.waitFor({ state: "detached", timeout: 3000 });
    check("#22 Markdown: Cancel puts the old answer back", (await rawText()) === cur);
    await page.waitForTimeout(600);
    check("#22 Markdown: Cancel leaves plan.md unchanged", onDisk() === keep);
    await toMode("Rich");
  }
  const axeDocDark = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor with diagrams (dark)", axeDocDark.violations.length === 0, axeIds(axeDocDark));

  // plan.md changed outside Grillado (Q5): no local edits → reloads by itself.
  const outside = edited.replace("## Flow", "## Flow (edited in vim)");
  writeFileSync(planFile, outside);
  await page.getByRole("heading", { name: "Flow (edited in vim)" }).waitFor({ timeout: 5000 });
  check("outside edit reloads plan.md automatically when nothing is unsaved", (await page.getByText("plan.md changed outside Grillado").count()) === 0);
  check("reload is announced politely", await page.getByRole("status").filter({ hasText: "Reloaded plan.md" }).count().then((n) => n === 1));
  // Both sides changed: hold the save, write the file, and the banner asks.
  await page.route("**/plan", (r) => (r.request().method() === "POST" ? new Promise(() => {}) : r.continue()));
  const flowPara = page.locator("[data-testid=plan] .blk[data-block=para]").first();
  await flowPara.click({ position: { x: 4, y: 4 } });
  await blockBox.waitFor();
  await blockBox.press("End");
  await blockBox.pressSequentially(" Mine.");
  await blockBox.press("Escape");
  const theirs = outside.replace("## Notes", "## Notes (theirs)");
  writeFileSync(planFile, theirs);
  const conflict = page.getByRole("alert").filter({ hasText: "plan.md changed outside Grillado" });
  await conflict.waitFor({ timeout: 5000 });
  check("both sides changed: banner asks which to keep", (await conflict.getByRole("button", { name: "Keep mine" }).count()) === 1 && (await conflict.getByRole("button", { name: "Load the file" }).count()) === 1);
  const axeConflict = await new AxeBuilder({ page }).analyze();
  check("axe: conflict banner (dark)", axeConflict.violations.length === 0, axeIds(axeConflict));
  await shot(page, "plan-editor-conflict-dark");
  await page.unroute("**/plan");
  await conflict.getByRole("button", { name: "Keep mine" }).click();
  const conflictFile = path.join(path.dirname(planFile), "plan.conflict.md");
  check("Keep mine: my version saved, theirs kept as plan.conflict.md", (await waitDisk((t) => t.includes(" Mine.") && !t.includes("(theirs)"))) && existsSync(conflictFile) && readFileSync(conflictFile, "utf8") === theirs);
  // Put the earlier edit back so the restart check below sees it.
  const mine = onDisk();
  await toMode("Markdown");
  await setRaw(mine.replace(" Mine.", ""));
  check("back to the edited plan", await waitDisk((t) => t === outside));
  await toMode("Rich");

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Light theme" }).click();
  await page.locator(".mmd[data-state=ok] .mmw > svg").first().waitFor();
  await page.waitForTimeout(400);
  const axeDocLight = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor with diagrams (light)", axeDocLight.violations.length === 0, axeIds(axeDocLight));
  await page.locator(".mmd").first().scrollIntoViewIfNeeded();
  await shot(page, "plan-editor-diagrams-light");
  await toMode("Markdown");
  const axeRawLight = await new AxeBuilder({ page }).analyze();
  check("axe: plan editor, Markdown view (light)", axeRawLight.violations.length === 0, axeIds(axeRawLight));
  await shot(page, "plan-editor-markdown-light");
  await toMode("Rich");
  await page.reload();
  await page.getByTestId("plan").waitFor();
  check("edits survive a reload", ((await page.getByTestId("plan").textContent()) ?? "").includes("Edited in place."));
  check("save status still says Saved after a reload", /^Saved/.test((await page.getByTestId("save-status").textContent()) ?? ""));
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
  await page.getByRole("heading", { name: "Grillado stopped" }).waitFor({ timeout: 10_000 });
  check("tab shows 'stopped' state", true);

  // Plan edits survive a restart (v1.1 acceptance): new process, same data dir.
  const sessionPath = `/s/${sessionId}`;
  const again = startServer(["--no-open"], e);
  const { url: url2, port: port2 } = await again.url;
  await page.goto(url2);
  await page.goto(`http://127.0.0.1:${port2}${sessionPath}`);
  await page.getByTestId("plan").waitFor({ timeout: 10_000 });
  await page.locator(".mmd").nth(1).scrollIntoViewIfNeeded().catch(() => {});
  await page.locator(".mmd[data-state=ok]").nth(1).waitFor({ timeout: 15_000 }).catch(() => {});
  const restored = (await page.getByTestId("plan").textContent()) ?? "";
  check("plan edits survive a restart", restored.includes("Edited in place.") && (await page.locator(".mmd[data-state=ok]").count()) === 2, restored.slice(0, 80));
  // Recording bugs on PR #2 @ba19865, with real pointer clicks (no scripted events).
  {
    const scope = page.locator(".dz[data-key=scope]");
    const storage = page.locator(".dz[data-key=storage]");
    // Bug 2: after Cancel on one card, the first click on another card's Change must open it.
    await scope.scrollIntoViewIfNeeded();
    await scope.hover();
    await scope.getByRole("button", { name: /^Change/ }).click();
    await scope.getByRole("radiogroup").waitFor();
    await scope.getByRole("button", { name: "Cancel" }).click();
    await storage.hover();
    await storage.getByRole("button", { name: /^Change/ }).click();
    const opened = await storage
      .getByRole("radiogroup")
      .waitFor({ timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    check("after Cancel on one card, one click on another card's Change opens it", opened);
    if (opened) await storage.getByRole("button", { name: "Cancel" }).click();
    else await page.keyboard.press("Escape");
    // Same with a keyboard cancel (Escape keeps the card focused in keyboard mode), then a mouse click.
    await scope.hover();
    await scope.getByRole("button", { name: /^Change/ }).click();
    await scope.getByRole("radiogroup").waitFor();
    await page.keyboard.press("Escape");
    await scope.getByRole("radiogroup").waitFor({ state: "detached" });
    await storage.hover();
    await storage.getByRole("button", { name: /^Change/ }).click();
    const opened2 = await storage.getByRole("radiogroup").waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
    check("after Escape on one card, one mouse click on another card's Change opens it", opened2);
    if (opened2) await storage.getByRole("button", { name: "Cancel" }).click();
    else await page.keyboard.press("Escape");

    // Bug 1: "Save answer" (no dependents) updates the note and the cited bullet, and the status shows the save.
    const oldAnswer = ((await scope.locator(".dz-av").textContent()) ?? "").trim();
    await page.evaluate(() => {
      window.__saveStates = [];
      const el = document.querySelector("[data-testid=save-status]");
      new MutationObserver(() => window.__saveStates.push(`${el.getAttribute("data-save")}:${el.textContent}`)).observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
    });
    await scope.hover();
    await scope.getByRole("button", { name: /^Change/ }).click();
    const pick = scope.locator(".dz-opt[aria-checked=false]").first();
    const newAnswer = ((await pick.locator(".lb > span").first().textContent()) ?? "").trim();
    await pick.click();
    await scope.getByRole("button", { name: "Save answer" }).click();
    await scope.locator(".dz-opts").waitFor({ state: "detached" });
    await page.waitForFunction((a) => document.querySelector(".dz[data-key=scope] .dz-av")?.textContent?.trim() === a, newAnswer);
    const note = (await scope.locator(".dz-n").first().textContent().catch(() => "")) ?? "";
    const bullets = await page.locator("[data-testid=plan] li .ps").allInnerTexts();
    const disk = readFileSync(planFile, "utf8");
    check("Save answer: the card's note no longer states the old answer", !note.includes(oldAnswer) && (note === "" || note.includes(newAnswer)), `${oldAnswer} -> ${newAnswer}: ${note}`);
    check("Save answer: the bullet citing the decision says the new answer", bullets.some((b) => b.startsWith(newAnswer)) && !bullets.some((b) => b.startsWith(oldAnswer)), bullets.join(" | "));
    check("Save answer: plan.md prose follows the new answer", disk.includes(`- ${newAnswer} [R1:scope]`) && !disk.includes(`- ${oldAnswer} [R1:scope]`));
    const states = await page.evaluate(() => window.__saveStates);
    const status = (await page.getByTestId("save-status").textContent()) ?? "";
    check("Save answer: the status shows Saving… then Saved", states.some((x) => x.startsWith("saving:Saving")) && !states.slice(states.findIndex((x) => x.startsWith("saving"))).some((x) => x.startsWith("idle")) && /^Saved/.test(status), `${states.join(" > ")} | ${status}`);
  }
  // Change a decision inline (Q2): works like Reopen for what depends on it.
  {
    const card = page.locator(".dz[data-key=platform]");
    await card.focus();
    await page.keyboard.press("Enter");
    await card.getByRole("radiogroup").waitFor();
    const opts = card.locator(".dz-opt");
    const labels = await opts.allTextContents();
    check("Change shows the options with Current and Recommended tags", labels.some((l) => l.includes("Current")) && labels.some((l) => l.includes("Recommended")), labels.join(" | "));
    const pickIdx = (await opts.evaluateAll((els) => els.findIndex((e, i) => i < els.length - 1 && e.getAttribute("aria-checked") === "false"))) + 1;
    await page.keyboard.press(String(pickIdx));
    check("picking a new answer warns which dependents will be re-asked", ((await card.locator(".dz-warn").textContent()) ?? "").includes("Storage"));
    check("the primary becomes 'Save and re-ask 1'", (await card.getByRole("button", { name: "Save and re-ask 1" }).count()) === 1);
    // The Save button turns primary with a short colour transition; let it finish so axe reads the settled colours.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const axeChange = await new AxeBuilder({ page }).analyze();
    check("axe: changing a decision (dark)", axeChange.violations.length === 0, axeIds(axeChange));
    await shot(page, "plan-editor-change-dark");
    const diskBeforeCancel = readFileSync(planFile, "utf8");
    await page.keyboard.press("Escape");
    check("#22 block editor: Cancel leaves the block and plan.md unchanged", readFileSync(planFile, "utf8") === diskBeforeCancel && (await card.locator(".dz-warn").count()) === 0);
    check("Esc cancels and puts focus back on the card", (await card.locator(".dz-opts").count()) === 0 && (await page.evaluate(() => document.activeElement?.matches(".dz[data-key=platform]"))));
    await page.keyboard.press("Enter");
    await page.keyboard.press(String(pickIdx));
    const newAnswer = ((await card.locator(".dz-opt").nth(pickIdx - 1).locator("span").first().textContent()) ?? "").trim();
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=question]").getByText("Keep data local first?").waitFor({ timeout: 15_000 });
    const planFile2 = path.join(e.GRILLADO_HOME, "sessions", sessionId, "plan.md");
    const after = readFileSync(planFile2, "utf8");
    const sess = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json"), "utf8"));
    check("saving the change updates the block in plan.md", after.includes(`key: platform\nquestion: Start on the web?\nanswer: ${newAnswer}`), newAnswer);
    check("its dependents are re-asked in a new round", ["answering", "asking"].includes(sess.status) && sess.stale?.storage && !sess.decisions.storage && sess.rounds.at(-1).questions.some((q) => q.key === "storage"), JSON.stringify({ status: sess.status, stale: sess.stale, storage: sess.decisions.storage, questions: sess.rounds.at(-1).questions.map((q) => q.key) }));
    await page.locator("[data-testid=question] legend").first().focus();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Yes, plate it" }).click();
    await page.getByTestId("plan").waitFor({ timeout: 15_000 });
    const replated = readFileSync(planFile2, "utf8");
    check("the next plan carries the changed answer; the edited plan is kept beside it", replated.includes(`answer: ${newAnswer}`) && readdirSync(path.dirname(planFile2)).some((f) => f.startsWith("plan.edited-")));
    // Mobile: plan view and Decisions tab, light and dark; "Load the file" side of the conflict.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ["Light theme", "Dark theme"]) {
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: theme }).click();
      await page.waitForTimeout(300);
      const tag = theme.startsWith("Light") ? "light" : "dark";
      const axeM = await new AxeBuilder({ page }).analyze();
      check(`axe: plan view (mobile, ${tag})`, axeM.violations.length === 0, axeIds(axeM));
      await shot(page, `plan-m-${tag}`);
      await page.getByRole("tab", { name: /Decisions/ }).click();
      await page.getByRole("heading", { name: "Decisions", level: 1 }).waitFor();
      const axeMT = await new AxeBuilder({ page }).analyze();
      check(`axe: Decisions tab (mobile, ${tag})`, axeMT.violations.length === 0, axeIds(axeMT));
      await shot(page, `decisions-m-${tag}`);
      await page.getByRole("tab", { name: /Document/ }).click();
    }
    await page.route("**/plan", (r) => (r.request().method() === "POST" ? new Promise(() => {}) : r.continue()));
    const p0 = page.locator("[data-testid=plan] .blk[data-block=para]").first();
    await p0.click({ position: { x: 4, y: 4 } });
    const box2 = page.getByRole("textbox", { name: /Edit block as Markdown/ });
    await box2.waitFor();
    await box2.press("End");
    await box2.pressSequentially(" Mine again.");
    await box2.press("Escape");
    const fileSide = readFileSync(planFile2, "utf8").replace("## Problem", "## Problem (from the file)");
    writeFileSync(planFile2, fileSide);
    const banner2 = page.getByRole("alert").filter({ hasText: "plan.md changed outside Grillado" });
    await banner2.waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    const axeMC = await new AxeBuilder({ page }).analyze();
    check("axe: conflict banner (mobile, dark)", axeMC.violations.length === 0, axeIds(axeMC));
    await shot(page, "conflict-m-dark");
    await page.unroute("**/plan");
    await banner2.getByRole("button", { name: "Load the file" }).click();
    await page.getByRole("heading", { name: "Problem (from the file)" }).waitFor({ timeout: 5000 });
    const cf2 = path.join(path.dirname(planFile2), "plan.conflict.md");
    check("Load the file: the file wins, my edits are kept as plan.conflict.md", readFileSync(planFile2, "utf8") === fileSide && readFileSync(cf2, "utf8").includes(" Mine again.") && (await banner2.count()) === 0);
    await page.setViewportSize({ width: 1280, height: 720 });
    // DECISIONS #22, Markdown view, save side: "Save and re-ask 1" runs the same path as the card's Change.
    await toMode("Markdown");
    const md22 = await rawText();
    await setRaw(md22.replace(/(key: platform\nquestion: [^\n]*\nanswer: )[^\n]*/, "$1Mobile app"));
    const hold2 = page.getByTestId("answer-change");
    await hold2.waitFor({ timeout: 5000 });
    check("#22 Markdown: the warning names the old and new answer", ((await hold2.textContent()) ?? "").includes(`${newAnswer} → Mobile app`), (await hold2.textContent())?.slice(0, 160));
    await hold2.getByRole("button", { name: "Save and re-ask 1" }).click();
    await page.getByText("Keep data local first?").waitFor({ timeout: 15_000 });
    // The page can show the round before plan.md and session.json are both on disk: read them again
    // until both agree, for up to 5 s (Designer, review-pr29 r2: a one-shot read here was flaky).
    const read22 = () => {
      const s = JSON.parse(readFileSync(path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json"), "utf8"));
      const md = readFileSync(planFile2, "utf8");
      return Boolean(md.includes("key: platform\nquestion: Start on the web?\nanswer: Mobile app") && s.stale?.storage && !s.decisions.storage && s.rounds.at(-1).questions.some((q) => q.key === "storage"));
    };
    let ok22 = false;
    for (const end = Date.now() + 5000; !(ok22 = (() => { try { return read22(); } catch { return false; } })()) && Date.now() < end; ) await page.waitForTimeout(100);
    check("#22 Markdown: saving writes the answer and re-asks the dependents in a new round", ok22);

    // DECISIONS #26: `answer:` edited outside Grillado is a Change. Notice in place, nothing reruns until confirmed.
    const sessFile = path.join(e.GRILLADO_HOME, "sessions", sessionId, "session.json");
    const readSess = () => JSON.parse(readFileSync(sessFile, "utf8"));
    const replate = async () => {
      await page.locator("[data-testid=question] legend").first().focus();
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Yes, plate it" }).click();
      await page.getByTestId("plan").waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => !document.querySelector(".dz[data-state=stale]"), null, { timeout: 15_000 });
    };
    await replate();
    if ((await page.getByTestId("plan-raw").count()) > 0) await toMode("Rich");
    const setFileAnswer = (to) => {
      const md = readFileSync(planFile2, "utf8").replace(/(key: platform\nquestion: [^\n]*\nanswer: )[^\n]*/, `$1${to}`);
      writeFileSync(planFile2, md);
    };
    const roundsBefore = readSess().rounds.length;
    setFileAnswer("  mobile   APP ");
    await page.waitForTimeout(1500);
    check("#26 a whitespace/casing-only edit of answer: is ignored", (await page.locator(".fb.ext").count()) === 0 && readSess().rounds.length === roundsBefore && readSess().status === "plated" && !readSess().plan?.external?.length);
    setFileAnswer("Web app");
    const ext = page.locator(".dz[data-key=platform] .fb.ext");
    await ext.waitFor({ timeout: 5000 });
    const extText = ((await ext.textContent()) ?? "").replace(/\s+/g, " ");
    check("#26 an external edit shows a one-sentence notice under the decision, naming the dependents", extText.includes("Web app") && extText.includes("Storage") && (await page.locator(".pbanner").count()) === 0, extText);
    check("#26 nothing reruns until confirmed", readSess().rounds.length === roundsBefore && readSess().status === "plated");
    const axe26 = await new AxeBuilder({ page }).analyze();
    check("axe: external-edit notice", axe26.violations.length === 0, axeIds(axe26));
    await shot(page, "external-edit-notice");
    await ext.getByRole("button", { name: "Not now" }).click();
    const staleCard = page.locator(".dz[data-key=storage][data-state=stale]");
    await staleCard.waitFor({ timeout: 5000 });
    const sDis = readSess();
    check("#26 dismissing keeps the new answer and marks the dependents stale, no rerun", sDis.decisions.platform?.answer === "Web app" && sDis.stale?.storage && sDis.rounds.length === roundsBefore && sDis.status === "plated" && (await staleCard.getByRole("button", { name: /^Re-ask/ }).count()) === 1);
    await staleCard.getByRole("button", { name: /^Re-ask/ }).click();
    await page.locator("[data-testid=question]").getByText("Keep data local first?").first().waitFor({ timeout: 15_000 });
    check("#26 Re-ask on a stale dependent asks it again", readSess().rounds.length === roundsBefore + 1 && readSess().rounds.at(-1).questions.some((q) => q.key === "storage"));
    await replate();
    const roundsB = readSess().rounds.length;
    setFileAnswer("Mobile app");
    await ext.waitFor({ timeout: 5000 });
    await ext.getByRole("button", { name: /^Re-ask/ }).click();
    await page.locator("[data-testid=question]").getByText("Keep data local first?").first().waitFor({ timeout: 15_000 });
    const sCon = readSess();
    check("#26 confirming re-asks the dependents", sCon.decisions.platform?.answer === "Mobile app" && sCon.rounds.length === roundsB + 1 && sCon.rounds.at(-1).questions.some((q) => q.key === "storage") && !sCon.decisions.storage);
  }
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
    check("auth error shown as 'Log in to …' (AC8)", (await banner.getAttribute("data-code")) === "auth" && /log in to Claude Code/i.test(await banner.textContent()) && (await banner.locator(".t").count()) === 0);
    await pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await shot(pg, "auth-error");
    check("auth banner offers retry", (await pg.getByRole("button", { name: "I’ve logged in, retry" }).count()) === 1);
    const authBody = banner.locator("p").first();
    check("auth banner is one sentence, no title, agent name templated (item 2 leftover 1)", ((await authBody.textContent()) ?? "").replace(/\s+/g, " ").trim() === "To keep going, log in to Claude Code: run claude in a terminal and use /login, then come back (your answers are saved)." && (await authBody.locator("code").textContent()) === "claude", await authBody.textContent());
    const inlCopy = authBody.getByRole("button", { name: "Copy claude" });
    const icon = await inlCopy.locator("svg").boundingBox();
    check("the inline copy button has a 14px icon", icon && Math.round(icon.width) === 14, JSON.stringify(icon));
    const axeErr = await new AxeBuilder({ page: pg }).analyze();
    check("axe: error state", axeErr.violations.length === 0, axeErr.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message?.slice(0, 120) ?? ""}`).join(","));
    await ctx.close();
    const r = await stop(s3, "SIGINT");
    check("SIGINT (idle) exits 0", r.code === 0, `${r.ms} ms`);
  }

  // ---------------------------------------------------------------- long run: heat goes down; no passivity nudge (#34); the cap at --max-rounds 6 (#33)
  {
    const e5 = env(fakeBins(["claude"]), { FAKE_MODE: "long" });
    const s5 = startServer(["--no-open", "--max-rounds", "6"], e5);
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
      nudges.push((await pg.getByTestId("nudge").count()) + (await pg.getByText("kept every suggestion").count()) + (await pg.getByRole("button", { name: "Looks right" }).count()));
      await pg.keyboard.press("Enter"); // keep every suggestion and send
      if (i < titles.length - 1) await pg.getByText(t).first().waitFor({ state: "detached", timeout: 15_000 });
    }
    check("heat meter goes down when a round opens many decisions", heat[1] === 3 && heat[2] === 2, heat.join(" → "));
    check("#34: no passivity nudge after 4 (or 5) all-accept rounds", nudges.every((n) => n === 0), nudges.join(","));
    await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15_000 });
    const st5 = await pg.getByTestId("round-status").textContent();
    check("#33: the cap's status line under the title (--max-rounds 6)", st5 === "Round 6 of 6 is done.", st5);
    check("#33: Keep going is gone at the cap", (await pg.getByRole("button", { name: "Keep going on a branch" }).count()) === 0);
    const s5json = JSON.parse(readFileSync(path.join(e5.GRILLADO_HOME, "sessions", readdirSync(path.join(e5.GRILLADO_HOME, "sessions"))[0], "session.json"), "utf8"));
    check("#33: six saved rounds, stopped by the cap", s5json.rounds.length === 6 && s5json.stop === "cap", `${s5json.rounds.length} ${s5json.stop}`);
    // Reopen at the cap is a repair: its re-ask round runs, doesn't count, and Confirm reads the same line again (review of #42).
    await pg.getByRole("button", { name: "Reopen Launch" }).click();
    await pg.getByRole("alertdialog", { name: "Reopen “Launch”?" }).getByRole("button", { name: "Reopen" }).click();
    await pg.getByText("Launch to friends first?").first().waitFor({ timeout: 15_000 });
    const rcRe = await pg.getByTestId("round-counter").textContent();
    check("ROUNDS-REASK: a re-ask at the cap reads Round 6 of 6 · asking again", rcRe === "Round 6 of 6 · asking again", rcRe);
    const subRe = await pg.locator(".intro p:not(.rmeta)").first().textContent();
    check("REASK-SUB: a re-ask round's sub line", (subRe ?? "").startsWith("You reopened these, or something they depend on changed. Suggested picks"), subRe);
    check("#39: no Send and wrap up on a re-ask at the cap", (await pg.getByRole("button", { name: "Send and wrap up" }).count()) === 0);
    await pg.keyboard.press("Enter");
    await pg.getByRole("heading", { name: "Is it done?" }).waitFor({ timeout: 15_000 });
    await pg.getByTestId("round-status").waitFor({ timeout: 15_000 });
    const st5b = await pg.getByTestId("round-status").textContent();
    check("#33: after a re-ask at the cap, Confirm still reads round 6 of 6", st5b === "Round 6 of 6 is done.", st5b);
    const s5b = JSON.parse(readFileSync(path.join(e5.GRILLADO_HOME, "sessions", readdirSync(path.join(e5.GRILLADO_HOME, "sessions"))[0], "session.json"), "utf8"));
    check("#33: the re-ask round is saved with reask and isn't counted", s5b.rounds.length === 7 && s5b.rounds[6].reask === true && s5b.rounds.filter((r) => !r.reask).length === 6, s5b.rounds.map((r) => !!r.reask).join(","));
    await ctx.close();
    await stop(s5, "SIGINT");
  }

  // ---------------------------------------------------------------- mobile: Send and wrap up, Wrap it up in ⋯, early confirm lists Still open first
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
    // PR45 N4: the phone strip stacks the heat word over the bar; at 320 the longest pair stays on one line each, 40px tall.
    await pg.setViewportSize({ width: 320, height: 700 });
    const strip = await pg.locator(".mstrip").evaluate((el) => {
      // Rows the visible text takes (the screen-reader prefix and the chevron aside).
      const lines = (node) => {
        const tops = new Set();
        const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          if (t.parentElement.closest(".sr-only") || !t.nodeValue.trim()) continue;
          const r = document.createRange();
          r.selectNodeContents(t);
          for (const x of r.getClientRects()) tops.add(Math.round(x.top));
        }
        return tops.size;
      };
      const measure = (s) => ({ h: Math.round(s.getBoundingClientRect().height), lv: lines(s.querySelector(".lv")), c: lines(s.querySelector(".c")), over: s.scrollWidth > s.clientWidth });
      const real = measure(el);
      // A copy with the longest pair the strip can show, so React's own nodes stay untouched.
      const copy = el.cloneNode(true);
      copy.querySelector(".lv").textContent = "Ready to confirm";
      const c = copy.querySelector(".c");
      for (const n of [...c.childNodes]) if (n.nodeType === 3) n.remove();
      c.insertBefore(document.createTextNode("12 settled · 14 open"), c.querySelector("svg"));
      el.after(copy);
      const long = measure(copy);
      copy.remove();
      return { real, long };
    });
    check("N4: the phone strip at 320 is 40px, one line each, no overflow", [strip.real, strip.long].every((m) => m.h === 40 && m.lv === 1 && m.c === 1 && !m.over), JSON.stringify(strip));
    await pg.setViewportSize({ width: 390, height: 844 });
    // #39: Send and wrap up takes Wrap it up's slot on rounds 1 to N−1; bare Wrap it up is in ⋯ (#38).
    const sendWrap = pg.locator(".bar").getByRole("button", { name: "Send and wrap up", exact: true });
    check("#38: no bare Wrap it up in the round bar", (await pg.locator(".bar").getByRole("button", { name: "Wrap it up" }).count()) === 0);
    const [wb, sb] = [await sendWrap.boundingBox(), await pg.getByRole("button", { name: "Send round" }).boundingBox()];
    check("#39: mobile Send and wrap up on round 1, quiet, 44px, left of Send round on one line", wb && sb && wb.x + wb.width <= sb.x && Math.round(wb.height) === 44 && Math.abs(wb.y - sb.y) < 1 && !(await sendWrap.evaluate((b) => b.classList.contains("primary"))), JSON.stringify([wb, sb]));
    await pg.getByRole("button", { name: "Send round" }).click();
    await pg.getByText("Start with the capture flow?").waitFor({ timeout: 15_000 });
    check("#39: Send and wrap up is hidden on round N", (await sendWrap.count()) === 0);
    await pg.getByRole("button", { name: "More" }).click();
    await pg.getByRole("menuitem", { name: "Wrap it up" }).click();
    const earlyTitle = pg.getByRole("heading", { level: 1, name: /^Wrap up with \d+ still open\?$/ });
    await earlyTitle.waitFor({ timeout: 15_000 });
    check("early confirm title is 'Wrap up with n still open?' (Victor, v1.2 review)", /^Wrap up with \d+ still open\?$/.test(((await earlyTitle.textContent()) ?? "").trim()), await earlyTitle.textContent());
    const confirmOpen = Number(/(\d+) still open/.exec((await earlyTitle.textContent()) ?? "")?.[1]);
    const confirmLine = /\d+ decisions? settled, \d+ still open/.exec((await pg.getByText(/decisions? settled, \d+ still open/).first().textContent()) ?? "")?.[0] ?? "";
    check("early confirm: the counts read 'n decisions settled, k still open'", confirmLine.endsWith(` ${confirmOpen} still open`), confirmLine);
    const confirmSettled = Number(/^(\d+)/.exec(confirmLine)?.[1]);
    const sideSub = ((await pg.getByTestId("side-sub").first().textContent()) ?? "").trim();
    check("early confirm: the Decisions panel count matches the title", sideSub === `${confirmSettled} settled · ${confirmOpen} open`, `${sideSub} vs ${confirmLine}`);
    check("early confirm has no kicker above the title (C6)", (await pg.getByText(/Wrapping up early|Nothing left open/).count()) === 0);
    const wrapSt = ((await pg.getByTestId("round-status").textContent()) ?? "").trim();
    check("#38: a wrap on round N lands on the cap Confirm", wrapSt === "Round 2 of 2 is done." && (await pg.getByRole("button", { name: "Ask 1 more round" }).count()) === 1 && (await pg.getByRole("button", { name: /Keep going/ }).count()) === 0, wrapSt);
    check("early confirm lists Still open first", (await pg.locator(".dl h2").first().textContent()) === "Still open", await pg.locator(".dl h2").allTextContents().then((t) => t.join(",")));
    const axeM = await new AxeBuilder({ page: pg }).analyze();
    check("axe: early confirm (mobile)", axeM.violations.length === 0, axeM.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target}`).join(","));
    // Plated with open decisions (v1.2 §5 e-early): they lead the document, Answer is quiet, Copy stays the one blue.
    await pg.setViewportSize({ width: 1280, height: 800 });
    await pg.getByRole("button", { name: /Yes, plate it/ }).click();
    await pg.getByTestId("plan").waitFor({ timeout: 15_000 });
    const firstH2 = await pg.locator("[data-testid=plan] h2").first().textContent();
    check("plan with open decisions: 'Open decisions' is the first section", (firstH2 ?? "").startsWith("Open decisions"), firstH2);
    const firstCard = pg.locator("[data-testid=plan] .dz").first();
    check("plan with open decisions: the first card in the document is an open one", (await firstCard.getAttribute("data-state")) === "open");
    const answerBtn = firstCard.getByRole("button", { name: "Answer" });
    check("open decisions start collapsed with a quiet 'Answer' button", (await answerBtn.count()) === 1 && !(await answerBtn.evaluate((b) => b.classList.contains("primary"))) && (await pg.locator(".planv .dz .btn.primary").count()) === 0);
    const blue = await pg.getByRole("button", { name: "Answer remaining questions" }).evaluate((b) => getComputedStyle(b).backgroundColor);
    const copyBg = await pg.locator(".copy-md").evaluate((b) => getComputedStyle(b).backgroundColor);
    const primaryBg = await pg.evaluate(() => {
      const el = document.createElement("span");
      el.style.background = "var(--primary)";
      document.body.append(el);
      const c = getComputedStyle(el).backgroundColor;
      el.remove();
      return c;
    });
    check("answering the open decisions is primary and Copy is quiet", blue === primaryBg && copyBg !== primaryBg, `${blue} vs ${primaryBg}`);
    const openN = await pg.locator("[data-testid=plan] .dz[data-state=open]").count();
    const status = ((await pg.getByTestId("save-status").textContent()) ?? "").trim();
    check("save status reads 'Saved · n open'", status === `Saved · ${openN} open`, status);
    // Item 2 handoff §4: one source for every count. Confirm, plan meta, tab and the Open heading agree.
    const total = confirmSettled + confirmOpen;
    const tabTxt = ((await pg.getByRole("tab", { name: /Decisions/ }).textContent()) ?? "").replace(/\s+/g, " ").trim();
    const metaTxt = ((await pg.getByTestId("plan-meta").textContent()) ?? "").trim();
    const openH = ((await pg.locator("[data-testid=plan] h2").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
    check(
      "counts agree: confirm, plan meta, tab, Open heading and status",
      openN === confirmOpen && tabTxt === `Decisions ${total} · ${confirmOpen} open` && metaTxt.endsWith(`${total} decisions · ${confirmOpen} open`) && openH === `Open decisions ${confirmOpen}`,
      `${confirmLine} | ${tabTxt} | ${metaTxt} | ${openH} | ${status}`,
    );
    const axeE = await new AxeBuilder({ page: pg }).analyze();
    check("axe: plan with open decisions (light)", axeE.violations.length === 0, axeE.violations.map((v) => `${v.id}:${v.nodes.length}@${v.nodes[0]?.target}`).join(","));
    await answerBtn.click();
    check("Answer opens the options in place", (await firstCard.getByRole("radiogroup").count()) === 1);
    // Decisions tab with open decisions: "Still open" first, the resolved log collapsed (v1.1 frame d-tab-early).
    await pg.getByRole("tab", { name: /Decisions/ }).click();
    await pg.getByRole("heading", { name: "Decisions", level: 1 }).waitFor();
    const accE = pg.locator(".acc-h");
    check("with open decisions the Decisions tab shows Open first and the resolved log collapsed", (await pg.locator(".dtab h2").first().textContent())?.startsWith("Open") && (await accE.getAttribute("aria-expanded")) === "false" && (await pg.locator("#acc-resolved").isHidden()), `${await pg.locator(".dtab h2").first().textContent()} | ${await accE.textContent()}`);
    const axeD = await new AxeBuilder({ page: pg }).analyze();
    check("axe: Decisions tab with open decisions, resolved collapsed (mobile)", axeD.violations.length === 0, axeIds(axeD));
    await ctx.close();
    await stop(s6, "SIGINT");
  }

  // A saved plan can finish topics that were never asked, even after the extra round was used.
  {
    const e7 = env(fakeBins(["claude"]), { FAKE_MODE: "long" });
    const s7 = startServer(["--no-open", "--max-rounds", "2"], e7);
    const { url: u7 } = await s7.url;
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    const pg = await ctx.newPage();
    await pg.goto(u7);
    await pg.getByRole("textbox", { name: "What are you planning?" }).fill("A shared household list");
    await pg.keyboard.press("Enter");
    await pg.getByRole("button", { name: "Send round", exact: true }).click();
    await pg.getByText("Start with the capture flow?").waitFor();
    await pg.getByRole("button", { name: "Send round", exact: true }).click();
    await pg.getByRole("button", { name: "Ask 1 more round" }).click();
    await pg.getByText("Include search in v1?").waitFor();
    await pg.getByRole("button", { name: "Send round", exact: true }).click();
    await pg.getByRole("button", { name: "Yes, plate it" }).click();
    await pg.getByTestId("plan").waitFor();
    const resume = pg.getByRole("button", { name: "Answer remaining questions" });
    check("a plan with never-asked topics has a visible answer action", await resume.isVisible());
    await shot(pg, "plan-unasked-desktop");
    await pg.getByRole("tab", { name: /Decisions/ }).click();
    const pending = pg.getByRole("region", { name: "Not asked yet" });
    check("Decisions lists the never-asked Sync topic", await pending.getByText("Sync", { exact: true }).isVisible());
    check("resolved answers stay collapsed while an unasked topic is open", await pg.locator(".acc-h").getAttribute("aria-expanded") === "false");
    const desktopAxe = await new AxeBuilder({ page: pg }).analyze();
    check("axe: never-asked decisions (desktop)", desktopAxe.violations.length === 0, axeIds(desktopAxe));
    await pg.setViewportSize({ width: 320, height: 700 });
    const hit = await resume.boundingBox();
    check("the answer action fits a 320px phone", hit && hit.x >= 0 && hit.x + hit.width <= 320 && hit.height >= 44, JSON.stringify(hit));
    await shot(pg, "plan-unasked-mobile");
    const phoneAxe = await new AxeBuilder({ page: pg }).analyze();
    check("axe: never-asked decisions (phone)", phoneAxe.violations.length === 0, axeIds(phoneAxe));
    await resume.click();
    await pg.getByText("Sync across devices?").waitFor({ timeout: 15_000 });
    check("the answer action asks the pending topic past the used extra round", await pg.getByTestId("question").count() === 1);
    check("resumed questions say they are finishing the saved plan", await pg.getByTestId("round-counter").textContent() === "Finishing your plan");
    await pg.getByRole("button", { name: "Send round", exact: true }).click();
    await pg.getByRole("button", { name: "Yes, plate it" }).click();
    await pg.getByTestId("plan").waitFor();
    check("the updated plan has no open decisions", !((await pg.getByRole("tab", { name: /Decisions/ }).textContent()) ?? "").includes("open") && await resume.count() === 0);
    await pg.getByRole("button", { name: "Plan actions" }).click();
    check("issue creation becomes available after the remaining question is answered", await pg.getByRole("menuitem", { name: "Create issues…" }).isEnabled());
    await ctx.close();
    await stop(s7);
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
