import { useEffect, useRef, useState } from "react";
import { ICheck, ICopy } from "./icons";

/** Copies `text`; false when neither the Clipboard API nor execCommand got it there (item 1 §6). */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    const back = document.activeElement as HTMLElement | null;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    back?.focus?.({ preventScroll: true });
    return ok;
  }
}

/** Selects the text of `el` so ⌘C / long-press still works after a failed copy. */
export function selectText(el: Element | null | undefined) {
  if (!el) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** How long "Copied" holds after the click (item 1 §5, --d-copied). */
export const COPIED_MS = 1500;

/**
 * Copy buttons (v1.2): `icon` (32px icon button, 14px icon), `inline` (a 14px icon that sits in a
 * sentence, after inline code), `cmd` (a copyable shell command), or a text
 * button in `tone` primary / soft / quiet. The label is always the accessible name.
 * A pill with `icon` (item 1 §5) stacks copy/check and Copy/Copied in one cell each, so its width
 * never changes. A click while "Copied" shows restarts the hold. When the copy fails nothing
 * says Copied and `onFailed` runs.
 */
export function CopyButton({
  text,
  label = "Copy",
  kind = "pill",
  tone = "quiet",
  icon = false,
  className,
  ariaLabel,
  onCopied,
  onFailed,
}: {
  text: string;
  label?: string;
  kind?: "pill" | "icon" | "inline" | "cmd";
  tone?: "primary" | "soft" | "quiet";
  /** Pill only: a copy icon that turns into a check, and a fixed width. */
  icon?: boolean;
  className?: string;
  /** A longer accessible name that starts with the visible label ("Copy" → "Copy Markdown"). */
  ariaLabel?: string;
  onCopied?: () => void;
  onFailed?: () => void;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async () => {
    const ok = await copy(text);
    clearTimeout(timer.current);
    if (!ok) {
      setDone(false);
      onFailed?.();
      return;
    }
    setDone(true);
    onCopied?.();
    timer.current = setTimeout(() => setDone(false), COPIED_MS);
  };
  const cls = (base: string) => `${base}${className ? ` ${className}` : ""}`;
  if (kind === "cmd")
    return (
      <button type="button" className={cls("cmd")} aria-label={done ? "Copied" : label} onClick={run}>
        <code>{text}</code>
        <span className="i" aria-hidden="true">
          {done ? <ICheck s={14} /> : <ICopy s={14} />}
        </span>
      </button>
    );
  if (kind === "icon" || kind === "inline")
    return (
      <button type="button" className={cls(`${kind === "icon" ? "icon-btn" : "copy-inl"}${done ? " ok" : ""}`)} aria-label={done ? "Copied" : label} onClick={run}>
        {done ? <ICheck s={14} /> : <ICopy s={14} />}
      </button>
    );
  if (icon)
    return (
      <button type="button" className={cls(`btn ${tone} cbtn${done ? " done" : ""}`)} aria-label={done ? "Copied" : (ariaLabel ?? label)} onClick={run}>
        <span className="ic" aria-hidden="true">
          <span className="a">
            <ICopy s={14} />
          </span>
          <span className="b">
            <ICheck s={14} />
          </span>
        </span>
        <span className="lb" aria-hidden="true">
          <span className="a">{label}</span>
          <span className="b">Copied</span>
        </span>
      </button>
    );
  return (
    <button type="button" className={cls(`btn ${tone}${done ? " ok" : ""}`)} aria-label={done ? undefined : ariaLabel} onClick={run}>
      {done ? "Copied" : label}
    </button>
  );
}
