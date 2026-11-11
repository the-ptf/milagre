//! The Commits view (`CommitHistory`, `CommitRow`, `CommitFiles`): the commits since the comparison base, each
//! with its message, author initials, date and totals; a click opens the commit (full message, SHA, its files),
//! and a file in it shows its diff under the list.

use gpui::{AnyElement, ClickEvent, ClipboardItem, Context, FontWeight, div, prelude::*, px};

use super::data::WorktreeChanges;
use super::files::{RowEnv, counts_inline};
use super::{ChangesView, files};
use crate::logic::diff::git::{CommitStats, GitCommit, commit_initials, commit_stats_notice};
use crate::theme::{RADIUS_CONTROL, TEXT_10, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{EmptySize, EmptyState, Icon, IconName, IconSize};

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Nov 10" for an ISO date (`toLocaleDateString` with a short month and a day).
pub fn short_date(iso: &str) -> String {
    let mut parts = iso.get(..10).unwrap_or("").split('-');
    let (_year, month, day) =
        (parts.next(), parts.next().and_then(|m| m.parse::<usize>().ok()), parts.next().and_then(|d| d.parse::<u32>().ok()));
    match (month, day) {
        (Some(month @ 1..=12), Some(day)) => format!("{} {day}", MONTHS[month - 1]),
        _ => iso.to_string(),
    }
}

/// "Nov 10, 2026, 16:42 UTC" for the opened commit's byline.
pub fn long_date(iso: &str) -> String {
    let year = iso.get(..4).unwrap_or("");
    let time = iso.get(11..16).unwrap_or("");
    format!("{}, {year}, {time} UTC", short_date(iso))
}

pub fn render(
    changes: &WorktreeChanges,
    open: Option<&str>,
    env: &RowEnv,
    theme: &Theme,
    cx: &mut Context<ChangesView>,
) -> Vec<AnyElement> {
    let history = &changes.history;
    if history.commits.is_empty() {
        let text = history.message.clone().unwrap_or_else(|| "No commits since the comparison branch.".to_string());
        return vec![EmptyState::new().size(EmptySize::Compact).icon(IconName::GitBranch).title(text).into_any_element()];
    }
    let mut out = Vec::new();
    for commit in &history.commits {
        let is_open = open == Some(commit.sha.as_str());
        out.push(commit_row(commit, is_open, theme, cx));
        if is_open {
            out.push(commit_detail(commit, changes, env, theme, cx));
        }
    }
    if history.has_more {
        out.push(div().w_full().p(px(8.0)).text_step(TEXT_12).text_color(theme.ink2).child("Show more commits").into_any_element());
    }
    out
}

fn commit_row(commit: &GitCommit, open: bool, theme: &Theme, cx: &mut Context<ChangesView>) -> AnyElement {
    let sha = commit.sha.clone();
    let hover = theme.hover;
    let id = format!("commit-{}", &commit.sha[..8.min(commit.sha.len())]);
    let selector = id.clone();
    let first_line = commit.message.lines().next().unwrap_or("").to_string();
    let totals = match commit.stats {
        CommitStats::Counts { files, added, removed } => div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .child(format!("{files} {}", if files == 1 { "file" } else { "files" }))
            .child(counts_inline(theme, added, removed))
            .into_any_element(),
        CommitStats::Unavailable(_) => div().flex_none().child("Totals unavailable").into_any_element(),
    };
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .flex()
        .flex_col()
        .gap(px(6.0))
        .w_full()
        .px(px(12.0))
        .py(px(10.0))
        .border_t_1()
        .border_color(theme.line)
        .cursor_pointer()
        .when(open, |el| el.bg(theme.hover2))
        .when(!open, |el| el.hover(move |style| style.bg(hover)))
        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.toggle_commit(&sha, cx)))
        .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink).line_clamp(2).child(first_line))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(16.0))
                        .rounded_full()
                        .bg(theme.hover2)
                        .text_step(TEXT_10)
                        .text_color(theme.ink2)
                        .child(commit_initials(&commit.author)),
                )
                .child(div().min_w_0().truncate().child(commit.author.clone()))
                .child(div().flex_none().child(short_date(&commit.date)))
                .child(div().flex().flex_1().min_w_0().justify_end().items_center().child(totals)),
        )
        .into_any_element()
}

fn commit_detail(commit: &GitCommit, changes: &WorktreeChanges, env: &RowEnv, theme: &Theme, cx: &mut Context<ChangesView>) -> AnyElement {
    let sha = commit.sha.clone();
    let files_of = changes.commit_files.get(&commit.sha);
    let list: Vec<AnyElement> = files_of.map(|repo| files::rows(&repo.files, env, cx)).unwrap_or_default();
    div()
        .debug_selector(|| "commit-detail".to_string())
        .flex()
        .flex_col()
        .gap(px(8.0))
        .w_full()
        .pb(px(10.0))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .mx(px(12.0))
                .pl(px(12.0))
                .border_l_2()
                .border_color(theme.line)
                .when_some(
                    match commit.stats {
                        CommitStats::Unavailable(reason) => Some(commit_stats_notice(reason)),
                        _ => None,
                    },
                    |el, notice| el.child(div().text_step(TEXT_11).text_color(theme.ink3).child(notice)),
                )
                .child(div().text_step(TEXT_12).text_color(theme.ink2).child(commit.message.clone()))
                .child(div().text_step(TEXT_11).text_color(theme.ink3).child(format!(
                    "{} <{}> · {}",
                    commit.author,
                    commit.email,
                    long_date(&commit.date)
                )))
                .child(
                    div()
                        .id("commit-copy-sha")
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(6.0))
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(RADIUS_CONTROL)
                        .bg(theme.field)
                        .font_family(mono())
                        .text_step(TEXT_11)
                        .text_color(theme.ink2)
                        .cursor_pointer()
                        .on_click(move |_, _window, cx| cx.write_to_clipboard(ClipboardItem::new_string(sha.clone())))
                        .child(commit.sha[..8.min(commit.sha.len())].to_string())
                        .child(Icon::new(IconName::Copy01).size(IconSize::S12).color(theme.ink2)),
                ),
        )
        .child(div().flex().flex_col().w_full().children(list))
        .into_any_element()
}
