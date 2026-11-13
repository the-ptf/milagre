//! The transcript with the markdown view: selection across messages, the selection gap of a virtualized list, copy,
//! streaming, and the measurements in README.md "Markdown notes". Mounted under gpui-component's `Root`, as the app
//! mounts it (its selection layer handles the drag). The test platform's text has fixed advances: these assert on the
//! text a selection or copy yields and on counts, never on glyph positions. Times are wall-clock in a debug test
//! build, printed for the README, not asserted.

use std::time::Instant;

use gpui::{
    Entity, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Pixels, Point, ScrollDelta, ScrollEvent, TestAppContext,
    VisualTestContext, point, px, size,
};
use gpui_base::TextSelection;

use crate::testing;
use crate::ui::selection::{Flavor, Plain, join, plain_text};
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

/// The whole of each message as the desktop copies it, joined as its blocks join.
fn whole(items: &[Item]) -> String {
    join(items.iter().map(|item| match item {
        Item::User(text) => Plain::block(text.to_string()),
        Item::Prose(prose) => plain_text(&prose.text, 0..prose.text.len(), Flavor::Markdown),
        _ => Plain::default(),
    }))
}

fn press(cx: &mut VisualTestContext, position: Point<Pixels>, click_count: usize, modifiers: Modifiers) {
    cx.simulate_event(MouseDownEvent { button: MouseButton::Left, position, click_count, modifiers, ..Default::default() });
    cx.simulate_event(MouseUpEvent { button: MouseButton::Left, position, click_count, modifiers });
    draw(cx);
}

fn drag(cx: &mut VisualTestContext, from: Point<Pixels>, to: Point<Pixels>) {
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    draw(cx);
}

#[gpui::test]
fn a_drag_across_messages_copies_them_as_the_desktop_does(cx: &mut TestAppContext) {
    let items: Vec<Item> = LONG_ANSWERS[..3].iter().map(|text| Item::Prose(Prose::new(*text))).collect();
    let (transcript, cx) = mount(cx, items.clone());
    cx.simulate_resize(size(px(800.0), px(2400.0)));
    draw(cx);
    let first = text_bounds(cx, &transcript, 0);
    let last = text_bounds(cx, &transcript, 2);
    drag(cx, first.origin, last.bottom_right());

    let tracker = transcript.read_with(cx, |t, _| t.selection());
    assert_eq!((tracker.anchor, tracker.cursor), (Some(0), Some(2)), "the drag's ends are in items 0 and 2");
    let ours = transcript.update(cx, |t, cx| t.selected_text_between(0, 2, cx));
    assert_eq!(ours, whole(&items), "a drag over all three copies each one whole");
    for part in
        ["I found the cause", "useDraftStore", "ts\nexport const useDraftStore", "The flaky test is", "Here's how the virtualized list"]
    {
        assert!(ours.contains(part), "copy lacks {part:?}:\n{ours}");
    }
    assert_eq!(copied(cx), ours, "⌘C writes it");
}

/// A drag from the middle of one message to the middle of another copies the tail of the first, the head of the
/// last, and the paragraph break between them.
#[gpui::test]
fn a_partial_drag_copies_the_selected_part_of_each_end(cx: &mut TestAppContext) {
    let items = vec![
        Item::User("Please look at the list.".into()),
        Item::Prose(Prose::new("First paragraph here.\n\nSecond paragraph here.")),
        Item::Prose(Prose::new("Third message starts.\n\nFourth part.")),
    ];
    let (transcript, cx) = mount(cx, items);
    cx.simulate_resize(size(px(800.0), px(1200.0)));
    draw(cx);
    let a = text_bounds(cx, &transcript, 1);
    let b = text_bounds(cx, &transcript, 2);
    // From inside the first line of item 1 to the start of item 2's first line.
    drag(cx, point(a.left() + px(60.0), a.top() + px(4.0)), point(b.left() + px(40.0), b.top() + px(4.0)));
    let text = copied(cx);
    // The test platform's glyphs are 8 px wide: 60 px in is the eighth character of "First paragraph here.".
    assert_eq!(text, "aragraph here.\n\nSecond paragraph here.\n\nThird", "a blank line after each paragraph, as the desktop copies");
}

