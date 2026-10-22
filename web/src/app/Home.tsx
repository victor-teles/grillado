import { ArrowUp, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateAction,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateHeader,
  EmptyStateTitle,
} from "@/components/ui/uai/empty-state";
import { CopyButton } from "./CopyButton";
import type { AppState, ProviderId, SessionSummary } from "./types";

export function NoAgent({ state, onRescan }: { state: AppState; onRescan: () => Promise<void> }) {
  const [scanning, setScanning] = useState(false);
  return (
    <EmptyState variant="card" className="items-stretch text-left">
      <EmptyStateContent>
        <EmptyStateHeader>
          <EmptyStateTitle>No coding agent found</EmptyStateTitle>
          <EmptyStateDescription>
            Grillado runs on the coding agent you already use. Install one of these, log in once, then scan again.
          </EmptyStateDescription>
        </EmptyStateHeader>
        <ul className="grid gap-2" aria-label="Install commands">
          {state.providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <span className="w-28 font-medium">{p.displayName}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{p.installHint}</code>
              {p.status === "broken" || p.status === "outdated" ? (
                <span className="w-full text-[12px] text-subtle-foreground">Found, but not working: {p.reason}</span>
              ) : null}
              <CopyButton text={p.installHint} label={`Copy ${p.displayName} install command`} />
            </li>
          ))}
        </ul>
        <EmptyStateActions>
          <EmptyStateAction
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              try {
                await onRescan();
              } finally {
                setScanning(false);
              }
            }}
          >
            <RefreshCw aria-hidden="true" className={scanning ? "motion-safe:animate-spin" : ""} />
            {scanning ? "Scanning…" : "Scan again"}
          </EmptyStateAction>
        </EmptyStateActions>
      </EmptyStateContent>
    </EmptyState>
  );
}

export function Picker({ state, onPick }: { state: AppState; onPick: (id: ProviderId, remember: boolean) => void }) {
  const [remember, setRemember] = useState(false);
  const ready = state.providers.filter((p) => p.status === "ready");
  return (
    <section aria-labelledby="picker-title" className="grid gap-4">
      <div>
        <h2 id="picker-title" className="text-xl font-semibold">
          Choose your agent
        </h2>
        <p className="text-muted-foreground">Each one uses your existing login. You can switch later.</p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ready.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPick(p.id, remember)}
              className="flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-muted font-semibold">
                {p.displayName[0]}
              </span>
              <span className="grid">
                <span className="font-medium">{p.displayName}</span>
                <span className="text-[12px] text-subtle-foreground">{p.version} · uses your existing login</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
        <Label htmlFor="remember">Remember my choice</Label>
      </div>
    </section>
  );
}

const EXAMPLES = ["A habit tracker that nudges me by text", "A CLI that turns meeting notes into tickets", "A recipe app for what's already in my fridge"];

export function Composer({ onStart }: { onStart: (idea: string, context: string) => Promise<void> }) {
  const [idea, setIdea] = useState("");
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!idea.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await onStart(idea, context);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start.");
      setSending(false);
    }
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor="idea" className="text-2xl font-semibold">
        What are we cooking?
      </Label>
      <p className="text-muted-foreground">Drop in a raw idea. I'll ask a few rounds of questions, then plate a plan you can hand to your agent.</p>
      <div className="relative">
        <Textarea
          id="idea"
          value={idea}
          rows={3}
          placeholder={EXAMPLES[0]}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="min-h-24 resize-y pr-14 text-[15px]"
        />
        <Button type="submit" size="icon" aria-label="Start" disabled={!idea.trim() || sending} className="absolute right-2 bottom-2 rounded-full">
          <ArrowUp aria-hidden="true" />
        </Button>
      </div>
      {showContext ? (
        <div className="grid gap-1.5">
          <Label htmlFor="context">Context (optional)</Label>
          <Textarea id="context" rows={4} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Paste notes, constraints, an existing README…" />
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => setShowContext(true)}>
          Add context
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-destructive-ink text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

const STATUS_LABEL: Record<SessionSummary["status"], string> = {
  asking: "On the grill",
  answering: "On the grill",
  confirm: "Ready to confirm",
  synthesizing: "Plating",
  plated: "Plated",
};

export function RecentSessions({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  if (!sessions.length) return <p className="text-subtle-foreground text-sm">No sessions yet. Your first plan will show up here.</p>;
  return (
    <section aria-labelledby="recent-title" className="grid gap-2">
      <h2 id="recent-title" className="text-sm font-medium text-muted-foreground">
        Recent sessions
      </h2>
      <ul className="grid gap-1.5">
        {sessions.map((s) => (
          <li key={s.id}>
            <a
              href={`/s/${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(s.id);
              }}
              className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="truncate">{s.idea}</span>
              <span className="shrink-0 text-[12px] text-subtle-foreground">
                {STATUS_LABEL[s.status]} · {s.decisions} decided
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
