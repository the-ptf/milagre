//! Composer tests, in GPUI's headless platform under gpui-component's `Root` (`testing::mount_in_root`): keys,
//! chips, undo, the menus, the prompt round trip and the IME handler calls.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AppContext as _, ClipboardEntry, ClipboardItem, Context, Entity, EntityInputHandler as _, ExternalPaths, FileDropEvent, Focusable as _,
    Image, ImageFormat, IntoElement, Modifiers, ParentElement as _, Render, Styled as _, Subscription, TestAppContext, VisualTestContext,
    Window, div, px,
};

use super::{COMPOSER_MIN_HEIGHT, Composer, ComposerAttachment, ComposerEvent, MenuKind};
use crate::testing::{self, bounds};

/// The composer at the bottom of a window-high column, as the Chat column holds it, so the menu has room above.
struct Host {
    composer: Entity<Composer>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().flex_col().justify_end().items_center().child(self.composer.clone())
    }
}

fn mount(cx: &mut TestAppContext) -> (Entity<Composer>, &mut VisualTestContext) {
    let (host, cx) = testing::mount_in_root(cx, |_, cx| Host { composer: cx.new(Composer::new) });
    let composer = host.read_with(cx, |host, _| host.composer.clone());
    composer.update_in(cx, |composer, window, cx| {
        let handle = composer.focus_handle(cx);
        window.focus(&handle, cx);
    });
    cx.run_until_parked();
    (composer, cx)
}

fn text(composer: &Entity<Composer>, cx: &mut VisualTestContext) -> String {
    composer.read_with(cx, |c, _| c.text().to_string())
}

/// The text area's chips: the source text each covers and its kind.
fn chips(composer: &Entity<Composer>, cx: &mut VisualTestContext) -> Vec<(String, String)> {
    let state = composer.read_with(cx, |c, _| c.input().cloned().expect("the text area exists"));
    state.read_with(cx, |state, _| {
        let value = state.value().to_string();
        state
            .tokens()
            .iter()
            .map(|span| (value[span.range()].to_string(), span.token().id().split(':').next().unwrap().to_string()))
            .collect()
    })
}

fn menu(composer: &Entity<Composer>, cx: &mut VisualTestContext) -> Option<(MenuKind, Vec<String>)> {
    composer.read_with(cx, |c, _| c.open_menu().map(|menu| (menu.token.kind, menu.rows.iter().map(|row| row.name.to_string()).collect())))
}

/// What the composer sent and attached, and the subscriptions that keep collecting it.
type Recorded = (Rc<RefCell<Vec<String>>>, Rc<RefCell<Vec<ComposerAttachment>>>, [Subscription; 2]);

/// Collects what the composer emits; keep the subscriptions alive for the test.
fn record(composer: &Entity<Composer>, cx: &mut VisualTestContext) -> Recorded {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let attached = Rc::new(RefCell::new(Vec::new()));
    let (s, a) = (sent.clone(), attached.clone());
    let subscriptions = cx.update(|_, cx| {
        [
            cx.subscribe(composer, move |_, event: &ComposerEvent, _| match event {
                ComposerEvent::Send(text) => s.borrow_mut().push(text.to_string()),
                ComposerEvent::Queued(_) | ComposerEvent::Stop | ComposerEvent::Compact => {}
            }),
            cx.subscribe(composer, move |_, event: &ComposerAttachment, _| a.borrow_mut().push(event.clone())),
        ]
    });
    (sent, attached, subscriptions)
}

#[gpui::test]
fn a_typed_skill_becomes_a_chip_and_stops_being_one_when_the_word_goes_on(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("Run /tldr");
    assert_eq!(chips(&composer, cx), [("/tldr".to_string(), "skill".to_string())], "a known skill, complete, is a chip");
    cx.simulate_input("x");
    assert_eq!(chips(&composer, cx), [], "/tldrx is text again, as the string says");
    cx.simulate_keystrokes("backspace");
    cx.simulate_input(" now");
    assert_eq!(text(&composer, cx), "Run /tldr now");
    assert_eq!(chips(&composer, cx), [("/tldr".to_string(), "skill".to_string())]);
    assert!(cx.debug_bounds("prompt-chip-skill-4").is_some(), "the chip is drawn by our renderer");
}

