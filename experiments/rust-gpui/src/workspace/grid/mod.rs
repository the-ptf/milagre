//! The Chat grid and the split (V-02, WP-48): `ChatGrid.tsx`, `agents/TileFamilyMenu.tsx`, and the parts of `App.tsx`
//! that hold the layout (`gridChats`, `dropOnGrid`, the split's moves, the layout toggle and the Subchats button).
//!
//! - ⌘⇧M (`grid.toggle`) and the corner's grid button show every active Chat side by side; the split shows only the
//!   Chats put beside the open one ("Open beside parent", "Show all N side by side", the Subchats button, a drop).
//! - The focused tile owns the composer: its body is the window's one `ChatView` (header hidden, the tile has its
//!   own). Every other tile is the Chat's transcript alone, a cached view of its own; clicking it focuses it.
//! - The sidebar's drag (WP-49) asks [`ChatGrid::hit`] where a dragged Chat would land, shows it with
//!   [`ChatGrid::show_drop`] and drops with [`ChatGrid::drop_chat`].
//!
//! | File | What |
//! | --- | --- |
//! | `logic.rs` | the TypeScript rules, pure (`chat-grid.ts`, `grid-drop.ts`, `subchat-split.ts`) |
//! | `tile.rs` | a tile's header and frame, the drop overlay, the split tile's menu, the corner buttons |

pub mod hooks;
pub mod logic;
mod tile;

#[cfg(test)]
mod logic_tests;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, Bounds, Context, Entity, EventEmitter, KeyBinding, Pixels, Point, SharedString, StyleRefinement, Window,
    canvas, div, prelude::*, px,
};

use crate::logic::lists::subchats::{FamilySession, FamilySessions, chat_family};
use crate::logic::marks::chat_mark::ChatMark;
use crate::theme::{ActiveTheme, HEADER_HEIGHT};
use crate::workspace::chat::ChatView;
use crate::workspace::chat::fixture;
use crate::workspace::chat::pills::bookmark::FamilyChat;
use crate::workspace::chat::transcript::Transcript;
use crate::workspace::sidebar::ChatRow;

pub use logic::{ChatLayout, GridDropTarget, Side};
pub use tile::corner_count;

/// A tile's least width and height, and the gap between tiles (`minmax(440px,1fr)`, `minmax(320px,1fr)`, `gap-3`).
pub const TILE_MIN_WIDTH: f32 = 440.0;
pub const TILE_MIN_HEIGHT: f32 = 320.0;
pub const TILE_GAP: f32 = 12.0;
/// The grid's inset from the column's sides and bottom; its top clears the window's 44px title strip.
pub const GRID_INSET: f32 = 12.0;

gpui::actions!(milagre_gpui_grid, [ToggleGrid]);

/// ⌘⇧M from the effective key table (`grid.toggle`), once per app.
pub fn install_keys(cx: &mut App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    use crate::logic::keybindings::{GpuiOptions, default_keybindings, gpui_bindings};
    let keys: Vec<KeyBinding> = gpui_bindings(&default_keybindings(), cfg!(target_os = "macos"), GpuiOptions::default())
        .into_iter()
        .filter(|binding| binding.command == "grid.toggle")
        .map(|binding| {
            // GPUI keeps a binding's strings for the life of the app; this one is installed once.
            let stroke: &'static str = binding.keystroke.leak();
            KeyBinding::new(stroke, ToggleGrid, None)
        })
        .collect();
    cx.bind_keys(keys);
}

/// What the grid asks the window to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GridEvent {
    /// Focus this Chat: the window opens it (the sidebar selects its row) and its tile takes the composer.
    Focus(String),
}

impl EventEmitter<GridEvent> for ChatGrid {}

/// What a tile's header shows about its Chat, from its sidebar row.
#[derive(Clone, Debug, PartialEq)]
pub struct TileInfo {
    pub key: String,
    pub title: SharedString,
    /// "project · branch".
    pub detail: SharedString,
    pub mark: ChatMark,
}

