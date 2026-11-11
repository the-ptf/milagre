//! Where the Designs page editor puts things (`DesignPageEditor.tsx`), as pure geometry: every design of the Chat on
//! one board, one row per group as on the canvas, each artboard under its title; the fit around the floating
//! panels; zoom about a point.
//!
//! Board units are the designs' own pixels, and everything on the board scales with the zoom, the titles included
//! (the desktop scales the whole board with a CSS transform); only a group's name keeps its screen size.

use super::super::board::{Item, rows};

/// Between artboards and between rows (`GAP`).
pub const GAP: f64 = 80.0;
/// A group's name above its block, in screen px, and the block's padding (`GROUP_LABEL`, `GROUP_PADDING`).
pub const GROUP_LABEL: f64 = 30.0;
pub const GROUP_PADDING: f64 = 48.0;
/// An artboard's title row: 13px text on an 18px line, 8px above the artboard (`text-13 mb-2`).
pub const TITLE: f64 = 26.0;
pub const MIN_SCALE: f64 = 0.025;
pub const MAX_SCALE: f64 = 3.0;
pub const ZOOM_STEP: f64 = 1.25;
/// What the fit keeps clear: the tool rail (or the open Layers panel) on the left, the inspector on the right, the
/// notices above and the zoom bar below, in screen px.
pub const FIT_LEFT: f64 = 88.0;
pub const FIT_LEFT_LAYERS: f64 = 312.0;
pub const FIT_RIGHT: f64 = 280.0;
pub const FIT_TOP: f64 = 56.0;
pub const FIT_BOTTOM: f64 = 76.0;

pub fn clamp_scale(scale: f64) -> f64 {
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

/// The board's origin on screen (relative to the viewport) and its zoom; starts at `{ x: 88, y: 72, scale: 0.5 }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

impl Default for View {
    fn default() -> Self {
        Self { x: 88.0, y: 72.0, scale: 0.5 }
    }
}

impl View {
    /// `zoomAt`: keeps the board point under `(px, py)` still.
    pub fn zoom_at(self, factor: f64, px: f64, py: f64) -> View {
        let scale = clamp_scale(self.scale * factor);
        View { scale, x: px - (px - self.x) * scale / self.scale, y: py - (py - self.y) * scale / self.scale }
    }

    pub fn to_screen(self, x: f64, y: f64) -> (f64, f64) {
        (self.x + x * self.scale, self.y + y * self.scale)
    }

    pub fn to_board(self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.x) / self.scale, (y - self.y) / self.scale)
    }
}

/// One artboard: its title row's top-left and its screen's box, in board units.
#[derive(Clone, Debug, PartialEq)]
pub struct Artboard {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Artboard {
    /// The design's screen (below the title).
    pub fn screen_y(&self) -> f64 {
        self.y + TITLE
    }
}

/// A group's block and its name, in board units.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub name: Option<String>,
    pub count: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page {
    pub artboards: Vec<Artboard>,
    /// Empty unless a design has a group; then every row is one.
    pub groups: Vec<Group>,
    pub width: f64,
    pub height: f64,
}

/// The board at a zoom (a group's name is `GROUP_LABEL / scale` tall in board units).
pub fn layout(items: &[Item], scale: f64) -> Page {
    let rows = rows(items);
    let grouped = rows.iter().any(|(group, _)| group.is_some());
    let mut page = Page::default();
    let mut y = 0.0;
    for (index, (group, members)) in rows.iter().enumerate() {
        if index > 0 {
            y += GAP;
        }
        let label = if grouped { GROUP_LABEL / scale } else { 0.0 };
        let padding = if grouped { GROUP_PADDING } else { 0.0 };
        let top = y + label;
        let mut x = padding;
        let mut tallest: f64 = 0.0;
        for (i, item) in members.iter().enumerate() {
            if i > 0 {
                x += GAP;
            }
            page.artboards.push(Artboard { id: item.id.clone(), x, y: top + padding, width: item.width, height: item.height });
            x += item.width;
            tallest = tallest.max(TITLE + item.height);
        }
        let block = (x + padding, tallest + 2.0 * padding);
        if grouped {
            page.groups.push(Group { name: group.clone(), count: members.len(), x: 0.0, y: top, width: block.0, height: block.1 });
        }
        page.width = page.width.max(block.0);
        y = top + block.1;
    }
    page.height = y;
    page
}

/// `fit`: the whole board centred in the room the floating panels leave, at most 100%.
pub fn fit(items: &[Item], room: (f64, f64), scale: f64, layers_open: bool) -> Option<View> {
    let page = layout(items, scale);
    if page.width <= 0.0 || page.height <= 0.0 {
        return None;
    }
    let left = if layers_open { FIT_LEFT_LAYERS } else { FIT_LEFT };
    let width = (room.0 - left - FIT_RIGHT).max(120.0);
    let height = (room.1 - FIT_TOP - FIT_BOTTOM).max(120.0);
    let scale = clamp_scale((width / page.width).min(height / page.height).min(1.0));
    // The group names' height depends on the zoom: lay out again at the new one before centring.
    let page = layout(items, scale);
    Some(View { scale, x: left + (width - page.width * scale) / 2.0, y: FIT_TOP + (height - page.height * scale) / 2.0 })
}

/// Where the zoom bar's buttons zoom about: the middle of the room between the panels.
pub fn zoom_centre(room: (f64, f64), layers_open: bool) -> (f64, f64) {
    ((room.0 + if layers_open { FIT_LEFT_LAYERS } else { FIT_LEFT } - FIT_RIGHT) / 2.0, room.1 / 2.0)
}

/// The artboard whose screen is under a board point.
pub fn artboard_at(page: &Page, x: f64, y: f64) -> Option<&Artboard> {
    page.artboards.iter().rev().find(|a| x >= a.x && x <= a.x + a.width && y >= a.screen_y() && y <= a.screen_y() + a.height)
}