#[gpui::test]
fn one_arrow_crosses_a_chip_backspace_removes_it_whole_and_undo_brings_it_back(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("see @src/app.rs ok");
    assert_eq!(chips(&composer, cx), [("@src/app.rs".to_string(), "file".to_string())]);
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.simulate_keystrokes("alt-left left");
    assert_eq!(composer.read_with(cx, |c, _| c.selected_range()), 15..15, "after the chip");
    cx.simulate_keystrokes("left");
    assert_eq!(composer.read_with(cx, |c, _| c.selected_range()), 4..4, "one left arrow crosses the whole chip");
    cx.simulate_keystrokes("right backspace");
    assert_eq!(text(&composer, cx), "see  ok");
    assert_eq!(chips(&composer, cx), []);
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&composer, cx), "see @src/app.rs ok", "undo restores the chip's text");
    assert_eq!(chips(&composer, cx), [("@src/app.rs".to_string(), "file".to_string())], "and the chip");
    cx.simulate_keystrokes("cmd-shift-z");
    assert_eq!(text(&composer, cx), "see  ok");
    cx.simulate_keystrokes("ctrl-y");
    assert_eq!(text(&composer, cx), "see  ok", "nothing left to redo");
    cx.simulate_keystrokes("cmd-z cmd-z");
    assert_eq!(text(&composer, cx), "", "the typing before it was one step");
}

#[gpui::test]
fn the_at_menu_opens_filters_and_inserts_the_row_as_one_undo_step(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("look at @");
    let (kind, rows) = menu(&composer, cx).expect("@ opens the menu");
    assert_eq!(kind, MenuKind::At);
    assert!(rows.contains(&"Port the composer to GPUI".to_string()) && rows.contains(&"Studio".to_string()));
    assert!(cx.debug_bounds("composer-menu").is_some(), "the panel is drawn");
    let panel = bounds(cx, "composer-menu");
    let frame = bounds(cx, "composer");
    assert!(panel.bottom() <= frame.top(), "the panel sits above the composer");
    cx.simulate_input("app");
    assert_eq!(menu(&composer, cx).unwrap().1.first().map(String::as_str), Some("app.rs"), "the name match first");
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.simulate_keystrokes("enter");
    assert_eq!(text(&composer, cx), "look at @src/app.rs ");
    assert_eq!(chips(&composer, cx), [("@src/app.rs".to_string(), "file".to_string())]);
    assert_eq!(composer.read_with(cx, |c, _| c.selected_range()), 20..20, "the caret after the space");
    assert!(menu(&composer, cx).is_none(), "the pick closes the menu");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&composer, cx), "look at @app", "undo takes the chip back out in one step");
}

#[gpui::test]
fn arrows_move_one_highlight_that_wraps_and_tab_or_a_click_picks(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("@");
    let rows = menu(&composer, cx).unwrap().1.len();
    assert_eq!(composer.read_with(cx, |c, _| c.menu_state()), (0, false), "no highlight until a key or the pointer");
    cx.simulate_keystrokes("down down");
    assert_eq!(composer.read_with(cx, |c, _| c.menu_state()), (2, true));
    cx.simulate_keystrokes("up up up");
    assert_eq!(composer.read_with(cx, |c, _| c.menu_state()).0, rows - 1, "up from the first row wraps to the last");
    assert!(cx.debug_bounds(crate::testing::leak(format!("composer-menu-row-{}", rows - 1))).is_some());
    cx.simulate_keystrokes("tab");
    assert_eq!(text(&composer, cx), "@computer:\"Victor's MacBook\" ", "Tab picks the highlighted row");
    assert_eq!(chips(&composer, cx), [("@computer:\"Victor's MacBook\"".to_string(), "computer-offline".to_string())]);

    cx.simulate_input("ask @chat");
    let row = bounds(cx, "composer-menu-row-0");
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    cx.simulate_click(row.center(), Modifiers::none());
    assert!(text(&composer, cx).ends_with("ask @src/workspace/chat/composer/mod.rs "), "a click picks its row: {}", text(&composer, cx));
    cx.update(|window, cx| assert!(composer.focus_handle(cx).is_focused(window), "the prompt keeps focus"));
}

