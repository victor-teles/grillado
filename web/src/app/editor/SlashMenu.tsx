// The slash menu (v1.1 item 4): Uai's CommandMenu, wrapped locally and driven by the editor
// (the textarea block editor or CodeMirror), which stays the combobox and keeps focus.
// Hooks: .slm (desktop), .msm (mobile, docked), .sm-i rows, .sm-p preview, .sm-e no match.
import { type MutableRefObject, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CommandMenu,
  CommandMenuGroup,
  CommandMenuGroupLabel,
  CommandMenuItem,
  CommandMenuList,
  type MenuKey,
  useCommandMenu,
} from "@/components/ui/uai/command-menu";
import { type Cmd, type CmdId, type Field, type Group, type Hit, commands, editFields, expand, insertion, rank, slashQuery, tabStops } from "./slash";

/** What the menu needs from the editor it lives in. Offsets are in the editor's own text. */
export interface SlashHost {
  value(): string;
  sel(): [number, number];
  /** Replace the whole text (only the changed part is touched) and select [from, to). */
  set(text: string, from: number, to: number): void;
  /** Screen box of the character at `pos`. */
  rect(pos: number): { left: number; top: number; bottom: number } | null;
}

type Api = ReturnType<typeof useCommandMenu>;
type Menu = { from: number; query: string; pointer: boolean };
type Fields = { list: Field[]; i: number; text: string; tail: number };

export interface SlashOpts {
  agentName: string;
  /** Item 5's hook: when set, "Diagram by {agent}" is listed and runs this at the "/" offset. */
  onAgentDiagram?: (at: number) => void;
}

const ALL = () => true;

