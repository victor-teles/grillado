// Debounced, serialized autosave. DOM-free so it can be unit-tested with fake saves.
//
// - `change(text)` marks the draft dirty and saves after `delay` ms of quiet.
// - Only one save is in flight; edits made during a save are saved right after it.
// - A failed save keeps the draft dirty and reports "error"; the next change or `flush()` retries.

export type SaveState = "saved" | "pending" | "saving" | "error";

export interface AutosaveOptions {
  save: (text: string) => Promise<void>;
  delay?: number;
  onState?: (state: SaveState, info: { error?: string; savedAt?: number }) => void;
}

export class Autosaver {
  private draft: string | null = null; // text not yet handed to `save`
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private failed = false;
  private _state: SaveState = "saved";
  private held = false;
  /** The last text the server confirmed. */
  lastSaved: string;

  constructor(
    initial: string,
    private opts: AutosaveOptions,
  ) {
    this.lastSaved = initial;
  }

  get state() {
    return this._state;
  }

  /** True while there is text the server hasn't confirmed yet. */
  get dirty() {
    return this.draft !== null || this.inflight !== null || this.failed;
  }

  change(text: string) {
    this.draft = text;
    this.failed = false;
    this.set("pending");
    this.clearTimer();
    if (this.held) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.opts.delay ?? 600);
  }

  /** Stop saving (plan.md changed on disk and the user hasn't picked a version yet). */
  hold() {
    this.held = true;
    this.clearTimer();
  }

  get holding() {
    return this.held;
  }

  /** Saving again; anything typed meanwhile is saved now. */
  release() {
    this.held = false;
    if (this.draft !== null) void this.run();
  }

  /** Save now (blur, toggle, leaving the page). Resolves once everything typed so far is saved or failed. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.held) return;
    if (this.draft === null && this.failed && !this.inflight) this.draft = this.failedText;
    // Loop: a save already in flight may be followed by one for text typed meanwhile.
    while (this.inflight || this.draft !== null) {
      if (this.inflight) await this.inflight;
      else {
        await this.run();
        if (this.failed) return;
      }
    }
  }

  /** Forget pending work (e.g. the plan was replaced by a new one). */
  reset(text: string) {
    this.clearTimer();
    this.held = false;
    this.draft = null;
    this.failed = false;
    this.lastSaved = text;
    this.set("saved");
  }

  dispose() {
    this.clearTimer();
  }

  private failedText: string | null = null;

  private async run(): Promise<void> {
    if (this.inflight) {
      // A save is running; the draft goes right after it.
      await this.inflight;
      if (this.draft !== null && !this.timer) return this.run();
      return;
    }
    const text = this.draft;
    if (text === null || this.held) return;
    this.draft = null;
    if (text === this.lastSaved) {
      this.set("saved", { savedAt: Date.now() });
      return;
    }
    this.set("saving");
    this.inflight = this.opts
      .save(text)
      .then(
        () => {
          this.lastSaved = text;
          this.failed = false;
          this.failedText = null;
        },
        (err) => {
          this.failed = true;
          this.failedText = this.draft ?? text;
          this.set("error", { error: String(err?.message ?? err) });
        },
      )
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
    if (this.failed) return;
    if (this.draft !== null) {
      // Typed during the save: save again (now if no debounce is pending).
      if (!this.timer) return this.run();
      this.set("pending");
      return;
    }
    this.set("saved", { savedAt: Date.now() });
  }

  private set(state: SaveState, info: { error?: string; savedAt?: number } = {}) {
    this._state = state;
    this.opts.onState?.(state, info);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
