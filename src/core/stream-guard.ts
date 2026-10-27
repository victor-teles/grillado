// What of a streamed reply may be shown yet (#97). The banned filter runs on the whole reply once it
// is in, but a streamed reply is on screen before then, so this holds text back until it is safe:
// only whole words are released (so "grill" never shows before we know what follows), a tail that
// could still become one of our own instruction sentences waits, and once anything banned shows up nothing more is released for that attempt (the reply
// will be rejected and asked again, and the partial text is dropped).
import { findBanned } from "./filter.ts";
import { promptFragments } from "./prompts.ts";

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
/** A held-back tail this long that starts an instruction sentence is never shown. */
const FRAGMENT_PREFIX = 16;

export class StreamGuard {
  private text = "";
  private tripped = false;
  private shown = "";
  private fragments = promptFragments().map(normalize);
  constructor(private exempt: string) {}

  /** Add streamed text; returns the text that may be shown now. */
  push(more: string): string {
    this.text += more;
    return this.safe();
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

  private safe(): string {
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
    // What was shown stays shown: the release only grows.
    const out = this.text.slice(0, Math.max(0, cut)).replace(/\s+$/, "");
    if (out.length > this.shown.length) this.shown = out;
    return this.shown;
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
