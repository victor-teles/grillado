import { describe, expect, test } from "bun:test";
import { RoundReplySchema } from "../src/core/schema.ts";
import {
  type Answer,
  type Session,
  DEFAULT_MAX_ROUNDS,
  applyRound,
  atCap,
  createSession,
  currentRound,
  keepGoing,
  reopen,
  roundsSaved,
  stopAtCap,
  submitAnswers,
} from "../src/core/session.ts";
import { ROOT_ID, buildTree, heatLevel } from "../src/core/tree.ts";

const q = (key: string, dependsOn: string[] = []) => ({
  key,
  label: key[0].toUpperCase() + key.slice(1),
  title: `Question ${key}?`,
  body: "",
  options: [
    { id: "a", label: `A for ${key}`, description: "" },
    { id: "b", label: `B for ${key}`, description: "" },
  ],
  recommendedOptionId: "a",
  dependsOn,
});
const ask = (s: Session, questions: ReturnType<typeof q>[], upcoming: { key: string; label: string; dependsOn: string[] }[] = []) =>
  applyRound(s, RoundReplySchema.parse({ type: "ask_round", summary: "s", questions, upcoming }));
const answerAll = (s: Session, pick: (key: string) => "a" | "b" = () => "a") => {
  const r = currentRound(s)!;
  const answers: Answer[] = r.questions.map((x) => ({ questionId: x.key, optionId: pick(x.key), accepted_recommendation: pick(x.key) === "a" }));
  submitAnswers(s, r.n, answers);
};

describe("heat meter (derived, can go down)", () => {
  test("level formula", () => {
    expect(heatLevel(0, 0)).toBe(1);
    expect(heatLevel(0, 5)).toBe(1);
    expect(heatLevel(2, 1)).toBe(3);
    expect(heatLevel(3, 6)).toBe(2);
    expect(heatLevel(9, 1)).toBe(4);
    expect(heatLevel(12, 0)).toBe(5);
  });

  test("goes down when a round uncovers more than it settles", () => {
    const s = createSession({ idea: "A notes app", provider: "claude" });
    ask(s, [q("audience"), q("budget")], [{ key: "core", label: "Core flow", dependsOn: ["audience"] }]);
    expect(buildTree(s).heat).toBe(1);
    answerAll(s);
    ask(s, [q("core", ["audience"])]);
    const before = buildTree(s);
    expect(before.counts).toEqual({ settled: 2, open: 1 });
    expect(before.heat).toBe(3);
    answerAll(s);
    ask(
      s,
      ["search", "tags", "export", "sharing", "reminders", "themes"].map((k) => q(k, ["core"])),
      [{ key: "sync", label: "Sync", dependsOn: ["search"] }],
    );
    const after = buildTree(s);
    expect(after.counts).toEqual({ settled: 3, open: 7 });
    expect(after.heat).toBe(2);
    expect(after.heat).toBeLessThan(before.heat);
  });

  test("reaches 5 only when nothing is open, and drops again on reopen", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    ask(s, [q("platform")]);
    answerAll(s);
    ask(s, [q("storage", ["platform"])]);
    answerAll(s);
    applyRound(s, RoundReplySchema.parse({ type: "frontier_empty", summary: "done", questions: [] }));
    expect(buildTree(s).heat).toBe(5);
    reopen(s, "platform");
    const t = buildTree(s);
    expect(t.counts).toEqual({ settled: 0, open: 2 });
    expect(t.heat).toBe(1);
  });
});

