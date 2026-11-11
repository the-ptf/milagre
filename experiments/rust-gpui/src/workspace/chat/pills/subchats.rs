//! The Subchats pill and panel (`SubchatTrack.tsx`, `subchat-track.ts`): a pill above the composer ("1 needs you
//! · 2 working") that morphs into the list of what each Subchat is doing. With exactly one waiting on the user the
//! pill turns orange and says who and what, and a tap opens that Chat; otherwise a tap opens the list. A row opens
//! its Chat; a single question or an approval waiting on the user is answered from the row.
//!
//! The states, the summary and the sort are `logic::activity::subchat_states` (ports of `subchat-states.ts`).

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px,
};

use super::{PANEL_PAD, PillEvent, PillRow, scroll_body};
use crate::logic::activity::subchat_states::{SubchatKind, SubchatRequest, SubchatState, sort_subchats, subchat_summary};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, SpinnerRing};

/// `TONES[kind].fill`.
pub fn fill(kind: SubchatKind, theme: &Theme) -> gpui::Rgba {
    match kind {
        SubchatKind::NeedsYou => theme.orange,
        SubchatKind::Failed => theme.red,
        SubchatKind::Working => theme.accent,
        SubchatKind::Holding => theme.purple,
        SubchatKind::Queued | SubchatKind::Stopped => theme.ink4,
        SubchatKind::Done => theme.green,
    }
}

/// `KIND_INK`: the words of a state, the ink token that holds contrast on the surface.
pub fn ink(kind: SubchatKind, theme: &Theme) -> gpui::Rgba {
    match kind {
        SubchatKind::NeedsYou => theme.orange_ink,
        SubchatKind::Failed => theme.red_ink,
        SubchatKind::Working => theme.accent_ink,
        SubchatKind::Holding => theme.purple_ink,
        SubchatKind::Queued | SubchatKind::Stopped => theme.ink3,
        SubchatKind::Done => theme.green_ink,
    }
}

fn icon(kind: SubchatKind) -> Option<IconName> {
    match kind {
        SubchatKind::NeedsYou => Some(IconName::HelpCircle),
        SubchatKind::Failed => Some(IconName::CancelCircle),
        SubchatKind::Working => None,
        SubchatKind::Holding => Some(IconName::Favourite),
        SubchatKind::Queued => Some(IconName::Clock01),
        SubchatKind::Stopped => Some(IconName::StopCircle),
        SubchatKind::Done => Some(IconName::CheckmarkCircle02),
    }
}

/// A single question with options is answered by one tap; several questions at once are answered in the Chat.
fn single_question(request: &SubchatRequest) -> Option<(&str, &crate::logic::activity::subchat_states::AgentQuestion)> {
    match request {
        SubchatRequest::Question { request_id, questions } if questions.len() == 1 => Some((request_id.as_str(), &questions[0])),
        _ => None,
    }
}

const ROW_HEIGHT: f32 = 54.0;
const ACTIONS_HEIGHT: f32 = 32.0;

impl PillRow {
    /// The states the panel lists, needs-you first.
    pub fn subchat_states(&self) -> Vec<SubchatState> {
        sort_subchats(&self.data.subchats)
    }

    pub(super) fn subchats_pill_width(&self) -> f32 {
        let summary = subchat_summary(&self.data.subchats);
        let chars = match &summary.asking {
            Some(asking) => {
                let rest: usize =
                    summary.parts.iter().filter(|part| part.kind != SubchatKind::NeedsYou).map(|part| part.text.len() + 3).sum();
                asking.title.chars().count().min(26) + asking.ask.chars().count().min(46) + rest + 2
            }
            None => summary.parts.iter().map(|part| part.text.len() + 3).sum::<usize>(),
        };
        20.0 + 10.0 + 6.0 + if summary.asking.is_some() { 0.0 } else { 18.0 } + chars as f32 * 6.3
    }

