//! The Details tab's sections and rows.

use gpui::{AnyElement, Context, Div, FontWeight, Rgba, SharedString, Stateful, div, prelude::*, px};

use super::data::{self, AgentInfo, middle_truncate};
use super::family::SubchatRow;
use super::{BRANCH_CHARS, DetailsView, PAD_X, PATH_CHARS, ROW_HEIGHT, Request, on};
use crate::logic::activity::subchat_states::SubchatKind;
use crate::theme::{RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, SectionLabel, Spinner, Tooltip};
use crate::workspace::chat::composer::context::{BUTTON_THRESHOLD, bar_at};
use crate::workspace::chat::pills::data::AgentStatus;

/// The context bar's width: the narrowest panel's column.
const CONTEXT_BAR: f32 = 248.0;
const INDENT: f32 = 16.0;

fn heading(theme: &Theme, text: &'static str) -> AnyElement {
    div().flex_none().px(px(PAD_X)).pt(px(12.0)).pb(px(4.0)).child(SectionLabel::new(text)).text_color(theme.ink3).into_any_element()
}

/// A collapsible section's heading: the muted label and a chevron, the whole row toggles.
fn toggle_heading(
    theme: &Theme,
    id: &'static str,
    text: &'static str,
    open: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .debug_selector(move || id.to_string())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.0))
        .w_full()
        .px(px(PAD_X))
        .pt(px(12.0))
        .pb(px(4.0))
        .text_color(theme.ink3)
        .cursor_pointer()
        .on_click(on_click)
        .child(SectionLabel::new(text))
        .child(chevron(theme, open))
        .into_any_element()
}

fn glyph(theme: &Theme, name: IconName) -> AnyElement {
    Icon::new(name).size(IconSize::S16).color(theme.ink3).into_any_element()
}

fn value(theme: &Theme, text: impl Into<SharedString>, color: Option<Rgba>) -> AnyElement {
    div().flex_none().text_step(TEXT_12).text_color(color.unwrap_or(theme.ink3)).child(text.into()).into_any_element()
}

/// A row: leading glyph, label (cut with an ellipsis), trailing value.
fn line(
    theme: &Theme,
    id: impl Into<SharedString>,
    lead: AnyElement,
    label: impl Into<SharedString>,
    trailing: Vec<AnyElement>,
) -> Stateful<Div> {
    let id: SharedString = id.into();
    let selector = id.clone();
    div()
        .id(id)
        .debug_selector(move || selector.to_string())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(ROW_HEIGHT))
        .px(px(PAD_X))
        .text_step(TEXT_13)
        .text_color(theme.ink2)
        .child(lead)
        .child(div().flex_1().min_w_0().truncate().child(label.into()))
        .children(trailing)
}

fn clickable(
    row: Stateful<Div>,
    theme: &Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    let hover = theme.hover2;
    row.cursor_pointer().hover(move |style| style.bg(hover)).on_click(on_click)
}

fn chevron(theme: &Theme, open: bool) -> AnyElement {
    Icon::new(if open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S14).color(theme.ink3).into_any_element()
}

fn state_mark(theme: &Theme, key: &str, kind: SubchatKind) -> AnyElement {
    let dot = |color: Rgba| div().flex_none().size(px(8.0)).rounded_full().bg(color).into_any_element();
    let mark = match kind {
        SubchatKind::Working => Spinner::new(SharedString::from(format!("details-spin-{key}"))).color(theme.ink3).into_any_element(),
        SubchatKind::NeedsYou => dot(theme.orange),
        SubchatKind::Failed => dot(theme.red),
        SubchatKind::Done => return value(theme, "Done", None),
        SubchatKind::Holding | SubchatKind::Queued | SubchatKind::Stopped => dot(theme.ink4),
    };
    div()
        .id(SharedString::from(format!("details-state-{key}")))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(16.0))
        .tooltip(Tooltip::text(kind.label()))
        .child(mark)
        .into_any_element()
}

