import { z } from "zod";
import { NO_PREVIEW, type Preview, type RawPreview } from "./previews.ts";

/** At most this many questions in one round, one decision each (#35, PO override). */
export const MAX_QUESTIONS = 6;

/** Machine-readable key for a decision, unique within a session (e.g. "storage-engine"). */
const DecisionKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase-kebab-case keys");

export const OptionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  description: z.string().max(600),
});

/**
 * An option's preview as the agent sends it (plan: option previews). Always present so every CLI's
 * schema mode accepts it; kind "none" means no preview. A malformed one counts as none: limits and
 * content are checked by Grillado afterwards (previews.ts), so a bad preview never fails a round.
 */
const RawPreviewSchema = z.object({
  kind: z.enum(["none", "ui", "code", "diagram"]),
  lang: z.string().max(40),
  source: z.string().max(400_000),
});
export const PreviewSchema = z.preprocess((v) => (RawPreviewSchema.safeParse(v).success ? v : NO_PREVIEW), RawPreviewSchema);
/** An option in a reply: the saved option plus its preview. */
export const OptionReplySchema = OptionSchema.extend({ preview: PreviewSchema });

/** "Show me another": one more option for a question that has previews. */
export const AnotherOptionReplySchema = z.object({
  type: z.literal("option"),
  label: z.string().min(1).max(200),
  description: z.string().max(600),
  preview: PreviewSchema,
});

export const QuestionSchema = z.object({
  key: DecisionKey,
  /** Short noun phrase naming the decision in the tree, e.g. "Merge conflicts". */
  label: z.string().max(60).default(""),
  title: z.string().min(1).max(160),
  body: z.string().max(2000),
  options: z.array(OptionReplySchema).min(2).max(6),
  recommendedOptionId: z.string().min(1),
  /** Keys of decisions settled in earlier rounds that this question builds on. */
  dependsOn: z.array(DecisionKey),
});

/** A decision the agent expects to ask later, once its prerequisites are settled (drawn as "waiting"). */
export const UpcomingSchema = z.object({
  key: DecisionKey,
  label: z.string().min(1).max(60),
  dependsOn: z.array(DecisionKey),
});

/** What the agent returns for a round request. One flat object so every CLI's schema mode accepts it. */
export const RoundReplySchema = z.object({
  type: z.enum(["ask_round", "frontier_empty"]),
  questions: z.array(QuestionSchema).max(MAX_QUESTIONS),
  /** Decisions that open up later. Optional for the agent; used only to draw the tree. */
  // Lenient: a bad hint is dropped instead of failing the whole round.
  upcoming: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((u) => UpcomingSchema.safeParse(u).success).slice(0, 16) : []),
    z.array(UpcomingSchema).max(16),
  ),
  summary: z.string().max(2000),
});

/** Keep the entries that parse and drop the rest, so one bad hint never fails a whole reply. */
const lenient = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success).slice(0, max) : []), z.array(item).max(max));

/** Plan 002: a project file a question is based on. Paths are checked by Grillado before they are kept. */
export const EvidenceSchema = z.object({ path: z.string().min(1).max(300), note: z.string().max(200) });
/** Plan 002: a fact read from the project, so not asked. */
export const FindingReplySchema = z.object({
  label: z.string().min(1).max(60),
  fact: z.string().min(1).max(300),
  paths: z.array(z.string().max(300)).min(1).max(3),
});
/** Plan 002: an existing file the plan's work changes or builds on. */
export const TouchSchema = z.object({ path: z.string().min(1).max(300), why: z.string().max(200) });

/** A round from an agent that can read the project: questions carry evidence, and facts it read are findings. */
export const GroundedRoundReplySchema = RoundReplySchema.extend({
  questions: z.array(QuestionSchema.extend({ evidence: lenient(EvidenceSchema, 4) })).max(MAX_QUESTIONS),
  findings: lenient(FindingReplySchema, 12),
});

export const CitationSchema = z.object({
  round: z.number().int().min(1),
  questionId: DecisionKey,
});

export const PlanReplySchema = z.object({
  type: z.literal("plan"),
  title: z.string().min(1).max(200),
  markdown: z.string().min(1).max(60_000),
  decisions: z
    .array(
      z.object({
        round: z.number().int().min(1),
        questionId: DecisionKey,
        statement: z.string().min(1).max(600),
      }),
    )
    .min(0),
  openDecisions: z.array(z.string().max(400)),
  /** The build steps (plan-to-build loop): thin end-to-end slices, each with a check that tells it is done. */
  // Lenient: a bad step is dropped; a plan with none gets the repair pass once (engine.ts) and is kept either way.
  steps: lenient(z.object({ title: z.string().min(1).max(300), done: z.string().max(600) }), 30),
});

/** A plan from an agent that can read the project: it lists the files the work touches. */
export const GroundedPlanReplySchema = PlanReplySchema.extend({ touches: lenient(TouchSchema, 30) });

/** The agent's reply in a comment thread. */
export const CommentReplySchema = z.object({
  type: z.literal("reply"),
  text: z.string().min(1).max(2000),
});

/** "Apply feedback": edits as exact `before → after` replacements, shown as suggestions (#16). */
export const EditReplySchema = z.object({
  type: z.literal("edits"),
  summary: z.string().max(400),
  edits: z
    .array(z.object({ before: z.string().min(1).max(2000), after: z.string().max(2000) }))
    .max(8),
});

