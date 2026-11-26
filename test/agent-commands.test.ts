// Plan 004: coding agents find Grillado (the skill stub, `grillado skills`) and use it from a shell
// (`grillado plan …`), and an app started for them goes away on its own.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../src/cli/args.ts";
import { checkPlanArgs, runPlan } from "../src/cli/plan-command.ts";
import { getPlan, listPlans } from "../src/cli/plans.ts";
import { loadSkills, parseSkill, runSkills } from "../src/cli/skills-command.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { BANNED_TERMS } from "../src/core/filter.ts";
import { draftSession, PLAN_MD, platedSession, tempStore } from "./mcp-fixture.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const SKILLS = path.join(ROOT, "skill-data");

function io() {
  const o = { out: "", err: "" };
  return { o, out: (s: string) => void (o.out += s), err: (s: string) => void (o.err += s) };
}
const base = (store: Store, extra: Partial<Parameters<typeof runPlan>[1]> = {}) => {
  const c = io();
  return { c, env: { version: "9.9.9", out: c.out, err: c.err, env: { GRILLADO_HOME: store.dir }, cliFile: "/nope", appLine: () => "npx grillado", pollMs: 20, ...extra } };
};

describe("grillado skills", () => {
  test("list names the three skills; get prints the version line and the skill", () => {
    const a = io();
    expect(runSkills([], "9.9.9", a.out, SKILLS)).toBe(0);
    expect(a.o.out.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0])).toEqual(["build", "mcp", "plan"]);
    const b = io();
    expect(runSkills(["get", "plan"], "9.9.9", b.out, SKILLS)).toBe(0);
    expect(b.o.out.startsWith("grillado 9.9.9\n\n# Plan with Grillado")).toBe(true);
    const j = io();
    runSkills(["list", "--json"], "9.9.9", j.out, SKILLS);
    expect(JSON.parse(j.o.out)).toMatchObject({ version: "9.9.9", skills: [{ name: "build" }, { name: "mcp" }, { name: "plan" }] });
  });

  test("an unknown skill or option is wrong usage", () => {
    expect(() => runSkills(["get", "nope"], "1", () => {}, SKILLS)).toThrow(UsageError);
    expect(() => runSkills(["get"], "1", () => {}, SKILLS)).toThrow(UsageError);
    expect(() => runSkills(["--full"], "1", () => {}, SKILLS)).toThrow(UsageError);
  });

  test("GRILLADO_SKILLS_DIR is honoured", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-skills-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dir, "only"));
    writeFileSync(path.join(dir, "only", "SKILL.md"), "---\nname: only\ndescription: One. More.\n---\nBody");
    const { skillsDir } = await import("../src/cli/skills-command.ts");
    expect(skillsDir({ GRILLADO_SKILLS_DIR: dir })).toBe(dir);
    expect(loadSkills(dir)).toEqual([{ name: "only", description: "One. More.", body: "Body" }]);
  });
});

