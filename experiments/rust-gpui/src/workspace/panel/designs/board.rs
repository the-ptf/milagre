//! Where the canvas puts things (`ArtifactCanvas.tsx`), as pure geometry: one row per group, the frames in a row
//! side by side at the screen size each was made for, the fit, zoom about a point and the dot grid's step.
//!
//! Canvas units are the designs' own pixels; the view maps them to the screen as `screen = view.x + canvas *
//! view.scale`. Names and title rows keep their screen size, so in canvas units they grow as the canvas zooms out
//! (`GROUP_LABEL / scale`, `HEADER / scale`), as the desktop's counter-scaled rows do.

/// Gap between frames and between rows, in canvas px (`GAP`).
pub const GAP: f64 = 80.0;
/// The title row above each frame, in screen px (`HEADER`); a narrow frame stacks it on two rows.
pub const HEADER: f64 = 32.0;
/// A group's name above its block, in screen px (`GROUP_LABEL`).
pub const GROUP_LABEL: f64 = 30.0;
/// The block's padding around its frames, in canvas px (`GROUP_PADDING`).
pub const GROUP_PADDING: f64 = 48.0;
pub const MIN_SCALE: f64 = 0.05;
pub const MAX_SCALE: f64 = 2.0;
/// Fit leaves this much room around the designs, in screen px; more at the bottom for the zoom bar.
pub const FIT_MARGIN: f64 = 24.0;
pub const FIT_BOTTOM: f64 = 56.0;
/// The zoom bar's steps (`ArtifactDock`'s `zoomBy(1.25)`).
pub const ZOOM_STEP: f64 = 1.25;
/// A frame narrower than this on screen floats its controls (`compact`); narrower than `NARROW` it wraps them.
pub const COMPACT: f64 = 260.0;
pub const NARROW: f64 = 300.0;
/// A press must move this far, in screen px, before it pans instead of clicking.
pub const DRAG_SLOP: f64 = 4.0;

pub fn clamp_scale(scale: f64) -> f64 {
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

/// The view: where the board's origin is on screen and how far it is zoomed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

impl Default for View {
    /// Before the first fit (`useState({ x: 40, y: 40, scale: 0.4 })`).
    fn default() -> Self {
        Self { x: 40.0, y: 40.0, scale: 0.4 }
    }
}

impl View {
    /// `zoomAt`: zooms by `factor` keeping the canvas point under `(px, py)` (screen, relative to the canvas) still.
    pub fn zoom_at(self, factor: f64, px: f64, py: f64) -> View {
        let scale = clamp_scale(self.scale * factor);
        View { scale, x: px - (px - self.x) * (scale / self.scale), y: py - (py - self.y) * (scale / self.scale) }
    }

    pub fn to_screen(self, x: f64, y: f64) -> (f64, f64) {
        (self.x + x * self.scale, self.y + y * self.scale)
    }
}

/// `dotStep`: the dot grid's screen spacing, 24 canvas px doubled until the dots are at least 12 px apart.
pub fn dot_step(scale: f64) -> f64 {
    let mut step = 24.0 * scale;
    while step < 12.0 {
        step *= 2.0;
    }
    step
}

/// How a frame's title row fits at a zoom: everything on one row, controls wrapped under the title, or only the
/// number and title with the controls floating over the frame's top edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderFit {
    Row,
    Narrow,
    Compact,
}

pub fn header_fit(width: f64, scale: f64) -> HeaderFit {
    let on_screen = width * scale;
    if on_screen < COMPACT {
        HeaderFit::Compact
    } else if on_screen < NARROW {
        HeaderFit::Narrow
    } else {
        HeaderFit::Row
    }
}

/// The title row's height in screen px.
pub fn header_height(width: f64, scale: f64) -> f64 {
    if header_fit(width, scale) == HeaderFit::Narrow { HEADER * 2.0 } else { HEADER }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    fn union(rects: impl IntoIterator<Item = Rect>) -> Option<Rect> {
        rects.into_iter().reduce(|a, b| {
            let (x, y) = (a.x.min(b.x), a.y.min(b.y));
            Rect { x, y, width: a.right().max(b.right()) - x, height: a.bottom().max(b.bottom()) - y }
        })
    }
}

/// One design on the board, in canvas units: `frame` is the whole column (title row and body), `body` the screen.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameBox {
    pub id: String,
    /// Numbered across the rows from 1.
    pub number: usize,
    pub frame: Rect,
    pub body: Rect,
}

