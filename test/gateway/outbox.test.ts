import { describe, expect, it } from "vitest";
import { Outbox } from "../../src/gateway/telegram/outbox.ts";

function api(failures: Array<object | undefined> = []) {
  const sent: Array<{ chat: number; text: string; html: boolean }> = [];
  return {
    sent,
    actions: 0,
    async sendMessage(chat: number, text: string, other?: { parse_mode?: string }) {
      const f = failures.shift();
      if (f) throw f;
      sent.push({ chat, text, html: other?.parse_mode === "HTML" });
    },
    async sendChatAction() {
      this.actions++;
    },
  };
}

const cfg = { chunkSize: 50, sendRatePerSec: 1000, typingRefreshMs: 20 };

describe("outbox", () => {
  it("splits long text into ordered chunks", async () => {
    const a = api();
    const o = new Outbox(a, cfg);
    o.send(1, `${"a".repeat(40)}\n\n${"b".repeat(40)}`);
    await o.flush(1000);
    expect(a.sent.map((s) => s.text)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("falls back to plain text when Telegram rejects the formatting", async () => {
    const a = api([{ error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" }]);
    const o = new Outbox(a, cfg);
    o.send(1, "**x**");
    await o.flush(1000);
    expect(a.sent).toEqual([{ chat: 1, text: "**x**", html: false }]);
  });

  it("retries 429 with retry_after and transient errors", async () => {
    const a = api([{ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0.01 } }, new Error("socket hang up")]);
    const o = new Outbox(a, cfg);
    o.send(1, "hi");
    await o.flush(5000);
    expect(a.sent.map((s) => s.text)).toEqual(["hi"]);
  });

  it("drops a message on a permanent error and keeps going", async () => {
    const a = api([{ error_code: 403, description: "Forbidden: bot was blocked by the user" }]);
    const o = new Outbox(a, cfg);
    o.send(1, "lost");
    o.send(1, "next");
    await o.flush(1000);
    expect(a.sent.map((s) => s.text)).toEqual(["next"]);
  });

  it("respects sendRatePerSec", async () => {
    const a = api();
    const o = new Outbox(a, { ...cfg, sendRatePerSec: 20 });
    const t = Date.now();
    for (let i = 0; i < 4; i++) o.send(1, `m${i}`);
    await o.flush(2000);
    expect(Date.now() - t).toBeGreaterThanOrEqual(140);
  });

  it("refreshes typing until stopped", async () => {
    const a = api();
    const o = new Outbox(a, cfg);
    o.startTyping(1);
    await new Promise((r) => setTimeout(r, 70));
    o.stopTyping(1);
    const n = a.actions;
    expect(n).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.actions).toBe(n);
  });
});