/** Every `grillado plan …` / `grillado skills get …` line in a skill's text, as argv. */
function commandsIn(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/(?:npx -y |npx )?grillado ((?:plan|skills) [^\n`|]*)/g)) {
    const argv = (m[1].match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, "")).map((a) => (a === "<id>" ? "2026-01-01-aaaaaaaa" : a));
    // Stop at prose or a shell comment after the command.
    const cut = argv.findIndex((a) => a === "#" || a.startsWith("(") || /[.,;]$/.test(a) && !a.startsWith("--"));
    if (argv[1] === "…") continue; // prose: "the shell commands (grillado plan …)"
    out.push(cut === -1 ? argv : argv.slice(0, cut));
  }
  return out;
}

describe("the skill text matches the CLI", () => {
  const files = [path.join(ROOT, "skills", "grillado", "SKILL.md"), ...readdirSync(SKILLS).map((d) => path.join(SKILLS, d, "SKILL.md"))];

  test("every command a skill shows parses", () => {
    const names = loadSkills(SKILLS).map((s) => s.name);
    let seen = 0;
    for (const f of files) {
      for (const argv of commandsIn(readFileSync(f, "utf8"))) {
        seen++;
        if (argv[0] === "skills") {
          if (argv[1] === "get") for (const n of argv.slice(2).filter((a) => !a.startsWith("-"))) expect(names).toContain(n);
          continue;
        }
        expect(() => checkPlanArgs(argv.slice(1)), `${path.basename(path.dirname(f))}: grillado ${argv.join(" ")}`).not.toThrow();
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(() => checkPlanArgs(["start", "x", "--bogus"])).toThrow(UsageError);
    expect(() => checkPlanArgs(["wait", "x", "--quote", "y"])).toThrow(UsageError);
  });

  test("the stub: name, a matchable description, allowed tools, and it points at skills get", () => {
    const stub = readFileSync(path.join(ROOT, "skills", "grillado", "SKILL.md"), "utf8");
    const s = parseSkill(stub, "x");
    expect(s.name).toBe("grillado");
    for (const phrase of ["help me plan", "let's plan", "write a spec", "docs/plans/grillado-plan-"]) expect(s.description).toContain(phrase);
    expect(stub).toMatch(/^allowed-tools: Bash\(grillado:\*\), Bash\(npx grillado:\*\), Bash\(npx -y grillado:\*\)$/m);
    expect(s.body).toContain("npx -y grillado skills get plan");
    expect(s.body.split("\n").length).toBeLessThan(30);
  });

  test("no skill text names the method or leaks a prompt", () => {
    for (const f of files) for (const t of BANNED_TERMS) expect(readFileSync(f, "utf8").toLowerCase()).not.toContain(t);
  });
});

describe("grillado plan", () => {
  test("list, get and comment match what the MCP tools return", async () => {
    const store = tempStore();
    const plated = platedSession(store);
    draftSession(store);
    let { c, env } = base(store);
    expect(await runPlan(["list", "--json"], env)).toBe(0);
    expect(JSON.parse(c.o.out)).toEqual(JSON.parse(JSON.stringify({ plans: listPlans(store) })));
    ({ c, env } = base(store));
    expect(await runPlan(["get", plated.id], env)).toBe(0);
    expect(c.o.out).toBe(PLAN_MD.endsWith("\n") ? PLAN_MD : `${PLAN_MD}\n`);
    ({ c, env } = base(store));
    await runPlan(["get", plated.id, "--json"], env);
    expect(JSON.parse(c.o.out)).toEqual(JSON.parse(JSON.stringify(getPlan(store, plated.id))));
    ({ c, env } = base(store));
    expect(await runPlan(["comment", plated.id, "--quote", "No sync in v1.", "--text", "Sync is cheap with iCloud.", "--json"], env)).toBe(0);
    expect(JSON.parse(c.o.out)).toMatchObject({ plan: plated.id, thread: expect.any(String) });
    expect(store.load(plated.id)?.comments?.[0].messages[0].text).toBe("Sync is cheap with iCloud.");
  });

  test("a draft reads as one; a comment on a draft or a wrong quote is refused (exit 1, message on stderr)", async () => {
    const store = tempStore();
    const draft = draftSession(store);
    const plated = platedSession(store);
    let { c, env } = base(store);
    await runPlan(["get", draft.id], env);
    expect(c.o.out).toContain("> **Draft.**");
    ({ c, env } = base(store));
    expect(await runPlan(["comment", draft.id, "--quote", "x", "--text", "y"], env)).toBe(1);
    expect(c.o.err).toContain("still a draft");
    expect(c.o.out).toBe("");
    ({ c, env } = base(store));
    expect(await runPlan(["comment", plated.id, "--quote", "not in it", "--text", "y"], env)).toBe(1);
    expect(c.o.err).toContain("That quote isn't in the plan");
    ({ c, env } = base(store));
    expect(await runPlan(["get", "2026-01-01-aaaaaaaa"], env)).toBe(1);
    expect(c.o.err).toContain("Run grillado plan list");
  });

  test("wrong usage throws (exit 2 in main)", async () => {
    const store = tempStore();
    for (const argv of [["nope"], ["get"], ["get", "a b"], ["wait", "x", "--timeout", "soon"], ["start"], ["start", "x", "--context", "a", "--context-file", "b"], ["comment", "2026-01-01-aaaaaaaa", "--text", "y"], ["list", "extra"], ["start", "x", "--bogus"]])
      await expect(runPlan(argv, base(store).env)).rejects.toThrow(UsageError);
  });

  test("wait: ready at once for a written plan; waiting at the timeout; ready once the user finishes", async () => {
    const store = tempStore();
    const plated = platedSession(store);
    let { c, env } = base(store);
    expect(await runPlan(["wait", plated.id, "--json"], env)).toBe(0);
    expect(JSON.parse(c.o.out)).toMatchObject({ result: "ready", id: plated.id, markdown: PLAN_MD });

    const draft = draftSession(store);
    ({ c, env } = base(store));
    expect(await runPlan(["wait", draft.id, "--timeout", "0", "--json"], env)).toBe(0);
    expect(JSON.parse(c.o.out)).toMatchObject({ result: "waiting", id: draft.id, status: "answering", decisions: 1 });
    ({ c, env } = base(store));
    await runPlan(["wait", draft.id, "--timeout", "0"], env);
    expect(c.o.out).toContain(`Run \`grillado plan wait ${draft.id}\` again`);

    ({ c, env } = base(store));
    const waiting = runPlan(["wait", draft.id, "--timeout", "5", "--json"], env);
    setTimeout(() => {
      store.update(draft.id, (s) => {
        s.status = "plated";
        const file = store.writePlan(s.id, "# Done\n");
        s.plan = { title: "Done", markdown: "# Done\n", path: file, openDecisions: [], createdAt: s.createdAt };
      });
    }, 100);
    expect(await waiting).toBe(0);
    expect(JSON.parse(c.o.out)).toMatchObject({ result: "ready", markdown: "# Done\n" });
  });

  test("start with an app running: a queued session in the project, its link opened, context from a file", async () => {
    const store = tempStore();
    store.writeServerInfo({ pid: process.pid, port: 4999, token: "tok" });
    const project = mkdtempSync(path.join(os.tmpdir(), "grillado-proj-"));
    writeFileSync(path.join(project, "ctx.md"), "Next.js, Prisma");
    const opened: string[] = [];
    const { c, env } = base(store, { cwd: project, open: (u) => opened.push(u) });
    expect(await runPlan(["start", "Save", "carts", "--context-file", "ctx.md", "--from", "claude-code", "--json"], env)).toBe(0);
    const r = JSON.parse(c.o.out);
    expect(r).toMatchObject({ app: "running", opened: true, url: `http://127.0.0.1:4999/s/${r.id}?t=tok` });
    expect(opened).toEqual([r.url]);
    const s = store.load(r.id)!;
    expect(s).toMatchObject({ idea: "Save carts", context: "Next.js, Prisma", queued: true, from: "claude-code", project });
    expect(s.planFile).toBe(path.join(project, "docs", "plans", `grillado-plan-${r.id}.md`));
    store.clearServerInfo(process.pid);
  });

  test("start: --plans-dir, else the folder set on Home, picks where the plan is saved (plan 005)", async () => {
    const store = tempStore();
    store.writeServerInfo({ pid: process.pid, port: 4999, token: "tok" });
    const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-proj-")));
    const { c, env } = base(store, { cwd: project, open: () => {} });
    expect(await runPlan(["start", "Save", "carts", "--plans-dir", "notes/plans", "--json"], env)).toBe(0);
    const a = JSON.parse(c.o.out);
    expect(store.load(a.id)!.planFile).toBe(path.join(project, "notes", "plans", `grillado-plan-${a.id}.md`));
    store.writeConfig({ plansDirs: { [project]: "decisions" } });
    c.o.out = "";
    expect(await runPlan(["start", "Share", "carts", "--json"], env)).toBe(0);
    const b = JSON.parse(c.o.out);
    expect(store.load(b.id)!.planFile).toBe(path.join(project, "decisions", `grillado-plan-${b.id}.md`));
    store.clearServerInfo(process.pid);
  });
});

