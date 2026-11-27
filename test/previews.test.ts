// Option previews ("See before you choose"): the limits and rules for a question's previews, what
// a round keeps, "Show me another", what the saved plan gets, and the server end to end with the
// fake agent CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { buildAnotherPrompt } from "../src/core/engine.ts";
import { MAX_OPTIONS, PREVIEW_LIMITS, QUESTION_PREVIEW_BYTES, type RawPreview, chosenPreviews, previewIssue, previewProblem, questionPreviewIssue, settlePreviews, uiAdvice } from "../src/core/previews.ts";
import { roundSystemPrompt } from "../src/core/prompts.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { AnotherOptionReplySchema, RoundReplySchema, anotherOptionJsonSchema, roundJsonSchema } from "../src/core/schema.ts";
import { addOption, anotherQuestion, applyRound, createSession, renderPlanMarkdown, submitAnswers } from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const NONE: RawPreview = { kind: "none", lang: "", source: "" };
const ui = (source = "<p>List</p>"): RawPreview => ({ kind: "ui", lang: "", source });
const code = (source = "list.add()"): RawPreview => ({ kind: "code", lang: "TS", source });
const DIAGRAM = 'flowchart LR\n  accTitle: Save\n  accDescr: How an item is saved.\n  A["New"] --> B["Saved"]';
const diagram = (source = DIAGRAM): RawPreview => ({ kind: "diagram", lang: "", source });
const opt = (id: string, preview: RawPreview = NONE) => ({ id, label: `Option ${id}`, description: "", preview });
const question = (key: string, previews: RawPreview[]) => ({
  key,
  label: key,
  title: `Question ${key}?`,
  body: "",
  options: previews.map((p, i) => opt("abcdef"[i], p)),
  recommendedOptionId: "a",
  dependsOn: [],
});
const reply = (...questions: ReturnType<typeof question>[]) => ({ type: "ask_round" as const, summary: "s", questions, upcoming: [] });

describe("one preview", () => {
  test("each kind has its limit, at and over", () => {
    expect(PREVIEW_LIMITS).toEqual({ ui: { bytes: 32768 }, code: { bytes: 16384, lines: 200 }, diagram: { bytes: 16384, lines: 150 } });
    expect(previewIssue(ui("x".repeat(32768)))).toBeNull();
    expect(previewIssue(ui("x".repeat(32769)))).toContain("32 KiB");
    // Bytes, not characters.
    expect(previewIssue(ui("é".repeat(16385)))).toContain("32 KiB");
    expect(previewIssue(code(Array(200).fill("x").join("\n")))).toBeNull();
    expect(previewIssue(code(Array(201).fill("x").join("\n")))).toBe("keep it under 200 lines");
    expect(previewIssue(code("x".repeat(16385)))).toContain("16 KiB");
    expect(previewIssue(diagram())).toBeNull();
    expect(previewIssue(diagram("graph TD\n A-->B"))).toContain("flowchart");
    expect(previewIssue(code(), "ui")).toContain('"ui" preview');
  });

  test("a UI preview's scripts and network references are called out, not refused", () => {
    expect(uiAdvice("<style>p{color:red}</style><p>ok</p>")).toBeNull();
    expect(uiAdvice("<SCRIPT>alert(1)</script>")).toContain("scripts");
    expect(uiAdvice('<img src="https://x.test/a.png">')).toContain("network");
    expect(uiAdvice("<p style='background:url(//x.test/a)'>")).toContain("network");
    expect(uiAdvice('<link rel="stylesheet" href="a.css">')).toContain("stylesheets");
    expect(uiAdvice('<meta http-equiv="refresh" content="0">')).toContain("documents");
  });
});

