# Plan 001: Grillado becomes the place where software decisions get made

> **Reader instructions**: This is a direction plan. It sets the product thesis, the UX
> principles every later plan must meet, and the order of work. It is not executed directly.
> Plans 002 and 003 are the executable first slice. Each later slice gets its own plan
> (`/factory plan <slice>`) when its turn comes, written against the code as it is then.

## Status

- **Priority**: P1
- **Effort**: L (the whole direction; each slice is S to L)
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `3dcd618`, 2026-11-24 (clean tree, branch `t3/factory-plan-product-ux`)

## Why this matters

Grillado 0.1.7 does one thing well: it turns an idea into a `plan.md` through rounds of
multiple-choice questions, and every plan line cites the answer behind it. Three gaps keep it
from solving real problems for developers and builders:

1. **It cannot see the project.** The agent runs with tools off in an empty temp folder
   (`src/cli/server.ts:785`, `src/core/providers/adapters.ts:10`). The interview prompt says so
   in plain words: "You have no tools in this session and cannot look anything up"
   (`src/core/prompts.ts:28`). It asks things the repository could answer, and the plan is told
   not to name files (`src/core/prompts.ts:52`).
2. **Options are only words.** A question offers 2 to 6 labels with a description
   (`src/core/schema.ts:13-29`). For a layout, an API shape or a data model, the user picks
   without seeing anything.
3. **The loop ends at the plan.** The coding agent can read a plan over MCP
   (`src/cli/mcp.ts`), but nothing flows back. When the build hits an undecided point, the
   coding agent guesses.

When this direction lands, Grillado knows the project it runs in, shows options instead of
describing them, and stays in the loop while the plan is built.

## Product thesis

**Grillado is where you decide what to build. It knows your project, shows you the options,
and keeps your coding agent on the decisions you made.**

Three pillars, in the order they ship:

| Pillar | What the user gets | Today |
|---|---|---|
| **Grounded** | Questions that cite the user's own code. Nothing asked that the project answers. Plans that name real files. | Code-blind |
| **Shown** | Options the user can look at and compare: a UI mock, a code sketch, a diagram. Later, real throwaway builds. | Text labels |
| **Kept** | The plan drives the build slice by slice. The coding agent sends undecided points back to the user. Decisions also become project docs. | Ends at `plan.md` |

Who it is for: developers working in an existing repository, and builders who direct a coding
agent without reading every line. Both need the same thing: to make the decisions that matter
quickly, with enough in front of them to decide well.

## Decisions made (2026-11-24, by Victor)

| Decision | Choice | Consequence |
|---|---|---|
| How Grillado learns about the project | The agent gets **read-only** file access inside the project | The README promise changes from "tools off" to "read-only". No write access, no commands started by Grillado, no network tools. Plans 002 and 003. |
| What a prototype is | **Previews on options first, real builds later** | Previews touch nothing in the repo. Real builds in git worktrees are a later phase with their own security decision. |
| How far into building | **Hand off and listen back** | Grillado never writes product code. The coding agent pulls slices over MCP and can send a decision back. |
| What ships first | **Knows my code** | Grounding makes every later feature better, including previews that match the real UI. |
| How coding agents drive Grillado | **CLI commands, MCP optional** | A skill plus `grillado plan …` commands work in any harness with a shell and no setup. Plan 004. |
| What the README is | **Install guide plus agent integration** | Options, security, development and publishing move to `docs/` and `CONTRIBUTING.md`. Plan 004. |

## Alternatives considered and rejected

- **Grillado-built snapshot instead of agent file access**: keeps "tools off", but the agent
  cannot follow a lead into the code. Rejected for depth.
- **Stay code-blind**: the largest gap for developers stays open.
- **Real builds first**: most convincing, but slowest and it needs write access before the
  product has earned that trust.
- **Grillado runs the build itself**: turns a planning tool into a build tool and competes with
  the coding agents it runs on.
- **Planning only**: leaves the "iterate" problem unsolved.

## UX principles (every later plan must meet these)

UX and UI are the first principle of this direction. Each principle has a check a reviewer can
run.

1. **Show, do not describe.** When an option can be seen, it is shown.
   *Check*: a question about layout, API shape, data shape or flow has something to look at.
2. **Never ask what the project can answer.** Facts come with their source. Decisions go to
   the user. *Check*: every fact the agent states about the project names a file that exists.
