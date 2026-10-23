# Grillado

Turn a raw idea into a plan you understand, one round of questions at a time.

Grillado runs locally on the coding agent you already have (Claude Code, Codex, Grok, or pi).
No API keys: it uses your CLI's existing login.

```sh
npx grillado
```

A browser tab opens. Describe the idea, answer rounds of questions (number keys pick, Enter
sends, the recommendation is preselected), confirm the decisions, and get a `plan.md` that cites
the answer behind every decision.

## Options

```
--port <n>          Port (default 4747, or the next free one). With --port, a busy port is an error.
--provider <id>     claude | codex | grok | pi
--model <id>        Passed through to the agent CLI
--no-open           Don't open a browser; just print the URL
--data-dir <path>   Sessions and plans (default ~/.grillado, or $GRILLADO_HOME)
```

Requires Node.js 22 or newer.

## Security

- The server listens on `127.0.0.1` only, checks `Host` and `Origin`, and requires the per-run
  token from the printed URL (exchanged for an HttpOnly cookie).
- Grillado runs no tools itself. It starts your agent CLI with a fixed argv, in an empty
  temporary folder, with tools off (Claude Code, Grok, pi) or in Codex's read-only sandbox.
- No telemetry.

## Development

```sh
bun install
npm run build      # web (Vite) + CLI (esbuild) + bundle content check
bun test test/     # unit and integration tests with fake agent CLIs
node e2e/run.mjs   # packs, installs, and drives the UI in headless Chrome (CHROME_PATH)
```

See `THIRD_PARTY_NOTICES.md` for licenses of adapted material.
