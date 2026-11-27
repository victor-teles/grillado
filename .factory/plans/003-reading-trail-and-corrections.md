# Plan 003: The user sees what the agent reads, can skip it, and can correct a finding

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: This plan builds on plan 002. Read the merged result of 002 first:
> the names below (`RunRequest.access`, `Session.codeRead`, `Session.readRoot`,
> `Session.findings`, `src/core/project-read.ts`, `src/cli/project-read.ts`) are 002's
> design and may have been adapted. Use what was shipped. Compare
> `git diff --stat 3dcd618 -- src web test e2e` with this plan and reconcile routine drift;
> pause if 002 is not merged or its read-only contract changed.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `.factory/plans/002-grounded-rounds.md`
- **Category**: direction
- **Planned at**: commit `3dcd618`, 2026-11-24 (before 002 was built)

## Why this matters

Plan 002 lets the agent read the project. Reading takes time: a first round that took under a
minute may now take several. Today the wait is one status line and a static skeleton
(`FiringUp`, `web/src/app/Round.tsx:360`). A longer wait with nothing to watch feels broken,
and it hides the very thing the user was asked to trust. This plan makes the wait show what is
being read, gives the user a way out when reading is slow or fails, and lets the user tell the
agent when it read the code wrong. Together these close the trust loop that 002 opens.

## Current state

- `src/core/providers/types.ts`: `ProviderEvent` is `progress | text-delta | text-reset |
  result | error`. There is no event for tool use.
- `src/core/providers/base.ts`: `createAdapter.run` reads stdout line by line only when the
  request asks for `stream` and the spec has a `stream` reader (lines 89-109). Today only
  comment replies do (`stream: { field: "text" }`, `src/core/engine.ts:319`), and only Claude
  Code has a reader (`claudeStreamReader`, `src/core/providers/adapters.ts:36`), which reads
  `stream_event` lines for one string field.
- `src/core/engine.ts`: `RunOptions` has `onProgress`, `onRepair`, `onText`. `runValidated`
  maps provider events to them (lines 200-211).
- `src/cli/server.ts`: `runOptions` broadcasts `{ type: "progress", sessionId, label }` over
  SSE and keeps the last label in `this.progress` (line 804); `view(s)` sends it as
  `progress`. `RunRecorder` (`this.record(…)`) writes the activity log; `rec.end(…)` takes
  `read`, `asked`, `wrote`, `result`.
- `src/core/activity.ts`: `ActivityLine` `run.ended` has `read?: string[]`. It holds plan
  section titles and renders as "Read plan.md · …" (`web/src/app/activity/Activity.tsx:457`).
  Do not reuse it for project files.
- `web/src/app/Round.tsx`: `FiringUp` (first round), `WaitingView` (between rounds),
  `StatusLine` (label, optional note, Stop shown from 60 s).
- `web/src/app/Session.tsx`: `Plating` (plan being written), `ProblemBanner` (one card per
  failure code with Retry and, when another agent is ready, Switch agent).
- `web/src/app/wait.ts`: `waitLabel` picks the status text from elapsed time.
- `web/src/app/api.ts:118`: the SSE event union the browser accepts.

```tsx
// web/src/app/Round.tsx:378 (FiringUp)
{busy ? <StatusLine dot label={label} note={COPY.roundWaitNote}
  onStop={elapsed >= 60 ? () => void act("stop").catch(() => {}) : undefined} /> : null}
```

