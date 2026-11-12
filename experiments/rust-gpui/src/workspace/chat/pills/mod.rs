//! The pill row over the composer (`ChatComposer.tsx`'s chip row, `PillMorph.tsx`, `StatusPill.tsx`): the PR action
//! and the review comments at the left; Tasks, Subagents and "Go to bottom" at the right. (Subchats and Ports are in
//! the Details panel, not here.) Tasks and Subagents morph in place into their panel (`morph.rs`): one surface hung
//! from the pill's bottom-right corner, the panel opening up and to the left over the transcript without moving the
//! row. Each pill hugs its content: the slot is as wide as the pill's measured text.
//!
//! `PillRow` is one plain view (not cached: an open panel is taller than the row, and a cached view is laid out
//! from its style alone). It re-renders when the Chat column does, which is cheap here, and every frame of a morph
//! (`request_animation_frame`, only while one runs). Spinners in the pills and panels are `ui::Spinner`: each turns in
//! a small view of its own, so a frame notifies that view, never this row or the Chat column (CONVENTIONS "Adding a
//! view that does not repaint its siblings", rule 4).
//!
//! | File | What |
//! | --- | --- |
//! | `morph.rs` | timing and geometry of the morph, as plain functions |
//! | `data.rs` | the fixture the row shows (`PillsData`) |
//! | `tasks.rs`, `phase.rs` | the Tasks panel and the phase graph, drawn with paths |
//! | `subagents.rs` | the Subagents panel and a subagent's detail |
//! | `bookmark.rs` | the Chat identity, the Subchat bookmark and the family menu (C-06) |

pub mod bookmark;
pub mod data;
pub mod morph;
mod phase;
mod subagents;
mod tasks;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::time::Instant;

use gpui::{
    AnyElement, App, ClickEvent, Context, ElementId, EventEmitter, FocusHandle, Focusable, Hsla, IntoElement, KeyDownEvent, MouseDownEvent,
    ParentElement, Render, ScrollHandle, SharedString, Styled, Window, div, prelude::*, px,
};

use self::data::PillsData;
use self::morph::{Frame, PILL_HEIGHT};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt, Theme};
use crate::ui::glass::{GLASS_BLUR, GLASS_PILL_FILL};
use crate::ui::{Glass, Icon, IconButton, IconButtonSize, IconName, IconSize, ScrollArea, SectionLabel, StatusPill};

/// Room under the panel's pill that the transcript's box keeps for the header and the composer, when sizing a panel.
const COMPOSER_ALLOWANCE: f32 = 44.0 + 120.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Tasks,
    Subagents,
}

impl Kind {
    fn id(self) -> &'static str {
        match self {
            Kind::Tasks => "pill-tasks",
            Kind::Subagents => "pill-subagents",
        }
    }

    fn panel_id(self) -> &'static str {
        match self {
            Kind::Tasks => "panel-tasks",
            Kind::Subagents => "panel-subagents",
        }
    }

    /// The panel's preferred width and tallest height (`width`, `height` props).
    pub fn preferred(self, detail: bool) -> (f32, f32) {
        match self {
            Kind::Tasks => (380.0, 520.0),
            Kind::Subagents if detail => (440.0, 600.0),
            Kind::Subagents => (420.0, 460.0),
        }
    }
}

/// What the row tells the Chat column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PillEvent {
    /// The PR pill: run the blocker's fix, or open the PR panel to merge.
    PullRequestAction,
    /// The review comments pill: open the PR panel.
    OpenReview,
    /// "Go to bottom".
    JumpToBottom,
    /// A panel closed from the keyboard or a press outside: the composer takes the focus back.
    Closed,
}

impl EventEmitter<PillEvent> for PillRow {}

pub struct PillRow {
    pub(super) data: PillsData,
    key: SharedString,
    open: Option<Kind>,
    /// The morph in progress: which pill, opening or closing, since when.
    morph: Option<(Kind, bool, Instant)>,
    /// Task ids folded shut in the Tasks panel.
    folded: HashSet<String>,
    selected_agent: Option<String>,
    show_archived: bool,
    log_open: bool,
    /// Detail sections shown whole ("Show all"), by name.
    clamped: HashSet<&'static str>,
    jump: bool,
    focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    scroll: ScrollHandle,
    /// Snapshot seed (`MILAGRE_GPUI_PILLS_OPEN`): a panel is open from the first frame.
    window: (f32, f32),
}

