//! Cases ported from `keybindings.test.mjs`, plus the shortcut gate, the catalogue, labels, GPUI output and the
//! rules the TS leaves untested.

use super::catalog::KEYBINDING_COMMANDS;
use super::gpui::{GpuiOptions, gpui_bindings, gpui_context, gpui_keystroke, gpui_pairs};
use super::keys::{canonical_key, format_key, has_command_modifier, key_from_event};
use super::rules::*;
use super::when::{WHEN_KEYS, when_names};
use super::*;
use std::collections::HashSet;

fn press(key: &str) -> KeyEvent {
    KeyEvent { key: key.into(), ..Default::default() }
}

fn press_code(key: &str, code: &str) -> KeyEvent {
    KeyEvent { key: key.into(), code: code.into(), ..Default::default() }
}

fn meta(mut e: KeyEvent) -> KeyEvent {
    e.meta_key = true;
    e
}
fn ctrl(mut e: KeyEvent) -> KeyEvent {
    e.ctrl_key = true;
    e
}
fn alt(mut e: KeyEvent) -> KeyEvent {
    e.alt_key = true;
    e
}
fn shift(mut e: KeyEvent) -> KeyEvent {
    e.shift_key = true;
    e
}

fn ctx(names: &[&str]) -> WhenContext {
    names.iter().fold(WhenContext::new(), |c, n| c.with(n))
}

fn sc(key: &str, m: bool, meta: bool, ctrl: bool, alt: bool, shift: bool) -> KeyShortcut {
    KeyShortcut { key: key.into(), mod_key: m, meta, ctrl, alt, shift }
}

#[test]
fn every_command_has_a_unique_id_and_a_key_it_can_read() {
    let ids: Vec<_> = KEYBINDING_COMMANDS.iter().map(|c| c.id).collect();
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
    for rule in default_keybindings() {
        assert!(parse_key(&rule.key).is_some(), "{}", rule.key);
    }
}

#[test]
fn the_catalogue_matches_the_ts_in_size_order_and_flags() {
    assert_eq!(KEYBINDING_COMMANDS.len(), 26);
    assert_eq!(KEYBINDING_COMMANDS[0].id, "commandPalette.toggle");
    assert_eq!(KEYBINDING_COMMANDS[0].defaults, &["mod+k"]);
    assert_eq!(KEYBINDING_COMMANDS[25].id, "simulator.toggle");
    let jump: Vec<_> = KEYBINDING_COMMANDS.iter().filter(|c| c.id.starts_with("chat.jump.")).collect();
    assert_eq!(jump.len(), 9);
    assert_eq!(jump[4].title, "Open Chat 5");
    assert_eq!(jump[4].defaults, &["mod+5"]);
    let forward: Vec<_> = KEYBINDING_COMMANDS.iter().filter(|c| c.forward).map(|c| c.id).collect();
    assert_eq!(
        forward,
        [
            "settings.open",
            "theme.toggle",
            "usage.open",
            "changes.toggle",
            "artifacts.toggle",
            "designs.toggle",
            "browser.toggle",
            "simulator.toggle"
        ]
    );
    assert_eq!(KEYBINDING_COMMANDS.iter().filter(|c| c.mobile).count(), 6 + 9);
    assert_eq!(keybinding_command("chat.quote").map(|c| c.defaults[0]), Some("mod+shift+'"));
    assert!(keybinding_command("nope").is_none());
    assert_eq!(default_rules_for("chat.new"), vec![KeybindingRule::new("mod+n", "chat.new")]);
    assert!(default_rules_for("nope").is_empty());
    assert_eq!(WHEN_KEYS.len(), 7);
}

#[test]
fn parse_key_reads_modifiers_aliases_and_the_plus_key() {
    assert_eq!(parse_key("Mod+Shift+D"), Some(sc("d", true, false, false, false, true)));
    assert_eq!(parse_key("cmd+left").map(|s| s.key), Some("arrowleft".into()));
    assert_eq!(parse_key("mod++").map(|s| s.key), Some("+".into()));
    assert_eq!(parse_key("mod+shift"), None);
    assert_eq!(parse_key("mod+k+j"), None);
    assert_eq!(parse_key("mod+nope"), None);
    assert_eq!(parse_key(""), None);
}

