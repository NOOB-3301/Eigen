import { bootProblems, getConfig } from "./config.ts";

/** False only when Telegram itself rejects the token; being offline must not block startup. */
export async function telegramTokenOk(token: string, fetchFn: typeof fetch = fetch) {
  try {
    const { status } = await fetchFn(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    return status !== 401 && status !== 404;
  } catch {
    return true;
  }
}

/** Loads config; throws (so the server refuses to start) when it is unsafe. */
export async function boot(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch) {
  const config = getConfig();
  const problems = bootProblems(config, env);
  if (!problems.length && !(await telegramTokenOk(env[config.telegram.tokenEnv]!, fetchFn))) problems.push(`${config.telegram.tokenEnv} was rejected by Telegram`);
  if (problems.length) throw new Error(`eigen cannot start:\n- ${problems.join("\n- ")}`);
  return config;
}
