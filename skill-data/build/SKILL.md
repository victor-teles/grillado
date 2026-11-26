---
name: build
description: Build from a Grillado plan. Follow the user's decisions, leave open decisions to the user, and comment on the plan when something in it doesn't hold.
---

# Build from a Grillado plan

A Grillado plan records decisions the user made. Build what it says.

## Find the plan

```sh
npx -y grillado plan list --json          # newest first; "draft": true means unfinished
npx -y grillado plan get <id> --json      # markdown, decisions, open
```

The plan is also a file in the project: `docs/plans/grillado-plan-<id>.md`, unless the user
picked another plans folder for the project.

## Rules

- **Decisions are settled.** Each line of the plan cites the answer behind it, like `[R1:storage]`: round 1, decision `storage`. Follow it. Don't reopen a decision in chat or quietly choose differently.
- **Open decisions go back to the user.** Anything in `open` (and the plan's "Open decisions" section) was not decided. Ask the user, or suggest running `npx -y grillado plan start` on that question. Don't guess.
- **A draft isn't final.** If `draft` is true, the interview isn't finished; tell the user before building from it.
- **"In your code"** lists the existing files the work touches, when Grillado read the project.
- If something in the plan turns out to be wrong or impossible, say so to the user, and leave a note on that passage so it shows in Grillado:

  ```sh
  npx -y grillado plan comment <id> --quote "<exact text from the plan>" --text "<what you found>"
  ```

  `--quote` must be copied exactly from the plan's Markdown.

## Work in slices

Build the plan in small end-to-end pieces, each one something the user can try. Check each piece against the decisions it cites before moving on.
