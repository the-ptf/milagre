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
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{
    Animation, AnimationExt as _, AnyElement, ClickEvent, Context, FontWeight, ListAlignment, ListOffset, ListState, Rgba, SharedString,
    Window, canvas, div, list, prelude::*, px,
};

use crate::theme::{
    ActiveTheme, CHAT_TEXT, CODE_TEXT, CONTROL_SM, CONTROL_XS, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_12, TEXT_13, TextStepExt, Theme, mono,
};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};
use crate::workspace::chat::markdown::{self, Block};

/// The Chat content column, centred in the Chat column.
pub const COLUMN_WIDTH: f32 = 536.0;
/// Room left under the last item for the floating pills.
pub const BOTTOM_CLEARANCE: f32 = 48.0;
const USER_MAX_WIDTH: f32 = 420.0;
const MARK_SIZE: f32 = 20.0;
const MARK_OVERLAP: f32 = 6.0;
/// Extra height laid out above and below the viewport, so scrolling does not pop items in.
const OVERDRAW: f32 = 600.0;

/// One entry in the transcript.
#[derive(Clone, Debug)]
pub enum Item {
    User(SharedString),
    Activity(Activity),
    Prose(Vec<Block>),
    Tool(Tool),
    Approval(Approval),
    Running(SharedString),
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

pub struct Transcript {
    items: Vec<Item>,
    list: ListState,
    /// Every call to `render_item`, for the "only visible items are laid out" check.
    item_renders: Rc<Cell<usize>>,
    animate_running: bool,
    probe: Option<Probe>,
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
            eprintln!("timing: fixture of {} items built and parsed in {:.1} ms", this.items.len(), ms(built));
            this.probe = Some(Probe::start(cx));
        }
        this
    }

    pub fn with_items(items: Vec<Item>, _cx: &mut Context<Self>) -> Self {
        let list = ListState::new(items.len(), ListAlignment::Bottom, px(OVERDRAW));
        // The running mark breathes in the app. The headless test platform keeps it still so a
        // test can count item renders without an animation frame re-rendering the list.
        Self { items, list, item_renders: Rc::new(Cell::new(0)), animate_running: !cfg!(test), probe: None }
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

    fn render_item(&mut self, ix: usize, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.item_renders.set(self.item_renders.get() + 1);
        let theme = *cx.theme();
        let previous = ix.checked_sub(1).and_then(|p| self.items.get(p));
        let top = top_gap(previous, &self.items[ix]);
        let content: AnyElement = match &self.items[ix] {
            Item::User(text) => user_message(text.clone(), &theme).into_any_element(),
            Item::Activity(activity) => activity_row(activity, &theme).into_any_element(),
            Item::Prose(blocks) => markdown::render(blocks, ix, &theme).into_any_element(),
            Item::Tool(tool) => tool_row(tool, &theme).into_any_element(),
            Item::Approval(approval) => self.approval(ix, approval, &theme, cx).into_any_element(),
            Item::Running(elapsed) => running_row(elapsed.clone(), self.animate_running, &theme).into_any_element(),
        };
        div()
            .debug_selector(move || format!("transcript-item-{ix}"))
            .w_full()
            .flex()
            .justify_center()
            .px_4()
            .pt(px(top))
            .child(div().w_full().max_w(px(COLUMN_WIDTH)).min_w_0().child(content))
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let frame = self.probe.as_mut().map(|probe| probe.frame(&self.item_renders));
        div()
            .size_full()
            .child(list(self.list.clone(), cx.processor(Self::render_item)).size_full().pt(px(16.0)).pb(px(BOTTOM_CLEARANCE)))
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
        Item::Running(_) => 12.0,
    }
}

fn user_message(text: SharedString, theme: &Theme) -> impl IntoElement + use<> {
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

fn running_row(elapsed: SharedString, animate: bool, theme: &Theme) -> impl IntoElement + use<> {
    let mark = div().flex_none().size(px(10.0)).rounded_full().border_2().border_color(theme.ink3);
    let mark = if animate {
        mark.with_animation(
            "running-mark",
            Animation::new(Duration::from_millis(1600)).repeat().with_easing(gpui::pulsating_between(0.35, 1.0)),
            |mark, delta| mark.opacity(delta),
        )
        .into_any_element()
    } else {
        mark.into_any_element()
    };
    div()
        .debug_selector(|| "running-row".into())
        .flex()
        .items_center()
        .gap_2()
        .h(CONTROL_XS)
        .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).child(mark))
        .child(div().text_step(TEXT_12).text_color(theme.ink3).child(elapsed))
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
/// idle with the running mark animating (+500 ms); jump 300 items up into history that was never
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
                let blocks = markdown::parse("Appended by the timing probe: **one** more paragraph with `code`.");
                this.push(Item::Prose(blocks), cx);
            })
            .ok();

            wait(100).await;
            let before = this.update(cx, |this, _| counters(this)).unwrap_or_default();
            wait(500).await;
            this.update(cx, |this, _| {
                let (renders, frames) = counters(this);
                eprintln!(
                    "timing: idle 500 ms, running mark animating: {} transcript frames, {} item renders",
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
