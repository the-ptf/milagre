//! The small cards: the answer card (`AnswerCard.tsx`), a PR action (`PullRequestActionCard.tsx`), a Linear issue
//! (`LinearIssueCard.tsx`), the usage-limit card (`UsageLimitCard.tsx`), a delegation report line
//! (`DelegationReportLine.tsx`, the Subchat report's one line), and a Subchat note (`SubchatMessages.tsx` `NoteLine`).
//! The queued messages moved to the composer's dock (`composer/queue.rs`).
//!
//! The ones a person wrote (answers, PR action, Linear issue) sit on the right with the user's messages, at most
//! 448px wide (`max-w-md`, `pl-12`). Card colours: `surface` with a `line` border at `rounded-card`.
//!
//! Not built: the Linear mark before the issue key (no Linear logo asset), the issue state's own dot colour (the data
//! carries the state's name only), markdown in an opened report (plain text), opening the sender's Chat, the usage
//! limit's live account list and schedule (the card is given its choices and its pending time).

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, Rgba, SharedString, div, prelude::*, px};

use super::super::Transcript;
use crate::data::AnsweredQuestion;
use crate::logic::activity::subchat_states::SubchatKind;
use crate::logic::prs::blockers::{Blocker, BlockerTone, PrState, pull_request_state_pill};
use crate::logic::usage::limit::{LimitChoice, UsageLimit, limit_headline, limit_resume_label, switched_text};
use crate::logic::usage::time::FixedZone;
use crate::theme::{RADIUS_CARD, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconButton, IconButtonSize, IconName, IconSize};

/// `max-w-md`.
const CARD_MAX_WIDTH: f32 = 448.0;
/// `pl-12`: what the user's side leaves empty on the left.
const USER_SIDE_INSET: f32 = 48.0;

/// A card on the user's side: right-aligned, at most 448px.
fn user_side(card: impl IntoElement) -> AnyElement {
    div()
        .flex()
        .w_full()
        .justify_end()
        .pl(px(USER_SIDE_INSET))
        .child(div().w_full().max_w(px(CARD_MAX_WIDTH)).child(card))
        .into_any_element()
}

fn card_frame(theme: &Theme) -> gpui::Div {
    div().flex().flex_col().w_full().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.surface).text_step(TEXT_13)
}

/// `AnswerCard`: each question the user answered with what they picked or typed.
pub fn answer_card(ix: usize, answered: &[AnsweredQuestion], theme: &Theme) -> AnyElement {
    let title = if answered.len() == 1 { "Answered the question".to_string() } else { format!("Answered {} questions", answered.len()) };
    let mut card = card_frame(theme).debug_selector(move || format!("answer-card-{ix}")).overflow_hidden().child(
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.line)
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .child(Icon::new(IconName::BubbleChatQuestion).size(IconSize::S14).color(theme.ink2))
            .child(title),
    );
    for (n, item) in answered.iter().enumerate() {
        card = card.child(
            div()
                .px_3()
                .py_2()
                .when(n > 0, |el| el.border_t_1().border_color(theme.line))
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(item.question.clone()))
                .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(item.answers.join(", "))),
        );
    }
    user_side(card)
}

/// A PR-blocker pill the user clicked, shown as what it asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct PrActionCard {
    pub blocker: Blocker,
    pub pr: u64,
    pub url: SharedString,
    /// The PR's state, when the host knows it: a Merged, Closed or Draft pill follows the number (`pullRequestStatePill`).
    pub state: Option<(PrState, bool)>,
}

/// The palette keys `StatePill` names, as theme colours.
fn palette(key: &str, theme: &Theme) -> Rgba {
    match key {
        "purpleTint" => theme.purple_tint,
        "purpleInk" => theme.purple_ink,
        "redTint" => theme.red_tint,
        "redInk" => theme.red_ink,
        "hover" => theme.hover,
        _ => theme.ink2,
    }
}

pub fn pr_action(ix: usize, card: &PrActionCard, theme: &Theme) -> AnyElement {
    let tone = if card.blocker.tone() == BlockerTone::Orange { theme.orange_ink } else { theme.red_ink };
    let url = card.url.clone();
    let pill = card.state.and_then(|(state, draft)| pull_request_state_pill(state, draft));
    user_side(
        card_frame(theme)
            .debug_selector(move || format!("pr-action-{ix}"))
            .flex_row()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .child(Icon::new(IconName::GitPullRequest).size(IconSize::S16).color(tone))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .child(card.blocker.action_label()),
            )
            .children(pill.map(|pill| {
                div()
                    .flex_none()
                    .px(px(6.0))
                    .rounded(RADIUS_INLINE)
                    .bg(palette(pill.fill, theme))
                    .text_step(TEXT_11)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(palette(pill.ink, theme))
                    .child(pill.label)
            }))
            .child(
                div()
                    .id(ElementId::from((SharedString::from("pr-action-link"), ix)))
                    .flex_none()
                    .cursor_pointer()
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .hover(|s| s.text_color(theme.ink))
                    .on_click(move |_: &ClickEvent, _window, cx| cx.open_url(&url))
                    .child(format!("Pull request #{}", card.pr)),
            ),
    )
}

