//! One Routine's page (R-02: `RoutinePage.tsx`, `RoutineStatusPill`), the Run Chat pane's header (V-04: `RunChatHeader.tsx`)
//! and the split they share (`App.tsx`: the page narrows to a 420px column, the Run Chat sits in a card beside it).
//!
//! Back to the Routines page, the name with On or Paused and one toolbar (checkbox, Run now, Edit), the settings as chips,
//! when it runs next and last ran, then its Runs by day, filtered by All, Acted, Failed or Unread.

use gpui::{AnyElement, App, Context, FontWeight, IntoElement, SharedString, Window, div, prelude::*, px};

use super::fixture;
use super::model::{Run, Target, model_name};
use super::words::{
    self, RunFilter, can_edit, can_run_now, clock, fallback_text, filter_runs, routine_problem, routine_retries, routine_times,
    routine_where_text, run_chat_meta, run_filter_counts, trigger_chip_text,
};
use super::{Editing, RoutinesView, list::act, routine_icon};
use crate::logic::copy::model_copy::PermissionMode;
use crate::logic::marks::ChatMark;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_WINDOW, TEXT_11, TEXT_12, TEXT_15, TEXT_22, TextStepExt};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Checkbox, Chip, ChipVariant, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize,
    InlineError, ScrollArea, Segmented, SegmentedOption,
};
use crate::workspace::chat::ChatView;
use crate::workspace::chrome;
use crate::workspace::sidebar::ChatRow;

/// The page's width as a column beside an open Run Chat.
pub(crate) const NARROW_WIDTH: f32 = 420.0;
const PAGE_WIDTH: f32 = 680.0;

/// The sidebar row a Run Chat is opened from (the fixture's own: a hidden Run Chat of its Project).
pub(crate) fn chat_row(key: &str, title: &str) -> ChatRow {
    ChatRow {
        key: key.to_string().into(),
        initial: title.chars().next().map_or(String::new(), |c| c.to_uppercase().to_string()).into(),
        tile: None,
        title: title.to_string().into(),
        detail: "happiergym".into(),
        offline: None,
        mark: ChatMark::Idle,
        failed: false,
        background: 0,
        depth: 0,
        family: None,
    }
}

/// "On" in green, or "Paused" in grey, beside the Routine's name.
fn status_pill(on: bool, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let (fill, ink, dot) = if on { (theme.green_tint, theme.green_ink, theme.green) } else { (theme.field, theme.ink3, theme.ink4) };
    div()
        .debug_selector(|| "routine-status-pill".into())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .h(px(20.0))
        .px(px(8.0))
        .rounded_full()
        .bg(fill)
        .text_step(TEXT_11)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink)
        .child(div().size(px(6.0)).rounded_full().bg(dot))
        .child(if on { "On" } else { "Paused" })
        .into_any_element()
}

/// A Routine's setting as a pill on the field fill: its icon and words ("Every hour", "New Worktree in payments-api").
fn setting_chip(id: &'static str, icon: IconName, text: impl Into<SharedString>, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    Chip::new(id)
        .variant(ChipVariant::Static)
        .child(Icon::new(icon).size(IconSize::S14).color(theme.ink2))
        .child(div().truncate().child(text.into()))
        .into_any_element()
}

