//! Drag and drop in the sidebar (S-14, WP-49): the one-list sidebar's drags in `SidebarNav.tsx` (`dragRowToGrid`,
//! `ChatList`'s pointer and keyboard drags) and `dropIntent` from `lib/chat-list.ts`.
//!
//! What a drag does, as the desktop's one list does it:
//!
//! - A pinned row dragged within the Pinned rows reorders them (a line above or below the row under the pointer),
//!   or, on the middle third of a row whose Chat can be linked, offers a Link between the two Chats' Worktrees: the
//!   row is outlined and the drop opens the Create Link popover. A pinned row of another Project takes only the
//!   Link. "Same worktree" and "Already linked" outline the row in red and say why.
//! - The keyboard: Space on a selected pinned row picks it up, Up and Down move it through the places it can land,
//!   Space drops it, Escape cancels. Each step is announced (`announcement`), as the desktop's live region does.
//!
//! The one-list layout has no Project headers, so there is no Project reorder; unpinned rows pin through the menu.
//! React's drags start past 4px; GPUI's own threshold (2px) starts these.

use gpui::{AnyElement, App, Bounds, Context, KeyDownEvent, Pixels, Point, Render, Window, anchored, deferred, div, prelude::*, px};

use super::links::{LinkEnd, LinkProblem, link_between};
use super::{ROW_INSET, Sidebar};
use crate::logic::lists::chats::pin_order_at;
use crate::theme::{ActiveTheme, HEADER_HEIGHT, RADIUS_CHIP, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_11, TextStepExt};
use crate::ui::{Icon, IconName, IconSize};

/// The Pinned rows' top padding (`pt(4)` in `mod.rs`).
const PINNED_PAD: f32 = 4.0;

/// Where a dragged Chat lands on a row (`DropZone`): on the line above or below it, or on the row itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropZone {
    Before,
    After,
    On,
}

/// What dropping does (`DropIntent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropIntent {
    Reorder,
    Pin,
    Unpin,
    Link,
    None,
    Invalid(LinkProblem),
}

/// One side of a drop as `dropIntent` reads it: pinned, and its Worktree when that is comparable.
#[derive(Clone, Copy, Debug)]
pub struct DropEnd<'a> {
    pub pinned: bool,
    pub worktree: Option<&'a LinkEnd>,
}

/// `dropIntent`: what dropping `source` at `zone` of `target` does. `None` for the target is the empty Pinned area;
/// `linked`: a Link already joins the two Chats' Worktrees.
pub fn drop_intent(source: DropEnd, target: Option<DropEnd>, zone: DropZone, linked: bool) -> DropIntent {
    let Some(target) = target else { return if source.pinned { DropIntent::None } else { DropIntent::Pin } };
    if zone == DropZone::On {
        if source.worktree.is_some() && source.worktree == target.worktree {
            return DropIntent::Invalid(LinkProblem::SameWorktree);
        }
        return if linked { DropIntent::Invalid(LinkProblem::Linked) } else { DropIntent::Link };
    }
    match (target.pinned, source.pinned) {
        (true, true) => DropIntent::Reorder,
        (true, false) => DropIntent::Pin,
        (false, true) => DropIntent::Unpin,
        (false, false) => DropIntent::None,
    }
}

/// The zone at `fraction` (0 top, 1 bottom) of a row: thirds when the row can be linked, halves otherwise.
pub fn zone_at(fraction: f32, linkable: bool) -> DropZone {
    if linkable {
        if fraction < 1.0 / 3.0 {
            DropZone::Before
        } else if fraction > 2.0 / 3.0 {
            DropZone::After
        } else {
            DropZone::On
        }
    } else if fraction < 0.5 {
        DropZone::Before
    } else {
        DropZone::After
    }
}

/// The value a row's drag carries: its Chat's key and whether it is pinned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatDrag {
    pub key: String,
    pub pinned: bool,
}

