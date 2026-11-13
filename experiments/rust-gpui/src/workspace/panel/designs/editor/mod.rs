//! The Designs page editor (WP-55, P-16): the full-window editor a design's Edit opens, ported from
//! `DesignPageEditor.tsx`, `DesignEditor.tsx`, `DesignTools.tsx` and the preview controller
//! (`design-controller-script.mjs`). Every design of the Chat is an artboard on one board; the active one has the
//! tool rail, the Layers panel and the inspector. Edits change a draft per design through the ported operations
//! (`src/logic/design_ops`), with undo and redo, and Save stores each changed draft as a new version.
//!
//! - `page.rs`: the board's geometry (artboards by group, fit, zoom).
//! - `canvas.rs`: the artboards drawn natively, the selection, the resize handle and the snap guides.
//! - `tools.rs`: the tool rail and the Layers panel. `inspector.rs`: the layer properties. `chrome.rs`: the title,
//!   the page actions, the zoom bar, the notices and the close confirmation.
//!
//! Interaction as on the desktop: a click selects a layer (an instance's root for its generated layers), Shift or ⌘
//! adds to the selection; a drag moves the selected layers (not those in an auto-layout frame or locked) and snaps
//! their edges and middles to the screen and the other layers within 6px (Option turns it off); the handle at the
//! selection's corner resizes and fixes its size; arrows nudge 1px (Shift 10), ⌫ deletes, ⌘D duplicates, ⌘Z and
//! ⇧⌘Z undo and redo, ⌘S saves, Escape closes the Layers panel, then the editor. Drag the background, hold Space
//! or use the middle button to pan; scroll pans, ⌘ or ctrl and scroll or a pinch zooms.
//!
//! What differs: the editor is drawn over the window from the Designs panel (`deferred`), not portalled into the
//! page; Save writes the new version into the fixture (`DesignsView`), standing in for `artifact:apply`; a newer
//! version arriving while editing (rebase and merge review), the kept-draft cache, Export and Share are not ported.
//! The inspector has no kit controls on the desktop either: a text style or a
//! binding is kept until a field it sets is edited, as `applyDesignOperations` does.

mod canvas;
mod chrome;
mod inspector;
pub mod page;
mod tools;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PinchEvent, Pixels, Point, ScrollEvent, ScrollHandle, Subscription, Window, div, point, prelude::*, px,
};
use serde_json::{Map, Value};

use self::inspector::{FieldSpec, FieldState};
use self::page::{Page, View};
use super::assets;
use super::board::Item;
use super::fixture::DesignArtifact;
use super::scene::{IconCache, Scene};
use crate::logic::design_layout::DesignDocument;
use crate::logic::design_ops::editor::{self as ops, History, Rect};
use crate::logic::design_ops::schema::Node;
use crate::logic::design_ops::{self, nodes_of, same};
use crate::theme::{ActiveTheme, HEADER_HEIGHT};

/// The page's header under the window chrome: title, status and actions (`top-[chrome+56px]`).
pub const PAGE_HEADER: f64 = 56.0;
/// The preview controller's own colours (`design-controller-script.mjs`), drawn on the design, not app chrome: the
/// selection and resize handle, and the snap guides.
pub const SELECTION: u32 = 0x367bf5;
pub const GUIDE: u32 = 0xf25fa8;

/// What the editor tells the Designs panel.
#[derive(Clone, Debug)]
pub enum EditorEvent {
    /// Closed, saved or discarded.
    Close,
    /// Each design saved, with its new version's document.
    Saved(Vec<(String, Value)>),
}

/// One design's draft (`DesignEditorSession`).
pub struct Session {
    pub id: String,
    pub title: String,
    pub group: Option<String>,
    pub saved_version: u32,
    pub saved: Value,
    pub history: History,
    pub selection: Vec<String>,
    revision: u64,
    scene: Option<(u64, Rc<Scene>)>,
}

