import type { Clock } from "../../src/mastra/lib/triggers.ts";

/**
 * A clock the test moves by hand. Timers fire only when it is advanced, so a cron time or a poll interval can be crossed without waiting.
 * `advance` walks forward timer by timer (each fires at its own time); `sleep` is a machine that was suspended: time jumps first, then everything due fires late.
 */
export function fakeClock(start: string | number) {
  let now = typeof start === "string" ? Date.parse(start) : start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const due = (until: number) => [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  const fire = (until: number, atOwnTime: boolean) => {
    for (let next = due(until); next; next = due(until)) {
      timers.delete(next[0]);
      if (atOwnTime) now = Math.max(now, next[1].at);
      next[1].fn();
    }
  };

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };

  return {
    clock,
    now: () => now,
    iso: () => new Date(now).toISOString(),
    /** Moves forward `ms`, firing each timer that falls inside at its own time. */
    advance(ms: number) {
      const target = now + ms;
      fire(target, true);
      now = target;
    },
    /** Time passes with nothing running (a laptop lid), then whatever was due fires, late. */
    sleep(ms: number) {
      now += ms;
      fire(now, false);
    },
    pending: () => timers.size,
  };
}
