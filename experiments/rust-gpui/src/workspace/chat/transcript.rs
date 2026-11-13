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
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, AnyView, App, ClickEvent, ClipboardItem, Context, Entity, FocusHandle, FontWeight, KeyBinding, ListAlignment, ListOffset,
    ListState, MouseButton, MouseDownEvent, Pixels, SharedString, StyleRefinement, Subscription, Task, WeakEntity, Window, canvas, div,
    list, prelude::*, px,
};
use gpui_base::input::{Copy as CopyText, SelectAll};
use gpui_base::{MarkdownExtensions, TextSelection, TextViewState, TextViewStyle};
use gpui_component::input::InputState;

use crate::data::ChatStep;
use crate::logic::lists::chat_display::ToolCallDisplay;
use crate::theme::{ActiveTheme, CONTROL_SM, CONTROL_XS, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::markdown::stream::{close_open_markdown, split_streaming_blocks};
use crate::ui::markdown::{FenceHooks, LinkHandler, Markdown, extensions_with, open_with_system, plain_text_source, text_view_style};
use crate::ui::selection::{Flavor, Plain, join, plain_text};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};
use crate::workspace::chat::transcript::step_row::StepRow;
use crate::workspace::chat::transcript_selection::{Keeper, SelectionTracker, SharedAll, SharedPainted, SharedTracker};

pub mod activity;
pub mod cards;
pub mod decision;
pub mod find;
pub mod quote;
pub mod step_row;
pub mod summary;

pub use activity::{Activity, RowState, StepItem};
pub use cards::Card;
pub use decision::CardDecision;
pub use quote::{Passage, TranscriptEvent};
pub use summary::Entry;