/// What follows the pointer: nothing, as the desktop's row drag shows no ghost (the row dims where it is).
pub struct DragGhost;

impl Render for DragGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(1.0))
    }
}

/// Where a drag would land in the sidebar: a pinned row and the zone; `other_scope` is another Project's row, where
/// a drop can only link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DropTarget {
    pub key: String,
    pub zone: DropZone,
    pub other_scope: bool,
}

/// A drag in progress.
#[derive(Clone, Debug)]
pub(super) struct DragState {
    pub key: String,
    pub target: Option<DropTarget>,
    pub keyboard: bool,
}

impl Sidebar {
    /// The Chat being dragged, if any.
    pub fn dragging(&self) -> Option<&str> {
        self.drag.as_ref().map(|drag| drag.key.as_str())
    }

    pub fn drop_target(&self) -> Option<&DropTarget> {
        self.drag.as_ref().and_then(|drag| drag.target.as_ref())
    }

    /// A pointer drag is going on (the keyboard's handles its own keys).
    pub fn pointer_dragging(&self) -> bool {
        self.drag.as_ref().is_some_and(|drag| !drag.keyboard)
    }

    /// The live announcement of the keyboard drag.
    pub fn drag_announcement(&self) -> &str {
        &self.announcement
    }

    /// What the drop would do now.
    pub fn drop_intent_now(&self) -> DropIntent {
        self.drag.as_ref().map_or(DropIntent::None, |drag| self.intent_of(drag))
    }

    fn row_ix(&self, key: &str) -> Option<usize> {
        self.rows.iter().position(|row| row.key.as_ref() == key)
    }

    fn is_pinned_row(&self, key: &str) -> bool {
        self.row_ix(key).is_some_and(|ix| ix < self.pinned)
    }

    /// Where row `ix` was last painted, in the window. A pinned row not painted yet (a snapshot's first frame) is
    /// where the layout puts it: under the header.
    fn row_bounds(&self, ix: usize, cx: &App) -> Option<Bounds<Pixels>> {
        let painted = self.row_views.get(&ix).map(|(view, _)| view.read(cx).bounds()).filter(|bounds| bounds.size.height > px(0.0));
        painted.or_else(|| {
            (ix < self.pinned && !self.collapsed).then(|| {
                let top = HEADER_HEIGHT + px(PINNED_PAD + ix as f32 * f32::from(ROW_TWO_LINE));
                Bounds::new(gpui::point(px(ROW_INSET), top), gpui::size(px(super::SIDEBAR_WIDTH - 2.0 * ROW_INSET), ROW_TWO_LINE))
            })
        })
    }

    /// Snapshot seeds (`MILAGRE_GPUI_SIDEBAR_DEMO`): a drag or a Link popover as a picture needs it.
    pub(super) fn apply_drag_demo(&mut self, demo: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.pinned < 2 {
            return;
        }
        let (first, second) = (self.rows[0].key.to_string(), self.rows[1].key.to_string());
        let target = |zone| DropTarget { key: second.clone(), zone, other_scope: false };
        match demo {
            "drag-reorder" | "drag-link" | "drag-invalid" => {
                if demo == "drag-invalid" {
                    let (Some(a), Some(b)) = (self.link_end(&first), self.link_end(&second)) else { return };
                    self.links.push(super::links::CanvasLink { id: "link-demo".into(), a, b });
                    self.relabel_links();
                }
                self.begin_drag(&first, false, cx);
                self.over(Some(target(if demo == "drag-reorder" { DropZone::After } else { DropZone::On })), cx);
            }
            "drag-keyboard" => {
                self.selected = Some(0);
                self.begin_drag(&first, true, cx);
                self.over(Some(target(DropZone::After)), cx);
            }
            "link-ask" => self.ask_link(&first, &second, HEADER_HEIGHT + px(PINNED_PAD), window, cx),
            "link-pick" => self.pick_link(&first, super::link_popover::PickerMode::Link, HEADER_HEIGHT + px(PINNED_PAD), window, cx),
            _ => {}
        }
    }

