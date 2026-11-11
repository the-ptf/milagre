//! One two-line Chat row (48px), as a view of its own.
//!
//! The sidebar's list mounts each visible row as a cached view (`AnyView::cached` at the row's fixed
//! size). So when the sidebar re-renders (a logo finished loading, a row's spinner turned, the selection
//! moved), GPUI reuses every row whose view did not change instead of building it again; only a row that
//! called `cx.notify()` renders. Rows tell the sidebar about clicks with [`RowEvent`], not by updating it
//! from inside their own listener (that would borrow the row view twice when the sidebar updates it back).
//!
//! What a row shows follows the desktop's inbox row (`InboxLine` and `ChatMarkDotInline` in
//! `apps/desktop/app/src/components/sidebar/ChatRow.tsx`): the title, then "project · #PR · +n · computer" (the
//! computer only with several computers, in `orange-ink` with ", offline" while it is), the mark from
//! `logic::marks::chat_mark_presentation`, a Subchat's indent and guide lines, and a family's count on its
//! parent's tile.

use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    Bounds, ClickEvent, Context, EventEmitter, FontWeight, HighlightStyle, MouseButton, Pixels, Point, Rgba, SharedString, StyledText,
    Window, canvas, div, prelude::*, px,
};

use super::list::{Family, ShownChat, SidebarData, project_label};
use crate::logic::identity::project_list::project_initial;
use crate::logic::lists::chat_row::{ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
use crate::logic::marks::{ChatMark, MarkIcon, Tone, chat_mark_presentation};
use crate::logic::prs::blockers::row_pull_requests;
use crate::theme::{ActiveTheme, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_10, TEXT_12, TEXT_13, TextStepExt, Theme, hex};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, SpinnerRing};

/// Horizontal inset of each row inside the sidebar.
pub const ROW_INSET: f32 = 8.0;
const TILE_SIZE: f32 = 24.0;
/// The trailing status slot of a row.
const MARK_SLOT: f32 = 16.0;
/// A Subchat's indent: 16px under its parent, 32px two deep (`pl-4`, `pl-8`).
const SUBCHAT_INDENT: f32 = 16.0;
/// The guide lines at the left of a Subchat row (`left-[19px]`, `left-[35px]`).
const GUIDE_X: [f32; 2] = [19.0, 35.0];
/// The family count over the parent's tile (`top-[18px] left-[26px]`, 16px high).
const BADGE_TOP: f32 = 18.0;
const BADGE_LEFT: f32 = 26.0;
const BADGE_SIZE: f32 = 16.0;

pub enum RowEvent {
    Clicked,
    /// The family count was clicked: fold or unfold the family.
    ToggleFamily,
    /// A right press: the row's context menu opens at the pointer.
    ContextMenu(Point<Pixels>),
    /// The pointer came onto the row (with the row's bounds in the window) or left it.
    Hover(Option<Bounds<Pixels>>),
}

/// What one row shows: the view model the sidebar builds from a listed Chat and its scope.
#[derive(Clone, Debug)]
pub struct ChatRow {
    /// The Chat's key, `<scope>#<id>`.
    pub key: SharedString,
    /// The letter on the tile.
    pub initial: SharedString,
    /// The tile's identity colour; `None` draws the neutral `field` tile.
    pub tile: Option<Rgba>,
    pub title: SharedString,
    /// "project · #PR · +n · computer".
    pub detail: SharedString,
    /// Where in `detail` an offline computer's name starts (drawn in `orange-ink`).
    pub offline: Option<Range<usize>>,
    pub mark: ChatMark,
    /// The last turn failed: an idle row shows the red dot.
    pub failed: bool,
    /// Background work still going, while the mark is Background.
    pub background: usize,
    /// 0 for a top-level Chat, 1 or 2 for a Subchat.
    pub depth: usize,
    pub family: Option<Family>,
}

/// What the menus need about a row that the row does not show (it stays literal-constructible for the Run Chat's
/// row in `routines/page.rs`): where its Chat lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowMeta {
    /// Index into `SidebarData::scopes`.
    pub scope: usize,
    /// The Chat's number in its scope.
    pub id: u64,
}

impl RowMeta {
    pub fn of(shown: &ShownChat) -> Self {
        Self { scope: shown.item.scope, id: shown.item.chat.id }
    }
}

