"use client";
import { Section, getPath, useForm } from "@/components/inspector/fields";
import { Button } from "@/components/ui";
import { BoolField, Callout, ChoiceField, ListField, NumField, useRoot } from "./controls";

export function SandboxSection() {
  const { config, set } = useForm();
  const { defaults } = useRoot();
  const isolation = (getPath(config, "sandbox.isolation") ?? defaults.sandbox.isolation) as string;
  const writable = (getPath(config, "sandbox.readWritePaths") as string[] | undefined) ?? [];
  const deny = getPath(config, "sandbox.denyReadPaths") as string[] | undefined;
  const removed = deny ? defaults.sandbox.denyReadPaths.filter((p) => !deny.includes(p)) : [];

  return (
    <>
      <Section title="Isolation" hint="Every shell command an agent runs goes through this. The sandbox folder (~/.eigen/sandbox) is the only place it can write by default.">
        <ChoiceField label="Isolation" path="sandbox.isolation" options={[{ value: "auto", label: "Auto" }, { value: "seatbelt", label: "Seatbelt (macOS)" }, { value: "bwrap", label: "Bubblewrap (Linux)" }, { value: "none", label: "None" }]} hint="Auto picks the OS sandbox that is available." />
        {isolation === "none" && (
          <Callout tone="bad" title="Isolation is off">
            Agent commands run directly on your machine with your permissions. They can read your keys and change any file you can.
          </Callout>
        )}
        <BoolField label="Allow network" path="sandbox.allowNetwork" hint="Lets commands reach the internet (package installs, web requests)." />
      </Section>

      <Section title="Paths" hint="One path per line. A leading ~/ means your home folder.">
        <ListField label="Also writable" path="sandbox.readWritePaths" placeholder="~/Projects/notes" hint="Folders agent commands may write to, beyond the sandbox." />
        {writable.length > 0 && (
          <Callout tone="warn" title="Agents can change these folders">
            {writable.join(", ")}. Anything an agent runs, or is tricked into running, can modify them.
          </Callout>
        )}
        <ListField label="Also readable" path="sandbox.readOnlyPaths" hint="Folders commands may read but not change." />
        {deny ? (
          <>
            <ListField label="Never readable" path="sandbox.denyReadPaths" rows={6} hint="Your own list replaces the built-in one." />
            <div>
              <Button variant="ghost" onClick={() => set("sandbox.denyReadPaths", undefined)}>
                Go back to the built-in list
              </Button>
            </div>
          </>
        ) : (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Never readable</div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-3">{defaults.sandbox.denyReadPaths.join("\n")}</pre>
            <p className="mt-1.5 text-[12px] text-ink-3">The built-in list ({defaults.sandbox.denyReadPaths.length} paths: keys, shell history, Documents, ...) is hidden from commands on macOS.</p>
            <Button variant="ghost" className="mt-2" onClick={() => set("sandbox.denyReadPaths", [...defaults.sandbox.denyReadPaths])}>
              Customize the list
            </Button>
          </div>
        )}
        {removed.length > 0 && (
          <Callout tone="warn" title={`${removed.length} protected ${removed.length === 1 ? "path is" : "paths are"} no longer hidden`}>
            {removed.join(", ")}
          </Callout>
        )}
      </Section>

      <Section title="Time limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Default command timeout (ms)" path="sandbox.commandTimeoutMs" width="w-40" />
          <NumField label="Longest allowed timeout (s)" path="sandbox.maxTimeoutSec" width="w-40" />
        </div>
      </Section>
    </>
  );
}
