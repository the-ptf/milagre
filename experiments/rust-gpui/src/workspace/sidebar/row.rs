//! One two-line Chat row (54px), as a view of its own.
//!
//! The sidebar's list mounts each visible row as a cached view (`AnyView::cached` at the row's fixed
//! size). So when the sidebar re-renders (a logo finished loading, a row's spinner turned, the selection
//! moved), GPUI reuses every row whose view did not change instead of building it again; only a row that
//! called `cx.notify()` renders. Rows tell the sidebar about clicks with [`RowEvent`], not by updating it
//! from inside their own listener (that would borrow the row view twice when the sidebar updates it back).
//!
//! The look is the owner's pick "Alt A, status on the edge, title first" (design `gpui-sidebar-v-a` v3):
//!
//! - line 1: a pinned Chat's pin, the title (ink; ink-2 for a Done or read idle Chat), and at the right edge the
//!   state: an approval's shield in orange, a question's bubble in accent, a failure's alert in red, a Done check in
//!   green, a quiet ink-4 spinner while it works, or for an idle Chat how long ago it last moved ("2d");
//! - line 2: the Project's 14px mark and name (a Chat without a Project: a bubble and "Chat"), the computer, and at
//!   the right edge the PR number in green ("+n" for several);
//! - hovering swaps the state for "Done", which moves the Chat to the Done list through the sidebar (Reopen is on the
//!   Done list's rows only).
//!
//! The data still follows the desktop's inbox row (`ChatRow.tsx`): `detail` is its "project · #PR · +n · computer"
//! line, which the Chat column and the tests read; the row draws from the split fields.

use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    Bounds, ClickEvent, Context, EventEmitter, FontWeight, MouseButton, Pixels, Point, Rgba, SharedString, Window, canvas, div, prelude::*,
    px,
};

use super::list::{ShownChat, SidebarData, list_clock, project_label};
use crate::logic::identity::project_list::project_initial;
use crate::logic::lists::chat_row::{ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
use crate::logic::marks::{ChatMark, MarkIcon, Tone, chat_mark_presentation};
use crate::logic::prs::blockers::{PrIcon, PrTone, pull_request_presentation, row_pull_requests};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_10, TEXT_12, TextStep, TextStepExt, Theme, hex, sidebar_step};
use crate::ui::press::{Press, ROW_DURATION, ROW_SCALE};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, Spinner};

/// Horizontal inset of each row inside the sidebar.
pub const ROW_INSET: f32 = 8.0;
/// A row's box, and the 2px between two rows (half above, half below each box).
pub const ROW_HEIGHT: f32 = 54.0;
pub const ROW_GAP: f32 = 2.0;
/// What one list item takes: the box and its share of the gaps.
pub const ROW_PITCH: f32 = ROW_HEIGHT + ROW_GAP;
const ROW_PAD_X: f32 = 14.0;
const ROW_PAD_TOP: f32 = 8.0;
/// Between the title's line and the second line.
const LINE_GAP: f32 = 3.0;
/// The title: 14px on a 20px line (between DESIGN.md's text-13 and text-15; the design asks for 14).
const TITLE_STEP: TextStep = TextStep { size: 14.0, line_height: 20.0 };
/// Between the title and the state at the right edge.
const STATE_GAP: f32 = 8.0;
/// Between the pin and the title, and between the second line's pieces.
const META_GAP: f32 = 5.0;
/// The Project's mark on the second line, and its letter.
const MARK_SIZE: f32 = 14.0;
const MARK_RADIUS: f32 = 4.0;
const MARK_LETTER: TextStep = TextStep { size: 8.0, line_height: 11.0 };
/// The working spinner (a hair under the 14px glyphs, as the design draws it).
const SPINNER_SIZE: f32 = 13.0;
/// Between the hover action's glyph and its word.
const ACTION_GAP: f32 = 4.0;
const TILE_SIZE: f32 = 24.0;
/// The background-work ring the hover card and the rail's card show (16px).
const BADGE_SIZE: f32 = 16.0;

