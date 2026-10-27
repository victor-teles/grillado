// #97: streamed comment replies, Claude Code only. The partial JSON reader, Claude's stream reader,
// the guard that keeps banned text off screen, and the adapters end to end with the fake CLIs.
import { describe, expect, test } from "bun:test";
import { commentSystemPrompt } from "../src/core/prompts.ts";
import { CommentReplySchema, commentJsonSchema } from "../src/core/schema.ts";
import { runValidated } from "../src/core/engine.ts";
import { StreamGuard } from "../src/core/stream-guard.ts";
import { promptFragments } from "../src/core/prompts.ts";
import { SPECS, claudeStreamReader, createAdapters } from "../src/core/providers/adapters.ts";
import { partialStringField } from "../src/core/providers/partial-json.ts";
import type { ProviderAdapter, ProviderEvent, RunFiles, RunRequest } from "../src/core/providers/types.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

describe("partialStringField", () => {
  const full = JSON.stringify({ type: "reply", n: [1, { a: "}" }], text: 'Say "hi"\nthen go ✓ 🙂.' });
  test("every prefix gives a prefix of the final text, and the whole gives all of it", () => {
    const want = 'Say "hi"\nthen go ✓ 🙂.';
    let last = "";
    for (let i = 0; i <= full.length; i++) {
      const v = partialStringField(full, "text") ?? "";
      const got = partialStringField(full.slice(0, i), "text") ?? "";
      expect(want.startsWith(got)).toBe(true);
      expect(got.length >= last.length).toBe(true);
      last = got;
      expect(v).toBe(want);
    }
    expect(last).toBe(want);
  });
  test("escapes and surrogate pairs wait until complete", () => {
    expect(partialStringField('{"text":"a\\', "text")).toBe("a");
    expect(partialStringField('{"text":"a\\u00', "text")).toBe("a");
    expect(partialStringField('{"text":"a\\u00e9', "text")).toBe("aé");
    expect(partialStringField('{"text":"\\ud83d', "text")).toBe("");
    expect(partialStringField('{"text":"\\ud83d\\ude42', "text")).toBe("🙂");
  });
  test("other fields, nested values and missing fields", () => {
    expect(partialStringField('{"type":"rep', "text")).toBeUndefined();
    expect(partialStringField('{"type":"reply","text', "text")).toBeUndefined();
    expect(partialStringField('{"type":"reply","text":', "text")).toBeUndefined();
    expect(partialStringField('{"type":"reply","text":"', "text")).toBe("");
    expect(partialStringField('{"x":{"text":"no"},"text":"yes', "text")).toBe("yes");
    expect(partialStringField('{"text":5}', "text")).toBeUndefined();
    expect(partialStringField("not json", "text")).toBeUndefined();
  });
});

const se = (event: object) => JSON.stringify({ type: "stream_event", event });
const so = (index: number) => se({ type: "content_block_start", index, content_block: { type: "tool_use", name: "StructuredOutput", id: "t" } });
const dj = (index: number, partial_json: string) => se({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });

describe("claudeStreamReader", () => {
  test("only the StructuredOutput call's field streams; text blocks and other lines are ignored", () => {
    const read = claudeStreamReader("text");
    const out: ProviderEvent[] = [];
    for (const l of [
      '{"type":"system","subtype":"init"}',
      se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here you go" } }),
      so(1),
      dj(1, '{"type":"re'),
      dj(1, 'ply","text":"Good'),
      dj(1, " catch."),
      dj(1, '"}'),
      se({ type: "content_block_stop", index: 1 }),
      "garbage",
    ])
      out.push(...read(l));
    expect(out).toEqual([
      { type: "text-delta", text: "Good" },
      { type: "text-delta", text: " catch." },
    ]);
  });
  test("a second StructuredOutput call starts the text over", () => {
    const read = claudeStreamReader("text");
    const out = [so(1), dj(1, '{"text":"first'), so(3), dj(3, '{"text":"second')].flatMap(read);
    expect(out).toEqual([{ type: "text-delta", text: "first" }, { type: "text-reset" }, { type: "text-delta", text: "second" }]);
  });
});

const files: RunFiles = { dir: "/r", systemPromptFile: "/r/s.md", promptFile: "/r/p.md", schemaFile: "/r/x.json", outputFile: "/r/o.json" };
const req: RunRequest = { kind: "comment", systemPrompt: "S", userPrompt: "U", jsonSchema: { type: "object" }, cwd: "/tmp", timeoutMs: 10_000, stream: { field: "text" } };