impl RoutinesView {
    /// The whole body of a Routine's page: the page alone, or the page as a column beside the Run Chat.
    pub(crate) fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let narrow = self.run_pane_open();
        // A flow Routine opens the Flow page (`flows/`) in place of the plain page.
        let page = if self.is_flow_open() { self.flow_column(narrow, window, cx) } else { self.page_column(narrow, cx) };
        if !narrow {
            return div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(chrome::header("routine-header"))
                .child(div().flex_1().min_h_0().child(page))
                .into_any_element();
        }
        let pane = self.run_chat_pane(cx);
        div()
            .debug_selector(|| "routine-split".into())
            .flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .h_full()
            .gap(px(12.0))
            .pt(px(chrome_height()))
            .pb(px(12.0))
            .pr(px(12.0))
            .child(div().flex().flex_col().flex_none().w(px(NARROW_WIDTH)).min_h_0().child(page))
            .child(
                div()
                    .debug_selector(|| "run-chat-pane".into())
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .rounded(RADIUS_WINDOW)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface)
                    .child(pane),
            )
            .into_any_element()
    }

    fn page_column(&mut self, narrow: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let Some(routine) = self.open_routine().cloned() else { return div().into_any_element() };
        let now = self.now;
        let id = routine.id.clone();
        let problem = routine_problem(&routine).map(str::to_string);
        let unread_chat = |run: &Run| run.chat_id.as_deref().is_some_and(|chat| self.unread_chats.contains(chat) && self.can_open(chat));
        let counts = run_filter_counts(&routine.runs, &unread_chat);
        let count_of = |filter: RunFilter| counts.iter().find(|(f, _)| *f == filter).map_or(0, |(_, n)| *n);
        // A filter whose Runs are all gone falls back to All.
        let shown = if self.run_filter != RunFilter::All && count_of(self.run_filter) == 0 { RunFilter::All } else { self.run_filter };
        let runs = filter_runs(&routine.runs, shown, &unread_chat);
        let model = routine.model.as_deref().map_or("Default model".to_string(), |m| model_name(routine.provider, m));
        let mode = routine
            .permission_mode
            .as_deref()
            .map_or("Default mode".to_string(), |m| PermissionMode::from_id(m).map_or(m.to_string(), |mode| mode.name().to_string()));
        let times = routine_times(&routine, now, &words::ZONE);
        let where_icon = match &routine.target {
            Target::Chat { .. } => IconName::BubbleChat,
            Target::NewChat { workspace, .. } => {
                if *workspace == super::model::Workspace::Worktree {
                    IconName::GitBranch
                } else {
                    IconName::Folder01
                }
            }
        };
        let options: Vec<SegmentedOption> = [RunFilter::All, RunFilter::Acted, RunFilter::Failed, RunFilter::Unread]
            .into_iter()
            .filter(|f| *f == RunFilter::All || count_of(*f) > 0)
            .map(|f| SegmentedOption::new(f.id(), f.label()).count(count_of(f) as u32))
            .collect();

        let toolbar = {
            let (toggle_view, toggle_id) = (view.clone(), id.clone());
            let enabled = routine.enabled;
            div()
                .debug_selector(|| "routine-toolbar".into())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.0))
                .h(px(32.0))
                .pr(px(2.0))
                .pl(px(8.0))
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .bg(theme.surface)
                .child(Checkbox::new("routine-enabled", enabled).on_toggle(move |on, _, cx| {
                    let id = toggle_id.clone();
                    toggle_view.update(cx, |this, cx| this.set_enabled(&id, on, cx));
                }))
                .child(div().mx(px(4.0)).w(px(1.0)).h(px(16.0)).bg(theme.line))
                .when(can_run_now(&routine), |el| {
                    let id = id.clone();
                    el.child(
                        IconButton::new("routine-run-now", IconName::Play)
                            .size(IconButtonSize::S28)
                            .disabled(!enabled)
                            .on_click(act(&view, move |this, _, cx| this.run_now(&id, cx))),
                    )
                })
                .when(can_edit(&routine), |el| {
                    let id = id.clone();
                    el.child(
                        IconButton::new("routine-edit", IconName::PencilEdit02)
                            .size(IconButtonSize::S28)
                            .on_click(act(&view, move |this, window, cx| {
                                this.start_editor(Some(Editing::Routine(id.clone())), window, cx)
                            })),
                    )
                })
        };

        let created = self.created_hook.as_ref().filter(|(rid, _)| rid == &id).map(|(_, url)| url.clone());
        let page = div()
            .id("routine-page")
            .debug_selector({
                let selector = format!("routine-page-{id}");
                move || selector.clone()
            })
            .flex()
            .flex_col()
            .flex_1()
            .w_full()
            .pb(px(40.0))
            .map(|el| if narrow { el.px(px(12.0)).pt(px(16.0)) } else { el.max_w(px(PAGE_WIDTH)).px(px(24.0)).pt(px(12.0)) })
            .child(
                div().flex().child(
                    Button::new("routine-back", "Routines")
                        .variant(ButtonVariant::Quiet)
                        .size(ButtonSize::S28)
                        .icon(IconName::ArrowLeft02)
                        .on_click(act(&view, |this, _, cx| this.back(cx))),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .mt(px(12.0))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .truncate()
                                    .text_step(TEXT_22)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if routine.enabled { theme.ink } else { theme.ink2 })
                                    .child(routine.name.clone()),
                            )
                            .child(status_pill(routine.enabled, cx)),
                    )
                    .child(toolbar),
            )
            .child(
                div()
                    .debug_selector(|| "routine-chips".into())
                    .mt(px(12.0))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.0))
                    .child(setting_chip(
                        "routine-chip-trigger",
                        routine_icon(&routine),
                        trigger_chip_text(&routine.trigger, Some("UTC")),
                        cx,
                    ))
                    .child(setting_chip(
                        "routine-chip-where",
                        where_icon,
                        routine_where_text(&routine.target, &|chat| fixture::chat_title(chat)),
                        cx,
                    ))
                    .child(setting_chip("routine-chip-model", IconName::Sparkles, model, cx))
                    .when(routine_retries(&routine), |el| {
                        el.child(setting_chip("routine-chip-fallback", IconName::Refresh, fallback_text(&routine), cx))
                    })
                    .child(setting_chip("routine-chip-mode", IconName::SecurityCheck, mode, cx)),
            )
            .when(!times.is_empty(), |el| {
                el.child(div().debug_selector(|| "routine-times".into()).mt(px(8.0)).text_step(TEXT_12).text_color(theme.ink3).child(times))
            })
            .when_some(problem, |el, problem| {
                el.child(
                    div()
                        .debug_selector(|| "routine-problem".into())
                        .mt(px(8.0))
                        .text_step(TEXT_12)
                        .text_color(theme.red_ink)
                        .child(problem),
                )
            })
            .when_some(self.error.clone(), |el, error| el.child(div().mt(px(8.0)).child(InlineError::new(error).small())))
            .when_some(created, |el, url| el.child(self.created_card(&url, cx)))
            .child(
                div()
                    .debug_selector(|| "routine-runs".into())
                    .mt(px(28.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .mb(px(8.0))
                            .child(div().flex_1().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Runs"))
                            .when(!routine.runs.is_empty(), |el| {
                                let view = view.clone();
                                el.child(Segmented::new("routine-runs-filter", Some(shown.id()), options).on_change(move |value, _, cx| {
                                    let next = RunFilter::from_id(value);
                                    view.update(cx, |this, cx| {
                                        if next != this.run_filter {
                                            this.shown_days = super::runs::FIRST_DAYS;
                                            this.expanded.clear();
                                        }
                                        this.run_filter = next;
                                        cx.notify();
                                    });
                                }))
                            }),
                    )
                    .child(if routine.runs.is_empty() {
                        let next =
                            routine.next_run_at.filter(|_| routine.enabled).map(|at| format!("Next Run {}.", clock(at, &words::ZONE)));
                        let mut empty = EmptyState::new().title("No Runs yet");
                        if let Some(next) = next {
                            empty = empty.help(next);
                        }
                        empty.into_any_element()
                    } else {
                        self.render_runs(&routine, &runs, cx)
                    }),
            );

        ScrollArea::new("routine-scroll", &self.page_scroll)
            .child(div().w_full().flex().flex_1().justify_center().child(page))
            .into_any_element()
    }

    /// "Routine created. Send POST requests to this URL." with the URL and Copy (shown once, on a webhook Routine's page).
    pub(crate) fn created_card(&self, url: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        div()
            .debug_selector(|| "routine-created".into())
            .mt(px(16.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(16.0))
            .py(px(12.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.0))
                    .child(div().flex_1().min_w_0().text_step(TEXT_12).text_color(theme.ink2).child(
                        "Routine created. Send POST requests to this URL. While this Mac is away, the relay holds them for up to 24 hours.",
                    ))
                    .child(IconButton::new("routine-created-dismiss", IconName::Cancel01).size(IconButtonSize::S24).on_click(act(
                        &view,
                        |this, _, cx| {
                            this.created_hook = None;
                            cx.notify();
                        },
                    ))),
            )
            .child(hook_url(Some(url), cx))
            .into_any_element()
    }

    /// The Run Chat pane: its header (title, the Run's meta, Close) over the Chat.
    fn run_chat_pane(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let Some(chat) = &self.run_chat else { return div().into_any_element() };
        let meta = match &chat.run {
            Some(run) => run_chat_meta(run, Some("main"), &words::ZONE),
            None => "main".to_string(),
        };
        let chat_view: gpui::Entity<ChatView> = chat.view.clone();
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(
                div()
                    .debug_selector(|| "run-chat-header".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(12.0))
                    .py(px(8.0))
                    .pr(px(8.0))
                    .pl(px(16.0))
                    .border_b_1()
                    .border_color(theme.line)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .truncate()
                                    .text_step(TEXT_15)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.ink)
                                    .child(chat.title.clone()),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "run-chat-meta".into())
                                    .truncate()
                                    .text_step(TEXT_12)
                                    .text_color(theme.ink3)
                                    .child(meta),
                            ),
                    )
                    .child(
                        IconButton::new("run-chat-close", IconName::Cancel01).on_click(act(&view, |this, _, cx| this.close_run_chat(cx))),
                    ),
            )
            .child(div().flex().flex_1().min_h_0().child(chat_view))
            .into_any_element()
    }
}

/// A webhook's URL with Copy (`HookUrl`), or where it will appear.
pub(crate) fn hook_url(url: Option<&str>, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    div()
        .debug_selector(|| "routine-hook".into())
        .flex()
        .items_center()
        .gap(px(8.0))
        .px(px(12.0))
        .py(px(8.0))
        .rounded(RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.field)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(crate::theme::mono())
                .text_step(TEXT_12)
                .text_color(theme.ink)
                .child(url.map_or("The URL appears after you create the Routine.".to_string(), str::to_string)),
        )
        .when_some(url.map(str::to_string), |el, url| {
            el.child(
                Button::new("routine-hook-copy", "Copy")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .icon(IconName::Copy01)
                    .on_click(move |_, _, cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(url.clone()))),
            )
        })
        .into_any_element()
}

/// The window chrome's height above a pane that sits beside the page.
fn chrome_height() -> f32 {
    f32::from(crate::theme::HEADER_HEIGHT)
}
