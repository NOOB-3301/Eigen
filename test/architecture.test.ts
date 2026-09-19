import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

type Imp = { from: string; to: string; typeOnly: boolean };

function imports(file: string): Imp[] {
  const src = readFileSync(file, "utf8");
  const out: Imp[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[3]!;
    if (!spec.startsWith(".")) continue;
    out.push({ from: file, to: resolve(dirname(file), spec), typeOnly: !!m[2] });
  }
  for (const m of src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push({ from: file, to: resolve(dirname(file), m[1]!), typeOnly: false });
  return out;
}

const layer = (abs: string) => relative(SRC, abs).split(sep)[0]!;

// Who may import whom (runtime imports). Any module may `import type` from core/types.ts.
const ALLOWED: Record<string, string[]> = {
  gateway: ["gateway", "core", "config", "util"],
  core: ["core", "models", "tools", "prompts", "config", "util"],
  models: ["models", "config", "util"],
  tools: ["tools", "config", "util"],
  prompts: ["prompts", "util"],
  config: ["config", "util"],
  util: ["util"],
};

const TYPES = join(SRC, "core", "types.ts");

describe("architecture", () => {
  const all = files(SRC).flatMap(imports);

  it("every src file lives in a known layer", () => {
    for (const f of files(SRC)) expect(Object.keys(ALLOWED)).toContain(layer(f));
  });

  it("core never imports gateway", () => {
    const bad = all.filter((i) => layer(i.from) === "core" && layer(i.to) === "gateway");
    expect(bad.map((i) => relative(ROOT, i.from))).toEqual([]);
  });

  it("imports follow the layer rules", () => {
    const bad = all
      .filter((i) => !ALLOWED[layer(i.from)]!.includes(layer(i.to)))
      .filter((i) => !(i.typeOnly && i.to === TYPES))
      .map((i) => `${relative(ROOT, i.from)} -> ${relative(ROOT, i.to)}${i.typeOnly ? " (type)" : ""}`);
    expect(bad).toEqual([]);
  });

  it("imports from core/types.ts outside core are type-only", () => {
    const bad = all.filter((i) => i.to === TYPES && layer(i.from) !== "core" && !i.typeOnly);
    expect(bad.map((i) => relative(ROOT, i.from))).toEqual([]);
  });

  it("provider wire formats appear only under src/models/adapters/", () => {
    const markers = [
      "tool_calls", "tool_call_id", "tool_use_id", "input_schema", "image_url", "cache_control", "x-api-key",
      "anthropic-version", "finish_reason", "stop_reason", "prompt_tokens", "input_tokens", "chat/completions",
      "/messages", 'type: "tool_use"', '"redacted_thinking"', "is_error",
    ];
    const adapters = join(SRC, "models", "adapters") + sep;
    const bad: string[] = [];
    for (const f of files(SRC)) {
      if (f.startsWith(adapters)) continue;
      const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""); // comments may mention providers
      for (const m of markers) if (code.includes(m)) bad.push(`${relative(ROOT, f)}: ${m}`);
    }
    expect(bad).toEqual([]);
  });
});
