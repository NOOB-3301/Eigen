import type { Agent } from "../../core/agent.ts";
import { sessionFor } from "./dispatcher.ts";
import type { Outbox } from "./outbox.ts";

const HELP = [
  "/new – start a fresh session (re-reads SOUL.md and prompts)",
  "/stop – cancel the current run and clear the queue",
  "/status – model, run state, queue, tokens today",
  "/model [name] – list models or switch this session",
  "/reload – re-read SOUL.md and prompts for the next session",
  "/reload_mcp – reconnect the MCP servers from config.json",
  "/verbose – toggle tool progress notes",
].join("\n");

// Commands act on the agent directly and never wait behind a run in the session queue.
function mcpLine(s: { tools: number; mcpServers: Array<{ name: string; ok: boolean; tools: number; error?: string }> }): string {
  if (!s.mcpServers.length) return `Tools: ${s.tools} (no MCP servers configured)`;
  const ok = s.mcpServers.filter((m) => m.ok);
  const failed = s.mcpServers.filter((m) => !m.ok).map((m) => `${m.name} (${m.error})`);
  return [`Tools: ${s.tools}`, `MCP: ${ok.length}/${s.mcpServers.length} servers – ${ok.map((m) => `${m.name}:${m.tools}`).join(", ") || "none"}`, failed.length ? `MCP failed: ${failed.join("; ")}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function createCommands(agent: Agent, outbox: Outbox): (chatId: number, text: string) => void {
  return (chatId, text) => {
    const [head = "", ...rest] = text.trim().split(/\s+/);
    const cmd = head.slice(1).split("@")[0]!.toLowerCase();
    const arg = rest.join(" ");
    const sid = sessionFor(chatId);
    const reply = (t: string) => outbox.send(chatId, t);

    switch (cmd) {
      case "new":
        reply(agent.newSession(sid).message);
        break;
      case "stop": {
        const { cancelled, dropped } = agent.cancel(sid);
        if (!cancelled) reply(dropped ? `Cleared ${dropped} queued message(s).` : "Nothing is running.");
        else if (dropped) reply(`Stopping; also cleared ${dropped} queued message(s).`);
        break; // the run's "done" event sends "Stopped."
      }
      case "status": {
        const s = agent.status(sid);
        reply(
          [
            `Model: ${s.model} (${s.provider}, ${s.providerModel})`,
            `Tool calling: ${s.toolCalling ? "on" : "off (this model entry has toolCalling: false)"}`,
            `State: ${s.running ? "running" : "idle"}, queued: ${s.queueLength}`,
            `Tokens today (${s.model}): ${s.tokensToday}${s.dailyTokenCap ? ` / ${s.dailyTokenCap}` : ""}`,
            `History: ${s.messages} messages, verbose: ${s.verbose ? "on" : "off"}`,
            mcpLine(s),
          ].join("\n"),
        );
        break;
      }
      case "model": {
        if (!arg) {
          const current = agent.getModel(sid);
          const lines = agent.listModels().map(({ name, entry: e, isDefault }) => {
            const flags = [e.toolCalling && "tools", e.vision && "vision", e.promptCaching && "caching"].filter(Boolean).join(", ") || "none";
            return `${name === current ? "▸" : "•"} ${name}${isDefault ? " (default)" : ""}: ${e.provider}, ${e.model} [${flags}]`;
          });
          reply(`${lines.join("\n")}\n\nSwitch with /model <name>.`);
        } else {
          reply(agent.setModel(sid, arg).message);
        }
        break;
      }
      case "reload":
        reply(agent.reload().message);
        break;
      // Telegram only auto-links [A-Za-z0-9_], so the underscore form is the canonical one.
      case "reload_mcp":
      case "reload-mcp":
        reply("Reconnecting MCP servers…");
        void agent.reloadMcp().then((r) => reply(r.message));
        break;
      case "verbose":
        reply(`Verbose ${agent.toggleVerbose(sid) ? "on" : "off"}.`);
        break;
      case "start":
      case "help":
        reply(`eigen is listening. Send a message, or:\n${HELP}`);
        break;
      default:
        reply(`Unknown command /${cmd}.\n${HELP}`);
    }
  };
}
