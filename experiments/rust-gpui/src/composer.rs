//! The composer: a multi-line text input on top, the send row below.
//!
//! GPUI 0.2.2 ships no text field. This is the smallest honest one, grown from the `input` example
//! inside the gpui crate: the `Composer` entity owns the text, the selection and the IME marked
//! range and implements `EntityInputHandler`; `InputElement` shapes the text with wrapping, paints
//! it with the caret and selection, and registers the platform input handler while focused. Typed
//! characters, dead keys and IME composition reach it through that handler (`NSTextInputClient` on
//! macOS); editing keys are GPUI actions bound in the `Composer` key context.
//!
//! Enter sends (emits `ComposerEvent::Send`), Shift+Enter inserts a newline. Not built: undo, word
//! movement, double-click word selection, caret blink, drag and drop, attachments.

use std::ops::Range;

use gpui::{
    App, AvailableSpace, Bounds, ClickEvent, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, EventEmitter, FocusHandle, Focusable, FontWeight, Global, GlobalElementId, InspectorElementId, KeyBinding,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, SharedString, Style, TextAlign, TextRun,
    UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, font, point, prelude::*, px, relative, rgb, size,
};
use unicode_segmentation::UnicodeSegmentation as _;

use crate::markdown::{PROSE_LINE_HEIGHT, PROSE_SIZE, SANS};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_WINDOW, StyledText, TEXT_12, Theme};
use crate::transcript::{COLUMN_WIDTH, Glyph, glyph};

actions!(
    composer,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectAll,
        Home,
        End,
        Send,
        Newline,
        Paste,
        Copy,
        Cut,
        ShowCharacterPalette,
    ]
);

pub const PLACEHOLDER: &str = "Type @ for files, Chats and computers, / for skills";
const KEY_CONTEXT: &str = "Composer";
pub const COMPOSER_MIN_HEIGHT: f32 = 112.0;
/// The input grows to this many lines, then scrolls to keep the caret in view.
const MAX_LINES: usize = 8;
/// Claude's brand colour, the model chip's dot.
const CLAUDE_DOT: u32 = 0xd97757;

pub enum ComposerEvent {
    Send(SharedString),
}

pub struct Composer {
    focus_handle: FocusHandle,
    content: String,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    layout: Option<InputLayout>,
    is_selecting: bool,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

struct ComposerKeys;
impl Global for ComposerKeys {}

/// Binds the editing keys once per app, scoped to the composer's key context.
pub fn bind_keys(cx: &mut App) {
    if cx.has_global::<ComposerKeys>() {
        return;
    }
    cx.set_global(ComposerKeys);
    let context = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("cmd-a", SelectAll, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("cmd-left", Home, context),
        KeyBinding::new("cmd-right", End, context),
        KeyBinding::new("enter", Send, context),
        KeyBinding::new("shift-enter", Newline, context),
        KeyBinding::new("cmd-v", Paste, context),
        KeyBinding::new("cmd-c", Copy, context),
        KeyBinding::new("cmd-x", Cut, context),
        KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, context),
    ]);
}

impl Composer {
    /// Empty, unless `MILAGRE_GPUI_COMPOSER_TEXT` prefills it (`\n` for a newline) so a snapshot can
    /// show wrapping, the caret and a selection without anyone typing. `MILAGRE_GPUI_COMPOSER_SELECT`
    /// (`start..end` in bytes) selects part of it.
    pub fn new(cx: &mut Context<Self>) -> Self {
        bind_keys(cx);
        let content = std::env::var("MILAGRE_GPUI_COMPOSER_TEXT").map(|text| text.replace("\\n", "\n")).unwrap_or_default();
        let end = content.len();
        let selected_range = std::env::var("MILAGRE_GPUI_COMPOSER_SELECT")
            .ok()
            .and_then(|range| {
                let (start, stop) = range.split_once("..")?;
                Some(start.parse::<usize>().ok()?.min(end)..stop.parse::<usize>().ok()?.min(end))
            })
            .filter(|range| range.start <= range.end && content.is_char_boundary(range.start) && content.is_char_boundary(range.end))
            .unwrap_or(end..end);
        Self {
            focus_handle: cx.focus_handle(),
            content,
            selected_range,
            selection_reversed: false,
            marked_range: None,
            layout: None,
            is_selecting: false,
        }
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn selected_range(&self) -> Range<usize> {
        self.selected_range.clone()
    }

    pub fn marked_range(&self) -> Option<Range<usize>> {
        self.marked_range.clone()
    }

    fn cursor(&self) -> usize {
        if self.selection_reversed { self.selected_range.start } else { self.selected_range.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).rev().find_map(|(ix, _)| (ix < offset).then_some(ix)).unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).find_map(|(ix, _)| (ix > offset).then_some(ix)).unwrap_or(self.content.len())
    }

