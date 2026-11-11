//! Pure, bounded port of the production routine cron helpers.
//! No timers, host access, process execution, timezone discovery or production registration.
//!
//! Epochs are integer milliseconds. Non-finite/fractional JS numeric coercions are not exposed:
//! ```compile_fail
//! let _ = milagre_routines::next_run("* * * * *", "UTC", f64::INFINITY);
//! ```
mod cron;
mod schedule;
mod zone;
pub use cron::{every_to_cron, parse_cron, Cron};
pub use schedule::{next_run, MAX_AFTER_MS, MIN_AFTER_MS};

pub const MAX_INPUT_BYTES: usize = 4096;
pub const MAX_ZONE_BYTES: usize = 128;
pub const TZDB_VERSION: &str = "2025b";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidCron(String),
    InvalidEvery(String),
    MinutesRule,
    HoursRule,
    NoRun,
    Bounds(&'static str),
    Timestamp,
    TimeZoneData,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCron(reason) => write!(f, "Invalid cron: {reason}"),
            Self::InvalidEvery(value) => write!(
                f,
                "Invalid every: {} (use e.g. 15m or 2h)",
                serde_json::to_string(value).map_err(|_| std::fmt::Error)?
            ),
            Self::MinutesRule => {
                f.write_str("Every N minutes must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)")
            }
            Self::HoursRule => {
                f.write_str("Every N hours must divide 24 (1, 2, 3, 4, 6, 8, 12, 24)")
            }
            Self::NoRun => f.write_str("No run within 8 years"),
            Self::Bounds(reason) => write!(f, "Routine cron bound: {reason}"),
            Self::Timestamp => f.write_str("Routine cron timestamp is outside the supported range"),
            Self::TimeZoneData => f.write_str("Routine cron timezone database mismatch"),
        }
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;
