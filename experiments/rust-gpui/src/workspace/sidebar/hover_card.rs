//! The row's hover card (`ChatHoverCard` in `components/sidebar/ChatRow.tsx`): after the pointer rests 150ms on a
//! row, a 256px card opens beside the sidebar with everything the row cannot say — state, PRs, diff, branch,
//! Linear issue, folder, Links — read from the Project state already held, so it never waits on git. It stays
//! while the pointer is on it (a 250ms grace to cross over) and opens upwards for rows low in the window.
//!
//! [`CardModel::build`] is the data (testable); [`render`] draws it.

use std::time::Duration;

use gpui::{Anchor, AnyElement, App, Bounds, FontWeight, Pixels, Point, Window, anchored, deferred, div, point, prelude::*, px};

use super::SIDEBAR_WIDTH;
use super::list::SidebarData;
use super::row::{ChatRow, RowMeta, status_mark};
use crate::data::{PrState, PullRequest};
use crate::logic::lists::order::format_line_count;
use crate::logic::marks::{ChatMark, chat_mark_presentation};
use crate::logic::prs::blockers::row_pull_requests;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize};

/// How long the pointer rests on a row before the card opens (`HOVER_CARD_DELAY`).
pub const OPEN_DELAY: Duration = Duration::from_millis(150);
/// Time to cross from the row to the card before it closes (`HOVER_CARD_GRACE`).
pub const CLOSE_GRACE: Duration = Duration::from_millis(250);
pub const CARD_WIDTH: f32 = 256.0;
/// Rows this close to the window's bottom open the card upwards.
const FLIP_ZONE: f32 = 240.0;

#[derive(Clone, Debug, PartialEq)]
pub struct CardPr {
    pub number: Option<u32>,
    pub title: String,
    pub state: PrState,
    pub ready: bool,
    pub blocked: bool,
    /// Its page on GitHub: a click opens it in the browser and closes the card.
    pub url: String,
}

/// What the card says about a Chat.
#[derive(Clone, Debug, PartialEq)]
pub struct CardModel {
    pub title: String,
    /// "Running", "Needs approval", "Last turn failed": none for an idle Chat.
    pub status: Option<String>,
    pub prs: Vec<CardPr>,
    pub diff: Option<(u64, u64)>,
    pub branch: Option<String>,
    pub linear: Option<String>,
    /// The Worktree's folder name.
    pub folder: Option<String>,
    /// The Chats and Projects this Chat's Worktree is Linked with on the canvas.
    pub linked: Vec<String>,
}

impl CardModel {
    pub fn build(row: &ChatRow, meta: RowMeta, data: &SidebarData, linked: Vec<String>) -> Self {
        let scope = &data.scopes[meta.scope];
        let chat = scope.state.sessions.get(&meta.id);
        let worktree = chat.and_then(|chat| scope.state.worktree_of(chat));
        let status = match row.mark {
            ChatMark::Idle if row.failed => Some("Last turn failed".to_owned()),
            ChatMark::Idle => None,
            ChatMark::Background if row.background > 0 => Some(format!("{} in the background", row.background)),
            mark => Some(chat_mark_presentation(mark).label.to_owned()),
        };
        let prs = chat
            .map(|chat| {
                let folder = worktree.map(|worktree| worktree.path.clone()).unwrap_or_default();
                let refs = chat.summary.as_ref().map(|summary| summary.pull_requests.clone()).unwrap_or_default();
                row_pull_requests(&scope.pull_requests.chat_pull_requests(&folder, &refs))
            })
            .unwrap_or_default()
            .into_iter()
            .map(|pr: PullRequest| CardPr {
                number: pr.number,
                blocked: !crate::logic::prs::blockers::pull_request_blockers(Some(&pr)).is_empty(),
                ready: pr.ready_to_merge,
                state: pr.state,
                url: pr.url,
                title: pr.title,
            })
            .collect();
        let path = worktree.map(|worktree| worktree.path.to_string());
        Self {
            title: row.title.to_string(),
            status,
            prs,
            diff: worktree.and_then(|worktree| worktree.diff.as_ref()).map(|diff| (diff.added, diff.removed)),
            branch: worktree.map(|worktree| worktree.name.to_string()).filter(|_| !scope.project.is_chats_home()),
            linear: worktree.and_then(|worktree| worktree.linear_issue.as_ref()).map(ToString::to_string),
            folder: path.filter(|_| !scope.project.is_chats_home()).map(|path| path.rsplit('/').next().unwrap_or(&path).to_owned()),
            linked,
        }
    }
}

/// Where the card sits: 8px right of the sidebar, its top 4px above the row; for a row low in the window its bottom
/// 4px under the row instead.
pub fn placement(row: Bounds<Pixels>, window_height: Pixels) -> (Anchor, Point<Pixels>) {
    let x = px(SIDEBAR_WIDTH + 8.0);
    if row.top() > window_height - px(FLIP_ZONE) {
        (Anchor::BottomLeft, point(x, row.bottom() + px(4.0)))
    } else {
        (Anchor::TopLeft, point(x, row.top() - px(4.0)))
    }
}