impl Session {
    pub fn new(artifact: &DesignArtifact, version: u32) -> Result<Self, String> {
        let source = artifact.source(version).ok_or("This design has no editable document.")?;
        let saved = design_ops::validate(source)?;
        let nodes = nodes_of(&saved);
        let first = nodes.iter().find(|n| n.get("type").and_then(Value::as_str) == Some("text")).or(nodes.first());
        let selection = first.and_then(|n| n.get("id").and_then(Value::as_str)).map(|id| vec![id.to_string()]).unwrap_or_default();
        Ok(Self {
            id: artifact.id.clone(),
            title: artifact.title.clone(),
            group: artifact.group.clone(),
            saved_version: version,
            history: History::new(saved.clone()),
            selection: ops::selectable_ids(&nodes, &selection),
            saved,
            revision: 0,
            scene: None,
        })
    }

    pub fn document(&self) -> &Value {
        &self.history.present
    }

    pub fn nodes(&self) -> Vec<Node> {
        nodes_of(&self.history.present)
    }

    pub fn dirty(&self) -> bool {
        !same(&self.history.present, &self.saved)
    }

    /// The selection, lifted to instance roots and pruned of layers that are gone.
    pub fn selected(&self) -> Vec<String> {
        ops::selectable_ids(&self.nodes(), &self.selection)
    }

    fn size(&self) -> (f64, f64) {
        let d = self.document();
        (d["width"].as_f64().unwrap_or(390.0), d["height"].as_f64().unwrap_or(844.0))
    }

    fn set_present(&mut self, changed: impl FnOnce(&mut History)) {
        changed(&mut self.history);
        self.revision += 1;
    }
}

/// A press on the canvas.
#[derive(Clone, Debug)]
enum Press {
    Pan { start: Point<f64>, from: View },
    Layers { design: String, start: Point<f64>, targets: Vec<(String, Rect)>, rect: Rect, resizing: bool, moved: bool },
}

/// A drag in progress: the document as it would be, and the guides it snapped to.
struct Live {
    design: String,
    operations: Vec<Value>,
    guides: (Option<f64>, Option<f64>),
    scene: Rc<Scene>,
}

pub struct DesignEditor {
    sessions: Vec<Session>,
    active: String,
    layers_open: bool,
    collapsed: HashSet<String>,
    view: View,
    moved: bool,
    /// The viewport's size and its top-left in the window.
    room: (f64, f64),
    origin: Point<f64>,
    press: Option<Press>,
    live: Option<Live>,
    space: bool,
    /// The close confirmation is up.
    confirming: bool,
    error: Option<String>,
    notice: Option<String>,
    icons: IconCache,
    fields: HashMap<&'static str, FieldState>,
    specs: HashMap<&'static str, FieldSpec>,
    field_scope: String,
    subscriptions: Vec<Subscription>,
    focus: FocusHandle,
    layers_scroll: ScrollHandle,
    inspector_scroll: ScrollHandle,
    seed: u64,
    /// Takes the keyboard on its first frame, as the desktop focuses the editor's root when it opens.
    focus_pending: bool,
    renders: usize,
}

impl EventEmitter<EditorEvent> for DesignEditor {}

impl DesignEditor {
    /// The editor on every design, with `active` selected; each design at the version the canvas shows.
    pub fn new(designs: &[DesignArtifact], versions: &HashMap<String, u32>, active: &str, cx: &mut Context<Self>) -> Self {
        assets::register_fonts(cx);
        let sessions: Vec<Session> =
            designs.iter().filter_map(|d| Session::new(d, versions.get(&d.id).copied().unwrap_or_else(|| d.latest())).ok()).collect();
        let active = if sessions.iter().any(|s| s.id == active) {
            active.to_string()
        } else {
            sessions.first().map(|s| s.id.clone()).unwrap_or_default()
        };
        Self {
            sessions,
            active,
            layers_open: false,
            collapsed: HashSet::new(),
            view: View::default(),
            moved: false,
            room: (0.0, 0.0),
            origin: point(0.0, 0.0),
            press: None,
            live: None,
            space: false,
            confirming: false,
            error: None,
            notice: None,
            icons: IconCache::new(),
            fields: HashMap::new(),
            specs: HashMap::new(),
            field_scope: String::new(),
            subscriptions: Vec::new(),
            focus: cx.focus_handle(),
            layers_scroll: ScrollHandle::new(),
            inspector_scroll: ScrollHandle::new(),
            seed: 0x9e37_79b9_7f4a_7c15,
            focus_pending: true,
            renders: 0,
        }
    }

