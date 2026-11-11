//! The Chat transcript: a virtualized list of variable-height items, newest at the bottom.
//!
//! `Transcript` is its own entity. It owns the items and GPUI's `ListState`, and draws through
//! `list()`, which lays out only the items in view plus an overdraw band and caches every measured
//! height in a sum tree. The list starts at the bottom (`ListAlignment::Bottom`) and stays pinned
//! there while new items arrive, unless the reader has scrolled up.
//!
//! Heights are cached, so any change to an item that is already measured must be reported with
//! `ListState::splice` (see `resolve`), or the list keeps the old height.
//!
//! `MILAGRE_GPUI_TIMING=1` prints frame and item-render numbers to stderr (see `Probe`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, ClickEvent, ClipboardItem, Context, Entity, FontWeight, ListAlignment, ListOffset, ListState, Pixels, Rgba, SharedString,
    Task, Window, canvas, div, list, prelude::*, px,
};
use gpui_base::{MarkdownExtensions, TextSelection, TextViewState, TextViewStyle};

use crate::theme::{
    ActiveTheme, Appearance, CHAT_TEXT, CODE_TEXT, CONTROL_SM, CONTROL_XS, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_12, TEXT_13, TextStepExt,
    Theme, mono,
};
use crate::ui::markdown::stream::{close_open_markdown, split_streaming_blocks};
use crate::ui::markdown::{LinkHandler, Markdown, extensions, open_with_system, plain_text_source, text_view_style};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};
use crate::workspace::chat::transcript_selection::{Keeper, SelectionTracker, SharedPainted, SharedTracker};

/// The Chat content column, centred in the Chat column.
pub const COLUMN_WIDTH: f32 = 536.0;
/// Room left under the last item for the floating pills.
pub const BOTTOM_CLEARANCE: f32 = 48.0;
/// The gap between the last item and the running row.
pub const RUNNING_GAP: f32 = 12.0;
/// Padding above the list's first item.
pub const LIST_TOP_PAD: f32 = 16.0;
const USER_MAX_WIDTH: f32 = 420.0;
const MARK_SIZE: f32 = 20.0;
const MARK_OVERLAP: f32 = 6.0;
/// Extra height laid out above and below the viewport, so scrolling does not pop items in.
const OVERDRAW: f32 = 600.0;
/// Text views kept for items this far outside the last drawn range; further ones are dropped and parsed again
/// when they come back (the desktop keeps parsed bodies in an LRU of 500 for the same reason).
const VIEW_MARGIN: usize = 150;
/// A streamed answer renders at most this often (`STREAM_RENDER_MS` in `Markdown.tsx`); the last batch always shows.
pub const STREAM_RENDER: Duration = Duration::from_millis(50);

/// One entry in the transcript.
#[derive(Clone, Debug)]
pub enum Item {
    User(SharedString),
    Activity(Activity),
    Prose(Prose),
    Tool(Tool),
    Approval(Approval),
}

/// An assistant answer: markdown source, rendered by `ui::markdown`. While `streaming`, the transcript feeds it
/// block by block (`Transcript::stream`).
#[derive(Clone, Debug)]
pub struct Prose {
    pub text: SharedString,
    pub streaming: bool,
}

impl Prose {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into(), streaming: false }
    }
}

/// A folded reply's summary: up to three marks, one line of what happened, and how long it took.
#[derive(Clone, Debug)]
pub struct Activity {
    pub marks: Vec<ToolKind>,
    pub summary: SharedString,
    pub duration: SharedString,
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub kind: ToolKind,
    pub label: SharedString,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub duration: SharedString,
}

#[derive(Clone, Debug)]
pub struct Approval {
    pub tool: Tool,
    pub command: SharedString,
    pub state: ApprovalState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    Waiting,
    Allowed,
    AlwaysAllowed,
    Denied,
}

impl ApprovalState {
    fn label(self) -> &'static str {
        match self {
            ApprovalState::Waiting => "Waiting for approval",
            ApprovalState::Allowed => "Allowed",
            ApprovalState::AlwaysAllowed => "Always allowed",
            ApprovalState::Denied => "Denied",
        }
    }
}

