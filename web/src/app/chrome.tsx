// App chrome: header (desktop + mobile), steps, agent chip, theme, and small shared hooks.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IMore, IMoon, IPlate, IPower, ISun, ISwap, Mark } from "./icons";
import type { ProviderId, ProviderView } from "./types";
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
/** Avatar letters from the agent's display name: initials of two words, else its first two letters. */
export function Steps({ step }: { step: number }) {
  return (
    <ol className="steps" aria-label="Session progress">
      {STEPS.map((s, i) => (
        <li key={s} className="step" data-status={i < step ? "complete" : i === step ? "current" : "upcoming"} aria-current={i === step ? "step" : undefined}>
          <span className="d" aria-hidden="true" />
          {s}
        </li>
      ))}
    </ol>
  );
}

export function AgentChip({ provider, compact, onSwitch }: { provider: ProviderView; compact?: boolean; onSwitch?: () => void }) {
  const version = provider.version ? ` ${provider.version}` : "";
  // Visible name first so the accessible name contains it (WCAG 2.5.3); version and role for screen readers.
  const inner = (
    <>
      <span className="mono2" aria-hidden="true">
        {monogram(provider.displayName)}
      </span>
      <span className="sr-only">Agent: </span>
      <span className={compact ? "sr-only" : undefined}>{provider.displayName}</span>
      <span className="sr-only">
        {version}
        {onSwitch ? ", switch agent" : ""}
      </span>
      {provider.status === "ready" ? <span className="ok" aria-hidden="true" /> : null}
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
  round?: number;
  provider?: ProviderView;
  onSwitch?: () => void;
  onHome?: () => void;
  onWrap?: () => void;
  onQuit?: () => void;
  theme: Theme;
  onTheme: () => void;
}

export function Header(p: HeaderProps) {
  const mobile = useMobile();
  const brand = (
    <>
      <span className="mark" style={mobile ? { width: 24, height: 24 } : undefined}>
        <Mark size={mobile ? 14 : 15} />
      </span>
      {mobile ? null : <span className="wordmark">Grillado</span>}
    </>
  );
  const home = p.onHome ? (
    <a
      href="/"
      aria-label="Grillado home"
      onClick={(e) => {
        e.preventDefault();
        p.onHome!();
      }}
    >
      {brand}
    </a>
  ) : (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }} aria-label={mobile ? "Grillado" : undefined} role={mobile ? "img" : undefined}>
      {brand}
    </span>
  );
  const menu = <HeaderMenu {...p} mobile={mobile} />;
  if (mobile)
    return (
      <header className="mh">
        <div className="r">
          {home}
          <span className="sess2">{p.title ?? "Grillado"}</span>
          {p.round ? <span className="roundc">R{p.round}</span> : null}
          {p.provider ? <AgentChip provider={p.provider} compact onSwitch={p.onSwitch} /> : null}
          {menu}
        </div>
        {p.step !== undefined ? (
          <div className="mstep2">
            <span className="bars" aria-hidden="true">
              {STEPS.map((s, i) => (
                <i key={s} className={i < p.step! ? "c" : i === p.step ? "n" : ""} />
              ))}
            </span>
            <span>
              {STEPS[p.step]} · step {p.step + 1} of 4
            </span>
          </div>
        ) : null}
      </header>
    );
  return (
    <header className="hdr">
      <div className="brand">
        {home}
        {p.title ? (
          <span className="sess" title={p.title}>
            {p.title}
          </span>
        ) : null}
      </div>
      {p.step !== undefined ? <Steps step={p.step} /> : <span />}
      <div className="hdr-r">
        {p.round ? <span className="roundc">Round {p.round}</span> : null}
        {p.provider ? <AgentChip provider={p.provider} onSwitch={p.onSwitch} /> : null}
        {menu}
      </div>
    </header>
  );
}

function HeaderMenu(p: HeaderProps & { mobile: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ghost" aria-label="More">
          <IMore />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56 motion-reduce:animate-none">
        {p.provider ? (
          <>
            <DropdownMenuLabel className="text-[12px] font-normal text-subtle-foreground">
              {p.provider.displayName}
              {p.provider.version ? <span className="mono"> {p.provider.version}</span> : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={p.onTheme}>
          {p.theme === "dark" ? <ISun s={14} /> : <IMoon s={14} />}
          {p.theme === "dark" ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
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
                <span className="text-[11.5px] text-subtle-foreground">Stops the local server. Your session is saved.</span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
