import { join } from "node:path";
import { ensureHome, eigenHome } from "./src/config/home.ts";
import { ConfigError, loadConfig } from "./src/config/load.ts";
import { Agent } from "./src/core/agent.ts";
import { TelegramChannel } from "./src/gateway/telegram/index.ts";
import { ConflictError } from "./src/gateway/telegram/receiver.ts";
import { initLogger } from "./src/util/logger.ts";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`eigen needs Node 22.18+ (found ${process.versions.node}).`);
  process.exit(1);
}

const home = eigenHome();
const seeded = ensureHome(home);
if (seeded.createdConfig) {
  console.log(`Created ${home} with default files: ${seeded.created.join(", ")}

Before starting eigen, fill in:
  1. ${join(home, ".env")}
       TELEGRAM_BOT_TOKEN=<token from @BotFather>
       ANTHROPIC_API_KEY=<key>            (only for the "cloud" entry)
  2. ${join(home, "config.json")}
       telegram.allowedUserIds: [<your numeric Telegram user id>]
       models: check each entry's model id, baseUrl and contextWindow
               (for Ollama keep contextWindow below the num_ctx Ollama runs with)

Then run: node main.ts`);
  process.exit(0);
}

const logger = initLogger(join(home, "logs", "eigen.log"));

let config;
try {
  config = loadConfig(home);
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}
if (config.telegram.allowedUserIds.length === 0) {
  console.error(`telegram.allowedUserIds in ${join(home, "config.json")} is empty; nobody could talk to the bot. Add your Telegram user id.`);
  process.exit(1);
}
const agent = new Agent({ config, home });
// Connect MCP servers before polling starts so the first message already sees their tools.
const mcpStatus = await agent.startMcp();
logger.info({ evt: "mcp_ready", servers: mcpStatus.length, connected: mcpStatus.filter((s) => s.ok).length, tools: agent.mcp.toolCount() });
console.log(`Agents initiated with config ${JSON.stringify(config, null, 2)} , mcpServer Status ${JSON.stringify(agent.mcp.list(), null, 2) } and Skills ${JSON.stringify(agent.skills.slugs(), null, 2)} `);
const telegram = new TelegramChannel(config.telegram, agent);

let stopping = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ evt: "shutdown", signal });
  setTimeout(() => process.exit(code), 5000).unref(); // never hang on exit
  agent.shutdown(); // cancels runs; their "Stopped." notes go into the outbox
  await telegram.stop();
  await agent.mcp.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => logger.error({ evt: "unhandled_rejection", err: e }));

try {
  await telegram.start();
} catch (e) {
  logger.fatal({ evt: "startup_failed", err: (e as Error).message });
  process.exit(1);
}
logger.info({ evt: "started", home, defaultModel: config.defaultModel });

telegram.done.then(
  () => void shutdown("poll_ended"),
  (e) => {
    if (e instanceof ConflictError) logger.fatal({ evt: "poll_conflict" }, `${e.message}. Stop the other instance and restart.`);
    else logger.fatal({ evt: "poll_failed", err: (e as Error).message });
    void shutdown("poll_failed", 1);
  },
);