pub enum RowEvent {
    Clicked,
    /// A right press: the row's context menu opens at the pointer.
    ContextMenu(Point<Pixels>),
    /// The pointer came onto the row (with the row's bounds in the window) or left it.
    Hover(Option<Bounds<Pixels>>),
    /// The hover action: "Done".
    ToggleDone,
    /// The PR chip (`PullRequestChip`): open the Chat with this PR in its PR panel.
    OpenPullRequest(u32),
}

/// What one row shows: the view model the sidebar builds from a listed Chat and its scope.
#[derive(Clone, Debug)]
pub struct ChatRow {
    /// The Chat's key, `<scope>#<id>`.
    pub key: SharedString,
    /// The letter on the tile.
    pub initial: SharedString,
    /// The tile's identity colour; `None` draws the neutral tile.
    pub tile: Option<Rgba>,
    /// The Project's picture (`project:image`), drawn in the tile and the mark instead of the letter.
    pub image: Option<std::sync::Arc<gpui::Image>>,
    pub title: SharedString,
    /// "project · #PR · +n · computer" (the desktop's one line; the Chat column reads the Project from it).
    pub detail: SharedString,
    /// Where in `detail` an offline computer's name starts (drawn in `orange-ink`).
    pub offline: Option<Range<usize>>,
    pub mark: ChatMark,
    /// The last turn failed: an idle row shows the red alert.
    pub failed: bool,
    /// Background work still going, while the mark is Background.
    pub background: usize,
    /// The second line's Project name ("Chat" for a Chat without a Project).
    pub project: SharedString,
    /// The Chat lives in a Chats home: a bubble stands in for the Project's mark.
    pub chats_home: bool,
    /// What Filters › Show adds after the Project (branch, Linear issue, diff, last activity), " · "-joined.
    pub extra: SharedString,
    /// The computer, when Filters › Show has it ("tianxu, offline" while it is).
    pub computer: Option<SharedString>,
    /// The PR at the right edge: its number, or "+n" for several.
    pub prs: Option<SharedString>,
    /// The first PR's number, which the chip opens.
    pub pr_number: Option<u32>,
    /// The first PR's look (`prLook`): its state's glyph and tone, and its title for the chip's tooltip.
    pub pr_look: Option<RowPrLook>,
    /// How long ago the Chat last moved ("2d"), for an idle row's right edge.
    pub recency: Option<SharedString>,
    /// Marked Done (only the Done list's rows are).
    pub done: bool,
    /// How long the Chat ran, first message to last ("20:20", "1:02:10"): a Done row's right edge.
    pub ran: Option<SharedString>,
}

