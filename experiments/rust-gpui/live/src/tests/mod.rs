//! Tests of the live crate. `owned` runs against the staged runtime and is ignored by default: run it only through
//! `../daemon-check/scripts/check-gpui-live.py run`, which stages this runner beside the hashed `chat-runtime` and the
//! backend's fixed Claude stand-in.

mod bundled;
mod canvas;
mod cold_start;
mod daemon;
mod fake_daemon;
mod fake_settings;
mod git;
mod owned;
mod polish;
mod pr_accounts;
mod remote_computers;
mod settings;
mod sidebar_writes;
mod suggestion_avatars;
mod usage;

#[test]
fn chat_ids_belong_to_the_owned_project() {
    use crate::sinks::chat_id;
    assert_eq!(chat_id("/p/project", "/p/project#3"), Some(3));
    assert_eq!(chat_id("/p/project", "/p/other#3"), None);
    assert_eq!(chat_id("/p/project", "/p/project#x"), None);
}
