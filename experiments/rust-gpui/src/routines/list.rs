//! The Routines page and its rows (R-01: `RoutinesPage.tsx`, `RoutineRow.tsx`). Title and New Routine, the Show and
//! Computer filters as chip dropdowns with counts in their menus, Heartbeats and Triggers groups in cards, rows with a
//! status column and a ⋯ menu (Pause or Resume, Edit, Run now, Open Chat, Mark as read, Delete). DESIGN.md "Routines
//! page": the header is the title and New Routine only, rows have no tick, 56 high, glyph bare, status in a 72px column.

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, Context, ElementId, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled,
    Window, div, point, prelude::*, px,
};

use super::model::{LOCAL, Routine};
use super::words::{
    self, can_edit, can_run_now, delete_question, group_routines, is_heartbeat, routine_meta, routine_problem, routine_status,
};
use super::{Editing, Kind, RoutinesView, routine_icon};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, TEXT_10, TEXT_12, TEXT_13, TEXT_22, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonVariant, EmptySize, EmptyState, Icon, IconButton, IconName, IconSize, InlineError, MenuList, MenuRow, Popover,
    ScrollArea, SectionLabel, Select, SelectOption, SelectVariant,
};
use crate::workspace::chrome;

/// The status column: 72px holds "Next 09:45", "Fri 16:00" and "Paused", so every row's meta line ends at the same x.
pub(crate) const STATUS_WIDTH: f32 = 72.0;
const ROW_HEIGHT: f32 = 56.0;
const LIST_WIDTH: f32 = 720.0;
const HELP: &str = "Routines run while the computer they are on is awake. Closing the lid on battery pauses them.";

/// A click handler that works on the view.
pub(crate) fn act(
    view: &Entity<RoutinesView>,
    f: impl Fn(&mut RoutinesView, &mut Window, &mut Context<RoutinesView>) + 'static,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let view = view.clone();
    move |_, window, cx| view.update(cx, |this, cx| f(this, window, cx))
}

/// `shadow-card`: the card's own ring and a faint drop, so a card on the page takes no border.
pub(crate) fn card_shadow(theme: &Theme) -> Vec<BoxShadow> {
    let ring = theme.line;
    vec![
        BoxShadow { color: ring.into(), offset: point(px(0.0), px(0.0)), blur_radius: px(0.0), spread_radius: px(1.0), inset: false },
        BoxShadow {
            color: gpui::black().opacity(0.04),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
            inset: false,
        },
    ]
}

impl RoutinesView {
    /// The computers a Routine can be filtered by: this one first, then each paired computer with Routines.
    fn computer_choices(&self) -> Vec<String> {
        let mut choices = vec![LOCAL.to_string()];
        for routine in &self.routines {
            if !choices.contains(&routine.computer) {
                choices.push(routine.computer.clone());
            }
        }
        if choices.len() == 1 { Vec::new() } else { choices }
    }