#[gpui::test]
fn double_click_selects_a_word_and_triple_click_its_paragraph(cx: &mut TestAppContext) {
    let items = vec![Item::Prose(Prose::new("Alpha beta gamma delta.\n\nAnother paragraph."))];
    let (transcript, cx) = mount(cx, items);
    let text = text_bounds(cx, &transcript, 0);
    let at = point(text.left() + px(2.0), text.top() + px(4.0));
    press(cx, at, 1, Modifiers::none());
    press(cx, at, 2, Modifiers::none());
    assert_eq!(copied(cx), "Alpha", "a double click selects the word under it");
    press(cx, at, 3, Modifiers::none());
    assert_eq!(copied(cx), "Alpha beta gamma delta.", "a triple click selects its paragraph");
}

#[gpui::test]
fn shift_click_extends_the_selection_into_another_message(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(6));
    let start = text_bounds(cx, &transcript, 1);
    let end = text_bounds(cx, &transcript, 4);
    press(cx, start.origin, 1, Modifiers::none());
    press(cx, end.bottom_right(), 1, Modifiers::shift());
    let tracker = transcript.read_with(cx, |t, _| t.selection());
    assert_eq!((tracker.anchor, tracker.cursor), (Some(1), Some(4)), "the anchor stays where the click was");
    let text = copied(cx);
    assert!(text.starts_with("Message 1 begins") && text.ends_with("Message 4 ends."), "copy spans items 1 to 4: {text:?}");
    // A second shift-click moves the end back; the anchor holds.
    let back = text_bounds(cx, &transcript, 2);
    press(cx, back.bottom_right(), 1, Modifiers::shift());
    let text = copied(cx);
    assert!(text.starts_with("Message 1 begins") && text.ends_with("Message 2 ends."), "the end moved back to item 2: {text:?}");
}

/// ⌘A selects every message, including the ones far off screen that were never laid out; ⌘C copies them all, and
/// the next press ends it.
#[gpui::test]
fn command_a_selects_the_whole_transcript(cx: &mut TestAppContext) {
    let items = answers(300);
    let (transcript, cx) = mount(cx, items.clone());
    let text = text_bounds(cx, &transcript, 299);
    press(cx, text.center(), 1, Modifiers::none());
    let parses = transcript.read_with(cx, |t, _| t.parses());
    cx.simulate_keystrokes("cmd-a");
    draw(cx);
    assert!(transcript.read_with(cx, |t, _| t.all_selected()));
    assert!(cx.update(TextSelection::has_selection), "the messages on screen show it");
    let all = copied(cx);
    assert_eq!(all, whole(&items));
    assert!(all.starts_with("Message 0 begins") && all.ends_with("Message 299 ends."));
    assert_eq!(transcript.read_with(cx, |t, _| t.parses()), parses, "copying 300 messages parses none for display");

    // Scrolling to messages never drawn: they come in selected.
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: px(0.0) });
        cx.notify();
    });
    draw(cx);
    let first = transcript.update(cx, |t, cx| t.text_view(0, cx)).expect("item 0 drawn");
    assert_eq!(first.read_with(cx, |state, _| state.selected_source_range()), Some(0..items_source_len(&items[0])));

    let at = text_bounds(cx, &transcript, 0).center();
    press(cx, at, 1, Modifiers::none());
    assert!(!transcript.read_with(cx, |t, _| t.all_selected()), "a press ends it");
    assert_eq!(first.read_with(cx, |state, _| state.selected_source_range()), None, "and clears the views it reached");
}

fn items_source_len(item: &Item) -> usize {
    match item {
        Item::Prose(prose) => prose.text.len(),
        _ => 0,
    }
}

#[gpui::test]
fn command_a_works_after_a_press_on_the_transcript_between_messages(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(5));
    let a = transcript.read_with(cx, |t, _| t.drawn_text(3)).unwrap();
    let b = transcript.read_with(cx, |t, _| t.drawn_text(4)).unwrap();
    // The gap between two messages: no text view there.
    press(cx, point(a.left() - px(8.0), (a.bottom() + b.top()) / 2.0), 1, Modifiers::none());
    cx.update(|window, cx| {
        let focused = transcript.read(cx).focus_handle().contains_focused(window, cx);
        assert!(focused, "the press moved focus into the transcript");
    });
    cx.simulate_keystrokes("cmd-a");
    draw(cx);
    assert!(transcript.read_with(cx, |t, _| t.all_selected()));
    assert!(copied(cx).ends_with("Message 4 ends."));
}

