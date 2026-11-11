//! The grid painter: what the visible rows hold ([`build_frame`], plain data read under the emulator's lock), and
//! the element that paints it ([`TerminalGrid`]): merged background rects, the selection, one shaped line per row
//! and the cursor.
//!
//! Glyph runs are cached by row content: a row is shaped only when no row of the last frame had the same text and
//! styles (its hash), so typing reshapes one line and a wheel scroll reshapes only the lines that came into view. Every glyph is placed on the cell grid (`shape_line`'s
//! `force_width`), so fallback fonts and wide characters cannot push a column out of place.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point as GridPoint};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::CursorShape;
use gpui::{
    App, BorderStyle, Bounds, Element, ElementId, Entity, Font, FontStyle, FontWeight, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, ShapedLine, SharedString, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle, Window,
    fill, font, outline, point, px, relative, size,
};

use super::colors::Palette;
use super::session::{GridSize, Listener};
use super::view::TerminalView;
use crate::theme::{CODE_TEXT, mono};

/// The Code size plus half a pixel, as xterm ran (`codeFontSize` in `terminal-sessions.ts`).
pub const FONT_SIZE: f32 = CODE_TEXT.size + 0.5;
/// xterm's `lineHeight: 1.2`.
pub const LINE_HEIGHT_RATIO: f32 = 1.2;
/// A beam or underline cursor's thickness.
const BAR: Pixels = px(2.0);

/// One run of cells that share a style.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    /// Bytes of the row's text.
    pub len: usize,
    pub fg: Hsla,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
}

impl Run {
    fn same_style(&self, other: &Run) -> bool {
        self.fg == other.fg
            && self.bold == other.bold
            && self.italic == other.italic
            && self.underline == other.underline
            && self.strike == other.strike
    }
}

/// One visible row: its text (one char per cell, trailing blanks dropped) and style runs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub text: String,
    pub runs: Vec<Run>,
    pub hash: u64,
}

/// A span of cells on one row: a background, or part of the selection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
    pub line: usize,
    pub col: usize,
    pub cols: usize,
    pub color: Hsla,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorPaint {
    pub shape: CursorShape,
    pub line: usize,
    pub col: usize,
    pub cols: usize,
    pub color: Hsla,
}

/// Everything one frame paints, in cells.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Frame {
    pub rows: Vec<Row>,
    pub backgrounds: Vec<Span>,
    pub selection: Vec<Span>,
    pub cursor: Option<CursorPaint>,
    pub display_offset: usize,
}

/// Reads the visible rows of `term`. `focused` draws a solid block cursor (its glyph in the cursor accent);
/// otherwise a hollow one, as xterm does.
pub fn build_frame<T: alacritty_terminal::event::EventListener>(term: &Term<T>, palette: &Palette, focused: bool) -> Frame {
    let content = term.renderable_content();
    let lines = term.screen_lines();
    let offset = content.display_offset;
    let overrides = content.colors;
    let selection = content.selection;
    let cursor = content.cursor;
    let cursor_line = cursor.point.line.0 + offset as i32;
    let block_here = focused && cursor.shape == CursorShape::Block;

    let mut frame = Frame { rows: vec![Row::default(); lines], display_offset: offset, ..Frame::default() };
    let mut cursor_cols = 1;
    for indexed in content.display_iter {
        let viewport = indexed.point.line.0 + offset as i32;
        if viewport < 0 || viewport as usize >= lines {
            continue;
        }
        let line = viewport as usize;
        let col = indexed.point.column.0;
        let cell = indexed.cell;
        let is_cursor = viewport == cursor_line && col == cursor.point.column.0;
        if is_cursor && cell.flags.contains(Flags::WIDE_CHAR) {
            cursor_cols = 2;
        }
        let colors = palette.cell(cell, overrides);
        let fg = if is_cursor && block_here { palette.cursor_accent.into() } else { colors.fg };
        if let Some(bg) = colors.bg {
            push_span(&mut frame.backgrounds, line, col, bg);
        }
        if selection.is_some_and(|range| range.contains(indexed.point)) {
            push_span(&mut frame.selection, line, col, palette.selection.into());
        }

        let row = &mut frame.rows[line];
        let start = row.text.len();
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) || cell.c == '\0' {
            row.text.push(' ');
        } else {
            row.text.push(cell.c);
            if let Some(zerowidth) = cell.zerowidth() {
                row.text.extend(zerowidth.iter());
            }
        }
        let run = Run {
            len: row.text.len() - start,
            fg,
            bold: cell.flags.contains(Flags::BOLD),
            italic: cell.flags.contains(Flags::ITALIC),
            underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
            strike: cell.flags.contains(Flags::STRIKEOUT),
        };
        match row.runs.last_mut() {
            Some(last) if last.same_style(&run) => last.len += run.len,
            _ => row.runs.push(run),
        }
    }
    for row in &mut frame.rows {
        trim_trailing_blanks(row);
        row.hash = row_hash(row);
    }
    if cursor.shape != CursorShape::Hidden && cursor_line >= 0 && (cursor_line as usize) < lines {
        let shape = if focused { cursor.shape } else { CursorShape::HollowBlock };
        frame.cursor = Some(CursorPaint {
            shape,
            line: cursor_line as usize,
            col: cursor.point.column.0,
            cols: cursor_cols,
            color: palette.cursor.into(),
        });
    }
    frame
}

