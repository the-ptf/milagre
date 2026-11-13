//! Find in chat and quote selection (WP-28): `find-in-chat.test.ts`'s vectors, the search text against the source,
//! match counts and navigation on the fixture transcript, the bar's keys in the real Chat column, the Quote button,
//! and the measurements in README.md "Find in chat". The test platform's text has fixed advances: these assert on
//! counts, items and text, never on glyph positions.

use std::time::Instant;

use gpui::{
    Entity, Focusable as _, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Pixels, Point, TestAppContext, VisualTestContext, point,
    px,
};

use crate::testing;
use crate::ui::markdown::plain_text_source;
use crate::ui::selection::{Flavor, plain_text};
use crate::workspace::chat::ChatView;
use crate::workspace::chat::composer::Composer;
use crate::workspace::chat::find::{SearchText, clamp_match, find_label, match_offsets, step_match};
use crate::workspace::chat::fixture;
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

fn mount_chat(cx: &mut TestAppContext) -> (Entity<ChatView>, Entity<Transcript>, Entity<Composer>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat: Entity<ChatView> = workspace.read_with(cx, |workspace, _| workspace.chat.clone());
    let (transcript, composer) = chat.read_with(cx, |chat, _| (chat.transcript.clone(), chat.composer.clone()));
    draw(cx);
    (chat, transcript, composer, cx)
}

fn search(text: &str, query: &str) -> Vec<String> {
    let mut ranges = Vec::new();
    SearchText::new(text).find(&query.to_lowercase(), &mut ranges);
    ranges.into_iter().map(|range| text[range].to_string()).collect()
}

/// 2,000 user messages and answers, as the fixture writes them.
fn messages(count: usize) -> Vec<Item> {
    fixture::history(count * 4).into_iter().filter(|item| matches!(item, Item::User(_) | Item::Prose(_))).take(count).collect()
}

/// What a query counts, independently: each message as the desktop copies it, searched as one string per line.
fn expected_count(items: &[Item], query: &str) -> usize {
    items
        .iter()
        .filter_map(|item| match item {
            Item::User(text) => Some(text.to_string()),
            Item::Prose(prose) => Some(plain_text(&prose.text, 0..prose.text.len(), Flavor::Markdown).text),
            _ => None,
        })
        .map(|text| text.lines().map(|line| match_offsets(line, query).len()).sum::<usize>())
        .sum()
}

// ---- find-in-chat.test.ts ----

#[test]
fn matches_ignore_case_and_do_not_overlap() {
    assert_eq!(match_offsets("Foo foo FOO", "foo"), [0, 4, 8]);
    assert_eq!(match_offsets("aaaa", "aa"), [0, 2]);
}

#[test]
fn an_empty_query_or_no_occurrence_has_no_matches() {
    assert!(match_offsets("hello", "").is_empty());
    assert!(match_offsets("hello", "xyz").is_empty());
}

#[test]
fn offsets_stay_aligned_when_lowercasing_changes_the_length() {
    assert!(match_offsets("İstanbul", "stan").is_empty());
}

#[test]
fn stepping_wraps_in_both_directions() {
    assert_eq!(step_match(0, 3, 1), 1);
    assert_eq!(step_match(2, 3, 1), 0);
    assert_eq!(step_match(0, 3, -1), 2);
    assert_eq!(step_match(0, 0, 1), 0);
}

#[test]
fn the_active_match_is_clamped_when_matches_disappear() {
    assert_eq!(clamp_match(5, 3), 2);
    assert_eq!(clamp_match(1, 3), 1);
    assert_eq!(clamp_match(4, 0), 0);
}

#[test]
fn label_shows_position_no_results_or_nothing_without_a_query() {
    assert_eq!(find_label("", 0, 0), "");
    assert_eq!(find_label("x", 0, 0), "No results");
    assert_eq!(find_label("x", 2, 12), "3 of 12");
}

// ---- The search text ----

#[test]
fn a_block_reads_as_one_string_across_inline_markup() {
    let source = "A **bold** word and `inline code` here.";
    assert_eq!(search(source, "a bold word"), ["A **bold** word"], "the hit spans the markup, as the DOM walk joins it");
    assert_eq!(search(source, "inline code"), ["inline code"], "inline code maps inside its backticks");
    assert_eq!(search(source, "WORD"), ["word"], "case-insensitive");
}

#[test]
fn matches_never_cross_blocks() {
    let source = "First paragraph ends\n\nSecond starts here.\n\n- item one\n- item two\n\n| A | B |\n|---|---|\n| cell | next |";
    assert!(search(source, "ends second").is_empty(), "paragraphs are separate blocks");
    assert!(search(source, "one item").is_empty(), "list items are separate blocks");
    assert!(search(source, "cell next").is_empty(), "table cells are separate blocks");
    assert_eq!(search(source, "item"), ["item", "item"]);
    let blocks = SearchText::new(source).blocks();
    assert_eq!(blocks, ["first paragraph ends", "second starts here.", "item one", "item two", "a", "b", "cell", "next"]);
}

