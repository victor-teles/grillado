// Plans 002 and 005: the composer's project chip. It names the project before Start ("Reads {project}"
// when the agent will read it); its popover switches projects, sets the plans folder, and turns reading off.
import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { Popover } from "radix-ui";
import { COPY, fmt } from "../copy";
import { ICheck, IDown, IFolder } from "../icons";
import type { ProjectView, ProviderView } from "../types";

/** Whether a session started now would read: the project allows it, it's on, and the agent can. */
export function readsNow(project: ProjectView | null | undefined, provider: ProviderView | undefined): boolean {
  return !!project?.readable && project.on && !!provider?.canRead;
}

/**
 * The project as the composer shows it: a click on the checkbox counts at once (what Start sends),
 * and the saved value takes over when the app state comes back with it. A failed save reverts.
 */
export function useProjectRead(saved: ProjectView | null | undefined) {
  const [want, setWant] = useState<boolean | null>(null);
  const savedOn = saved?.readable ? saved.on : null;
  useEffect(() => {
    if (want !== null && want === savedOn) setWant(null);
  }, [want, savedOn]);
  const project = saved?.readable && want !== null ? { ...saved, on: want } : saved;
  const set = (on: boolean) => {
    setWant(on);
    api.setProjectRead(on).catch(() => setWant(null));
  };
  return [project, set] as const;
}

/** A text field with its button, for the popover: Enter applies it (the popover sits inside the composer's React tree). */
function Field({ id, label, hint, value, placeholder, button, onApply, testId }: { id: string; label: string; hint?: string; value: string; placeholder?: string; button: string; onApply: (v: string) => Promise<void>; testId: string }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(value), [value]);
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onApply(text.trim());
      if (!value) setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pfield">
      <label htmlFor={id}>{label}</label>
      <span className="in">
        <input
          id={id}
          data-testid={testId}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={500}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void apply();
            }
          }}
        />
        <button type="button" className="btn soft sm" disabled={busy} onClick={() => void apply()}>
          {button}
        </button>
      </span>
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Plan 005: the composer's project chip. It names the project new plans start in and, when the agent
 * will read it, says so (plan 002). Its popover switches projects, sets where plans are saved, and
 * turns reading off for the project.
 */
export function ProjectChip({ project, provider, onChange }: { project: ProjectView | null | undefined; provider?: ProviderView; onChange: (on: boolean) => void }) {
  const titleId = useId();
  const otherId = useId();
  const plansId = useId();
  const [error, setError] = useState("");
  if (!project) return null;
  const can = !!provider?.canRead;
  const on = readsNow(project, provider);
  const agent = provider?.displayName ?? "The agent";
  const pick = async (folder: string) => {
    setError("");
    try {
      await api.setProject({ folder });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Popover.Root onOpenChange={() => setError("")}>
      <Popover.Trigger asChild>
        <button type="button" className="readchip" data-on={on || undefined} data-testid="read-chip" title={project.folder}>
          <IFolder s={14} />
          <span className="nm">{on ? fmt(COPY.readOn, { project: project.name }) : project.name}</span>
          <IDown s={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="readpop" side="top" align="start" sideOffset={8} collisionPadding={16} aria-labelledby={titleId} data-testid="read-pop">
          <section className="psec" aria-labelledby={titleId}>
            <p className="t" id={titleId}>
              {COPY.projectTitle}
            </p>
            {project.known.length > 1 ? (
              <ul className="plist" data-testid="project-list">
                {project.known.map((k) => {
                  const here = k.folder === project.folder;
                  return (
                    <li key={k.folder}>
                      <button type="button" className="prow" aria-current={here || undefined} onClick={() => (here ? undefined : void pick(k.folder))} title={k.folder}>
                        <span className="ck">{here ? <ICheck s={14} /> : null}</span>
                        <span className="nm">{k.name}</span>
                        <span className="at">{k.folder}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="at1" title={project.folder}>
                {project.folder}
              </p>
            )}
            {error ? (
              <span className="err" role="alert">
                {error}
              </span>
            ) : null}
            <Field id={otherId} testId="project-other" label={COPY.projectOther} value="" placeholder={COPY.projectOtherHint} button={COPY.projectUse} onApply={(v) => api.setProject({ folder: v }).then(() => undefined)} />
          </section>
          <section className="psec">
            <Field
              id={plansId}
              testId="plans-dir"
              label={COPY.plansTitle}
              value={project.plansDir}
              placeholder="docs/plans"
              hint={fmt(COPY.plansHint, { path: project.plansAt })}
              button={COPY.plansSave}
              onApply={(v) => api.setProject({ plansDir: v }).then(() => undefined)}
            />
          </section>
          <section className="psec">
            <p className="t">{COPY.readTitle}</p>
            {!project.readable ? (
              <p>{fmt(COPY.readCantFolder[project.reason] ?? COPY.readCantFolder["no-project"], { agent })}</p>
            ) : can ? (
              <>
                <p>{fmt(COPY.readBody, { agent, root: project.root })}</p>
                <label className="check">
                  <input type="checkbox" checked={project.on} onChange={(e) => onChange(e.target.checked)} />
                  {COPY.readCheck}
                </label>
              </>
            ) : (
              <p>{fmt(COPY.readCantAgent, { agent })}</p>
            )}
          </section>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