fn push_span(spans: &mut Vec<Span>, line: usize, col: usize, color: Hsla) {
    match spans.last_mut() {
        Some(last) if last.line == line && last.col + last.cols == col && last.color == color => last.cols += 1,
        _ => spans.push(Span { line, col, cols: 1, color }),
    }
}

/// Blank cells at the end of a row draw nothing: drop them so a mostly empty screen shapes almost nothing.
fn trim_trailing_blanks(row: &mut Row) {
    while row.text.ends_with(' ') {
        let Some(last) = row.runs.last_mut() else { break };
        if last.underline || last.strike {
            break;
        }
        row.text.pop();
        last.len -= 1;
        if last.len == 0 {
            row.runs.pop();
        }
    }
}

fn row_hash(row: &Row) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    row.text.hash(&mut hasher);
    for run in &row.runs {
        (run.len, run.bold, run.italic, run.underline, run.strike).hash(&mut hasher);
        for part in [run.fg.h, run.fg.s, run.fg.l, run.fg.a] {
            part.to_bits().hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// The text of the cells in `start..=end` (viewport rows, inclusive columns), for tests and the bench.
pub fn grid_text<T>(term: &Term<T>, line: i32, cols: std::ops::RangeInclusive<usize>) -> String {
    term.bounds_to_string(GridPoint::new(Line(line), Column(*cols.start())), GridPoint::new(Line(line), Column(*cols.end())))
}

/// Cell size and font for the grid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    pub font_size: Pixels,
    pub cell_width: Pixels,
    pub line_height: Pixels,
}

impl Metrics {
    pub fn measure(window: &Window) -> Self {
        let font_size = px(FONT_SIZE);
        let text = window.text_system();
        let id = text.resolve_font(&font(mono()));
        let cell_width = text.advance(id, font_size, 'm').map(|s| s.width).unwrap_or(font_size * 0.6);
        Self { font_size, cell_width, line_height: px((FONT_SIZE * LINE_HEIGHT_RATIO).round()) }
    }

    /// How many cells fit in `bounds` (at least 2 columns and 1 line).
    pub fn grid_size(&self, bounds: Size) -> GridSize {
        let cols = (f32::from(bounds.width) / f32::from(self.cell_width)).floor().max(2.0) as usize;
        let lines = (f32::from(bounds.height) / f32::from(self.line_height)).floor().max(1.0) as usize;
        GridSize { cols, lines }
    }

    /// The cell under `position` (relative to the grid's origin), clamped to the grid, and whether the pointer is
    /// on the cell's right half.
    pub fn cell_at(&self, position: Point<Pixels>, grid: GridSize) -> (usize, usize, bool) {
        let x = f32::from(position.x).max(0.0) / f32::from(self.cell_width);
        let y = f32::from(position.y).max(0.0) / f32::from(self.line_height);
        let col = (x.floor() as usize).min(grid.cols.saturating_sub(1));
        let line = (y.floor() as usize).min(grid.lines.saturating_sub(1));
        (line, col, x.fract() >= 0.5)
    }
}

type Size = gpui::Size<Pixels>;

/// What the grid keeps between frames: its size, where it was drawn, the row cache and a few counters.
#[derive(Default)]
pub struct GridState {
    pub size: Option<GridSize>,
    pub origin: Point<Pixels>,
    pub metrics: Option<Metrics>,
    /// Last frame's shaped rows by content hash.
    cache: HashMap<u64, ShapedLine>,
    /// Frames painted.
    pub frames: usize,
    /// Rows shaped (cache misses) since the grid was made.
    pub shaped_rows: usize,
    /// Time spent reading the emulator and shaping, per frame: total and worst.
    pub prepaint_total: Duration,
    pub prepaint_max: Duration,
}

impl GridState {
    fn invalidate(&mut self) {
        self.cache.clear();
    }
}

/// The element that paints one Terminal's grid. It fills its parent.
pub struct TerminalGrid {
    pub view: Entity<TerminalView>,
    pub term: Arc<FairMutex<Term<Listener>>>,
    pub state: Rc<RefCell<GridState>>,
    pub palette: Palette,
    pub focused: bool,
}

pub struct Prepainted {
    frame: Frame,
    lines: Vec<Option<ShapedLine>>,
    metrics: Metrics,
}

impl IntoElement for TerminalGrid {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TerminalGrid {
    type RequestLayoutState = ();
    type PrepaintState = Prepainted;

    fn id(&self) -> Option<ElementId> {
        Some("terminal-grid".into())
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
        let mut style = Style::default();
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
    ) -> Prepainted {
        let started = Instant::now();
        let metrics = Metrics::measure(window);
        let grid = metrics.grid_size(bounds.size);
        let resized = {
            let mut state = self.state.borrow_mut();
            state.origin = bounds.origin;
            if state.metrics != Some(metrics) {
                state.invalidate();
                state.metrics = Some(metrics);
            }
            state.size != Some(grid)
        };
        if resized {
            // The grid reflows now; the PTY hears of it once the size holds still (`view.rs`).
            self.view.update(cx, |view, cx| view.set_grid_size(grid, metrics, cx));
            self.state.borrow_mut().size = Some(grid);
        }
        let frame = {
            let term = self.term.lock();
            build_frame(&term, &self.palette, self.focused)
        };

        let base = font(mono());
        let mut state = self.state.borrow_mut();
        let mut previous = std::mem::take(&mut state.cache);
        let mut shaped = 0;
        let mut lines = Vec::with_capacity(frame.rows.len());
        for row in &frame.rows {
            if row.text.is_empty() {
                lines.push(None);
                continue;
            }
            if let Some(line) = previous.remove(&row.hash).or_else(|| state.cache.get(&row.hash).cloned()) {
                state.cache.insert(row.hash, line.clone());
                lines.push(Some(line));
                continue;
            }
            let runs: Vec<TextRun> = row.runs.iter().map(|run| text_run(run, &base)).collect();
            let line =
                window.text_system().shape_line(SharedString::from(row.text.clone()), metrics.font_size, &runs, Some(metrics.cell_width));
            state.cache.insert(row.hash, line.clone());
            lines.push(Some(line));
            shaped += 1;
        }
        let spent = started.elapsed();
        state.shaped_rows += shaped;
        state.prepaint_total += spent;
        state.prepaint_max = state.prepaint_max.max(spent);
        Prepainted { frame, lines, metrics }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepainted: &mut Prepainted,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Prepainted { frame, lines, metrics } = prepainted;
        let origin = bounds.origin;
        let cell = |line: usize, col: usize, cols: usize| {
            Bounds::new(
                point(origin.x + metrics.cell_width * col as f32, origin.y + metrics.line_height * line as f32),
                size(metrics.cell_width * cols as f32, metrics.line_height),
            )
        };
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for span in frame.backgrounds.iter().chain(frame.selection.iter()) {
                window.paint_quad(fill(cell(span.line, span.col, span.cols), span.color));
            }
            if let Some(cursor) = frame.cursor
                && cursor.shape == CursorShape::Block
            {
                window.paint_quad(fill(cell(cursor.line, cursor.col, cursor.cols), cursor.color));
            }
            for (ix, line) in lines.iter().enumerate() {
                if let Some(line) = line {
                    let at = point(origin.x, origin.y + metrics.line_height * ix as f32);
                    let _ = line.paint(at, metrics.line_height, TextAlign::Left, None, window, cx);
                }
            }
            if let Some(cursor) = frame.cursor {
                let bounds = cell(cursor.line, cursor.col, cursor.cols);
                match cursor.shape {
                    CursorShape::Beam => window.paint_quad(fill(Bounds::new(bounds.origin, size(BAR, bounds.size.height)), cursor.color)),
                    CursorShape::Underline => window.paint_quad(fill(
                        Bounds::new(point(bounds.left(), bounds.bottom() - BAR), size(bounds.size.width, BAR)),
                        cursor.color,
                    )),
                    CursorShape::HollowBlock => window.paint_quad(outline(bounds, cursor.color, BorderStyle::Solid)),
                    CursorShape::Block | CursorShape::Hidden => {}
                }
            }
        });
        self.state.borrow_mut().frames += 1;
    }
}

fn text_run(run: &Run, base: &Font) -> TextRun {
    let mut font = base.clone();
    if run.bold {
        font.weight = FontWeight::BOLD;
    }
    if run.italic {
        font.style = FontStyle::Italic;
    }
    TextRun {
        len: run.len,
        font,
        color: run.fg,
        background_color: None,
        underline: run.underline.then_some(UnderlineStyle { thickness: px(1.0), color: Some(run.fg), wavy: false }),
        strikethrough: run.strike.then_some(StrikethroughStyle { thickness: px(1.0), color: Some(run.fg) }),
    }
}
