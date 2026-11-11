//! Streaming throughput of ChatHost over an isolated copy with a scripted provider (no real provider, no live data).
//!
//!   cargo run --release --example streaming [-- <repeats> [<workload>]]
//!
//! Workloads (deterministic; the same events every run):
//! - long-reply: one Chat streams a 200 KB reply in 4,000 text deltas of 50 bytes.
//! - many-steps: one Chat runs 1,500 shell steps (start, two 500-byte outputs, completion with its full output).
//! - subagents: one Chat with 10 subagents, 100 updates each (a 20-entry transcript tail that moves on), plus text.
//! - multi-chat: four Chats at once, interleaved: the three above plus a fourth mixing text and steps.
//!
//! Events go through `ChatHost::pump` in batches of 50 (a tick's worth), then every turn completes and the state is
//! flushed. Each workload prints its best time over the repeats, events per second, and a digest of what it produced
//! (the saved state, the runs before the end, and every notice), so a change can show it computes the same thing.

use std::path::Path;
use std::time::Instant;

use milagre_owner_store::chat_host::{ChatHost, MockProvider, Notice};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson;
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CHATS: i64 = 4;

fn long_reply(chat: &str) -> Vec<(String, Value)> {
    (0..4000)
        .map(|n| {
            (
                chat.to_string(),
                json!({ "type": "text-delta", "text": format!("{:0>49}\n", n) }),
            )
        })
        .collect()
}

fn many_steps(chat: &str) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    for n in 0..1500 {
        let id = format!("s{n}");
        let command = format!("$ run task {n}\n");
        events.push((chat.into(), json!({ "type": "step-started", "step": { "id": id, "kind": "shell", "title": format!("Run task {n}"), "detail": command } })));
        let chunk = format!("{}\n", "x".repeat(499));
        events.push((
            chat.into(),
            json!({ "type": "step-output", "id": id, "text": chunk }),
        ));
        events.push((
            chat.into(),
            json!({ "type": "step-output", "id": id, "text": chunk }),
        ));
        let detail = format!("{command}{chunk}{chunk}# pass {n}\n# fail 0\n");
        events.push((
            chat.into(),
            json!({ "type": "step-completed", "id": id, "status": "done", "detail": detail }),
        ));
        if n % 10 == 0 {
            events.push((
                chat.into(),
                json!({ "type": "text-delta", "text": format!("Finished batch {n}.\n") }),
            ));
        }
    }
    events
}

fn subagents(chat: &str) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    for update in 0..100u64 {
        for agent in 0..10u64 {
            let transcript: Vec<Value> = (update.saturating_sub(19)..=update)
                .map(|entry| json!({ "id": format!("a{agent}-e{entry}"), "role": "assistant", "text": format!("Agent {agent} step {entry}: {}", "y".repeat(120)) }))
                .collect();
            let status = if update == 99 { "completed" } else { "running" };
            events.push((chat.into(), json!({ "type": "subagent-update", "agent": {
                "id": format!("agent-{agent}"), "title": format!("Explorer {agent}"), "status": status,
                "startedAt": 1_000, "updatedAt": 1_000 + update, "prompt": "Look around",
                "transcript": transcript,
            } })));
        }
        events.push((
            chat.into(),
            json!({ "type": "text-delta", "text": format!("Waiting on agents ({update}).\n") }),
        ));
    }
    events
}

fn mixed(chat: &str) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    for n in 0..1000 {
        events.push((
            chat.into(),
            json!({ "type": "text-delta", "text": format!("Line {n} of a mixed reply.\n") }),
        ));
        if n % 4 == 0 {
            let id = format!("m{n}");
            events.push((chat.into(), json!({ "type": "step-started", "step": { "id": id, "kind": "read", "title": format!("Read file {n}"), "file": format!("src/{n}.rs") } })));
            events.push((chat.into(), json!({ "type": "step-completed", "id": id, "status": "done", "detail": "z".repeat(300) })));
        }
    }
    events
}

