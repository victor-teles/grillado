// v1.3 item 2 end-to-end: "Send to issues" (HANDOFF-ENGINEER-item2 §1–§9). The ⋯ item, the sheet
// (destination, labels, preview, approval card), nothing written before the confirm, a partial run and
// Retry failed, the strip and the decision chips, an update with an issue edited in GitHub and one
// deleted, gh fix-its, Linear connect/bad key/disconnect, phones at 390 and 320, both themes, axe.
// Never talks to GitHub or Linear: a fake gh (test/fixtures/fake-gh.mjs) and a local Linear mock.
// One server and one browser at a time; only processes started here are killed.
//   node e2e/issues.mjs                 checks only
//   SHOTS=dir node e2e/issues.mjs       also writes the frames to dir
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = realpathSync(path.join(ROOT, "dist/cli.js"));
const WORK = mkdtempSync(path.join(os.tmpdir(), "grillado-is-"));
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
const started = new Set();
process.on("exit", () => {
  for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
});

// ---------------------------------------------------------------- fakes
const bin = mkdtempSync(path.join(WORK, "bin-"));
for (const id of ["claude", "codex", "pi"]) {
  writeFileSync(path.join(bin, id), `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-agent.mjs")}" ${id} "$@"\n`);
  chmodSync(path.join(bin, id), 0o755);
}
// gh: the fake, with its knobs in a file so one server can see gh missing, logged out, public…
const GHDIR = mkdtempSync(path.join(WORK, "gh-"));
const CTL = path.join(GHDIR, "ctl.sh");
const ctl = (env = {}) => writeFileSync(CTL, Object.entries(env).map(([k, v]) => `export ${k}=${v}\n`).join(""));
ctl();
writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n. "${CTL}"\n[ "$GH_MISSING" = 1 ] && exit 127\nexec "${NODE}" "${path.join(ROOT, "test/fixtures/fake-gh.mjs")}" "$@"\n`);
chmodSync(path.join(bin, "gh"), 0o755);
const ghCalls = () => (existsSync(path.join(GHDIR, "argv.jsonl")) ? readFileSync(path.join(GHDIR, "argv.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args) : []);
const isWrite = (a) => (a[0] === "issue" && ["create", "edit", "close", "delete"].includes(a[1])) || (a[0] === "label" && a[1] === "create") || (a[0] === "api" && a.some((x, i) => (x === "-X" || x === "--method") && /POST|PATCH|PUT|DELETE/.test(a[i + 1] ?? "")));
const ghState = () => JSON.parse(readFileSync(path.join(GHDIR, "state.json"), "utf8"));
const ghEdit = (fn) => {
  const st = ghState();
  fn(st);
  writeFileSync(path.join(GHDIR, "state.json"), JSON.stringify(st, null, 2));
};

// Linear: GraphQL on 127.0.0.1 (the CLI only accepts a loopback GRILLADO_LINEAR_URL).
const linearReqs = [];
const linear = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const { query } = JSON.parse(raw || "{}");
    linearReqs.push(query);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "lin_api_good") return send(400, { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] });
    if (/viewer/.test(query)) return send(200, { data: { viewer: { id: "u1", name: "Victor" } } });
    if (/teams\(/.test(query)) return send(200, { data: { teams: { nodes: [{ id: "team-1", name: "Core", key: "COR" }] } } });
    if (/projects\(/.test(query)) return send(200, { data: { team: { projects: { nodes: [{ id: "proj-1", name: "Grillado" }] } } } });
    if (/labels\(/.test(query)) return send(200, { data: { team: { labels: { nodes: [{ id: "label-1", name: "feature", color: "#5e6ad2" }] } } } });
    if (/issues\(/.test(query)) return send(200, { data: { issues: { nodes: [] } } });
    send(400, { errors: [{ message: "mock: unsupported" }] });
  });
});
await new Promise((r) => linear.listen(0, "127.0.0.1", r));
const LINEAR_URL = `http://127.0.0.1:${linear.address().port}/graphql`;

