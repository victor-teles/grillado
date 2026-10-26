// Plan text ↔ decision linking helpers (item 2 handoff §2): jump + flash, and viewport checks.

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Hover linking only where there's a real hover (§5: none on touch). */
export const canHover = () => typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;

let flashing: { el: HTMLElement; t: ReturnType<typeof setTimeout> } | null = null;

/**
 * §2.4: scroll the target to the middle (smooth unless reduced motion) and flash it: tint in 120ms,
 * hold 1200ms, out 220ms (CSS on [data-fl]). A new jump cancels the running flash.
 */
export function jumpTo(el: HTMLElement | null, focus?: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  if (flashing) {
    clearTimeout(flashing.t);
    flashing.el.removeAttribute("data-fl");
  }
  el.setAttribute("data-fl", "");
  flashing = { el, t: setTimeout(() => el.removeAttribute("data-fl"), 1320) };
  focus?.focus({ preventScroll: true });
}

/** Where `el` is relative to the plan's scroll viewport. */
export function offscreen(el: Element | null): "above" | "below" | null {
  if (!el) return null;
  const box = (el.closest(".docwrap") as HTMLElement | null)?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const r = el.getBoundingClientRect();
  return r.bottom < box.top ? "above" : r.top > box.bottom ? "below" : null;
}

/** A non-empty text selection inside the plan suspends hover linking (§2.5, item 3's toolbar). */
export const selecting = () => {
  const s = typeof getSelection === "function" ? getSelection() : null;
  return !!s && !s.isCollapsed && !!s.anchorNode?.parentElement?.closest(".doc");
};
