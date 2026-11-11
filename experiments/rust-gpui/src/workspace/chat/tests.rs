//! Chat column tests in GPUI's headless test platform: the real workspace with the ~2,000-item
//! fixture, driven by simulated clicks and keystrokes.
//!
//! The test platform shapes text with a no-op text system (fixed advances), so these tests check
//! structure, state and geometry, not text metrics or timing.

use gpui::{ClipboardItem, Entity, EntityInputHandler as _, Focusable as _, Modifiers, TestAppContext, VisualTestContext, px};

use crate::testing::{self, leak};
use crate::workspace::chat::ChatView;
use crate::workspace::chat::composer::Composer;
use crate::workspace::chat::transcript::{ApprovalState, COLUMN_WIDTH, Item, Prose, Transcript};

fn mount(cx: &mut TestAppContext) -> (Entity<Transcript>, Entity<Composer>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat: Entity<ChatView> = workspace.read_with(cx, |workspace, _| workspace.chat.clone());
    let (transcript, composer) = chat.read_with(cx, |chat, _| (chat.transcript.clone(), chat.composer.clone()));
    (transcript, composer, cx)
}

#[gpui::test]
fn the_list_holds_about_two_thousand_items_and_opens_at_the_bottom(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    let (count, list_count, top, renders) = transcript.read_with(cx, |t, _| {
        (t.items().len(), t.list_state().item_count(), t.list_state().logical_scroll_top().item_ix, t.item_renders())
    });
    assert_eq!(count, 2000);
    assert_eq!(list_count, 2000, "ListState tracks every item");
    assert!(top > 1900, "opens scrolled to the bottom (top item {top})");
    assert!(cx.debug_bounds("running-row").is_some(), "the running row, the last item, is drawn");
    assert!(cx.debug_bounds("approval-allow-once").is_some(), "the waiting approval is on screen");
    assert!(cx.debug_bounds("transcript-item-0").is_none(), "the oldest item is not");
    eprintln!("item renders to open 2,000 items: {renders} (top item {top})");
    assert!(renders < 120, "only items in and around the viewport are laid out, got {renders}");
}

#[gpui::test]
fn items_sit_in_the_536px_column_with_the_composer(cx: &mut TestAppContext) {
    let (_, _, cx) = mount(cx);
    let composer = cx.debug_bounds("composer").expect("composer drawn");
    assert_eq!(composer.size.width, px(COLUMN_WIDTH));
    assert!(composer.size.height >= px(crate::workspace::chat::composer::COMPOSER_MIN_HEIGHT));
    let running = cx.debug_bounds("running-row").expect("running row drawn");
    assert_eq!(running.origin.x, composer.origin.x, "transcript column and composer share a left edge");
    let progress = cx.debug_bounds("pill-progress").expect("3/7 pill drawn");
    assert_eq!(progress.right(), composer.right(), "the 3/7 pill ends at the column's right edge");
    let subagents = cx.debug_bounds("pill-subagents").expect("subagents pill drawn");
    assert_eq!(subagents.origin.x, composer.origin.x);
    assert_eq!(progress.size.height, crate::theme::CONTROL_SM);
}

#[gpui::test]
fn allow_once_settles_the_approval(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    let allow = cx.debug_bounds("approval-allow-once").expect("Allow once drawn");
    assert_eq!(allow.size.height, crate::theme::CONTROL_SM);
    let waiting = cx.debug_bounds("approval-waiting").expect("the waiting row is drawn");
    cx.simulate_click(allow.center(), Modifiers::none());

    let state = transcript
        .read_with(cx, |t, _| t.items().iter().rev().find_map(|item| if let Item::Approval(a) = item { Some(a.state) } else { None }));
    assert_eq!(state, Some(ApprovalState::Allowed));
    // Debug bounds are per frame (GPUI 0.2.2 kept them forever; gpui-pre clears them each frame).
    assert!(cx.debug_bounds("approval-waiting").is_none(), "the waiting row and its buttons are gone");
    assert!(cx.debug_bounds("approval-allow-once").is_none());
    let resolved = cx.debug_bounds("approval-resolved").expect("the quiet Allowed line is drawn");
    assert_eq!(resolved.origin, waiting.origin, "it replaces the waiting row in place");
    assert_eq!(resolved.size.height, waiting.size.height);
}

