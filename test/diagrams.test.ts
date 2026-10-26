// "Add diagrams" (v1.1 item 5): sections, the Mermaid check, block suggestions, the run route.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { pruneSuggestions, review, undoReview } from "../src/core/comments.ts";
import { accOf, addDiagramSuggestion, checkMermaid, describeDiagram, formatDuration, planSections, suggestedCode } from "../src/core/diagrams.ts";
import { buildDiagramPrompt } from "../src/core/engine.ts";
import { promptFragments } from "../src/core/prompts.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { createSession } from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";
import { fitDiagram, zoomStep } from "../web/src/app/editor/diagram.ts";

const FLOW = `flowchart TD
  accTitle: Sync flow
  accDescr: How an edit reaches every phone.
  A[Edit] --> B{Online?}
  B -- yes --> C[Send now]
  B -->|no| D[Queue]`;

const PLAN = `# Shopping list

## Problem
Families lose track of the list.

## Sync
- Edits queue offline
- Last edit wins [R2:sync]

\`\`\`decision
id: R2·1
key: sync
question: Sync across devices?
answer: Yes
\`\`\`

## Platform
Web first.

\`\`\`mermaid
flowchart LR
  accTitle: Old
  accDescr: Old one.
  A --> B
\`\`\`
`;

function plated(md = PLAN) {
  const s = createSession({ idea: "Shopping list", provider: "claude" });
  s.status = "plated";
  s.plan = { title: "Shopping list", markdown: md, path: "", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}

describe("sections", () => {
  test("H2 sections, the last block as the anchor, and an existing diagram", () => {
    const [p, sync, plat] = planSections(PLAN);
    expect([p.title, sync.title, plat.title]).toEqual(["Problem", "Sync", "Platform"]);
    expect(p.anchor).toBe("Families lose track of the list.");
    // A fence with blank lines inside stays one block.
    expect(sync.anchor.startsWith("```decision") && sync.anchor.endsWith("```")).toBe(true);
    expect(PLAN.slice(sync.anchorAt, sync.anchorAt + sync.anchor.length)).toBe(sync.anchor);
    expect(sync.diagram).toBeUndefined();
    expect(plat.diagram?.text.startsWith("```mermaid\nflowchart LR")).toBe(true);
  });
  test("a ## inside a fence is not a section", () => {
    expect(planSections("## A\nx\n\n```\n## not\n```\n").map((x) => x.title)).toEqual(["A"]);
  });
});

describe("the Mermaid check (#43)", () => {
  test("passes a good flowchart and state diagram", () => {
    expect(checkMermaid(FLOW)).toBeNull();
    expect(checkMermaid("stateDiagram-v2\n  direction LR\n  accTitle: T\n  accDescr: D\n  [*] --> Idle\n  Idle --> Busy: go")).toBeNull();
  });
  test("names what is wrong", () => {
    expect(checkMermaid("graph TD\nA-->B")).toContain("start with");
    expect(checkMermaid(FLOW, ["state"])).toContain("state diagram only");
    expect(checkMermaid(FLOW.replace(/  accTitle.*\n/, ""))).toContain("accTitle");
    expect(checkMermaid(`${FLOW}\n  style A fill:#f00`)).toContain("no style");
    expect(checkMermaid(`${FLOW}\n%%{init: {}}%%`)).toContain("no style");
    expect(checkMermaid(FLOW.replace("B{Online?}", "B{Online?"))).toContain("{} shape is not closed");
    expect(checkMermaid("stateDiagram-v2\n  accTitle: T\n  accDescr: D\n  A --> B")).toContain("direction LR");
  });
  test("caption and kind come from the source", () => {
    expect(accOf(FLOW)).toEqual({ title: "Sync flow", descr: "How an edit reaches every phone." });
  });
});

describe("block suggestions", () => {
  test("insert lands after the section's last block; accept, undo, prune", () => {
    const s = plated();
    const sync = planSections(PLAN)[1];
    const x = addDiagramSuggestion(s, sync, FLOW);
    expect(x).toMatchObject({ kind: "diagram", section: "Sync", status: "pending" });
    expect(suggestedCode(x)).toBe(FLOW);
    review(s, "accept", [x.id]);
    expect(s.plan!.markdown).toContain(`${sync.anchor}\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n## Platform`);
    // The anchor is a decision fence: diagram suggestions are found with fences counted.
    expect(undoReview(s)).toEqual({ ids: [x.id] });
    expect(s.plan!.markdown).toBe(PLAN);
  });
  test("replacing a section's diagram swaps the fence", () => {
    const s = plated();
    const x = addDiagramSuggestion(s, planSections(PLAN)[2], FLOW);
    expect(x.replace).toBe(true);
    review(s, "accept", [x.id]);
    expect(s.plan!.markdown).not.toContain("accTitle: Old");
    expect(s.plan!.markdown.trimEnd().endsWith(`\`\`\`mermaid\n${FLOW}\n\`\`\``)).toBe(true);
  });
  test("a hand edit under the anchor drops it and counts it as skipped", () => {
    const s = plated();
    s.diagramRun = { state: "done", startedAt: "", sections: ["Problem"], kinds: ["flowchart"], done: 1, added: 1, skipped: 0 };
    addDiagramSuggestion(s, planSections(PLAN)[0], FLOW);
    s.plan!.markdown = PLAN.replace("lose track of", "forget");
    expect(pruneSuggestions(s)).toBe(1);
    expect(s.diagramRun.skipped).toBe(1);
  });
});

describe("text view and formatting", () => {
  test("describeDiagram lists shapes and arrows with labels", () => {
    const d = describeDiagram(FLOW);
    expect(d.kind).toBe("flowchart");
    expect(d.shapes).toEqual(["Edit", "Online?", "Send now", "Queue"]);
    expect(d.edges).toEqual([
      { from: "Edit", to: "Online?" },
      { from: "Online?", to: "Send now", label: "yes" },
      { from: "Online?", to: "Queue", label: "no" },
    ]);
    const st = describeDiagram('stateDiagram-v2\n  direction LR\n  state "Waiting for net" as W\n  [*] --> W\n  W --> Sent: online\n  Sent --> [*]');
    expect(st.edges).toEqual([{ from: "Start", to: "Waiting for net" }, { from: "Waiting for net", to: "Sent", label: "online" }, { from: "Sent", to: "End" }]);
  });
  test("durations read '4.2 s' (§18 B)", () => {
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(75_000)).toBe("1 min 15 s");
  });
  test("the prompt sends the section, its kinds and the focus; the prompt text is guarded", () => {
    const sec = planSections(PLAN)[1];
    const p = buildDiagramPrompt(PLAN, sec, ["flowchart"], "what happens offline");
    expect(p).toContain('"section":"Sync"');
    expect(p).toContain("focus on: what happens offline");
    expect(promptFragments().some((f) => f.includes("Never use style, classDef"))).toBe(true);
  });
});

