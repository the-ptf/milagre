//! The question card (`agents/QuestionCard.tsx`, DESIGN.md "Question card"): a bordered card (`line-strong`,
//! `rounded-card`, `surface`) with "Waiting for answer" and how long the turn has waited, the question at 15
//! semibold, each option as a bordered row with a radio (or a checkbox when several may be picked), its label at
//! 13 medium and its description at 12 `ink-2`, "Other…" as the last row with a text field, and Dismiss and Send
//! answer (Next on every question but the last) at the bottom right. Several questions show one at a time under a
//! tab each. A picked row is `inset` with a `line-strong` border.
//!
//! The card is one list item and resolves in place: Send answer turns it into the answer card (`AnswerCard`), and
//! Dismiss into a quiet line. The draft rules are `answers.rs`.
//!
//! Not built: dictation (the mic button is inert), images on an answer (the image button is inert), the secret
//! and bug-report variants of the card, Escape clearing the field, arrow keys over the option rows (a row is a
//! mouse target; Enter in the field advances or sends, as in the app).

use std::collections::HashMap;

use gpui::{AnyElement, ClickEvent, Context, ElementId, Entity, FontWeight, SharedString, Subscription, Window, div, prelude::*, px};
use gpui_component::input::{InputEvent, InputState};

use super::super::Transcript;
use super::answers::{self, Drafts, Primary};
use crate::data::{AnsweredQuestion, QuestionRequest};
use crate::logic::activity::subchat_states::AgentQuestion;
use crate::theme::{CONTROL_SM, RADIUS_CARD, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, FieldSize, Icon, IconButton, IconButtonSize, IconName, IconSize, Input, TabOption, Tabs,
};

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Open,
    Answered(Vec<AnsweredQuestion>),
    Dismissed,
}

#[derive(Clone, Debug)]
pub struct QuestionCard {
    pub request_id: SharedString,
    pub questions: Vec<AgentQuestion>,
    pub drafts: Drafts,
    pub active: usize,
    /// "1m 04s": how long the turn has waited, beside "Waiting for answer" (a ticking clock is not built).
    pub waited: Option<SharedString>,
    pub status: Status,
}

impl QuestionCard {
    pub fn new(request: &QuestionRequest, waited: Option<SharedString>) -> Self {
        Self {
            request_id: request.request_id.clone(),
            questions: request.questions.clone(),
            drafts: Drafts::new(),
            active: 0,
            waited,
            status: Status::Open,
        }
    }

    fn active_question(&self) -> Option<&AgentQuestion> {
        self.questions.get(self.active)
    }

    /// Sends the answers when every question has one: the card becomes the user's answered questions.
    fn send(&mut self) -> bool {
        match answers::draft_answers(&self.questions, &self.drafts) {
            Some(all) => {
                self.status = Status::Answered(answers::answered_questions(&self.questions, &all));
                true
            }
            None => false,
        }
    }

    /// Enter in the field, or the primary button: Next moves on, Send sends.
    pub fn advance(&mut self) {
        if self.status != Status::Open || !answers::primary_enabled(&self.questions, &self.drafts, self.active) {
            return;
        }
        match answers::primary_action(&self.questions, self.active) {
            Primary::Next => self.active = answers::next_tab(self.questions.len(), self.active),
            Primary::Send => {
                self.send();
            }
        }
    }

    /// A click on option `label` of the active question: the pick, and the move it causes.
    pub fn pick(&mut self, label: &str) {
        let Some(question) = self.active_question().cloned() else { return };
        answers::pick_option(&mut self.drafts, &question, label);
        if answers::sends_on_pick(&self.questions) {
            self.send();
        } else if answers::advances_on_pick(&self.questions, self.active) {
            self.active = answers::next_tab(self.questions.len(), self.active);
        }
    }

    pub fn type_text(&mut self, question_ix: usize, text: &str) {
        if let Some(question) = self.questions.get(question_ix).cloned() {
            answers::type_answer(&mut self.drafts, &question, text);
        }
    }

    pub fn choose_other(&mut self) {
        if let Some(question) = self.active_question().cloned() {
            answers::choose_other(&mut self.drafts, &question);
        }
    }
}

/// A radio or checkbox box, drawn only: the row is the control. 16px; an `ink-3` edge on `surface` at rest, an ink
/// fill with an 8px dot (radio) or a 14px tick (checkbox) when picked.
pub fn choice_box(checked: bool, radio: bool, theme: &Theme) -> AnyElement {
    let shape = if radio { gpui::Pixels::from(8.0) } else { RADIUS_INLINE };
    let base = div().flex().flex_none().items_center().justify_center().size(px(16.0)).border_1();
    let base = if radio { base.rounded_full() } else { base.rounded(shape) };
    if checked {
        base.bg(theme.ink)
            .border_color(theme.ink)
            .child(if radio {
                div().size(px(8.0)).rounded_full().bg(theme.on_ink).into_any_element()
            } else {
                Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.on_ink).into_any_element()
            })
            .into_any_element()
    } else {
        base.bg(theme.surface).border_color(theme.ink3).into_any_element()
    }
}

