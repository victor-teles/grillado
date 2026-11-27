# Grillado

Plan software with your coding agent. Describe the idea, answer a few rounds of questions in your
browser, and get a plan in which every decision is yours, cited to the answer behind it.

```sh
npx grillado
```

Run it from your project folder. A browser tab opens; the plan is saved as
`docs/plans/grillado-plan-<id>.md` there, so you can commit it with your code. Inside a git
repository the agent reads the project (and only reads) to ask better questions.

Needs Node.js 22 or newer and one coding agent CLI, logged in: Claude Code, Codex, Grok or pi.
No API keys: Grillado uses your CLI's own login.

## Use it from your coding agent

Install the skill once, so your agent knows when to use Grillado:

```sh
npx skills add victor-teles/grillado
```

Then ask it to "plan … with Grillado", or just "help me plan …". It runs
`npx -y grillado plan start`, you answer in the browser, and it builds from your plan.

**Claude Code**: the skill above is all you need. To use MCP instead:

```sh
claude mcp add --scope user grillado -- npx -y grillado mcp
```

**Codex**: the skill above, or MCP:

```sh
codex mcp add grillado -- npx -y grillado mcp
```

**Cursor**: the skill above, or MCP in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "grillado": { "type": "stdio", "command": "npx", "args": ["-y", "grillado", "mcp"] } } }
```

**Any other agent**: add this to your `AGENTS.md` or `CLAUDE.md`:

```markdown
When I ask to plan, scope or spec something, run `npx -y grillado skills get plan` and follow it.
When building from a plan in docs/plans/grillado-plan-*.md, run `npx -y grillado skills get build`.
```

## More

- [Options and where plans are saved](docs/cli.md)
- [Commands and MCP tools for agents](docs/agents.md)
- [Security](docs/security.md): local only, what the agent may read, what it can't do
- [Contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md)
- License: [MIT](LICENSE)