#[gpui::test]
fn the_slash_menu_ranks_what_is_typed_and_escape_closes_it_until_the_next_edit(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("/");
    let (kind, rows) = menu(&composer, cx).unwrap();
    assert_eq!(kind, MenuKind::Slash);
    assert_eq!(rows.first().map(String::as_str), Some("/undo"));
    cx.simulate_input("fro");
    assert_eq!(menu(&composer, cx).unwrap().1, ["/frontend-design"]);
    cx.simulate_keystrokes("escape");
    assert!(menu(&composer, cx).is_none(), "Escape closes the menu");
    assert!(cx.debug_bounds("composer-menu").is_none());
    cx.simulate_input("n");
    assert_eq!(menu(&composer, cx).unwrap().1, ["/frontend-design"], "typing opens it again");
    cx.simulate_keystrokes("enter");
    assert_eq!(text(&composer, cx), "/frontend-design ");
    assert_eq!(chips(&composer, cx), [("/frontend-design".to_string(), "skill".to_string())]);
}

#[gpui::test]
fn enter_sends_shift_enter_breaks_the_line_and_the_composer_clears(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (sent, _, _subscriptions) = record(&composer, cx);
    cx.simulate_keystrokes("enter");
    assert!(sent.borrow().is_empty(), "an empty prompt sends nothing");
    cx.simulate_input("one");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("two @src/app.rs");
    cx.simulate_keystrokes("enter");
    assert!(sent.borrow().is_empty(), "with the caret in a mention the menu is open: Enter picks, as on the desktop");
    assert_eq!(text(&composer, cx), "one\ntwo @src/app.rs ");
    cx.simulate_input("now");
    cx.simulate_keystrokes("enter");
    assert_eq!(*sent.borrow(), ["one\ntwo @src/app.rs now"], "the message is the prompt string, chips as their text");
    assert_eq!(text(&composer, cx), "");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&composer, cx), "", "a sent draft starts a new history");
}

#[gpui::test]
fn up_and_down_at_the_edges_step_through_sent_prompts_and_restore_the_draft(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.update(|_, cx| composer.update(cx, |c, _| c.set_prompt_history(vec!["first".into(), "second\nline".into()])));
    cx.simulate_input("draft");
    cx.simulate_keystrokes("up");
    assert_eq!(text(&composer, cx), "second\nline");
    cx.simulate_keystrokes("up");
    assert_eq!(text(&composer, cx), "second\nline", "the caret is on the last line, not the first: Up moves in the text");
    cx.simulate_keystrokes("up");
    assert_eq!(text(&composer, cx), "first");
    cx.simulate_keystrokes("up");
    assert_eq!(text(&composer, cx), "first", "nothing older");
    cx.simulate_keystrokes("down");
    assert_eq!(text(&composer, cx), "second\nline");
    cx.simulate_keystrokes("down");
    assert_eq!(text(&composer, cx), "draft", "past the newest the draft comes back");
}