Conventions that apply (same as plan 002): pure argv with exact tests; copy in
`web/src/app/copy.ts` with `{agent}` slots; curly apostrophes on screen; the design rules in
`web/src/styles/grillado.css:1-10` (transitions only, nothing loops, nothing animates on
keyboard input; under reduced motion only opacity and color change); real CLI output is kept as
fixtures (`test/fixtures/grok-1.0.70/`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `bun test test/` | all pass |
| Build | `npm run build` | exit 0 |
| One browser test | `CHROME_PATH=<chrome> node e2e/<name>.mjs` | exit 0 |
| All browser tests | `CHROME_PATH=<chrome> npm run e2e` | exit 0 |
| Apostrophe check | `node scripts/apostrophes.mjs` | 0 strings listed |

Not run during planning (read-only).

## Implementation rules relevant to this plan

- **An honest gap beats a fake trail.** An agent whose CLI does not report tool use shows the
  plain status line. Never invent file names or counts.
- **The trail shows paths, not contents.** Every path goes through 002's path check before it
  is stored or sent. Search patterns are shown as the agent sent them, cut to 80 characters.
- **Quiet motion.** A new trail line fades in over `--d-quick` (160 ms). Nothing loops. With
  reduced motion the line appears without movement.
- **Screen readers get a summary, not a stream.** The live region announces the count at most
  once every 10 seconds ("12 files read"), not each file.
- **Throttle.** Send at most four reading updates per second per session over SSE.
- **A correction is the user's word.** It wins over what the agent read, it is exempt from the
  leak filter like other user text (`userText`, `src/core/session.ts:520`), and it is capped
  at 500 characters.
- **No change for sessions without read access.** Their wait screens, events and state stay
  as they are.
- Keep `server.ts` changes to wiring; put the reading state and its throttle in a small module.

## Design

### Reading events

- New `ProviderEvent`: `{ type: "activity"; action: "read" | "search" | "list"; target: string }`.
- New `RunOptions.onActivity`. `runValidated` forwards the event; nothing else changes in it.
- `RunRequest` gains a way to ask for activity events without asking for a text field
  (for example `watch: true`). When set and the spec can, the adapter uses its streaming
  invocation and a reader that maps the CLI's tool-use lines to `activity` events. The final
  reply is still parsed by the spec's `parse`.
- **Claude Code**: the stream-json output carries the agent's tool calls. Capture a real read
  run (the canary repository from plan 002, Step 1) into `test/fixtures/`, find the lines that
  name the tool and its input, and map `Read` to `read` (file path), `Grep` to `search`
  (pattern), `Glob` to `list` (pattern). Make paths relative to the read root.
- **Codex, Grok, pi**: check each CLI's help for a line-by-line event output that works
  together with its structured reply. Add a reader where one exists and a real capture proves
  the shape. Where none exists, the adapter emits no activity events.

### Server

- Per running session keep `{ files: number; recent: string[] }` (the last three targets),
  next to `this.progress`. Reset it when a run starts and clear it when the run ends.
- Broadcast `{ type: "reading", sessionId, files, recent }`, throttled, and include the same
  object in `view(s)` as `reading` so a reload mid-run shows it.
- At the end of a read run, record the files in the activity log under a new `files?: string[]`
  on `run.ended` (first 50, plus a count in `result`). The activity panel shows
  `Read 14 files` with the list behind a disclosure.

### Wait screens

Applies to `FiringUp`, `WaitingView` and `Plating` when the session has read access.

```
Add offline mode to the editor

● Reading grillado…                              [ Skip reading ]
  package.json
  src/core/session.ts
  search: autosave
14 files read · Reading a project can take a few minutes.
```

- Status label: `Reading {project}…` while reading events arrive or before the first one; then
  the existing labels (`Finding the first decisions…`, `Still cooking…`) take over once the
  reply starts or reading has been quiet for 20 seconds.
- Up to three recent lines in the mono face, oldest on top, the newest fading in.
- The count line replaces `COPY.roundWaitNote` for read runs. Without events (an agent with no
  activity output) it reads only `Reading a project can take a few minutes.`
- **Skip reading**: a quiet button on the status line, available from 10 seconds. It stops the
  run and starts the same round or plan again without read access, for this run only. The
  session keeps `codeRead`; later rounds read again. Existing **Stop** stays as it is (from
  60 s).

### When a read run fails

In `ProblemBanner`, when the failed run had read access and the code is `timeout`, `malformed`
or `unknown`, add a second action before Retry: `Ask without reading`. It retries the same
step without read access for this run. The card's primary action stays Retry (one primary
button per surface).

Server: `retry` accepts `{ read: false }`; `stop` followed by the skip uses the same path. Add
one action, do not fork `startRound`.