impl Transcript {
    /// The text field of question `question_ix` on card `ix`, made on first use.
    fn other_input(
        &mut self,
        ix: usize,
        question_ix: usize,
        placeholder: &'static str,
        secret: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(state) = self.inputs.get(&(ix, question_ix)) {
            return state.clone();
        }
        let state = if secret { Input::password_state(placeholder, window, cx) } else { Input::state(placeholder, window, cx) };
        let subscription: Subscription = cx.subscribe_in(&state, window, move |this, state, event: &InputEvent, _window, cx| match event {
            InputEvent::Change => {
                let text = state.read(cx).value().to_string();
                if let Some(mut card) = this.question_at(ix) {
                    card.type_text(question_ix, &text);
                    this.replace_question(ix, card, false, cx);
                }
            }
            InputEvent::PressEnter { .. } => {
                if let Some(mut card) = this.question_at(ix) {
                    card.advance();
                    this.replace_question(ix, card, true, cx);
                }
            }
            _ => {}
        });
        self.subscriptions.push(subscription);
        self.inputs.insert((ix, question_ix), state.clone());
        state
    }

    fn question_at(&self, ix: usize) -> Option<QuestionCard> {
        match self.card_at(ix) {
            Some(super::Card::Question(card)) if card.status == Status::Open => Some(*card),
            _ => None,
        }
    }

    /// Puts a changed card back. A pick, a tab or an answer can change the height, so those re-measure the item; typing
    /// only changes colours.
    fn replace_question(&mut self, ix: usize, card: QuestionCard, remeasure: bool, cx: &mut Context<Self>) {
        let resolved = card.status != Status::Open;
        if remeasure || resolved {
            self.set_card(ix, super::Card::Question(Box::new(card)), cx);
        } else if let Some(super::super::Item::Card(slot)) = self.items.get_mut(ix) {
            *slot = super::Card::Question(Box::new(card));
            cx.notify();
        }
        if resolved {
            self.inputs.retain(|(item, _), _| *item != ix);
        }
    }

