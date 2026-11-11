//! Fixed synthetic content, created through the same writer the renderer uses.
//! This is trusted startup code, never an RPC accepting a path or a tool grant.
use crate::claude_content::SharedContent;
use milagre_owner_wire::RpcError;
use serde_json::json;
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

pub(crate) fn initialize(content: &SharedContent, project: &Path) -> Result<(), RpcError> {
    let chat = format!("{}#1", project.display());
    let dispatcher = content
        .dispatcher(&chat)
        .map_err(|error| RpcError::new(error.code, error.message))?;
    let asset = project.join("fixture-note.txt");
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&asset)?
        .write_all(b"Rust fixture asset\n")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    for (name, request, id, format) in [
        (
            "artifact_show",
            json!({
                "id":"fixture-report", "title":"Rust fixture report",
                "html":"<main><h1>Rust fixture artifact</h1><p>Saved by the Rust content owner.</p><a href=\"assets/fixture-note.txt\">Fixture asset</a></main>",
                "assets":[{"name":"fixture-note.txt","path":asset}]
            }),
            "fixture-report",
            "html",
        ),
        (
            "design_show",
            json!({
                "id":"fixture-screen", "title":"Rust fixture screen", "group":"Fixture",
                "document":{
                    "schemaVersion":1, "width":390, "height":260, "background":"#fff7d6",
                    "nodes":[{"id":"heading","type":"text","x":24,"y":32,"width":342,"height":96,
                        "text":"Rust fixture design","fontFamily":"Inter","fontSize":28,"fill":"#29261f"}]
                }
            }),
            "fixture-screen",
            "design",
        ),
    ] {
        let reply = runtime.block_on(dispatcher.call(name, &request));
        if reply["isError"] != false {
            return Err(failed());
        }
        // Design tool feedback explicitly reports the absent raster helper. This
        // checkpoint verifies saved source and fresh HTML, never PNG feedback.
        let saved = content.renderer("artifact:get", &json!({"chatId":chat,"id":id}))?;
        if saved["id"] != id || saved["format"] != format || saved["version"] != 1 {
            return Err(failed());
        }
    }
    fs::remove_file(asset)?;
    let listed = content.renderer("artifact:list", &json!({"chatId":chat}))?;
    if listed.as_array().map(Vec::len) != Some(2) {
        return Err(failed());
    }
    Ok(())
}

fn failed() -> RpcError {
    RpcError::new(
        "FIXTURE_CONTENT_FAILED",
        "The fixed Rust Artifact and Design could not be saved and read back",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_store::{Isolation, Policy};
    use milagre_owner_wire::IsolatedProfile;

    #[test]
    fn initialization_uses_the_one_owner_and_retained_grants_never_revive() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("fixture")).unwrap();
        let content = SharedContent::new(isolation.clone(), project.clone()).unwrap();
        assert!(initialize(&content, &project).is_err());
        assert!(!project.join("fixture-note.txt").exists());
        content.opened(true);
        initialize(&content, &project).unwrap();
        assert!(!project.join("fixture-note.txt").exists());
        assert!(SharedContent::new(isolation.clone(), project.clone()).is_err());
        let chat = format!("{}#1", project.display());
        let grant = content.dispatcher(&chat).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let edited = runtime.block_on(grant.call(
            "design_apply",
            &json!({
                "id":"fixture-screen","expectedVersion":1,
                "operations":[{"op":"update","id":"heading","patch":{"text":"Shared owner edit"}}]
            }),
        ));
        assert_eq!(edited["isError"], false);
        assert_eq!(
            content
                .renderer(
                    "artifact:get",
                    &json!({"chatId":chat,"id":"fixture-screen"})
                )
                .unwrap()["version"],
            2
        );
        content.opened(false);
        content.opened(true);
        assert_eq!(
            runtime.block_on(grant.call("design_read", &json!({"id":"fixture-screen"})))["isError"],
            true
        );
        assert!(content.dispatcher(&chat).is_ok());
        content.shutdown();
        assert!(content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .is_err());
        // shutdown releases the actual stores even while the revoked grant is retained.
        let reopened = SharedContent::new(isolation, project).unwrap();
        reopened.opened(true);
        assert_eq!(
            reopened
                .renderer(
                    "artifact:get",
                    &json!({"chatId":chat,"id":"fixture-screen"})
                )
                .unwrap()["version"],
            2
        );
    }
}
