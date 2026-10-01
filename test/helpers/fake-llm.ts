import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

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

/** A scripted OpenAI-compatible server. Each request consumes the next turn (the last one repeats). */
export async function fakeLlm(turns: Turn[]) {
  const requests: Array<{ messages: Array<Record<string, any>>; tools?: Array<{ function: { name: string } }> }> = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body);
      requests.push(json);
      send(res, !!json.stream, turns[Math.min(i++, turns.length - 1)]!);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