    // ---- Reading ----

    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    fn session_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn active(&self) -> Option<&Session> {
        self.session(&self.active)
    }

    pub fn active_id(&self) -> &str {
        &self.active
    }

    pub fn view(&self) -> View {
        self.view
    }

    pub fn layers_open(&self) -> bool {
        self.layers_open
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn confirming(&self) -> bool {
        self.confirming
    }

    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn guides(&self) -> Option<(Option<f64>, Option<f64>)> {
        self.live.as_ref().map(|l| l.guides)
    }

    /// Designs with unsaved changes.
    pub fn changed(&self) -> usize {
        self.sessions.iter().filter(|s| s.dirty()).count()
    }

    /// The page's status line.
    pub fn status(&self) -> String {
        let changed = self.changed();
        if changed > 0 {
            if self.sessions.len() > 1 {
                format!("Unsaved changes in {changed} {}", if changed == 1 { "design" } else { "designs" })
            } else {
                "Unsaved changes".into()
            }
        } else if let Some(active) = self.active() {
            format!("Saved · version {}", active.saved_version)
        } else {
            "Opening page…".into()
        }
    }

    pub fn items(&self) -> Vec<Item> {
        self.sessions
            .iter()
            .map(|s| {
                let (width, height) = s.size();
                Item { id: s.id.clone(), group: s.group.clone(), width, height }
            })
            .collect()
    }

    pub fn page(&self) -> Page {
        page::layout(&self.items(), self.view.scale)
    }

    /// The scene a design draws now (the drag's preview while one is live).
    fn scene(&mut self, id: &str, cx: &App) -> Option<Rc<Scene>> {
        if let Some(live) = self.live.as_ref().filter(|l| l.design == id) {
            return Some(live.scene.clone());
        }
        let session = self.sessions.iter().position(|s| s.id == id)?;
        let revision = self.sessions[session].revision;
        if let Some((built, scene)) = &self.sessions[session].scene
            && *built == revision
        {
            return Some(scene.clone());
        }
        let scene = Rc::new(build_scene(self.sessions[session].document(), &mut self.icons, cx)?);
        self.sessions[session].scene = Some((revision, scene.clone()));
        Some(scene)
    }

    /// The laid-out boxes of a design's layers in paint order, by id.
    fn bounds(&mut self, id: &str, cx: &App) -> Vec<(String, Rect)> {
        let Some(scene) = self.scene(id, cx) else { return Vec::new() };
        scene
            .layout
            .order
            .iter()
            .map(|(index, b)| (scene.document.nodes[*index].id.clone(), Rect { x: b.x, y: b.y, width: b.width, height: b.height }))
            .collect()
    }

    /// A new layer id for a type (`${type}-${uuid.slice(0, 8)}`), unique in the document.
    fn new_id(&mut self, kind: &str, taken: &HashSet<String>) -> String {
        loop {
            // xorshift64*: ids only need to be unlikely to repeat.
            self.seed ^= self.seed >> 12;
            self.seed ^= self.seed << 25;
            self.seed ^= self.seed >> 27;
            let value = self.seed.wrapping_mul(0x2545_f491_4f6c_dd1d);
            let id = format!("{kind}-{:08x}", (value >> 32) as u32);
            if !taken.contains(&id) {
                return id;
            }
        }
    }

    // ---- Changing ----

    /// `change`: applies operations to the active draft as one undo step, or shows why they can't apply.
    pub fn change(&mut self, operations: Vec<Value>, cx: &mut Context<Self>) -> bool {
        let id = self.active.clone();
        self.change_in(&id, operations, cx)
    }

    fn change_in(&mut self, id: &str, operations: Vec<Value>, cx: &mut Context<Self>) -> bool {
        if operations.is_empty() {
            return false;
        }
        let Some(session) = self.session_mut(id) else { return false };
        match design_ops::apply(session.document(), &operations) {
            Ok(next) => {
                if !same(&next, session.document()) {
                    session.set_present(|history| history.push(next));
                }
                self.error = None;
                cx.notify();
                true
            }
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                false
            }
        }
    }

