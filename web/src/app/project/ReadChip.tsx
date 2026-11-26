// Plan 002: the composer's "Reads {project}" chip. It names what the agent may do before Start,
// and its checkbox turns reading off for this project. Outside a readable project it isn't shown.
import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { Popover } from "radix-ui";
import { COPY, fmt } from "../copy";
import { IDown, IFolder } from "../icons";
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

export function ReadChip({ project, provider, onChange }: { project: ProjectView | null | undefined; provider?: ProviderView; onChange: (on: boolean) => void }) {
  const titleId = useId();
  if (!project?.readable || !provider) return null;
  const can = !!provider.canRead;
  const on = readsNow(project, provider);
  const agent = provider.displayName;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="readchip" data-on={on || undefined} data-testid="read-chip" title={project.root}>
          <IFolder s={14} />
          <span className="nm">{on ? fmt(COPY.readOn, { project: project.name }) : COPY.readOff}</span>
          <IDown s={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="readpop" side="top" align="start" sideOffset={8} collisionPadding={16} aria-labelledby={titleId} data-testid="read-pop">
          <p className="t" id={titleId}>
            {COPY.readTitle}
          </p>
          <p>{can ? fmt(COPY.readBody, { agent, root: project.root }) : fmt(COPY.readCantAgent, { agent })}</p>
          {can ? (
            <label className="check">
              <input
                type="checkbox"
                checked={project.on}
                onChange={(e) => onChange(e.target.checked)}
              />
              {COPY.readCheck}
            </label>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