    pub(super) fn question_card(
        &mut self,
        ix: usize,
        card: &QuestionCard,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match &card.status {
            Status::Answered(answered) => return super::small::answer_card(ix, answered, theme),
            Status::Dismissed => {
                return div()
                    .debug_selector(move || format!("question-dismissed-{ix}"))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child("Dismissed the question")
                    .into_any_element();
            }
            Status::Open => {}
        }
        let Some(question) = card.active_question() else { return div().into_any_element() };
        let several = card.questions.len() > 1;
        let draft = answers::draft_of(&card.drafts, &question.id);
        let other_on = answers::other_chosen(&draft);
        let radio = !question.multi_select;
        let ready = answers::primary_enabled(&card.questions, &card.drafts, card.active);
        let action = answers::primary_action(&card.questions, card.active);

        let mut body = div().flex().flex_col().gap(px(6.0));
        // "Waiting for answer" in the approval row's orange, then the question.
        body = body.child(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::MEDIUM)
                        .child(div().flex_none().size(px(8.0)).rounded_full().bg(theme.orange))
                        .child(div().text_color(theme.orange_ink).child("Waiting for answer"))
                        .children(card.waited.as_ref().map(|waited| div().text_color(theme.ink3).child(format!("\u{b7} {waited}")))),
                )
                .child(
                    div()
                        .mt(px(2.0))
                        .text_step(TEXT_15)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.ink)
                        .child(question.question.clone()),
                ),
        );
        if question.multi_select {
            body = body.child(div().text_step(TEXT_12).text_color(theme.ink3).child("Pick any that apply."));
        }
        for (n, option) in question.options.iter().enumerate() {
            let picked = draft.picked.contains(&option.label);
            let label = option.label.clone();
            let click = cx.listener(move |this, _: &ClickEvent, _window, cx| {
                if let Some(mut card) = this.question_at(ix) {
                    card.pick(&label);
                    this.replace_question(ix, card, true, cx);
                }
            });
            body = body.child(
                div()
                    .id(ElementId::from((SharedString::from("question-option"), ix * 100 + n)))
                    .debug_selector(move || format!("question-option-{ix}-{n}"))
                    .flex()
                    .w_full()
                    .items_start()
                    .gap_2()
                    .px(px(10.0))
                    .py_2()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .cursor_pointer()
                    .when(picked, |el| el.border_color(theme.line_strong).bg(theme.inset))
                    .when(!picked, |el| {
                        el.border_color(theme.line).bg(theme.surface).hover(|s| s.border_color(theme.line_strong).bg(theme.hover))
                    })
                    .on_click(click)
                    .child(div().mt(px(2.0)).child(choice_box(picked, radio, theme)))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(option.label.clone()),
                            )
                            .children(option.description.clone().map(|d| div().text_step(TEXT_12).text_color(theme.ink2).child(d))),
                    ),
            );
        }
        if question.allow_other {
            let placeholder = if question.options.is_empty() { "Type your answer" } else { "Other\u{2026}" };
            let input = self.other_input(ix, card.active, placeholder, question.secret, window, cx);
            let toggle = cx.listener(move |this, _: &ClickEvent, _window, cx| {
                if let Some(mut card) = this.question_at(ix) {
                    card.choose_other();
                    this.replace_question(ix, card, true, cx);
                }
            });
            body = body.child(
                div()
                    .debug_selector(move || format!("question-other-{ix}"))
                    .flex()
                    .w_full()
                    .min_h(px(52.0))
                    .items_center()
                    .gap_2()
                    .px(px(10.0))
                    .py_2()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .when(other_on, |el| el.border_color(theme.line_strong).bg(theme.inset))
                    .when(!other_on, |el| el.border_color(theme.line).bg(theme.surface))
                    .when(!question.options.is_empty(), |el| {
                        el.child(
                            div()
                                .id(ElementId::from((SharedString::from("question-other-box"), ix)))
                                .cursor_pointer()
                                .on_click(toggle)
                                .child(choice_box(other_on, radio, theme)),
                        )
                    })
                    .child(div().flex_1().min_w_0().child(Input::new(format!("question-field-{ix}"), &input).size(FieldSize::S28).bare()))
                    .when(!question.secret, |el| {
                        // 24px controls trailing on the options' content inset; dictation and image answers are not built.
                        el.child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(2.0))
                                .child(
                                    IconButton::new(ElementId::from((SharedString::from("question-mic"), ix)), IconName::Mic01)
                                        .size(IconButtonSize::S24),
                                )
                                .child(
                                    IconButton::new(ElementId::from((SharedString::from("question-image"), ix)), IconName::Image01)
                                        .size(IconButtonSize::S24),
                                ),
                        )
                    }),
            );
        }

        let mut shell = div()
            .debug_selector(move || format!("question-card-{ix}"))
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .w_full()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line_strong)
            .bg(theme.surface);
        if several {
            let options: Vec<TabOption> = card
                .questions
                .iter()
                .enumerate()
                .map(|(n, q)| {
                    let option = TabOption::new(n.to_string(), answers::tab_label(q, n));
                    if answers::question_answered(q, &card.drafts) { option.icon(IconName::Tick02) } else { option }
                })
                .collect();
            let change = cx.listener(move |this, value: &SharedString, _window, cx| {
                if let (Some(mut card), Ok(active)) = (this.question_at(ix), value.parse::<usize>()) {
                    card.active = active.min(card.questions.len().saturating_sub(1));
                    this.replace_question(ix, card, true, cx);
                }
            });
            shell = shell.child(
                Tabs::new(ElementId::from((SharedString::from("question-tabs"), ix)), card.active.to_string(), options).on_change(change),
            );
        }
        let dismiss = cx.listener(move |this, _: &ClickEvent, _window, cx| {
            if let Some(mut card) = this.question_at(ix) {
                card.status = Status::Dismissed;
                this.replace_question(ix, card, true, cx);
            }
        });
        let advance = cx.listener(move |this, _: &ClickEvent, _window, cx| {
            if let Some(mut card) = this.question_at(ix) {
                card.advance();
                this.replace_question(ix, card, true, cx);
            }
        });
        let primary = match action {
            Primary::Next => "Next",
            Primary::Send if card.questions.len() == 1 => "Send answer",
            Primary::Send => "Send answers",
        };
        shell
            .child(body)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_end()
                    .gap_2()
                    .h(CONTROL_SM)
                    .child(
                        Button::new(ElementId::from((SharedString::from("question-dismiss"), ix)), "Dismiss")
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::S28)
                            .selector("question-dismiss")
                            .on_click(dismiss),
                    )
                    .child(
                        Button::new(ElementId::from((SharedString::from("question-send"), ix)), primary)
                            .size(ButtonSize::S28)
                            .selector("question-send")
                            .disabled(!ready)
                            .on_click(advance),
                    ),
            )
            .into_any_element()
    }
}

/// Builds the cards the data holds: one per question request.
pub fn from_requests(requests: &[QuestionRequest], waited: Option<SharedString>) -> Vec<QuestionCard> {
    requests.iter().filter(|r| r.secret_request.is_none() && r.bug_report.is_none()).map(|r| QuestionCard::new(r, waited.clone())).collect()
}

/// For tests: the map of `(item, question)` to field states.
pub type Inputs = HashMap<(usize, usize), Entity<InputState>>;