3. **The suggested path is one keypress.** Every screen has one primary action on Enter and the
   whole flow works from the keyboard. *Check*: a session can be finished without a pointer.
4. **Waiting is never blank.** While the agent works, the screen says what it is doing and
   what is already saved. *Check*: no wait state shows only a spinner or a skeleton.
5. **Nothing is lost and everything can be undone.** Any decision can be reopened. Any agent
   edit is a suggestion until accepted. *Check*: no agent action changes the plan or the repo
   without a visible accept step.
6. **Trust is visible.** What the agent may do is stated where it acts.
   *Check*: the screen that starts an agent run names its access in plain words.
7. **Plain words.** No jargon, no method names, no agent name hard-coded in a sentence.
   *Check*: copy lives in `web/src/app/copy.ts` templates with `{agent}` slots.
8. **Quiet by default.** One type ramp (12/14/17/24), weights 400/500/600, one primary button
   per surface, ember only for heat and "open now", transitions only, nothing loops.
   These are the existing rules in `web/src/styles/grillado.css:1-10`. *Check*: no new token,
   weight or looping animation is added without a stated reason.
9. **Works everywhere it is opened.** Phone width (390 px), dark and light, reduced motion,
   screen reader. *Check*: the screen passes axe in `e2e/` and has no horizontal scroll at
   390 px.

## Vocabulary

Use these names in code, copy and later plans. Keep them stable.

| Term | Meaning |
|---|---|
| **Round** | One batch of up to 6 questions (exists today). |
| **Decision** | A settled answer, cited in the plan as `[R<round>:<key>]` (exists today). |
| **Finding** | A fact the agent read from the project and therefore did not ask. Always has at least one source path. |
| **Evidence** | The project files a question is based on, shown on its card. |
| **Preview** | Something to look at on an option: a UI mock, a code sketch, or a diagram. |
| **Slice** | A thin end-to-end piece of the plan that can be built on its own (exists in Send to issues). |
| **Ask** | A decision the coding agent sends back to the user during the build. |

Never surface the terms in `BANNED_TERMS` (`src/core/filter.ts:4`) in the UI, network replies,
MCP surface or exported plans. `npm run build` enforces this through `scripts/check-banned.mjs`.

## Roadmap

Order is a recommendation after slice A. Each slice is planned in detail only when it is next.

### Slice A: Knows your code (plans 002 and 003, planned)

The agent reads the project (read-only) when it writes rounds and the plan. Questions carry
evidence. Findings list what it did not need to ask. The plan names real files. The user sees
what the agent may do and can turn it off.

- **002** delivers the grounded round end to end: access, prompts, evidence, findings, the
  plan's file list, disclosure and opt-out, security docs.
- **003** delivers the waiting experience and the correction loop: a live trail of what is
  being read, a way out when reading is slow, and "Not right" on a finding.

### Agents find and use Grillado (plan 004, planned)

Not a pillar of its own: it is the front door to all three. A discovery skill lets a coding
agent recognise a planning request; `grillado skills get <name>` serves instructions that
match the installed version; `grillado plan start | wait | get | list | comment` let the agent
drive Grillado from a shell with no MCP setup. The README becomes an install guide plus how to
connect each agent. Independent of slice A; slice D extends the same commands.

### Slice B: See before you choose (to plan next)

**Outcome**: an option can carry a preview, and the user compares previews side by side
before picking.

```
How should the list look?

+-----------+ +-----------+ +-----------+
| [mock A]  | | [mock B]  | | [mock C]  |
| rows      | | cards     | | board     |
+-----------+ +-----------+ +-----------+
 (*) Rows      ( ) Cards     ( ) Board
     suggested

[ Compare ]  [ Show me another ]
```

Constraints the plan for this slice must honor:

- Three preview kinds: **ui** (self-contained HTML and CSS), **code** (a short sketch of the
  caller's side, highlighted), **diagram** (Mermaid, reusing `web/src/app/editor/DiagramView.tsx`
  and `checkMermaid` in `src/core/diagrams.ts`).
- A `ui` preview is agent-written markup. It renders only in a sandboxed `iframe` with an
  opaque origin, no scripts in the first version, and a content security policy that blocks
  every network request. It must never share an origin with the app, which holds the session
  cookie.
- Previews are optional per question. The agent adds them only when seeing helps. A question
  with previews must still be answerable by number key.
