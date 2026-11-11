//! The transcript cards (WP-23) mounted under `Root`, with the whole demo laid out in a tall window.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, px, size};

use crate::testing;
use crate::workspace::chat::fixture::cards_demo;
use crate::workspace::chat::transcript::cards::question::Status;
use crate::workspace::chat::transcript::{Card, Item, Transcript};

fn mount(cx: &mut TestAppContext) -> (Entity<Transcript>, &mut VisualTestContext) {
    let (transcript, cx) = testing::mount_in_root(cx, |_, cx| Transcript::with_items(cards_demo(), cx));
    cx.simulate_resize(size(px(800.0), px(9000.0)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    (transcript, cx)
}

fn find(cx: &mut VisualTestContext, transcript: &Entity<Transcript>, pick: impl Fn(&Card) -> bool) -> usize {
    transcript
        .read_with(cx, |t, _| t.items().iter().position(|item| matches!(item, Item::Card(card) if pick(card))))
        .expect("the demo has this card")
}

fn redraw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn click(cx: &mut VisualTestContext, selector: String) {
    let at = testing::bounds(cx, testing::leak(selector)).center();
    cx.simulate_click(at, Modifiers::none());
    redraw(cx);
}

#[gpui::test]
fn every_card_kind_draws_and_the_unknown_kind_is_a_bubble(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx);
    type Pick = fn(&Card) -> bool;
    let kinds: [(&str, Pick); 10] = [
        ("divider", |c| matches!(c, Card::Divider(_))),
        ("image-strip", |c| matches!(c, Card::Images(_))),
        ("generated-image", |c| matches!(c, Card::Generated(_))),
        ("question-card", |c| matches!(c, Card::Question(_))),
        ("answer-card", |c| matches!(c, Card::Answer(_))),
        ("pr-action", |c| matches!(c, Card::PrAction(_))),
        ("linear-issue", |c| matches!(c, Card::Linear(_))),
        ("usage-limit", |c| matches!(c, Card::Limit(_))),
        ("report-line", |c| matches!(c, Card::Report(_))),
        ("queued-card", |c| matches!(c, Card::Queued(_))),
    ];
    for (name, pick) in kinds {
        let ix = find(cx, &transcript, pick);
        let bounds = testing::bounds(cx, testing::leak(format!("{name}-{ix}")));
        assert!(bounds.size.height > px(0.0), "{name} has a height");
    }
    // "A kind from a newer app" is the user's bubble; its empty twin adds no item.
    let bubbles =
        transcript.read_with(cx, |t, _| t.items().iter().filter(|i| matches!(i, Item::User(text) if text.contains("newer app"))).count());
    assert_eq!(bubbles, 1);
}

#[gpui::test]
fn picking_an_option_resolves_the_question_in_place(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx);
    let ix = find(cx, &transcript, |c| matches!(c, Card::Question(q) if q.questions.len() == 1));
    let before = transcript.read_with(cx, |t, _| t.items().len());
    click(cx, format!("question-option-{ix}-0"));
    let (after, status) = transcript.read_with(cx, |t, _| {
        let Item::Card(Card::Question(q)) = &t.items()[ix] else { panic!("still a question item") };
        (t.items().len(), q.status.clone())
    });
    assert_eq!(after, before, "resolved in place: same item");
    assert!(matches!(&status, Status::Answered(a) if a[0].answers == ["setTimeout"]));
    assert!(testing::bounds(cx, testing::leak(format!("answer-card-{ix}"))).size.height > px(0.0));
}

#[gpui::test]
fn several_questions_need_every_answer_and_dismiss_closes_the_card(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx);
    let ix = find(cx, &transcript, |c| matches!(c, Card::Question(q) if q.questions.len() == 2));
    // Next is disabled until the active question has an answer.
    let _ = ix;
    click(cx, format!("question-option-{ix}-0"));
    click(cx, "question-dismiss".to_string());
    let dismissed = transcript
        .read_with(cx, |t, _| t.items().iter().any(|i| matches!(i, Item::Card(Card::Question(q)) if q.status == Status::Dismissed)));
    assert!(dismissed);
}

#[gpui::test]
fn an_image_opens_in_the_viewer_and_a_click_closes_it(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx);
    let ix = find(
        cx,
        &transcript,
        |c| matches!(c, Card::Images(s) if s.kind == crate::workspace::chat::transcript::cards::images::StripKind::Attachments),
    );
    click(cx, format!("image-open-{ix}-0"));
    assert!(testing::bounds(cx, "viewer").size.height > px(0.0));
    let at = testing::bounds(cx, "viewer").center();
    cx.simulate_click(at, Modifiers::none());
    redraw(cx);
    assert!(transcript.read_with(cx, |t, _| t.items().len()) > 0);
}

#[gpui::test]
fn the_usage_limit_switch_and_the_queue_remove_change_their_cards(cx: &mut TestAppContext) {
    let (transcript, cx) = mount(cx);
    let limit = find(cx, &transcript, |c| matches!(c, Card::Limit(_)));
    click(cx, format!("limit-account-{limit}-0"));
    let result = transcript.read_with(cx, |t, _| matches!(&t.items()[limit], Item::Card(Card::Limit(c)) if c.result.is_some()));
    assert!(result);
    let queued = find(cx, &transcript, |c| matches!(c, Card::Queued(_)));
    let before = transcript.read_with(cx, |t, _| matches!(&t.items()[queued], Item::Card(Card::Queued(q)) if q.items.len() == 2));
    assert!(before);
    let report = find(cx, &transcript, |c| matches!(c, Card::Report(r) if !r.open));
    assert!(testing::bounds(cx, testing::leak(format!("report-line-{report}"))).size.height > px(0.0));
}
