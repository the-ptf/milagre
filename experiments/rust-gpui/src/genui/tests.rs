//! `packages/shared/src/genui.test.ts` and the parser's behaviour, then the blocks drawn in a markdown view.

use std::sync::{Arc, Mutex};

use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, ParentElement as _, Render, Styled as _, TestAppContext, VisualTestContext,
    Window, div, px,
};
use gpui_base::TextViewState;

use super::contract::*;
use super::lang::{self, Tok};
use crate::testing;
use crate::ui::markdown::{FenceHooks, Markdown, extensions_with, open_with_system, text_view_style};

const EXAMPLE: &str = r##"root = Stack([title, summary, prs, actions])
title = Heading("Three PRs are waiting on you")
summary = KeyValue([["Open", "3"], ["Failing CI", "1"], ["Oldest", "4 days"]])
prs = Table(["PR", "Author", "CI"], [["#403 Worktree link line", "victor", "green"], ["#390 Sidebar Links", "victor", "red"]])
actions = Stack([approve, later], "row")
approve = Button("Merge the green ones", Action([@ToAssistant("Merge the PRs whose CI is green")]))
later = Button("Later", Action([@ToAssistant("Not now")]), "secondary")"##;

fn root(code: &str) -> Option<Node> {
    parse_block(code).root
}

fn children(node: &Node) -> &[Node] {
    match node {
        Node::Stack { children, .. } => children,
        other => panic!("not a stack: {other:?}"),
    }
}

#[test]
fn the_skills_example_parses_to_its_tree() {
    let block = parse_block(EXAMPLE);
    assert!(!block.incomplete);
    let tree = block.root.expect("a root");
    let parts = children(&tree);
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], Node::Heading { text: "Three PRs are waiting on you".into(), level: 2 });
    assert_eq!(
        parts[1],
        Node::KeyValue { pairs: vec![("Open".into(), "3".into()), ("Failing CI".into(), "1".into()), ("Oldest".into(), "4 days".into())] }
    );
    assert!(matches!(&parts[2], Node::Table { columns, rows } if columns.len() == 3 && rows.len() == 2));
    let Node::Stack { children: buttons, direction, gap } = &parts[3] else { panic!("actions") };
    assert_eq!((*direction, *gap), (Direction::Row, Gap::M));
    assert_eq!(
        buttons[0],
        Node::Button {
            label: "Merge the green ones".into(),
            action: Action { messages: vec!["Merge the PRs whose CI is green".into()] },
            variant: ButtonVariant::Primary
        }
    );
    assert!(matches!(&buttons[1], Node::Button { variant: ButtonVariant::Secondary, .. }));
}

#[test]
fn the_other_example_has_every_remaining_component() {
    let tree = root(
        r#"root = Stack([title, description, note, progress, bars, trend])
title = Heading("Checks this week")
description = Text("Twelve checks passed today.", "muted")
note = Callout("Two checks still need a review.", "warning", "Pending")
progress = Progress("Verified", 0.85)
bars = BarChart(["Mon", "Tue", "Wed"], [4, 7, 12], "Passing checks")
trend = LineChart(["Mon", "Tue", "Wed"], [3, 2, 1], "Failing checks")"#,
    )
    .expect("a root");
    let parts = children(&tree);
    assert_eq!(parts[1], Node::Text { text: "Twelve checks passed today.".into(), tone: TextTone::Muted });
    assert_eq!(
        parts[2],
        Node::Callout { body: "Two checks still need a review.".into(), tone: CalloutTone::Warning, title: Some("Pending".into()) }
    );
    assert_eq!(parts[3], Node::Progress { label: "Verified".into(), value: 0.85 });
    assert!(matches!(&parts[4], Node::BarChart { values, .. } if values == &[4.0, 7.0, 12.0]));
    assert!(matches!(&parts[5], Node::LineChart { title: Some(title), .. } if title == "Failing checks"));
}

#[test]
fn rows_are_cut_or_padded_to_the_columns_and_cells_become_strings() {
    let tree = root("root = Stack([Table([\"A\", \"B\"], [[4], [\"a\", \"b\", \"c\"], [0.5, null]])])").expect("a root");
    assert_eq!(
        children(&tree)[0],
        Node::Table {
            columns: vec!["A".into(), "B".into()],
            rows: vec![vec!["4".into(), "".into()], vec!["a".into(), "b".into()], vec!["0.5".into(), "".into()]]
        }
    );
}