#[test]
fn code_blocks_links_and_escapes_map_back_to_their_source() {
    let source = "See [the docs](https://example.com/docs) now.\n\n```rust\nfn main() {}\n```\n\nA \\*literal\\* star &amp; more.";
    assert_eq!(search(source, "the docs"), ["the docs"], "a link's text, not its address");
    assert!(search(source, "example.com").is_empty(), "the address is not shown, so not found");
    assert_eq!(search(source, "fn main"), ["fn main"]);
    assert_eq!(search(source, "*literal*"), ["*literal\\*"], "an escaped character maps to its own byte, the match ends after the escape");
    assert_eq!(search(source, "star & more"), ["star &amp; more"], "an entity maps to its whole source");
}

#[test]
fn a_user_message_is_searched_as_typed() {
    let typed = "Fix *this* in src/app.rs\nthen   run `npm test`";
    let source = plain_text_source(typed);
    assert_eq!(search(&source, "*this*").len(), 1, "markdown characters a user typed are text");
    assert_eq!(search(&source, "app.rs\nthen").len(), 1, "a line break is a newline, as the bubble keeps it");
    assert_eq!(search(&source, "then   run").len(), 1, "runs of spaces stay");
}

// ---- The transcript ----

#[gpui::test]
fn match_counts_on_the_fixture_transcript(cx: &mut TestAppContext) {
    let items = fixture::transcript(2000);
    let (transcript, cx) = mount(cx, items.clone());
    for query in ["virtualized", "the", "useDraftStore", "zzzz-nothing"] {
        transcript.update(cx, |t, cx| t.set_find_query(query, cx));
        let total = transcript.read_with(cx, |t, _| t.find_status().map_or(0, |(_, total)| total));
        assert_eq!(total, expected_count(&items, query), "{query:?} counts every match in every message");
    }
    let label = transcript.read_with(cx, |t, _| t.find_label());
    assert_eq!(label, "No results");
}

#[gpui::test]
fn the_first_match_is_active_and_scrolled_into_view_even_far_up(cx: &mut TestAppContext) {
    let mut items = fixture::transcript(2000);
    items.insert(3, Item::Prose(Prose::new("An early answer that mentions the **needle** once.")));
    items.push(Item::Prose(Prose::new("The latest answer mentions the needle too.")));
    let (transcript, cx) = mount(cx, items);
    assert!(transcript.read_with(cx, |t, _| t.drawn_text(3)).is_none(), "the early answer starts off screen");

    transcript.update(cx, |t, cx| t.set_find_query("needle", cx));
    draw(cx);
    draw(cx);
    let (status, hits) = transcript.read_with(cx, |t, _| (t.find_status(), t.find_state().unwrap().hits.clone()));
    assert_eq!(status, Some((0, 2)), "1 of 2");
    assert_eq!(hits[0].item, 3, "the first match in the Chat is active, as the desktop's jump makes it");
    assert!(transcript.read_with(cx, |t, _| t.drawn_text(3)).is_some(), "its message was scrolled into the list");
    assert_eq!(transcript.read_with(cx, |t, _| t.find_highlighted()), vec![3], "and its match highlighted as it was drawn");

    transcript.update(cx, |t, cx| t.step_find(1, cx));
    draw(cx);
    draw(cx);
    let last = transcript.read_with(cx, |t, _| t.items().len() - 1);
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, 2)), "2 of 2");
    assert!(transcript.read_with(cx, |t, _| t.drawn_text(last)).is_some(), "the next match's message is on screen");
    transcript.update(cx, |t, cx| t.step_find(1, cx));
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((0, 2)), "and it wraps");
    transcript.update(cx, |t, cx| t.step_find(-1, cx));
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, 2)), "back wraps too");

    transcript.update(cx, |t, cx| t.close_find(cx));
    draw(cx);
    assert!(transcript.read_with(cx, |t, _| t.find_state().is_none() && t.find_highlighted().is_empty()));
}

#[gpui::test]
fn typing_in_the_field_parses_no_message(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx, fixture::transcript(2000));
    transcript.update(cx, |t, cx| t.set_find_query("v", cx));
    draw(cx);
    let (parses, built) = transcript.read_with(cx, |t, _| (t.parses(), t.search_texts_built()));
    for query in ["vi", "vir", "virt", "virtu", "virtual", "virtua", "virtualized"] {
        transcript.update(cx, |t, cx| t.set_find_query(query, cx));
    }
    draw(cx);
    let (parses_after, built_after) = transcript.read_with(cx, |t, _| (t.parses(), t.search_texts_built()));
    assert_eq!(built_after, built, "every message's search text was read once, on the first query");
    assert!(parses_after <= parses + 30, "only messages newly scrolled to are parsed for display ({parses} -> {parses_after})");
}