    fn begin_drag(&mut self, key: &str, keyboard: bool, cx: &mut Context<Self>) {
        self.close_card();
        self.menu = None;
        self.drag = Some(DragState { key: key.to_string(), target: None, keyboard });
        self.announcement = if keyboard {
            let label = self.row_title(key).unwrap_or_default();
            format!("Picked up {label}. Arrow keys move it, Space drops it, Escape cancels.")
        } else {
            String::new()
        };
        self.mark_dragging(Some(key), cx);
        cx.notify();
    }

    fn mark_dragging(&mut self, key: Option<&str>, cx: &mut Context<Self>) {
        for (ix, (view, _)) in &self.row_views {
            let dragging = key.is_some_and(|key| self.rows.get(*ix).is_some_and(|row| row.key.as_ref() == key));
            view.update(cx, |view, cx| view.set_dragging(dragging, cx));
        }
    }

    /// The pointer moved during a drag of `drag` (the window's hook calls this): the sidebar's target under `at`.
    /// Returns whether the sidebar took the pointer, so the Chat view does not.
    pub fn drag_over(&mut self, drag: &ChatDrag, at: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        if self.drag.as_ref().is_none_or(|state| state.key != drag.key) {
            self.begin_drag(&drag.key, false, cx);
        }
        let target = self.hit(drag, at, cx);
        let took = target.is_some();
        self.over(target, cx);
        took
    }

    fn over(&mut self, target: Option<DropTarget>, cx: &mut Context<Self>) {
        let Some(drag) = &mut self.drag else { return };
        if drag.target == target {
            return;
        }
        drag.target = target;
        if drag.keyboard {
            let drag = drag.clone();
            self.announcement = if drag.target.is_some() { self.describe(&drag) } else { String::new() };
        }
        cx.notify();
    }

    /// The pinned row (or another Project's pinned row) under `at`. Between two rows of the Pinned area it keeps the
    /// last target; elsewhere it is none.
    fn hit(&self, drag: &ChatDrag, at: Point<Pixels>, cx: &App) -> Option<DropTarget> {
        if !drag.pinned || self.collapsed {
            return None;
        }
        let source_ix = self.row_ix(&drag.key)?;
        let source_scope = self.meta[source_ix].scope;
        let painted: Vec<(usize, Bounds<Pixels>)> = (0..self.pinned).filter_map(|ix| Some((ix, self.row_bounds(ix, cx)?))).collect();
        let area = painted.iter().map(|(_, b)| *b).reduce(|a, b| a.union(&b))?;
        let Some((ix, bounds)) = painted.iter().find(|(_, bounds)| bounds.contains(&at)).copied() else {
            return area.contains(&at).then(|| self.drop_target().cloned()).flatten();
        };
        let key = self.rows[ix].key.to_string();
        let scope = self.meta[ix].scope;
        if scope == source_scope {
            let fraction = f32::from(at.y - bounds.origin.y) / f32::from(bounds.size.height);
            return Some(DropTarget { key, zone: zone_at(fraction, self.scope_linkable(scope)), other_scope: false });
        }
        // Another Project's row: anywhere on it links, since the drop can't move the Chat there.
        (self.scope_linkable(source_scope) && self.scope_linkable(scope)).then_some(DropTarget {
            key,
            zone: DropZone::On,
            other_scope: true,
        })
    }

