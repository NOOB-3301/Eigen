import { z } from "zod";
import { ConfigSchema, type Config } from "@eigen/engine/config";
import type { GetRootConfigResponse } from "@eigen/engine/schema";
import { readRoot, writeRoot } from "@eigen/engine/store";
import { paths } from "@/lib/server/home";
import { failure, guard, json, readBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** What the schema fills in for a key the file leaves out; the editor shows these as placeholders instead of guessing them. */
let defaults: Config | undefined;
const schemaDefaults = () => (defaults ??= { ...ConfigSchema.parse({ defaultModel: "d", models: { d: { id: "p/m" } }, telegram: {} }), models: {} });

export type RootConfigPayload = GetRootConfigResponse & { defaults: Config };

/** The root config.json exactly as the file holds it (no defaults filled in), its version, and the schema defaults. */
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    const r = readRoot(paths());
    return r ? json({ ...r, defaults: schemaDefaults() } satisfies RootConfigPayload) : json({ ok: false, issues: ["no config.json"] }, 404);
  } catch (e) {
    return failure(e);
  }
}

const UpdateRoot = z.object({ config: z.record(z.string(), z.unknown()), etag: z.string().optional() });

/** UpdateRootConfigRequest -> UpdateRootConfigResponse: 200 { ok, etag } / 400 { issues } / 404 / 409 { etag }. The engine watches the file. */
export async function PUT(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readBody(req, UpdateRoot);
  if ("error" in body) return body.error;
  try {
    const r = writeRoot(paths(), body.data);
    return json(r.body, r.status);
  } catch (e) {
    return failure(e);
  }
}
