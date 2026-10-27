// What of a streamed reply may be shown yet (#97). The banned filter runs on the whole reply once it
// is in, but a streamed reply is on screen before then, so this holds text back until it is safe:
// only whole words are released (so "grill" never shows before we know what follows), a tail that
// could still become one of our own instruction sentences waits, and once anything banned shows up
// nothing more is released for that attempt (the reply will be rejected and asked again, and the
// partial text is dropped).
import { BANNED_TERMS, findBanned } from "./filter.ts";
import { promptFragments } from "./prompts.ts";

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
/** A held-back tail this long that starts an instruction sentence is never shown. */
const FRAGMENT_PREFIX = 16;
/** Banned terms of more than one word: their first words are harmless alone, so they wait (#97). */
const MULTI_WORD = BANNED_TERMS.filter((t) => t.includes(" "));

export class StreamGuard {
  private text = "";
  private tripped = false;
  private shown = "";
  private fragments = promptFragments().map(normalize);
  private multi: string[];
  constructor(private exempt: string) {
    const ex = normalize(exempt);
    this.multi = MULTI_WORD.filter((t) => !ex.includes(t));
  }

  /** Add streamed text; returns the text that may be shown now. */
  push(more: string): string {
    this.text += more;
    return this.safe();
  }

  /**
   * The stream is over (finished, stopped or failed): release what the multi-word hold kept, since no
   * next word is coming to make it banned ("Talk to Matt" keeps "Matt"). Partial words, instruction
   * fragments and banned names stay cut; once tripped, only what was already shown.
   */
  settle(): string {
    return this.safe(false);
  }

  reset(): void {
    this.text = "";
    this.shown = "";
    this.tripped = false;
  }

  /** True once the reply has shown something banned: the attempt is going to be rejected. */
  get blocked(): boolean {
    return this.tripped;
  }

  private safe(hold = true): string {
    if (this.tripped) return "";
    if (findBanned(this.text, this.exempt)) {
      this.tripped = true;
      return "";
    }
    // Whole words only: "grill" never shows before we know whether "ing" follows.
    const ws = this.text.search(/\s\S*$/);
    let cut = ws === -1 ? 0 : ws;
    const hay = normalize(this.text);
    // A tail that could still become one of our instruction sentences waits.
    for (const f of this.fragments) {
      for (let k = Math.min(f.length - 1, hay.length); k >= FRAGMENT_PREFIX; k--) {
        const at = hay.length - k;
        if (hay.slice(at) === f.slice(0, k)) {
          cut = Math.min(cut, this.indexFromEnd(k));
          break;
        }
      }
    }
    // Trailing words that could still become a multi-word banned name wait for the next word:
    // "As Matt" is held until we know whether "Pocock" follows.
    if (hold) cut = Math.min(cut, this.multiWordHold());
    // What was shown stays shown: the release only grows.
    const out = this.text.slice(0, Math.max(0, cut)).replace(/\s+$/, "");
    if (out.length > this.shown.length) this.shown = out;
    return this.shown;
  }

  /** Where the earliest trailing run of words that starts a multi-word banned term begins, or the end. */
  private multiWordHold(): number {
    let hold = this.text.length;
    const longest = Math.max(0, ...this.multi.map((t) => t.length));
    for (let i = this.text.length; i >= 0; i--) {
      if (i > 0 && !/\s/.test(this.text[i - 1])) continue;
      const tail = normalize(this.text.slice(i)).trim();
      if (tail.length > longest) break;
      if (tail && this.multi.some((t) => t.startsWith(tail))) hold = i;
    }
    return hold;
  }

  /** The position in the raw text of the normalized tail of length k (whitespace runs count once). */
  private indexFromEnd(k: number): number {
    let i = this.text.length;
    let seen = 0;
    while (i > 0 && seen < k) {
      i--;
      if (/\s/.test(this.text[i])) while (i > 0 && /\s/.test(this.text[i - 1])) i--;
      seen++;
    }
    return i;
  }
}