#[gpui::test]
fn deny_settles_the_approval(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    let deny = cx.debug_bounds("approval-deny").expect("Deny drawn");
    cx.simulate_click(deny.center(), Modifiers::none());
    let state = transcript
        .read_with(cx, |t, _| t.items().iter().rev().find_map(|item| if let Item::Approval(a) = item { Some(a.state) } else { None }));
    assert_eq!(state, Some(ApprovalState::Denied));
}

#[gpui::test]
fn typing_then_enter_sends_a_user_message(cx: &mut TestAppContext) {
    let (transcript, composer, cx) = mount(cx);
    cx.update(|window, cx| assert!(composer.focus_handle(cx).is_focused(window), "the composer has focus when the Chat opens"));

    cx.simulate_input("Ship");
    cx.simulate_keystrokes("space");
    cx.simulate_input("it");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("now");
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "Ship it\nnow");

    let before = transcript.read_with(cx, |t, _| t.items().len());
    cx.simulate_keystrokes("enter");
    let (after, last) = transcript.read_with(cx, |t, _| (t.items().len(), t.items().last().cloned()));
    assert_eq!(after, before + 1);
    assert!(matches!(last, Some(Item::User(text)) if text.as_ref() == "Ship it\nnow"));
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "", "the input clears after sending");
    let last_selector = leak(format!("transcript-item-{}", after - 1));
    assert!(cx.debug_bounds(last_selector).is_some(), "the sent message is on screen");

    // Enter on an empty input sends nothing.
    cx.simulate_keystrokes("enter");
    assert_eq!(transcript.read_with(cx, |t, _| t.items().len()), after);
}

#[gpui::test]
fn sending_while_scrolled_up_jumps_to_the_bottom(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 100, offset_in_item: px(0.0) });
        cx.notify();
    });
    cx.run_until_parked();
    let top = transcript.read_with(cx, |t, _| t.list_state().logical_scroll_top().item_ix);
    assert!(top < 200, "scrolled away from the bottom (top item {top})");
    cx.simulate_input("hi");
    cx.simulate_keystrokes("enter");
    let (last, top) = transcript.read_with(cx, |t, _| (t.items().len() - 1, t.list_state().logical_scroll_top().item_ix));
    assert!(top > 1900, "back at the bottom (top item {top})");
    assert!(cx.debug_bounds(leak(format!("transcript-item-{last}"))).is_some(), "the new message is drawn");
}

#[gpui::test]
fn caret_keys_backspace_and_select_all(cx: &mut TestAppContext) {
    let (_, composer, cx) = mount(cx);
    let text = |cx: &mut VisualTestContext| composer.read_with(cx, |c, _| (c.text().to_string(), c.selected_range()));

    cx.simulate_input("abc");
    cx.simulate_keystrokes("left left");
    assert_eq!(text(cx), ("abc".into(), 1..1));
    cx.simulate_input("X");
    assert_eq!(text(cx), ("aXbc".into(), 2..2));
    cx.simulate_keystrokes("backspace");
    assert_eq!(text(cx), ("abc".into(), 1..1));
    cx.simulate_keystrokes("right right right");
    assert_eq!(text(cx).1, 3..3, "right stops at the end");
    cx.simulate_keystrokes("shift-left shift-left");
    assert_eq!(text(cx).1, 1..3);
    cx.simulate_keystrokes("backspace");
    assert_eq!(text(cx), ("a".into(), 1..1));
    cx.simulate_input("é");
    cx.simulate_keystrokes("backspace");
    assert_eq!(text(cx), ("a".into(), 1..1), "backspace removes a whole two-byte character");
    cx.simulate_keystrokes("cmd-a backspace");
    assert_eq!(text(cx), ("".into(), 0..0));
}

