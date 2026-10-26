// v1.1 backlog item 2: a decision block shows who answered it and when, and only notes that add something.
import { describe, expect, test } from "bun:test";
import { noteAdds, restTag, whoLine } from "../web/src/app/editor/decision-meta.ts";

const iso = (d: Date) => d.toISOString();

describe("whoLine", () => {
  test("you, with the time from at:", () => {
    expect(whoLine({ by: "you", at: "2026-10-25T17:02:11Z" }, "Agent X", { format: iso })).toBe("You, 2026-10-25T17:02:11.000Z");
  });
  test("kept the suggestion", () => {
    expect(whoLine({ by: "you", kept_suggestion: true }, "A")).toBe("You kept the suggestion");
  });
  test("by: agent uses the selected agent's display name, never a hardcoded one", () => {
    expect(whoLine({ by: "agent", at: "2026-10-25T17:02:11Z" }, "Some Agent", { format: iso })).toBe("Picked by Some Agent, 2026-10-25T17:02:11.000Z");
  });
  test("right after a change it says what it was", () => {
    expect(whoLine({ by: "you" }, "A", { was: "Merge per item" })).toBe("Changed just now · was Merge per item");
  });
  test("a missing or unreadable at: drops the time but keeps who", () => {
    expect(whoLine({ by: "you" }, "A")).toBe("You");
    expect(whoLine({ by: "you", at: "not a date" }, "A")).toBe("You");
  });
  test("nothing to say without by: or at:", () => {
    expect(whoLine({}, "A")).toBeNull();
  });
});

describe("restTag and notes", () => {
  test("Picked by {agent} at rest; Your call when you overrode; nothing when you kept it", () => {
    expect(restTag({ by: "agent" }, "Some Agent")).toEqual({ kind: "agent", text: "Picked by Some Agent" });
    expect(restTag({ by: "you", kept_suggestion: false }, "A")?.kind).toBe("yours");
    expect(restTag({ by: "you", kept_suggestion: true }, "A")).toBeNull();
  });
  test("a note that only repeats the answer is dropped", () => {
    expect(noteAdds("Decided: Yes, one core flow.", "Yes, one core flow")).toBe(false);
    expect(noteAdds("Last edit wins inside an item.", "Merge per item")).toBe(true);
    expect(noteAdds("", "x")).toBe(false);
  });
});