export function useSlash(host: MutableRefObject<SlashHost | null>, opts: SlashOpts) {
  const agentDiagram = !!opts.onAgentDiagram;
  const cmds = useMemo(() => commands(opts.agentName, agentDiagram), [opts.agentName, agentDiagram]);
  const [menu, setMenuS] = useState<Menu | null>(null);
  const [fields, setFieldsS] = useState<Fields | null>(null);
  const [say, setSay] = useState("");
  const [aria, setAria] = useState<{ activeId: string | null; listId: string | null }>({ activeId: null, listId: null });
  const api = useRef<Api | null>(null);
  const applying = useRef(false);
  /** Start of the last inserted block, in the host's text. */
  const last = useRef<number | null>(null);
  const hits = menu ? rank(cmds, menu.query) : [];
  // Event handlers run between renders: keep the latest state here too.
  const cur = useRef({ menu, fields, hits });
  cur.current.hits = hits;
  const setMenu = (m: Menu | null) => {
    cur.current.menu = m;
    setMenuS(m);
  };
  const setFields = (f: Fields | null) => {
    cur.current.fields = f;
    setFieldsS(f);
  };
  const set = (text: string, a: number, b: number) => {
    applying.current = true;
    try {
      host.current?.set(text, a, b);
    } finally {
      applying.current = false;
    }
  };
  const run = () => {
    const h = host.current;
    if (!h) return null;
    const [a, b] = h.sel();
    return a === b ? slashQuery(h.value(), a) : null;
  };

  /** The editor's text changed (typing, paste, undo). Only a typed "/" opens the menu. */
  const input = (prev: string, next: string) => {
    if (applying.current || !host.current) return;
    const { menu, fields } = cur.current;
    if (fields) {
      const r = editFields(fields.text, next, fields.list, fields.i);
      if (!r) setFields(null);
      else {
        if (r.text !== next) {
          const [a, b] = host.current.sel();
          set(r.text, a, b);
        }
        setFields({ ...fields, list: r.fields, text: r.text });
      }
    }
    const r = run();
    const [caret] = host.current.sel();
    if (menu) {
      if (!r || r.from !== menu.from) setMenu(null);
      else if (r.query !== menu.query) setMenu({ ...menu, query: r.query });
    } else if (r && r.query === "" && next.length === prev.length + 1 && next[caret - 1] === "/") setMenu({ from: r.from, query: "", pointer: false });
  };

  /** The caret moved: leaving the "/query" run closes the menu; leaving the field ends field mode. */
  const moved = () => {
    if (applying.current || !host.current) return;
    const { menu, fields } = cur.current;
    if (menu) {
      const r = run();
      if (!r || r.from !== menu.from) setMenu(null);
    }
    if (fields) {
      const [a, b] = host.current.sel();
      const f = fields.list[fields.i];
      if (a < f.start || b > f.end) setFields(null);
    }
  };

  /** A key in the editor. true when the menu or field mode used it (the editor does nothing more). */
  const key = (e: MenuKey & { shiftKey?: boolean }): boolean => {
    const { menu, fields, hits } = cur.current;
    const h = host.current;
    if (menu) {
      if (e.isComposing) return false;
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") return api.current?.onKeyDown(e) ?? false;
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!hits.length) {
          setMenu(null);
          // ↵ keeps "/xyz" as text and adds the newline; Tab just closes.
          if (e.key === "Enter") return false;
          e.preventDefault();
          return true;
        }
        return api.current?.onKeyDown({ key: "Enter", preventDefault: () => e.preventDefault() }) ?? false;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return true;
      }
      if (e.key === " " && !hits.length) setMenu(null);
      return false;
    }
    if (fields && h && e.key === "Tab") {
      e.preventDefault();
      const stops = tabStops(fields.list);
      const next = stops[stops.indexOf(fields.i) + (e.shiftKey ? -1 : 1)];
      if (next === undefined) {
        if (e.shiftKey) return true;
        // Past the last field: field mode ends with the caret after the block.
        const end = h.value().length - fields.tail;
        setFields(null);
        set(h.value(), end, end);
        return true;
      }
      const f = fields.list[next];
      setFields({ ...fields, i: next });
      set(h.value(), f.start, f.end);
      return true;
    }
    if (fields && e.key === "Escape") setFields(null);
    return false;
  };

  /** Open at a "/" the host just put at `from` ("+" in the rich view, "+ Block" on mobile). */
  const openAt = (from: number, pointer: boolean) => setMenu({ from, query: "", pointer });

  const pick = (hit: Hit) => {
    const h = host.current;
    const m = cur.current.menu;
    if (!h || !m) return;
    const doc = h.value();
    const runEnd = m.from + 1 + m.query.length;
    setMenu(null);
    if (hit.cmd.agent) {
      set(doc.slice(0, m.from) + doc.slice(runEnd), m.from, m.from);
      opts.onAgentDiagram?.(m.from);
      return;
    }
    const tpl = expand(hit.cmd.id, hit.alias);
    const ins = insertion(doc, { from: m.from, query: m.query }, runEnd, tpl);
    last.current = ins.end - tpl.text.length;
    const text = doc.slice(0, ins.from) + ins.text + doc.slice(ins.to);
    const f0 = ins.fields[0];
    set(text, f0?.start ?? ins.end, f0?.end ?? ins.end);
    setFields(f0 ? { list: ins.fields, i: 0, text, tail: text.length - ins.end } : null);
    const name = f0 ? text.slice(f0.start, f0.end) : "";
    setSay(`${hit.cmd.label} inserted.${f0 ? ` ${name} field selected.${tabStops(ins.fields).length > 1 ? " Tab for the next field." : ""}` : ""}`);
  };

  const close = () => {
    setMenu(null);
    setFields(null);
  };

  return { cmds, menu, fields, hits, say, aria, setAria, api, last, input, moved, key, openAt, pick, close };
}

export type Slash = ReturnType<typeof useSlash>;

/**
 * Popup attributes for the editor element (handoff §8). The editor stays a multi-line textbox:
 * role=combobox isn't allowed on a textarea and can't be multi-line, so it keeps its own role and
 * points at the list with aria-controls / aria-activedescendant while the menu is open.
 */
