// `grillado mcp` (v1.2 item 1): a stdio MCP server over the same data dir as the web app, so the
// coding agent the user builds with can read plans and decisions, start a new plan, and comment.
// Local only: no network. stdout carries the protocol; anything else goes to stderr.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MAX_COMMENT, MAX_QUOTE, addCoderComment } from "../core/comments.ts";
import { PROVIDER_IDS } from "../core/providers/types.ts";
import { type Session, createSession } from "../core/session.ts";
import { shellQuote } from "./launch.ts";
import { type Store, defaultDataDir } from "./store.ts";

const URI = "grillado://plans/";
const planId = z.string().regex(/^[\w-]{1,80}$/, "A plan id looks like 2026-10-26-1a2b3c4d (see list_plans).");

export class UnknownPlan extends Error {
  constructor(id: string) {
    super(`No plan with id "${id}". Call list_plans to see the ids.`);
  }
}

const titleOf = (s: Session) => s.plan?.title || s.idea.split("\n")[0].slice(0, 80);
/** Not confirmed yet: no plan written, or the interview reopened after it was. */
const isDraft = (s: Session) => s.status !== "plated" || !s.plan;

export function summary(s: Session) {
  return {
    id: s.id,
    title: titleOf(s),
    status: s.status,
    draft: isDraft(s),
    decisions: Object.keys(s.decisions).length,
    updatedAt: s.updatedAt,
    uri: URI + s.id,
  };
}

export function decisionsOf(s: Session) {
  return {
    id: s.id,
    draft: isDraft(s),
    decisions: Object.values(s.decisions)
      .sort((a, b) => a.round - b.round)
      .map((d) => ({
        key: d.key,
        title: d.title,
        answer: d.answer,
        round: d.round,
        /** "unknown" means the user left the call to the agent. */
        kind: d.kind,
        acceptedRecommendation: d.accepted_recommendation,
        dependsOn: d.dependsOn,
      })),
    open: s.plan?.openDecisions ?? [],
    stale: Object.values(s.stale ?? {}).map((d) => ({ key: d.key, title: d.title, reason: d.reason })),
  };
}

/** The plan's Markdown (plan.md is the source of truth), or a draft built from the decisions so far. */
export function markdownOf(store: Store, s: Session): string {
  const md = s.plan ? (store.readPlan(s.id) ?? s.plan.markdown) : null;
  if (md !== null && !isDraft(s)) return md;
  const note = `> **Draft.** This plan isn't confirmed yet (status: ${s.status}). Finish the interview in Grillado for the final plan.`;
  if (md !== null) return `${note}\n\n${md}`;
  const lines = Object.values(s.decisions)
    .sort((a, b) => a.round - b.round)
    .map((d) => `- **${d.title}**: ${d.answer}`);
  return [`# Draft: ${titleOf(s)}`, "", note, "", "## Idea", "", s.idea, ...(s.context ? ["", "## Context", "", s.context] : []), "", "## Decisions so far", "", ...(lines.length ? lines : ["None yet."]), ""].join("\n");
}

function load(store: Store, id: string): Session {
  const s = store.load(id);
  if (!s) throw new UnknownPlan(id);
  return s;
}

const text = (t: string) => ({ type: "text" as const, text: t });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Tool errors come back as `isError` results the agent can read, not protocol errors. */
async function safely(fn: () => { content: ReturnType<typeof text>[]; structuredContent?: Record<string, unknown> }) {
  try {
    return fn();
  } catch (err: any) {
    return { content: [text(String(err?.message ?? err))], isError: true };
  }
}

/** appLine: how to start the web app for this build and data dir, for start_plan's app-closed hint
 *  (main passes launch.ts's appLine; the fallback is the published package with this data dir). */