    /// The offset one visual line above or below the caret, at the same x; the text's start or end
    /// past the first or last line.
    fn vertical(&self, down: bool) -> usize {
        let Some(layout) = self.layout.as_ref().filter(|l| !l.placeholder) else {
            return if down { self.content.len() } else { 0 };
        };
        let caret = layout.position(self.cursor());
        let y = if down { caret.y + layout.line_height * 1.5 } else { caret.y - layout.line_height * 0.5 };
        if y < px(0.0) {
            0
        } else if y >= layout.content_height() {
            self.content.len()
        } else {
            layout.offset_for(point(caret.x, y))
        }
    }

    fn line_start(&self) -> usize {
        self.content[..self.cursor()].rfind('\n').map_or(0, |ix| ix + 1)
    }

    fn line_end(&self) -> usize {
        let cursor = self.cursor();
        self.content[cursor..].find('\n').map_or(self.content.len(), |ix| cursor + ix)
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selected_range.is_empty() { self.previous_boundary(self.cursor()) } else { self.selected_range.start };
        self.move_to(target, cx);
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selected_range.is_empty() { self.next_boundary(self.cursor()) } else { self.selected_range.end };
        self.move_to(target, cx);
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(false);
        self.move_to(target, cx);
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(true);
        self.move_to(target, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor()), cx);
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.vertical(false), cx);
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.vertical(true), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_start(), cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_end(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", window, cx);
    }

    fn send(&mut self, _: &Send, _: &mut Window, cx: &mut Context<Self>) {
        self.submit(cx);
    }

    /// Emits the text as a message and clears the input. Blank text is not sent.
    pub fn submit(&mut self, cx: &mut Context<Self>) {
        let text = self.content.trim();
        if text.is_empty() {
            return;
        }
        cx.emit(ComposerEvent::Send(text.to_string().into()));
        self.content.clear();
        self.marked_range = None;
        self.move_to(0, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\r\n", "\n"), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn show_character_palette(&mut self, _: &ShowCharacterPalette, window: &mut Window, _: &mut Context<Self>) {
        window.show_character_palette();
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus_handle);
        self.is_selecting = true;
        let offset = self.offset_for_window_point(event.position);
        if event.modifiers.shift { self.select_to(offset, cx) } else { self.move_to(offset, cx) }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.offset_for_window_point(event.position), cx);
        }
    }

    fn offset_for_window_point(&self, position: Point<Pixels>) -> usize {
        match self.layout.as_ref().filter(|l| !l.placeholder) {
            Some(layout) => layout.offset_for(layout.to_content(position)),
            None => 0,
        }
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        utf16_to_utf8(&self.content, offset)
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        let mut utf8 = 0;
        for ch in self.content.chars() {
            if utf8 >= offset {
                break;
            }
            utf8 += ch.len_utf8();
            utf16 += ch.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }

    /// What the input shows, as text and runs: the content (marked text underlined), or the
    /// placeholder in `ink-3` when empty.
    fn display(&self, theme: &Theme) -> (SharedString, Vec<TextRun>, bool) {
        let run = |len: usize, color: gpui::Rgba| TextRun {
            len,
            font: font(SANS),
            color: color.into(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        if self.content.is_empty() {
            return (PLACEHOLDER.into(), vec![run(PLACEHOLDER.len(), theme.ink3)], true);
        }
        let len = self.content.len();
        let runs = match &self.marked_range {
            Some(marked) => {
                let underline = UnderlineStyle { thickness: px(1.0), color: Some(theme.ink.into()), wavy: false };
                vec![
                    run(marked.start, theme.ink),
                    TextRun { underline: Some(underline), ..run(marked.len(), theme.ink) },
                    run(len - marked.end, theme.ink),
                ]
                .into_iter()
                .filter(|run| run.len > 0)
                .collect()
            }
            None => vec![run(len, theme.ink)],
        };
        (self.content.clone().into(), runs, false)
    }
}

impl EntityInputHandler for Composer {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(&mut self, _ignore_disabled_input: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected_range), reversed: self.selection_reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(&mut self, range_utf16: Option<Range<usize>>, new_text: &str, _: &mut Window, cx: &mut Context<Self>) {
        let range =
            range_utf16.as_ref().map(|r| self.range_from_utf16(r)).or(self.marked_range.clone()).unwrap_or(self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        let caret = range.start + new_text.len();
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range =
            range_utf16.as_ref().map(|r| self.range_from_utf16(r)).or(self.marked_range.clone()).unwrap_or(self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        self.marked_range = (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        // The new selection is relative to the inserted text, in UTF-16 of that text.
        self.selected_range = new_selected_range_utf16
            .map(|sel| range.start + utf16_to_utf8(new_text, sel.start)..range.start + utf16_to_utf8(new_text, sel.end))
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        self.selection_reversed = false;
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let start = layout.to_window(layout.position(range.start));
        let end = layout.to_window(layout.position(range.end));
        Some(Bounds::from_corners(start, point(end.x.max(start.x), end.y + layout.line_height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let layout = self.layout.as_ref().filter(|l| !l.placeholder)?;
        let offset = layout.offset_for(layout.to_content(point));
        Some(self.offset_to_utf16(offset))
    }
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .id("composer")
            .debug_selector(|| "composer".into())
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::show_character_palette))
            .flex()
            .flex_col()
            .w_full()
            .max_w(px(COLUMN_WIDTH))
            .min_h(px(COMPOSER_MIN_HEIGHT))
            .rounded(RADIUS_WINDOW)
            .bg(theme.surface)
            .border_1()
            .border_color(theme.line)
            .child(
                div()
                    .id("composer-input")
                    .debug_selector(|| "composer-input".into())
                    .flex_1()
                    .px(px(14.0))
                    .pt(px(12.0))
                    .pb(px(4.0))
                    .cursor(CursorStyle::IBeam)
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .child(InputElement { input: cx.entity() }),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .h(CONTROL_SM)
                    .mx(px(8.0))
                    .mb(px(8.0))
                    .child(icon_button("composer-attach", Glyph::Attach, &theme))
                    .child(div().flex_1())
                    .child(chip(&theme).child("Ask"))
                    .child(
                        chip(&theme)
                            .gap(px(6.0))
                            .child(div().flex_none().size(px(8.0)).rounded_full().bg(rgb(CLAUDE_DOT)))
                            .child("Opus 5.5 · Medium"),
                    )
                    .child(icon_button("composer-mic", Glyph::Mic, &theme))
                    .child(
                        div()
                            .id("composer-send")
                            .debug_selector(|| "composer-send".into())
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(CONTROL_SM)
                            .rounded_full()
                            .bg(theme.ink)
                            .cursor_pointer()
                            .hover(|style| style.opacity(0.9))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.submit(cx)))
                            .child(glyph(Glyph::Send, 16.0, theme.on_ink)),
                    ),
            )
    }
}

/// The UTF-8 byte offset of the first `utf16` UTF-16 code units of `text` (the platform IME counts
/// in UTF-16; Rust strings index in UTF-8).
fn utf16_to_utf8(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    let mut bytes = 0;
    for ch in text.chars() {
        if units >= utf16 {
            break;
        }
        units += ch.len_utf16();
        bytes += ch.len_utf8();
    }
    bytes
}

/// A composer trigger chip: 28 high, fully round, 12 medium `ink-2`, `hover` on hover.
fn chip(theme: &Theme) -> gpui::Div {
    let hover = theme.hover;
    div()
        .flex()
        .flex_none()
        .items_center()
        .h(CONTROL_SM)
        .px(px(10.0))
        .rounded_full()
        .text_step(TEXT_12)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink2)
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
}

fn icon_button(id: &'static str, kind: Glyph, theme: &Theme) -> impl IntoElement + use<> {
    let hover = theme.hover;
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(CONTROL_SM)
        .rounded_full()
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(glyph(kind, 16.0, theme.ink3))
}

/// Where the shaped input sits and how offsets map to points. Kept on the entity after paint so
/// mouse hits, up/down and the IME's candidate window can use it.
#[derive(Clone)]
struct InputLayout {
    lines: Vec<WrappedLine>,
    /// Byte offset where each hard line (between `\n`s) starts.
    starts: Vec<usize>,
    /// Top of each hard line, from the top of the text.
    tops: Vec<Pixels>,
    line_height: Pixels,
    bounds: Bounds<Pixels>,
    /// How far the text is scrolled up to keep the caret visible past `MAX_LINES`.
    scroll: Pixels,
    placeholder: bool,
}

impl InputLayout {
    fn new(lines: Vec<WrappedLine>, line_height: Pixels, bounds: Bounds<Pixels>, placeholder: bool) -> Self {
        let mut starts = Vec::with_capacity(lines.len());
        let mut tops = Vec::with_capacity(lines.len());
        let (mut start, mut top) = (0, px(0.0));
        for line in &lines {
            starts.push(start);
            tops.push(top);
            start += line.len() + 1;
            top += line_height * rows(line).len() as f32;
        }
        Self { lines, starts, tops, line_height, bounds, scroll: px(0.0), placeholder }
    }

    fn content_height(&self) -> Pixels {
        let rows: usize = self.lines.iter().map(|line| rows(line).len()).sum();
        self.line_height * rows.max(1) as f32
    }

    fn to_content(&self, window_point: Point<Pixels>) -> Point<Pixels> {
        window_point - self.bounds.origin + point(px(0.0), self.scroll)
    }

    fn to_window(&self, content_point: Point<Pixels>) -> Point<Pixels> {
        content_point + self.bounds.origin - point(px(0.0), self.scroll)
    }

    /// Top-left of the caret at `offset`, in content coordinates.
    fn position(&self, offset: usize) -> Point<Pixels> {
        let Some(h) = self.starts.iter().rposition(|&start| start <= offset) else { return point(px(0.0), px(0.0)) };
        let line = &self.lines[h];
        let local = (offset - self.starts[h]).min(line.len());
        let rows = rows(line);
        let r = rows.iter().rposition(|&start| start <= local).unwrap_or(0);
        let layout = &line.unwrapped_layout;
        point(layout.x_for_index(local) - layout.x_for_index(rows[r]), self.tops[h] + self.line_height * r as f32)
    }

    /// The offset nearest a point in content coordinates.
    fn offset_for(&self, p: Point<Pixels>) -> usize {
        let Some(h) = self.tops.iter().rposition(|&top| top <= p.y).or((!self.lines.is_empty()).then_some(0)) else { return 0 };
        let line = &self.lines[h];
        let rows = rows(line);
        let r = (((p.y - self.tops[h]) / self.line_height).floor().max(0.0) as usize).min(rows.len() - 1);
        let (row_start, row_end) = (rows[r], rows.get(r + 1).copied().unwrap_or(line.len()));
        let layout = &line.unwrapped_layout;
        let x = p.x.max(px(0.0)) + layout.x_for_index(row_start);
        self.starts[h] + layout.closest_index_for_x(x).clamp(row_start, row_end)
    }

    /// One rectangle per visual row the selection touches, in content coordinates.
    fn selection_rects(&self, selection: &Range<usize>) -> Vec<Bounds<Pixels>> {
        let mut rects = Vec::new();
        for (h, line) in self.lines.iter().enumerate() {
            let rows = rows(line);
            let layout = &line.unwrapped_layout;
            for (r, &row_start) in rows.iter().enumerate() {
                let row_end = rows.get(r + 1).copied().unwrap_or(line.len());
                let start = selection.start.max(self.starts[h] + row_start);
                let end = selection.end.min(self.starts[h] + row_end);
                if start >= end {
                    continue;
                }
                let x0 = layout.x_for_index(row_start);
                let left = layout.x_for_index(start - self.starts[h]) - x0;
                let right = layout.x_for_index(end - self.starts[h]) - x0;
                let top = self.tops[h] + self.line_height * r as f32;
                rects.push(Bounds::from_corners(point(left, top), point(right, top + self.line_height)));
            }
        }
        rects
    }
}

/// Byte offsets (within the hard line) where each visual row starts.
fn rows(line: &WrappedLine) -> Vec<usize> {
    let layout = &line.unwrapped_layout;
    std::iter::once(0).chain(line.wrap_boundaries().iter().map(|b| layout.runs[b.run_ix].glyphs[b.glyph_ix].index)).collect()
}

struct InputElement {
    input: Entity<Composer>,
}

struct InputPrepaint {
    layout: InputLayout,
    selections: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
}

impl IntoElement for InputElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

fn shape(text: SharedString, runs: &[TextRun], width: Pixels, window: &mut Window) -> Vec<WrappedLine> {
    window.text_system().shape_text(text, px(PROSE_SIZE), runs, Some(width), None).map(|lines| lines.into_vec()).unwrap_or_default()
}

impl Element for InputElement {
    type RequestLayoutState = ();
    type PrepaintState = InputPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let (text, runs, _) = self.input.read(cx).display(cx.theme());
        let line_height = px(PROSE_LINE_HEIGHT);
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        let layout_id = window.request_measured_layout(style, move |known, available, window, _cx| {
            let width = known.width.or(match available.width {
                AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            let Some(width) = width else { return size(px(0.0), line_height) };
            let rows: usize = shape(text.clone(), &runs, width, window).iter().map(|line| rows(line).len()).sum();
            size(width, line_height * rows.clamp(1, MAX_LINES) as f32)
        });
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> InputPrepaint {
        let theme = *cx.theme();
        let input = self.input.read(cx);
        let (text, runs, placeholder) = input.display(&theme);
        let selection = input.selected_range.clone();
        let cursor = input.cursor();
        let lines = shape(text, &runs, bounds.size.width, window);
        let mut layout = InputLayout::new(lines, px(PROSE_LINE_HEIGHT), bounds, placeholder);

        let caret = if placeholder { point(px(0.0), px(0.0)) } else { layout.position(cursor) };
        layout.scroll = (caret.y + layout.line_height - bounds.size.height).max(px(0.0));
        let selections = if placeholder {
            Vec::new()
        } else {
            layout
                .selection_rects(&selection)
                .into_iter()
                .map(|rect| fill(Bounds::new(layout.to_window(rect.origin), rect.size), theme.accent_tint))
                .collect()
        };
        let caret =
            selection.is_empty().then(|| fill(Bounds::new(layout.to_window(caret), size(px(2.0), layout.line_height)), theme.accent));
        InputPrepaint { layout, selections, caret }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut InputPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let layout = prepaint.layout.clone();
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for selection in prepaint.selections.drain(..) {
                window.paint_quad(selection);
            }
            for (line, &top) in layout.lines.iter().zip(&layout.tops) {
                let origin = layout.to_window(point(px(0.0), top));
                line.paint(origin, layout.line_height, TextAlign::Left, None, window, cx).ok();
            }
            if focus_handle.is_focused(window)
                && let Some(caret) = prepaint.caret.take()
            {
                window.paint_quad(caret);
            }
        });
        self.input.update(cx, |input, _| input.layout = Some(layout));
    }
}
