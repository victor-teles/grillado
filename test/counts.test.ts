// Item 2 handoff §4: every count on a screen comes from one place and agrees.
import { describe, expect, test } from "bun:test";
import { confirmCounts, countText, planCounts } from "../web/src/app/counts.ts";
import type { SessionView } from "../web/src/app/types.ts";

const q = (key: string) => ({ key, title: `Question ${key}?`, options: [] });
function session(answered: number, open: number): SessionView {
  const decisions: Record<string, unknown> = {};
  for (let i = 0; i < answered; i++) decisions[`d${i}`] = { key: `d${i}`, title: `Question d${i}?`, answer: "Yes", round: 1 };
  return {
    decisions,
    rounds: [{ n: 1, questions: [...Object.keys(decisions).map(q), ...Array.from({ length: open }, (_, i) => q(`o${i}`))] }],
    plan: { openDecisions: [] },
  } as unknown as SessionView;
}
const openBlocks = (n: number) =>
  Array.from({ length: n }, (_, i) => "```decision\nkey: o" + i + "\nstatus: open\nquestion: Question o" + i + "?\n```\n").join("\n");

describe("decision counts", () => {
  test("early wrap: confirm, plan meta, tab and Open heading agree", () => {
    const s = session(16, 2);
    const before = confirmCounts(s);
    const after = planCounts(s, `# Plan\n\n${openBlocks(2)}`);
    expect([before.total, before.open, before.resolved]).toEqual([after.total, after.open, after.resolved]);
    const t = countText(after);
    expect(t.tab).toBe("Decisions 18 · 2 open");
    expect(t.tabName).toBe("Decisions, 18, 2 open");
    expect(t.titleMeta).toBe("18 decisions · 2 open");
    expect(t.openHeading).toBe(2);
    expect(t.status).toBe("2 open");
    expect(countText(before).confirm).toBe("16 decisions settled, 2 still open");
    expect(countText(after, true).tab).toBe("Decisions · 2 open");
  });
  test("nothing open: no open suffix anywhere", () => {
    const t = countText(planCounts(session(1, 0), "# Plan\n"));
    expect([t.tab, t.titleMeta, t.status]).toEqual(["Decisions 1", "1 decision", ""]);
  });
  test("answering an open block moves it from open to resolved, total unchanged", () => {
    const s = session(16, 2);
    const md = `# Plan\n\n${openBlocks(2)}`;
    (s.decisions as Record<string, unknown>).o0 = { key: "o0", title: "Question o0?", answer: "No", round: 1 };
    const c = planCounts(s, md);
    expect([c.total, c.open, c.resolved]).toEqual([18, 1, 17]);
  });
});