describe("argv", () => {
  test("Claude streams with stream-json, partial messages and verbose; everything else is the same", () => {
    expect(SPECS.claude.stream!.buildInvocation(req, files)).toEqual({
      args: [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", '{"type":"object"}', "--tools", "",
        "--permission-mode", "dontAsk", "--system-prompt-file", "/r/s.md", "--no-session-persistence",
      ],
      stdin: "U",
    });
  });
  test("no other provider streams (#97): they keep their argv and reply whole", () => {
    for (const id of ["codex", "grok", "pi"] as const) expect(SPECS[id].stream).toBeUndefined();
  });
});

async function collect(a: ProviderAdapter, r: RunRequest) {
  const evs: ProviderEvent[] = [];
  for await (const e of a.run(r, new AbortController().signal)) evs.push(e);
  return evs;
}
const commentReq = (): RunRequest => ({
  kind: "comment",
  systemPrompt: commentSystemPrompt(),
  userPrompt: `<plan>## Scope\nOne list</plan>\n<state>${JSON.stringify({ section: "Scope", quote: "One list", messages: [{ by: "user", text: "Why?" }] })}</state>`,
  jsonSchema: commentJsonSchema(),
  cwd: "/tmp",
  timeoutMs: 20_000,
  stream: { field: "text" },
});

describe("end to end with the fake CLIs", () => {
  test("Claude Code: deltas add up to the reply, then the validated result", async () => {
    const [claude] = createAdapters({ env: fakeEnv(fakeBinDir(["claude"]), { FAKE_STREAM_MS: "1" }) });
    const evs = await collect(claude, commentReq());
    const deltas = evs.filter((e) => e.type === "text-delta");
    expect(deltas.length).toBeGreaterThan(3);
    const res = evs.find((e) => e.type === "result") as { raw: { type: string; text: string } };
    expect(res.raw.type).toBe("reply");
    expect(deltas.map((e) => (e as { text: string }).text).join("")).toBe(res.raw.text);
    expect(evs.at(-1)!.type).toBe("result");
  });
  test("Codex, Grok and pi: no deltas, the whole reply at once", async () => {
    const adapters = createAdapters({ env: fakeEnv(fakeBinDir()) }).filter((a) => a.id !== "claude");
    for (const a of adapters) {
      const evs = await collect(a, commentReq());
      expect(evs.map((e) => e.type)).toEqual(["progress", "result"]);
    }
  });
  test("Claude Code errors mid-stream: the deltas so far, then the error", async () => {
    const [claude] = createAdapters({ env: fakeEnv(fakeBinDir(["claude"]), { FAKE_STREAM: "fail", FAKE_STREAM_MS: "1" }) });
    const evs = await collect(claude, commentReq());
    expect(evs.some((e) => e.type === "text-delta")).toBe(true);
    expect(evs.at(-1)!.type).toBe("error");
  });
  test("Stop mid-stream ends the run as stopped, with nothing streamed after it", async () => {
    const [claude] = createAdapters({ env: fakeEnv(fakeBinDir(["claude"]), { FAKE_STREAM: "hold", FAKE_STREAM_MS: "1" }) });
    const c = new AbortController();
    const evs: ProviderEvent[] = [];
    for await (const e of claude.run(commentReq(), c.signal)) {
      evs.push(e);
      if (e.type === "text-delta" && evs.filter((x) => x.type === "text-delta").length === 3) c.abort();
    }
    expect(evs.filter((e) => e.type === "text-delta").length).toBe(3);
    expect(evs.at(-1)).toEqual({ type: "error", code: "unknown", message: "Stopped." });
  });
});

/** A stand-in adapter that replays events, to drive runValidated's streaming. */
const scripted = (runs: ProviderEvent[][]): ProviderAdapter => {
  let n = 0;
  return {
    id: "claude",
    displayName: "Claude Code",
    bin: "claude",
    installHint: "",
    loginHint: "",
    detect: async () => ({ status: "ready", version: "1", path: "/x" }),
    async *run() {
      yield* runs[n++] ?? [];
    },
  };
};
const words = (t: string) => t.split(/(?<= )/).map((text) => ({ type: "text-delta" as const, text }));
const base = { kind: "comment" as const, systemPrompt: "S", userPrompt: "U", jsonSchema: {}, stream: { field: "text" } };
const opts = (shown: string[]) => ({ cwd: "/tmp", timeoutMs: 1000, signal: new AbortController().signal, onText: (t: string) => shown.push(t) });

