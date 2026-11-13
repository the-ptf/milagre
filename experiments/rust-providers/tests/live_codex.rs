//! Opt-in probe of the installed `codex app-server`: initialize and model/list only. No thread,
//! no turn, no account read, nothing printed beyond the user agent's product name and the model
//! count. Run with:
//!
//!   MILAGRE_CODEX_LIVE=1 cargo test --test live_codex -- --ignored --nocapture

use milagre_providers::codex::client::{CodexClient, ConnectOptions};
use milagre_providers::codex::SpawnOptions;
use std::time::Duration;

#[tokio::test]
#[ignore = "talks to the installed codex CLI; set MILAGRE_CODEX_LIVE=1"]
async fn installed_codex_initializes_and_lists_models() {
    if std::env::var("MILAGRE_CODEX_LIVE").as_deref() != Ok("1") {
        eprintln!("MILAGRE_CODEX_LIVE not set; skipped");
        return;
    }
    let command = std::env::var("MILAGRE_CODEX_BIN").unwrap_or_else(|_| "codex".into());
    let mut connect = ConnectOptions::new(SpawnOptions::new(command).cwd(std::env::temp_dir()), "0.0.0-rust-probe");
    connect.initialize_timeout = Some(Duration::from_secs(30));
    let (client, _events) = CodexClient::connect(connect).await.expect("codex app-server initializes");
    let agent = client.initialize_result().get("userAgent").and_then(|v| v.as_str()).unwrap_or("");
    let product = agent.split('/').next().unwrap_or("");
    let models = client.list_models().await.expect("model/list answers");
    assert!(!models.is_empty(), "model/list returned no models");
    assert!(models.iter().all(|m| m.get("id").and_then(|v| v.as_str()).is_some()), "every model has an id");
    eprintln!("codex app-server: product={product:?} models={}", models.len());
    let exit = client.close().await;
    eprintln!("closed: reason={:?}", exit.reason);
}
