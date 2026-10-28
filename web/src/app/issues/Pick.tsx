// The sheet's comboboxes (§2, §7): a .isel button that opens a .ilist listbox, with an optional
// search row that also takes a typed value ("Use acme/payments", "Create label “x”").
// Keyboard: ↑/↓ move the highlight (aria-activedescendant), Enter picks, Esc closes the list only.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ICheck, IDown, ISearch } from "../icons";

export interface Opt {
  value: string;
  label: string;
  meta?: string;
  /** A label colour, as GitHub/Linear give it ("d73a4a" or "#d73a4a"). */
  color?: string;
}

/** The listbox. `onCreate` turns typed text into an extra option at the end (or null). */
export function ListBox(p: {
  label: string;
  options: Opt[];
  selected?: string;
  search?: string;
  onCreate?: (q: string) => Opt | null;
  onPick: (o: Opt) => void;
  onClose: (refocus: boolean) => void;
  loading?: boolean;
  empty?: string;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const t = q.trim().toLowerCase();
  const shown = p.options.filter((o) => !t || o.label.toLowerCase().includes(t) || o.value.toLowerCase().includes(t));
  const extra = p.onCreate && q.trim() && !p.options.some((o) => o.value.toLowerCase() === t) ? p.onCreate(q.trim()) : null;
  const all = extra ? [...shown, extra] : shown;
  const at = Math.min(hl, Math.max(0, all.length - 1));

  useEffect(() => {
    if (p.search !== undefined) input.current?.focus({ preventScroll: true });
    else list.current?.focus({ preventScroll: true });
  }, []);
  // A press outside closes it (without moving focus).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const field = box.current?.parentElement;
      if (field && !field.contains(e.target as Node)) p.onClose(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [p.onClose]);

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = all.length;
      if (n) setHl((at + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Home" && p.search === undefined) {
      e.preventDefault();
      setHl(0);
    } else if (e.key === "End" && p.search === undefined) {
      e.preventDefault();
      setHl(all.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (all[at]) p.onPick(all[at]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose(true);
    } else if (e.key === "Tab") p.onClose(false);
  };
  const optId = (i: number) => `${id}-o${i}`;
  return (
    <div ref={box} className="ilist">
      {p.search !== undefined ? (
        <div className="isrch">
          <ISearch s={16} />
          <input
            ref={input}
            value={q}
            placeholder={p.search}
            aria-label={p.search.replace(/…$/, "")}
            role="combobox"
            aria-expanded="true"
            aria-controls={id}
            aria-activedescendant={all.length ? optId(at) : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setHl(0);
            }}
            onKeyDown={keys}
          />
        </div>
      ) : null}
      <div
        ref={list}
        id={id}
        role="listbox"
        aria-label={p.label}
        tabIndex={p.search === undefined ? -1 : undefined}
        aria-activedescendant={p.search === undefined && all.length ? optId(at) : undefined}
        onKeyDown={p.search === undefined ? keys : undefined}
        style={{ display: "grid", outline: "none" }}
      >
        {all.map((o, i) => (
          <div
            key={`${o.value}-${i}`}
            id={optId(i)}
            className="iopt"
            role="option"
            aria-selected={o.value === p.selected}
            data-hl={i === at ? "" : undefined}
            onPointerMove={() => setHl(i)}
            onClick={() => p.onPick(o)}
          >
            {o.color ? <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, flex: "none", background: o.color.startsWith("#") ? o.color : `#${o.color}` }} /> : null}
            <span className="t">{o.label}</span>
            {o.meta ? <span className="m">{o.meta}</span> : null}
            {o.value === p.selected ? <ICheck s={16} className="ok" /> : null}
          </div>
        ))}
        {!all.length ? (
          <div className="iopt" role="option" aria-selected="false" aria-disabled="true">
            <span className="m">{p.loading ? "Loading…" : (p.empty ?? "Nothing found")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled .isel combobox button plus its listbox. */
export function Select(p: {
  id: string;
  label: ReactNode;
  value?: string;
  placeholder: string;
  hint?: ReactNode;
  open: boolean;
  setOpen: (v: boolean) => void;
  list: (close: (refocus: boolean) => void) => ReactNode;
  invalid?: boolean;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    p.setOpen(false);
    if (refocus) btn.current?.focus({ preventScroll: true });
  };
  return (
    <div className="ifl">
      <label className="ilb" htmlFor={p.id}>
        {p.label}
      </label>
      <button
        ref={btn}
        type="button"
        id={p.id}
        className={`isel${p.value ? "" : " ph"}`}
        aria-haspopup="listbox"
        aria-expanded={p.open}
        aria-invalid={p.invalid || undefined}
        onClick={() => p.setOpen(!p.open)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !p.open) {
            e.preventDefault();
            p.setOpen(true);
          }
        }}
      >
        {p.value ? <span className="v">{p.value}</span> : p.placeholder}
        <IDown s={16} />
      </button>
      {p.hint}
      {p.open ? p.list(close) : null}
    </div>
  );
}