fn pr_tone(pr: &CardPr, theme: &Theme) -> gpui::Rgba {
    match pr.state {
        PrState::Merged => theme.purple_ink,
        PrState::Closed => theme.red_ink,
        _ if pr.blocked => theme.orange_ink,
        _ => theme.green_ink,
    }
}

fn line<I: IntoElement + 'static, C: IntoElement + 'static>(icon: I, content: C, theme: &Theme) -> impl IntoElement + use<I, C> {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).text_color(theme.ink3).child(icon))
        .child(div().flex().flex_1().min_w_0().child(content))
}

/// Draws the card for `row`. `on_hover` is told when the pointer is on the card (it keeps the card open).
pub fn render(
    model: &CardModel,
    row: &ChatRow,
    at: Bounds<Pixels>,
    window: &Window,
    cx: &App,
    on_hover: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let theme = *cx.theme();
    let (anchor, position) = placement(at, window.viewport_size().height);
    let glyph = |name: IconName| Icon::new(name).size(IconSize::S14).color(theme.ink3);
    let mut body = div().flex().flex_col().gap(px(6.0)).mt(px(8.0)).text_step(TEXT_12).text_color(theme.ink2);
    if let Some(status) = &model.status {
        let tone = match row.mark {
            ChatMark::Question | ChatMark::Waiting | ChatMark::Interrupted => theme.orange_ink,
            ChatMark::Idle => theme.red_ink,
            ChatMark::Running | ChatMark::Background | ChatMark::Delegated | ChatMark::Unread => theme.accent_ink,
            ChatMark::Failed => theme.red_ink,
        };
        body = body.child(div().debug_selector(|| "hover-card-status".into()).child(line(
            status_mark(100_000, row, &theme),
            div().text_color(tone).child(status.clone()),
            &theme,
        )));
    }
    if !model.prs.is_empty() {
        body = body.child(
            div().id("hover-card-prs").flex().flex_col().gap(px(2.0)).mx(px(-4.0)).max_h(px(148.0)).overflow_y_scroll().children(
                model.prs.iter().enumerate().map(|(ix, pr)| {
                    let tone = pr_tone(pr, &theme);
                    let hover = theme.hover;
                    let url = pr.url.clone();
                    div()
                        .id(("hover-card-pr", ix))
                        .debug_selector(move || format!("hover-card-pr-{ix}"))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .min_w_0()
                        .px(px(4.0))
                        .py(px(2.0))
                        .rounded(RADIUS_INLINE)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                        .when(!url.is_empty(), |el| el.on_click(move |_, _, cx| cx.open_url(&url)))
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .size(px(16.0))
                                .items_center()
                                .justify_center()
                                .child(Icon::new(IconName::GitPullRequest).size(IconSize::S14).color(tone)),
                        )
                        .child(div().flex_1().min_w_0().truncate().child(match (pr.number, pr.title.is_empty()) {
                            (Some(n), true) => format!("#{n}"),
                            (Some(n), false) => format!("#{n} · {}", pr.title),
                            (None, _) => pr.title.clone(),
                        }))
                        .when(pr.ready, |el| el.child(div().flex_none().text_color(theme.green_ink).child("Ready to merge")))
                }),
            ),
        );
    }
    if let Some((added, removed)) = model.diff {
        body = body.child(line(
            glyph(IconName::FileEdit),
            if added == 0 && removed == 0 {
                div().text_color(theme.ink3).child("No changes").into_any_element()
            } else {
                div()
                    .flex()
                    .gap(px(4.0))
                    .child(div().text_color(theme.green_ink).child(format!("+{}", format_line_count(added as f64))))
                    .child(div().text_color(theme.red_ink).child(format!("−{}", format_line_count(removed as f64))))
                    .into_any_element()
            },
            &theme,
        ));
    }
    if let Some(branch) = &model.branch {
        body = body.child(line(glyph(IconName::GitBranch), div().truncate().child(branch.clone()), &theme));
    }
    if let Some(issue) = &model.linear {
        body = body.child(line(glyph(IconName::Link04), div().truncate().child(issue.clone()), &theme));
    }
    if let Some(folder) = &model.folder {
        body = body.child(line(glyph(IconName::Folder01), div().truncate().child(folder.clone()), &theme));
    }
    if !model.linked.is_empty() {
        body = body.child(
            div().debug_selector(|| "hover-card-links".into()).child(line(
                glyph(IconName::Link04),
                div()
                    .flex()
                    .flex_col()
                    .child(div().text_step(TEXT_11).text_color(theme.ink3).child("Linked with"))
                    .children(model.linked.iter().map(|label| div().truncate().child(label.clone()))),
                &theme,
            )),
        );
    }
    deferred(
        anchored().position(position).anchor(anchor).child(
            div()
                .id("hover-card")
                .debug_selector(|| "hover-card".into())
                .occlude()
                .w(px(CARD_WIDTH))
                .p(px(12.0))
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .on_hover(move |hovered, window, cx| on_hover(*hovered, window, cx))
                .child(
                    div()
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.ink)
                        .line_clamp(3)
                        .child(model.title.clone()),
                )
                .child(body),
        ),
    )
    .with_priority(1)
    .into_any_element()
}