export function comboboxProps(s: Slash) {
  const open = !!s.menu && s.hits.length > 0;
  return {
    "aria-autocomplete": "list" as const,
    "aria-controls": open && s.aria.listId ? s.aria.listId : undefined,
    "aria-activedescendant": open && s.aria.activeId ? s.aria.activeId : undefined,
  };
}

// ---------------- the menu ----------------

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const ICON: Record<CmdId | "search", ReactNode> = {
  decision: svg(<><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>),
  question: svg(<><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></>),
  flow: svg(<><rect x="3" y="3" width="7" height="6" rx="1.5" /><rect x="14" y="15" width="7" height="6" rx="1.5" /><path d="M6.5 9v3a3 3 0 0 0 3 3h4.5" /></>),
  state: svg(<><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.6 10.5 15.4 7.5M8.6 13.5l6.8 3" /></>),
  agentdiag: svg(<><rect x="3" y="3" width="7" height="6" rx="1.5" /><path d="M6.5 9v3a3 3 0 0 0 3 3H12" /><path d="M18 13v8M14 17h8" /></>),
  callout: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></>),
  code: svg(<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />),
  diff: svg(<path d="M12 3v8M8 7h8M8 17h8" />),
  table: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M12 4v16" /></>),
  tabs: svg(<><path d="M3 20V7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10Z" /><path d="M3 11h18" /></>),
  h: svg(<path d="M5 4v16M15 4v16M5 12h10M19 20v-6l-2 1.5" />),
  list: svg(<><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r=".6" /><circle cx="4.5" cy="12" r=".6" /><circle cx="4.5" cy="18" r=".6" /></>),
  check: svg(<><rect x="3" y="4" width="6" height="6" rx="1.5" /><path d="m4.5 7 1 1 2-2M13 7h8M13 17h8" /><rect x="3" y="14" width="6" height="6" rx="1.5" /></>),
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
};
export const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />);
export const CalloutIcon = () => ICON.callout;

const bold = (text: string, idx: number[] | null) =>
  idx ? [...text].map((ch, i) => (idx.includes(i) ? <b key={i}>{ch}</b> : ch)) : text;

/** Static samples of what each block renders as (the preview column, aria-hidden). */
function sample(id: CmdId): ReactNode {
  switch (id) {
    case "decision":
      return (
        <div className="pdz">
          <div className="pvq">Which browsers do we support?</div>
          <div className="pva">
            Last two versions<span className="yc">Your call</span>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="pdz">
          <div className="pvq open">Which browsers do we support?</div>
          <span className="pvans">Answer</span>
        </div>
      );
    case "flow":
      return (
        <svg className="dg" viewBox="0 0 230 70" aria-hidden="true">
          <rect className="nb" x="2" y="22" width="66" height="26" rx="6" />
          <text x="35" y="39" textAnchor="middle">First step</text>
          <rect className="nb" x="96" y="22" width="66" height="26" rx="6" />
          <text x="129" y="39" textAnchor="middle">Next step</text>
          <path className="e" d="M68 35h28M162 35h28" />
          <rect className="nb" x="190" y="22" width="38" height="26" rx="6" />
          <text x="209" y="39" textAnchor="middle">…</text>
        </svg>
      );
    case "state":
      return (
        <svg className="dg" viewBox="0 0 230 70" aria-hidden="true">
          <circle cx="10" cy="35" r="5" fill="var(--foreground)" />
          <rect className="nb" x="34" y="22" width="76" height="26" rx="13" />
          <text x="72" y="39" textAnchor="middle">First state</text>
          <rect className="nb" x="140" y="22" width="84" height="26" rx="13" />
          <text x="182" y="39" textAnchor="middle">Next state</text>
          <path className="e" d="M15 35h19M110 35h30" />
        </svg>
      );
    case "agentdiag":
      return (
        <div className="agp">
          {ICON.flow}
          <span>Reads this section, then shows a diagram as a suggestion you accept or reject.</span>
        </div>
      );
    case "callout":
      return (
        <div className="cal">
          {ICON.callout}
          <span>
            <b>Note</b> · Text set apart from the plan.
          </span>
        </div>
      );
    case "code":
      return <div className="mono">const list = await sync()</div>;
    case "diff":
      return (
        <div className="mono">
          <span className="dl">- Last edit wins</span>
          {"\n"}
          <span className="dd">+ Merge per item</span>
        </div>
      );
    case "table":
      return (
        <table>
          <tbody>
            <tr><th>Column</th><th>Column</th></tr>
            <tr><td>Cell</td><td>Cell</td></tr>
          </tbody>
        </table>
      );
    case "tabs":
      return (
        <>
          <div className="tabs4"><span className="on">First tab</span><span>Second tab</span></div>
          <div>Only the open tab shows.</div>
        </>
      );
    case "h":
      return <div className="pvh">Heading</div>;
    case "list":
      return (<><div className="pvli">Item</div><div className="pvli">Item</div></>);
    case "check":
      return (<><div className="pvck"><i />Task</div><div className="pvck"><i />Task</div></>);
  }
}