describe("runValidated streaming (#97)", () => {
  test("whole words only, growing, and the final reply is the validated one", async () => {
    const shown: string[] = [];
    const text = "Good catch. A tick is yes or no.";
    const r = await runValidated(scripted([[...words(text), { type: "result", raw: { type: "reply", text } }]]), base, CommentReplySchema, () => null, opts(shown), "");
    expect(r.ok).toBe(true);
    expect(shown.at(-1)).toBe("Good catch. A tick is yes or");
    for (let i = 1; i < shown.length; i++) expect(shown[i].startsWith(shown[i - 1])).toBe(true);
  });
  test("a banned name never shows, not even its start; the retry starts the text over", async () => {
    const shown: string[] = [];
    const bad = "Per the grilling method, yes.";
    const good = "Yes, everyone can tick items off.";
    const r = await runValidated(
      scripted([
        [...bad.split("").map((text) => ({ type: "text-delta" as const, text })), { type: "result", raw: { type: "reply", text: bad } }],
        [...words(good), { type: "result", raw: { type: "reply", text: good } }],
      ]),
      base,
      CommentReplySchema,
      () => null,
      opts(shown),
      "",
    );
    expect(r).toEqual({ ok: true, value: { type: "reply", text: good } });
    expect(shown.some((t) => /gril/i.test(t))).toBe(false);
    expect(shown).toContain("Per the");
    expect(shown.indexOf("")).toBeGreaterThan(shown.indexOf("Per the"));
  });
  test("the start of one of our own instruction sentences is held back", () => {
    const f = promptFragments()[0];
    const g = new StreamGuard("");
    const shown = g.push(`Sure. ${f.slice(0, 40)} `);
    expect(shown).toBe("Sure.");
    expect(g.push(`${f.slice(40)} `)).toBe("");
    expect(g.blocked).toBe(true);
  });
  test("a word the user wrote themselves is not held back", () => {
    const g = new StreamGuard("an app for grilling recipes");
    expect(g.push("Grilling recipes, got it. ")).toBe("Grilling recipes, got it.");
  });
  test("a provider reset clears what was shown", async () => {
    const shown: string[] = [];
    await runValidated(
      scripted([[...words("first try here "), { type: "text-reset" }, ...words("second one "), { type: "result", raw: { type: "reply", text: "second one" } }]]),
      base,
      CommentReplySchema,
      () => null,
      opts(shown),
      "",
    );
    expect(shown).toEqual(["first", "first try", "first try here", "", "second", "second one"]);
  });
  test("without onText nothing asks the provider to stream", async () => {
    let got: RunRequest | undefined;
    const a: ProviderAdapter = { ...scripted([]), async *run(r) {
      got = r;
      yield { type: "result", raw: { type: "reply", text: "ok" } };
    } };
    await runValidated(a, base, CommentReplySchema, () => null, { cwd: "/tmp", timeoutMs: 1000, signal: new AbortController().signal }, "");
    expect(got?.stream).toBeUndefined();
  });
});

// Designer review of #18 (repro-guard-split.test.ts): split the reply at every chunk size 1–9 and
// every offset; no banned name may ever show, not even its first word ("Matt" before "Pocock").
describe("StreamGuard across chunk boundaries", () => {
  const split = (c: string, size: number, off: number) => [c.slice(0, off), ...Array.from({ length: Math.ceil((c.length - off) / size) }, (_, i) => c.slice(off + i * size, off + (i + 1) * size))];
  const each = (c: string, f: (shown: string[]) => void) => {
    for (let size = 1; size <= 9; size++)
      for (let off = 0; off < size; off++) {
        const g = new StreamGuard("");
        f(split(c, size, off).map((ch) => g.push(ch)));
      }
  };
  const banned = ["Good catch. Use the grill-me method to check it.", "Good catch. After grilling the plan we know more.", "Good catch. As Matt Pocock says, keep it small.", "Good catch. As Matt\nPocock says, keep it small.", "Good catch. See mattpocock on that."];
  for (const c of banned)
    test(`never shows any of “${c.replace(/\n/g, "\\n")}”'s banned name`, () => {
      each(c, (shown) => {
        for (const s of shown) expect(s).not.toMatch(/grill-|grilli|matt|pocock/i);
      });
    });
  test("a lone first word is released once the next word settles it", () => {
    each("Good catch. Matt says keep it small.", (shown) => expect(shown.at(-1)).toBe("Good catch. Matt says keep it"));
    each("Good catch. As Matt, keep it small.", (shown) => expect(shown.at(-1)).toContain("Matt, keep"));
  });
  test("skill and prompt are not banned terms: they stream as written (PO, #18)", () => {
    each("Good catch. I used the skill to check it.", (shown) => expect(shown.at(-1)).toBe("Good catch. I used the skill to check"));
    each("Good catch. The prompt says to keep it small.", (shown) => expect(shown.at(-1)).toBe("Good catch. The prompt says to keep it"));
  });
  test("a name the user typed is exempt, so it is not held", () => {
    const g = new StreamGuard("what would Matt Pocock say?");
    expect(g.push("As Matt ")).toBe("As Matt");
  });
});