impl PillRow {
    pub fn new(key: &str, title: &str, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            data: data::pills_for(key, title),
            key: key.to_string().into(),
            open: None,
            morph: None,
            folded: HashSet::new(),
            selected_agent: None,
            show_archived: false,
            log_open: false,
            clamped: HashSet::new(),
            jump: false,
            focus: cx.focus_handle(),
            return_focus: None,
            scroll: ScrollHandle::new(),
            window: (1440.0, 900.0),
        };
        if let Some(kind) = std::env::var("MILAGRE_GPUI_PILLS_OPEN").ok().and_then(|name| match name.as_str() {
            "tasks" => Some(Kind::Tasks),
            "subagents" => Some(Kind::Subagents),
            _ => None,
        }) {
            this.open = Some(kind);
            this.selected_agent = std::env::var("MILAGRE_GPUI_PILLS_AGENT").ok();
        }
        this
    }

    /// A different Chat: its pills, closed.
    pub fn set_chat(&mut self, key: &str, title: &str, cx: &mut Context<Self>) {
        // The first Chat named keeps a snapshot seed's open panel.
        let first = self.key.is_empty();
        self.key = key.to_string().into();
        self.data = data::pills_for(key, title);
        if !first {
            self.open = None;
            self.selected_agent = None;
        }
        self.morph = None;
        self.folded.clear();
        cx.notify();
    }

    pub fn open_kind(&self) -> Option<Kind> {
        self.open.filter(|_| !self.closing())
    }

    fn closing(&self) -> bool {
        matches!(self.morph, Some((_, false, _)))
    }

    pub fn data(&self) -> &PillsData {
        &self.data
    }

    /// Whether "Go to bottom" shows (the transcript is scrolled away from its end).
    pub fn set_jump(&mut self, jump: bool, cx: &mut Context<Self>) {
        if self.jump != jump {
            self.jump = jump;
            cx.notify();
        }
    }

    pub fn jump_shown(&self) -> bool {
        self.jump
    }

    /// Where the focus goes when a panel closes from the keyboard.
    pub fn set_return_focus(&mut self, handle: FocusHandle) {
        self.return_focus.get_or_insert(handle);
    }

    pub fn is_shown(&self, kind: Kind) -> bool {
        match kind {
            Kind::Tasks => self.data.plan.as_ref().is_some_and(|plan| !plan.is_empty()),
            Kind::Subagents => self.data.subagents.iter().any(|agent| !agent.archived) || self.open == Some(Kind::Subagents),
        }
    }

    /// Opens `kind`'s panel (closing any other), or closes the open one with `None`.
    pub fn set_open(&mut self, kind: Option<Kind>, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        let motion = crate::ui::motion();
        match kind {
            Some(kind) => {
                self.open = Some(kind);
                self.morph = motion.then(|| (kind, true, Instant::now()));
                self.selected_agent = None;
                self.show_archived = false;
                self.log_open = false;
                window.focus(&self.focus, cx);
            }
            None => {
                let Some(open) = self.open else { return };
                if motion {
                    self.morph = Some((open, false, Instant::now()));
                } else {
                    self.open = None;
                    self.morph = None;
                }
                if refocus && let Some(handle) = &self.return_focus {
                    window.focus(handle, cx);
                }
                cx.emit(PillEvent::Closed);
            }
        }
        cx.notify();
    }

    /// The frame of `kind`'s surface now; ends the morph (and a closing panel's mount) when it is over.
    fn frame_of(&mut self, kind: Kind, window: &mut Window) -> Frame {
        match self.morph {
            Some((morphing, opening, since)) if morphing == kind => {
                let frame = morph::frame(opening, since.elapsed());
                if frame.done {
                    self.morph = None;
                    if !opening {
                        self.open = None;
                    }
                    morph::at_rest(opening)
                } else {
                    window.request_animation_frame();
                    frame
                }
            }
            _ => morph::at_rest(self.open == Some(kind)),
        }
    }

    fn detail(&self) -> bool {
        self.open == Some(Kind::Subagents) && self.selected_agent.is_some()
    }

    /// The panel's size for `kind`: what its content needs, no more than the room it has.
    pub(super) fn panel_size(&self, kind: Kind) -> (f32, f32) {
        let preferred = kind.preferred(self.detail());
        let above = self.window.1 - COMPOSER_ALLOWANCE;
        let (width, room_height) = morph::room(preferred, self.window, above);
        let wanted = match kind {
            Kind::Tasks => self.tasks_height(),
            Kind::Subagents => self.subagents_height(),
        };
        (width, wanted.min(room_height))
    }

    /// The pill's face: the `StatusPill` the slot measures and draws.
    fn pill_face(&self, kind: Kind, cx: &mut Context<Self>) -> StatusPill {
        match kind {
            Kind::Tasks => self.tasks_pill(cx),
            Kind::Subagents => self.subagents_pill(cx),
        }
    }

    fn panel_face(&mut self, kind: Kind, size: (f32, f32), window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        match kind {
            Kind::Tasks => self.tasks_panel(size, cx),
            Kind::Subagents => self.subagents_panel(size, window, cx),
        }
    }

    /// One slot in the row: it holds the pill's place, and the morphing surface hangs from its bottom corner.
    fn slot(&mut self, kind: Kind, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let frame = self.frame_of(kind, window);
        let face = self.pill_face(kind, cx);
        let pill = morph::pill_size(face.width(window));
        let panel = self.panel_size(kind);
        let (width, height, radius) = morph::surface(pill, panel, frame.grown);
        let mounted = self.open == Some(kind);
        // Frosted glass while it is a pill or growing; open, the panel is opaque and needs no blur behind it.
        let fill = lerp_f(GLASS_PILL_FILL, 1.0, frame.grown);
        let blur = if fill < 1.0 { GLASS_BLUR } else { px(0.0) };
        let glass = Glass::new(blur, Hsla::from(theme.surface).opacity(fill)).radius(px(radius));
        let ring: Hsla = Hsla::from(theme.line);
        let surface = div()
            .id(ElementId::from(kind.panel_id()))
            .debug_selector(move || format!("{}-surface", kind.panel_id()))
            .absolute()
            .bottom_0()
            .right_0()
            .w(px(width))
            .h(px(height))
            .rounded(px(radius))
            .overflow_hidden()
            .child(glass)
            // The pill's ring is a border (a shadow would show through the translucent glass); open, the raised
            // shadow draws its own.
            .border_1()
            .border_color(ring.opacity((1.0 - frame.grown * 2.0).max(0.0)))
            .when(frame.grown > 0.5, |el| el.shadow(theme.shadow_raised()))
            .when(mounted && self.closing_or_open(kind), |el| {
                el.on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    if this.open_kind().is_some() {
                        this.set_open(None, false, window, cx);
                    }
                }))
            })
            .when(mounted, |el| {
                let body = self.panel_face(kind, panel, window, cx);
                el.child(div().absolute().bottom_0().right_0().w(px(panel.0)).h(px(panel.1)).opacity(frame.panel_opacity).child(body))
            });
        let pill_face = div()
            .absolute()
            .bottom_0()
            .right_0()
            .w(px(pill.0))
            .h(px(PILL_HEIGHT))
            .flex()
            .items_center()
            .justify_center()
            .opacity(frame.pill_opacity)
            .child(face);
        div()
            .id(ElementId::from(SharedString::from(format!("slot-{}", kind.id()))))
            .debug_selector(move || format!("slot-{}", kind.id()))
            .relative()
            .flex_none()
            .w(px(pill.0))
            .h(px(PILL_HEIGHT))
            .child(surface)
            .child(pill_face)
            .into_any_element()
    }

    fn closing_or_open(&self, kind: Kind) -> bool {
        self.open == Some(kind) && !self.closing()
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && self.open_kind().is_some() {
            cx.stop_propagation();
            self.set_open(None, true, window, cx);
        }
    }

    fn jump_pill(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let glass =
            Glass::new(GLASS_BLUR, Hsla::from(theme.surface).opacity(GLASS_PILL_FILL)).edge(theme.line).outset().radius(px(f32::MAX));
        div()
            .id("pill-jump")
            .debug_selector(|| "pill-jump".into())
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .size(crate::theme::CONTROL_SM)
            .relative()
            .rounded_full()
            .child(glass)
            .text_color(theme.ink2)
            .cursor_pointer()
            .hover(move |style| style.text_color(theme.ink))
            .tooltip(crate::ui::Tooltip::text("Go to bottom"))
            .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(PillEvent::JumpToBottom)))
            .child(Icon::new(IconName::ArrowDown01).size(IconSize::S14).color(theme.ink2))
            .into_any_element()
    }

    /// The PR action pill (`pr-action`): the blocker's fix in red or orange, or Merge in green; not a morph.
    fn pr_action_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let action = self.data.pr_action.as_ref()?;
        Some(
            StatusPill::new("pill-pr-action")
                .icon(if action.merge { IconName::GitMerge } else { IconName::GitPullRequest })
                .label(action.label.clone())
                .tone(action.tone)
                .medium()
                .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(PillEvent::PullRequestAction)))
                .into_any_element(),
        )
    }

    /// The review comments pill (`pr-review`): neutral, a bubble and the bold count, then what it counts.
    fn review_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let count = self.data.review_comments;
        if count == 0 {
            return None;
        }
        let theme = *cx.theme();
        let leading = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(Icon::new(IconName::BubbleChat).size(IconSize::S12).color(theme.ink2))
            .child(div().font_weight(gpui::FontWeight::MEDIUM).text_color(theme.ink).child(count.to_string()));
        Some(
            StatusPill::new("pill-review")
                .leading(leading, 18.0 + 7.0 * count.to_string().len() as f32)
                .label(if count == 1 { "review comment" } else { "review comments" })
                .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(PillEvent::OpenReview)))
                .into_any_element(),
        )
    }
}