/** Reports the menu's active row and list id up to the editor (aria-activedescendant). */
function Bridge({ s }: { s: Slash }) {
  const api = useCommandMenu();
  s.api.current = api;
  const { activeId, listId } = api;
  useEffect(() => {
    if (s.aria.activeId !== activeId || s.aria.listId !== listId) s.setAria({ activeId, listId });
  });
  useEffect(() => () => s.setAria({ activeId: null, listId: null }), []);
  return null;
}

function Preview({ s, agentName }: { s: Slash; agentName: string }) {
  const id = s.aria.activeId;
  const hit = s.hits.find((h) => h.cmd.id === (id ? document.getElementById(id)?.dataset.cmd : s.hits[0]?.cmd.id)) ?? s.hits[0];
  if (!hit) return null;
  const c = hit.cmd;
  return (
    <div className="sm-p" aria-hidden="true">
      <div>
        <h4>{c.label}</h4>
        <div className="pd">{c.desc}</div>
      </div>
      <div className="pv">{sample(c.id)}</div>
      <div className="ins">
        <span className="pt">{c.agent ? `Runs ${agentName} · adds a suggestion` : "Inserts"}</span>
        {c.agent ? null : <div className="snip">{expand(c.id, hit.alias).text}</div>}
      </div>
    </div>
  );
}

const WIDE = 1100;

