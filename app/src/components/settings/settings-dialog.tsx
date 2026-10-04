"use client";
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, Cpu, LoaderCircle, Plug, RefreshCw, Send, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Form, setPath, type FormCtx } from "@/components/inspector/fields";
import { Button, Modal, Skeleton, spring } from "@/components/ui";
import { cn } from "@/lib/cn";
import { keys, useFleet } from "@/lib/client/api";
import { lineDiff } from "@/lib/client/diff";
import { refreshSecrets } from "@/lib/client/secrets";
import { loadRoot, saveRoot, type RootPayload } from "./api";
import { AdvancedSection } from "./advanced-section";
import { Callout, Root, type Obj } from "./controls";
import { MemorySection } from "./memory-section";
import { ModelsSection } from "./models-section";
import { SandboxSection } from "./sandbox-section";
import { TelegramSection } from "./telegram-section";
import { ToolsSection } from "./tools-section";
import { canon, issuesToProblems, sectionOfPath, validateRoot, type Problems } from "./validate";

export type SettingsSection = "models" | "telegram" | "memory" | "sandbox" | "tools" | "advanced";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: ComponentType<{ size?: number; className?: string }> }> = [
  { id: "models", label: "Models", icon: Cpu },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "sandbox", label: "Sandbox", icon: ShieldCheck },
  { id: "tools", label: "Tools", icon: Plug },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

/** Editor for the shared root ~/.eigen/config.json: models, Telegram, memory defaults, sandbox policy and the MCP catalog. */
export function SettingsDialog({ open, onClose, section }: { open: boolean; onClose: () => void; section?: SettingsSection }) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" description="Shared config for every agent." className="w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden" initialFocus='nav[aria-label="Settings sections"] button[aria-current="page"]'>
      <SettingsBody initial={section ?? "models"} onClose={onClose} />
    </Modal>
  );
}

type Loaded = { base: { config: Obj; etag: string }; defaults: RootPayload["defaults"] };
type Phase = { k: "idle" } | { k: "saving" } | { k: "conflict" };

/** Required top-level objects: setPath prunes emptied ones, but the schema has no default for these. */
const keepRequired = (o: Obj): Obj => (o.telegram && typeof o.telegram === "object" ? o : { ...o, telegram: {} });