    pub(crate) fn render_list(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let choices = self.computer_choices();
        let picked = if self.computer == "all" || choices.contains(&self.computer) { self.computer.clone() } else { "all".to_string() };
        let listed: Vec<&Routine> = self.routines.iter().filter(|routine| picked == "all" || routine.computer == picked).collect();
        let groups = group_routines(&listed);
        let shown = |list: Vec<&Routine>| -> Vec<Routine> {
            list.into_iter().filter(|routine| self.kind != Kind::Paused || !routine.enabled).cloned().collect()
        };
        let heartbeats = if self.kind == Kind::Triggers { Vec::new() } else { shown(groups.heartbeats.clone()) };
        let triggers = if self.kind == Kind::Heartbeats { Vec::new() } else { shown(groups.triggers.clone()) };
        let empty = self.routines.is_empty() && self.error.is_none();
        let counts = [listed.len(), groups.heartbeats.len(), groups.triggers.len(), groups.paused.len()];

        let kind_select = {
            let view = view.clone();
            Select::new(
                "routines-show",
                self.kind.id(),
                Kind::ALL.iter().zip(counts).map(|(kind, count)| SelectOption::new(kind.id(), kind.label()).trailing(count.to_string())),
            )
            .variant(SelectVariant::Chip)
            .align_start()
            .width(200.0)
            .on_change(move |value, _, cx| {
                let kind = Kind::from_id(value);
                view.update(cx, |this, cx| {
                    this.kind = kind;
                    cx.notify();
                });
            })
        };
        let computer_select = (!choices.is_empty()).then(|| {
            let view = view.clone();
            let on_each =
                |id: &str| if id == "all" { self.routines.len() } else { self.routines.iter().filter(|r| r.computer == id).count() };
            let options: Vec<SelectOption> = std::iter::once("all".to_string())
                .chain(choices.iter().cloned())
                .map(|id| {
                    let label = if id == "all" { "Every computer".to_string() } else { RoutinesView::computer_name(&id) };
                    SelectOption::new(id.clone(), label).trailing(on_each(&id).to_string())
                })
                .collect();
            Select::new("routines-computer", picked.clone(), options).variant(SelectVariant::Chip).align_start().width(220.0).on_change(
                move |value, _, cx| {
                    let value = value.to_string();
                    view.update(cx, |this, cx| {
                        this.computer = value;
                        cx.notify();
                    });
                },
            )
        });

        let group = |id: &'static str, title: &'static str, rows: Vec<Routine>, this: &Self, cx: &mut Context<Self>| -> AnyElement {
            let count = rows.len();
            let theme = *cx.theme();
            div()
                .debug_selector(move || format!("routine-group-{id}"))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(SectionLabel::new(title))
                .child(
                    div().flex().flex_col().overflow_hidden().rounded(RADIUS_CARD).bg(theme.surface).shadow(card_shadow(&theme)).children(
                        rows.into_iter().enumerate().map(|(ix, routine)| {
                            let row = this.render_row(&routine, picked_computer_hidden(&picked), cx);
                            div().w_full().when(ix + 1 < count, |el| el.border_b_1().border_color(theme.line)).child(row)
                        }),
                    ),
                )
                .into_any_element()
        };
        let heartbeat_group = (!heartbeats.is_empty()).then(|| group("heartbeats", "Heartbeats", heartbeats.clone(), self, cx));
        let trigger_group = (!triggers.is_empty()).then(|| group("triggers", "Triggers", triggers.clone(), self, cx));
        let none_here = !self.routines.is_empty() && heartbeats.is_empty() && triggers.is_empty();

        let page =
            div()
                .id("routines-page")
                .debug_selector(|| "routines-page".into())
                .flex()
                .flex_col()
                .flex_1()
                .w_full()
                .max_w(px(LIST_WIDTH))
                .px(px(24.0))
                .pt(px(12.0))
                .pb(px(40.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(16.0))
                        .child(div().min_w_0().text_step(TEXT_22).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Routines"))
                        .child(
                            Button::new("routine-new", "New Routine")
                                .icon(IconName::PlusSign)
                                .on_click(act(&view, |this, window, cx| this.start_editor(Some(Editing::New), window, cx))),
                        ),
                )
                .when_some(self.error.clone(), |el, error| el.child(div().mt(px(16.0)).child(InlineError::new(error))))
                .when(!self.routines.is_empty(), |el| {
                    el.child(
                        div()
                            .debug_selector(|| "routine-filters".into())
                            .mt(px(20.0))
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.0))
                            .child(kind_select)
                            .children(computer_select),
                    )
                })
                .child(div().mt(px(20.0)).flex().flex_col().gap(px(20.0)).children(heartbeat_group).children(trigger_group).when(
                    none_here,
                    |el| {
                        el.child(
                            div().debug_selector(|| "routines-none".into()).text_step(TEXT_13).text_color(theme.ink3).child("None here."),
                        )
                    },
                ))
                .when(empty, |el| {
                    el.child(
                        div().flex_1().flex().items_center().justify_center().min_h(px(200.0)).child(
                            EmptyState::new().icon(IconName::TimeSchedule).title("No Routines yet").help(HELP).size(EmptySize::Compact),
                        ),
                    )
                });

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(chrome::header("routines-header"))
            .child(div().flex_1().min_h_0().child(
                ScrollArea::new("routines-scroll", &self.list_scroll).child(div().w_full().flex().flex_1().justify_center().child(page)),
            ))
            .into_any_element()
    }

    /// One Routine: glyph, name, meta and status, then the ⋯ menu; a delete question under it while confirming.
    pub(crate) fn render_row(&self, routine: &Routine, name_the_computer: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let id = routine.id.clone();
        let now = self.now;
        let unread = self.unread_routines.contains(&routine.id);
        let meta = routine_meta(routine, &|chat| RoutinesView::chat_title(chat), now);
        let status = if routine.flow.as_ref().is_some_and(|flow| flow.revision == 0) {
            "Not published".to_string()
        } else {
            routine_status(routine, now, &words::ZONE)
        };
        let problem = routine_problem(routine).map(str::to_string);
        let waiting = routine.flow.as_ref().map_or(0, |flow| flow.waiting);
        let confirming = self.confirming.as_deref() == Some(&routine.id);
        let computer = (name_the_computer && routine.computer != LOCAL).then(|| RoutinesView::computer_name(&routine.computer));
        let ink = if routine.enabled { theme.ink } else { theme.ink2 };
        let row_id = SharedString::from(format!("routine-row-{id}"));
        let selector = row_id.to_string();

        let open_button = {
            let (view, id) = (view.clone(), id.clone());
            div()
                .id(ElementId::from(SharedString::from(format!("routine-open-{id}"))))
                .debug_selector({
                    let selector = format!("routine-open-{id}");
                    move || selector.clone()
                })
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(12.0))
                .py(px(8.0))
                .pl(px(16.0))
                .cursor_pointer()
                .on_click(move |_, _, cx| {
                    let id = id.clone();
                    view.update(cx, |this, cx| this.open_page(&id, cx));
                })
                .child(div().flex().flex_none().items_center().justify_center().size(px(32.0)).child(
                    Icon::new(routine_icon(routine)).size(IconSize::S16).color(if routine.enabled { theme.ink2 } else { theme.ink3 }),
                ))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .min_w_0()
                                .child(
                                    div()
                                        .truncate()
                                        .text_step(TEXT_13)
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(ink)
                                        .child(routine.name.clone()),
                                )
                                .when(routine.flow.is_some(), |el| {
                                    el.child(
                                        div()
                                            .debug_selector(|| "routine-flow-chip".into())
                                            .flex_none()
                                            .px(px(6.0))
                                            .py(px(2.0))
                                            .rounded(RADIUS_CHIP)
                                            .bg(theme.field)
                                            .text_step(TEXT_10)
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.ink2)
                                            .child("Flow"),
                                    )
                                })
                                .when(unread, |el| {
                                    el.child(
                                        div()
                                            .debug_selector(|| "routine-unread".into())
                                            .flex_none()
                                            .size(px(8.0))
                                            .rounded_full()
                                            .bg(theme.accent),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.0))
                                .min_w_0()
                                .text_step(TEXT_12)
                                .text_color(theme.ink3)
                                .when_some(computer, |el, name| {
                                    el.child(
                                        div()
                                            .debug_selector(|| "routine-computer".into())
                                            .flex()
                                            .flex_none()
                                            .items_center()
                                            .gap(px(4.0))
                                            .child(Icon::new(IconName::Laptop).size(IconSize::S12).color(theme.ink3))
                                            .child(name)
                                            .child("\u{b7}"),
                                    )
                                })
                                .child(div().truncate().child(meta)),
                        )
                        .when_some(problem, |el, problem| {
                            el.child(
                                div()
                                    .debug_selector(|| "routine-problem".into())
                                    .truncate()
                                    .text_step(TEXT_12)
                                    .text_color(theme.red_ink)
                                    .child(problem),
                            )
                        }),
                )
                .child(if waiting > 0 {
                    div()
                        .debug_selector(|| "routine-waiting".into())
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_end()
                        .gap(px(4.0))
                        .min_w(px(STATUS_WIDTH))
                        .text_step(TEXT_12)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.orange_ink)
                        .child(Icon::new(IconName::PauseCircle).size(IconSize::S14).color(theme.orange_ink))
                        .child(if waiting == 1 { "Waiting for you".to_string() } else { format!("{waiting} waiting for you") })
                } else {
                    div()
                        .debug_selector(|| "routine-status".into())
                        .flex_none()
                        .min_w(px(STATUS_WIDTH))
                        .text_step(TEXT_12)
                        .text_color(if routine.enabled { theme.ink2 } else { theme.ink3 })
                        .flex()
                        .justify_end()
                        .child(status)
                })
        };

        let menu = self.row_menu(routine, unread, cx);
        let hover = theme.hover;
        div()
            .id(row_id)
            .debug_selector(move || selector.clone())
            .group("routine-row")
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_stretch()
                    .gap(px(12.0))
                    .pr(px(16.0))
                    .min_h(px(ROW_HEIGHT))
                    .hover(move |style| style.bg(hover))
                    .child(open_button)
                    .child(div().flex().flex_none().items_center().child(menu)),
            )
            .when(confirming, |el| {
                let (cancel_view, delete_view, delete_id) = (view.clone(), view.clone(), id.clone());
                el.child(
                    div()
                        .debug_selector(|| "routine-delete-question".into())
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .min_h(px(44.0))
                        .px(px(16.0))
                        .pb(px(12.0))
                        .child(div().flex_1().min_w_0().text_step(TEXT_12).text_color(theme.ink).child(delete_question(routine)))
                        .child(
                            Button::new(("routine-delete-cancel", 0usize), "Cancel")
                                .selector("routine-delete-cancel")
                                .variant(ButtonVariant::Secondary)
                                .on_click(act(&cancel_view, |this, _, cx| {
                                    this.confirming = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new(("routine-delete-confirm", 0usize), "Delete")
                                .selector("routine-delete-confirm")
                                .variant(ButtonVariant::Danger)
                                .on_click(move |_, _, cx| {
                                    let id = delete_id.clone();
                                    delete_view.update(cx, |this, cx| this.delete_routine(&id, cx));
                                }),
                        ),
                )
            })
            .into_any_element()
    }

    /// The ⋯ button and the menu it opens: Pause or Resume first, Edit, Run now, Open Chat, Mark as read, Delete.
    fn row_menu(&self, routine: &Routine, unread: bool, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity();
        let id = routine.id.clone();
        let chat = match &routine.target {
            super::model::Target::Chat { chat_id } => Some(chat_id.clone()),
            _ => routine.runs.iter().find_map(|run| run.chat_id.clone()),
        };
        let (enabled, editable, runnable, heartbeat) = (routine.enabled, can_edit(routine), can_run_now(routine), is_heartbeat(routine));
        let trigger_id = SharedString::from(format!("routine-more-{id}"));
        Popover::new(SharedString::from(format!("routine-menu-{id}")))
            .width(px(200.0))
            .trigger({
                let trigger_id = trigger_id.clone();
                move |open| IconButton::new(ElementId::from(trigger_id), IconName::MoreHorizontal).pressed(open).into_any_element()
            })
            .content(move |dismiss, _window, _cx| {
                let mut list = MenuList::new(SharedString::from(format!("routine-actions-{id}"))).dismiss(dismiss);
                let (view_a, id_a) = (view.clone(), id.clone());
                list = list.row(
                    MenuRow::new("pause", if enabled { "Pause" } else { "Resume" })
                        .icon(if enabled { IconName::PauseCircle } else { IconName::PlayCircle })
                        .on_click(move |_, _, cx| {
                            let id = id_a.clone();
                            view_a.update(cx, |this, cx| this.set_enabled(&id, !enabled, cx));
                        }),
                );
                if editable {
                    let (view_b, id_b) = (view.clone(), id.clone());
                    list = list.row(MenuRow::new("edit", "Edit").icon(IconName::PencilEdit02).on_click(move |_, window, cx| {
                        let id = id_b.clone();
                        view_b.update(cx, |this, cx| {
                            this.open_page(&id, cx);
                            this.start_editor(Some(Editing::Routine(id)), window, cx);
                        });
                    }));
                }
                if runnable {
                    let (view_c, id_c) = (view.clone(), id.clone());
                    list = list.row(MenuRow::new("run", "Run now").icon(IconName::Play).on_click(move |_, _, cx| {
                        let id = id_c.clone();
                        view_c.update(cx, |this, cx| this.run_now(&id, cx));
                    }));
                }
                if chat.is_some() {
                    let (view_d, id_d) = (view.clone(), id.clone());
                    list = list.row(
                        MenuRow::new("chat", if heartbeat { "Open Chat" } else { "Open last Chat" }).icon(IconName::BubbleChat).on_click(
                            move |_, window, cx| {
                                let id = id_d.clone();
                                view_d.update(cx, |this, cx| {
                                    this.open_page(&id, cx);
                                    if let Some(chat) = this.routine(&id).and_then(|r| r.runs.iter().find_map(|run| run.chat_id.clone())) {
                                        this.open_run_chat(&chat, window, cx);
                                    }
                                });
                            },
                        ),
                    );
                }
                if unread {
                    let (view_e, id_e) = (view.clone(), id.clone());
                    list = list.row(MenuRow::new("read", "Mark as read").icon(IconName::Tick02).on_click(move |_, _, cx| {
                        let id = id_e.clone();
                        view_e.update(cx, |this, cx| this.mark_read(&id, cx));
                    }));
                }
                let (view_f, id_f) = (view.clone(), id.clone());
                list = list.row(MenuRow::new("delete", "Delete").icon(IconName::Delete02).danger().on_click(move |_, _, cx| {
                    let id = id_f.clone();
                    view_f.update(cx, |this, cx| {
                        this.confirming = Some(id);
                        cx.notify();
                    });
                }));
                list.into_any_element()
            })
            .into_any_element()
    }
}

/// Another computer's row names it unless the Computer filter already names the one computer listed.
fn picked_computer_hidden(picked: &str) -> bool {
    picked == "all"
}
