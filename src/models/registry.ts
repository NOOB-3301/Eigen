import type { Config, ModelEntry, ProviderKind } from "../config/schema.ts";
import { createAiSdkProvider } from "./adapters/ai-sdk.ts";
import type { FetchFn, ModelProvider } from "./provider.ts";

// Both kinds go through the one AI SDK adapter, which picks the SDK provider from
// entry.provider. Adding a provider = one SDK package + one line here + a config entry.
const FACTORIES: Record<ProviderKind, (f?: FetchFn) => ModelProvider> = {
  "openai-compat": createAiSdkProvider,
  anthropic: createAiSdkProvider,
};

export class ModelRegistry {
  readonly defaultName: string;
  #entries: Record<string, ModelEntry>;
  #providers = new Map<ProviderKind, ModelProvider>();
  #fetch?: FetchFn;

  constructor(config: Pick<Config, "models" | "defaultModel">, fetchFn?: FetchFn) {
    this.#entries = config.models;
    this.defaultName = config.defaultModel;
    this.#fetch = fetchFn;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.#entries, name);
  }

  entry(name: string): ModelEntry {
    const e = this.#entries[name];
    if (!e) throw new Error(`unknown model entry "${name}"`);
    return e;
  }

  names(): string[] {
    return Object.keys(this.#entries);
  }

  provider(name: string): ModelProvider {
    const kind = this.entry(name).provider;
    let p = this.#providers.get(kind);
    if (!p) {
      p = FACTORIES[kind](this.#fetch);
      this.#providers.set(kind, p);
    }
    return p;
  }
}