describe("a question's previews", () => {
  test("none is fine; with previews, every option needs one of the same kind", () => {
    expect(questionPreviewIssue(question("q", [NONE, NONE]))).toBeNull();
    expect(questionPreviewIssue(question("q", [ui(), ui(), ui()]))).toBeNull();
    expect(questionPreviewIssue(question("q", [ui(), NONE]))).toContain('option "b": every option of a question with previews needs a "ui" preview');
    expect(questionPreviewIssue(question("q", [code(), diagram()]))).toContain('use a "code" preview');
    expect(questionPreviewIssue(question("q", [ui("<script>1</script>"), ui()]))).toContain("scripts");
    const big = ui("x".repeat(32000));
    expect(questionPreviewIssue({ key: "q", options: Array.from({ length: 9 }, (_, i) => opt(String(i), big)) })).toContain("together are over 256 KiB");
    expect(QUESTION_PREVIEW_BYTES).toBe(256 * 1024);
    expect(previewProblem([question("ok", [NONE, NONE]), question("bad", [ui(), NONE])])).toContain('"bad"');
  });

  test("settling keeps the usable ones and leaves the rest as text options", () => {
    const qs = [question("all", [code(), code()]), question("some", [ui(), ui("x".repeat(40000)), diagram()]), question("none", [NONE, NONE]), question("broken", [diagram("nope"), NONE])];
    settlePreviews(qs);
    expect(qs[0].options.map((o) => o.preview)).toEqual([{ kind: "code", source: "list.add()", lang: "ts" }, { kind: "code", source: "list.add()", lang: "ts" }] as any);
    expect(qs[1].options.map((o: any) => [o.preview?.kind, o.previewFailed])).toEqual([["ui", undefined], [undefined, true], [undefined, true]]);
    // No usable preview at all: a plain text question, with nothing marked.
    for (const q of [qs[2], qs[3]]) expect(q.options.every((o: any) => !("preview" in o) && !("previewFailed" in o))).toBe(true);
  });

  test("a UI preview with a script is kept: the frame it is shown in never runs it", () => {
    const qs = [question("q", [ui("<script>1</script><p>a</p>"), ui()])];
    settlePreviews(qs);
    expect(qs[0].options[0].preview).toMatchObject({ kind: "ui" });
  });
});

describe("the reply shapes", () => {
  test("an option without a preview, or with a malformed one, parses as none", () => {
    const bare = { type: "ask_round", summary: "s", upcoming: [], questions: [{ key: "q", label: "Q", title: "Q?", body: "", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "", preview: { kind: "video" } }], recommendedOptionId: "a", dependsOn: [] }] };
    const parsed = RoundReplySchema.parse(bare);
    expect(parsed.questions[0].options.map((o) => o.preview)).toEqual([NONE, NONE]);
  });

  test("the strict schemas require the preview on every option", () => {
    const option = (roundJsonSchema() as any).properties.questions.items.properties.options.items;
    expect(option.required).toEqual(["id", "label", "description", "preview"]);
    expect(option.properties.preview.required).toEqual(["kind", "lang", "source"]);
    expect((anotherOptionJsonSchema() as any).required).toEqual(["type", "label", "description", "preview"]);
    expect(AnotherOptionReplySchema.safeParse({ type: "option", label: "x", description: "", preview: ui() }).success).toBe(true);
  });

  test("the round prompt says when and how to give previews, with and without reading", () => {
    for (const read of [false, true]) {
      const p = roundSystemPrompt({ read });
      expect(p).toContain("give every option of that question a \"preview\", all of the same kind");
      expect(p).toContain('"preview":{"kind":"none"|"ui"|"code"|"diagram","lang":"","source":""}');
      expect(p).toContain("at most 32 KiB");
    }
  });
});

