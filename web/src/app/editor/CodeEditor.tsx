import { useEffect, useRef, useState } from "react";
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
}) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<CodeEditorHandle | null>(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const [ready, setReady] = useState(false);
  const cb = useRef({ onChange, onBlur, keys });
  cb.current = { onChange, onBlur, keys };
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
      });
      setReady(true);
      if (autoFocus) ed.current.view.focus();
    });
    return () => {
      live = false;
      ed.current?.destroy();
      ed.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => ed.current?.setValue(value), [value, ready]);
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