#[gpui::test]
fn a_streamed_answer_is_searched_again_and_the_active_match_stays(cx: &mut TestAppContext) {
    let items = vec![Item::Prose(Prose::new("One apple here.")), Item::Prose(Prose::new("Two apple there."))];
    let (transcript, cx) = mount(cx, items);
    transcript.update(cx, |t, cx| t.set_find_query("apple", cx));
    transcript.update(cx, |t, cx| t.step_find(1, cx));
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, 2)));
    let ix = transcript.update(cx, |t, cx| t.begin_stream(cx));
    transcript.update(cx, |t, cx| t.stream(ix, "A third apple arrives.\n\n", cx));
    cx.executor().advance_clock(STREAM_RENDER);
    draw(cx);
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, 3)), "the new match counts; the active one stays");
}

// ---- The bar in the Chat column ----

#[gpui::test]
fn command_f_opens_the_bar_and_escape_closes_it_back_to_the_composer(cx: &mut TestAppContext) {
    let (chat, transcript, composer, cx) = mount_chat(cx);
    cx.simulate_keystrokes("cmd-f");
    draw(cx);
    assert!(chat.read_with(cx, |c, _| c.find_open()), "⌘F from the composer opens the bar");
    assert!(cx.debug_bounds("find-bar").is_some());
    cx.simulate_input("virtualized");
    draw(cx);
    let expected = transcript.read_with(cx, |t, _| expected_count(t.items(), "virtualized"));
    assert!(expected > 1);
    assert_eq!(transcript.read_with(cx, |t, _| t.find_label()), format!("1 of {expected}"), "typing searches");
    cx.simulate_keystrokes("enter");
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, expected)), "Enter steps forward");
    cx.simulate_keystrokes("shift-enter");
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((0, expected)), "Shift+Enter back");
    cx.simulate_keystrokes("cmd-g");
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, expected)), "⌘G forward");
    cx.simulate_keystrokes("cmd-shift-g");
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((0, expected)), "⇧⌘G back");
    let next = cx.debug_bounds("find-next").expect("next button drawn");
    cx.simulate_click(next.center(), Modifiers::none());
    assert_eq!(transcript.read_with(cx, |t, _| t.find_status()), Some((1, expected)), "the arrow steps too");

    // ⌘F again keeps the bar and its query, focused and selected: typing replaces it.
    cx.simulate_keystrokes("cmd-f");
    cx.simulate_input("useDraftStore");
    draw(cx);
    let bar = chat.read_with(cx, |c, _| c.find_bar().cloned()).expect("bar still open");
    assert_eq!(bar.read_with(cx, |b, cx| b.query(cx)), "useDraftStore");

    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(!chat.read_with(cx, |c, _| c.find_open()), "Escape closes it");
    assert!(transcript.read_with(cx, |t, _| t.find_state().is_none()));
    let composer_focused = cx.update(|window, cx| composer.focus_handle(cx).contains_focused(window, cx));
    assert!(composer_focused, "focus goes back to the composer");
}

// ---- Quote selection ----

fn press(cx: &mut VisualTestContext, position: Point<Pixels>, click_count: usize) {
    cx.simulate_event(MouseDownEvent {
        button: MouseButton::Left,
        position,
        click_count,
        modifiers: Modifiers::none(),
        ..Default::default()
    });
    cx.simulate_event(MouseUpEvent { button: MouseButton::Left, position, click_count, modifiers: Modifiers::none() });
    draw(cx);
}

#[gpui::test]
fn a_selection_inside_one_answer_offers_quote_and_quote_fills_the_composer(cx: &mut TestAppContext) {
    let (chat, transcript, composer, cx) = mount_chat(cx);
    transcript.update(cx, |t, cx| {
        t.set_items(
            vec![Item::User("Look at the drafts".into()), Item::Prose(Prose::new("Alpha beta gamma delta.\n\nAnother paragraph."))],
            cx,
        )
    });
    draw(cx);
    draw(cx);
    let text = transcript.read_with(cx, |t, _| t.drawn_text(1)).expect("answer drawn");
    let at = point(text.left() + px(2.0), text.top() + px(4.0));
    press(cx, at, 1);
    press(cx, at, 2);
    draw(cx);
    let passage = chat.read_with(cx, |c, _| c.passage().cloned()).expect("a word selected in one answer offers a quote");
    assert_eq!((passage.item, passage.text.as_str(), passage.source.as_str()), (1, "Alpha", "Claude reply"));
    let button = cx.debug_bounds("quote-selection").expect("the Quote button shows");
    assert!(button.top() > at.y, "under the selection's end");

    cx.simulate_click(button.center(), Modifiers::none());
    draw(cx);
    let quotes = composer.read_with(cx, |c, _| c.quotes().to_vec());
    assert_eq!(quotes.len(), 1, "Quote adds a chip");
    assert_eq!((quotes[0].text.as_str(), quotes[0].source.as_deref()), ("Alpha", Some("Claude reply")), "its text is the selection");
    assert!(chat.read_with(cx, |c, _| c.passage().is_none()), "the button goes");
    assert!(cx.debug_bounds("quote-selection").is_none());
}

