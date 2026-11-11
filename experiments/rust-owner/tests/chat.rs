//! ChatHost conformance: every trace of fixtures/chat-traces.json runs through Node's real ChatHost over its real
//! ProjectStates with a mocked provider (fixtures/chat-node.cjs) and through the Rust ChatHost with `MockProvider`,
//! from the same seeded Project. Each step's answer, what the host told its clients (events with their sequence
//! numbers, broadcasts, queue callbacks), the turns the provider was asked to start, interrupts, the saved state and
//! the runs must match. Plus the gates: what this checkpoint refuses instead of approximating.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use milagre_owner_store::chat_host::AnswerResult;
use milagre_owner_store::chat_host::{
    AnswerTicket, ChatHost, MockProvider, Notice, SteeringMode, TurnId,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::{self, RawJson};
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Map, Value};

struct Run {
    isolation: Isolation,
    project: PathBuf,
    host: ChatHost,
    mock: MockProvider,
    counter: Arc<AtomicU64>,
    turns_seen: usize,
    interrupts_seen: usize,
    /// Notices a step already took (to read a start's result), told with the step's line.
    held: Vec<Notice>,
}

fn host_for(
    isolation: &Isolation,
    now: i64,
    mock: &MockProvider,
    counter: &Arc<AtomicU64>,
) -> ChatHost {
    let mut host = ChatHost::new(ProjectStates::new(
        isolation.clone(),
        Timing::default(),
        now,
    ));
    host.register(Box::new(mock.clone()));
    host.register(Box::new(MockProvider::sharing("claude", mock)));
    host.steering = SteeringMode::Recorded;
    let counter = counter.clone();
    host.set_ids(move || {
        let next = counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{next:012}")
    });
    host
}

impl Run {
    fn clean(&self, text: &str) -> String {
        common::normalize(text, &self.project)
    }

    fn clean_value(&self, value: &Value) -> Value {
        jsjson::parse(&self.clean(&jsjson::to_string(value))).unwrap()
    }

    fn chat(&self, session: &Value) -> String {
        format!(
            "{}#{}",
            self.project.display(),
            jsjson::property_key(Some(session))
        )
    }

    fn attempt(&self, result: milagre_owner_store::Result<Value>) -> Value {
        result.unwrap_or_else(|error| json!({ "error": self.clean(&error.to_string()) }))
    }

