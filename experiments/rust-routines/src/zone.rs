use crate::{Error, Result, MAX_ZONE_BYTES, TZDB_VERSION};
use jiff::tz::{Offset, TimeZone};
#[path = "zones.rs"]
mod names;

pub(crate) fn get(name: &str) -> Result<TimeZone> {
    if name.len() > MAX_ZONE_BYTES {
        return Err(Error::Bounds("timezone exceeds 128 bytes"));
    }
    if jiff_tzdb::VERSION != Some(TZDB_VERSION) {
        return Err(Error::TimeZoneData);
    }
    let unknown = || Error::InvalidCron(format!("unknown timezone {name}"));
    if name.starts_with(['+', '-']) {
        let bytes = name.as_bytes();
        let (hour, minute) = match bytes.len() {
            3 => (name.get(1..3), Some("00")),
            5 => (name.get(1..3), name.get(3..5)),
            6 if bytes[3] == b':' => (name.get(1..3), name.get(4..6)),
            _ => return Err(unknown()),
        };
        let parse = |text: Option<&str>| {
            text.filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|v| v.parse::<i32>().ok())
        };
        let (hour, minute) = (
            parse(hour).ok_or_else(unknown)?,
            parse(minute).ok_or_else(unknown)?,
        );
        if hour > 23 || minute > 59 {
            return Err(unknown());
        }
        let seconds = (hour * 60 + minute) * 60 * if bytes[0] == b'-' { -1 } else { 1 };
        return Ok(TimeZone::fixed(
            Offset::from_seconds(seconds).map_err(|_| unknown())?,
        ));
    }
    let lookup = name.to_ascii_lowercase();
    let index = names::NAMES
        .binary_search_by_key(&lookup.as_str(), |(key, _)| *key)
        .map_err(|_| unknown())?;
    let (_, canonical) = names::NAMES[index];
    let (canonical, data) = jiff_tzdb::get(canonical).ok_or(Error::TimeZoneData)?;
    TimeZone::tzif(canonical, data).map_err(|_| Error::TimeZoneData)
}
