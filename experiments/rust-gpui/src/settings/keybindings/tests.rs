//! Headless tests for WP-41 (Keybindings): the pure rules (what a key press does while recording, the edits, the
//! search, the `when` checks) and the page (the groups, recording a key, the conflict and bare-key flows, removing,
//! resetting, the scope, the failure notice, Conditions).

use gpui::{BorrowAppContext as _, Entity, Keystroke, Modifiers, TestAppContext, VisualTestContext};

use super::KeybindingsView;
use super::logic::{self, ALL, Captured, Pending, Recording, WhenCheck, capture, key_event};
use super::model::KeybindingsStore;
use crate::data::LOCAL;
use crate::logic::keybindings::catalog::KEYBINDING_COMMANDS;
use crate::logic::keybindings::{KeybindingRule, default_keybindings};
use crate::settings::SettingsSectionId;
use crate::testing;
use crate::workspace::Workspace;

// ---- The rules ------------------------------------------------------------------------------------------------

fn press(rules: &[KeybindingRule], command: &str, index: Option<usize>, keys: &'static str) -> Captured {
    let event = key_event(&Keystroke::parse(keys).expect("a keystroke"));
    capture(rules, &Recording { command: command.to_string(), index }, &event, true)
}

#[test]
fn a_gpui_keystroke_becomes_the_key_string_of_the_model() {
    let key = |keys: &'static str| crate::logic::keybindings::keys::key_from_event(&key_event(&Keystroke::parse(keys).unwrap()), true);
    assert_eq!(key("cmd-shift-d").as_deref(), Some("mod+shift+d"));
    assert_eq!(key("ctrl-alt-left").as_deref(), Some("ctrl+alt+arrowleft"));
    assert_eq!(key("alt-space").as_deref(), Some("alt+space"));
    assert_eq!(key("cmd-,").as_deref(), Some("mod+,"));
    assert_eq!(key("cmd-alt-pagedown").as_deref(), Some("mod+alt+pagedown"));
    assert_eq!(key("ctrl-f5").as_deref(), Some("ctrl+f5"));
    assert_eq!(key("cmd-shift-'").as_deref(), Some("mod+shift+'"));
}

#[test]
fn escape_and_backspace_end_a_recording_but_only_a_rule_can_be_removed() {
    let rules = default_keybindings();
    assert_eq!(press(&rules, "chat.new", Some(0), "escape"), Captured::Cancel);
    assert_eq!(press(&rules, "chat.new", Some(0), "backspace"), Captured::Remove);
    assert_eq!(press(&rules, "chat.new", Some(0), "delete"), Captured::Remove);
    assert_eq!(press(&rules, "chat.new", None, "backspace"), Captured::Cancel, "a new rule has nothing to remove");
    // With a modifier they are keys like any other.
    assert_eq!(press(&rules, "terminal.new", None, "cmd-backspace"), Captured::Save("mod+backspace".into()));
}

#[test]
fn a_key_nobody_has_is_saved_and_one_a_command_has_asks() {
    let rules = default_keybindings();
    assert_eq!(press(&rules, "terminal.new", Some(0), "cmd-shift-y"), Captured::Save("mod+shift+y".into()));
    let Captured::Ask(pending) = press(&rules, "terminal.new", Some(0), "cmd-n") else { panic!("Cmd N is New Chat's") };
    assert_eq!(pending.conflicts, vec!["chat.new".to_string()]);
    assert_eq!(pending.error, None);
    assert_eq!(logic::pending_message(&pending), "⌘N already runs “New Chat”. Replace takes it from it.");
    // Its own key is no conflict.
    assert_eq!(press(&rules, "chat.new", Some(0), "cmd-n"), Captured::Save("mod+n".into()));
}