#[test]
fn a_block_over_any_cap_has_no_root() {
    let rows: Vec<String> = (0..201).map(|_| "[\"x\"]".to_string()).collect();
    let columns: Vec<String> = (0..13).map(|i| format!("\"c{i}\"")).collect();
    let points: Vec<String> = (0..101).map(|_| "1".to_string()).collect();
    for expr in [
        format!("Table([\"A\"], [{}])", rows.join(",")),
        format!("Table([{}], [])", columns.join(",")),
        format!("BarChart([], [{}])", points.join(",")),
        format!("Table([\"A\"], [[{}]])", (0..13).map(|_| "\"x\"").collect::<Vec<_>>().join(",")),
        format!("Text(\"{}\")", "x".repeat(4001)),
        format!("Heading(\"{}\")", "x".repeat(201)),
    ] {
        assert_eq!(root(&format!("root = Stack([{expr}])")), None, "{}", &expr[..expr.len().min(40)]);
    }
    // Exactly at the caps is fine.
    let at_cap: Vec<String> = (0..200).map(|_| "[\"x\"]".to_string()).collect();
    assert!(root(&format!("root = Stack([Table([\"A\"], [{}])])", at_cap.join(","))).is_some());
}

#[test]
fn the_text_cap_counts_utf8_bytes() {
    assert!(!text_over_limit(&"é".repeat(32768)));
    assert!(text_over_limit(&"é".repeat(32769)));
    assert!(text_over_limit(&"😀".repeat(16385)));
    assert_eq!(root(&format!("root = Stack([Text(\"{}\")])", "😀".repeat(16385))), None);
}

