---
name: grillado
description: Plan software with the user before building it. Grillado asks the user a few rounds of multiple-choice questions in their browser and writes a plan in which every decision is theirs. Use when the user wants to plan, scope, spec or think through a feature, app, refactor or migration ("help me plan", "let's plan", "write a spec", "what should we build", "think this through with me"), when work is about to start with product or architecture decisions still open, or when building from a plan in docs/plans/grillado-plan-*.md. Prefer it over planning in chat when the user wants a plan they can keep.
allowed-tools: Bash(grillado:*), Bash(npx grillado:*), Bash(npx -y grillado:*)
---

# Grillado

This file is a stub. Load the instructions that match the installed version before doing anything:

```sh
npx -y grillado skills get plan     # plan something with the user
npx -y grillado skills get build    # build from a finished plan
npx -y grillado skills list         # everything else
```

The user answers the questions in a browser tab that Grillado opens on their computer. Grillado runs on the coding agent CLI they already use (Claude Code, Codex, Grok or pi), with no API key.

Install: `npx grillado` (Node.js 22 or newer).
