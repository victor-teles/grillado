import { useEffect, useRef } from "react";

/**
 * Where something may float beside a line of plan text (#119). Shared by the ✓ Accepted mark (#102)
 * and the hover pill (#103), so both read the same line end and avoid the same controls.
 *
 * - The line end comes from text only. The decision cites (`.gut`), the block's Edit button
 *   (`.blk-act`) and the floating pill are absolutely placed, so a Range over the whole block
 *   would count them as text.
 * - The block's Edit button, its reserved slot (#117) and its cites are taken: a candidate box that touches one doesn't fit,
 *   even while they are faded out (they show on the same hover).
 */
export type Box = { left: number; right: number; top: number; bottom: number };

export interface LineRoom {
  /** The last line box of the element. */
  last: DOMRect;
  /** The right edge of the text on that line, the element's and whatever follows it. */
  end: number;
  colLeft: number;
  colRight: number;
  /** The Edit slot and the cites of the element's block. */
  taken: Box[];
  /** A cite sits on this line: nothing goes in the margin there. */
  cited: boolean;
}

// An inline cite (#118 fallback, `.gut.in`) is in the flow, so it counts as text.
const NOT_TEXT = ".gut:not(.in), .blk-act, .blk-slot, .ipill.hp, .okm, .sr-only";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote";

export function lineRoom(el: Element): LineRoom | null {
  const last = [...el.getClientRects()].filter((r) => r.width > 0).pop();
  const doc = el.closest<HTMLElement>(".doc");
  if (!last || !doc) return null;
  const block = el.closest(BLOCK) ?? el.parentElement ?? el;
  const mid = (last.top + last.bottom) / 2;
  let end = last.right;
  const range = document.createRange();
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent?.trim() || n.parentElement?.closest(NOT_TEXT)) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width > 1 && r.top <= mid && r.bottom >= mid) end = Math.max(end, r.right);
  }
  const d = doc.getBoundingClientRect();
  const cs = getComputedStyle(doc);
  const blk = el.closest(".blk");
  const box = (e: Element): Box => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  // Edit and its reserved first-line slot (#117); the slot has no box where it isn't shown (touch, phones).
  const edit = blk ? [...blk.querySelectorAll(":scope > .blk-act, :scope > .blk-slot")].map(box).filter((b) => b.right > b.left) : [];
  const cites = blk ? [...blk.querySelectorAll(".gut-cite")].map(box).filter((b) => b.right > b.left) : [];
  return {
    last,
    end,
    colLeft: d.left + parseFloat(cs.paddingLeft || "0"),
    colRight: d.right - parseFloat(cs.paddingRight || "0"),
    taken: [...edit, ...cites],
    cited: cites.some((c) => c.top < last.bottom && c.bottom > last.top),
  };
}

/** The first taken box that `b` touches, if any. */
export const hit = (b: Box, taken: Box[]) => taken.find((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top);

/**
 * Something placed once beside the text goes, rather than moves, when the plan's width changes: a
 * window resize or the rail opening or closing (#116). A height change (a scrollbar showing up) moves no text.
 */
export function useDropOnResize(wrap: HTMLElement, onDrop: () => void) {
  const drop = useRef(onDrop);
  drop.current = onDrop;
  useEffect(() => {
    let width = wrap.clientWidth;
    const ro = new ResizeObserver(() => {
      if (wrap.clientWidth !== width) drop.current();
      width = wrap.clientWidth;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);
}
