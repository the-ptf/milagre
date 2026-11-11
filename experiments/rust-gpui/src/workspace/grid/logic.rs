//! The grid's and the split's rules, pure: `lib/chat-grid.ts`, `lib/grid-drop.ts` and `lib/subchat-split.ts`.
//! `logic_tests.rs` checks them against values the TypeScript gave when run through node.

use std::collections::HashSet;

/// How the Chat view shows Chats: the open one alone, every active one side by side (`Grid`), or only the ones put
/// beside it (`Split`). `ChatLayout` in `chat-grid.ts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChatLayout {
    #[default]
    Single,
    Grid,
    Split,
}

impl ChatLayout {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatLayout::Single => "single",
            ChatLayout::Grid => "grid",
            ChatLayout::Split => "split",
        }
    }
}

/// Where the desktop keeps these on one Mac (`localStorage`); the port's window state stands in for it.
pub trait Storage {
    fn get_item(&self, key: &str) -> Option<String>;
    fn set_item(&mut self, key: &str, value: String);
}

impl Storage for std::collections::HashMap<String, String> {
    fn get_item(&self, key: &str) -> Option<String> {
        self.get(key).cloned()
    }

    fn set_item(&mut self, key: &str, value: String) {
        self.insert(key.to_string(), value);
    }
}

const LAYOUT_KEY: &str = "milagre.chatLayout";
const PINS_KEY: &str = "milagre.chatGridPins";
/// Bumped from "milagre.chatSplit" when a split stopped following focus (see `grid-drop.ts`).
const SPLIT_KEY: &str = "milagre.chatSplit2";

pub fn read_chat_layout(storage: &impl Storage) -> ChatLayout {
    match storage.get_item(LAYOUT_KEY).as_deref() {
        Some("grid") => ChatLayout::Grid,
        Some("split") => ChatLayout::Split,
        _ => ChatLayout::Single,
    }
}

pub fn save_chat_layout(storage: &mut impl Storage, layout: ChatLayout) {
    storage.set_item(LAYOUT_KEY, layout.as_str().to_string());
}

fn read_keys(storage: &impl Storage, name: &str) -> Vec<String> {
    let raw = storage.get_item(name).unwrap_or_else(|| "[]".into());
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Array(items)) => items.into_iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

fn write_keys<'a>(storage: &mut impl Storage, name: &str, keys: impl IntoIterator<Item = &'a str>) {
    let keys: Vec<&str> = keys.into_iter().collect();
    storage.set_item(name, serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into()));
}

/// The Chats kept in the grid on this Mac, whether or not they are active.
pub fn read_grid_pins(storage: &impl Storage) -> Vec<String> {
    read_keys(storage, PINS_KEY)
}

pub fn save_grid_pins(storage: &mut impl Storage, pins: &[String]) {
    write_keys(storage, PINS_KEY, pins.iter().map(String::as_str));
}

/// The Chats of the split view on this Mac, in order.
pub fn read_split_chats(storage: &impl Storage) -> Vec<String> {
    read_keys(storage, SPLIT_KEY)
}

/// A new Chat's draft tile is left out: it has no Chat to come back to.
pub fn save_split_chats(storage: &mut impl Storage, keys: &[String]) {
    write_keys(storage, SPLIT_KEY, keys.iter().map(String::as_str).filter(|key| !is_draft_tile_key(key)));
}

/// What `activeChatKeys` reads about one Chat's session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionInfo {
    pub key: String,
    pub unread: bool,
    pub archived: bool,
    /// A Routine's Run Chat kept out of the lists (`routine.hidden`).
    pub hidden_run: bool,
}

/// One live run: its Chat and whether it waits on an approval or a question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunInfo {
    pub key: String,
    pub waiting: bool,
}

/// Keys of the Chats the grid shows besides the focused one: a turn running, waiting or asking, a Delegation working
/// there, or a finished turn not read yet. Named Links' Chats stay out, and so do hidden Run Chats except while their
/// run waits on the user. Order: runs, then Delegation targets, then unread sessions, each key once.
pub fn active_chat_keys(runs: &[RunInfo], delegations: &[Option<String>], sessions: &[SessionInfo]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let add = |key: &str, keys: &mut Vec<String>| {
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    };
    for run in runs {
        add(&run.key, &mut keys);
    }
    for key in delegations.iter().flatten() {
        add(key, &mut keys);
    }
    for session in sessions {
        if session.unread && !session.archived {
            add(&session.key, &mut keys);
        }
    }
    let waiting = |key: &str| runs.iter().any(|run| run.key == key && run.waiting);
    let hidden = |key: &str| sessions.iter().rev().find(|s| s.key == key).is_some_and(|s| s.hidden_run && !waiting(key));
    keys.into_iter().filter(|key| !key.starts_with("milagre-link:") && !hidden(key)).collect()
}

/// The focused tile's key while the window shows a new Chat not saved yet: Chat ids start at 1.
pub fn draft_tile_key(project_path: &str) -> String {
    format!("{project_path}#0")
}

pub fn is_draft_tile_key(key: &str) -> bool {
    key.ends_with("#0")
}