#[test]
fn parse_key_edge_cases() {
    assert_eq!(parse_key("  Command+Option+Esc ").map(|s| (s.meta, s.alt, s.key)), Some((true, true, "escape".into())));
    assert_eq!(parse_key("super+return").map(|s| (s.meta, s.key)), Some((true, "enter".into())));
    assert_eq!(parse_key("control+del").map(|s| (s.ctrl, s.key)), Some((true, "delete".into())));
    assert_eq!(parse_key("mod+plus").map(|s| s.key), Some("+".into()));
    assert_eq!(parse_key("mod+comma").map(|s| s.key), Some(",".into()));
    assert_eq!(parse_key("mod+period").map(|s| s.key), Some(".".into()));
    assert_eq!(parse_key("f19").map(|s| s.key), Some("f19".into()));
    assert_eq!(parse_key("f20"), None);
    assert_eq!(parse_key("f0"), None);
    assert_eq!(parse_key("f01"), None);
    assert_eq!(parse_key("++"), None);
    assert_eq!(parse_key("mod+"), None);
    assert_eq!(parse_key("mod+😀"), None, "a key longer than one UTF-16 unit");
    assert_eq!(parse_key(&format!("mod+{}", "a".repeat(70))), None);
    assert_eq!(parse_key("mod+shift+'").map(|s| s.key), Some("'".into()));
    // A modifier name is only a modifier before the last part.
    assert_eq!(parse_key("shift"), None);
}

#[test]
fn format_and_canonical_keys() {
    assert_eq!(format_key(&sc("d", true, true, true, true, true)), "mod+cmd+ctrl+alt+shift+d");
    assert_eq!(canonical_key("mod+k", true), canonical_key("cmd+K", true));
    assert_eq!(canonical_key("mod+k", false), canonical_key("ctrl+k", false));
    assert_ne!(canonical_key("mod+k", true), canonical_key("ctrl+k", true));
    assert_eq!(canonical_key("bad key", true), None);
}

#[test]
fn key_from_event_reads_punctuation_and_alt_letters_from_the_physical_key() {
    assert_eq!(key_from_event(&shift(meta(press("D"))), true).as_deref(), Some("mod+shift+d"));
    let mut e = shift(meta(press_code("<", "Comma")));
    assert_eq!(key_from_event(&e, true).as_deref(), Some("mod+shift+,"));
    e = alt(meta(press_code("˚", "KeyK")));
    assert_eq!(key_from_event(&e, true).as_deref(), Some("mod+alt+k"));
    e = alt(ctrl(press("ArrowLeft")));
    assert_eq!(key_from_event(&e, false).as_deref(), Some("mod+alt+arrowleft"));
    assert_eq!(key_from_event(&meta(press("Meta")), true), None);
    // The keys of the table the physical-code path covers.
    assert_eq!(key_from_event(&meta(press_code("{", "BracketLeft")), true).as_deref(), Some("mod+["));
    assert_eq!(key_from_event(&meta(press_code("1", "Digit1")), true).as_deref(), Some("mod+1"));
    assert_eq!(key_from_event(&alt(press(" ")), true).as_deref(), Some("alt+space"));
    assert_eq!(key_from_event(&press("F5"), true).as_deref(), Some("f5"));
    assert_eq!(key_from_event(&press("Dead"), true), None);
    // A Mac distinguishes Ctrl from Cmd; elsewhere Meta is its own modifier.
    assert_eq!(key_from_event(&ctrl(press("k")), true).as_deref(), Some("ctrl+k"));
    assert_eq!(key_from_event(&meta(press("k")), false).as_deref(), Some("cmd+k"));
}

#[test]
fn key_label_for_draws_mac_glyphs_in_menu_order_and_words_elsewhere() {
    assert_eq!(key_label_for("mod+shift+d", true).as_deref(), Some("⇧⌘D"));
    assert_eq!(key_label_for("mod+alt+arrowleft", true).as_deref(), Some("⌥⌘←"));
    assert_eq!(key_label_for("ctrl+alt+shift+mod+k", true).as_deref(), Some("⌃⌥⇧⌘K"));
    assert_eq!(key_label_for("mod+shift+d", false).as_deref(), Some("Ctrl+Shift+D"));
    assert_eq!(key_label_for("bad", true), None);
    assert_eq!(key_label_for("alt+space", true).as_deref(), Some("⌥Space"));
    assert_eq!(key_label_for("cmd+alt+k", false).as_deref(), Some("Meta+Alt+K"));
    assert_eq!(key_label_for("mod+enter", true).as_deref(), Some("⌘↵"));
    assert_eq!(key_label_for("f5", true).as_deref(), Some("F5"));
}

