"use client";

/** One MCP server as config.json holds it: stdio { command, args, env } or remote { url, headers, transport }, plus flags. */
export type McpServerValue = Record<string, unknown>;

/**
 * CONTRACT STUB (owned by the app-settings worker, who replaces the body; consumers keep this signature).
 * Edits a single MCP server entry (used by Settings > Tools for root mcpServers, and by the agent inspector for private servers).
 * `name`/`onRename` edit the record key; `env:NAME` values get a write-only SecretInput next to them.
 */
export function McpServerForm({
  name,
  value,
  onChange,
  onRename,
  onRemove,
}: {
  name: string;
  value: McpServerValue;
  onChange: (next: McpServerValue) => void;
  onRename?: (next: string) => void;
  onRemove?: () => void;
}) {
  void onChange;
  void onRename;
  void onRemove;
  return <pre className="font-mono text-[12px] text-ink-3">{`${name}: ${JSON.stringify(value)}`}</pre>;
}