#[test]
fn a_named_key_is_one_keycap_beside_its_modifiers() {
    assert_eq!(logic::label("alt+space"), "⌥ Space");
    assert_eq!(logic::label("mod+shift+d"), "⇧⌘D");
    assert_eq!(logic::label("mod+alt+arrowleft"), "⌥⌘←");
    assert_eq!(crate::ui::shortcut_labels(&logic::label("alt+space")), vec!["⌥", "SPACE"]);
}

#[test]
fn a_bare_key_is_refused_with_the_reason() {
    let rules = default_keybindings();
    let Captured::Ask(Pending { error: Some(error), key, .. }) = press(&rules, "terminal.new", None, "k") else { panic!("a bare K asks") };
    assert_eq!(key, "k");
    assert_eq!(error, "K would run while you type. Add ⌘, ⌃ or ⌥.");
    // Alt alone is enough (the dictation default is Alt Space), and a function key is too.
    assert_eq!(press(&rules, "terminal.new", None, "alt-j"), Captured::Save("alt+j".into()));
    assert_eq!(press(&rules, "terminal.new", None, "f6"), Captured::Save("f6".into()));
    // Shift alone is not.
    assert!(matches!(press(&rules, "terminal.new", None, "shift-j"), Captured::Ask(Pending { error: Some(_), .. })));
}

#[test]
fn a_conflict_only_counts_under_the_same_condition() {
    let mut rules = default_keybindings();
    rules.push(KeybindingRule::new("mod+shift+y", "terminal.toggle").with_when("terminalFocus"));
    assert_eq!(press(&rules, "terminal.new", None, "cmd-shift-y"), Captured::Save("mod+shift+y".into()), "the other has a condition");
    // Re-recording the conditional rule itself is compared under its own condition.
    let index = logic::own(&rules, "terminal.toggle").len() - 1;
    let Captured::Ask(pending) = press(&rules, "chat.new", Some(0), "cmd-j") else { panic!() };
    assert_eq!(pending.conflicts, vec!["terminal.toggle".to_string()]);
    assert_eq!(index, 1);
}

#[test]
fn saving_replaces_the_rule_in_place_keeps_its_condition_and_takes_the_key_from_the_others() {
    let mut rules = default_keybindings();
    rules.retain(|rule| rule.command != "terminal.toggle");
    rules.push(KeybindingRule::new("mod+j", "terminal.toggle"));
    rules.push(KeybindingRule::new("mod+`", "terminal.toggle").with_when("!terminalFocus"));
    let recording = Recording { command: "terminal.toggle".into(), index: Some(1) };
    let edit = logic::save_edit(&rules, &recording, "mod+shift+y", &[], true);
    assert_eq!(edit.len(), 1);
    let next: Vec<(String, Option<String>)> = edit[0].1.iter().map(|rule| (rule.key.clone(), rule.when.clone())).collect();
    assert_eq!(next, vec![("mod+j".into(), None), ("mod+shift+y".into(), Some("!terminalFocus".into()))]);

    // A new rule is added after the others; taking a key leaves the other command without it.
    let recording = Recording { command: "terminal.new".into(), index: None };
    let edit = logic::save_edit(&rules, &recording, "cmd+n", &["chat.new".to_string()], true);
    assert_eq!(edit.len(), 2);
    assert_eq!(edit[0], ("chat.new".to_string(), Vec::new()), "the key left New Chat, which had only it");
    assert_eq!(edit[1].0, "terminal.new");
    assert_eq!(edit[1].1.iter().map(|rule| rule.key.as_str()).collect::<Vec<_>>(), vec!["mod+t", "cmd+n"]);
    let after = logic::apply_edit(&rules, &edit);
    assert!(after.iter().all(|rule| rule.command != "chat.new"));
    assert_eq!(
        after.last().map(|rule| (rule.key.as_str(), rule.command.as_str())),
        Some(("cmd+n", "terminal.new")),
        "edited rules go last, so they win"
    );
}