#[gpui::test]
fn pasted_text_is_plain_with_unix_lines_and_pasted_images_or_files_become_an_event(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (_, attached, _subscriptions) = record(&composer, cx);
    cx.simulate_input("ab");
    cx.write_to_clipboard(ClipboardItem::new_string("one\r\ntwo".into()));
    cx.simulate_keystrokes("left cmd-v");
    assert_eq!(text(&composer, cx), "aone\ntwob");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&composer, cx), "ab", "a paste is its own undo step");

    let image = Image::from_bytes(ImageFormat::Png, vec![1, 2, 3]);
    cx.write_to_clipboard(ClipboardItem { entries: vec![ClipboardEntry::Image(image)] });
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(text(&composer, cx), "ab", "an image inserts no text");
    let at = composer.read_with(cx, |c, _| c.selected_range());
    match attached.borrow().as_slice() {
        [ComposerAttachment::Pasted { images, paths, at: range }] => {
            assert_eq!((images.len(), paths.len(), range.clone()), (1, 0, at.clone()));
        }
        other => panic!("one paste event, got {other:?}"),
    }
    // The tray uploaded it as image 1: its mention goes in where it was pasted, as a chip.
    composer.update_in(cx, |c, window, cx| c.insert_image_mentions(&[1], at.clone(), window, cx));
    assert_eq!(text(&composer, cx), "a [Image #1] b");
    assert_eq!(chips(&composer, cx), [("[Image #1]".to_string(), "image".to_string())]);
}

#[gpui::test]
fn dropped_files_become_an_event(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (_, attached, _subscriptions) = record(&composer, cx);
    let position = bounds(cx, "composer-input").center();
    let paths = ExternalPaths(vec![PathBuf::from("/tmp/shot.png")].into());
    cx.simulate_event(FileDropEvent::Entered { position, paths });
    cx.simulate_event(FileDropEvent::Submit { position });
    assert!(
        matches!(attached.borrow().as_slice(), [ComposerAttachment::Dropped { paths, .. }] if paths == &[PathBuf::from("/tmp/shot.png")]),
        "{:?}",
        attached.borrow()
    );
}

#[gpui::test]
fn deleting_an_image_chip_drops_its_image_and_renumbers_the_rest(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (_, attached, _subscriptions) = record(&composer, cx);
    composer.update_in(cx, |c, window, cx| {
        c.set_image_count(2, window, cx);
        c.set_text("a [Image #1] b [Image #2]", window, cx);
    });
    assert_eq!(chips(&composer, cx).len(), 2);
    composer.update_in(cx, |c, _, cx| {
        let state = c.input().unwrap().clone();
        state.update(cx, |state, cx| state.set_selected_range(12..12, cx));
    });
    cx.simulate_keystrokes("backspace");
    assert!(matches!(attached.borrow().as_slice(), [ComposerAttachment::ImageRemoved(1)]));
    assert_eq!(text(&composer, cx), "a  b [Image #1]");
    assert_eq!(chips(&composer, cx), [("[Image #1]".to_string(), "image".to_string())]);
}

/// Prompt string to editor to prompt string, every chip kind: what is set is what shows, what is sent is the same
/// string, and each chip covers its source exactly.
#[gpui::test]
fn every_chip_kind_round_trips_through_the_editor(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (sent, _, _subscriptions) = record(&composer, cx);
    let prompt = "Use /tldr on @src/app.rs and @\"docs/agents/ui.md\", ask @chat:12, run on @computer:Studio, see [Image #1]";
    composer.update_in(cx, |c, window, cx| {
        c.set_image_count(1, window, cx);
        c.set_text(prompt, window, cx);
    });
    assert_eq!(text(&composer, cx), prompt);
    let kinds: Vec<String> = chips(&composer, cx).into_iter().map(|(source, kind)| format!("{kind} {source}")).collect();
    assert_eq!(
        kinds,
        [
            "skill /tldr",
            "file @src/app.rs",
            "file @\"docs/agents/ui.md\"",
            "chat @chat:12",
            "computer @computer:Studio",
            "image [Image #1]"
        ]
    );
    for kind in ["skill", "file", "chat", "computer", "image"] {
        assert!(
            cx.debug_bounds(crate::testing::leak(format!(
                "prompt-chip-{kind}-{}",
                prompt
                    .find(match kind {
                        "skill" => "/tldr",
                        "file" => "@src",
                        "chat" => "@chat",
                        "computer" => "@computer",
                        _ => "[Image",
                    })
                    .unwrap()
            )))
            .is_some(),
            "the {kind} chip is drawn"
        );
    }
    // Copying a selection over chips copies their text.
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some(prompt));
    cx.simulate_keystrokes("cmd-right enter");
    assert_eq!(*sent.borrow(), [prompt]);
}

