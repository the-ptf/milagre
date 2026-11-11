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
        p.start_turn(TurnId(id), &RawJson((req).clone())).unwrap();
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
        p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
            .unwrap();
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
            p.answer_question(
                "fixture",
                TurnId(1),
                AnswerId(1),
                id,
                &RawJson((json!({q:["A"]})).clone()),
            )
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
        p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
            .unwrap();
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
        ("permissionMode", json!("plan")),
        ("permissionMode", json!("Full")),
        ("permissionMode", json!(1)),
        ("images", json!(["x"])),
        ("fastMode", json!(1)),
        ("ultracode", json!(null)),
        ("tldrEnabled", json!("yes")),
        ("replies", json!(["concise"])),
        ("replies", json!("verbose")),
        ("effort", json!(5)),
        ("model", json!(null)),
        ("accountId", json!("work")),
        ("busyWithoutTurn", json!(true)),
        ("activeChildren", json!([])),
        ("backgroundTasks", json!([])),
    ] {
        let mut req = request(&p);
        req[k] = v;
        assert!(p.start_turn(TurnId(1), &RawJson((req).clone())).is_err());
        assert_eq!(p.monitor().workers(), 0);
    }
}

#[test]
fn cancelled_receipt_after_callback_keeps_delivery_uncertain() {
    let mut p = ClaudeFixture::create(Scenario::QuestionDelayedReceipt).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
        .unwrap();
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
        &RawJson((json!({question:["A"]})).clone()),
    )
    .unwrap();
    // The fake emits text only after it receives the actual callback response.
    collect(&mut p, |e| {
        e.iter().any(
            |e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="text-delta"),
        )
    });
    p.close_chat("fixture", TurnId(1)).unwrap();
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
    p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
        .unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    p.start_turn(TurnId(2), &RawJson((request(&p)).clone()))
        .unwrap();
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
    p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
        .unwrap();
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
    p.start_turn(TurnId(1), &RawJson((req).clone())).unwrap();
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
    p.start_turn(TurnId(1), &RawJson((request(&p)).clone()))
        .unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    let mut changed = request(&p);
    changed["resumeId"] = json!("another-session");
    assert!(p
        .start_turn(TurnId(2), &RawJson((changed).clone()))
        .is_err());
    changed["resumeId"] = json!("fixture-session");
    p.start_turn(TurnId(2), &RawJson((changed).clone()))
        .unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn repeated_answer_bursts_keep_task_retention_bounded_and_settle_every_admission() {
    let mut p = ClaudeFixture::create(Scenario::Question).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &RawJson(request(&p))).unwrap();
    collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="question-request"))
    });
    let mut admitted = std::collections::HashSet::new();
    let mut settled = std::collections::HashSet::new();
    for id in 1..=1024 {
        if p.answer_question(
            "fixture",
            TurnId(1),
            AnswerId(id),
            "unmatched",
            &RawJson(json!({})),
        )
        .is_ok()
        {
            admitted.insert(id);
        }
        if id % 16 == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        for event in p.take_events() {
            if let ProviderEvent::AnswerSettled {
                answer, outcome, ..
            } = event
            {
                assert!(matches!(outcome, AnswerOutcome::NotWaiting));
                assert!(settled.insert(answer.0));
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while settled.len() != admitted.len() {
        for event in p.take_events() {
            if let ProviderEvent::AnswerSettled {
                answer, outcome, ..
            } = event
            {
                assert!(matches!(outcome, AnswerOutcome::NotWaiting));
                assert!(settled.insert(answer.0));
            }
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(settled, admitted);
    assert!(admitted.len() > 32);
    assert!(monitor.peak_reply_tasks() > 0 && monitor.peak_reply_tasks() <= 8);
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn stop_with_eight_entered_and_eight_queued_answers_settles_once_without_blocking() {
    let mut p = ClaudeFixture::create(Scenario::AnswerSaturation).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &RawJson(request(&p))).unwrap();
    collect(&mut p, |events| {
        events.iter().filter(|e| matches!(e,
        ProviderEvent::Agent { event: RawJson(v), .. } if v["type"] == "question-request"
    )).count() == 8
    });
    for id in 0..8 {
        p.answer_question(
            "fixture",
            TurnId(1),
            AnswerId(id),
            &format!("q{id}"),
            &RawJson(json!({"0":["A"]})),
        )
        .unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while monitor.peak_reply_tasks() != 8 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    for id in 8..16 {
        p.answer_question(
            "fixture",
            TurnId(1),
            AnswerId(id),
            "unmatched",
            &RawJson(json!({})),
        )
        .unwrap();
    }
    assert!(p
        .answer_question(
            "fixture",
            TurnId(1),
            AnswerId(16),
            "unmatched",
            &RawJson(json!({}))
        )
        .is_err());
    let start = Instant::now();
    p.interrupt("fixture", TurnId(1)).unwrap();
    assert!(start.elapsed() < Duration::from_millis(50));
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    let events = p.take_events();
    assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Agent { event: RawJson(v), .. } if v["text"] == "Eight answers and Stop received")));
    let mut settled = std::collections::HashSet::new();
    for event in events {
        if let ProviderEvent::AnswerSettled {
            answer, outcome, ..
        } = event
        {
            assert!(settled.insert(answer.0));
            if answer.0 < 8 {
                assert!(
                    matches!(outcome, AnswerOutcome::Uncertain(_)),
                    "{outcome:?}"
                );
            } else {
                assert!(matches!(outcome, AnswerOutcome::Failed(_)), "{outcome:?}");
            }
        }
    }
    assert_eq!(settled, (0..16).collect());
    assert_eq!(monitor.peak_reply_tasks(), 8);
    let pid = monitor.pid("fixture").unwrap();
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

fn ps_command(pid: u32) -> String {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn typed_fast_ultracode_effort_and_tldr_settings_are_admitted() {
    let mut p = ClaudeFixture::create(Scenario::Reply).unwrap();
    let m = p.monitor();
    let mut req = request(&p);
    for (k, v) in [
        ("effort", json!("low")),
        ("ultracode", json!(true)),
        ("fastMode", json!(true)),
        ("replies", json!("normal")),
        ("tldrEnabled", json!(false)),
        ("images", json!([])),
    ] {
        req[k] = v;
    }
    p.start_turn(TurnId(1), &RawJson(req)).unwrap();
    let events = collect(&mut p, |e| e.iter().any(terminal));
    assert!(!events
        .iter()
        .any(|e| matches!(e, ProviderEvent::StartFailed { .. })));
    assert!(events.iter().any(
        |e| matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="turn-completed")
    ));
    // The idle session keeps its process: its argv is still observable.
    let argv = ps_command(m.pid("fixture").unwrap());
    for expected in [
        "--effort low",
        "--settings ",
        "--append-system-prompt-file ",
        "--setting-sources=user,project,local",
    ] {
        assert!(argv.contains(expected), "{expected} missing from {argv}");
    }
    assert!(
        !argv.contains("Milagre"),
        "instructions stay off argv: {argv}"
    );
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
}

/// The three ordinary turns of the Node trace. The fake child asserts every launch option and
/// control frame recorded from Node; this test observes generations and processes.
#[test]
fn ordinary_turns_reuse_then_restart_on_tldr_change_with_a_late_old_exit() {
    let trace: Value = serde_json::from_str(include_str!(
        "../../rust-claude/tests/fixtures/conformance/claude-ordinary.json"
    ))
    .unwrap();
    let mut p = ClaudeFixture::create(Scenario::Ordinary).unwrap();
    let m = p.monitor();
    let turn = |p: &ClaudeFixture, index: usize| {
        let mut req = trace["request"].clone();
        req["chatId"] = json!("fixture");
        req["cwd"] = json!(p.project());
        for (k, v) in trace["turns"][index].as_object().unwrap() {
            req[k] = v.clone();
        }
        if index > 0 {
            // The owner sends the native id it saw in session-started.
            req["resumeId"] = json!("fixture-session");
        }
        RawJson(req)
    };
    let mut all = Vec::new();
    p.start_turn(TurnId(1), &turn(&p, 0)).unwrap();
    all.extend(collect(&mut p, |e| e.iter().any(terminal)));
    let first = m.pid("fixture").unwrap();
    p.start_turn(TurnId(2), &turn(&p, 1)).unwrap();
    all.extend(collect(&mut p, |e| e.iter().any(terminal)));
    assert_eq!(
        m.pid("fixture"),
        Some(first),
        "concise -> normal reuses the process"
    );
    // A different resume identity cannot hijack the restart.
    let mut wrong = turn(&p, 2);
    wrong.0["resumeId"] = json!("another-session");
    assert!(p.start_turn(TurnId(3), &wrong).is_err());
    assert!(alive(first));
    p.start_turn(TurnId(3), &turn(&p, 2)).unwrap();
    let third = collect(&mut p, |e| {
        e.iter().any(terminal)
            && e.iter().any(|e| {
                matches!(
                    e,
                    ProviderEvent::Exited {
                        turn: TurnId(2),
                        ..
                    }
                )
            })
    });
    let second = m.pid("fixture").unwrap();
    assert_ne!(second, first, "TLDR change starts a new process");
    assert!(ps_command(second).contains("--resume=fixture-session"));
    let position = |test: &dyn Fn(&ProviderEvent) -> bool| third.iter().position(test).unwrap();
    let started = position(&|e| {
        matches!(
            e,
            ProviderEvent::Started {
                turn: TurnId(3),
                ..
            }
        )
    });
    let completed = position(&|e| {
        terminal(e)
            && matches!(
                e,
                ProviderEvent::Agent {
                    turn: TurnId(3),
                    ..
                }
            )
    });
    let old_exit = position(&|e| {
        matches!(
            e,
            ProviderEvent::Exited {
                turn: TurnId(2),
                ..
            }
        )
    });
    assert!(
        old_exit > started,
        "the old generation exits late: {third:?}"
    );
    let _ = completed;
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(first) {
        assert!(
            Instant::now() < deadline,
            "old process {first} was not reaped"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    all.extend(third);
    for event in &all {
        match event {
            ProviderEvent::StartFailed { .. } => panic!("{all:?}"),
            ProviderEvent::Agent {
                event: RawJson(v), ..
            } => {
                assert!(
                    v["type"] != "turn-failed" && v["type"] != "turn-cancelled",
                    "{v}"
                )
            }
            ProviderEvent::Exited { turn, .. } => {
                assert_eq!(*turn, TurnId(2), "only the old generation exits")
            }
            _ => {}
        }
    }
    for id in 1..=3 {
        assert_eq!(
            all.iter()
                .filter(|e| terminal(e)
                    && matches!(e, ProviderEvent::Agent { turn, .. } if turn.0 == id))
                .count(),
            1
        );
    }
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
    assert!(!m.cleanup_failed());
}

fn modes_trace() -> Value {
    serde_json::from_str(include_str!(
        "../../rust-claude/tests/fixtures/conformance/claude-modes.json"
    ))
    .unwrap()
}
fn modes_request(p: &ClaudeFixture, trace: &Value, index: usize) -> RawJson {
    let mut req = trace["request"].clone();
    req["chatId"] = json!("fixture");
    req["cwd"] = json!(p.project());
    for (k, v) in trace["turns"][index].as_object().unwrap() {
        req[k] = v.clone();
    }
    RawJson(req)
}
fn cards(events: &[ProviderEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::Agent {
                event: RawJson(v), ..
            } if v["type"]
                .as_str()
                .is_some_and(|t| t.starts_with("permission-")) =>
            {
                Some(v.clone())
            }
            _ => None,
        })
        .collect()
}

/// Full, Auto and Ask through the fixture adapter. The fake child asserts Node's launch mode
/// (bypassPermissions), the setPermissionMode/effort order and each recorded `can_use_tool` answer.
#[test]
fn full_auto_ask_turns_match_node_and_settle_cards_through_the_owner_contract() {
    let trace = modes_trace();
    let mut p = ClaudeFixture::create(Scenario::Modes).unwrap();
    let m = p.monitor();
    let mut all = Vec::new();
    let mut pid = None;
    for (index, decision) in [(0, None), (1, Some("allow")), (2, Some("deny"))] {
        let turn = TurnId(index as u64 + 1);
        p.start_turn(turn, &modes_request(&p, &trace, index))
            .unwrap();
        if let Some(decision) = decision {
            let seen = collect(&mut p, |e| !cards(e).is_empty());
            let card = cards(&seen)[0].clone();
            all.extend(seen);
            p.respond_permission(
                "fixture",
                turn,
                AnswerId(index as u64),
                card["requestId"].as_str().unwrap(),
                decision,
            )
            .unwrap();
        }
        all.extend(collect(&mut p, |e| e.iter().any(terminal)));
        assert!(
            pid.is_none_or(|pid| m.pid("fixture") == Some(pid)),
            "mode changes keep the process"
        );
        pid = m.pid("fixture");
    }
    assert_eq!(json!(cards(&all)), trace["cards"]);
    assert_eq!(
        all.iter()
            .filter(|e| matches!(
                e,
                ProviderEvent::AnswerSettled {
                    outcome: AnswerOutcome::Accepted,
                    ..
                }
            ))
            .count(),
        2
    );
    for event in &all {
        if let ProviderEvent::Agent {
            event: RawJson(v), ..
        } = event
        {
            assert!(
                v["type"] != "turn-failed" && v["type"] != "turn-cancelled",
                "{v}"
            );
        }
    }
    let argv = ps_command(pid.unwrap());
    assert!(
        argv.contains("--permission-mode bypassPermissions"),
        "{argv}"
    );
    assert!(
        argv.contains("--allow-dangerously-skip-permissions"),
        "{argv}"
    );
    p.shutdown();
    assert!(m.wait_stopped(Duration::from_secs(3)));
    assert!(!m.cleanup_failed());
}

/// A card pending in Auto cannot be answered once its session is closed: the turn is cancelled,
/// its process reaped, and a late answer for that generation is refused before enqueue.
#[test]
fn pending_auto_card_is_revoked_by_close_and_late_answers_are_refused() {
    let trace = modes_trace();
    let mut p = ClaudeFixture::create(Scenario::Modes).unwrap();
    let m = p.monitor();
    p.start_turn(TurnId(1), &modes_request(&p, &trace, 0))
        .unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    p.start_turn(TurnId(2), &modes_request(&p, &trace, 1))
        .unwrap();
    let seen = collect(&mut p, |e| !cards(e).is_empty());
    let card = cards(&seen)[0].clone();
    let pid = m.pid("fixture").unwrap();
    p.close_chat("fixture", TurnId(2)).unwrap();
    assert!(p
        .respond_permission(
            "fixture",
            TurnId(2),
            AnswerId(9),
            card["requestId"].as_str().unwrap(),
            "allow"
        )
        .is_err());
    let events = collect(&mut p, |e| {
        e.iter().any(|e| {
            matches!(
                e,
                ProviderEvent::Exited {
                    turn: TurnId(2),
                    ..
                }
            )
        })
    });
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Agent { turn: TurnId(2), event: RawJson(v), .. } if v["type"] == "turn-cancelled")));
    assert!(cards(&events)
        .iter()
        .any(|c| c["type"] == "permission-resolved" && c["decision"] == "cancelled"));
    assert!(m.wait_stopped(Duration::from_secs(3)));
    assert!(!alive(pid));
}

fn mode_settled(events: &[ProviderEvent], id: u64) -> bool {
    events
        .iter()
        .any(|event| matches!(event, ProviderEvent::ModeSettled { change, .. } if change.0 == id))
}

/// The actual Node oracle's cards and native mode controls through one retained session. Enqueue
/// both active changes together: the adapter must serialize Full then Ask before the next prompt.
#[test]
fn live_modes_match_node_with_ordered_receipts_and_retained_idle_session() {
    use milagre_owner_store::chat_host::{ModeChangeId, ModeOutcome};
    let trace: Value = serde_json::from_str(include_str!(
        "../../rust-claude/tests/fixtures/conformance/claude-live-modes.json"
    ))
    .unwrap();
    let mut p = ClaudeFixture::create(Scenario::LiveModes).unwrap();
    let monitor = p.monitor();
    let mut req = trace["request"].clone();
    req.as_object_mut()
        .unwrap()
        .extend(trace["turn"].as_object().unwrap().clone());
    req["cwd"] = json!(p.project());
    req["chatId"] = json!("fixture");
    p.start_turn(TurnId(1), &RawJson(req)).unwrap();
    let mut all = collect(&mut p, |events| !cards(events).is_empty());
    let pid = monitor.pid("fixture").unwrap();
    p.set_mode("fixture", TurnId(1), ModeChangeId(1), "full")
        .unwrap();
    p.set_mode("fixture", TurnId(1), ModeChangeId(2), "ask")
        .unwrap();
    all.extend(collect(&mut p, |events| {
        mode_settled(events, 1)
            && mode_settled(events, 2)
            && cards(events)
                .iter()
                .any(|event| event["requestId"] == "live-1")
    }));
    assert!(
        !all.iter().any(terminal),
        "mode changes leave this turn running"
    );
    assert_eq!(cards(&all), trace["cards"].as_array().unwrap()[..3]);
    p.respond_permission("fixture", TurnId(1), AnswerId(1), "live-1", "deny")
        .unwrap();
    all.extend(collect(&mut p, |events| events.iter().any(terminal)));
    for (id, mode) in [(3, "auto"), (4, "ask")] {
        p.set_mode("fixture", TurnId(1), ModeChangeId(id), mode)
            .unwrap();
        all.extend(collect(&mut p, |events| mode_settled(events, id)));
    }
    assert_eq!(json!(cards(&all)), trace["cards"]);
    let receipts: Vec<_> = all
        .iter()
        .filter_map(|event| match event {
            ProviderEvent::ModeSettled {
                change, outcome, ..
            } => {
                assert!(matches!(outcome, ModeOutcome::Applied), "{outcome:?}");
                Some(change.0)
            }
            _ => None,
        })
        .collect();
    assert_eq!(receipts, [1, 2, 3, 4]);
    assert_eq!(monitor.pid("fixture"), Some(pid));
    p.close_chat("fixture", TurnId(1)).unwrap();
    assert!(p
        .set_mode("fixture", TurnId(1), ModeChangeId(5), "full")
        .is_err());
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert!(!alive(pid));
}

#[test]
fn mode_lane_is_bounded_and_close_distinguishes_queued_from_entered() {
    use milagre_owner_store::chat_host::{ModeChangeId, ModeOutcome, ProviderErrorKind};
    let mut p = ClaudeFixture::create(Scenario::ModeStalled).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &RawJson(request(&p))).unwrap();
    collect(&mut p, |events| {
        events
            .iter()
            .any(|event| matches!(event, ProviderEvent::Started { .. }))
    });
    assert!(p
        .set_mode("fixture", TurnId(2), ModeChangeId(100), "full")
        .is_err());
    assert!(p
        .set_mode("fixture", TurnId(1), ModeChangeId(100), "invalid")
        .is_err());
    p.set_mode("fixture", TurnId(1), ModeChangeId(1), "full")
        .unwrap();
    collect(&mut p, |events| {
        events.iter().any(|event| matches!(event, ProviderEvent::Agent { event: RawJson(v), .. } if v["text"] == "mode entered"))
    });
    assert!(p
        .set_mode("fixture", TurnId(1), ModeChangeId(1), "ask")
        .is_err());
    for id in 2..=9 {
        p.set_mode("fixture", TurnId(1), ModeChangeId(id), "ask")
            .unwrap();
    }
    assert!(p
        .set_mode("fixture", TurnId(1), ModeChangeId(10), "ask")
        .is_err());
    let before = Instant::now();
    p.close_chat("fixture", TurnId(1)).unwrap();
    assert!(
        before.elapsed() < Duration::from_millis(100),
        "close admission stays nonblocking"
    );
    let events = collect(&mut p, |events| {
        events.iter().any(|event| {
            matches!(
                event,
                ProviderEvent::Exited {
                    turn: TurnId(1),
                    ..
                }
            )
        })
    });
    let mut settled = std::collections::HashMap::<u64, Vec<&ModeOutcome>>::new();
    for event in &events {
        if let ProviderEvent::ModeSettled {
            change, outcome, ..
        } = event
        {
            settled.entry(change.0).or_default().push(outcome);
        }
    }
    assert_eq!(settled.len(), 9);
    assert!(matches!(
        settled[&1].as_slice(),
        [ModeOutcome::Uncertain(_), ModeOutcome::Failed(_)]
    ));
    for id in 2..=9 {
        assert!(
            matches!(settled[&id].as_slice(), [ModeOutcome::Failed(error)] if error.kind == ProviderErrorKind::Refused)
        );
    }
    let final_receipt = events
        .iter()
        .position(|event| {
            matches!(
                event,
                ProviderEvent::ModeSettled {
                    change: ModeChangeId(1),
                    outcome: ModeOutcome::Failed(_),
                    ..
                }
            )
        })
        .unwrap();
    let exit = events
        .iter()
        .position(|event| matches!(event, ProviderEvent::Exited { .. }))
        .unwrap();
    assert!(
        final_receipt < exit,
        "definitive cleanup settles the exact operation before Exited"
    );
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert!(!monitor.cleanup_failed());
}