impl ChatRow {
    pub fn new(shown: &ShownChat, data: &SidebarData) -> Self {
        Self::with_show(shown, data, DESKTOP_CHAT_ROW_SHOW)
    }

    /// The row as Filters › Show has it: which facts the second line carries.
    pub fn with_show(shown: &ShownChat, data: &SidebarData, show: ChatRowShow) -> Self {
        let listed = &shown.item;
        let scope = &data.scopes[listed.scope];
        let project = &scope.project;
        let chat = &listed.chat;
        let title: SharedString = chat.display_title(&[]).into();
        // A Chat without a Project (the Chats home) shows its own initial.
        let initial = project_initial(if project.is_chats_home() { &title } else { &project.name });

        let mut parts = vec![project_label(project).to_string()];
        let worktree = scope.state.worktree_of(chat);
        if show.branch
            && let Some(worktree) = worktree
        {
            parts.push(worktree.name.to_string());
        }
        if show.linear_issue
            && let Some(key) = worktree.and_then(|worktree| worktree.linear_issue.as_ref())
        {
            parts.push(key.to_string());
        }
        if show.pull_requests {
            let folder = scope.state.worktree_of(chat).map(|worktree| worktree.path.clone()).unwrap_or_default();
            let refs = chat.summary.as_ref().map(|summary| summary.pull_requests.clone()).unwrap_or_default();
            let prs = row_pull_requests(&scope.pull_requests.chat_pull_requests(&folder, &refs));
            // One PR chip, then the rest as a count (`ROW_PR_LIMIT`).
            if let Some(number) = prs.first().and_then(|pr| pr.number) {
                parts.push(format!("#{number}"));
            }
            if prs.len() > 1 {
                parts.push(format!("+{}", prs.len() - 1));
            }
        }
        if show.diff
            && let Some(diff) = worktree.and_then(|worktree| worktree.diff.as_ref()).filter(|diff| diff.added > 0 || diff.removed > 0)
        {
            parts.push(format!("+{} −{}", diff.added, diff.removed));
        }
        if show.last_activity
            && let Some(at) = listed.last_at
        {
            parts.push(since(at));
        }
        let mut offline = None;
        // The computer, only once there are several (`rowComputer`).
        if show.computer && !data.computers.computers.is_empty() {
            let name = data.computers.name_of(&project.computer);
            let before = parts.iter().map(|part| part.len() + " · ".len()).sum::<usize>();
            if data.computers.is_offline(&project.computer) {
                let text = format!("{name}, offline");
                offline = Some(before..before + text.len());
                parts.push(text);
            } else {
                parts.push(name.to_string());
            }
        }
        Self {
            key: listed.key.clone().into(),
            initial: initial.into(),
            tile: project.tile,
            title,
            detail: parts.join(" · ").into(),
            offline,
            mark: listed.mark,
            failed: listed.failed,
            background: listed.background,
            depth: shown.depth,
            family: shown.family,
        }
    }
}

/// How long ago `at` (ms since the epoch) was, as the desktop's second line says it.
fn since(at: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    crate::logic::lists::chat_row::activity_ago(at as f64, now)
}

pub struct ChatRowView {
    ix: usize,
    row: ChatRow,
    selected: bool,
    /// Shared with the sidebar: every `render` of any row, to check what a frame rebuilt.
    renders: Rc<Cell<usize>>,
    /// Where the row was last painted, for the hover card.
    bounds: Rc<Cell<Bounds<Pixels>>>,
    /// The row is being renamed: the field takes the title's place.
    rename: Option<gpui::AnyView>,
    /// The sidebar's rows drag (`drag.rs`); `pinned` rides along with the drag, `dragging` dims the row meanwhile.
    draggable: bool,
    pinned: bool,
    dragging: bool,
}

impl EventEmitter<RowEvent> for ChatRowView {}

impl ChatRowView {
    pub fn new(ix: usize, row: ChatRow, selected: bool, renders: Rc<Cell<usize>>) -> Self {
        Self { ix, row, selected, renders, bounds: Rc::default(), rename: None, draggable: false, pinned: false, dragging: false }
    }