#[test]
fn has_command_modifier_refuses_keys_that_fire_while_typing() {
    assert!(!has_command_modifier("k"));
    assert!(!has_command_modifier("shift+k"));
    assert!(has_command_modifier("alt+k"));
    assert!(has_command_modifier("f5"));
    assert!(!has_command_modifier("nope+nope"));
}

#[test]
fn parse_when_and_evaluate_when_handle_not_and_or_and_parentheses() {
    let tree = parse_when("chatView && !(terminalFocus || editableFocus)").expect("parses");
    assert!(evaluate_when(&tree, &ctx(&["chatView"])));
    assert!(!evaluate_when(&tree, &ctx(&["chatView", "terminalFocus"])));
    assert!(!evaluate_when(&parse_when("unknownKey").expect("parses"), &ctx(&[])));
    assert_eq!(parse_when("a &&"), None);
    assert_eq!(parse_when("(a"), None);
    assert_eq!(parse_when("a b"), None);
}

#[test]
fn when_edge_cases() {
    assert_eq!(parse_when(""), None);
    assert_eq!(parse_when("   "), None);
    assert_eq!(parse_when("a & b"), None);
    assert_eq!(parse_when("a | b"), None);
    assert_eq!(parse_when("!"), None);
    assert_eq!(parse_when("1a"), None);
    assert_eq!(parse_when("()"), None);
    assert_eq!(parse_when(&"a ".repeat(200)), None, "over 256 characters");
    // || binds looser than &&.
    let t = parse_when("a || b && c").expect("parses");
    assert!(evaluate_when(&t, &ctx(&["a"])));
    assert!(!evaluate_when(&t, &ctx(&["b"])));
    assert!(evaluate_when(&t, &ctx(&["b", "c"])));
    // Dots are part of a name.
    assert_eq!(when_names(&parse_when("a.b && !(c || a.b)").expect("parses")), vec!["a.b", "c", "a.b"]);
    // 32 nested parentheses parse; 33 do not.
    let nest = |n: usize| format!("{}x{}", "(".repeat(n), ")".repeat(n));
    assert!(parse_when(&nest(32)).is_some());
    assert!(parse_when(&nest(33)).is_none());
    // Setting a name false is the same as not setting it.
    let mut c = ctx(&["a"]);
    c.set("a", false);
    assert!(!evaluate_when(&parse_when("a").expect("parses"), &c));
}

fn raw(key: &str, command: &str, when: Option<&str>) -> RawRule {
    RawRule { key: key.into(), command: command.into(), when: when.map(str::to_string) }
}

#[test]
fn read_rules_keeps_valid_rules_and_says_what_it_left_out() {
    let (rules, issues) = read_rules(&[
        raw("mod+g", "terminal.toggle", None),
        raw("mod+g", "nope", None),
        raw("", "chat.new", None),
        raw("mod+t", "terminal.new", Some("terminalFocus &&")),
    ]);
    assert_eq!(rules, vec![KeybindingRule::new("mod+g", "terminal.toggle")]);
    assert_eq!(
        issues,
        vec![
            "Rule 2 has an unknown command \"nope\".",
            "Rule 3 has a key Milagre can't read: \"\".",
            "Rule 4 has a when it can't read: \"terminalFocus &&\".",
        ]
    );
}

#[test]
fn read_rules_trims_and_caps() {
    let (rules, _) = read_rules(&[raw("  mod+g ", "chat.new", Some(" chatView "))]);
    assert_eq!(rules[0].key, "mod+g");
    assert_eq!(rules[0].when.as_deref(), Some("chatView"));
    let many: Vec<_> = (0..300).map(|_| raw("mod+g", "chat.new", None)).collect();
    let (rules, issues) = read_rules(&many);
    assert_eq!(rules.len(), 256);
    assert_eq!(issues, vec!["Only the first 256 rules are read."]);
    // An empty when is not a when: it is rejected as unreadable.
    assert!(read_rule(&raw("mod+g", "chat.new", Some(""))).is_err());
}

