// v1.3 item 1 (PO, #21): a just-imported plan moves from Found to Recent with no reload. While its
// row holds "✓ Imported" (1.5 s), Recent holds the plan back; when the row leaves, the plan's row is
// added to Recent (and gets focus if the Found row had it). Kept here so the Found block stays one
// component with one mount point: Home only wires these props through.
import { useCallback, useMemo, useState } from "react";
import type { SessionSummary } from "../types";
import type { FoundHandoff } from "./Found";

export function useFoundHandoff(sessions: SessionSummary[]) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [enter, setEnter] = useState<{ id: string; focus: boolean } | null>(null);
  const onImported = useCallback((id: string) => setPending((p) => new Set(p).add(id)), []);
  const onSettled = useCallback<NonNullable<FoundHandoff["onSettled"]>>((id, o) => {
    setPending((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
    if (!o.update) setEnter({ id, focus: o.focus });
  }, []);
  const shown = useMemo(() => (pending.size ? sessions.filter((s) => !pending.has(s.id)) : sessions), [sessions, pending]);
  const entered = useCallback(() => setEnter(null), []);
  return { found: { onImported, onSettled } satisfies FoundHandoff, sessions: shown, enter, entered };
}