/** "Add diagrams": one section's diagram, or a skip when a diagram wouldn't help (#41). */
export const DiagramReplySchema = z.object({
  type: z.literal("diagram"),
  skip: z.boolean(),
  mermaid: z.string().max(4000),
});

/** "Add to plan" (#104): one edit that works a decision into the text, or no place for it. */
export const AddPlanReplySchema = z.object({
  type: z.literal("addplan"),
  place: z.boolean(),
  before: z.string().max(2000),
  after: z.string().max(2000),
});

/** v1.3 item 1 §4: the decisions {agent} read out of a free-text interview's answers. */
export const ImportReplySchema = z.object({
  type: z.literal("decisions"),
  decisions: z
    .array(
      z.object({
        label: z.string().max(60),
        title: z.string().max(200),
        answer: z.string().max(1000),
      }),
    )
    .max(60),
});

export type ImportReply = z.infer<typeof ImportReplySchema>;

/** v1.3 item 2: thin end-to-end slices of a plan, one issue each. */
export const SplitReplySchema = z.object({
  type: z.literal("slices"),
  slices: z
    .array(
      z.object({
        key: z.string().max(60),
        title: z.string().max(256),
        body: z.string().max(20_000),
        covers: z.array(z.string().max(80)).max(60),
        sections: z.array(z.string().max(120)).max(20),
      }),
    )
    .max(250),
});

export type SplitReply = z.infer<typeof SplitReplySchema>;

/** Review r5: a plan with to-dos and no decisions, its to-dos grouped into slices (each to-do in exactly one). */
export const GroupReplySchema = z.object({
  type: z.literal("groups"),
  slices: z
    .array(
      z.object({
        key: z.string().max(60),
        title: z.string().max(256),
        body: z.string().max(20_000),
        todos: z.array(z.string().max(20)).max(250),
      }),
    )
    .max(250),
});

export type GroupReply = z.infer<typeof GroupReplySchema>;
/**
 * An option as kept on the session. Its preview was checked (previews.ts): a usable one is kept,
 * an unusable one leaves `previewFailed`. `added`: it came from "Show me another".
 */
export type Option = z.infer<typeof OptionSchema> & { preview?: Preview; previewFailed?: boolean; added?: boolean };
/** A question as kept on the session: from a reading agent it may carry checked evidence. */
export type Question = Omit<z.infer<typeof QuestionSchema>, "options"> & { options: Option[]; evidence?: z.infer<typeof EvidenceSchema>[] };
export type Upcoming = z.infer<typeof UpcomingSchema>;
/** Any round reply: grounded ones add evidence on questions and findings. */
/** A question in a reply, before applyRound settles its previews: an option's may still be raw ("none", or unusable). */
export type ReplyQuestion = Omit<Question, "options"> & { options: (Omit<Option, "preview"> & { preview?: Preview | RawPreview })[] };
export type RoundReply = Omit<z.infer<typeof RoundReplySchema>, "questions"> & { questions: ReplyQuestion[]; findings?: z.infer<typeof FindingReplySchema>[] };
export type AnotherOptionReply = z.infer<typeof AnotherOptionReplySchema>;
export type GroundedRoundReply = z.infer<typeof GroundedRoundReplySchema>;
export type PlanReply = Omit<z.infer<typeof PlanReplySchema>, "steps"> & { steps?: { title: string; done: string }[]; touches?: z.infer<typeof TouchSchema>[] };
export type CommentReply = z.infer<typeof CommentReplySchema>;
export type EditReply = z.infer<typeof EditReplySchema>;
export type DiagramReply = z.infer<typeof DiagramReplySchema>;
export type AddPlanReply = z.infer<typeof AddPlanReplySchema>;

/**
 * JSON Schema for the CLI schema flags. OpenAI-style strict structured output (Codex) needs every
 * property listed in `required` and `additionalProperties: false`, so we normalize to that.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      obj.required = Object.keys(obj.properties as object);
      obj.additionalProperties = false;
    }
    // Strict structured-output modes reject some keywords. Zod still enforces them after parsing.
    delete obj.pattern;
    delete obj.default;
    delete obj.minLength;
    delete obj.maxLength;
    if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
    if ("const" in obj) {
      obj.enum = [obj.const];
      delete obj.const;
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(json);
  return json;
}

export const roundJsonSchema = () => toStrictJsonSchema(RoundReplySchema);
export const planJsonSchema = () => toStrictJsonSchema(PlanReplySchema);
export const groundedRoundJsonSchema = () => toStrictJsonSchema(GroundedRoundReplySchema);
export const groundedPlanJsonSchema = () => toStrictJsonSchema(GroundedPlanReplySchema);
export const commentJsonSchema = () => toStrictJsonSchema(CommentReplySchema);
export const editJsonSchema = () => toStrictJsonSchema(EditReplySchema);
export const anotherOptionJsonSchema = () => toStrictJsonSchema(AnotherOptionReplySchema);
export const diagramJsonSchema = () => toStrictJsonSchema(DiagramReplySchema);
export const addPlanJsonSchema = () => toStrictJsonSchema(AddPlanReplySchema);
export const importJsonSchema = () => toStrictJsonSchema(ImportReplySchema);
export const splitJsonSchema = () => toStrictJsonSchema(SplitReplySchema);
export const groupJsonSchema = () => toStrictJsonSchema(GroupReplySchema);