// ---------------------------------------------------------------- the app, for real

const servers: GrilladoServer[] = [];
const pids: number[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("an app started for the agent", () => {
  test("plan start starts the web app in the background; the next one reuses it; it quits when idle", async () => {
    const store = tempStore();
    const project = mkdtempSync(path.join(os.tmpdir(), "grillado-proj-"));
    const env = { ...fakeEnv(fakeBinDir(["claude"])), GRILLADO_HOME: store.dir, GRILLADO_IDLE_MS: "1500", GRILLADO_WEB_DIR: mkdtempSync(path.join(os.tmpdir(), "grillado-web-")) };
    const first = base(store, { cwd: project, env, cliFile: path.join(ROOT, "src", "cli", "main.ts"), open: () => {} });
    expect(await runPlan(["start", "Save carts", "--no-open", "--json"], first.env)).toBe(0);
    const r = JSON.parse(first.c.o.out);
    expect(r).toMatchObject({ app: "started", opened: false });
    const info = store.readServerInfo()!;
    pids.push(info.pid);
    const status = await new Promise<number>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port: info.port, path: `/api/sessions/${r.id}`, headers: { "x-grillado-token": info.token } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on("error", reject),
    );
    expect(status).toBe(200);
    const second = base(store, { cwd: project, env, cliFile: path.join(ROOT, "src", "cli", "main.ts"), open: () => {} });
    await runPlan(["start", "Another", "--no-open", "--json"], second.env);
    expect(JSON.parse(second.c.o.out)).toMatchObject({ app: "running" });
    expect(store.readServerInfo()?.pid).toBe(info.pid);
    // Nobody opens it: it quits on its own and takes server.json with it.
    await until(() => !existsSync(path.join(store.dir, "server.json")), 15_000);
  }, 30_000);

  test("idle exit waits while a browser is connected", async () => {
    let quit = 0;
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    const server = new GrilladoServer({ adapters: [], store, webDir: web, port: 0, strictPort: true, idleExitMs: 300, onQuit: () => quit++ });
    servers.push(server);
    await server.listen();
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { "x-grillado-token": server.token } });
    req.on("error", () => {});
    await new Promise((r) => setTimeout(r, 900));
    expect(quit).toBe(0);
    req.destroy();
    await until(() => quit > 0, 3000);
    expect(quit).toBe(1);
  });

  test("without --exit-when-idle the app never quits on its own", async () => {
    let quit = 0;
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    const server = new GrilladoServer({ adapters: [], store, webDir: web, port: 0, strictPort: true, onQuit: () => quit++ });
    servers.push(server);
    await server.listen();
    await new Promise((r) => setTimeout(r, 400));
    expect(quit).toBe(0);
  });
});

test("--exit-when-idle parses for the web app and not for mcp", async () => {
  const { parseArgs } = await import("../src/cli/args.ts");
  expect(parseArgs(["--exit-when-idle"]).exitWhenIdle).toBe(true);
  expect(parseArgs([]).exitWhenIdle).toBe(false);
  expect(() => parseArgs(["mcp", "--exit-when-idle"])).toThrow("mcp only takes");
  // Plan 004 never changed what an editor's `grillado mcp` line accepts.
  expect(parseArgs(["mcp", "--data-dir", "x", "--no-scan"]).command).toBe("mcp");
});

test("README and docs: every relative link points at a file that exists; the README stays short", () => {
  const files = ["README.md", "CONTRIBUTING.md", ...readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  for (const f of files) {
    const text = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      expect(existsSync(path.resolve(ROOT, path.dirname(f), target)), `${f} → ${target}`).toBe(true);
    }
  }
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  expect(readme.split("\n").length).toBeLessThan(80);
  expect(readme).toContain("npx skills add victor-teles/grillado");
});