// The project: a git folder whose origin is on GitHub (local git only).
const proj = mkdtempSync(path.join(WORK, "proj-"));
execFileSync("git", ["init", "-q", proj]);
execFileSync("git", ["-C", proj, "remote", "add", "origin", "git@github.com:victor-teles/grillado.git"]);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function server() {
  const home = mkdtempSync(path.join(WORK, "home-"));
  const env = { PATH: `${bin}:${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, GRILLADO_HOME: path.join(home, ".grillado"), FAKE_STATE_DIR: home, FAKE_GH_DIR: GHDIR, GRILLADO_LINEAR_URL: LINEAR_URL };
  const child = spawn(NODE, [CLI, "--no-open", "--no-scan", "--port", String(await freePort())], { env, cwd: proj, stdio: ["ignore", "pipe", "pipe"] });
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
  return { url, dir: env.GRILLADO_HOME, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.on("exit", r), child.kill("SIGINT")))) };
}

// ---------------------------------------------------------------- helpers
const pickIfAsked = async (pg, name) => {
  const r = pg.getByRole("radio", { name });
  if (await r.isVisible({ timeout: 1500 }).catch(() => false)) {
    await r.click();
    await pg.getByRole("button", { name: /Continue/ }).click();
  }
};
async function plate(pg, url, idea) {
  await pg.goto(url);
  await pickIfAsked(pg, /Claude Code/);
  await pg.getByRole("textbox", { name: "What are you planning?" }).fill(idea);
  await pg.keyboard.press("Enter");
  await pg.getByRole("heading", { name: "2 decisions are ready" }).waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByText("Keep data local first?").waitFor({ timeout: 15000 });
  await pg.getByRole("button", { name: /Send round/ }).click();
  await pg.getByRole("button", { name: /Yes, plate it/ }).click({ timeout: 15000 });
  await pg.getByTestId("plan").waitFor({ timeout: 15000 });
  return pg.url().split("/s/")[1].split("?")[0];
}
async function axe(pg, name) {
  await pg.waitForTimeout(400);
  const r = await new AxeBuilder({ page: pg }).analyze();
  check(`axe: ${name}`, r.violations.length === 0, r.violations.map((v) => `${v.id} ${v.nodes[0]?.target} ${v.nodes[0]?.any?.[0]?.message ?? ""} ${v.nodes[0]?.html?.slice(0, 160) ?? ""}`).join("; "));
}
async function shot(pg, name, theme) {
  if (!SHOTS) return;
  await pg.waitForFunction(() => !document.querySelector(".toast,.gr-notice"), null, { timeout: 6000 }).catch(() => {});
  await settle(pg);
  await pg.waitForTimeout(250);
  await pg.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
}
const settle = (pg) => pg.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 3000 }).catch(() => {});
const active = (pg) => pg.evaluate(() => { const a = document.activeElement; return `${a?.getAttribute("role") ?? a?.tagName}:${a?.getAttribute("aria-label") ?? a?.textContent?.trim()}`; });
const sheet = (pg) => pg.getByTestId("issues-sheet");
const go = (pg) => sheet(pg).getByTestId("issues-confirm");
const foot = (pg) => sheet(pg).locator(".iac");
/** The card's first line, with the · separators spaced as they read. */
const sum = async (pg) => (await foot(pg).locator(".iac-t").textContent()).replace(/\s*·\s*/g, " · ").trim();
const menuItems = async (pg) => {
  await pg.getByRole("button", { name: "Plan actions" }).click();
  await pg.getByRole("menu").waitFor();
  return pg.getByRole("menu").getByRole("menuitem").allTextContents();
};
async function openSheet(pg) {
  await menuItems(pg);
  await pg.getByTestId("menu-issues").click();
  await sheet(pg).waitFor();
  await sheet(pg).locator(".ir:not(.sk)").first().waitFor({ timeout: 10000 });
  await settle(pg);
}
const planUrl = (app, id) => `${new URL(app.url).origin}/s/${id}${new URL(app.url).search}`;
const errors = [];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const app = await server();
let planId = "";
try {
  // ============================================================== desktop, dark: the whole flow
  {
    const theme = "dark";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    planId = await plate(pg, app.url, "A recipe box for my family");

    // §1 the ⋯ item, after “Use in your editor…”
    const items = await menuItems(pg);
    const at = items.findIndex((t) => t.startsWith("Create issues…"));
    check("⋯ has “Create issues…” right after “Use in your editor…”", at > 0 && items[at - 1] === "Use in your editor…", items.join(" | "));
    check("the item is enabled on a finished plan", (await pg.getByTestId("menu-issues").getAttribute("aria-disabled")) === null);
    await shot(pg, "d-menu", theme);
    await pg.keyboard.press("Escape");

    // §2 the sheet: focus, destination, nothing written
    await openSheet(pg);
    check("the sheet is a modal dialog named “Create issues”", (await sheet(pg).getAttribute("aria-modal")) === "true" && (await pg.getByRole("dialog", { name: "Create issues" }).count()) === 1);
    check("focus starts on the selected destination tab", (await active(pg)) === "tab:GitHub", await active(pg));
    check("Copy Markdown is hidden while the sheet is open", await pg.evaluate(() => document.documentElement.classList.contains("ish-open")));
    const repoBtn = sheet(pg).getByRole("button", { name: "Repository" });
    check("the repository is origin’s", (await repoBtn.textContent()).includes("victor-teles/grillado"));
    await sheet(pg).locator(".ifl .ihn", { hasText: /gh as @/ }).waitFor({ timeout: 5000 });
    check("the hint says where it came from and who gh is", /^From origin · github\.com · gh as @\S+$/.test(await sheet(pg).locator(".ifl .ihn").first().textContent()), await sheet(pg).locator(".ifl .ihn").first().textContent());
    await go(pg).waitFor();
    await pg.waitForFunction(() => !document.querySelector("[data-testid=issues-confirm]")?.disabled, null, { timeout: 8000 }).catch(() => {});
    const btn0 = await go(pg).textContent();
    check("the button says how many and where", /^Create \d+ issues? in victor-teles\/grillado$/.test(btn0), btn0);
    check("the how-line names gh and promises nothing is sent yet", /^Runs gh as @\S+ on this computer\. Nothing is sent before you click\.$/.test(await foot(pg).locator(".iac-n").last().textContent()));
    check("no public line on a private repo", (await sheet(pg).locator(".pub").count()) === 0);

    // §3 the split: only on request (BIG-3 pending: no agent run on open)
    const src = sheet(pg).locator(".ipv-src").first();
    check("opening didn’t run the agent: the list is the user stories or the parent", /^(One issue per user story|Only the parent issue)/.test(await src.textContent()), await src.textContent());
    await src.getByRole("button", { name: "Split with Claude Code" }).click();
    await sheet(pg).getByText(/^Split by Claude Code into/).waitFor({ timeout: 15000 });
    const rows = sheet(pg).locator(".ir:not(.sk)");
    const n = await rows.count();
    check("split: the parent plus slices", n >= 2, String(n));
    check("slices say which decisions they cover, with the plan’s ids", /^Covers R\d·\d/.test(await rows.nth(1).locator(".cov").textContent()), await rows.nth(1).locator(".cov").textContent());
    await shot(pg, "d-sheet", theme);
    await axe(pg, `${theme} desktop: the sheet`);

    // Body disclosure: what would be sent (BIG-1 pending: the server's body).
    const x = rows.nth(1).locator(".ir-x");
    await x.click();
    check("Body opens the exact body", (await x.getAttribute("aria-expanded")) === "true" && (await rows.nth(1).locator(".ir-body pre").textContent()).includes("grillado:plan="));
    await shot(pg, "d-body", theme);
    await x.click();

    // Selection: the parent is locked while a child is on; the count follows.
    const parentCb = rows.nth(0).getByRole("checkbox");
    check("the parent is locked while any child is selected", (await parentCb.getAttribute("aria-disabled")) === "true");
    await rows.nth(1).getByRole("checkbox").click();
    const btn1 = await go(pg).textContent();
    check("unchecking a child counts one fewer", Number(/\d+/.exec(btn1)[0]) === Number(/\d+/.exec(await go(pg).textContent())[0]) && Number(/\d+/.exec(btn1)[0]) === n - 1, btn1);
    await rows.nth(1).getByRole("checkbox").click();

    // A title edit; Enter moves on, never adds a line.
    const t1 = rows.nth(1).locator("textarea");
    await t1.fill("Keep recipes on the device");
    await t1.press("Enter");
    check("Enter in a title moves to the next title", (await active(pg)).startsWith("TEXTAREA:Issue title") && (await t1.inputValue()) === "Keep recipes on the device");

    // Esc order (§9): the listbox first, then the sheet; focus back on ⋯.
    await repoBtn.click();
    await sheet(pg).getByRole("listbox", { name: "Repositories" }).waitFor();
    check("the repo list tags origin", (await sheet(pg).getByRole("option").first().textContent()).includes("origin"));
    await pg.keyboard.type("acme/payments");
    check("a typed owner/repo can be used", (await sheet(pg).getByRole("option", { name: /Use acme\/payments/ }).count()) === 1);
    await shot(pg, "d-repos", theme);
    await pg.keyboard.press("Escape");
    check("Esc closes the list first, focus back on Repository", (await sheet(pg).count()) === 1 && (await sheet(pg).getByRole("listbox").count()) === 0 && (await active(pg)).includes("victor-teles/grillado"), await active(pg));
    // Labels: add a known one and a new one.
    await sheet(pg).getByRole("button", { name: "Add label" }).click();
    await sheet(pg).getByRole("option", { name: /bug/ }).click();
    await sheet(pg).getByRole("button", { name: "Add label" }).click();
    await pg.keyboard.type("v1.3");
    await sheet(pg).getByRole("option", { name: /Create label “v1\.3”/ }).waitFor();
    await pg.keyboard.press("Enter");
    const what = await foot(pg).locator(".iac-t").textContent();
    check("the card lists labels and the one it creates", /labels bug, v1\.3 · also creates the label v1\.3$/.test(what), what);
    await shot(pg, "d-labels", theme);
    check("nothing was written to GitHub before the confirm", ghCalls().filter(isWrite).length === 0, JSON.stringify(ghCalls().filter(isWrite)));
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });
    check("Esc closes the sheet, focus back on ⋯", (await active(pg)) === "BUTTON:Plan actions", await active(pg));

    // Public repos say so (§4).
    ctl({ FAKE_GH_VISIBILITY: "PUBLIC" });
    await openSheet(pg);
    await sheet(pg).locator(".pub").waitFor({ timeout: 5000 }).catch(() => {});
    check("a public repo shows the public line", (await sheet(pg).locator(".pub").textContent().catch(() => "")) === "Public repo: anyone can read these issues");
    check("the hint says public", (await sheet(pg).locator(".ifl .ihn").first().textContent()).includes("· public"));
    await shot(pg, "d-public", theme);
    ctl({ FAKE_GH_FAIL_CREATE: "3" });
    await pg.keyboard.press("Escape");

    // §5 the run: a partial failure, then Retry failed.
    await openSheet(pg);
    await sheet(pg).getByText(/^Split by Claude Code/).waitFor();
    await pg.waitForFunction(() => !document.querySelector("[data-testid=issues-confirm]")?.disabled, null, { timeout: 8000 });
    const before = ghCalls().filter(isWrite).length;
    await go(pg).click();
    await sheet(pg).locator(".iac[data-k=partial],.iac[data-k=done]").waitFor({ timeout: 20000 });
    check("a failed create is a partial run", (await foot(pg).getAttribute("data-k")) === "partial", await foot(pg).textContent());
    check("the summary counts created and failed", /^\d+ created · 1 failed · victor-teles\/grillado$/.test(await sum(pg)), await sum(pg));
    check("the failed row says GitHub’s words", /^GitHub said: \S/.test(await sheet(pg).locator(".ir-why").first().textContent()), await sheet(pg).locator(".ir-why").first().textContent());
    check("Retry failed takes focus", (await active(pg)) === "BUTTON:Retry failed", await active(pg));
    check("the confirm was the first write", before === 0 && ghCalls().filter(isWrite).length > 0);
    await shot(pg, "d-partial", theme);
    await axe(pg, `${theme} desktop: partial run`);
    await pg.keyboard.press("Enter");
    await sheet(pg).locator(".iac[data-k=done]").waitFor({ timeout: 20000 });
    check("Retry failed creates only the failed one", (await sum(pg)) === "1 created · victor-teles/grillado", await sum(pg));
    check("Open parent issue links #1", (await sheet(pg).getByRole("link", { name: /Open parent issue/ }).getAttribute("href")) === "https://github.com/victor-teles/grillado/issues/1");
    check("Done takes focus", (await active(pg)) === "BUTTON:Done");
    await shot(pg, "d-done", theme);
    await pg.keyboard.press("Enter");
    await sheet(pg).waitFor({ state: "detached" });

    // §8 the strip and chips.
    const strip = pg.getByTestId("issues-strip");
    await strip.waitFor({ timeout: 8000 });
    await pg.waitForFunction(() => /sub-issues? · victor-teles\/grillado/.test(document.querySelector("[data-testid=issues-strip]")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    check("the strip links the parent and counts the sub-issues", /^Issues#1·\d+sub-issues?·victor-teles\/grillado$/.test((await strip.textContent()).replace(/\s/g, "")), await strip.textContent());
    const chips = pg.locator("[data-testid^=issue-chips-] .ilk");
    await chips.first().waitFor({ timeout: 8000 }).catch(() => {});
    check("decision cards carry their issue chips", (await chips.count()) > 0 && /^R\d·\d is covered by issue #\d+$/.test(await chips.first().getAttribute("aria-label")), String(await chips.count()));
    const mi = await menuItems(pg);
    check("the item becomes “Update issues…” with where it went", mi.some((t) => t === "Update issues…#1 · victor-teles/grillado"), mi.join(" | "));
    await pg.keyboard.press("Escape");
    await shot(pg, "d-strip", theme);
    await axe(pg, `${theme} desktop: plan with the strip and chips`);

    // §6 update: the plan changes, the parent was edited in GitHub, one sub-issue was deleted.
    const planFile = path.join(app.dir, "sessions", planId, "plan.md");
    const md = readFileSync(planFile, "utf8");
    const lines = md.split("\n");
    const p = lines.findIndex((l, i) => i > 0 && l.trim() && !l.startsWith("#") && !l.startsWith("```"));
    lines[p] = `${lines[p]} Families share one box.`;
    writeFileSync(planFile, lines.join("\n"));
    ghEdit((st) => {
      st.issues[0].body = `${st.issues[0].body}\n\nA note from the team.`;
      st.issues[1].deleted = true;
    });
    await pg.reload();
    await pg.getByTestId("plan").waitFor();
    await pg.waitForFunction(() => /changed since export/.test(document.querySelector("[data-testid=issues-strip]")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
    check("the strip says what changed, with Update issues", /\d+ changed since export·Update issues$/.test((await pg.getByTestId("issues-strip").textContent()).replace(/\s*·\s*/g, "·")), await pg.getByTestId("issues-strip").textContent());
    const gone = pg.locator(".ilk.gone");
    check("a deleted sub-issue’s chip offers Recreate", (await gone.count()) === 0 || /#2 missing · Recreate/.test(await gone.first().textContent()), String(await gone.count()));
    await shot(pg, "d-changed", theme);
    await openSheet(pg);
    await pg.getByRole("dialog", { name: "Update issues" }).waitFor();
    check("update mode says where the issues already are", /^Already in victor-teles\/grillado #1/.test(await sheet(pg).locator(".ish-d").textContent()));
    const par = sheet(pg).getByTestId("issue-row-plan");
    check("the parent edited in GitHub is skipped by default", (await par.locator(".ist").textContent()) === "Edited in GitHub · skip");
    check("the deleted one will be recreated", (await sheet(pg).getByText("Missing in GitHub · will recreate").count()) === 1);
    check("button: Recreate 1 issue", (await go(pg).textContent()) === "Recreate 1 issue in victor-teles/grillado", await go(pg).textContent());
    await shot(pg, "d-update", theme);
    await par.getByRole("button", { name: "Overwrite with the plan’s version" }).click();
    check("overwrite flips the row and the button", (await par.locator(".ist").textContent()) === "Edited in GitHub · overwrite" && (await go(pg).textContent()) === "Create 1 and update 1 in victor-teles/grillado", await go(pg).textContent());
    check("the card counts it", /1 update \(1 overwrites edits made in GitHub\) · 1 recreated/.test(await foot(pg).locator(".iac-t").textContent()), await foot(pg).locator(".iac-t").textContent());
    await shot(pg, "d-overwrite", theme);
    await axe(pg, `${theme} desktop: update mode`);
    await go(pg).click();
    await sheet(pg).locator(".iac[data-k=done]").waitFor({ timeout: 20000 });
    check("the update run: 1 created, 1 updated", (await sum(pg)) === "1 created, 1 updated · victor-teles/grillado", `${await sum(pg)} | ${(await sheet(pg).locator(".ir").allTextContents()).join(" || ")}`);
    await pg.keyboard.press("Escape");

    // §7 gh fix-its: missing, then logged out, then fine again.
    ctl({ GH_MISSING: 1 });
    await openSheet(pg);
    const fix = sheet(pg).locator(".ifix");
    await fix.waitFor({ timeout: 8000 });
    check("gh missing: the fix-it with install commands", (await fix.locator("strong").textContent()) === "GitHub CLI isn’t installed" && (await fix.locator("pre").allTextContents()).includes("brew install gh"));
    check("gh missing: the button waits", (await go(pg).isDisabled()) && (await foot(pg).locator(".iac-t").textContent()) === "Install gh to continue");
    await shot(pg, "d-fix-missing", theme);
    await axe(pg, `${theme} desktop: gh missing`);
    ctl({ FAKE_GH_AUTH: "out" });
    await fix.getByRole("button", { name: "Check again" }).click();
    await sheet(pg).getByText("gh isn’t signed in to github.com").waitFor({ timeout: 8000 });
    check("gh logged out: the exact command", (await fix.locator("pre").textContent()) === "gh auth login" && (await foot(pg).locator(".iac-t").textContent()) === "Sign in to gh to continue");
    await shot(pg, "d-fix-auth", theme);
    ctl();
    await fix.getByRole("button", { name: "Check again" }).click();
    await fix.waitFor({ state: "detached", timeout: 8000 });
    check("signed in: the fix-it goes and the repository is back", (await sheet(pg).getByRole("button", { name: "Repository" }).count()) === 1);

    // §2 Linear: a bad key, a good one, disconnect.
    await sheet(pg).getByRole("tab", { name: "GitHub" }).focus();
    await pg.keyboard.press("ArrowRight");
    check("←/→ moves between destinations", (await active(pg)) === "tab:Linear" && (await sheet(pg).getByRole("tab", { name: "Linear" }).getAttribute("aria-selected")) === "true");
    const key = sheet(pg).getByLabel("Linear API key");
    check("the key field is a password field", (await key.getAttribute("type")) === "password");
    await key.fill("lin_api_bad");
    await sheet(pg).getByRole("button", { name: "Connect" }).click();
    await sheet(pg).getByRole("alert").filter({ hasText: "That key didn’t work." }).waitFor({ timeout: 8000 });
    check("a bad key says so, with the settings link", (await sheet(pg).getByRole("link", { name: /Check it in Linear’s API key settings/ }).count()) === 1);
    await shot(pg, "d-linear-bad", theme);
    await key.fill("lin_api_good");
    await sheet(pg).getByRole("button", { name: "Connect" }).click();
    await sheet(pg).locator(".iconn").waitFor({ timeout: 8000 });
    check("connected: who and the last four only", /^ConnectedasVictor·••••good$/.test((await sheet(pg).locator(".iconn > span").first().textContent()).replace(/\s/g, "")), await sheet(pg).locator(".iconn").textContent());
    await pg.waitForFunction(() => /in Linear · Team Core$/.test(document.querySelector("[data-testid=issues-confirm]")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
    check("the button names the Linear team", /^Create \d+ issues? in Linear · Team Core$/.test(await go(pg).textContent()), await go(pg).textContent());
    check("the how-line names api.linear.app", (await foot(pg).locator(".iac-n").last().textContent()) === "Sends to api.linear.app with your saved key. Nothing is sent before you click.");
    check("the key never comes back to the page", !(await pg.content()).includes("lin_api_good"));
    await shot(pg, "d-linear", theme);
    await axe(pg, `${theme} desktop: Linear connected`);
    await sheet(pg).locator(".iconn").getByRole("button", { name: "Disconnect" }).click();
    check("disconnect asks first", (await sheet(pg).locator(".iconn.ask").textContent()).includes("Disconnect Linear? You’ll paste a key again next time."));
    await shot(pg, "d-linear-ask", theme);
    await sheet(pg).locator(".iconn.ask").getByRole("button", { name: "Disconnect" }).click();
    await sheet(pg).getByLabel("Linear API key").waitFor();
    check("disconnected: the key field is back", true);
    check("nothing was ever written to Linear", !linearReqs.some((q) => /issueCreate|issueUpdate|issueLabelCreate/.test(q)));
    await sheet(pg).getByRole("tab", { name: "Linear" }).focus();
    await pg.keyboard.press("ArrowLeft");
    await pg.keyboard.press("Escape");
    await sheet(pg).waitFor({ state: "detached" });

    // Keyboard mode: no motion (html[data-kbd]).
    await pg.getByRole("button", { name: "Plan actions" }).focus();
    await pg.keyboard.press("Enter");
    await pg.getByTestId("menu-issues").waitFor();
    await pg.getByTestId("menu-issues").focus();
    await pg.keyboard.press("Enter");
    await sheet(pg).waitFor();
    const moving = await pg.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.target?.closest?.(".ish") || a.effect?.target?.classList?.contains("ish"))).length);
    check("data-kbd: the sheet opens with no transition", moving === 0, String(moving));
    check("keyboard open: focus on the destination tab", (await active(pg)) === "tab:GitHub", await active(pg));
    await pg.keyboard.press("Escape");
    await ctx.close();
  }

  // ============================================================== desktop light, phones (both themes)
  for (const theme of ["light", "dark"]) {
    for (const vp of theme === "light" ? [{ w: 1440, h: 900 }, { w: 390, h: 844 }, { w: 320, h: 640 }] : [{ w: 390, h: 844 }, { w: 320, h: 640 }]) {
      const phone = vp.w <= 640;
      const tag = phone ? `m${vp.w}` : "d";
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: phone, hasTouch: phone });
      await ctx.addInitScript((t) => localStorage.setItem("grillado-theme", t), theme);
      const pg = await ctx.newPage();
      pg.on("pageerror", (e) => errors.push(String(e)));
      await pg.goto(planUrl(app, planId));
      await pg.getByTestId("plan").waitFor({ timeout: 15000 });
      await pg.getByTestId("issues-strip").waitFor({ timeout: 8000 });
      await shot(pg, `${tag}-strip`, theme);
      await openSheet(pg);
      const box = await sheet(pg).boundingBox();
      if (phone) {
        check(`${theme} ${vp.w}: a bottom sheet, full width`, Math.round(box.x) === 0 && Math.round(box.width) === vp.w && Math.abs(box.y + box.height - vp.h) < 2, JSON.stringify(box));
        check(`${theme} ${vp.w}: no Cancel on phones`, (await foot(pg).getByRole("button", { name: "Cancel" }).count()) === 0);
      } else check(`${theme} desktop: a 560px side sheet`, Math.round(box.width) === 560 && Math.round(box.x + box.width) === vp.w, JSON.stringify(box));
      const over = await pg.evaluate(() => { const s = document.querySelector(".ish-b"); return s.scrollWidth - s.clientWidth; });
      check(`${theme} ${vp.w}: nothing overflows sideways`, over <= 0, String(over));
      const fits = await go(pg).evaluate((b) => b.scrollWidth <= b.clientWidth + 1);
      check(`${theme} ${vp.w}: the confirm text fits`, fits);
      await shot(pg, `${tag}-sheet`, theme);
      await axe(pg, `${theme} ${vp.w}: the sheet`);
      if (phone) {
        await sheet(pg).getByRole("tab", { name: "Linear" }).click();
        await sheet(pg).getByLabel("Linear API key").waitFor();
        await shot(pg, `${tag}-linear`, theme);
        await sheet(pg).getByRole("tab", { name: "GitHub" }).click();
        await sheet(pg).getByRole("button", { name: "Repository" }).click();
        await shot(pg, `${tag}-repos`, theme);
        await pg.keyboard.press("Escape");
      }
      await pg.keyboard.press("Escape");
      await sheet(pg).waitFor({ state: "detached" });
      await ctx.close();
    }
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await app.stop();
  await browser.close();
  linear.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
