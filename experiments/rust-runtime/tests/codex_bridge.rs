use milagre_owner_store::jsjson::RawJson;
use milagre_owner_store::{
    agent_runs,
    chat_host::{
        AnswerId, AnswerOutcome, AnswerResult, AnswerTicket, ChatHost, Notice, Provider,
        ProviderEvent, TurnId,
    },
    states::{ProjectStates, Timing},
};
use milagre_rust_runtime::codex_fixture::{CodexFixture, Scenario};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
fn request(p: &CodexFixture, chat: &str) -> Value {
    json!({"provider":"codex","cwd":p.project(),"chatId":chat,"prompt":"hello","permissionMode":"ask"})
}
fn terminal(e: &ProviderEvent) -> bool {
    matches!(e,ProviderEvent::Agent {event:RawJson(event),..} if matches!(event["type"].as_str(),Some("turn-completed"|"turn-failed"|"turn-cancelled")))
}
fn collect(
    p: &mut CodexFixture,
    mut until: impl FnMut(&[ProviderEvent]) -> bool,
) -> Vec<ProviderEvent> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut events = vec![];
    loop {
        events.extend(p.take_events());
        if until(&events) {
            return events;
        }
        assert!(Instant::now() < deadline, "timed out: {events:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn reply_resume_and_sequential_turns_have_exact_generation_and_one_end() {
    let mut p = CodexFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    let mut req = request(&p, "chat");
    req["resumeId"] = json!("resumed-thread");
    p.start_turn(TurnId(1), &req).unwrap();
    let events = collect(&mut p, |e| e.iter().any(terminal));
    assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
    assert_eq!(
        monitor.native_session("chat").unwrap().1.as_deref(),
        Some("resumed-thread")
    );
    assert_eq!(
        events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Agent {
                    event: RawJson(event),
                    ..
                } if event["type"] == "text-delta" => event["text"].as_str(),
                _ => None,
            })
            .collect::<String>(),
        "Hello"
    );
    p.start_turn(TurnId(2), &req).unwrap();
    let events = collect(&mut p, |e| e.iter().any(terminal));
    assert!(events.iter().all(|e| match e {
        ProviderEvent::Agent { turn, .. } | ProviderEvent::Started { turn, .. } =>
            *turn == TurnId(2),
        _ => true,
    }));
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert_eq!(
        p.take_events()
            .iter()
            .filter(|e| matches!(
                e,
                ProviderEvent::Exited {
                    turn: TurnId(2),
                    ..
                }
            ))
            .count(),
        1
    );
}
#[test]
fn interrupt_and_close_return_without_waiting_for_slow_or_stubborn_native_turn() {
    for scenario in [Scenario::SlowStop, Scenario::Stubborn] {
        let mut p = CodexFixture::create(scenario).unwrap();
        let monitor = p.monitor();
        p.start_turn(TurnId(4), &request(&p, "chat")).unwrap();
        collect(&mut p, |e| {
            e.iter().any(|e| matches!(e, ProviderEvent::Started { .. }))
        });
        let before = Instant::now();
        p.interrupt("chat", TurnId(4)).unwrap();
        assert!(before.elapsed() < Duration::from_millis(50));
        let events = collect(&mut p, |e| e.iter().any(terminal));
        assert_eq!(events.iter().filter(|e| terminal(e)).count(), 1);
        let before = Instant::now();
        p.close_chat("chat", TurnId(4)).unwrap();
        assert!(before.elapsed() < Duration::from_millis(50));
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
    }
}
#[test]
fn cancelled_initialization_and_thread_start_do_not_pin_the_owner() {
    for scenario in [Scenario::HangInitialize, Scenario::HangThread] {
        let mut p = CodexFixture::create(scenario).unwrap();
        let monitor = p.monitor();
        p.start_turn(TurnId(1), &request(&p, "chat")).unwrap();
        let pid = fixture_child(p.project());
        drop(p);
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
        assert!(
            !alive(pid),
            "worker reported stopped before cancelled child {pid} was reaped"
        );
    }
}
#[test]
fn refusal_precedes_spawn_and_approval_answer_settles_after_native_write() {
    let mut p = CodexFixture::create(Scenario::Approval).unwrap();
    let monitor = p.monitor();
    for (key, value) in [
        ("role", json!("babysit")),
        ("permissionMode", json!("full")),
        ("images", json!(["x"])),
        ("tldrEnabled", json!(true)),
        ("linked_tools", json!({})),
    ] {
        let mut req = request(&p, "chat");
        req[key] = value;
        assert!(p.start_turn(TurnId(1), &req).is_err());
        assert_eq!(monitor.workers(), 0);
    }
    p.start_turn(TurnId(1), &request(&p, "chat")).unwrap();
    collect(&mut p, |e| {
        e.iter().any(
            |e| matches!(e,ProviderEvent::Agent {event:RawJson(event),..} if event["type"]=="permission-request"),
        )
    });
    assert!(p.start_turn(TurnId(2), &request(&p, "chat")).is_err());
    p.respond_permission("chat", TurnId(1), AnswerId(1), "srv-1", "allow")
        .unwrap();
    p.answer_question("chat", TurnId(1), AnswerId(2), "not-waiting", &json!({}))
        .unwrap();
    let events = collect(&mut p, |e| {
        e.iter()
            .filter(|e| matches!(e, ProviderEvent::AnswerSettled { .. }))
            .count()
            == 2
            && e.iter().any(terminal)
    });
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::AnswerSettled {
            answer: AnswerId(1),
            outcome: AnswerOutcome::Accepted,
            ..
        }
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::AnswerSettled {
            answer: AnswerId(2),
            outcome: AnswerOutcome::NotWaiting,
            ..
        }
    )));
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}
#[test]
fn failed_resume_and_crash_have_a_single_exit_and_no_live_worker() {
    for scenario in [Scenario::ResumeExit, Scenario::Crash] {
        let mut p = CodexFixture::create(scenario).unwrap();
        let monitor = p.monitor();
        let mut req = request(&p, "chat");
        req["resumeId"] = json!("thread-old");
        p.start_turn(TurnId(7), &req).unwrap();
        let events = collect(&mut p, |e| {
            e.iter().any(|e| matches!(e, ProviderEvent::Exited { .. }))
        });
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(
                    e,
                    ProviderEvent::Exited {
                        turn: TurnId(7),
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| terminal(e) || matches!(e, ProviderEvent::StartFailed { .. }))
                .count(),
            1
        );
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
    }
}
#[test]
fn owner_persists_real_adapter_events_and_advances_a_queued_turn() {
    let p = CodexFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    let project = p.project().to_path_buf();
    let mut host = ChatHost::new(ProjectStates::new(p.isolation(), Timing::default(), 1000));
    host.register(Box::new(p));
    let chat = agent_runs::chat_key(project.to_str().unwrap(), &json!(1));
    let req = json!({"projectPath":project,"sessionId":1,"provider":"codex","body":"first","permissionMode":"ask","clientMessageId":"one"});
    host.send(&req).unwrap();
    let mut queued = req.clone();
    queued["body"] = json!("second");
    queued["clientMessageId"] = json!("two");
    queued["delivery"] = json!("queue");
    assert!(host.send(&queued).unwrap().queued);
    let deadline = Instant::now() + Duration::from_secs(5);
    while host.is_busy(&chat) {
        assert!(Instant::now() < deadline);
        let errors = host.tick(
            1000 + (5000
                - deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as i64),
        );
        assert!(errors.is_empty(), "{errors:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
    let state = host.states.whole_state(&project).unwrap();
    let messages = state["messages"].as_array().unwrap();
    assert_eq!(
        messages.iter().filter(|m| m["role"] == "user").count(),
        2,
        "{state}"
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["body"] == "Hello")
            .count(),
        2,
        "{state}"
    );
    host.shutdown(false).unwrap();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn captured_close_and_late_exit_do_not_stop_replacement_session() {
    let mut p = CodexFixture::create(Scenario::SlowStop).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(10), &request(&p, "chat")).unwrap();
    collect(&mut p, |e| {
        e.iter().any(|e| matches!(e, ProviderEvent::Started { .. }))
    });
    let old_pid = monitor.native_session("chat").unwrap().0.unwrap();
    p.close_chat("chat", TurnId(10)).unwrap();
    p.start_turn(TurnId(11), &request(&p, "chat")).unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(|e| {
            matches!(
                e,
                ProviderEvent::Started {
                    turn: TurnId(11),
                    ..
                }
            )
        }) && e.iter().any(|e| {
            matches!(
                e,
                ProviderEvent::Exited {
                    turn: TurnId(10),
                    ..
                }
            )
        })
    });
    assert!(!events.iter().any(|e| matches!(
        e,
        ProviderEvent::Exited {
            turn: TurnId(11),
            ..
        }
    )));
    assert!(!std::process::Command::new("/bin/kill")
        .args(["-0", &old_pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());
    p.interrupt("chat", TurnId(10)).unwrap();
    std::thread::sleep(Duration::from_millis(25));
    assert!(!p.take_events().iter().any(terminal));
    let new_pid = monitor.native_session("chat").unwrap().0.unwrap();
    assert_ne!(old_pid, new_pid);
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    assert!(!std::process::Command::new("/bin/kill")
        .args(["-0", &new_pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());
}
#[test]
fn stalled_owner_event_consumer_closes_admission_and_preserves_terminal_reserve() {
    let mut p = CodexFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    let req = request(&p, "chat");
    let mut next = 1;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline, "event budget was not enforced");
        match p.start_turn(TurnId(next), &req) {
            Ok(()) => next += 1,
            Err(e) if e.message == "The fixture provider is closed" => break,
            Err(e) => assert!(e.message.contains("Steering"), "{e:?}"),
        }
        std::thread::sleep(Duration::from_millis(3));
    }
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    let events = p.take_events();
    assert!(events.len() <= 256 + 16 * 3);
    assert!(events
        .iter()
        .any(|e| matches!(e,ProviderEvent::Agent {event:RawJson(event),..}if event["type"]=="turn-failed")));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, ProviderEvent::Exited { .. }))
            .count(),
        1
    );
    assert!(p.start_turn(TurnId(next), &req).is_err());
}
#[test]
fn session_limit_is_bounded_and_one_hung_chat_does_not_block_another() {
    let mut p = CodexFixture::create(Scenario::HangThread).unwrap();
    let monitor = p.monitor();
    for id in 1..=16 {
        p.start_turn(TurnId(id), &request(&p, &format!("chat-{id}")))
            .unwrap();
    }
    assert!(p.start_turn(TurnId(17), &request(&p, "overflow")).is_err());
    assert_eq!(monitor.workers(), 16);
    let before = Instant::now();
    p.shutdown();
    assert!(before.elapsed() < Duration::from_millis(50));
    assert!(monitor.wait_stopped(Duration::from_secs(5)));
}

