import { secretStatuses } from "@eigen/engine/envfile";
import { AgentConfigSchema, ENV_NAME, referencedEnvNames, type AgentConfig, type SecretStatus } from "@eigen/engine/schema";
import { listAgentIds, readAgent } from "@eigen/engine/store";
import { paths, rootConfig } from "./home";

/**
 * Every env name the configs point at (root + every agent that parses) and whether it is set in ~/.eigen/.env.
 * `extra` adds names the editor is about to reference (typed into a form, not saved yet) so their status shows too.
 * Never returns a value.
 */
export function secretList(extra: string[] = []): SecretStatus[] {
  const p = paths();
  const agents: AgentConfig[] = [];
  for (const id of listAgentIds(p)) {
    try {
      const a = readAgent(p, id);
      const r = a && AgentConfigSchema.safeParse(a.config);
      if (r?.success) agents.push(r.data);
    } catch {
      /* a folder that is not a valid id: the engine ignores it too */
    }
  }
  const refs = referencedEnvNames(rootConfig(), agents);
  for (const n of extra) if (ENV_NAME.test(n) && !refs.has(n)) refs.set(n, []);
  return secretStatuses(p, refs);
}
