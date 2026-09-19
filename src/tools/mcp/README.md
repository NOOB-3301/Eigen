# MCP (not enabled in v0)

Placeholder. A later milestone adds MCP stdio clients that start the servers listed
under `mcpServers` in config.json, list their tools, and register each one in the
`ToolRegistry` as a normal `Tool` (name-prefixed, zod schema built from the server's
JSON Schema). Execution then flows through `executeTool` like every built-in tool, so
the hooks stage applies to MCP tools too.
