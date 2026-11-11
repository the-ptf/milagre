//! The transcript with the markdown view: selection across messages, the selection gap of a virtualized list, copy,
//! streaming, and the measurements in README.md "Markdown notes". Mounted under gpui-component's `Root`, as the app
//! mounts it (its selection layer handles the drag). The test platform's text has fixed advances: these assert on the
//! text a selection or copy yields and on counts, never on glyph positions. Times are wall-clock in a debug test
//! build, printed for the README, not asserted.

use std::time::Instant;

use gpui::{Entity, Modifiers, MouseButton, ScrollDelta, ScrollEvent, TestAppContext, VisualTestContext, point, px, size};
use gpui_base::TextSelection;

use crate::testing;
use crate::workspace::chat::fixture::{self, LONG_ANSWERS};
use crate::workspace::chat::transcript::{Item, Prose, STREAM_RENDER, Transcript};

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn mount(cx: &mut TestAppContext, items: Vec<Item>) -> (Entity<Transcript>, &mut VisualTestContext) {
    let (transcript, cx) = testing::mount_in_root(cx, move |_, cx| Transcript::with_items(items, cx));
    draw(cx);
    (transcript, cx)
}

fn answers(count: usize) -> Vec<Item> {
    (0..count)
        .map(|ix| {
            Item::Prose(Prose::new(format!(
                "Message {ix} begins. A line of filler text so the message wraps once or twice in the column.\n\n- a list item in message {ix}\n\nMessage {ix} ends."
            )))
        })
        .collect()
}

fn copied(cx: &mut VisualTestContext) -> String {
    cx.simulate_keystrokes("cmd-c");
    cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default()
}

/// Item `ix`'s text, inset so a press lands on its first line and a release on its last.
fn text_bounds(cx: &mut VisualTestContext, transcript: &Entity<Transcript>, ix: usize) -> gpui::Bounds<gpui::Pixels> {
    let text = transcript.read_with(cx, |t, _| t.drawn_text(ix)).unwrap_or_else(|| panic!("item {ix} is not drawn"));
    gpui::Bounds::from_corners(point(text.left() + px(1.0), text.top() + px(2.0)), point(text.right() - px(1.0), text.bottom() - px(2.0)))
}