#[gpui::test]
fn up_and_down_move_between_lines(cx: &mut TestAppContext) {
    let (_, composer, cx) = mount(cx);
    cx.simulate_input("one");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("two");
    let caret = |cx: &mut VisualTestContext| composer.read_with(cx, |c, _| c.selected_range().start);
    assert_eq!(caret(cx), 7);
    cx.simulate_keystrokes("up");
    assert_eq!(caret(cx), 3, "up keeps the column: end of `one`");
    cx.simulate_keystrokes("down");
    assert_eq!(caret(cx), 7);
}

#[gpui::test]
fn paste_inserts_clipboard_text_with_newlines(cx: &mut TestAppContext) {
    let (_, composer, cx) = mount(cx);
    cx.write_to_clipboard(ClipboardItem::new_string("line one\r\nline two".into()));
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_string()), "line one\nline two");
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("line one\nline two"));
}

/// The sequence macOS sends for Option+E then A: `setMarkedText("´")`, then `insertText("á")`
/// replacing the marked range. Called on the entity directly, as `ElementInputHandler` does; the
/// test platform has no IME to drive it from a real key event.
#[gpui::test]
fn dead_key_composition_replaces_the_marked_text(cx: &mut TestAppContext) {
    let (_, composer, cx) = mount(cx);
    cx.simulate_input("s");
    cx.update(|window, cx| {
        composer.update(cx, |c, cx| {
            c.replace_and_mark_text_in_range(None, "´", None, window, cx);
            assert_eq!(c.text(), "s´");
            assert_eq!(c.marked_text_range(window, cx), Some(1..2), "marked range is in UTF-16 units");
            c.replace_text_in_range(None, "á", window, cx);
        })
    });
    assert_eq!(composer.read_with(cx, |c, _| (c.text().to_string(), c.marked_range(), c.selected_range())), ("sá".into(), None, 3..3));
}

#[gpui::test]
fn typing_does_not_re_render_the_transcript(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    // The first key press switches GPUI's input modality from mouse to keyboard, which refreshes
    // the whole window once (see `modality_switches_redraw_every_view_once`). Count after it.
    cx.simulate_input("h");
    let before = transcript.read_with(cx, |t, _| t.item_renders());
    cx.simulate_input("ello");
    let after_typing = transcript.read_with(cx, |t, _| t.item_renders());
    assert_eq!(after_typing, before, "the transcript is a cached view; keystrokes reuse its last frame");

    let appended = Prose::new("One more **answer** with `code`.");
    transcript.update(cx, |t, cx| t.push(Item::Prose(appended), cx));
    cx.run_until_parked();
    let after_append = transcript.read_with(cx, |t, _| t.item_renders());
    eprintln!("item renders: typing 4 keys {}, appending one item {}", after_typing - before, after_append - after_typing);
    assert!(after_append > after_typing, "the append is laid out");
    assert!(after_append - after_typing < 120, "an append re-lays only what is in view");
}

#[gpui::test]
fn activity_marks_take_their_width(cx: &mut TestAppContext) {
    let (_, _, cx) = mount(cx);
    let marks = cx.debug_bounds("activity-marks").expect("an activity row is drawn");
    assert_eq!(marks.size.width, px(20.0 + 14.0 + 14.0), "three 20px marks overlapping by 6px");
}

#[gpui::test]
fn clicking_a_link_in_prose_opens_it(cx: &mut TestAppContext) {
    let items = vec![Item::Prose(Prose::new("[Open the docs](https://milagre.cloud/docs) for the list API."))];
    let (_, cx) = testing::mount_in_root(cx, |_, cx| Transcript::with_items(items, cx));
    let item = cx.debug_bounds("transcript-item-0").expect("the one item is drawn");
    // The column is centred in the item; the link is the paragraph's first words, below the 8px gap.
    let column_left = item.center().x - px(COLUMN_WIDTH / 2.0);
    let line_y = item.origin.y + px(8.0 + 10.0);
    cx.simulate_click(gpui::point(column_left + px(400.0), line_y), Modifiers::none());
    assert_eq!(cx.opened_url(), None, "a click past the link opens nothing");
    cx.simulate_click(gpui::point(column_left + px(12.0), line_y), Modifiers::none());
    assert_eq!(cx.opened_url().as_deref(), Some("https://milagre.cloud/docs"));
}

