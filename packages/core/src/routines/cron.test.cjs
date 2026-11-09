const assert = require("node:assert/strict");
const test = require("node:test");
const { everyToCron, nextRun, parseCron } = require("./cron.cjs");

// Epoch ms for a wall-clock time in a zone, found by scanning minutes around the guess.
function localEpoch(timeZone, y, mo, d, h, mi) {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const want = `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}, ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 1) {
    const t = guess + offset * 60_000;
    if (format.format(t) === want) return t;
  }
  throw new Error(`no such local time ${want} in ${timeZone}`);
}

test("parseCron expands lists, ranges and steps into sets", () => {
  const cron = parseCron("0,30 9-17/4 */10 1-3 1,7");
  assert.deepEqual([...cron.minute], [0, 30]);
  assert.deepEqual([...cron.hour], [9, 13, 17]);
  assert.deepEqual([...cron.dayOfMonth], [1, 11, 21, 31]);
  assert.deepEqual([...cron.month], [1, 2, 3]);
  assert.deepEqual([...cron.dayOfWeek].sort(), [0, 1]);
});

test("parseCron rejects malformed expressions", () => {
  for (const bad of [
    "61 * * * *",
    "* * *",
    "* * * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "a * * * *",
    "1,,2 * * * *",
    "",
  ]) {
    assert.throws(() => parseCron(bad), /Invalid cron/, bad);
  }
});

test("everyToCron converts minutes and hours", () => {
  assert.equal(everyToCron("15m"), "*/15 * * * *");
  assert.equal(everyToCron("1m"), "*/1 * * * *");
  assert.equal(everyToCron("30m"), "*/30 * * * *");
  assert.equal(everyToCron("60m"), "0 */1 * * *");
  assert.equal(everyToCron("120m"), "0 */2 * * *");
  assert.equal(everyToCron("2h"), "0 */2 * * *");
  assert.equal(everyToCron("12h"), "0 */12 * * *");
  assert.equal(everyToCron("24h"), "0 0 * * *");
});

test("everyToCron rejects anything else", () => {
  for (const bad of ["0m", "0h", "1.5h", "15", "15s", "1d", " 15m", "15m ", "-5m", "", "m"]) {
    assert.throws(() => everyToCron(bad), /Invalid every/, JSON.stringify(bad));
  }
});

const MINUTES_RULE = "Every N minutes must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)";
const HOURS_RULE = "Every N hours must divide 24 (1, 2, 3, 4, 6, 8, 12, 24)";

test("everyToCron takes only minutes that divide 60 and hours that divide 24", () => {
  for (const bad of ["7m", "45m", "59m", "61m", "90m"]) assert.throws(() => everyToCron(bad), { message: MINUTES_RULE }, bad);
  for (const bad of ["5h", "7h", "23h", "25h", "300m"]) assert.throws(() => everyToCron(bad), { message: HOURS_RULE }, bad);
});

// The times a cadence fires at over two days from midnight UTC, and the gaps between them.
function gaps(every) {
  const expression = everyToCron(every);
  let at = Date.UTC(2026, 9, 16) - 1;
  const fired = [];
  while (at < Date.UTC(2026, 9, 18)) fired.push((at = nextRun(expression, "UTC", at)));
  return new Set(fired.slice(1).map((t, index) => (t - fired[index]) / 60_000));
}

test("every accepted cadence fires at even gaps, across the hour and midnight", () => {
  for (const minutes of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]) assert.deepEqual(gaps(`${minutes}m`), new Set([minutes]), `${minutes}m`);
  for (const hours of [1, 2, 3, 4, 6, 8, 12, 24]) assert.deepEqual(gaps(`${hours}h`), new Set([hours * 60]), `${hours}h`);
  assert.deepEqual(gaps("120m"), new Set([120]));
});

test("nextRun finds the next quarter hour, strictly after", () => {
  assert.equal(nextRun("*/15 * * * *", "UTC", Date.UTC(2026, 9, 16, 10, 31)), Date.UTC(2026, 9, 16, 10, 45));
  assert.equal(nextRun("*/15 * * * *", "UTC", Date.UTC(2026, 9, 16, 10, 30)), Date.UTC(2026, 9, 16, 10, 45));
  // Seconds past the minute still move to the next whole minute.
  assert.equal(nextRun("* * * * *", "UTC", Date.UTC(2026, 9, 16, 10, 30, 59, 999)), Date.UTC(2026, 9, 16, 10, 31));
});

test("nextRun reads fields in the given time zone", () => {
  const zone = "America/Sao_Paulo";
  const fridayNine = localEpoch(zone, 2026, 10, 16, 9, 0);
  assert.equal(nextRun("30 8 * * 1-5", zone, fridayNine), localEpoch(zone, 2026, 10, 19, 8, 30));
});

test("nextRun combines day-of-month and day-of-week with OR", () => {
  // 2026-10-16 is a Friday. The 20th is a Tuesday, the next Monday is the 19th.
  const after = Date.UTC(2026, 9, 16, 12, 0);
  assert.equal(nextRun("0 9 20 * 1", "UTC", after), Date.UTC(2026, 9, 19, 9, 0));
  // With only one restricted, the other is a wildcard and both must hold.
  assert.equal(nextRun("0 9 20 * *", "UTC", after), Date.UTC(2026, 9, 20, 9, 0));
});

test("nextRun treats 7 as Sunday", () => {
  // 2026-10-16 is a Friday, so Sunday is the 18th.
  assert.equal(nextRun("0 0 * * 7", "UTC", Date.UTC(2026, 9, 16)), Date.UTC(2026, 9, 18));
});

test("nextRun keeps the local hour across the October DST change", () => {
  const zone = "Europe/Lisbon";
  let at = localEpoch(zone, 2026, 10, 24, 8, 30);
  const days = [];
  for (let i = 0; i < 3; i++) {
    at = nextRun("30 8 * * *", zone, at);
    days.push(at);
  }
  assert.deepEqual(days, [localEpoch(zone, 2026, 10, 25, 8, 30), localEpoch(zone, 2026, 10, 26, 8, 30), localEpoch(zone, 2026, 10, 27, 8, 30)]);
  // The clocks went back on the 25th, so that day is 25 hours long.
  assert.equal(days[1] - days[0], 24 * 3_600_000);
  assert.equal(days[0] - localEpoch(zone, 2026, 10, 24, 8, 30), 25 * 3_600_000);
});

test("nextRun skips a wall-clock time that falls in the spring gap", () => {
  const zone = "Europe/Lisbon";
  const after = localEpoch(zone, 2026, 3, 28, 1, 30);
  assert.equal(nextRun("30 1 * * *", zone, after), localEpoch(zone, 2026, 3, 30, 1, 30));
});

test("nextRun does not skip a day when the clock jumps two hours", () => {
  // Antarctica/Troll moves +00 to +02 on 2026-03-29, so a skip must not overshoot midnight.
  assert.equal(nextRun("30 0 * * 1", "Antarctica/Troll", Date.UTC(2026, 2, 29, 0, 30)), localEpoch("Antarctica/Troll", 2026, 3, 30, 0, 30));
});

test("nextRun fires once when a wall-clock minute repeats in the autumn", () => {
  const zone = "Europe/Lisbon";
  // 01:30 happens twice on 2026-10-25; the first one is 00:30 UTC.
  const first = Date.UTC(2026, 9, 25, 0, 30);
  assert.equal(nextRun("30 1 * * *", zone, Date.UTC(2026, 9, 24, 12, 0)), first);
  assert.equal(nextRun("30 1 * * *", zone, first), localEpoch(zone, 2026, 10, 26, 1, 30));
});

test("nextRun finds a leap day within the year cap", () => {
  assert.equal(nextRun("0 0 29 2 *", "UTC", Date.UTC(2027, 2, 1)), Date.UTC(2028, 1, 29));
});

test("nextRun finds a leap day more than a year away", () => {
  // Made in March 2028, just after a leap day: the next one is four years on.
  const started = performance.now();
  assert.equal(nextRun("0 0 29 2 *", "UTC", Date.UTC(2028, 2, 1, 12, 0)), Date.UTC(2032, 1, 29));
  assert.equal(nextRun("0 0 29 2 *", "America/Sao_Paulo", Date.UTC(2028, 2, 1, 12, 0)), localEpoch("America/Sao_Paulo", 2032, 2, 29, 0, 0));
  assert.ok(performance.now() - started < 200, "skips whole days and months");
});

test("nextRun throws, quickly, when nothing matches within 8 years", () => {
  const started = performance.now();
  assert.throws(() => nextRun("0 0 31 2 *", "UTC", Date.UTC(2026, 0, 1)), { message: "No run within 8 years" });
  assert.throws(() => nextRun("0 0 30 2 *", "Europe/Lisbon", Date.UTC(2026, 0, 1)), { message: "No run within 8 years" });
  assert.ok(performance.now() - started < 200, "skips whole days and months");
});

test("a minute cadence still answers fast and exactly", () => {
  const started = performance.now();
  let at = Date.UTC(2026, 9, 16, 10, 0, 30);
  for (let index = 0; index < 1000; index += 1) {
    const next = nextRun("* * * * *", "Europe/Lisbon", at);
    assert.equal(next, Math.floor(at / 60_000) * 60_000 + 60_000);
    at = next;
  }
  assert.ok(performance.now() - started < 1000);
});

test("nextRun rejects bad expressions and unknown time zones", () => {
  assert.throws(() => nextRun("61 * * * *", "UTC", 0), /Invalid cron/);
  assert.throws(() => nextRun("* * * * *", "Mars/Base", 0), /Invalid cron/);
});