export function createMcpServer(store: Store, version = "0.0.0-dev", appLine = `npx grillado${store.dir === defaultDataDir() ? "" : ` --data-dir ${shellQuote(store.dir)}`}`): McpServer {
  const mcp = new McpServer({ name: "grillado", version });
  const clientName = () => mcp.server.getClientVersion()?.name;

  mcp.registerTool(
    "list_plans",
    {
      title: "List plans",
      description: "List the plans in Grillado, newest first: id, title, status, whether it is still a draft, and its resource URI.",
      inputSchema: {},
    },
    async () =>
      safely(() => {
        const plans = store.list().map(summary);
        return { content: [plans.length ? json(plans) : text("No plans yet. Use start_plan to send an idea to Grillado.")], structuredContent: { plans } };
      }),
  );

  mcp.registerTool(
    "get_plan",
    {
      title: "Get a plan",
      description:
        "Get one plan's Markdown and its resolved decisions with their answers. A plan whose interview isn't finished comes back as a draft (draft: true) built from the decisions so far.",
      inputSchema: { plan: planId.describe("The plan id from list_plans") },
    },
    async ({ plan }) =>
      safely(() => {
        const s = load(store, plan);
        const markdown = markdownOf(store, s);
        const d = decisionsOf(s);
        return {
          content: [text(markdown), json({ id: s.id, title: titleOf(s), status: s.status, draft: d.draft, decisions: d.decisions, open: d.open })],
          structuredContent: { ...summary(s), markdown, decisions: d.decisions, open: d.open },
        };
      }),
  );

  mcp.registerTool(
    "get_decisions",
    {
      title: "Get a plan's decisions",
      description: "Get the decisions behind one plan: each question's answer, the round it was settled in and what it depends on, plus decisions still open or waiting to be asked again.",
      inputSchema: { plan: planId.describe("The plan id from list_plans") },
    },
    async ({ plan }) =>
      safely(() => {
        const d = decisionsOf(load(store, plan));
        return { content: [json(d)], structuredContent: d };
      }),
  );

  mcp.registerTool(
    "start_plan",
    {
      title: "Start a plan",
      description:
        "Send a new idea to Grillado to be planned. Creates the session and returns its local URL; the user answers the interview questions in the browser. Give the URL to the user.",
      inputSchema: {
        idea: z.string().trim().min(1, "Describe the idea.").max(8000).describe("The idea, in the user's words"),
        context: z.string().max(20_000).optional().describe("Optional background: the codebase, constraints, what exists already"),
      },
    },
    async ({ idea, context }) =>
      safely(() => {
        const s = createSession({ idea, context, provider: store.readConfig().defaultProvider ?? PROVIDER_IDS[0] });
        s.queued = true;
        // Always marked editor-started; a client without a usable name reads "From your editor" (#108).
        s.from = (clientName() ?? "").slice(0, 80);
        store.create(s);
        const info = store.readServerInfo();
        const url = info ? `http://127.0.0.1:${info.port}/s/${s.id}?t=${info.token}` : null;
        const next = url
          ? `Open ${url} to answer Grillado's questions.`
          : `Grillado's web app isn't running. Run \`${appLine}\` and open this idea from Recent; the questions start there.`;
        return { content: [text(`Started plan ${s.id}. ${next}`)], structuredContent: { id: s.id, url, uri: URI + s.id, next } };
      }),
  );

  mcp.registerTool(
    "add_comment",
    {
      title: "Comment on a plan",
      description:
        "Leave a comment on a passage of a written plan. It shows in Grillado's Comments rail as from the coding agent. `quote` must be copied exactly from the plan's Markdown (get_plan).",
      inputSchema: {
        plan: planId.describe("The plan id from list_plans"),
        quote: z.string().min(1, "Quote the passage the comment is on.").max(MAX_QUOTE).describe("The exact plan text the comment is on"),
        text: z.string().trim().min(1, "Write the comment.").max(MAX_COMMENT).describe("The comment"),
      },
    },
    async ({ plan, quote, text: body }) =>
      safely(() => {
        const t = store.update(plan, (s) => {
          if (s.status !== "plated" || !s.plan) throw new Error(`Plan "${plan}" is still a draft: comments open once its plan is written.`);
          const view = { comments: s.comments, plan: { markdown: store.readPlan(s.id) ?? s.plan.markdown } };
          let thread;
          try {
            thread = addCoderComment(view, { quote, text: body, client: clientName() });
          } catch {
            throw new Error("That quote isn't in the plan. Copy it exactly from get_plan's Markdown.");
          }
          s.comments = view.comments;
          s.updatedAt = new Date().toISOString();
          return thread;
        });
        if (!t) throw new UnknownPlan(plan);
        return { content: [text(`Comment added to plan ${plan}. It's in Grillado's Comments rail.`)], structuredContent: { plan, thread: t.id } };
      }),
  );

  mcp.registerResource(
    "plan",
    new ResourceTemplate(`${URI}{id}`, {
      list: async () => ({
        resources: store.list().map((s) => ({
          uri: URI + s.id,
          name: titleOf(s),
          description: isDraft(s) ? `Draft (${s.status})` : "Plan",
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "Grillado plan", description: "One plan's Markdown (a draft while its interview isn't finished)", mimeType: "text/markdown" },
    async (uri, { id }) => {
      const s = load(store, String(id));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdownOf(store, s) }] };
    },
  );

  return mcp;
}

export async function runMcp(store: Store, version: string, appLine?: string): Promise<void> {
  const mcp = createMcpServer(store, version, appLine);
  await mcp.connect(new StdioServerTransport());
  console.error(`grillado mcp: serving ${store.dir} over stdio`);
}