/// A selectable item's text views: the message, and while it streams, the block being written.
struct Views {
    main: Entity<TextViewState>,
    live: Option<Entity<TextViewState>>,
}

/// An answer being streamed: its text so far and the finished blocks its main view already holds.
#[derive(Default)]
struct Stream {
    text: String,
    shown: Vec<String>,
    last_flush: Option<Instant>,
    pending: Option<Task<()>>,
}

pub struct Transcript {
    items: Vec<Item>,
    list: ListState,
    /// Every call to `render_item`, for the "only visible items are laid out" check.
    item_renders: Rc<Cell<usize>>,
    /// Text view states created and texts handed to them (each one a parse), for the measurements.
    parses: Rc<Cell<usize>>,
    /// Room kept under the last item for the running row, which `ChatView` draws over the list's bottom
    /// edge as a view of its own (`running.rs`).
    footer: Pixels,
    probe: Option<Probe>,
    views: HashMap<usize, Views>,
    streams: HashMap<usize, Stream>,
    style: TextViewStyle,
    style_for: Appearance,
    extensions: MarkdownExtensions,
    on_link: LinkHandler,
    tracker: SharedTracker,
    painted: SharedPainted,
    /// Snapshot mode (`MILAGRE_GPUI_TRANSCRIPT_SELECT`): drag over this item once it has been drawn.
    select_on_open: Option<usize>,
}

