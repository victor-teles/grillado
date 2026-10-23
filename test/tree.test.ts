import { describe, expect, test } from "bun:test";
import { RoundReplySchema } from "../src/core/schema.ts";
import {
  type Answer,
  type Session,
  acceptStreak,
  applyRound,
  createSession,
  currentRound,
  dismissNudge,
  reopen,
  shouldNudge,
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

describe("passivity nudge", () => {
  test("appears after 4 rounds in a row of all-accepted answers, never before", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    for (let i = 1; i <= 4; i++) {
      ask(s, [q(`k${i}a`), q(`k${i}b`)]);
      expect(shouldNudge(s)).toBe(false);
      answerAll(s);
    }
    expect(acceptStreak(s)).toBe(4);
    expect(shouldNudge(s)).toBe(false); // waiting for the next round: nothing to push back on yet
    ask(s, [q("k5")]);
    expect(shouldNudge(s)).toBe(true);
  });

  test("one changed answer resets the streak", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    for (let i = 1; i <= 5; i++) {
      ask(s, [q(`k${i}a`), q(`k${i}b`)]);
      answerAll(s, (k) => (i === 2 && k.endsWith("b") ? "b" : "a"));
    }
    expect(acceptStreak(s)).toBe(3);
    ask(s, [q("k6")]);
    expect(shouldNudge(s)).toBe(false);
  });

  test("Looks right dismisses it for the rest of the session", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    for (let i = 1; i <= 4; i++) {
      ask(s, [q(`k${i}`)]);
      answerAll(s);
    }
    ask(s, [q("k5")]);
    expect(shouldNudge(s)).toBe(true);
    dismissNudge(s);
    expect(shouldNudge(s)).toBe(false);
    answerAll(s);
    ask(s, [q("k6")]);
    expect(acceptStreak(s)).toBe(5);
    expect(shouldNudge(s)).toBe(false);
  });
});

describe("schema", () => {
  test("label and upcoming are optional for the parser", () => {
    const r = RoundReplySchema.parse({ type: "ask_round", summary: "s", questions: [{ ...q("x"), label: undefined }] });
    expect(r.upcoming).toEqual([]);
    expect(r.questions[0].label).toBe("");
  });
});