### Correcting a finding

In the findings list from plan 002, each finding gets a quiet `Not right` button.

```
Storage    Sessions are JSON files under ~/.grillado      src/cli/store.ts
           [ Not right ]

  -> What’s true instead?
     [ Plans are saved in the project now, not only in ~/.grillado ]   [ Save ]
```

- Saving stores `{ findingId, text }` on the session (`Session.corrections`), marks the
  finding as corrected in the UI (the fact struck through, the user's text beneath, labelled
  with `COPY.you`), and can be undone until the next round is sent.
- `stateFor` sends corrections with the findings. Add one line to the grounded prompts: the
  user's corrections win over what was read; do not ask about them again and do not contradict
  them.
- The next round's prompt may reopen a decision that rested on a corrected finding only by
  asking: the agent says so in the question body. Do not auto-reopen decisions.
- Keyboard: `Not right` is in the tab order; Enter saves, Escape cancels and returns focus.

## Scope

**In scope**:

- `src/core/providers/types.ts`, `src/core/providers/base.ts`, `src/core/providers/adapters.ts`
- `src/core/engine.ts`, `src/core/session.ts`, `src/core/prompts.ts`, `src/core/activity.ts`
- `src/cli/server.ts` (wiring), one new small module under `src/cli/` for the reading state
- `web/src/app/api.ts`, `web/src/app/types.ts`, `web/src/app/Round.tsx`,
  `web/src/app/Session.tsx`, `web/src/app/wait.ts`, `web/src/app/copy.ts`,
  `web/src/app/activity/Activity.tsx`, the findings component from plan 002,
  `web/src/styles/grillado.css`
- `test/` (new tests and fixtures), `test/fixtures/fake-agent.mjs`,
  `e2e/grounded.mjs` (extend) or `e2e/reading.mjs` (create), `package.json` (`e2e` script only)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- The read-only contract, eligibility and argv security flags: owned by plan 002. Adding a
  streaming output flag to a read variant is in scope; changing which tools are allowed is not.
- Showing file contents, or any route that serves project files.
- Streaming the questions themselves as they are written.
- Read access for other run kinds.
- Caching findings across sessions.

## Git workflow

- Branch: `feat/reading-trail`, from the branch or `main` that contains plan 002.
- Commit only if the operator asked; `feat: …` / `fix: …` messages as in `git log`.
- Do not push or open a pull request unless the operator asked.

## Steps

### Step 1: Capture real tool-use output

Run each installed CLI's read variant with its streaming output in the canary repository and
save the raw stdout as fixtures. Decide per CLI: reader or no reader.

**Evidence**: fixtures under `test/fixtures/`, and a one-line result per CLI in the notes.

### Step 2: Activity events through the adapter and engine

Add the event type, the request option and `onActivity`. Write the Claude Code reader and any
other reader Step 1 justified. The reply path must be unchanged for requests that do not ask.

**Evidence**: reader tests replay the fixtures and yield the expected `activity` events with
relative paths; `test/adapters.test.ts` has exact-argv tests for each new streaming read
variant; existing stream tests (`test/stream.test.ts`) pass unchanged.

### Step 3: Reading state, SSE and the activity log

Add the per-session reading state with its throttle, the `reading` event, the `view` field and
`files` on `run.ended`.

**Evidence**: a server test with the fake agent (extend it with `FAKE_READ_TRAIL`: a list of
tool-use lines it prints before the reply) receives throttled `reading` events with the right
count, sees `reading` in a mid-run `GET` of the session, and finds `files` in
`activity.jsonl` afterwards. A path outside the read root in the trail never appears.

### Step 4: Wait screens, Skip reading and the failure action

Build the trail in the three wait screens, the Skip button, and `Ask without reading`.

**Evidence**: browser test (Step 6).

### Step 5: Corrections

Add `Session.corrections`, the state and prompt line, the `Not right` flow and its undo.

**Evidence**: unit test: a correction appears in the next round's prompt state and is exempt
from the leak filter; a correction over 500 characters is refused by the route. Browser test
(Step 6).

