//! The transcript's half of text selection (WP-16): keeping a selection when the message it started in scrolls out
//! of the virtualized list, and copying what lies between its ends.
//!
//! gpui-base's window selection (`TextSelection`, drawn by `Root`'s selection layer) holds each end as a point in
//! one participant, a message's `TextView`. A participant that misses a frame because its element was dropped is
//! swept, and with an end gone the whole selection is cleared (`gap_selection_is_dropped_when_the_anchor_message_
//! unmounts` in `fitcheck::markdown`). A `gpui::list` drops every item outside the viewport. So:
//!
//! 1. [`SelectionTracker`] follows the drag at item level (which item holds the anchor, which the cursor), with the
//!    rule gpui-base uses to pick a participant for a point: the one under it, else the last one starting above it,
//!    else the first.
//! 2. [`Keeper`], an element painted after the list, draws each item holding an end that the list did not draw this
//!    frame, laid out at the list's width, just outside the list's bounds (above it for an item before the ones on
//!    screen, below it for one after) and clipped away. Its participant stays registered, so the selection stands,
//!    its highlight comes back with the item and its end keeps its offset (the item lays out at the same width).
//! 3. Copy is the transcript's (`Transcript::copy_selection`): the selected part of the two end items and the whole
//!    text of every selectable item between them, mounted or not, joined as gpui-base joins participants.
//!
//! Bounds: items between the ends that are off screen are not participants, so they paint no highlight until they
//! scroll back (they then get it from the band between the ends) and gpui-base's own copy would skip them, which is
//! why the transcript copies. A kept item paints after the list, so gpui-base numbers it last; that order only feeds
//! gpui-base's own copy, which the transcript replaces whenever the ends are in different items.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use gpui_base::TextViewState;

use gpui::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, DispatchPhase, Element, ElementId, Entity, EntityId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, Position, Style,
    WeakEntity, Window, point, px, relative, size,
};

/// Which items hold the ends of the selection, as the drag left them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SelectionTracker {
    pub anchor: Option<usize>,
    pub cursor: Option<usize>,
    pub dragging: bool,
    /// Where the pointer was last seen during the drag (the list may scroll under a still pointer).
    pub pointer: Option<Point<Pixels>>,
    /// Where the button went down, and whether the pointer has since moved away from there: a press is a drag
    /// (the transcript then draws its rows as cached views) only once it moves, so a click keeps its rows as built.
    pub origin: Option<Point<Pixels>>,
    pub moved: bool,
}

/// How far the pointer moves with the button held before a press counts as a drag.
const DRAG_SLOP: f32 = 3.0;

impl SelectionTracker {
    /// The items holding an end, first to last; `None` without a selection across items.
    pub fn span(&self) -> Option<(usize, usize)> {
        let (anchor, cursor) = (self.anchor?, self.cursor?);
        Some((anchor.min(cursor), anchor.max(cursor)))
    }

    /// A selection is being dragged (the button is held and the pointer has moved).
    pub fn is_dragging(&self) -> bool {
        self.dragging && self.moved
    }

    /// The items that must stay drawn: the ends.
    pub fn ends(&self) -> impl Iterator<Item = usize> + use<> {
        let (anchor, cursor) = (self.anchor, self.cursor);
        anchor.into_iter().chain(cursor.filter(|cursor| Some(*cursor) != anchor))
    }
}

/// What the list drew this frame: every item row, and the text of each selectable one, in window coordinates.
#[derive(Clone, Debug, Default)]
pub struct Painted {
    pub rows: BTreeMap<usize, Bounds<Pixels>>,
    pub texts: BTreeMap<usize, Bounds<Pixels>>,
    /// The list's own bounds.
    pub list: Option<Bounds<Pixels>>,
    /// The last frame's rows and texts, for rows a cached view replays this frame (its probes do not run again).
    prev_rows: BTreeMap<usize, Bounds<Pixels>>,
    prev_texts: BTreeMap<usize, Bounds<Pixels>>,
}