/// A Chat started from a Linear issue, shown as the issue instead of the prompt the agent read.
#[derive(Clone, Debug, PartialEq)]
pub struct LinearCard {
    pub key: SharedString,
    pub title: SharedString,
    pub state: SharedString,
    pub url: SharedString,
    pub note: Option<SharedString>,
}

pub fn linear_issue(ix: usize, card: &LinearCard, theme: &Theme) -> AnyElement {
    let url = card.url.clone();
    let opens = !url.is_empty();
    user_side(
        div()
            .flex()
            .flex_col()
            .gap_2()
            .w_full()
            .child(
                card_frame(theme)
                    .id(ElementId::from((SharedString::from("linear-issue"), ix)))
                    .debug_selector(move || format!("linear-issue-{ix}"))
                    .gap_1()
                    .px_3()
                    .py_2()
                    .when(opens, |el| {
                        el.cursor_pointer()
                            .hover(|s| s.border_color(theme.line_strong))
                            .on_click(move |_: &ClickEvent, _window, cx| cx.open_url(&url))
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(div().flex_none().font_weight(FontWeight::MEDIUM).child(card.key.clone()))
                            .child(div().flex_none().size(px(6.0)).rounded_full().bg(theme.ink3))
                            .child(div().min_w_0().truncate().child(card.state.clone())),
                    )
                    .child(div().line_clamp(2).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(card.title.clone())),
            )
            .children(card.note.clone().map(|note| {
                div()
                    .self_end()
                    .px_3()
                    .py(px(6.0))
                    .rounded(RADIUS_CARD)
                    .text_step(TEXT_13)
                    .bg(theme.field)
                    .text_color(theme.ink)
                    .child(note)
            })),
    )
}

/// The usage-limit card under a reply the plan's limit stopped.
#[derive(Clone, Debug)]
pub struct LimitCard {
    pub limit: UsageLimit,
    pub now: i64,
    /// `limitChoices`: the Project's other accounts for the provider.
    pub choices: Vec<LimitChoice>,
    /// A pending "continue at reset" schedule's time.
    pub pending_at: Option<String>,
    /// The Chat's last message with no turn running: the card may offer its actions.
    pub interactive: bool,
    pub result: Option<SharedString>,
}

impl Transcript {
    pub(super) fn limit_card(&mut self, ix: usize, card: &LimitCard, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let zone = FixedZone(0);
        let headline = limit_headline(&card.limit, card.now, &zone);
        let resume = limit_resume_label(card.pending_at.as_deref(), &card.limit, card.now, &zone);
        let mut shell = card_frame(theme).debug_selector(move || format!("usage-limit-{ix}")).gap_2().px_3().py_2().child(
            div()
                .flex()
                .items_start()
                .gap_2()
                .child(div().mt(px(1.0)).child(Icon::new(IconName::Clock01).size(IconSize::S16).color(theme.orange_ink)))
                .child(
                    div()
                        .min_w_0()
                        .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(headline.title))
                        .child(div().text_step(TEXT_12).text_color(theme.ink3).child(headline.detail)),
                ),
        );
        if let (Some(label), None) = (&resume, &card.result) {
            let pending = card.pending_at.is_some();
            let toggle = cx.listener(move |this, _: &ClickEvent, _window, cx| {
                if let Some(super::Card::Limit(mut card)) = this.card_at(ix) {
                    card.pending_at = if card.pending_at.is_some() {
                        None
                    } else {
                        Some(crate::logic::usage::time::format_iso(card.now + 3 * 60 * 60 * 1000))
                    };
                    this.set_card(ix, super::Card::Limit(card), cx);
                }
            });
            shell = shell.child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .when(pending, |el| el.child(div().text_step(TEXT_12).text_color(theme.ink2).child(label.clone())))
                    .when(card.interactive, |el| {
                        el.child(
                            Button::new(
                                ElementId::from((SharedString::from("limit-resume"), ix)),
                                if pending { "Cancel".to_string() } else { label.clone() },
                            )
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S24)
                            .selector("limit-resume")
                            .on_click(toggle),
                        )
                    }),
            );
        }
        if let Some(result) = &card.result {
            shell = shell.child(div().text_step(TEXT_12).text_color(theme.ink2).child(result.clone()));
        } else if card.interactive {
            if card.choices.is_empty() {
                shell = shell.child(
                    div().child(
                        Button::new(ElementId::from((SharedString::from("limit-add"), ix)), "Add account")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28),
                    ),
                );
            } else {
                let mut list = div().flex().flex_col().gap_1();
                for (n, choice) in card.choices.iter().enumerate() {
                    let label = choice.label.clone();
                    let click = cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        if let Some(super::Card::Limit(mut card)) = this.card_at(ix) {
                            card.result = Some(switched_text(true, &label).into());
                            this.set_card(ix, super::Card::Limit(card), cx);
                        }
                    });
                    list = list.child(
                        div()
                            .id(ElementId::from((SharedString::from("limit-account"), ix * 100 + n)))
                            .debug_selector(move || format!("limit-account-{ix}-{n}"))
                            .flex()
                            .h(px(32.0))
                            .w_full()
                            .items_center()
                            .gap_2()
                            .px(px(10.0))
                            .rounded(RADIUS_CONTROL)
                            .border_1()
                            .border_color(theme.line)
                            .text_step(TEXT_12)
                            .when(choice.disabled, |el| el.opacity(0.4))
                            .when(!choice.disabled, |el| {
                                el.cursor_pointer().hover(|s| s.border_color(theme.line_strong).bg(theme.hover)).on_click(click)
                            })
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child(format!("Switch to {}", choice.label)),
                            )
                            .when(!choice.detail.is_empty(), |el| {
                                el.child(div().flex_none().text_color(theme.ink3).child(choice.detail.clone()))
                            }),
                    );
                }
                shell = shell.child(list);
                if card.choices.iter().all(|c| c.disabled) {
                    shell = shell.child(
                        div().child(
                            Button::new(ElementId::from((SharedString::from("limit-manage"), ix)), "Manage accounts")
                                .variant(ButtonVariant::Quiet)
                                .size(ButtonSize::S24),
                        ),
                    );
                }
            }
        }
        div().mt(px(12.0)).max_w(px(CARD_MAX_WIDTH)).child(shell).into_any_element()
    }
}

