# Security

- The server listens on `127.0.0.1` only, checks `Host` and `Origin`, and requires the per-run
  token from the printed URL (exchanged for an HttpOnly cookie).
- Grillado runs no shell commands for your agent. It starts your agent CLI with a fixed argv.
- **Reading your project.** Inside a git repository, the agent may read the project while it asks
  questions and writes the plan, so it doesn't ask what the code already answers. It reads from the
  repository's top folder and can't change files or go online:
  - Claude Code gets only its Read, Grep and Glob tools, loads your user settings only (a
    project's own settings and hooks are not loaded) and no MCP servers. Environment files, keys,
    credentials and `.git` are denied to it.
  - Grok gets only `read_file`, `grep` and `list_dir`, in its read-only sandbox. Its MCP tools
    are removed and every MCP call is denied, as are reads and searches of environment files,
    keys, credentials and `.git`.
  - Codex and pi don't read the project yet. Codex offers its plugin and connected-app tools
    (some of which go online) with no way to turn them off, so a file in the project could steer
    one. They run as before, in an empty temporary folder.
  - Every path an agent names is checked by Grillado (inside the project, existing, not
    sensitive) before it is shown or written into a plan.
  - Home shows what the agent may do before you start. Turn it off per project there, or for
    every project with `--no-code` or `GRILLADO_NO_CODE=1`. Outside a git repository, in your
    home folder or at a filesystem root, nothing is read.
- **Option previews.** An option can carry a preview the agent wrote: a UI mock (HTML and CSS),
  a code sketch or a diagram. That text is not trusted:
  - A UI mock is only shown inside a frame with an empty `sandbox` attribute: it gets an origin of
    its own (it can't read Grillado's page, cookie or storage), runs no scripts, sends no forms and
    can't navigate the page. The frame's document carries its own content security policy that
    loads nothing from the network (inline CSS and `data:` images only), and tags that would
    redirect the frame are removed.
  - A code sketch is shown as text. A diagram is drawn by the same renderer as the plan's (pele),
    in the browser: it escapes the diagram's text, writes no scripts or HTML labels, and Grillado
    turns its links and images off, so a diagram can't be clicked through or fetch anything.
  - Previews are saved with the session, and the source of each preview you chose is written
    into the plan file as a fenced code block. Nothing is written anywhere else in your project.
  - "Show me another" is one more agent run with tools off, like a comment reply.
- **Building from a plan.** `grillado build` and the `build_*` MCP tools only read and write
  Grillado's own data: the session, and the "Build steps" and "Build log" sections at the end of
  the plan file. They run nothing and write no other file. A coding agent can report progress,
  ask a question and withdraw its own question; it cannot answer one. Answers only come from the
  browser, through the same token-protected local server as everything else. The text an agent
  sends (step reports, a question and its options) is shown as text.
- Comment replies, edits, diagrams, imports, "Show me another" and the issue split run in an empty temporary folder
  with tools off (Claude Code, Grok, pi) or in Codex's read-only sandbox. "Tools off" means the
  CLI's built-in tools: in these runs Codex and Grok may still offer MCP tools from your own
  configuration. Nothing from your project is in front of the agent in these runs, only your own
  idea, answers and plan.
- Send to issues is the only time Grillado talks to a service itself, and only to the destination
  you picked: Linear over HTTPS, or GitHub through your own `gh` (Grillado stores no GitHub token).
  Opening the sheet reads what it needs (your `gh` version and sign-in, repositories and labels;
  Linear teams, projects and labels). Nothing is created or changed until you click the confirm
  button, which names the destination. A Linear API key is kept in `secrets.json` (mode 0600) in the
  data dir, never sent to the browser, and removed by Disconnect.
- While the web app runs it writes `server.json` (port and token, mode 0600) in the data dir, so
  `grillado mcp` and `grillado plan start` can link straight to the new session. It is removed on
  exit.
- `grillado plan start` starts the web app in the background when it isn't running, on
  `127.0.0.1` like any other run, with `--exit-when-idle`: it quits after 30 minutes with no
  browser open and nothing running. The `grillado plan` commands never answer questions or
  confirm a plan; only you do, in the browser.
- No telemetry.