#[gpui::test]
fn a_drag_across_messages_copies_what_gpui_base_selects(cx: &mut TestAppContext) {
    let items = LONG_ANSWERS[..3].iter().map(|text| Item::Prose(Prose::new(*text))).collect();
    let (transcript, cx) = mount(cx, items);
    cx.simulate_resize(size(px(800.0), px(2400.0)));
    draw(cx);
    let first = text_bounds(cx, &transcript, 0);
    let last = text_bounds(cx, &transcript, 2);
    cx.simulate_mouse_down(first.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(last.bottom_right(), Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(last.bottom_right(), MouseButton::Left, Modifiers::none());
    draw(cx);

    let tracker = transcript.read_with(cx, |t, _| t.selection());
    assert_eq!((tracker.anchor, tracker.cursor), (Some(0), Some(2)), "the drag's ends are in items 0 and 2");
    let base = cx.update(TextSelection::selected_text);
    let ours = transcript.update(cx, |t, cx| t.selected_text_between(0, 2, cx));
    assert_eq!(ours.trim(), base.trim(), "with every item mounted, the transcript copies what gpui-base selects");
    for part in ["I found the cause", "useDraftStore", "export const useDraftStore", "The flaky test is", "Here's how the virtualized list"]
    {
        assert!(ours.contains(part), "copy lacks {part:?}:\n{ours}");
    }
    assert_eq!(copied(cx), base.trim(), "⌘C writes it");
}

/// The gap (`fitcheck::markdown::gap_selection_is_dropped_when_the_anchor_message_unmounts`), closed: the item the
/// drag began in scrolls out and unmounts, and the selection stands; copy holds every message it covers.
#[gpui::test]
fn the_selection_holds_when_the_message_it_began_in_scrolls_away(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(80));
    cx.simulate_resize(size(px(800.0), px(400.0)));
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: px(0.0) });
        cx.notify();
    });
    draw(cx);
    let start = text_bounds(cx, &transcript, 0);
    let list = gpui::Bounds::from_corners(point(px(0.0), px(0.0)), point(px(800.0), px(400.0)));
    let renders_before = transcript.read_with(cx, |t, _| t.item_renders());
    let started = Instant::now();
    cx.simulate_mouse_down(start.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    // Wheel steps with the button held, until 50 items have gone by.
    let mut steps = 0;
    while transcript.read_with(cx, |t, _| t.list_state().logical_scroll_top().item_ix) < 50 && steps < 400 {
        cx.simulate_event(ScrollEvent {
            position: list.center(),
            delta: ScrollDelta::Pixels(point(px(0.0), px(-40.0))),
            ..Default::default()
        });
        draw(cx);
        steps += 1;
    }
    let end = point(px(780.0), px(380.0));
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    draw(cx);
    let elapsed = started.elapsed();
    let renders = transcript.read_with(cx, |t, _| t.item_renders()) - renders_before;
    let (tracker, top) = transcript.read_with(cx, |t, _| (t.selection(), t.list_state().logical_scroll_top().item_ix));
    eprintln!(
        "measure: drag over {top} items ({steps} wheel steps of 40 px): {renders} item renders, {:.0} ms ({} test build)",
        elapsed.as_secs_f64() * 1000.0,
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    assert!(top >= 50, "the drag went past 50 items (top item {top})");
    assert!(cx.debug_bounds("transcript-item-0").is_none(), "the first item has left the list");
    assert!(cx.debug_bounds("kept-item-0").is_some(), "the keeper draws it off screen");
    assert_eq!(tracker.anchor, Some(0));
    assert!(cx.update(TextSelection::has_selection), "the selection is still there");

    let text = copied(cx);
    assert!(text.starts_with("Message 0 begins"), "copy starts where the drag did:\n{}", &text[..text.len().min(200)]);
    for ix in [1, 25, 49] {
        assert!(text.contains(&format!("Message {ix} begins")) && text.contains(&format!("Message {ix} ends")), "copy lacks message {ix}");
    }
    let cursor = tracker.cursor.expect("a cursor end");
    assert!(cursor >= top && text.contains(&format!("Message {cursor} begins")), "copy reaches the end item {cursor}");
    assert!(!text.contains(&format!("Message {} begins", cursor + 1)), "and stops there");

    // Scrolling the start back into view finds it highlighted where it was: the end kept its offset.
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: px(0.0) });
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("transcript-item-0").is_some() && cx.debug_bounds("kept-item-0").is_none());
    assert_eq!(copied(cx), text, "the same selection, now that its start is mounted again");
}

#[gpui::test]
fn a_finished_selection_survives_scrolling_far_away(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(300));
    let last = text_bounds(cx, &transcript, 299);
    let before = text_bounds(cx, &transcript, 298);
    cx.simulate_mouse_down(before.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(last.bottom_right(), Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(last.bottom_right(), MouseButton::Left, Modifiers::none());
    draw(cx);
    let selected = copied(cx);
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 10, offset_in_item: px(0.0) });
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("kept-item-298").is_some() && cx.debug_bounds("kept-item-299").is_some(), "both ends kept below");
    assert!(cx.update(TextSelection::has_selection));
    assert_eq!(copied(cx), selected);
    assert!(selected.contains("Message 298 begins") && selected.contains("Message 299 ends"));
}