fn lerp_f(a: f32, b: f32, t: f32) -> f32 {
    morph::lerp(a, b, t)
}

impl Focusable for PillRow {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for PillRow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let size = window.viewport_size();
        self.window = (f32::from(size.width), f32::from(size.height));
        let right_kinds: Vec<Kind> = [Kind::Tasks, Kind::Subagents].into_iter().filter(|kind| self.is_shown(*kind)).collect();
        // The PR pills lead the row; the rest sit at its right (`justify-end`, the last left pill takes `mr-auto`).
        let mut left = div().flex().items_end().gap_2();
        left = left.children(self.pr_action_pill(cx)).children(self.review_pill(cx));
        let mut right = div().flex().items_end().justify_end().gap_2();
        for kind in right_kinds {
            right = right.child(self.slot(kind, window, cx));
        }
        if self.jump {
            right = right.child(self.jump_pill(cx));
        }
        div()
            .id("pill-row")
            .debug_selector(|| "pill-row".into())
            .key_context("PillRow")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.on_key_down(event, window, cx)))
            .absolute()
            .left_0()
            .right_0()
            .bottom(px(8.0))
            .flex()
            .justify_center()
            .px_4()
            .child(div().w_full().max_w(px(crate::theme::column_width())).flex().justify_between().items_end().child(left).child(right))
    }
}

/// A panel's header row: a section label with a trailing count, and the collapse button.
fn panel_header(label: &'static str, trailing: String, collapse: AnyElement, theme: &Theme) -> AnyElement {
    div()
        .flex_none()
        .flex()
        .items_center()
        .gap_2()
        .px_2()
        .pt_1()
        .child(
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_between()
                .child(SectionLabel::new(label))
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(trailing)),
        )
        .child(collapse)
        .into_any_element()
}

/// The collapse button (`ArrowShrink02`, 24px).
fn collapse_button(id: &'static str, cx: &mut Context<PillRow>) -> AnyElement {
    IconButton::new(id, IconName::ArrowShrink02)
        .size(IconButtonSize::S24)
        .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.set_open(None, true, window, cx)))
        .into_any_element()
}

/// A panel's body: its rows in a scroll area under the fixed header.
fn scroll_body(id: &'static str, handle: &ScrollHandle, children: Vec<AnyElement>) -> AnyElement {
    div().flex_1().min_h_0().child(ScrollArea::new(id, handle).children(children)).into_any_element()
}

/// The 8px a panel holds around its content (`p-1`).
const PANEL_PAD: f32 = 4.0;
/// The header row's height with its padding.
const HEADER: f32 = 36.0;