    fn step(&mut self, step: &Value) -> Value {
        let p = self.project.clone();
        match step["op"].as_str().unwrap() {
            "open" => {
                self.host.states.get(&p).unwrap();
                Value::Null
            }
            "send" => {
                let mut request = step["request"].clone();
                request["projectPath"] = json!(p.display().to_string());
                let result = self.host.send(&request);
                // Node awaits `sent.started`: the start answers through the provider's events.
                self.host.pump();
                let notices = self.host.take_notices();
                let result = result.map(|sent| {
                    let started = if sent.duplicate {
                        Value::Null
                    } else if sent.queued {
                        json!("waiting")
                    } else if sent.steering {
                        // The runtime's dispatch, emulated as Node's mocked SessionManager answers a steer.
                        let request = notices.iter().find_map(|notice| match notice {
                            Notice::SteerRequested { request, .. } => Some(request.clone()),
                            _ => None,
                        });
                        let mut mock = self.mock.state.lock().unwrap();
                        mock.turns.extend(request);
                        mock.next_turn += 1;
                        json!({ "turnId": format!("turn-{}", mock.next_turn), "steered": true })
                    } else {
                        notices
                            .iter()
                            .find_map(|notice| match notice {
                                Notice::Started { turn, result, .. } if Some(*turn) == sent.turn => Some(result.clone()),
                                _ => None,
                            })
                            .unwrap_or(Value::Null)
                    };
                    json!({ "sessionId": sent.session_id, "duplicate": sent.duplicate, "queued": sent.queued, "started": started })
                });
                self.held.extend(notices);
                self.attempt(result)
            }
            "failNextStart" => {
                self.mock.state.lock().unwrap().fail_next_start =
                    Some(step["message"].as_str().unwrap().into());
                Value::Null
            }
            "event" => {
                let chat = self.chat(&step["session"]);
                // The trace holds encoded JSON; a provider hands over raw JSON, which the host encodes once.
                self.mock
                    .emit(&chat, RawJson::decode(&step["event"]).unwrap().0);
                let errors = self.host.pump();
                match errors.into_iter().next() {
                    Some(error) => json!({ "error": self.clean(&error.to_string()) }),
                    None => Value::Null,
                }
            }
            "interrupt" => {
                let chat = self.chat(&step["session"]);
                self.host.interrupt(&chat).unwrap();
                Value::Null
            }
            "queueSend" => {
                let chat = self.chat(&step["session"]);
                let result = self
                    .host
                    .send_queued_now(&chat, step["id"].as_str().unwrap())
                    .map(|_| Value::Null);
                self.attempt(result)
            }
            "queueRemove" => {
                let chat = self.chat(&step["session"]);
                let result = self
                    .host
                    .remove_queued(&chat, step["id"].as_str().unwrap())
                    .map(Value::Bool);
                self.attempt(result)
            }
            "refuseAnswers" => {
                self.mock.state.lock().unwrap().refuse_answers = step["refuse"].as_bool().unwrap();
                Value::Null
            }
            "respondPermission" => {
                let request = json!({ "chatId": self.chat(&step["session"]), "requestId": step["requestId"], "decision": step["decision"] });
                let ticket = self.host.respond_permission(&request);
                self.settled(ticket)
            }
            "answerQuestion" => {
                let mut request = json!({ "chatId": self.chat(&step["session"]), "requestId": step["requestId"], "answers": step["answers"] });
                if let Some(summary) = step.get("summary") {
                    request["summary"] = summary.clone();
                }
                let ticket = self.host.answer_question(&request);
                self.settled(ticket)
            }
            "sendStatus" => {
                let result = self.host.send_status(&p, &step["id"]);
                self.attempt(result)
            }
            "advance" => {
                let to = self.host.states.now() + step["ms"].as_i64().unwrap();
                self.host.states.advance(to);
                Value::Null
            }
            "flush" => {
                let result = self.host.states.flush(Some(&p)).map(|_| Value::Null);
                self.attempt(result)
            }
            "crash" => {
                let now = self.host.states.now();
                let next = host_for(&self.isolation, now, &self.mock, &self.counter);
                let old = std::mem::replace(&mut self.host, next);
                old.states.abandon().unwrap();
                Value::Null
            }
            "snapshot" => jsjson::parse(&common::snapshot(&p)).unwrap(),
            other => panic!("unknown step {other}"),
        }
    }

    /// What Node's awaited answer command gives: a pending ticket waits for its settlement through the provider's
    /// events.
    fn settled(&mut self, ticket: milagre_owner_store::Result<AnswerTicket>) -> Value {
        let answer = match ticket {
            Err(error) => return json!({ "error": self.clean(&error.to_string()) }),
            Ok(AnswerTicket::Settled(accepted)) => return Value::Bool(accepted),
            Ok(AnswerTicket::Pending(answer)) => answer,
        };
        self.host.pump();
        let notices = self.host.take_notices();
        let result = notices.iter().find_map(|notice| match notice {
            Notice::AnswerSettled {
                answer: settled,
                result,
                ..
            } if *settled == answer => Some(result.clone()),
            _ => None,
        });
        self.held.extend(notices);
        match result {
            Some(AnswerResult::Accepted) => Value::Bool(true),
            Some(AnswerResult::NotWaiting) => Value::Bool(false),
            Some(AnswerResult::Failed(error)) => json!({ "error": self.clean(&error) }),
            Some(AnswerResult::Uncertain(error)) => json!({ "uncertain": self.clean(&error) }),
            None => json!("unsettled"),
        }
    }

