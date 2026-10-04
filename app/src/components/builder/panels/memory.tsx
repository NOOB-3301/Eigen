"use client";
import { RotateCcw } from "lucide-react";
import { DEFAULT_WORKING_MEMORY_TEMPLATE, defaultApiKeyEnv } from "@eigen/engine/schema";
import { Button, Segmented } from "@/components/ui";
import { MarkdownSurface } from "@/components/editors/markdown-surface";
import { BLURB } from "../kinds";
import { eff, storageMoved, type Item } from "../model";
import { BoolField, Callout, ChoiceField, ModelRefField, NumField, StrField } from "./controls";
import { Connection, type PanelCtx } from "./connection";
import { Field, Section, getPath, useForm } from "./fields";
import { KeyField } from "./key-field";

const SCOPE = [
  { value: "resource", label: "Per person" },
  { value: "thread", label: "Per chat" },
] as const;
const scopeHint = "Per person: one memory across all their chats with this agent. Per chat: each conversation starts empty.";

export function StorageBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const { config, set } = useForm();
  const url = getPath(config, "memory.storage.url");
  const remote = typeof url === "string";
  const moved = !!ctx.base && storageMoved(ctx.base, ctx.draft);
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.storage}. Every memory block keeps its data here; without it the agent keeps nothing between messages.`} />
      <Section title="Where" hint="Only this agent ever uses this database. Two agents never share one.">
        <Segmented
          label="Where the memory lives"
          value={remote ? "remote" : "local"}
          onChange={(v) => {
            if (v === "remote") set("memory.storage.url", "libsql://");
            else {
              set("memory.storage.url", undefined);
              set("memory.storage.authTokenEnv", undefined);
            }
          }}
          options={[
            { value: "local", label: "memory.db in its folder" },
            { value: "remote", label: "Remote LibSQL" },
          ]}
        />
        {remote && (
          <>
            <StrField label="Database URL" path="memory.storage.url" mono placeholder="libsql://my-db.turso.io" hint="libsql://, https:// or wss://. Never a file: path." />
            <KeyField agentId={ctx.agentId} path="memory.storage.authTokenEnv" label="Auth token variable" effective={(getPath(config, "memory.storage.authTokenEnv") as string | undefined) ?? undefined} hint="Required for libsql://. The name of the line in this agent's .env that holds the token." />
          </>
        )}
        {moved && (
          <Callout tone="warn" title="The agent will start with an empty memory">
            After you apply, it reads and writes the new database. What it remembers now stays where it was; nothing is copied or deleted.
          </Callout>
        )}
      </Section>
    </>
  );
}

export function LastMessagesBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.lastMessages}. Connecting it turns the storage on.`} />
      <Section title="Settings">
        <NumField label="Messages sent with every turn" path="memory.lastMessages.count" hint="Default 20, at most 500." />
      </Section>
    </>
  );
}

export function WorkingMemoryBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const { config, set } = useForm();
  const raw = getPath(config, "memory.workingMemory.template");
  const template = typeof raw === "string" ? raw : DEFAULT_WORKING_MEMORY_TEMPLATE;
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.workingMemory}. It reads the page on every turn and updates it when it learns something.`} />
      <Section title="Settings">
        <ChoiceField label="Scope" path="memory.workingMemory.scope" options={[...SCOPE]} hint={scopeHint} />
        <Field
          label="Template"
          path="memory.workingMemory.template"
          aside={
            raw !== undefined && (
              <Button variant="quiet" className="h-7 px-2" onClick={() => set("memory.workingMemory.template", undefined)}>
                <RotateCcw size={12} aria-hidden /> Reset to default
              </Button>
            )
          }
        >
          {() => <MarkdownSurface value={template} onChange={(v) => set("memory.workingMemory.template", v === DEFAULT_WORKING_MEMORY_TEMPLATE ? undefined : v)} label="Working memory template" rows={10} />}
        </Field>
      </Section>
    </>
  );
}

export function SemanticRecallBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  const { config } = useForm();
  const embedder = { id: String(eff(config, "memory.semanticRecall.embedder.id")), url: getPath(config, "memory.semanticRecall.embedder.url") as string | undefined, apiKeyEnv: getPath(config, "memory.semanticRecall.embedder.apiKeyEnv") as string | undefined };
  // The default embedder is a local Ollama one; once the draft names its own, its url is whatever it says.
  const ownEmbedder = getPath(config, "memory.semanticRecall.embedder") !== undefined;
  const effective = embedder.id.includes("/") ? defaultApiKeyEnv({ ...embedder, url: ownEmbedder ? embedder.url : String(eff(config, "memory.semanticRecall.embedder.url")) }) : undefined;
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.semanticRecall}, even from other chats when the scope is per person. Disconnecting it also disconnects the subconscious.`} />
      <Section title="Settings">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Matches per turn" path="memory.semanticRecall.topK" />
          <NumField label="Messages around each match" path="memory.semanticRecall.messageRange" />
        </div>
        <ChoiceField label="Scope" path="memory.semanticRecall.scope" options={[...SCOPE]} hint={scopeHint} />
      </Section>
      <Section title="Embedder" hint="The model that turns messages into vectors. Default: nomic-embed-text on a local Ollama.">
        <StrField label="Embedding model" path="memory.semanticRecall.embedder.id" mono />
        <StrField label="Base URL" path="memory.semanticRecall.embedder.url" mono hint="Empty for a hosted provider when you set your own model id." />
        <KeyField agentId={ctx.agentId} path="memory.semanticRecall.embedder.apiKeyEnv" label="API key variable" effective={effective} />
      </Section>
    </>
  );
}

export function ObservationalBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.observational}, so a long conversation does not fall out of the context window. Disconnecting it also disconnects the subconscious.`} />
      <Section title="Settings">
        <ModelRefField label="Observer model" path="memory.observational.model" emptyLabel="The agent's model" hint="One of this agent's models. A cheaper one is fine." />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Observe after (tokens)" path="memory.observational.messageTokens" width="w-40" />
          <NumField label="Reflect after (tokens)" path="memory.observational.reflectionTokens" width="w-40" />
        </div>
        <StrField label="Activate after idle" path="memory.observational.activateAfterIdle" mono hint="How long a chat sits quiet before it is compressed, e.g. 30m. Default 30m." />
        <BoolField label="Observation retrieval" path="memory.observational.retrieval" hint="Let the agent search its observations with a tool." />
      </Section>
    </>
  );
}

export function SubconsciousBody({ item, ctx }: { item: Item; ctx: PanelCtx }) {
  return (
    <>
      <Connection item={item} ctx={ctx} blurb={`${BLURB.subconscious}. It reads both semantic recall and observational memory, so connecting it turns them (and the storage) on.`} />
      <Section title="Settings">
        <ModelRefField label="Curate model" path="memory.subconscious.model" emptyLabel="The observer's model" hint="It calls tools with strict schemas, so a very small model may fail." />
        <BoolField label="Pins" path="memory.subconscious.pins" hint="Short reminders delivered on every turn." />
        <BoolField label="Knowledge tools" path="memory.subconscious.tools" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Max pins" path="memory.subconscious.maxPins" />
          <NumField label="Max characters" path="memory.subconscious.maxCharacters" />
        </div>
      </Section>
    </>
  );
}
