use jiff::Timestamp;
use milagre_routines::{
    every_to_cron, next_run, parse_cron, Error, MAX_AFTER_MS, MAX_INPUT_BYTES, MIN_AFTER_MS,
};
fn epoch(text: &str) -> i64 {
    text.parse::<Timestamp>().unwrap().as_millisecond()
}
fn next(expr: &str, zone: &str, after: &str) -> i64 {
    next_run(expr, zone, epoch(after)).unwrap()
}

#[test]
fn lists_ranges_stride_and_js_set_order_are_preserved() {
    let c = parse_cron("0,30 9-17/4 */10 1-3 1,7").unwrap();
    assert_eq!(c.minute(), [0, 30]);
    assert_eq!(c.hour(), [9, 13, 17]);
    assert_eq!(c.day_of_month(), [1, 11, 21, 31]);
    assert_eq!(c.month(), [1, 2, 3]);
    assert_eq!(c.day_of_week(), [1, 0]);
    assert_eq!(parse_cron("59,0,59 0 * * 7,1,0").unwrap().minute(), [59, 0]);
    assert_eq!(parse_cron("0 0 * * 7,1,0").unwrap().day_of_week(), [1, 0]);
}
#[test]
fn very_large_steps_keep_the_first_value_without_integer_narrowing() {
    for stride in [
        "256".into(),
        "65536".into(),
        "9007199254740993".into(),
        "9".repeat(3500),
    ] {
        let cron = parse_cron(&format!("*/{stride} 3-23/{stride} * * *"));
        if stride.len() > 2000 {
            assert!(matches!(cron, Err(Error::Bounds(_))));
        } else {
            let cron = cron.unwrap();
            assert_eq!(cron.minute(), [0]);
            assert_eq!(cron.hour(), [3]);
        }
        assert_eq!(
            parse_cron(&format!("*/{stride} * * * *")).unwrap().minute(),
            [0]
        );
    }
    assert_eq!(
        parse_cron(&format!("*/{}1 * * * *", "0".repeat(3000)))
            .unwrap()
            .minute()
            .len(),
        60
    );
}
#[test]
fn exact_parser_errors_follow_production_order() {
    for (expr, error) in [
        ("", "Invalid cron: expected 5 fields, got 0"),
        ("1/0 * * * *", "Invalid cron: minute step \"0\""),
        (
            "1/2 * * * *",
            "Invalid cron: minute step needs a range, got \"1/2\"",
        ),
        ("60 * * * *", "Invalid cron: minute 60 is outside 0-59"),
        (
            "3-1 * * * *",
            "Invalid cron: minute range \"3-1\" runs backwards",
        ),
        ("1,,2 * * * *", "Invalid cron: minute has \"\""),
        ("* * * * 8", "Invalid cron: dayOfWeek 8 is outside 0-7"),
    ] {
        assert_eq!(parse_cron(expr).unwrap_err().to_string(), error);
    }
    assert_eq!(
        parse_cron(&format!("{} * * * *", "9".repeat(400)))
            .unwrap_err()
            .to_string(),
        "Invalid cron: minute Infinity is outside 0-59"
    );
}
#[test]
fn javascript_whitespace_is_used_instead_of_rust_whitespace() {
    assert!(parse_cron("\u{feff}*\u{00a0}*\u{2028}*\u{3000}*\u{2003}*\u{feff}").is_ok());
    assert!(parse_cron("*\u{0085}* * * * *").is_err());
}
#[test]
fn cadences_preserve_fixed_divisors_and_whole_hour_conversion() {
    for minutes in [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] {
        assert_eq!(
            every_to_cron(&format!("{minutes}m")).unwrap(),
            format!("*/{minutes} * * * *")
        );
    }
    for hours in [1, 2, 3, 4, 6, 8, 12] {
        assert_eq!(
            every_to_cron(&format!("{}m", hours * 60)).unwrap(),
            format!("0 */{hours} * * *")
        );
    }
    assert_eq!(every_to_cron("1440m").unwrap(), "0 0 * * *");
    assert_eq!(every_to_cron("300m"), Err(Error::HoursRule));
    assert_eq!(every_to_cron("90m"), Err(Error::MinutesRule));
    assert_eq!(
        every_to_cron("15m\n").unwrap_err().to_string(),
        "Invalid every: \"15m\\n\" (use e.g. 15m or 2h)"
    );
}
#[test]
fn strictly_after_handles_seconds_and_negative_epoch_floor() {
    assert_eq!(next_run("* * * * *", "UTC", -1).unwrap(), 0);
    assert_eq!(next_run("* * * * *", "UTC", -60000).unwrap(), 0);
    assert_eq!(next_run("* * * * *", "UTC", -60001).unwrap(), -60000);
    for after in [
        "2026-10-16T10:30:00Z",
        "2026-10-16T10:30:59.999Z",
        "2026-10-16T10:31:00Z",
    ] {
        assert_eq!(
            next("*/15 * * * *", "UTC", after),
            epoch("2026-10-16T10:45:00Z")
        );
    }
}
#[test]
fn day_restriction_uses_set_cardinality_and_or_only_when_both_restricted() {
    let after = "2026-10-16T12:00:00Z";
    for expr in ["0 9 20 * 1", "0 9 1-31 * 1"] {
        assert_eq!(next(expr, "UTC", after), epoch("2026-10-19T09:00:00Z"));
    }
    for expr in ["0 9 20 * *", "0 9 20 * 0-7"] {
        assert_eq!(next(expr, "UTC", after), epoch("2026-10-20T09:00:00Z"));
    }
    assert_eq!(
        next("0 0 * * 7", "UTC", after),
        epoch("2026-10-18T00:00:00Z")
    );
}
#[test]
fn repeated_minutes_are_never_fired_twice_even_from_second_occurrence() {
    let first = epoch("2026-10-25T00:30:00Z");
    assert_eq!(
        next("30 1 * * *", "Europe/Lisbon", "2026-10-24T12:00:00Z"),
        first
    );
    for after in [first, first + 60 * 60 * 1000] {
        assert_eq!(
            next_run("30 1 * * *", "Europe/Lisbon", after).unwrap(),
            epoch("2026-10-26T01:30:00Z")
        );
    }
    assert_eq!(
        next("* * * * *", "Europe/Lisbon", "2026-10-25T00:59:00Z"),
        epoch("2026-10-25T02:00:00Z")
    );
}
#[test]
fn gaps_half_hour_and_two_hour_changes_preserve_node_calendar_search() {
    assert_eq!(
        next("30 1 * * *", "Europe/Lisbon", "2026-03-28T01:30:00Z"),
        epoch("2026-03-30T00:30:00Z")
    );
    assert_eq!(
        next("30 0 * * 1", "Antarctica/Troll", "2026-03-29T00:30:00Z"),
        epoch("2026-03-29T22:30:00Z")
    );
    assert_eq!(
        next("0 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z"),
        epoch("2026-10-04T15:00:00Z")
    );
}
#[test]
fn leap_day_search_crosses_the_nonleap_century_and_is_bounded() {
    assert_eq!(
        next("0 0 29 2 *", "UTC", "2096-03-01T00:00:00Z"),
        epoch("2104-02-29T00:00:00Z")
    );
    assert_eq!(
        next_run("0 0 31 2 *", "UTC", epoch("2026-01-01T00:00:00Z")),
        Err(Error::NoRun)
    );
    assert_eq!(
        next_run("0 0 30 2 *", "Europe/Lisbon", epoch("2026-01-01T00:00:00Z")),
        Err(Error::NoRun)
    );
}
#[test]
fn named_and_numeric_timezones_use_pinned_data_and_no_unknown_fallback() {
    assert_eq!(
        next("30 8 * * 1-5", "America/Sao_Paulo", "2026-10-16T12:00:00Z"),
        epoch("2026-10-19T11:30:00Z")
    );
    assert_eq!(
        next("0 9 * * *", "+05:45", "2026-10-16T00:00:00Z"),
        epoch("2026-10-16T03:15:00Z")
    );
    assert_eq!(
        next("0 9 * * *", "aMeRiCa/nEw_yOrK", "2026-10-16T00:00:00Z"),
        next("0 9 * * *", "US/Eastern", "2026-10-16T00:00:00Z")
    );
    for zone in [
        "Mars/Base",
        "Etc/Unknown",
        "Factory",
        "+24:00",
        " UTC ",
        "+1",
    ] {
        assert_eq!(
            next_run("* * * * *", zone, 0).unwrap_err().to_string(),
            format!("Invalid cron: unknown timezone {zone}")
        );
    }
}
#[test]
fn public_bounds_are_explicit_and_leave_room_for_the_complete_search() {
    assert_eq!(epoch("1900-01-02T00:00:00Z"), MIN_AFTER_MS);
    assert_eq!(epoch("9990-12-30T23:59:59.999Z"), MAX_AFTER_MS);
    assert!(next_run("* * * * *", "-23:59", MIN_AFTER_MS).unwrap() > MIN_AFTER_MS);
    assert!(next_run("0 0 29 2 *", "+23:59", MAX_AFTER_MS).unwrap() > MAX_AFTER_MS);
    for after in [i64::MIN, MIN_AFTER_MS - 1, MAX_AFTER_MS + 1, i64::MAX] {
        assert_eq!(next_run("* * * * *", "UTC", after), Err(Error::Timestamp));
    }
    assert!(matches!(
        parse_cron(&"x".repeat(MAX_INPUT_BYTES + 1)),
        Err(Error::Bounds(_))
    ));
    assert!(matches!(
        every_to_cron(&"x".repeat(MAX_INPUT_BYTES + 1)),
        Err(Error::Bounds(_))
    ));
    assert!(matches!(
        next_run("* * * * *", &"x".repeat(129), 0),
        Err(Error::Bounds(_))
    ));
}

