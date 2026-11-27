// Plan 003: while a reading agent works, the wait shows what it opens, how many files so far, and a
// way out (Skip reading asks the same thing again without reading, this once). Sessions that don't
// read get the plain status line, unchanged.
import { useEffect, useRef, useState } from "react";
import { useSince } from "../chrome";
import { COPY, fmt } from "../copy";
import { StatusLine } from "../Round";
import type { SessionView } from "../types";

/** Seconds before Skip reading is offered, and of quiet before the usual labels take over. */
export const SKIP_AFTER = 10;
const QUIET = 20;
/** The screen-reader summary is said at most this often. */
const ANNOUNCE_EVERY_MS = 10_000;

export const projectName = (s: SessionView) => s.readRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? "your project";

const countText = (n: number) => (n === 1 ? COPY.readingCountOne : fmt(COPY.readingCount, { n }));

/** The status line of a wait screen; for a reading session, with its trail and Skip reading. */
export function WaitStatus({
  session,
  label,
  note,
  dot,
  elapsed,
  onStop,
  onSkip,
}: {
  session: SessionView;
  label: string;
  note: string;
  dot?: boolean;
  elapsed: number;
  onStop?: () => void;
  onSkip: () => void;
}) {
  const reading = session.codeRead ? session.reading : undefined;
  const quietFor = useSince(reading?.at, !!reading);
  const announced = useAnnounced(reading?.files ?? 0);
  if (!session.codeRead) return <StatusLine dot={dot} label={label} note={note} onStop={onStop} />;
  // "Reading …" until it has gone quiet for a while (it's writing the reply), then the usual labels.
  const stillReading = !reading || quietFor < QUIET;
  const skip =
    elapsed >= SKIP_AFTER ? (
      <button type="button" className="btn quiet sm" data-testid="skip-reading" onClick={onSkip}>
        {COPY.skipReading}
      </button>
    ) : null;
  return (
    <div className="reads">
      <StatusLine dot={dot} label={stillReading ? fmt(COPY.readingProject, { project: projectName(session) }) : label} onStop={onStop} actions={skip} />
      {reading?.recent.length ? (
        <ul className="trail" data-testid="reading-trail">
          {reading.recent.map((line, i) => (
            // Keyed by position from the end, so the newest line is the one that mounts (and fades in).
            <li key={`${reading.recent.length - i}:${line}`} title={line}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="meta wait-note" data-testid="wait-note">
        {reading?.files ? `${countText(reading.files)} · ${COPY.readingNote}` : COPY.readingNote}
      </p>
      <span className="sr-only" aria-live="polite">
        {announced ? countText(announced) : ""}
      </span>
    </div>
  );
}

/** The file count for screen readers, updated at most every ten seconds. */
function useAnnounced(files: number) {
  const [said, setSaid] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    if (!files || files === said) return;
    const wait = Math.max(0, last.current + ANNOUNCE_EVERY_MS - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      setSaid(files);
    }, wait);
    return () => clearTimeout(t);
  }, [files, said]);
  return said;
}