    fn line(&mut self, op: &str, result: Value) -> String {
        // Starts the step asked for answer through the provider's events, as Node's settle waits for them.
        let late: Vec<Value> = self
            .host
            .pump()
            .iter()
            .map(|error| json!({ "pumpError": self.clean(&error.to_string()) }))
            .collect();
        let mut taken = std::mem::take(&mut self.held);
        taken.extend(self.host.take_notices());
        let notices: Vec<Value> = taken
            .into_iter()
            .filter(|notice| {
                !matches!(
                    notice,
                    Notice::Started { .. } | Notice::AnswerSettled { .. } | Notice::AnswerResolved { .. } | Notice::SteerRequested { .. }
                )
            })
            .map(|notice| match notice {
                Notice::Event {
                    event,
                    seq,
                    with_state,
                    ..
                } => json!({ "event": event["type"], "seq": seq, "state": with_state, "payload": self.clean_value(&event) }),
                Notice::Broadcast { .. } => json!({ "broadcast": true }),
                Notice::NameChat { session, .. } => json!({ "nameChat": session }),
                Notice::QueueStarted { result, .. } => json!({ "queuedStarted": result }),
                Notice::QueueStartedWithoutSender { id, .. } => {
                    json!({ "queueStartedWithoutSender": id })
                }
                Notice::QueueRemovedWithoutSender { id, .. } => {
                    json!({ "queueRemovedWithoutSender": id })
                }
                Notice::Gap { what, .. } => json!({ "gap": what }),
                Notice::Failed { what, error, .. } => json!({ "failed": what, "error": error }),
                Notice::AnswerForgotten { answer, .. } => json!({ "answerForgotten": answer.0 }),
                Notice::Started { .. } | Notice::AnswerSettled { .. } | Notice::AnswerResolved { .. } | Notice::SteerRequested { .. } => {
                    unreachable!()
                }
            })
            .chain(late)
            .collect();
        let (turns, interrupts, answers) = {
            let mut state = self.mock.state.lock().unwrap();
            let answers = std::mem::take(&mut state.answers);
            (
                state.turns[self.turns_seen..].to_vec(),
                state.interrupts[self.interrupts_seen..].to_vec(),
                answers,
            )
        };
        self.turns_seen += turns.len();
        self.interrupts_seen += interrupts.len();
        let state = self.host.states.current(&self.project);
        let mut line = Map::new();
        line.insert("op".into(), json!(op));
        line.insert("result".into(), result);
        line.insert("notices".into(), Value::Array(notices));
        line.insert(
            "turns".into(),
            Value::Array(turns.iter().map(|turn| self.clean_value(turn)).collect()),
        );
        line.insert(
            "interrupts".into(),
            Value::Array(
                interrupts
                    .iter()
                    .map(|chat| json!(self.clean(chat)))
                    .collect(),
            ),
        );
        line.insert(
            "answers".into(),
            Value::Array(
                answers
                    .iter()
                    .map(|answer| self.clean_value(answer))
                    .collect(),
            ),
        );
        line.insert(
            "ids".into(),
            json!(state
                .as_ref()
                .map(|s| s
                    .message_list()
                    .iter()
                    .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
                    .collect::<Vec<_>>())
                .unwrap_or_default()),
        );
        let text = state
            .map(|state| jsjson::to_string(&state.to_value()))
            .unwrap_or_else(|| "null".into());
        line.insert("hash".into(), json!(common::sha256(&self.clean(&text))));
        line.insert(
            "runs".into(),
            self.clean_value(&Value::Object(self.host.runs().clone())),
        );
        jsjson::to_string(&Value::Object(line))
    }
}

