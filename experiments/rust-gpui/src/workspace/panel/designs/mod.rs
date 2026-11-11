//! The Designs tab of the side panel (WP-36, P-15): every design of the Chat side by side at the screen size each
//! was made for, one row per group, on a canvas that pans and zooms. Each frame has its number, title, version
//! picker, Delete and Choose; a click hands a design the mouse (its accent border), Escape takes it back.
//!
//! Ported from `ArtifactCanvas.tsx` and the Designs half of `ArtifactDock` (`ArtifactCard.tsx`). What differs:
//!
//! - Designs are drawn natively (N-03) from the ported layout (`src/logic/design_layout`), instead of an iframe per
//!   design over a rasterized preview. Every zoom draws sharp, and nothing waits on a frame to load.
//! - The canvas fills the panel body under a 40px bar, as the Artifact tab does, instead of a floating dock: the
//!   dock's own title row is the panel's tab strip. The zoom bar floats over the canvas as on the desktop.
//! - Fixture designs only (`fixture.rs`). Edit (the design page editor, WP-55), comment pins and their bubble, live
//!   agent drafts and replays, Share and the transcript's design cards are not ported. Send records the choice as
//!   sent, with no message.
//!
//! Pan: drag the background or a design that does not have the mouse, or scroll. Zoom: pinch, ⌘- or ctrl-scroll
//! about the pointer, or the zoom bar about the middle. Until the user pans or zooms, the canvas keeps every design
//! (or the one asked for) fitted as the panel resizes.

pub mod assets;
pub mod board;
pub mod fixture;
mod frame;
pub mod render;
pub mod scene;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, ClickEvent, Context, FocusHandle, Focusable, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PinchEvent,
    Pixels, Point, RenderImage, ScrollEvent, SharedString, Window, canvas, div, point, prelude::*, px,
};