#[gpui::test]
fn the_prompt_box_grows_from_68_to_100_then_scrolls(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let height = |cx: &mut VisualTestContext| bounds(cx, "composer-input").size.height;
    assert_eq!(height(cx), px(68.0));
    assert!(cx.debug_bounds("composer-placeholder").is_some(), "the empty prompt shows the placeholder");
    assert!(bounds(cx, "composer").size.height >= px(COMPOSER_MIN_HEIGHT));
    cx.simulate_input("1");
    assert!(cx.debug_bounds("composer-placeholder").is_none());
    for (line, expected) in [(2, 68.0), (3, 76.0), (4, 96.0), (5, 100.0), (9, 100.0)] {
        while composer.read_with(cx, |c, _| c.text().lines().count()) < line {
            cx.simulate_keystrokes("shift-enter");
            cx.simulate_input("x");
        }
        assert_eq!(height(cx), px(expected), "{line} lines");
    }
}

#[gpui::test]
fn quotes_sit_over_the_prompt_and_go_first_in_the_message(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    let (sent, _, _subscriptions) = record(&composer, cx);
    composer.update(cx, |c, cx| c.add_quote("Name: Nora\n  URL", Some("Claude reply"), cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("composer-quote-0").is_some());
    cx.simulate_keystrokes("enter");
    assert_eq!(*sent.borrow(), ["> Name: Nora\n>   URL"], "quotes alone can be sent");
    composer.update(cx, |c, cx| c.add_quote("again", None, cx));
    cx.run_until_parked();
    let remove = bounds(cx, "composer-quote-0").top_right() + gpui::point(px(-14.0), px(16.0));
    cx.simulate_click(remove, Modifiers::none());
    assert!(composer.read_with(cx, |c, _| c.quotes().is_empty()), "the x removes the quote");
}

#[gpui::test]
fn tab_takes_the_suggestion_in_an_empty_prompt(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    composer.update(cx, |c, cx| c.set_suggestion(Some("Run the tests".into()), cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("composer-placeholder").is_some());
    cx.simulate_keystrokes("tab");
    assert_eq!(text(&composer, cx), "Run the tests");
}

/// What AppKit sends for a composition: marked text while it lasts (no chips, no menu, no undo step), then the
/// committed text, recorded as one typing step.
#[gpui::test]
fn ime_composition_is_one_step_and_chips_wait_for_the_commit(cx: &mut TestAppContext) {
    let (composer, cx) = mount(cx);
    cx.simulate_input("@src/app.rs ");
    cx.executor().advance_clock(Duration::from_secs(1));
    composer.update_in(cx, |c, window, cx| {
        c.replace_and_mark_text_in_range(None, "にほん", Some(0..3), window, cx);
        assert_eq!(c.text(), "@src/app.rs にほん");
        assert_eq!(c.marked_text_range(window, cx), Some(12..15), "UTF-16 units");
    });
    cx.run_until_parked();
    assert_eq!(composer.read_with(cx, |c, _| c.marked_range()), Some(12..21), "bytes");
    assert!(menu(&composer, cx).is_none());
    composer.update_in(cx, |c, window, cx| c.replace_text_in_range(None, "日本", window, cx));
    cx.run_until_parked();
    assert_eq!(text(&composer, cx), "@src/app.rs 日本");
    assert_eq!(composer.read_with(cx, |c, _| c.marked_range()), None);
    assert_eq!(chips(&composer, cx).len(), 1);
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&composer, cx), "@src/app.rs ", "the composition undoes as one step");
}
