"use client";
/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  VENDORED, LOCAL WRAPPER: Uai "command-menu" (MIT, Victor Mesquita), copied from
 *  victor-teles/uai src/registry/uai/components/command-menu.tsx for Grillado's slash menu.
 *
 *  Three local additions, no Uai PR (v1.1 item 6 §18 E):
 *   1. `useCommandMenu()` exports the key handler, so a host that isn't the menu's own input
 *      (a textarea, CodeMirror) can drive it. CommandMenuInput uses the same handler.
 *   2. A `filter` prop replaces the built-in substring match. With it, the host ranks and orders
 *      the rows itself, so the CSS match highlight and the filter FLIP are skipped.
 *   3. `data-keyboard` on the list while the arrow keys move the highlight: it jumps instead of
 *      sliding (in-data-keyboard:transition-none); a pointer move clears it.
 *  Plus `appear={false}` to skip the open pop (a typed "/" opens instantly), and tabIndex=0 on the
 *  scrolling list (axe scrollable-region-focusable).
 *  Grillado visuals live in web/src/styles/grillado.css, never in this file.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { cva } from "class-variance-authority";
import { Search } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/uai-utils";

export const COMMAND_MENU_VARIANTS = ["panel", "floating", "compact"] as const;
export type CommandMenuVariant = (typeof COMMAND_MENU_VARIANTS)[number];
export type CommandMenuProps = Omit<ComponentProps<"div">, "defaultValue"> & {
  variant?: CommandMenuVariant;
  /** The search query. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Called when Escape is pressed with an empty query, for closing a surrounding dialog. */
  onDismiss?: () => void;
  /** Label for the result listbox. */
  label?: string;
  /** Local: replaces the built-in match; the host renders rows in its own order. */
  filter?: (query: string, text: string) => boolean;
  /** Local: false skips the open animation. */
  appear?: boolean;
};
type MenuContext = {
  id: string;
  query: string;
  /** Option rects by id, captured just before the query changes, for the filter FLIP. */
  flip: React.RefObject<Map<string, number> | null>;
  /** True once the first paint is done; rows that appear later fade in. */
  ready: boolean;
  setQuery: (value: string) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  empty: boolean;
  label: string;
  variant: CommandMenuVariant;
  listRef: React.RefObject<HTMLDivElement | null>;
  onDismiss?: () => void;
  filter?: (query: string, text: string) => boolean;
};
const Context = createContext<MenuContext | null>(null);
function useMenu(part: string) {
  const context = useContext(Context);
  if (!context) throw new Error(`${part} must be used within CommandMenu`);
  return context;
}
const GroupContext = createContext<string | null>(null);
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function matches(query: string, text: string) {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}
const EASE_POP = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_QUINT = "cubic-bezier(0.23, 1, 0.32, 1)";
const HIGHLIGHT_NAME = "uai-command-match";
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Set after the page's first paint: a menu mounted later was opened by something. */
let pageSettled = false;

/** Ranges of every query term inside the list's option text, for the CSS Custom Highlight API. */
function matchRanges(list: HTMLElement, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranges: Range[] = [];
  if (!terms.length) return ranges;
  for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
    const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('kbd, [aria-hidden="true"]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.toLowerCase() ?? "";
      for (const term of terms) {
        for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + term.length);
          ranges.push(range);
        }
      }
    }
  }
  return ranges;
}

function options(list: HTMLElement | null) {
  return Array.from(
    list?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [],
  );
}

const commandMenuVariants = cva(
  "flex min-w-0 origin-top flex-col overflow-hidden bg-popover text-[13px]/[18px] text-popover-foreground",
  {
    variants: {
      variant: {
        panel: "rounded-[14px] border p-0",
        floating:
          "rounded-[14px] border-0 p-0 shadow-[0_0_0_1px_var(--border-strong),0_10px_28px_oklch(0_0_0/0.42)]",
        compact: "rounded-xl border p-0",
      },
    },
  },
);