#[test]
fn rust_chat_host_matches_node() {
    if common::node().is_none() {
        return;
    }
    let traces_file = common::crate_dir().join("fixtures/chat-traces.json");
    let driver = common::crate_dir().join("fixtures/chat-node.cjs");
    let traces = jsjson::parse_bytes(&std::fs::read(&traces_file).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0;
    for trace in traces.as_array().unwrap() {
        let name = trace["name"].as_str().unwrap();
        let base = tempfile::tempdir().unwrap();
        let seeded = base.path().join("seed/project");
        let node_dir = base.path().join("node/project");
        let node = |args: &[&str]| {
            let output = std::process::Command::new("node")
                .arg(&driver)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: node {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        node(&[
            "seed",
            traces_file.to_str().unwrap(),
            name,
            seeded.to_str().unwrap(),
        ]);
        common::copy_tree(&seeded, &node_dir);
        let isolation = Isolation::create(&base.path().join("rust"), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("project")).unwrap();
        common::copy_tree(&seeded, &project);
        let lines: Vec<Value> = String::from_utf8(node(&[
            "run",
            traces_file.to_str().unwrap(),
            name,
            node_dir.to_str().unwrap(),
        ]))
        .unwrap()
        .lines()
        .map(|line| jsjson::parse(line).unwrap())
        .collect();
        let steps = trace["steps"].as_array().unwrap();
        assert_eq!(
            lines.len(),
            steps.len(),
            "{name}: Node ran {} of {} steps",
            lines.len(),
            steps.len()
        );
        let mock = MockProvider::new("kiro");
        let counter = Arc::new(AtomicU64::new(0));
        let host = host_for(
            &isolation,
            trace["start"].as_i64().unwrap(),
            &mock,
            &counter,
        );
        let mut run = Run {
            isolation,
            project,
            host,
            mock,
            counter,
            turns_seen: 0,
            interrupts_seen: 0,
            held: Vec::new(),
        };
        for (index, (step, node)) in steps.iter().zip(&lines).enumerate() {
            let op = step["op"].as_str().unwrap();
            let result = run.step(step);
            let rust = run.line(op, result);
            let expected =
                String::from_utf16(&jsjson::to_utf16(node["line"].as_str().unwrap())).unwrap();
            compared += 1;
            if rust != expected {
                let at = rust
                    .bytes()
                    .zip(expected.bytes())
                    .position(|(a, b)| a != b)
                    .unwrap_or(0);
                let from = at.saturating_sub(150);
                failures.push(format!(
                    "{name} step {index} ({op}):\n  node: …{}\n  rust: …{}",
                    expected
                        .get(from..(at + 250).min(expected.len()))
                        .unwrap_or(&expected),
                    rust.get(from..(at + 250).min(rust.len())).unwrap_or(&rust)
                ));
            }
        }
        run.host.states.close().unwrap();
    }
    assert!(
        failures.is_empty(),
        "{} of {compared} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{compared} ChatHost trace steps match Node");
}

/// What this checkpoint refuses: each gate fails with a clear error and saves nothing.
#[test]
fn unsupported_features_are_refused_not_approximated() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    std::fs::write(
        project.join(".milagre/coordination.json"),
        r#"{"next_id":1,"worktrees":{"1":{"id":1,"path":"/tmp/wt"}},"sessions":{"1":{"id":1,"worktree_id":1},"2":{"id":2,"worktree_id":1,"handoverDraft":"brief"}},"messages":[]}"#,
    )
    .unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    let claude = MockProvider::new("claude");
    host.register(Box::new(claude.clone()));
    host.register(Box::new(MockProvider::new("codex")));
    let path = project.display().to_string();
    let send = |host: &mut ChatHost, extra: Value| {
        let mut request = json!({ "projectPath": path, "sessionId": 1, "provider": "claude", "model": "m", "body": "hi" });
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        host.send(&request).map(|_| ()).unwrap_err().to_string()
    };
    for (extra, expected) in [
        (
            json!({ "images": [{ "dataUrl": "data:image/png;base64,AAAA" }] }),
            "Sending images",
        ),
        (json!({ "context": { "kind": "compaction" } }), "Compacting"),
        (
            json!({ "context": { "kind": "routine-run", "runId": "r" } }),
            "Routine",
        ),
        (json!({ "limitResumeId": "x" }), "Usage-limit"),
        (json!({ "expectedAccountId": "a" }), "account routing"),
        (json!({ "guard": { "level": 1 } }), "wake"),
        (json!({ "delivery": "now" }), "Sending now"),
        (json!({ "delivery": "later" }), "Invalid message delivery."),
        (json!({ "provider": null }), "Choose a provider"),
        (json!({ "sessionId": 2 }), "handed-over"),
    ] {
        let error = send(&mut host, extra.clone());
        assert!(error.contains(expected), "{extra}: {error}");
    }
    host.states.get(&project).unwrap();
    assert!(
        host.states
            .current(&project)
            .unwrap()
            .message_list()
            .is_empty(),
        "a refused send saved something"
    );

    // A running Claude turn: a plain send would steer it in Node; here it is refused (queueing still works).
    host.send(&json!({ "projectPath": path, "sessionId": 1, "provider": "claude", "model": "m", "body": "start" })).unwrap();
    let error = send(&mut host, json!({}));
    assert!(error.contains("Steering a running turn"), "{error}");
    let queued = host.send(&json!({ "projectPath": path, "sessionId": 1, "provider": "claude", "model": "m", "body": "later", "delivery": "queue" })).unwrap();
    assert!(queued.queued);
    // Another provider for a Chat that ran on Claude: a handoff.
    claude.emit(
        &format!("{path}#1"),
        json!({ "type": "session-started", "nativeId": "native" }),
    );
    claude.emit(&format!("{path}#1"), json!({ "type": "turn-completed" }));
    host.pump();
    claude.emit(&format!("{path}#1"), json!({ "type": "turn-completed" }));
    host.pump();
    let error = send(&mut host, json!({ "provider": "codex" }));
    assert!(error.contains("handoff"), "{error}");
    // Events whose folding isn't ported are refused, the run left as it was.
    host.send(&json!({ "projectPath": path, "sessionId": 1, "provider": "claude", "model": "m", "body": "steps" })).unwrap();
    let runs_before = host.runs().clone();
    for (kind, event, expected) in [
        ("context-compacting", json!({}), "context-compacting"),
        ("context-compacted", json!({}), "context-compacted"),
        (
            "step-started",
            json!({ "step": "not a step" }),
            "without a step",
        ),
        ("subagent-update", json!({}), "without an agent"),
        ("tasks-updated", json!({ "tasks": "x" }), "without tasks"),
    ] {
        let mut event = event;
        event["type"] = json!(kind);
        let turn = host.active_turn(&format!("{path}#1")).unwrap_or(TurnId(0));
        let error = host
            .receive(&format!("{path}#1"), turn, &event)
            .unwrap_err()
            .to_string();
        assert!(error.contains(expected), "{kind}: {error}");
    }
    assert_eq!(host.runs(), &runs_before);
    // Answers whose policy isn't ported are refused before anything is shown or handed over.
    let chat = format!("{path}#1");
    for (request, expected) in [
        (
            json!({ "chatId": chat, "requestId": "setup-review-1", "decision": "allow" }),
            "setup review",
        ),
        (
            json!({ "chatId": chat, "requestId": "p1", "decision": "yes" }),
            "Unknown permission decision: yes",
        ),
    ] {
        let error = host.respond_permission(&request).unwrap_err().to_string();
        assert!(error.contains(expected), "{request}: {error}");
    }
    for (request, expected) in [
        (
            json!({ "chatId": chat, "requestId": "milagre-secret-1", "answers": { "q": ["x"] } }),
            "secret",
        ),
        (
            json!({ "chatId": chat, "requestId": "milagre-bug-report-1", "answers": null }),
            "bug report",
        ),
        (
            json!({ "chatId": chat, "requestId": "q1", "answers": { "q": ["x"] }, "summary": "x", "images": { "q": [{ "dataUrl": "data:," }] } }),
            "Images attached",
        ),
        (
            json!({ "chatId": chat, "requestId": "q1", "answers": { "q": ["x"] }, "images": [] }),
            "Invalid images",
        ),
        (
            json!({ "chatId": chat, "requestId": "q1", "answers": { "q": ["x"] }, "suggestionId": "s" }),
            "suggestion card",
        ),
    ] {
        let error = host.answer_question(&request).unwrap_err().to_string();
        assert!(error.contains(expected), "{request}: {error}");
    }
    assert!(
        claude.state.lock().unwrap().answers.is_empty(),
        "a refused answer reached the provider"
    );
    assert_eq!(host.runs(), &runs_before);
    host.states.close().unwrap();
}
