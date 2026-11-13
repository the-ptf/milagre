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
//! - Fixture designs (`fixture.rs`), or a data layer's ([`DesignsView::set_live`]: the Chat's designs as Milagre's
//!   daemon keeps them, `artifact:list` and `artifact:get` per version, with the comments sent on them as pins). Live,
//!   Delete and Send are [`DesignsEvent`]s the data layer carries out (`artifact:delete`; the choice as Electron's
//!   message, "I chose the design …"); while the first read is on its way the board is a skeleton. Live agent
//!   drafts and replays, Share and the transcript's design cards are not ported.
//! - Comment mode (`../comments.rs`): the comment button floats at the canvas's top-right (C toggles it too); a click
//!   on a design pins a comment there (with the layer under it), written in its bubble; Send sends the choice and the
//!   comments as Electron's message and records them ([`DesignsEvent::AddComments`], `artifact:add-comments`). The
//!   pins draw over the frames, outside their clipping, so a bubble near an edge stays whole.
//! - Edit opens the design page editor (`editor/`, WP-55) over the window; its Save adds a version here.
//!
//! Pan: drag the background or a design that does not have the mouse, or scroll. Zoom: pinch, ⌘- or ctrl-scroll
//! about the pointer, or the zoom bar about the middle. Until the user pans or zooms, the canvas keeps every design
//! (or the one asked for) fitted as the panel resizes.

pub mod assets;
pub mod board;
pub mod editor;
pub mod fixture;
mod frame;
pub mod render;
pub mod scene;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    App, ClickEvent, Context, Entity, FocusHandle, Focusable, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    PinchEvent, Pixels, Point, ScrollEvent, SharedString, Subscription, Window, anchored, canvas, deferred, div, point, prelude::*, px,
};

use self::board::{Board, View};
use self::editor::{DesignEditor, EditorEvent};
use self::fixture::DesignArtifact;
use self::scene::{IconCache, Scene};
use super::comments::{self, Bubble, CommentHost, Comments, Draft, Target};
use crate::theme::{ActiveTheme, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{EmptySize, EmptyState, IconName};

/// A comment sent on a design (`artifact:comments`), drawn as a numbered pin on the version it was left on.
#[derive(Clone, Debug, PartialEq)]
pub struct DesignPin {
    pub id: String,
    pub design: String,
    pub version: u32,
    /// Where on the screen, as fractions of its size.
    pub x: f64,
    pub y: f64,
    pub number: u32,
    pub text: String,
    pub resolved: bool,
    /// The agent's note on what it did, once it resolved it.
    pub note: Option<String>,
}

/// What the Designs tab asks a data layer to do (live only; the fixture does them in place).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesignsEvent {
    /// Delete a design with every version (`artifact:delete [{chatId, id}]`).
    Delete(String),
    /// Send the choice and the comments to the Chat as this message (Electron's `designFeedbackMessage`).
    Send(String),
    /// Record the comments just sent (`artifact:add-comments [{chatId, comments}]`, Electron's `DesignComment`s).
    AddComments(Vec<serde_json::Value>),
}

impl gpui::EventEmitter<DesignsEvent> for DesignsView {}

/// The message Send sends for a chosen version (`designFeedbackMessage` with a choice and no comments).
pub fn choice_message(id: &str, title: &str, version: u32) -> String {
    format!("I chose the design \"{title}\" ({id}, version {version}). Continue from this one.")
}

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
    /// The design page editor, while it is open over the window.
    editor: Option<(Entity<DesignEditor>, Subscription)>,
    focus_handle: FocusHandle,
    renders: usize,
    /// A data layer feeds the designs ([`Self::set_live`]); `loading` until its first read for the Chat answers.
    live: bool,
    loading: bool,
    pins: Vec<DesignPin>,
    comments: Comments,
}

impl CommentHost for DesignsView {
    fn comments(&self) -> &Comments {
        &self.comments
    }

    fn comments_mut(&mut self) -> &mut Comments {
        &mut self.comments
    }

    fn send_feedback(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.send(cx);
        self.bubble_left(window, cx);
    }

