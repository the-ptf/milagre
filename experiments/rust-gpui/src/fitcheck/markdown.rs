//! Fit check (a): gpui-component's rich text (`gpui_base::TextView` and its window-wide
//! `TextSelection`) against the transcript's markdown (`apps/desktop/app/src/components/markdown`).
//!
//! The test platform's text system has fixed advances, so these tests drag between element corners
//! and assert on the text the selection yields, never on glyph positions.

use std::sync::atomic::Ordering;

use gpui::{Bounds, Modifiers, MouseButton, Pixels, VisualTestContext, point, px};
use gpui_base::TextSelection;

use super::fixture::{DRAFT_ANSWER, FLAKY_ANSWER, LIST_ANSWER, MESSAGES, ROUTING};
use super::harness::{draw, mount};
use super::probes::{MessagesView, file_link_target};
use crate::testing::bounds;

fn drag(cx: &mut VisualTestContext, from: gpui::Point<Pixels>, to: gpui::Point<Pixels>) {
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    draw(cx);
}

fn inside_start(b: Bounds<Pixels>) -> gpui::Point<Pixels> {
    point(b.left() + px(1.0), b.top() + px(2.0))
}

fn inside_end(b: Bounds<Pixels>) -> gpui::Point<Pixels> {
    point(b.right() - px(1.0), b.bottom() - px(2.0))
}

fn selected(cx: &mut VisualTestContext) -> String {
    cx.update(TextSelection::selected_text)
}

