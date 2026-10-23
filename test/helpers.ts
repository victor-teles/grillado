import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { which } from "../src/core/providers/resolve.ts";
import type { ProviderId } from "../src/core/providers/types.ts";

export const FAKE_AGENT = path.join(import.meta.dir, "fixtures", "fake-agent.mjs");
export const NODE = process.env.NODE_BIN ?? which("node") ?? "node";

/** A temp dir with fake `claude`/`codex`/`grok`/`pi` executables that run the fake agent under Node. */
export function fakeBinDir(ids: ProviderId[] = ["claude", "codex", "grok", "pi"]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-fakebin-"));
  for (const id of ids) {
    const file = path.join(dir, id);
    writeFileSync(file, `#!/bin/sh\nexec "${NODE}" "${FAKE_AGENT}" ${id} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

export function fakeEnv(binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "grillado-fakestate-"));
  return { PATH: `${binDir}:/usr/bin:/bin`, FAKE_STATE_DIR: stateDir, HOME: stateDir, ...extra };
}
