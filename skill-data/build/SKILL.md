---
name: build
description: Build from a Grillado plan step by step. Follow the user's decisions, report each step with what you verified, and ask the user in Grillado when the plan doesn't cover a decision, instead of guessing.
---

# Build from a Grillado plan

A Grillado plan records decisions the user made and the steps to build them. Build what it says, one step at a time, and report back through `grillado build`, so the plan shows what was built.

## Read the plan

```sh
npx -y grillado plan list --json          # newest first; "draft": true means unfinished
npx -y grillado plan get <id> --json      # markdown, decisions, open, and build (revision, steps, asks)
```

The plan is also a file in the project: `docs/plans/grillado-plan-<id>.md`, unless the user picked another plans folder. It ends with "Build steps" and "Build log"; Grillado writes those two sections, so don't edit them by hand.

## The loop

1. Get the step to work on, and say you started it:

   ```sh
   npx -y grillado build next <id>
   npx -y grillado build start <id>
   ```

   Each step has a done check ("Done when: …"). The order is the user's.

2. Build that step, end to end, and run its done check.

3. Report it done. `--verified` is required: the checks you ran and what they showed. Add `--deviation` when you moved away from the plan, and say why.

   ```sh
   npx -y grillado build done <id> --verified "bun test test/cart.test.ts: 14 pass; saved a cart and reopened it in the browser" --deviation "Kept carts in the session table, not a new one: it already has the user id"
   ```

   Don't report a step done on a check you didn't run. The user can reopen a step.

4. Run `build next` again until it says every step is done. Then tell the user what was built.

A plan written before build steps existed has none: `build next` says so. Build from the plan text and tell the user they can add steps in Grillado's Build tab.

## When the plan doesn't cover a decision

Don't guess, and don't ask in chat or leave a comment for it. Ask in Grillado, with options of your own, and wait:

```sh
npx -y grillado build ask <id> --key ask-cart-expiry --title "How long should a saved cart be kept?" --option a="30 days" --option b="Until the user clears it" --suggest a
npx -y grillado build wait <id> --ask ask-cart-expiry --json
```

- `--key` is a new lowercase-kebab-case name for this question. `--body "<text>"` adds what the user needs to know; `--note a="<text>"` describes an option.
- The question shows in Grillado as a card marked "Agent is waiting". Only the user answers it. Their answer becomes a decision in the plan, cited `[B:ask-cart-expiry]`, and comes back from `build wait` as `"result": "answered"`.
- `"result": "waiting"` means the timeout passed first (540 s by default): run the same `build wait` again. Tell the user you are waiting on their answer in Grillado.
- If you find the answer in the plan after all, take the question back: `npx -y grillado build withdraw <id> --ask ask-cart-expiry`. A withdrawn question is never a decision.
- Never answer your own question, and never build on a guess while it is open. Work on something the question doesn't touch, or wait.

## When the plan changes under you

Every `build` reply gives the plan's revision. When the user changed the plan since you last read it (a new decision, an edited section, a step edited, moved or reopened), the reply lists what changed. Run `npx -y grillado plan get <id>` again before the next step, and redo what the change touches.

## Rules

- **Decisions are settled.** Each line of the plan cites the answer behind it: `[R1:storage]` is round 1, decision `storage`; `[B:ask-storage]` was decided during the build. Follow it. Don't reopen a decision in chat or quietly choose differently.
- **Open decisions go back to the user.** Anything in `open` (and the plan's "Open decisions" section) was not decided: ask it with `build ask`.
- **A draft isn't final.** If `draft` is true, the interview isn't finished; tell the user before building from it.
- **"In your code"** lists the existing files the work touches, when Grillado read the project.
- If something in the plan turns out to be wrong or impossible, say so to the user, and leave a note on that passage so it shows in Grillado:

  ```sh
  npx -y grillado plan comment <id> --quote "<exact text from the plan>" --text "<what you found>"
  ```

  `--quote` must be copied exactly from the plan's Markdown.