impl Painted {
    pub fn clear(&mut self) {
        self.rows.clear();
        self.texts.clear();
        self.prev_rows.clear();
        self.prev_texts.clear();
    }

    /// A new frame: what the last one drew becomes the previous frame's.
    pub fn begin_frame(&mut self) {
        self.prev_rows = std::mem::take(&mut self.rows);
        self.prev_texts = std::mem::take(&mut self.texts);
    }

    /// The selectable items whose text was drawn last frame.
    pub fn last_texts(&self) -> impl Iterator<Item = usize> + '_ {
        self.prev_texts.keys().copied()
    }

    /// Where row `ix` was drawn last frame.
    pub fn last_row(&self, ix: usize) -> Option<Bounds<Pixels>> {
        self.prev_rows.get(&ix).copied()
    }

    /// Row `ix` is drawn by a cached view this frame: it keeps last frame's bounds unless it renders again (its
    /// probes then overwrite them).
    pub fn carry(&mut self, ix: usize) {
        if let Some(row) = self.prev_rows.get(&ix) {
            self.rows.insert(ix, *row);
        }
        if let Some(text) = self.prev_texts.get(&ix) {
            self.texts.insert(ix, *text);
        }
    }

    /// The item gpui-base would put a selection end at for `position`: the selectable text under it (the smallest,
    /// as gpui-base picks by area), else the last one whose top is above it, else the first on screen.
    pub fn item_at(&self, position: Point<Pixels>) -> Option<usize> {
        let area = |b: &Bounds<Pixels>| f32::from(b.size.width) * f32::from(b.size.height);
        let hit = self
            .texts
            .iter()
            .filter(|(_, bounds)| bounds.contains(&position))
            .min_by(|a, b| area(a.1).total_cmp(&area(b.1)).then(a.0.cmp(b.0)));
        if let Some((ix, _)) = hit {
            return Some(*ix);
        }
        let above = self
            .texts
            .iter()
            .filter(|(_, bounds)| bounds.top() <= position.y)
            .max_by(|a, b| f32::from(a.1.top()).total_cmp(&f32::from(b.1.top())));
        above.or_else(|| self.texts.iter().min_by(|a, b| f32::from(a.1.top()).total_cmp(&f32::from(b.1.top())))).map(|(ix, _)| *ix)
    }
}

pub type SharedTracker = Rc<RefCell<SelectionTracker>>;
pub type SharedPainted = Rc<RefCell<Painted>>;
pub type SharedAll = Rc<RefCell<AllSelected>>;

/// ⌘A in the transcript: every selectable item is selected, mounted or not. Each text view drawn while it holds
/// shows it through its own select-all; the first press anywhere ends it, before gpui-base handles that press.
#[derive(Default)]
pub struct AllSelected {
    pub active: bool,
    /// The text views that were told to select all, to clear when it ends.
    views: HashMap<EntityId, WeakEntity<TextViewState>>,
}

impl AllSelected {
    /// Selects all of `view` (again: a view's first draw parses with the message's extensions, which resets it).
    pub fn apply(&mut self, view: &Entity<TextViewState>, cx: &mut App) {
        view.update(cx, |state, cx| state.select_all(cx));
        self.views.insert(view.entity_id(), view.downgrade());
    }

    /// Ends a select-all: clears each view it reached.
    pub fn end(&mut self, cx: &mut App) {
        self.active = false;
        for (_, view) in self.views.drain() {
            if let Some(view) = view.upgrade() {
                view.update(cx, |view, cx| view.clear_selection(cx));
            }
        }
    }
}

/// Painted after the transcript's list, over the same bounds: keeps the items that hold a selection end alive, and
/// follows the pointer to know which items those are.
pub struct Keeper {
    tracker: SharedTracker,
    painted: SharedPainted,
    all: SharedAll,
    /// The end items, built in the transcript's render, by index.
    candidates: Vec<(usize, AnyElement)>,
}

