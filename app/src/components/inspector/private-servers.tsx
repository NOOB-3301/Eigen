"use client";
import { Plus } from "lucide-react";
import { McpServerForm, type McpServerValue } from "@/components/mcp-form";
import { Button } from "@/components/ui";
import { errorAt, getPath, useForm } from "./fields";

/**
 * Editor for `tools.mcp.servers`: MCP servers only this agent connects to. Same shape as the root catalog, so the form is shared with Settings.
 * Cards are keyed by position, so renaming a server (which rebuilds the record in the same order) never remounts the form under the cursor.
 */
export function PrivateServers({ rootNames }: { rootNames: string[] }) {
  const { config, set, errors } = useForm();
  const own = (getPath(config, "tools.mcp.servers") as Record<string, McpServerValue> | undefined) ?? {};
  const entries = Object.entries(own);
  const write = (next: Array<[string, McpServerValue]>) => set("tools.mcp.servers", next.length ? Object.fromEntries(next) : undefined);

  const freeName = () => {
    for (let i = 1; ; i++) {
      const n = i === 1 ? "server" : `server-${i}`;
      if (!(n in own) && !rootNames.includes(n)) return n;
    }
  };

  return (
    <>
      {entries.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">None yet. Add one that only this agent should be able to use.</p>
      ) : (
        <ul className="grid gap-3">
          {entries.map(([name, value], i) => {
            const error = errorAt(errors, `tools.mcp.servers.${name}`);
            return (
              <li key={i} className="rounded-xl border border-line p-3">
                <McpServerForm
                  name={name}
                  value={value}
                  onChange={(next) => write(entries.map(([n, v], j) => (j === i ? [n, next] : [n, v])))}
                  onRename={(next) => {
                    if (!next || next === name || next in own) return;
                    write(entries.map(([n, v], j) => (j === i ? [next, v] : [n, v])));
                  }}
                  onRemove={() => write(entries.filter((_, j) => j !== i))}
                />
                {error && (
                  <p role="alert" className="mt-2 text-[12px] text-bad">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Button onClick={() => write([...entries, [freeName(), { command: "", args: [], enabled: true, trusted: false }]])}>
        <Plus size={13} /> Add tool server
      </Button>
    </>
  );
}
