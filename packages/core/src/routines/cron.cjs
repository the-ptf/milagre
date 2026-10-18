const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// A leap day can be 8 years away (2096 to 2104 skips one), so the search looks that far ahead.
const SEARCH_YEARS = 8;
// Fixed cadences that fire at even gaps all day: minutes that divide an hour, hours that divide a day.
const EVERY_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
const MINUTES_RULE = `Every N minutes must divide 60 (${EVERY_MINUTES.join(", ")})`;
const HOURS_RULE = `Every N hours must divide 24 (${EVERY_HOURS.join(", ")})`;

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is Sunday as well; it folds into 0 after parsing.
  { name: "dayOfWeek", min: 0, max: 7 },
];

function invalid(reason) {
  return new Error(`Invalid cron: ${reason}`);
}

function parseNumber(text, field) {
  if (!/^\d+$/.test(text)) throw invalid(`${field.name} has "${text}"`);
  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw invalid(`${field.name} ${value} is outside ${field.min}-${field.max}`);
  }
  return value;
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined || range === "") throw invalid(`${field.name} has "${part}"`);
    let stride = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) throw invalid(`${field.name} step "${step}"`);
      stride = Number(step);
    }
    let from;
    let to;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [low, high, more] = range.split("-");
      if (more !== undefined) throw invalid(`${field.name} has "${part}"`);
      from = parseNumber(low, field);
      to = parseNumber(high, field);
      if (from > to) throw invalid(`${field.name} range "${range}" runs backwards`);
    } else {
      if (step !== undefined) throw invalid(`${field.name} step needs a range, got "${part}"`);
      from = to = parseNumber(range, field);
    }
    for (let value = from; value <= to; value += stride) values.add(value);
  }
  return values;
}

function parseCron(expr) {
  if (typeof expr !== "string") throw invalid("expected a string");
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    throw invalid(`expected 5 fields, got ${expr.trim() === "" ? 0 : parts.length}`);
  }
  const cron = {};
  FIELDS.forEach((field, index) => {
    cron[field.name] = parseField(parts[index], field);
  });
  if (cron.dayOfWeek.delete(7)) cron.dayOfWeek.add(0);
  return cron;
}

function everyToCron(every) {
  const match = typeof every === "string" ? /^([1-9]\d*)([mh])$/.exec(every) : null;
  if (!match) throw new Error(`Invalid every: ${JSON.stringify(every)} (use e.g. 15m or 2h)`);
  let amount = Number(match[1]);
  let unit = match[2];
  // Whole hours given in minutes are hours. Anything else uneven would fire at :00 and again at :59 (59m), or leave
  // a short gap at midnight (23h).
  if (unit === "m" && amount >= 60 && amount % 60 === 0) {
    amount /= 60;
    unit = "h";
  }
  if (unit === "m") {
    if (!EVERY_MINUTES.includes(amount)) throw new Error(MINUTES_RULE);
    return `*/${amount} * * * *`;
  }
  if (!EVERY_HOURS.includes(amount)) throw new Error(HOURS_RULE);
  return amount === 24 ? "0 0 * * *" : `0 */${amount} * * *`;
}

function wallClock(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw invalid(`unknown timezone ${timeZone}`);
  }
  return (epoch) => {
    const fields = {};
    for (const part of format.formatToParts(epoch)) {
      if (part.type !== "literal") fields[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
    return {
      year: fields.year,
      minute: fields.minute,
      hour: fields.hour,
      dayOfMonth: fields.day,
      month: fields.month,
      dayOfWeek: new Date(asUtc).getUTCDay(),
      // The wall clock read as if it were UTC: equal for two instants showing the same time.
      asUtc,
      offset: asUtc - Math.floor(epoch / MINUTE_MS) * MINUTE_MS,
    };
  };
}

function dayMatches(cron, wall) {
  if (!cron.month.has(wall.month)) return false;
  const dom = cron.dayOfMonth.has(wall.dayOfMonth);
  const dow = cron.dayOfWeek.has(wall.dayOfWeek);
  // Like Vixie cron: when both day fields are restricted, either one is enough.
  const domRestricted = cron.dayOfMonth.size < 31;
  const dowRestricted = cron.dayOfWeek.size < 7;
  return domRestricted && dowRestricted ? dom || dow : dom && dow;
}

// The first instant the zone's clock shows `wallUtc` (a wall-clock time read as if it were UTC), or null when the clock
// skips it (the spring gap). A time shown twice after clocks go back gives the first of the two.
function firstInstant(read, wallUtc) {
  // Within 6 hours either side of a rough guess lie both offsets of any change near that time.
  const guess = wallUtc - read(wallUtc).offset;
  const offsets = new Set([read(guess - 6 * HOUR_MS).offset, read(guess + 6 * HOUR_MS).offset]);
  const instants = [...offsets].map((offset) => wallUtc - offset).sort((a, b) => a - b);
  return instants.find((instant) => read(instant).asUtc === wallUtc) ?? null;
}

const ascending = (values) => [...values].sort((a, b) => a - b);

function nextRun(expr, timeZone, after) {
  const cron = parseCron(expr);
  const read = wallClock(timeZone);
  const start = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const from = read(start);
  const hours = ascending(cron.hour);
  const minutes = ascending(cron.minute);
  // Walks the calendar day by day (a month at a time through months that can't match) with plain date arithmetic, and
  // asks the zone only about the times a matching day lists.
  let day = Date.UTC(from.year, from.month - 1, from.dayOfMonth);
  const lastDay = Date.UTC(from.year + SEARCH_YEARS, from.month - 1, from.dayOfMonth);
  while (day <= lastDay) {
    const date = new Date(day);
    const month = date.getUTCMonth() + 1;
    if (!cron.month.has(month)) {
      day = Date.UTC(date.getUTCFullYear(), month, 1);
      continue;
    }
    if (dayMatches(cron, { month, dayOfMonth: date.getUTCDate(), dayOfWeek: date.getUTCDay() })) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const wallUtc = day + hour * HOUR_MS + minute * MINUTE_MS;
          // A wall time before the start's was shown before it (or skipped), so it can't come next.
          if (wallUtc < from.asUtc) continue;
          const instant = firstInstant(read, wallUtc);
          // A time first shown before the start doesn't fire again when the clock repeats it.
          if (instant !== null && instant >= start) return instant;
        }
      }
    }
    day += DAY_MS;
  }
  throw new Error(`No run within ${SEARCH_YEARS} years`);
}

module.exports = { everyToCron, nextRun, parseCron };