/// Equal when a row would draw the same: the picture compares by identity (one read shares one `Arc`).
impl PartialEq for ChatRow {
    fn eq(&self, other: &Self) -> bool {
        let same_image = match (&self.image, &other.image) {
            (Some(a), Some(b)) => std::sync::Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        same_image
            && self.key == other.key
            && self.initial == other.initial
            && self.tile == other.tile
            && self.title == other.title
            && self.detail == other.detail
            && self.offline == other.offline
            && self.mark == other.mark
            && self.failed == other.failed
            && self.background == other.background
            && self.project == other.project
            && self.chats_home == other.chats_home
            && self.extra == other.extra
            && self.computer == other.computer
            && self.prs == other.prs
            && self.pr_number == other.pr_number
            && self.pr_look == other.pr_look
            && self.recency == other.recency
            && self.done == other.done
            && self.ran == other.ran
    }
}

impl Default for ChatRow {
    fn default() -> Self {
        Self {
            key: SharedString::default(),
            initial: SharedString::default(),
            tile: None,
            image: None,
            title: SharedString::default(),
            detail: SharedString::default(),
            offline: None,
            mark: ChatMark::Idle,
            failed: false,
            background: 0,
            project: SharedString::default(),
            chats_home: false,
            extra: SharedString::default(),
            computer: None,
            prs: None,
            pr_number: None,
            pr_look: None,
            recency: None,
            done: false,
            ran: None,
        }
    }
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
        let mut extra = Vec::new();
        let worktree = scope.state.worktree_of(chat);
        if show.branch
            && let Some(worktree) = worktree
        {
            parts.push(worktree.name.to_string());
            extra.push(worktree.name.to_string());
        }
        if show.linear_issue
            && let Some(key) = worktree.and_then(|worktree| worktree.linear_issue.as_ref())
        {
            parts.push(key.to_string());
            extra.push(key.to_string());
        }
        let mut prs_label = None;
        let mut pr_number = None;
        let mut pr_look = None;
        if show.pull_requests {
            let folder = scope.state.worktree_of(chat).map(|worktree| worktree.path.clone()).unwrap_or_default();
            let refs = chat.summary.as_ref().map(|summary| summary.pull_requests.clone()).unwrap_or_default();
            let prs = row_pull_requests(&scope.pull_requests.chat_pull_requests(&folder, &refs));
            // One PR chip, then the rest as a count (`ROW_PR_LIMIT`).
            if let Some(number) = prs.first().and_then(|pr| pr.number) {
                parts.push(format!("#{number}"));
                pr_number = Some(number);
                let look = pull_request_presentation(&prs[0]);
                pr_look = Some(RowPrLook { icon: look.icon, tone: look.tone, title: prs[0].title.clone().into() });
            }
            if prs.len() > 1 {
                parts.push(format!("+{}", prs.len() - 1));
            }
            // The row's right edge: the number, or how many there are.
            prs_label = match prs.len() {
                0 => None,
                1 => prs[0].number.map(|number| number.to_string()),
                n => Some(format!("+{n}")),
            };
        }
        if show.diff
            && let Some(diff) = worktree.and_then(|worktree| worktree.diff.as_ref()).filter(|diff| diff.added > 0 || diff.removed > 0)
        {
            parts.push(format!("+{} −{}", diff.added, diff.removed));
            extra.push(format!("+{} −{}", diff.added, diff.removed));
        }
        let recency = listed.last_at.map(since);
        if show.last_activity
            && let Some(ago) = &recency
        {
            parts.push(ago.clone());
            extra.push(ago.clone());
        }
        let mut offline = None;
        let mut computer = None;
        if show.computer {
            let name = data.computers.name_of(&project.computer);
            let text = if data.computers.is_offline(&project.computer) { format!("{name}, offline") } else { name.to_string() };
            // The detail line names the computer only once there are several (`rowComputer`); the row always does.
            if !data.computers.computers.is_empty() {
                let before = parts.iter().map(|part| part.len() + " · ".len()).sum::<usize>();
                if data.computers.is_offline(&project.computer) {
                    offline = Some(before..before + text.len());
                }
                parts.push(text.clone());
            }
            computer = Some(text.into());
        }
        Self {
            key: listed.key.clone().into(),
            initial: initial.into(),
            tile: project.tile,
            image: if project.is_chats_home() { None } else { project.image.clone() },
            title,
            detail: parts.join(" · ").into(),
            offline,
            mark: listed.mark,
            failed: listed.failed,
            background: listed.background,
            project: if project.is_chats_home() { "Chat".into() } else { project.name.clone() },
            chats_home: project.is_chats_home(),
            extra: extra.join(" · ").into(),
            computer,
            prs: prs_label.map(Into::into),
            pr_number,
            pr_look,
            recency: recency.map(Into::into),
            done: chat.is_done(),
            ran: listed.first_at.zip(listed.last_at).map(|(first, last)| ran_label(last - first).into()),
        }
    }

    /// What the right edge of the first line says about the Chat.
    pub fn state(&self) -> RowState {
        match self.mark {
            ChatMark::Waiting => RowState::Approval,
            ChatMark::Question => RowState::Question,
            ChatMark::Running | ChatMark::Background => RowState::Working,
            ChatMark::Delegated => RowState::Delegated,
            ChatMark::Interrupted => RowState::Interrupted,
            _ if self.done => RowState::Done,
            ChatMark::Failed => RowState::Failed,
            _ if self.failed => RowState::Failed,
            ChatMark::Unread => RowState::Idle { unread: true },
            _ => RowState::Idle { unread: false },
        }
    }

    /// The title is dimmed for a Done Chat and for an idle one already read.
    pub fn dimmed(&self) -> bool {
        matches!(self.state(), RowState::Done | RowState::Idle { unread: false })
    }
}

/// The state at a row's right edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Approval,
    Question,
    Failed,
    Done,
    Working,
    /// Working on a Delegation.
    Delegated,
    Interrupted,
    /// Nothing going on: the recency (brighter and medium while unread, never coloured: Victor, 2026-11-12).
    Idle {
        unread: bool,
    },
}

