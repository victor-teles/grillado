"use client";
/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  VENDORED, TEMPORARY: Uai "agent-question" with the stacked layout, ahead of its release.
 *
 *  Copied verbatim from victor-teles/uai PR #56 (branch feat/agent-question-stacked, commit
 *  5120fb7, src/registry/uai/components/agent-question.tsx). It is the registry's existing
 *  `agent-question` item with `layout="stacked"`, so once #56 ships, swapping this file is a
 *  plain reinstall over it (`npx shadcn add @uai/agent-question`); no import changes.
 *  Grillado-specific visuals live in web/src/styles/grillado.css, never in this file.
 *  Only this header comment differs from upstream.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { cva } from "class-variance-authority";
import { Check, ChevronDown, TriangleAlert, X } from "lucide-react";
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/uai-utils";

export const AGENT_QUESTION_VARIANTS = ["card", "inline", "compact"] as const;
export const AGENT_QUESTION_STATUSES = ["asking", "submitting", "answered", "dismissed"] as const;
/** `stepper` shows one question at a time; `stacked` shows them all with one submit. */
export const AGENT_QUESTION_LAYOUTS = ["stepper", "stacked"] as const;

export type AgentQuestionVariant = (typeof AGENT_QUESTION_VARIANTS)[number];
export type AgentQuestionStatus = (typeof AGENT_QUESTION_STATUSES)[number];
export type AgentQuestionLayout = (typeof AGENT_QUESTION_LAYOUTS)[number];
export type AgentQuestionType = "single" | "multiple";
/**
 * Answers by question id. A single choice is a string, a multiple choice a string array.
 * Choosing "Something else" records the value `other`, and its text sits under `"<id>:other"`.
 * A skipped question has no entry.
 */
export type AgentQuestionAnswers = Record<string, string | string[]>;

/** Sent with the answers. `untouched` lists the items whose preselected recommendation was kept. */
export type AgentQuestionSubmitMeta = { untouched: string[] };

/** The key that holds a question's "Something else" text. */
export function agentQuestionOtherKey(questionId: string) {
  return `${questionId}:other`;
}

type RegisteredItem = {
  id: string;
  type: AgentQuestionType;
  required: boolean;
  element: HTMLElement;
};

type PendingFocus = { kind: "item"; id: string } | { kind: "primary" } | null;

type AgentQuestionContextValue = {
  variant: AgentQuestionVariant;
  layout: AgentQuestionLayout;
  recommendedLabel: string;
  preselectRecommended: boolean;
  activeId: string | undefined;
  activate: (id: string, options?: { focus?: boolean }) => void;
  untouched: ReadonlySet<string>;
  touch: (id: string) => void;
  recommended: React.RefObject<Map<string, Set<string>>>;
  canSubmit: boolean;
  submit: () => void;
  answerText: (id: string) => string | null;
  headingId: string;
  status: AgentQuestionStatus;
  busy: boolean;
  items: readonly RegisteredItem[];
  step: number;
  direction: 1 | -1;
  leaving: number | null;
  answers: AgentQuestionAnswers;
  error: ReactNode;
  focusOnStep: React.RefObject<boolean>;
  titles: React.RefObject<Map<string, string>>;
  labels: React.RefObject<Map<string, Map<string, string>>>;
  register: (item: RegisteredItem) => () => void;
  setAnswer: (id: string, value: string | string[] | undefined) => void;
  setOther: (id: string, text: string) => void;
  isAnswered: (item: RegisteredItem | undefined) => boolean;
  next: () => void;
  back: () => void;
  skip: () => void;
  dismiss: (() => void) | undefined;
  primaryRef: React.RefObject<HTMLButtonElement | null>;
};

const AgentQuestionContext = createContext<AgentQuestionContextValue | null>(null);

function useAgentQuestion(name: string) {
  const context = useContext(AgentQuestionContext);
  if (!context) throw new Error(`${name} must be used within AgentQuestion`);
  return context;
}

type ItemContextValue = {
  id: string;
  type: AgentQuestionType;
  index: number;
  /** The question taking input: the current step, or the active item when stacked. */
  current: boolean;
  setCustomSummary: (custom: boolean) => void;
  legendId: string;
  descriptionId: string;
  legendRef: React.RefObject<HTMLLegendElement | null>;
};

const ItemContext = createContext<ItemContextValue | null>(null);

function useItem(name: string) {
  const context = useContext(ItemContext);
  if (!context) throw new Error(`${name} must be used within AgentQuestionItem`);
  return context;
}

type OptionsContextValue = { optionCount: number };
const OptionsContext = createContext<OptionsContextValue>({ optionCount: 0 });

function hasValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function answeredIn(answers: AgentQuestionAnswers, item: RegisteredItem | undefined) {
  if (!item) return false;
  const value = answers[item.id];
  if (!hasValue(value)) return false;
  const picked = Array.isArray(value) ? value : [value as string];
  if (picked.includes("other") && !answers[agentQuestionOtherKey(item.id)]?.toString().trim())
    return picked.length > 1;
  return true;
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

const rootVariants = cva(
  "group/aq grid w-full min-w-0 animate-in text-[13px]/[18px] text-card-foreground duration-240 ease-out-quint fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none",
  {
    variants: {
      variant: {
        card: "max-w-[420px] rounded-[14px] border border-border bg-card",
        inline: "max-w-[420px]",
        compact: "max-w-[300px] rounded-[12px] border border-border bg-card",
      },
    },
  },
);

const stackedRootVariants = cva(
  "group/aq grid w-full min-w-0 animate-in text-[13px]/[18px] text-card-foreground duration-240 ease-out-quint fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none motion-reduce:fade-in-0",
  {
    variants: {
      variant: {
        card: "max-w-[460px]",
        inline: "max-w-[460px]",
        compact: "max-w-[300px]",
      },
    },
  },
);

const bodyInnerVariants = cva("grid min-w-0", {
  variants: {
    variant: {
      card: "gap-3.5 p-4",
      inline: "ml-1 gap-3.5 border-l border-border py-1 pl-4",
      compact: "gap-2.5 p-3",
    },
  },
});

export type AgentQuestionProps = Omit<ComponentProps<"section">, "onSubmit" | "defaultValue"> & {
  variant?: AgentQuestionVariant;
  /** `stepper` (default) shows one question at a time; `stacked` shows every question and one submit. */
  layout?: AgentQuestionLayout;
  /** The chip on recommended options and the word in their accessible name. */
  recommendedLabel?: string;
  /** Start each question with its recommended option chosen, drawn as untouched until the user touches it. */
  preselectRecommended?: boolean;
  /** Controlled active item (stacked only): the one that takes the number keys. */
  activeItem?: string;
  /** Uncontrolled active item (stacked only). Defaults to the first item. */
  defaultActiveItem?: string;
  onActiveItemChange?: (id: string) => void;
  /** Controlled status. Leave it unset to let the component move to submitting and answered. */
  status?: AgentQuestionStatus;
  step?: number;
  defaultStep?: number;
  onStepChange?: (step: number) => void;
  value?: AgentQuestionAnswers;
  defaultValue?: AgentQuestionAnswers;
  onValueChange?: (answers: AgentQuestionAnswers) => void;
  /**
   * Called with every answer and `{ untouched }`, the items whose preselected recommendation was
   * kept. Return a promise to show the submitting state until it settles.
   */
  onSubmit?: (answers: AgentQuestionAnswers, meta: AgentQuestionSubmitMeta) => unknown;
  /** Called with the question id when an optional question is skipped. */
  onSkip?: (questionId: string) => void;
  /** Shows the dismiss button in the header. */
  onDismiss?: () => void;
  /** A danger-ink line above the footer. The answers are kept. */
  error?: ReactNode;
};

/**
 * A decision an agent asks for: one to five questions, single or multiple choice. The questions
 * collapse into `AgentQuestionSummary` once answered.
 */
export function AgentQuestion({
  variant = "card",
  layout = "stepper",
  recommendedLabel = "Recommended",
  preselectRecommended = false,
  activeItem: activeItemProp,
  defaultActiveItem,
  onActiveItemChange,
  status: statusProp,
  step: stepProp,
  defaultStep = 0,
  onStepChange,
  value: valueProp,
  defaultValue = {},
  onValueChange,
  onSubmit,
  onSkip,
  onDismiss,
  error: errorProp,
  className,
  children,
  onKeyDown,
  onKeyDownCapture,
  ...props
}: AgentQuestionProps) {
  const stacked = layout === "stacked";
  const [internalStatus, setInternalStatus] = useState<AgentQuestionStatus>("asking");
  const status = statusProp ?? internalStatus;
  const [internalStep, setInternalStep] = useState(defaultStep);
  const step = stepProp ?? internalStep;
  const [internalValue, setInternalValue] = useState<AgentQuestionAnswers>(defaultValue);
  const answers = valueProp ?? internalValue;
  const [internalError, setInternalError] = useState<ReactNode>(null);
  const error = errorProp ?? internalError;
  const [items, setItems] = useState<RegisteredItem[]>([]);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [leaving, setLeaving] = useState<number | null>(null);
  const focusOnStep = useRef(false);
  const titles = useRef(new Map<string, string>());
  const labels = useRef(new Map<string, Map<string, string>>());
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const summaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const headingId = useId();
  const recommended = useRef(new Map<string, Set<string>>());
  const preselected = useRef(new Set<string>());
  const [untouched, setUntouched] = useState<ReadonlySet<string>>(() => new Set());
  const untouchedRef = useRef(untouched);
  untouchedRef.current = untouched;
  const [internalActive, setInternalActive] = useState<string | undefined>(defaultActiveItem);
  const requestedActive = activeItemProp ?? internalActive;
  const activeId = items.some((item) => item.id === requestedActive)
    ? requestedActive
    : items[0]?.id;
  const pendingFocus = useRef<PendingFocus>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const register = useCallback((item: RegisteredItem) => {
    setItems((current) =>
      [...current.filter((entry) => entry.id !== item.id), item].sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      ),
    );
    return () => setItems((current) => current.filter((entry) => entry.id !== item.id));
  }, []);

  const commit = useCallback(
    (next: AgentQuestionAnswers) => {
      answersRef.current = next;
      if (valueProp === undefined) setInternalValue(next);
      onValueChange?.(next);
    },
    [valueProp, onValueChange],
  );

  const touch = useCallback((id: string) => {
    if (!untouchedRef.current.has(id)) return;
    const next = new Set(untouchedRef.current);
    next.delete(id);
    untouchedRef.current = next;
    setUntouched(next);
  }, []);

  const setAnswer = useCallback(
    (id: string, value: string | string[] | undefined) => {
      touch(id);
      const next = { ...answersRef.current };
      if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[id];
      else next[id] = value;
      commit(next);
    },
    [commit, touch],
  );

  const setOther = useCallback(
    (id: string, text: string) => {
      touch(id);
      const next = { ...answersRef.current };
      if (text) next[agentQuestionOtherKey(id)] = text;
      else delete next[agentQuestionOtherKey(id)];
      commit(next);
    },
    [commit, touch],
  );

  // Preselect each item's recommended option once, before paint, and draw it as untouched.
  useLayoutEffect(() => {
    if (!preselectRecommended) return;
    let next = answersRef.current;
    const fresh: string[] = [];
    for (const item of items) {
      if (preselected.current.has(item.id)) continue;
      const values = recommended.current.get(item.id);
      if (!values || values.size === 0) continue;
      preselected.current.add(item.id);
      if (hasValue(next[item.id])) continue;
      const [first] = values;
      next = { ...next, [item.id]: item.type === "single" ? (first as string) : [...values] };
      fresh.push(item.id);
    }
    if (fresh.length === 0) return;
    commit(next);
    const marked = new Set([...untouchedRef.current, ...fresh]);
    untouchedRef.current = marked;
    setUntouched(marked);
  }, [items, preselectRecommended, commit]);

  const isAnswered = useCallback(
    (item: RegisteredItem | undefined) => answeredIn(answers, item),
    [answers],
  );

  const activate = useCallback(
    (id: string, options?: { focus?: boolean }) => {
      if (options?.focus) {
        pendingFocus.current = { kind: "item", id };
        setFocusTick((tick) => tick + 1);
      }
      if (id === activeId) return;
      if (activeItemProp === undefined) setInternalActive(id);
      onActiveItemChange?.(id);
    },
    [activeId, activeItemProp, onActiveItemChange],
  );

  // Stacked: move focus after the render that shows the target (a folded item unfolds first).
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusTick is the trigger.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target.kind === "primary") {
      primaryRef.current?.focus();
      return;
    }
    const item = items.find((entry) => entry.id === target.id);
    if (!item) return;
    item.element
      .querySelector<HTMLElement>("[data-slot=agent-question-title]")
      ?.focus({ preventScroll: true });
    item.element.scrollIntoView?.({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [focusTick, items]);

  const goTo = useCallback(
    (nextStep: number) => {
      setDirection(nextStep > step ? 1 : -1);
      setLeaving(step);
      focusOnStep.current = true;
      if (stepProp === undefined) setInternalStep(nextStep);
      onStepChange?.(nextStep);
    },
    [step, stepProp, onStepChange],
  );

  useEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), 200);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const submit = useCallback(() => {
    const current = answersRef.current;
    const meta: AgentQuestionSubmitMeta = {
      untouched: items
        .filter((item) => untouchedRef.current.has(item.id) && hasValue(current[item.id]))
        .map((item) => item.id),
    };
    const result = onSubmit?.(current, meta);
    if (statusProp !== undefined) return;
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setInternalStatus("submitting");
      setInternalError(null);
      (result as Promise<unknown>).then(
        () => setInternalStatus("answered"),
        (reason: unknown) => {
          setInternalStatus("asking");
          setInternalError(
            reason instanceof Error
              ? reason.message
              : stacked
                ? "The agent didn’t get your answers. They’re still here."
                : "Couldn’t send. Try again.",
          );
        },
      );
    } else {
      setInternalStatus("answered");
    }
  }, [onSubmit, statusProp, items, stacked]);

  const next = useCallback(() => {
    if (step < items.length - 1) goTo(step + 1);
    else submit();
  }, [step, items.length, goTo, submit]);

  const back = useCallback(() => {
    if (step > 0) goTo(step - 1);
  }, [step, goTo]);

  const skip = useCallback(() => {
    const item = items[step];
    if (!item) return;
    const nextAnswers = { ...answersRef.current };
    delete nextAnswers[item.id];
    delete nextAnswers[agentQuestionOtherKey(item.id)];
    commit(nextAnswers);
    onSkip?.(item.id);
    next();
  }, [items, step, commit, onSkip, next]);

  const dismiss = onDismiss
    ? () => {
        onDismiss();
        if (statusProp === undefined) setInternalStatus("dismissed");
      }
    : undefined;

  // Move focus to the summary heading once answered, but only if focus was inside.
  const previousStatus = useRef(status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (before === status) return;
    if (status !== "answered" && status !== "dismissed") return;
    const section = sectionRef.current;
    const active = document.activeElement;
    if (section && (active === document.body || (active && section.contains(active)))) {
      summaryHeadingRef.current?.focus();
    }
  }, [status]);

  const collapsed = status === "answered" || status === "dismissed";
  const busy = status === "submitting";
  const answeredCount = items.filter((item) => answeredIn(answers, item)).length;
  const canSubmit =
    items.length > 0 && items.every((item) => !item.required || answeredIn(answers, item));

  const answerText = (id: string) => {
    const value = answers[id];
    if (!hasValue(value)) return null;
    const optionLabels = labels.current.get(id);
    const other = answers[agentQuestionOtherKey(id)];
    return (Array.isArray(value) ? value : [value as string])
      .map((entry) =>
        entry === "other" && typeof other === "string" && other
          ? other
          : (optionLabels?.get(entry) ?? entry),
      )
      .join(" · ");
  };

  // Stacked: announce progress once answering settles for half a second.
  const announcedCount = useRef(answeredCount);
  useEffect(() => {
    if (!stacked || collapsed || announcedCount.current === answeredCount) return;
    const timer = window.setTimeout(() => {
      announcedCount.current = answeredCount;
      setAnnouncement(`${answeredCount} of ${items.length} answered`);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [stacked, collapsed, answeredCount, items.length]);

  const titleOf = (item: RegisteredItem) => titles.current.get(item.id) ?? item.id;

  /** After answering `fromId`: the next unanswered item, wrapping; or the submit when none is left. */
  const advanceFrom = (fromId: string) => {
    const start = items.findIndex((item) => item.id === fromId);
    const ordered = [...items.slice(start + 1), ...items.slice(0, Math.max(0, start))];
    const target = ordered.find((item) => !answeredIn(answersRef.current, item));
    if (target) {
      activate(target.id, { focus: true });
      setAnnouncement(
        `Question ${items.indexOf(target) + 1} of ${items.length}: ${titleOf(target)}`,
      );
    } else {
      pendingFocus.current = { kind: "primary" };
      setFocusTick((tick) => tick + 1);
    }
  };

  const optionControls = (item: RegisteredItem) =>
    Array.from(
      item.element.querySelectorAll<HTMLElement>("[data-slot=agent-question-option] [data-index]"),
    );

  // Stacked: ↑/↓, J/K, Home and End move between items before the radio group sees them.
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDownCapture?.(event);
    if (!stacked || event.defaultPrevented || collapsed || busy) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    const index = items.findIndex((item) => item.id === activeId);
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      j: index + 1,
      J: index + 1,
      ArrowUp: index - 1,
      k: index - 1,
      K: index - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      event.stopPropagation();
      const next = items[Math.min(items.length - 1, Math.max(0, moves[event.key] as number))];
      if (next) activate(next.id, { focus: true });
      return;
    }
    // ←/→ walk the checkboxes of a multiple-choice group, like the radio group does.
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      target.closest("[role=checkbox]")
    ) {
      const group = target.closest("[data-slot=agent-question-options]");
      const boxes = group
        ? Array.from(group.querySelectorAll<HTMLElement>("[role=checkbox]:not([disabled])"))
        : [];
      const at = boxes.indexOf(target.closest("[role=checkbox]") as HTMLElement);
      if (at < 0 || boxes.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      boxes[(at + step + boxes.length) % boxes.length]?.focus();
    }
  };

  const handleStackedKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const choice = target.closest<HTMLElement>("[role=radio], [role=checkbox]");
    if ((event.defaultPrevented && !choice) || collapsed || busy) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const otherField = target.closest<HTMLElement>("[data-other-input]");
    const typing = target.closest("input, textarea, [contenteditable='true']");
    const itemOf = (element: HTMLElement) => items.find((item) => item.element.contains(element));
    if (otherField) {
      const item = itemOf(otherField);
      if (!item) return;
      if (event.key === "Enter") {
        event.preventDefault();
        advanceFrom(item.id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        const value = answersRef.current[item.id];
        setAnswer(
          item.id,
          Array.isArray(value) ? value.filter((entry) => entry !== "other") : undefined,
        );
        item.element
          .querySelector<HTMLElement>("[data-slot=agent-question-option][data-other] [data-index]")
          ?.focus();
      }
      return;
    }
    if (typing) return;
    if (/^[1-9]$/.test(event.key)) {
      const item = items.find((entry) => entry.id === activeId);
      if (!item) return;
      const control = optionControls(item)[Number(event.key) - 1];
      if (!control) return;
      event.preventDefault();
      control.click();
      if (item.type === "multiple") control.focus();
      else if (!control.closest("[data-other]")) advanceFrom(item.id);
      return;
    }
    if (event.key === "Enter") {
      if (choice) {
        event.preventDefault();
        choice.click();
        return;
      }
      if (target.closest("button, a, summary, [role=button]")) return;
      event.preventDefault();
      if (canSubmit) {
        primaryRef.current?.click();
        return;
      }
      const missing = items.find((item) => item.required && !answeredIn(answersRef.current, item));
      if (missing) {
        activate(missing.id, { focus: true });
        setAnnouncement(`${titleOf(missing)}: needs an answer`);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (stacked) {
      handleStackedKeyDown(event);
      return;
    }
    const target = event.target as HTMLElement;
    // Radio and checkbox primitives prevent Enter themselves; it still continues here.
    const choice = target.closest("[role=radio], [role=checkbox]");
    if ((event.defaultPrevented && !choice) || collapsed || busy) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = target.closest("input, textarea, [contenteditable='true']");
    if (/^[1-9]$/.test(event.key) && !typing) {
      const item = items[step];
      if (!item) return;
      const options = Array.from(
        item.element.querySelectorAll<HTMLElement>(
          "[data-slot=agent-question-option] [data-index]",
        ),
      );
      const control = options[Number(event.key) - 1];
      if (!control) return;
      event.preventDefault();
      control.click();
      control.focus();
      return;
    }
    if (event.key === "Enter") {
      const activates = target.closest(
        "button:not([role=radio]):not([role=checkbox]), a, summary, [role=button]",
      );
      if (activates) return;
      event.preventDefault();
      if (primaryRef.current && !primaryRef.current.disabled) primaryRef.current.click();
    }
  };

  const all = Children.toArray(children);
  const summaryIndex = all.findIndex(
    (child) => isValidElement(child) && child.type === AgentQuestionSummary,
  );
  const summary = summaryIndex >= 0 ? all[summaryIndex] : <AgentQuestionSummary />;
  const rest = summaryIndex >= 0 ? all.filter((_, index) => index !== summaryIndex) : all;

  const value: AgentQuestionContextValue = {
    variant,
    layout,
    recommendedLabel,
    preselectRecommended,
    activeId,
    activate,
    untouched,
    touch,
    recommended,
    canSubmit,
    submit,
    answerText,
    headingId,
    status,
    busy,
    items,
    step,
    direction,
    leaving,
    answers,
    error,
    focusOnStep,
    titles,
    labels,
    register,
    setAnswer,
    setOther,
    isAnswered,
    next,
    back,
    skip,
    dismiss,
    primaryRef,
  };

  return (
    <AgentQuestionContext.Provider value={value}>
      <SummaryHeadingContext.Provider value={summaryHeadingRef}>
        {/* Number keys, arrows and Enter are delegated from the options and the input. */}
        <section
          ref={sectionRef}
          data-slot="agent-question"
          data-variant={variant}
          data-layout={layout}
          data-status={status}
          aria-busy={busy || undefined}
          role={stacked ? "form" : undefined}
          aria-labelledby={stacked ? headingId : undefined}
          className={cn(
            stacked ? stackedRootVariants({ variant }) : rootVariants({ variant }),
            collapsed && "border-0 bg-transparent",
            className,
          )}
          onKeyDown={handleKeyDown}
          onKeyDownCapture={handleKeyDownCapture}
          {...props}
        >
          <div
            data-slot="agent-question-body"
            inert={collapsed || undefined}
            className={cn(
              "grid min-w-0 [transition:grid-template-rows_300ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
            )}
          >
            <div className="min-h-0 min-w-0 overflow-hidden">
              <div
                className={
                  stacked
                    ? cn("grid min-w-0", variant === "compact" ? "gap-1.5" : "gap-2.5")
                    : bodyInnerVariants({ variant })
                }
              >
                {rest}
              </div>
            </div>
          </div>
          <div
            data-slot="agent-question-record"
            className={cn(
              "grid min-w-0 [transition:grid-template-rows_300ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              collapsed ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 min-w-0 overflow-hidden">{collapsed ? summary : null}</div>
          </div>
          <span role="status" className="sr-only">
            {status === "answered" ? "Answers sent" : stacked ? announcement : ""}
          </span>
        </section>
      </SummaryHeadingContext.Provider>
    </AgentQuestionContext.Provider>
  );
}

const SummaryHeadingContext = createContext<React.RefObject<HTMLHeadingElement | null> | null>(
  null,
);

/* -------------------------------------------------------------------------------------------------
 * Header
 * -----------------------------------------------------------------------------------------------*/

export function AgentQuestionHeader({ className, children, ...props }: ComponentProps<"div">) {
  const context = useAgentQuestion("AgentQuestionHeader");
  const total = context.items.length;
  const compact = context.variant === "compact";
  if (context.layout === "stacked") {
    const answered = context.items.filter((item) => context.isAnswered(item)).length;
    const untouched = context.items.filter((item) => context.untouched.has(item.id)).length;
    const progress = compact
      ? `${answered} of ${total}`
      : context.preselectRecommended
        ? `${answered} of ${total} ready${untouched > 0 ? ` · ${untouched} untouched` : ""}`
        : `${answered} of ${total} answered`;
    return (
      <div
        data-slot="agent-question-header"
        className={cn("flex min-w-0 items-center justify-between gap-2 px-0.5", className)}
        {...props}
      >
        <span className="flex min-w-0 items-center gap-2 text-[11.5px]/4 text-subtle-foreground tabular-nums">
          {total > 1 ? (
            <span aria-hidden="true" className="flex items-center gap-1">
              {context.items.map((item) => (
                <span
                  key={item.id}
                  className={cn(
                    "h-1 w-3.5 rounded-full [transition:background-color_160ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                    item.id === context.activeId
                      ? "bg-foreground"
                      : context.isAnswered(item)
                        ? "bg-muted-foreground"
                        : "bg-border-strong",
                  )}
                />
              ))}
            </span>
          ) : null}
          <span id={context.headingId}>{total > 0 ? progress : null}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {children ?? (compact ? null : <AgentQuestionWaiting />)}
          {context.dismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Dismiss question"
              onClick={context.dismiss}
              className={cn(
                "rounded-lg text-muted-foreground [transition:background-color_120ms_ease-out,color_120ms_ease-out,scale_140ms_cubic-bezier(0.23,1,0.32,1)] hover:bg-muted hover:text-foreground active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100",
                compact ? "size-6 rounded-md" : "size-7",
              )}
            >
              <X className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div
      data-slot="agent-question-header"
      className={cn("flex min-w-0 items-center justify-between gap-2", className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2 text-[11.5px]/4 text-subtle-foreground tabular-nums">
        {total > 1 ? (
          <span aria-hidden="true" className="flex items-center gap-1">
            {context.items.map((item, index) =>
              index === context.step ? (
                <span
                  key={`${item.id}-${context.step}`}
                  className="h-1 w-4 origin-left rounded-full bg-foreground motion-safe:animate-[grow-x_240ms_cubic-bezier(0.23,1,0.32,1)_backwards]"
                />
              ) : (
                <span
                  key={item.id}
                  className={cn(
                    "size-1 rounded-full",
                    index < context.step ? "bg-muted-foreground" : "bg-border-strong",
                  )}
                />
              ),
            )}
          </span>
        ) : null}
        {total > 0
          ? compact
            ? `${context.step + 1} of ${total}`
            : `Question ${context.step + 1} of ${total}`
          : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {children ?? (compact ? null : <AgentQuestionWaiting />)}
        {context.dismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss question"
            onClick={context.dismiss}
            className={cn(
              "rounded-lg text-muted-foreground [transition:background-color_120ms_ease-out,color_120ms_ease-out,scale_140ms_cubic-bezier(0.23,1,0.32,1)] hover:bg-muted hover:text-foreground active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100",
              compact ? "size-6 rounded-md" : "size-7",
            )}
          >
            <X className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/** The "Waiting for you" badge. Not live: the agent's message announces the question. */
export function AgentQuestionWaiting({ className, children, ...props }: ComponentProps<"span">) {
  const context = useAgentQuestion("AgentQuestionWaiting");
  if (context.status !== "asking") return null;
  return (
    <Badge
      variant="secondary"
      data-slot="agent-question-waiting"
      className={cn(
        "h-6 gap-1.5 rounded-full border-0 bg-primary/14 px-2.5 py-0 text-[11.5px] font-medium text-primary-ink",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
      />
      {children ?? "Waiting for you"}
    </Badge>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Item
 * -----------------------------------------------------------------------------------------------*/

export type AgentQuestionItemProps = Omit<ComponentProps<"fieldset">, "id"> & {
  id: string;
  type?: AgentQuestionType;
  required?: boolean;
  /** A short name shown above the title in the stacked layout, such as "Database". */
  label?: string;
};

const stackItemVariants = cva(
  "relative m-0 grid min-w-0 p-0 outline-none [transition:border-color_160ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
  {
    variants: {
      variant: {
        card: "gap-2.5 rounded-[14px] border border-border bg-card px-3.5 pt-3.5 pb-3 data-active:border-foreground",
        inline:
          "gap-2.5 border-0 px-3.5 pt-3.5 pb-3 before:absolute before:inset-y-3.5 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground before:opacity-0 before:[transition:opacity_160ms_cubic-bezier(0.23,1,0.32,1)] data-active:before:opacity-100 motion-reduce:before:transition-none",
        compact:
          "gap-2 rounded-[12px] border border-border bg-card p-3 data-active:border-foreground",
      },
    },
  },
);

const StackContext = createContext(false);

/** One question, a fieldset whose legend is the title. Only the current one shows, unless stacked. */
export function AgentQuestionItem({
  id,
  type = "single",
  required = false,
  label,
  className,
  children,
  onFocus,
  onPointerDown,
  ...props
}: AgentQuestionItemProps) {
  const context = useAgentQuestion("AgentQuestionItem");
  const inStack = useContext(StackContext);
  const ref = useRef<HTMLFieldSetElement | null>(null);
  const legendRef = useRef<HTMLLegendElement | null>(null);
  const legendId = useId();
  const descriptionId = useId();
  const [customSummary, setCustomSummary] = useState(false);
  const { register } = context;
  const stacked = context.layout === "stacked";

  useLayoutEffect(() => {
    if (!ref.current) return;
    return register({ id, type, required, element: ref.current });
  }, [register, id, type, required]);

  const index = context.items.findIndex((item) => item.id === id);
  const current = stacked ? id === context.activeId : index === context.step;
  const leaving = !stacked && index === context.leaving && !current;

  useEffect(() => {
    if (!current || !context.focusOnStep.current) return;
    context.focusOnStep.current = false;
    legendRef.current?.focus();
  }, [current, context.focusOnStep]);

  const itemValue = useMemo<ItemContextValue>(
    () => ({ id, type, index, current, setCustomSummary, legendId, descriptionId, legendRef }),
    [id, type, index, current, legendId, descriptionId],
  );

  if (stacked) {
    const compact = context.variant === "compact";
    const folded = compact && !current;
    const answered = context.isAnswered(context.items[index]);
    const meta = [label, type === "multiple" ? "choose any" : null, required ? null : "optional"]
      .filter(Boolean)
      .join(" · ");
    const fieldset = (
      <fieldset
        ref={ref}
        data-slot="agent-question-item"
        data-active={current || undefined}
        data-answered={answered || undefined}
        data-folded={folded || undefined}
        aria-current={current ? "step" : undefined}
        aria-labelledby={legendId}
        aria-describedby={descriptionId}
        aria-disabled={context.busy || undefined}
        disabled={context.busy}
        onFocus={(event) => {
          onFocus?.(event);
          context.activate(id);
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          context.activate(id);
        }}
        className={cn(
          stackItemVariants({ variant: context.variant }),
          folded && "p-0 [&>*:not([data-slot=agent-question-item-summary])]:hidden",
          compact &&
            current &&
            "animate-in duration-240 ease-out-quint fade-in-0 motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        {children}
        {/* After the children so the legend stays the fieldset's first child; drawn first. */}
        <div
          data-slot="agent-question-item-meta"
          className="-order-1 flex min-w-0 items-center gap-2 text-[11.5px]/4 text-subtle-foreground"
        >
          <IndexChip index={index} answered={answered && !context.untouched.has(id)} />
          {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
        </div>
        {compact && !customSummary ? <ItemSummaryRow /> : null}
      </fieldset>
    );
    return (
      <ItemContext.Provider value={itemValue}>
        {inStack ? (
          <li
            className="m-0 min-w-0 list-none p-0 animate-in duration-240 ease-out-quint fade-in-0 slide-in-from-bottom-1 fill-mode-backwards motion-reduce:animate-none"
            style={{ animationDelay: `${Math.max(0, index) * 40}ms` }}
          >
            {fieldset}
          </li>
        ) : (
          fieldset
        )}
      </ItemContext.Provider>
    );
  }

  return (
    <ItemContext.Provider value={itemValue}>
      <fieldset
        ref={ref}
        data-slot="agent-question-item"
        data-current={current || undefined}
        aria-describedby={descriptionId}
        hidden={!current && !leaving}
        inert={leaving || undefined}
        aria-hidden={leaving || undefined}
        disabled={context.busy}
        className={cn(
          "m-0 grid min-w-0 gap-3 border-0 p-0",
          context.variant === "compact" && "gap-2",
          current &&
            (context.direction === 1
              ? "animate-in duration-200 ease-out-quint fade-in-0 slide-in-from-right-2 motion-reduce:animate-none"
              : "animate-in duration-200 ease-out-quint fade-in-0 slide-in-from-left-2 motion-reduce:animate-none"),
          leaving &&
            (context.direction === 1
              ? "pointer-events-none animate-out duration-200 ease-out-quint fade-out-0 slide-out-to-left-2 fill-mode-forwards motion-reduce:hidden"
              : "pointer-events-none animate-out duration-200 ease-out-quint fade-out-0 slide-out-to-right-2 fill-mode-forwards motion-reduce:hidden"),
          className,
        )}
        {...props}
      >
        {children}
      </fieldset>
    </ItemContext.Provider>
  );
}

function IndexChip({ index, answered }: { index: number; answered: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10.5px]/none font-semibold [transition:background-color_180ms_cubic-bezier(0.16,1,0.3,1),color_180ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        answered ? "bg-success/14 text-success-ink" : "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "[grid-area:1/1] [transition:opacity_180ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
          answered && "opacity-0",
        )}
      >
        {index + 1}
      </span>
      <Check
        strokeWidth={2.4}
        className={cn(
          "size-3 [grid-area:1/1] [transition:opacity_180ms_cubic-bezier(0.16,1,0.3,1),scale_180ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:scale-100 motion-reduce:[transition:opacity_180ms_ease-out]",
          answered ? "scale-100 opacity-100" : "scale-90 opacity-0",
        )}
      />
    </span>
  );
}

const stackVariants = cva("grid min-w-0", {
  variants: {
    variant: {
      card: "gap-2.5",
      inline: "divide-y divide-border rounded-[14px] border border-border bg-card",
      compact: "gap-1.5",
    },
  },
});

/** Stacked layout: the list of items. The keyboard model works anywhere inside the root. */
export function AgentQuestionStack({ className, ...props }: ComponentProps<"ul">) {
  const context = useAgentQuestion("AgentQuestionStack");
  return (
    <StackContext.Provider value={true}>
      <ul
        data-slot="agent-question-stack"
        className={cn("m-0 list-none p-0", stackVariants({ variant: context.variant }), className)}
        {...props}
      />
    </StackContext.Provider>
  );
}

/**
 * Compact stacked only: the one-line row an inactive item folds into: its number or check, the
 * question, and the answer or "Not answered". Choosing it expands the item.
 */
export function AgentQuestionItemSummary({
  className,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "children">) {
  const { setCustomSummary } = useItem("AgentQuestionItemSummary");
  useLayoutEffect(() => {
    setCustomSummary(true);
    return () => setCustomSummary(false);
  }, [setCustomSummary]);
  return <ItemSummaryRow className={className} onClick={onClick} {...props} />;
}

function ItemSummaryRow({
  className,
  onClick,
  ...props
}: Omit<ComponentProps<"button">, "children">) {
  const context = useAgentQuestion("AgentQuestionItemSummary");
  const item = useItem("AgentQuestionItemSummary");
  if (context.layout !== "stacked" || context.variant !== "compact" || item.current) return null;
  const answer = context.answerText(item.id);
  const untouched = context.untouched.has(item.id);
  return (
    <button
      type="button"
      data-slot="agent-question-item-summary"
      onClick={(event) => {
        onClick?.(event);
        context.activate(item.id, { focus: true });
      }}
      className={cn(
        "grid w-full min-w-0 animate-in grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left duration-240 ease-out-quint fade-in-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <IndexChip
        index={item.index}
        answered={context.isAnswered(context.items[item.index]) && !untouched}
      />
      <span className="truncate text-[12.5px]/4 text-muted-foreground">
        {context.titles.current.get(item.id) ?? item.id}
      </span>
      <span
        className={cn(
          "max-w-[9rem] truncate text-[12.5px]/4",
          answer ? "font-medium text-foreground" : "text-subtle-foreground",
        )}
      >
        {answer ?? "Not answered"}
        {answer && untouched ? (
          <span className="font-normal text-subtle-foreground">
            {` · ${context.recommendedLabel.toLowerCase()}`}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Groups the items so the outgoing and incoming questions cross over in place. Stacked: the stack. */
export function AgentQuestionItems({ className, ...props }: ComponentProps<"div">) {
  const context = useAgentQuestion("AgentQuestionItems");
  if (context.layout === "stacked")
    return <AgentQuestionStack className={className} {...(props as ComponentProps<"ul">)} />;
  return (
    <div
      data-slot="agent-question-items"
      className={cn("grid min-w-0 *:[grid-area:1/1]", className)}
      {...props}
    />
  );
}

export function AgentQuestionTitle({ className, children, ...props }: ComponentProps<"legend">) {
  const context = useAgentQuestion("AgentQuestionTitle");
  const item = useItem("AgentQuestionTitle");
  useLayoutEffect(() => {
    if (typeof children === "string") context.titles.current.set(item.id, children);
  }, [children, context.titles, item.id]);
  return (
    <legend
      ref={item.legendRef}
      id={item.legendId}
      tabIndex={-1}
      data-slot="agent-question-title"
      className={cn(
        "float-left m-0 w-full p-0 font-semibold tracking-[-0.005em] text-foreground outline-none [&+*]:clear-left",
        context.variant === "compact" ? "text-[13px]/[18px]" : "text-[14px]/5",
        className,
      )}
      {...props}
    >
      {children}
    </legend>
  );
}

/** 12.5/18 muted. Hidden in compact. */
export function AgentQuestionDescription({ className, ...props }: ComponentProps<"p">) {
  const context = useAgentQuestion("AgentQuestionDescription");
  const item = useItem("AgentQuestionDescription");
  if (context.variant === "compact") return null;
  return (
    <p
      id={item.descriptionId}
      data-slot="agent-question-description"
      className={cn("m-0 -mt-2.5 text-[12.5px]/[18px] text-muted-foreground", className)}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Options
 * -----------------------------------------------------------------------------------------------*/

const STAGGER = [
  "",
  "[&>*:nth-child(2)]:delay-[40ms]",
  "[&>*:nth-child(3)]:delay-[80ms]",
  "[&>*:nth-child(4)]:delay-[120ms]",
  "[&>*:nth-child(5)]:delay-[160ms]",
  "[&>*:nth-child(6)]:delay-[200ms]",
].join(" ");

export type AgentQuestionOptionsProps = ComponentProps<"div">;

/** A RadioGroup for single choice, or a labelled group of checkboxes for multiple choice. */
export function AgentQuestionOptions({ className, children, ...props }: AgentQuestionOptionsProps) {
  const context = useAgentQuestion("AgentQuestionOptions");
  const item = useItem("AgentQuestionOptions");
  const count = Math.min(9, Children.toArray(children).filter(isValidElement).length);
  const shortcuts = Array.from({ length: count }, (_, index) => String(index + 1)).join(" ");
  const classes = cn(
    "grid min-w-0 gap-1.5 *:animate-in *:fade-in-0 *:slide-in-from-bottom-1 *:duration-240 *:ease-out-quint *:fill-mode-backwards motion-reduce:*:animate-none",
    STAGGER,
    context.variant === "compact" && "gap-1",
    className,
  );
  const value = context.answers[item.id];
  const keyshortcuts = context.layout === "stacked" && !item.current ? undefined : shortcuts;
  return (
    <OptionsContext.Provider value={{ optionCount: count }}>
      {item.type === "single" ? (
        <RadioGroup
          data-slot="agent-question-options"
          aria-labelledby={item.legendId}
          aria-keyshortcuts={keyshortcuts || undefined}
          value={typeof value === "string" ? value : ""}
          onValueChange={(next: unknown) => {
            if (typeof next === "string") context.setAnswer(item.id, next);
          }}
          disabled={context.busy}
          className={classes}
          {...(props as Omit<ComponentProps<typeof RadioGroup>, "value" | "onValueChange">)}
        >
          {children}
        </RadioGroup>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: the item is already the fieldset; this groups its checkboxes.
        <div
          role="group"
          data-slot="agent-question-options"
          aria-labelledby={item.legendId}
          aria-keyshortcuts={keyshortcuts || undefined}
          className={classes}
          {...props}
        >
          {children}
        </div>
      )}
    </OptionsContext.Provider>
  );
}

const optionVariants = cva(
  "group/option grid min-w-0 rounded-[10px] bg-background [transition:background-color_120ms_ease-out,box-shadow_120ms_ease-out] hover:shadow-[inset_0_0_0_1px_var(--border-strong)] has-data-[state=checked]:bg-muted has-data-checked:bg-muted has-data-[state=checked]:shadow-[inset_0_0_0_1px_var(--foreground)] has-data-checked:shadow-[inset_0_0_0_1px_var(--foreground)] has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ring has-focus-visible:outline-solid has-disabled:opacity-55 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        card: "",
        inline: "",
        compact: "",
      },
    },
  },
);

const controlClass =
  "mt-px size-4 shrink-0 border-0 bg-transparent shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] transition-[background-color,box-shadow] duration-[140ms] ease-out-quint focus-visible:ring-0 data-[state=checked]:bg-primary data-checked:bg-primary data-[state=checked]:shadow-none data-checked:shadow-none disabled:opacity-100 motion-reduce:transition-none dark:bg-transparent dark:data-[state=checked]:bg-primary dark:data-checked:bg-primary";

type OptionBaseProps = {
  value: string;
  label: string;
  description?: ReactNode;
  recommended?: boolean;
  disabled?: boolean;
  /** Rendered under the label when the option is selected (used by "Something else"). */
  reveal?: (selected: boolean) => ReactNode;
};

export type AgentQuestionOptionProps = Omit<ComponentProps<"div">, "children"> & {
  value: string;
  label: string;
  description?: ReactNode;
  recommended?: boolean;
  disabled?: boolean;
};

function OptionRow({
  value,
  label,
  description,
  recommended = false,
  disabled = false,
  reveal,
  className,
  ...props
}: OptionBaseProps & Omit<ComponentProps<"div">, "children">) {
  const context = useAgentQuestion("AgentQuestionOption");
  const item = useItem("AgentQuestionOption");
  const descriptionId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(-1);
  const compact = context.variant === "compact";
  const stacked = context.layout === "stacked";

  useLayoutEffect(() => {
    if (!recommended) return;
    let values = context.recommended.current.get(item.id);
    if (!values) {
      values = new Set();
      context.recommended.current.set(item.id, values);
    }
    values.add(value);
    return () => {
      context.recommended.current.get(item.id)?.delete(value);
    };
  }, [context.recommended, item.id, value, recommended]);

  useLayoutEffect(() => {
    let map = context.labels.current.get(item.id);
    if (!map) {
      map = new Map();
      context.labels.current.set(item.id, map);
    }
    map.set(value, label);
    const row = rowRef.current;
    const parent = row?.parentElement;
    if (row && parent) {
      setIndex(
        Array.from(parent.children)
          .filter((child) => child.getAttribute("data-slot") === "agent-question-option")
          .indexOf(row),
      );
    }
  }, [context.labels, item.id, value, label]);

  const answer = context.answers[item.id];
  const selected = Array.isArray(answer) ? answer.includes(value) : answer === value;
  const shortcut = index >= 0 && index < 9 ? String(index + 1) : null;
  const showDescription = !compact && description && !(reveal && selected);
  const untouched = selected && context.untouched.has(item.id);
  const name = untouched
    ? `${label}, ${context.recommendedLabel}, preselected`
    : recommended
      ? `${label}, ${context.recommendedLabel.toLowerCase()}`
      : label;

  const control =
    item.type === "single" ? (
      <RadioGroupItem
        value={value}
        onClick={() => context.touch(item.id)}
        disabled={disabled || context.busy}
        aria-label={name}
        aria-describedby={showDescription ? descriptionId : undefined}
        data-index={index}
        className={cn(
          controlClass,
          "[&_svg]:size-1.5 [&_svg]:fill-primary-foreground [&_svg]:stroke-0 [&_svg]:animate-in [&_svg]:zoom-in-0 [&_svg]:duration-150 [&_svg]:ease-out-quint motion-reduce:[&_svg]:animate-none",
          untouched && "bg-muted-foreground! [&_svg]:fill-muted!",
        )}
      />
    ) : (
      <Checkbox
        checked={selected}
        onClick={() => context.touch(item.id)}
        disabled={disabled || context.busy}
        onCheckedChange={(checked: unknown) => {
          const current = Array.isArray(answer) ? answer : [];
          const nextValue = checked
            ? [...current.filter((entry) => entry !== value), value]
            : current.filter((entry) => entry !== value);
          context.setAnswer(item.id, nextValue);
        }}
        aria-label={name}
        aria-describedby={showDescription ? descriptionId : undefined}
        data-index={index}
        className={cn(
          controlClass,
          "rounded-[5px] text-primary-foreground [&_svg]:size-3 [&_svg]:stroke-[3] [&_svg]:animate-in [&_svg]:zoom-in-50 [&_svg]:duration-150 [&_svg]:ease-out-quint motion-reduce:[&_svg]:animate-none",
          untouched && "bg-muted-foreground! text-muted!",
        )}
      />
    );

  return (
    <div
      ref={rowRef}
      data-slot="agent-question-option"
      data-selected={selected || undefined}
      data-untouched={untouched || undefined}
      className={cn(
        optionVariants({ variant: context.variant }),
        untouched &&
          "bg-muted! shadow-none! outline-1 -outline-offset-1 outline-muted-foreground outline-dashed",
        className,
      )}
      {...props}
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the first labelable child. */}
      <label
        className={cn(
          "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5",
          compact ? "py-[7px] pr-2 pl-2.5" : "py-2.5 pr-2.5 pl-3",
          (disabled || context.busy) && "cursor-not-allowed",
        )}
      >
        {control}
        <span className="grid min-w-0 gap-0.5">
          <span
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-foreground",
              compact ? "text-[12.5px]/[18px]" : "text-[13px]/[18px]",
            )}
          >
            {label}
            {recommended ? (
              <span
                aria-hidden="true"
                className="inline-flex h-[18px] items-center rounded-full bg-muted px-1.5 text-[10.5px] font-medium text-muted-foreground group-has-data-checked/option:bg-background group-has-data-[state=checked]/option:bg-background"
              >
                {context.recommendedLabel}
              </span>
            ) : null}
          </span>
          {showDescription ? (
            <span id={descriptionId} className="text-[12px]/4 text-subtle-foreground">
              {description}
            </span>
          ) : null}
        </span>
        {shortcut ? (
          <span
            aria-hidden="true"
            className={cn(
              "flex",
              stacked &&
                "[transition:opacity_160ms_cubic-bezier(0.23,1,0.32,1),visibility_160ms] motion-reduce:transition-none",
              stacked && !item.current && "invisible opacity-0",
            )}
          >
            <kbd className="min-w-5 rounded-md bg-muted px-1.5 text-center font-mono text-[11px]/[18px] font-medium text-subtle-foreground group-has-data-checked/option:bg-background group-has-data-[state=checked]/option:bg-background">
              {shortcut}
            </kbd>
          </span>
        ) : (
          <span />
        )}
      </label>
      {reveal ? reveal(selected) : null}
    </div>
  );
}

/** One choice: a 16px control, a label, an optional Recommended chip and description, and its number key. */
export function AgentQuestionOption(props: AgentQuestionOptionProps) {
  return <OptionRow {...props} />;
}

export type AgentQuestionOtherProps = Omit<
  ComponentProps<"div">,
  "children" | "onChange" | "defaultValue"
> & {
  label?: string;
  description?: ReactNode;
  placeholder?: string;
};

/** "Something else": selecting it reveals an inline text input and moves focus into it. */
export function AgentQuestionOther({
  label = "Something else",
  description = "Describe what you want instead",
  placeholder = "Type your answer",
  ...props
}: AgentQuestionOtherProps) {
  const context = useAgentQuestion("AgentQuestionOther");
  const item = useItem("AgentQuestionOther");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const answer = context.answers[item.id];
  const selected = Array.isArray(answer) ? answer.includes("other") : answer === "other";
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current && item.current) inputRef.current?.focus();
    wasSelected.current = selected;
  }, [selected, item.current]);
  const text = context.answers[agentQuestionOtherKey(item.id)];
  const compact = context.variant === "compact";
  return (
    <OptionRow
      data-other=""
      value="other"
      label={label}
      description={description}
      reveal={(open) => (
        <div
          className={cn(
            "grid motion-reduce:transition-none",
            context.layout === "stacked"
              ? "[transition:grid-template-rows_240ms_cubic-bezier(0.23,1,0.32,1)]"
              : "[transition:grid-template-rows_300ms_cubic-bezier(0.23,1,0.32,1)]",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
          inert={!open || undefined}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={compact ? "px-2.5 pb-2" : "pr-2.5 pb-2.5 pl-[38px]"}>
              <Input
                ref={inputRef}
                data-other-input=""
                aria-label={label}
                placeholder={placeholder}
                value={typeof text === "string" ? text : ""}
                disabled={context.busy}
                onChange={(event) => context.setOther(item.id, event.target.value)}
                className="h-[30px] rounded-lg border-border-strong bg-card px-2.5 text-[12.5px] shadow-none focus-visible:ring-[3px] focus-visible:ring-primary/24 md:text-[12.5px] dark:bg-card"
              />
            </div>
          </div>
        </div>
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Footer
 * -----------------------------------------------------------------------------------------------*/

const pillClass =
  "rounded-full border-0 px-3.5 font-medium [transition:background-color_120ms_ease-out,scale_140ms_cubic-bezier(0.23,1,0.32,1)] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";

/** Key hints or the selected count, then Back, Skip, and Continue (Send answers on the last step). */
export function AgentQuestionFooter({ className, children, ...props }: ComponentProps<"div">) {
  const context = useAgentQuestion("AgentQuestionFooter");
  if (context.layout === "stacked") {
    return (
      <StackedFooter className={className} {...props}>
        {children}
      </StackedFooter>
    );
  }
  const item = context.items[context.step];
  const compact = context.variant === "compact";
  const last = context.step >= context.items.length - 1;
  const answered = context.isAnswered(item);
  const canContinue = item ? !item.required || answered : false;
  const value = item ? context.answers[item.id] : undefined;
  const selectedCount = Array.isArray(value) ? value.length : 0;
  const optionCount = item
    ? Math.min(9, item.element.querySelectorAll("[data-slot=agent-question-option]").length)
    : 0;
  const size = compact ? "h-7 text-[12px]" : "h-8 text-[13px]";
  return (
    <div
      data-slot="agent-question-footer"
      className={cn("grid min-w-0 gap-2.5", className)}
      {...props}
    >
      {context.error ? (
        <p role="alert" className="m-0 text-[12px]/4 text-destructive-ink">
          {context.error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        {children ??
          (compact ? (
            <span />
          ) : item?.type === "multiple" && selectedCount > 0 ? (
            <span className="text-[11.5px]/4 text-subtle-foreground tabular-nums">
              {selectedCount} selected
            </span>
          ) : optionCount > 0 ? (
            <span
              aria-hidden="true"
              className="flex min-w-0 items-center gap-1 text-[11.5px]/4 text-subtle-foreground max-[380px]:hidden"
            >
              <Kbd>1</Kbd>–<Kbd>{optionCount}</Kbd> choose · <Kbd>↵</Kbd> continue
            </span>
          ) : (
            <span />
          ))}
        <span className="flex shrink-0 items-center gap-2">
          {context.step > 0 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={context.busy}
              onClick={context.back}
              className={cn(pillClass, size, "bg-secondary hover:bg-accent")}
            >
              Back
            </Button>
          ) : null}
          {item && !item.required ? (
            <Button
              type="button"
              variant="secondary"
              disabled={context.busy}
              onClick={context.skip}
              className={cn(pillClass, size, "bg-secondary hover:bg-accent")}
            >
              Skip
            </Button>
          ) : null}
          <Button
            ref={context.primaryRef}
            type="button"
            data-slot="agent-question-continue"
            disabled={context.busy || !canContinue}
            onClick={context.next}
            className={cn(pillClass, size, "disabled:opacity-50")}
          >
            {context.busy ? (
              <span className="shimmer-text">Sending…</span>
            ) : last ? (
              "Send answers"
            ) : (
              "Continue"
            )}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Stacked: key hints and the one "Send answers" for the whole set. */
function StackedFooter({ className, children, ...props }: ComponentProps<"div">) {
  const context = useAgentQuestion("AgentQuestionFooter");
  const compact = context.variant === "compact";
  const active = context.items.find((item) => item.id === context.activeId);
  const activeValue = active ? context.answers[active.id] : undefined;
  const otherOpen = Array.isArray(activeValue)
    ? activeValue.includes("other")
    : activeValue === "other";
  const optionCount = active
    ? Math.min(9, active.element.querySelectorAll("[data-slot=agent-question-option]").length)
    : 0;
  return (
    <div
      data-slot="agent-question-footer"
      className={cn("grid min-w-0 gap-2.5 px-0.5 pt-0.5", className)}
      {...props}
    >
      {context.error ? (
        <p
          role="alert"
          className="m-0 flex items-center gap-1.5 text-[12px]/4 text-destructive-ink"
        >
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {context.error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        {children ?? (
          <span
            aria-hidden="true"
            className="flex min-w-0 flex-wrap items-center gap-1 text-[11.5px]/4 text-subtle-foreground"
          >
            {compact ? (
              <>
                <Kbd>↵</Kbd> send
              </>
            ) : otherOpen ? (
              <>
                <Kbd>↵</Kbd> in the field saves it and moves on
              </>
            ) : (
              <>
                {optionCount > 0 ? (
                  <>
                    <Kbd>1</Kbd>–<Kbd>{optionCount}</Kbd> choose ·{" "}
                  </>
                ) : null}
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move · <Kbd>↵</Kbd> send
              </>
            )}
          </span>
        )}
        <Button
          ref={context.primaryRef}
          type="button"
          data-slot="agent-question-continue"
          disabled={context.busy || !context.canSubmit}
          onClick={context.submit}
          className={cn(
            pillClass,
            compact
              ? "relative h-7 text-[12px] after:absolute after:inset-x-0 after:-inset-y-1.5"
              : "h-8 text-[13px]",
            context.busy ? "disabled:opacity-60" : "disabled:opacity-50",
          )}
        >
          {context.busy ? "Sending…" : "Send answers"}
        </Button>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="min-w-[18px] rounded-[5px] bg-muted px-1 text-center font-mono text-[10.5px]/4 font-medium text-subtle-foreground">
      {children}
    </kbd>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Summary
 * -----------------------------------------------------------------------------------------------*/

export type AgentQuestionSummaryProps = Omit<ComponentProps<"div">, "children"> & {
  /** When the answers went out, already formatted, such as "14:02". */
  time?: string;
  defaultOpen?: boolean;
};

/**
 * The record left in the transcript: a check tile, "Answered 3 questions", the time, and a
 * disclosure with each question and its answer. Rendered by the root once answered or dismissed.
 */
export function AgentQuestionSummary({
  time,
  defaultOpen = false,
  className,
  ...props
}: AgentQuestionSummaryProps) {
  const context = useAgentQuestion("AgentQuestionSummary");
  const headingRef = useContext(SummaryHeadingContext);
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  if (context.status !== "answered" && context.status !== "dismissed") return null;
  const dismissed = context.status === "dismissed";
  const total = context.items.length;
  const chrome =
    context.variant === "inline"
      ? "rounded-[14px] border border-border bg-card"
      : context.variant === "compact"
        ? "rounded-[12px] border border-border bg-card"
        : "rounded-[14px] border border-border bg-card";
  const heading = dismissed
    ? "Question dismissed"
    : `Answered ${total} ${total === 1 ? "question" : "questions"}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div data-slot="agent-question-summary" className={cn(chrome, className)} {...props}>
        <div
          className={cn(
            "flex min-w-0 items-center gap-2.5",
            context.variant === "compact" ? "px-3 py-2.5" : "px-3 py-2.5",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-full",
              dismissed
                ? "bg-muted text-muted-foreground"
                : "animate-in bg-success/14 text-success-ink duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] zoom-in-50 motion-reduce:animate-none",
            )}
          >
            {dismissed ? (
              <X className="size-3.5" strokeWidth={2} />
            ) : (
              <Check className="size-3.5" strokeWidth={2.2} />
            )}
          </span>
          <div className="grid min-w-0 flex-1">
            <h3
              ref={headingRef}
              tabIndex={-1}
              className={cn(
                "m-0 truncate text-[13px]/[18px] font-medium outline-none",
                dismissed ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {heading}
            </h3>
            {!dismissed ? (
              <p className="m-0 text-[12px]/4 text-subtle-foreground tabular-nums">
                Sent to the agent{time ? ` · ${time}` : ""}
              </p>
            ) : null}
          </div>
          {!dismissed && total > 0 ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={open ? "Hide answers" : "Show answers"}
                aria-controls={listId}
                className="size-7 rounded-lg text-muted-foreground [transition:background-color_120ms_ease-out,color_120ms_ease-out,scale_140ms_cubic-bezier(0.23,1,0.32,1)] hover:bg-muted hover:text-foreground active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <ChevronDown
                  className={cn(
                    "size-4 [transition:rotate_200ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                    open && "rotate-180",
                  )}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </div>
        {!dismissed ? (
          <CollapsibleContent id={listId}>
            <ul className="m-0 grid list-none gap-2 border-t border-border px-3.5 pt-3 pb-3.5">
              {context.items.map((item) => {
                const answer = context.answerText(item.id);
                const untouched = answer !== null && context.untouched.has(item.id);
                return (
                  <li key={item.id} className="grid gap-0.5 text-[12px]/4">
                    <span className="text-subtle-foreground">
                      {context.titles.current.get(item.id) ?? item.id}
                    </span>
                    <span
                      className={cn(
                        answer ? "font-medium text-foreground" : "text-subtle-foreground",
                      )}
                    >
                      {answer ?? "Skipped"}
                      {untouched ? (
                        <span className="font-normal text-subtle-foreground">
                          {` · ${context.recommendedLabel.toLowerCase()}`}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CollapsibleContent>
        ) : null}
      </div>
    </Collapsible>
  );
}
