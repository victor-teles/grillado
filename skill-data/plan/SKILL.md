---
name: plan
description: Plan a feature, app, refactor or migration with the user in Grillado before building it. The user answers a few rounds of questions in the browser and gets a plan whose every decision is theirs.
---

# Plan with Grillado

Grillado turns an idea into a plan through a few rounds of multiple-choice questions that **the user** answers in their browser. Every decision in the plan cites the answer behind it, so you build what they decided, not what you guessed.

## When to use it

Use it when the user wants to plan, scope, spec or think something through before it is built: a feature, an app, a refactor, a migration. Phrases like "let's plan…", "help me plan…", "write a spec for…", "what should we build…", "think this through with me".

Don't use it for a one-line fix, a question with one obvious answer, or when the user wants you to just do it.

## How

1. Tell the user, in one sentence, that a browser tab is about to open with questions for them.

2. Start the plan, in the project folder, with the idea in the user's own words: the thing to build, not the request around it ("A dark mode toggle", not "let's plan a dark mode toggle"). Put what you know that they didn't say (the stack, what exists, constraints) in the context:

   ```sh
   npx -y grillado plan start "Let people save a cart and come back later" --context "Next.js app, Postgres via Prisma, guest checkout exists" --json
   ```

   For long context, write it to a file and pass `--context-file <path>`.

   It prints the plan `id` and opens the questions in the browser (it starts Grillado's local web app if it isn't running). If `url` is null, tell the user the command in `next` and stop there.

3. Wait for the user to finish. Don't answer the questions for them, and don't plan in chat meanwhile:

   ```sh
   npx -y grillado plan wait <id> --json
   ```

   - `"result": "ready"`: the plan is in `markdown`, with `decisions` (each question's answer) and `open` (decisions still open).
   - `"result": "waiting"`: run the same command again. If you can't keep waiting (your session limits it), tell the user the questions are open in their browser and to tell you when they're done; then run `npx -y grillado plan get <id>`. If it says the last agent run failed, tell the user to retry in the browser.

4. Show the user a short summary of the plan and ask whether to start building. To build from it, run `npx -y grillado skills get build`.

## Good to know

- The plan is also saved in the project at `docs/plans/grillado-plan-<id>.md`.
- `npx -y grillado plan list` lists plans; `npx -y grillado plan get <id>` prints one.
- Grillado runs on the user's own coding agent CLI and login (Claude Code, Codex, Grok or pi). It needs no API key. If none is installed, the browser says how to add one.
- If Grillado's MCP tools are available to you (`start_plan`, `get_plan`), you can use them instead; `npx -y grillado skills get mcp` maps them.
