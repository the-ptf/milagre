//! The Summary tab (`Summary`, `Section`, `CommentCard` in `PullRequestPanel.tsx`): reviewers and labels, then the
//! Description, Checks and Comments sections, each folding.

use gpui::{AnyElement, ClickEvent, Context, FontWeight, Window, div, prelude::*, px};

use super::avatar::avatar;
use super::model::{Check, Comment, Outcome, PullRequestDetail, Thread, ago, now_ms, open_threads};
use super::{PrView, Section, ViewState};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme, mono};
use crate::ui::markdown::{Markdown, base_extensions, open_with_system, text_view_style};
use crate::ui::{Icon, IconName, IconSize, SpinnerRing, motion};

/// The PR panel's text size (`text-12`).
const BODY: f32 = 12.0;

/// A folding section's header: what folds, its label, the count beside it and the action shown while open.
struct Head {
    section: Section,
    label: &'static str,
    meta: Option<String>,
    action: Option<AnyElement>,
}

/// One entry of the Comments section: a PR comment, or an open thread with its replies.
struct Item<'a> {
    thread: Option<&'a Thread>,
    comments: Vec<&'a Comment>,
}

impl Item<'_> {
    /// By the latest word in each.
    fn at(&self) -> i64 {
        self.comments.last().map_or(0, |comment| comment.created_at)
    }
}

/// The Comments section's entries in the order the sort asks for.
fn comment_items(pr: &PullRequestDetail, newest_first: bool) -> Vec<Item<'_>> {
    let mut items: Vec<Item> = open_threads(pr)
        .into_iter()
        .map(|thread| Item { thread: Some(thread), comments: thread.comments.iter().filter(|c| !c.pending).collect() })
        .collect();
    items.extend(pr.comments.iter().filter(|c| !c.pending).map(|comment| Item { thread: None, comments: vec![comment] }));
    items.sort_by_key(|item| if newest_first { -item.at() } else { item.at() });
    items
}

/// The glyph of a check and the colour it takes.
fn check_style(theme: &Theme, outcome: Outcome) -> (IconName, gpui::Rgba) {
    match outcome {
        Outcome::Pass => (IconName::CheckmarkCircle02, theme.green_ink),
        Outcome::Fail => (IconName::CancelCircle, theme.red_ink),
        Outcome::Running => (IconName::Circle, theme.orange_ink),
        Outcome::Skipped => (IconName::MinusSignCircle, theme.ink3),
        Outcome::Neutral => (IconName::Circle, theme.ink3),
    }
}

