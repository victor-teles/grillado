# Plan 008: Plan-to-build loop (slice D of 001)

The decisions are in the Grillado plan, made by the user in Grillado on 2026-11-26:
`docs/plans/grillado-plan-2026-11-27-6f344d58.md` (session `2026-11-27-6f344d58`). Build what it
says; this file only records how the build is laid out, so the work can be resumed.

## Settled by the plan (short form)

- One slice: build steps, progress, asks, change notices, in shell commands and MCP together.
- Steps are written by the plan run at plating (title + done check, stable key). Send to issues
  reuses them and does not split again.
- Full step editing in the plan view: title, done check, reorder by keyboard, add, remove.
- The agent marks a step done itself, with what it verified and any deviations (required). It shows
  Done at once; the user can reopen it.
- `grillado build next|start|done|ask|wait|withdraw <plan>`, each with a `build_*` MCP tool; shared
  logic in one module next to `src/cli/plans.ts`.
- An ask: key, question, the agent's options, the step it was raised at. Pinned card above the plan,
  ember "Agent is waiting" tag, number keys and Enter. `build wait` like `plan wait` (540 s, re-run).
  The agent may withdraw; a withdrawn ask is never a decision; nothing answers for the user.
- An answered ask becomes a bullet under Implementation decisions tagged `[B:<ask-key>]`, "decided
  during the build at step N", and is returned to the waiting agent.
- Every build reply carries the plan revision; when it moved since the agent's last `get`, the reply
  lists what changed (new decisions, edited sections, step edits).
- The plan file records progress: `[ ]` / started / `[x]` per step, and a Build log section.
- While away: tab title count "(1) Agent is waiting" and an ember badge in the plans list. No OS
  notifications.
- `plan start --agent <id>` (and MCP): optional; refused with the list of agents that can read when
  the chosen one cannot.
- The build skill tells agents to use `grillado build`, re-read on a change, report done with
  verification and deviations.

## Layout of the build (design notes)

- `src/core/build.ts` (DOM-free): types (BuildStep, BuildAsk, BuildLogEntry, BuildState), the
  appendix renderer and stripper for the plan file ("## Build steps" + "## Build log", always the
  last two sections, written by Grillado only), the snapshot + diff for change notices.
- The session is the truth for build state (`session.build`). Every change to it, from the CLI, MCP
  or the server, goes through `store.update` under the session lock; `store.save` keeps the build
  state that is on disk. The server adopts it when the session file changes (as it does comments).
- The plan text the user edits (`plan.markdown`) never contains the appendix. The file on disk is
  text + appendix; readers of the file strip it before comparing or adopting edits.
- Revision: `build.rev`, moved by user-side changes (round, text edit, step edit/reorder/add/remove,
  reopen, answered ask). The agent's own reports (start, done, ask, withdraw) do not move it.
  `build.seen` is the snapshot taken at the agent's last `plan get` / ready `plan wait` / `get_plan`.
- `src/cli/build.ts`: the shared operations (next, start, done, ask, wait, withdraw).
  `src/cli/build-command.ts`: the shell verb. `src/cli/mcp.ts`: six `build_*` tools.
- Server: `POST /api/sessions/:id/build` with ops `edit | move | add | remove | reopen | answer`.
- Web: a Build tab in the plan view (steps, status, editing, log), the pinned ask card above the
  plan (the vendored question component, one item), tab title count, Recent badge.
- Deviation to report: step editing lives in a Build tab of the plan view, not inside the block
  editor (`PlanEditor.tsx`).

## Status

BUILT, not committed (2026-11-26). Waiting on the full browser suite before calling it done.

Everything in "Settled by the plan" is in. Where things live:
- `src/core/build.ts` (state, rules, plan file appendix after `<!-- grillado:build -->`, snapshot + diff).
- `src/cli/build.ts` (shared operations), `src/cli/build-command.ts` (`grillado build …`), six `build_*` tools in `mcp.ts`.
- Store: `writePlan` adds the appendix, `readPlan` strips it, `readPlanFile`, `refreshPlan`; `save` keeps disk `build`.
- Plan reply `steps` (schema, prompt, contracts, one repair pass); `fallbackSlices` source "steps".
- `plan start --agent` / `start_plan agent` (`agentFor`, `session.agentPinned`).
- Server: `buildUpdate`, `trackRevision`, `POST …/build`, adoption of build changes made by a shell or MCP.
- Web: `web/src/app/build/Build.tsx` (Build tab, ask cards), tab title count, Recent badge.
- Tests: `test/build.test.ts` (28), `e2e/build.mjs` (57 checks). Skills and docs updated.

Deviations from the plan, to tell the user:
- Step editing is a Build tab in the plan view, not inside the block editor.
- The build sections are not part of the editable plan text; they are an appendix Grillado writes in the file.
- `build_wait` over MCP waits 50 s by default (540 s from a shell).
- An answered ask is a cited line under Implementation decisions, not an entry in the Decisions tab.

Checked with real Claude Code: a real plan came back with six thin steps with runnable done checks.
