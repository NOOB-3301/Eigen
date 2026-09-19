import { describe, expect, it } from "vitest";
import { splitMessage, toTelegramHtml } from "../../src/gateway/telegram/format.ts";

describe("splitMessage", () => {
  it("returns short text as one chunk", () => {
    expect(splitMessage("hello", 4096)).toEqual(["hello"]);
  });

  it("prefers paragraph boundaries", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    expect(splitMessage(`${a}\n\n${b}`, 100)).toEqual([a, b]);
  });

  it("falls back to line then word boundaries", () => {
    const text = `${"x".repeat(50)}\n${"y".repeat(30)} ${"z".repeat(40)}`;
    const chunks = splitMessage(text, 60);
    expect(chunks[0]).toBe("x".repeat(50));
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("hard-cuts unbroken text without losing characters or splitting surrogate pairs", () => {
    const text = "q".repeat(99) + "😀" + "q".repeat(150);
    const chunks = splitMessage(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]!.endsWith("\ud83d")).toBe(false);
  });

  it("respects the 4096 limit on long real-ish text", () => {
    const para = "word ".repeat(300).trim();
    const text = Array.from({ length: 10 }, () => para).join("\n\n");
    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });
});

describe("toTelegramHtml", () => {
  it("escapes HTML and converts code and bold", () => {
    expect(toTelegramHtml("a < b & **c** `x<y`")).toBe("a &lt; b &amp; <b>c</b> <code>x&lt;y</code>");
    expect(toTelegramHtml("```sh\nls -la\n```")).toBe("<pre>ls -la</pre>");
  });
  it("leaves unmatched markers alone", () => {
    expect(toTelegramHtml("```\nunterminated")).toBe("```\nunterminated");
  });
});
