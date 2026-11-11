use milagre_owner_store::{
    chat_host::{AnswerId, AnswerOutcome, Provider, ProviderEvent, TurnId},
    jsjson::RawJson,
};
use milagre_rust_runtime::claude_fixture::{ClaudeFixture, Scenario};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
fn request(p: &ClaudeFixture) -> Value {
    json!({"provider":"claude","chatId":"fixture","cwd":p.project(),"prompt":"hello","permissionMode":"ask","model":"sonnet"})
}
fn terminal(e: &ProviderEvent) -> bool {
    matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if matches!(v["type"].as_str(),Some("turn-completed"|"turn-cancelled"|"turn-failed")))
}
fn collect(p: &mut ClaudeFixture, until: impl Fn(&[ProviderEvent]) -> bool) -> Vec<ProviderEvent> {
    let end = Instant::now() + Duration::from_secs(5);
    let mut all = vec![];
    loop {
        all.extend(p.take_events());
        if until(&all) {
            return all;
        }
        assert!(Instant::now() < end, "events: {all:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn sequential_turns_reuse_process_and_emit_one_terminal_each() {
    let mut p = ClaudeFixture::create(Scenario::Reply).unwrap();
    let m = p.monitor();
    let req = request(&p);
    let mut pid = None;
    for id in 1..=2 {
        p.start_turn(TurnId(id), &req).unwrap();
        let events = collect(&mut p, |e| e.iter().any(terminal));
        assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
        assert!(events
            .iter()
            .any(|e| matches!(e,ProviderEvent::Started{turn,..} if turn.0==id)));
        assert!(events.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["text"]=="Claude fixture hello")));
        let current = m.pid("fixture").unwrap();
        assert!(pid.is_none_or(|p| p == current));
        pid = Some(current);
    }
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
    assert!(!m.cleanup_failed());
}
#[test]
fn permissions_and_questions_settle_asynchronously() {
    for (scenario, kind, id) in [
        (Scenario::Permission, "permission-request", "p1"),
        (Scenario::Question, "question-request", "q1"),
    ] {
        let mut p = ClaudeFixture::create(scenario).unwrap();
        let m = p.monitor();
        p.start_turn(TurnId(1), &request(&p)).unwrap();
        let events = collect(&mut p, |e| {
            e.iter()
                .any(|e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]==kind))
        });
        let card = events
            .iter()
            .find_map(|e| {
                if let ProviderEvent::Agent {
                    event: RawJson(v), ..
                } = e
                {
                    if v["type"] == kind {
                        return Some(v);
                    }
                }
                None
            })
            .unwrap();
        if kind == "permission-request" {
            p.respond_permission("fixture", TurnId(1), AnswerId(1), id, "allow")
                .unwrap();
        } else {
            let q = card["questions"][0]["id"].as_str().unwrap();
            p.answer_question("fixture", TurnId(1), AnswerId(1), id, &json!({q:["A"]}))
                .unwrap();
        }
        let events = collect(&mut p, |e| {
            e.iter().any(terminal)
                && e.iter()
                    .any(|e| matches!(e, ProviderEvent::AnswerSettled { .. }))
        });
        assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::AnswerSettled {
                outcome: AnswerOutcome::Accepted,
                ..
            }
        )));
        p.shutdown();
        assert!(m.wait_stopped(Duration::from_secs(3)));
    }
}
#[test]
fn stop_crash_and_cancelled_initialization_release_workers() {
    for scenario in [Scenario::Stop, Scenario::Crash, Scenario::HangInitialize] {
        let mut p = ClaudeFixture::create(scenario).unwrap();
        let m = p.monitor();
        p.start_turn(TurnId(1), &request(&p)).unwrap();
        if matches!(scenario, Scenario::HangInitialize) {
            std::thread::sleep(Duration::from_millis(50));
            p.shutdown();
        } else {
            let seen = collect(&mut p, |e| {
                e.iter().any(|e| matches!(e, ProviderEvent::Started { .. }))
            });
            if matches!(scenario, Scenario::Stop) {
                let t = Instant::now();
                p.interrupt("fixture", TurnId(1)).unwrap();
                assert!(t.elapsed() < Duration::from_millis(50));
            }
            if !seen.iter().any(terminal) {
                collect(&mut p, |e| e.iter().any(terminal));
            }
            p.shutdown();
        }
        assert!(m.wait_stopped(Duration::from_secs(3)));
        assert_eq!(m.workers(), 0);
    }
}
#[test]
fn unsupported_configuration_is_refused_before_spawn() {
    let mut p = ClaudeFixture::create(Scenario::Reply).unwrap();
    for (k, v) in [
        ("role", json!("babysit")),
        ("permissionMode", json!("auto")),
        ("images", json!(["x"])),
        ("fastMode", json!(true)),
    ] {
        let mut req = request(&p);
        req[k] = v;
        assert!(p.start_turn(TurnId(1), &req).is_err());
        assert_eq!(p.monitor().workers(), 0);
    }
}