#[gpui::test]
fn a_click_elsewhere_ends_the_selection_and_frees_the_kept_items(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(40));
    let a = text_bounds(cx, &transcript, 37);
    let b = text_bounds(cx, &transcript, 39);
    cx.simulate_mouse_down(a.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(b.bottom_right(), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(b.bottom_right(), MouseButton::Left, Modifiers::none());
    draw(cx);
    assert!(cx.update(TextSelection::has_selection));
    cx.simulate_click(point(px(5000.0), px(5000.0)), Modifiers::none());
    draw(cx);
    assert_eq!(transcript.read_with(cx, |t, _| t.selection().anchor), None, "a press outside the transcript resets the ends");
}

/// Streaming: finished blocks append once; only the block being written is parsed again, with its open bold closed.
#[gpui::test]
fn streaming_parses_only_the_block_being_written(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, fixture::transcript(2000));
    let ix = transcript.update(cx, |t, cx| t.begin_stream(cx));
    let text = LONG_ANSWERS[4];
    let mut sent = 0;
    for chunk in text.as_bytes().chunks(37) {
        let chunk = std::str::from_utf8(chunk).expect("ascii fixture");
        transcript.update(cx, |t, cx| t.stream(ix, chunk, cx));
        sent += chunk.len();
        cx.executor().advance_clock(STREAM_RENDER);
        draw(cx);
    }
    assert_eq!(sent, text.len());
    // One more batch, measured: what it parses and builds.
    let (parses, renders) = transcript.read_with(cx, |t, _| (t.parses(), t.item_renders()));
    cx.executor().advance_clock(STREAM_RENDER);
    let started = Instant::now();
    transcript.update(cx, |t, cx| t.stream(ix, "\n\nOne more **paragraph", cx));
    draw(cx);
    let elapsed = started.elapsed();
    let (parses_after, renders_after, prose) = transcript.read_with(cx, |t, _| (t.parses(), t.item_renders(), t.items()[ix].clone()));
    eprintln!(
        "measure: one streamed append into a {}-char answer: {} text parsed, {} item renders, {:.2} ms ({} test build)",
        text.len(),
        parses_after - parses,
        renders_after - renders,
        elapsed.as_secs_f64() * 1000.0,
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    assert_eq!(parses_after - parses, 2, "the finished block appends to the message, the open block is set again");
    assert!(renders_after - renders < 40, "only items in view are laid out again");
    let Item::Prose(prose) = prose else { panic!("the stream is prose") };
    assert!(prose.streaming && prose.text.ends_with("One more **paragraph"));
    let live = transcript.update(cx, |t, cx| t.text_view(ix, cx)).expect("a view");
    let shown = live.read_with(cx, |state, _| state.rendered_text().as_str().to_string());
    assert!(shown.contains("See the compositor notes"), "the finished blocks are in the message's view");

    transcript.update(cx, |t, cx| t.finish_stream(ix, cx));
    draw(cx);
    let done = live.read_with(cx, |state, _| state.rendered_text().as_str().to_string());
    // Finished, the text renders as written: the bold that never closed shows its marker, as in the desktop.
    assert!(done.trim_end().ends_with("One more **paragraph"), "the whole text as written: {done:?}");
}

#[gpui::test]
fn opening_two_thousand_items_parses_only_what_is_drawn(cx: &mut TestAppContext) {
    let started = Instant::now();
    let (transcript, cx) = mount(cx, fixture::transcript(2000));
    let elapsed = started.elapsed();
    let (renders, parses, views) = transcript.read_with(cx, |t, _| (t.item_renders(), t.parses(), t.live_views()));
    eprintln!(
        "measure: open 2,000 items: {renders} item renders, {parses} texts parsed, {views} text views, {:.0} ms to the first frame ({} test build)",
        elapsed.as_secs_f64() * 1000.0,
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    assert!(renders < 120 && parses < 120, "only items in and around the viewport are built ({renders}, {parses})");
    // Far history scrolled through: views stay bounded.
    for top in [1500, 1000, 500, 0] {
        transcript.update(cx, |t, cx| {
            t.list_state().scroll_to(gpui::ListOffset { item_ix: top, offset_in_item: px(0.0) });
            cx.notify();
        });
        draw(cx);
    }
    let views = transcript.read_with(cx, |t, _| t.live_views());
    assert!(views < 400, "text views far from the viewport are dropped ({views})");
}
