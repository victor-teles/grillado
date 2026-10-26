// CodeMirror 6 setup for the Markdown view and the diagram source editor. Loaded on demand
// (dynamic import) so the document view doesn't pay for it.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { type Format, formatEdit } from "./selection";
import { Decoration, type DecorationSet, EditorView, MatchDecorator, ViewPlugin, type ViewUpdate, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface LineError {
  /** 1-based line in the document. */
  line: number;
  message: string;
}

const setErrors = StateEffect.define<LineError[]>();
/** Marks changes that came from outside (setValue), so they aren't reported back as edits. */
const external = Annotation.define<boolean>();

class ErrorWidget extends WidgetType {
  constructor(readonly message: string) {
    super();
  }
  eq(o: ErrorWidget) {
    return o.message === this.message;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-errmsg";
    el.setAttribute("role", "note");
    el.textContent = this.message;
    return el;
  }
}

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrors)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const doc = tr.state.doc;
      for (const err of [...e.value].sort((a, z) => a.line - z.line)) {
        if (err.line < 1 || err.line > doc.lines) continue;
        const line = doc.line(err.line);
        b.add(line.from, line.from, Decoration.line({ class: "cm-errline", attributes: { "data-error": err.message } }));
        b.add(line.to, line.to, Decoration.widget({ widget: new ErrorWidget(`Line ${err.line}: ${err.message}`), side: 1, block: true }));
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// [R1:key] citations stand out (primary ink).
const citeMatcher = new MatchDecorator({ regexp: /\[R\d+:[^\]\s]+\]/g, decoration: Decoration.mark({ class: "cm-cite" }) });
const cites = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = citeMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = citeMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

// Lines inside ``` fences (decision and diagram blocks) get a tint. Inside a decision fence the
// machine fields (id, key, by, kept_suggestion, at, status) step back whole; the human fields
// (question, answer, note) keep a foreground value with a muted key (v1.2 §4). `key:` stays editable.
const MACHINE = new Set(["id", "key", "by", "kept_suggestion", "at", "status"]);
const fenceLine = Decoration.line({ class: "cm-fenced" });
const fenceMark = Decoration.mark({ class: "cm-fmark" });
const dfield = Decoration.mark({ class: "cm-dfield" });
const dkey = Decoration.mark({ class: "cm-dkey" });
function fenceDeco(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  let inFence = false;
  let decision = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const fence = line.text.startsWith("```");
    if (fence || inFence) b.add(line.from, line.from, fenceLine);
    if (fence) {
      if (line.to > line.from) b.add(line.from, line.to, fenceMark);
      inFence = !inFence;
      decision = inFence && /^```decision\b/.test(line.text);
      continue;
    }
    if (inFence && decision) {
      const m = /^(\s*)([A-Za-z_]+)\s*:/.exec(line.text);
      if (m) {
        const start = line.from + m[1].length;
        if (MACHINE.has(m[2].toLowerCase())) {
          if (line.to > start) b.add(start, line.to, dfield);
        } else b.add(start, line.from + m[0].length, dkey);
      }
    }
  }
  return b.finish();
}
const fences = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = fenceDeco(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = fenceDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: [tags.processingInstruction, tags.punctuation, tags.meta], class: "cm-marker" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
]);

export interface CodeEditorHandle {
  view: EditorView;
  setValue(text: string): void;
  setErrors(errors: LineError[]): void;
  destroy(): void;
}

/** ⌘B / ⌘I wrap the selection in Markdown marks, or unwrap it (item 3 keeps them working in the editor). */
const format = (f: Format) => (view: EditorView) => {
  const r = view.state.selection.main;
  if (r.empty) return false;
  const doc = view.state.doc.toString();
  const out = formatEdit(doc, r.from, r.to, f);
  let a = 0;
  while (a < doc.length && doc[a] === out.text[a]) a++;
  let z = 0;
  while (z < doc.length - a && doc[doc.length - 1 - z] === out.text[out.text.length - 1 - z]) z++;
  view.dispatch({ changes: { from: a, to: doc.length - z, insert: out.text.slice(a, out.text.length - z) }, selection: { anchor: out.start, head: out.end } });
  return true;
};

export function createEditor(opts: {
  parent: HTMLElement;
  value: string;
  label: string;
  markdownLang: boolean;
  onChange: (text: string) => void;
  onCursor?: (line: number, col: number) => void;
  onBlur?: () => void;
  keys?: { key: string; run: () => boolean }[];
}): CodeEditorHandle {
  const ext: Extension[] = [
    lineNumbers(),
    history(),
    EditorView.lineWrapping,
    keymap.of([...(opts.keys ?? []), { key: "Mod-b", run: format("bold") }, { key: "Mod-i", run: format("italic") }, ...defaultKeymap, ...historyKeymap]),
    syntaxHighlighting(highlight),
    errorField,
    cites,
    fences,
    EditorView.contentAttributes.of({ "aria-label": opts.label, "aria-multiline": "true", spellcheck: "false" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) opts.onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        opts.onCursor?.(line.number, head - line.from + 1);
      }
      if (u.focusChanged && !u.view.hasFocus) opts.onBlur?.();
    }),
  ];
  if (opts.markdownLang) ext.push(markdown());
  const view = new EditorView({ doc: opts.value, extensions: ext, parent: opts.parent });
  // e2e and debugging reach the view through the DOM.
  (view.dom as HTMLElement & { cmView?: EditorView }).cmView = view;
  return {
    view,
    setValue(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      // Replace only the part that differs so the caret and scroll stay put.
      let a = 0;
      while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
      let z = 0;
      while (z < cur.length - a && z < text.length - a && cur[cur.length - 1 - z] === text[text.length - 1 - z]) z++;
      view.dispatch({ changes: { from: a, to: cur.length - z, insert: text.slice(a, text.length - z) }, annotations: external.of(true) });
    },
    setErrors(errors) {
      view.dispatch({ effects: setErrors.of(errors) });
    },
    destroy() {
      view.destroy();
    },
  };
}