export function CommandMenu({
  variant = "panel",
  value,
  defaultValue = "",
  onValueChange,
  onDismiss,
  label = "Commands",
  filter,
  appear = true,
  children,
  className,
  ...props
}: CommandMenuProps) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [internal, setInternal] = useState(defaultValue);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [ready, setReady] = useState(false);
  const flip = useRef<Map<string, number> | null>(null);
  const query = value ?? internal;
  // Keep the active option valid after filtering and when the result set changes.
  useIsomorphicLayoutEffect(() => {
    const visible = options(listRef.current);
    const nextEmpty = !listRef.current?.querySelector('[role="option"]');
    if (nextEmpty !== empty) setEmpty(nextEmpty);
    if (!visible.some((option) => option.id === activeId)) setActiveId(visible[0]?.id ?? null);
  });
  const lastQuery = useRef(query);
  useIsomorphicLayoutEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setActiveId(options(listRef.current)[0]?.id ?? null);
  }, [query]);
  const floating = variant === "floating";
  // Open: pop in from the input. A panel that is part of the page's first paint stays put;
  // one mounted later (by a trigger) or a floating palette always pops.
  useEffect(() => {
    setReady(true);
    const root = rootRef.current;
    const opened = floating || pageSettled;
    if (!pageSettled) requestAnimationFrame(() => (pageSettled = true));
    if (!opened || !appear || !root?.animate) return;
    const reduced = prefersReducedMotion();
    root.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, scale: "0.96" },
            { opacity: 1, scale: "1" },
          ],
      { duration: reduced ? 120 : 180, easing: reduced ? "ease-out" : EASE_POP },
    );
  }, [floating]);
  // Matched characters turn foreground through the CSS Custom Highlight API, so item
  // children stay untouched and widths never change while typing.
  useEffect(() => {
    const list = listRef.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (filter || !list || !registry || typeof Highlight === "undefined") return;
    registry.set(HIGHLIGHT_NAME, new Highlight(...matchRanges(list, query)));
    return () => {
      registry.delete(HIGHLIGHT_NAME);
    };
  });
  return (
    <Context.Provider
      value={{
        id,
        query,
        flip,
        ready,
        setQuery: (next) => {
          const positions = new Map<string, number>();
          for (const option of listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ??
            [])
            positions.set(option.id, option.offsetTop);
          flip.current = positions;
          if (value === undefined) setInternal(next);
          onValueChange?.(next);
        },
        activeId,
        setActiveId,
        empty,
        label,
        variant,
        listRef,
        onDismiss,
        filter,
      }}
    >
      <div
        data-slot="command-menu"
        data-variant={variant}
        className={cn(commandMenuVariants({ variant }), className)}
        {...props}
        ref={rootRef}
      >
        {children}
      </div>
    </Context.Provider>
  );
}

/** The keys a combobox host forwards to the menu. */
export type MenuKey = {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
};

/**
 * Local: the menu's key handling for any host. `onKeyDown` returns true when it used the key
 * (↑↓ wrap, Home/End, Enter runs the active row, Escape clears the query or dismisses).
 */
export function useCommandMenu() {
  const context = useMenu("useCommandMenu");
  const onKeyDown = (event: MenuKey | KeyboardEvent<HTMLElement>): boolean => {
    const list = options(context.listRef.current);
    const index = list.findIndex((option) => option.id === context.activeId);
    const composing = "nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing;
    let target: HTMLElement | undefined;
    if (event.key === "ArrowDown") target = list[(index + 1) % list.length];
    else if (event.key === "ArrowUp") target = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") target = list[0];
    else if (event.key === "End") target = list[list.length - 1];
    else if (event.key === "Enter") {
      if (composing) return false;
      event.preventDefault();
      list[index]?.click();
      return true;
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (context.query) context.setQuery("");
      else context.onDismiss?.();
      return true;
    } else return false;
    event.preventDefault();
    if (!target) return true;
    const listEl = context.listRef.current;
    // Key repeat moves the highlight faster so it never trails the key.
    listEl?.toggleAttribute("data-repeat", !!event.repeat);
    listEl?.setAttribute("data-keyboard", "");
    context.setActiveId(target.id);
    target.scrollIntoView?.({ block: "nearest" });
    return true;
  };
  return {
    onKeyDown,
    activeId: context.activeId,
    setActiveId: context.setActiveId,
    query: context.query,
    listId: `${context.id}-list`,
  };
}