/// What the cached markdown style was built from: the theme (its colours, not just its scheme: two dark themes differ
/// in the code background, the chip and the syntax) and the Appearance choices it bakes in (the Chat and code sizes,
/// the monospace family).
type StyleKey = (Theme, u32, u32, &'static str);

fn style_key(theme: &Theme) -> StyleKey {
    (*theme, crate::theme::chat_text().size.to_bits(), crate::theme::code_text().size.to_bits(), mono())
}

/// The Chat content column at the default width, centred in the Chat column. The chosen width is [`column_width`].
pub const COLUMN_WIDTH: f32 = 536.0;
/// Room left under the last item for the floating pills.
pub const BOTTOM_CLEARANCE: f32 = 48.0;
/// The gap between the last item and the running row.
pub const RUNNING_GAP: f32 = 12.0;
/// Padding above the list's first item.
pub const LIST_TOP_PAD: f32 = 16.0;
/// More room above the first item while the find bar floats over the top (`pt-12` instead of `pt-7`).
pub const FIND_TOP_PAD: f32 = 20.0;
const USER_MAX_WIDTH: f32 = 420.0;
/// Extra height laid out above and below the viewport, so scrolling does not pop items in.
const OVERDRAW: f32 = 600.0;
/// Text views kept for items this far outside the last drawn range; further ones are dropped and parsed again
/// when they come back (the desktop keeps parsed bodies in an LRU of 500 for the same reason).
const VIEW_MARGIN: usize = 150;
/// The key context of the transcript: ⌘A selects every message and ⌘C copies the selection while focus is in it.
const KEY_CONTEXT: &str = "Transcript";

/// ⌘A and ⌘C for the transcript, once per app. A focused message's own text view binds the same keys to the same
/// actions; the transcript takes them first (`capture_action`).
pub fn install_keys(cx: &mut App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    cx.bind_keys([KeyBinding::new("cmd-a", SelectAll, Some(KEY_CONTEXT)), KeyBinding::new("cmd-c", CopyText, Some(KEY_CONTEXT))]);
}

/// A streamed answer renders at most this often (`STREAM_RENDER_MS` in `Markdown.tsx`); the last batch always shows.
pub const STREAM_RENDER: Duration = Duration::from_millis(50);

/// One entry in the transcript.
#[derive(Clone, Debug)]
pub enum Item {
    User(SharedString),
    /// A reply's activity: a fold of its steps, or the lone step's row.
    Activity(Activity),
    Prose(Prose),
    /// A tool call that stands between two pieces of text.
    Step(StepItem),
    Approval(Approval),
    /// A card or divider (WP-23): `transcript/cards`.
    Card(Card),
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

#[derive(Clone, Debug)]
pub struct Approval {
    /// The call that waits (its title and kind draw the row; it has no detail of its own).
    pub step: ChatStep,
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
    /// Every item element built (a cached row that is reused builds none), for the "only visible items are laid
    /// out" check and the drag measurements.
    item_renders: Rc<Cell<usize>>,
    /// Text view states created and texts handed to them (each one a parse), for the measurements.
    parses: Rc<Cell<usize>>,
    /// Room kept under the last item for the running row, which `ChatView` draws over the list's bottom
    /// edge as a view of its own (`running.rs`).
    footer: Pixels,
    /// Room kept under everything for the composer, which floats over the list's bottom (the list runs behind it to
    /// the card's bottom edge), so the last item still scrolls fully above it. `ChatView` measures the composer.
    composer_room: Pixels,
    probe: Option<Probe>,
    views: HashMap<usize, Views>,
    streams: HashMap<usize, Stream>,
    style: TextViewStyle,
    style_for: StyleKey,
    extensions: MarkdownExtensions,
    /// The same rules for the block being written: a diagram stays code and a generative UI's buttons are off.
    live_extensions: MarkdownExtensions,
    on_link: LinkHandler,
    tracker: SharedTracker,
    painted: SharedPainted,
    all: SharedAll,
    /// While a selection is dragged, each row on screen is a cached view of its own (`RowView`), so the selection
    /// moving through one message re-renders that message and no other.
    row_views: HashMap<usize, Entity<RowView>>,
    focus: FocusHandle,
    /// Snapshot mode (`MILAGRE_GPUI_TRANSCRIPT_SELECT`): drag over this item once it has been drawn.
    select_on_open: Option<usize>,
    /// Settings › Chat › Tool call display (default Compact) and Always expand reasoning (default off).
    display: ToolCallDisplay,
    expand_reasoning: bool,
    /// The shared clock's ticks while a running step's title shimmers ([`crate::ui::frame_clock`]).
    shimmer_clock: Option<crate::ui::frame_clock::ClockUse>,
    /// Images decoded for the cards (kept; `None` for one that could not be read).
    images: HashMap<PathBuf, Option<cards::images::Decoded>>,
    /// The image or brief open over the transcript.
    viewer: Option<cards::images::Viewer>,
    /// The text fields of open question cards, by (item, question).
    inputs: HashMap<(usize, usize), Entity<InputState>>,
    subscriptions: Vec<Subscription>,
    /// Find in chat, while its bar is open (`transcript/find.rs`).
    find: Option<find::FindState>,
    search_index: find::SearchIndex,
}

impl Transcript {
    /// The fixture transcript: ~2,000 items, or `MILAGRE_GPUI_TRANSCRIPT_ITEMS` when set.
    pub fn new(cx: &mut Context<Self>) -> Self {
        let count = std::env::var("MILAGRE_GPUI_TRANSCRIPT_ITEMS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(crate::workspace::chat::fixture::HISTORY_ITEMS);
        let started = Instant::now();
        let demo = std::env::var_os("MILAGRE_GPUI_TRANSCRIPT_ACTIVITY").is_some();
        let cards = std::env::var_os("MILAGRE_GPUI_TRANSCRIPT_CARDS").is_some();
        let items = if let Some(kind) = std::env::var("MILAGRE_GPUI_TRANSCRIPT_BLOCKS").ok().filter(|kind| !kind.is_empty()) {
            // Snapshot seed: a reply with diagrams (`diagrams`) or generative UI (`genui`).
            crate::genui::fixture::blocks_demo(&kind)
        } else if cards {
            crate::workspace::chat::fixture::cards_demo()
        } else if demo {
            crate::workspace::chat::fixture::activity_demo()
        } else {
            crate::workspace::chat::fixture::transcript(count)
        };
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
        install_keys(cx);
        let list = ListState::new(items.len(), ListAlignment::Bottom, px(OVERDRAW));
        let theme = *cx.theme();
        let on_link = open_with_system();
        // A generative UI button sends its message as the user's next one, as a Composer send does.
        let transcript = cx.weak_entity();
        let send: crate::genui::SendHandler = Arc::new(move |text, _, cx| {
            let text = SharedString::from(text.to_string());
            transcript.update(cx, |transcript, cx| transcript.push_user(text, cx)).ok();
        });
        let hooks = FenceHooks { streaming: false, send: Some(send) };
        Self {
            items,
            list,
            item_renders: Rc::new(Cell::new(0)),
            parses: Rc::new(Cell::new(0)),
            footer: px(0.0),
            composer_room: px(0.0),
            probe: None,
            views: HashMap::new(),
            streams: HashMap::new(),
            style: text_view_style(&theme, crate::theme::chat_text().size),
            style_for: style_key(&theme),
            extensions: extensions_with(on_link.clone(), hooks.clone()),
            live_extensions: extensions_with(on_link.clone(), FenceHooks { streaming: true, ..hooks }),
            on_link,
            tracker: SharedTracker::default(),
            painted: SharedPainted::default(),
            all: SharedAll::default(),
            row_views: HashMap::new(),
            focus: cx.focus_handle(),
            select_on_open: None,
            display: ToolCallDisplay::Compact,
            expand_reasoning: false,
            shimmer_clock: None,
            images: HashMap::new(),
            viewer: None,
            inputs: HashMap::new(),
            subscriptions: Vec::new(),
            find: None,
            search_index: find::SearchIndex::default(),
        }
    }

    /// Shows another Chat's items: the list starts over at the bottom, and the views, streams, selection and
    /// other per-item caches of the old items go.
    pub fn set_items(&mut self, items: Vec<Item>, cx: &mut Context<Self>) {
        self.list.reset(items.len());
        self.list.scroll_to(ListOffset { item_ix: items.len(), offset_in_item: px(0.0) });
        self.items = items;
        self.views.clear();
        self.streams.clear();
        self.inputs.clear();
        self.viewer = None;
        self.select_on_open = None;
        *self.tracker.borrow_mut() = SelectionTracker::default();
        self.all.borrow_mut().end(cx);
        self.row_views.clear();
        self.painted.borrow_mut().clear();
        // The find bar belongs to one Chat (the Chat column closes it); its matches go with the old items.
        self.search_index.clear();
        self.find = None;
        cx.emit(TranscriptEvent::Passage(None));
        cx.notify();
    }

    /// The two Chat settings that shape the activity: tool calls, and whether thinking rows start open.
    pub fn display(&self) -> (ToolCallDisplay, bool) {
        (self.display, self.expand_reasoning)
    }

    /// The two Chat settings that shape the activity: every item is built again, so heights are measured again.
    pub fn set_display(&mut self, display: ToolCallDisplay, expand_reasoning: bool, cx: &mut Context<Self>) {
        if (self.display, self.expand_reasoning) != (display, expand_reasoning) {
            self.display = display;
            self.expand_reasoning = expand_reasoning;
            self.list.reset(self.items.len());
            cx.notify();
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

    /// Keeps room under the last item for the composer floating over the list (its measured height).
    pub fn set_composer_room(&mut self, room: Pixels, cx: &mut Context<Self>) {
        if self.composer_room != room {
            self.composer_room = room;
            cx.notify();
        }
    }

    pub fn composer_room(&self) -> Pixels {
        self.composer_room
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

    /// Whether ⌘A selected every message.
    pub fn all_selected(&self) -> bool {
        self.all.borrow().active
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
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
        self.refresh_find();
        cx.notify();
    }

    /// "Go to bottom": the list follows its end again.
    pub fn scroll_to_bottom(&mut self, cx: &mut Context<Self>) {
        self.list.scroll_to(ListOffset { item_ix: self.items.len(), offset_in_item: px(0.0) });
        cx.notify();
    }

    /// Appends a message the user sent and scrolls to it, even if the reader had scrolled up.
    pub fn push_user(&mut self, text: SharedString, cx: &mut Context<Self>) {
        self.push(Item::User(text), cx);
        self.list.scroll_to(ListOffset { item_ix: self.items.len(), offset_in_item: px(0.0) });
    }

    /// A sent message: its images' strip (when it has any) over its bubble (when it has text), scrolled to.
    pub fn push_sent(&mut self, text: SharedString, images: Vec<cards::images::ImageRef>, cx: &mut Context<Self>) {
        if !images.is_empty() {
            let strip = cards::images::ImageStrip { kind: cards::images::StripKind::Attachments, images };
            self.push(Item::Card(Card::Images(strip)), cx);
        }
        if !text.is_empty() {
            self.push(Item::User(text), cx);
        }
        self.list.scroll_to(ListOffset { item_ix: self.items.len(), offset_in_item: px(0.0) });
    }

    /// Settles the approval at `ix`. The row changes height, so the list re-measures that item.
    pub fn resolve(&mut self, ix: usize, state: ApprovalState, cx: &mut Context<Self>) {
        if let Some(Item::Approval(approval)) = self.items.get_mut(ix)
            && approval.state == ApprovalState::Waiting
        {
            approval.state = state;
            self.list.splice(ix..ix + 1, 1);
            cx.emit(CardDecision::Approval { ix, state });
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
        self.refresh_find();
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
        self.refresh_find();
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

    /// What a selection covering all of item `ix` copies (`ui::selection::plain`), from its source: no text view
    /// is needed, so items far from the screen copy without being parsed for display.
    fn whole_text(&self, ix: usize) -> Plain {
        match self.items.get(ix) {
            Some(Item::User(text)) => Plain::block(text.to_string()),
            Some(Item::Prose(prose)) => plain_text(&prose.text, 0..prose.text.len(), Flavor::Markdown),
            _ => Plain::default(),
        }
    }

    /// What the selection holds of item `ix`, an end of it: the source range its text view reports, serialised as
    /// the desktop copies it. A streamed answer, or a selection the view cannot map to its source (inside a nested
    /// fence), copies the view's own text.
    fn part_text(&self, ix: usize, cx: &App) -> Plain {
        let Some(views) = self.views.get(&ix) else { return Plain::default() };
        let state = views.main.read(cx);
        let range = if self.streams.contains_key(&ix) { None } else { state.selected_source_range() };
        let (Some(range), Some(item)) = (range, self.items.get(ix)) else {
            let mut text = state.selected_text();
            if let Some(live) = &views.live {
                text.push_str(&live.read(cx).selected_text());
            }
            return Plain::block(text);
        };
        match item {
            Item::User(typed) => {
                let source = plain_text_source(typed);
                if range.start == 0 && range.end >= source.len() {
                    Plain::block(typed.to_string())
                } else {
                    plain_text(&source, range, Flavor::PreWrap)
                }
            }
            Item::Prose(prose) => plain_text(&prose.text, range, Flavor::Markdown),
            _ => Plain::default(),
        }
    }

    /// The text a copy gives for a selection whose ends are in items `first` and `last`: the selected part of each
    /// end and the whole of every selectable item between, mounted or not, joined as the desktop's blocks join.
    pub fn selected_text_between(&mut self, first: usize, last: usize, cx: &mut Context<Self>) -> String {
        let parts: Vec<Plain> = (first..=last)
            .filter(|ix| self.is_selectable(*ix))
            .map(|ix| if ix == first || ix == last { self.part_text(ix, cx) } else { self.whole_text(ix) })
            .collect();
        join(parts)
    }

    /// What ⌘C copies now: everything after ⌘A, else the selection the drag left, else nothing.
    pub fn copy_text(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<String> {
        let text = if self.all.borrow().active {
            join((0..self.items.len()).map(|ix| self.whole_text(ix)))
        } else {
            let (first, last) = self.tracker.borrow().span()?;
            if !TextSelection::has_selection(window, cx) {
                return None;
            }
            self.selected_text_between(first, last, cx)
        };
        (!text.trim().is_empty()).then_some(text)
    }

    /// ⌘C while focus is in the transcript: the transcript copies, since items between the ends may not be
    /// mounted and the desktop's text differs from gpui-base's own. Nothing selected here: the action goes on.
    fn copy_selection(&mut self, _: &CopyText, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.copy_text(window, cx) else { return };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        cx.stop_propagation();
    }

    /// ⌘A while focus is in the transcript: every message, as a page's ⌘A selects the page. The window selection
    /// goes; each text view shows the selection through its own select-all, now or when it is next built.
    pub fn select_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        TextSelection::clear(window, cx);
        *self.tracker.borrow_mut() = SelectionTracker::default();
        let mut all = self.all.borrow_mut();
        all.active = true;
        for views in self.views.values() {
            for view in std::iter::once(&views.main).chain(views.live.as_ref()) {
                all.apply(view, cx);
            }
        }
        drop(all);
        cx.notify();
    }

    /// While ⌘A holds, each message drawn last frame shows it: a view built since (or reset by its first parse)
    /// selects all now. A streamed answer is left as it is.
    fn keep_all_selected(&mut self, cx: &mut Context<Self>) {
        if !self.all.borrow().active {
            return;
        }
        let drawn: Vec<usize> = self.painted.borrow().last_texts().collect();
        for ix in drawn {
            let Some(views) = self.views.get(&ix).filter(|_| !self.streams.contains_key(&ix)) else { continue };
            if views.main.read(cx).selected_source_range().is_none() {
                self.all.borrow_mut().apply(&views.main, cx);
            }
        }
    }

    fn select_all_action(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.select_all(window, cx);
        cx.stop_propagation();
    }

    /// Snapshot mode: once the answer `select_on_open` names was drawn, drags from the middle of the message above
    /// it (when drawn; else from the answer's second line) to the middle of its code block through the window's
    /// input, as a pointer would: a selection across messages.
    fn select_for_snapshot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.select_on_open else { return };
        let Some(text) = self.drawn_text(ix) else { return };
        self.select_on_open = None;
        let above = (0..ix).rev().find(|ix| self.is_selectable(*ix)).and_then(|ix| self.drawn_text(ix));
        let from = match above {
            Some(above) => gpui::point(above.left() + px(60.0), above.top() + px(10.0)),
            None => gpui::point(text.left() + px(40.0), text.top() + px(60.0)),
        };
        let to = gpui::point(text.left() + px(300.0), text.bottom() - px(130.0));
        // `MILAGRE_GPUI_TRANSCRIPT_SELECT=word`: a double click on a word of the answer's second line instead (the
        // Quote button's snapshot).
        let word = std::env::var("MILAGRE_GPUI_TRANSCRIPT_SELECT").is_ok_and(|value| value == "word");
        let (from, to) = if word {
            (gpui::point(text.left() + px(40.0), text.top() + px(32.0)), gpui::point(text.left() + px(40.0), text.top() + px(32.0)))
        } else {
            (from, to)
        };
        let clicks = if word { 2 } else { 1 };
        window.defer(cx, move |window, cx| {
            let left = gpui::MouseButton::Left;
            for click_count in 1..=clicks {
                let down = gpui::MouseDownEvent { button: left, position: from, click_count, ..Default::default() };
                let moved = gpui::MouseMoveEvent { position: to, pressed_button: Some(left), ..Default::default() };
                let up = gpui::MouseUpEvent { button: left, position: to, click_count, ..Default::default() };
                window.dispatch_event(gpui::PlatformInput::MouseDown(down), cx);
                if click_count == 1 && from != to {
                    window.dispatch_event(gpui::PlatformInput::MouseMove(moved), cx);
                }
                window.dispatch_event(gpui::PlatformInput::MouseUp(up), cx);
            }
        });
    }

    fn refresh_style(&mut self, cx: &Context<Self>) {
        let theme = cx.theme();
        let key = style_key(theme);
        if key != self.style_for {
            self.style = text_view_style(theme, crate::theme::chat_text().size);
            self.style_for = key;
            // Item heights were measured at the old sizes and fonts.
            self.list_state().remeasure();
        }
    }

    /// A selectable item's text: its markdown views, with a probe recording where they were drawn.
    fn text_block(&self, ix: usize) -> AnyElement {
        let views = &self.views[&ix];
        let markdown = |state: &Entity<TextViewState>, extensions: &MarkdownExtensions| {
            Markdown::new(state, self.style.clone(), extensions.clone(), self.on_link.clone())
        };
        let main_empty = self.streams.get(&ix).is_some_and(|stream| stream.shown.is_empty());
        let painted = self.painted.clone();
        div()
            .relative()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(crate::theme::chat_text().size * 0.5))
            .when(!main_empty, |el| el.child(markdown(&views.main, &self.extensions)))
            .children(views.live.as_ref().map(|live| markdown(live, &self.live_extensions)))
            .child(
                canvas(move |bounds, _, _| _ = painted.borrow_mut().texts.insert(ix, bounds), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .into_any_element()
    }

    /// Item `ix` for the list. While a selection is dragged, a row drawn last frame is a cached view at last
    /// frame's height (heights do not change under a drag): only a row whose selection moved renders again. A
    /// streamed answer changes on its own, so it is never cached.
    fn render_item(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let last = self.painted.borrow().last_row(ix);
        if self.tracker.borrow().is_dragging()
            && !self.streams.contains_key(&ix)
            && let Some(last) = last
        {
            let transcript = cx.weak_entity();
            let view = self.row_views.entry(ix).or_insert_with(|| cx.new(|_| RowView { transcript, ix })).clone();
            self.painted.borrow_mut().carry(ix);
            return div()
                .w_full()
                .h(last.size.height)
                .child(AnyView::from(view).cached(StyleRefinement::default().size_full()))
                .into_any_element();
        }
        self.row(ix, true, window, cx)
    }

    /// Item `ix` as the list draws it; `in_list` false for a copy the keeper draws off screen.
    fn row(&mut self, ix: usize, in_list: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if in_list {
            self.item_renders.set(self.item_renders.get() + 1);
        }
        let theme = *cx.theme();
        let previous = ix.checked_sub(1).and_then(|p| self.items.get(p));
        let top = top_gap(previous, &self.items[ix]);
        let selectable = self.ensure_views(ix, cx);
        if selectable {
            self.sync_find(ix, cx);
        }
        if let Item::Card(card) = &self.items[ix] {
            let card = card.clone();
            let content = self.card_item(ix, &card, &theme, window, cx);
            return self.framed(ix, in_list, top, content);
        }
        let content: AnyElement = match &self.items[ix] {
            Item::User(_) => user_message(self.text_block(ix), &theme).into_any_element(),
            Item::Prose(_) if selectable => self.text_block(ix),
            Item::Prose(_) => div().into_any_element(),
            Item::Activity(activity) => self.activity_item(ix, activity, &theme, cx),
            Item::Step(item) => self.step_item(ix, item, &theme, cx),
            Item::Approval(approval) => self.approval(ix, approval, &theme, cx).into_any_element(),
            Item::Card(_) => unreachable!("cards return above"),
        };
        self.framed(ix, in_list, top, content)
    }

    /// An item's content in the column: centred, `column_width()` wide at most, `top` below the item before it.
    fn framed(&self, ix: usize, in_list: bool, top: f32, content: AnyElement) -> AnyElement {
        let painted = self.painted.clone();
        div()
            .debug_selector(move || if in_list { format!("transcript-item-{ix}") } else { format!("kept-item-{ix}") })
            .relative()
            .w_full()
            .flex()
            .justify_center()
            .px_4()
            .pt(px(top))
            .child(div().w_full().max_w(px(crate::theme::column_width())).min_w_0().child(content))
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
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(step_row::row(
                &StepRow {
                    step: &approval.step,
                    key: (ix, 0),
                    open: false,
                    all_lines: false,
                    waiting: false,
                    now: 0,
                    on_toggle: None,
                    on_all: None,
                },
                theme,
            ))
            .child(state_row)
            .child(
                div()
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.inset)
                    .border_1()
                    .border_color(theme.line)
                    .p(px(8.0))
                    .font_family(mono())
                    .text_step(crate::theme::code_text())
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

impl Transcript {
    /// A running step's title shimmers on the shared clock: while one is in the transcript, each tick draws it again
    /// (12.5 a second, not every vsync); the rows read the pulse from [`step_row::set_shimmer_phase`].
    fn follow_shimmer(&mut self, cx: &mut Context<Self>) {
        let running = |step: &crate::data::ChatStep| step.status == crate::data::StepStatus::Running;
        let shimmering = crate::ui::motion()
            && self.items.iter().rev().any(|item| match item {
                Item::Step(item) => running(&item.step),
                Item::Activity(activity) => activity.steps().iter().any(|step| running(step)),
                _ => false,
            });
        if !shimmering {
            self.shimmer_clock = None;
            step_row::set_shimmer_phase(None);
            return;
        }
        if self.shimmer_clock.is_none() {
            self.shimmer_clock = Some(crate::ui::frame_clock::observe(cx, |_: &mut Transcript, cx| cx.notify()));
        }
        step_row::set_shimmer_phase(Some(crate::ui::frame_clock::phase(step_row::SHIMMER, cx)));
    }
}

impl Render for Transcript {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let frame = self.probe.as_mut().map(|probe| probe.frame(&self.item_renders));
        self.refresh_style(cx);
        self.follow_shimmer(cx);
        self.select_for_snapshot(window, cx);
        if !self.tracker.borrow().is_dragging() {
            // A drag keeps every view it passed: no message is parsed again under the pointer.
            self.evict_views();
        }
        self.painted.borrow_mut().begin_frame();
        self.keep_all_selected(cx);
        if !self.tracker.borrow().is_dragging() {
            self.row_views.clear();
        }
        // The items holding a selection end, built now; the keeper draws those the list does not.
        let ends: Vec<usize> = self.tracker.borrow().ends().filter(|ix| self.is_selectable(*ix)).collect();
        let kept: Vec<(usize, AnyElement)> = ends.into_iter().map(|ix| (ix, self.row(ix, false, window, cx))).collect();
        let theme = *cx.theme();
        let overlay = self.viewer_overlay(&theme, cx);
        div()
            .size_full()
            .relative()
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .capture_action(cx.listener(Self::copy_selection))
            .capture_action(cx.listener(Self::select_all_action))
            // A press in the transcript moves focus here (as a page takes it from a field), so ⌘A and ⌘C reach it;
            // a text view or field inside that focuses itself keeps it.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    // Not when an element over it already took the press's focus (the composer floats over the
                    // transcript: a click in it focused its text area, which this used to take straight back).
                    if !window.default_prevented() && !this.focus.contains_focused(window, cx) {
                        window.focus(&this.focus, cx);
                    }
                }),
            )
            .child(
                list(self.list.clone(), cx.processor(Self::render_item))
                    .size_full()
                    .pt(px(LIST_TOP_PAD + if self.find.is_some() { FIND_TOP_PAD } else { 0.0 }))
                    .pb(px(BOTTOM_CLEARANCE) + self.footer + self.composer_room),
            )
            .child(Keeper::new(self.tracker.clone(), self.painted.clone(), self.all.clone(), kept))
            .child(self.passage_listener(cx))
            .children(overlay)
            .children(frame.map(|frame| {
                // Zero-size and last: its paint runs after every item of this frame has painted.
                canvas(|_, _, _| {}, move |_, _, _, _| frame.painted()).absolute().size(px(0.0))
            }))
    }
}

/// One row of the transcript as a view of its own, mounted cached while a selection is dragged (`render_item`).
/// It draws what the transcript draws for the row.
pub struct RowView {
    transcript: WeakEntity<Transcript>,
    ix: usize,
}

impl Render for RowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ix = self.ix;
        let row = self.transcript.update(cx, |transcript, cx| transcript.row(ix, true, window, cx)).ok();
        div().size_full().children(row)
    }
}

fn top_gap(previous: Option<&Item>, item: &Item) -> f32 {
    let stacked = |item: Option<&Item>| matches!(item, Some(Item::Step(_)) | Some(Item::Approval(_)));
    match item {
        Item::Card(card) => cards::top_gap(card),
        Item::User(_) => 24.0,
        // A fold whose steps are all gone (a live fold a split run left behind) takes no room.
        Item::Activity(activity) if activity.entries.is_empty() => 0.0,
        Item::Activity(_) => 12.0,
        Item::Prose(_) => 8.0,
        Item::Step(_) | Item::Approval(_) if stacked(previous) => 0.0,
        Item::Step(_) | Item::Approval(_) => 8.0,
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
            .text_size(px(crate::theme::chat_text().size))
            .line_height(px(crate::theme::chat_text().line_height))
            .text_color(theme.ink)
            .child(text),
    )
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

#[cfg(test)]
mod style_tests {
    use super::*;
    use crate::settings::appearance::model::palette_for;
    use crate::settings::appearance::palette::Scheme;

    /// The markdown style is rebuilt when the theme changes between two themes of the same scheme: the key holds the
    /// theme's colours, not only its scheme, so a code block never keeps the old theme's background or syntax.
    #[test]
    fn the_style_key_changes_between_two_dark_themes() {
        let blue = Theme::dark();
        let gruvbox = palette_for("gruvbox", Scheme::Dark, None).to_theme(Scheme::Dark);
        assert_eq!(blue.appearance, gruvbox.appearance);
        assert_ne!(style_key(&blue), style_key(&gruvbox));
        assert_eq!(style_key(&blue), style_key(&Theme::dark()));
    }
}
