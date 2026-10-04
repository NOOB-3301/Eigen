"use client";
import { Section, useForm } from "@/components/inspector/fields";
import { SecretInput } from "@/components/secret-input";
import { useSecrets } from "@/lib/client/secrets";
import { Callout, BoolField, ModelRefField, NumField, StrField, useRoot } from "./controls";
import { getPath } from "@/components/inspector/fields";

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;

export function MemorySection() {
  const { config } = useForm();
  const { defaults } = useRoot();
  const eff = (p: string) => (getPath(config, p) ?? getPath(defaults, p)) as boolean;
  const embedKey = getPath(config, "memory.embedder.apiKeyEnv");
  const embedEnv = typeof embedKey === "string" ? embedKey : "";
  const { isSet } = useSecrets(ENV.test(embedEnv) ? [embedEnv] : []);

  return (
    <>
      <Section title="Conversation" hint="Defaults for every agent. An agent can override these in its own Memory tab.">
        <NumField label="Recent messages kept" path="memory.lastMessages" hint="How many of the latest messages every turn starts with. Default 20." />
        <StrField label="Nightly consolidation" path="memory.consolidationCron" mono hint="Cron expression for when the curator rewrites your memory notes. Default 30 3 * * * (03:30)." />
      </Section>

      <Section title="Semantic recall" hint="Finds older messages that look like the current one, using an embedding model.">
        <BoolField label="Semantic recall" path="memory.semanticRecall.enabled" hint="Needs the embedder below to be reachable." />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Matches per turn" path="memory.semanticRecall.topK" />
          <NumField label="Messages around each match" path="memory.semanticRecall.messageRange" />
        </div>
        <StrField label="Embedding model" path="memory.embedder.id" mono hint="provider/model. Default ollama/nomic-embed-text." />
        <StrField label="Embedder base URL" path="memory.embedder.url" mono hint="Default http://localhost:11434/v1 (Ollama)." />
        <StrField label="Embedder API key variable" path="memory.embedder.apiKeyEnv" mono placeholder="not needed for local servers" hint="The .env variable that holds the key." />
        {embedEnv && (ENV.test(embedEnv) ? <SecretInput name={embedEnv} set={isSet(embedEnv)} label={embedEnv} /> : <Callout tone="warn">Use an upper-case name to set the key from here.</Callout>)}
      </Section>

      <Section title="Observational memory" hint="Background agents compress old turns into short observations, so long conversations stay cheap.">
        <BoolField label="Observational memory" path="memory.observational.enabled" />
        <ModelRefField label="Observer model" path="memory.observational.model" emptyLabel="Same as the agent's model" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Observe after (tokens)" path="memory.observational.messageTokens" width="w-40" />
          <NumField label="Reflect after (tokens)" path="memory.observational.reflectionTokens" width="w-40" />
        </div>
        <StrField label="Activate after idle" path="memory.observational.activateAfterIdle" mono hint="How long a chat sits quiet before compressing, e.g. 30m. Default 30m." />
        <BoolField label="Observation retrieval" path="memory.observational.retrieval" hint="Let agents search their observations with a tool." />
      </Section>

      <Section title="Knowledge (experimental)" hint="A curator keeps durable facts and pinned reminders that are delivered on every turn.">
        <BoolField label="Knowledge memory" path="memory.knowledge.enabled" />
        {eff("memory.knowledge.enabled") && (!eff("memory.observational.enabled") || !eff("memory.semanticRecall.enabled")) && (
          <Callout tone="warn">Knowledge needs observational memory and semantic recall turned on.</Callout>
        )}
        <ModelRefField label="Curate model" path="memory.knowledge.model" emptyLabel="Same as the observer" hint="It calls tools with strict schemas, so a very small model may fail." />
        <BoolField label="Pins" path="memory.knowledge.pins" hint="Short reminders delivered on every turn." />
        <BoolField label="Knowledge tools" path="memory.knowledge.tools" />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumField label="Max pins" path="memory.knowledge.maxPins" />
          <NumField label="Max characters" path="memory.knowledge.maxCharacters" />
        </div>
      </Section>
    </>
  );
}