    fn drop_end(&self, key: &str) -> DropEnd<'_> {
        DropEnd { pinned: self.is_pinned_row(key), worktree: None }
    }

    /// `intentOf`.
    fn intent_of(&self, drag: &DragState) -> DropIntent {
        let Some(target) = &drag.target else { return DropIntent::None };
        if target.key == drag.key {
            return DropIntent::None;
        }
        let (source_end, target_end) = (self.link_end(&drag.key), self.link_end(&target.key));
        if target.zone == DropZone::On && (source_end.is_none() || target_end.is_none()) {
            return DropIntent::None;
        }
        let linked = match (&source_end, &target_end) {
            (Some(a), Some(b)) => link_between(&self.links, a, b).is_some(),
            _ => false,
        };
        let source = DropEnd { worktree: source_end.as_ref(), ..self.drop_end(&drag.key) };
        // Two Projects' Worktrees are never the same one, whatever their paths say.
        let onto = DropEnd { worktree: if target.other_scope { None } else { target_end.as_ref() }, ..self.drop_end(&target.key) };
        drop_intent(source, Some(onto), target.zone, linked)
    }

    /// `pinSlot`: the pin orders of the dragged Chat's Project other than its own, and its index among them.
    fn pin_slot(&self, drag: &DragState) -> (Vec<f64>, usize) {
        let Some(source_ix) = self.row_ix(&drag.key) else { return (Vec::new(), 0) };
        let (scope, _) = (self.meta[source_ix].scope, ());
        let others: Vec<usize> = (0..self.pinned).filter(|ix| *ix != source_ix && self.meta[*ix].scope == scope).collect();
        let orders = others
            .iter()
            .map(|ix| super::pins::pin_of(&self.data, &self.list_filters.pins, scope, self.meta[*ix].id).unwrap_or(0.0))
            .collect();
        let index = match &drag.target {
            Some(target) => {
                let at = others.iter().position(|ix| self.rows[*ix].key.as_ref() == target.key).unwrap_or(0);
                at + usize::from(target.zone == DropZone::After)
            }
            None => 0,
        };
        (orders, index)
    }

    /// `describe`: what the keyboard drag announces for the current target.
    fn describe(&self, drag: &DragState) -> String {
        match self.intent_of(drag) {
            DropIntent::Invalid(problem) => problem.drop_hint().to_string(),
            DropIntent::Link => {
                let label = drag.target.as_ref().and_then(|target| self.row_title(&target.key)).unwrap_or_default();
                format!("On {label}: create Link")
            }
            DropIntent::Pin | DropIntent::Reorder => {
                let (orders, index) = self.pin_slot(drag);
                format!("Pinned, position {} of {}", index + 1, orders.len() + 1)
            }
            DropIntent::Unpin => "Chats: unpin".into(),
            DropIntent::None => "No change".into(),
        }
    }

    fn finish_drag(&mut self, cx: &mut Context<Self>) -> Option<DragState> {
        let drag = self.drag.take()?;
        self.mark_dragging(None, cx);
        cx.notify();
        Some(drag)
    }

    /// Calls the drag off (Escape, a cancelled press): nothing changes.
    pub fn cancel_drag(&mut self, cx: &mut Context<Self>) {
        if let Some(drag) = self.finish_drag(cx)
            && drag.keyboard
        {
            self.announcement = "Cancelled".into();
        }
    }

    /// The drag ends here: a drop in the sidebar pins, reorders or opens the Create Link popover; anywhere else
    /// nothing changes.
    pub fn end_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.finish_drag(cx) else { return };
        let intent = self.intent_of(&drag);
        if drag.keyboard {
            self.announcement = match intent {
                DropIntent::Invalid(problem) => problem.drop_hint().to_string(),
                DropIntent::None => "Dropped, nothing changed".into(),
                DropIntent::Link => String::new(),
                _ => format!("Dropped. {}", self.describe(&drag)),
            };
        }
        match intent {
            DropIntent::Pin | DropIntent::Reorder => {
                let (orders, index) = self.pin_slot(&drag);
                self.pin_at(&drag.key, Some(pin_order_at(&orders, index)), cx);
            }
            DropIntent::Unpin => self.pin_at(&drag.key, None, cx),
            DropIntent::Link => {
                if let Some(target) = &drag.target {
                    let top = self.row_top(&target.key, cx);
                    self.ask_link(&drag.key, &target.key, top, window, cx);
                }
            }
            DropIntent::None | DropIntent::Invalid(_) => {}
        }
        if drag.keyboard {
            window.focus(&self.focus, cx);
            if let Some(ix) = self.row_ix(&drag.key) {
                self.select(ix, cx);
            }
        }
    }

    /// A drop's pin: this device's order for the Chat, recorded when it pins or unpins.
    fn pin_at(&mut self, key: &str, order: Option<f64>, cx: &mut Context<Self>) {
        let Some((scope, id)) = self.locate(key) else { return };
        let before = super::pins::pin_of(&self.data, &self.list_filters.pins, scope, id);
        self.set_pin_order(key, order);
        self.book.pin(key, before, order);
        self.after_book(cx);
    }

    /// `slots`: every place the keyboard can move the Chat to, top to bottom: before each other pinned row of its
    /// Project (and on it, when it can be linked), then after the last.
    fn slots(&self, key: &str) -> Vec<DropTarget> {
        let Some(source_ix) = self.row_ix(key) else { return Vec::new() };
        let scope = self.meta[source_ix].scope;
        let linkable = self.scope_linkable(scope);
        let pins: Vec<String> = (0..self.pinned)
            .filter(|ix| *ix != source_ix && self.meta[*ix].scope == scope)
            .map(|ix| self.rows[ix].key.to_string())
            .collect();
        let mut out = Vec::new();
        for pin in &pins {
            out.push(DropTarget { key: pin.clone(), zone: DropZone::Before, other_scope: false });
            if linkable {
                out.push(DropTarget { key: pin.clone(), zone: DropZone::On, other_scope: false });
            }
        }
        if let Some(last) = pins.last() {
            out.push(DropTarget { key: last.clone(), zone: DropZone::After, other_scope: false });
        }
        out
    }

    /// The keyboard drag's keys, before the list's own: Space picks a selected pinned row up and drops it, Up and
    /// Down move it, Escape cancels, Tab ends it. Returns whether the key was the drag's.
    pub(super) fn drag_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let key = event.keystroke.key.as_str();
        let Some(drag) = self.drag.clone() else {
            if key != "space" || self.collapsed {
                return false;
            }
            let Some(row) = self.selected.filter(|ix| *ix < self.pinned).and_then(|ix| self.rows.get(ix)) else { return false };
            let row = row.key.to_string();
            self.begin_drag(&row, true, cx);
            return true;
        };
        if !drag.keyboard {
            return false;
        }
        match key {
            "down" | "up" => {
                let all = self.slots(&drag.key);
                if all.is_empty() {
                    return true;
                }
                let step: isize = if key == "down" { 1 } else { -1 };
                let next = match all.iter().position(|slot| Some(slot) == drag.target.as_ref()) {
                    None if step > 0 => 0,
                    None => all.len() - 1,
                    Some(at) => at.saturating_add_signed(step).min(all.len() - 1),
                };
                self.over(Some(all[next].clone()), cx);
            }
            "space" => {
                self.end_drag(window, cx);
            }
            "escape" => self.cancel_drag(cx),
            "tab" => {
                self.finish_drag(cx);
                return false;
            }
            _ => return false,
        }
        true
    }

    /// The drop's mark: a line above or below the target row, or the row outlined for a Link (red with the reason
    /// when it can't be linked). Drawn over the window, at the row's painted place.
    pub(super) fn drop_indicator(&self, cx: &App) -> Option<AnyElement> {
        let drag = self.drag.as_ref()?;
        let target = drag.target.as_ref()?;
        let intent = self.intent_of(drag);
        if intent == DropIntent::None {
            return None;
        }
        let bounds = self.row_bounds(self.row_ix(&target.key)?, cx)?;
        let theme = *cx.theme();
        let element = if target.zone == DropZone::On {
            let invalid = match intent {
                DropIntent::Invalid(problem) => Some(problem.drop_hint()),
                _ => None,
            };
            let (fill, ring) = if invalid.is_some() { (theme.red_tint, theme.red) } else { (theme.accent_tint, theme.accent) };
            div()
                .debug_selector(|| "drop-target".into())
                .relative()
                .flex()
                .items_center()
                .justify_end()
                .w(bounds.size.width)
                .h(bounds.size.height)
                .pr(px(8.0))
                .rounded(RADIUS_CONTROL)
                .border_2()
                .border_color(ring)
                .bg(fill)
                .opacity(0.9)
                .map(|el| match invalid {
                    Some(hint) => el.child(
                        div()
                            .debug_selector(|| "drop-hint".into())
                            .absolute()
                            .left_0()
                            .top(bounds.size.height + px(4.0))
                            .px(px(8.0))
                            .py(px(4.0))
                            .rounded(RADIUS_CHIP)
                            .bg(theme.surface)
                            .shadow(theme.shadow_raised())
                            .text_step(TEXT_11)
                            .text_color(theme.red_ink)
                            .whitespace_nowrap()
                            .child(hint),
                    ),
                    None => el.child(Icon::new(IconName::Link04).size(IconSize::S14).color(theme.accent_ink)),
                })
                .into_any_element()
        } else {
            let y = if target.zone == DropZone::Before { bounds.origin.y } else { bounds.bottom() };
            let line = div()
                .debug_selector(|| "drop-line".into())
                .w(bounds.size.width - px(2.0 * (12.0 - ROW_INSET)))
                .h(px(2.0))
                .rounded_full()
                .bg(theme.accent)
                .into_any_element();
            return Some(
                deferred(anchored().position(gpui::point(bounds.origin.x + px(12.0 - ROW_INSET), y - px(1.0))).child(line))
                    .with_priority(1)
                    .into_any_element(),
            );
        };
        Some(deferred(anchored().position(bounds.origin).child(element)).with_priority(1).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(pinned: bool, worktree: Option<&LinkEnd>) -> DropEnd<'_> {
        DropEnd { pinned, worktree }
    }

    /// `dropIntent`'s vectors (`lib/chat-list.test.ts`).
    #[test]
    fn drop_intent_matches_the_desktop() {
        let (wa, wb, wc) = (LinkEnd::worktree("p", "/a"), LinkEnd::worktree("p", "/b"), LinkEnd::worktree("p", "/c"));
        let pinned = end(true, Some(&wa));
        let recent = end(false, Some(&wb));
        assert_eq!(drop_intent(recent, None, DropZone::Before, false), DropIntent::Pin);
        assert_eq!(drop_intent(pinned, None, DropZone::Before, false), DropIntent::None);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::After, false), DropIntent::Pin);
        assert_eq!(drop_intent(pinned, Some(end(true, Some(&wc))), DropZone::Before, false), DropIntent::Reorder);
        assert_eq!(drop_intent(pinned, Some(recent), DropZone::Before, false), DropIntent::Unpin);
        assert_eq!(drop_intent(recent, Some(end(false, Some(&wc))), DropZone::After, false), DropIntent::None);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::On, false), DropIntent::Link);
        assert_eq!(drop_intent(recent, Some(pinned), DropZone::On, true), DropIntent::Invalid(LinkProblem::Linked));
        assert_eq!(drop_intent(recent, Some(end(false, Some(&wb))), DropZone::On, false), DropIntent::Invalid(LinkProblem::SameWorktree));
    }

    #[test]
    fn zones_are_thirds_when_the_row_links_and_halves_otherwise() {
        assert_eq!(zone_at(0.2, true), DropZone::Before);
        assert_eq!(zone_at(0.5, true), DropZone::On);
        assert_eq!(zone_at(0.8, true), DropZone::After);
        assert_eq!(zone_at(0.49, false), DropZone::Before);
        assert_eq!(zone_at(0.5, false), DropZone::After);
    }
}
