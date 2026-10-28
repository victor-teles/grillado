// v1.3 item 1 §5 (#144): an imported plan's meta line says where it came from, and offers Update
// when the source changed. No banner, no blue.
import { useState } from "react";
import { sourceWithArticle } from "../../../../src/core/activity.ts";
import { api } from "../api";
import type { SessionView } from "../types";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function Provenance({ session, head, edited }: { session: SessionView; head: string; edited: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const src = session.source!;
  const info = session.sourceInfo;
  const update = async () => {
    if (!info || state === "busy") return;
    setState("busy");
    try {
      await api.foundImport(info.row);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  const meta = (
    <p className="sub fp" data-testid="plan-meta">
      {head.split(" · ").map((x, i) => (
        <span key={i}>{x}</span>
      ))}
      <span>
        Imported from {sourceWithArticle(src.app, src.kind)}, {day(info?.date ?? src.importedAt)}
      </span>
      {edited ? <span>edited</span> : null}
      {info?.state === "gone" ? <span>Source no longer on disk</span> : info?.state === "changed" ? null : src.compacted ? <span>Part of the session was compacted</span> : null}
      {info?.state === "changed" ? (
        <>
          <span>
            <span className="fp-ch">{state === "failed" ? "Couldn’t update" : "Source changed"}</span>
          </span>
          <span>
            <button type="button" className="fp-up" aria-disabled={state === "busy" || undefined} onClick={() => void update()}>
              {state === "busy" ? "Updating…" : state === "failed" ? "Try again" : "Update"}
            </button>
          </span>
        </>
      ) : null}
    </p>
  );
  // The agent it runs on, when the import's own isn't installed (demo finding MUST 2): its own quiet line, never a wrapped part of the meta.
  return session.agentNote ? (
    <>
      {meta}
      <p className="sub fp-agent" data-testid="agent-note">
        {session.agentNote}
      </p>
    </>
  ) : (
    meta
  );
}