impl Transcript {
    /// The fixture transcript: ~2,000 items, or `MILAGRE_GPUI_TRANSCRIPT_ITEMS` when set.
    pub fn new(cx: &mut Context<Self>) -> Self {
        let count = std::env::var("MILAGRE_GPUI_TRANSCRIPT_ITEMS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(crate::workspace::chat::fixture::HISTORY_ITEMS);
        let started = Instant::now();
        let items = crate::workspace::chat::fixture::transcript(count);
        let built = started.elapsed();
        let mut this = Self::with_items(items, cx);
        if std::env::var_os("MILAGRE_GPUI_TIMING").is_some() {
            eprintln!("timing: fixture of {} items built in {:.1} ms (parsed when first drawn)", this.items.len(), ms(built));
            this.probe = Some(Probe::start(cx));
        }
        // Snapshot helpers: `MILAGRE_GPUI_TRANSCRIPT_TOP=<item>` (or `rich`, the last answer with a table) opens
        // scrolled there; `MILAGRE_GPUI_TRANSCRIPT_SELECT=1` then drags a selection over that answer.
        let rich = this.items.iter().rposition(|item| matches!(item, Item::Prose(p) if p.text.contains("| Platform")));
        let top = match std::env::var("MILAGRE_GPUI_TRANSCRIPT_TOP").ok().as_deref() {
            Some("rich") => rich.map(|ix| ix.saturating_sub(1)),
            Some(value) => value.parse().ok(),
            None => None,
        };
        if let Some(ix) = top {
            this.list.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.0) });
        }
        if std::env::var_os("MILAGRE_GPUI_TRANSCRIPT_SELECT").is_some() {
            this.select_on_open = rich;
        }
        this
    }

    pub fn with_items(items: Vec<Item>, cx: &mut Context<Self>) -> Self {
        // Code colours from Milagre's Shiki buckets, on gpui-component's theme (idempotent).
        crate::ui::markdown::highlight::install(cx);
        let list = ListState::new(items.len(), ListAlignment::Bottom, px(OVERDRAW));
        let theme = *cx.theme();
        let on_link = open_with_system();
        Self {
            items,
            list,
            item_renders: Rc::new(Cell::new(0)),
            parses: Rc::new(Cell::new(0)),
            footer: px(0.0),
            probe: None,
            views: HashMap::new(),
            streams: HashMap::new(),
            style: text_view_style(&theme, CHAT_TEXT.size),
            style_for: theme.appearance,
            extensions: extensions(on_link.clone()),
            on_link,
            tracker: SharedTracker::default(),
            painted: SharedPainted::default(),
            select_on_open: None,
        }
    }

    /// Keeps room for the running row under the last item (or gives it back when the turn ends).
    pub fn set_running_row(&mut self, shown: bool, cx: &mut Context<Self>) {
        let footer = if shown { px(RUNNING_GAP) + CONTROL_XS } else { px(0.0) };
        if self.footer != footer {
            self.footer = footer;
            cx.notify();
        }
    }

    pub fn items(&self) -> &[Item] {
        &self.items
    }

    pub fn list_state(&self) -> &ListState {
        &self.list
    }

    /// How many times an item element has been built since the transcript was created.
    pub fn item_renders(&self) -> usize {
        self.item_renders.get()
    }

    /// How many texts were handed to text views (one parse each) since the transcript was created.
    pub fn parses(&self) -> usize {
        self.parses.get()
    }

    /// How many items hold text views now.
    pub fn live_views(&self) -> usize {
        self.views.len()
    }

    /// Where item `ix`'s text was drawn in the last frame the list drew it.
    pub fn drawn_text(&self, ix: usize) -> Option<gpui::Bounds<Pixels>> {
        self.painted.borrow().texts.get(&ix).copied()
    }

    /// Which items hold the ends of the selection.
    pub fn selection(&self) -> SelectionTracker {
        *self.tracker.borrow()
    }

    /// The text view of a selectable item, created if needed.
    pub fn text_view(&mut self, ix: usize, cx: &mut Context<Self>) -> Option<Entity<TextViewState>> {
        self.ensure_views(ix, cx).then(|| self.views[&ix].main.clone())
    }

    /// Appends an item at the bottom. The list stays pinned to the bottom if it was there.
    pub fn push(&mut self, item: Item, cx: &mut Context<Self>) {
        let ix = self.items.len();
        self.items.push(item);
        self.list.splice(ix..ix, 1);
        cx.notify();
    }

    /// Appends a message the user sent and scrolls to it, even if the reader had scrolled up.
    pub fn push_user(&mut self, text: SharedString, cx: &mut Context<Self>) {
        self.push(Item::User(text), cx);
        self.list.scroll_to(ListOffset { item_ix: self.items.len(), offset_in_item: px(0.0) });
    }

    /// Settles the approval at `ix`. The row changes height, so the list re-measures that item.
    pub fn resolve(&mut self, ix: usize, state: ApprovalState, cx: &mut Context<Self>) {
        if let Some(Item::Approval(approval)) = self.items.get_mut(ix)
            && approval.state == ApprovalState::Waiting
        {
            approval.state = state;
            self.list.splice(ix..ix + 1, 1);
            cx.notify();
        }
    }

    /// Starts a streamed answer at the bottom and returns its index.
    pub fn begin_stream(&mut self, cx: &mut Context<Self>) -> usize {
        let ix = self.items.len();
        self.push(Item::Prose(Prose { text: SharedString::default(), streaming: true }), cx);
        let main = cx.new(|cx| TextViewState::markdown("", cx));
        self.views.insert(ix, Views { main, live: None });
        self.streams.insert(ix, Stream::default());
        ix
    }

    /// Appends `delta` to the streamed answer at `ix`. It shows at once if the last batch showed at least
    /// [`STREAM_RENDER`] ago, else when that time is up (the batches in between join it).
    pub fn stream(&mut self, ix: usize, delta: &str, cx: &mut Context<Self>) {
        let Some(stream) = self.streams.get_mut(&ix) else { return };
        stream.text.push_str(delta);
        // The executor's clock, so tests can move time.
        let now = cx.background_executor().now();
        let since = stream.last_flush.map(|at| now.saturating_duration_since(at));
        if since.is_none_or(|since| since >= STREAM_RENDER) {
            self.flush_stream(ix, cx);
        } else if stream.pending.is_none() {
            let wait = STREAM_RENDER.saturating_sub(since.unwrap_or(Duration::ZERO));
            stream.pending = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                this.update(cx, |this, cx| this.flush_stream(ix, cx)).ok();
            }));
        }
    }

    /// Shows the streamed text: the finished blocks (`splitStreamingBlocks`) append to the message's view, so they
    /// are parsed once, and the block being written, with its open bold or code closed (`closeOpenMarkdown`), is
    /// the only text parsed again.
    fn flush_stream(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(stream) = self.streams.get_mut(&ix) else { return };
        stream.pending = None;
        stream.last_flush = Some(cx.background_executor().now());
        let mut blocks = split_streaming_blocks(&stream.text);
        let live_text = close_open_markdown(&blocks.pop().unwrap_or_default());
        let views = self.views.get_mut(&ix).expect("a streamed answer keeps its views");
        if blocks != stream.shown {
            let main = views.main.clone();
            if !stream.shown.is_empty() && blocks.starts_with(&stream.shown) {
                let added: String = blocks[stream.shown.len()..].iter().map(|block| format!("\n\n{block}")).collect();
                main.update(cx, |state, cx| state.push_str(&added, cx));
            } else {
                let text = blocks.join("\n\n");
                main.update(cx, |state, cx| state.set_text(&text, cx));
            }
            self.parses.set(self.parses.get() + 1);
            stream.shown = blocks;
        }
        if live_text.trim().is_empty() {
            views.live = None;
        } else {
            match &views.live {
                Some(live) => live.update(cx, |state, cx| state.set_text(&live_text, cx)),
                None => views.live = Some(cx.new(|cx| TextViewState::markdown(&live_text, cx))),
            }
            self.parses.set(self.parses.get() + 1);
        }
        if let Some(Item::Prose(prose)) = self.items.get_mut(ix) {
            prose.text = stream.text.clone().into();
        }
        self.list.splice(ix..ix + 1, 1);
        cx.notify();
    }

    /// Ends the stream at `ix`: the whole text goes to the message's view (appended where it continues it) and the
    /// live view goes away.
    pub fn finish_stream(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(stream) = self.streams.remove(&ix) else { return };
        if let Some(views) = self.views.get_mut(&ix) {
            views.main.update(cx, |state, cx| state.set_text(&stream.text, cx));
            views.live = None;
            self.parses.set(self.parses.get() + 1);
        }
        if let Some(Item::Prose(prose)) = self.items.get_mut(ix) {
            *prose = Prose::new(stream.text);
        }
        self.list.splice(ix..ix + 1, 1);
        cx.notify();
    }

    fn is_selectable(&self, ix: usize) -> bool {
        matches!(self.items.get(ix), Some(Item::User(_) | Item::Prose(_)))
    }

    /// Creates the text view of a selectable item the first time it is needed; false for other items.
    fn ensure_views(&mut self, ix: usize, cx: &mut Context<Self>) -> bool {
        if self.views.contains_key(&ix) {
            return true;
        }
        let source = match self.items.get(ix) {
            Some(Item::User(text)) => plain_text_source(text),
            Some(Item::Prose(prose)) => prose.text.to_string(),
            _ => return false,
        };
        let main = cx.new(|cx| TextViewState::markdown(&source, cx));
        self.parses.set(self.parses.get() + 1);
        self.views.insert(ix, Views { main, live: None });
        true
    }

    /// Drops the text views of items far from the last drawn range, keeping the selection's ends and streams.
    fn evict_views(&mut self) {
        let (lo, hi) = {
            let painted = self.painted.borrow();
            match (painted.rows.keys().next(), painted.rows.keys().next_back()) {
                (Some(lo), Some(hi)) => (*lo, *hi),
                _ => return,
            }
        };
        let ends: Vec<usize> = self.tracker.borrow().ends().collect();
        let streams = &self.streams;
        let keep = lo.saturating_sub(VIEW_MARGIN)..=hi + VIEW_MARGIN;
        self.views.retain(|ix, _| keep.contains(ix) || ends.contains(ix) || streams.contains_key(ix));
    }

    /// The text a selection covering all of item `ix` copies.
    fn full_text(&mut self, ix: usize, cx: &mut Context<Self>) -> String {
        if !self.ensure_views(ix, cx) {
            return String::new();
        }
        let views = &self.views[&ix];
        let mut text = views.main.read(cx).rendered_text().as_str().to_string();
        if let Some(live) = &views.live {
            text.push_str(live.read(cx).rendered_text().as_str());
        }
        text
    }

    /// The part of item `ix` the selection holds, as its views last painted it.
    fn selected_part(&self, ix: usize, cx: &Context<Self>) -> String {
        let Some(views) = self.views.get(&ix) else { return String::new() };
        let mut text = views.main.read(cx).selected_text();
        if let Some(live) = &views.live {
            text.push_str(&live.read(cx).selected_text());
        }
        text
    }

    /// The text a copy gives for a selection whose ends are in items `first` and `last`: the selected part of each
    /// end and the whole text of every selectable item between, joined as gpui-base joins its participants.
    pub fn selected_text_between(&mut self, first: usize, last: usize, cx: &mut Context<Self>) -> String {
        let mut parts = Vec::new();
        for ix in first..=last {
            if !self.is_selectable(ix) {
                continue;
            }
            let part = if ix == first || ix == last { self.selected_part(ix, cx) } else { self.full_text(ix, cx) };
            if !part.trim().is_empty() {
                parts.push(part);
            }
        }
        parts.join("\n")
    }

    /// ⌘C over a selection across items: the transcript copies, since items between the ends may not be mounted.
    /// A selection inside one item is left to gpui-base (the action goes on to the text view).
    fn copy_selection(&mut self, _: &gpui_base::input::Copy, window: &mut Window, cx: &mut Context<Self>) {
        let Some((first, last)) = self.tracker.borrow().span() else { return };
        if first == last || !TextSelection::has_selection(window, cx) {
            return;
        }
        let text = self.selected_text_between(first, last, cx);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
        cx.stop_propagation();
    }

    /// Snapshot mode: once the answer `select_on_open` names was drawn, drags from its second line to the middle
    /// of its code block through the window's input, as a pointer would.
    fn select_for_snapshot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.select_on_open.and_then(|ix| self.drawn_text(ix)) else { return };
        self.select_on_open = None;
        let from = gpui::point(text.left() + px(40.0), text.top() + px(60.0));
        let to = gpui::point(text.left() + px(300.0), text.bottom() - px(130.0));
        window.defer(cx, move |window, cx| {
            let left = gpui::MouseButton::Left;
            let down = gpui::MouseDownEvent { button: left, position: from, click_count: 1, ..Default::default() };
            let moved = gpui::MouseMoveEvent { position: to, pressed_button: Some(left), ..Default::default() };
            let up = gpui::MouseUpEvent { button: left, position: to, click_count: 1, ..Default::default() };
            window.dispatch_event(gpui::PlatformInput::MouseDown(down), cx);
            window.dispatch_event(gpui::PlatformInput::MouseMove(moved), cx);
            window.dispatch_event(gpui::PlatformInput::MouseUp(up), cx);
        });
    }

    fn refresh_style(&mut self, cx: &Context<Self>) {
        let theme = cx.theme();
        if theme.appearance != self.style_for {
            self.style = text_view_style(theme, CHAT_TEXT.size);
            self.style_for = theme.appearance;
        }
    }

    /// A selectable item's text: its markdown views, with a probe recording where they were drawn.
    fn text_block(&self, ix: usize) -> AnyElement {
        let views = &self.views[&ix];
        let markdown =
            |state: &Entity<TextViewState>| Markdown::new(state, self.style.clone(), self.extensions.clone(), self.on_link.clone());
        let main_empty = self.streams.get(&ix).is_some_and(|stream| stream.shown.is_empty());
        let painted = self.painted.clone();
        div()
            .relative()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(CHAT_TEXT.size * 0.5))
            .when(!main_empty, |el| el.child(markdown(&views.main)))
            .children(views.live.as_ref().map(markdown))
            .child(
                canvas(move |bounds, _, _| _ = painted.borrow_mut().texts.insert(ix, bounds), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .into_any_element()
    }

    fn render_item(&mut self, ix: usize, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.item_renders.set(self.item_renders.get() + 1);
        self.row(ix, true, cx)
    }

    /// Item `ix` as the list draws it; `in_list` false for a copy the keeper draws off screen.
    fn row(&mut self, ix: usize, in_list: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let previous = ix.checked_sub(1).and_then(|p| self.items.get(p));
        let top = top_gap(previous, &self.items[ix]);
        let selectable = self.ensure_views(ix, cx);
        let content: AnyElement = match &self.items[ix] {
            Item::User(_) => user_message(self.text_block(ix), &theme).into_any_element(),
            Item::Prose(_) if selectable => self.text_block(ix),
            Item::Prose(_) => div().into_any_element(),
            Item::Activity(activity) => activity_row(activity, &theme).into_any_element(),
            Item::Tool(tool) => tool_row(tool, &theme).into_any_element(),
            Item::Approval(approval) => self.approval(ix, approval, &theme, cx).into_any_element(),
        };
        let painted = self.painted.clone();
        div()
            .debug_selector(move || if in_list { format!("transcript-item-{ix}") } else { format!("kept-item-{ix}") })
            .relative()
            .w_full()
            .flex()
            .justify_center()
            .px_4()
            .pt(px(top))
            .child(div().w_full().max_w(px(COLUMN_WIDTH)).min_w_0().child(content))
            .when(in_list, |row| {
                row.child(
                    canvas(move |bounds, _, _| _ = painted.borrow_mut().rows.insert(ix, bounds), |_, _, _, _| {})
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                )
            })
            .into_any_element()
    }

    fn approval(&self, ix: usize, approval: &Approval, theme: &Theme, cx: &Context<Self>) -> impl IntoElement + use<> {
        let state_row = if approval.state == ApprovalState::Waiting {
            div()
                .debug_selector(|| "approval-waiting".into())
                .flex()
                .items_center()
                .gap_2()
                .h(CONTROL_SM)
                .child(div().flex_none().size(px(8.0)).rounded_full().bg(theme.orange))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_step(TEXT_12)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.orange_ink)
                        .child(ApprovalState::Waiting.label()),
                )
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .gap(px(6.0))
                        .child(self.decision_button(ix, ApprovalState::Denied, cx))
                        .child(self.decision_button(ix, ApprovalState::AlwaysAllowed, cx))
                        .child(self.decision_button(ix, ApprovalState::Allowed, cx)),
                )
        } else {
            let icon = if approval.state == ApprovalState::Denied { IconName::Cancel01 } else { IconName::Tick02 };
            div()
                .debug_selector(|| "approval-resolved".into())
                .flex()
                .items_center()
                .gap_2()
                .h(CONTROL_SM)
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(
                    div()
                        .flex_none()
                        .size(px(16.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::new(icon).size(IconSize::S12).color(theme.ink3)),
                )
                .child(approval.state.label())
        };
        div().flex().flex_col().gap_1().child(tool_row(&approval.tool, theme)).child(state_row).child(
            div()
                .rounded(RADIUS_CONTROL)
                .bg(theme.inset)
                .border_1()
                .border_color(theme.line)
                .p(px(8.0))
                .font_family(mono())
                .text_step(CODE_TEXT)
                .text_color(theme.ink)
                .child(approval.command.clone()),
        )
    }

    /// Deny (`danger-ghost`), Always allow (`secondary`) and Allow once (`primary`), all 28 high (DESIGN.md
    /// "Approvals").
    fn decision_button(&self, ix: usize, decision: ApprovalState, cx: &Context<Self>) -> Button {
        let (id, label, variant) = match decision {
            ApprovalState::Denied => ("approval-deny", "Deny", ButtonVariant::DangerGhost),
            ApprovalState::AlwaysAllowed => ("approval-always", "Always allow", ButtonVariant::Secondary),
            _ => ("approval-allow-once", "Allow once", ButtonVariant::Primary),
        };
        Button::new((id, ix), label)
            .selector(id)
            .variant(variant)
            .size(ButtonSize::S28)
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.resolve(ix, decision, cx)))
    }
}