/// A run's length as a clock: "m:ss" under an hour, "h:mm:ss" from one.
pub fn ran_label(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// How long ago `at` (ms since the epoch) was, as the desktop's second line says it.
fn since(at: i64) -> String {
    crate::logic::lists::chat_row::activity_ago(at as f64, list_clock() as f64)
}

pub struct ChatRowView {
    pub(super) ix: usize,
    pub(super) row: ChatRow,
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
    /// The pointer is on the row: the state gives way to the Done action. Kept here, not in a hover style, because
    /// the swap changes the layout (the title gets shorter) and a hover style must not change it between prepaint and
    /// paint.
    pub(super) hovered: bool,
    /// The pointer is on the Done action itself: it brightens from ink-2 to ink, as the desktop's `hover:text-ink`.
    done_hovered: bool,
    /// The pointer is on the PR chip: its state glyph gives way to the link glyph and the number turns ink.
    pr_hovered: bool,
    /// Snapshot seed: draw the row as hovered, its Done action showing.
    show_hover: bool,
}

impl EventEmitter<RowEvent> for ChatRowView {}

/// Where a row view sits in the list as the rows were last built (`ChatRowView::place`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub ix: usize,
    pub selected: bool,
    pub pinned: bool,
    pub dragging: bool,
    pub show_hover: bool,
}

