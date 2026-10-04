"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import type { GetAgentResponse } from "@eigen/engine/schema";
import type { FleetResponse, RootInfo } from "@/lib/types";
import { ApiError, keys, saveConfig, useAgent } from "@/lib/client/api";
import { awaitingReload, onAgentEvent } from "@/lib/client/events";
import { issuesByPath, validateDraft, type Validation } from "@/lib/client/validate";
import { sameDraft, setPath, stable, type Base, type Draft, type Obj } from "@/lib/client/draft";

/** Where a save is: the Inspector and the Builder both show this, in their own words. */
export type Phase =
  | { k: "idle" }
  | { k: "saving" }
  | { k: "waiting" }
  | { k: "reloaded" }
  | { k: "saved-offline" }
  | { k: "saved-prompt" }
  | { k: "saved-unconfirmed" }
  | { k: "rejected"; problems: string[] }
  | { k: "invalid"; issues: string[] }
  | { k: "conflict" }
  | { k: "error"; message: string };

const baseOf = (d: GetAgentResponse): Base => ({ config: (d.config ?? {}) as Obj, instructionsText: d.instructionsText ?? "", soulText: d.soulText ?? "", etag: d.etag });
const draftOf = (b: Base): Draft => ({ config: b.config, instructionsText: b.instructionsText, soulText: b.soulText });

/** Stale save outcomes clear on the next edit; a save that is still in flight, or a conflict being resolved, does not. */
const clearsOnConfigEdit = (p: Phase) => p.k === "invalid" || p.k === "reloaded" || p.k === "saved-offline" || p.k === "saved-prompt" || p.k === "saved-unconfirmed" || p.k === "error";
const clearsOnTextEdit = (p: Phase) => !(p.k === "idle" || p.k === "saving" || p.k === "waiting" || p.k === "conflict");

/**
 * One agent's staged edit: the draft (config + instructions + own soul), whether it is dirty, validation, the save state machine
 * (etag conflict, 400 issues, engine confirmation) and the file-changed-underneath-you flag.
 * Shared by the Inspector (forms) and the Builder (component nodes), so both save through the same path and behave the same.
 */
