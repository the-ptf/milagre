//! Explicit selected-account acceptance helper. Root stages this beside chat-runtime.
//! Usage: owned_chat_live <existing-dedicated-root> <reply-marker> <new-report.json>
//! No account/profile/socket/executable discovery and no retry or process signals.
use futures::FutureExt;
use milagre_daemon_client::{
    ChatPageOptions, ClientOptions, Error, Notice, OwnedChatGuard, OwnedChatShutdown,
    PermissionDecision, SendOptions, SendTarget,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    future::Future,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    pin::pin,
    process::ExitCode,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn wait<F: Future>(future: F, budget: Duration, label: &str) -> Result<F::Output, String> {
    let mut future = pin!(future);
    let until = Instant::now() + budget;
    loop {
        if let Some(value) = future.as_mut().now_or_never() {
            return Ok(value);
        }
        if Instant::now() >= until {
            return Err(format!(
                "Timed out: {label}; submitted work may still have executed"
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn rpc<T>(future: impl Future<Output = Result<T, Error>>, label: &str) -> Result<T, String> {
    wait(future, Duration::from_secs(20), label)?.map_err(|error| error.to_string())
}
fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.to_owned())
}

fn turn(guard: &OwnedChatGuard, marker: &str, report: &mut Value) -> Result<(), String> {
    let options = ClientOptions {
        request_timeout: Duration::from_secs(15),
        ..ClientOptions::default()
    };
    let (client, hello, mut notifications) = rpc(guard.connect(options), "connect")?;
    report["hello"] = json!({"wire":hello.wire,"capabilities":hello.capabilities});
    let actions = guard
        .chat_actions(&client)
        .map_err(|error| error.to_string())?;
    let mut send_attempted = false;
    let result = (|| {
        rpc(client.open_view(guard.project()), "explicit Project open")?;
        let snapshot = rpc(client.runtime_snapshot(), "runtime snapshot")?;
        // This standalone check's local state application precedes event release.
        // A GUI replaces this assignment with its real reducer application.
        let applied_snapshot = snapshot.body.clone();
        require(
            applied_snapshot["projects"]
                .as_array()
                .is_some_and(|projects| {
                    projects
                        .iter()
                        .any(|project| project["path"] == guard.project())
                }),
            "Snapshot is missing the owned Project",
        )?;
        rpc(client.accept_snapshot(&snapshot), "snapshot acknowledgment")?;
        report["snapshot"] = json!({"eventSeq":snapshot.event_seq,"appliedBeforeAccept":true});
        let page = ChatPageOptions {
            limit: Some(500),
            ..ChatPageOptions::default()
        };
        let before = rpc(
            client.chat_messages(guard.project(), 1, page.clone()),
            "transcript before send",
        )?;
        let before_total = before["total"].as_u64().ok_or("Missing transcript total")?;
        report["beforeTotal"] = json!(before_total);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let client_id = format!("owned-live-{}-{nanos}", std::process::id());
        let body = format!("This is a no-tools transport check. Do not use any tools, read files, or perform other actions. Reply with exactly this text and nothing else: {marker}");
        report["clientMessageId"] = json!(client_id);
        report["sendAttempted"] = json!(true);
        report["sendDisposition"] =
            json!("uncertain until receipt, events and transcript are reconciled");
        send_attempted = true;
        report["sendReceipt"] = rpc(
            actions.send(
                SendTarget::Existing(1),
                &body,
                &client_id,
                SendOptions::default(),
            ),
            "single send",
        )?;
        require(
            report["sendReceipt"]["sessionId"] == 1,
            "Send receipt names another Chat",
        )?;

        let until = Instant::now() + Duration::from_secs(150);
        let mut last_wire_seq = snapshot.event_seq;
        let mut event_count = 0usize;
        let mut types = BTreeMap::<String, usize>::new();
        let mut streamed = String::new();
        let mut completed = false;
        while Instant::now() < until {
            let notice = notifications.next().now_or_never().flatten();
            let Some(notice) = notice else {
                thread::sleep(Duration::from_millis(20));
                continue;
            };
            let Notice::Event {
                wire_seq,
                channel,
                payload,
                ..
            } = notice
            else {
                return Err(format!(
                    "Notifications closed before completion: {notice:?}"
                ));
            };
            require(
                wire_seq > last_wire_seq,
                "Notification sequence did not increase",
            )?;
            last_wire_seq = wire_seq;
            event_count += 1;
            require(
                event_count <= 2048,
                "Event observation exceeded 2048 events",
            )?;
            if channel != "agent:event" || payload["chatId"] != format!("{}#1", guard.project()) {
                continue;
            }
            let event = &payload["event"];
            let kind = event["type"].as_str().unwrap_or("missing-type");
            *types.entry(kind.to_owned()).or_default() += 1;
            match kind {
                "permission-request" => {
                    let request_id = event["requestId"]
                        .as_str()
                        .ok_or("Permission has no request ID")?;
                    let denial = rpc(
                        actions.respond_permission(1, request_id, PermissionDecision::Deny),
                        "deny unexpected permission",
                    );
                    report["unexpectedPermission"] = json!({"requestId":request_id,"denied":matches!(denial,Ok(Value::Bool(true)))});
                    return Err("No-tools turn requested a permission; denied and stopping".into());
                }
                "question-request" => return Err("No-tools turn requested a question".into()),
                "text-delta" => {
                    let delta = event["text"]
                        .as_str()
                        .ok_or("Text delta has no string text")?;
                    require(
                        streamed.len() + delta.len() <= 64 * 1024,
                        "Stream observation exceeded 64 KiB",
                    )?;
                    streamed.push_str(delta);
                }
                "turn-completed" => {
                    completed = true;
                    break;
                }
                "turn-failed" | "turn-cancelled" => return Err(format!("Turn ended as {kind}")),
                _ => {}
            }
        }
        report["events"] = json!({"count":event_count,"types":types,"lastWireSeq":last_wire_seq,"streamedText":streamed,"completed":completed});
        require(completed, "No turn-completed event within 150 seconds")?;
        require(
            streamed.trim() == marker,
            "Streamed text differs from the exact marker",
        )?;
        let after = rpc(
            client.chat_messages(guard.project(), 1, page),
            "saved transcript",
        )?;
        require(
            after["total"].as_u64() == Some(before_total + 2),
            "Single send did not save exactly two additional messages",
        )?;
        let messages = after["messages"]
            .as_array()
            .ok_or("Missing transcript messages")?;
        let user = messages
            .iter()
            .find(|message| message["clientMessageId"] == client_id)
            .ok_or("Saved user message is missing")?;
        require(
            user["body"] == body,
            "Saved user message differs from the single submitted body",
        )?;
        let assistant = messages
            .iter()
            .rev()
            .find(|message| message["role"] == "assistant")
            .ok_or("Saved assistant message is missing")?;
        require(
            assistant["body"]
                .as_str()
                .is_some_and(|text| text.trim() == marker)
                && assistant["outcome"] == "completed",
            "Saved assistant marker/outcome differs",
        )?;
        let status = rpc(
            actions.send_status(&client_id),
            "send status reconciliation",
        )?;
        require(
            status == report["sendReceipt"],
            "Send status did not equal the original owner receipt",
        )?;
        report["afterTotal"] = after["total"].clone();
        report["saved"] = json!({"userId":user["id"],"assistantId":assistant["id"],"assistantText":assistant["body"],"outcome":assistant["outcome"]});
        report["sendStatus"] = status;
        report["sendDisposition"] = json!("completed and persisted, with matching send status");
        Ok(())
    })();
    if result.is_err() && send_attempted {
        report["failureInterrupt"] = outcome(rpc(actions.interrupt(1), "failure interrupt"));
    }
    client.disconnect();
    result
}

fn outcome(value: Result<Value, String>) -> Value {
    match value {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}
fn cleanup(guard: &OwnedChatGuard, report: &mut Value) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(20);
    let mut pending = 0;
    loop {
        let result = rpc(guard.shutdown(), "owned shutdown")?;
        match result {
            OwnedChatShutdown::Complete(cleanup) => {
                let temporary = cleanup.temporary;
                report["cleanup"] = json!({"kind":"Complete","pid":temporary.pid,"exitCode":temporary.exit_code,"stopAcknowledged":temporary.stop_acknowledged,"profileRemoved":temporary.profile_removed,"socketRemoved":temporary.socket_removed,"launchStorageRemoved":temporary.launch_storage_removed,"dataRetained":cleanup.data_retained,"pendingObservations":pending});
                return require(
                    temporary.exit_code == Some(0)
                        && temporary.stop_acknowledged
                        && temporary.profile_removed
                        && temporary.socket_removed
                        && temporary.launch_storage_removed
                        && cleanup.data_retained,
                    "Complete cleanup did not meet all acceptance flags",
                );
            }
            OwnedChatShutdown::Pending {
                stop_acknowledged,
                reason,
            } => {
                pending += 1;
                report["cleanup"] = json!({"kind":"Pending","stopAcknowledged":stop_acknowledged,"reason":reason,"observations":pending});
                if Instant::now() >= until {
                    return Err("Owned cleanup still Pending after 20 seconds; ownership outcome remains unconfirmed".into());
                }
                thread::sleep(Duration::from_millis(100));
            }
            OwnedChatShutdown::Unknown { reason } => {
                report["cleanup"] = json!({"kind":"Unknown","reason":reason});
                return Err(
                    "Owned child cleanup is Unknown; no signals, replay or data removal attempted"
                        .into(),
                );
            }
        }
    }
}

fn run(root: &Path, marker: &str, report: &mut Value) -> Result<(), String> {
    let guard = rpc(OwnedChatGuard::open(root), "open dedicated runtime")?;
    let info = guard.info();
    report["runtime"] = json!({"pid":info.pid,"project":info.project,"dataRoot":info.data_root,"profile":info.profile,"socket":info.socket,"launchRoot":info.launch_root,"model":info.model,"accountId":info.account_id});
    let result = turn(&guard, marker, report);
    if let Err(error) = &result {
        report["turnError"] = json!(error);
    }
    let closed = cleanup(&guard, report);
    if let Err(error) = &closed {
        report["cleanupError"] = json!(error);
    }
    result.and(closed)
}

fn main() -> ExitCode {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() != 3
        || !Path::new(&arguments[0]).is_absolute()
        || !Path::new(&arguments[2]).is_absolute()
        || arguments[1].is_empty()
        || arguments[1].len() > 256
        || !arguments[1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        eprintln!("Usage: owned_chat_live <absolute-existing-dedicated-root> <1..256 ASCII alphanumeric/underscore/hyphen marker> <absolute-new-report.json>");
        return ExitCode::FAILURE;
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&arguments[2]);
    let mut file: File = match file {
        Ok(file) => file,
        Err(error) => {
            eprintln!("Could not create the new private report: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut report = json!({"schemaVersion":1,"kind":"public-owned-chat-selected-account-no-tools","clientCrate":env!("CARGO_PKG_NAME"),"clientVersion":env!("CARGO_PKG_VERSION"),"runnerPid":std::process::id(),"expectedMarker":arguments[1],"passed":false,"sendAttempted":false,"signalsSent":0,"automaticReplays":0});
    let result = run(Path::new(&arguments[0]), &arguments[1], &mut report);
    if let Err(error) = result {
        report["error"] = json!(error);
    } else {
        report["passed"] = json!(true);
    }
    let written = serde_json::to_writer_pretty(&mut file, &report)
        .and_then(|()| file.write_all(b"\n").map_err(serde_json::Error::io));
    if let Err(error) = written {
        eprintln!("Could not write private report: {error}");
        return ExitCode::FAILURE;
    }
    println!(
        "{}",
        json!({"passed":report["passed"],"report":arguments[2],"cleanup":report["cleanup"],"error":report["error"]})
    );
    if report["passed"] == true {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