describe("decision tree", () => {
  test("statuses, primary parent, waits-on and stale reasons", () => {
    const s = createSession({ idea: "Shopping list\nmore", provider: "claude" });
    ask(s, [q("platform"), q("scope")], [{ key: "sync", label: "Sync", dependsOn: ["platform"] }]);
    let t = buildTree(s);
    expect(t.nodes[0]).toMatchObject({ id: ROOT_ID, status: "idea", label: "Shopping list" });
    expect(t.nodes.map((n) => [n.id, n.status, n.parentId])).toEqual([
      [ROOT_ID, "idea", null],
      ["platform", "frontier", ROOT_ID],
      ["sync", "blocked", "platform"],
      ["scope", "frontier", ROOT_ID],
    ]);
    expect(t.nodes.find((n) => n.id === "sync")!.waitsOn).toEqual(["Platform"]);
    expect(t.nodes.find((n) => n.id === "scope")!.questionIndex).toBe(1);

    answerAll(s, (k) => (k === "scope" ? "b" : "a"));
    ask(s, [q("sync", ["platform"]), q("roles", ["scope", "platform"])]);
    t = buildTree(s);
    const roles = t.nodes.find((n) => n.id === "roles")!;
    expect(roles.parentId).toBe("scope"); // the most recently opened prerequisite
    expect(roles.depth).toBe(2);
    expect(t.nodes.find((n) => n.id === "scope")!.answer).toMatchObject({ label: "B for scope", acceptedRecommendation: false });

    answerAll(s);
    ask(s, [q("conflicts", ["sync"])]);
    reopen(s, "platform");
    t = buildTree(s);
    const byId = Object.fromEntries(t.nodes.map((n) => [n.id, n]));
    expect(byId.platform.status).toBe("stale");
    expect(byId.platform.staleReason).toBe("You reopened it");
    expect(byId.sync.staleReason).toBe("Platform changed");
    expect(byId.roles.staleReason).toBe("Platform changed");
    expect(byId.scope.status).toBe("settled");
    expect(byId.conflicts).toBeUndefined(); // dropped with the open round

    ask(s, [q("platform")]);
    answerAll(s, () => "b");
    expect(s.decisions.platform.reopened).toBe(true);
    expect(s.stale?.platform).toBeUndefined();
    expect(buildTree(s).nodes.find((n) => n.id === "sync")!.status).toBe("stale");
  });
});

describe("round cap (#33)", () => {
  test("the default is 2 rounds", () => expect(DEFAULT_MAX_ROUNDS).toBe(2));

  test("a round counts once its batch is saved; the gate closes at N", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    expect(roundsSaved(s)).toBe(0);
    ask(s, [q("a")]);
    expect(roundsSaved(s)).toBe(1);
    expect(atCap(s, 2)).toBe(false);
    answerAll(s);
    ask(s, [q("b")]);
    expect(atCap(s, 2)).toBe(true);
    expect(atCap(s, 3)).toBe(false);
  });

  test("a round asked while a reopened or stale decision is owed is a re-ask and doesn't count", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    ask(s, [q("a")]);
    answerAll(s);
    ask(s, [q("b")]);
    answerAll(s);
    expect(atCap(s, 2)).toBe(true);
    s.reopened = ["a"];
    expect(atCap(s, 2)).toBe(false);
    ask(s, [q("a")]);
    answerAll(s);
    s.stale = { b: { key: "b", label: "b", title: "b", answer: "x", round: 2, dependsOn: [], reason: "a changed" } as any };
    expect(atCap(s, 2)).toBe(false);
    ask(s, [q("b")]);
    delete s.stale!.b;
    answerAll(s);
    expect(s.rounds.map((r) => !!r.reask)).toEqual([false, false, true, true]);
    expect(roundsSaved(s)).toBe(2);
    expect(atCap(s, 2)).toBe(true);
    expect(atCap(s, 3)).toBe(false);
  });

  test("at the cap Confirm opens with the cap as its reason, and Keep going is refused", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    ask(s, [q("a")]);
    answerAll(s);
    ask(s, [q("b")]);
    answerAll(s);
    stopAtCap(s);
    expect(s.status).toBe("confirm");
    expect(s.stop).toBe("cap");
    expect(() => keepGoing(s, 2)).toThrow("That was the last round.");
    keepGoing(s, 3);
    expect(s.status as string).toBe("asking");
    expect(s.stop).toBeUndefined();
  });

  test("an empty frontier below the cap is the agent ending early; Keep going stays", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    ask(s, [q("a")]);
    answerAll(s);
    applyRound(s, { type: "frontier_empty", summary: "done", questions: [], upcoming: [] });
    expect(s.status).toBe("confirm");
    expect(s.stop).toBe("empty");
    expect(roundsSaved(s)).toBe(1);
    keepGoing(s, 2);
    expect(s.status as string).toBe("asking");
  });

  test("reopened decisions are owed past the cap", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    ask(s, [q("platform")]);
    answerAll(s);
    ask(s, [q("storage", ["platform"])]);
    answerAll(s);
    expect(atCap(s, 2)).toBe(true);
    stopAtCap(s);
    reopen(s, "platform");
    expect(atCap(s, 2)).toBe(false);
    ask(s, [q("platform")]);
    answerAll(s);
    // storage still waits to be asked again
    expect(atCap(s, 2)).toBe(false);
    ask(s, [q("storage", ["platform"])]);
    answerAll(s);
    expect(atCap(s, 2)).toBe(true);
  });
});

describe("schema", () => {
  test("label and upcoming are optional for the parser", () => {
    const r = RoundReplySchema.parse({ type: "ask_round", summary: "s", questions: [{ ...q("x"), label: undefined }] });
    expect(r.upcoming).toEqual([]);
    expect(r.questions[0].label).toBe("");
  });
});
