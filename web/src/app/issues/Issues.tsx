// "Send to issues" on the plan page (v1.3 item 2 §1, §8): the ⋯ menu item, the strip under the
// title, the chips on decision cards, and the sheet. The plan check (§8) only reads: it previews the
// linked destination when the page opens, after a run, and when the plan changes.
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type Preview, issuesApi } from "../api";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { IDot, IIssues } from "../icons";
import type { SessionView } from "../types";
import { ICOPY, TNAME, plural } from "./copy";
import { IssuesSheet } from "./IssuesSheet";

const PARENT = "plan";

export function useIssues(p: {
  session: SessionView;
  agentName: string;
  phone: boolean;
  /** Not plated, or decisions still open: the item reads "Finish the plan first". */
  draft: boolean;
  idOf: (key: string) => string;
  /** The decision's short title: what chips and labels show (the R·n code stays in title attributes). */
  nameOf: (key: string) => string;
  /** The ⋯ trigger: focus goes back there when the sheet closes. */
  moreRef: RefObject<HTMLElement | null>;
}) {
  const s = p.session;
  const linked = s.issues ?? null;
  const run = s.issuesRun;
  const running = run?.state === "running";
  const [open, setOpen] = useState(false);
  const next = useRef(false);

  // §8: what changed since the export, checked against the tracker (reads only).
  const [check, setCheck] = useState<Preview | null>(null);
  const markdown = s.plan?.markdown ?? "";
  useEffect(() => {
    if (!linked || p.draft || running) return;
    let off = false;
    const t = setTimeout(
      () => {
        const body =
          linked.tracker === "github"
            ? { tracker: linked.tracker, repo: linked.target, host: linked.host ?? "github.com", labels: linked.labels }
            : { tracker: linked.tracker, team: linked.target, teamName: linked.targetName, project: linked.projectId, labels: linked.labels };
        void issuesApi
          .preview(s.id, body)
          .then((x) => !off && setCheck(x))
          .catch(() => !off && setCheck(null));
      },
      check ? 1500 : 0,
    );
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [s.id, linked?.exportedAt, JSON.stringify(linked?.failed ?? {}), markdown, p.draft, running]);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    p.moreRef.current?.focus({ preventScroll: true });
    setOpen(false);
  }, [p.moreRef]);

  const ref = (l?: { number?: number; identifier?: string }) => (l ? (l.identifier ?? `#${l.number}`) : "");
  const T = linked ? TNAME[linked.tracker] : "";
  const where = linked ? (linked.tracker === "github" ? linked.target : `Team ${linked.targetName ?? linked.target}`) : "";
  const done = run ? run.rows.filter((r) => !["waiting", "creating", "updating"].includes(r.status)).length : 0;

  // ---------------------------------------------------------------- menu item
  const menuItem = (
    <DropdownMenuItem
      className={`imi${p.draft ? " dis" : ""}`}
      aria-disabled={p.draft || undefined}
      data-testid="menu-issues"
      onSelect={(e) => {
        if (p.draft) {
          e.preventDefault();
          return;
        }
        next.current = true;
      }}
    >
      <IIssues s={16} />
      <span className="imi-m">
        <span>{linked ? ICOPY.menuUpdate : ICOPY.menuCreate}</span>
        {p.draft ? (
          <span className="imi-h">{ICOPY.menuDraft}</span>
        ) : running ? (
          <span className="imi-h">
            Creating issues · {done} of {run.rows.length}
          </span>
        ) : linked?.parent ? (
          <span className="imi-h">
            {ref(linked.parent)} · {where}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
  /** Plan's ⋯ onCloseAutoFocus: the sheet takes focus instead of the trigger. */
  const onMenuClosed = (e: Event) => {
    if (!next.current) return false;
    next.current = false;
    e.preventDefault();
    show();
    return true;
  };

  // ---------------------------------------------------------------- strip (§8)
  const changes = check?.changes ?? [];
  const parentGone = changes.find((c) => c.key === PARENT)?.change === "missing";
  const changed = changes.filter((c) => c.change === "update" || c.change === "edited" || c.change === "new" || c.change === "missing").length;
  const failed = Object.keys(linked?.failed ?? {});
  const kids = Object.keys(linked?.items ?? {}).filter((k) => k !== PARENT).length;
  const sg = (n: ReactNode, k: string) => (
    <span className="sg" key={k}>
      <span className="dt" aria-hidden="true">
        ·
      </span>
      {n}
    </span>
  );
  const link = (gone = false) =>
    linked?.parent ? (
      gone ? (
        <span className="ilnk gone">
          <IDot s={12} />
          {ref(linked.parent)}
        </span>
      ) : (
        <a className="ilnk" href={linked.parent.url} target="_blank" rel="noreferrer" aria-label={`Parent issue ${ref(linked.parent)}, opens in a new tab`}>
          <IDot s={12} />
          {ref(linked.parent)}
        </a>
      )
    ) : null;
  let strip: ReactNode = null;
  if (running && run)
    strip = (
      <div className="istrip" role="group" aria-label="Issues" data-testid="issues-strip">
        <span className="ilab">Issues</span>
        <span>
          Creating issues · {done} of {run.rows.length}
        </span>
        {sg(
          <button type="button" className="lnk2" onClick={show}>
            Show
          </button>,
          "s",
        )}
      </div>
    );
  else if (linked?.parent && !p.draft) {
    const parts: ReactNode[] = [];
    if (parentGone) {
      parts.push(<span key="m" className="bad">Missing in {T}</span>);
      parts.push(
        sg(
          <button type="button" className="lnk2" onClick={show}>
            Recreate
          </button>,
          "r",
        ),
      );
    } else if (failed.length) {
      parts.push(sg(`${kids} of ${plural(kids + failed.filter((k) => !linked.items[k]).length, "sub-issue")}`, "n"));
      parts.push(sg(<span className="bad">{failed.length} failed</span>, "f"));
      parts.push(
        sg(
          <button type="button" className="lnk2" onClick={show}>
            Retry failed
          </button>,
          "r",
        ),
      );
    } else if (changed) {
      parts.push(sg(`${changed} changed since export`, "c"));
      parts.push(
        sg(
          <button type="button" className="lnk2" onClick={show}>
            Update issues
          </button>,
          "u",
        ),
      );
    } else {
      parts.push(sg(plural(kids, "sub-issue"), "n"));
      parts.push(sg(where, "w"));
    }
    strip = (
      <div className="istrip" role="group" aria-label="Issues" data-testid="issues-strip">
        <span className="ilab">Issues</span>
        {link(parentGone)}
        {parts}
      </div>
    );
  }

  // ---------------------------------------------------------------- chips (§8)
  const gone = new Set(changes.filter((c) => c.change === "missing").map((c) => c.key));
  const chipsFor = (decision: string): ReactNode => {
    if (!linked || p.draft) return null;
    const hits = (check?.items ?? []).filter((it) => it.key !== PARENT && it.covers.includes(decision) && linked.items[it.key]);
    if (!hits.length) return null;
    const name = p.nameOf(decision) || decision;
    const shown = hits.slice(0, 2);
    return (
      <span className="ilks" data-testid={`issue-chips-${decision}`}>
        {shown.map((it) => {
          const l = linked.items[it.key];
          return gone.has(it.key) ? (
            <button key={it.key} type="button" className="ilk gone" onClick={show} title={`${ref(l)} was deleted in ${T}`}>
              <IDot s={12} />
              {ref(l)} missing · Recreate
            </button>
          ) : (
            <a key={it.key} className="ilk" href={l.url} target="_blank" rel="noreferrer" aria-label={`${name} is covered by issue ${ref(l)}`}>
              <IDot s={12} />
              {ref(l)}
            </a>
          );
        })}
        {hits.length > 2 ? <span className="ilk more">+{hits.length - 2}</span> : null}
      </span>
    );
  };

  const sheet = open ? <IssuesSheet session={s} agentName={p.agentName} phone={p.phone} idOf={p.idOf} nameOf={p.nameOf} onClose={close} /> : null;
  return { menuItem, strip, chipsFor, sheet, onMenuClosed, open: show };
}
