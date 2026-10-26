// v1.1 plan editor: block parsing/splicing (lossless round-trip, citation ids), autosave,
// Mermaid render + fallback, and the server's save endpoint (persists to plan.md, survives restart).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { createSession, editPlan } from "../src/core/session.ts";
import { Autosaver, type SaveState } from "../web/src/app/editor/autosave.ts";
import { citations, parseBlocks, splice } from "../web/src/app/editor/blocks.ts";
import { type MermaidLike, renderDiagram } from "../web/src/app/editor/diagram.ts";

// A plan shaped like renderPlanMarkdown's output, plus the things an editor tends to lose.
const PLAN = `# Recipe app

Build a **web** app first [R1:platform], store data locally [R2:storage].

## Scope

- Recipes and timers [R1:scope]
- Shopping list [R1:scope, R2:storage]
  - nested item keeps its indent

3. third
4. fourth

\`\`\`mermaid
flowchart TD
  A[Idea] --> B[Plan]
\`\`\`

| Table | stays |
|---|---|
| a | b |

<details><summary>raw html</summary>kept</details>

## Decision log

- **[R1:platform]** Platform → Web (accepted the recommendation)
- **[R1:scope]** Scope → Recipes and timers (your call)
- **[R2:storage]** Storage → SQLite on the device (your call)

## Open decisions

- Sync between devices
`;

/** What the rich view does when a block is edited: splice that block's source slice. */
function editBlock(source: string, index: number, edit: (raw: string) => string) {
  const b = parseBlocks(source)[index];
  return splice(source, b.start, b.end, edit(b.raw));
}

describe("blocks: lossless round-trip", () => {
  test("every block's raw text is exactly its source slice; only blank lines sit between blocks", () => {
    for (const src of [PLAN, PLAN.replace(/\n/g, "\r\n"), "", "\n\n", "no newline at end", "```js\nunclosed fence\nstill code"]) {
      const blocks = parseBlocks(src);
      let at = 0;
      for (const b of blocks) {
        expect(src.slice(b.start, b.end)).toBe(b.raw);
        expect(src.slice(at, b.start).trim()).toBe("");
        at = b.end;
      }
      expect(src.slice(at).trim()).toBe("");
    }
  });

  test("Markdown → editor → Markdown with no edits is byte-identical (rich and raw)", () => {
    for (const src of [PLAN, PLAN.replace(/\n/g, "\r\n")]) {
      let out = src;
      // Opening and closing every block in the rich view without typing.
      parseBlocks(src).forEach((_, i) => (out = editBlock(out, i, (raw) => raw)));
      expect(out).toBe(src);
    }
  });

  test("editing one block leaves every other byte alone, including raw [R1:id] citations", () => {
    const blocks = parseBlocks(PLAN);
    const scope = blocks.findIndex((b) => b.kind === "heading" && b.text === "Scope");
    const out = editBlock(PLAN, scope, () => "## Scope (v1)");
    expect(out).toBe(PLAN.replace("## Scope\n", "## Scope (v1)\n"));
    expect(citations(out)).toEqual(citations(PLAN));
    expect(out).toContain("- **[R1:platform]** Platform");
  });

  test("editing text around a citation keeps the id raw", () => {
    const para = parseBlocks(PLAN).findIndex((b) => b.kind === "para" && b.raw.includes("[R1:platform]"));
    const out = editBlock(PLAN, para, (raw) => raw.replace("Build a", "Ship a"));
    expect(out).toContain("Ship a **web** app first [R1:platform], store data locally [R2:storage].");
    expect(citations(out)).toEqual(citations(PLAN));
  });

  test("block kinds match the renderer", () => {
    const kinds = parseBlocks(PLAN).map((b) => b.kind);
    expect(kinds.slice(0, 5)).toEqual(["heading", "para", "heading", "list", "list"]);
    const ol = parseBlocks(PLAN)[4];
    expect(ol.kind === "list" && ol.ordered && ol.first).toBe(3);
    const fence = parseBlocks(PLAN).find((b) => b.kind === "fence");
    expect(fence?.kind === "fence" && fence.lang).toBe("mermaid");
    expect(fence?.kind === "fence" && fence.body).toBe("flowchart TD\n  A[Idea] --> B[Plan]");
  });

  test("citations() finds single and grouped ids", () => {
    expect(citations("a [R1:x] b [R2:y, R3:z-1] [not:one]")).toEqual(["R1:x", "R2:y", "R3:z-1"]);
  });
});

