//! Dates the usage logic needs without a date crate: `Date.parse` for ISO 8601 strings, an ISO printer, and local
//! time through a [`Zone`] the caller supplies (the app asks the OS; tests pass fixed offsets).
//!
//! Formats follow what the TypeScript gets from `toLocaleTimeString(undefined, ...)` in an English locale:
//! "4:10 PM", "Thu 4:10 PM" and, for `Intl.DateTimeFormat` with `hourCycle: "h23"`, "Thu 16:10". Other locales
//! are not reproduced. The space before AM or PM is an ASCII space (newer ICU prints U+202F there).

pub const MINUTE: i64 = 60_000;
pub const HOUR: i64 = 60 * MINUTE;
pub const DAY: i64 = 24 * HOUR;

/// A time zone: the offset from UTC at a moment, in minutes east of UTC.
pub trait Zone {
    fn offset_minutes(&self, utc_ms: i64) -> i32;
}

/// A zone that never changes offset (UTC is `FixedZone(0)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedZone(pub i32);

impl Zone for FixedZone {
    fn offset_minutes(&self, _utc_ms: i64) -> i32 {
        self.0
    }
}

/// This computer's zone, asked of the OS at each moment (daylight saving included). Off Unix it is UTC.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SystemZone;

impl Zone for SystemZone {
    fn offset_minutes(&self, utc_ms: i64) -> i32 {
        #[cfg(unix)]
        {
            let seconds = utc_ms.div_euclid(1000) as libc::time_t;
            // SAFETY: `localtime_r` writes only into the `tm` it is given and reads the `time_t` by reference.
            let mut local: libc::tm = unsafe { std::mem::zeroed() };
            if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
                return 0;
            }
            (local.tm_gmtoff / 60) as i32
        }
        #[cfg(not(unix))]
        {
            let _ = utc_ms;
            0
        }
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (`month` 1 to 12).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date of a day count since 1970-01-01: (year, month 1 to 12, day).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Milliseconds since the epoch of a wall-clock time at a fixed UTC offset (`new Date(y, m, d, h, mi)` in a zone
/// whose offset is `offset_minutes`; `month` is 1 to 12 here, not 0 to 11).
pub fn epoch_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, offset_minutes: i32) -> i64 {
    ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute - i64::from(offset_minutes)) * MINUTE
}

/// `Date.parse` for ISO 8601: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, then optionally `THH:MM[:SS[.fff]]` and `Z` or
/// `±HH:MM`. A date alone and a time without an offset are read as UTC (JavaScript reads the latter as local time;
/// the host always sends `Z`). Anything else is `None` (JavaScript's `NaN`).
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let digits = |at: &mut usize, count: usize| -> Option<i64> {
        let slice = bytes.get(*at..*at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *at += count;
        std::str::from_utf8(slice).ok()?.parse().ok()
    };
    let eat = |at: &mut usize, byte: u8| -> bool {
        if bytes.get(*at) == Some(&byte) {
            *at += 1;
            true
        } else {
            false
        }
    };
    let year = digits(&mut at, 4)?;
    let mut month = 1;
    let mut day = 1;
    if eat(&mut at, b'-') {
        month = digits(&mut at, 2)?;
        if eat(&mut at, b'-') {
            day = digits(&mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    let mut offset = 0;
    if at < bytes.len() {
        if !(eat(&mut at, b'T') || eat(&mut at, b' ')) {
            return None;
        }
        hour = digits(&mut at, 2)?;
        if !eat(&mut at, b':') {
            return None;
        }
        minute = digits(&mut at, 2)?;
        if eat(&mut at, b':') {
            second = digits(&mut at, 2)?;
            if eat(&mut at, b'.') {
                let start = at;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
                if at == start {
                    return None;
                }
                let fraction = &text[start..at];
                let first3: String = fraction.chars().chain("00".chars()).take(3).collect();
                millis = first3.parse().ok()?;
            }
        }
        if eat(&mut at, b'Z') {
        } else if bytes.get(at).is_some_and(|b| *b == b'+' || *b == b'-') {
            let sign = if bytes[at] == b'-' { -1 } else { 1 };
            at += 1;
            let offset_hour = digits(&mut at, 2)?;
            eat(&mut at, b':');
            let offset_minute = digits(&mut at, 2)?;
            offset = sign * (offset_hour * 60 + offset_minute) as i32;
        }
        if at != bytes.len() {
            return None;
        }
        if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute, second, millis) != (0, 0, 0)) {
            return None;
        }
    }
    Some(epoch_ms(year, month, day, hour, minute, offset) + second * 1000 + millis)
}

/// `new Date(ms).toISOString()`.
pub fn format_iso(ms: i64) -> String {
    let days = ms.div_euclid(DAY);
    let rest = ms.rem_euclid(DAY);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / HOUR, rest % HOUR / MINUTE, rest % MINUTE / 1000, rest % 1000)
}

/// A moment as the clock on the wall shows it in a zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i64,
    /// 1 to 12.
    pub month: i64,
    pub day: i64,
    /// 0 is Sunday, as `Date.getDay`.
    pub weekday: i64,
    pub hour: i64,
    pub minute: i64,
}