    /// Lets the row drag (the sidebar's rows; a Run Chat's row elsewhere stays put).
    pub fn set_draggable(&mut self, pinned: bool, dragging: bool) {
        self.draggable = true;
        self.pinned = pinned;
        self.dragging = dragging;
    }

    pub fn set_dragging(&mut self, dragging: bool, cx: &mut Context<Self>) {
        if self.dragging != dragging {
            self.dragging = dragging;
            cx.notify();
        }
    }

    /// Where the row was last painted, in the window.
    pub fn bounds(&self) -> Bounds<Pixels> {
        self.bounds.get()
    }

    /// The rename field in the title's place, or the title again.
    pub fn set_rename(&mut self, field: Option<gpui::AnyView>, cx: &mut Context<Self>) {
        self.rename = field;
        cx.notify();
    }

    /// Sets the field a new view starts with (no repaint to ask for yet).
    pub fn set_rename_silently(&mut self, field: Option<gpui::AnyView>) {
        self.rename = field;
    }

    pub fn set_selected(&mut self, selected: bool, cx: &mut Context<Self>) {
        if self.selected != selected {
            self.selected = selected;
            cx.notify();
        }
    }
}

impl Render for ChatRowView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.set(self.renders.get() + 1);
        let theme = *cx.theme();
        let (ix, row, selected) = (self.ix, &self.row, self.selected);
        let hover = theme.hover;
        let indent = SUBCHAT_INDENT * row.depth.min(2) as f32;
        let detail = match &row.offline {
            Some(range) => StyledText::new(row.detail.clone())
                .with_highlights([(range.clone(), HighlightStyle { color: Some(theme.orange_ink.into()), ..HighlightStyle::default() })]),
            None => StyledText::new(row.detail.clone()),
        };
        // Outer box carries the 8px side inset so the rounded fill stops short of the edges.
        div()
            .relative()
            .w_full()
            .h(ROW_TWO_LINE)
            .pl(px(ROW_INSET + indent))
            .pr(px(ROW_INSET))
            .children(
                GUIDE_X.iter().take(row.depth.min(2)).map(|x| div().absolute().left(px(*x)).top_0().bottom_0().w(px(1.0)).bg(theme.line)),
            )
            .child(
                div()
                    .id(("chat-row", ix))
                    .debug_selector(move || format!("chat-row-{ix}"))
                    .h(ROW_TWO_LINE)
                    .px_2()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(RADIUS_CONTROL)
                    .cursor_pointer()
                    .when(selected, |el| el.bg(theme.hover2))
                    .when(!selected, |el| el.hover(move |style| style.bg(hover)))
                    .when(self.dragging, |el| el.opacity(0.5))
                    .when(self.draggable, |el| {
                        let drag = super::drag::ChatDrag { key: row.key.to_string(), pinned: self.pinned };
                        el.on_drag(drag, |_, _, _, cx| cx.new(|_| super::drag::DragGhost))
                    })
                    .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(RowEvent::Clicked)))
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(|_, event: &gpui::MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            cx.emit(RowEvent::ContextMenu(event.position));
                        }),
                    )
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        cx.emit(RowEvent::Hover(hovered.then(|| this.bounds.get())));
                    }))
                    .child({
                        let cell = self.bounds.clone();
                        canvas(move |bounds, _, _| cell.set(bounds), |_, _, _, _| ()).absolute().size_full()
                    })
                    .child(project_tile(row, &theme))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(match &self.rename {
                                Some(field) => div().h(px(18.0)).child(field.clone()).into_any_element(),
                                None => div()
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .truncate()
                                    .child(row.title.clone())
                                    .into_any_element(),
                            })
                            .child(
                                div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).truncate().child(detail),
                            ),
                    )
                    .child(div().flex().flex_none().items_center().justify_center().w(px(MARK_SLOT)).child(status_mark(ix, row, &theme))),
            )
            .when_some(row.family, |el, family| el.child(family_badge(ix, family, indent, &theme, cx)))
    }
}

/// A project tile: the project's identity colour, or `field`, with its initial at 600. (The spike's look;
/// DESIGN.md's default tile is an ink fill, which `ProjectAvatar` draws without `.colors`.)
pub(super) fn project_tile(row: &ChatRow, theme: &Theme) -> ProjectAvatar {
    let (fill, ink) = match row.tile {
        Some(color) => (color, hex("#ffffff")),
        None => (theme.field, theme.ink2),
    };
    ProjectAvatar::new(&row.initial).size(TILE_SIZE).colors(fill, ink)
}

