//! The palette's rules (`filterCommands`, Recent, message rows, results) and the view in the headless platform.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::commands::*;
use super::sources::{self, ChatEntry, PaletteInput, ProjectEntry};
use super::{FixtureMessages, PaletteEvent, PaletteView, SEARCH_DELAY};
use crate::logic::marks::chat_mark::ChatMark;
use crate::settings::SettingsStore;
use crate::settings::appearance::model::ThemePreference;
use crate::testing;

fn cmd(id: &str, label: &str, group: &str) -> Command {
    Command::new(id, label, group, CommandIcon::Chat, CommandAction::NewChat)
}

fn input() -> PaletteInput {
    PaletteInput {
        chats: vec![
            ChatEntry { key: "s#1".into(), title: "Fix header".into(), mark: ChatMark::Running, detail: "web · #12".into() },
            ChatEntry { key: "s#2".into(), title: "Release train".into(), mark: ChatMark::Idle, detail: "app".into() },
        ],
        projects: vec![ProjectEntry { path: "/code/api".into(), name: "api".into() }],
        current_chat: true,
        git: true,
        away_from_chat: false,
    }
}

#[test]
fn every_word_must_match_the_label_detail_keywords_or_group() {
    let list = vec![
        cmd("a", "New Chat", "Actions").keywords("create agent session"),
        cmd("b", "Settings", "Actions"),
        cmd("c", "Fix header", "Chats").detail("Working"),
    ];
    let ids = |q: &str| filter_commands(&list, q).into_iter().map(|c| c.id).collect::<Vec<_>>();
    assert_eq!(ids(""), ["a", "b", "c"]);
    assert_eq!(ids("create session"), ["a"]);
    assert_eq!(ids("working fix"), ["c"]);
    assert_eq!(ids("actions"), ["a", "b"], "the group's name matches");
    assert!(ids("zzz").is_empty());
}

#[test]
fn search_only_rows_wait_for_typing_and_do_not_match_their_group() {
    let list = vec![cmd("a", "Settings", "Actions"), cmd("r", "Sidebar usage", "Settings").search_only()];
    assert_eq!(filter_commands(&list, "").len(), 1);
    let found = filter_commands(&list, "settings");
    assert_eq!(found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a"], "the group name does not pull in every row");
    assert_eq!(filter_commands(&list, "sidebar").len(), 1);
}

#[test]
fn recent_keeps_the_newest_five_once_each() {
    let mut recent = RecentCommands::default();
    for id in ["a", "b", "c", "d", "e", "f", "c"] {
        recent.remember(id);
    }
    assert_eq!(recent.0, ["c", "f", "e", "d", "b"]);
}

#[test]
fn recent_rows_copy_the_command_and_skip_the_gone() {
    let list = vec![cmd("a", "New Chat", "Actions"), cmd("b", "Other", "Actions")];
    let recent = recent_commands(&list, &["b".into(), "gone".into(), "a".into()]);
    assert_eq!(
        recent.iter().map(|c| (c.id.as_str(), c.group.as_str())).collect::<Vec<_>>(),
        [("recent:b", "Recent"), ("recent:a", "Recent")]
    );
    assert_eq!(remembered_id(&recent[0]), "b");
    assert_eq!(remembered_id(&list[0]), "a");
}

#[test]
fn an_empty_query_lists_recent_first_then_the_groups() {
    let list = sources::commands(&input());
    let shown = results(&list, &["settings".into()], "", &Found::default());
    assert_eq!(shown.rows[0].id, "recent:settings");
    assert_eq!(shown.rows[0].group, "Recent");
    assert!(shown.rows.iter().all(|row| !row.search_only), "no Settings rows in an empty palette");
    assert!(!shown.searching);
    let typed = results(&list, &["settings".into()], "header", &Found::default());
    assert_eq!(typed.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["chat:s#1"]);
}

#[test]
fn nothing_matching_offers_a_new_chat_with_the_search_after_the_host_answers() {
    let list = sources::commands(&input());
    let waiting = results(&list, &[], "zzqq", &Found::default());
    assert!(waiting.searching && waiting.rows.is_empty(), "nothing flashes in while the host looks");
    let answered = results(&list, &[], "zzqq", &Found { query: "zzqq".into(), commands: Vec::new() });
    assert_eq!(answered.rows.len(), 1);
    assert_eq!(answered.rows[0].id, START_CHAT_ID);
    assert_eq!(answered.rows[0].action, CommandAction::StartChat("zzqq".into()));
    let one_char = results(&list, &[], "z", &Found::default());
    assert!(!one_char.searching, "one character never asks the host");
}

#[test]
fn message_rows_come_after_when_no_command_matches() {
    let list = sources::commands(&input());
    let hit = Command::new(
        "message:1",
        "…the zzqq bug",
        "Messages",
        CommandIcon::Message,
        CommandAction::OpenMessage { chat: "s#1".into(), term: "zzqq".into() },
    );
    let shown = results(&list, &[], "zzqq", &Found { query: "zzqq".into(), commands: vec![hit] });
    assert_eq!(shown.rows.len(), 1);
    assert_eq!(shown.rows[0].group, "Messages");
    // A query that matches a command never lists messages.
    let hit = cmd("message:2", "x", "Messages");
    let both = results(&list, &[], "header", &Found { query: "header".into(), commands: vec![hit] });
    assert!(both.rows.iter().all(|row| row.group != "Messages"));
}

#[test]
fn messages_show_three_per_chat_in_listed_chats_only() {
    let found = |id: u64, chat: &str| MessageMatch {
        message_id: id,
        chat: chat.into(),
        snippet: format!("m{id}"),
        highlight: (0, 1),
        term: "m".into(),
    };
    let matches: Vec<_> = (1..=5).map(|id| found(id, "s#1")).chain([found(6, "s#unlisted"), found(7, "s#2")]).collect();
    let titles = HashMap::from([("s#1".to_string(), "One".to_string()), ("s#2".to_string(), "Two".to_string())]);
    let rows = message_commands(&matches, &titles);
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["message:1", "message:2", "message:3", "message:7"]);
    assert_eq!(rows[0].detail.as_deref(), Some("One"));
    assert_eq!(rows[0].highlight, Some((0, 1)));
    let many: Vec<_> = (0..60).map(|id| found(id, &format!("c{id}"))).collect();
    let titles: HashMap<_, _> = (0..60).map(|id| (format!("c{id}"), "t".to_string())).collect();
    assert_eq!(message_commands(&many, &titles).len(), MESSAGES_TOTAL);
}