#[gpui::test]
fn a_selection_across_messages_offers_nothing_and_the_shortcut_quotes(cx: &mut TestAppContext) {
    let (chat, transcript, composer, cx) = mount_chat(cx);
    transcript.update(cx, |t, cx| {
        t.set_items(
            vec![Item::User("Look at the drafts".into()), Item::Prose(Prose::new("Alpha beta gamma delta.\n\nAnother paragraph."))],
            cx,
        )
    });
    draw(cx);
    draw(cx);
    let user = transcript.read_with(cx, |t, _| t.drawn_text(0)).expect("user message drawn");
    let answer = transcript.read_with(cx, |t, _| t.drawn_text(1)).expect("answer drawn");
    cx.simulate_mouse_down(point(user.left() + px(2.0), user.top() + px(4.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(point(answer.left() + px(40.0), answer.top() + px(4.0)), Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(point(answer.left() + px(40.0), answer.top() + px(4.0)), MouseButton::Left, Modifiers::none());
    draw(cx);
    assert!(chat.read_with(cx, |c, _| c.passage().is_none()), "a selection across messages offers nothing");

    // A word in the user's own message, quoted with ⇧⌘'.
    let at = point(user.left() + px(2.0), user.top() + px(4.0));
    press(cx, at, 1);
    press(cx, at, 2);
    let passage = chat.read_with(cx, |c, _| c.passage().cloned()).expect("a word in the user's message");
    assert_eq!((passage.text.as_str(), passage.source.as_str()), ("Look", "Your message"));
    cx.simulate_keystrokes("cmd-shift-'");
    draw(cx);
    let quotes = composer.read_with(cx, |c, _| c.quotes().to_vec());
    assert_eq!(quotes.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(), ["Look"], "the shortcut quotes it");
}

// ---- Measurements (README.md "Find in chat") ----

#[gpui::test]
fn measure_find_over_two_thousand_messages(cx: &mut TestAppContext) {
    let items = messages(2000);
    assert_eq!(items.len(), 2000);
    let bytes: usize = items
        .iter()
        .map(|item| match item {
            Item::User(text) => text.len(),
            Item::Prose(prose) => prose.text.len(),
            _ => 0,
        })
        .sum();
    let (transcript, cx) = mount(cx, items);
    let parses_before = transcript.read_with(cx, |t, _| t.parses());

    let started = Instant::now();
    transcript.update(cx, |t, cx| t.set_find_query("t", cx));
    let first = started.elapsed();
    let built = transcript.read_with(cx, |t, _| t.search_texts_built());

    let mut keystrokes = Vec::new();
    let mut counts = Vec::new();
    for query in ["th", "the", "the ", "the l", "the li", "the lis", "the list", "virtualized", "z"] {
        let started = Instant::now();
        transcript.update(cx, |t, cx| t.set_find_query(query, cx));
        keystrokes.push(started.elapsed().as_secs_f64() * 1000.0);
        counts.push((query, transcript.read_with(cx, |t, _| t.find_status().map_or(0, |(_, n)| n))));
    }
    let started = Instant::now();
    draw(cx);
    let frame = started.elapsed();
    let mut steps = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        transcript.update(cx, |t, cx| t.step_find(1, cx));
        draw(cx);
        steps.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let parses_after = transcript.read_with(cx, |t, _| t.parses());
    keystrokes.sort_by(f64::total_cmp);
    steps.sort_by(f64::total_cmp);
    let build = if cfg!(debug_assertions) { "debug" } else { "release" };
    eprintln!(
        "measure: find over 2,000 messages ({:.1} MB of source, {build} test build): first query {:.1} ms (reads {built} search texts), \
         a keystroke after it median {:.2} ms / max {:.2} ms, the frame after it {:.1} ms; a step to the next match and its frame \
         median {:.1} ms / max {:.1} ms; {} texts parsed for display meanwhile; counts {counts:?}",
        bytes as f64 / 1_000_000.0,
        first.as_secs_f64() * 1000.0,
        keystrokes[keystrokes.len() / 2],
        keystrokes[keystrokes.len() - 1],
        frame.as_secs_f64() * 1000.0,
        steps[steps.len() / 2],
        steps[steps.len() - 1],
        parses_after - parses_before,
    );
    assert_eq!(built, 2000);
}