    pub(super) fn subchats_pill(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let summary = subchat_summary(&self.data.subchats);
        let asking = summary.asking.clone();
        let tone: gpui::Rgba = if summary.lead == Some(SubchatKind::NeedsYou) { theme.orange_ink } else { theme.ink2 };
        let rest: Vec<_> = summary.parts.iter().filter(|part| part.kind != SubchatKind::NeedsYou).cloned().collect();
        let lead = match summary.lead {
            Some(SubchatKind::Working) => SpinnerRing::new().size(10.0).color(theme.accent).into_any_element(),
            Some(kind) => div().flex_none().size(px(8.0)).rounded_full().bg(fill(kind, &theme)).into_any_element(),
            None => div().flex_none().size(px(8.0)).rounded_full().bg(theme.ink4).into_any_element(),
        };
        let words = match &asking {
            Some(asking) => div()
                .flex()
                .items_center()
                .gap_1p5()
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .max_w(px(160.0))
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.orange_ink)
                        .child(asking.title.clone()),
                )
                .child(div().max_w(px(280.0)).truncate().text_color(theme.ink).child(asking.ask.clone()))
                .children(rest.iter().map(|part| div().flex_none().text_color(theme.ink3).child(format!("\u{b7} {}", part.text))))
                .into_any_element(),
            None => div()
                .flex()
                .items_center()
                .min_w_0()
                .overflow_hidden()
                .children(summary.parts.iter().enumerate().map(|(index, part)| {
                    div().flex_none().text_color(if index == 0 { theme.ink } else { theme.ink3 }).child(if index > 0 {
                        format!(" \u{b7} {}", part.text)
                    } else {
                        part.text.clone()
                    })
                }))
                .into_any_element(),
        };
        let key = asking.as_ref().map(|asking| asking.key.clone());
        div()
            .id("pill-subchats-button")
            .debug_selector(|| "pill-subchats-button".into())
            .flex()
            .items_center()
            .gap(px(6.0))
            .h_full()
            .max_w_full()
            .overflow_hidden()
            .px(px(10.0))
            .rounded_full()
            .text_step(TEXT_12)
            .text_color(tone)
            .whitespace_nowrap()
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .when(asking.is_none(), |el| el.child(Icon::new(IconName::ArrowUp01).size(IconSize::S12).color(tone)))
            .child(lead)
            .child(words)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| match &key {
                Some(key) => cx.emit(PillEvent::OpenChat(key.clone())),
                None => this.set_open(Some(super::Kind::Subchats), false, window, cx),
            }))
            .into_any_element()
    }

    pub(super) fn subchats_height(&self) -> f32 {
        let rows: f32 =
            self.data.subchats.iter().map(|state| ROW_HEIGHT + if state.request.is_some() { ACTIONS_HEIGHT } else { 0.0 }).sum();
        2.0 * PANEL_PAD + rows + 2.0 * self.data.subchats.len() as f32
    }

    pub(super) fn subchats_panel(&mut self, _size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let rows = self.subchat_states().iter().map(|state| subchat_row(state, &theme, cx)).collect();
        div()
            .id("panel-subchats")
            .debug_selector(|| "panel-subchats".into())
            .size_full()
            .flex()
            .flex_col()
            .p(px(PANEL_PAD))
            .child(scroll_body("subchats-body", &self.scroll, rows))
            .into_any_element()
    }
}