impl ChatRowView {
    pub fn new(ix: usize, row: ChatRow, selected: bool, renders: Rc<Cell<usize>>) -> Self {
        Self {
            ix,
            row,
            selected,
            renders,
            bounds: Rc::default(),
            rename: None,
            draggable: false,
            pinned: false,
            dragging: false,
            hovered: false,
            done_hovered: false,
            pr_hovered: false,
            show_hover: false,
        }
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

    /// Whether the pointer is on the Done action (drawn in ink rather than ink-2).
    #[cfg(test)]
    pub(super) fn done_hovered(&self) -> bool {
        self.done_hovered
    }

    /// Draws the row as if the pointer rested on it (the hovered-row snapshot).
    pub fn set_show_hover(&mut self, show: bool) {
        self.show_hover = show;
        // Snapshot aid (never in tests): `MILAGRE_GPUI_SIDEBAR_DONE_HOVER=1` also puts the pointer on the Done action.
        self.done_hovered = show && !cfg!(test) && std::env::var_os("MILAGRE_GPUI_SIDEBAR_DONE_HOVER").is_some();
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

    /// The rows were built again: this Chat's row now sits at `place.ix` and shows `row`. Renders again only when
    /// something it draws changed; the pointer's hover stays (the view is the same, keyed by the Chat).
    pub fn place(&mut self, place: Place, row: &ChatRow, rename: Option<gpui::AnyView>, cx: &mut Context<Self>) {
        let renaming_changed = self.rename.as_ref().map(|v| v.entity_id()) != rename.as_ref().map(|v| v.entity_id());
        let now = Place { ix: self.ix, selected: self.selected, pinned: self.pinned, dragging: self.dragging, show_hover: self.show_hover };
        if now == place && self.row == *row && !renaming_changed {
            return;
        }
        self.ix = place.ix;
        self.selected = place.selected;
        self.pinned = place.pinned;
        self.dragging = place.dragging;
        if self.show_hover != place.show_hover {
            self.set_show_hover(place.show_hover);
        }
        if self.row != *row {
            self.row = row.clone();
        }
        self.rename = rename;
        cx.notify();
    }

    /// Drawn as the selected row.
    #[cfg(test)]
    pub fn is_selected(&self) -> bool {
        self.selected
    }

    pub fn set_selected(&mut self, selected: bool, cx: &mut Context<Self>) {
        if self.selected != selected {
            self.selected = selected;
            cx.notify();
        }
    }
}

impl Render for ChatRowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.set(self.renders.get() + 1);
        // An offline computer's row is greyscale (its computer keeps the desktop's orange "offline") and half strength.
        let offline = row_offline(&self.row);
        let theme = if offline { greyed(cx.theme()) } else { *cx.theme() };
        let (ix, row, selected, hovered) = (self.ix, &self.row, self.selected, self.hovered || self.show_hover);
        let hover = theme.hover;
        // The computer brightens to ink-3 on the hovered and the selected row.
        let computer_ink = if selected || hovered { theme.ink3 } else { theme.ink4 };
        let title_ink = if row.dimmed() { theme.ink2 } else { theme.ink };

        let title_line = div()
            .flex()
            .items_center()
            .h(px(TITLE_STEP.line_height))
            .gap(px(STATE_GAP))
            .child(match &self.rename {
                Some(field) => div().flex_1().min_w_0().h(px(18.0)).child(field.clone()).into_any_element(),
                None => div()
                    .flex()
                    .flex_1()
                    .items_center()
                    .gap(px(META_GAP))
                    .min_w_0()
                    .when(self.pinned, |el| {
                        el.child(
                            div()
                                .debug_selector(|| "chat-pinned".into())
                                .flex_none()
                                .child(Icon::new(IconName::Pin).size(IconSize::S12).color(theme.ink4)),
                        )
                    })
                    .child(
                        div()
                            .min_w_0()
                            .text_step(sidebar_step(TITLE_STEP))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(title_ink)
                            .truncate()
                            .child(row.title.clone()),
                    )
                    .into_any_element(),
            })
            .child(right_edge(ix, row, hovered, self.done_hovered, &theme, cx));

        let meta = div()
            .flex()
            .items_center()
            .h(px(TEXT_12.line_height))
            .gap(px(META_GAP))
            .text_step(sidebar_step(TEXT_12))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .items_center()
                    .gap(px(META_GAP))
                    .min_w_0()
                    .overflow_hidden()
                    .child(project_mark_as(row, &theme, if offline { MarkLook::Grey } else { MarkLook::Colour }))
                    .child(div().flex_none().text_color(theme.ink3).child(row.project.clone()))
                    .when(!row.extra.is_empty(), |el| el.child(div().min_w_0().truncate().text_color(theme.ink4).child(row.extra.clone())))
                    .children(row.computer.clone().map(|name| {
                        let ink = if row.offline.is_some() { theme.orange_ink } else { computer_ink };
                        div()
                            .flex()
                            .items_center()
                            .gap(px(META_GAP))
                            .min_w_0()
                            .child(Icon::new(IconName::Laptop).size(IconSize::S12).color(ink))
                            .child(
                                div()
                                    .debug_selector(move || format!("chat-row-computer-{ix}"))
                                    .min_w_0()
                                    .truncate()
                                    .text_color(ink)
                                    .child(name),
                            )
                    })),
            )
            .children(row.prs.clone().map(|prs| {
                let number = row.pr_number;
                let look = row.pr_look.clone();
                let (glyph, tone) =
                    look.as_ref().map_or((IconName::GitPullRequest, theme.green), |look| (look.glyph(), look.color(&theme)));
                let ink = theme.ink;
                // `PullRequestChip`: under the pointer the number turns ink and the state glyph gives way to the link
                // glyph (`LinkSquare02Icon`), no underline; the PR is named in a tooltip. The swap is the view's state,
                // so a test can see it.
                let pr_hovered = self.pr_hovered || (self.show_hover && std::env::var_os("MILAGRE_GPUI_SIDEBAR_PR_HOVER").is_some());
                let glyph_el = if pr_hovered {
                    div()
                        .debug_selector(move || format!("chat-row-pr-link-{ix}"))
                        .flex_none()
                        .child(Icon::new(IconName::LinkSquare02).size(IconSize::S12).color(ink))
                } else {
                    div()
                        .debug_selector(move || format!("chat-row-pr-glyph-{ix}"))
                        .flex_none()
                        .child(Icon::new(glyph).size(IconSize::S12).color(tone))
                };
                div()
                    .id("chat-row-prs")
                    .debug_selector(move || format!("chat-row-prs-{ix}"))
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        if this.pr_hovered != *hovered {
                            this.pr_hovered = *hovered;
                            cx.notify();
                        }
                    }))
                    .when_some(look.zip(number), |el, (look, number)| el.tooltip(look.tooltip(number)))
                    .when_some(number, |el, number| {
                        // A plain click opens the PR in the Chat's PR panel (`openRowPullRequest`), not the row's click.
                        el.cursor_pointer().on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                            cx.stop_propagation();
                            cx.emit(RowEvent::OpenPullRequest(number));
                        }))
                    })
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(META_GAP))
                    .text_color(if pr_hovered { ink } else { tone })
                    .child(glyph_el)
                    .child(prs)
            }));

        // `active:scale-[0.98]` over 150 ms: the fill shrinks, the row's view alone renders (`ui::press`).
        let press = Press::with(("chat-row", ix), ROW_SCALE, ROW_DURATION, window, cx);
        let engaged = press.engaged();
        let face = engaged.then(|| press.face(Some(if selected { theme.hover2 } else { hover }.into()), RADIUS_CONTROL));
        // Outer box: the 8px side inset and half a gap above and below, so the rounded fill stops short of the edges.
        div().relative().w_full().h(px(ROW_PITCH)).px(px(ROW_INSET)).py(px(ROW_GAP / 2.0)).child(
            div()
                // A fixed id inside the row's own view (keyed by its Chat): the element keeps its hover and click
                // state when the row moves to another index.
                .id("chat-row")
                .debug_selector(move || format!("chat-row-{ix}"))
                .h(px(ROW_HEIGHT))
                .px(px(ROW_PAD_X))
                .pt(px(ROW_PAD_TOP))
                .flex()
                .flex_col()
                .gap(px(LINE_GAP))
                .rounded(RADIUS_CONTROL)
                .cursor_pointer()
                .map(|el| press.wire(el))
                .when(selected && !engaged, |el| el.bg(theme.hover2))
                .when(!selected && self.show_hover && !engaged, |el| el.bg(hover))
                .when(!selected && !engaged, |el| el.hover(move |style| style.bg(hover)))
                .when(self.dragging || offline, |el| el.opacity(OFFLINE_OPACITY))
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
                    if this.hovered != *hovered {
                        this.hovered = *hovered;
                        this.done_hovered &= *hovered;
                        cx.notify();
                    }
                    cx.emit(RowEvent::Hover(hovered.then(|| this.bounds.get())));
                }))
                .children(face)
                .child({
                    let cell = self.bounds.clone();
                    canvas(move |bounds, _, _| cell.set(bounds), |_, _, _, _| ()).absolute().size_full()
                })
                .child(title_line)
                .child(meta),
        )
    }
}