describe("diagrams route", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  async function serve(extra: Record<string, string> = {}) {
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const s = plated();
    s.plan!.path = store.writePlan(s.id, PLAN);
    store.save(s);
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    mkdirSync(path.join(web, "assets"));
    const env = { ...fakeEnv(fakeBinDir(["claude"])), ...extra };
    const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: web, port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const call = (method: string, p: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, method, path: `/api/sessions/${s.id}${p}`, headers: { "x-grillado-token": server.token, "content-type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(data) }));
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const settle = async () => {
      for (let i = 0; i < 300; i++) {
        const v = (await call("GET", "")).json;
        if (v.diagramRun && v.diagramRun.state !== "running") return v;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("run never finished");
    };
    return { call, settle, file: s.plan!.path };
  }

  test("sections → one suggestion per drawn section, skips counted; accept writes plan.md", async () => {
    const { call, settle, file } = await serve({ FAKE_DIAGRAM: "bad-once" });
    const r = await call("POST", "/diagrams", { sections: ["Problem", "Sync"], kinds: ["flowchart", "state"] });
    expect(r.status).toBe(200);
    expect(r.json.drawing).toBe(true);
    // One run at a time.
    expect((await call("POST", "/diagrams", { sections: ["Sync"] })).json.error).toContain("already adding diagrams");
    const v = await settle();
    expect(v.diagramRun).toMatchObject({ state: "done", done: 2, added: 1, skipped: 1 });
    expect(v.diagramRun.ms).toBeGreaterThan(0);
    const x = v.suggestions.find((y: any) => y.kind === "diagram");
    expect(x.section).toBe("Sync");
    expect(checkMermaid(suggestedCode(x))).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(PLAN);
    await call("POST", "/suggestions", { op: "accept", ids: "all" });
    expect(readFileSync(file, "utf8")).toContain("```\n\n```mermaid\nflowchart TD\n  accTitle: Sync flow");
  });

  test("the slash menu's one-section run, and drop from the browser counts as skipped", async () => {
    const { call, settle } = await serve();
    await call("POST", "/diagrams", { op: "one", at: PLAN.indexOf("Last edit wins") });
    let v = await settle();
    expect(v.diagramRun).toMatchObject({ sections: ["Sync"], added: 1 });
    const id = v.suggestions[0].id;
    v = (await call("POST", "/suggestions", { op: "drop", id })).json;
    expect(v.suggestions).toEqual([]);
    expect(v.diagramRun).toMatchObject({ added: 0, skipped: 1 });
  });

  test("an agent failure stops the run; Try again picks up the rest", async () => {
    const { call, settle } = await serve({ FAKE_DIAGRAM: "fail" });
    await call("POST", "/diagrams", { sections: ["Sync", "Platform"] });
    const v = await settle();
    expect(v.diagramRun).toMatchObject({ state: "error", done: 1, added: 1 });
    expect(v.diagramRun.message).toBeTruthy();
    expect((await call("POST", "/diagrams", { op: "retry" })).json.diagramRun.sections).toEqual(["Platform"]);
  });

  test("needs a section and a kind", async () => {
    const { call } = await serve();
    expect((await call("POST", "/diagrams", { sections: [] })).json.error).toContain("section");
    expect((await call("POST", "/diagrams", { sections: ["Sync"], kinds: [] })).json.error).toContain("kind");
  });
});

describe("diagram sizing and zoom (§6.3, §7)", () => {
  test("fits the column at natural size", () => {
    expect(fitDiagram({ w: 600, h: 300 }, { col: 680, wide: 820 })).toEqual({ scale: 1, breakout: false, crop: false });
  });
  test("breaks out to 820, then scales to the floor, then crops", () => {
    expect(fitDiagram({ w: 800, h: 300 }, { col: 680, wide: 820 })).toEqual({ scale: 1, breakout: true, crop: false });
    expect(fitDiagram({ w: 900, h: 300 }, { col: 680, wide: 820 }).scale).toBeCloseTo(820 / 900);
    expect(fitDiagram({ w: 1400, h: 300 }, { col: 680, wide: 820 })).toEqual({ scale: 0.85, breakout: true, crop: true });
  });
  test("too tall crops; phones always fit the width", () => {
    expect(fitDiagram({ w: 400, h: 900 }, { col: 680, wide: 820 }).crop).toBe(true);
    expect(fitDiagram({ w: 1400, h: 900 }, { col: 350, wide: 350, fit: true })).toEqual({ scale: 0.25, breakout: false, crop: false });
  });
  test("zoom steps through 50–300% and stops at the ends", () => {
    expect(zoomStep(100, 1)).toBe(150);
    expect(zoomStep(87, 1)).toBe(100);
    expect(zoomStep(87, -1)).toBe(75);
    expect(zoomStep(300, 1)).toBe(300);
    expect(zoomStep(50, -1)).toBe(50);
  });
});
