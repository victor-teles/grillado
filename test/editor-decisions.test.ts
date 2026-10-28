// v1.1 editor, phase 1 behaviour: fenced decision blocks (format + validation), changing a
// decision inline (works like Reopen for its dependents), plan.md reloads after outside edits
// (auto, or a conflict when both sides changed), and the scroll-safe autosize.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { answerEdits, decisionProblems, findDecisionBlocks, parseDecisionBody, revertAnswerEdits, serializeDecision, updateDecisionBlock } from "../src/core/decision-block.ts";
import { agentNameFrom } from "../src/core/providers/base.ts";
import { type Session, OTHER_OPTION, adoptExternalPlan, answerOpenDecision, confirmExternal, dismissExternal, reaskStale, changeDecision, createSession, planAnswerEdits, renderPlanMarkdown, restateAnswer, saveAnswerEdits, swapAnswer } from "../src/core/session.ts";
import { textHash } from "../src/core/text-hash.ts";
import { passages, sentences } from "../web/src/app/editor/blocks.ts";
import { diagramLabel, explainDiagramError } from "../web/src/app/editor/diagram.ts";
import { reconcile } from "../web/src/app/editor/reconcile.ts";
import { fmt, monogram } from "../web/src/app/copy.ts";

const BLOCK = `id: R3·1
key: merge
question: How should two edits to the same item merge?
answer: Merge per item
note: Last edit wins inside an item; different items never clash.
by: you
kept_suggestion: false
at: 2026-10-22T21:14-03:00`;

describe("decision blocks (Q3)", () => {
  test("the handoff's example parses", () => {
    const p = parseDecisionBody(BLOCK);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fields).toMatchObject({ id: "R3·1", key: "merge", answer: "Merge per item", by: "you", kept_suggestion: false });
  });

  test("open decisions need no answer; settled ones do", () => {
    expect(parseDecisionBody("id: R5·3\nquestion: Backups?\nstatus: open").ok).toBe(true);
    const p = parseDecisionBody("id: R5·3\nquestion: Backups?");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.message).toContain("needs an answer");
  });

  test.each([
    ["id: R3·1\nquestion q\nanswer: a", 1, "name, a colon"],
    ["id: R3·1\nquestion: q\nquestion: again\nanswer: a", 2, "set twice"],
    ["question: q\nanswer: a", -1, "needs an id"],
    ["id: three\nquestion: q\nanswer: a", 0, "should look like R3·1"],
    ["id: R1·1\nanswer: a", -1, "needs a question"],
    ["id: R1·1\nquestion: q\nanswer: a\nkept_suggestion: yes", 3, "true or false"],
    ["id: R1·1\nquestion: q\nanswer: a\nby: robot", 3, "you or agent"],
    ["id: R1·1\nquestion: q\nanswer: a\nat: last tuesday", 3, "date and time"],
    ["id: R1·1\nquestion: q\nanswer: a\nstatus: maybe", 3, "only be “open”"],
  ])("invalid: %p", (body, line, message) => {
    const p = parseDecisionBody(body);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.line).toBe(line);
    expect(p.message).toContain(message);
  });

  test("problems point at the document line, in plain words", () => {
    const md = `# Plan\n\nText.\n\n\`\`\`decision\nid: R1·1\nquestion: q\nkept_suggestion: maybe\nanswer: a\n\`\`\`\n`;
    expect(decisionProblems(md)).toEqual([{ line: 8, message: "This decision block can’t be read: “kept_suggestion” must be true or false." }]);
    expect(decisionProblems(md.replace("maybe", "true"))).toEqual([]);
  });

  test("updating a block keeps unknown names, comments and order", () => {
    const md = `Intro\n\n\`\`\`decision\n${BLOCK}\n# a comment\nowner: Ana\n\`\`\`\n\nAfter [R3:merge].\n`;
    const next = updateDecisionBlock(md, "merge", { answer: "Last write wins", kept_suggestion: true });
    expect(next).toContain("answer: Last write wins\n");
    expect(next).toContain("kept_suggestion: true\n");
    expect(next).toContain("# a comment\nowner: Ana\n```");
    expect(next.replace("answer: Last write wins", "answer: Merge per item").replace("kept_suggestion: true", "kept_suggestion: false")).toBe(md);
    expect(updateDecisionBlock(md, "nope", { answer: "x" })).toBe(md);
    const parsed = findDecisionBlocks(next)[0].parsed;
    expect(parsed.ok && parsed.entries.map((e) => e.name)).toEqual(["id", "key", "question", "answer", "note", "by", "kept_suggestion", "at", "owner"]);
  });

  test("serialize → parse round-trips and never breaks a line", () => {
    const text = serializeDecision({ id: "R1·2", key: "k", question: "Two\nlines?", answer: "Yes", kept_suggestion: true, extra: "kept" });
    expect(text.split("\n")).toHaveLength(8);
    const [b] = findDecisionBlocks(text);
    expect(b.parsed.ok && b.parsed.fields.question).toBe("Two lines?");
  });
});