#[test]
fn remove_when_and_reset_edits() {
    let rules = default_keybindings();
    assert_eq!(logic::remove_edit(&rules, "chat.new", 0), vec![("chat.new".to_string(), Vec::new())]);
    let edit = logic::when_edit(&rules, "chat.new", 0, "  chatView  ");
    assert_eq!(edit[0].1[0].when.as_deref(), Some("chatView"), "trimmed");
    assert_eq!(logic::when_edit(&rules, "chat.new", 0, "  ")[0].1[0].when, None, "empty clears it");
    let reset = logic::reset_edit("changes.toggle");
    assert_eq!(reset[0].1.iter().map(|rule| rule.key.as_str()).collect::<Vec<_>>(), vec!["mod+shift+d"]);
    assert!(reset[0].1[0].when.is_none());
}

#[test]
fn the_search_reads_titles_ids_groups_keys_and_conditions() {
    let mut rules = default_keybindings();
    rules.push(KeybindingRule::new("mod+shift+y", "terminal.new").with_when("linkOpen"));
    let hits = |query: &str| -> Vec<&'static str> {
        KEYBINDING_COMMANDS.iter().filter(|command| logic::matches(command, &rules, query, true)).map(|command| command.id).collect()
    };
    assert_eq!(hits("").len(), KEYBINDING_COMMANDS.len());
    assert_eq!(hits("new chat"), vec!["chat.new"]);
    assert_eq!(hits("new terminal"), vec!["terminal.new"]);
    assert_eq!(hits("chat.jump.3"), vec!["chat.jump.3"]);
    assert_eq!(hits("⇧⌘D"), vec!["changes.toggle"]);
    assert_eq!(hits("panels terminal"), vec!["terminal.toggle", "terminal.new"]);
    assert_eq!(hits("TERMINAL new"), vec!["terminal.new"]);
    assert_eq!(hits("mod+shift+y"), vec!["terminal.new"]);
    assert_eq!(hits("linkopen"), vec!["terminal.new"], "a condition is searchable");
    assert!(hits("no such thing").is_empty());
}

#[test]
fn the_when_field_checks_syntax_and_names() {
    assert_eq!(logic::when_check(""), WhenCheck::default());
    assert_eq!(logic::when_check("!terminalFocus && chatView"), WhenCheck::default());
    assert!(logic::when_check("chatView &&").invalid);
    assert!(logic::when_check("(chatView").invalid);
    let unknown = logic::when_check("chatView && sidebarShown || !sidebarShown || nope");
    assert_eq!(unknown.unknown, vec!["sidebarShown".to_string(), "nope".to_string()]);
    assert!(logic::unknown_message(&unknown.unknown).starts_with("sidebarShown, nope are never true. Known: terminalFocus, "));
    assert!(logic::unknown_message(&["nope".to_string()]).starts_with("nope is never true."));
}

// ---- The page -------------------------------------------------------------------------------------------------

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(testing::leak(selector.to_string())).is_some()
}

/// Scrolls the Settings body so `selector` is on screen, then clicks it.
fn click(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    reveal(cx, workspace, selector);
    let at = cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn")).center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

fn reveal(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    let body = cx.debug_bounds("settings-main").expect("settings body");
    let at = cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn"));
    let handle = workspace.read_with(cx, |w, _| w.settings.clone()).read_with(cx, |s, _| s.body_scroll().clone());
    // Bring it to the middle of the body, whichever side it is on.
    let delta = f32::from(at.center().y - body.center().y);
    if delta.abs() > 1.0 {
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(delta)));
        settle(cx);
    }
}

fn open(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext, Entity<KeybindingsView>) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Keybindings, window, cx));
    settle(cx);
    let view = settings.read_with(cx, |s, _| s.keybindings.clone());
    (workspace, cx, view)
}

fn rules_of(cx: &mut VisualTestContext, computer: &str) -> Vec<KeybindingRule> {
    cx.update(|_, cx| cx.global::<KeybindingsStore>().get(computer).state.rules)
}