fn subchat_row(state: &SubchatState, theme: &Theme, cx: &mut Context<PillRow>) -> AnyElement {
    let theme = *theme;
    let key = state.key.clone();
    let asked = state.request.as_ref().filter(|request| single_question(request).is_some());
    let selector = format!("subchat-row-{}", state.key);
    let detail_color: Hsla = match state.kind {
        SubchatKind::Failed => theme.red_ink.into(),
        SubchatKind::Done => theme.ink2.into(),
        _ => theme.ink3.into(),
    };
    let mark = match icon(state.kind) {
        Some(icon) => Icon::new(icon).size(IconSize::S16).color(fill(state.kind, &theme)).into_any_element(),
        None => SpinnerRing::new().size(14.0).color(theme.accent).into_any_element(),
    };
    let open_key = key.clone();
    let button = div()
        .id(ElementId::from(SharedString::from(format!("subchat-open-{}", state.key))))
        .debug_selector({
            let key = state.key.clone();
            move || format!("subchat-open-{key}")
        })
        .flex()
        .items_start()
        .gap_2()
        .w_full()
        .px_2()
        .py(px(6.0))
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover))
        .child(div().mt(px(1.0)).flex().flex_none().items_center().justify_center().size(px(16.0)).child(mark))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .flex()
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.ink)
                        .child(div().min_w_0().truncate().child(state.title.clone()))
                        .when_some(state.via.clone(), |el, via| {
                            el.child(
                                div().flex_none().font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(format!(" \u{b7} in {via}")),
                            )
                        }),
                )
                .child(div().truncate().text_step(TEXT_12).text_color(detail_color).child(state.detail.clone())),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_baseline()
                .gap_1p5()
                .text_step(TEXT_12)
                .child(div().font_weight(FontWeight::MEDIUM).text_color(ink(state.kind, &theme)).child(state.label))
                .children(state.elapsed.clone().map(|elapsed| div().text_color(theme.ink3).child(elapsed))),
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.set_open(None, false, window, cx);
            cx.emit(PillEvent::OpenChat(open_key.clone()));
        }));
    let actions = state.request.as_ref().map(|request| {
        let mut row = div().flex().flex_wrap().gap_1p5().pr_2().pb_2().pl(px(32.0));
        if let Some((request_id, question)) = single_question(request) {
            for (index, option) in question.options.iter().enumerate() {
                let (chat, request_id, label) = (key.clone(), request_id.to_string(), option.label.clone());
                let recommended = index == 0 && option.label.contains("(Recommended)");
                row = row.child(
                    Button::new(ElementId::from(SharedString::from(format!("subchat-answer-{}-{index}", state.key))), label.clone())
                        .size(ButtonSize::S24)
                        .variant(if recommended { ButtonVariant::Link } else { ButtonVariant::Secondary })
                        .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                            cx.emit(PillEvent::Answer { chat: chat.clone(), request: request_id.clone(), label: label.to_string() })
                        })),
                );
            }
        }
        if let SubchatRequest::Approval { request } = request {
            for (allow, label) in [(true, "Allow"), (false, "Deny")] {
                let (chat, request_id) = (key.clone(), request.request_id.clone());
                row = row.child(
                    Button::new(ElementId::from(SharedString::from(format!("subchat-{}-{}", label.to_lowercase(), state.key))), label)
                        .size(ButtonSize::S24)
                        .variant(if allow { ButtonVariant::Primary } else { ButtonVariant::Secondary })
                        .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                            cx.emit(PillEvent::Respond { chat: chat.clone(), request: request_id.clone(), allow })
                        })),
                );
            }
        }
        let reply_key = key.clone();
        row.child(
            Button::new(ElementId::from(SharedString::from(format!("subchat-reply-{}", state.key))), "Reply\u{2026}")
                .size(ButtonSize::S24)
                .variant(ButtonVariant::Quiet)
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.set_open(None, false, window, cx);
                    cx.emit(PillEvent::OpenChat(reply_key.clone()));
                })),
        )
    });
    div()
        .id(ElementId::from(SharedString::from(format!("subchat-li-{}", state.key))))
        .debug_selector(move || selector.clone())
        .flex_none()
        .mb(px(2.0))
        .rounded(RADIUS_CONTROL)
        .when(state.kind == SubchatKind::NeedsYou, |el| el.bg(theme.orange_tint))
        .child(button)
        .children(actions)
        .when(asked.is_none() && state.request.is_none(), |el| el)
        .into_any_element()
}
