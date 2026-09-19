import { describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import { createFastPath } from "../../src/gateway/telegram/fastpath.ts";

const ME = 42;
let nextId = 1;
function msg(from: number, text: string | undefined, chatType = "private", id = nextId++): Update {
  return {
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: from, type: chatType }, from: { id: from, is_bot: false, first_name: "x" }, ...(text !== undefined ? { text } : { photo: [] }) },
  } as unknown as Update;
}

function setup() {
  const h = { onCommand: vi.fn(), onText: vi.fn(), onUnsupported: vi.fn() };
  return { h, fp: createFastPath([ME], h) };
}

describe("fast path", () => {
  it("routes text and commands from the allowed user", () => {
    const { h, fp } = setup();
    expect(fp(msg(ME, "hello"))).toBe("text");
    expect(fp(msg(ME, "/status"))).toBe("command");
    expect(h.onText).toHaveBeenCalledWith(ME, "hello");
    expect(h.onCommand).toHaveBeenCalledWith(ME, "/status");
  });

  it("silently drops other users, groups and edits", () => {
    const { h, fp } = setup();
    expect(fp(msg(7, "hi"))).toBe("rejected");
    expect(fp(msg(ME, "hi", "group"))).toBe("ignored");
    expect(fp({ update_id: nextId++, edited_message: msg(ME, "x").message } as unknown as Update)).toBe("ignored");
    expect(h.onText).not.toHaveBeenCalled();
    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.onUnsupported).not.toHaveBeenCalled();
  });

  it("dedupes by update id", () => {
    const { h, fp } = setup();
    const u = msg(ME, "once");
    fp(u);
    expect(fp(u)).toBe("duplicate");
    expect(h.onText).toHaveBeenCalledTimes(1);
  });

  it("flags non-text messages from the allowed user", () => {
    const { h, fp } = setup();
    expect(fp(msg(ME, undefined))).toBe("unsupported");
    expect(h.onUnsupported).toHaveBeenCalledWith(ME);
  });

  it("never awaits: handlers are called synchronously and return immediately", () => {
    const h = { onCommand: vi.fn(), onText: vi.fn(() => new Promise(() => {})), onUnsupported: vi.fn() };
    const fp = createFastPath([ME], h as never);
    const t = performance.now();
    fp(msg(ME, "slow"));
    expect(performance.now() - t).toBeLessThan(50);
  });
});