/// Dragging over messages on screen re-renders only the rows whose selection changed: the others are cached views
/// for the length of the drag, and no message is parsed again.
#[gpui::test]
fn a_drag_rebuilds_only_the_rows_it_changes(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(40));
    cx.simulate_resize(size(px(800.0), px(2400.0)));
    draw(cx);
    let (lo, hi) = transcript.read_with(cx, |t, _| {
        let drawn: Vec<usize> = (0..40).filter(|ix| t.drawn_text(*ix).is_some()).collect();
        (drawn[0], *drawn.last().unwrap())
    });
    assert!(hi - lo >= 12, "a screenful of messages ({lo}..={hi})");
    let start = text_bounds(cx, &transcript, lo + 1);
    cx.simulate_mouse_down(start.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    // The first frame of the drag mounts each row as a cached view.
    cx.simulate_mouse_move(start.center(), Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    let (renders, parses) = transcript.read_with(cx, |t, _| (t.item_renders(), t.parses()));
    let mut per_step = Vec::new();
    let mut last_renders = renders;
    for ix in lo + 2..hi - 1 {
        let to = text_bounds(cx, &transcript, ix).center();
        cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::none());
        draw(cx);
        let now = transcript.read_with(cx, |t, _| t.item_renders());
        per_step.push(now - last_renders);
        last_renders = now;
    }
    let end = text_bounds(cx, &transcript, hi - 2).bottom_right();
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    draw(cx);
    let (renders_after, parses_after) = transcript.read_with(cx, |t, _| (t.item_renders(), t.parses()));
    eprintln!("measure: drag across {} messages on screen: item builds per step {per_step:?}", per_step.len());
    assert_eq!(parses_after, parses, "a drag parses nothing");
    // gpui-base tells every participant inside the selection that it moved (its snapshot holds the ends), so a step
    // rebuilds the rows from the anchor to the pointer and none outside them.
    for (step, builds) in per_step.iter().enumerate() {
        assert!(*builds <= step + 3, "step {step} rebuilt {builds} rows, more than the {} the selection covers", step + 3);
    }
    assert!(renders_after > renders, "the rows the drag passed did render");
    let text = copied(cx);
    assert!(text.starts_with(&format!("Message {} begins", lo + 1)) && text.contains(&format!("Message {} begins", hi - 2)));
}

