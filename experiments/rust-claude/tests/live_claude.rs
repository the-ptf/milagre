//! Opt-in probe of the installed Claude Code CLI: spawn, `initialize`, a few local control requests,
//! close. No user message is sent, so no model turn runs and nothing is billed.
//!
//! Isolation: HOME and CLAUDE_CONFIG_DIR point at a fresh temp directory (no credentials, no user
//! settings, nothing of the user's written), the working directory is empty, MCP is strict and empty,
//! session persistence is off and nonessential traffic is disabled.
//!
//!   MILAGRE_CLAUDE_LIVE=1 [MILAGRE_CLAUDE_BIN=~/.local/share/claude/versions/2.1.322] \
//!     cargo test --test live_claude -- --ignored --nocapture

mod common;

use std::time::Duration;

use milagre_claude::{ClaudeClient, ClaudeEvent, ExitReason, Handlers, InitializeOptions, LaunchOptions, Limits};

fn binary() -> Option<std::path::PathBuf> {
    if std::env::var("MILAGRE_CLAUDE_LIVE").ok().as_deref() != Some("1") {
        return None;
    }
    let path = std::env::var_os("MILAGRE_CLAUDE_BIN")
        .map(Into::into)
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".local/share/claude/versions/2.1.322"));
    Some(path)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn initialize_without_a_turn() {
    let Some(program) = binary() else {
        eprintln!("skipped: set MILAGRE_CLAUDE_LIVE=1");
        return;
    };
    let home = common::scratch("live-home");
    let cwd = common::scratch("live-cwd");
    let mut options = LaunchOptions::new(&program);
    options.cwd = Some(cwd.clone());
    options.env = Some(vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), home.clone().into_os_string()),
        ("CLAUDE_CONFIG_DIR".into(), home.join(".claude").into_os_string()),
        ("TMPDIR".into(), std::env::temp_dir().into_os_string()),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
        ("DISABLE_AUTOUPDATER".into(), "1".into()),
    ]);
    options.permission_mode = Some("default".into());
    options.strict_mcp_config = true;
    options.no_session_persistence = true;
    options.setting_sources = Some(vec!["local".into()]);
    options.include_partial_messages = true;
    let limits =
        Limits { initialize_timeout: Duration::from_secs(30), request_timeout: Some(Duration::from_secs(15)), ..Limits::default() };
    let (client, mut events) = ClaudeClient::spawn(&options, Handlers::default(), limits).expect("spawn the CLI");
    let collector = tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(event) = events.recv().await {
            let done = matches!(event, ClaudeEvent::Exit(_));
            seen.push(event);
            if done {
                break;
            }
        }
        seen
    });

    let init = InitializeOptions { prompt_suggestions: Some(false), ..Default::default() };
    let reply = client.initialize(&init).await;
    match &reply {
        Ok(reply) => {
            let keys: Vec<&String> = reply.payload.as_object().map(|o| o.keys().collect()).unwrap_or_default();
            eprintln!("initialize ok; payload keys: {keys:?}");
            eprintln!("envelope keys: {:?}", reply.raw["response"].as_object().map(|o| o.keys().collect::<Vec<_>>()));
            eprintln!(
                "commands: {}, models: {}",
                reply.payload["commands"].as_array().map_or(0, Vec::len),
                reply.payload["models"].as_array().map_or(0, Vec::len)
            );
            eprintln!(
                "version: {}, capabilities: {}, session_state: {}, account: {}",
                reply.payload["claude_code_version"],
                reply.payload["capabilities"],
                reply.payload["session_state"],
                reply.payload["account"]
            );
            assert!(reply.payload.get("commands").is_some(), "initialize reply lists commands");
        }
        Err(error) => eprintln!("initialize failed: {error}"),
    }
    if reply.is_ok() {
        for (name, result) in [
            ("set_permission_mode default", client.set_permission_mode("default").await.map(|r| r.payload)),
            ("set_permission_mode acceptEdits", client.set_permission_mode("acceptEdits").await.map(|r| r.payload)),
            ("mcp_status", client.mcp_status().await.map(|r| r.payload)),
            ("interrupt (no turn)", client.interrupt(false).await.map(|r| r.payload)),
            ("unknown subtype", client.control("milagre_probe_unknown", serde_json::Value::Null).await.map(|r| r.payload)),
        ] {
            eprintln!(
                "{name}: {}",
                match result {
                    Ok(payload) => format!("ok {payload}"),
                    Err(error) => format!("err {error}"),
                }
            );
        }
    }
    let exit = client.close().await;
    let seen = collector.await.unwrap();
    for event in &seen {
        match event {
            ClaudeEvent::Message(value) => eprintln!("message type={} subtype={}", value["type"], value["subtype"]),
            ClaudeEvent::Diagnostic(diagnostic) => eprintln!("diagnostic {diagnostic:?}"),
            ClaudeEvent::Exit(info) => eprintln!("exit {info}"),
        }
    }
    eprintln!("stderr tail: {}", exit.stderr_tail.trim());
    assert!(reply.is_ok(), "initialize should answer without credentials: {:?}", reply.err());
    assert!(matches!(exit.reason, ExitReason::Closed), "{exit:?}");
    assert!(
        !home.join(".claude/projects").exists() || std::fs::read_dir(home.join(".claude/projects")).unwrap().next().is_none(),
        "no transcript written"
    );
}
