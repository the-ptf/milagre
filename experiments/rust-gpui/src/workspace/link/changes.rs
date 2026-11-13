//! The Link's Changes panel (`changes/LinkChangesPanel.tsx`): one section per member Worktree (the Project's avatar,
//! name, branch and line counts over its Uncommitted and Committed files), collapsible, and a row for each Project the
//! Chat has no Worktree in yet. A file picked belongs to its member: the panel keeps which one, so the diff (WP-31)
//! opens that Worktree's file.

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, SharedString, div, prelude::*, px};

use super::LinkWorkspace;
use super::fixture::{ChangedFile, LinkChat, Member, PENDING_WORKTREE_TEXT};
use crate::theme::{ActiveTheme, RADIUS_CHIP, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, SectionLabel};

/// The panel's width (`--changes-panel-width`, 320).
pub const PANEL_WIDTH: f32 = 320.0;

/// Which list a file was picked from (`DiffMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Uncommitted,
    Committed,
}

/// The file the diff shows: its member Project, its list and its path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picked {
    pub project_id: &'static str,
    pub mode: Mode,
    pub path: &'static str,
}

/// The Changes tab's count: every member's files.
pub fn changed_count(chat: &LinkChat) -> usize {
    chat.members.iter().map(Member::file_count).sum()
}

fn counts(added: u32, removed: u32, theme: &Theme) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .gap_1()
        .text_step(TEXT_11)
        .font_family(crate::theme::MONO)
        .child(div().text_color(theme.green_ink).child(format!("+{added}")))
        .child(div().text_color(theme.red_ink).child(format!("\u{2212}{removed}")))
}

impl LinkWorkspace {
    pub(super) fn changes_panel(&self, chat: &LinkChat, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let count = changed_count(chat);
        let tabs = div().flex().flex_none().items_center().gap_1().px_3().py_2().border_b_1().border_color(theme.line).child(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .h(px(28.0))
                .px_2()
                .rounded(RADIUS_CHIP)
                .bg(theme.hover)
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .child("Changes")
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(count.to_string())),
        );
        let pending = self.link.projects.iter().filter(|project| !chat.members.iter().any(|member| member.project_id == project.id));
        let body = div()
            .id("link-changes-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .py_1p5()
            .children(chat.members.iter().map(|member| self.member_section(member, cx)))
            .children(pending.map(|project| {
                let selector = format!("link-changes-pending-{}", project.id);
                div()
                    .debug_selector(move || selector.clone())
                    .mx_2()
                    .mt_1()
                    .py_1()
                    .pl_4()
                    .flex()
                    .items_start()
                    .gap_1p5()
                    .min_w_0()
                    .child(ProjectAvatar::new(project.name).size(16.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                div()
                                    .truncate()
                                    .text_step(TEXT_12)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child(project.name),
                            )
                            .child(div().text_step(TEXT_11).text_color(theme.ink3).child(PENDING_WORKTREE_TEXT)),
                    )
            }));
        div()
            .id("link-changes")
            .debug_selector(|| "link-changes".into())
            .flex()
            .flex_col()
            .flex_none()
            .w(px(PANEL_WIDTH))
            .h_full()
            .border_l_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .pt(crate::theme::HEADER_HEIGHT)
            .child(tabs)
            .child(body)
            .into_any_element()
    }

    fn member_section(&self, member: &Member, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let name = self.link.project(member.project_id).map_or(member.project_id, |project| project.name);
        let collapsed = self.collapsed.contains(member.project_id);
        let (added, removed) = member.counts();
        let id = member.project_id;
        let selector = format!("link-changes-project-{id}");
        let header = div()
            .id(ElementId::from(SharedString::from(format!("link-project-header-{id}"))))
            .debug_selector({
                let selector = format!("link-project-header-{id}");
                move || selector.clone()
            })
            .mx_2()
            .mt_1()
            .py_1()
            .pl_1()
            .pr_1()
            .flex()
            .items_center()
            .gap_1p5()
            .min_w_0()
            .rounded(RADIUS_CHIP)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_member(id, cx)))
            .child(Icon::new(if collapsed { IconName::ArrowRight01 } else { IconName::ArrowDown01 }).size(IconSize::S12).color(theme.ink3))
            .child(ProjectAvatar::new(name).size(16.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().truncate().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(name))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .min_w_0()
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .child(Icon::new(IconName::GitBranch).size(IconSize::S12).color(theme.ink3))
                            .child(div().truncate().child(member.branch)),
                    ),
            )
            .child(counts(added, removed, &theme));
        let lists = (!collapsed).then(|| {
            let section = |label: &'static str, mode: Mode, files: &[ChangedFile], cx: &mut Context<Self>| {
                (!files.is_empty()).then(|| {
                    div()
                        .flex()
                        .flex_col()
                        .child(div().px_2().pt_2().pb_1().child(SectionLabel::new(label)))
                        .children(files.iter().map(|file| self.file_row(member, mode, file, cx)))
                })
            };
            div().pl_5().flex().flex_col().children(section("Uncommitted", Mode::Uncommitted, &member.uncommitted, cx)).children(section(
                "Committed",
                Mode::Committed,
                &member.committed,
                cx,
            ))
        });
        div().debug_selector(move || selector.clone()).pb_2().child(header).children(lists).into_any_element()
    }

    fn file_row(&self, member: &Member, mode: Mode, file: &ChangedFile, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let picked = Picked { project_id: member.project_id, mode, path: file.path };
        let active = self.picked.as_ref() == Some(&picked);
        let (dir, name) = match file.path.rsplit_once('/') {
            Some((dir, name)) => (dir, name),
            None => ("", file.path),
        };
        let selector = format!("link-file-{}-{}", member.project_id, file.path);
        div()
            .id(ElementId::from(SharedString::from(selector.clone())))
            .debug_selector(move || selector.clone())
            .mx_2()
            .h(px(28.0))
            .px_2()
            .flex()
            .items_center()
            .gap_1p5()
            .min_w_0()
            .rounded(RADIUS_CHIP)
            .text_step(TEXT_12)
            .cursor_pointer()
            .when(active, |el| el.bg(theme.hover2))
            .hover(move |style| style.bg(theme.hover))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.pick_file(picked.clone(), cx)))
            .child(div().flex_none().text_color(theme.ink).child(name))
            .child(div().flex_1().min_w_0().truncate().text_color(theme.ink3).child(dir))
            .child(counts(file.added, file.removed, &theme))
            .into_any_element()
    }
}