- Previews use the project's look when slice A found one (fonts, colors, component names).
- Nothing is written to the repository.
- New actions: **Compare** (side by side, full width), **Show me another** (one more option
  with a preview, one agent call).

Open questions for that plan: preview size limits, how previews print into `plan.md` (likely a
link to a saved file next to the plan), and phone layout (one preview at a time, swipe or
arrow keys).

### Slice C: Easier to steer (proposed, not yet confirmed)

Two small changes that make the interview fit the job:

- **Depth on the home screen**: Quick (1 round), Standard (2), Deep (4), replacing the
  CLI-only `--max-rounds` (`src/cli/args.ts:52`). A bug fix and a new product should not get
  the same interview.
- **Ask about this** on a question card: one short exchange with the agent before deciding
  ("why this pick?", "what does option B cost me?"). Reuses the comment reply run
  (`replyToComment`, `src/core/engine.ts:316`).

### Slice D: Plan to build loop (hand off and listen back)

**Outcome**: the coding agent builds the plan slice by slice and never guesses a decision.

- The plan gets a first-class **Build steps** section: the slices that Send to issues already
  computes (`splitPlan`, `src/core/engine.ts:482`), each with a way to tell it is done.
- New MCP tools next to the existing ones in `src/cli/mcp.ts`: get the next slice, report a
  slice started or done, and **ask a decision**. An ask shows up in the browser as a question
  card with the agent's options; the answer becomes a cited decision in the plan and is
  returned to the coding agent.
- The plan view shows slice status and open asks.
- Grillado still writes no product code and runs no commands.

### Slice E: Living docs

**Outcome**: decisions outlive the plan. As terms and hard-to-reverse choices settle, Grillado
proposes a glossary entry or a short decision record, and writes it into the repository only
when the user accepts.

- Glossary and decision records are read as project context in later sessions (slice A reads
  them like any file).
- Writing follows the existing precedent: Grillado already writes
  `docs/plans/grillado-plan-<id>.md` into the project (`src/cli/store.ts:139`).
- File locations and formats are a decision for that plan. Check what the repository already
  uses before proposing new paths.

### Slice F: Real builds (phase two of prototypes)

**Outcome**: for a decision that only running code can settle, the agent builds two or three
throwaway variants in git worktrees, and the user runs and compares them.

This is the first feature that needs write access and command execution. It needs its own
security decision, an explicit per-use consent step, and its own plan. Do not start it from
this document.

## Shared constraints for every slice

- **Local and keyless.** No API keys, no telemetry, the server on `127.0.0.1` only
  (`README.md:92-106`).
- **Every provider, or an honest gap.** Claude Code, Codex, Grok and pi are supported
  (`src/core/providers/adapters.ts:265`). A feature one CLI cannot support is turned off for
  that agent with a plain explanation, never faked.
- **Stateless agent calls.** Each call resends a compact state (`stateFor`,
  `src/core/engine.ts:79`). New knowledge that later calls need is saved on the session and
  sent in that state.
- **One flat JSON reply per call**, validated with Zod and repaired once (`runValidated`,
  `src/core/engine.ts:170`). Optional hints are parsed leniently so a bad hint never fails a
  round (see `upcoming`, `src/core/schema.ts:44`).
- **Hidden prompts stay hidden.** Every new prompt constant is added to `promptFragments()`
  (`src/core/prompts.ts:144`).
- **Adapted text is credited.** Prompt text adapted from a third-party source is listed in
  `THIRD_PARTY_NOTICES.md`.
- **On-screen copy uses curly apostrophes.** `node scripts/apostrophes.mjs` lists violations.

## Done criteria for the direction

- [ ] Plans 002, 003 and 004 are DONE in `.factory/plans/README.md`.
- [ ] Each of slices B to F has its own plan before work on it starts.
- [ ] Every shipped slice passes the nine UX principle checks above.
- [ ] `README.md` Security matches what each release can actually do.

## Maintenance notes

- Revisit the slice order after slice A ships. Real use of grounded rounds will show whether
  previews (B) or the build loop (D) is the bigger pull.
- Slice C is a proposal. Confirm or drop it before planning it.
- The security posture now has three steps: tools off (today), read-only (slice A), write in
  worktrees (slice F). Each step is opt-out or opt-in on its own and documented on its own.