### Step 6: Browser test and full check

**Evidence**: `npm run typecheck`, `bun test test/`, `npm run build` and
`CHROME_PATH=<chrome> npm run e2e` exit 0.

## Test plan

Unit and integration (bun):

- Readers: fixture replay per CLI; a malformed line is ignored; no events when not asked.
- Server: throttle (a burst of 50 lines gives at most four events in a second, and the final
  count is exact); state cleared after the run; `files` capped at 50 with the full count kept.
- Skip and `Ask without reading`: the rerun's fake-agent log shows the tools-off argv and a
  temp `cwd`; the next round after it reads again.
- Corrections: saved, sent in state, undone, capped, exempt from the filter.
- A session without read access produces no `reading` events and its wait screens' text is
  unchanged (`test/wait`-style tests on `waitLabel`).

Browser (fake agent with `FAKE_DELAY_MS` and `FAKE_READ_TRAIL`, axe on each state):

- First round: `Reading <name>…`, three trail lines at most, the count line updates.
- `Skip reading` appears, and after it the round arrives and the agent log shows no read
  access for that run.
- A read run that times out shows `Ask without reading` beside Retry; using it produces a
  round.
- `Not right` on a finding: type, save, the corrected state shows; undo restores it; all by
  keyboard.
- Reduced motion (`prefers-reduced-motion: reduce`): trail lines appear without transform.
- 390×844: no horizontal scroll on any wait screen; long paths truncate from the left.
- An agent without activity output shows the plain status and note.

## Done criteria

- [ ] `npm run typecheck`, `bun test test/`, `npm run build` exit 0.
- [ ] `CHROME_PATH=<chrome> npm run e2e` exits 0 with no axe violations in the new states.
- [ ] `node scripts/apostrophes.mjs` lists no strings.
- [ ] With Claude Code (real CLI, manual), a first round in a real repository shows file names
      while it reads, and the activity panel lists the files afterwards.
- [ ] No wait screen of a read run shows only a status line and a skeleton for more than
      10 seconds without either a trail line or the Skip button.
- [ ] `Skip reading` and `Ask without reading` each produce a round or plan without read
      access for that run only.
- [ ] A corrected finding is in the next round's prompt state, and the agent's next reply in
      the fake flow does not repeat the corrected fact.
- [ ] Sessions without read access behave exactly as before (existing e2e files unchanged and
      passing).
- [ ] `git status` shows changes only in the in-scope paths; `.factory/plans/README.md` row
      for 003 is updated.

## STOP conditions

Pause and report when:

- Plan 002 is not merged, or its read-only contract differs from what this plan assumes in a
  way that changes the wait screens' meaning (for example, read access became opt-in per run).
- No supported CLI reports tool use in a form that can be read while it still returns the
  structured reply. Then the trail cannot be honest; ship Skip reading, the failure action and
  corrections, and report the trail as blocked.
- Getting activity events requires giving an agent a tool or permission that plan 002's
  contract forbids.

A CLI whose event lines differ from the fixtures is a reason to recapture and adapt.

## Maintenance notes

- **Reviewers**: check that the trail cannot show a path outside the read root, and that the
  streaming read argv keeps every security flag of 002's read argv.
- **CLI drift**: readers depend on each CLI's event lines. Keep the fixtures named by CLI
  version, as `test/fixtures/grok-1.0.70/` does, and recapture when a CLI changes.
- **Later**: corrections are the seed of the project glossary in plan 001's slice E. When that
  slice is planned, consider offering to keep a correction for future sessions.

## Execution notes (2026-11-25)

- **Trail: Claude Code only.** Its `stream-json` output carries each tool call in an `assistant`
  message (fixture: `test/fixtures/claude-2.1.332-read/stream.jsonl`). Grok's `streaming-json`
  doesn't carry the structured reply, and Codex doesn't read (plan 002 notes), so they show the
  plain "Reading {project}…" status and note with no trail lines, as this plan allows.
- Reading runs on Claude Code now use the streaming invocation (same read-only flags; tested).
- The wait JSON field names follow the server: `reading: { files, recent, at }`.