#[test]
fn only_assistant_steps_post_anything() {
    let tree = root(
        r#"root = Stack([a, b, c, d])
a = Button("A", Action([@ToAssistant("go"), @OpenUrl("https://example.com"), @Set($x, 1), @ToAssistant("")]))
b = Button("B", Action([@OpenUrl("https://example.com")]))
c = Button("C", {type: "continue_conversation"})
d = Button("D", {steps: [{type: "continue_conversation", message: "legacy"}, {type: "open_url", url: "u"}]})"#,
    )
    .expect("a root");
    let messages: Vec<Vec<String>> = children(&tree)
        .iter()
        .map(|node| match node {
            Node::Button { action, .. } => action.messages.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(messages, vec![vec!["go".to_string()], vec![], vec!["C".to_string()], vec!["legacy".to_string()]]);
}

#[test]
fn a_component_that_fails_its_checks_is_left_out() {
    // Progress wants a number, Button an action, Table a header, KeyValue pairs of two; an unknown name is not a component.
    let tree = root(
        r#"root = Stack([Progress("x", "40%"), Button("Go"), Table([], []), KeyValue([["a"]]), Mystery("x"), Heading("kept"), Text("x", null)])"#,
    )
    .expect("a root");
    assert_eq!(children(&tree), &[Node::Heading { text: "kept".into(), level: 2 }]);
}

#[test]
fn a_wrong_optional_leaf_is_pruned_and_a_wrong_required_one_drops_the_component() {
    let tree = root(r#"root = Stack([Heading("a", 7), Text("b", "loud"), Heading(5), Callout("c", "danger", 3)], "diagonal", "xl")"#)
        .expect("a root");
    let Node::Stack { children, direction, gap } = &tree else { panic!() };
    assert_eq!((*direction, *gap), (Direction::Column, Gap::M), "bad enums fall back to the defaults");
    // Heading level 7 fails Zod's union of 1, 2, 3 (lang-core skips unions), so that one is dropped; the loud tone is pruned.
    assert_eq!(
        children,
        &[
            Node::Text { text: "b".into(), tone: TextTone::Default },
            Node::Callout { body: "c".into(), tone: CalloutTone::Danger, title: None }
        ]
    );
}

#[test]
fn the_root_must_be_a_stack() {
    assert_eq!(root("root = Heading(\"x\")"), None);
    assert!(root("root = Stack([])").is_some());
    // No `root` statement: the first component is the entry (a Heading here, so no root; a Stack, so one).
    assert_eq!(root("a = Heading(\"x\")\nb = Stack([a])"), None);
    assert!(root("b = Stack([a])\na = Heading(\"x\")").is_some());
}

#[test]
fn references_resolve_forward_and_a_cycle_or_a_stranger_is_unresolved() {
    let parsed = lang::parse("root = Stack([a, b, c])\na = Heading(\"a\")\nc = Stack([root])\nunused = Text(\"x\")", params_table);
    let root = parsed.root.expect("root");
    assert_eq!(root.statement, "root");
    assert!(parsed.unresolved.contains(&"b".to_string()), "b is never defined: {:?}", parsed.unresolved);
    assert_eq!(parsed.orphaned, vec!["unused".to_string()]);
    assert_eq!(parsed.statements, 4);
}

fn params_table(name: &str) -> Option<&'static [lang::Param]> {
    params(name)
}

#[test]
fn a_block_still_being_written_is_closed_and_marked_incomplete() {
    let block = parse_block("root = Stack([a])\na = Heading(\"Hel");
    assert!(block.incomplete);
    assert_eq!(block.root.as_ref().map(|root| children(root).to_vec()), Some(vec![Node::Heading { text: "Hel".into(), level: 2 }]));
    assert!(!parse_block("root = Stack([])").incomplete);
    assert_eq!(lang::auto_close("a = F(\"x\\"), ("a = F(\"x\\\\\")".to_string(), true));
}

#[test]
fn comments_and_fences_are_stripped_outside_strings() {
    let code = "```openui\n// the tree\nroot = Stack([t]) # root\nt = Text(\"a // not a comment # nor this\")\n```";
    let tree = root(code).expect("a root");
    assert_eq!(children(&tree), &[Node::Text { text: "a // not a comment # nor this".into(), tone: TextTone::Default }]);
}

#[test]
fn the_lexer_reads_what_lang_core_reads() {
    use Tok::*;
    assert_eq!(
        lang::tokenize("x = [1, -2.5e1, \"a\\nb\", 'c', true, null] ? $s : @Count(y)"),
        vec![
            Ident("x".into()),
            Assign,
            LBracket,
            Num(1.0),
            Comma,
            Num(-25.0),
            Comma,
            Str("a\nb".into()),
            Comma,
            Str("c".into()),
            Comma,
            True,
            Comma,
            Null,
            RBracket,
            Question,
            StateVar("$s".into()),
            Colon,
            At("Count".into()),
            LParen,
            Ident("y".into()),
            RParen,
            Eof
        ]
    );
    // `a -1` is a subtraction, `(-1)` and `[-1]` are numbers; an unterminated string takes the rest.
    assert_eq!(lang::tokenize("a - 1")[1], Minus);
    assert_eq!(lang::tokenize("a -1")[1], Minus);
    assert_eq!(lang::tokenize("[-1]")[1], Num(-1.0));
    assert_eq!(lang::tokenize("\"open")[0], Str("open".into()));
}

#[test]
fn expressions_over_literals_and_the_pure_builtins_evaluate() {
    let tree = root(
        r#"root = Stack([Progress("p", 1 / 4 + 0.25), Text(@Count([1, 2, 3]) > 2 ? "many" : "few"), Heading("n=" + @Sum([1, 2, 3.5])), Text(@Round(2.345, 2) + "")])"#,
    )
    .expect("a root");
    let parts = children(&tree);
    assert_eq!(parts[0], Node::Progress { label: "p".into(), value: 0.5 });
    assert_eq!(parts[1], Node::Text { text: "many".into(), tone: TextTone::Default });
    assert_eq!(parts[2], Node::Heading { text: "n=6.5".into(), level: 2 });
    assert!(matches!(&parts[3], Node::Text { text, .. } if text == "2.35" || text == "2.34"));
}

#[test]
fn a_deeply_nested_or_fanning_out_block_ends() {
    let deep = format!("root = Stack([{}Text(\"x\"){}])", "Stack([".repeat(200), "])".repeat(200));
    let _ = parse_block(&deep);
    let mut fan = String::from("root = Stack([a0, a0])\n");
    for i in 0..30 {
        fan.push_str(&format!("a{i} = Stack([a{}, a{}])\n", i + 1, i + 1));
    }
    fan.push_str("a30 = Text(\"leaf\")");
    let started = std::time::Instant::now();
    let _ = parse_block(&fan);
    assert!(started.elapsed().as_secs() < 5, "bounded by the node budget");
}

#[test]
fn chart_geometry_puts_zero_on_the_baseline_and_never_divides_by_zero() {
    let g = Geometry::of(&[0.0, 5.0, 10.0]);
    assert_eq!(g.zero(), CHART_PAD_TOP + CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM);
    assert_eq!(g.y(10.0), CHART_PAD_TOP);
    assert_eq!(g.slot, (CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT) / 3.0);
    assert_eq!(Geometry::of(&[]).y(0.0), Geometry::of(&[]).zero());
    assert_eq!(Geometry::of(&[3.0, 3.0]).y(3.0), CHART_PAD_TOP);
    let negative = Geometry::of(&[-5.0, 5.0]);
    assert!(negative.y(-5.0) > negative.zero() && negative.y(5.0) < negative.zero());
}

// -- drawn in a markdown view -------------------------------------------------------------------

struct Harness {
    state: Entity<TextViewState>,
    streaming: bool,
    sent: Arc<Mutex<Vec<String>>>,
    with_host: bool,
}

impl Render for Harness {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sent = self.sent.clone();
        let send: super::SendHandler = Arc::new(move |text, _, _| sent.lock().expect("sent").push(text.to_string()));
        let hooks = FenceHooks { streaming: self.streaming, send: self.with_host.then_some(send) };
        let style = text_view_style(cx.theme(), crate::theme::CHAT_TEXT.size);
        div().size_full().p_4().child(div().w(px(536.0)).child(Markdown::new(
            &self.state,
            style,
            extensions_with(open_with_system(), hooks),
            open_with_system(),
        )))
    }
}

use crate::theme::ActiveTheme as _;

fn mount<'a>(
    cx: &'a mut TestAppContext,
    text: &'static str,
    streaming: bool,
    with_host: bool,
) -> (Entity<Harness>, &'a mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, move |_, cx| Harness {
        state: cx.new(|cx| TextViewState::markdown(text, cx)),
        streaming,
        sent: Default::default(),
        with_host,
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    (view, cx)
}