export function useAgentDraft({ id, root, engineOnline, quiet }: { id: string; root?: RootInfo; engineOnline: boolean; /** The caller shows the save outcome itself (the builder's apply bar), so no toast. */ quiet?: boolean }) {
  const { data, error, mutate: refetch } = useAgent(id);
  const { mutate } = useSWRConfig();
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phase, setPhaseState] = useState<Phase>({ k: "idle" });
  const [external, setExternal] = useState(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const phaseRef = useRef(phase);
  const nameRef = useRef<string>(id);
  const quietRef = useRef(!!quiet);
  useEffect(() => {
    quietRef.current = !!quiet;
  }, [quiet]);

  const setPhase = useCallback((next: Phase | ((p: Phase) => Phase)) => {
    const value = typeof next === "function" ? next(phaseRef.current) : next;
    phaseRef.current = value;
    setPhaseState(value);
  }, []);

  const dirty = !!(base && draft && !sameDraft(base, draft));

  // Adopt server data when we have no local edits; otherwise flag that the file moved underneath us.
  // (Adjusting state while rendering, keyed on the data object, instead of an effect.)
  const [seen, setSeen] = useState<GetAgentResponse | undefined>(undefined);
  if (data && data !== seen) {
    setSeen(data);
    if (!base) {
      const b = baseOf(data);
      setBase(b);
      setDraft(draftOf(b));
    } else if (data.etag === base.etag) {
      // Same file version: a prompt or soul edit made elsewhere still flows in, as long as this draft has not touched that text.
      const next: Partial<Draft> = {};
      if (data.instructionsText !== null && data.instructionsText !== base.instructionsText && draft?.instructionsText === base.instructionsText) next.instructionsText = data.instructionsText;
      if (data.soulText !== null && data.soulText !== base.soulText && draft?.soulText === base.soulText) next.soulText = data.soulText;
      if (Object.keys(next).length) {
        setBase({ ...base, ...next });
        setDraft((d) => d && { ...d, ...next });
      }
    } else if (phase.k !== "saving") {
      if (!dirty) {
        const b = baseOf(data);
        setBase(b);
        setDraft(draftOf(b));
        setExternal(false);
      } else setExternal(true);
    }
  }

  const name = typeof draft?.config.name === "string" && draft.config.name ? draft.config.name : id;
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // Settle the save when the engine reports back for this agent.
  useEffect(
    () =>
      onAgentEvent((ev) => {
        if (!("id" in ev) || ev.id !== id || phaseRef.current.k !== "waiting") return;
        // The studio's own listener skips agents in awaitingReload; whichever listener runs first, it must still see the mark, so it is cleared a tick later.
        const settle = () => {
          clearTimeout(waitTimer.current);
          setTimeout(() => awaitingReload.delete(id), 0);
        };
        if (ev.type === "agent.loaded") {
          settle();
          if (!quietRef.current) toast.success("Saved, engine reloaded", { description: `${nameRef.current} is running the new config.` });
          setPhase({ k: "reloaded" });
        } else if (ev.type === "agent.error") {
          settle();
          setPhase({ k: "rejected", problems: ev.problems });
        }
      }),
    [id, setPhase],
  );
  useEffect(
    () => () => {
      clearTimeout(waitTimer.current);
      awaitingReload.delete(id);
    },
    [id],
  );

  const validation: Validation | null = useMemo(() => (draft ? validateDraft(id, draft.config, root) : null), [draft, id, root]);
  const errors = useMemo(() => ({ ...issuesByPath(phase.k === "invalid" ? phase.issues : []), ...(validation?.byPath ?? {}) }), [phase, validation]);

  /** Replace the config through a function; used when one action touches several paths at once (the builder's connect and disconnect). */
  const update = useCallback(
    (fn: (d: Draft) => Draft) => {
      setDraft((d) => d && fn(d));
      setPhase((p) => (clearsOnConfigEdit(p) ? { k: "idle" } : p));
    },
    [setPhase],
  );
  const set = useCallback((path: string, value: unknown) => update((d) => ({ ...d, config: setPath(d.config, path, value) })), [update]);
  const setConfig = useCallback((config: Obj) => setDraft((d) => d && { ...d, config }), []);
  const setInstructions = useCallback(
    (text: string) => {
      setDraft((d) => d && { ...d, instructionsText: text });
      setPhase((p) => (clearsOnTextEdit(p) ? { k: "idle" } : p));
    },
    [setPhase],
  );
  const setSoul = useCallback(
    (text: string) => {
      setDraft((d) => d && { ...d, soulText: text });
      setPhase((p) => (clearsOnTextEdit(p) ? { k: "idle" } : p));
    },
    [setPhase],
  );

  /** Optimistic canvas update: the node shows the new name/model/state before the engine confirms. */
  const optimistic = useCallback(
    (cfg: Obj) => {
      void mutate(
        keys.fleet,
        (f?: FleetResponse) => {
          if (!f) return f;
          const patch = (a: FleetResponse["agents"][number]) =>
            a.id !== id
              ? a
              : {
                  ...a,
                  name: typeof cfg.name === "string" ? cfg.name : a.name,
                  role: typeof cfg.role === "string" ? cfg.role : a.role,
                  enabled: cfg.enabled !== false,
                  modelKey: typeof cfg.model === "string" ? cfg.model : (root?.defaultModel ?? a.modelKey),
                };
          return {
            ...f,
            agents: f.agents.map(patch),
            overrides: { ...f.overrides, [id]: [...(f.overrides[id] ?? []).filter((o) => o !== "model"), ...(cfg.model !== undefined ? ["model"] : [])] },
            topology: {
              ...f.topology,
              nodes: f.topology.nodes.map((n) => (n.type === "agent" && n.data.id === id ? { ...n, data: { ...n.data, ...patch(n.data) } } : n)),
            },
          };
        },
        { revalidate: false },
      );
    },
    [id, mutate, root?.defaultModel],
  );

  const save = useCallback(
    async (etagOverride?: string) => {
      if (!draft || !base) return;
      const configChanged = stable(base.config) !== stable(draft.config);
      const inline = typeof (draft.config.instructions as Obj | undefined)?.inline === "string";
      const promptChanged = draft.instructionsText !== base.instructionsText;
      const soulChanged = draft.soulText !== base.soulText;
      setPhase({ k: "saving" });
      setExternal(false);
      if (configChanged) optimistic(draft.config);
      if (configChanged && engineOnline) awaitingReload.add(id);
      let r;
      try {
        r = await saveConfig(id, {
          config: draft.config,
          etag: etagOverride ?? base.etag,
          ...(promptChanged && !inline ? { instructionsText: draft.instructionsText } : {}),
          ...(soulChanged ? { soulText: draft.soulText } : {}),
        });
      } catch (e) {
        awaitingReload.delete(id);
        setPhase({ k: "error", message: (e as Error).message });
        void mutate(keys.fleet);
        return;
      }
      if (r.body.ok) {
        setBase({ ...draft, etag: r.body.etag });
        void refetch();
        void mutate(keys.fleet);
        if (!configChanged) {
          setPhase({ k: "saved-prompt" });
          if (!quiet) toast.success(soulChanged && !promptChanged ? "Soul saved" : "Prompt saved", { description: "It applies from the agent's next message." });
        } else if (!engineOnline) {
          awaitingReload.delete(id);
          setPhase({ k: "saved-offline" });
          if (!quiet) toast("Saved to disk", { description: "The engine is offline; it loads this when it starts." });
        } else {
          setPhase({ k: "waiting" });
          clearTimeout(waitTimer.current);
          waitTimer.current = setTimeout(() => {
            awaitingReload.delete(id);
            setPhase((p) => (p.k === "waiting" ? { k: "saved-unconfirmed" } : p));
          }, 8000);
        }
        return;
      }
      awaitingReload.delete(id);
      void mutate(keys.fleet); // undo the optimistic patch
      if (r.status === 409) setPhase({ k: "conflict" });
      else if (r.status === 400) setPhase({ k: "invalid", issues: r.body.issues ?? ["the server rejected the config"] });
      else setPhase({ k: "error", message: r.body.issues?.[0] ?? `save failed (${r.status})` });
    },
    [draft, base, id, engineOnline, quiet, optimistic, refetch, mutate, setPhase],
  );

  const discard = useCallback(() => {
    if (!base) return;
    setDraft(draftOf(base));
    setPhase({ k: "idle" });
  }, [base, setPhase]);

  const reloadTheirs = useCallback(async () => {
    const theirs = await refetch();
    if (!theirs) return;
    const b = baseOf(theirs);
    setBase(b);
    setDraft(draftOf(b));
    setExternal(false);
    setPhase({ k: "idle" });
  }, [refetch, setPhase]);

  return {
    data,
    error,
    notFound: error instanceof ApiError && error.status === 404,
    refetch,
    base,
    draft,
    dirty,
    phase,
    setPhase,
    external,
    validation,
    errors,
    set,
    update,
    setConfig,
    setInstructions,
    setSoul,
    save,
    discard,
    reloadTheirs,
    /** The agent's own soul file exists on disk. */
    hasSoulFile: data ? data.soulText !== null : false,
  };
}

export type AgentDraft = ReturnType<typeof useAgentDraft>;
