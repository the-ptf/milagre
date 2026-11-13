//! Settings on a fake Node daemon ([`crate::settings`]), checked on the fake's request log and saved state:
//!
//! - `settings_read_and_write_like_electron`: General, Chat, Models, Experimental, About and Keybindings are listed
//!   and searched (less the rows the window cannot honour), read from the daemon, and each change reaches it with
//!   Electron's command and arguments; the daemon's answer is what shows; a refused write is put back and said; the
//!   transcript follows Chat's tool calls and reasoning; Worktrees' default and Clean up worktrees' removals.
//! - `a_read_only_window_reads_settings_and_writes_nothing`: the reads, and every change put back unsent.
//! - `settings_pages_read_and_write_like_electron`: Skills, Integrations, Phone & sharing, This Mac and a Project's
//!   page are listed (MCP is not), read from the daemon when shown, and write with Electron's commands and arguments.
//! - `settings_pages_in_a_read_only_window_read_and_write_nothing`: the same pages read; every action refused unsent.

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
        for section in [S::Mcp, S::Browser] {
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

fn settings_view(m: &mut Mounted<'_>) -> gpui::Entity<milagre_gpui_spike::settings::SettingsModal> {
    m.workspace.read_with(m.vcx, |w, _| w.settings.clone())
}

fn show(m: &mut Mounted<'_>, page: milagre_gpui_spike::settings::SelectedSection) {
    let settings = settings_view(m);
    m.vcx.update(|window, cx| {
        settings.update(cx, |s, cx| {
            if !s.is_open() {
                s.open(window, cx);
            }
            s.select_section(page, cx);
        })
    });
    m.vcx.run_until_parked();
}

fn section(id: S) -> milagre_gpui_spike::settings::SelectedSection {
    milagre_gpui_spike::settings::SelectedSection::Section(id)
}

fn alpha_page() -> milagre_gpui_spike::settings::SelectedSection {
    milagre_gpui_spike::settings::SelectedSection::Project { path: ALPHA.into(), name: "alpha".into() }
}

fn project_entry(m: &mut Mounted<'_>) -> milagre_gpui_spike::settings::projects::model::ProjectEntry {
    m.vcx.update(|_, cx| cx.global::<milagre_gpui_spike::settings::projects::ProjectsStore>().get(ALPHA))
}

#[gpui::test]
fn settings_pages_read_and_write_like_electron(cx: &mut TestAppContext) {
    use milagre_gpui_spike::settings::devices::hosted;
    use milagre_gpui_spike::settings::host as page_host;
    use milagre_gpui_spike::settings::projects::hosted as project_host;
    use milagre_gpui_spike::settings::projects::view::Save;

    cx.executor().allow_parking();
    let data = data_folder("settings-pages");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the settings read", read_done);
    let dry = crate::opener::DryRun::default();
    m.vcx.update(|_, cx| cx.set_global(dry.clone()));

    // Listed and searched; MCP stays out, and so do the rows this window does not back.
    m.vcx.update(|_, cx| {
        for page in [S::Skills, S::Connections, S::Devices, S::ThisMac, S::Project] {
            assert!(settings_shows(cx, page), "{page:?} is listed");
        }
        assert!(!settings_shows(cx, S::Mcp));
        for (page, title) in [(S::Devices, "Simulators"), (S::ThisMac, "Computer use"), (S::Project, "Remove Project")] {
            assert!(!settings_row_shows(cx, page, title), "{title} is hidden");
        }
    });
    assert!(search(&mut m, "Linear").contains(&(S::Connections, "Linear".into())));
    assert!(search(&mut m, "Allow devices").contains(&(S::Devices, "Allow devices to connect".into())));
    assert!(search(&mut m, "Simlock").iter().all(|(_, title)| title != "Simlock devices" && title != "Simulators"));
    assert!(search(&mut m, "Computer use").iter().all(|(_, title)| title != "Computer use"));

    // Skills: the live Project's skills, a SKILL.md read, Open in editor and Show in Finder for a listed file.
    show(&mut m, section(S::Skills));
    let skills = settings_view(&mut m).read_with(m.vcx, |s, _| s.skills_view().clone());
    m.wait_for("skills:list", |m| skills.read_with(m.vcx, |v, _| v.skills().len()) == 3);
    assert_eq!(calls(&fake, "skills:list").last(), Some(&json!([ALPHA])));
    skills.read_with(m.vcx, |v, _| assert_eq!(v.warnings().len(), 1));
    skills.update(m.vcx, |v, cx| v.open(0, cx));
    m.wait_for("skills:read", |m| !skills.read_with(m.vcx, |v, _| v.reading()));
    let tidy = format!("{ALPHA}/.claude/skills/tidy/SKILL.md");
    assert_eq!(calls(&fake, "skills:read").last(), Some(&json!([ALPHA, tidy])));
    skills.update(m.vcx, |v, cx| {
        v.file_action(page_host::OPEN_FILE, cx);
        v.file_action(page_host::REVEAL, cx);
    });
    m.vcx.run_until_parked();
    assert_eq!(*dry.0.borrow(), [format!("skill-editor {tidy}"), format!("skill-finder {tidy}")]);
    skills.update(m.vcx, |v, cx| v.open(2, cx));
    m.wait_for("the unreadable skill", |m| skills.read_with(m.vcx, |v, _| v.read_error().is_some()));
    assert!(skills.read_with(m.vcx, |v, _| v.read_error().unwrap().contains("ENOENT")));

    // Integrations: Linear read, its switches, a browser sign-in and a disconnect; Babysit PRs saves a patch.
    show(&mut m, section(S::Connections));
    let integrations = settings_view(&mut m).read_with(m.vcx, |s, _| s.integrations_view().clone());
    m.wait_for("linear:status", |m| integrations.read_with(m.vcx, |v, _| v.linear().workspaces.len()) == 1);
    integrations.read_with(m.vcx, |v, _| assert!(v.linear().enabled && v.linear().workspaces[0].organization == "Fake Org"));
    integrations.update(m.vcx, |v, cx| v.set_move_to_started(false, cx));
    m.wait_for("move-to-started", |_| !calls(&fake, "linear:move-to-started:save").is_empty());
    assert_eq!(calls(&fake, "linear:move-to-started:save"), vec![json!([false])]);
    integrations.update(m.vcx, |v, cx| v.connect_linear(true, cx));
    m.wait_for("the sign-in", |m| integrations.read_with(m.vcx, |v, _| v.linear().connecting.is_none()));
    integrations.read_with(m.vcx, |v, _| assert_eq!((v.linear().workspaces.len(), v.linear().error.clone()), (2, None)));
    assert_eq!(calls(&fake, "linear:connect"), vec![json!([{"window": false}])]);
    integrations.update(m.vcx, |v, cx| v.disconnect_workspace("fake", cx));
    m.wait_for("the disconnect", |m| integrations.read_with(m.vcx, |v, _| v.linear().workspaces.len() == 1));
    assert_eq!(calls(&fake, "linear:disconnect"), vec![json!([{"workspace": "fake"}])]);
    integrations.update(m.vcx, |v, cx| v.change(Box::new(|b| b.level = 5), cx));
    // The page's own save delay (`SAVE_MS`) on the test clock.
    m.vcx.executor().advance_clock(std::time::Duration::from_millis(200));
    m.wait_for("babysit:settings:save", |_| !calls(&fake, "babysit:settings:save").is_empty());
    assert_eq!(calls(&fake, "babysit:settings:save"), vec![json!([{"level": 5}])]);
    m.wait_for("the saved level", |_| fake.world().settings["babysit"]["level"] == 5);
    integrations.update(m.vcx, |v, cx| v.set_linear_enabled(false, cx));
    m.wait_for("linear:enabled:save", |m| integrations.read_with(m.vcx, |v, _| !v.linear().enabled) && !calls(&fake, "linear:enabled:save").is_empty());
    assert_eq!(fake.world().settings["linear"]["enabled"], false);

    // Phone & sharing: the status and the code, the devices (the new one acknowledged), every access action.
    show(&mut m, section(S::Devices));
    m.wait_for("phone:status and devices:list", |m| devices(m, |d| d.hosted.phone_read && d.hosted.devices_read));
    devices(&mut m, |d| {
        assert!(d.phone.enabled && d.hosted.pairing.qr_svg.is_some());
        assert_eq!(d.hosted.pairing.chosen("automatic").1, Some("https://relay.milagre.cloud/pair#k=fake1&c=1"));
        assert_eq!(d.devices.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), ["p1", "p2", "c1"]);
        assert!(d.fresh.contains("p2"));
    });
    m.wait_for("devices:acknowledge", |_| !calls(&fake, "devices:acknowledge").is_empty());
    assert_eq!(calls(&fake, "devices:acknowledge")[0], json!([["p2"]]));
    assert!(m.vcx.debug_bounds("phone-qr").is_some(), "the host's code is drawn");
    m.vcx.update(|_, cx| hosted::set_lan(false, cx));
    m.wait_for("phone:set-lan", |m| devices(m, |d| d.phone.lan.as_ref().is_some_and(|l| !l.enabled)));
    m.vcx.update(|_, cx| hosted::remove_device("p1".into(), cx));
    m.wait_for("devices:remove", |m| devices(m, |d| d.devices.len() == 2));
    assert_eq!(calls(&fake, "devices:remove"), vec![json!(["p1"])]);
    m.vcx.update(|_, cx| hosted::reset_access(cx));
    m.wait_for("phone:reset", |m| devices(m, |d| d.devices.is_empty() && d.hosted.pairing.pairing_link.as_deref() == Some("https://relay.milagre.cloud/pair#k=fake2")));
    m.vcx.update(|_, cx| hosted::set_phone_enabled(false, cx));
    m.wait_for("phone:set-enabled", |m| devices(m, |d| !d.phone.enabled));
    fake.world().settings["refuse"] = json!("Phone access is managed elsewhere");
    m.vcx.update(|_, cx| hosted::set_phone_enabled(true, cx));
    m.wait_for("the refusal", |m| devices(m, |d| d.hosted.action_error.as_deref().is_some_and(|e| e.contains("Phone access is managed elsewhere")) && !d.phone.enabled));
    fake.world().settings["refuse"] = Value::Null;

    // This Mac: its memory and disk.
    show(&mut m, section(S::ThisMac));
    m.wait_for("computer:resources:read", |m| devices(m, |d| d.resources.get("this-mac").is_some_and(|r| r.memory.total == 32.0e9)));
    assert!(m.vcx.debug_bounds("this-mac-settings").is_some());

    // A Project's page: every group read for its path, then each write with the path.
    show(&mut m, alpha_page());
    m.wait_for("the Project's reads", |m| project_entry(m).loaded > 0);
    for method in ["main-sync:read", "project-git:read", "files-to-copy:read", "worktree-setup:read"] {
        assert_eq!(calls(&fake, method).last(), Some(&json!([ALPHA])), "{method}");
    }
    let entry = project_entry(&mut m);
    assert_eq!((entry.branch.effective().base_branch, entry.setup.clone(), entry.files.clone()), ("develop".into(), "npm ci".into(), ".env*".into()));
    assert_eq!(entry.matches, Some(vec![".env".to_owned(), ".env.local".to_owned()]));
    let project = settings_view(&mut m).read_with(m.vcx, |s, _| s.project_view().clone());
    m.wait_for("the fields", |m| project.read_with(m.vcx, |p, _| p.template_input().is_some()));
    let template = project.read_with(m.vcx, |p, _| p.template_input().unwrap());
    m.vcx.update(|window, cx| template.update(cx, |t, cx| t.set_value("{username}/{slug}", window, cx)));
    project.update(m.vcx, |p, cx| {
        p.edited(Save::Branch, cx);
        p.flush(Save::Branch, cx);
    });
    m.wait_for("project-git:save", |_| !calls(&fake, "project-git:save").is_empty());
    assert_eq!(calls(&fake, "project-git:save")[0], json!([ALPHA, {"template": "{username}/{slug}"}]));
    m.vcx.update(|_, cx| {
        project_host::save_main_sync(ALPHA, milagre_gpui_spike::settings::devices::logic::MainSyncChoice::On, cx);
        project_host::save_setup(ALPHA, " uv sync ", cx);
        project_host::save_files(ALPHA, ".env*\nconfig/*", cx);
        project_host::preview_files(ALPHA, "config/*", cx);
        project_host::set_hidden(ALPHA, true, cx);
    });
    m.wait_for("the Project's writes", |m| {
        let e = project_entry(m);
        e.hidden && e.setup == "uv sync" && e.matches == Some(vec!["config/secrets.json".to_owned()])
    });
    assert_eq!(calls(&fake, "main-sync:save"), vec![json!([ALPHA, true])]);
    assert_eq!(calls(&fake, "worktree-setup:save"), vec![json!([ALPHA, "uv sync"])]);
    assert_eq!(calls(&fake, "files-to-copy:save"), vec![json!([ALPHA, [".env*", "config/*"]])]);
    assert_eq!(calls(&fake, "project:set-hidden"), vec![json!([ALPHA, true])]);
    m.wait_for("the sidebar following Show in sidebar", |m| m.vcx.update(|_, cx| crate::sidebar_writes::is_hidden(cx, ALPHA)));
    fake.world().settings["refuse"] = json!("Setup is locked");
    m.vcx.update(|_, cx| project_host::save_setup(ALPHA, "make", cx));
    m.wait_for("the refused save", |m| project_entry(m).errors.get("setup").is_some_and(|e| e.starts_with("Couldn't save: ") && e.contains("Setup is locked")));
    fake.world().settings["refuse"] = Value::Null;

    // Leaving Settings ends the devices' refresh: no read after it closes.
    let settings = settings_view(&mut m);
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.close(window, cx)));
    m.vcx.run_until_parked();
    let live = m.vcx.update(|_, cx| crate::settings::live(cx)).unwrap();
    let errors = live.read_with(m.vcx, |l, _| l.errors.clone());
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(errors.iter().all(|e| e.contains("Phone access is managed elsewhere") || e.contains("Setup is locked")), "{errors:?}");
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn settings_pages_in_a_read_only_window_read_and_write_nothing(cx: &mut TestAppContext) {
    use milagre_gpui_spike::settings::devices::hosted;
    use milagre_gpui_spike::settings::projects::hosted as project_host;

    cx.executor().allow_parking();
    let data = data_folder("settings-pages-read-only");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), true));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the settings read", read_done);

    show(&mut m, section(S::Skills));
    let skills = settings_view(&mut m).read_with(m.vcx, |s, _| s.skills_view().clone());
    m.wait_for("skills:list", |m| skills.read_with(m.vcx, |v, _| v.skills().len()) == 3);
    show(&mut m, section(S::Connections));
    let integrations = settings_view(&mut m).read_with(m.vcx, |s, _| s.integrations_view().clone());
    m.wait_for("linear:status", |m| integrations.read_with(m.vcx, |v, _| v.linear().workspaces.len()) == 1);
    integrations.update(m.vcx, |v, cx| v.set_linear_enabled(false, cx));
    m.wait_for("Linear put back", |m| integrations.read_with(m.vcx, |v, _| v.linear().enabled && v.linear().error.as_deref().is_some_and(|e| e.starts_with("Read-only"))));
    show(&mut m, section(S::Devices));
    m.wait_for("phone:status", |m| devices(m, |d| d.hosted.phone_read && d.hosted.devices_read));
    m.vcx.update(|_, cx| hosted::reset_access(cx));
    m.wait_for("the refused reset", |m| devices(m, |d| d.hosted.action_error.as_deref().is_some_and(|e| e.starts_with("Read-only"))));
    assert_eq!(devices(&mut m, |d| d.devices.len()), 3);
    show(&mut m, alpha_page());
    m.wait_for("the Project's reads", |m| project_entry(m).loaded > 0);
    m.vcx.update(|_, cx| project_host::save_setup(ALPHA, "make", cx));
    m.wait_for("the refused save", |m| project_entry(m).errors.get("setup").is_some_and(|e| e.contains("Read-only")));

    let live = m.vcx.update(|_, cx| crate::settings::live(cx)).unwrap();
    assert_eq!(
        live.read_with(m.vcx, |l, _| l.refused.clone()),
        ["linear:enabled:save", "phone:reset", "worktree-setup:save"].map(str::to_owned).to_vec()
    );
    // Nothing but reads reached the daemon: no pairing window opened, no device acknowledged.
    let written: Vec<String> = fake
        .log()
        .into_iter()
        .map(|(method, _)| method)
        .filter(|method| {
            [
                "linear:enabled:save",
                "linear:connect",
                "babysit:settings:save",
                "phone:open-pairing",
                "phone:reset",
                "devices:acknowledge",
                "devices:remove",
                "worktree-setup:save",
                "project-git:save",
            ]
            .contains(&method.as_str())
        })
        .collect();
    assert_eq!(written, Vec::<String>::new());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}
