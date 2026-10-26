import { useState } from "react";
import { ICheck, ICopy } from "./icons";

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/**
 * Copy buttons (v1.2): `icon` (32px icon button), `cmd` (a copyable shell command), or a text
 * button in `tone` primary / soft / quiet. The label is always the accessible name.
 */
export function CopyButton({
  text,
  label = "Copy",
  kind = "pill",
  tone = "quiet",
  className,
  ariaLabel,
  onCopied,
}: {
  text: string;
  label?: string;
  kind?: "pill" | "icon" | "cmd";
  tone?: "primary" | "soft" | "quiet";
  className?: string;
  /** A longer accessible name that starts with the visible label ("Copy" → "Copy Markdown"). */
  ariaLabel?: string;
  onCopied?: () => void;
}) {
  const [done, setDone] = useState(false);
  const run = async () => {
    await copy(text);
    setDone(true);
    onCopied?.();
    setTimeout(() => setDone(false), 1500);
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
  if (kind === "icon")
    return (
      <button type="button" className={cls(`icon-btn${done ? " ok" : ""}`)} aria-label={done ? "Copied" : label} onClick={run}>
        {done ? <ICheck s={16} /> : <ICopy s={16} />}
      </button>
    );
  return (
    <button type="button" className={cls(`btn ${tone}${done ? " ok" : ""}`)} aria-label={done ? undefined : ariaLabel} onClick={run}>
      {done ? "Copied" : label}
    </button>
  );
}
