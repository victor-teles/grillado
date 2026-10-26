import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { CodeEditorHandle, LineError } from "./cm";

let cm: Promise<typeof import("./cm")> | null = null;
const loadCm = () => (cm ??= import("./cm"));

/**
 * CodeMirror text editor (Markdown view, diagram source). Hooks: `.ced`, `.ced-status`,
 * `.cm-cite`, `.cm-fenced`, `.cm-fmark`, `.cm-dkey`, `.cm-dfield`, `.cm-errline`, `.cm-errmsg`.
 */
export function CodeEditor({
  value,
  onChange,
  label,
  file,
  mode = "Markdown",
  markdownLang = true,
  errors = [],
  onBlur,
  autoFocus,
  keys,
  testId,
  handle,
  onKey,
  onSelect,
  attrs,
}: {
  value: string;
  onChange: (t: string) => void;
  label: string;
  file?: string;
  mode?: string;
  markdownLang?: boolean;
  errors?: LineError[];
  onBlur?: () => void;
  autoFocus?: boolean;
  keys?: { key: string; run: () => boolean }[];
  testId?: string;
  /** The live editor, for hosts that drive it (the slash menu). */
  handle?: MutableRefObject<CodeEditorHandle | null>;
  onKey?: (e: KeyboardEvent) => boolean;
  onSelect?: () => void;
  /** Extra attributes on the editable element (the slash menu's combobox attributes). */
  attrs?: Record<string, string | boolean | undefined>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<CodeEditorHandle | null>(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [ready, setReady] = useState(false);
  const cb = useRef({ onChange, onBlur, keys, onKey, onSelect });
  cb.current = { onChange, onBlur, keys, onKey, onSelect };
  const initial = useRef(value);

  useEffect(() => {
    let live = true;
    void loadCm().then((m) => {
      if (!live || !host.current) return;
      ed.current = m.createEditor({
        parent: host.current,
        value: initial.current,
        label,
        markdownLang,
        onChange: (t) => cb.current.onChange(t),
        onCursor: (line, col) => setPos({ line, col }),
        onBlur: () => cb.current.onBlur?.(),
        keys: (cb.current.keys ?? []).map((k) => ({ key: k.key, run: () => cb.current.keys?.find((x) => x.key === k.key)?.run() ?? false })),
        onKey: (e) => cb.current.onKey?.(e) ?? false,
        onSelect: () => cb.current.onSelect?.(),
      });
      if (handle) handle.current = ed.current;
      setReady(true);
      if (autoFocus) ed.current.view.focus();
    });
    return () => {
      live = false;
      ed.current?.destroy();
      ed.current = null;
      if (handle) handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => ed.current?.setValue(value), [value, ready]);
  const attrKey = JSON.stringify(attrs ?? {});
  useEffect(() => {
    const el = ed.current?.view.contentDOM;
    if (!el || !attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) el.removeAttribute(k);
      else el.setAttribute(k, String(v));
    }
  }, [attrKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const errKey = JSON.stringify(errors);
  useEffect(() => ed.current?.setErrors(errors), [errKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ced" data-ready={ready ? "" : undefined} data-testid={testId}>
      {ready ? null : <pre className="ced-loading mono">{value}</pre>}
      <div ref={host} className="ced-host mono" />
      {file ? (
        <div className="ced-status" aria-hidden="true">
          <span>{file}</span>
          <span>{mode}</span>
          <span>
            Ln {pos.line}, Col {pos.col}
          </span>
        </div>
      ) : null}
    </div>
  );
}