#[gpui::test]
fn clicking_in_the_input_places_the_caret(cx: &mut TestAppContext) {
    let (_, composer, cx) = mount(cx);
    cx.simulate_input("hello");
    assert_eq!(composer.read_with(cx, |c, _| c.selected_range()), 5..5);
    let input = cx.debug_bounds("composer-input").expect("input drawn");
    // 14px left padding, 12px top padding: the first character's left edge.
    cx.simulate_click(gpui::point(input.origin.x + px(14.0), input.origin.y + px(20.0)), Modifiers::none());
    assert_eq!(composer.read_with(cx, |c, _| c.selected_range()), 0..0);
}

/// GPUI behaviour worth knowing (gpui-pre 0.3.12, `Window::dispatch_event`): when input switches
/// between mouse and keyboard, the window refreshes, and a refresh lays out every view again, cached
/// or not (it exists for focus-visible styling). So the first key after using the mouse, and the
/// first mouse move after typing, each rebuild the visible transcript once. Steady typing does not.
#[gpui::test]
fn modality_switches_redraw_every_view_once(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    let renders = |cx: &mut VisualTestContext| transcript.read_with(cx, |t, _| t.item_renders());
    let mounted = renders(cx);
    cx.simulate_input("a");
    let first_key = renders(cx);
    assert!(first_key > mounted, "the first key after the mouse refreshes the window");
    cx.simulate_input("b");
    assert_eq!(renders(cx), first_key, "the next key does not");
    cx.simulate_mouse_move(gpui::point(px(700.0), px(30.0)), None, Modifiers::none());
    assert!(renders(cx) > first_key, "the first mouse move after typing refreshes it again");
}

/// The running row follows the last item: pinned to the bottom it sits under it, and scrolled up it moves with the
/// content instead of floating over the messages (it was a view over the list's bottom edge).
#[gpui::test]
fn the_running_row_scrolls_with_the_content_and_never_overlaps_an_item(cx: &mut TestAppContext) {
    let (transcript, _, cx) = mount(cx);
    let visible_items = |cx: &mut VisualTestContext, transcript: &Entity<Transcript>| {
        let count = transcript.read_with(cx, |t, _| t.items().len());
        (count.saturating_sub(60)..count).filter_map(|ix| cx.debug_bounds(leak(format!("transcript-item-{ix}")))).collect::<Vec<_>>()
    };
    let last = transcript.read_with(cx, |t, _| t.items().len() - 1);
    let pinned = cx.debug_bounds("running-row").expect("running row drawn");
    let last_item = cx.debug_bounds(leak(format!("transcript-item-{last}"))).expect("last item drawn");
    assert!(pinned.top() >= last_item.bottom(), "pinned, the row sits after the last item ({:?} vs {:?})", pinned, last_item);

    let wheel = gpui::point(px(700.0), px(300.0));
    let mut shown = 0;
    for step in [60.0_f32, 140.0, 400.0, 1500.0] {
        // A wheel step up the way a trackpad delivers it: it moves the list and re-renders the transcript.
        cx.simulate_event(gpui::ScrollEvent {
            position: wheel,
            delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.0), px(step))),
            ..Default::default()
        });
        cx.run_until_parked();
        let items = visible_items(cx, &transcript);
        if let Some(row) = cx.debug_bounds("running-row") {
            shown += 1;
            for item in &items {
                assert!(!row.intersects(item), "scrolled up {step}: running row {row:?} overlaps item {item:?}");
            }
            assert!(row.top() > pinned.top(), "scrolled up, the row moved down with the content");
        }
    }
    assert!(shown > 0, "the row is still drawn for the first scroll steps");
}