#[test]
fn message_search_matches_every_word_and_marks_the_hit_in_a_snippet() {
    let messages = vec![
        ("s#1".to_string(), 1, "We should retry the relay dial with a short backoff when the room is busy.".to_string()),
        ("s#2".to_string(), 2, "Unrelated words here".to_string()),
    ];
    let found = search_messages(&messages, "relay backoff", 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].chat, "s#1");
    let (start, end) = found[0].highlight;
    assert!(found[0].snippet[start..end].eq_ignore_ascii_case("relay"), "{:?}", found[0].snippet);
    assert!(search_messages(&messages, "nothing like it", 10).is_empty());
}

#[test]
fn the_sources_list_the_groups_in_order() {
    let list = sources::commands(&input());
    let groups: Vec<&str> = list.iter().map(|c| c.group.as_str()).fold(Vec::new(), |mut acc, g| {
        if acc.last() != Some(&g) {
            acc.push(g);
        }
        acc
    });
    assert_eq!(groups, ["Current Chat", "Actions", "Chats", "Projects", "Settings"]);
    let chat = list.iter().find(|c| c.id == "chat:s#1").unwrap();
    assert_eq!(chat.detail.as_deref(), Some("Working"));
    assert!(chat.keywords.contains("#12"));
    assert!(list.iter().any(|c| c.id == "project:/code/api" && c.detail.as_deref() == Some("/code/api")));
    assert!(list.iter().filter(|c| c.group == "Settings").all(|c| c.search_only));
    let new_chat = list.iter().find(|c| c.id == "new-chat").unwrap();
    assert_eq!(super::shortcut_of(new_chat.keybinding.unwrap()).as_deref(), Some("\u{2318}N"));
    // No Git, no Chat: no Commit row; away from the Chat: Back to Chat.
    let bare = sources::commands(&PaletteInput { git: false, away_from_chat: true, ..input() });
    assert!(bare.iter().all(|c| c.id != "git") && bare.iter().any(|c| c.id == "back-to-chat"));
}