use self::board::{Board, View};
use self::fixture::DesignArtifact;
use self::scene::{IconCache, Scene};
use crate::theme::{ActiveTheme, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{EmptySize, EmptyState, Icon, IconName, IconSize};

/// The bar under the panel's tab strip: the tab's name and Send.
pub const BAR_HEIGHT: Pixels = px(40.0);

/// A press on the canvas: where it started, the view then, and the design it started on (which a click without a
/// drag hands the mouse).
#[derive(Clone, Debug)]
struct Drag {
    start: Point<f64>,
    from: View,
    design: Option<String>,
    dragged: bool,
}

pub struct DesignsView {
    designs: Vec<DesignArtifact>,
    /// The version each design shows; absent follows the newest.
    versions: HashMap<String, u32>,
    scenes: HashMap<(String, u32), Rc<Scene>>,
    icons: IconCache,
    view: View,
    /// The canvas's size and its top-left in the window, from the last paint.
    room: (f64, f64),
    origin: Point<f64>,
    /// The user panned or zoomed: the canvas stops fitting on its own.
    moved: bool,
    /// The design to keep in view (a card's Open), or every design.
    focus: Option<String>,
    /// The design that has the mouse.
    active: Option<String>,
    hovered: Option<String>,
    /// Chosen here and waiting for Send, and the choice last sent.
    pending: Option<(String, u32)>,
    sent: Option<(String, u32)>,
    /// The design whose Delete is armed.
    deleting: Option<String>,
    drag: Option<Drag>,
    focus_handle: FocusHandle,
    renders: usize,
}

impl DesignsView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        assets::register_fonts(cx);
        let mut this = Self {
            designs: fixture::designs(),
            versions: HashMap::new(),
            scenes: HashMap::new(),
            icons: IconCache::new(),
            view: View::default(),
            room: (0.0, 0.0),
            origin: point(0.0, 0.0),
            moved: false,
            focus: None,
            active: None,
            hovered: None,
            pending: None,
            sent: None,
            deleting: None,
            drag: None,
            focus_handle: cx.focus_handle(),
            renders: 0,
        };
        this.apply_env_seed();
        this
    }

    /// Snapshot runs: `MILAGRE_GPUI_DESIGNS_FOCUS=<id>` fits one design, `MILAGRE_GPUI_DESIGNS_ACTIVE=<id>` gives it the
    /// mouse, `MILAGRE_GPUI_DESIGNS_CHOOSE=<id>` chooses it.
    fn apply_env_seed(&mut self) {
        if cfg!(test) {
            return;
        }
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        self.focus = var("MILAGRE_GPUI_DESIGNS_FOCUS");
        self.active = var("MILAGRE_GPUI_DESIGNS_ACTIVE");
        if let Some(id) = var("MILAGRE_GPUI_DESIGNS_CHOOSE")
            && let Some(version) = self.design(&id).map(DesignArtifact::latest)
        {
            self.pending = Some((id, version));
        }
    }

    pub fn designs(&self) -> &[DesignArtifact] {
        &self.designs
    }

    pub fn design(&self, id: &str) -> Option<&DesignArtifact> {
        self.designs.iter().find(|d| d.id == id)
    }

    pub fn view(&self) -> View {
        self.view
    }

    pub fn active(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn pending(&self) -> Option<(&str, u32)> {
        self.pending.as_ref().map(|(id, v)| (id.as_str(), *v))
    }

    pub fn sent(&self) -> Option<(&str, u32)> {
        self.sent.as_ref().map(|(id, v)| (id.as_str(), *v))
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    /// The version a design shows.
    pub fn shown_version(&self, id: &str) -> u32 {
        self.versions.get(id).copied().or_else(|| self.design(id).map(DesignArtifact::latest)).unwrap_or(1)
    }

    /// The board's items: each design at the size of the version it shows.
    pub fn items(&self) -> Vec<board::Item> {
        self.designs
            .iter()
            .map(|design| {
                let document = design.version(self.shown_version(&design.id)).unwrap_or(&design.versions[0]);
                board::Item { id: design.id.clone(), group: design.group.clone(), width: document.width, height: document.height }
            })
            .collect()
    }

    pub fn board(&self) -> Board {
        board::layout(&self.items(), self.view.scale)
    }

    fn scene(&mut self, id: &str, version: u32, cx: &App) -> Option<Rc<Scene>> {
        let key = (id.to_string(), version);
        if let Some(scene) = self.scenes.get(&key) {
            return Some(scene.clone());
        }
        let document = self.design(id)?.version(version)?.clone();
        let scene = Rc::new(Scene::build(document, &mut self.icons, cx));
        self.scenes.insert(key, scene.clone());
        Some(scene)
    }

    /// A Lucide glyph for the UI around the designs, 16px at a 1.8 stroke like the app's icons, decoded once.
    fn glyph(&mut self, name: &str, color: gpui::Rgba, cx: &App) -> Option<Arc<RenderImage>> {
        let hex = format!(
            "#{:02x}{:02x}{:02x}",
            (color.r * 255.0).round() as u8,
            (color.g * 255.0).round() as u8,
            (color.b * 255.0).round() as u8
        );
        let key = format!("ui|{name}|{hex}|{}", color.a);
        self.icons
            .entry(key)
            .or_insert_with(|| assets::icon_svg(name, &hex, f64::from(color.a), 1.8, 32).and_then(|svg| assets::render_svg(&svg, cx)))
            .clone()
    }

    /// The canvas's size and place changed (it measures itself as it paints): fits again unless the user moved.
    fn set_room(&mut self, room: (f64, f64), origin: Point<f64>, cx: &mut Context<Self>) {
        self.origin = origin;
        if room == self.room {
            return;
        }
        self.room = room;
        if !self.moved {
            self.fit(self.focus.clone().as_deref());
        }
        cx.notify();
    }

    fn fit(&mut self, id: Option<&str>) {
        if let Some(view) = board::fit(&self.items(), id, self.room, self.view.scale) {
            self.view = view;
        }
    }

    /// Brings one design into view, as a card's Open does.
    pub fn open_design(&mut self, id: &str, cx: &mut Context<Self>) {
        self.moved = false;
        self.focus = Some(id.to_string());
        self.fit(Some(id));
        cx.notify();
    }

    /// The zoom bar's Fit: every design, and it stays where the user leaves it.
    pub fn fit_all(&mut self, cx: &mut Context<Self>) {
        self.moved = true;
        self.focus = None;
        self.fit(None);
        cx.notify();
    }

    pub fn zoom_at(&mut self, factor: f64, at: (f64, f64), cx: &mut Context<Self>) {
        self.moved = true;
        self.view = self.view.zoom_at(factor, at.0, at.1);
        cx.notify();
    }

    fn middle(&self) -> (f64, f64) {
        (self.room.0 / 2.0, self.room.1 / 2.0)
    }

    pub fn zoom_by(&mut self, factor: f64, cx: &mut Context<Self>) {
        self.zoom_at(factor, self.middle(), cx);
    }

    pub fn zoom_to(&mut self, scale: f64, cx: &mut Context<Self>) {
        self.zoom_at(scale / self.view.scale, self.middle(), cx);
    }

    pub fn pan_by(&mut self, dx: f64, dy: f64, cx: &mut Context<Self>) {
        self.moved = true;
        self.view.x += dx;
        self.view.y += dy;
        cx.notify();
    }

    /// Steps a design's version; the newest follows later versions again (`go`).
    pub fn go(&mut self, id: &str, next: u32, cx: &mut Context<Self>) {
        let Some(last) = self.design(id).map(DesignArtifact::latest) else { return };
        let next = next.clamp(1, last);
        if next >= last {
            self.versions.remove(id);
        } else {
            self.versions.insert(id.to_string(), next);
        }
        cx.notify();
    }

    /// Choose, or unchoose the version already chosen (`onChoose`).
    pub fn choose(&mut self, id: &str, cx: &mut Context<Self>) {
        let shown = (id.to_string(), self.shown_version(id));
        self.pending = if self.pending.as_ref() == Some(&shown) { None } else { Some(shown) };
        cx.notify();
    }

    /// How many things Send sends: the choice (comments are not ported).
    pub fn feedback(&self) -> usize {
        usize::from(self.pending.is_some())
    }

    pub fn send(&mut self, cx: &mut Context<Self>) {
        if let Some(choice) = self.pending.take() {
            self.sent = Some(choice);
            cx.notify();
        }
    }

    pub fn arm_delete(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        self.deleting = id.map(str::to_string);
        cx.notify();
    }

    /// Deletes a design with every version (in the fixture: from this view), and what pointed at it.
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        self.designs.retain(|d| d.id != id);
        self.versions.remove(id);
        self.scenes.retain(|(design, _), _| design != id);
        for slot in [&mut self.pending, &mut self.sent] {
            if slot.as_ref().is_some_and(|(design, _)| design == id) {
                *slot = None;
            }
        }
        for slot in [&mut self.active, &mut self.hovered, &mut self.deleting, &mut self.focus] {
            if slot.as_deref() == Some(id) {
                *slot = None;
            }
        }
        cx.notify();
    }

    pub fn set_active(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        if self.active.as_deref() != id {
            self.active = id.map(str::to_string);
            cx.notify();
        }
    }

    fn set_hovered(&mut self, id: &str, hovered: bool, cx: &mut Context<Self>) {
        let next = if hovered {
            Some(id.to_string())
        } else if self.hovered.as_deref() == Some(id) {
            None
        } else {
            return;
        };
        if self.hovered != next {
            self.hovered = next;
            cx.notify();
        }
    }

    fn local(&self, position: Point<Pixels>) -> Point<f64> {
        point(f64::from(f32::from(position.x)) - self.origin.x, f64::from(f32::from(position.y)) - self.origin.y)
    }

    /// The design whose screen (not its title row) is under a canvas-relative point.
    fn body_at(&self, at: Point<f64>) -> Option<String> {
        let view = self.view;
        let (x, y) = ((at.x - view.x) / view.scale, (at.y - view.y) / view.scale);
        self.board()
            .frames
            .iter()
            .rev()
            .find(|f| x >= f.body.x && x <= f.body.right() && y >= f.body.y && y <= f.body.bottom())
            .map(|f| f.id.clone())
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus_handle, cx);
        let at = self.local(event.position);
        let design = self.body_at(at);
        // A press anywhere but on the design that has the mouse takes it back.
        if design.is_none() || design != self.active {
            self.set_active(None, cx);
        }
        if design.is_some() && design == self.active {
            return;
        }
        self.drag = Some(Drag { start: at, from: self.view, design, dragged: false });
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.drag.is_none() {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            self.drag = None;
            return;
        }
        let at = self.local(event.position);
        let Some(drag) = self.drag.as_mut() else { return };
        let (dx, dy) = (at.x - drag.start.x, at.y - drag.start.y);
        if !drag.dragged && dx.hypot(dy) < board::DRAG_SLOP {
            return;
        }
        drag.dragged = true;
        let from = drag.from;
        self.moved = true;
        self.view = View { x: from.x + dx, y: from.y + dy, scale: from.scale };
        cx.notify();
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.take() else { return };
        if !drag.dragged
            && let Some(design) = drag.design
        {
            self.set_active(Some(&design), cx);
        }
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(px(16.0));
        let (dx, dy) = (f64::from(f32::from(delta.x)), f64::from(f32::from(delta.y)));
        if event.modifiers.platform || event.modifiers.control {
            let at = self.local(event.position);
            // `deltaY` is the opposite sign of GPUI's: scrolling down is a negative delta here.
            self.zoom_at((dy * 0.01).exp(), (at.x, at.y), cx);
        } else {
            self.pan_by(dx, dy, cx);
        }
    }

    fn on_pinch(&mut self, event: &PinchEvent, _: &mut Window, cx: &mut Context<Self>) {
        let at = self.local(event.position);
        self.zoom_at(1.0 + f64::from(event.delta), (at.x, at.y), cx);
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" {
            if self.deleting.is_some() {
                self.arm_delete(None, cx);
            } else if self.active.is_some() {
                self.set_active(None, cx);
            } else {
                return;
            }
            cx.stop_propagation();
        }
    }

    fn bar(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let feedback = self.feedback();
        div()
            .flex_none()
            .h(BAR_HEIGHT)
            .px_3()
            .flex()
            .items_center()
            .gap_2()
            .child(Icon::new(IconName::PaintBoard).size(IconSize::S14).color(theme.ink2))
            .child(div().flex_1().min_w_0().truncate().text_step(TEXT_13).text_color(theme.ink).child("Designs"))
            .when(feedback > 0, |el| {
                let (ink, on_ink) = (theme.ink, theme.on_ink);
                el.child(
                    div()
                        .id("designs-send")
                        .debug_selector(|| "designs-send".to_string())
                        .flex()
                        .items_center()
                        .gap_1()
                        .h(px(24.0))
                        .px_2()
                        .rounded(crate::theme::RADIUS_CONTROL)
                        .bg(ink)
                        .text_color(on_ink)
                        .text_step(TEXT_12)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .cursor_pointer()
                        .hover(|style| style.opacity(0.9))
                        .child("Send")
                        .child(
                            div()
                                .px(px(6.0))
                                .rounded_full()
                                .bg(gpui::Rgba { a: 0.2, ..on_ink })
                                .text_step(TEXT_11)
                                .child(feedback.to_string()),
                        )
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.send(cx))),
                )
            })
    }
}