#[test]
fn the_last_matching_rule_wins_and_when_gates_it() {
    let compiled = compile_rules(&[
        KeybindingRule::new("mod+k", "commandPalette.toggle"),
        KeybindingRule::new("mod+k", "terminal.new").with_when("terminalFocus"),
    ]);
    let event = meta(press("k"));
    assert_eq!(command_for_event(&compiled, &event, &ctx(&[]), true), Some("commandPalette.toggle"));
    assert_eq!(command_for_event(&compiled, &event, &ctx(&["terminalFocus"]), true), Some("terminal.new"));
    assert_eq!(command_for_event(&compiled, &shift(meta(press("k"))), &ctx(&[]), true), None);
    // mod takes either Cmd or Ctrl, as the window always did, but not both.
    assert_eq!(command_for_event(&compiled, &ctrl(press("k")), &ctx(&[]), true), Some("commandPalette.toggle"));
    assert_eq!(command_for_event(&compiled, &ctrl(meta(press("k"))), &ctx(&[]), true), None);
    // A rule naming the pressed modifier wins over a later mod rule that only allows it.
    let both = compile_rules(&[KeybindingRule::new("ctrl+k", "chat.new"), KeybindingRule::new("mod+k", "commandPalette.toggle")]);
    assert_eq!(command_for_event(&both, &ctrl(press("k")), &ctx(&[]), true), Some("chat.new"));
    assert_eq!(command_for_event(&both, &meta(press("k")), &ctx(&[]), true), Some("commandPalette.toggle"));
}

#[test]
fn compile_rules_drops_what_does_not_parse() {
    let compiled = compile_rules(&[
        KeybindingRule::new("bad+", "chat.new"),
        KeybindingRule::new("mod+n", "chat.new").with_when("a &&"),
        KeybindingRule::new("mod+n", "chat.new").with_when(""),
        KeybindingRule::new("mod+m", "chat.new"),
    ]);
    assert_eq!(compiled.len(), 2);
    assert!(compiled[0].when_tree.is_none(), "an empty when is no when");
}

#[test]
fn shortcut_command_keeps_typing_typing() {
    let compiled = compile_rules(&[KeybindingRule::new("k", "chat.find"), KeybindingRule::new("mod+f", "chat.find")]);
    let editing = ctx(&["editableFocus"]);
    // The command's last rule has a modifier, so it runs in a field.
    assert_eq!(shortcut_command(&compiled, &meta(press("f")), &editing, true), Some("chat.find"));
    // The bare "k" rule is not the last one, but the command's last rule decides: it runs (as in the TS).
    assert_eq!(shortcut_command(&compiled, &press("k"), &editing, true), Some("chat.find"));
    let bare = compile_rules(&[KeybindingRule::new("mod+f", "chat.find"), KeybindingRule::new("k", "chat.find")]);
    assert_eq!(shortcut_command(&bare, &press("k"), &editing, true), None);
    assert_eq!(shortcut_command(&bare, &press("k"), &ctx(&[]), true), Some("chat.find"));
    assert_eq!(shortcut_command(&bare, &press("z"), &editing, true), None);
}

#[test]
fn conflicts_for_names_the_other_commands_on_the_same_key_and_when() {
    let rules = default_keybindings();
    assert_eq!(conflicts_for(&rules, "cmd+K", "chat.new", None, true), vec!["commandPalette.toggle"]);
    assert!(conflicts_for(&rules, "mod+k", "commandPalette.toggle", None, true).is_empty());
    assert!(conflicts_for(&rules, "mod+k", "chat.new", Some("terminalFocus"), true).is_empty());
    assert!(conflicts_for(&rules, "nonsense+", "chat.new", None, true).is_empty());
    // cmd and ctrl differ on a Mac, and are the same key as mod elsewhere.
    assert!(conflicts_for(&rules, "ctrl+k", "chat.new", None, true).is_empty());
    assert_eq!(conflicts_for(&rules, "ctrl+k", "chat.new", None, false), vec!["commandPalette.toggle"]);
    // Each conflicting command once.
    let doubled = vec![KeybindingRule::new("mod+g", "chat.find"), KeybindingRule::new("cmd+g", "chat.find")];
    assert_eq!(conflicts_for(&doubled, "mod+g", "chat.new", None, true), vec!["chat.find"]);
}

#[test]
fn with_command_rules_replaces_a_commands_rules_at_the_end_and_is_default_notices() {
    let rules = default_keybindings();
    assert!(is_default(&rules, "chat.new"));
    let next = with_command_rules(&rules, "chat.new", &[RuleDraft::new("mod+shift+n")]);
    assert_eq!(next.last(), Some(&KeybindingRule::new("mod+shift+n", "chat.new")));
    assert_eq!(next.iter().filter(|r| r.command == "chat.new").count(), 1);
    assert!(!is_default(&next, "chat.new"));
    assert_eq!(primary_key_for(&next, "chat.new", None), Some("mod+shift+n"));
    assert_eq!(primary_key_for(&with_command_rules(&rules, "chat.new", &[]), "chat.new", None), None);
    // A default key with a when is no longer the default.
    let gated = with_command_rules(&rules, "chat.new", &[RuleDraft { key: "mod+n".into(), when: Some("chatView".into()) }]);
    assert!(!is_default(&gated, "chat.new"));
}