impl TileInfo {
    pub fn from_row(row: &ChatRow) -> Self {
        // The row's detail is "project · #PR · +n · computer": the tile names the Project (and branch) only.
        let mut parts = row.detail.split(" \u{b7} ");
        let project = parts.next().unwrap_or_default();
        Self { key: row.key.to_string(), title: row.title.clone(), detail: project.to_string().into(), mark: row.mark }
    }

    /// The Chat waits on an approval or a question: an unfocused tile says so and is outlined in orange.
    pub fn needs_you(&self) -> bool {
        matches!(self.mark, ChatMark::Question | ChatMark::Waiting)
    }
}

/// The split tile's menu while open: which tile it hangs from.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TileMenu {
    tile: String,
}

pub struct ChatGrid {
    layout: ChatLayout,
    /// The grid's tiles in order (`gridChats`): kept between frames so a status change never moves a tile.
    grid_tiles: Vec<String>,
    /// The split's Chats in order.
    split: Vec<String>,
    /// Chats kept in the grid while idle (dropped there, or pinned from a tile).
    pins: Vec<String>,
    focused: Option<String>,
    /// The window's Chat column: the focused tile's body.
    chat: Entity<ChatView>,
    /// Every unfocused tile's transcript, by Chat key.
    transcripts: HashMap<String, Entity<Transcript>>,
    /// What each Chat's header shows, by key (the sidebar's rows).
    info: HashMap<String, TileInfo>,
    /// The keys of the sidebar's active Chats (`activeChatKeys`), in its order.
    active: Vec<String>,
    /// Every Chat's family facts (the sidebar's), for the split's moves and the tile menu.
    family: Vec<FamilyChat>,
    /// The width the window gives the grid, before it has measured it.
    width_hint: f32,
    /// Where each tile and the whole pane were last painted, for the drop hit test.
    painted: Rc<RefCell<Painted>>,
    drop: Option<GridDropTarget>,
    menu: Option<TileMenu>,
    storage: HashMap<String, String>,
    /// Snapshot seed: `MILAGRE_GPUI_GRID=split` shows the open Chat's family once a Chat is open.
    seed_family: bool,
}

#[derive(Default)]
struct Painted {
    pane: Bounds<Pixels>,
    tiles: Vec<(String, Bounds<Pixels>)>,
}

impl ChatGrid {
    pub fn new(chat: Entity<ChatView>, _cx: &mut Context<Self>) -> Self {
        let storage = HashMap::new();
        // Snapshot seed (never in tests): `MILAGRE_GPUI_GRID=grid|split` opens that layout.
        let layout = match std::env::var("MILAGRE_GPUI_GRID").ok().as_deref() {
            Some("grid") if !cfg!(test) => ChatLayout::Grid,
            Some("split") if !cfg!(test) => ChatLayout::Split,
            _ => logic::read_chat_layout(&storage),
        };
        Self {
            layout,
            grid_tiles: Vec::new(),
            split: logic::read_split_chats(&storage),
            pins: logic::read_grid_pins(&storage),
            focused: None,
            chat,
            transcripts: HashMap::new(),
            info: HashMap::new(),
            active: Vec::new(),
            family: Vec::new(),
            width_hint: 960.0,
            painted: Rc::default(),
            drop: None,
            menu: None,
            storage,
            seed_family: layout == ChatLayout::Split,
        }
    }

    pub fn layout(&self) -> ChatLayout {
        self.layout
    }

    pub fn focused(&self) -> Option<&str> {
        self.focused.as_deref()
    }

    pub fn pins(&self) -> &[String] {
        &self.pins
    }

    pub fn split_keys(&self) -> &[String] {
        &self.split
    }

    /// The tiles on screen, in order; empty while the open Chat shows alone.
    pub fn tiles(&self) -> Vec<String> {
        match self.layout {
            ChatLayout::Single => Vec::new(),
            ChatLayout::Grid if self.focused.is_some() => self.grid_tiles.clone(),
            ChatLayout::Grid => Vec::new(),
            // The last one left shows alone.
            ChatLayout::Split if self.split.len() >= 2 => self.split.clone(),
            ChatLayout::Split => Vec::new(),
        }
    }

