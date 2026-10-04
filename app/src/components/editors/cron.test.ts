// Run with: node --test src/components/editors/*.test.ts   (from app/; Node 22.18+ strips the types)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRON_PRESETS, CUSTOM_SCHEDULE, checkCron, isTimezone } from "./cron.ts";

const say = (expr: string) => {
  const r = checkCron(expr);
  assert.ok(r.ok, `${expr} should be valid: ${r.ok ? "" : r.error}`);
  return r.description;
};
const bad = (expr: string) => {
  const r = checkCron(expr);
  assert.ok(!r.ok, `${expr} should be rejected`);
  return r.error;
};

describe("describing", () => {
  it("describes the presets", () => {
    assert.deepEqual(CRON_PRESETS.map((p) => say(p.cron)), ["Every hour, on the hour", "Every day at 09:00", "Every weekday at 09:00", "Every Monday at 08:00", "Every 15 minutes"]);
  });

  it("handles steps, lists, ranges and names", () => {
    assert.equal(say("* * * * *"), "Every minute");
    assert.equal(say("*/5 * * * *"), "Every 5 minutes");
    assert.equal(say("0,15,30,45 * * * *"), "Every 15 minutes");
    assert.equal(say("0,30 * * * *"), "Every 30 minutes");
    assert.equal(say("10,40 * * * *"), "Every hour at minutes 10 and 40");
    assert.equal(say("15 * * * *"), "Every hour at minute 15");
    assert.equal(say("0 */6 * * *"), "Every 6 hours");
    assert.equal(say("30 */6 * * *"), "Every 6 hours at minute 30");
    assert.equal(say("0 9,12,15 * * *"), "Every day at 09:00, 12:00 and 15:00");
    assert.equal(say("0,30 9 * * *"), "Every day at 09:00 and 09:30");
    assert.equal(say("0 9-17 * * 1-5"), "Every hour from 09:00 to 17:00 on weekdays");
    assert.equal(say("*/15 9-17 * * *"), "Every 15 minutes from 09:00 to 17:45");
    assert.equal(say("* 9 * * *"), "Every minute from 09:00 to 09:59");
    assert.equal(say("0 9 * * MON-FRI"), "Every weekday at 09:00");
    assert.equal(say("0 9 * * mon,wed,fri"), "Every Monday, Wednesday and Friday at 09:00");
    assert.equal(say("0 9 * * SAT,SUN"), "Every Saturday and Sunday at 09:00");
    assert.equal(say("0 9 * * 0"), "Every Sunday at 09:00");
    assert.equal(say("0 9 * * 7"), "Every Sunday at 09:00");
    assert.equal(say("0 9 * * FRI-SUN"), "Friday to Sunday at 09:00");
    assert.equal(say("0 9 * * 1-3"), "Monday to Wednesday at 09:00");
    assert.equal(say("0 0 1 * *"), "On the 1st of every month at 00:00");
    assert.equal(say("0 8 1,15 * *"), "On the 1st and 15th of every month at 08:00");
    assert.equal(say("0 8 1-7 * *"), "On days 1 to 7 of every month at 08:00");
    assert.equal(say("0 0 1 JAN *"), "On the 1st of January at 00:00");
    assert.equal(say("0 9 * 3 *"), "Every day in March at 09:00");
    assert.equal(say("0 9 * 1,6 MON"), "Every Monday in January and June at 09:00");
    assert.equal(say("0 9 * 3-5 *"), "Every day from March to May at 09:00");
    assert.equal(say("*/20 * * * 1-5"), "Every 20 minutes on weekdays");
    assert.equal(say("0 * * 12 *"), "Every hour, on the hour in December");
  });

  it("treats a field that merely covers everything as every", () => {
    assert.equal(say("0 9 1-31 * *"), "Every day at 09:00");
    assert.equal(say("0 9 * * 0-6"), "Every day at 09:00");
    assert.equal(say("0-59 * * * *"), "Every minute");
  });

  it("says custom schedule instead of guessing", () => {
    assert.equal(say("*/7 * * * *"), CUSTOM_SCHEDULE); // 56 -> 0 is 4 minutes: not "every 7 minutes"
    assert.equal(say("0 */5 * * *"), "Every day at 00:00, 05:00, 10:00, 15:00 and 20:00");
    assert.equal(say("0 9 15 * 1"), CUSTOM_SCHEDULE); // day of month AND weekday means either in cron
    assert.equal(say("0 9 1-31 * 1"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 L * *"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 15W * *"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 * * 5#2"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 * * ?"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 LW * *"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 * * 5L"), CUSTOM_SCHEDULE);
    assert.equal(say("0 9 * * +1"), CUSTOM_SCHEDULE);
    assert.equal(say("1,2,3,4,5 * * * *"), CUSTOM_SCHEDULE);
    assert.equal(say("5,10 9,13,17 * * *"), "Every day at 09:05, 09:10, 13:05, 13:10, 17:05 and 17:10");
    assert.equal(say("0 9 1,5,9,13,17,21 * *"), CUSTOM_SCHEDULE);
    assert.equal(say("*/10 8-18/2 * * *"), CUSTOM_SCHEDULE);
  });

  it("ignores extra whitespace", () => {
    assert.equal(say("  0   9  *  *  1-5 "), "Every weekday at 09:00");
  });
});

describe("validating", () => {
  it("needs exactly five fields", () => {
    assert.match(bad("0 9 * *"), /Five fields/);
    assert.match(bad("0 0 9 * * *"), /Five fields/);
    assert.match(bad(""), /Five fields/);
  });

  it("rejects out-of-range values with the field name", () => {
    assert.match(bad("60 * * * *"), /minute: 60 is outside 0-59/);
    assert.match(bad("0 24 * * *"), /hour: 24 is outside 0-23/);
    assert.match(bad("0 9 0 * *"), /day of month: 0 is outside 1-31/);
    assert.match(bad("0 9 32 * *"), /day of month: 32/);
    assert.match(bad("0 9 * 13 *"), /month: 13 is outside 1-12/);
    assert.match(bad("0 9 * * 8"), /weekday: 8 is outside 0-7/);
  });

  it("rejects malformed steps, ranges and lists", () => {
    assert.match(bad("*/0 * * * *"), /step of 0/);
    assert.match(bad("*/61 * * * *"), /larger than the field/);
    assert.match(bad("5/15 * * * *"), /needs \*\/15 or a range/);
    assert.match(bad("0 17-9 * * *"), /runs backwards/);
    assert.match(bad("0 9 * * 1,,3"), /empty entry/);
    assert.match(bad("0 9 * * 1,"), /empty entry/);
    assert.match(bad("0 -5 * * *"), /not a number/);
    assert.match(bad("0 5- * * *"), /not a number/);
    assert.match(bad("a * * * *"), /characters cron does not accept/);
    assert.match(bad("0 9 * * Monday"), /characters cron does not accept/);
    assert.match(bad("L * * * *"), /characters cron does not accept/);
    assert.match(bad("0 9 * * L"), /characters cron does not accept/);
    assert.match(bad("0 9 32W * *"), /day of month: 32/);
    assert.match(bad("0 9 * * 5#6"), /characters cron does not accept/);
  });

  it("accepts the edge values", () => {
    for (const e of ["59 23 31 12 7", "0 0 1 1 0", "*/60 * * * *", "0 0 * * 0,7"]) assert.ok(checkCron(e).ok, e);
  });
});

describe("timezones", () => {
  it("accepts IANA names and rejects the rest", () => {
    assert.ok(isTimezone("Europe/Stockholm"));
    assert.ok(isTimezone("UTC"));
    assert.ok(!isTimezone("Mars/Olympus"));
    assert.ok(!isTimezone("not a zone"));
  });
});