/// The grid's tiles in order. A Chat keeps its slot while it stays active or focused, so a status change never moves
/// a tile; new ones join at the end, except a new Chat's first save, which takes its draft tile's slot. `None` when
/// nothing changed (the TypeScript returns `previous` itself).
pub fn grid_chats(previous: &[String], active: &[String], focused: Option<&str>) -> Option<Vec<String>> {
    // `wanted` keeps the Set's insertion order: active first, then the focused one.
    let mut wanted: Vec<&str> = Vec::new();
    for key in active.iter().map(String::as_str).chain(focused) {
        if !wanted.contains(&key) {
            wanted.push(key);
        }
    }
    let is_wanted = |key: &str| wanted.contains(&key);
    let draft = previous.iter().position(|key| is_draft_tile_key(key) && !is_wanted(key));
    let focused_new = focused.filter(|focused| !previous.iter().any(|key| key == focused));
    let mut kept: Vec<String> = Vec::new();
    for (index, key) in previous.iter().enumerate() {
        if is_wanted(key) {
            kept.push(key.clone());
        } else if Some(index) == draft
            && let Some(focused) = focused_new
        {
            kept.push(focused.to_string());
        }
    }
    let seen: HashSet<String> = kept.iter().cloned().collect();
    let next: Vec<String> =
        kept.iter().cloned().chain(wanted.iter().filter(|key| !seen.contains(**key)).map(|key| key.to_string())).collect();
    if next.as_slice() == previous { None } else { Some(next) }
}

/// A box in window coordinates (the TypeScript's `{ left, top, width, height }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

/// The insertion bar of a drop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bar {
    pub left: f32,
    pub top: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Before,
    After,
}

/// Where a Chat dragged out of the sidebar lands: before or after a grid tile, or beside the one Chat on screen
/// (`tile` `None`), which turns the view into a grid of the two.
#[derive(Clone, Debug, PartialEq)]
pub struct GridDropTarget {
    pub tile: Option<String>,
    pub side: Side,
    pub area: Area,
    pub bar: Bar,
}

impl GridDropTarget {
    /// The chip's words (`GridDropOverlay`).
    pub fn label(&self) -> &'static str {
        match (&self.tile, self.side) {
            (None, _) => "Open beside",
            (Some(_), Side::Before) => "Add before",
            (Some(_), Side::After) => "Add after",
        }
    }
}

/// Which side of a box a point is on, the half it would take and the bar at that edge.
pub fn drop_side(area: Area, x: f32, gap: f32) -> (Side, Area, Bar) {
    let before = x < area.left + area.width / 2.0;
    let half = area.width / 2.0;
    let side = if before { Side::Before } else { Side::After };
    let taken = Area { left: if before { area.left } else { area.left + half }, top: area.top, width: half, height: area.height };
    let bar = Bar {
        left: if before { area.left - gap / 2.0 - 2.0 } else { area.left + area.width + gap / 2.0 - 2.0 },
        top: area.top + 16.0,
        height: (area.height - 32.0).max(0.0),
    };
    (side, taken, bar)
}

/// The tiles after a drop puts `key` before or after `tile`, or beside `focused` when the view had no tiles yet.
pub fn place_dropped(tiles: &[String], key: &str, tile: Option<&str>, side: Side, focused: Option<&str>) -> Vec<String> {
    let anchor = tile.or(focused);
    let base: Vec<String> =
        if !tiles.is_empty() { tiles.to_vec() } else { focused.map(|focused| vec![focused.to_string()]).unwrap_or_default() };
    let mut rest: Vec<String> = base.into_iter().filter(|item| item != key).collect();
    match anchor.and_then(|anchor| rest.iter().position(|item| item == anchor)) {
        None => rest.push(key.to_string()),
        Some(at) => rest.insert(if side == Side::Before { at } else { at + 1 }, key.to_string()),
    }
    rest
}

/// "Open beside parent": the parent first, then the open Chat.
pub fn beside_parent(parent: &str, open: &str) -> Vec<String> {
    vec![parent.to_string(), open.to_string()]
}

/// "Show all N side by side": the family's Chats in order, always including the focused one, Done or not.
pub fn family_split(root: &str, children: &[String], focused: Option<&str>) -> Vec<String> {
    let mut keys: Vec<String> = std::iter::once(root.to_string()).chain(children.iter().cloned()).collect();
    if let Some(focused) = focused
        && !keys.iter().any(|key| key == focused)
    {
        keys.push(focused.to_string());
    }
    keys
}

/// The split after a tile's menu swaps `tile` for `next`; `None` (unchanged) when `next` is on screen already or
/// `tile` isn't.
pub fn swap_tile(split: &[String], tile: &str, next: &str) -> Option<Vec<String>> {
    if split.iter().any(|key| key == next) || !split.iter().any(|key| key == tile) {
        return None;
    }
    Some(split.iter().map(|key| if key == tile { next.to_string() } else { key.clone() }).collect())
}

/// The grid's tracks for `count` tiles in a box `width` wide: CSS `repeat(auto-fit, minmax(440px, 1fr))` with a
/// 12px gap. auto-fit collapses empty tracks, so there are never more columns than tiles.
pub fn grid_columns(width: f32, count: usize, min: f32, gap: f32) -> usize {
    if count == 0 {
        return 0;
    }
    let fit = ((width + gap) / (min + gap)).floor().max(1.0) as usize;
    fit.min(count)
}

/// Each row's height for `rows` rows in a box `height` tall: `auto-rows: minmax(320px, 1fr)` with the gap.
pub fn grid_row_height(height: f32, rows: usize, min: f32, gap: f32) -> f32 {
    if rows == 0 {
        return min;
    }
    ((height - gap * (rows as f32 - 1.0)) / rows as f32).max(min)
}
