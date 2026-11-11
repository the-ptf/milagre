//! The PR's review (`PullRequestReview.tsx`, `usePrReviewActions.ts`): GitHub's threads on the picked file, with
//! Reply (added to the viewer's pending review), Resolve and Fix in Chat, and the bar that submits the review with a
//! verdict and an optional summary.
//!
//! The desktop draws a thread under its line in the diff (WP-31); here the picked file's threads gather in a strip
//! above its diff, which is where the desktop puts the ones no row carries (outdated, or outside the hunks). The bar
//! floats over the diff's bottom edge, as it does there, but picks its verdict with the segmented control rather
//! than a select, because a select's menu would open below the window.

use std::collections::HashMap;

use gpui::{AnyElement, ClickEvent, Context, FontWeight, SharedString, Window, div, prelude::*, px};

use super::avatar::avatar;
use super::bridge::Write;
use super::model::{PullRequestDetail, ReviewEvent, Thread, ThreadState, age, now_ms, thread_fix_message, thread_state};
use super::{PrEvent, PrView};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, IconButton, IconButtonSize, IconName, InlineError, Segmented, SegmentedOption, TextArea,
};

/// What the review UI keeps: the bar's form and which thread is being replied to.
#[derive(Clone, Debug)]
pub struct ReviewForm {
    pub open: bool,
    pub event: ReviewEvent,
    pub replying: Option<String>,
    /// Threads folded or unfolded against their default (resolved and outdated ones start folded).
    pub folded: HashMap<String, bool>,
}

impl Default for ReviewForm {
    fn default() -> Self {
        Self { open: false, event: ReviewEvent::Comment, replying: None, folded: HashMap::new() }
    }
}

fn state_tone(theme: &Theme, state: ThreadState) -> gpui::Rgba {
    match state {
        ThreadState::Open => theme.orange_ink,
        ThreadState::Pending => theme.accent_ink,
        ThreadState::Resolved | ThreadState::Outdated => theme.ink3,
    }
}

/// A text area's state kept by the window under `key`, made when first asked for.
fn keyed_textarea(
    key: String,
    placeholder: &'static str,
    rows: (usize, usize),
    window: &mut Window,
    cx: &mut gpui::App,
) -> gpui::Entity<gpui_component::input::TextareaState> {
    window.use_keyed_state(SharedString::from(key), cx, |window, cx| TextArea::state(placeholder, rows, window, cx)).read(cx).clone()
}

impl PrView {
    pub fn replying(&self) -> Option<&str> {
        self.review.replying.as_deref()
    }

    pub fn review_open(&self) -> bool {
        self.review.open
    }

    pub fn review_event(&self) -> ReviewEvent {
        self.review.event
    }

    pub fn toggle_review(&mut self, cx: &mut Context<Self>) {
        self.review.open = !self.review.open;
        cx.notify();
    }

    pub fn set_review_event(&mut self, event: ReviewEvent, cx: &mut Context<Self>) {
        self.review.event = event;
        cx.notify();
    }

    pub fn start_reply(&mut self, thread: Option<String>, cx: &mut Context<Self>) {
        self.review.replying = thread;
        cx.notify();
    }

    /// A thread is folded when the user said so, else when it is resolved or outdated.
    pub fn is_thread_folded(&self, thread: &Thread) -> bool {
        self.review.folded.get(&thread.id).copied().unwrap_or(matches!(thread_state(thread), ThreadState::Resolved | ThreadState::Outdated))
    }

    pub fn toggle_thread(&mut self, thread: &Thread, cx: &mut Context<Self>) {
        let folded = self.is_thread_folded(thread);
        self.review.folded.insert(thread.id.clone(), !folded);
        cx.notify();
    }

    pub fn reply(&mut self, thread: &str, body: &str, cx: &mut Context<Self>) -> bool {
        let body = body.trim();
        if body.is_empty() {
            return false;
        }
        let ok = self.write("reply", Write::Reply { thread: thread.to_string(), body: body.to_string() }, cx);
        if ok {
            self.review.replying = None;
            cx.notify();
        }
        ok
    }

    pub fn resolve(&mut self, thread: &str, resolved: bool, cx: &mut Context<Self>) {
        self.write("resolve", Write::Resolve { thread: thread.to_string(), resolved }, cx);
    }

    pub fn delete_comment(&mut self, id: &str, cx: &mut Context<Self>) {
        self.write("delete", Write::DeleteComment { id: id.to_string() }, cx);
    }

    /// "Fix in Chat": the thread, where it sits and the ask, for the Chat's composer.
    pub fn fix_in_chat(&mut self, thread: &Thread, cx: &mut Context<Self>) {
        let Some(pr) = &self.detail else { return };
        let message = thread_fix_message(pr.number, thread);
        self.close_file(cx);
        cx.emit(PrEvent::FixInChat(message));
    }

