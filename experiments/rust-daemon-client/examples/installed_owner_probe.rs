//! Read-only probe of the installed Milagre daemon: adopt, list Projects, read one Project and Chat page.
//! Sends nothing and opens no view. `cargo run --features installed-owner --example installed_owner_probe [PROJECT]`
use milagre_daemon_client::{ChatPageOptions, ClientOptions, InstalledOwner};

fn main() {
    futures::executor::block_on(async {
        let owner = InstalledOwner::adopt().await.expect("adopt");
        let info = owner.info();
        println!(
            "daemon pid {} version {} data {}",
            info.pid,
            info.version,
            info.data_dir.display()
        );
        let known = owner.known_projects().await.expect("known");
        println!(
            "{} known Projects; first: {:?}",
            known.len(),
            known.first().map(|p| &p.name)
        );
        let path = std::env::args()
            .nth(1)
            .unwrap_or_else(|| known[0].path.clone());
        let project = owner.project(&path).expect("project");
        let (client, hello, _notices) = project
            .connect(ClientOptions::default())
            .await
            .expect("connect");
        println!("hello capabilities: {}", hello.capabilities.len());
        let read = client
            .project_read(&path, true)
            .await
            .expect("project:read");
        let keys: Vec<_> = read["state"]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        println!("project {} state keys: {:?}", read["name"], keys);
        let runs = client.chat_runs().await.expect("chat:runs");
        println!("runs seq {}", runs.seq);
        let sessions = &read["state"]["sessions"];
        let first = sessions
            .as_array()
            .and_then(|s| s.last())
            .or_else(|| sessions.as_object().and_then(|o| o.values().next_back()));
        println!(
            "sessions: {}",
            sessions
                .as_array()
                .map(Vec::len)
                .or(sessions.as_object().map(|o| o.len()))
                .unwrap_or(0)
        );
        if let Some(id) = first.and_then(|c| c["id"].as_u64()) {
            let page = client
                .chat_messages(
                    &path,
                    id,
                    ChatPageOptions {
                        limit: Some(3),
                        ..Default::default()
                    },
                )
                .await
                .expect("chat:messages");
            println!(
                "chat {id}: page ok ({} bytes)",
                serde_json::to_string(&page).map(|s| s.len()).unwrap_or(0)
            );
        }
        let snapshot = client.runtime_snapshot().await.expect("snapshot");
        println!("snapshot eventSeq {}", snapshot.event_seq);
        // A second, request-only connection: no snapshot, events discarded, loaded without project:open.
        let before: Vec<_> = owner
            .known_projects()
            .await
            .expect("known")
            .into_iter()
            .map(|p| p.path)
            .collect();
        let (quiet, _, notices) = project
            .connect(ClientOptions::default())
            .await
            .expect("connect quiet");
        notices.discard();
        let loaded = quiet.load_view(&path).await.expect("load_view");
        println!(
            "load_view: {} version {}",
            loaded["name"], loaded["version"]
        );
        let models = project.models(&quiet).await.expect("models");
        for provider in ["claude", "codex", "antigravity", "kiro"] {
            let recommended = models[provider]
                .as_array()
                .and_then(|m| m.iter().find(|m| m["recommended"] == true))
                .map(|m| m["id"].clone());
            println!("models {provider}: recommended {:?}", recommended);
        }
        let after: Vec<_> = owner
            .known_projects()
            .await
            .expect("known")
            .into_iter()
            .map(|p| p.path)
            .collect();
        println!("recents order unchanged: {}", before == after);
    });
}