// Designer review of #18, round 2: what the multi-word hold kept is let go when the stream ends
// without a next word (Stop, error), so a kept partial says "Talk to Matt", not "Talk to".
describe("StreamGuard.settle and the end of a stream", () => {
  const cut = "Good catch. Talk to Matt ";
  /** Streams `text` word by word, then waits for Stop: ends quietly, or throws, as an adapter may. */
  const stoppable = (text: string, onAbort: "end" | "throw"): ProviderAdapter => ({
    ...scripted([]),
    async *run(_req, signal) {
      yield* words(text);
      await new Promise<void>((r) => (signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true })));
      if (onAbort === "throw") throw new Error("aborted");
    },
  });
  test("settle releases a held first word, but not a partial word, a banned name or a tripped attempt", () => {
    const g = new StreamGuard("");
    expect(g.push(cut)).toBe("Good catch. Talk to");
    expect(g.settle()).toBe("Good catch. Talk to Matt");
    const p = new StreamGuard("");
    p.push("Good catch. Talk to Matt Poc");
    expect(p.settle()).toBe("Good catch. Talk to Matt"); // "Poc" is a partial word, so it stays cut
    const b = new StreamGuard("");
    b.push("Good catch. As Matt Pocock says ");
    expect(b.settle()).toBe("");
    expect(b.blocked).toBe(true);
    const gr = new StreamGuard("");
    gr.push("Good catch. Try gril");
    expect(gr.settle()).toBe("Good catch. Try");
  });
  test("an error mid-stream keeps “Matt” in the partial", async () => {
    const shown: string[] = [];
    const r = await runValidated(scripted([[...words(cut), { type: "error", code: "unknown", message: "529" }]]), base, CommentReplySchema, () => null, opts(shown), "");
    expect(r.ok).toBe(false);
    expect(shown.at(-1)).toBe("Good catch. Talk to Matt");
  });
  for (const how of ["end", "throw"] as const)
    test(`Stop keeps “Matt” in the partial (the adapter ${how === "end" ? "ends quietly" : "throws"})`, async () => {
      const shown: string[] = [];
      const c = new AbortController();
      const run = runValidated(stoppable(cut, how), base, CommentReplySchema, () => null, { ...opts(shown), signal: c.signal }, "").catch(() => null);
      await new Promise((r) => setTimeout(r, 5));
      expect(shown.at(-1)).toBe("Good catch. Talk to");
      c.abort();
      await run;
      expect(shown.at(-1)).toBe("Good catch. Talk to Matt");
    });
  test("Stop or an error never lets “As Matt Pocock” show", async () => {
    for (const text of ["Good catch. As Matt Pocock says ", "Good catch. As Matt\nPocock "]) {
      const shown: string[] = [];
      await runValidated(scripted([[...words(text), { type: "error", code: "unknown", message: "529" }]]), base, CommentReplySchema, () => null, opts(shown), "");
      const c = new AbortController();
      const s2: string[] = [];
      const run = runValidated(stoppable(text, "end"), base, CommentReplySchema, () => null, { ...opts(s2), signal: c.signal }, "");
      await new Promise((r) => setTimeout(r, 5));
      c.abort();
      await run;
      for (const s of [...shown, ...s2]) expect(s).not.toMatch(/pocock/i);
      expect(shown.at(-1)).toBe("");
      expect(s2.at(-1)).toBe("");
    }
  });
});