pub fn local_time(utc_ms: i64, zone: &dyn Zone) -> LocalTime {
    let shifted = utc_ms + i64::from(zone.offset_minutes(utc_ms)) * MINUTE;
    let days = shifted.div_euclid(DAY);
    let rest = shifted.rem_euclid(DAY);
    let (year, month, day) = civil_from_days(days);
    LocalTime { year, month, day, weekday: (days + 4).rem_euclid(7), hour: rest / HOUR, minute: rest % HOUR / MINUTE }
}

impl LocalTime {
    pub fn same_day(&self, other: &LocalTime) -> bool {
        (self.year, self.month, self.day) == (other.year, other.month, other.day)
    }

    /// "Thu".
    pub fn weekday_short(&self) -> &'static str {
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][self.weekday as usize]
    }

    /// `toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })` in en-US: "4:10 PM".
    pub fn time_12h(&self) -> String {
        let hour = match self.hour % 12 {
            0 => 12,
            h => h,
        };
        format!("{hour}:{:02} {}", self.minute, if self.hour < 12 { "AM" } else { "PM" })
    }

    /// `Intl.DateTimeFormat` with `hour: "2-digit", minute: "2-digit", hourCycle: "h23"`: "16:10".
    pub fn time_24h(&self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }
}

/// `todayKey`: the local calendar day as the token usage report names days ("2026-11-08").
pub fn day_key(utc_ms: i64, zone: &dyn Zone) -> String {
    let local = local_time(utc_ms, zone);
    format!("{:04}-{:02}-{:02}", local.year, local.month, local.day)
}

/// Whether the text parses (`Number.isFinite(Date.parse(text))`).
pub fn is_date(text: &str) -> bool {
    parse_iso_ms(text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_zone_is_a_real_offset_that_matches_the_os() {
        // Any real zone is within UTC-12 to UTC+14, in whole minutes; it agrees with itself across a call.
        let now = epoch_ms(2026, 11, 12, 12, 0, 0);
        let offset = SystemZone.offset_minutes(now);
        assert!((-12 * 60..=14 * 60).contains(&offset), "{offset}");
        assert_eq!(offset, SystemZone.offset_minutes(now));
        // Local time through it is UTC shifted by that offset.
        let local = local_time(now, &SystemZone);
        let shifted = local_time(now, &FixedZone(offset));
        assert_eq!((local.hour, local.minute, local.day), (shifted.hour, shifted.minute, shifted.day));
    }

    #[test]
    fn civil_dates_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 10, 13), 20_739);
        for days in [-1000, 0, 1, 59, 60, 365, 11_016, 20_739, 30_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(20_739), (2026, 10, 13));
    }

    #[test]
    fn iso_strings_parse_like_date_parse() {
        assert_eq!(parse_iso_ms("2026-11-08T12:00:00Z"), Some(1_794_139_200_000));
        assert_eq!(parse_iso_ms("2026-11-08T12:00:00.000Z"), Some(1_794_139_200_000));
        assert_eq!(parse_iso_ms("2026-11-08T12:00:00.5Z"), Some(1_794_139_200_500));
        assert_eq!(parse_iso_ms("2026-11-08T14:00:00+02:00"), Some(1_794_139_200_000));
        assert_eq!(parse_iso_ms("2026-11-08T12:00Z"), Some(1_794_139_200_000));
        assert_eq!(parse_iso_ms("2026-11-08"), Some(1_794_096_000_000));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("not a date"), None);
        assert_eq!(parse_iso_ms(""), None);
        assert_eq!(parse_iso_ms("2026-13-01"), None);
        assert_eq!(parse_iso_ms("2026-11-08T25:00:00Z"), None);
        assert_eq!(parse_iso_ms("2026-11-08T12:00:00Zjunk"), None);
    }

    #[test]
    fn iso_printing_matches_to_iso_string() {
        assert_eq!(format_iso(1_794_139_200_500), "2026-11-08T12:00:00.500Z");
        assert_eq!(format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(parse_iso_ms(&format_iso(1_794_139_201_234)), Some(1_794_139_201_234));
    }

    #[test]
    fn local_time_follows_the_zone() {
        let at = epoch_ms(2026, 10, 13, 23, 30, 0);
        let utc = local_time(at, &FixedZone(0));
        assert_eq!((utc.day, utc.hour, utc.minute, utc.weekday_short()), (13, 23, 30, "Tue"));
        let tokyo = local_time(at, &FixedZone(9 * 60));
        assert_eq!((tokyo.day, tokyo.hour, tokyo.weekday_short()), (14, 8, "Wed"));
        let la = local_time(at, &FixedZone(-8 * 60));
        assert_eq!((la.day, la.hour, la.weekday_short()), (13, 15, "Tue"));
        assert_eq!(day_key(at, &FixedZone(9 * 60)), "2026-10-14");
        assert_eq!(day_key(epoch_ms(2026, 1, 3, 0, 1, -300), &FixedZone(-300)), "2026-01-03");
    }

    #[test]
    fn twelve_and_twenty_four_hour_clocks() {
        let t = |h: i64, m: i64| local_time(epoch_ms(2026, 10, 13, h, m, 0), &FixedZone(0));
        assert_eq!(t(16, 10).time_12h(), "4:10 PM");
        assert_eq!(t(0, 5).time_12h(), "12:05 AM");
        assert_eq!(t(12, 0).time_12h(), "12:00 PM");
        assert_eq!(t(9, 7).time_24h(), "09:07");
    }
}
