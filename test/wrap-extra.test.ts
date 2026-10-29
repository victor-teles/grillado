import { expect, test } from "bun:test";
import os from "node:os";
import { nextRound } from "../src/core/engine.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { askMore, atCap, createSession, keepGoing, submitAnswers, wrapUp } from "../src/core/session.ts";
function scripted(replies: unknown[]): ProviderAdapter & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    id: "claude",
    displayName: "Fake",
    bin: "fake",
    installHint: "n/a",
    loginHint: "fake login",
    requests,
    async detect() {
      return { status: "ready", version: "1", path: "/fake" };
    },
    async *run(req: RunRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: "progress", label: "Thinking" };
      const next = replies.shift();
      if (next && typeof next === "object" && "error" in (next as any)) {
        yield { type: "error", code: (next as any).error, message: "nope" };
        return;
      }
      yield { type: "result", raw: next };
    },
  };
}

const opts = () => ({ cwd: os.tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal });
const q = (key: string, dependsOn: string[] = [], options = ["a", "b"]) => ({
  key,
  title: `Question ${key}?`,
  body: "",
  options: options.map((id) => ({ id, label: `Option ${id}`, description: "" })),
  recommendedOptionId: options[0],
  dependsOn,
});
const round = (...questions: ReturnType<typeof q>[]) => ({ type: "ask_round", summary: "s", questions });
const acceptAll = (s: any) => s.rounds.at(-1).questions.map((x: any) => ({ questionId: x.key, optionId: x.recommendedOptionId, accepted_recommendation: true }));

// Rounds PR 4 review (PR45-rounds M1), from the Designer’s M1-test.ts.
test("PR45 call 2: a wrap while the granted extra round prepares gives the grant back", async () => {
  const s = createSession({ idea: "x", provider: "claude" });
  const a = scripted([round(q("one")), round(q("two")), round(q("three"))]);
  await nextRound(s, a, opts()); submitAnswers(s, 1, acceptAll(s));
  await nextRound(s, a, opts()); submitAnswers(s, 2, acceptAll(s));
  s.status = "confirm"; s.stop = "cap";
  askMore(s); // the grant; the extra round now prepares (status asking)
  wrapUp(s);
  expect(s.extra).toBeFalsy();
  expect(s.stop).toBe("cap");
  expect(atCap(s, 2)).toBe(true);
  expect(() => keepGoing(s)).toThrow(); // no Keep going at the cap
  askMore(s); // the quiet Ask 1 more round still works, once
  expect(s.extra).toBe(true);
});