fn mount_messages<'a>(
    cx: &'a mut gpui::TestAppContext,
    texts: &'static [&'static str],
) -> (gpui::Entity<MessagesView>, &'a mut VisualTestContext) {
    let (view, cx) = mount(cx, move |_, cx| MessagesView::new(texts, cx));
    // Parsing runs on a background task; let it land, then draw what it produced.
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

#[gpui::test]
fn drag_selects_across_paragraphs_lists_and_a_code_block(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount_messages(cx, &[DRAFT_ANSWER]);
    let message = bounds(cx, "message-0");
    drag(cx, inside_start(message), inside_end(message));
    let text = selected(cx);
    for expected in [
        "I found the cause",
        "Moved the draft into",
        "Restored the caret position",
        "export const useDraftStore",
        "return { drafts: rest };",
        "Switching between three Chats",
        "for why drafts are per Chat",
    ] {
        assert!(text.contains(expected), "selection lacks {expected:?}:\n{text}");
    }
    // Markdown markup is not in a plain selection.
    assert!(!text.contains("```"), "fences leaked into the plain selection:\n{text}");
    assert!(!text.contains("**remounted**"), "emphasis markers leaked:\n{text}");
}

#[gpui::test]
fn one_drag_selects_across_several_messages(cx: &mut gpui::TestAppContext) {
    static THREE: [&str; 3] = [DRAFT_ANSWER, FLAKY_ANSWER, LIST_ANSWER];
    let (_, cx) = mount_messages(cx, &THREE);
    let first = bounds(cx, "message-0");
    let third = bounds(cx, "message-2");
    drag(cx, inside_start(first), inside_end(third));
    let text = selected(cx);
    for expected in ["I found the cause", "The flaky test is", "Here's how the virtualized list", "or the old height stays"] {
        assert!(text.contains(expected), "cross-message selection lacks {expected:?}");
    }
    // Messages come out in document order.
    let a = text.find("I found the cause").unwrap();
    let b = text.find("The flaky test is").unwrap();
    let c = text.find("Here's how the virtualized list").unwrap();
    assert!(a < b && b < c, "messages out of order");
}

#[gpui::test]
fn cmd_c_copies_the_window_selection(cx: &mut gpui::TestAppContext) {
    static TWO: [&str; 2] = [DRAFT_ANSWER, FLAKY_ANSWER];
    let (_, cx) = mount_messages(cx, &TWO);
    let first = bounds(cx, "message-0");
    let second = bounds(cx, "message-1");
    drag(cx, inside_start(first), inside_end(second));
    let text = selected(cx);
    cx.simulate_keystrokes("cmd-c");
    let copied = cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default();
    assert_eq!(copied, text.trim(), "the clipboard holds the selection");
    assert!(copied.contains("I ran it 50 times"));
}

#[gpui::test]
fn file_link_chips_are_inline_elements_and_copy_as_their_code(cx: &mut gpui::TestAppContext) {
    static ONE: [&str; 1] = [ROUTING];
    let (_, cx) = mount_messages(cx, &ONE);
    let message = bounds(cx, "message-0");
    let chip = bounds(cx, "file-chip:apps/desktop/app/src/intro/Dawn.tsx");
    let second = bounds(cx, "file-chip:src/theme/colors.rs");
    assert!(message.contains(&chip.center()) && message.contains(&second.center()), "chips sit inside the message");
    assert!(chip.size.height > px(0.0) && chip.size.width > px(0.0));
    // `npm test` reads as a command, not a file: it stays inline code.
    assert!(cx.debug_bounds("file-chip:npm test").is_none());

    drag(cx, inside_start(message), inside_end(message));
    let text = selected(cx);
    assert!(text.contains("apps/desktop/app/src/intro/Dawn.tsx:42"), "a chip copies as its code text:\n{text}");
    assert!(text.contains("npm test"));
}

#[gpui::test]
fn fences_route_to_custom_block_renderers(cx: &mut gpui::TestAppContext) {
    static ONE: [&str; 1] = [ROUTING];
    let (_, cx) = mount_messages(cx, &ONE);
    let message = bounds(cx, "message-0");
    let mermaid = bounds(cx, "mermaid-block");
    let nested = bounds(cx, "nested-markdown");
    assert!(message.contains(&mermaid.center()) && message.contains(&nested.center()));
    assert!(mermaid.top() < nested.top(), "blocks keep source order");
}

#[gpui::test]
fn streaming_append_reparses_only_the_last_block(cx: &mut gpui::TestAppContext) {
    static ONE: [&str; 1] = [ROUTING];
    let (view, cx) = mount_messages(cx, &ONE);
    let (state, counter) = view.read_with(cx, |v, _| (v.message(0), v.fence_parses.clone()));
    let settled = counter.load(Ordering::SeqCst);
    assert!(settled >= 2, "the two fences were parsed once each at least ({settled})");

    // A streamed paragraph after the task list: the fences above are not parsed again.
    for chunk in ["\n\nThe timer ", "fallback ships ", "in this PR."] {
        state.update(cx, |state, cx| state.push_str(chunk, cx));
        cx.run_until_parked();
        draw(cx);
    }
    assert_eq!(counter.load(Ordering::SeqCst), settled, "an append re-parsed a fence it did not touch");
    let rendered = state.read_with(cx, |state, _| state.rendered_text().as_str().to_string());
    assert!(rendered.trim_end().ends_with("The timer fallback ships in this PR."), "appended text is rendered: {rendered:?}");

    // A fence that arrives in the stream is parsed (once its block is the last one, maybe more than once).
    state.update(cx, |state, cx| state.push_str("\n\n```mermaid\ngraph LR\n  A --> B\n```", cx));
    cx.run_until_parked();
    draw(cx);
    let after_fence = counter.load(Ordering::SeqCst);
    assert!(after_fence > settled);

    // A full replacement parses every fence again: the contrast with the appends above.
    state.update(cx, |state, cx| state.set_text(&format!("{ROUTING}\n\nReplaced."), cx));
    cx.run_until_parked();
    draw(cx);
    assert!(counter.load(Ordering::SeqCst) >= after_fence + 2, "a replacement re-parses every fence");
}

#[gpui::test]
fn selection_in_a_finished_message_survives_streaming_into_the_next(cx: &mut gpui::TestAppContext) {
    static TWO: [&str; 2] = [FLAKY_ANSWER, "Working on it"];
    let (view, cx) = mount_messages(cx, &TWO);
    let first = bounds(cx, "message-0");
    drag(cx, inside_start(first), inside_end(first));
    let before = selected(cx);
    assert!(before.contains("The flaky test is"));
    let streaming = view.read_with(cx, |v, _| v.message(1));
    for chunk in [", reading the logs", " now.\n\n- first finding"] {
        streaming.update(cx, |state, cx| state.push_str(chunk, cx));
        cx.run_until_parked();
        draw(cx);
    }
    assert_eq!(selected(cx), before, "streaming into another message changed the selection");
}

#[gpui::test]
fn a_link_click_reaches_milagres_handler(cx: &mut gpui::TestAppContext) {
    static ONE: [&str; 1] = ["[Open the design notes](https://milagre.cloud/design) to read why."];
    let (view, cx) = mount_messages(cx, &ONE);
    let message = bounds(cx, "message-0");
    let on_link = point(message.left() + px(6.0), message.top() + px(8.0));
    cx.simulate_click(on_link, Modifiers::none());
    draw(cx);
    let clicks = view.read_with(cx, |v, _| v.link_clicks.lock().expect("clicks").clone());
    assert_eq!(clicks, vec![gpui::SharedString::from("https://milagre.cloud/design")]);
}

#[gpui::test]
fn the_full_transcript_fixture_lays_out(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount_messages(cx, &MESSAGES);
    for ix in 0..MESSAGES.len() {
        let b = bounds(cx, crate::testing::leak(format!("message-{ix}")));
        assert!(b.size.height > px(18.0), "message {ix} has no height");
    }
}

#[test]
fn file_link_rule_matches_the_desktop() {
    assert_eq!(file_link_target("src/a.rs").map(|c| c.path.to_string()), Some("src/a.rs".into()));
    assert_eq!(file_link_target("intro/Dawn.tsx:42").and_then(|c| c.line), Some(42));
    assert!(file_link_target("npm test").is_none());
    assert!(file_link_target("console.log").is_none());
    assert!(file_link_target("../etc/passwd.txt").is_none());
    assert!(file_link_target("/abs/path.ts").is_none());
}

#[gpui::test]
fn a_drag_ends_where_the_pointer_stops(cx: &mut gpui::TestAppContext) {
    static THREE: [&str; 3] = [DRAFT_ANSWER, FLAKY_ANSWER, LIST_ANSWER];
    let (_, cx) = mount_messages(cx, &THREE);
    let first = bounds(cx, "message-0");
    let second = bounds(cx, "message-1");
    drag(cx, point(first.left() + px(1.0), first.top() + px(2.0)), inside_end(second));
    let text = selected(cx);
    assert!(text.contains("I found the cause") && text.contains("I ran it 50 times"));
    assert!(!text.contains("virtualized list"), "the third message was not dragged over:\n{text}");
}

/// The transcript is a virtualized `gpui::list`: messages outside the viewport are not laid out.
/// Drags `steps` wheel steps of 40px down while the button is held, then releases at the list's
/// bottom right, and returns the first and last message the selection holds.
fn drag_while_scrolling(steps: usize) -> (Option<usize>, Option<usize>) {
    const COUNT: usize = 30;
    let mut app = gpui::TestAppContext::single();
    let (_, cx) = mount(&mut app, |_, cx| ListMessages::new(COUNT, cx));
    cx.run_until_parked();
    draw(cx);
    let list = bounds(cx, "virtual-transcript");
    cx.simulate_mouse_down(point(list.left() + px(1.0), list.top() + px(2.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    for _ in 0..steps {
        cx.simulate_event(gpui::ScrollEvent {
            position: list.center(),
            delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(-40.0))),
            ..Default::default()
        });
        cx.run_until_parked();
        draw(cx);
    }
    let end = point(list.right() - px(2.0), list.bottom() - px(4.0));
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    draw(cx);
    let text = selected(cx);
    let has = |ix: &usize| text.contains(&format!("Message {ix} begins"));
    ((0..COUNT).find(has), (0..COUNT).rev().find(has))
}

#[gpui::test]
fn selection_across_list_items_holds_while_the_anchor_message_is_mounted(cx: &mut gpui::TestAppContext) {
    let _ = cx;
    let (first, still) = drag_while_scrolling(0);
    assert_eq!(first, Some(0));
    let (first, scrolled) = drag_while_scrolling(1);
    assert_eq!(first, Some(0), "the anchor message is still mounted after one wheel step");
    assert!(scrolled >= still && still >= Some(1), "the drag reaches the messages in view ({still:?}, {scrolled:?})");
}

/// GAP (WP-16): once the message the drag started in scrolls out of the list and unmounts, the
/// whole window selection is dropped, not just clipped. Each message is its own selection
/// participant and nothing keeps an unmounted one's endpoint. gpui-base has the hooks for it
/// (`TextSelectionContentKey`, `TextSelection::resolve_content_key_with`), but the transcript has to
/// wire them. If a gpui-component upgrade makes this test fail, the gap has closed.
#[gpui::test]
fn gap_selection_is_dropped_when_the_anchor_message_unmounts(cx: &mut gpui::TestAppContext) {
    let _ = cx;
    // 40 wheel steps of 40px: far past the first message, its 200px overdraw band and the 300px view.
    assert_eq!(drag_while_scrolling(40), (None, None));
    // Where it starts: the first step count at which the anchor's message has unmounted.
    let lost = (1..40).find(|steps| drag_while_scrolling(*steps).0.is_none());
    eprintln!("selection dropped from {lost:?} wheel steps");
    assert!(lost.is_some());
}

/// Messages as items of a `gpui::list` (what `workspace/chat/transcript.rs` uses), each a `TextView`.
struct ListMessages {
    messages: Vec<gpui::Entity<gpui_base::TextViewState>>,
    state: gpui::ListState,
}

impl ListMessages {
    fn new(count: usize, cx: &mut gpui::Context<Self>) -> Self {
        use gpui::AppContext as _;
        let messages = (0..count)
            .map(|ix| {
                let text = format!("Message {ix} begins. A line of filler text so the message wraps once or twice.\n\n- a list item in message {ix}\n\nMessage {ix} ends.");
                cx.new(|cx| gpui_base::TextViewState::markdown(&text, cx))
            })
            .collect();
        Self { messages, state: gpui::ListState::new(count, gpui::ListAlignment::Top, px(200.0)) }
    }
}

impl gpui::Render for ListMessages {
    fn render(&mut self, _: &mut gpui::Window, cx: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        use gpui::{InteractiveElement as _, IntoElement as _, ParentElement as _, Styled as _};
        let theme = *crate::theme::ActiveTheme::theme(&**cx);
        gpui::div().size_full().bg(theme.page).text_color(theme.ink).child(
            gpui::div().debug_selector(|| "virtual-transcript".into()).w(px(480.0)).h(px(300.0)).child(
                gpui::list(
                    self.state.clone(),
                    cx.processor(|this, ix: usize, _, _| {
                        gpui::div().pb_4().child(gpui_base::TextView::new(&this.messages[ix]).selectable(true)).into_any_element()
                    }),
                )
                .size_full(),
            ),
        )
    }
}