    /// A patch to the one selected layer.
    pub fn patch(&mut self, patch: Map<String, Value>, cx: &mut Context<Self>) {
        let Some(id) = self.single_selected() else { return };
        self.change(vec![design_ops::op_update(&id, patch)], cx);
    }

    pub fn single_selected(&self) -> Option<String> {
        let selected = self.active()?.selected();
        (selected.len() == 1).then(|| selected[0].clone())
    }

    pub fn undo(&mut self, cx: &mut Context<Self>) {
        let id = self.active.clone();
        if let Some(session) = self.session_mut(&id)
            && session.history.can_undo()
        {
            session.set_present(|h| {
                h.undo();
            });
            self.error = None;
            cx.notify();
        }
    }

    pub fn redo(&mut self, cx: &mut Context<Self>) {
        let id = self.active.clone();
        if let Some(session) = self.session_mut(&id)
            && session.history.can_redo()
        {
            session.set_present(|h| {
                h.redo();
            });
            self.error = None;
            cx.notify();
        }
    }

    pub fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.active != id && self.session(id).is_some() {
            self.active = id.to_string();
            cx.notify();
        }
    }

    /// `selectLayer`: one layer, or Shift/⌘ toggles it in the selection.
    pub fn select(&mut self, id: Option<&str>, additive: bool, cx: &mut Context<Self>) {
        let active = self.active.clone();
        let Some(session) = self.session_mut(&active) else { return };
        let nodes = session.nodes();
        let target = id.map(|id| design_ops::instance_root_id(&nodes, id).unwrap_or_else(|| id.to_string()));
        session.selection = match (target, additive) {
            (Some(t), true) if session.selection.contains(&t) => session.selection.iter().filter(|s| **s != t).cloned().collect(),
            (Some(t), true) => session.selection.iter().cloned().chain([t]).collect(),
            (Some(t), false) => vec![t],
            (None, true) => session.selection.clone(),
            (None, false) => Vec::new(),
        };
        cx.notify();
    }

    pub fn set_selection(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        let active = self.active.clone();
        if let Some(session) = self.session_mut(&active) {
            session.selection = ops::selectable_ids(&session.nodes(), &ids);
            cx.notify();
        }
    }

    pub fn selection(&self) -> Vec<String> {
        self.active().map(Session::selected).unwrap_or_default()
    }

    /// The rail's add buttons.
    pub fn add(&mut self, kind: &str, cx: &mut Context<Self>) {
        let taken: HashSet<String> =
            self.active().map(|s| s.nodes().iter().filter_map(|n| n["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        let id = self.new_id(kind, &taken);
        if self.change(vec![design_ops::op_insert(ops::new_node(kind, &id), None)], cx) {
            self.set_selection(vec![id], cx);
        }
    }

    pub fn duplicate(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let nodes = session.nodes();
        let selected = session.selected();
        let mut taken: HashSet<String> = nodes.iter().filter_map(|n| n["id"].as_str().map(str::to_string)).collect();
        let mut fresh = Vec::new();
        for _ in 0..nodes.len() {
            let id = self.new_id("x", &taken);
            taken.insert(id.clone());
            fresh.push(id.trim_start_matches("x-").to_string());
        }
        let mut next = fresh.into_iter();
        let (operations, roots) =
            ops::duplicate_operations(&nodes, &selected, |kind| format!("{kind}-{}", next.next().unwrap_or_default()));
        if self.change(operations, cx) {
            self.set_selection(roots, cx);
        }
    }

    pub fn remove(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let operations = ops::delete_operations(&session.nodes(), &session.selected());
        if self.change(operations, cx) {
            self.set_selection(Vec::new(), cx);
        }
    }

    /// `move`: arrow keys and the selection's X and Y.
    pub fn nudge(&mut self, dx: f64, dy: f64, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let operations = ops::move_operations(&session.nodes(), &session.selected(), dx, dy);
        self.change(operations, cx);
    }

    /// Make component on a frame, or a new instance of a main component.
    pub fn insert_instance(&mut self, component: &str, cx: &mut Context<Self>) {
        let Some(session) = self.active() else { return };
        let document = session.document().clone();
        let taken: HashSet<String> = session.nodes().iter().filter_map(|n| n["id"].as_str().map(str::to_string)).collect();
        let id = self.new_id("instance", &taken);
        match design_ops::create_instance(&document, component, &id, None, None) {
            Ok(operations) => {
                if self.change(operations, cx) {
                    self.set_selection(vec![id], cx);
                }
            }
            Err(error) => {
                self.error = Some(error);
                cx.notify();
            }
        }
    }

    pub fn detach(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.single_selected() else { return };
        let Some(document) = self.active().map(|s| s.document().clone()) else { return };
        match design_ops::detach_instance(&document, &id) {
            Ok(operations) => {
                self.change(operations, cx);
            }
            Err(error) => {
                self.error = Some(error);
                cx.notify();
            }
        }
    }

    pub fn set_layers_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.layers_open = open;
        if !self.moved {
            self.fit();
        }
        cx.notify();
    }

    pub fn toggle_collapsed(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(id) {
            self.collapsed.insert(id.to_string());
        }
        cx.notify();
    }

    /// Saves every changed draft as a new version: the operations `diffDesignDocuments` gives, applied to the saved
    /// version as the host's `artifact:apply` would.
    pub fn save(&mut self, cx: &mut Context<Self>) -> bool {
        let mut saved = Vec::new();
        for session in &mut self.sessions {
            if !session.dirty() {
                continue;
            }
            let result =
                design_ops::diff(&session.saved, session.document()).and_then(|operations| design_ops::apply(&session.saved, &operations));
            match result {
                Ok(next) => {
                    session.saved = next.clone();
                    session.saved_version += 1;
                    session.set_present(|h| h.present = next.clone());
                    saved.push((session.id.clone(), next));
                }
                Err(error) => {
                    let (id, title) = (session.id.clone(), session.title.clone());
                    self.active = id;
                    self.error = Some(format!("Review {title} before saving the page. Your remaining drafts are still here. {error}"));
                    cx.notify();
                    return false;
                }
            }
        }
        self.error = None;
        if !saved.is_empty() {
            cx.emit(EditorEvent::Saved(saved));
        }
        cx.notify();
        true
    }

    /// Close: asks first while a draft has unsaved changes.
    pub fn close(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.changed() > 0 {
            self.confirming = true;
            cx.notify();
        } else {
            cx.emit(EditorEvent::Close);
        }
    }

    pub fn discard(&mut self, cx: &mut Context<Self>) {
        cx.emit(EditorEvent::Close);
    }

    // ---- The view ----

    fn fit(&mut self) {
        if let Some(view) = page::fit(&self.items(), self.room, self.view.scale, self.layers_open) {
            self.view = view;
        }
    }

    pub fn fit_page(&mut self, cx: &mut Context<Self>) {
        self.moved = false;
        self.fit();
        cx.notify();
    }

    pub fn zoom_at(&mut self, factor: f64, at: (f64, f64), cx: &mut Context<Self>) {
        self.moved = true;
        self.view = self.view.zoom_at(factor, at.0, at.1);
        cx.notify();
    }

    pub fn zoom_by(&mut self, factor: f64, cx: &mut Context<Self>) {
        let at = page::zoom_centre(self.room, self.layers_open);
        self.zoom_at(factor, at, cx);
    }

    fn set_room(&mut self, room: (f64, f64), origin: Point<f64>, cx: &mut Context<Self>) {
        self.origin = origin;
        if room == self.room {
            return;
        }
        self.room = room;
        if !self.moved {
            self.fit();
        }
        cx.notify();
    }

    fn local(&self, position: Point<Pixels>) -> Point<f64> {
        point(f64::from(f32::from(position.x)) - self.origin.x, f64::from(f32::from(position.y)) - self.origin.y)
    }

    // ---- Pointer ----

    /// The design under a viewport point and the point in its own pixels.
    fn design_at(&self, at: Point<f64>) -> Option<(String, (f64, f64))> {
        let (bx, by) = self.view.to_board(at.x, at.y);
        let page = self.page();
        let artboard = page::artboard_at(&page, bx, by)?;
        Some((artboard.id.clone(), (bx - artboard.x, by - artboard.screen_y())))
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let at = self.local(event.position);
        let pan = event.button == MouseButton::Middle || self.space;
        let hit = if pan { None } else { self.design_at(at) };
        let Some((design, (x, y))) = hit else {
            if event.button == MouseButton::Left || event.button == MouseButton::Middle {
                self.moved = true;
                self.press = Some(Press::Pan { start: at, from: self.view });
            }
            return;
        };
        if event.button != MouseButton::Left {
            return;
        }
        self.activate(&design, cx);
        self.press_design(&design, (x, y), at, event.modifiers.shift || event.modifiers.platform || event.modifiers.control, cx);
    }

    /// The controller's `pointerdown` on a design: the resize handle, or the layer under the pointer.
    fn press_design(&mut self, design: &str, (x, y): (f64, f64), at: Point<f64>, additive: bool, cx: &mut Context<Self>) {
        let bounds = self.bounds(design, cx);
        let Some(session) = self.session(design) else { return };
        let nodes = session.nodes();
        let selected = session.selected();
        let roots = ops::selection_roots(&nodes, &selected);
        let handle = canvas::handle_hit(&nodes, &roots, &bounds, (x, y), self.view.scale);
        if handle {
            let targets: Vec<(String, Rect)> =
                roots.iter().filter_map(|id| bounds.iter().find(|(b, _)| b == id).map(|(_, r)| (id.clone(), *r))).collect();
            if let Some(rect) = Rect::union(&targets.iter().map(|t| t.1).collect::<Vec<_>>()) {
                self.press = Some(Press::Layers { design: design.to_string(), start: at, targets, rect, resizing: true, moved: false });
            }
            return;
        }
        let hit = self
            .scene(design, cx)
            .and_then(|scene| scene.layer_at(x, y).map(str::to_string))
            .map(|id| design_ops::instance_root_id(&nodes, &id).unwrap_or(id));
        if additive {
            self.select(hit.as_deref(), true, cx);
            return;
        }
        let selection = match &hit {
            Some(id) if selected.contains(id) => selected.clone(),
            Some(id) => vec![id.clone()],
            None => Vec::new(),
        };
        self.set_selection(selection.clone(), cx);
        let roots = ops::selection_roots(&nodes, &selection);
        let targets: Vec<(String, Rect)> = roots
            .iter()
            .filter(|id| ops::movable(&nodes, id))
            .filter_map(|id| bounds.iter().find(|(b, _)| *b == **id).map(|(_, r)| (id.clone(), *r)))
            .collect();
        if let Some(rect) = Rect::union(&targets.iter().map(|t| t.1).collect::<Vec<_>>()) {
            self.press = Some(Press::Layers { design: design.to_string(), start: at, targets, rect, resizing: false, moved: false });
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(press) = self.press.clone() else { return };
        if event.pressed_button.is_none() {
            self.finish(true, cx);
            return;
        }
        let at = self.local(event.position);
        match press {
            Press::Pan { start, from } => {
                self.view = View { x: from.x + at.x - start.x, y: from.y + at.y - start.y, scale: from.scale };
                cx.notify();
            }
            Press::Layers { design, start, targets, rect, resizing, moved } => {
                let scale = self.view.scale;
                let raw = ((at.x - start.x) / scale, (at.y - start.y) / scale);
                self.drag_to(&design, &targets, rect, resizing, raw, event.modifiers.alt, moved, cx);
            }
        }
    }

    /// One step of a layer drag: snapped offsets, and the document as it would be after it.
    #[allow(clippy::too_many_arguments)]
    pub fn drag_to(
        &mut self,
        design: &str,
        targets: &[(String, Rect)],
        rect: Rect,
        resizing: bool,
        raw: (f64, f64),
        no_snap: bool,
        moved: bool,
        cx: &mut Context<Self>,
    ) {
        let rounded = (ops::js_round(raw.0), ops::js_round(raw.1));
        if !moved && !ops::drag_moved(rounded.0, rounded.1) {
            return;
        }
        if let Some(Press::Layers { moved, .. }) = self.press.as_mut() {
            *moved = true;
        }
        // Snap against the document as it is, not the preview.
        let saved_live = self.live.take();
        let bounds = self.bounds(design, cx);
        let Some(session) = self.session(design) else {
            self.live = saved_live;
            return;
        };
        let nodes = session.nodes();
        let excluded: HashSet<String> = targets.iter().map(|t| t.0.clone()).collect();
        let step = ops::drag_step(rect, raw, resizing, no_snap, &excluded, session.size(), &nodes, &bounds);
        let operations = ops::drag_operations(&nodes, targets, step.dx, step.dy, resizing);
        let preview = design_ops::apply(session.document(), &operations).ok();
        let scene = preview.as_ref().and_then(|doc| build_scene(doc, &mut self.icons, cx)).map(Rc::new);
        self.live = scene.map(|scene| Live { design: design.to_string(), operations, guides: step.guides, scene });
        cx.notify();
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.finish(false, cx);
    }

    /// The controller's `finish`: a drag that moved becomes one undoable edit.
    fn finish(&mut self, cancelled: bool, cx: &mut Context<Self>) {
        let press = self.press.take();
        let live = self.live.take();
        if let (Some(Press::Layers { design, moved: true, .. }), Some(live), false) = (press, live, cancelled) {
            self.change_in(&design, live.operations, cx);
        }
        cx.notify();
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(px(16.0));
        let (dx, dy) = (f64::from(f32::from(delta.x)), f64::from(f32::from(delta.y)));
        if event.modifiers.platform || event.modifiers.control {
            let at = self.local(event.position);
            self.zoom_at((dy * 0.01).exp(), (at.x, at.y), cx);
        } else {
            self.moved = true;
            self.view.x += dx;
            self.view.y += dy;
            cx.notify();
        }
    }

    fn on_pinch(&mut self, event: &PinchEvent, _: &mut Window, cx: &mut Context<Self>) {
        let at = self.local(event.position);
        self.zoom_at(1.0 + f64::from(event.delta), (at.x, at.y), cx);
    }

    // ---- Keys ----

    /// Whether a text field has the keyboard (its keys are its own).
    fn typing(&self, window: &Window, cx: &App) -> bool {
        self.fields.values().any(|field| field.focused(window, cx))
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let m = event.keystroke.modifiers;
        let command = m.platform || m.control;
        if command && key == "s" {
            self.save(cx);
            cx.stop_propagation();
            return;
        }
        if self.typing(window, cx) {
            return;
        }
        if self.confirming {
            if key == "escape" {
                self.confirming = false;
                cx.notify();
                cx.stop_propagation();
            }
            return;
        }
        match key {
            "escape" => {
                if self.layers_open {
                    self.set_layers_open(false, cx);
                } else {
                    self.close(window, cx);
                }
            }
            "space" => {
                self.space = true;
                cx.notify();
            }
            "z" if command => {
                if m.shift {
                    self.redo(cx);
                } else {
                    self.undo(cx);
                }
            }
            "d" if command => self.duplicate(cx),
            "backspace" | "delete" => self.remove(cx),
            "left" | "right" | "up" | "down" => {
                let step = if m.shift { 10.0 } else { 1.0 };
                let (dx, dy) = match key {
                    "left" => (-step, 0.0),
                    "right" => (step, 0.0),
                    "up" => (0.0, -step),
                    _ => (0.0, step),
                };
                self.nudge(dx, dy, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn on_key_up(&mut self, event: &KeyUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "space" && self.space {
            self.space = false;
            cx.notify();
        }
    }

    /// Snapshot runs: `MILAGRE_GPUI_DESIGNS_EDIT_LAYERS=1` opens the Layers panel, `…_SELECT=<ids>` selects layers,
    /// `…_DRAG=<dx>,<dy>` shows the selection mid-drag with its guides, `…_NUDGE=<dx>,<dy>` leaves an unsaved edit.
    pub fn apply_env_seed(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let pair = |value: String| -> Option<(f64, f64)> {
            let (a, b) = value.split_once(',')?;
            Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
        };
        if var("MILAGRE_GPUI_DESIGNS_EDIT_LAYERS").is_some() {
            self.layers_open = true;
        }
        if let Some(ids) = var("MILAGRE_GPUI_DESIGNS_EDIT_SELECT") {
            self.set_selection(ids.split(',').map(str::to_string).collect(), cx);
        }
        if let Some((dx, dy)) = var("MILAGRE_GPUI_DESIGNS_EDIT_NUDGE").and_then(pair) {
            self.nudge(dx, dy, cx);
        }
        if let Some(raw) = var("MILAGRE_GPUI_DESIGNS_EDIT_DRAG").and_then(pair) {
            self.start_drag_preview(raw, cx);
        }
    }

    /// Shows the selection dragged by `raw` design px (snapped), as a press and move would.
    pub fn start_drag_preview(&mut self, raw: (f64, f64), cx: &mut Context<Self>) {
        let design = self.active.clone();
        let bounds = self.bounds(&design, cx);
        let Some(session) = self.session(&design) else { return };
        let nodes = session.nodes();
        let roots = ops::selection_roots(&nodes, &session.selected());
        let targets: Vec<(String, Rect)> = roots
            .iter()
            .filter(|id| ops::movable(&nodes, id))
            .filter_map(|id| bounds.iter().find(|(b, _)| *b == **id).map(|(_, r)| (id.clone(), *r)))
            .collect();
        let Some(rect) = Rect::union(&targets.iter().map(|t| t.1).collect::<Vec<_>>()) else { return };
        self.press = Some(Press::Layers {
            design: design.clone(),
            start: point(0.0, 0.0),
            targets: targets.clone(),
            rect,
            resizing: false,
            moved: false,
        });
        self.drag_to(&design, &targets, rect, false, raw, false, false, cx);
    }
}

/// A design's scene from its JSON document.
fn build_scene(document: &Value, icons: &mut IconCache, cx: &App) -> Option<Scene> {
    let document = DesignDocument::from_json(document).ok()?;
    Some(Scene::build(Arc::new(document), icons, cx))
}

impl Focusable for DesignEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DesignEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        if std::mem::take(&mut self.focus_pending) {
            window.focus(&self.focus, cx);
        }
        let theme = *cx.theme();
        let viewport = window.viewport_size();
        let top = f64::from(f32::from(HEADER_HEIGHT)) + PAGE_HEADER;
        let room = (f64::from(f32::from(viewport.width)), (f64::from(f32::from(viewport.height)) - top).max(0.0));
        if room != self.room || self.origin.y != top {
            self.set_room(room, point(0.0, top), cx);
        }
        let board = canvas::board(self, &theme, cx);
        let rail = tools::rail(self, &theme, cx);
        let layers = self.layers_open.then(|| tools::layers(self, &theme, cx));
        let inspector = inspector::panel(self, &theme, window, cx);
        let actions = chrome::actions(self, &theme, cx);
        let heading = chrome::heading(self, &theme);
        let notices = chrome::notices(self, &theme);
        let zoom = chrome::zoom_bar(self, &theme, cx);
        let confirmation = self.confirming.then(|| chrome::confirmation(&theme, cx));
        let grab = self.space || matches!(self.press, Some(Press::Pan { .. }));
        div()
            .id("design-editor")
            .debug_selector(|| "design-editor".to_string())
            .track_focus(&self.focus)
            .key_context("DesignEditor")
            .relative()
            .w(viewport.width)
            .h(viewport.height)
            .overflow_hidden()
            .occlude()
            .bg(theme.canvas)
            .text_color(theme.ink)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_key_up(cx.listener(Self::on_key_up))
            .child(heading)
            .child(actions)
            .child(
                div()
                    .id("design-page-viewport")
                    .debug_selector(|| "design-page-viewport".to_string())
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .top(px(top as f32))
                    .overflow_hidden()
                    .when(grab, |el| el.cursor_grab())
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .on_pinch(cx.listener(Self::on_pinch))
                    .child(board)
                    .child(rail)
                    .children(layers)
                    .child(notices)
                    .child(inspector)
                    .child(zoom),
            )
            .children(confirmation)
    }
}