/// A row PR's look (`prLook`): the glyph and tone of its state, and its title.
#[derive(Clone, Debug, PartialEq)]
pub struct RowPrLook {
    pub icon: PrIcon,
    pub tone: PrTone,
    pub title: SharedString,
}

impl RowPrLook {
    /// `PR_ICONS` (the checking dot draws the open glyph: the set has no circle-dot).
    pub fn glyph(&self) -> IconName {
        match self.icon {
            PrIcon::Merged => IconName::GitMerge,
            PrIcon::Closed => IconName::GitPullRequestClosed,
            PrIcon::Draft => IconName::GitPullRequestDraft,
            PrIcon::Ready => IconName::Tick02,
            PrIcon::Checking | PrIcon::Open => IconName::GitPullRequest,
        }
    }

    /// `PR_TONES`.
    pub fn color(&self, theme: &Theme) -> Rgba {
        match self.tone {
            PrTone::Purple => theme.purple,
            PrTone::Red => theme.red,
            PrTone::Orange => theme.orange,
            PrTone::Green => theme.green,
            PrTone::Ink3 => theme.ink3,
        }
    }

    /// The chip's tooltip: the state's glyph in its tone, `#980` in mono, then the title cut with an ellipsis.
    fn tooltip(&self, number: u32) -> impl Fn(&mut gpui::Window, &mut gpui::App) -> gpui::AnyView + 'static {
        let look = self.clone();
        crate::ui::Tooltip::rich(move |theme| {
            div()
                .debug_selector(|| "chat-row-pr-tooltip".into())
                .flex()
                .items_center()
                .gap(px(6.0))
                .max_w(px(PR_TOOLTIP_WIDTH))
                .child(Icon::new(look.glyph()).size(IconSize::S12).color(look.color(theme)))
                .child(div().flex_none().font_family(crate::theme::mono()).child(format!("#{number}")))
                .child(div().min_w_0().truncate().child(look.title.clone()))
                .into_any_element()
        })
    }
}