#[test]
fn primary_key_for_takes_the_last_rule_whose_when_holds() {
    let rules = vec![KeybindingRule::new("mod+1", "chat.new"), KeybindingRule::new("mod+2", "chat.new").with_when("terminalFocus")];
    assert_eq!(primary_key_for(&rules, "chat.new", None), Some("mod+2"));
    assert_eq!(primary_key_for(&rules, "chat.new", Some(&ctx(&[]))), Some("mod+1"));
    assert_eq!(primary_key_for(&rules, "chat.new", Some(&ctx(&["terminalFocus"]))), Some("mod+2"));
    assert_eq!(keys_for(&rules, "chat.new"), vec!["mod+1", "mod+2"]);
}

#[test]
fn add_new_defaults_adds_unseen_commands_once_and_keeps_removed_ones_unbound() {
    let first = add_new_defaults(&[], &[]);
    assert_eq!(first.rules, default_keybindings());
    assert!(first.added);
    let unbound = with_command_rules(&first.rules, "chat.new", &[]);
    let again = add_new_defaults(&unbound, &first.seen);
    assert!(!again.added);
    assert!(!again.rules.iter().any(|r| r.command == "chat.new"));
    // A newer Milagre brings designs.toggle: added once, after the rules there are.
    let without = with_command_rules(&unbound, "designs.toggle", &[]);
    let seen_without: Vec<String> = first.seen.iter().filter(|id| *id != "designs.toggle").cloned().collect();
    let newer = add_new_defaults(&without, &seen_without);
    assert_eq!(newer.rules.last(), Some(&KeybindingRule::new("mod+shift+e", "designs.toggle")));
    assert!(!newer.rules.iter().any(|r| r.command == "chat.new"));
    // An unseen command the file already binds keeps only its own rules.
    let kept = add_new_defaults(&with_command_rules(&without, "designs.toggle", &[RuleDraft::new("mod+e")]), &seen_without);
    let mine: Vec<_> = kept.rules.iter().filter(|r| r.command == "designs.toggle").collect();
    assert_eq!(mine, vec![&KeybindingRule::new("mod+e", "designs.toggle")]);
    assert!(!kept.added);
    assert!(kept.seen.iter().any(|id| id == "designs.toggle"));
    // Seen ids keep their order and are not repeated.
    let dup = add_new_defaults(&[], &["x".to_string(), "x".to_string()]);
    assert_eq!(&dup.seen[..2], ["x".to_string(), "commandPalette.toggle".to_string()]);
}

#[test]
fn chat_jump_helpers() {
    assert_eq!(chat_jump_index(Some("chat.jump.1")), Some(0));
    assert_eq!(chat_jump_index(Some("chat.jump.9")), Some(8));
    assert_eq!(chat_jump_index(Some("chat.jump.10")), None);
    assert_eq!(chat_jump_index(Some("chat.jump.0")), None);
    assert_eq!(chat_jump_index(Some("chat.new")), None);
    assert_eq!(chat_jump_index(None), None);
    assert_eq!(chat_jump_command(2), "chat.jump.3");
    assert!(keybinding_command(&chat_jump_command(8)).is_some());
}

// ---- GPUI --------------------------------------------------------------------------------------------------------

fn pairs(rules: &[KeybindingRule], mac: bool) -> Vec<(String, String)> {
    gpui_pairs(rules, mac, GpuiOptions::default())
}

#[test]
fn gpui_keystrokes_follow_gpui_syntax() {
    let ks = |key: &str, mac| gpui_keystroke(&parse_key(key).expect("key"), mac);
    assert_eq!(ks("mod+shift+d", true), "shift-cmd-d");
    assert_eq!(ks("mod+shift+d", false), "ctrl-shift-d");
    assert_eq!(ks("mod+alt+arrowleft", true), "alt-cmd-left");
    assert_eq!(ks("alt+space", true), "alt-space");
    assert_eq!(ks("mod+,", true), "cmd-,");
    assert_eq!(ks("mod+[", true), "cmd-[");
    assert_eq!(ks("mod+shift+'", true), "shift-cmd-'");
    assert_eq!(ks("ctrl+alt+shift+cmd+k", true), "ctrl-alt-shift-cmd-k");
    assert_eq!(ks("cmd+k", false), "super-k");
    assert_eq!(ks("mod+-", true), "cmd--");
    assert_eq!(ks("mod++", true), "cmd-+");
    assert_eq!(ks("f5", true), "f5");
    assert_eq!(ks("mod+pagedown", true), "cmd-pagedown");
}