    /// The canvas keeps the keyboard for C and Escape once the bubble is gone.
    fn bubble_left(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus_handle, cx);
    }
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
            editor: None,
            focus_handle: cx.focus_handle(),
            renders: 0,
            live: false,
            loading: false,
            pins: Vec::new(),
            comments: Comments::default(),
        };
        this.apply_env_seed();
        if !cfg!(test)
            && let Ok(id) = std::env::var("MILAGRE_GPUI_DESIGNS_EDIT")
            && !id.is_empty()
        {
            this.open_editor(&id, cx);
            if let Some((editor, _)) = &this.editor {
                editor.update(cx, |editor, cx| editor.apply_env_seed(cx));
            }
        }
        this
    }

    /// Whether the layer editor is offered: never in the Preview (view only) nor on a data layer's designs.
    pub fn can_edit(&self, cx: &gpui::App) -> bool {
        !self.is_live() && !crate::workspace::preview::is_on(cx)
    }

    /// Edit: the design page editor on every design, this one active (`DesignPageEditor`).
    pub fn open_editor(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.can_edit(cx) {
            return;
        }
        if self.design(id).is_none() {
            return;
        }
        let (designs, versions) = (self.designs.clone(), self.versions.clone());
        let editor = cx.new(|cx| DesignEditor::new(&designs, &versions, id, cx));
        let subscription = cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| this.on_editor_event(event, cx));
        self.editor = Some((editor, subscription));
        self.active = None;
        cx.notify();
    }

    pub fn editor(&self) -> Option<&Entity<DesignEditor>> {
        self.editor.as_ref().map(|(editor, _)| editor)
    }

    fn on_editor_event(&mut self, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Close => {
                self.editor = None;
            }
            // Each saved draft is the design's newest version; the canvas follows it.
            EditorEvent::Saved(saved) => {
                for (id, document) in saved {
                    if let Some(design) = self.designs.iter_mut().find(|d| d.id == *id) {
                        match design.push_version(document.clone()) {
                            Ok(_) => {
                                self.versions.remove(id);
                            }
                            Err(error) => eprintln!("designs: the saved version of {id} does not read back: {error}"),
                        }
                    }
                }
            }
        }
        cx.notify();
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

    /// A data layer's Chat changed: its designs are being read (a skeleton until [`Self::set_live`] answers).
    pub fn start_live(&mut self, cx: &mut Context<Self>) {
        self.live = true;
        self.loading = true;
        self.designs.clear();
        self.pins.clear();
        self.versions.clear();
        self.scenes.clear();
        self.pending = None;
        self.sent = None;
        self.deleting = None;
        self.active = None;
        self.hovered = None;
        self.focus = None;
        self.moved = false;
        self.editor = None;
        self.comments.reset();
        cx.notify();
    }

    /// A data layer's read of the Chat's designs and the comments on them. A version picked here stays while the
    /// design still has it; the board fits again only when the designs changed and the user has not moved it.
    pub fn set_live(&mut self, designs: Vec<DesignArtifact>, pins: Vec<DesignPin>, cx: &mut Context<Self>) {
        let same = self.designs.len() == designs.len()
            && self
                .designs
                .iter()
                .zip(&designs)
                .all(|(a, b)| a.id == b.id && a.first == b.first && a.latest() == b.latest() && a.group == b.group);
        self.live = true;
        self.loading = false;
        self.versions.retain(|id, version| designs.iter().any(|d| d.id == *id && d.version(*version).is_some()));
        for slot in [&mut self.pending, &mut self.sent] {
            if slot.as_ref().is_some_and(|(id, version)| !designs.iter().any(|d| d.id == *id && d.version(*version).is_some())) {
                *slot = None;
            }
        }
        if !same {
            self.scenes.retain(|(id, version), _| designs.iter().any(|d| d.id == *id && d.version(*version).is_some()));
            self.designs = designs;
            if !self.moved {
                self.fit(self.focus.clone().as_deref());
            }
        }
        self.pins = pins;
        cx.notify();
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    pub fn pins(&self) -> &[DesignPin] {
        &self.pins
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

    /// The groups and the designs in view, laid out at the view (built as the board is measured, see `render`).
    fn board_layer(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = *cx.theme();
        let view = self.view;
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
        let zoom = (!self.designs.is_empty()).then(|| frame::zoom_bar(self.view.scale, &theme, cx));
        let pins = self.comment_layer(&board, &theme, cx);
        let button = (!self.designs.is_empty()).then(|| {
            div()
                .absolute()
                .top(px(16.0))
                .right(px(16.0))
                .p_1()
                .rounded(px(18.0))
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(comments::comment_button(self, "designs", "Comment on a design", &theme, cx))
        });
        div().relative().size_full().children(groups).children(frames).children(pins).children(zoom).children(button).into_any_element()
    }

    /// The pins over the frames in view (`CommentLayer`): sent comments on the version each shows (resolved ones only
    /// with "Show resolved comments" or while open), then the comments waiting; the open one as its bubble.
    fn comment_layer(&mut self, board: &Board, theme: &Theme, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let view = self.view;
        let room = self.room;
        let open = self.comments.open.clone();
        let mut out = Vec::new();
        let mut place = |el: gpui::AnyElement, x: f64, y: f64, opened: bool| {
            let left = if opened { x.min(room.0 - f64::from(comments::BUBBLE_WIDTH) - 8.0).max(0.0) } else { x };
            out.push(div().absolute().left(px(left as f32)).top(px(y as f32)).child(el).into_any_element());
        };
        for item in &board.frames {
            let version = self.shown_version(&item.id);
            let at = |x: f64, y: f64| view.to_screen(item.body.x + x * item.body.width, item.body.y + y * item.body.height);
            let sent: Vec<DesignPin> = self
                .pins
                .iter()
                .filter(|p| p.design == item.id && p.version == version)
                .filter(|p| self.comments.show_resolved || !p.resolved || open.as_deref() == Some(&format!("sent:{}", p.id)))
                .cloned()
                .collect();
            for pin in sent {
                let key = format!("sent:{}", pin.id);
                let (x, y) = at(pin.x, pin.y);
                if open.as_deref() == Some(key.as_str()) {
                    let content =
                        Bubble::Sent { text: pin.text.clone(), resolved: pin.resolved.then(|| pin.note.clone().unwrap_or_default()) };
                    place(comments::bubble(self, content, theme, cx).into_any_element(), x, y, true);
                    continue;
                }
                let (fill, ink) = if pin.resolved { (theme.green_ink, theme.on_green) } else { (theme.ink, theme.on_ink) };
                let face = comments::pin_face(format!("design-pin-{}", pin.id), pin.number, fill, ink, theme)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.open_pin(&key, window, cx)));
                place(face.into_any_element(), x, y, false);
            }
            let drafts: Vec<(usize, Draft)> = self
                .comments
                .drafts
                .iter()
                .enumerate()
                .filter(|(_, d)| d.target.id == item.id && d.target.version == version)
                .map(|(n, d)| (n, d.clone()))
                .collect();
            for (n, draft) in drafts {
                let (x, y) = at(draft.x, draft.y);
                let number = n as u32 + 1;
                if open.as_deref() == Some(draft.key.as_str()) {
                    let content = Bubble::Draft { key: draft.key.clone(), number };
                    place(comments::bubble(self, content, theme, cx).into_any_element(), x, y, true);
                    continue;
                }
                let key = draft.key.clone();
                let face = comments::pin_face(format!("design-draft-{number}"), number, theme.accent_ink, theme.on_accent, theme)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.open_pin(&key, window, cx)));
                place(face.into_any_element(), x, y, false);
            }
        }
        out
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
        let Some((first, last)) = self.design(id).map(|d| (d.first, d.latest())) else { return };
        let next = next.clamp(first, last);
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

    /// How many things Send sends: the comments written and the choice.
    pub fn feedback(&self) -> usize {
        self.comments.written() + usize::from(self.pending.is_some())
    }

    pub fn comments_state(&self) -> &Comments {
        &self.comments
    }

    /// Send (`ArtifactDock`'s `send`): the choice and the comments as one message to the Chat, then the comments are
    /// recorded so the agent can resolve them by id; comment mode ends. In the fixture the comments become sent pins.
    pub fn send(&mut self, cx: &mut Context<Self>) {
        if self.feedback() == 0 {
            return;
        }
        let written = self.comments.take_written(cx);
        let choice = self.pending.take();
        let titled =
            choice.as_ref().map(|(id, version)| (id.clone(), self.design(id).map(|d| d.title.clone()).unwrap_or_default(), *version));
        let message = comments::feedback_message(titled.as_ref().map(|(id, title, v)| (id.as_str(), title.as_str(), *v)), &written);
        if self.live {
            cx.emit(DesignsEvent::Send(message));
            if !written.is_empty() {
                cx.emit(DesignsEvent::AddComments(written.iter().map(comments::comment_value).collect()));
            }
        } else {
            for draft in &written {
                let number = self.pins.iter().filter(|p| p.design == draft.target.id).count() as u32 + 1;
                self.pins.push(DesignPin {
                    id: draft.key.clone(),
                    design: draft.target.id.clone(),
                    version: draft.target.version,
                    x: draft.x,
                    y: draft.y,
                    number,
                    text: draft.text.trim().to_string(),
                    resolved: false,
                    note: None,
                });
            }
        }
        if let Some(choice) = choice {
            self.sent = Some(choice);
        }
        self.comments.commenting = false;
        cx.notify();
    }

    /// Comment mode on or off (the comment button, C).
    pub fn set_commenting(&mut self, on: bool, cx: &mut Context<Self>) {
        if on {
            self.active = None;
        }
        comments::set_commenting(self, on, cx);
    }

    /// Pins a comment on design `id` at `(x, y)` (fractions of its screen), on the version it shows, naming the layer
    /// there, and opens its bubble.
    pub fn pin_comment(&mut self, id: &str, x: f64, y: f64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(design) = self.design(id) else { return };
        let (title, version) = (design.title.clone(), self.shown_version(id));
        let node_id = self.scene(id, version, cx).and_then(|scene| {
            let node = crate::logic::design_layout::layout::node_at(&scene.document, &scene.layout, x * scene.width, y * scene.height)?;
            Some(scene.document.nodes[node].id.clone())
        });
        let draft = Draft {
            key: comments::new_comment_id(),
            target: Target { id: id.to_string(), title, version, html: false },
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
            text: String::new(),
            node_id,
            anchor: None,
            near: None,
            tab: None,
        };
        let key = self.comments.pin(draft, cx);
        self.comments.open = None;
        comments::open_bubble(self, &key, window, cx);
    }

    /// Opens a pin's bubble (a draft's key, or `sent:<id>`).
    pub fn open_pin(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        comments::open_bubble(self, key, window, cx);
    }

    pub fn arm_delete(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        self.deleting = id.map(str::to_string);
        cx.notify();
    }

    /// Deletes a design with every version (in the fixture: from this view), and what pointed at it.
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.live {
            cx.emit(DesignsEvent::Delete(id.to_string()));
        }
        let gone: Vec<String> = self.comments.drafts.iter().filter(|d| d.target.id == id).map(|d| d.key.clone()).collect();
        for key in gone {
            self.comments.remove(&key);
        }
        self.pins.retain(|pin| pin.design != id);
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
        // A press elsewhere closes the open bubble (`useDismiss`), dropping a comment left empty.
        if self.comments.open.is_some() {
            comments::close_bubble(self, window, cx);
        }
        // In comment mode a press on a design pins a comment there instead.
        if self.comments.commenting
            && let Some(id) = design.clone()
            && let Some(body) = self.board().frames.iter().find(|f| f.id == id).map(|f| f.body)
        {
            let view = self.view;
            let (x, y) = ((at.x - view.x) / view.scale, (at.y - view.y) / view.scale);
            self.pin_comment(&id, (x - body.x) / body.width, (y - body.y) / body.height, window, cx);
            // The bubble's field keeps the focus: the canvas does not take it back as this press ends.
            window.prevent_default();
            return;
        }
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

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // The bubble's text field keeps its own keys.
        if self.comments.typing(window, cx) {
            return;
        }
        let keys = &event.keystroke;
        let bare = !(keys.modifiers.platform || keys.modifiers.control || keys.modifiers.alt || keys.modifiers.shift);
        if keys.key == comments::COMMENT_KEY && bare && self.editor.is_none() {
            let on = !self.comments.commenting;
            self.set_commenting(on, cx);
            cx.stop_propagation();
            return;
        }
        // ⌘Enter sends what waits, as Send does.
        if keys.key == "enter" && (keys.modifiers.platform || keys.modifiers.control) && self.feedback() > 0 {
            self.send(cx);
            cx.stop_propagation();
            return;
        }
        if event.keystroke.key == "escape" {
            // Escape closes a bubble, then leaves comment mode, before anything else.
            if self.comments.open.is_some() {
                comments::close_bubble(self, window, cx);
                cx.stop_propagation();
                return;
            }
            if self.comments.commenting {
                self.set_commenting(false, cx);
                cx.stop_propagation();
                return;
            }
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
            // No title: the panel's tab already says Designs. The bar shows only while there is feedback to send.
            .justify_end()
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
        // The board is built where the canvas is measured (its prepaint), so the first frame already draws it fitted to
        // the panel's size: a fit made after a draw needs another frame, which a window that is not active (a
        // snapshot) may never draw.
        let board_layer = canvas(
            move |bounds, window, cx| {
                let room = (f64::from(f32::from(bounds.size.width)), f64::from(f32::from(bounds.size.height)));
                let origin = point(f64::from(f32::from(bounds.origin.x)), f64::from(f32::from(bounds.origin.y)));
                let view = entity.upgrade()?;
                let mut layer = view.update(cx, |view, cx| {
                    view.set_room(room, origin, cx);
                    view.board_layer(cx)
                });
                layer.prepaint_as_root(bounds.origin, bounds.size.into(), window, cx);
                Some(layer)
            },
            |_, layer, window, cx| {
                if let Some(mut layer) = layer {
                    layer.paint(window, cx);
                }
            },
        )
        .absolute()
        .size_full();
        let empty = self.designs.is_empty();
        let loading = self.loading && empty;
        let editor = self
            .editor
            .as_ref()
            .map(|(editor, _)| deferred(anchored().position(gpui::point(px(0.0), px(0.0))).child(editor.clone())).with_priority(10));
        div()
            .id("designs-panel")
            .debug_selector(|| "panel-body-Designs".to_string())
            .size_full()
            .flex()
            .flex_col()
            .text_color(theme.ink)
            .when(self.feedback() > 0, |el| el.child(self.bar(&theme, cx)))
            .child(
                div()
                    .id("designs-canvas")
                    .debug_selector(|| "designs-canvas".to_string())
                    .track_focus(&self.focus_handle)
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .map(|el| if self.comments.commenting { el.cursor_crosshair() } else { el.cursor_grab() })
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .on_pinch(cx.listener(Self::on_pinch))
                    .on_key_down(cx.listener(Self::on_key_down))
                    .child(board_layer)
                    .when(loading, |el| el.child(div().absolute().size_full().child(crate::workspace::panel::skeletons::designs(&theme))))
                    .when(empty && !loading, |el| {
                        el.child(
                            div().absolute().size_full().flex().items_center().justify_center().child(
                                EmptyState::new()
                                    .size(EmptySize::Panel)
                                    .icon(IconName::PaintBoard)
                                    .title("No designs yet")
                                    .help("Designs an agent shows in this Chat appear here."),
                            ),
                        )
                    }), // The zoom bar is the board layer's: it reads the fit made as the board is measured.
            )
            .children(editor)
    }
}

/// The view's text for a zoom (`ZoomBar`): `40%`.
pub fn zoom_label(scale: f64) -> SharedString {
    format!("{}%", (scale * 100.0).round()).into()
}