#[test]
fn settings_rows_are_found_by_their_words_and_open_their_page() {
    let list = sources::commands(&PaletteInput::default());
    let found = filter_commands(&list, "keep awake");
    assert!(
        found.iter().any(|c| matches!(&c.action, CommandAction::OpenSettings(Some(entry)) if entry.title.to_lowercase().contains("awake"))),
        "{found:?}"
    );
}

#[test]
fn quick_settings_mark_the_current_value_and_apply() {
    let mut store = SettingsStore::default();
    store.appearance.theme = ThemePreference::Dark;
    let rows = quick_settings(&store);
    let dark = rows.iter().find(|c| c.label == "Mode: Dark").unwrap();
    assert_eq!(dark.detail.as_deref(), Some("Current"));
    let light = rows.iter().find(|c| c.label == "Mode: Light").unwrap();
    assert_eq!(light.detail, None);
    assert!(rows.iter().any(|c| c.label.starts_with("Theme: Catppuccin")));
    let CommandAction::SetSetting(setting) = &light.action else { panic!("a setting") };
    setting.apply(&mut store);
    assert_eq!(store.appearance.theme, ThemePreference::Light);
    let off = QuickSetting::Flag(Flag::KeepAwake, false);
    store.keep_awake = true;
    assert!(!off.is_current(&store));
    off.apply(&mut store);
    assert!(!store.keep_awake && off.is_current(&store));
    let ids: std::collections::HashSet<_> = rows.iter().map(|c| &c.id).collect();
    assert_eq!(ids.len(), rows.len(), "ids are unique");
}

#[test]
fn the_selection_wraps() {
    assert_eq!(step_selection(3, 2, true), 0);
    assert_eq!(step_selection(3, 0, false), 2);
    assert_eq!(step_selection(0, 0, true), 0);
}

// ---- the view ----

struct Opened {
    events: Rc<RefCell<Vec<String>>>,
    _sub: gpui::Subscription,
}

fn open(cx: &mut TestAppContext) -> (Entity<PaletteView>, Opened, &mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, |_, cx| PaletteView::new(cx));
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    let sub = cx.update(|_, cx| {
        cx.subscribe(&view, move |_, event: &PaletteEvent, _| match event {
            PaletteEvent::Run(command) => seen.borrow_mut().push(command.id.clone()),
            PaletteEvent::Closed => seen.borrow_mut().push("closed".into()),
        })
    });
    let search = Rc::new(FixtureMessages::new(vec![("s#2".into(), 9, "the migration plan lives in the doc".into())]));
    cx.update(|window, cx| view.update(cx, |palette, cx| palette.show(&input(), Some(search), window, cx)));
    cx.run_until_parked();
    (view, Opened { events, _sub: sub }, cx)
}

fn type_query(view: &Entity<PaletteView>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |palette, cx| palette.set_query(text, window, cx)));
    cx.run_until_parked();
}

fn ids(view: &Entity<PaletteView>, cx: &mut VisualTestContext) -> Vec<String> {
    view.read_with(cx, |palette, _| palette.rows().iter().map(|row| row.id.clone()).collect())
}