impl PrView {
    pub(super) fn summary(&self, pr: &PullRequestDetail, state: &ViewState, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let props = div().flex().flex_col().px(px(12.0)).py(px(8.0)).child(self.reviewers_row(pr, cx)).child(self.labels_row(pr, cx));
        let description = {
            let body: AnyElement = if pr.body.trim().is_empty() {
                div().text_color(theme.ink3).child("No description.").into_any_element()
            } else {
                self.markdown("description", &theme).unwrap_or_else(|| div().into_any_element())
            };
            self.section(
                Head { section: Section::Description, label: "Description", meta: None, action: None },
                state,
                div().text_step(TEXT_12).text_color(theme.ink2).child(body).into_any_element(),
                cx,
            )
        };
        let mut checks = pr.checks.clone();
        checks.sort_by_key(|check| check.outcome.order());
        let checks_body =
            div().flex().flex_col().gap(px(2.0)).children(checks.iter().enumerate().map(|(ix, check)| self.check_row(ix, check, &theme)));
        let checks = self.section(
            Head { section: Section::Checks, label: "Checks", meta: pr.checks.is_empty().then(|| "None".to_string()), action: None },
            state,
            checks_body.into_any_element(),
            cx,
        );
        let items = comment_items(pr, state.newest_first);
        let count = items.len();
        let sort = (count > 1).then(|| {
            let view = cx.entity();
            div()
                .id("pr-comments-sort")
                .debug_selector(|| "pr-comments-sort".to_string())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.0))
                .h(px(24.0))
                .px(px(4.0))
                .rounded(RADIUS_CHIP)
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .cursor_pointer()
                .hover(move |style| style.bg(theme.hover).text_color(theme.ink))
                .on_click(move |_: &ClickEvent, _, cx| view.update(cx, |this, cx| this.toggle_sort(cx)))
                .child(Icon::new(IconName::ArrowUpDown).size(IconSize::S12).color(theme.ink2))
                .child(if state.newest_first { "Newest first" } else { "Oldest first" })
                .into_any_element()
        });
        let comments_body: AnyElement = if items.is_empty() {
            div().px(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child("No comments yet.").into_any_element()
        } else {
            div().flex().flex_col().gap(px(8.0)).children(items.iter().map(|item| self.comment_card(item, &theme, cx))).into_any_element()
        };
        let comments = self.section(
            Head { section: Section::Comments, label: "Comments", meta: Some(count.to_string()), action: sort },
            state,
            comments_body,
            cx,
        );
        div()
            .flex()
            .flex_col()
            .child(props)
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            .child(div().flex().flex_col().px(px(8.0)).pt(px(6.0)).child(description).child(checks).child(comments))
            .into_any_element()
    }

    /// A parsed text of the PR (the description, a comment) as markdown at the panel's size.
    fn markdown(&self, key: &str, theme: &Theme) -> Option<AnyElement> {
        let state = self.texts.get(key)?;
        Some(Markdown::new(state, text_view_style(theme, BODY), base_extensions(), open_with_system()).size(BODY).into_any_element())
    }

    fn check_row(&self, ix: usize, check: &Check, theme: &Theme) -> AnyElement {
        let (icon, tone) = check_style(theme, check.outcome);
        let glyph: AnyElement = if check.outcome == Outcome::Running {
            let ring = SpinnerRing::new().size(13.0).color(tone);
            if motion() { ring.animated(("pr-check-ring", ix)).into_any_element() } else { ring.into_any_element() }
        } else {
            Icon::new(icon).size(IconSize::S14).color(tone).into_any_element()
        };
        let url = check.url.clone();
        let hover = theme.hover;
        let ink = theme.ink;
        div()
            .id(("pr-check", ix))
            .debug_selector({
                let name = format!("pr-check-{}", check.outcome.key());
                move || name.clone()
            })
            .flex()
            .items_center()
            .gap(px(8.0))
            .h(px(24.0))
            .px(px(4.0))
            .rounded(RADIUS_CHIP)
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .when(url.is_some(), |el| el.cursor_pointer().hover(move |style| style.bg(hover).text_color(ink)))
            .when_some(url.clone(), |el, url| el.on_click(move |_, _, cx| cx.open_url(&url)))
            .child(div().flex().flex_none().child(glyph))
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .children(check.workflow.as_ref().map(|workflow| div().text_color(theme.ink3).child(format!("{workflow} / "))))
                    .child(check.name.clone()),
            )
            .when(url.is_some(), |el| el.child(Icon::new(IconName::LinkSquare02).size(IconSize::S12).color(theme.ink3)))
            .into_any_element()
    }

    /// A folding section: chevron, label and meta in a 32px header, the body below when open.
    fn section(&self, head: Head, state: &ViewState, body: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        let Head { section, label, meta, action } = head;
        let theme = *cx.theme();
        let open = state.open.contains(&section);
        let view = cx.entity();
        let key = label.to_lowercase();
        let ink = theme.ink;
        div()
            .debug_selector({
                let name = format!("pr-section-{key}");
                move || name.clone()
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .h(px(32.0))
                    .px(px(4.0))
                    .child(
                        div()
                            .id(("pr-section-toggle", section as usize))
                            .debug_selector({
                                let name = format!("pr-section-toggle-{key}");
                                move || name.clone()
                            })
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(px(6.0))
                            .h_full()
                            .text_color(theme.ink2)
                            .cursor_pointer()
                            .hover(move |style| style.text_color(ink))
                            .on_click(move |_, _, cx| view.update(cx, |this, cx| this.toggle_section(section, cx)))
                            .child(
                                Icon::new(if open { IconName::ArrowDown01 } else { IconName::ArrowRight01 })
                                    .size(IconSize::S12)
                                    .color(theme.ink3),
                            )
                            .child(div().flex_none().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(label))
                            .children(meta.map(|meta| div().min_w_0().truncate().text_step(TEXT_12).text_color(theme.ink3).child(meta))),
                    )
                    .children(action.filter(|_| open)),
            )
            .when(open, |el| el.child(div().px(px(4.0)).pb(px(12.0)).child(body)))
            .into_any_element()
    }

    /// A comment on the PR, or an open thread on a line with its replies; the thread's place opens the file's diff.
    fn comment_card(&self, item: &Item, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let now = now_ms();
        let first_id = item.comments.first().map(|c| c.id.clone()).unwrap_or_default();
        let selector = match item.thread {
            Some(thread) => format!("pr-open-thread-{}", thread.id),
            None => format!("pr-comment-{first_id}"),
        };
        let theme = *theme;
        div()
            .debug_selector(move || selector.clone())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .p(px(12.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.inset)
            .children(item.comments.iter().enumerate().map(|(index, comment)| {
                let place = (index == 0).then_some(item.thread).flatten().map(|thread| {
                    let view = cx.entity();
                    let path = thread.path.clone();
                    let text = match thread.line {
                        Some(line) => format!("{}:{line}", thread.path),
                        None => thread.path.clone(),
                    };
                    div()
                        .id(("pr-thread-path", index))
                        .debug_selector(|| "pr-thread-path".to_string())
                        .min_w_0()
                        .truncate()
                        .font_family(mono())
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.ink))
                        .on_click(move |_, _, cx| view.update(cx, |this, cx| this.open_file(&path, cx)))
                        .child(text)
                });
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .when(index > 0, |el| el.border_t_1().border_color(theme.line).pt(px(8.0)))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_center()
                            .gap(px(6.0))
                            .child(avatar(&theme, &comment.author, 20.0, false))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_step(TEXT_12)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(comment.author.clone()),
                            )
                            .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(ago(comment.created_at, now))),
                    )
                    .children(place)
                    .child(div().text_step(TEXT_12).text_color(theme.ink).children(self.markdown(&comment.id, &theme)))
            }))
            .into_any_element()
    }
}