describe("autosave", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function rig(over: { fail?: () => boolean; latency?: number } = {}) {
    const saved: string[] = [];
    const states: SaveState[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const saver = new Autosaver("v0", {
      delay: 20,
      save: async (t) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(over.latency ?? 5);
        concurrent--;
        if (over.fail?.()) throw new Error("disk full");
        saved.push(t);
      },
      onState: (s) => states.push(s),
    });
    return { saver, saved, states, max: () => maxConcurrent };
  }

  test("debounces a burst of edits into one save of the latest text", async () => {
    const { saver, saved, states } = rig();
    for (const t of ["v1", "v12", "v123"]) saver.change(t);
    expect(saver.dirty).toBe(true);
    await sleep(80);
    expect(saved).toEqual(["v123"]);
    expect(saver.dirty).toBe(false);
    expect(states.at(-1)).toBe("saved");
    expect(states).toContain("saving");
  });

  test("never runs two saves at once; edits made during a save are saved right after", async () => {
    const { saver, saved, max } = rig({ latency: 40 });
    saver.change("a");
    await sleep(30); // save of "a" is in flight
    saver.change("ab");
    await saver.flush();
    expect(saved).toEqual(["a", "ab"]);
    expect(max()).toBe(1);
  });

  test("flush saves immediately without waiting for the debounce", async () => {
    const { saver, saved } = rig();
    saver.change("now");
    await saver.flush();
    expect(saved).toEqual(["now"]);
  });

  test("text equal to the last save isn't sent again", async () => {
    const { saver, saved } = rig();
    saver.change("v0");
    await saver.flush();
    expect(saved).toEqual([]);
    expect(saver.state).toBe("saved");
  });

  test("a failed save reports error, stays dirty, and flush retries it", async () => {
    let fail = true;
    const { saver, saved, states } = rig({ fail: () => fail });
    saver.change("draft");
    await saver.flush();
    expect(states.at(-1)).toBe("error");
    expect(saver.dirty).toBe(true);
    fail = false;
    await saver.flush();
    expect(saved).toEqual(["draft"]);
    expect(saver.dirty).toBe(false);
    expect(saver.lastSaved).toBe("draft");
  });

  test("reset drops pending work (plan replaced from outside)", async () => {
    const { saver, saved } = rig();
    saver.change("local");
    saver.reset("server");
    await sleep(50);
    expect(saved).toEqual([]);
    expect(saver.lastSaved).toBe("server");
  });
});

describe("Mermaid", () => {
  // Real Mermaid rejects bad syntax here without a DOM; drawing needs a browser, so success is
  // covered with a stub here and with real Mermaid in the e2e run.
  const real = async () => (await import("mermaid")).default as unknown as MermaidLike;
  const withRender = async (): Promise<MermaidLike> => {
    const m = await real();
    return { initialize: (c) => m.initialize(c), parse: (t) => m.parse(t), render: async (id) => ({ svg: `<svg id="${id}"></svg>` }) };
  };

  test("a valid diagram renders to SVG", async () => {
    const fake: MermaidLike = { initialize: () => {}, parse: async () => true, render: async (id) => ({ svg: `<svg id="${id}"></svg>` }) };
    const r = await renderDiagram("flowchart TD\n  A[Idea] --> B[Plan]", { dark: true, load: async () => fake });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.svg).toContain("<svg");
  });

  test("an invalid diagram falls back with Mermaid's error instead of throwing", async () => {
    const r = await renderDiagram("flowchart TD\n  A -->", { dark: false, load: withRender });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/parse error/i);
  });

  test("empty diagrams and a failed Mermaid load also fall back", async () => {
    expect((await renderDiagram("  ", { dark: false, load: withRender })).ok).toBe(false);
    const r = await renderDiagram("flowchart TD\n A-->B", { dark: false, load: () => Promise.reject(new Error("chunk failed")) });
    expect(r.ok === false && r.error).toBe("chunk failed");
  });

  test("Mermaid is initialized strict, with the current theme", async () => {
    const seen: Record<string, unknown>[] = [];
    const fake: MermaidLike = { initialize: (c) => seen.push(c), parse: async () => true, render: async () => ({ svg: "<svg/>" }) };
    await renderDiagram("graph TD; A-->B", { dark: true, load: async () => fake });
    expect(seen[0]).toMatchObject({ securityLevel: "strict", theme: "dark", startOnLoad: false });
    await renderDiagram("graph TD; A-->B", { dark: true, theme: { primaryColor: "#111111" }, load: async () => fake });
    expect(seen[1]).toMatchObject({ theme: "base", themeVariables: { primaryColor: "#111111" }, htmlLabels: false, flowchart: { useMaxWidth: false, curve: "basis" } });
  });

  test("Mermaid uses dagre and diagrams can't switch to the unshipped ELK layout", async () => {
    const seen: Record<string, any>[] = [];
    const fake: MermaidLike = { initialize: (c) => seen.push(c), parse: async () => true, render: async () => ({ svg: "<svg/>" }) };
    await renderDiagram("graph TD; A-->B", { dark: false, load: async () => fake });
    expect(seen[0].layout).toBe("dagre");
    expect(seen[0].state.layout).toBe("dagre");
    expect(seen[0].secure).toEqual(expect.arrayContaining(["layout", "securityLevel"]));
  });
});