#[test]
fn owner_unicode_identities_are_decoded_and_lone_identity_units_are_refused() {
    let mut p = CodexFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    let mut req = request(&p, "chat");
    req["resumeId"] = milagre_owner_store::jsjson::parse(r#""half\ud800""#).unwrap();
    assert!(p
        .start_turn(TurnId(1), &req)
        .unwrap_err()
        .message
        .contains("UTF-16"));
    assert_eq!(monitor.workers(), 0);
    let thread = "real-\u{10fffe}-\u{f0000}";
    req["prompt"] = json!("hello");
    req["resumeId"] = json!(milagre_owner_store::jsjson::js_string(thread));
    p.start_turn(TurnId(2), &req).unwrap();
    collect(&mut p, |e| e.iter().any(terminal));
    assert_eq!(
        monitor.native_session("chat").unwrap().1.as_deref(),
        Some(thread)
    );
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}
fn fixture_child(project: &std::path::Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let ps = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .unwrap();
        for line in String::from_utf8_lossy(&ps.stdout).lines() {
            let ids: Vec<u32> = line
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            if ids.len() != 2 || ids[1] != std::process::id() {
                continue;
            }
            #[cfg(target_os = "macos")]
            let matches = {
                let output = std::process::Command::new("/usr/sbin/lsof")
                    .args(["-a", "-p", &ids[0].to_string(), "-d", "cwd", "-Fn"])
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.strip_prefix('n') == project.to_str())
            };
            #[cfg(not(target_os = "macos"))]
            let matches = std::fs::read_link(format!("/proc/{}/cwd", ids[0]))
                .ok()
                .as_deref()
                == Some(project);
            if matches {
                return ids[0];
            }
        }
        assert!(Instant::now() < deadline, "no fixture child appeared");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn queued_answers_fail_exactly_once_on_close_and_stale_generations_are_refused() {
    let mut p = CodexFixture::create(Scenario::HangThread).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p, "chat")).unwrap();
    assert!(p
        .respond_permission("chat", TurnId(2), AnswerId(90), "x", "allow")
        .is_err());
    for id in 1..=8 {
        p.respond_permission("chat", TurnId(1), AnswerId(id), "x", "allow")
            .unwrap();
    }
    assert!(p
        .respond_permission("chat", TurnId(1), AnswerId(9), "x", "allow")
        .is_err());
    p.close_chat("chat", TurnId(2)).unwrap();
    assert_eq!(monitor.workers(), 1);
    p.close_chat("chat", TurnId(1)).unwrap();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    let events = p.take_events();
    for id in 1..=8 {
        assert_eq!(events.iter().filter(|e|matches!(e,ProviderEvent::AnswerSettled{answer,outcome:AnswerOutcome::Failed(_),..}if answer.0==id)).count(),1);
    }
    assert!(!events.iter().any(|e| matches!(
        e,
        ProviderEvent::AnswerSettled {
            answer: AnswerId(9),
            ..
        }
    )));
}
#[test]
fn question_answers_reach_the_node_fake_and_settle_once() {
    let mut p = CodexFixture::create(Scenario::Question).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p, "chat")).unwrap();
    let events = collect(&mut p, |e| {
        e.iter()
            .any(|e| matches!(e,ProviderEvent::Agent {event:RawJson(event),..}if event["type"]=="question-request"))
    });
    let card = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::Agent {
                event: RawJson(event),
                ..
            } if event["type"] == "question-request" => Some(event),
            _ => None,
        })
        .unwrap();
    let id = card["requestId"].as_str().unwrap();
    p.answer_question(
        "chat",
        TurnId(1),
        AnswerId(1),
        id,
        &json!({"color":["Green"]}),
    )
    .unwrap();
    let events = collect(&mut p, |e| {
        e.iter().any(terminal)
            && e.iter()
                .any(|e| matches!(e, ProviderEvent::AnswerSettled { .. }))
    });
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(
                e,
                ProviderEvent::AnswerSettled {
                    answer: AnswerId(1),
                    outcome: AnswerOutcome::Accepted,
                    ..
                }
            ))
            .count(),
        1
    );
    p.shutdown();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn owner_question_ticket_waits_for_native_answer_and_preserves_unknown_request_state() {
    let p = CodexFixture::create(Scenario::Question).unwrap();
    let monitor = p.monitor();
    let project = p.project().to_path_buf();
    let mut host = ChatHost::new(ProjectStates::new(p.isolation(), Timing::default(), 1000));
    host.register(Box::new(p));
    host.send(&json!({"projectPath":project,"sessionId":1,"provider":"codex","body":"question","permissionMode":"ask"})).unwrap();
    let chat = agent_runs::chat_key(project.to_str().unwrap(), &json!(1));
    let deadline = Instant::now() + Duration::from_secs(5);
    let request_id = loop {
        assert!(host.pump().is_empty());
        let notices = host.take_notices();
        if let Some(id) = notices.iter().find_map(|n| match n {
            Notice::Event { event, .. } if event["type"] == "question-request" => {
                event["requestId"].as_str().map(str::to_owned)
            }
            _ => None,
        }) {
            break id;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    };
    let baseline = host.states.whole_state(&project).unwrap()["messages"]
        .as_array()
        .unwrap()
        .len();
    let unknown = host
        .answer_question(
            &json!({"chatId":chat,"requestId":"unknown","answers":{"color":["Green"]}}),
        )
        .unwrap();
    let AnswerTicket::Pending(unknown) = unknown else {
        panic!("must defer")
    };
    assert_eq!(
        host.states.whole_state(&project).unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        baseline
    );
    let wait = |host: &mut ChatHost, id| {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            assert!(host.pump().is_empty());
            if let Some(result) = host.take_notices().into_iter().find_map(|n| match n {
                Notice::AnswerSettled { answer, result, .. } if answer == id => Some(result),
                _ => None,
            }) {
                break result;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    assert_eq!(wait(&mut host, unknown), AnswerResult::NotWaiting);
    assert_eq!(
        host.states.whole_state(&project).unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        baseline
    );
    let AnswerTicket::Pending(answer) = host
        .answer_question(
            &json!({"chatId":chat,"requestId":request_id,"answers":{"color":["Green"]}}),
        )
        .unwrap()
    else {
        panic!("must defer")
    };
    assert_eq!(wait(&mut host, answer), AnswerResult::Accepted);
    while host.is_busy(&chat) {
        assert!(host.pump().is_empty());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    host.shutdown(false).unwrap();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn cancellation_after_native_write_reports_uncertain_not_failed() {
    let mut p = CodexFixture::create(Scenario::QuestionDelayedReceipt).unwrap();
    let monitor = p.monitor();
    p.start_turn(TurnId(1), &request(&p, "chat")).unwrap();
    collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(event),..}if event["type"]=="question-request"))
    });
    p.answer_question(
        "chat",
        TurnId(1),
        AnswerId(1),
        "srv-q",
        &json!({"color":["Green"]}),
    )
    .unwrap();
    let native = collect(&mut p, |e| {
        e.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(event),..}if event["type"]=="text-delta"&&event["text"].as_str().is_some_and(|s|s.contains("Green"))))
    });
    assert!(
        !native
            .iter()
            .any(|e| matches!(e, ProviderEvent::AnswerSettled { .. })),
        "receipt must still be delayed"
    );
    p.close_chat("chat", TurnId(1)).unwrap();
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
    assert!(!events.iter().any(|e| matches!(
        e,
        ProviderEvent::AnswerSettled {
            outcome: AnswerOutcome::Failed(_) | AnswerOutcome::Accepted,
            ..
        }
    )));
}
#[test]
fn delayed_receipt_keeps_history_blocks_retry_and_resolves_without_second_rpc_notice() {
    let p = CodexFixture::create(Scenario::QuestionDelayedReceipt).unwrap();
    let monitor = p.monitor();
    let project = p.project().to_path_buf();
    let mut host = ChatHost::new(ProjectStates::new(p.isolation(), Timing::default(), 1000));
    host.answer_capacity = 1;
    host.answer_grace_ms = 10;
    host.register(Box::new(p));
    let chat = agent_runs::chat_key(project.to_str().unwrap(), &json!(1));
    host.send(&json!({"projectPath":project,"sessionId":1,"provider":"codex","body":"question","permissionMode":"ask"})).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(host.pump().is_empty());
        if host
            .take_notices()
            .iter()
            .any(|n| matches!(n,Notice::Event{event,..}if event["type"]=="question-request"))
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let marker = "literal \u{10fffe}\u{f0000} / \u{10fffe}\u{10fffd}";
    let request = json!({"chatId":chat,"requestId":"srv-q","summary":milagre_owner_store::jsjson::js_string(marker),"answers":{"color":[milagre_owner_store::jsjson::js_string(marker)]}});
    let AnswerTicket::Pending(answer) = host.answer_question(&request).unwrap() else {
        panic!("must wait")
    };
    loop {
        assert!(host.pump().is_empty());
        if host
            .take_notices()
            .iter()
            .any(|n| matches!(n,Notice::Event{event,..}if event["type"]=="text-delta"))
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(host.tick(1011).is_empty());
    assert_eq!(host.take_notices().iter().filter(|n|matches!(n,Notice::AnswerSettled{answer:id,result:AnswerResult::Uncertain(_),..}if *id==answer)).count(),1);
    assert_eq!(host.answers_in_flight(), 1);
    assert!(matches!(
        host.answer_question(&request).unwrap_err(),
        milagre_owner_store::StoreError::AnswerDeliveryUnknown(_)
    ));
    let mut other = request.clone();
    other["requestId"] = json!("other");
    assert!(matches!(
        host.answer_question(&other).unwrap_err(),
        milagre_owner_store::StoreError::AnswersAtCapacity(_)
    ));
    // Actual native reply echoes the raw markers. Owner serialization must decode one layer,
    // without interpreting their adjacent codepoints as a surrogate or doubling them again.
    let state = host.states.whole_state(&project).unwrap();
    let raw: Value = serde_json::from_str(&milagre_owner_store::jsjson::to_string(&state)).unwrap();
    assert!(raw["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "user" && m["body"] == marker));
    assert!(raw["messages"].as_array().unwrap().iter().any(
        |m| m["role"] == "assistant" && m["body"].as_str().is_some_and(|s| s.contains(marker))
    ));
    loop {
        assert!(host.pump().is_empty());
        let notices = host.take_notices();
        assert!(!notices
            .iter()
            .any(|n| matches!(n,Notice::AnswerSettled{answer:id,..}if *id==answer)));
        if notices.iter().any(|n|matches!(n,Notice::AnswerResolved{answer:id,result:AnswerResult::Accepted,..}if *id==answer)){break}
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(host.answers_in_flight(), 0);
    host.shutdown(false).unwrap();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
}

#[test]
fn native_cli_receives_decoded_prompt_and_answers_while_disk_keeps_original_utf16() {
    use milagre_owner_store::jsjson;
    let p = CodexFixture::create(Scenario::QuestionInputProbe).unwrap();
    let monitor = p.monitor();
    let project = p.project().to_path_buf();
    let isolation = p.isolation();
    let mut host = ChatHost::new(ProjectStates::new(
        isolation.clone(),
        Timing::default(),
        1000,
    ));
    host.register(Box::new(p));
    let chat = agent_runs::chat_key(project.to_str().unwrap(), &json!(1));
    let prefix = "prompt marker:\u{10fffe}\u{f0000} PUA:\u{e000} emoji:😀 halves:";
    let mut prompt_units: Vec<u16> = prefix.encode_utf16().collect();
    prompt_units.extend([0xd800, 0x20, 0xdc00]);
    let prompt = jsjson::from_utf16(&prompt_units);
    let native_prompt = String::from_utf16_lossy(&prompt_units);
    host.send(&json!({"projectPath":project,"sessionId":1,"provider":"codex","body":prompt,"permissionMode":"ask","clientMessageId":"codec-input"})).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(host.pump().is_empty());
        if host
            .take_notices()
            .iter()
            .any(|n| matches!(n,Notice::Event{event,..}if event["type"]=="question-request"))
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        monitor.native_input_probe().unwrap()["input"][0]["text"],
        native_prompt
    );
    let mut answer_units: Vec<u16> = "answer marker:\u{10fffe}\u{f0000} PUA:\u{e000} half:"
        .encode_utf16()
        .collect();
    answer_units.extend([0xd83d, 0x21]);
    let answer = jsjson::from_utf16(&answer_units);
    let native_answer = String::from_utf16_lossy(&answer_units);
    let AnswerTicket::Pending(id)=host.answer_question(&json!({"chatId":chat,"requestId":"srv-q","summary":answer,"answers":{"color":[answer]}})).unwrap() else {panic!("must await native receipt")};
    loop {
        assert!(host.pump().is_empty());
        if host.take_notices().iter().any(|n|matches!(n,Notice::AnswerSettled{answer:known,result:AnswerResult::Accepted,..}if *known==id)){break}
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let probe = monitor.native_input_probe().unwrap();
    assert_eq!(probe["input"][0]["text"], native_prompt);
    assert_eq!(
        probe["answer"]["result"]["answers"]["color"]["answers"][0],
        native_answer
    );
    while host.is_busy(&chat) {
        assert!(host.pump().is_empty());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    host.shutdown(false).unwrap();
    assert!(monitor.wait_stopped(Duration::from_secs(3)));
    let mut reopened = ProjectStates::new(isolation, Timing::default(), 2000);
    let state = reopened.whole_state(&project).unwrap();
    let messages = state["messages"].as_array().unwrap();
    assert!(messages.iter().any(|m| m["role"] == "user"
        && m["clientMessageId"] == "codec-input"
        && m["body"]
            .as_str()
            .is_some_and(|s| jsjson::to_utf16(s) == prompt_units)));
    assert!(messages.iter().any(|m| m["role"] == "user"
        && m["body"]
            .as_str()
            .is_some_and(|s| jsjson::to_utf16(s) == answer_units)));
    reopened.close().unwrap();
}