    pub fn has_tiles(&self) -> bool {
        !self.tiles().is_empty()
    }

    pub fn drop_target(&self) -> Option<&GridDropTarget> {
        self.drop.as_ref()
    }

    pub fn menu_open_on(&self) -> Option<&str> {
        self.menu.as_ref().map(|menu| menu.tile.as_str())
    }

    /// The window's state each frame: the open Chat, the sidebar's rows (their marks say which Chats are active) and
    /// the families, and the grid's width before it is measured. Cheap when nothing changed.
    pub fn sync(&mut self, focused: Option<&str>, rows: &[ChatRow], family: Vec<FamilyChat>, width_hint: f32, cx: &mut Context<Self>) {
        self.width_hint = width_hint;
        let info: HashMap<String, TileInfo> = rows.iter().map(|row| (row.key.to_string(), TileInfo::from_row(row))).collect();
        let active = active_from_rows(rows);
        let changed = info != self.info || active != self.active || family != self.family || focused != self.focused.as_deref();
        self.info = info;
        self.active = active;
        self.family = family;
        if focused != self.focused.as_deref() {
            self.focused = focused.map(str::to_string);
            self.menu = None;
            // A Chat on screen in a split is only focused; any other ends the split.
            if self.layout == ChatLayout::Split && focused.is_some_and(|key| !self.split.iter().any(|item| item == key)) {
                self.end_split(cx);
            }
        }
        self.update_grid_tiles();
        if self.seed_family && self.focused.is_some() {
            self.seed_family = false;
            self.show_family(cx);
        }
        if changed {
            cx.notify();
        }
    }

    fn update_grid_tiles(&mut self) {
        let wanted: Vec<String> = self.active.iter().chain(self.pins.iter()).cloned().collect();
        if let Some(next) = logic::grid_chats(&self.grid_tiles, &wanted, self.focused.as_deref()) {
            self.grid_tiles = next;
        }
    }

    fn set_layout(&mut self, layout: ChatLayout, cx: &mut Context<Self>) {
        self.layout = layout;
        self.menu = None;
        logic::save_chat_layout(&mut self.storage, layout);
        cx.notify();
    }

    /// ⌘⇧M and the corner's grid button: every active Chat as a grid, or the open one alone.
    pub fn toggle_grid(&mut self, cx: &mut Context<Self>) {
        let next = if self.layout == ChatLayout::Grid { ChatLayout::Single } else { ChatLayout::Grid };
        self.set_layout(next, cx);
    }

    fn set_split(&mut self, keys: Vec<String>, cx: &mut Context<Self>) {
        logic::save_split_chats(&mut self.storage, &keys);
        self.split = keys;
        self.set_layout(ChatLayout::Split, cx);
    }

    pub fn end_split(&mut self, cx: &mut Context<Self>) {
        self.split.clear();
        logic::save_split_chats(&mut self.storage, &[]);
        self.set_layout(ChatLayout::Single, cx);
    }

    /// The family menu's "Open beside parent": the parent and the open Chat, the open one staying focused.
    pub fn open_beside(&mut self, parent: &str, cx: &mut Context<Self>) {
        let Some(open) = self.focused.clone() else { return };
        self.set_split(logic::beside_parent(parent, &open), cx);
    }

    /// The open Chat's family: its top Chat and that Chat's listed Subchats (`chat_family`).
    pub fn focused_family(&self) -> Option<(String, Vec<String>)> {
        let key = self.focused.as_deref()?;
        family_of(&self.family, key)
    }

    /// "Show all N side by side" and the Subchats button: the whole family, the focused Chat always among it.
    pub fn show_family(&mut self, cx: &mut Context<Self>) {
        let Some((root, children)) = self.focused_family() else { return };
        self.set_split(logic::family_split(&root, &children, self.focused.as_deref()), cx);
    }

