// v1.1 backlog item 2: a decision block shows who answered it and when.
import { describe, expect, test } from "bun:test";
import { answeredLine } from "../web/src/app/editor/decision-meta.ts";

const iso = (d: Date) => d.toISOString();

describe("answeredLine", () => {
  test("names who answered and when, from by: and at:", () => {
    expect(answeredLine({ by: "you", at: "2026-10-25T17:02:11Z" }, "Agent X", iso)).toBe("Answered by you · 2026-10-25T17:02:11.000Z");
  });
  test("by: agent uses the selected agent's display name, never a hardcoded one", () => {
    expect(answeredLine({ by: "agent", at: "2026-10-25T17:02:11Z" }, "Some Agent", iso)).toBe("Answered by Some Agent · 2026-10-25T17:02:11.000Z");
  });
  test("a missing or unreadable at: drops the time but keeps who", () => {
    expect(answeredLine({ by: "you" }, "A")).toBe("Answered by you");
    expect(answeredLine({ by: "you", at: "not a date" }, "A")).toBe("Answered by you");
  });
  test("nothing to say without by: or at:", () => {
    expect(answeredLine({}, "A")).toBeNull();
  });
  test("the default format is short English month, day and time", () => {
    expect(answeredLine({ by: "you", at: "2026-10-25T17:02:11Z" }, "A")).toMatch(/^Answered by you · Oct 2[45], \d{1,2}:\d{2} [AP]M$/);
  });
});
