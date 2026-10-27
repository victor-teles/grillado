import { describe, expect, test } from "bun:test";
import { newer } from "../web/src/app/newer.ts";
import type { SessionView } from "../web/src/app/types.ts";

const snap = (rev: number | undefined, busy: boolean) => ({ id: "s", rev, busy }) as unknown as SessionView;

describe("session snapshots (review-pr22 #3)", () => {
  test("a reply older than a pushed update doesn't bring a finished run back", () => {
    const pushed = snap(7, false); // the run already failed
    const reply = snap(5, true); // taken as the run started
    expect(newer(pushed, reply)).toBe(pushed);
  });
  test("a newer snapshot wins", () => {
    const next = snap(8, false);
    expect(newer(snap(7, true), next)).toBe(next);
  });
  test("one without a number is taken", () => {
    const next = snap(undefined, false);
    expect(newer(snap(7, true), next)).toBe(next);
  });
});