// ---------------------------------------------------------------- session fixtures

const question = (key: string, dependsOn: string[] = []) => ({
  key,
  label: key[0].toUpperCase() + key.slice(1),
  title: `Which ${key}?`,
  body: "",
  options: ["a", "b", "c"].map((id) => ({ id, label: `${key} ${id}`, description: "" })),
  recommendedOptionId: "a",
  dependsOn,
});

/** Plated: platform ← storage ← sync (dependents), plus scope (independent). */
function platedSession(): Session {
  const s = createSession({ idea: "Recipe app", provider: "claude" });
  const qs = [question("scope"), question("platform"), question("storage", ["platform"]), question("sync", ["storage"])];
  s.rounds = [
    {
      n: 1,
      questions: qs,
      summary: "",
      askedAt: "2026-10-22T20:00:00.000Z",
      answeredAt: "2026-10-22T21:14:00.000Z",
      answers: qs.map((q) => ({ questionId: q.key, optionId: "a", accepted_recommendation: true })),
    },
  ];
  for (const q of qs)
    s.decisions[q.key] = { key: q.key, round: 1, title: q.title, label: q.label, answer: `${q.key} a`, kind: "option", accepted_recommendation: true, dependsOn: q.dependsOn };
  const body = "## Shape\nA web app [R1:platform]. Recipes stay on the device [R1:storage].\n\n## Later\n- Sync over the LAN [R1:sync]";
  const markdown = renderPlanMarkdown(s, { type: "plan", title: "Recipes", markdown: body, decisions: [], openDecisions: [] } as any);
  s.status = "plated";
  s.plan = { title: "Recipes", markdown, path: "/tmp/plan.md", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}

describe("plan.md with decision blocks", () => {
  test("each block follows the section that first cites it; uncited ones go under More decisions", () => {
    const md = platedSession().plan!.markdown;
    const shape = md.indexOf("## Shape");
    const later = md.indexOf("## Later");
    const more = md.indexOf("## More decisions");
    const at = (key: string) => md.indexOf(`key: ${key}\n`);
    expect(at("platform")).toBeGreaterThan(shape);
    expect(at("platform")).toBeLessThan(later);
    expect(at("storage")).toBeLessThan(later);
    expect(at("sync")).toBeGreaterThan(later);
    expect(at("scope")).toBeGreaterThan(more);
    expect(md).toContain("id: R1·2\nkey: platform\nquestion: Which platform?\nanswer: platform a\nby: you\nkept_suggestion: true\nat: 2026-10-22T21:14:00.000Z");
    expect(decisionProblems(md)).toEqual([]);
  });
});

describe("changing a decision inline (Q2)", () => {
  test("with dependents: new answer in the block, dependents re-asked, plan kept and marked", () => {
    const s = platedSession();
    const deps = changeDecision(s, "platform", { optionId: "b" });
    expect(deps.sort()).toEqual(["storage", "sync"]);
    expect(s.status).toBe("asking");
    expect(s.decisions.platform.answer).toBe("platform b");
    expect(s.decisions.platform.accepted_recommendation).toBe(false);
    expect(s.decisions.storage).toBeUndefined();
    expect(s.stale?.storage.reason).toBe("Platform changed");
    expect(s.reopened).toEqual(expect.arrayContaining(["storage", "sync"]));
    expect(s.plan?.waiting).toEqual(deps);
    expect(s.plan?.markdown).toContain("key: platform\nquestion: Which platform?\nanswer: platform b\nby: you\nkept_suggestion: false\nat: ");
    expect(s.plan?.editedAt).toBeTruthy();
  });

  test("without dependents: updated in place, stays plated", () => {
    const s = platedSession();
    expect(changeDecision(s, "scope", { optionId: OTHER_OPTION, text: "Just me" })).toEqual([]);
    expect(s.status).toBe("plated");
    expect(s.decisions.scope).toMatchObject({ answer: "Just me", kind: "other" });
    expect(s.rounds[0].answers!.find((a) => a.questionId === "scope")).toMatchObject({ optionId: OTHER_OPTION, text: "Just me" });
    expect(s.plan!.markdown).toContain("answer: Just me");
  });

  test("dogfood friction 20: Change keeps a note that doesn't repeat the old answer, as written", () => {
    const s = platedSession();
    s.plan!.markdown = updateDecisionBlock(s.plan!.markdown, "scope", { note: "Overridden by the PO: one household only, for now." });
    expect(changeDecision(s, "scope", { optionId: OTHER_OPTION, text: "Just me" })).toEqual([]);
    const f = findDecisionBlocks(s.plan!.markdown).find((b) => b.parsed.ok && b.parsed.fields.key === "scope")!;
    expect(f.parsed.ok && f.parsed.fields).toMatchObject({ answer: "Just me", note: "Overridden by the PO: one household only, for now." });
  });

  test("no stale restatement: cited prose and the block's note follow the new answer (recording bug 1)", () => {
    const s = createSession({ idea: "Notes", provider: "claude" });
    const qs = [question("scope"), question("platform")];
    s.rounds = [{ n: 1, questions: qs, summary: "", askedAt: "2026-10-22T20:00:00.000Z", answeredAt: "2026-10-22T21:14:00.000Z", answers: qs.map((q) => ({ questionId: q.key, optionId: "a", accepted_recommendation: true })) }];
    for (const q of qs) s.decisions[q.key] = { key: q.key, round: 1, title: q.title, label: q.label, answer: `${q.key} a`, kind: "option", accepted_recommendation: true, dependsOn: [] };
    const body = "## Implementation decisions\n- scope a [R1:scope]\n- platform a [R1:platform]\n\nWe go with platform a for now [R1:platform]. Scope a stays small [R1:scope]. Unrelated platform a mention.";
    const statements = [
      { round: 1, questionId: "scope", statement: "Decided: scope a." },
      { round: 1, questionId: "platform", statement: "Phones first, because that's where lists get used." },
    ];
    const markdown = renderPlanMarkdown(s, { type: "plan", title: "Notes", markdown: body, decisions: statements, openDecisions: [] } as any);
    s.status = "plated";
    s.plan = { title: "Notes", markdown, path: "/tmp/plan.md", openDecisions: [], createdAt: new Date().toISOString() };

    expect(changeDecision(s, "scope", { optionId: "b" })).toEqual([]);
    const md = s.plan.markdown;
    expect(md).toContain("- scope b [R1:scope]");
    expect(md).toContain("Scope b stays small [R1:scope].");
    expect(md).toContain("note: Decided: scope b.");
    expect(md).not.toMatch(/scope a/i);
    expect(md).toContain("- platform a [R1:platform]"); // other decisions untouched

    // A paraphrased note can't be rewritten word for word: it's kept as written (dogfood friction 20), never dropped.
    changeDecision(s, "platform", { optionId: "b" });
    const md2 = s.plan.markdown;
    expect(md2).toContain("- platform b [R1:platform]");
    expect(md2).toContain("We go with platform b for now [R1:platform].");
    expect(md2).toContain("Unrelated platform a mention."); // only sentences that cite the decision
    expect(md2).toContain("note: Phones first, because that's where lists get used.");
    expect(decisionProblems(md2)).toEqual([]);
  });

  test("restateAnswer leaves fences and cites alone; swapAnswer matches whole words", () => {
    const md = "- Yes [R1:a]\n```decision\nanswer: Yes\n```\n- Yesterday [R1:a]\n- Yes [R1:b]";
    expect(restateAnswer(md, "R1:a", "Yes", "No")).toBe("- No [R1:a]\n```decision\nanswer: Yes\n```\n- Yesterday [R1:a]\n- Yes [R1:b]");
    expect(restateAnswer("- local [R1:local]", "R1:local", "local", "cloud")).toBe("- cloud [R1:local]");
    expect(swapAnswer("we picked mobile app.", "Mobile app", "Web app")).toBe("we picked web app.");
    expect(swapAnswer("nothing here", "Mobile app", "Web app")).toBeNull();
  });

  test("same answer is a no-op; bad picks and wrong states throw", () => {
    const s = platedSession();
    const before = s.plan!.markdown;
    expect(changeDecision(s, "platform", { optionId: "a" })).toEqual([]);
    expect(s.plan!.markdown).toBe(before);
    expect(() => changeDecision(s, "platform", { optionId: "zzz" })).toThrow("Pick one");
    expect(() => changeDecision(s, "ghost", { optionId: "a" })).toThrow("Unknown");
    s.status = "asking";
    expect(() => changeDecision(s, "platform", { optionId: "b" })).toThrow();
  });

  test("answering an open decision settles it and drops status: open", () => {
    const s = platedSession();
    s.rounds.push({ n: 2, questions: [question("backups")], summary: "", askedAt: "2026-10-22T22:00:00.000Z" });
    s.wrappedUp = true;
    s.plan!.markdown = renderPlanMarkdown(s, { type: "plan", title: "Recipes", markdown: "## Shape\nWeb [R1:platform].", decisions: [], openDecisions: [] } as any);
    expect(s.plan!.markdown).toContain("id: R2·1\nkey: backups\nquestion: Which backups?\nstatus: open");
    answerOpenDecision(s, "backups", { optionId: "a" });
    expect(s.decisions.backups).toMatchObject({ round: 2, answer: "backups a", accepted_recommendation: true });
    expect(s.plan!.markdown).not.toContain("status: open");
    expect(s.plan!.markdown).toContain("key: backups\nquestion: Which backups?\nanswer: backups a");
    expect(() => answerOpenDecision(s, "backups", { optionId: "a" })).toThrow("already");
  });
});


describe("hand-edited answers count as a Change (DECISIONS #22)", () => {
  const answersOf = (s: Session) => Object.fromEntries(Object.entries(s.decisions).map(([k, d]) => [k, d.answer]));

  test("only a settled answer that differs is an edit; prose, notes and open blocks aren't", () => {
    const s = platedSession();
    const md = s.plan!.markdown;
    expect(answerEdits(md, answersOf(s))).toEqual([]);
    const prose = md.replace("## Shape", "## Shape and size").replace("answer: platform a\n", "answer: platform a\nnote: checked twice\n");
    expect(answerEdits(prose, answersOf(s))).toEqual([]);
    // Whitespace and case-only spacing differences aren't a change of mind.
    expect(answerEdits(md.replace("answer: platform a", "answer:   platform a  "), answersOf(s))).toEqual([]);
    const edited = md.replace("answer: platform a", "answer: platform b");
    expect(answerEdits(edited, answersOf(s))).toEqual([{ key: "platform", from: "platform a", to: "platform b" }]);
    // A removed block isn't an answer change either.
    expect(answerEdits(md.replace(/```decision\n[^`]*key: platform[^`]*```\n?/, ""), answersOf(s))).toEqual([]);
  });

  test("the same key typed twice (e.g. pasted into a paragraph) is reported once", () => {
    const s = platedSession();
    const fence = "```decision\nid: R1·2\nkey: platform\nquestion: Which platform?\nanswer: Desktop app\n```";
    const md = s.plan!.markdown.replace("## Later", `${fence}\n\n${fence}\n\n## Later`);
    expect(answerEdits(md, answersOf(s))).toEqual([{ key: "platform", from: "platform a", to: "Desktop app" }]);
  });

  test("cancel puts back only the answer lines; every other edit survives", () => {
    const s = platedSession();
    const md = s.plan!.markdown;
    const edited = md.replace("answer: platform a", "answer: platform b").replace("## Shape", "## Shape, edited");
    const back = revertAnswerEdits(edited, answersOf(s));
    expect(back).toBe(md.replace("## Shape", "## Shape, edited"));
    expect(answerEdits(back, answersOf(s))).toEqual([]);
  });

  test("saving an edited answer re-asks its dependents, exactly like the card's Change", () => {
    const viaCard = platedSession();
    const viaText = platedSession();
    const cardDeps = changeDecision(viaCard, "platform", { optionId: "b" });
    const md = viaText.plan!.markdown.replace("answer: platform a", "answer: Platform B");
    expect(planAnswerEdits(viaText, md)).toHaveLength(1);
    const deps = saveAnswerEdits(viaText, md);
    expect(deps.sort()).toEqual(cardDeps.sort());
    // Matching an option label (any case) picks that option, not a free-text answer.
    expect(viaText.decisions.platform).toMatchObject({ answer: "platform b", kind: viaCard.decisions.platform.kind });
    expect(viaText.status).toBe("asking");
    expect(viaText.plan?.waiting).toEqual(deps);
    expect(viaText.stale?.storage.reason).toBe("Platform changed");
    expect(viaText.decisions.storage).toBeUndefined();
    expect(viaText.plan!.markdown).toContain("key: platform\nquestion: Which platform?\nanswer: platform b\nby: you\nkept_suggestion: false");
  });

  test("an answer that isn't an option is saved as your own words; no dependents keeps it plated", () => {
    const s = platedSession();
    const md = s.plan!.markdown.replace("answer: scope a", "answer: Just the two of us").replace("## Shape", "## Shape (edited)");
    expect(saveAnswerEdits(s, md)).toEqual([]);
    expect(s.status).toBe("plated");
    expect(s.decisions.scope).toMatchObject({ answer: "Just the two of us", kind: "other" });
    expect(s.rounds[0].answers!.find((a) => a.questionId === "scope")).toMatchObject({ optionId: OTHER_OPTION, text: "Just the two of us" });
    expect(s.plan!.markdown).toContain("## Shape (edited)");
    expect(s.plan!.markdown).toContain("answer: Just the two of us");
  });
});

describe("answer: edited outside Grillado (DECISIONS #26)", () => {
  const edited = (s: Session) => s.plan!.markdown.replace("answer: platform a", "answer: Platform B");

  test("a changed answer with dependents waits for the user; nothing reruns", () => {
    const s = platedSession();
    adoptExternalPlan(s, edited(s));
    expect(s.status).toBe("plated");
    expect(s.plan!.external).toEqual([{ key: "platform", from: "platform a", to: "Platform B", deps: ["storage", "sync"] }]);
    expect(s.decisions.platform.answer).toBe("platform a");
    expect(s.plan!.waiting).toBeUndefined();
    // Pending edits aren't held again by the autosave's answer check.
    expect(planAnswerEdits(s, s.plan!.markdown)).toEqual([]);
  });

  test("confirming re-asks the dependents, as the card's Change does", () => {
    const s = platedSession();
    adoptExternalPlan(s, edited(s));
    const deps = confirmExternal(s);
    expect(deps.sort()).toEqual(["storage", "sync"]);
    expect(s.status).toBe("asking");
    expect(s.plan!.waiting).toEqual(deps);
    expect(s.decisions.platform.answer).toBe("platform b");
    expect(s.plan!.external).toBeUndefined();
  });

  test("dismissing keeps the new answer and marks the dependents stale; Re-ask asks one again", () => {
    const s = platedSession();
    adoptExternalPlan(s, edited(s));
    dismissExternal(s);
    expect(s.status).toBe("plated");
    expect(s.decisions.platform.answer).toBe("platform b");
    expect(s.plan!.markdown).toContain("answer: platform b");
    expect(Object.keys(s.stale ?? {}).sort()).toEqual(["storage", "sync"]);
    expect(s.decisions.storage).toBeUndefined();
    expect(s.plan!.waiting).toBeUndefined();
    expect(reaskStale(s, ["storage"])).toEqual(["storage"]);
    expect(s.status).toBe("asking");
    expect(s.plan!.waiting).toEqual(["storage"]);
  });

  test("whitespace- or casing-only edits change nothing", () => {
    const s = platedSession();
    const md = s.plan!.markdown.replace("answer: platform a", "answer:   PLATFORM   A ");
    adoptExternalPlan(s, md);
    expect(s.plan!.external).toBeUndefined();
    expect(s.decisions.platform.answer).toBe("platform a");
    expect(s.status).toBe("plated");
    expect(planAnswerEdits(s, md)).toEqual([]);
  });

  test("an edit nothing depends on is just recorded", () => {
    const s = platedSession();
    adoptExternalPlan(s, s.plan!.markdown.replace("answer: scope a", "answer: scope c"));
    expect(s.plan!.external).toBeUndefined();
    expect(s.decisions.scope.answer).toBe("scope c");
    expect(s.status).toBe("plated");
  });
});

// ---------------------------------------------------------------- server

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});
const webDir = () => mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));

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

