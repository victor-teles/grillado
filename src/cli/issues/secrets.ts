// ~/.grillado/secrets.json (mode 0600): the Linear API key, the only secret Grillado keeps (v1.3
// item 2). It never leaves the server except in the Authorization header to api.linear.app; the
// browser only ever sees the name and the last four characters.
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeAtomic } from "../store.ts";

export interface Secrets {
  linear?: { key: string; name: string; connectedAt: string };
}

const file = (dir: string) => path.join(dir, "secrets.json");

export function readSecrets(dir: string): Secrets {
  try {
    return JSON.parse(readFileSync(file(dir), "utf8"));
  } catch {
    return {};
  }
}

export function writeSecrets(dir: string, s: Secrets) {
  if (!Object.keys(s).length) {
    try {
      unlinkSync(file(dir));
    } catch {}
    return;
  }
  writeAtomic(file(dir), `${JSON.stringify(s, null, 2)}\n`);
  // writeAtomic creates it 0600; an older file someone loosened is tightened again.
  chmodSync(file(dir), 0o600);
}

/** What the browser may know about the saved key. */
export function linearView(dir: string): { connected: false } | { connected: true; name: string; last4: string } {
  const l = readSecrets(dir).linear;
  return l ? { connected: true, name: l.name, last4: l.key.slice(-4) } : { connected: false };
}