describe("in the session", () => {
  const session = () => {
    const s = createSession({ idea: "A shopping list", provider: "claude" });
    applyRound(s, reply(question("look", [ui("<p>Rows</p>"), ui("<p>Cards</p>")]), question("plain", [NONE, NONE])) as any);
    return s;
  };

  test("Show me another appends to an open question with previews, up to six options", () => {
    const s = session();
    expect(() => anotherQuestion(s, "plain")).toThrow("no previews");
    expect(() => anotherQuestion(s, "gone")).toThrow("isn’t open");
    for (let n = 3; n <= MAX_OPTIONS; n++) {
      const o = addOption(s, "look", { label: `Option ${n}`, description: "", preview: { kind: "ui", source: `<p>${n}</p>` } });
      expect(o).toMatchObject({ id: `more-${n}`, added: true });
    }
    expect(s.rounds[0].questions[0].options).toHaveLength(6);
    expect(() => anotherQuestion(s, "look")).toThrow("at most 6 options");
    // An added option is answered like any other.
    submitAnswers(s, 1, [{ questionId: "look", optionId: "more-4", accepted_recommendation: false }, { questionId: "plain", optionId: "a", accepted_recommendation: true }]);
    expect(s.decisions.look.answer).toBe("Option 4");
    expect(() => anotherQuestion(s, "look")).toThrow("isn’t open");
  });

  test("the prompt for another option carries the question, its options and their previews", () => {
    const s = session();
    const p = buildAnotherPrompt(s, anotherQuestion(s, "look"));
    const asked = JSON.parse([...p.matchAll(/<state>(.*?)<\/state>/gs)][1][1]);
    expect(asked).toMatchObject({ key: "look", previewKind: "ui", options: [{ label: "Option a", preview: "<p>Rows</p>" }, { label: "Option b" }] });
    expect(p).toContain('with a "ui" preview');
  });

  test("the saved plan carries the source of each chosen preview, fenced by kind", () => {
    const s = createSession({ idea: "A shopping list", provider: "claude" });
    applyRound(s, reply(question("look", [ui("<p>Rows</p>"), ui("<p>Cards</p>")]), question("api", [code("a()\n```\nb()"), code()]), question("flow", [diagram(), diagram()]), question("plain", [NONE, NONE])) as any);
    submitAnswers(s, 1, [
      { questionId: "look", optionId: "b", accepted_recommendation: false },
      { questionId: "api", optionId: "a", accepted_recommendation: true },
      { questionId: "flow", optionId: "a", accepted_recommendation: true },
      { questionId: "plain", optionId: "a", accepted_recommendation: true },
    ]);
    const md = renderPlanMarkdown(s, { type: "plan", title: "List", markdown: "## Problem\nx [R1:look]", decisions: [], openDecisions: [] });
    const section = md.slice(md.indexOf("## Chosen previews"), md.indexOf("## More decisions"));
    expect(section).toContain("### look: Option b\n\n```html\n<p>Cards</p>\n```");
    // A source with a fence of its own gets a longer one.
    expect(section).toContain("### api: Option a\n\n````ts\na()\n```\nb()\n````");
    expect(section).toContain(`### flow: Option a\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
    expect(section).not.toContain("plain");
    expect(section).not.toContain("<p>Rows</p>");
    expect(chosenPreviews([])).toEqual([]);
  });
});

// ---------------------------------------------------------------- the server, end to end

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function request(port: number, token: string, method: string, p: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function start(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-prev-"));
  const log = path.join(dir, "calls.jsonl");
  const ctl = path.join(dir, "ctl.json");
  writeFileSync(ctl, "{}");
  const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Grillado</title>");
  const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_LOG: log, FAKE_CTL: ctl, ...extra });
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: web, port: 0, strictPort: true });
  servers.push(server);
  await server.detect();
  await server.listen();
  const api = (method: string, p: string, body?: unknown) => request(server.port, server.token, method, p, body);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "--version");
  const created = await api("POST", "/api/sessions", { idea: "A shopping list" });
  const id = created.json.id as string;
  const get = async () => (await api("GET", `/api/sessions/${id}`)).json;
  const idle = (status: string) => waitFor(async () => { const s = await get(); return !s.busy && s.status === status ? s : undefined; });
  const settled = () => waitFor(async () => { const s = await get(); return s.anotherRun && s.anotherRun.state !== "running" ? s : undefined; });
  return { api, calls, store, id, get, idle, settled, ctl: (o: Record<string, string>) => writeFileSync(ctl, JSON.stringify(o)) };
}

const platform = (s: any) => s.rounds.at(-1).questions.find((q: any) => q.key === "platform");

describe("server: rounds with previews", () => {
  test("a round keeps each kind of preview on its options, and plain questions stay plain", async () => {
    for (const kind of ["ui", "code", "diagram"] as const) {
      const { idle, calls } = await start({ FAKE_PREVIEWS: kind });
      const s = await idle("answering");
      expect(platform(s).options.map((o: any) => o.preview.kind)).toEqual([kind, kind, kind]);
      expect(s.rounds[0].questions.find((q: any) => q.key === "scope").options.every((o: any) => !o.preview && !o.previewFailed)).toBe(true);
      if (kind === "code") expect(platform(s).options[0].preview.lang).toBe("ts");
      expect(calls()).toHaveLength(1);
    }
  });

  test("a preview over its limit gets the one repair pass", async () => {
    const { idle, calls } = await start({ FAKE_PREVIEWS: "big-once" });
    const s = await idle("answering");
    expect(platform(s).options.every((o: any) => o.preview?.kind === "ui")).toBe(true);
    // The second call is the repair pass, with what was wrong fed back.
    expect(calls()).toHaveLength(2);
    expect(calls()[1].promptBytes).toBeGreaterThan(calls()[0].promptBytes);
  });

  test("a preview that still can't be shown leaves its option answerable as text", async () => {
    const { idle, api, id, calls } = await start({ FAKE_PREVIEWS: "partial" });
    const s = await idle("answering");
    expect(calls()).toHaveLength(2);
    expect(platform(s).options.map((o: any) => [!!o.preview, !!o.previewFailed])).toEqual([[true, false], [false, true], [true, false]]);
    const answers = s.rounds[0].questions.map((q: any) => ({ questionId: q.key, optionId: q.key === "platform" ? "mobile" : q.recommendedOptionId, accepted_recommendation: false }));
    expect((await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers })).status).toBe(200);
    expect((await idle("answering")).decisions.platform.answer).toBe("Mobile app");
  });
});

describe("server: Show me another", () => {
  test("one agent call appends one option, kept across a restart of the session view, up to six", async () => {
    const { idle, api, id, calls, settled, store } = await start({ FAKE_PREVIEWS: "code" });
    await idle("answering");
    expect((await api("POST", `/api/sessions/${id}/another`, { key: "scope" })).json.error).toBe("That question has no previews.");
    const r = await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
    expect(r.json.anotherRun).toMatchObject({ question: "platform", state: "running" });
    let s = await settled();
    expect(s.anotherRun.state).toBe("done");
    expect(calls()).toHaveLength(2);
    expect(platform(s).options.at(-1)).toMatchObject({ id: "more-4", label: "Option 4", added: true, preview: { kind: "code", lang: "ts" } });
    // Saved with the session.
    expect(store.load(id)!.rounds[0].questions[1].options).toHaveLength(4);
    for (const n of [5, 6]) {
      await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
      s = await waitFor(async () => { const x = await (await api("GET", `/api/sessions/${id}`)).json; return platform(x).options.length === n && x.anotherRun.state === "done" ? x : undefined; });
    }
    expect((await api("POST", `/api/sessions/${id}/another`, { key: "platform" })).json.error).toBe("A question holds at most 6 options.");
    // The run shows in Activity.
    const activity = (await api("GET", `/api/sessions/${id}/activity`)).json;
    expect(activity.entries.filter((e: any) => e.kind === "option").map((e: any) => [e.status, e.target.decision])).toEqual(Array(3).fill(["done", "Start on the web?"]));
  });

  test("a failed request leaves the options as they were, says why, and can be tried again", async () => {
    const { idle, api, id, settled, ctl, calls } = await start({ FAKE_PREVIEWS: "ui" });
    await idle("answering");
    ctl({ FAKE_ANOTHER: "fail" });
    await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
    let s = await settled();
    expect(s.anotherRun).toMatchObject({ question: "platform", state: "error", code: "malformed" });
    expect(platform(s).options).toHaveLength(3);
    // One call, one repair pass.
    expect(calls()).toHaveLength(3);
    ctl({ FAKE_ANOTHER: "dup" });
    await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
    s = await waitFor(async () => { const x = await (await api("GET", `/api/sessions/${id}`)).json; return calls().length === 5 && x.anotherRun.state !== "running" ? x : undefined; });
    expect(s.anotherRun.state).toBe("error");
    ctl({ FAKE_ANOTHER: "" });
    await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
    s = await waitFor(async () => { const x = await (await api("GET", `/api/sessions/${id}`)).json; return x.anotherRun.state === "done" ? x : undefined; });
    expect(platform(s).options).toHaveLength(4);
  });

  test("sending the round stops a request still on its way", async () => {
    const { idle, api, id, get } = await start({ FAKE_PREVIEWS: "ui", FAKE_ANOTHER_DELAY_MS: "1500" });
    const s = await idle("answering");
    await api("POST", `/api/sessions/${id}/another`, { key: "platform" });
    const answers = s.rounds[0].questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers });
    const after = await idle("answering");
    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[0].questions[1].options).toHaveLength(3);
    expect((await get()).anotherRun.state).toBe("stopped");
  });
});