function storeWithPlan() {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const s = platedSession();
  const file = store.writePlan(s.id, s.plan!.markdown);
  s.plan!.path = file;
  store.save(s);
  return { store, id: s.id, file, md: s.plan!.markdown };
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe("server: change, conflicts, outside edits", () => {
  test("change action writes plan.md and starts re-asking the dependents", async () => {
    const { store, id, file } = storeWithPlan();
    const { call } = await serve(store);
    const r = await call("POST", `/api/sessions/${id}/change`, { key: "storage", optionId: "c" });
    expect(r.status).toBe(200);
    expect(r.json.plan.waiting).toEqual(["sync"]);
    expect(readFileSync(file, "utf8")).toContain("answer: storage c");
    expect(store.load(id)!.status).toBe("asking");
  });

  test("a save made on top of an older plan.md is refused with the newer text (409)", async () => {
    const { store, id, file, md } = storeWithPlan();
    const { call } = await serve(store);
    await call("GET", `/api/sessions/${id}`);
    const outside = `${md}\nEdited in another editor.\n`;
    writeFileSync(file, outside);
    expect(await until(async () => (await call("GET", `/api/sessions/${id}`)).json.plan.markdown === outside)).toBe(true);
    const stale = await call("POST", `/api/sessions/${id}/plan`, { markdown: `${md}\nMine.\n`, base: textHash(md) });
    expect(stale.status).toBe(409);
    expect(stale.json.markdown).toBe(outside);
    expect(readFileSync(file, "utf8")).toBe(outside);
    const fresh = await call("POST", `/api/sessions/${id}/plan`, { markdown: `${outside}Mine.\n`, base: textHash(outside) });
    expect(fresh.status).toBe(200);
  });

  test("saving plan.md with a changed answer is held until re-ask is confirmed (DECISIONS #22)", async () => {
    const { store, id, file, md } = storeWithPlan();
    const { call } = await serve(store);
    const edited = md.replace("answer: storage a", "answer: storage c");
    const held = await call("POST", `/api/sessions/${id}/plan`, { markdown: edited, base: textHash(md) });
    expect(held.status).toBe(409);
    expect(held.json.answerEdits).toEqual([{ key: "storage", from: "storage a", to: "storage c" }]);
    expect(held.json.markdown).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(md);
    const ok = await call("POST", `/api/sessions/${id}/plan`, { markdown: edited, base: textHash(md), reask: true });
    expect(ok.status).toBe(200);
    expect(ok.json.reasked).toEqual(["sync"]);
    expect(readFileSync(file, "utf8")).toContain("answer: storage c\nby: you\nkept_suggestion: false");
    const s = store.load(id)!;
    expect(s.status).toBe("asking");
    expect(s.plan!.waiting).toEqual(["sync"]);
  });

  test("outside edits are picked up live and marked as a reload", async () => {
    const { store, id, file, md } = storeWithPlan();
    const { call } = await serve(store);
    const first = await call("GET", `/api/sessions/${id}`);
    expect(first.json.plan.reloadedAt).toBeUndefined();
    writeFileSync(file, md.replace("A web app", "A web app, offline first"));
    expect(await until(async () => !!(await call("GET", `/api/sessions/${id}`)).json.plan.reloadedAt)).toBe(true);
    expect((await call("GET", `/api/sessions/${id}`)).json.plan.markdown).toContain("offline first");
    // Our own saves don't count as outside edits.
    const before = (await call("GET", `/api/sessions/${id}`)).json.plan.reloadedAt;
    await call("POST", `/api/sessions/${id}/plan`, { markdown: "# Mine\n" });
    await new Promise((r) => setTimeout(r, 1200));
    expect((await call("GET", `/api/sessions/${id}`)).json.plan.reloadedAt).toBe(before);
  });

  test("the losing version is kept as plan.conflict.md", async () => {
    const { store, id } = storeWithPlan();
    const { call } = await serve(store);
    const r = await call("POST", `/api/sessions/${id}/plan-conflict`, { markdown: "# the other one\n" });
    expect(r.status).toBe(200);
    const kept = path.join(store.sessionDir(id), "plan.conflict.md");
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf8")).toBe("# the other one\n");
  });
});

// ---------------------------------------------------------------- browser-side logic

describe("plan.md reload rules (Q5)", () => {
  const base = { lastSaved: "A", dirty: false, sent: new Set<string>(), text: "A" };
  test("no local edits: reload", () => expect(reconcile(base, "B")).toBe("adopt"));
  test("both changed: ask", () => expect(reconcile({ ...base, dirty: true, text: "A+" }, "B")).toBe("conflict"));
  test("our own save echoing back: ignore", () => expect(reconcile({ ...base, dirty: true, text: "A++", sent: new Set(["A+"]) }, "A+")).toBe("ignore"));
  test("same text: ignore", () => expect(reconcile({ ...base, dirty: true, text: "B" }, "B")).toBe("ignore"));
});

describe("context passages and diagrams", () => {
  test("sentences keep every character and don't split inside cites or code", () => {
    const t = "Use `a. b` here [R1:x]. Then this! And [R2:y, R3:z] that? End";
    const parts = sentences(t);
    expect(parts.join("")).toBe(t);
    expect(parts).toEqual(["Use `a. b` here [R1:x]. ", "Then this! ", "And [R2:y, R3:z] that? ", "End"]);
  });

  test("passages are the sentences and list items citing a decision", () => {
    const md = "# T\n\nOne [R1:a]. Two. Three [R1:a, R1:b].\n\n- item [R1:b]\n- plain\n";
    const ps = passages(md);
    expect(ps.map((p) => p.keys)).toEqual([["a"], ["a", "b"], ["b"]]);
    expect(new Set(ps.map((p) => p.id)).size).toBe(3);
  });

  test("diagram errors point at the line where the shape opened", () => {
    const code = "flowchart LR\n  A[Start] --> B{Ok?\n  B --> C[Done]";
    expect(explainDiagramError(code, "Parse error on line 3:\n...")).toEqual({ line: 2, message: "Line 2: a shape isn’t closed. Add the missing } after “Ok?”." });
    expect(explainDiagramError("flowchart LR\n  A --> ", "Parse error on line 2")).toEqual({ line: 2, message: "Mermaid couldn’t read line 2." });
    expect(explainDiagramError("flowchat LR\n  A --> B", "Parse error")).toEqual({ line: 1, message: "Line 1: the diagram type is missing. Start with flowchart TD or stateDiagram-v2." });
    expect(explainDiagramError("flowchart LR\n  A --> --> B", "Parse error on line 2:\nExpecting 'AMP'")).toEqual({ line: 2, message: "Line 2: Mermaid doesn’t know this arrow. Use --> or -.->." });
    expect(diagramLabel(code, '<g class="node default"></g><g class="node"></g>')).toBe("flowchart diagram, 2 nodes");
    expect(diagramLabel("stateDiagram-v2\n  accTitle: Sync states\n  [*] --> A", "")).toBe("State diagram: Sync states");
  });
});

describe("agent name (§5b)", () => {
  test("taken from the binary's own version output when it names itself", () => {
    expect(agentNameFrom("2.1.3 (Claude Code)")).toBe("Claude Code");
    expect(agentNameFrom("claude 9.9.9-fake")).toBeUndefined();
  });
  test("monogram and templates", () => {
    expect(monogram("Claude Code")).toBe("CC");
    expect(monogram("Codex")).toBe("CO");
    expect(monogram("pi")).toBe("PI");
    expect(fmt("Question for {agent}", { agent: "Grok" })).toBe("Question for Grok");
    expect(fmt("{n} edits from {agent}", { n: 3 })).toBe("3 edits from {agent}");
  });
});
