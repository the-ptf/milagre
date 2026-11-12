//! Settings on a fake Node daemon ([`crate::settings`]), checked on the fake's request log and saved state:
//!
//! - `settings_read_and_write_like_electron`: General, Chat, Models, Experimental, About and Keybindings are listed
//!   and searched (less the rows the window cannot honour), read from the daemon, and each change reaches it with
//!   Electron's command and arguments; the daemon's answer is what shows; a refused write is put back and said; the
//!   transcript follows Chat's tool calls and reasoning; Worktrees' default and Clean up worktrees' removals.
//! - `a_read_only_window_reads_settings_and_writes_nothing`: the reads, and every change put back unsent.

use gpui::{BorrowAppContext as _, TestAppContext};
use milagre_gpui_spike::data::LOCAL;
use milagre_gpui_spike::logic::keybindings::rules::RuleDraft;
use milagre_gpui_spike::settings::SettingsStore;
use milagre_gpui_spike::settings::devices::DevicesStore;
use milagre_gpui_spike::settings::devices::cleanup::CleanupRemover;
use milagre_gpui_spike::settings::keybindings::KeybindingsStore;
use milagre_gpui_spike::settings::search::SettingsSectionId as S;
use milagre_gpui_spike::settings::store::{FollowUpMode, ToolCallDisplay};
use milagre_gpui_spike::workspace::preview::{settings_row_shows, settings_shows};
use serde_json::{Value, json};

use super::daemon::mount_daemon;
use super::fake_daemon::{FakeDaemon, World, data_folder};
use super::owned::Mounted;
use crate::controller::DaemonSession;
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/alpha";

fn world() -> World {
    World::with(vec![(ALPHA, "alpha", true, vec![(1, "Alpha", vec![("user", "Q"), ("assistant", "A")])])])
}

fn calls(fake: &FakeDaemon, method: &str) -> Vec<Value> {
    fake.log().into_iter().filter(|(m, _)| m == method).map(|(_, args)| args).collect()
}

fn store<T>(m: &mut Mounted<'_>, read: impl FnOnce(&SettingsStore) -> T) -> T {
    m.vcx.update(|_, cx| read(cx.global::<SettingsStore>()))
}

fn change(m: &mut Mounted<'_>, edit: impl FnOnce(&mut SettingsStore)) {
    m.vcx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| edit(s)));
}

fn local_keys(m: &mut Mounted<'_>) -> Vec<(String, String)> {
    m.vcx.update(|_, cx| cx.global::<KeybindingsStore>().get(LOCAL).state.rules.iter().map(|r| (r.command.clone(), r.key.clone())).collect())
}

fn search(m: &mut Mounted<'_>, query: &str) -> Vec<(S, String)> {
    let settings = m.workspace.read_with(m.vcx, |w, _| w.settings.clone());
    m.vcx.update(|window, cx| {
        settings.update(cx, |s, cx| {
            s.open(window, cx);
            s.set_query(query, window, cx);
        })
    });
    settings.read_with(m.vcx, |s, cx| s.current_hits(cx).into_iter().map(|hit| (hit.entry.page, hit.entry.title)).collect())
}

fn devices<T>(m: &mut Mounted<'_>, read: impl FnOnce(&DevicesStore) -> T) -> T {
    m.vcx.update(|_, cx| read(cx.global::<DevicesStore>()))
}

/// What the cleanup dialog does for one chosen worktree ([`CleanupRemover`]), run to its answer.
fn remove(m: &mut Mounted<'_>, path: &str) -> Result<(), String> {
    let task = m.vcx.update(|_, cx| {
        let remover = cx.global::<CleanupRemover>().clone();
        (remover.0)(path.to_owned(), cx)
    });
    let answer = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot = answer.clone();
    m.vcx.update(|_, cx| cx.spawn(async move |_| *slot.borrow_mut() = Some(task.await)).detach());
    m.wait_for("the removal", |_| answer.borrow().is_some());
    answer.borrow_mut().take().unwrap()
}

fn read_done(m: &mut Mounted<'_>) -> bool {
    let live = m.vcx.update(|_, cx| crate::settings::live(cx)).expect("Settings on the daemon");
    live.read_with(m.vcx, |l, _| l.reads > 0)
}