pub fn dot_mark(color: Rgba) -> gpui::Div {
    div().flex_none().size(px(8.0)).rounded_full().bg(color)
}

/// A palette key's colour.
fn tone_color(tone: Tone, theme: &Theme) -> Rgba {
    match tone {
        Tone::Accent => theme.accent,
        Tone::Green => theme.green,
        Tone::Orange => theme.orange,
        Tone::Red => theme.red,
        Tone::Ink3 => theme.ink3,
        Tone::Ink4 => theme.ink4,
    }
}

/// The trailing mark, as the desktop's `ChatMarkDotInline` draws it from `chat_mark_presentation`: a spinner ring
/// while running, the background ring with its count, the mark's glyph in its tone when the Chat needs the user or
/// works on a Delegation, the red dot for an idle Chat whose last turn failed, the accent dot when unread.
pub(super) fn status_mark(ix: usize, row: &ChatRow, theme: &Theme) -> gpui::AnyElement {
    let mark = if row.mark == ChatMark::Idle && row.failed { ChatMark::Failed } else { row.mark };
    let presentation = chat_mark_presentation(mark);
    let color = tone_color(presentation.tone, theme);
    let glyph = |name: IconName| Icon::new(name).size(IconSize::S14).color(color).into_any_element();
    match presentation.icon {
        _ if mark == ChatMark::Idle => div().into_any_element(),
        MarkIcon::Spinner => {
            let ring = SpinnerRing::new();
            // The spin re-renders this row's view (cheap) and its ancestors, never the other rows.
            if crate::ui::motion() { ring.animated(("chat-row-spinner", ix)).into_any_element() } else { ring.into_any_element() }
        }
        MarkIcon::Ring => background_ring(row.background, theme).into_any_element(),
        MarkIcon::ShieldAlert => glyph(IconName::ShieldAlert),
        MarkIcon::Bubble => glyph(IconName::BubbleChatQuestion),
        MarkIcon::Link => glyph(IconName::Link04),
        MarkIcon::Alert => glyph(IconName::Alert02),
        MarkIcon::Dot => dot_mark(color).into_any_element(),
    }
}

/// `BackgroundMark`: a 16px ring in `ink-3` with how much background work goes on ("9+" past nine).
fn background_ring(count: usize, theme: &Theme) -> impl IntoElement + use<> {
    let label = match count {
        0 => String::new(),
        1..=9 => count.to_string(),
        _ => "9+".to_owned(),
    };
    div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(BADGE_SIZE))
        .rounded_full()
        .border_1()
        .border_color(theme.ink3)
        .text_step(TEXT_10)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.ink3)
        .child(label)
}

/// A family's count over its parent's tile: `line-strong` folded, `accent-tint` open, orange when a Subchat waits on
/// the user. Clicking it folds or unfolds the family.
fn family_badge(ix: usize, family: Family, indent: f32, theme: &Theme, cx: &mut Context<ChatRowView>) -> impl IntoElement + use<> {
    let (fill, ink) = if family.asking {
        (theme.orange, hex("#000000"))
    } else if family.folded {
        (theme.line_strong, theme.ink)
    } else {
        (theme.accent_tint, theme.accent_ink)
    };
    div()
        .id(("chat-family", ix))
        .debug_selector(move || format!("chat-family-{ix}"))
        .absolute()
        .top(px(BADGE_TOP))
        .left(px(BADGE_LEFT + indent))
        .h(px(BADGE_SIZE))
        .min_w(px(BADGE_SIZE))
        .px(px(4.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(theme.surface)
        .border_2()
        .border_color(theme.surface)
        .child(div().absolute().inset_0().rounded_full().bg(fill))
        .child(div().relative().text_step(TEXT_10).font_weight(FontWeight::SEMIBOLD).text_color(ink).child(family.count.to_string()))
        .cursor_pointer()
        .on_click(cx.listener(|_, _: &ClickEvent, _, cx| {
            cx.stop_propagation();
            cx.emit(RowEvent::ToggleFamily);
        }))
}