fn fenced(code: &str) -> &'static str {
    testing::leak(format!("```openui\n{code}\n```"))
}

#[gpui::test]
fn every_component_draws_and_a_button_sends_its_message(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx, fenced(EXAMPLE), false, true);
    for selector in ["generative-ui-block", "genui-heading", "genui-keyvalue", "genui-table", "genui-stack"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector} drawn");
    }
    // Both buttons share a selector; the bounds are the last one's ("Later").
    let button = testing::bounds(cx, "genui-button");
    cx.simulate_click(button.center(), Modifiers::none());
    let sent = view.read_with(cx, |view, _| view.sent.lock().expect("sent").clone());
    assert_eq!(sent, vec!["Not now".to_string()]);
}

#[gpui::test]
fn charts_progress_and_callouts_draw_in_their_boxes(cx: &mut TestAppContext) {
    let code = "root = Stack([Callout(\"n\", \"success\", \"t\"), Progress(\"Done\", 0.5), BarChart([\"a\", \"b\"], [1, 2], \"Bars\"), LineChart([\"a\", \"b\"], [1, 2])])";
    let (_, cx) = mount(cx, fenced(code), false, true);
    for selector in ["genui-callout", "genui-progress", "progress-fill", "genui-chart"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let canvas = testing::bounds(cx, "genui-chart-canvas");
    assert!(f32::from(canvas.size.width) <= 448.0 + 0.5, "at most max-w-md: {:?}", canvas.size);
    let ratio = f32::from(canvas.size.width) / f32::from(canvas.size.height);
    assert!((ratio - 320.0 / 140.0).abs() < 0.05, "the viewBox's proportions: {ratio}");
    let fill = testing::bounds(cx, "progress-fill");
    let track = testing::bounds(cx, "genui-progress");
    assert!(f32::from(fill.size.width) < f32::from(track.size.width) * 0.6, "half a bar");
}

#[gpui::test]
fn a_button_is_off_while_the_reply_streams_or_with_no_host_to_take_it(cx: &mut TestAppContext) {
    for (streaming, host) in [(true, true), (false, false)] {
        let (view, cx) = mount(cx, fenced(EXAMPLE), streaming, host);
        let button = testing::bounds(cx, "genui-button");
        cx.simulate_click(button.center(), Modifiers::none());
        assert!(view.read_with(cx, |view, _| view.sent.lock().expect("sent").is_empty()), "streaming {streaming}, host {host}");
    }
}

#[gpui::test]
fn a_finished_block_with_no_root_shows_as_code_and_a_streaming_one_waits(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, fenced("root = Heading(\"x\")"), false, true);
    assert!(cx.debug_bounds("generative-ui-block").is_some());
    assert!(cx.debug_bounds("genui-heading").is_none(), "not a Stack: shown as code");
    // Cut short: code once finished, what parses so far while streaming.
    let cut = fenced("root = Stack([a])\na = Heading(\"Hel");
    let (_, cx) = mount(cx, cut, false, true);
    assert!(cx.debug_bounds("genui-heading").is_none());
    let (_, cx) = mount(cx, cut, true, true);
    assert!(cx.debug_bounds("genui-heading").is_some());
}

#[gpui::test]
fn in_the_transcript_a_button_posts_its_message_as_the_users_next_one(cx: &mut TestAppContext) {
    use crate::workspace::chat::transcript::{Item, Prose, Transcript};
    let items = vec![Item::Prose(Prose::new(fenced(EXAMPLE)))];
    let (transcript, cx) = testing::mount_in_root(cx, move |_, cx| Transcript::with_items(items, cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    let button = testing::bounds(cx, "genui-button");
    cx.simulate_click(button.center(), Modifiers::none());
    let last = transcript.read_with(cx, |transcript, _| transcript.items().last().cloned());
    assert!(matches!(last, Some(Item::User(text)) if text == "Not now"), "the message is the user's next one");
}