/// The PR tooltip's widest (the desktop's tooltips wrap at 280; this one cuts its title instead).
const PR_TOOLTIP_WIDTH: f32 = 280.0;

/// The first line's right edge: the state, or the Done action while the pointer is on the row. The action rests in
/// ink-2 and brightens to ink while the pointer is on it (`hover:text-ink` on the desktop's `data-chat-done`).
fn right_edge(
    ix: usize,
    row: &ChatRow,
    hovered: bool,
    done_hovered: bool,
    theme: &Theme,
    cx: &mut Context<ChatRowView>,
) -> gpui::AnyElement {
    if !hovered {
        return div()
            .debug_selector(move || format!("chat-row-state-{ix}"))
            .flex()
            .flex_none()
            .items_center()
            .child(state_mark(ix, row, theme))
            .into_any_element();
    }
    let ink = if done_hovered { theme.ink } else { theme.ink2 };
    div()
        .id("chat-row-action")
        .debug_selector(move || format!("chat-row-action-{ix}"))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(ACTION_GAP))
        .text_step(sidebar_step(TEXT_12))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .cursor_pointer()
        .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
            if this.done_hovered != *hovered {
                this.done_hovered = *hovered;
                cx.notify();
            }
        }))
        .on_click(cx.listener(|_, _: &ClickEvent, _, cx| {
            cx.stop_propagation();
            cx.emit(RowEvent::ToggleDone);
        }))
        .child(Icon::new(IconName::Tick02).size(IconSize::S14).color(ink))
        .child("Done")
        .into_any_element()
}

/// The state at the right edge of a row's first line (see [`RowState`]).
fn state_mark(ix: usize, row: &ChatRow, theme: &Theme) -> gpui::AnyElement {
    let glyph = |name: IconName, color: Rgba| Icon::new(name).size(IconSize::S14).color(color).into_any_element();
    match row.state() {
        RowState::Approval => glyph(IconName::ShieldQuestionMark, theme.orange),
        RowState::Question => glyph(IconName::BubbleChatQuestion, theme.accent),
        RowState::Failed => glyph(IconName::AlertCircle, theme.red),
        RowState::Done => glyph(IconName::CheckmarkCircle02, theme.green),
        RowState::Delegated => glyph(IconName::Link04, theme.accent),
        RowState::Interrupted => glyph(IconName::Alert02, theme.orange),
        // The ring turns in a view of its own: a frame renders it and this row (its cached parent), never the other
        // rows, the transcript or the panel (`ui::motion_tests`).
        RowState::Working => Spinner::new(("chat-row-spinner", ix)).size(SPINNER_SIZE).color(theme.ink4).into_any_element(),
        RowState::Idle { unread } => match &row.recency {
            Some(ago) => div()
                .text_step(sidebar_step(TEXT_12))
                .text_color(if unread { theme.ink } else { theme.ink4 })
                .when(unread, |el| el.font_weight(FontWeight::MEDIUM))
                .child(ago.clone())
                .into_any_element(),
            None if unread => dot_mark(theme.accent).into_any_element(),
            None => div().into_any_element(),
        },
    }
}

/// How a Project mark is drawn: in its colour, greyed (an offline computer's row), or greyed until the pointer is on
/// the element of this group (a Done row).
#[derive(Clone, PartialEq, Eq)]
pub(super) enum MarkLook {
    Colour,
    Grey,
    GreyUntilHover(SharedString),
}

/// An offline computer's row (and a dragged one) at half strength (the desktop's `opacity-50`).
pub(super) const OFFLINE_OPACITY: f32 = 0.5;

/// The Chat's computer is offline.
pub(super) fn row_offline(row: &ChatRow) -> bool {
    row.offline.is_some()
}

/// The theme an offline computer's row draws with: every state colour (accent, green, orange, red) is `ink-4`, so the
/// row is greyscale. `orange-ink`, the computer's "offline", stays (the desktop keeps it orange).
pub(super) fn greyed(theme: &Theme) -> Theme {
    Theme { accent: theme.ink4, green: theme.ink4, orange: theme.ink4, red: theme.ink4, ..*theme }
}