    /// Whether the split shows exactly the open Chat's family (the Subchats button is pressed).
    pub fn family_shown(&self) -> bool {
        let Some((root, children)) = self.focused_family() else { return false };
        let shown = self.tiles();
        self.layout == ChatLayout::Split
            && shown.len() == children.len() + 1
            && shown.contains(&root)
            && children.iter().all(|child| shown.contains(child))
    }

    /// The Subchats button: off always returns to the open Chat alone.
    pub fn toggle_family(&mut self, cx: &mut Context<Self>) {
        if self.family_shown() { self.end_split(cx) } else { self.show_family(cx) }
    }

    /// A tile's pin: kept in the grid while idle, or not.
    pub fn toggle_pin(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(at) = self.pins.iter().position(|pin| pin == key) {
            self.pins.remove(at);
        } else {
            self.pins.push(key.to_string());
        }
        logic::save_grid_pins(&mut self.storage, &self.pins);
        self.update_grid_tiles();
        cx.notify();
    }

    /// A split tile's close button: the others stay; the last one left shows alone. Closing the focused tile focuses its
    /// neighbour first.
    pub fn close_tile(&mut self, key: &str, cx: &mut Context<Self>) {
        let tiles = self.split.clone();
        let Some(at) = tiles.iter().position(|item| item == key) else { return };
        let next: Vec<String> = tiles.iter().filter(|item| *item != key).cloned().collect();
        let neighbour = next[at..].iter().chain(next[..at].iter().rev()).find(|item| !logic::is_draft_tile_key(item)).cloned();
        self.split = next.clone();
        logic::save_split_chats(&mut self.storage, &next);
        if self.focused.as_deref() == Some(key)
            && let Some(neighbour) = neighbour
        {
            self.focused = Some(neighbour.clone());
            cx.emit(GridEvent::Focus(neighbour));
        }
        if self.split.len() < 2 {
            self.end_split(cx);
        }
        cx.notify();
    }

    /// A split tile's menu: "Open alone" ends the split on that Chat.
    pub fn open_alone(&mut self, key: &str, cx: &mut Context<Self>) {
        self.end_split(cx);
        if self.focused.as_deref() != Some(key) {
            cx.emit(GridEvent::Focus(key.to_string()));
        }
    }

    /// A split tile's menu: a family row takes the tile's place, the one explicit swap.
    pub fn swap(&mut self, tile: &str, next: &str, cx: &mut Context<Self>) {
        self.menu = None;
        let Some(swapped) = logic::swap_tile(&self.split, tile, next) else {
            cx.notify();
            return;
        };
        self.split = swapped;
        logic::save_split_chats(&mut self.storage, &self.split);
        if self.focused.as_deref() == Some(tile) {
            self.focused = Some(next.to_string());
            cx.emit(GridEvent::Focus(next.to_string()));
        }
        cx.notify();
    }

    pub fn toggle_menu(&mut self, tile: &str, cx: &mut Context<Self>) {
        self.menu = match &self.menu {
            Some(menu) if menu.tile == tile => None,
            _ => Some(TileMenu { tile: tile.to_string() }),
        };
        cx.notify();
    }