function SettingsBody({ initial, onClose }: { initial: SettingsSection; onClose: () => void }) {
  const { mutate } = useSWRConfig();
  const fleet = useFleet();
  const [state, setState] = useState<{ k: "loading" } | { k: "error"; message: string } | { k: "ready" }>({ k: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Obj>({});
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [section, setSection] = useState<SettingsSection>(initial);
  const [rev, setRev] = useState(0);

  /** Reads the file; the answer carries either the payload or why it cannot be edited. Sets no state, so effects can call it. */
  const load = useCallback(async (): Promise<{ ok: true; r: RootPayload } | { ok: false; message: string }> => {
    try {
      const r = await loadRoot();
      if (r.parseError) return { ok: false, message: `config.json is not valid JSON (${r.parseError}). Fix it by hand in ~/.eigen/config.json; saving from here would overwrite it.` };
      return { ok: true, r };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, []);

  const adopt = useCallback((r: RootPayload) => {
    setLoaded({ base: { config: r.config, etag: r.etag }, defaults: r.defaults });
    setDraft(r.config);
    setServerIssues([]);
    setPhase({ k: "idle" });
    setRev((n) => n + 1);
    setState({ k: "ready" });
  }, []);

  const apply = useCallback((res: Awaited<ReturnType<typeof load>>) => (res.ok ? adopt(res.r) : setState({ k: "error", message: res.message })), [adopt]);

  useEffect(() => {
    let live = true;
    void load().then((res) => live && apply(res));
    return () => {
      live = false;
    };
  }, [load, apply]);

  const dirty = loaded ? canon(draft) !== canon(loaded.base.config) : false;
  const clientProblems = useMemo<Problems>(() => (loaded ? validateRoot(draft, loaded.defaults, loaded.base.config) : {}), [draft, loaded]);
  const server = useMemo(() => issuesToProblems(serverIssues), [serverIssues]);
  const errors = useMemo(() => ({ ...clientProblems, ...server.byPath }), [clientProblems, server]);
  const problemCount = Object.keys(clientProblems).length + serverIssues.length;
  const badSections = useMemo(() => new Set(Object.keys(errors).map(sectionOfPath).filter(Boolean)), [errors]);

  const set = useCallback((path: string, value: unknown) => {
    setDraft((d) => keepRequired(setPath(d, path, value)));
    setServerIssues([]);
  }, []);
  const form: FormCtx = { config: draft, set, errors };

  const save = async (etagOverride?: string) => {
    if (!loaded) return;
    setPhase({ k: "saving" });
    setServerIssues([]);
    const r = await saveRoot(draft, etagOverride ?? loaded.base.etag);
    if (r.status === 200 && r.body.ok) {
      setLoaded({ ...loaded, base: { config: draft, etag: r.body.etag } });
      setPhase({ k: "idle" });
      void mutate(keys.root);
      void mutate(keys.fleet);
      void refreshSecrets();
      if (fleet.data?.engine === "offline") toast("Saved to disk", { description: "The engine is offline; it picks this up when it starts." });
      else toast.success("Settings saved", { description: "Agents this affects reload on their own." });
    } else if (r.status === 409) {
      setPhase({ k: "conflict" });
    } else {
      setPhase({ k: "idle" });
      const issues = !r.body.ok ? (r.body.issues ?? []) : [];
      setServerIssues(issues.length ? issues : [`could not save (${r.status})`]);
      const first = Object.keys(issuesToProblems(issues).byPath).map(sectionOfPath).find(Boolean);
      if (first && first !== section) setSection(first);
      // Bring the offending card into view; the field errors are inside it.
      setTimeout(() => document.querySelector('[data-problem="true"]')?.scrollIntoView({ block: "center", behavior: "smooth" }), 120);
    }
  };

  const revert = () => {
    if (!loaded) return;
    setDraft(loaded.base.config);
    setServerIssues([]);
    setRev((n) => n + 1);
  };

  const jumpToProblem = () => {
    const first = Object.keys(errors).map(sectionOfPath).find(Boolean);
    if (first) setSection(first);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !problemCount && phase.k === "idle") void save();
    }
  };

  const canSave = dirty && Object.keys(clientProblems).length === 0 && phase.k === "idle";

  return (
    <div className="flex h-[min(82vh,780px)] flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-ink">Settings</h2>
          <p className="truncate text-[12.5px] text-ink-3">Shared by every agent. Saved to ~/.eigen/config.json.</p>
        </div>
        <Button variant="quiet" onClick={onClose} aria-label="Close settings" className="px-2">
          <X size={16} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
          {SECTIONS.map((s) => {
            const on = s.id === section;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => setSection(s.id)}
                className={cn("relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13.5px] transition-colors focus-visible:outline-2 focus-visible:outline-accent", on ? "text-ink" : "text-ink-2 hover:bg-raised hover:text-ink")}
              >
                {on && <motion.span layoutId="settings-nav" transition={spring} className="absolute inset-0 rounded-lg border border-line bg-raised" />}
                <Icon size={15} className="relative shrink-0" />
                <span className="relative">{s.label}</span>
                {badSections.has(s.id) && <span className="relative ml-auto size-1.5 rounded-full bg-bad" aria-label="has problems" />}
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.k === "loading" && (
            <div className="space-y-4 p-5" aria-busy="true" aria-label="Loading settings">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {state.k === "error" && (
            <div className="space-y-3 p-5">
              <Callout tone="bad" title="Cannot open the settings">
                {state.message}
              </Callout>
              <Button variant="ghost" onClick={() => { setState({ k: "loading" }); void load().then(apply); }}>
                <RefreshCw size={13} /> Try again
              </Button>
            </div>
          )}
          {state.k === "ready" && loaded && (
            <Root.Provider value={{ defaults: loaded.defaults, base: loaded.base.config }}>
              <Form.Provider value={form}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={`${section}-${rev}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
                    {section === "models" && <ModelsSection />}
                    {section === "telegram" && <TelegramSection />}
                    {section === "memory" && <MemorySection />}
                    {section === "sandbox" && <SandboxSection />}
                    {section === "tools" && <ToolsSection />}
                    {section === "advanced" && (
                      <AdvancedSection
                        etag={loaded.base.etag.slice(0, 8)}
                        onReplace={(next) => {
                          setDraft(keepRequired(next));
                          setServerIssues([]);
                          setRev((n) => n + 1);
                        }}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </Form.Provider>
            </Root.Provider>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {phase.k === "conflict" && loaded && (
          <Conflict
            key="conflict"
            mine={draft}
            onReloadTheirs={() => void load().then(apply)}
            onOverwrite={(etag) => void save(etag)}
            onCancel={() => setPhase({ k: "idle" })}
          />
        )}
      </AnimatePresence>

      {(server.loose.length > 0 || serverIssues.length > 0) && state.k === "ready" && (
        <div role="alert" className="max-h-28 shrink-0 overflow-y-auto border-t border-bad/40 bg-bad/8 px-5 py-3 text-[12.5px] text-ink">
          <div className="font-medium">The engine refused this change</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-2">
            {(server.loose.length ? server.loose : serverIssues).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <div className="min-w-0 flex-1 text-[12.5px]" role="status">
          {problemCount > 0 ? (
            <button type="button" onClick={jumpToProblem} className="text-bad underline-offset-2 hover:underline">
              {problemCount} {problemCount === 1 ? "problem" : "problems"} to fix
            </button>
          ) : dirty ? (
            <span className="text-ink-2">Unsaved changes</span>
          ) : state.k === "ready" ? (
            <span className="text-ink-3">Up to date</span>
          ) : null}
        </div>
        <Button variant="quiet" onClick={revert} disabled={!dirty || phase.k === "saving"}>
          Revert
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
          {phase.k === "saving" && <LoaderCircle size={13} className="animate-spin" />} Save
        </Button>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Conflict({ mine, onReloadTheirs, onOverwrite, onCancel }: { mine: Obj; onReloadTheirs: () => void; onOverwrite: (etag: string) => void; onCancel: () => void }) {
  const [theirs, setTheirs] = useState<RootPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadRoot().then(setTheirs, (e: Error) => setErr(e.message));
  }, []);
  const lines = useMemo(() => (theirs ? lineDiff(JSON.stringify(sorted(theirs.config), null, 2), JSON.stringify(sorted(mine), null, 2)) : []), [theirs, mine]);
  const out: Array<{ kind: string; text: string }> = [];
  let run: typeof lines = [];
  const flush = () => {
    if (run.length > 4) out.push(run[0]!, { kind: "gap", text: `… ${run.length - 2} unchanged lines` }, run[run.length - 1]!);
    else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.kind === "same") run.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  const changed = lines.some((l) => l.kind !== "same");

  return (
    <motion.section aria-label="Edit conflict" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="shrink-0 overflow-hidden border-t border-warn/40 bg-warn/6">
      <div className="space-y-3 px-5 py-4">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">config.json changed on disk since you opened it</h3>
          <p className="text-[12.5px] text-ink-2">Lines marked + are yours, − are on disk now.</p>
        </div>
        {err && <p className="text-[12.5px] text-bad">{err}</p>}
        {!theirs && !err && <Skeleton className="h-20 w-full" />}
        {theirs && (
          <div className="max-h-48 overflow-auto rounded-lg border border-line bg-sunken font-mono text-[11.5px] leading-[1.55]">
            {changed ? (
              out.map((l, i) => (
                <div key={i} className={cn("px-3 whitespace-pre-wrap", l.kind === "add" && "bg-ok/12 text-ink", l.kind === "del" && "bg-bad/12 text-ink-2", l.kind === "same" && "text-ink-3", l.kind === "gap" && "py-0.5 font-sans text-[11px] text-ink-3 italic")}>
                  {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : l.kind === "gap" ? "" : "  "}
                  {l.text}
                </div>
              ))
            ) : (
              <p className="p-3 font-sans text-ink-3">No differences in content; only the file version changed.</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onReloadTheirs}>
            <RefreshCw size={13} /> Reload theirs
          </Button>
          <Button variant="primary" disabled={!theirs} onClick={() => theirs && onOverwrite(theirs.etag)}>
            Overwrite with mine
          </Button>
          <Button variant="quiet" onClick={onCancel} className="ml-auto">
            Keep editing
          </Button>
        </div>
      </div>
    </motion.section>
  );
}

/** Same content, stable key order, so the diff shows real changes only. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  return v;
}