#[gpui::test]
fn it_opens_over_the_window_listing_the_groups(cx: &mut TestAppContext) {
    let (view, _, cx) = open(cx);
    assert!(view.read_with(cx, |p, _| p.is_open()));
    for selector in ["palette", "palette-header", "palette-list", "palette-group-Actions", "palette-row-0"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let rows = ids(&view, cx);
    assert_eq!(rows.first().map(String::as_str), Some("git"));
    assert!(rows.contains(&"chat:s#1".to_string()) && rows.contains(&"project:/code/api".to_string()));
}

#[gpui::test]
fn typing_narrows_the_list_and_arrows_move_the_selection(cx: &mut TestAppContext) {
    let (view, _, cx) = open(cx);
    type_query(&view, "re", cx);
    let rows = ids(&view, cx);
    assert!(rows.contains(&"chat:s#2".to_string()));
    assert_eq!(view.read_with(cx, |p, _| p.selected_id().map(str::to_string)), Some(rows[0].clone()));
    cx.simulate_keystrokes("down");
    assert_eq!(view.read_with(cx, |p, _| p.selected_id().map(str::to_string)), Some(rows[1].clone()));
    cx.simulate_keystrokes("up up");
    assert_eq!(view.read_with(cx, |p, _| p.selected_id().map(str::to_string)), Some(rows.last().unwrap().clone()), "wraps to the last row");
}

#[gpui::test]
fn return_runs_the_selected_row_closes_and_remembers_it(cx: &mut TestAppContext) {
    let (view, opened, cx) = open(cx);
    type_query(&view, "release", cx);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(*opened.events.borrow(), ["closed", "chat:s#2"]);
    assert!(!view.read_with(cx, |p, _| p.is_open()));
    assert_eq!(cx.update(|_, cx| cx.global::<RecentCommands>().0.clone()), ["chat:s#2"]);
    // The next opening leads with it.
    let search: Option<Rc<dyn super::MessageSearch>> = None;
    cx.update(|window, cx| view.update(cx, |p, cx| p.show(&input(), search, window, cx)));
    cx.run_until_parked();
    assert_eq!(ids(&view, cx)[0], "recent:chat:s#2");
}

#[gpui::test]
fn escape_closes_without_running_anything(cx: &mut TestAppContext) {
    let (view, opened, cx) = open(cx);
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(!view.read_with(cx, |p, _| p.is_open()));
    assert_eq!(*opened.events.borrow(), ["closed"]);
}

#[gpui::test]
fn a_click_on_a_row_runs_it_and_a_press_on_the_scrim_closes(cx: &mut TestAppContext) {
    let (view, opened, cx) = open(cx);
    let row = testing::bounds(cx, "palette-row-1").center();
    cx.simulate_click(row, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(opened.events.borrow().len(), 2);
    assert!(!view.read_with(cx, |p, _| p.is_open()));
    let search: Option<Rc<dyn super::MessageSearch>> = None;
    cx.update(|window, cx| view.update(cx, |p, cx| p.show(&input(), search, window, cx)));
    cx.run_until_parked();
    cx.simulate_click(gpui::point(gpui::px(4.0), gpui::px(4.0)), Modifiers::none());
    assert!(!view.read_with(cx, |p, _| p.is_open()));
}

#[gpui::test]
fn messages_are_searched_after_a_pause_when_no_command_matches(cx: &mut TestAppContext) {
    let (view, _, cx) = open(cx);
    type_query(&view, "migration", cx);
    assert!(ids(&view, cx).is_empty(), "nothing is offered while the host looks");
    cx.executor().advance_clock(SEARCH_DELAY + std::time::Duration::from_millis(10));
    cx.run_until_parked();
    assert_eq!(ids(&view, cx), ["message:9"]);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
}

#[gpui::test]
fn a_search_with_no_answer_offers_a_new_chat(cx: &mut TestAppContext) {
    let (view, opened, cx) = open(cx);
    type_query(&view, "qqzzxx", cx);
    cx.executor().advance_clock(SEARCH_DELAY + std::time::Duration::from_millis(10));
    cx.run_until_parked();
    assert_eq!(ids(&view, cx), [START_CHAT_ID]);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(opened.events.borrow().last().map(String::as_str), Some(START_CHAT_ID));
    assert!(cx.update(|_, cx| cx.try_global::<RecentCommands>().is_none_or(|r| r.0.is_empty())), "that row is not remembered");
}

#[gpui::test]
fn the_window_opens_it_with_cmd_k_and_runs_a_command(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    // The composer has the focus, as in the app: the window's actions are on its path.
    let focus = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer_focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.simulate_keystrokes("cmd-k");
    cx.run_until_parked();
    let palette = workspace.read_with(cx, |w, _| w.palette.clone());
    assert!(palette.read_with(cx, |p, _| p.is_open()));
    assert!(ids(&palette, cx).iter().any(|id| id.starts_with("chat:")), "the sidebar's Chats are listed");
    type_query(&palette, "routines", cx);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(!palette.read_with(cx, |p, _| p.is_open()));
    cx.simulate_keystrokes("cmd-k");
    cx.run_until_parked();
    assert!(palette.read_with(cx, |p, _| p.is_open()));
    cx.simulate_keystrokes("cmd-k");
    cx.run_until_parked();
    assert!(!palette.read_with(cx, |p, _| p.is_open()), "cmd-k toggles");
}