    pub fn close_menu(&mut self, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            cx.notify();
        }
    }

    fn focus_tile(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.focused.as_deref() != Some(key) {
            self.menu = None;
            cx.emit(GridEvent::Focus(key.to_string()));
        }
    }

    /// The drop target under a window point for the Chat `key` being dragged, or `None` when the point is not over the
    /// Chat view or the Chat can't go there. Reads where the tiles were last painted.
    pub fn hit(&self, point: Point<Pixels>, key: &str) -> Option<GridDropTarget> {
        let painted = self.painted.borrow();
        let area = |b: &Bounds<Pixels>| logic::Area {
            left: f32::from(b.origin.x),
            top: f32::from(b.origin.y),
            width: f32::from(b.size.width),
            height: f32::from(b.size.height),
        };
        if self.has_tiles() {
            let (tile, bounds) = painted.tiles.iter().find(|(_, bounds)| bounds.contains(&point))?;
            if tile == key {
                return None;
            }
            let (side, area, bar) = logic::drop_side(area(bounds), f32::from(point.x), TILE_GAP);
            return Some(GridDropTarget { tile: Some(tile.clone()), side, area, bar });
        }
        let focused = self.focused.as_deref()?;
        if focused == key || !painted.pane.contains(&point) {
            return None;
        }
        let (side, area, bar) = logic::drop_side(area(&painted.pane), f32::from(point.x), 0.0);
        Some(GridDropTarget { tile: None, side, area, bar })
    }

    /// Shows (or, with `None`, hides) where the dragged Chat would land.
    pub fn show_drop(&mut self, target: Option<GridDropTarget>, cx: &mut Context<Self>) {
        let same = match (&self.drop, &target) {
            (Some(a), Some(b)) => a.tile == b.tile && a.side == b.side && a.area.left == b.area.left && a.area.width == b.area.width,
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.drop = target;
            cx.notify();
        }
    }

    /// The drop (`dropOnGrid`): in the grid the Chat is pinned and placed; otherwise it joins the split.
    pub fn drop_chat(&mut self, key: &str, target: &GridDropTarget, cx: &mut Context<Self>) {
        self.show_drop(None, cx);
        let focused = self.focused.clone();
        if self.layout == ChatLayout::Grid {
            self.pins.retain(|pin| pin != key);
            self.pins.push(key.to_string());
            logic::save_grid_pins(&mut self.storage, &self.pins);
            self.grid_tiles = logic::place_dropped(&self.grid_tiles, key, target.tile.as_deref(), target.side, focused.as_deref());
            cx.notify();
            return;
        }
        let placed = logic::place_dropped(&self.tiles(), key, target.tile.as_deref(), target.side, focused.as_deref());
        self.set_split(placed, cx);
    }

    fn transcript_for(&mut self, key: &str, title: &str, cx: &mut Context<Self>) -> Entity<Transcript> {
        self.transcripts
            .entry(key.to_string())
            .or_insert_with(|| cx.new(|cx| Transcript::with_items(fixture::transcript_for(key, title), cx)))
            .clone()
    }

    fn tile_info(&self, key: &str) -> TileInfo {
        self.info.get(key).cloned().unwrap_or_else(|| TileInfo {
            key: key.to_string(),
            title: if logic::is_draft_tile_key(key) { "New Chat".into() } else { "Chat".into() },
            detail: key.split('#').next().unwrap_or_default().rsplit('/').next().unwrap_or_default().to_string().into(),
            mark: ChatMark::Idle,
        })
    }

    /// The columns for `count` tiles at the grid's measured width, or the window's hint before the first paint.
    fn columns(&self, count: usize) -> usize {
        let measured = f32::from(self.painted.borrow().pane.size.width);
        let width = if measured > 0.0 { measured } else { self.width_hint };
        logic::grid_columns(width - 2.0 * GRID_INSET, count, TILE_MIN_WIDTH, TILE_GAP)
    }
}

/// The sidebar rows the grid counts as active: running, waiting, asking, background work, a Delegation, unread.
fn active_from_rows(rows: &[ChatRow]) -> Vec<String> {
    let runs: Vec<logic::RunInfo> = rows
        .iter()
        .filter(|row| matches!(row.mark, ChatMark::Running | ChatMark::Background | ChatMark::Waiting | ChatMark::Question))
        .map(|row| logic::RunInfo { key: row.key.to_string(), waiting: matches!(row.mark, ChatMark::Waiting | ChatMark::Question) })
        .collect();
    let delegations: Vec<Option<String>> =
        rows.iter().filter(|row| row.mark == ChatMark::Delegated).map(|row| Some(row.key.to_string())).collect();
    let sessions: Vec<logic::SessionInfo> = rows
        .iter()
        .map(|row| logic::SessionInfo { key: row.key.to_string(), unread: row.mark == ChatMark::Unread, ..Default::default() })
        .collect();
    logic::active_chat_keys(&runs, &delegations, &sessions)
}

