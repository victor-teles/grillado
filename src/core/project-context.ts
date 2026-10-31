export interface ProjectContextSource {
  /** POSIX path relative to the project root. */
  path: string;
  text: string;
  truncated: boolean;
}

export interface ProjectContext {
  capturedAt: string;
  sources: ProjectContextSource[];
  /** Some eligible text or files did not fit in the snapshot limits. */
  truncated: boolean;
}

export interface ProjectContextView {
  capturedAt: string;
  sources: Pick<ProjectContextSource, "path" | "truncated">[];
  truncated: boolean;
}

/** Public provenance never includes the historical plan text sent to the agent. */
export function projectContextView(context: ProjectContext | undefined): ProjectContextView | undefined {
  if (!context) return undefined;
  return {
    capturedAt: context.capturedAt,
    sources: context.sources.map(({ path, truncated }) => ({ path, truncated })),
    truncated: context.truncated,
  };
}