/// The frame times the README quotes: a drag that runs through 200 messages, with the pointer held while the list
/// scrolls under it (wheel steps), then the same over one screenful without scrolling.
#[gpui::test]
fn measure_dragging_across_two_hundred_messages(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, answers(200));
    cx.simulate_resize(size(px(800.0), px(600.0)));
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: px(0.0) });
        cx.notify();
    });
    draw(cx);
    let start = text_bounds(cx, &transcript, 0);
    let parses = transcript.read_with(cx, |t, _| t.parses());
    cx.simulate_mouse_down(start.origin, MouseButton::Left, Modifiers::none());
    draw(cx);
    let pointer = point(px(600.0), px(560.0));
    let mut frames = Vec::new();
    let mut steps = 0;
    let renders_before = transcript.read_with(cx, |t, _| t.item_renders());
    while transcript.read_with(cx, |t, _| t.selection().cursor) < Some(199) && steps < 2000 {
        let started = Instant::now();
        cx.simulate_event(ScrollEvent { position: pointer, delta: ScrollDelta::Pixels(point(px(0.0), px(-40.0))), ..Default::default() });
        cx.simulate_mouse_move(pointer, Some(MouseButton::Left), Modifiers::none());
        draw(cx);
        frames.push(started.elapsed().as_secs_f64() * 1000.0);
        steps += 1;
    }
    let scroll_renders = transcript.read_with(cx, |t, _| t.item_renders()) - renders_before;
    let scrolled = stats(&mut frames);
    // The same pointer, now moving over the screenful at the end without scrolling.
    let mut still = Vec::new();
    let renders_before = transcript.read_with(cx, |t, _| t.item_renders());
    let parses_before = transcript.read_with(cx, |t, _| t.parses());
    for step in 0..60 {
        let y = px(40.0) + px(8.0 * step as f32);
        let started = Instant::now();
        cx.simulate_mouse_move(point(px(400.0), y), Some(MouseButton::Left), Modifiers::none());
        draw(cx);
        still.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let still_renders = transcript.read_with(cx, |t, _| t.item_renders()) - renders_before;
    assert_eq!(transcript.read_with(cx, |t, _| t.parses()), parses_before, "moving over drawn messages parses nothing");
    let unscrolled = stats(&mut still);
    cx.simulate_mouse_up(point(px(400.0), px(500.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    let build = if cfg!(debug_assertions) { "debug" } else { "release" };
    eprintln!(
        "measure: drag through 200 messages, {steps} frames of 40 px: frame mean {:.2} ms, p95 {:.2} ms, max {:.2} ms; {scroll_renders} item builds ({build} test build)",
        scrolled.0, scrolled.1, scrolled.2
    );
    eprintln!(
        "measure: drag over one screenful, 60 frames without scrolling: frame mean {:.2} ms, p95 {:.2} ms, max {:.2} ms; {still_renders} item builds ({build} test build)",
        unscrolled.0, unscrolled.1, unscrolled.2
    );
    let parsed = transcript.read_with(cx, |t, _| t.parses()) - parses;
    eprintln!("measure: the drag parsed {parsed} messages, each the first time it came on screen");
    assert!(parsed <= 200, "each message parses at most once under the drag ({parsed})");
    let text = copied(cx);
    assert!(text.starts_with("Message 0 begins") && text.contains("Message 150 ends"), "the copy holds the whole run");
}

/// Mean, 95th percentile and max, in ms.
fn stats(frames: &mut [f64]) -> (f64, f64, f64) {
    frames.sort_by(f64::total_cmp);
    let mean = frames.iter().sum::<f64>() / frames.len().max(1) as f64;
    let p95 = frames.get(frames.len() * 95 / 100).copied().unwrap_or_default();
    (mean, p95, frames.last().copied().unwrap_or_default())
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

/// Hit testing at item level, the rule gpui-base uses to pick a participant: the text under the point (the smallest
/// when they nest), else the last one starting above it, else the first on screen.
#[test]
fn item_at_follows_gpui_base_participant_rule() {
    use crate::workspace::chat::transcript_selection::Painted;
    let b = |x: f32, y: f32, w: f32, h: f32| gpui::Bounds::new(point(px(x), px(y)), size(px(w), px(h)));
    let mut painted = Painted::default();
    painted.texts.insert(3, b(0.0, 100.0, 500.0, 80.0));
    painted.texts.insert(4, b(0.0, 200.0, 500.0, 80.0));
    painted.texts.insert(5, b(300.0, 210.0, 100.0, 20.0));
    assert_eq!(painted.item_at(point(px(10.0), px(120.0))), Some(3), "inside item 3's text");
    assert_eq!(painted.item_at(point(px(350.0), px(215.0))), Some(5), "the smaller of two that contain the point");
    assert_eq!(painted.item_at(point(px(10.0), px(190.0))), Some(3), "in the gap below item 3: the last one above");
    assert_eq!(painted.item_at(point(px(10.0), px(900.0))), Some(5), "below everything: the last one starting above");
    assert_eq!(painted.item_at(point(px(10.0), px(5.0))), Some(3), "above everything: the first on screen");
    assert_eq!(Painted::default().item_at(point(px(0.0), px(0.0))), None);
}

#[test]
fn the_tracker_spans_its_ends_in_order() {
    use crate::workspace::chat::transcript_selection::SelectionTracker;
    let tracker = SelectionTracker { anchor: Some(9), cursor: Some(4), ..Default::default() };
    assert_eq!(tracker.span(), Some((4, 9)));
    assert_eq!(tracker.ends().collect::<Vec<_>>(), vec![9, 4]);
    let one = SelectionTracker { anchor: Some(2), cursor: Some(2), ..Default::default() };
    assert_eq!(one.ends().collect::<Vec<_>>(), vec![2]);
    let pressed = SelectionTracker { dragging: true, ..Default::default() };
    assert!(!pressed.is_dragging(), "a press is not a drag until the pointer moves");
}