fn keys_of(cx: &mut VisualTestContext, computer: &str, command: &str) -> Vec<String> {
    rules_of(cx, computer).into_iter().filter(|rule| rule.command == command).map(|rule| rule.key).collect()
}

fn online_computers(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Vec<String> {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| s.computers.iter().filter(|(_, _, online)| *online).map(|(id, _, _)| id.clone()).collect())
}

fn keys(cx: &mut VisualTestContext, keys: &str) {
    cx.simulate_keystrokes(keys);
    settle(cx);
}

#[gpui::test]
fn the_page_lists_the_catalogue_in_four_groups_with_a_reset_only_where_a_key_was_changed(cx: &mut TestAppContext) {
    let (_workspace, cx, _view) = open(cx);
    for group in ["General", "Navigation", "Chat", "Panels"] {
        assert!(drawn(cx, &format!("settings-group-{}", group.to_lowercase())), "{group}");
    }
    for command in KEYBINDING_COMMANDS {
        assert!(drawn(cx, &format!("kb-row-{}", command.id)), "{}", command.id);
    }
    assert!(drawn(cx, "kb-chip-commandPalette.toggle-0"));
    assert!(drawn(cx, "kb-add-key-chat.new"));
    // The fixture gave Terminals a second key, so only theme.toggle and terminal.toggle have something to undo (the fixture drops their defaults and adds three rules).
    assert!(drawn(cx, "kb-reset-terminal.toggle") && drawn(cx, "kb-reset-theme.toggle"));
    assert!(!drawn(cx, "kb-reset-chat.new"));
    assert!(drawn(cx, "kb-chip-terminal.toggle-1"), "a command can have two keys");
    // Conditions are hidden until Advanced is on.
    assert!(!drawn(cx, "kb-when-toggle-chat.new"));
    assert!(drawn(cx, "kb-open-file"), "this computer's file can be opened");
    assert_eq!(cx.update(|_, cx| cx.global::<KeybindingsStore>().get(LOCAL).state.rules.len()), default_keybindings().len() + 1);
}

#[gpui::test]
fn the_search_narrows_the_groups_and_says_when_nothing_matches(cx: &mut TestAppContext) {
    let (_workspace, cx, view) = open(cx);
    let input = view.update(cx, |v, _| v.search_state()).expect("the search field exists");
    cx.update(|window, cx| input.update(cx, |state, cx| state.set_value("terminal", window, cx)));
    settle(cx);
    assert!(drawn(cx, "kb-row-terminal.toggle") && drawn(cx, "kb-row-terminal.new"));
    assert!(!drawn(cx, "kb-row-chat.new") && !drawn(cx, "settings-group-navigation"), "other commands and empty groups go");
    assert!(drawn(cx, "settings-group-general"), "Switch light and dark is kept: its condition names terminalFocus");
    cx.update(|window, cx| input.update(cx, |state, cx| state.set_value("zzzz", window, cx)));
    settle(cx);
    assert!(!drawn(cx, "kb-row-terminal.new"));
    assert!(drawn(cx, "empty-state") || !drawn(cx, "settings-group-panels"), "nothing is listed");
}