/// Round-robin over the Chats' event lists.
fn interleave(lists: Vec<Vec<(String, Value)>>) -> Vec<(String, Value)> {
    let mut iters: Vec<_> = lists.into_iter().map(|list| list.into_iter()).collect();
    let mut out = Vec::new();
    loop {
        let mut any = false;
        for iter in &mut iters {
            if let Some(item) = iter.next() {
                out.push(item);
                any = true;
            }
        }
        if !any {
            return out;
        }
    }
}

struct Outcome {
    seconds: f64,
    events: usize,
    digest: String,
}

fn run(name: &str, chats: &[i64]) -> Outcome {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let sessions: serde_json::Map<String, Value> =
        (1..=CHATS).map(|id| (id.to_string(), json!({ "id": id, "worktree_id": 1, "provider": "kiro", "native_session_id": format!("n{id}") }))).collect();
    let seed = json!({ "next_id": 100, "worktrees": { "1": { "id": 1, "path": "/tmp/wt", "name": "main" } }, "sessions": sessions, "messages": [] });
    std::fs::write(project.join(".milagre/coordination.json"), seed.to_string()).unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    host.open_project(&project).unwrap();
    let path = project.display().to_string();
    let key = |id: i64| format!("{path}#{id}");
    for &id in chats {
        host.send(&json!({ "projectPath": path, "sessionId": id, "provider": "kiro", "model": "m", "body": format!("Go {id}"), "clientMessageId": format!("c{id}") }))
            .unwrap();
    }
    assert!(host.pump().is_empty());
    let lists: Vec<Vec<(String, Value)>> = chats
        .iter()
        .map(|&id| match (name, id) {
            ("long-reply", _) | (_, 1) => long_reply(&key(id)),
            ("many-steps", _) | (_, 2) => many_steps(&key(id)),
            ("subagents", _) | (_, 3) => subagents(&key(id)),
            _ => mixed(&key(id)),
        })
        .collect();
    let events = interleave(lists);
    let count = events.len();
    let mut digest = Sha256::new();
    let started = Instant::now();
    for batch in events.chunks(50) {
        for (chat, event) in batch {
            kiro.emit(chat, event.clone());
        }
        let errors = host.pump();
        assert!(errors.is_empty(), "{name}: {errors:?}");
        for notice in host.take_notices() {
            if let Notice::Event {
                event,
                seq,
                with_state,
                ..
            } = notice
            {
                digest.update(
                    jsjson::to_string(&event)
                        .replace(&path, "<project>")
                        .as_bytes(),
                );
                digest.update(format!("{seq:?}{with_state}").as_bytes());
            }
        }
    }
    let runs = jsjson::to_string(&Value::Object(host.runs().clone()));
    for &id in chats {
        kiro.emit(&key(id), json!({ "type": "turn-completed" }));
    }
    assert!(host.pump().is_empty());
    host.states.flush(Some(&project)).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    digest.update(runs.replace(&path, "<project>").as_bytes());
    let state = jsjson::to_string(&host.states.current(&project).unwrap().to_value());
    digest.update(state.replace(&path, "<project>").as_bytes());
    host.states.close().unwrap();
    Outcome {
        seconds,
        events: count,
        digest: hex::encode(digest.finalize())[..16].to_string(),
    }
}

fn main() {
    let repeats: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(3);
    println!("workload      events   best s   events/s  digest");
    let only = std::env::args().nth(2);
    for (name, chats) in [
        ("long-reply", vec![1]),
        ("many-steps", vec![2]),
        ("subagents", vec![3]),
        ("multi-chat", vec![1, 2, 3, 4]),
    ] {
        if only.as_deref().is_some_and(|only| only != name) {
            continue;
        }
        let mut best: Option<Outcome> = None;
        for _ in 0..repeats {
            let outcome = run(name, &chats);
            if let Some(previous) = &best {
                assert_eq!(previous.digest, outcome.digest, "{name}: not deterministic");
            }
            if best.as_ref().is_none_or(|b| outcome.seconds < b.seconds) {
                best = Some(outcome);
            }
        }
        let best = best.unwrap();
        println!(
            "{name:<12} {:>7} {:>8.3} {:>10.0}  {}",
            best.events,
            best.seconds,
            best.events as f64 / best.seconds,
            best.digest
        );
    }
}
