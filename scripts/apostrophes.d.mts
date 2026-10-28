// Types for scripts/apostrophes.mjs, so its test can import it.
export function straightApostrophes(o?: { fix?: boolean }): string[];
export function straightIn(text: string, afterValue?: boolean): boolean;
export function curly(text: string, afterValue?: boolean): string;
export function scan(files: [string, boolean][], o?: { fix?: boolean; rel?: (f: string) => string; hits?: string[] }): string[];
export function webShown(): Set<string>;
export function offscreenTags(): string[];