#[gpui::test]
fn pressing_a_chip_records_a_key_over_it_on_every_online_computer(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    click(cx, &workspace, "kb-chip-terminal.new-0");
    assert!(drawn(cx, "kb-recording"), "the chip turns into Press keys");
    assert_eq!(view.read_with(cx, |v, _| v.recording().cloned()), Some(Recording { command: "terminal.new".into(), index: Some(0) }));
    keys(cx, "cmd-shift-y");
    assert!(!drawn(cx, "kb-recording") && view.read_with(cx, |v, _| v.recording().is_none()));
    let mut computers = vec![LOCAL.to_string()];
    computers.extend(online_computers(&workspace, cx));
    assert!(computers.len() > 1, "the fixture has an online computer");
    for computer in &computers {
        assert_eq!(keys_of(cx, computer, "terminal.new"), vec!["mod+shift+y".to_string()], "{computer}");
    }
    assert!(drawn(cx, "kb-reset-terminal.new"), "now it differs from the default");
    // A single computer in scope leaves the others alone.
    view.update(cx, |v, cx| v.set_scope(LOCAL, cx));
    settle(cx);
    click(cx, &workspace, "kb-chip-terminal.new-0");
    keys(cx, "cmd-shift-i");
    assert_eq!(keys_of(cx, LOCAL, "terminal.new"), vec!["mod+shift+i".to_string()]);
    assert_eq!(keys_of(cx, &computers[1], "terminal.new"), vec!["mod+shift+y".to_string()]);
}

#[gpui::test]
fn escape_stops_recording_without_closing_settings_and_the_apps_shortcuts_do_not_run(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    click(cx, &workspace, "kb-chip-chat.new-0");
    keys(cx, "escape");
    assert!(view.read_with(cx, |v, _| v.recording().is_none()));
    assert!(settings.read_with(cx, |s, _| s.is_open()), "Escape went to the recording, not the dialog");
    assert_eq!(keys_of(cx, LOCAL, "chat.new"), vec!["mod+n".to_string()]);
    // Cmd-, is Open Settings: while recording it is a key like any other (and asks, as another command has it).
    click(cx, &workspace, "kb-chip-chat.new-0");
    keys(cx, "cmd-,");
    assert!(settings.read_with(cx, |s, _| s.is_open()), "the toggle did not run");
    let pending = view.read_with(cx, |v, _| v.pending().cloned()).expect("Open Settings has Cmd comma");
    assert_eq!(pending.conflicts, vec!["settings.open".to_string()]);
    assert_eq!(keys_of(cx, LOCAL, "chat.new"), vec!["mod+n".to_string()], "nothing saved yet");
}

#[gpui::test]
fn a_key_another_command_has_waits_for_replace_and_cancel_keeps_everything(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    click(cx, &workspace, "kb-add-key-terminal.new");
    keys(cx, "cmd-n");
    assert!(drawn(cx, "kb-pending-terminal.new"));
    assert_eq!(
        view.read_with(cx, |v, _| v.pending().map(logic::pending_message)).as_deref(),
        Some("⌘N already runs “New Chat”. Replace takes it from it.")
    );
    click(cx, &workspace, "kb-pending-cancel");
    assert!(!drawn(cx, "kb-pending-terminal.new"));
    assert_eq!(keys_of(cx, LOCAL, "chat.new"), vec!["mod+n".to_string()]);
    assert_eq!(keys_of(cx, LOCAL, "terminal.new"), vec!["mod+t".to_string()]);

    click(cx, &workspace, "kb-add-key-terminal.new");
    keys(cx, "cmd-n");
    click(cx, &workspace, "kb-replace");
    assert!(!drawn(cx, "kb-pending-terminal.new"));
    assert_eq!(keys_of(cx, LOCAL, "terminal.new"), vec!["mod+t".to_string(), "mod+n".to_string()], "added after its own key");
    assert!(keys_of(cx, LOCAL, "chat.new").is_empty(), "New Chat lost it and is unbound");
    assert!(drawn(cx, "kb-add-key-chat.new"));
    assert!(drawn(cx, "kb-reset-chat.new"));
}

#[gpui::test]
fn a_bare_key_cannot_be_saved(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    click(cx, &workspace, "kb-add-key-terminal.new");
    keys(cx, "k");
    let message = view.read_with(cx, |v, _| v.pending().map(logic::pending_message)).expect("a bare key asks");
    assert_eq!(message, "K would run while you type. Add ⌘, ⌃ or ⌥.");
    assert!(!drawn(cx, "kb-replace"), "only OK, no Replace");
    click(cx, &workspace, "kb-pending-cancel");
    assert_eq!(keys_of(cx, LOCAL, "terminal.new"), vec!["mod+t".to_string()]);
}