#[test]
fn native_mode_failure_never_emits_an_applied_receipt() {
    use milagre_owner_store::chat_host::{ModeChangeId, ModeOutcome};
    let mut p = ClaudeFixture::create(Scenario::ModeRejected).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &RawJson(request(&p))).unwrap();
    collect(&mut p, |events| {
        events
            .iter()
            .any(|event| matches!(event, ProviderEvent::Started { .. }))
    });
    p.set_mode("fixture", TurnId(1), ModeChangeId(1), "full")
        .unwrap();
    let events = collect(&mut p, |events| mode_settled(events, 1));
    assert!(events.iter().any(|event| matches!(
        event,
        ProviderEvent::ModeSettled {
            outcome: ModeOutcome::Failed(_),
            ..
        }
    )));
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn background_activity_retains_tldr_until_settled_then_restarts_and_close_cleans_up() {
    let oracle: Value =
        serde_json::from_str(include_str!("../fixtures/session-retention-node.json")).unwrap();
    let case = oracle["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "background-retention")
        .unwrap();
    let expected: Vec<_> = case["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|step| step["action"] == "start")
        .map(|step| step["snapshot"]["session"].as_u64().unwrap())
        .collect();
    let mut provider = ClaudeFixture::create(Scenario::BackgroundRetention).unwrap();
    let monitor = provider.monitor();
    let mut pids = Vec::new();
    let mut all = Vec::new();
    for turn in 1..=5 {
        let mut req = request(&provider);
        req["prompt"] = json!(format!("retention {turn}"));
        req["effort"] = json!("high");
        req["replies"] = json!("normal");
        req["tldrEnabled"] = json!(turn == 1);
        provider.start_turn(TurnId(turn), &RawJson(req)).unwrap();
        let events = collect(&mut provider, |events| {
            events.iter().any(|event| terminal(event) && matches!(event, ProviderEvent::Agent { turn: actual, .. } if actual.0 == turn))
        });
        assert!(events
            .iter()
            .all(|event| !matches!(event, ProviderEvent::StartFailed { .. })));
        assert!(events.iter().all(|event| !matches!(event, ProviderEvent::Agent { event:RawJson(v), .. } if v["type"]=="turn-failed" || v["type"]=="turn-cancelled")));
        all.extend(events);
        pids.push(monitor.pid("fixture").unwrap());
    }
    let actual: Vec<_> = pids
        .iter()
        .map(|pid| if *pid == pids[0] { 1 } else { 2 })
        .collect();
    assert_eq!(
        actual, expected,
        "native reuse/replacement matches actual Node SessionManager decisions"
    );
    assert_ne!(pids[4], pids[0]);
    assert!(ps_command(pids[4]).contains("--resume=fixture-session"));
    assert!(all.iter().any(|event| matches!(event, ProviderEvent::Agent { event:RawJson(v), .. } if v["type"]=="subagent-update" && v["agent"]["id"]=="foreground-child" && v["agent"]["status"]=="running")));
    provider.close_chat("fixture", TurnId(5)).unwrap();
    let closed = collect(&mut provider, |events| {
        events.iter().any(|event| {
            matches!(
                event,
                ProviderEvent::Exited {
                    turn: TurnId(5),
                    ..
                }
            )
        })
    });
    assert!(closed.iter().any(|event| matches!(event, ProviderEvent::Agent { event:RawJson(v), .. } if v["type"]=="subagent-update" && v["agent"]["id"]=="closing-child" && v["agent"]["status"]=="cancelled")));
    assert!(closed.iter().any(|event| matches!(event, ProviderEvent::Agent { event:RawJson(v), .. } if v["type"]=="background-tasks" && v["tasks"]==json!([]))));
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert!(!monitor.cleanup_failed());
}

#[test]
fn changed_tldr_during_first_pending_start_cannot_replace_the_starting_worker() {
    let mut provider = ClaudeFixture::create(Scenario::HangInitialize).unwrap();
    let monitor = provider.monitor();
    let mut req = request(&provider);
    provider
        .start_turn(TurnId(1), &RawJson(req.clone()))
        .unwrap();
    req["tldrEnabled"] = json!(false);
    assert!(provider.start_turn(TurnId(2), &RawJson(req)).is_err());
    assert_eq!(monitor.workers(), 1);
    provider.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}
