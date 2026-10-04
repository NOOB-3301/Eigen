"use client";
import { useMemo, useState, type FormEvent } from "react";
import { AnimatePresence } from "motion/react";
import { FolderPlus, LoaderCircle, Plus, Search, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { CreateSkillRequest, type SkillOrigin, type SkillSummary, type SkillWriteResponse } from "@eigen/engine/schema";
import { cn } from "@/lib/cn";
import { Button, Modal, Skeleton } from "@/components/ui";
import { inputCls } from "@/components/builder/panels/fields";
import { Callout } from "@/components/builder/panels/controls";
import { FormField } from "./form-field";
import { MAX_TEXT, MarkdownSurface } from "./markdown-surface";
import { ConflictBanner, SaveBar, saveShortcut, saveStatus, type SavePhase } from "./parts";
import { MAX_DESCRIPTION, hasBlankBody, validateSkillDraft, withStarterBody } from "./skill-rules";

/* Pure views for the skill library and the skill editor: data and callbacks come in as props (skill-editor.tsx wires the hooks). */

const ORIGIN: Record<SkillOrigin, { label: string; hint: string; tone: string }> = {
  user: { label: "Yours", hint: "A folder in this agent's skills/ that you can edit", tone: "bg-accent-soft text-accent" },
  clawhub: { label: "ClawHub", hint: "Installed from ClawHub. Read-only here", tone: "border border-line text-ink-3" },
};

export function OriginBadge({ origin }: { origin: SkillOrigin }) {
  const o = ORIGIN[origin];
  return (
    <span title={o.hint} className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", o.tone)}>
      {o.label}
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function SkillLibraryView({ skills, loading, selected, onPick, onNew }: { skills: SkillSummary[]; loading: boolean; selected?: string | null; onPick: (slug: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => skills.filter((s) => !q || `${s.slug} ${s.name} ${s.description}`.toLowerCase().includes(q)).toSorted((a, b) => Number(a.origin !== "user") - Number(b.origin !== "user") || a.slug.localeCompare(b.slug)), [skills, q]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
          <input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} className={cn(inputCls(), "pl-9")} />
        </div>
        <Button variant="primary" onClick={onNew}>
          <Plus size={13} aria-hidden /> New skill
        </Button>
      </div>

      {loading && (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {!loading && skills.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
          <FolderPlus size={20} className="mx-auto text-ink-3" aria-hidden />
          <p className="mt-2 text-[13px] font-medium text-ink">No skills yet</p>
          <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] text-ink-3">
            A skill is a folder with a SKILL.md: instructions an agent loads only when its description matches the job. Create one here, or put a folder in this agent&apos;s skills/ folder.
          </p>
        </div>
      )}

      {!loading && skills.length > 0 && (
        <>
          <p role="status" className="text-[12px] text-ink-3">
            {q ? `${shown.length} of ${plural(skills.length, "skill")}` : plural(skills.length, "skill")}
          </p>
          {shown.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[12.5px] text-ink-3">No skill matches “{query.trim()}”.</p>
          ) : (
            <ul className="space-y-2">
              {shown.map((s) => {
                const on = selected === s.slug;
                return (
                  <li key={s.slug}>
                    <button
                      type="button"
                      onClick={() => onPick(s.slug)}
                      aria-current={on ? "true" : undefined}
                      className={cn("w-full rounded-xl border px-3.5 py-3 text-left transition-colors", on ? "border-accent/60 bg-accent-soft" : "border-line bg-panel hover:border-line-strong hover:bg-raised")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                          {s.name || s.slug}
                          {s.name && s.name !== s.slug && <span className="ml-2 font-mono text-[11.5px] font-normal text-ink-3">{s.slug}</span>}
                        </span>
                        <OriginBadge origin={s.origin} />
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-ink-2">{s.description || "No description"}</span>
                      {s.problem && (
                        <span className="mt-1.5 flex items-start gap-1.5 text-[12px] text-warn">
                          <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                          <span>The engine skips this skill: {s.problem}</span>
                        </span>
                      )}
                      <span className={cn("mt-1 block text-[11.5px]", s.enabled ? "text-ok" : "text-ink-3")}>{s.enabled ? "Loaded by this agent" : "Not connected"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/** The server's own rule for a new skill's slug, with the pattern error put in words that fit this form (zod's mentions @owner/, which a new skill cannot use). */
const slugIssue = (slug: string) => {
  if (!slug) return undefined;
  const r = CreateSkillRequest.shape.slug.safeParse(slug);
  if (r.success) return undefined;
  const issue = r.error.issues[0];
  if (issue?.code === "invalid_format") return "Use lowercase letters, digits and single hyphens, such as pdf-tools";
  if (issue?.code === "too_big") return "At most 100 characters";
  return issue?.message ?? "Not a valid slug";
};

export function NewSkillDialog({
  open,
  onClose,
  existing,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Slugs already in the library. */
  existing: string[];
  onCreate: (input: { slug: string; description: string }) => Promise<SkillWriteResponse>;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);

  const slugError = slugIssue(slug) ?? (existing.includes(slug) ? `a skill named "${slug}" already exists` : undefined);
  const descError = description.trim().length > MAX_DESCRIPTION ? `${description.trim().length.toLocaleString("en-US")} / ${MAX_DESCRIPTION.toLocaleString("en-US")} characters` : undefined;
  const ok = !!slug && !slugError && description.trim() !== "" && !descError;

  const close = () => {
    if (busy) return;
    setSlug("");
    setDescription("");
    setIssues([]);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setIssues([]);
    const r = await onCreate({ slug, description: description.trim() }).catch((err: unknown): SkillWriteResponse => ({ ok: false, issues: [err instanceof Error ? err.message : "the request failed"] }));
    setBusy(false);
    if (!r.ok) {
      setIssues(r.issues?.length ? r.issues : [`a skill named "${slug}" already exists`]);
      return;
    }
    const made = r.slug ?? slug;
    setSlug("");
    setDescription("");
    onClose();
    onCreated(made);
  };

  return (
    <Modal open={open} onClose={close} title="New skill" description="Creates a skill folder with a SKILL.md." className="max-w-md">
      <form onSubmit={submit} noValidate>
        <div className="border-b border-line px-5 pt-5 pb-4">
          <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">New skill</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            Creates skills/{slug && !slugError ? slug : "<slug>"}/SKILL.md with a starter you can rewrite.
          </p>
        </div>
        <div className="space-y-4 px-5 py-5">
          <FormField label="Slug" error={slugError} hint="Lowercase letters, digits and single hyphens, such as pdf-tools. It is the folder name and the skill's name; it cannot change later.">
            {(a) => (
              <input
                id={a.id}
                aria-describedby={a.describedBy}
                aria-invalid={a.invalid}
                value={slug}
                placeholder="pdf-tools"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
                className={cn(inputCls(a.invalid), "font-mono text-[13px]")}
              />
            )}
          </FormField>
          <FormField label="Description" error={descError} hint="The model reads this line to decide when to use the skill: say what it does and when." aside={<span className="tabular-nums">{description.trim().length} / {MAX_DESCRIPTION}</span>}>
            {(a) => (
              <textarea
                id={a.id}
                aria-describedby={a.describedBy}
                aria-invalid={a.invalid}
                rows={3}
                value={description}
                placeholder="Extracts text and tables from PDF files. Use when the user attaches a PDF or asks about its contents."
                onChange={(e) => setDescription(e.target.value)}
                className={cn(inputCls(a.invalid), "resize-y")}
              />
            )}
          </FormField>
          {issues.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ok || busy}>
            {busy && <LoaderCircle size={13} className="animate-spin" aria-hidden />} Create skill
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------------------------- */

export type SkillEditorViewProps = {
  slug: string;
  origin: SkillOrigin;
  loading: boolean;
  /** Why the skill could not be loaded (not found, studio unreachable). */
  loadError?: string;
  text: string;
  onChange: (next: string) => void;
  dirty: boolean;
  phase: SavePhase;
  /** What is on disk now, for the conflict diff. */
  theirs: string | null;
  /** The other files in the skill folder, names only. */
  files: string[];
  /** Why the engine skips the SAVED version, if it does. */
  problem?: string;
  /** Whether the agent loads it (its skills.enabled is "all" or lists it). */
  enabled: boolean;
  trashing: boolean;
  trashError?: string;
  onSave: () => void;
  onDiscard: () => void;
  onLoadTheirs: () => void;
  onOverwrite: () => void;
  onKeepEditing: () => void;
  onTrash: () => void;
  onClose?: () => void;
};

type Ask = "trash" | "close" | null;

export function SkillEditorView(p: SkillEditorViewProps) {
  const [ask, setAsk] = useState<Ask>(null);
  const readOnly = p.origin === "clawhub";
  const rules = useMemo(() => (readOnly ? { errors: [], warnings: [] } : validateSkillDraft(p.slug, p.text)), [readOnly, p.slug, p.text]);
  const saving = p.phase.k === "saving";
  const serverIssues = p.phase.k === "error" ? p.phase.issues : [];
  const canSave = p.dirty && rules.errors.length === 0 && !saving && p.phase.k !== "conflict";
  const status = saveStatus(p.phase, p.dirty, {
    savedText: "Saved. The agent sees it on its next message.",
    // The list below the editor says what is wrong; the bar only says why Save is off.
    problems: rules.errors.length ? [rules.errors.length === 1 ? "Fix the problem listed above to save." : `Fix the ${rules.errors.length} problems listed above to save.`] : [],
  });
  const close = () => (p.dirty ? setAsk("close") : p.onClose?.());
  const folder = p.slug.split("/").pop() ?? p.slug;

  if (p.loading) return <Skeleton className="h-72 w-full" />;
  if (p.loadError)
    return (
      <Callout tone="bad" title={`Could not open ${p.slug}`}>
        {p.loadError}
        {p.onClose && (
          <div className="mt-2">
            <Button variant="ghost" onClick={p.onClose}>
              Back to the library
            </Button>
          </div>
        )}
      </Callout>
    );

  return (
    <div className="space-y-3" onKeyDown={readOnly ? undefined : saveShortcut(() => canSave && p.onSave())}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 truncate font-mono text-[14px] font-semibold text-ink" title={p.slug}>
          {p.slug}
        </h3>
        <OriginBadge origin={p.origin} />
        <div className="ml-auto flex items-center gap-1.5">
          {!readOnly && (
            <Button variant="quiet" disabled={p.trashing} onClick={() => setAsk("trash")}>
              <Trash2 size={13} aria-hidden /> Move to trash
            </Button>
          )}
          {p.onClose && (
            <Button variant="quiet" aria-label="Close the skill editor" className="px-2" onClick={close}>
              <X size={15} aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {ask === "close" && (
        <Callout tone="warn" title="Close without saving?">
          Your changes to {folder} will be lost.
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="danger" onClick={p.onClose}>
              Discard and close
            </Button>
            <Button variant="quiet" onClick={() => setAsk(null)}>
              Keep editing
            </Button>
          </div>
        </Callout>
      )}

      {ask === "trash" && (
        <Callout tone="warn" title={`Move ${folder} to the trash?`}>
          It leaves this agent&apos;s library{p.enabled ? ", and the agent stops loading it" : ""}. The folder goes to the agent&apos;s .trash, so you can move it back by hand.
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={p.trashing}
              onClick={() => {
                setAsk(null);
                p.onTrash();
              }}
            >
              <Trash2 size={13} aria-hidden /> Move to trash
            </Button>
            <Button variant="quiet" onClick={() => setAsk(null)}>
              Keep it
            </Button>
          </div>
        </Callout>
      )}
      {p.trashError && (
        <p role="alert" className="text-[12.5px] text-bad">
          Could not move it to the trash: {p.trashError}
        </p>
      )}

      {readOnly ? (
        <Callout title="Installed from ClawHub">Read-only here. To change it, create your own skill and copy the text across.</Callout>
      ) : (
        <Callout title="Shared library">Every agent that uses this skill sees your change on its next message.</Callout>
      )}

      {p.problem && (
        <Callout tone="warn" title="The engine skips this skill as saved">
          {p.problem}
        </Callout>
      )}

      <AnimatePresence initial={false}>
        {p.phase.k === "conflict" && <ConflictBanner key="conflict" what="SKILL.md" mine={p.text} theirs={p.theirs} onLoadTheirs={p.onLoadTheirs} onOverwrite={p.onOverwrite} onKeepEditing={p.onKeepEditing} />}
      </AnimatePresence>

      <MarkdownSurface
        value={p.text}
        onChange={p.onChange}
        label={`SKILL.md of ${p.slug}`}
        readOnly={readOnly}
        rows={18}
        invalid={rules.errors.length > 0}
        action={
          !readOnly &&
          hasBlankBody(p.text) && (
            <Button variant="ghost" className="h-7" onClick={() => p.onChange(withStarterBody(p.slug, p.text))}>
              <Sparkles size={13} aria-hidden /> Insert starter body
            </Button>
          )
        }
      />

      {!readOnly && (
        <p className="text-[12px] leading-relaxed text-ink-3">
          Frontmatter: <code className="font-mono text-ink-2">name</code> must equal the folder name (<code className="font-mono text-ink-2">{folder}</code>), and <code className="font-mono text-ink-2">description</code> is what the model reads to decide when to use this skill. The maximum size is {MAX_TEXT.toLocaleString("en-US")} characters.
        </p>
      )}

      {(rules.errors.length > 0 || rules.warnings.length > 0 || serverIssues.length > 0) && (
        <ul aria-label="Problems in SKILL.md" className="space-y-1.5">
          {rules.errors.map((m) => (
            <Problem key={m} tone="bad">
              {m}
            </Problem>
          ))}
          {serverIssues.map((m) => (
            <Problem key={`server-${m}`} tone="bad">
              {`The engine rejected it: ${m}`}
            </Problem>
          ))}
          {rules.warnings.map((m) => (
            <Problem key={m} tone="warn">
              {m}
            </Problem>
          ))}
        </ul>
      )}

      {p.files.length > 0 && (
        <section aria-label="Other files in this skill">
          <h4 className="text-[12.5px] font-medium text-ink-2">Other files in this skill</h4>
          <ul className="mt-1.5 divide-y divide-line rounded-lg border border-line bg-raised font-mono text-[12px] text-ink-2">
            {p.files.map((f) => (
              <li key={f} className="truncate px-3 py-1.5" title={f}>
                {f}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-ink-3">Read-only here: edit them in the folder.</p>
        </section>
      )}

      {!readOnly && <SaveBar status={status} dirty={p.dirty} canSave={canSave} saving={saving} onSave={p.onSave} onDiscard={p.onDiscard} />}
    </div>
  );
}

function Problem({ tone, children }: { tone: "bad" | "warn"; children: string }) {
  return (
    <li className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] text-ink", tone === "bad" ? "bg-bad/10" : "bg-warn/10")}>
      <TriangleAlert size={13} className={cn("mt-0.5 shrink-0", tone === "bad" ? "text-bad" : "text-warn")} aria-hidden />
      <span>{children}</span>
    </li>
  );
}