#[gpui::test]
fn backspace_while_recording_and_the_chips_cross_take_a_key_off(cx: &mut TestAppContext) {
    let (workspace, cx, _view) = open(cx);
    click(cx, &workspace, "kb-chip-terminal.toggle-1");
    keys(cx, "backspace");
    assert_eq!(keys_of(cx, LOCAL, "terminal.toggle"), vec!["mod+j".to_string()]);
    // The cross on a chip does the same.
    click(cx, &workspace, "kb-remove-sidebar.toggle-0");
    assert!(keys_of(cx, LOCAL, "sidebar.toggle").is_empty());
    assert!(drawn(cx, "kb-add-key-sidebar.toggle"), "an unbound command offers Add key");
}

#[gpui::test]
fn reset_puts_a_command_back_and_reset_all_asks_first(cx: &mut TestAppContext) {
    let (workspace, cx, _view) = open(cx);
    click(cx, &workspace, "kb-reset-terminal.toggle");
    assert_eq!(keys_of(cx, LOCAL, "terminal.toggle"), vec!["mod+j".to_string()]);
    assert!(!drawn(cx, "kb-reset-terminal.toggle"));
    assert!(drawn(cx, "kb-reset-theme.toggle"), "the other customization stays");

    click(cx, &workspace, "kb-reset-all");
    assert!(drawn(cx, "kb-reset-all-confirm"), "it asks");
    assert!(!drawn(cx, "kb-reset-all"));
    click(cx, &workspace, "kb-reset-all-cancel");
    assert!(drawn(cx, "kb-reset-all") && drawn(cx, "kb-reset-theme.toggle"), "Cancel changes nothing");
    click(cx, &workspace, "kb-reset-all");
    click(cx, &workspace, "kb-reset-all-confirm");
    assert_eq!(rules_of(cx, LOCAL), default_keybindings());
    assert!(!drawn(cx, "kb-reset-theme.toggle"));
    // It went to the online computers too (the scope is All).
    for computer in online_computers(&workspace, cx) {
        assert_eq!(rules_of(cx, &computer), default_keybindings());
    }
}

#[gpui::test]
fn a_computer_that_refuses_the_write_is_named_and_the_others_still_save(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    let online = online_computers(&workspace, cx);
    let refusing = online[0].clone();
    cx.update(|_, cx| cx.update_global::<KeybindingsStore, _>(|store, _| store.set_write_error(&refusing, Some("its disk is read-only."))));
    click(cx, &workspace, "kb-chip-chat.find-0");
    keys(cx, "cmd-shift-y");
    assert_eq!(keys_of(cx, LOCAL, "chat.find"), vec!["mod+shift+y".to_string()], "this computer saved");
    assert_eq!(keys_of(cx, &refusing, "chat.find"), vec!["mod+f".to_string()]);
    let failures = view.read_with(cx, |v, _| v.failures().to_vec());
    assert_eq!(failures.len(), 1);
    assert!(failures[0].ends_with(": its disk is read-only."), "{failures:?}");
    assert!(drawn(cx, "kb-notice-failure-0"));
    // A later edit that works clears the notice.
    cx.update(|_, cx| cx.update_global::<KeybindingsStore, _>(|store, _| store.set_write_error(&refusing, None)));
    click(cx, &workspace, "kb-reset-chat.find");
    assert!(view.read_with(cx, |v, _| v.failures().is_empty()));
}

