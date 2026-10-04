// Run with: node --test src/components/editors/*.test.ts   (from app/; Node 22.18+ strips the types)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clip, countLines, duration, intervalLabel, relativeTime } from "./format.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

describe("relativeTime", () => {
  it("reads past and future", () => {
    assert.equal(relativeTime(ago(5), NOW), "just now");
    assert.equal(relativeTime(ago(-5), NOW), "in a few seconds");
    assert.equal(relativeTime(ago(120), NOW), "2 min ago");
    assert.equal(relativeTime(ago(-7200), NOW), "in 2 h");
    assert.equal(relativeTime(ago(3 * 86_400), NOW), "3 d ago");
    assert.equal(relativeTime(ago(30 * 86_400), NOW), "Sep 4, 2026");
  });
  it("passes through what it cannot parse", () => {
    assert.equal(relativeTime("yesterday-ish", NOW), "yesterday-ish");
  });
});

describe("duration", () => {
  it("formats short and long runs", () => {
    assert.equal(duration("2026-10-04T12:00:00.000Z", "2026-10-04T12:00:00.850Z"), "850 ms");
    assert.equal(duration("2026-10-04T12:00:00Z", "2026-10-04T12:00:12Z"), "12 s");
    assert.equal(duration("2026-10-04T12:00:00Z", "2026-10-04T12:03:04Z"), "3 min 4 s");
    assert.equal(duration("2026-10-04T12:00:00Z", "2026-10-04T12:02:00Z"), "2 min");
  });
  it("has no answer without an end or with a backwards clock", () => {
    assert.equal(duration("2026-10-04T12:00:00Z"), undefined);
    assert.equal(duration("2026-10-04T12:00:10Z", "2026-10-04T12:00:00Z"), undefined);
  });
});

describe("clip", () => {
  it("leaves short text alone and reports what it cut", () => {
    assert.deepEqual(clip("abc", 5), { text: "abc", hidden: 0 });
    assert.deepEqual(clip("abcdef", 4), { text: "abcd", hidden: 2 });
  });
  it("does not split an emoji in half", () => {
    assert.deepEqual(clip("ab😀cd", 3), { text: "ab", hidden: 4 });
  });
});

describe("intervalLabel", () => {
  it("speaks in minutes and hours", () => {
    assert.equal(intervalLabel(60), "1 min");
    assert.equal(intervalLabel(300), "5 min");
    assert.equal(intervalLabel(3600), "1 h");
    assert.equal(intervalLabel(5400), "1 h 30 min");
    assert.equal(intervalLabel(90), "2 min");
  });
});

describe("countLines", () => {
  it("counts lines like an editor", () => {
    assert.equal(countLines(""), 0);
    assert.equal(countLines("a"), 1);
    assert.equal(countLines("a\nb"), 2);
    assert.equal(countLines("a\nb\n"), 2);
    assert.equal(countLines("\n"), 1);
  });
});