impl Keeper {
    pub fn new(tracker: SharedTracker, painted: SharedPainted, all: SharedAll, candidates: Vec<(usize, AnyElement)>) -> Self {
        Self { tracker, painted, all, candidates }
    }
}

impl IntoElement for Keeper {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Keeper {
    type RequestLayoutState = ();
    type PrepaintState = Vec<AnyElement>;

    fn id(&self) -> Option<ElementId> {
        Some("transcript-keeper".into())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style { position: Position::Absolute, ..Style::default() };
        style.inset.top = px(0.0).into();
        style.inset.left = px(0.0).into();
        style.size.width = relative(1.0).into();
        style.size.height = relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        // The list prepainted before this element: `painted` is this frame's.
        let painted = self.painted.borrow().clone();
        {
            // A still pointer over a list that auto-scrolls moves the cursor end to another item.
            let mut tracker = self.tracker.borrow_mut();
            if tracker.dragging
                && let Some(pointer) = tracker.pointer
                && let Some(item) = painted.item_at(pointer)
            {
                tracker.cursor = Some(item);
            }
        }
        let first = painted.rows.keys().next().copied().unwrap_or(0);
        let mask = ContentMask { bounds };
        let mut kept = Vec::new();
        for (ix, mut element) in self.candidates.drain(..) {
            if painted.rows.contains_key(&ix) {
                continue;
            }
            let space = size(AvailableSpace::Definite(bounds.size.width), AvailableSpace::MinContent);
            let measured = element.layout_as_root(space, window, cx);
            let y = if ix < first { bounds.top() - measured.height - px(1.0) } else { bounds.bottom() + px(1.0) };
            window.with_content_mask(Some(mask), |window| element.prepaint_at(point(bounds.left(), y), window, cx));
            kept.push(element);
        }
        kept
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        kept: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let mask = ContentMask { bounds };
        for element in kept.iter_mut() {
            window.with_content_mask(Some(mask), |window| element.paint(window, cx));
        }
        // Follow the gesture in the capture phase, before gpui-base's selection layer handles it, without stopping it.
        let (tracker, painted, all) = (self.tracker.clone(), self.painted.clone(), self.all.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
            if phase != DispatchPhase::Capture || event.button != MouseButton::Left {
                return;
            }
            if all.borrow().active {
                all.borrow_mut().end(cx);
            }
            let mut tracker = tracker.borrow_mut();
            if !bounds.contains(&event.position) {
                *tracker = SelectionTracker::default();
                return;
            }
            let item = painted.borrow().item_at(event.position);
            if !(event.modifiers.shift && tracker.anchor.is_some()) {
                tracker.anchor = item;
            }
            tracker.cursor = item;
            tracker.dragging = true;
            tracker.moved = false;
            tracker.pointer = Some(event.position);
            tracker.origin = Some(event.position);
        });
        let (tracker, painted) = (self.tracker.clone(), self.painted.clone());
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, _| {
            if phase != DispatchPhase::Capture || event.pressed_button != Some(MouseButton::Left) {
                return;
            }
            let mut tracker = tracker.borrow_mut();
            if tracker.dragging {
                tracker.pointer = Some(event.position);
                let origin = tracker.origin.unwrap_or(event.position);
                let (dx, dy) = (f32::from(event.position.x - origin.x), f32::from(event.position.y - origin.y));
                tracker.moved |= dx.abs() > DRAG_SLOP || dy.abs() > DRAG_SLOP;
                if let Some(item) = painted.borrow().item_at(event.position) {
                    tracker.cursor = Some(item);
                }
            }
        });
        let tracker = self.tracker.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, _| {
            if phase == DispatchPhase::Capture && event.button == MouseButton::Left {
                tracker.borrow_mut().dragging = false;
            }
        });
    }
}
