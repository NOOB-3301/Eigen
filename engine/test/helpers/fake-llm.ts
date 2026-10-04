import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = { model?: string; messages: Array<Record<string, any>>; tools?: Array<{ function: { name: string } }> };

export type Turn = {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  delayMs?: number;
  /** Answers every request it matches, wherever the request falls in the script (agents that run in parallel make the order unpredictable). Turns without it are used in order. */
  when?: (request: RecordedRequest) => boolean;
};

const chunk = (delta: object, finish: string | null = null) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function send(res: ServerResponse, stream: boolean, turn: Turn) {
  const calls = (turn.calls ?? []).map((c, i) => ({ index: i, id: `call_${i}_${c.name}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  const finish = calls.length ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!stream) {
    res.setHeader("content-type", "application/json");
    const message = { role: "assistant", content: turn.text ?? null, ...(calls.length && { tool_calls: calls }) };
    return res.end(JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, message, finish_reason: finish }], usage }));
  }
  res.setHeader("content-type", "text/event-stream");
  const events = [chunk({ role: "assistant", content: turn.text ?? "" }), ...(calls.length ? [chunk({ tool_calls: calls })] : []), { ...chunk({}, finish), usage }];
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** Deterministic 128-dim bag-of-words embedding: texts sharing words are close in cosine distance. */
export function embed(text: string) {
  const v = new Array<number>(128).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 128, 7)]! += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** A scripted OpenAI-compatible server. Each request consumes the next turn (the last one repeats), unless a turn with `when` matches it. */
export async function fakeLlm(turns: Turn[]) {
  const requests: RecordedRequest[] = [];
  const ordered = turns.filter((t) => !t.when);
  const embeddings: string[] = [];
  /** The Authorization header of every request (chat and embeddings), "" when there was none: which key reached the server. */
  const authorizations: string[] = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body);
      authorizations.push(String(req.headers.authorization ?? ""));
      if (req.url?.endsWith("/embeddings")) {
        const inputs: string[] = [json.input].flat();
        embeddings.push(...inputs);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ object: "list", model: "fake-embed", data: inputs.map((t, index) => ({ object: "embedding", index, embedding: embed(t) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
      }
      requests.push(json);
      const turn = turns.find((t) => t.when?.(json)) ?? ordered[Math.min(i++, ordered.length - 1)] ?? {};
      const timer = setTimeout(() => !res.destroyed && send(res, !!json.stream, turn), turn.delayMs ?? 0);
      res.on("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, embeddings, authorizations, close: () => new Promise<void>((r) => server.close(() => r())) };
}