impl DetailsView {
    fn stop_button(&self, id: String, request: Request, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id(SharedString::from(format!("{id}-tip")))
            .flex_none()
            .tooltip(Tooltip::text("Stop"))
            .child(
                IconButton::new(SharedString::from(id), IconName::Stop)
                    .size(IconButtonSize::S24)
                    .glyph(IconSize::S12)
                    .on_click(on(cx, move |this, cx| this.stop(request.clone(), cx))),
            )
            .into_any_element()
    }

    pub(super) fn environment(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let mut rows: Vec<AnyElement> = vec![heading(theme, "Environment")];
        if let Some(computer) = &self.data.computer {
            let tone = computer.offline.then_some(theme.orange_ink);
            rows.push(
                line(
                    theme,
                    "details-computer",
                    glyph(theme, IconName::Computer),
                    computer.name.clone(),
                    vec![value(theme, computer.state, tone)],
                )
                .into_any_element(),
            );
        }
        if let Some(repo) = &self.data.repo {
            rows.push(line(theme, "details-repo", glyph(theme, IconName::FolderGit), repo.clone(), vec![]).into_any_element());
        }
        if let Some(branch) = &self.data.branch {
            rows.push(
                line(theme, "details-branch", glyph(theme, IconName::GitBranch), middle_truncate(branch, BRANCH_CHARS), vec![])
                    .tooltip(Tooltip::text(branch.clone()))
                    .into_any_element(),
            );
        }
        if let Some(path) = &self.data.path {
            let copied = self.is_copied();
            let label = middle_truncate(path, PATH_CHARS);
            let hover = theme.hover2;
            let left = div()
                .id("details-path")
                .debug_selector(|| "details-path".to_string())
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(8.0))
                .h_full()
                .px(px(PAD_X))
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .tooltip(Tooltip::text(path.clone()))
                .on_click(on(cx, |this, cx| this.copy_path(cx)))
                .child(glyph(theme, IconName::Folder01))
                .child(div().flex_1().min_w_0().truncate().child(label));
            let right: Vec<AnyElement> = if copied {
                vec![div().flex_none().pr(px(PAD_X)).text_step(TEXT_12).text_color(theme.green_ink).child("Copied").into_any_element()]
            } else {
                let (editor_name, editor_tip) = self.editor(cx);
                let _ = editor_name;
                vec![
                    div()
                        .id("details-finder-tip")
                        .flex_none()
                        .tooltip(Tooltip::text("Show in Finder"))
                        .child(
                            IconButton::new("details-finder", IconName::FolderOpen)
                                .size(IconButtonSize::S24)
                                .glyph(IconSize::S14)
                                .on_click(on(cx, |this, cx| this.reveal_in_finder(cx))),
                        )
                        .into_any_element(),
                    div()
                        .id("details-editor-tip")
                        .flex_none()
                        .pr(px(PAD_X - 4.0))
                        .tooltip(Tooltip::text(editor_tip))
                        .child(
                            IconButton::new("details-editor", IconName::Code)
                                .size(IconButtonSize::S24)
                                .glyph(IconSize::S14)
                                .on_click(on(cx, |this, cx| this.open_in_editor(cx))),
                        )
                        .into_any_element(),
                ]
            };
            rows.push(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .w_full()
                    .h(px(ROW_HEIGHT))
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child(left)
                    .children(right)
                    .into_any_element(),
            );
        }
        section(rows)
    }

    pub(super) fn context(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(context) = &self.data.context else { return div().into_any_element() };
        let open = self.context_open();
        let attention = context.claude && context.percent as f32 >= BUTTON_THRESHOLD;
        let tone = attention.then_some(theme.orange_ink);
        let head = clickable(
            line(
                theme,
                "details-context",
                glyph(theme, IconName::RamMemory),
                "Context",
                vec![value(theme, format!("{}%", context.percent), tone), chevron(theme, open)],
            ),
            theme,
            on(cx, |this, cx| this.toggle_context(cx)),
        );
        let mut rows: Vec<AnyElement> = vec![head.into_any_element()];
        if open {
            let mut body = div()
                .debug_selector(|| "details-context-body".to_string())
                .flex()
                .flex_col()
                .gap(px(8.0))
                .px(px(PAD_X))
                .pb(px(8.0))
                .child(div().text_step(TEXT_12).text_color(theme.ink2).child(context.tokens.clone()))
                .child(bar_at(theme, context.percent, CONTEXT_BAR));
            if context.claude {
                body = body.child(
                    div()
                        .id("details-compact")
                        .debug_selector(|| "details-compact".to_string())
                        .flex()
                        .items_center()
                        .justify_center()
                        .w_full()
                        .h(px(32.0))
                        .rounded(RADIUS_CONTROL)
                        .bg(Rgba { a: 0.15, ..theme.orange })
                        .text_step(TEXT_12)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.orange_ink)
                        .cursor_pointer()
                        .on_click(on(cx, |this, cx| this.compact(cx)))
                        .child("Compact now"),
                );
            }
            rows.push(body.into_any_element());
        }
        section(rows)
    }

    pub(super) fn subchats(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let open = self.children_open();
        let mut rows: Vec<AnyElement> =
            vec![toggle_heading(theme, "details-children-toggle", "Children", open, on(cx, |this, cx| this.toggle_children(cx)))];
        if !open {
            return section(rows);
        }
        if let Some(parent) = &self.family().parent {
            let key = parent.key.clone();
            rows.push(
                clickable(
                    line(
                        theme,
                        "details-parent",
                        glyph(theme, IconName::CornerUpLeft),
                        parent.title.clone(),
                        vec![value(theme, "Parent", None)],
                    ),
                    theme,
                    on(cx, move |this, cx| this.open_chat(&key, cx)),
                )
                .into_any_element(),
            );
        }
        let subchats: Vec<SubchatRow> = self.family().subchats.clone();
        for (ix, sub) in subchats.into_iter().enumerate() {
            let key = sub.key.clone();
            let row = line(
                theme,
                format!("details-subchat-{ix}"),
                Icon::new(IconName::CornerUpLeft).size(IconSize::S14).color(theme.ink3).into_any_element(),
                sub.title.clone(),
                vec![state_mark(theme, &sub.key, sub.kind)],
            )
            .pl(px(PAD_X + sub.depth as f32 * INDENT));
            rows.push(clickable(row, theme, on(cx, move |this, cx| this.open_chat(&key, cx))).into_any_element());
        }
        section(rows)
    }

    pub(super) fn background(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let data = &self.data;
        let open = self.background_open();
        let mut rows: Vec<AnyElement> = vec![toggle_heading(
            theme,
            "details-background-toggle",
            "Background tasks",
            open,
            on(cx, |this, cx| this.toggle_background(cx)),
        )];
        if !open {
            return section(rows);
        }
        for command in &data.commands {
            let time = data::elapsed(command.started_at, None, data.commands_now);
            rows.push(
                line(
                    theme,
                    format!("details-command-{}", command.id),
                    glyph(theme, IconName::CommandLine),
                    command.title.clone(),
                    vec![
                        value(theme, time, None),
                        self.stop_button(format!("details-stop-{}", command.id), Request::StopCommand(command.id.clone()), cx),
                    ],
                )
                .pr(px(PAD_X - 4.0))
                .into_any_element(),
            );
        }
        for port in &data.ports {
            let tail = match &port.computer {
                Some(computer) => format!("{computer} \u{b7} :{}", port.port),
                None => format!(":{}", port.port),
            };
            rows.push(
                line(
                    theme,
                    format!("details-port-{}", port.pid),
                    glyph(theme, IconName::Globe02),
                    port.command.clone(),
                    vec![
                        value(theme, tail, None),
                        self.stop_button(format!("details-stop-port-{}", port.pid), Request::StopPort(port.pid), cx),
                    ],
                )
                .pr(px(PAD_X - 4.0))
                .into_any_element(),
            );
        }
        for agent in data.running_agents() {
            let time = data::elapsed(agent.started_at, None, data.agents_now);
            rows.push(
                line(
                    theme,
                    format!("details-agent-{}", agent.id),
                    glyph(theme, IconName::Bot),
                    agent.title.clone(),
                    vec![
                        value(theme, time, None),
                        self.stop_button(format!("details-stop-agent-{}", agent.id), Request::StopAgent(agent.id.clone()), cx),
                    ],
                )
                .pr(px(PAD_X - 4.0))
                .into_any_element(),
            );
        }
        let finished = data.finished_count();
        if data.running_count() == 0 && finished == 0 {
            rows.push(
                div()
                    .flex_none()
                    .h(px(ROW_HEIGHT))
                    .px(px(PAD_X))
                    .flex()
                    .items_center()
                    .text_step(TEXT_13)
                    .text_color(theme.ink3)
                    .child("Nothing running")
                    .into_any_element(),
            );
        }
        if finished > 0 {
            let open = self.finished_open();
            rows.push(
                clickable(
                    line(
                        theme,
                        "details-finished",
                        glyph(theme, IconName::CheckmarkCircle02),
                        format!("{finished} finished"),
                        vec![chevron(theme, open)],
                    ),
                    theme,
                    on(cx, |this, cx| this.toggle_finished(cx)),
                )
                .into_any_element(),
            );
            if open {
                let list: Vec<AgentInfo> = data.finished_agents().cloned().collect();
                for agent in list {
                    let (icon, color) = match agent.status {
                        AgentStatus::Completed => (IconName::Tick02, theme.green_ink),
                        AgentStatus::Failed => (IconName::AlertCircle, theme.red_ink),
                        _ => (IconName::Stop, theme.ink3),
                    };
                    let time = data::elapsed(agent.started_at, agent.ended_at, data.agents_now);
                    rows.push(
                        line(
                            theme,
                            format!("details-done-{}", agent.id),
                            Icon::new(icon).size(IconSize::S16).color(color).into_any_element(),
                            agent.title.clone(),
                            vec![value(theme, time, None)],
                        )
                        .pl(px(PAD_X + INDENT))
                        .into_any_element(),
                    );
                }
            }
        }
        section(rows)
    }

    pub(super) fn links(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let open = self.links_open();
        let mut rows: Vec<AnyElement> =
            vec![toggle_heading(theme, "details-links-toggle", "Links", open, on(cx, |this, cx| this.toggle_links(cx)))];
        if !open {
            return section(rows);
        }
        if let Some((key, title)) = self.data.linear.clone() {
            let issue = key.clone();
            rows.push(
                clickable(
                    line(theme, "details-linear", glyph(theme, IconName::LinkSquare02), title, vec![value(theme, key, None)]),
                    theme,
                    on(cx, move |this, cx| this.open_linear(&issue, cx)),
                )
                .into_any_element(),
            );
        }
        if let Some(pr) = self.data.pr {
            rows.push(
                clickable(
                    line(
                        theme,
                        "details-pr",
                        glyph(theme, IconName::GitPullRequest),
                        format!("Pull request #{}", pr.number),
                        vec![value(theme, pr.state, None)],
                    ),
                    theme,
                    on(cx, move |this, cx| this.open_pr(pr.number, cx)),
                )
                .into_any_element(),
            );
        }
        for (ix, name) in self.data.links.clone().into_iter().enumerate() {
            let target = name.clone();
            rows.push(
                clickable(
                    line(theme, format!("details-link-{ix}"), glyph(theme, IconName::Link04), name, vec![value(theme, "Linked", None)]),
                    theme,
                    on(cx, move |this, cx| this.open_linked(&target, cx)),
                )
                .into_any_element(),
            );
        }
        section(rows)
    }
}

fn section(rows: Vec<AnyElement>) -> AnyElement {
    div().flex().flex_col().flex_none().w_full().pb(px(4.0)).children(rows).into_any_element()
}
