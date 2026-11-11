use milagre_owner_store::{
    agent_runs,
    chat_host::{ChatHost, Provider, ProviderEvent, TurnId},
    states::{ProjectStates, Timing},
};
use milagre_rust_runtime::codex_fixture::{CodexFixture, Scenario};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
fn request(p: &CodexFixture, chat: &str) -> Value {
    json!({"provider":"codex","cwd":p.project(),"chatId":chat,"prompt":"hello","permissionMode":"ask"})
}
fn terminal(e: &ProviderEvent) -> bool {
    matches!(e,ProviderEvent::Agent{event,..} if matches!(event["type"].as_str(),Some("turn-completed"|"turn-failed"|"turn-cancelled")))
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
                ProviderEvent::Agent { event, .. } if event["type"] == "text-delta" =>
                    event["text"].as_str(),
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
        p.close_chat("chat").unwrap();
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
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive(pid) {
            assert!(
                Instant::now() < deadline,
                "cancelled startup left child {pid}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
#[test]
fn refusal_precedes_spawn_and_approval_answer_does_not_report_success() {
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
            |e| matches!(e,ProviderEvent::Agent{event,..} if event["type"]=="permission-request"),
        )
    });
    assert!(p.respond_permission("chat", "srv-1", "allow").is_err());
    assert!(p.answer_question("chat", "srv-1", &json!({})).is_err());
    assert!(p.start_turn(TurnId(2), &request(&p, "chat")).is_err());
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
    p.close_chat("chat").unwrap();
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
        .any(|e| matches!(e,ProviderEvent::Agent{event,..}if event["type"]=="turn-failed")));
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
fn owner_unicode_markers_are_decoded_and_lone_units_are_explicitly_refused() {
    let mut p = CodexFixture::create(Scenario::Reply).unwrap();
    let monitor = p.monitor();
    let mut req = request(&p, "chat");
    req["prompt"] = milagre_owner_store::jsjson::parse(r#""half\ud800""#).unwrap();
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