#[test]
fn every_default_becomes_a_gpui_keystroke_gpui_can_name() {
    let all = pairs(&default_keybindings(), true);
    assert_eq!(all.len(), 26);
    assert_eq!(all[0], ("cmd-k".to_string(), "commandPalette.toggle".to_string()));
    assert!(all.iter().any(|(k, c)| k == "cmd-1" && c == "chat.jump.1"));
    assert!(all.iter().any(|(k, c)| k == "cmd-b" && c == "sidebar.toggle"));
    // No two defaults share a keystroke.
    assert_eq!(all.iter().map(|(k, _)| k).collect::<HashSet<_>>().len(), all.len());
}

#[test]
fn gpui_contexts_come_from_when_and_the_typing_gate() {
    let rules = vec![
        KeybindingRule::new("mod+k", "commandPalette.toggle"),
        KeybindingRule::new("mod+t", "terminal.new").with_when("terminalFocus"),
        KeybindingRule::new("mod+f", "chat.find").with_when("chatView && !(terminalFocus || editableFocus)"),
        KeybindingRule::new("x", "chat.quote"),
        KeybindingRule::new("y", "changes.toggle").with_when("a.b || c"),
        KeybindingRule::new("mod+y", "chat.parent").with_when("bad &&"),
    ];
    let bindings = gpui_bindings(&rules, true, GpuiOptions::default());
    let contexts: Vec<_> = bindings.iter().map(|b| (b.keystroke.as_str(), b.command.as_str(), b.context.as_deref())).collect();
    assert_eq!(
        contexts,
        vec![
            ("cmd-k", "commandPalette.toggle", None),
            ("cmd-t", "terminal.new", Some("terminalFocus")),
            ("cmd-f", "chat.find", Some("chatView && !(terminalFocus || editableFocus)")),
            ("x", "chat.quote", Some("!editableFocus")),
            ("y", "changes.toggle", Some("(a_b || c) && !editableFocus")),
        ],
        "the unparseable rule is left out"
    );
    assert_eq!(gpui_context(&parse_when("!a").expect("parses")), "!a");
    assert_eq!(gpui_context(&parse_when("!!a").expect("parses")), "!!a");
}

#[test]
fn gpui_gate_follows_the_commands_last_rule() {
    let rules = vec![KeybindingRule::new("x", "chat.quote"), KeybindingRule::new("mod+q", "chat.quote")];
    let bindings = gpui_bindings(&rules, true, GpuiOptions::default());
    assert!(bindings.iter().all(|b| b.context.is_none()));
}

#[test]
fn gpui_user_overrides_register_in_file_order_so_the_last_rule_wins() {
    let merged = with_command_rules(&default_keybindings(), "chat.new", &[RuleDraft::new("mod+shift+n")]);
    let all = pairs(&merged, true);
    assert!(!all.iter().any(|(k, c)| k == "cmd-n" && c == "chat.new"));
    assert_eq!(all.last(), Some(&("shift-cmd-n".to_string(), "chat.new".to_string())));
    let clash = pairs(&[KeybindingRule::new("mod+k", "chat.new"), KeybindingRule::new("mod+k", "chat.find")], true);
    assert_eq!(clash.last().map(|(_, c)| c.as_str()), Some("chat.find"));
}

#[test]
fn gpui_mod_either_binds_the_other_modifier_first() {
    let rules = vec![KeybindingRule::new("mod+k", "commandPalette.toggle"), KeybindingRule::new("ctrl+j", "terminal.toggle")];
    let all = gpui_pairs(&rules, true, GpuiOptions { mod_either: true });
    assert_eq!(
        all,
        vec![
            ("ctrl-k".to_string(), "commandPalette.toggle".to_string()),
            ("cmd-k".to_string(), "commandPalette.toggle".to_string()),
            ("ctrl-j".to_string(), "terminal.toggle".to_string()),
        ]
    );
    let other = gpui_pairs(&rules, false, GpuiOptions { mod_either: true });
    assert_eq!(other[0].0, "super-k");
    assert_eq!(other[1].0, "ctrl-k");
}