export function CommandMenuInput({
  className,
  onChange,
  onKeyDown,
  placeholder = "Search commands…",
  ...props
}: Omit<ComponentProps<"input">, "value" | "defaultValue">) {
  const context = useMenu("CommandMenuInput");
  const compact = context.variant === "compact";
  const { onKeyDown: move } = useCommandMenu();
  return (
    <div
      data-slot="command-menu-input-row"
      className={cn(
        "flex flex-none items-center border-b text-muted-foreground",
        compact ? "h-10 gap-2 px-3" : "h-12 gap-2.5 px-3.5",
      )}
    >
      <Search size={16} strokeWidth={1.75} aria-hidden="true" className="flex-none" />
      <input
        type="text"
        role="combobox"
        aria-label={context.label}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        data-slot="command-menu-input"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
          compact ? "h-6 text-[12.5px]/[18px]" : "h-7 text-[13.5px]/[18px]",
          className,
        )}
        {...props}
        value={context.query}
        aria-expanded={!context.empty}
        aria-controls={`${context.id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={context.activeId ?? undefined}
        onChange={(event) => {
          onChange?.(event);
          if (!event.defaultPrevented) context.setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) move(event as KeyboardEvent<HTMLElement>);
        }}
        onKeyUp={(event) => {
          props.onKeyUp?.(event);
          context.listRef.current?.removeAttribute("data-repeat");
        }}
      />
      <span
        aria-hidden="true"
        className="flex-none rounded-md bg-foreground/6 px-1.25 font-mono text-[11px]/[18px] font-medium text-muted-foreground"
      >
        esc
      </span>
    </div>
  );
}

export function CommandMenuList({ className, children, style, ...props }: ComponentProps<"div">) {
  const context = useMenu("CommandMenuList");
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [measured, setMeasured] = useState(false);
  // The panel follows its results: measure the content and transition the list height
  // (approved exception E5 in quality/premium-exceptions.json).
  useIsomorphicLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(content.offsetHeight));
    observer.observe(content);
    setHeight(content.offsetHeight);
    const frame = requestAnimationFrame(() => setMeasured(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  // One shared highlight slides to the active row.
  useIsomorphicLayoutEffect(() => {
    const highlight = highlightRef.current;
    const row = context.activeId ? document.getElementById(context.activeId) : null;
    if (!highlight) return;
    if (!row || !context.listRef.current?.contains(row)) {
      highlight.style.opacity = "0";
      return;
    }
    const wasHidden = highlight.style.opacity !== "1";
    if (wasHidden) highlight.style.transitionProperty = "none";
    highlight.style.translate = `0 ${row.offsetTop}px`;
    highlight.style.height = `${row.offsetHeight}px`;
    highlight.style.opacity = "1";
    if (wasHidden) {
      void highlight.offsetHeight;
      highlight.style.transitionProperty = "";
    }
  });
  // Filter: surviving rows slide from where they were; new rows fade in without moving.
  useIsomorphicLayoutEffect(() => {
    const before = context.flip.current;
    context.flip.current = null;
    const list = context.listRef.current;
    if (!before || !list || context.filter || prefersReducedMotion()) return;
    for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
      if (typeof option.animate !== "function") continue;
      const from = before.get(option.id);
      if (from === undefined) {
        option.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
        continue;
      }
      const dy = from - option.offsetTop;
      if (Math.abs(dy) > 0.5)
        option.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], {
          duration: 200,
          easing: EASE_QUINT,
        });
    }
  }, [context.query]);
  const compact = context.variant === "compact";
  return (
    <div
      role="listbox"
      aria-label={context.label}
      // Grillado: a scrolling region must be keyboard-reachable (axe scrollable-region-focusable).
      // In practice focus stays in the editor: Tab picks the active row while the menu is open.
      tabIndex={0}
      data-slot="command-menu-list"
      data-measured={measured || undefined}
      className={cn(
        "relative max-h-80 overflow-y-auto overscroll-contain scroll-py-1",
        "data-measured:transition-[height] data-measured:duration-160 data-measured:ease-out-quint motion-reduce:transition-none",
        "[&_*::highlight(uai-command-match)]:text-foreground",
        className,
      )}
      style={height === null ? style : { height: Math.min(height, 320), ...style }}
      {...props}
      onPointerMove={(event) => {
        props.onPointerMove?.(event);
        context.listRef.current?.removeAttribute("data-keyboard");
      }}
      ref={context.listRef}
      id={`${context.id}-list`}
    >
      <span
        ref={highlightRef}
        aria-hidden="true"
        data-slot="command-menu-highlight"
        className={cn(
          "pointer-events-none absolute inset-x-1 top-0 bg-accent opacity-0",
          compact ? "rounded-[7px]" : "rounded-lg",
          "transition-[translate,opacity,background-color,scale] duration-160 ease-out-quint in-data-repeat:duration-100 in-data-keyboard:transition-none motion-reduce:transition-[opacity,background-color]",
          "data-running:scale-[0.99] data-running:bg-[color-mix(in_oklab,var(--accent)_80%,var(--foreground))]",
        )}
      />
      <div ref={contentRef} data-slot="command-menu-list-content" className="relative p-1">
        {children}
      </div>
    </div>
  );
}

export function CommandMenuGroup({ className, children, ...props }: ComponentProps<"div">) {
  useMenu("CommandMenuGroup");
  const labelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  useIsomorphicLayoutEffect(() => {
    const next = !ref.current?.querySelector('[role="option"]');
    if (next !== hidden) setHidden(next);
  });
  return (
    <GroupContext.Provider value={labelId}>
      {/* biome-ignore lint/a11y/useSemanticElements: APG listbox groups use role="group"; a fieldset is not allowed in a listbox. */}
      <div
        role="group"
        aria-labelledby={labelId}
        data-slot="command-menu-group"
        className={cn(hidden ? "hidden" : "grid", "gap-px pb-0.5", className)}
        {...props}
        ref={ref}
        hidden={hidden}
      >
        {children}
      </div>
    </GroupContext.Provider>
  );
}

export function CommandMenuGroupLabel({ className, ...props }: ComponentProps<"div">) {
  const labelId = useContext(GroupContext);
  if (!labelId) throw new Error("CommandMenuGroupLabel must be used within CommandMenuGroup");
  return (
    <div
      data-slot="command-menu-group-label"
      className={cn(
        "px-2.5 pt-2 pb-1.5 text-[11.5px]/4 font-normal text-subtle-foreground",
        className,
      )}
      {...props}
      id={labelId}
    />
  );
}

export type CommandMenuItemProps = Omit<ComponentProps<"div">, "onSelect"> & {
  /** Text matched against the query. */
  value: string;
  /** Extra search terms, such as synonyms. */
  keywords?: readonly string[];
  disabled?: boolean;
  onSelect?: () => void;
};

export function CommandMenuItem({
  value,
  keywords = [],
  disabled = false,
  onSelect,
  onClick,
  onPointerMove,
  className,
  ...props
}: CommandMenuItemProps) {
  const context = useMenu("CommandMenuItem");
  const id = useId();
  if (!(context.filter ?? matches)(context.query, [value, ...keywords].join(" "))) return null;
  const active = context.activeId === id;
  const compact = context.variant === "compact";
  // Run: flash the shared highlight for 120ms (scale .99 and a deeper tint).
  const flash = () => {
    const highlight = context.listRef.current?.querySelector<HTMLElement>(
      '[data-slot="command-menu-highlight"]',
    );
    if (!highlight) return;
    highlight.setAttribute("data-running", "");
    window.setTimeout(() => highlight.removeAttribute("data-running"), 120);
  };
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: options are navigated with aria-activedescendant from the combobox input.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input.
    <div
      role="option"
      data-slot="command-menu-item"
      className={cn(
        "relative flex items-center font-medium select-none [&>svg]:size-4 [&>svg]:shrink-0",
        "transition-colors duration-120 ease-out motion-reduce:transition-none [&>svg]:transition-colors [&>svg]:duration-100 [&>svg]:ease-out",
        compact
          ? "min-h-7 gap-2 rounded-[7px] px-2 text-[12.5px]/[18px]"
          : "min-h-9 gap-2.5 rounded-lg px-2.5 text-[13px]/[18px]",
        disabled
          ? "cursor-not-allowed text-subtle-foreground [&>svg]:text-subtle-foreground [&>svg]:opacity-60"
          : "cursor-pointer text-muted-foreground data-active:text-foreground [&>svg]:text-muted-foreground data-active:[&>svg]:text-foreground",
        className,
      )}
      {...props}
      id={id}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-active={active || undefined}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (!disabled && !active) context.setActiveId(id);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (disabled || event.defaultPrevented) return;
        if (!active) context.setActiveId(id);
        if (!prefersReducedMotion()) flash();
        onSelect?.();
      }}
    />
  );
}

export function CommandMenuShortcut({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="command-menu-shortcut"
      className={cn(
        "ml-auto min-w-5 rounded-md bg-foreground/6 px-1.25 text-center font-mono text-[11px]/[18px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandMenuEmpty({ className, children, ...props }: ComponentProps<"div">) {
  const context = useMenu("CommandMenuEmpty");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context.empty || !context.ready || prefersReducedMotion()) return;
    ref.current?.animate?.(
      [
        { opacity: 0, translate: "0 4px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 200, easing: EASE_QUINT },
    );
  }, [context.empty, context.ready]);
  return (
    <div
      ref={ref}
      role="status"
      data-slot="command-menu-empty"
      className={cn(
        context.empty ? "grid" : "hidden",
        "justify-items-center gap-1 px-4 pt-6 pb-7 text-center",
        className,
      )}
      {...props}
    >
      {context.empty ? (
        <>
          <span
            aria-hidden="true"
            className="mb-2 grid size-8 place-items-center rounded-full bg-muted text-muted-foreground"
          >
            <Search size={16} strokeWidth={1.75} />
          </span>
          <span className="text-[13px]/[18px] font-medium text-foreground">
            {context.query ? `No results for “${context.query}”` : "No results"}
          </span>
          {children ? (
            <span className="text-[12.5px]/[18px] text-muted-foreground">{children}</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Optional key legend under the list. Put a context action in it with `ml-auto`. */
export function CommandMenuFooter({ className, children, ...props }: ComponentProps<"div">) {
  const context = useMenu("CommandMenuFooter");
  return (
    <div
      data-slot="command-menu-footer"
      className={cn(
        "flex h-9 flex-none items-center gap-3 border-t px-3 text-[11.5px]/4 text-subtle-foreground",
        context.variant === "compact" && "h-8 px-2.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span>
            <kbd className="font-mono">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> Open
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> Close
          </span>
        </>
      )}
    </div>
  );
}