#[gpui::test]
fn the_scope_menu_offers_all_this_computer_and_each_online_computer(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    assert_eq!(view.read_with(cx, |v, _| v.scope().to_string()), ALL);
    click(cx, &workspace, "kb-scope");
    assert!(drawn(cx, "kb-scope-all") && drawn(cx, "kb-scope-local"));
    let online = online_computers(&workspace, cx);
    assert!(drawn(cx, &format!("kb-scope-{}", online[0])));
    click(cx, &workspace, "kb-scope-local");
    assert_eq!(view.read_with(cx, |v, _| v.scope().to_string()), LOCAL);
    assert!(drawn(cx, "kb-open-file"));
    // On another computer the page shows its rules, and the file button (this computer's) is gone.
    view.update(cx, |v, cx| v.set_scope(&online[0], cx));
    settle(cx);
    assert!(!drawn(cx, "kb-open-file"));
    assert!(!drawn(cx, "kb-reset-terminal.toggle"), "that computer has the defaults");
}

#[gpui::test]
fn add_keybinding_picks_a_command_and_records_a_new_key_for_it(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    click(cx, &workspace, "kb-add");
    let option = cx.debug_bounds("kb-add-project.add").expect("the menu lists every command").center();
    cx.simulate_click(option, Modifiers::none());
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.recording().cloned()), Some(Recording { command: "project.add".into(), index: None }));
    keys(cx, "cmd-alt-y");
    assert_eq!(keys_of(cx, LOCAL, "project.add"), vec!["mod+o".to_string(), "mod+alt+y".to_string()]);
}

#[gpui::test]
fn conditions_are_edited_only_with_advanced_on_and_save_once_they_read(cx: &mut TestAppContext) {
    let (workspace, cx, view) = open(cx);
    click(cx, &workspace, "settings-row-conditions");
    assert!(cx.update(|_, cx| cx.global::<KeybindingsStore>().advanced));
    click(cx, &workspace, "kb-when-toggle-chat.find");
    let field = view.update(cx, |v, _| v.when_input("chat.find", 0, "")).expect("the condition field is open");
    let set = |cx: &mut VisualTestContext, text: &str| {
        cx.update(|window, cx| field.update(cx, |state, cx| state.set_value(text.to_string(), window, cx)));
        settle(cx);
    };
    // Text that does not read is flagged and not saved, even on Enter.
    set(cx, "chatView &&");
    assert!(drawn(cx, "kb-when-invalid-chat.find-0"), "the field is flagged");
    keys(cx, "enter");
    assert_eq!(rules_of(cx, LOCAL).iter().find(|rule| rule.command == "chat.find").and_then(|rule| rule.when.clone()), None);
    // A name no context sets only warns; the condition still saves.
    set(cx, "chatView && sidebarShown");
    assert!(drawn(cx, "kb-when-unknown-chat.find-0") && !drawn(cx, "kb-when-invalid-chat.find-0"));
    // A condition that reads saves on Enter, and the shortcut stays.
    set(cx, "chatView && !terminalFocus");
    cx.update(|window, cx| field.update(cx, |state, cx| state.focus(window, cx)));
    keys(cx, "enter");
    let rule = rules_of(cx, LOCAL).into_iter().find(|rule| rule.command == "chat.find").expect("still bound");
    assert_eq!((rule.key.as_str(), rule.when.as_deref()), ("mod+f", Some("chatView && !terminalFocus")));
    // Empty clears it again.
    let field =
        view.update(cx, |v, _| v.when_input("chat.find", 0, "chatView && !terminalFocus")).expect("a new field keyed by the saved text");
    cx.update(|window, cx| field.update(cx, |state, cx| state.set_value("", window, cx)));
    settle(cx);
    cx.update(|window, cx| field.update(cx, |state, cx| state.focus(window, cx)));
    keys(cx, "enter");
    assert_eq!(rules_of(cx, LOCAL).iter().find(|rule| rule.command == "chat.find").and_then(|rule| rule.when.clone()), None);
    // Turning Advanced off hides the buttons.
    click(cx, &workspace, "settings-row-conditions");
    assert!(!drawn(cx, "kb-when-toggle-chat.find"));
}
