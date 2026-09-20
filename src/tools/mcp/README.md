# MCP

`client.ts` connects the servers listed under `mcpServers` in `~/.eigen/config.json`
(stdio or HTTP/SSE, via `@ai-sdk/mcp`), lists each server's tools, and registers them in
the `ToolRegistry` as `mcp__<server>__<tool>` with the server's own JSON Schema
(`defineRawTool`, so eigen skips zod validation and the server validates instead).

Execution deliberately goes through `executeTool` like every built-in tool, which keeps
timeouts, `/stop`, output truncation, events, logging and the hooks stage working. The
discovered tool objects are never handed to `generateText`: a tool the model layer can
execute would bypass all of that and eigen's history.

`/reload_mcp` in Telegram re-reads config.json, closes the clients, unregisters
`mcp__*` and reconnects. Failures are reported per server and never stop the daemon.
