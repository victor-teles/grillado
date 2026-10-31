import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseArgs } from "../src/cli/args.ts";
import { appLine, mcpLaunch, shellQuote } from "../src/cli/launch.ts";
import { createMcpServer, type McpOptions } from "../src/cli/mcp.ts";
import type { Store } from "../src/cli/store.ts";
import { addCoderComment } from "../src/core/comments.ts";
import { PLAN_MD, draftSession, platedSession, tempStore } from "./mcp-fixture.ts";

async function connect(store: Store, name = "test-coder", app?: string, options?: McpOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store, "0.0.0-dev", app, options).connect(a);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(b);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as any;
const textOf = (r: any) => r.content.map((x: any) => x.text).join("\n");

describe("grillado mcp tools", () => {
  test("lists exactly the seven tools", async () => {
    const c = await connect(tempStore());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add_comment", "get_decisions", "get_plan", "import_source", "list_plans", "list_project_sources", "start_plan"]);
    for (const t of tools) expect(JSON.stringify(t).toLowerCase()).not.toMatch(/grill-me|grilling|pocock/);
    // v1.3 item 2: issues are only created from the browser, after its preview and confirm.
    expect(tools.some((t) => /issue/.test(t.name))).toBe(false);
  });

  test("list_plans: empty, then newest first with draft flags", async () => {
    const store = tempStore();
    const c = await connect(store);
    expect(textOf(await call(c, "list_plans"))).toContain("No plans yet");
    const plated = platedSession(store);
    const draft = draftSession(store);
    const r = await call(c, "list_plans");
    expect(r.structuredContent.plans.map((p: any) => [p.id, p.draft])).toEqual([
      [draft.id, true],
      [plated.id, false],
    ]);
    expect(r.structuredContent.plans[1]).toMatchObject({ title: "Recipe box", status: "plated", decisions: 2, uri: `grillado://plans/${plated.id}` });
  });

  test("get_plan: plan.md plus resolved decisions with answers", async () => {
    const store = tempStore();
    const s = platedSession(store);
    store.writePlan(s.id, `${PLAN_MD}\nEdited by hand.\n`); // plan.md is the source of truth
    const r = await call(await connect(store), "get_plan", { plan: s.id });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Edited by hand.");
    expect(r.structuredContent).toMatchObject({ id: s.id, draft: false, open: ["export"] });
    expect(r.structuredContent.decisions.map((d: any) => [d.key, d.answer])).toEqual([
      ["storage", "SQLite on the device"],
      ["sync", "Not in v1"],
    ]);
  });

  test("get_plan: issues is null until the plan is sent, then the links", async () => {
    const store = tempStore();
    const s = platedSession(store);
    const c = await connect(store);
    expect((await call(c, "get_plan", { plan: s.id })).structuredContent.issues).toBeNull();
    store.update(s.id, (x) => {
      x.issues = {
        tracker: "github",
        target: "victor-teles/grillado",
        labels: ["grillado"],
        parent: { id: "9001", number: 1, url: "https://github.com/victor-teles/grillado/issues/1", contentHash: "h" },
        items: { "add-recipes": { id: "9002", number: 2, url: "https://github.com/victor-teles/grillado/issues/2", contentHash: "h", unattached: true } },
        exportedAt: "2026-10-27T00:00:00.000Z",
      };
    });
    const r = await call(c, "get_plan", { plan: s.id });
    expect(r.structuredContent.issues).toEqual({
      tracker: "github",
      target: "victor-teles/grillado",
      parent: { number: 1, url: "https://github.com/victor-teles/grillado/issues/1" },
      items: { "add-recipes": { number: 2, url: "https://github.com/victor-teles/grillado/issues/2" } },
      exportedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(JSON.parse(r.content[1].text).issues.parent.number).toBe(1);
  });

  test("get_plan: an unconfirmed plan comes back as a draft", async () => {
    const store = tempStore();
    const s = draftSession(store);
    const r = await call(await connect(store), "get_plan", { plan: s.id });
    expect(r.structuredContent.draft).toBe(true);
    expect(r.content[0].text).toStartWith("# Draft: A habit tracker");
    expect(r.content[0].text).toContain("**Draft.**");
    expect(r.content[0].text).toContain("- **Which platform?**: iOS first");
  });

  test("get_plan / get_decisions / add_comment: unknown and malformed ids are clear errors", async () => {
    const c = await connect(tempStore());
    for (const tool of ["get_plan", "get_decisions"]) {
      const r = await call(c, tool, { plan: "2026-01-01-nope" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe('No plan with id "2026-01-01-nope". Call list_plans to see the ids.');
    }
    const r = await call(c, "add_comment", { plan: "2026-01-01-nope", quote: "x", text: "y" });
    expect(textOf(r)).toContain('No plan with id "2026-01-01-nope"');
    const bad = await call(c, "get_plan", { plan: "../etc" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("A plan id looks like");
  });

  test("get_decisions: answers, dependencies, open and stale", async () => {
    const store = tempStore();
    const s = platedSession(store);
    store.update(s.id, (x) => {
      x.stale = { color: { key: "color", label: "Color", title: "Accent color?", answer: "Orange", round: 1, dependsOn: [], reason: "Brand changed" } };
    });
    const r = await call(await connect(store), "get_decisions", { plan: s.id });
    expect(r.structuredContent.decisions[1]).toEqual({ key: "sync", title: "Sync between devices?", answer: "Not in v1", round: 2, kind: "other", acceptedRecommendation: false, dependsOn: ["storage"] });
    expect(r.structuredContent.open).toEqual(["export"]);
    expect(r.structuredContent.stale).toEqual([{ key: "color", title: "Accent color?", reason: "Brand changed" }]);
  });

  test("start_plan: queues a session; links to it when the web app is running", async () => {
    const store = tempStore();
    const c = await connect(store);
    const off = await call(c, "start_plan", { idea: "  A plant watering reminder  " });
    expect(off.structuredContent.url).toBeNull();
    expect(off.structuredContent.next).toContain("npx grillado --data-dir");
    const s = store.load(off.structuredContent.id)!;
    expect(s).toMatchObject({ idea: "A plant watering reminder", status: "asking", queued: true, rounds: [] });
    expect(s.project).toBe(process.cwd());
    expect(s.planFile).toBe(path.join(process.cwd(), "docs", "plans", `grillado-plan-${s.id}.md`));

    store.writeServerInfo({ pid: process.pid, port: 4999, token: "tok" });
    const on = await call(c, "start_plan", { idea: "Another", context: "Uses Expo" });
    expect(on.structuredContent.url).toBe(`http://127.0.0.1:4999/s/${on.structuredContent.id}?t=tok`);
    expect(store.load(on.structuredContent.id)!.context).toBe("Uses Expo");
    expect((await call(c, "start_plan", { idea: "   " })).isError).toBe(true);
  });

  test("start_plan can bind its output to an explicit project", async () => {
    const store = tempStore();
    const project = path.join(store.dir, "project");
    const result = await call(await connect(store), "start_plan", { idea: "A project plan", path: project });
    const id = result.structuredContent.id;
    expect(store.load(id)?.project).toBe(project);
    const file = store.writePlan(id, "# A project plan\n");
    expect(file).toBe(path.join(project, "docs", "plans", `grillado-plan-${id}.md`));
    expect(store.readPlan(id)).toBe("# A project plan\n");
  });

  test("start_plan captures immutable project-plan context and returns metadata without text", async () => {
    const store = tempStore();
    const project = mkdtempSync(path.join(os.tmpdir(), "grillado-mcp-project-"));
    mkdirSync(path.join(project, "docs", "plans"), { recursive: true });
    const source = path.join(project, "docs", "plans", "existing.md");
    writeFileSync(source, "Existing decision");

    const result = await call(await connect(store), "start_plan", { idea: "A project plan", path: project });
    expect(result.structuredContent.projectContext.sources).toEqual([{ path: "docs/plans/existing.md", truncated: false }]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("Existing decision");
    const saved = store.load(result.structuredContent.id)!;
    expect(saved.projectContext?.sources[0].text).toBe("Existing decision");
    writeFileSync(source, "Changed later");
    expect(store.load(saved.id)?.projectContext).toEqual(saved.projectContext);
  });

  test("start_plan honors explicit and environment scan opt-outs", async () => {
    const store = tempStore();
    const project = mkdtempSync(path.join(os.tmpdir(), "grillado-mcp-off-"));
    writeFileSync(path.join(project, "PLAN.md"), "Must not be read");
    const explicit = await call(await connect(store, "test-coder", undefined, { scan: false }), "start_plan", { idea: "x", path: project });
    const environment = await call(await connect(store, "test-coder", undefined, { env: { GRILLADO_NO_SCAN: "1" } }), "start_plan", { idea: "y", path: project });
    expect(store.load(explicit.structuredContent.id)?.projectContext).toBeUndefined();
    expect(store.load(environment.structuredContent.id)?.projectContext).toBeUndefined();
    expect(explicit.structuredContent.projectContext).toBeUndefined();
  });

  test("add_comment: lands on the plan as the coding agent", async () => {
    const store = tempStore();
    const s = platedSession(store);
    const c = await connect(store);
    const r = await call(c, "add_comment", { plan: s.id, quote: "No sync in v1.", text: "I can add iCloud sync cheaply." });
    expect(r.isError).toBeFalsy();
    const t = store.load(s.id)!.comments!;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: r.structuredContent.thread, quote: "No sync in v1.", at: PLAN_MD.indexOf("No sync in v1.") });
    expect(t[0].messages[0]).toMatchObject({ by: "coder", client: "test-coder", text: "I can add iCloud sync cheaply." });

    expect(textOf(await call(c, "add_comment", { plan: s.id, quote: "Not in the plan", text: "x" }))).toContain("That quote isn't in the plan");
    const d = draftSession(store);
    expect(textOf(await call(c, "add_comment", { plan: d.id, quote: "x", text: "y" }))).toContain("is still a draft");
    expect(store.load(s.id)!.comments).toHaveLength(1);
  });
});

describe("grillado mcp resources", () => {
  test("one resource per plan, read as Markdown", async () => {
    const store = tempStore();
    const s = platedSession(store);
    const d = draftSession(store);
    const c = await connect(store);
    const { resources } = await c.listResources();
    expect(resources.map((r) => [r.uri, r.name, r.mimeType])).toEqual([
      [`grillado://plans/${d.id}`, "A habit tracker", "text/markdown"],
      [`grillado://plans/${s.id}`, "Recipe box", "text/markdown"],
    ]);
    const read = await c.readResource({ uri: `grillado://plans/${s.id}` });
    expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown", text: PLAN_MD });
    expect(c.readResource({ uri: "grillado://plans/2026-01-01-nope" })).rejects.toThrow('No plan with id "2026-01-01-nope"');
  });
});

describe("two processes writing at once", () => {
  test("a stale save keeps the threads another process added", () => {
    const store = tempStore();
    const s = platedSession(store);
    const stale = store.load(s.id)!; // the web app's copy
    store.update(s.id, (x) => void addCoderComment(x, { quote: "No sync in v1.", text: "from mcp" }));
    stale.summary = "changed by the web app";
    store.save(stale);
    const disk = store.load(s.id)!;
    expect(disk.summary).toBe("changed by the web app");
    expect(disk.comments!.map((t) => t.messages[0].text)).toEqual(["from mcp"]);
    expect(stale.comments).toHaveLength(1); // adopted into the caller's copy too
  });

  test("parallel writers never lose or corrupt a comment", () => {
    const store = tempStore();
    const s = platedSession(store);
    const script = `
      import { Store } from ${JSON.stringify(path.resolve("src/cli/store.ts"))};
      import { addCoderComment } from ${JSON.stringify(path.resolve("src/core/comments.ts"))};
      const store = new Store(process.argv[2]);
      for (let i = 0; i < 25; i++) store.update(process.argv[3], (s) => void addCoderComment(s, { quote: "No sync in v1.", text: process.argv[4] + i }));
    `;
    const file = path.join(store.dir, "writer.ts");
    writeFileSync(file, script);
    const procs = ["a", "b", "c"].map((tag) => Bun.spawn([process.execPath, file, store.dir, s.id, tag], { stderr: "inherit" }));
    // Meanwhile this process keeps saving its own stale copy, the way the web app would.
    const mine = store.load(s.id)!;
    for (let i = 0; i < 25; i++) store.save(mine);
    return Promise.all(procs.map((p) => p.exited)).then((codes) => {
      expect(codes).toEqual([0, 0, 0]);
      const disk = store.load(s.id)!; // parses: never half-written
      expect(disk.comments).toHaveLength(75);
      expect(spawnSync("ls", [store.sessionDir(s.id)]).stdout.toString()).not.toContain(".lock");
    });
  });
});

describe("grillado mcp args", () => {
  test("`mcp` takes only --data-dir and --no-scan", async () => {
    expect(parseArgs(["mcp"])).toMatchObject({ command: "mcp" });
    expect(parseArgs(["mcp", "--data-dir", "/tmp/x"])).toMatchObject({ command: "mcp", dataDir: "/tmp/x" });
    expect(parseArgs(["mcp", "--no-scan"])).toMatchObject({ command: "mcp", scan: false });
    expect(() => parseArgs(["mcp", "--port", "5000"])).toThrow("mcp only takes --data-dir and --no-scan");
    expect(() => parseArgs(["--port", "5000", "mcp"])).toThrow('Unknown option "mcp"');
  });
});

describe("the launch command for editors (handoff §2a)", () => {
  test("npx or a global install: npx -y grillado mcp", () => {
    const home = "/home/u";
    for (const f of ["/home/u/.npm/_npx/1a2b/node_modules/grillado/dist/cli.js", "/usr/local/lib/node_modules/grillado/dist/cli.js"]) {
      expect(mcpLaunch(f, "/home/u/.grillado", home)).toEqual({ command: "npx", args: ["-y", "grillado", "mcp"], line: "npx -y grillado mcp" });
    }
  });

  test("a local checkout: the absolute Node binary and cli.js, quoted; a custom data dir adds GRILLADO_HOME (#109)", () => {
    const node = "/Users/v/.nvm/versions/node/v22.11.0/bin/node";
    expect(mcpLaunch("/src/my grillado/dist/cli.js", "/data/plans", "/home/u", node)).toEqual({
      command: node,
      args: ["/src/my grillado/dist/cli.js", "mcp"],
      env: { GRILLADO_HOME: "/data/plans" },
      line: `${node} '/src/my grillado/dist/cli.js' mcp`,
    });
    expect(mcpLaunch("/src/g/dist/cli.js", "/home/u/.grillado", "/home/u", "/opt/my node/bin/node").line).toBe("'/opt/my node/bin/node' /src/g/dist/cli.js mcp");
  });

  test("by default it is this process's Node, never a bare node", () => {
    const l = mcpLaunch("/src/g/dist/cli.js", "/home/u/.grillado", "/home/u");
    expect(l.command).toBe(process.execPath);
    expect(path.isAbsolute(l.command)).toBe(true);
    expect(l.line).toBe(`${shellQuote(process.execPath)} /src/g/dist/cli.js mcp`);
  });

  test("start_plan's app-closed hint uses the same build and data dir", async () => {
    const node = "/opt/node/bin/node";
    expect(appLine("/src/g/dist/cli.js", "/home/u/.grillado", "/home/u", node)).toBe("/opt/node/bin/node /src/g/dist/cli.js");
    expect(appLine("/src/g/dist/cli.js", "/tmp/d 2", "/home/u", node)).toBe("/opt/node/bin/node /src/g/dist/cli.js --data-dir '/tmp/d 2'");
    expect(appLine("/usr/local/lib/node_modules/grillado/dist/cli.js", "/home/u/.grillado", "/home/u", node)).toBe("npx grillado");
    const r = await call(await connect(tempStore(), "test-coder", "/opt/node/bin/node /src/g/dist/cli.js"), "start_plan", { idea: "x" });
    expect(r.structuredContent.url).toBeNull();
    expect(r.structuredContent.next).toBe("Grillado's web app isn't running. Run `/opt/node/bin/node /src/g/dist/cli.js` and open this idea from Recent; the questions start there.");
  });

  test("start_plan remembers which editor sent the idea", async () => {
    const store = tempStore();
    const r = await call(await connect(store), "start_plan", { idea: "x" });
    expect(store.load(r.structuredContent.id)!.from).toBe("test-coder");
  });

  test("start_plan always marks the session as editor-started, even with no client name (#108)", async () => {
    const store = tempStore();
    const r = await call(await connect(store, ""), "start_plan", { idea: "x" });
    const s = store.load(r.structuredContent.id)!;
    expect(s.from).toBe("");
    expect(s.queued).toBe(true);
  });
});