impl Render for Transcript {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let frame = self.probe.as_mut().map(|probe| probe.frame(&self.item_renders));
        self.refresh_style(cx);
        self.select_for_snapshot(window, cx);
        self.evict_views();
        self.painted.borrow_mut().clear();
        // The items holding a selection end, built now; the keeper draws those the list does not.
        let ends: Vec<usize> = self.tracker.borrow().ends().filter(|ix| self.is_selectable(*ix)).collect();
        let kept: Vec<(usize, AnyElement)> = ends.into_iter().map(|ix| (ix, self.row(ix, false, cx))).collect();
        div()
            .size_full()
            .relative()
            .capture_action(cx.listener(Self::copy_selection))
            .child(
                list(self.list.clone(), cx.processor(Self::render_item))
                    .size_full()
                    .pt(px(LIST_TOP_PAD))
                    .pb(px(BOTTOM_CLEARANCE) + self.footer),
            )
            .child(Keeper::new(self.tracker.clone(), self.painted.clone(), kept))
            .children(frame.map(|frame| {
                // Zero-size and last: its paint runs after every item of this frame has painted.
                canvas(|_, _, _| {}, move |_, _, _, _| frame.painted()).absolute().size(px(0.0))
            }))
    }
}

fn top_gap(previous: Option<&Item>, item: &Item) -> f32 {
    let stacked = |item: Option<&Item>| matches!(item, Some(Item::Tool(_)) | Some(Item::Approval(_)));
    match item {
        Item::User(_) => 24.0,
        Item::Activity(_) => 12.0,
        Item::Prose(_) => 8.0,
        Item::Tool(_) | Item::Approval(_) if stacked(previous) => 0.0,
        Item::Tool(_) | Item::Approval(_) => 8.0,
    }
}

