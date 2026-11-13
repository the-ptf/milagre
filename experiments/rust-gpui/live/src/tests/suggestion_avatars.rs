//! The composer's next-message suggestion and the PR panel's GitHub avatars on a fake Node daemon:
//!
//! - `the_suggestion_follows_the_chats_state`: a Claude Chat's `suggestion` (the host's `prompt-suggestion`, kept in
//!   the Chat's state) shows in its empty composer, Tab takes it; the host dropping it (a message or a turn) hides it;
//!   another provider's Chat never shows one. Nothing is written for it (Electron has no dismiss command for it).
//! - `pr_avatars_load_once_per_login`: the people the PR names get their GitHub picture where "GitHub" has one (the
//!   rest keep their initials), each login asked once even across reads.

use gpui::{Modifiers, TestAppContext};
use milagre_gpui_spike::workspace::panel::PanelTab;
use milagre_gpui_spike::workspace::panel::pr::avatar::avatar_image;
use serde_json::json;

use super::daemon::mount_daemon;
use super::fake_daemon::{FakeDaemon, World, data_folder};
use crate::controller::DaemonSession;
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/alpha";

fn world() -> World {
    let mut world = World::with(vec![(
        ALPHA,
        "alpha",
        true,
        vec![(1, "Codex Chat", vec![("user", "Q"), ("assistant", "A")]), (2, "Claude Chat", vec![("user", "Q2"), ("assistant", "A2")])],
    )]);
    let project = world.projects.get_mut(ALPHA).unwrap();
    for (id, provider) in [(1u64, "codex"), (2, "claude")] {
        let session = project.sessions.get_mut(&id).unwrap();
        session["provider"] = json!(provider);
        session["suggestion"] = json!({"text": "Run the tests", "turnId": "t1"});
    }
    world
}

#[gpui::test]
fn the_suggestion_follows_the_chats_state(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("suggestion");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the Claude Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.wait_for("its suggestion", |m| {
        composer.read_with(m.vcx, |c, _| c.suggestion().map(|s| s.to_string())) == Some("Run the tests".into())
    });
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("composer-suggestion-tab").is_some(), "the Tab keycap over the empty prompt");

    // Tab takes it into the prompt.
    let input = m.vcx.debug_bounds("composer-input").expect("the composer's text area");
    m.vcx.simulate_click(input.center(), Modifiers::none());
    m.vcx.simulate_keystrokes("tab");
    assert_eq!(composer.read_with(m.vcx, |c, _| c.text().to_owned()), "Run the tests");
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.set_text("", window, cx)));

    // The host drops it (its next message, turn or reset): gone from the composer.
    {
        let mut w = fake.world();
        let session = w.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&2).unwrap();
        session.as_object_mut().unwrap().remove("suggestion");
        w.emit_state(ALPHA);
    }
    m.wait_for("the suggestion gone", |m| composer.read_with(m.vcx, |c, _| c.suggestion().is_none()));

    // A Codex Chat with one in its state shows none (Electron reads it for Claude only).
    m.open(&format!("{ALPHA}#1"));
    m.wait_for("the Codex Chat", |m| m.open_key().as_deref() == Some(format!("{ALPHA}#1").as_str()));
    m.vcx.run_until_parked();
    assert!(composer.read_with(m.vcx, |c, _| c.suggestion().is_none()));
    assert!(!fake.log().iter().any(|(method, _)| method == "agent:dismiss-suggestion"), "nothing is written for it");

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

fn pr_detail() -> serde_json::Value {
    json!({
        "number": 31, "url": "https://github.com/acme/alpha/pull/31", "title": "Pictures",
        "body": "", "state": "OPEN", "isDraft": false, "author": "no-picture-author",
        "createdAt": "2026-11-10T10:00:00Z", "updatedAt": "2026-11-12T10:00:00Z",
        "baseRefName": "main", "headRefName": "pics", "headRefOid": "bbb", "baseRefOid": "aaa",
        "additions": 1, "deletions": 0, "changedFiles": 0, "mergeStateStatus": "CLEAN", "reviewDecision": null,
        "autoMerge": null, "viewerCanMergeAsAdmin": false, "viewerIsAuthor": true,
        "checks": [], "reviewers": [{"login": "picture-reviewer", "state": "APPROVED"}, {"login": "acme/team", "state": "REQUESTED", "team": true}],
        "labels": [], "commits": [], "files": [], "threads": [],
        "comments": [{"id": "C1", "author": "picture-reviewer", "body": "Nice", "createdAt": "2026-11-11T10:00:00Z"}],
        "pendingReview": null
    })
}

#[gpui::test]
fn pr_avatars_load_once_per_login(cx: &mut TestAppContext) {
    use base64::Engine as _;
    cx.executor().allow_parking();
    let png = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==")
        .unwrap();
    crate::pr::TEST_AVATARS.lock().unwrap().insert("picture-reviewer".into(), png);
    let mut world = world();
    world.prs.insert(
        ALPHA.into(),
        json!({"worktrees": {(ALPHA): {"number": 31, "title": "Pictures", "url": "https://github.com/acme/alpha/pull/31", "state": "OPEN",
            "readyToMerge": false, "isBehind": false, "hasConflicts": false, "conflictStatusKnown": true}}, "chats": {}, "pending": false}),
    );
    world.pr_details.insert(31, pr_detail());
    let data = data_folder("pr-avatars");
    let fake = FakeDaemon::start(&data, world);
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the PR tab", |m| panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Pr)));
    m.wait_for("the picture", |m| m.vcx.update(|_, cx| avatar_image("picture-reviewer", cx).is_some()));
    assert!(m.vcx.update(|_, cx| avatar_image("no-picture-author", cx).is_none()), "no picture: initials");
    let live = m.controller.read_with(m.vcx, |c, _| c.live_pr().cloned()).unwrap();
    let asked = live.read_with(m.vcx, |l, _| l.avatars_asked().to_vec());
    assert_eq!(&asked[..2], ["no-picture-author", "picture-reviewer"], "author, then reviewers (not teams): {asked:?}");
    assert!(!asked.iter().any(|l| l.contains('/')), "a team has no picture");

    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Pr, cx));
    m.vcx.run_until_parked();
    m.wait_for("the picture drawn", |m| m.vcx.debug_bounds("avatar-picture-picture-reviewer").is_some());
    assert!(m.vcx.debug_bounds("avatar-no-picture-author").is_some(), "the author keeps the initials");

    // Another read asks nobody again.
    let reads = live.read_with(m.vcx, |l, _| l.reads());
    live.update(m.vcx, |l, cx| l.read(31, cx));
    m.wait_for("the read", |m| live.read_with(m.vcx, |l, _| l.reads()) > reads);
    assert_eq!(live.read_with(m.vcx, |l, _| l.avatars_asked().to_vec()), asked);

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}
