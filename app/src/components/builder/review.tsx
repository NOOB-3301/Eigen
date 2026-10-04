"use client";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import type { GetAgentResponse } from "@eigen/engine/schema";
import { fetcher, keys } from "@/lib/client/api";
import { lineDiff, type DiffLine } from "@/lib/client/diff";
import type { Draft } from "@/lib/client/draft";
import { cn } from "@/lib/cn";
import { Button, Skeleton, spring } from "@/components/ui";

const json = (config: unknown) => JSON.stringify(config, null, 2);
const changed = (d: DiffLine[]) => d.some((l) => l.kind !== "same");

/** The three files of an agent, diffed: config.json, instructions, soul. Files that did not change are left out. */
export function DraftDiff({ before, after, empty }: { before: Draft; after: Draft; empty?: string }) {
  const configDiff = lineDiff(json(before.config), json(after.config));
  const promptDiff = before.instructionsText !== after.instructionsText ? lineDiff(before.instructionsText, after.instructionsText) : [];
  const soulDiff = before.soulText !== after.soulText ? lineDiff(before.soulText, after.soulText) : [];
  return (
    <div className="max-h-56 overflow-auto rounded-lg border border-line bg-sunken font-mono text-[11.5px] leading-[1.55]">
      {changed(configDiff) && <DiffBlock title="config.json" lines={configDiff} />}
      {promptDiff.length > 0 && <DiffBlock title="instructions" lines={promptDiff} />}
      {soulDiff.length > 0 && <DiffBlock title="soul" lines={soulDiff} />}
      {!changed(configDiff) && promptDiff.length === 0 && soulDiff.length === 0 && <p className="p-3 font-sans text-ink-3">{empty ?? "No differences in content; only the file version changed."}</p>}
    </div>
  );
}

export function Conflict({ id, mine, onReloadTheirs, onOverwrite, onCancel }: { id: string; mine: Draft; onReloadTheirs: () => void; onOverwrite: (etag: string) => void; onCancel: () => void }) {
  const [theirs, setTheirs] = useState<GetAgentResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetcher<GetAgentResponse>(keys.agent(id)).then(setTheirs, (e: Error) => setErr(e.message));
  }, [id]);
  return (
    <motion.section
      aria-label="Edit conflict"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={spring}
      className="overflow-hidden border-t border-warn/40 bg-warn/6"
    >
      <div className="space-y-3 px-5 py-4">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">This agent changed on disk since you opened it</h3>
          <p className="text-[12.5px] text-ink-2">Lines marked + are yours, − are on disk now.</p>
        </div>
        {err && <p className="text-[12.5px] text-bad">{err}</p>}
        {!theirs && !err && <Skeleton className="h-24 w-full" />}
        {theirs && <DraftDiff before={{ config: (theirs.config ?? {}) as Draft["config"], instructionsText: theirs.instructionsText ?? "", soulText: theirs.soulText ?? "" }} after={mine} />}
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

function DiffBlock({ title, lines }: { title: string; lines: DiffLine[] }) {
  // Collapse long unchanged runs to keep the diff readable.
  const out: Array<{ kind: string; text: string }> = [];
  let run: DiffLine[] = [];
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
  return (
    <div>
      <div className="sticky top-0 border-b border-line bg-raised px-3 py-1 font-sans text-[11.5px] text-ink-3">{title}</div>
      {out.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre-wrap",
            l.kind === "add" && "bg-ok/12 text-ink",
            l.kind === "del" && "bg-bad/12 text-ink-2",
            l.kind === "same" && "text-ink-3",
            l.kind === "gap" && "py-0.5 font-sans text-[11px] text-ink-3 italic",
          )}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : l.kind === "gap" ? "" : "  "}
          {l.text}
        </div>
      ))}
    </div>
  );
}
