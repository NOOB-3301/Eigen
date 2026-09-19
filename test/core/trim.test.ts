import { describe, expect, it } from "vitest";
import { splitTurns, trimHistory, TRIMMED_NOTE } from "../../src/core/trim.ts";
import type { Message } from "../../src/core/types.ts";

const user = (t: string): Message => ({ role: "user", parts: [{ type: "text", text: t }] });
const call = (id: string): Message => ({ role: "assistant", parts: [{ type: "tool_call", id, name: "x", args: {} }], providerData: { blob: 1 } });
const result = (id: string, body: string): Message => ({ role: "tool", parts: [{ type: "tool_result", callId: id, content: [{ type: "text", text: body }] }] });
const reply = (t: string): Message => ({ role: "assistant", parts: [{ type: "text", text: t }] });

const big = "x".repeat(4000); // ~1000 tokens

function assertNoOrphans(ms: Message[]) {
  const calls = new Set(ms.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_call" ? [p.id] : []))));
  const results = new Set(ms.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [p.callId] : []))));
  expect([...results].every((r) => calls.has(r))).toBe(true);
  expect([...calls].every((c) => results.has(c))).toBe(true);
}

describe("trimHistory", () => {
  const history: Message[] = [user("q1"), call("a"), result("a", big), reply("r1"), user("q2"), call("b"), result("b", big), reply("r2"), user("q3")];

  it("splits turns at user messages", () => {
    expect(splitTurns(history).map((t) => t.length)).toEqual([4, 4, 1]);
  });

  it("leaves history alone when it fits", () => {
    const r = trimHistory(history, 100_000, 1000);
    expect(r.messages).toBe(r.messages);
    expect(r.messages).toEqual(history);
    expect(r.trimmedResults + r.droppedTurns).toBe(0);
  });

  it("trims oldest tool results first", () => {
    const r = trimHistory(history, 1200, 1000);
    expect(r.fits).toBe(true);
    expect(r.trimmedResults).toBe(1);
    expect(r.droppedTurns).toBe(0);
    expect(JSON.stringify(r.messages[2])).toContain(TRIMMED_NOTE);
    expect(JSON.stringify(r.messages[6])).toContain(big);
    expect(history[2]!.parts[0]).toMatchObject({ content: [{ text: big }] }); // original untouched
    // edited transcript -> provider blobs stripped from completed turns
    expect(r.messages[1]!.providerData).toBeUndefined();
    assertNoOrphans(r.messages);
  });

  it("drops whole oldest turns without orphaning tool results", () => {
    const r = trimHistory(history, 30, 1000);
    expect(r.fits).toBe(true);
    expect(r.droppedTurns).toBe(2);
    expect(r.messages).toEqual([user("q3")]);
    const r2 = trimHistory(history, 60, 1000);
    assertNoOrphans(r2.messages);
    expect(r2.messages[0]!.role).toBe("user");
  });

  it("never trims the latest turn and reports when it alone does not fit", () => {
    const current: Message[] = [user("old"), reply("r"), user("q"), call("c"), result("c", big)];
    const r = trimHistory(current, 500, 1000);
    expect(r.fits).toBe(false);
    expect(JSON.stringify(r.messages)).toContain(big);
  });

  it("counts images at the fixed estimate", () => {
    const img: Message = { role: "user", parts: [{ type: "image", mediaType: "image/png", data: "AAAA" }] };
    expect(trimHistory([img], 10_000, 5000).historyTokens).toBeGreaterThanOrEqual(5000);
  });
});