#[test]
fn all_accepted_cadences_keep_even_gaps_across_midnight() {
    let mut cadences = Vec::new();
    for minutes in [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] {
        cadences.push((format!("{minutes}m"), minutes * 60_000));
    }
    for hours in [1, 2, 3, 4, 6, 8, 12, 24] {
        cadences.push((format!("{hours}h"), hours * 3_600_000));
    }
    for (every, gap) in cadences {
        let expression = every_to_cron(&every).unwrap();
        let mut at = epoch("2026-10-16T00:00:00Z") - 1;
        let mut previous = None;
        while at < epoch("2026-10-18T00:00:00Z") {
            at = next_run(&expression, "UTC", at).unwrap();
            if let Some(previous) = previous {
                assert_eq!(at - previous, gap, "{every}");
            }
            previous = Some(at);
        }
    }
}
#[test]
fn icu_only_systemv_names_are_an_explicit_remaining_compatibility_gap() {
    // Node accepts these. They are outside this pinned IANA-name checkpoint;
    // inventing or substituting another zone's transition data would be incorrect.
    for zone in ["SystemV/EST5", "SystemV/EST5EDT", "SystemV/PST8PDT"] {
        assert_eq!(
            next_run("0 9 * * *", zone, 0).unwrap_err().to_string(),
            format!("Invalid cron: unknown timezone {zone}")
        );
    }
}