    /// The strip of the picked file's threads above its diff.
    pub(super) fn thread_cards(
        &self,
        pr: &PullRequestDetail,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = *cx.theme();
        let threads: Vec<&Thread> = pr.threads.iter().filter(|thread| thread.path == path).collect();
        if threads.is_empty() {
            return None;
        }
        let cards: Vec<AnyElement> = threads.into_iter().map(|thread| self.thread_card(thread, &theme, window, cx)).collect();
        Some(
            div()
                .id("pr-threads")
                .debug_selector(|| "pr-threads".to_string())
                .flex()
                .flex_col()
                .flex_none()
                .gap(px(8.0))
                .max_h(px(260.0))
                .overflow_y_scroll()
                .p(px(12.0))
                .border_b_1()
                .border_color(theme.line)
                .children(cards)
                .into_any_element(),
        )
    }

    fn thread_card(&self, thread: &Thread, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let now = now_ms();
        let state = thread_state(thread);
        let folded = self.is_thread_folded(thread);
        let replying = self.review.replying.as_deref() == Some(thread.id.as_str());
        let view = cx.entity();
        let first = thread.comments.first();
        let header = {
            let (view, owned) = (view.clone(), thread.clone());
            div()
                .id(SharedString::from(format!("pr-thread-head-{}", thread.id)))
                .debug_selector({
                    let key = format!("pr-thread-head-{}", thread.id);
                    move || key.clone()
                })
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_step(TEXT_12)
                .cursor_pointer()
                .on_click(move |_: &ClickEvent, _, cx| {
                    let thread = owned.clone();
                    view.update(cx, |this, cx| this.toggle_thread(&thread, cx));
                })
                .children(first.map(|c| avatar(&theme, &c.author, 20.0, false)))
                .child(div().font_weight(FontWeight::MEDIUM).child(first.map(|c| c.author.clone()).unwrap_or_default()))
                .child(div().text_color(theme.ink3).child(first.and_then(|c| age(c.created_at, now)).unwrap_or_default()))
                .when(thread.comments.len() > 1, |el| {
                    el.child(div().text_color(theme.ink3).child(format!("\u{b7} {} comments", thread.comments.len())))
                })
                .child(div().flex_1())
                .child(div().font_weight(FontWeight::MEDIUM).text_color(state_tone(&theme, state)).child(state.label()))
        };
        let comments = (!folded).then(|| {
            thread.comments.iter().enumerate().map(|(ix, comment)| {
                let id = comment.id.clone();
                let view = view.clone();
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .when(ix > 0, |el| {
                                el.child(
                                    div()
                                        .flex()
                                        .gap(px(8.0))
                                        .mb(px(2.0))
                                        .text_step(crate::theme::TEXT_11)
                                        .text_color(theme.ink3)
                                        .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(comment.author.clone()))
                                        .child(age(comment.created_at, now).unwrap_or_default())
                                        .when(comment.pending, |el| el.child(div().text_color(theme.accent_ink).child("Pending"))),
                                )
                            })
                            .child(div().text_step(TEXT_12).text_color(theme.ink).child(comment.body.clone())),
                    )
                    .when(comment.pending, |el| {
                        el.child(
                            IconButton::new(SharedString::from(format!("pr-comment-delete-{id}")), IconName::Delete02)
                                .size(IconButtonSize::S24)
                                .on_click(move |_, _, cx| {
                                    let id = id.clone();
                                    view.update(cx, |this, cx| this.delete_comment(&id, cx));
                                }),
                        )
                    })
            })
        });
        let field = (!folded && replying).then(|| {
            let state = keyed_textarea(format!("pr-reply-state-{}", thread.id), "Reply", (2, 5), window, cx);
            TextArea::new(format!("pr-reply-{}", thread.id), &state)
        });
        let actions = (!folded).then(|| {
            let tid = thread.id.clone();
            let resolved = thread.resolved;
            let mut row = div().flex().items_center().gap(px(8.0));
            if state != ThreadState::Pending {
                let (view_a, tid_a) = (view.clone(), tid.clone());
                row = row.child(if replying {
                    let state = keyed_textarea(format!("pr-reply-state-{}", thread.id), "Reply", (2, 5), window, cx);
                    Button::new(format!("pr-reply-send-{tid}"), "Add to review")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .selector("pr-reply-send")
                        .on_click(move |_, window, cx| {
                            let body = state.read(cx).value().to_string();
                            let sent = view_a.update(cx, |this, cx| this.reply(&tid_a, &body, cx));
                            if sent {
                                state.update(cx, |state, cx| state.set_value("", window, cx));
                            }
                        })
                } else {
                    Button::new(format!("pr-reply-{tid}"), "Reply")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .selector("pr-reply")
                        .on_click(move |_, _, cx| view_a.update(cx, |this, cx| this.start_reply(Some(tid_a.clone()), cx)))
                });
                let (view_b, tid_b) = (view.clone(), tid.clone());
                row = row.child(
                    Button::new(format!("pr-resolve-{tid}"), if resolved { "Unresolve" } else { "Resolve" })
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .selector("pr-resolve")
                        .on_click(move |_, _, cx| view_b.update(cx, |this, cx| this.resolve(&tid_b, !resolved, cx))),
                );
            }
            row = row.child(div().flex_1());
            if state == ThreadState::Open {
                let (view_c, thread_c) = (view.clone(), thread.clone());
                row = row.child(
                    Button::new(format!("pr-fix-{tid}"), "Fix in Chat")
                        .variant(ButtonVariant::Link)
                        .size(ButtonSize::S28)
                        .icon(IconName::Sparkles)
                        .selector("pr-fix")
                        .on_click(move |_, _, cx| view_c.update(cx, |this, cx| this.fix_in_chat(&thread_c, cx))),
                );
            }
            row
        });
        div()
            .debug_selector({
                let key = format!("pr-thread-{}", thread.id);
                move || key.clone()
            })
            .flex()
            .flex_col()
            .gap(px(8.0))
            .p(px(12.0))
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(theme.line)
            .bg(theme.inset)
            .child(header)
            .children(comments.into_iter().flatten())
            .children(field)
            .children(actions)
            .into_any_element()
    }

    /// Under the PR's diff: what the review holds so far, and Submit review with a verdict and an optional summary.
    pub(super) fn review_bar(&self, pr: &PullRequestDetail, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let pending = pr.pending_review.unwrap_or(0);
        let open = self.review.open;
        let event = self.review.event;
        // GitHub does not let a PR's author approve or request changes on it.
        let verdicts: Vec<ReviewEvent> = if pr.viewer_is_author { vec![ReviewEvent::Comment] } else { ReviewEvent::ALL.to_vec() };
        let summary = if pending > 0 { format!("{pending} pending") } else { "Nothing pending".to_string() };
        let form = open.then(|| {
            let body = keyed_textarea("pr-review-body-state".to_string(), "Leave a summary (optional)", (3, 6), window, cx);
            let (view_pick, view_submit) = (view.clone(), view.clone());
            let body_submit = body.clone();
            let blocked = event == ReviewEvent::Comment && pending == 0;
            div()
                .debug_selector(|| "pr-review-form".to_string())
                .flex()
                .flex_col()
                .gap(px(8.0))
                .p(px(12.0))
                .border_b_1()
                .border_color(theme.line)
                .child(TextArea::new("pr-review-body", &body))
                .child(
                    Segmented::new(
                        "pr-review-verdict",
                        Some(event.key()),
                        verdicts.iter().map(|verdict| SegmentedOption::new(verdict.key(), verdict.label())),
                    )
                    .on_change(move |value, _, cx| {
                        if let Some(next) = ReviewEvent::ALL.into_iter().find(|e| e.key() == value.as_ref()) {
                            view_pick.update(cx, |this, cx| this.set_review_event(next, cx));
                        }
                    }),
                )
                .child(div().flex().justify_end().child(
                    Button::new("pr-review-submit", "Submit").size(ButtonSize::S32).selector("pr-review-submit").on_click(
                        move |_, window, cx| {
                            let text = body_submit.read(cx).value().to_string();
                            if blocked && text.trim().is_empty() {
                                return;
                            }
                            let ok = view_submit.update(cx, |this, cx| {
                                let event = this.review.event;
                                this.submit_review(event, text, cx)
                            });
                            if ok {
                                body_submit.update(cx, |state, cx| state.set_value("", window, cx));
                                view_submit.update(cx, |this, cx| {
                                    this.review.open = false;
                                    cx.notify();
                                });
                            }
                        },
                    ),
                ))
                .children(self.write_error.as_ref().map(|message| InlineError::new(message.clone()).small()))
        });
        let toggle = view.clone();
        div()
            .absolute()
            .bottom(px(16.0))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .px(px(12.0))
            .child(
                div()
                    .debug_selector(|| "pr-review-bar".to_string())
                    .flex()
                    .flex_col()
                    .w_full()
                    .max_w(px(440.0))
                    .overflow_hidden()
                    .rounded(RADIUS_WINDOW)
                    .bg(theme.surface)
                    .shadow(theme.shadow_raised())
                    .children(form)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .h(px(44.0))
                            .pl(px(16.0))
                            .pr(px(6.0))
                            .when(pending > 0, |el| el.child(div().flex_none().size(px(8.0)).rounded_full().bg(theme.accent)))
                            .child(
                                div()
                                    .debug_selector(|| "pr-review-summary".to_string())
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .text_step(TEXT_13)
                                    .text_color(theme.ink2)
                                    .child(summary),
                            )
                            .child(
                                Button::new("pr-review-open", "Submit review")
                                    .pill()
                                    .size(ButtonSize::S32)
                                    .selector("pr-review-open")
                                    .on_click(move |_, _, cx| toggle.update(cx, |this, cx| this.toggle_review(cx))),
                            ),
                    ),
            )
            .into_any_element()
    }
}