#[test]
fn cancelled_receipt_after_callback_keeps_delivery_uncertain() {
    let mut p = ClaudeFixture::create(Scenario::QuestionDelayedReceipt).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e| matches!(e, ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="question-request"))
    });
    let question = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::Agent {
                event: RawJson(v), ..
            } if v["type"] == "question-request" => v["questions"][0]["id"].as_str(),
            _ => None,
        })
        .unwrap();
    p.answer_question(
        "fixture",
        TurnId(1),
        AnswerId(1),
        "q1",
        &json!({question:["A"]}),
    )
    .unwrap();
    // The fake emits text only after it receives the actual callback response.
    collect(&mut p, |e| {
        e.iter().any(
            |e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="text-delta"),
        )
    });
    p.close_chat("fixture", TurnId(1)).unwrap();
    assert!(p.start_turn(TurnId(2), &request(&p)).is_err());
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    let events = p.take_events();
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
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::Exited {
            turn: TurnId(1),
            ..
        }
    )));
    let pid = monitor.pid("fixture").unwrap();
    assert_eq!(
        unsafe { libc::kill(pid as i32, 0) },
        -1,
        "stopped must include reaping"
    );
}

#[test]
fn stale_close_cannot_stop_the_next_turn_and_drop_reaps() {
    let mut p = ClaudeFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    p.start_turn(TurnId(2), &request(&p)).unwrap();
    assert!(p.close_chat("fixture", TurnId(1)).is_err());
    let events = collect(&mut p, |e| e.iter().any(terminal));
    assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
    assert!(events.iter().all(|e| match e {
        ProviderEvent::Agent { turn, .. } | ProviderEvent::Started { turn, .. } => turn.0 == 2,
        _ => true,
    }));
    let pid = monitor.pid("fixture").unwrap();
    drop(p);
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
}

#[test]
fn compact_subagent_close_patch_keeps_the_prior_transcript() {
    let mut p = ClaudeFixture::create(Scenario::Subagent).unwrap();
    let m = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    let initial = collect(&mut p, |events| {
        events.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="subagent-update"&&v["agent"]["transcript"].as_array().is_some_and(|rows|rows.iter().any(|r|r["text"]=="retained child result"))))
    });
    p.close_chat("fixture", TurnId(1)).unwrap();
    assert!(m.wait_stopped(Duration::from_secs(3)));
    let final_events = p.take_events();
    assert_eq!(final_events.iter().filter(|e| terminal(e)).count(), 1);
    let patch = final_events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::Agent {
                event: RawJson(v), ..
            } if v["type"] == "subagent-update" && v["agent"]["status"] == "cancelled" => Some(v),
            _ => None,
        })
        .expect("close must forward compact child settlement");
    assert_eq!(patch["agent"]["transcript"], json!([]));
    // Exercise the owner's real merge instead of overwriting the stored child with the patch.
    let mut session = json!({"id":1});
    for event in initial.iter().chain(final_events.iter()) {
        if let ProviderEvent::Agent {
            event: RawJson(v), ..
        } = event
        {
            if v["type"] == "subagent-update" {
                let state = json!({"sessions":{"1":session},"messages":[]});
                let state = milagre_owner_store::message_store::ProjectState::from_value(&state);
                let (merged, _, _) = milagre_owner_store::agent_runs::apply_agent_event(
                    &state,
                    &serde_json::Map::new(),
                    "/fixture",
                    "/fixture#1",
                    v,
                    1,
                )
                .unwrap();
                session = merged.to_value()["sessions"]["1"].clone();
            }
        }
    }
    assert!(session["subagents"][0]["transcript"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["text"] == "retained child result"));
}

#[test]
fn initial_resume_reaches_native_argv_and_reused_session_refuses_a_different_identity() {
    let mut p = ClaudeFixture::create(Scenario::Stop).unwrap();
    let m = p.monitor();
    let mut req = request(&p);
    req["resumeId"] = json!("resumed-fixture");
    p.start_turn(TurnId(1), &req).unwrap();
    collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="session-started"))
    });
    let pid = m.pid("fixture").unwrap();
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("--resume=resumed-fixture"));
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));

    let mut p = ClaudeFixture::create(Scenario::Reply).unwrap();
    let m = p.monitor();
    p.start_turn(TurnId(1), &request(&p)).unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    let mut changed = request(&p);
    changed["resumeId"] = json!("another-session");
    assert!(p.start_turn(TurnId(2), &changed).is_err());
    changed["resumeId"] = json!("fixture-session");
    p.start_turn(TurnId(2), &changed).unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
}
