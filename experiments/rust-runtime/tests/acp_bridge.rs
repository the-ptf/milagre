#![cfg(feature = "acp-fixture")]
use milagre_owner_store::{
    chat_host::{AnswerId, AnswerOutcome, Provider, ProviderEvent, TurnId},
    jsjson::RawJson,
};
use milagre_rust_runtime::acp_fixture::{AcpFixture, Scenario};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
fn request(p: &AcpFixture) -> RawJson {
    RawJson(
        json!({"provider":"kiro","chatId":"fixture","cwd":p.project(),"prompt":"hello","permissionMode":"ask"}),
    )
}
fn terminal(e: &ProviderEvent) -> bool {
    matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if matches!(v["type"].as_str(),Some("turn-completed"|"turn-failed"|"turn-cancelled")))
}
fn collect(p: &mut AcpFixture, until: impl Fn(&[ProviderEvent]) -> bool) -> Vec<ProviderEvent> {
    let until_at = Instant::now() + Duration::from_secs(5);
    let mut all = vec![];
    loop {
        all.extend(p.take_events());
        if until(&all) {
            return all;
        }
        assert!(Instant::now() < until_at, "{all:?}");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn reaped(pids: &[(u64, u32)]) {
    assert!(!pids.is_empty());
    for (_, pid) in pids {
        assert_eq!(unsafe { libc::kill(*pid as i32, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}
#[test]
fn one_process_per_turn_reaps_before_terminal_and_late_text_cannot_cross() {
    let mut p = AcpFixture::create(Scenario::LateUpdate).unwrap();
    let m = p.monitor();
    for id in 1..=2 {
        p.start_turn(TurnId(id), &request(&p)).unwrap();
        let events = collect(&mut p, |e| {
            e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
        });
        assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
        let text: Vec<&Value> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Agent {
                    event: RawJson(v), ..
                } if v["type"] == "text-delta" => Some(&v["text"]),
                _ => None,
            })
            .collect();
        assert_eq!(text, vec![&json!("live")]);
        assert!(!events.iter().any(
            |e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["type"]=="session-started")
        ));
        reaped(&m.pids());
    }
    let pids = m.pids();
    assert_eq!(pids.len(), 2);
    assert_ne!(pids[0].1, pids[1].1);
    assert!(m.wait_stopped(Duration::from_secs(2)));
}
#[test]
fn native_permission_is_once_only_and_process_exits() {
    for decision in ["allow", "deny"] {
        let mut p = AcpFixture::create(Scenario::Permission).unwrap();
        let m = p.monitor();
        p.start_turn(TurnId(1), &request(&p)).unwrap();
        let events = collect(&mut p, |e| {
            e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["type"]=="permission-request"))
        });
        let id = events
            .iter()
            .find_map(|e| match e {
                ProviderEvent::Agent {
                    event: RawJson(v), ..
                } if v["type"] == "permission-request" => v["requestId"].as_str(),
                _ => None,
            })
            .unwrap();
        assert!(p
            .respond_permission("fixture", TurnId(1), AnswerId(99), id, "allow-for-chat")
            .is_err());
        p.respond_permission("fixture", TurnId(1), AnswerId(1), id, decision)
            .unwrap();
        let events = collect(&mut p, |e| {
            e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
        });
        assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
        assert!(events.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["text"]==format!("picked:{decision}"))));
        let answers: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ProviderEvent::AnswerSettled { .. }))
            .collect();
        assert_eq!(answers.len(), 1);
        assert!(matches!(
            answers[0],
            ProviderEvent::AnswerSettled {
                outcome: AnswerOutcome::Accepted | AnswerOutcome::Uncertain(_),
                ..
            }
        ));
        reaped(&m.pids());
    }
}
#[test]
fn stop_is_nonblocking_and_start_failure_settles_once() {
    let mut p = AcpFixture::create(Scenario::Stop).unwrap();
    let m = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    collect(&mut p, |e| {
        e.iter()
            .any(|e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["text"]=="Working"))
    });
    let start = Instant::now();
    p.interrupt("fixture", TurnId(1)).unwrap();
    assert!(start.elapsed() < Duration::from_millis(50));
    let events = collect(&mut p, |e| {
        e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
    });
    assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
    reaped(&m.pids());
    let mut p = AcpFixture::create(Scenario::StartFailure).unwrap();
    p.start_turn(TurnId(2), &request(&p)).unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
    });
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, ProviderEvent::StartFailed { .. }))
            .count(),
        1
    );
    assert!(!events.iter().any(terminal));
    assert!(p.monitor().wait_stopped(Duration::from_secs(2)));
}
#[test]
fn unsupported_inputs_fail_before_any_worker() {
    let mut p = AcpFixture::create(Scenario::Reply).unwrap();
    for (k, v) in [
        ("resumeId", json!("old")),
        ("permissionMode", json!("full")),
        ("model", json!("vendor")),
        ("images", json!(["x"])),
        ("mcp", json!({})),
    ] {
        let mut req = request(&p);
        req.0[k] = v;
        assert!(p.start_turn(TurnId(1), &req).is_err());
        assert_eq!(p.monitor().workers(), 0);
    }
}
#[test]
fn production_node_clients_drive_fixed_acp_owner() {
    let output = std::process::Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/acp-compat.cjs"))
        .arg(env!("CARGO_BIN_EXE_acp-runtime"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("conformance passed"));
}
#[test]
fn lost_answer_delivery_stays_uncertain_and_stale_close_cannot_stop_replacement() {
    let mut p = AcpFixture::create(Scenario::BlockedAnswer).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["type"]=="permission-request"))
    });
    let id = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::Agent {
                event: RawJson(v), ..
            } if v["type"] == "permission-request" => v["requestId"].as_str(),
            _ => None,
        })
        .unwrap();
    p.respond_permission("fixture", TurnId(1), AnswerId(1), id, "allow")
        .unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    while monitor.answers_entered() == 0 {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
    p.close_chat("fixture", TurnId(1)).unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
    });
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(
                e,
                ProviderEvent::AnswerSettled {
                    answer: AnswerId(1),
                    outcome: AnswerOutcome::Uncertain(_),
                    ..
                }
            ))
            .count(),
        1
    );
    reaped(&monitor.pids());
    p.start_turn(TurnId(2), &request(&p)).unwrap();
    assert!(p.close_chat("fixture", TurnId(1)).is_err());
    collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{turn:TurnId(2),event:RawJson(v),..}if v["type"]=="permission-request"))
    });
    p.respond_permission("fixture", TurnId(2), AnswerId(2), id, "allow")
        .unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e| {
            matches!(
                e,
                ProviderEvent::AnswerSettled {
                    answer: AnswerId(2),
                    ..
                }
            )
        })
    });
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::AnswerSettled {
            outcome: AnswerOutcome::NotWaiting,
            ..
        }
    )));
    drop(p);
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    reaped(&monitor.pids());
}
#[test]
fn watchdog_ends_stalled_turn_and_output_reservations_are_bounded() {
    let mut p = AcpFixture::create(Scenario::Watchdog).unwrap();
    let m = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    let events = collect(&mut p, |events| {
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::Exited { .. }))
    });
    assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
    assert!(events
        .iter()
        .any(|e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..}if v["type"]=="turn-failed")));
    reaped(&m.pids());
    // Startup failures reserve their future exit/terminal until the consumer drains them.
    let mut p = AcpFixture::create(Scenario::StartFailure).unwrap();
    let m = p.monitor();
    for id in 1..=16 {
        p.start_turn(TurnId(id), &request(&p)).unwrap();
        assert!(m.wait_stopped(Duration::from_secs(2)));
    }
    assert!(p.start_turn(TurnId(17), &request(&p)).is_err());
    let events = p.take_events();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, ProviderEvent::Exited { .. }))
            .count(),
        16
    );
    p.start_turn(TurnId(18), &request(&p)).unwrap();
    assert!(m.wait_stopped(Duration::from_secs(2)));
}