/** The menu, anchored under the "/" (desktop) or docked above the accessory row (mobile). */
export function SlashMenu({ s, host, agentName, mobile, dock = 0 }: { s: Slash; host: MutableRefObject<SlashHost | null>; agentName: string; mobile: boolean; dock?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const menu = s.menu;
  const preview = !mobile && typeof window !== "undefined" && window.innerWidth >= WIDE && s.hits.length > 0;
  useLayoutEffect(() => {
    if (!menu || mobile) return;
    const r = host.current?.rect(menu.from);
    const el = ref.current;
    if (!r || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = r.bottom + 6;
    let origin = "top left";
    if (top + h > window.innerHeight - 12 && r.top - 6 - h >= 12) {
      top = r.top - 6 - h;
      origin = "bottom left";
    }
    const left = Math.max(12, Math.min(r.left - 36, window.innerWidth - w - 12));
    if (!pos || pos.left !== left || pos.top !== top) setPos({ left, top, origin });
  });
  const [count, setCount] = useState("");
  useEffect(() => {
    if (!menu) return;
    const t = setTimeout(() => setCount(s.hits.length ? `${s.hits.length} ${s.hits.length === 1 ? "block" : "blocks"}` : ""), 250);
    return () => clearTimeout(t);
  }, [menu?.query, s.hits.length]);
  if (!menu) return null;
  const q = menu.query;
  const rows = (hits: Hit[]) =>
    hits.map((h) => (
      <CommandMenuItem
        key={h.cmd.id}
        value={h.cmd.label}
        data-cmd={h.cmd.id}
        className="sm-i"
        aria-description={h.cmd.agent ? `Runs ${agentName}. Adds a suggestion.` : undefined}
        onSelect={() => s.pick(h)}
      >
        {ICON[h.cmd.id]}
        {mobile ? (
          <span className="tx2">
            <span className="lb">
              {bold(h.cmd.label, h.hit)}
              {h.alias ? <span className="al">{bold(h.alias, [...q].map((_, i) => i))}</span> : null}
            </span>
            <span className="d">{h.cmd.desc}</span>
          </span>
        ) : (
          <span className="lb">
            {bold(h.cmd.label, h.hit)}
            {h.alias ? <span className="al">{bold(h.alias, [...q].map((_, i) => i))}</span> : null}
          </span>
        )}
        {h.cmd.agent ? <i className="ag" aria-hidden="true" /> : h.cmd.sc && !mobile ? <kbd className="sc" aria-hidden="true">{h.cmd.sc}</kbd> : null}
      </CommandMenuItem>
    ));
  const grouped = () => {
    const groups: [Group, Hit[]][] = [];
    for (const h of s.hits) {
      const last = groups.at(-1);
      if (last && last[0] === h.cmd.group) last[1].push(h);
      else groups.push([h.cmd.group, [h]]);
    }
    return groups.map(([g, hs]) => (
      <CommandMenuGroup key={g} className="sm-gr">
        <CommandMenuGroupLabel className="sm-g">{g}</CommandMenuGroupLabel>
        {rows(hs)}
      </CommandMenuGroup>
    ));
  };
  const style = mobile ? { bottom: dock } : pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: -9999, top: 0 };
  return createPortal(
    <div
      ref={ref}
      className={mobile ? "msm" : preview ? "slm" : "slm np"}
      data-pointer={menu.pointer ? "" : undefined}
      style={style}
      // Clicks in the menu keep focus (and the caret) in the editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      <CommandMenu variant="floating" value={q} filter={ALL} label="Blocks" appear={false} className="sm-c">
        <Bridge s={s} />
        {s.hits.length ? (
          <CommandMenuList className="sm-l">{q ? rows(s.hits) : grouped()}</CommandMenuList>
        ) : (
          <div className="sm-e" role="status">
            <span className="ei">{ICON.search}</span>
            <b>No block called “/{q}”</b>
            <span>{mobile ? "Keep typing: it stays as text" : "↵ keeps it as text · Esc closes"}</span>
          </div>
        )}
        {mobile || !s.hits.length ? null : (
          <div className="sm-f" aria-hidden="true">
            <span><span className="kb4">↑↓</span> move</span>
            <span><span className="kb4">↵</span> insert</span>
            <span><span className="kb4">Esc</span> close</span>
          </div>
        )}
      </CommandMenu>
      {preview ? <Preview s={s} agentName={agentName} /> : null}
      <span className="sr-only" role="status">{count}</span>
    </div>,
    // Inside <main>, so the menu sits in the page's landmark.
    document.querySelector("main") ?? document.body,
  );
}

/** Caret box in a textarea: a hidden mirror with the same text metrics, measured at `pos`. */
export function textareaRect(el: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(el);
  const m = document.createElement("div");
  for (const p of ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize"] as const)
    m.style[p] = cs[p];
  Object.assign(m.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "-9999px" });
  m.textContent = el.value.slice(0, pos);
  const mark = document.createElement("span");
  mark.textContent = el.value.slice(pos, pos + 1) || "\u200b";
  m.appendChild(mark);
  document.body.appendChild(m);
  const r = el.getBoundingClientRect();
  const left = r.left + mark.offsetLeft - el.scrollLeft;
  const top = r.top + mark.offsetTop - el.scrollTop;
  const out = { left, top, bottom: top + mark.offsetHeight };
  m.remove();
  return out;
}
