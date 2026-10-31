// App chrome: header (desktop + mobile), steps, agent chip, theme, and small shared hooks.
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IDown, IMore, IMoon, IPlate, IPlug, IPower, ISun, ISwap, Mark } from "./icons";
import type { ProviderView } from "./types";
import { monogram } from "./copy";
export { monogram };

// ---------------------------------------------------------------- hooks

export function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
export const useMobile = () => useMedia("(max-width: 767px)");

export type Theme = "dark" | "light";
const THEME_KEY = "grillado-theme";
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"));
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", theme === "dark");
    el.classList.toggle("light", theme === "light");
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);
  return [theme, toggle];
}

/** Seconds since `since` (ISO), ticking once a second while `active`. */
export function useSince(since: string | number | undefined, active = true) {
  const start = typeof since === "string" ? Date.parse(since) : (since ?? Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, start]);
  return Math.max(0, Math.floor((now - start) / 1000));
}
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------- header parts

export const STEPS = ["Idea", "On the grill", "Confirm", "Plan"] as const;
/** The four stages as plain text; the current one gets an ember dot (v1.2 header). */
export function Steps({ step }: { step: number }) {
  return (
    <ol className="stages" aria-label="Session progress">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === step ? "step" : undefined} data-done={i < step ? "" : undefined}>
          {s}
          {i < step ? <span className="sr-only"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The agent in plain text with a chevron when it can be switched (v1.2: no monogram, no status dot). */
export function AgentChip({ provider, onSwitch }: { provider: ProviderView; compact?: boolean; onSwitch?: () => void }) {
  const version = provider.version ? ` ${provider.version}` : "";
  // Visible name first so the accessible name contains it (WCAG 2.5.3); version and role for screen readers.
  const inner = (
    <>
      <span className="sr-only">Agent: </span>
      <span>{provider.displayName}</span>
      <span className="sr-only">
        {version}
        {onSwitch ? ", switch agent" : ""}
      </span>
      {onSwitch ? <IDown s={14} /> : null}
    </>
  );
  const title = `${provider.displayName}${version}`;
  return onSwitch ? (
    <button type="button" className="agent" title={title} onClick={onSwitch}>
      {inner}
    </button>
  ) : (
    <span className="agent" title={title}>
      {inner}
    </span>
  );
}

export interface HeaderProps {
  step?: number;
  title?: string;
  afterTitle?: ReactNode;
  provider?: ProviderView;
  onSwitch?: () => void;
  onHome?: () => void;
  onWrap?: () => void;
  onQuit?: () => void;
  theme: Theme;
  onTheme: () => void;
  /** Desktop: a button before More (Home's "Use in your editor", v1.2 item 1). */
  extra?: ReactNode;
  /** Phones: "Use in your editor…" in the More sheet (item 1 §3). Not on desktop (Q5). */
  onEditor?: () => void;
  moreRef?: RefObject<HTMLButtonElement | null>;
}

/** One 52px row (48 on phones): mark + session title · stages · agent + ⋯. */
export function Header(p: HeaderProps) {
  const mobile = useMobile();
  const mark = (
    <span className="mark" aria-hidden="true">
      <Mark size={14} />
    </span>
  );
  const home = p.onHome ? (
    <a
      href="/"
      className="home"
      aria-label="Grillado home"
      onClick={(e) => {
        e.preventDefault();
        p.onHome!();
      }}
    >
      {mark}
    </a>
  ) : (
    <span className="home" role="img" aria-label="Grillado">
      {mark}
    </span>
  );
  return (
    <header className="top">
      <div className="brand">
        {home}
        {p.title ? (
          <span className="title" title={p.title}>
            {p.title}
          </span>
        ) : null}
        {p.afterTitle}
      </div>
      {p.step !== undefined && !mobile ? <Steps step={p.step} /> : <span />}
      <div className="top-r">
        {p.provider && !mobile ? <AgentChip provider={p.provider} onSwitch={p.onSwitch} /> : null}
        {mobile ? null : p.extra}
        <HeaderMenu {...p} mobile={mobile} />
      </div>
    </header>
  );
}

function HeaderMenu(p: HeaderProps & { mobile: boolean }) {
  // "Use in your editor…" opens its sheet only once the menu has handed focus back,
  // so the menu's focus trap can't pull focus off the sheet's tab.
  const editorNext = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button ref={p.moreRef} type="button" className="icon-btn" aria-label="More">
          <IMore />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56 motion-reduce:animate-none"
        onCloseAutoFocus={(e) => {
          if (!editorNext.current) return;
          editorNext.current = false;
          e.preventDefault();
          p.onEditor?.();
        }}
      >
        {p.provider ? (
          <>
            <DropdownMenuLabel className="text-[12px] font-normal text-muted-foreground">
              {p.provider.displayName}
              {p.provider.version ? ` ${p.provider.version}` : null}
              {mobileStep(p)}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={p.onTheme}>
          {p.theme === "dark" ? <ISun s={14} /> : <IMoon s={14} />}
          {p.theme === "dark" ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        {p.mobile && p.onEditor ? (
          <DropdownMenuItem onSelect={() => (editorNext.current = true)}>
            <IPlug s={14} />
            Use in your editor…
          </DropdownMenuItem>
        ) : null}
        {p.onSwitch ? (
          <DropdownMenuItem onSelect={p.onSwitch}>
            <ISwap s={14} />
            Switch agent
          </DropdownMenuItem>
        ) : null}
        {p.onWrap ? (
          <DropdownMenuItem onSelect={p.onWrap}>
            <IPlate s={14} />
            Wrap it up
          </DropdownMenuItem>
        ) : null}
        {p.onQuit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={p.onQuit}>
              <IPower s={14} />
              <span className="grid">
                Quit Grillado
                <span className="text-[12px] text-muted-foreground">Stops the local server. Your session is saved.</span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** On phones the stages aren't in the header; the menu says where you are. */
function mobileStep(p: HeaderProps & { mobile: boolean }) {
  return p.mobile && p.step !== undefined ? <span className="block">{`${STEPS[p.step]} · step ${p.step + 1} of 4`}</span> : null;
}