/// A Subchat's finished report: one grey line, its text opening on the chevron.
#[derive(Clone, Debug, PartialEq)]
pub struct ReportCard {
    pub text: SharedString,
    pub kind: SubchatKind,
    pub body: SharedString,
    pub open: bool,
}

impl Transcript {
    pub(super) fn report_line(&mut self, ix: usize, card: &ReportCard, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let ink = if card.kind == SubchatKind::Failed { theme.red_ink } else { theme.ink3 };
        let toggle = cx.listener(move |this, _: &ClickEvent, _window, cx| {
            if let Some(super::Card::Report(mut card)) = this.card_at(ix) {
                card.open = !card.open;
                this.set_card(ix, super::Card::Report(card), cx);
            }
        });
        let can_open = !card.body.trim().is_empty();
        div()
            .debug_selector(move || format!("report-line-{ix}"))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .min_w_0()
            .max_w_full()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .text_step(TEXT_12)
                    .text_color(ink)
                    .child(Icon::new(IconName::CornerDownRight).size(IconSize::S12).color(ink))
                    .child(div().min_w_0().truncate().child(card.text.clone()))
                    .when(can_open, |el| {
                        el.child(
                            IconButton::new(
                                ElementId::from((SharedString::from("report-toggle"), ix)),
                                if card.open { IconName::ArrowDown01 } else { IconName::ArrowRight01 },
                            )
                            .size(IconButtonSize::S20)
                            .on_click(toggle),
                        )
                    }),
            )
            .when(card.open, |el| {
                el.child(
                    div()
                        .min_w_0()
                        .max_w_full()
                        .rounded(RADIUS_CONTROL)
                        .border_1()
                        .border_color(theme.line)
                        .px_3()
                        .py_2()
                        .text_size(px(crate::theme::chat_text().size))
                        .line_height(px(crate::theme::chat_text().line_height))
                        .text_color(theme.ink)
                        .child(card.body.clone()),
                )
            })
            .into_any_element()
    }
}

/// A grey `↳` note (Subchat "answered by", escalation).
#[derive(Clone, Debug, PartialEq)]
pub struct NoteLine {
    pub text: SharedString,
}

pub fn note_line(ix: usize, note: &NoteLine, theme: &Theme) -> AnyElement {
    div()
        .debug_selector(move || format!("note-line-{ix}"))
        .flex()
        .min_w_0()
        .max_w_full()
        .items_center()
        .gap(px(6.0))
        .text_step(TEXT_12)
        .text_color(theme.ink3)
        .child(Icon::new(IconName::CornerDownRight).size(IconSize::S12).color(theme.ink3))
        .child(div().min_w_0().truncate().child(note.text.clone()))
        .into_any_element()
}