// ------------------------------------------------------------------ server

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  return dir;
}

async function serve(store: Store) {
  const server = new GrilladoServer({ adapters: [], store, webDir: webDir(), port: 0, strictPort: true });
  servers.push(server);
  await server.listen();
  const call = (method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.port, method, path: p, headers: { "x-grillado-token": server.token, "content-type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode!, json: res.headers["content-type"]?.includes("json") ? JSON.parse(data) : data }));
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { server, call };
}

/** A plated session on disk, as synthesis leaves it. */
function platedStore() {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const s = createSession({ idea: "Recipe app", provider: "claude" });
  s.decisions = {
    platform: { key: "platform", round: 1, title: "Platform", label: "Platform", answer: "Web", accepted_recommendation: true, kind: "option", dependsOn: [] } as any,
  };
  s.status = "plated";
  const file = store.writePlan(s.id, PLAN);
  s.plan = { title: "Recipe app", markdown: PLAN, path: file, openDecisions: [], createdAt: new Date().toISOString() };
  store.save(s);
  return { store, id: s.id, file };
}

describe("plan save endpoint", () => {
  test("saves the exact text to plan.md and session.json; survives a restart", async () => {
    const { store, id, file } = platedStore();
    const { call } = await serve(store);
    const edited = PLAN.replace("## Scope", "## Scope\n\nAdded by hand, ünïcödé, keeps [R1:platform].");
    const r = await call("POST", `/api/sessions/${id}/plan`, { markdown: edited });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(store.load(id)!.plan!.markdown).toBe(edited);
    expect(store.load(id)!.plan!.editedAt).toBeTruthy();

    const again = await serve(store);
    const s = await again.call("GET", `/api/sessions/${id}`);
    expect(s.json.plan.markdown).toBe(edited);
    expect((await again.call("GET", `/api/sessions/${id}/plan.md`)).status).toBe(200);
  });

  test("plan.md edited by hand while Grillado was down wins on load", async () => {
    const { store, id, file } = platedStore();
    writeFileSync(file, `${PLAN}\nEdited in vim.\n`);
    const { call } = await serve(store);
    expect((await call("GET", `/api/sessions/${id}`)).json.plan.markdown).toBe(`${PLAN}\nEdited in vim.\n`);
  });

  test("rejects non-text, oversized and not-yet-plated saves", async () => {
    const { store, id, file } = platedStore();
    const { call } = await serve(store);
    expect((await call("POST", `/api/sessions/${id}/plan`, { markdown: 42 })).status).toBe(400);
    expect((await call("POST", `/api/sessions/${id}/plan`, { markdown: "x".repeat(600_000) })).status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(PLAN);
    const s = createSession({ idea: "x", provider: "claude" });
    expect(() => editPlan(s, "# nope")).toThrow("no plan");
  });

  test("reopening an edited plan keeps the edited copy next to the new one", async () => {
    const { store, id } = platedStore();
    const { call } = await serve(store);
    await call("POST", `/api/sessions/${id}/plan`, { markdown: `${PLAN}\nMy notes.\n` });
    await call("POST", `/api/sessions/${id}/reopen`, { key: "platform" });
    const dir = store.sessionDir(id);
    const kept = readdirSync(dir).filter((f) => f.startsWith("plan.edited-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(dir, kept[0]), "utf8")).toContain("My notes.");
  });
});

