//! The two time formats of `packages/shared/src/display-clock.ts`. The file's `createDisplayClock` (one shared
//! interval that stops while the window is hidden) is not ported: the GPUI app drives repaints with its own
//! timers, and a clock that only schedules callbacks has no output to port.

/// Remaining time, rounded up so a live request never reads 0:00 before its deadline: "5:00", "0:01".
pub fn format_countdown(ms: f64) -> String {
    let seconds = (ms.max(0.0) / 1000.0).ceil() as u64;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// Whole seconds for live elapsed labels; finished durations keep their own rounding rules: "59s", "1m 05s",
/// "2h 13m 05s".
pub fn format_elapsed(ms: f64) -> String {
    let seconds = (ms.max(0.0) / 1000.0).floor() as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {:02}s", seconds % 60);
    }
    format!("{}h {:02}m {:02}s", minutes / 60, minutes % 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_elapsed_labels_floor_seconds_clamp_negatives_and_pad_smaller_units() {
        for (ms, label) in [
            (-5.0, "0s"),
            (0.0, "0s"),
            (999.0, "0s"),
            (1000.0, "1s"),
            (59_999.0, "59s"),
            (60_000.0, "1m 00s"),
            (61_000.0, "1m 01s"),
            (3_599_999.0, "59m 59s"),
            (3_600_000.0, "1h 00m 00s"),
            (7_985_000.0, "2h 13m 05s"),
        ] {
            assert_eq!(format_elapsed(ms), label, "{ms} ms");
        }
    }

    #[test]
    fn countdown_rounds_up_at_second_boundaries_and_stops_at_zero() {
        assert_eq!(format_countdown(300_000.0), "5:00");
        assert_eq!(format_countdown(299_999.0), "5:00");
        assert_eq!(format_countdown(299_000.0), "4:59");
        assert_eq!(format_countdown(1.0), "0:01");
        assert_eq!(format_countdown(0.0), "0:00");
        assert_eq!(format_countdown(-1000.0), "0:00");
    }
}
