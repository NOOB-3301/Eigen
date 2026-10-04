/** The env var an agent's own bot token is conventionally stored under: TELEGRAM_BOT_TOKEN_<ID>. Always a valid ENV_NAME for a valid agent id. */
export const suggestTokenEnv = (id: string) => (id ? `TELEGRAM_BOT_TOKEN_${id.toUpperCase().replace(/-/g, "_")}` : "");
