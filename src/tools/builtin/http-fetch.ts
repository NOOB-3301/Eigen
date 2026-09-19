import { z } from "zod";
import { defineTool } from "../registry.ts";

const MAX_BYTES = 512 * 1024;

export const httpFetch = defineTool({
  name: "http_fetch",
  description: "Make an HTTP GET or POST request and return status, content type and (size-limited) body text.",
  inputSchema: z.object({
    url: z.url().describe("Absolute http(s) URL"),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().optional().describe("Request body for POST"),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  async execute({ url, method, body, headers }, { signal }) {
    const res = await fetch(url, { method, body: method === "POST" ? body : undefined, headers, signal, redirect: "follow" });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cut = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= MAX_BYTES) {
        cut = true;
        await reader.cancel();
        break;
      }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
    const head = `HTTP ${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? "unknown"}\n\n`;
    return { content: [{ type: "text", text: head + text + (cut ? `\n[response cut at ${MAX_BYTES} bytes]` : "") }], isError: !res.ok };
  },
});