/// The second line's Project mark: the Project's colour (or the neutral `line-strong`) with its letter, or for a Chat
/// without a Project a grey bubble; in a [`MarkLook`]. Greyed, the fill is `hover-2` and the letter `ink-4`.
pub(super) fn project_mark_as(row: &ChatRow, theme: &Theme, look: MarkLook) -> gpui::AnyElement {
    if row.chats_home {
        return Icon::new(IconName::BubbleChat).size(IconSize::S14).color(theme.ink4).into_any_element();
    }
    let (fill, ink) = match row.tile {
        Some(color) => (color, hex("#ffffff")),
        None => (theme.line_strong, theme.ink),
    };
    let (grey_fill, grey_ink) = (theme.hover2, theme.ink4);
    let letter = row.initial.chars().next().map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_default();
    if let Some(image) = row.image.clone() {
        // The picture in the mark's square and rounding, on its fill; greyed with the row.
        let grey = look != MarkLook::Colour;
        return div()
            .flex_none()
            .size(px(MARK_SIZE))
            .rounded(px(MARK_RADIUS))
            .bg(if grey { grey_fill } else { fill })
            .child(crate::ui::project_image(image, MARK_SIZE, px(MARK_RADIUS)))
            .when(grey, |el| el.opacity(0.6))
            .into_any_element();
    }
    let mark = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(MARK_SIZE))
        .rounded(px(MARK_RADIUS))
        .text_step(MARK_LETTER)
        .font_weight(FontWeight::BOLD);
    match look {
        MarkLook::Colour => mark.bg(fill).text_color(ink),
        MarkLook::Grey => mark.bg(grey_fill).text_color(grey_ink),
        MarkLook::GreyUntilHover(group) => {
            mark.bg(grey_fill).text_color(grey_ink).group_hover(group, move |style| style.bg(fill).text_color(ink))
        }
    }
    .child(letter)
    .into_any_element()
}

/// A project tile: the project's identity colour, or `field`, with its initial at 600. (The spike's look;
/// DESIGN.md's default tile is an ink fill, which `ProjectAvatar` draws without `.colors`.)
pub(super) fn project_tile(row: &ChatRow, theme: &Theme) -> ProjectAvatar {
    let (fill, ink) = match row.tile {
        Some(color) => (color, hex("#ffffff")),
        None => (theme.field, theme.ink2),
    };
    ProjectAvatar::new(&row.initial).size(TILE_SIZE).colors(fill, ink).image(row.image.clone())
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

/// The mark the hover card and the rail's card show beside a Chat, as the desktop's `ChatMarkDotInline` draws it from
/// `chat_mark_presentation`: a spinner ring while running, the background ring with its count, the mark's glyph in
/// its tone when the Chat needs the user or works on a Delegation, the red alert for an idle Chat whose last turn
/// failed, the accent dot when unread.
pub(super) fn status_mark(ix: usize, row: &ChatRow, theme: &Theme) -> gpui::AnyElement {
    let mark = if row.mark == ChatMark::Idle && row.failed { ChatMark::Failed } else { row.mark };
    let presentation = chat_mark_presentation(mark);
    let color = tone_color(presentation.tone, theme);
    let glyph = |name: IconName| Icon::new(name).size(IconSize::S14).color(color).into_any_element();
    match presentation.icon {
        _ if mark == ChatMark::Idle && row.done => glyph_in(IconName::CheckmarkCircle02, theme.green),
        _ if mark == ChatMark::Idle => div().into_any_element(),
        MarkIcon::Spinner => Spinner::new(("chat-row-spinner", ix)).into_any_element(),
        MarkIcon::Ring => background_ring(row.background, theme).into_any_element(),
        MarkIcon::ShieldAlert => glyph(IconName::ShieldQuestionMark),
        MarkIcon::Bubble => glyph(IconName::BubbleChatQuestion),
        MarkIcon::Link => glyph(IconName::Link04),
        MarkIcon::Alert if mark == ChatMark::Failed => glyph(IconName::AlertCircle),
        MarkIcon::Alert => glyph(IconName::Alert02),
        MarkIcon::Dot => dot_mark(color).into_any_element(),
    }
}

fn glyph_in(name: IconName, color: Rgba) -> gpui::AnyElement {
    Icon::new(name).size(IconSize::S14).color(color).into_any_element()
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