/// The family of `key` among the Chats of its own scope (`chat_family`).
pub fn family_of(chats: &[FamilyChat], key: &str) -> Option<(String, Vec<String>)> {
    let scope = key.rsplit_once('#')?.0;
    let id_of = |key: &str| key.rsplit_once('#').and_then(|(s, id)| (s == scope).then(|| id.parse::<u64>().ok()).flatten());
    let sessions: FamilySessions = chats
        .iter()
        .filter_map(|chat| {
            let id = id_of(&chat.key)?;
            let parent = chat.parent.as_deref().and_then(id_of);
            Some((id, FamilySession { id, parent, archived: chat.archived, done_at: chat.done.then_some(1) }))
        })
        .collect();
    let (root, children) = chat_family(Some(&sessions), key)?;
    (!children.is_empty()).then_some((root, children))
}

impl Render for ChatGrid {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let tiles = self.tiles();
        let painted = self.painted.clone();
        let measure_pane = canvas(move |bounds, _, _| painted.borrow_mut().pane = bounds, |_, _, _, _| {}).absolute().size_full();
        if tiles.is_empty() {
            // The open Chat alone: the pane is still a drop target ("Open beside").
            return div()
                .relative()
                .size_full()
                .child(measure_pane)
                .child(self.chat.clone())
                .children(self.drop.as_ref().map(|target| tile::drop_overlay(target, &theme)))
                .into_any_element();
        }
        let columns = self.columns(tiles.len()).max(1);
        self.painted.borrow_mut().tiles.clear();
        let split = self.layout == ChatLayout::Split;
        let mut rows: Vec<AnyElement> = Vec::new();
        for (row_ix, chunk) in tiles.chunks(columns).enumerate() {
            let mut row = div().id(("grid-row", row_ix)).flex().flex_row().gap(px(TILE_GAP)).flex_1().min_h(px(TILE_MIN_HEIGHT));
            for key in chunk {
                row = row.child(self.tile(key, split, &tiles, cx));
            }
            // Empty tracks keep the last row's tiles one column wide, as a CSS grid does.
            for _ in chunk.len()..columns {
                row = row.child(div().flex_1().min_w_0());
            }
            rows.push(row.into_any_element());
        }
        let menu = self.menu.clone().and_then(|menu| tile::tile_menu(self, &menu.tile, &tiles, &theme, cx));
        div()
            .id("chat-grid")
            .debug_selector(|| "chat-grid".into())
            .relative()
            .size_full()
            .bg(theme.page)
            .pt(HEADER_HEIGHT)
            .px(px(GRID_INSET))
            .pb(px(GRID_INSET))
            .flex()
            .flex_col()
            .child(measure_pane)
            .child(
                div()
                    .id("chat-grid-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().min_h_full().flex().flex_col().gap(px(TILE_GAP)).children(rows)),
            )
            .children(menu)
            .children(self.drop.as_ref().map(|target| tile::drop_overlay(target, &theme)))
            .into_any_element()
    }
}

impl ChatGrid {
    fn tile(&mut self, key: &str, split: bool, tiles: &[String], cx: &mut Context<Self>) -> AnyElement {
        let info = self.tile_info(key);
        let focused = self.focused.as_deref() == Some(key);
        let body: AnyElement = if focused {
            self.chat.clone().into_any_element()
        } else {
            let transcript = self.transcript_for(key, &info.title.clone(), cx);
            AnyView::from(transcript).cached(StyleRefinement::default().size_full()).into_any_element()
        };
        let controls = tile::Controls {
            split,
            pinned: self.pins.iter().any(|pin| pin == key),
            menu_open: self.menu.as_ref().is_some_and(|menu| menu.tile == key),
            has_menu_rows: split && tiles.len() > 1,
        };
        let painted = self.painted.clone();
        let tile_key = key.to_string();
        let measure =
            canvas(move |bounds, _, _| painted.borrow_mut().tiles.push((tile_key.clone(), bounds)), |_, _, _, _| {}).absolute().size_full();
        tile::frame(&info, focused, controls, body, measure, cx)
    }
}