impl Focusable for DesignsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for DesignsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let entity = cx.entity().downgrade();
        let measure = canvas(
            move |bounds, _, cx| {
                let room = (f64::from(f32::from(bounds.size.width)), f64::from(f32::from(bounds.size.height)));
                let origin = point(f64::from(f32::from(bounds.origin.x)), f64::from(f32::from(bounds.origin.y)));
                if let Some(view) = entity.upgrade() {
                    view.update(cx, |view, cx| view.set_room(room, origin, cx));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let view = self.view;
        let line = theme.line;
        let dots = canvas(|_, _, _| {}, move |bounds, _, window, _| frame::paint_dots(bounds, view, line, window)).absolute().size_full();
        let board = self.board();
        let groups = board.groups.iter().map(|group| frame::group(group, view, &theme)).collect::<Vec<_>>();
        let room = self.room;
        let visible = |rect: &board::Rect| {
            let (x, y) = view.to_screen(rect.x, rect.y);
            x < room.0 && y < room.1 && x + rect.width * view.scale > 0.0 && y + rect.height * view.scale > 0.0
        };
        let mut frames = Vec::new();
        for item in board.frames.iter().filter(|f| visible(&f.frame) || room == (0.0, 0.0)) {
            let version = self.shown_version(&item.id);
            let scene = self.scene(&item.id, version, cx);
            frames.push(frame::frame(self, item, version, scene, &theme, cx));
        }
        let empty = self.designs.is_empty();
        let glyphs = [self.glyph("minus", theme.ink3, cx), self.glyph("scan", theme.ink3, cx)];
        div()
            .id("designs-panel")
            .debug_selector(|| "panel-body-Designs".to_string())
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.canvas)
            .text_color(theme.ink)
            .child(self.bar(&theme, cx))
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            .child(
                div()
                    .id("designs-canvas")
                    .debug_selector(|| "designs-canvas".to_string())
                    .track_focus(&self.focus_handle)
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(theme.canvas)
                    .cursor_grab()
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .on_pinch(cx.listener(Self::on_pinch))
                    .on_key_down(cx.listener(Self::on_key_down))
                    .child(measure)
                    .child(dots)
                    .children(groups)
                    .children(frames)
                    .when(empty, |el| {
                        el.child(
                            div().absolute().size_full().flex().items_center().justify_center().child(
                                EmptyState::new()
                                    .size(EmptySize::Panel)
                                    .icon(IconName::PaintBoard)
                                    .title("No designs yet")
                                    .help("Designs an agent shows in this Chat appear here."),
                            ),
                        )
                    })
                    .when(!empty, |el| el.child(frame::zoom_bar(self.view.scale, glyphs, &theme, cx))),
            )
    }
}

/// The view's text for a zoom (`ZoomBar`): `40%`.
pub fn zoom_label(scale: f64) -> SharedString {
    format!("{}%", (scale * 100.0).round()).into()
}
