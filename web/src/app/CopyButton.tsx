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

/** Icon-only (`.btnico`) or small pill copy button. The label is always the accessible name. */
export function CopyButton({ text, label = "Copy", kind = "pill", onCopied }: { text: string; label?: string; kind?: "pill" | "icon" | "cmd"; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  const run = async () => {
    await copy(text);
    setDone(true);
    onCopied?.();
    setTimeout(() => setDone(false), 1500);
  };
  if (kind === "cmd")
    return (
      <button type="button" className="cmd" aria-label={done ? "Copied" : label} onClick={run}>
        {text}
        <span className="i" aria-hidden="true">
          {done ? <ICheck s={12} /> : <ICopy s={12} />}
        </span>
      </button>
    );
  if (kind === "icon")
    return (
      <button type="button" className={`btnico${done ? " ok" : ""}`} aria-label={done ? "Copied" : label} onClick={run}>
        {done ? <ICheck s={14} /> : <ICopy s={14} />}
      </button>
    );
  return (
    <button type="button" className="pill secondary sm" onClick={run} style={done ? { color: "var(--success-ink)" } : undefined}>
      {done ? <ICheck s={14} /> : <ICopy s={14} />}
      {done ? "Copied" : label}
    </button>
  );
}