fn user_message(text: AnyElement, theme: &Theme) -> impl IntoElement + use<> {
    div().flex().justify_end().child(
        div()
            .max_w(px(USER_MAX_WIDTH))
            .min_w_0()
            .p(px(12.0))
            .rounded(RADIUS_WINDOW)
            .bg(theme.field)
            .text_size(px(CHAT_TEXT.size))
            .line_height(px(CHAT_TEXT.line_height))
            .text_color(theme.ink)
            .child(text),
    )
}

fn activity_row(activity: &Activity, theme: &Theme) -> impl IntoElement + use<> {
    let shown = activity.marks.len().min(3);
    // The marks' row gets an explicit width: with negative margins on its children, a hugging flex
    // container measures 0px wide in GPUI 0.2.2 (taffy), and the summary text lands on the marks.
    let marks_width = if shown == 0 { 0.0 } else { MARK_SIZE + (shown - 1) as f32 * (MARK_SIZE - MARK_OVERLAP) };
    let marks = activity.marks.iter().take(shown).enumerate().map(|(n, kind)| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(MARK_SIZE))
            .when(n > 0, |mark| mark.ml(px(-MARK_OVERLAP)))
            .rounded_full()
            .bg(theme.field)
            .border_2()
            .border_color(theme.page)
            .child(Icon::new(kind.icon()).size(IconSize::S12).color(theme.ink2))
    });
    div()
        .flex()
        .items_center()
        .gap_2()
        .h(CONTROL_XS)
        .child(div().debug_selector(|| "activity-marks".into()).flex().flex_none().w(px(marks_width)).children(marks))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink3)
                .child(activity.summary.clone()),
        )
        .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(activity.duration.clone()))
}

