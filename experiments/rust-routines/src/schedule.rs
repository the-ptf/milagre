use crate::{parse_cron, zone, Error, Result};
use jiff::{civil::Date, tz::TimeZone, Timestamp};
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// 1900-01-02T00:00:00Z. Earlier JS Date/ICU historical domains are not accepted.
pub const MIN_AFTER_MS: i64 = -2_208_902_400_000;
/// 9990-12-30T23:59:59.999Z. Leaves room for the full inclusive eight-year search.
pub const MAX_AFTER_MS: i64 = 253_118_217_599_999;
struct Wall {
    date: Date,
    as_utc: i64,
    offset: i64,
}
fn utc(date: Date, hour: i8, minute: i8) -> Result<i64> {
    Ok(TimeZone::UTC
        .to_timestamp(date.at(hour, minute, 0, 0))
        .map_err(|_| Error::Timestamp)?
        .as_millisecond())
}
fn read(zone: &TimeZone, epoch: i64) -> Result<Wall> {
    let wall = zone.to_datetime(Timestamp::from_millisecond(epoch).map_err(|_| Error::Timestamp)?);
    let as_utc = utc(wall.date(), wall.hour(), wall.minute())?;
    Ok(Wall {
        date: wall.date(),
        as_utc,
        offset: as_utc - epoch.div_euclid(MINUTE) * MINUTE,
    })
}
fn first_instant(zone: &TimeZone, wall_utc: i64) -> Result<Option<i64>> {
    let guess = wall_utc - read(zone, wall_utc)?.offset;
    let mut instants = [
        wall_utc - read(zone, guess - 6 * HOUR)?.offset,
        wall_utc - read(zone, guess + 6 * HOUR)?.offset,
    ];
    instants.sort_unstable();
    for instant in instants {
        if read(zone, instant)?.as_utc == wall_utc {
            return Ok(Some(instant));
        }
    }
    Ok(None)
}
/// Finds the first whole minute strictly after `after_ms`, using Node's calendar,
/// six-hour offset sampling, skipped-gap and first-occurrence-only repeat rules.
pub fn next_run(expression: &str, time_zone: &str, after_ms: i64) -> Result<i64> {
    let cron = parse_cron(expression)?;
    let zone = zone::get(time_zone)?;
    if !(MIN_AFTER_MS..=MAX_AFTER_MS).contains(&after_ms) {
        return Err(Error::Timestamp);
    }
    let start = after_ms.div_euclid(MINUTE) * MINUTE + MINUTE;
    let from = read(&zone, start)?;
    let mut hours = cron.hour().to_vec();
    hours.sort_unstable();
    let mut minutes = cron.minute().to_vec();
    minutes.sort_unstable();
    let mut day = utc(from.date, 0, 0)?;
    // JS Date.UTC normalizes February 29 in a non-leap cap year to March 1.
    let last = utc(
        Date::new(from.date.year() + 8, from.date.month(), 1).map_err(|_| Error::Timestamp)?,
        0,
        0,
    )? + i64::from(from.date.day() - 1) * DAY;
    while day <= last {
        let date = read(&TimeZone::UTC, day)?.date;
        if !cron.month().contains(&(date.month() as u8)) {
            let (year, month) = if date.month() == 12 {
                (date.year() + 1, 1)
            } else {
                (date.year(), date.month() + 1)
            };
            day = utc(
                Date::new(year, month, 1).map_err(|_| Error::Timestamp)?,
                0,
                0,
            )?;
            continue;
        }
        let dom = cron.day_of_month().contains(&(date.day() as u8));
        let dow = cron
            .day_of_week()
            .contains(&(date.weekday().to_sunday_zero_offset() as u8));
        let matches = if cron.day_of_month().len() < 31 && cron.day_of_week().len() < 7 {
            dom || dow
        } else {
            dom && dow
        };
        if matches {
            for hour in &hours {
                for minute in &minutes {
                    let wall_utc = day + i64::from(*hour) * HOUR + i64::from(*minute) * MINUTE;
                    if wall_utc < from.as_utc {
                        continue;
                    }
                    if let Some(instant) = first_instant(&zone, wall_utc)? {
                        if instant >= start {
                            return Ok(instant);
                        }
                    }
                }
            }
        }
        day += DAY;
    }
    Err(Error::NoRun)
}