#[gpui::test]
fn settings_read_and_write_like_electron(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("settings");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the settings read", read_done);

    // Listed and searched: the backed sections, less the rows this window cannot honour.
    m.vcx.update(|_, cx| {
        for section in [S::General, S::Chat, S::Keybindings, S::Models, S::Worktrees, S::Experimental, S::About] {
            assert!(settings_shows(cx, section), "{section:?} is listed");
        }
        for section in [S::Skills, S::Mcp, S::Browser, S::ThisMac] {
            assert!(!settings_shows(cx, section), "{section:?} is not listed");
        }
        assert!(!settings_row_shows(cx, S::General, "Chat order"));
        assert!(settings_row_shows(cx, S::General, "Archive Done Chats after"));
    });
    assert!(search(&mut m, "Chat order").iter().all(|(_, title)| title != "Chat order"));
    assert!(search(&mut m, "Archive Done").contains(&(S::General, "Archive Done Chats after".into())));
    assert!(search(&mut m, "Delegate").contains(&(S::Experimental, "Delegate to other computers".into())));
    assert!(search(&mut m, "Release channel").is_empty());

    // Read: the fake's values, not the defaults.
    assert_eq!(
        store(&mut m, |s| (
            s.follow_ups,
            s.auto_compact,
            s.button_threshold,
            s.auto_threshold,
            s.done_retention_hours,
            s.delegate_to_other_computers,
            s.device_notes,
            s.auto_update,
            s.milagre_version.clone()
        )),
        (FollowUpMode::Queue, true, 60, 80, 72, true, true, true, Some("9.9.9-fake".to_owned()))
    );
    assert!(local_keys(&mut m).contains(&("chat.new".into(), "mod+n".into())));
    for method in crate::settings::READS.iter().chain(&["keybindings:read"]) {
        // Once at launch, once more when the search above opened Settings.
        let read = calls(&fake, method);
        assert!(!read.is_empty() && read.iter().all(|args| *args == json!([])), "{method}: {read:?}");
    }

    // Writes, with Electron's arguments; the daemon's answer stays.
    change(&mut m, |s| s.done_retention_hours = 168);
    m.wait_for("done:settings:save", |_| !calls(&fake, "done:settings:save").is_empty());
    assert_eq!(calls(&fake, "done:settings:save")[0], json!([{"retentionHours": 168}]));
    change(&mut m, |s| s.follow_ups = FollowUpMode::Now);
    m.wait_for("followUps", |_| !calls(&fake, "context:settings:save").is_empty());
    assert_eq!(calls(&fake, "context:settings:save")[0], json!([{"followUps": "now"}]));
    change(&mut m, |s| {
        s.auto_compact = false;
        s.set_button_threshold(50);
    });
    m.wait_for("the context patch", |_| calls(&fake, "context:settings:save").len() == 2);
    assert_eq!(calls(&fake, "context:settings:save")[1], json!([{"autoCompact": false, "buttonThreshold": 50}]));
    change(&mut m, |s| {
        s.delegate_to_other_computers = false;
        s.device_notes = false;
        s.auto_update = false;
        s.keep_awake = false;
    });
    m.wait_for("the switches", |_| !calls(&fake, "app:set-keep-awake").is_empty());
    assert_eq!(calls(&fake, "linked:remote-enabled:save"), vec![json!([false])]);
    assert_eq!(calls(&fake, "device-notes:save"), vec![json!([false])]);
    assert_eq!(calls(&fake, "app-update:auto:save"), vec![json!([false])]);
    assert_eq!(calls(&fake, "app:set-keep-awake"), vec![json!([false])]);
    let saved = fake.world().settings.clone();
    assert_eq!(saved["done"]["retentionHours"], 168);
    assert_eq!(saved["context"], json!({"buttonThreshold": 50, "autoThreshold": 80, "autoCompact": false, "followUps": "now"}));
    assert_eq!((saved["remote"].clone(), saved["notes"].clone(), saved["autoUpdate"].clone()), (json!(false), json!(false), json!(false)));

    // A refused write goes back and says why; nothing else is sent.
    fake.world().settings["refuse"] = json!("Done settings are locked");
    change(&mut m, |s| s.done_retention_hours = 1);
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    m.wait_for("the refusal", |m| store(m, |s| s.done_retention_hours) == 168 && calls(&fake, "done:settings:save").len() == 2);
    let notice = sidebar.read_with(m.vcx, |s, _| s.notice().map(|n| n.to_string())).unwrap_or_default();
    assert!(notice.contains("Done settings are locked"), "{notice}");
    fake.world().settings["refuse"] = Value::Null;

    // Keybindings: an edit is `keybindings:set-command`, a reset `keybindings:reset`, and the answer is the page.
    m.vcx.update(|_, cx| {
        cx.update_global::<KeybindingsStore, _>(|keys, _| keys.apply(LOCAL, &vec![("chat.new".to_owned(), vec![RuleDraft::new("mod+u")])]).unwrap())
    });
    m.wait_for("set-command", |_| !calls(&fake, "keybindings:set-command").is_empty());
    assert_eq!(calls(&fake, "keybindings:set-command")[0], json!(["chat.new", [{"key": "mod+u"}]]));
    m.wait_for("the file's rules", |m| local_keys(m).contains(&("chat.new".into(), "mod+u".into())));
    m.vcx.update(|_, cx| cx.update_global::<KeybindingsStore, _>(|keys, _| keys.reset_all(LOCAL).unwrap()));
    m.wait_for("reset", |_| !calls(&fake, "keybindings:reset").is_empty());
    m.wait_for("the defaults back", |m| local_keys(m).contains(&("chat.new".into(), "mod+n".into())));

    // The transcript follows Chat's tool calls and reasoning.
    change(&mut m, |s| {
        s.tool_call_display = ToolCallDisplay::Full;
        s.expand_reasoning = true;
    });
    let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
    assert_eq!(transcript.read_with(m.vcx, |t, _| t.display()), (milagre_gpui_spike::logic::lists::chat_display::ToolCallDisplay::Full, true));

    // Worktrees: the default read and written; Clean up worktrees lists the host's idle worktrees and removes each
    // with what the list saw (unsaved work forced); one the host keeps says why.
    assert_eq!(devices(&mut m, |d| (d.main_sync_default, d.idle.iter().map(|i| i.title.clone()).collect::<Vec<_>>())), (false, vec!["old".to_owned(), "dirty".to_owned(), "keep".to_owned()]));
    m.vcx.update(|_, cx| cx.update_global::<DevicesStore, _>(|d, _| d.main_sync_default = true));
    m.wait_for("main-sync:default:save", |_| !calls(&fake, "main-sync:default:save").is_empty());
    assert_eq!(calls(&fake, "main-sync:default:save"), vec![json!([true])]);
    m.wait_for("saved", |_| fake.world().settings["syncMain"] == true);
    let removed = remove(&mut m, "/fake/worktrees/dirty");
    assert_eq!(removed, Ok(()));
    let request = &calls(&fake, "storage:remove-worktree")[0][0];
    assert_eq!((request["projectPath"].clone(), request["force"].clone(), request["seen"]["uncommitted"].clone()), (json!(ALPHA), json!(true), json!(2)));
    assert!(request["activity"]["chats"].is_array() && request["idleBefore"].is_number() && request["lastAt"].is_number());
    let kept = remove(&mut m, "/fake/worktrees/keep");
    assert!(kept.as_ref().is_err_and(|e| e.contains("running Terminal")), "{kept:?}");
    assert_eq!(fake.world().settings["idle"].as_array().map(Vec::len), Some(2));
    let live = m.vcx.update(|_, cx| crate::settings::live(cx)).unwrap();
    let errors = live.update(m.vcx, |l, _| std::mem::take(&mut l.errors));
    assert!(errors.len() == 2 && errors[0].starts_with("done:settings:save") && errors[0].contains("Done settings are locked"), "{errors:?}");
    assert!(errors[1].starts_with("storage:remove-worktree"), "{errors:?}");

    // Opening Settings reads again.
    let settings = m.workspace.read_with(m.vcx, |w, _| w.settings.clone());
    let before = calls(&fake, "done:settings:read").len();
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.close(window, cx)));
    m.vcx.run_until_parked();
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.open(window, cx)));
    m.wait_for("the read on open", |_| calls(&fake, "done:settings:read").len() > before);
    assert_eq!(live.read_with(m.vcx, |l, _| l.errors.clone()), Vec::<String>::new());
}