fn tool_row(tool: &Tool, theme: &Theme) -> impl IntoElement + use<> {
    div()
        .flex()
        .items_center()
        .gap_2()
        .h(CONTROL_SM)
        .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).child(Icon::new(tool.kind.icon()).color(theme.ink3)))
        .child(
            div().min_w_0().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(tool.label.clone()),
        )
        .children(tool.added.map(|n| count(format!("+{n}"), theme.green)))
        .children(tool.removed.map(|n| count(format!("-{n}"), theme.red_ink)))
        .child(div().flex_1())
        .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(tool.duration.clone()))
}

fn count(text: String, color: Rgba) -> impl IntoElement {
    div().flex_none().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(color).child(text)
}

/// What a tool row or an activity mark stands for. Each kind draws the desktop's glyph
/// (`agents/ActivitySource.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolKind {
    Edit,
    Read,
    Command,
    Search,
    Think,
}

impl ToolKind {
    pub fn icon(self) -> IconName {
        match self {
            ToolKind::Edit => IconName::PencilEdit02,
            ToolKind::Read => IconName::File01,
            ToolKind::Command => IconName::CommandLine,
            ToolKind::Search => IconName::Search01,
            ToolKind::Think => IconName::AiBrain01,
        }
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Timing probe for `MILAGRE_GPUI_TIMING=1`. Each labelled frame prints the CPU time from the start
/// of `Transcript::render` to the end of the transcript's paint (GPUI lays the list out in
/// prepaint, between the two) and how many item elements the list built in that frame.
///
/// Script, timed from the transcript's creation, all inside snapshot mode's 1.5 s (which then quits
/// the app): append one item at the bottom (+400 ms); count frames and item renders over 500 ms of
/// idle while the running mark animates outside the list (+500 ms); jump 300 items up into history that was never
/// measured (+1,050 ms); scroll 120 px further up, as one wheel step would (+1,150 ms).
struct Probe {
    created: Instant,
    label: Rc<RefCell<Option<&'static str>>>,
    frames: Rc<Cell<usize>>,
}

impl Probe {
    fn start(cx: &mut Context<Transcript>) -> Self {
        let probe = Self { created: Instant::now(), label: Rc::new(RefCell::new(Some("first frame"))), frames: Rc::new(Cell::new(0)) };
        let label = probe.label.clone();
        cx.spawn(async move |this, cx| {
            let executor = cx.background_executor().clone();
            let wait = |ms: u64| executor.timer(Duration::from_millis(ms));
            let counters = |this: &Transcript| (this.item_renders.get(), this.probe.as_ref().map_or(0, |p| p.frames.get()));

            wait(400).await;
            label.replace(Some("append one item at the bottom"));
            this.update(cx, |this, cx| {
                this.push(Item::Prose(Prose::new("Appended by the timing probe: **one** more paragraph with `code`.")), cx);
            })
            .ok();

            wait(100).await;
            let before = this.update(cx, |this, _| counters(this)).unwrap_or_default();
            wait(500).await;
            this.update(cx, |this, _| {
                let (renders, frames) = counters(this);
                eprintln!(
                    "timing: idle 500 ms, running mark animating outside the list: {} transcript frames, {} item renders",
                    frames - before.1,
                    renders - before.0
                );
            })
            .ok();

            wait(50).await;
            label.replace(Some("jump 300 items up (unmeasured history)"));
            this.update(cx, |this, cx| {
                let target = this.items.len().saturating_sub(300);
                this.list.scroll_to(ListOffset { item_ix: target, offset_in_item: px(0.0) });
                cx.notify();
            })
            .ok();

            wait(100).await;
            label.replace(Some("scroll 120 px up"));
            this.update(cx, |this, cx| {
                this.list.scroll_by(px(-120.0));
                cx.notify();
            })
            .ok();

            wait(100).await;
            this.update(cx, |this, _| {
                let top = this.list.logical_scroll_top();
                let height = this.list.max_offset_for_scrollbar().y;
                eprintln!(
                    "timing: now at item {} of {}; scrollable height known to the list: {:.0} px",
                    top.item_ix,
                    this.items.len(),
                    f32::from(height)
                );
            })
            .ok();
        })
        .detach();
        probe
    }

    fn frame(&mut self, renders: &Rc<Cell<usize>>) -> FrameProbe {
        self.frames.set(self.frames.get() + 1);
        FrameProbe {
            label: self.label.take(),
            started: Instant::now(),
            created: self.created,
            renders: renders.clone(),
            renders_before: renders.get(),
        }
    }
}

struct FrameProbe {
    label: Option<&'static str>,
    started: Instant,
    created: Instant,
    renders: Rc<Cell<usize>>,
    renders_before: usize,
}

impl FrameProbe {
    fn painted(self) {
        let Some(label) = self.label else { return };
        let built = self.renders.get() - self.renders_before;
        let cpu = ms(self.started.elapsed());
        if label == "first frame" {
            let epoch = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            eprintln!(
                "timing: first frame painted at epoch {epoch} ms, {:.1} ms after the transcript was created; render to paint {cpu:.1} ms; {built} item renders",
                ms(self.created.elapsed())
            );
        } else {
            eprintln!("timing: {label}: render to paint {cpu:.1} ms; {built} item renders");
        }
    }
}