/// A group's block (`rounded-card bg-hover`) and its name above it, in canvas units.
#[derive(Clone, Debug, PartialEq)]
pub struct GroupBox {
    pub name: Option<String>,
    pub count: usize,
    /// The section: the name's row and the block.
    pub section: Rect,
    pub block: Rect,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Board {
    /// Empty until any design has a group (`grouped`); then every row is a group, the ungrouped one included.
    pub groups: Vec<GroupBox>,
    pub frames: Vec<FrameBox>,
}

/// What the board needs of a design: its id, group and screen size.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub group: Option<String>,
    pub width: f64,
    pub height: f64,
}

/// `designGroups`: one row per group in the order each first appears; designs without a group share a row where
/// the first of them appears.
pub fn rows(items: &[Item]) -> Vec<(Option<String>, Vec<&Item>)> {
    let mut rows: Vec<(Option<String>, Vec<&Item>)> = Vec::new();
    for item in items {
        let group = item.group.as_deref().map(str::trim).filter(|g| !g.is_empty()).map(str::to_string);
        match rows.iter_mut().find(|(g, _)| *g == group) {
            Some((_, members)) => members.push(item),
            None => rows.push((group, vec![item])),
        }
    }
    rows
}

/// Lays the board out at `scale`, as the desktop's flex column of rows does.
pub fn layout(items: &[Item], scale: f64) -> Board {
    let rows = rows(items);
    let grouped = rows.iter().any(|(group, _)| group.is_some());
    let mut board = Board::default();
    let mut y = 0.0;
    let mut number = 0;
    for (index, (group, members)) in rows.iter().enumerate() {
        if index > 0 {
            y += GAP;
        }
        let label = if grouped { GROUP_LABEL / scale } else { 0.0 };
        let padding = if grouped { GROUP_PADDING } else { 0.0 };
        let top = y + label + padding;
        let mut x = padding;
        let mut tallest: f64 = 0.0;
        for (offset, item) in members.iter().enumerate() {
            if offset > 0 {
                x += GAP;
            }
            number += 1;
            let header = header_height(item.width, scale) / scale;
            let frame = Rect { x, y: top, width: item.width, height: header + item.height };
            board.frames.push(FrameBox {
                id: item.id.clone(),
                number,
                frame,
                body: Rect { x, y: top + header, width: item.width, height: item.height },
            });
            tallest = tallest.max(frame.height);
            x += item.width;
        }
        let block = Rect { x: 0.0, y: y + label, width: x + padding, height: tallest + 2.0 * padding };
        if grouped {
            board.groups.push(GroupBox {
                name: group.clone(),
                count: members.len(),
                section: Rect { x: 0.0, y, width: block.width, height: label + block.height },
                block,
            });
        }
        y = block.bottom();
    }
    board
}

/// `fit`: the view that shows `id`'s frame (or every frame and group block) whole, centred, at most 100%. Title rows
/// keep their screen size, so a fit that changes the zoom measures again at the new zoom, up to three more times.
pub fn fit(items: &[Item], id: Option<&str>, room: (f64, f64), start: f64) -> Option<View> {
    let (width, height) = room;
    // Not measured yet (a tab never shown): nothing to fit to.
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let mut scale = start;
    let mut view = None;
    for _ in 0..4 {
        let board = layout(items, scale);
        let frames = board.frames.iter().filter(|f| id.is_none_or(|id| f.id == id)).map(|f| f.frame);
        let sections = board.groups.iter().filter(|_| id.is_none()).map(|g| g.section);
        let bounds = Rect::union(frames.chain(sections))?;
        let space = height - FIT_MARGIN - FIT_BOTTOM;
        let next = clamp_scale(((width - FIT_MARGIN * 2.0) / bounds.width).min(space / bounds.height).min(1.0));
        view = Some(View {
            scale: next,
            x: (width - bounds.width * next) / 2.0 - bounds.x * next,
            y: FIT_MARGIN + (space - bounds.height * next) / 2.0 - bounds.y * next,
        });
        let settled = (next - scale).abs() <= 0.005;
        scale = next;
        if settled {
            break;
        }
    }
    view
}

/// The frame under a canvas point (its title row or body), front to back.
pub fn frame_at(board: &Board, x: f64, y: f64) -> Option<&FrameBox> {
    board.frames.iter().rev().find(|f| x >= f.frame.x && x <= f.frame.right() && y >= f.frame.y && y <= f.frame.bottom())
}