#[gpui::test]
fn a_read_only_window_reads_settings_and_writes_nothing(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("settings-read-only");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), true));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the settings read", read_done);
    assert_eq!(store(&mut m, |s| s.done_retention_hours), 72);

    change(&mut m, |s| {
        s.done_retention_hours = 1;
        s.follow_ups = FollowUpMode::Now;
    });
    m.vcx.update(|_, cx| {
        cx.update_global::<KeybindingsStore, _>(|keys, _| keys.apply(LOCAL, &vec![("chat.new".to_owned(), vec![RuleDraft::new("mod+u")])]).unwrap())
    });
    m.wait_for("put back", |m| store(m, |s| (s.done_retention_hours, s.follow_ups)) == (72, FollowUpMode::Queue));
    m.wait_for("the keys read again", |m| local_keys(m).contains(&("chat.new".into(), "mod+n".into())));
    m.vcx.update(|_, cx| cx.update_global::<DevicesStore, _>(|d, _| d.main_sync_default = true));
    m.wait_for("main sync put back", |m| !devices(m, |d| d.main_sync_default));
    let refused = remove(&mut m, "/fake/worktrees/old");
    assert!(refused.is_err_and(|e| e.starts_with("Read-only")));
    let live = m.vcx.update(|_, cx| crate::settings::live(cx)).unwrap();
    assert_eq!(
        live.read_with(m.vcx, |l, _| l.refused.clone()),
        ["context:settings:save", "done:settings:save", "keybindings:set-command", "main-sync:default:save", "storage:remove-worktree"]
            .map(str::to_owned)
            .to_vec()
    );
    assert_eq!(fake.world().settings["idle"].as_array().map(Vec::len), Some(3));
    for (method, _) in fake.log() {
        assert!(method.ends_with(":read") || method == "app:version" || !method.contains("settings") && !method.starts_with("keybindings:"), "{method} written");
    }
}
