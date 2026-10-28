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
--no-scan           Don't look in this folder for plans to import (also GRILLADO_NO_SCAN=1)
--data-dir <path>   Sessions and plans (default ~/.grillado, or $GRILLADO_HOME)
```

Requires Node.js 22 or newer.

## Use it from your coding agent (MCP)

`npx grillado mcp` is an MCP server over stdio on the same data as the web app (`~/.grillado`,
`$GRILLADO_HOME` or `--data-dir`). It works whether or not the web app is running and needs no
network. Tools: `list_plans`, `get_plan` (Markdown plus the decisions and their answers; a plan
that isn't finished comes back marked as a draft), `get_decisions`, `start_plan` (sends an idea to
Grillado and returns the link to answer its questions in the browser) and `add_comment` (shows in
the plan's Comments rail as from the coding agent), plus `list_project_sources` and
`import_source` (the planning sessions and plan files found in a project, and importing one as a
plan). Once a plan has been sent to GitHub or Linear, `get_plan` includes its `issues` links. There
is no tool to create issues: that only happens in the browser, after its preview and confirm. Each plan is also a resource,
`grillado://plans/<id>`.

Set it up once, for every project (`npx -y` skips npx's install prompt). If you use a custom
data dir, pass it as `GRILLADO_HOME` (the web app's "Use in your editor" shows these with the
right command and env filled in).

Claude Code:

```sh
claude mcp add --scope user grillado -- npx -y grillado mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "grillado": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "grillado", "mcp"]
    }
  }
}
```

Codex, in `~/.codex/config.toml` (or `codex mcp add grillado -- npx -y grillado mcp`):

```toml
[mcp_servers.grillado]
command = "npx"
args = ["-y", "grillado", "mcp"]
```

Then ask your agent to "build the Grillado plan for …".

## Security

- The server listens on `127.0.0.1` only, checks `Host` and `Origin`, and requires the per-run
  token from the printed URL (exchanged for an HttpOnly cookie).
- Grillado runs no tools for your agent. It starts your agent CLI with a fixed argv, in an empty
  temporary folder, with tools off (Claude Code, Grok, pi) or in Codex's read-only sandbox.
- Send to issues is the only time Grillado talks to a service itself, and only to the destination
  you picked: Linear over HTTPS, or GitHub through your own `gh` (Grillado stores no GitHub token).
  Opening the sheet reads what it needs (your `gh` version and sign-in, repositories and labels;
  Linear teams, projects and labels). Nothing is created or changed until you click the confirm
  button, which names the destination. A Linear API key is kept in `secrets.json` (mode 0600) in the
  data dir, never sent to the browser, and removed by Disconnect.
- While the web app runs it writes `server.json` (port and token, mode 0600) in the data dir, so
  `grillado mcp` can link `start_plan` straight to the new session. It is removed on exit.
- No telemetry.

## Development

```sh
bun install
npm run build      # web (Vite) + CLI (esbuild) + bundle content check
bun test test/     # unit and integration tests with fake agent CLIs
node e2e/run.mjs   # packs, installs, and drives the UI in headless Chrome (CHROME_PATH)
```

See `THIRD_PARTY_NOTICES.md` for licenses of adapted material.
