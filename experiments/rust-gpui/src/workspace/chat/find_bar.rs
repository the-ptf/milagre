//! The find bar (WP-28, `FindBar.tsx`): a field, the count ("3 of 12", "No results"), previous, next and close,
//! floating over the top right of the transcript. ⌘F opens it (again: refocuses it and selects its text), Enter and
//! ⌘G step forward, Shift+Enter and ⇧⌘G back, Escape closes it and focus goes back to where it was.
//!
//! The bar only reports what was typed and pressed ([`FindBarEvent`]); the transcript searches and highlights
//! (`transcript/find.rs`), and the count is read from it as the bar draws. The bar is a plain child of the Chat
//! column, so typing re-renders the column and the bar, never the transcript's items unless the matches move.
//!
//! Look: `surface`, `rounded-card`, `shadow-raised`, 4px gaps, 12px on the left and 4 elsewhere; the field 176
//! wide in 13px ink with an `ink-3` placeholder; the count at least 72 wide in 12px `ink-3`, right aligned; three
//! 24px icon buttons with tooltips. It enters with `fade-up` (8px up and in, `--duration-base` on the enter curve, at the
//! Appearance "Motion" speed): a bar is a new view each time it opens, so the animation runs once per opening, and its
//! frames notify the bar alone. Not built: tabular figures in the count.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    Animation, AnimationExt as _, AnyElement, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding, KeyDownEvent,
    ListOffset, Pixels, SharedString, Subscription, Window, canvas, div, prelude::*, px,
};
use gpui_base::TextSelection;
use gpui_component::Sizable as _;
use gpui_component::input::{Input as WidgetInput, InputEvent, InputState};

use crate::logic::keybindings::rules::primary_key_for;
use crate::logic::keybindings::{GpuiOptions, default_keybindings, gpui_bindings, key_label_for};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{IconButton, IconButtonSize, IconName, Tooltip};
use crate::workspace::chat::ChatView;
use crate::workspace::chat::transcript::quote::{button_origin, quote_button};
use crate::workspace::chat::transcript::{Passage, Transcript, TranscriptEvent};

/// Where the bar floats in the transcript (`top-11 right-4`, under the header).
pub const BAR_TOP: f32 = 0.0;
pub const BAR_RIGHT: f32 = 16.0;
/// The field (`w-44`) and the count (`min-w-18`).
const FIELD_WIDTH: f32 = 176.0;
const COUNT_MIN_WIDTH: f32 = 72.0;
/// `py-1 pr-1 pl-3`, `gap-1`.
const PAD: f32 = 4.0;
const PAD_LEFT: f32 = 12.0;
const GAP: f32 = 4.0;
/// The field's own height inside the bar (its 13px line, centred against the 24px buttons).
const FIELD_HEIGHT: f32 = 24.0;

/// What the bar asks the Chat column to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindBarEvent {
    Query(String),
    Next,
    Previous,
    Close,
}

pub struct FindBar {
    input: Entity<InputState>,
    transcript: Entity<Transcript>,
    /// The query last reported.
    last: String,
    _input: Subscription,
}

impl EventEmitter<FindBarEvent> for FindBar {}

impl FindBar {
    pub fn new(transcript: Entity<Transcript>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in chat"));
        let subscription = cx.subscribe(&input, |this: &mut Self, input, event: &InputEvent, cx| match event {
            // The field also reports a change on Enter with the text as it was: only new text searches again.
            InputEvent::Change => {
                let query = input.read(cx).value().to_string();
                if query != this.last {
                    this.last = query.clone();
                    cx.emit(FindBarEvent::Query(query));
                }
            }
            InputEvent::PressEnter { shift, .. } => cx.emit(if *shift { FindBarEvent::Previous } else { FindBarEvent::Next }),
            _ => {}
        });
        Self { input, transcript, last: String::new(), _input: subscription }
    }

    pub fn query(&self, cx: &gpui::App) -> String {
        self.input.read(cx).value().to_string()
    }

    /// ⌘F: focus the field and select its text, so typing replaces the last search; `seed` replaces the text.
    pub fn focus_and_select(&mut self, seed: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |state, cx| {
            if let Some(seed) = seed {
                state.set_value(seed.to_string(), window, cx);
            }
            state.focus(window, cx);
            state.select_all(window, cx);
        });
        if let Some(seed) = seed.filter(|seed| *seed != self.last) {
            self.last = seed.to_string();
            cx.emit(FindBarEvent::Query(seed.to_string()));
        }
    }

    fn icon_button(
        &self,
        id: &'static str,
        icon: IconName,
        tooltip: Tooltip,
        disabled: bool,
        event: FindBarEvent,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let bar = cx.weak_entity();
        div().id(SharedString::from(format!("{id}-tip"))).tooltip(tooltip.build()).child(
            IconButton::new(id, icon).size(IconButtonSize::S24).disabled(disabled).on_click(move |_, _, cx| {
                bar.update(cx, |_, cx| cx.emit(event.clone())).ok();
            }),
        )
    }
}

impl Focusable for FindBar {
    fn focus_handle(&self, cx: &gpui::App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

/// How far below its place the bar starts its `fade-up`.
const FADE_UP: f32 = 8.0;

impl Render for FindBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let (label, total) = {
            let transcript = self.transcript.read(cx);
            (transcript.find_label(), transcript.find_status().map_or(0, |(_, total)| total))
        };
        let field = WidgetInput::new(&self.input)
            .with_size(gpui_component::Size::Small)
            .appearance(false)
            .focus_bordered(false)
            .h(px(FIELD_HEIGHT))
            .px_0()
            .text_size(px(TEXT_13.size))
            .text_color(theme.ink);
        let bar = div()
            .debug_selector(|| "find-bar".into())
            .absolute()
            .top(px(BAR_TOP))
            .right(px(BAR_RIGHT))
            .flex()
            .items_center()
            .gap(px(GAP))
            .py(px(PAD))
            .pr(px(PAD))
            .pl(px(PAD_LEFT))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .occlude()
            // Escape closes, wherever focus is in the bar (before the field's own Escape).
            .capture_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && !event.keystroke.modifiers.modified() {
                    cx.stop_propagation();
                    cx.emit(FindBarEvent::Close);
                }
            }))
            .child(div().debug_selector(|| "find-field".into()).w(px(FIELD_WIDTH)).child(field))
            .child(
                div()
                    .debug_selector(|| "find-count".into())
                    .min_w(px(COUNT_MIN_WIDTH))
                    .flex()
                    .justify_end()
                    .whitespace_nowrap()
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child(label),
            )
            .child(self.icon_button(
                "find-previous",
                IconName::ArrowUp01,
                Tooltip::new("Previous match"),
                total == 0,
                FindBarEvent::Previous,
                cx,
            ))
            .child(self.icon_button(
                "find-next",
                IconName::ArrowDown01,
                Tooltip::new("Next match").shortcut("⌘G"),
                total == 0,
                FindBarEvent::Next,
                cx,
            ))
            .child(self.icon_button("find-close", IconName::Cancel01, Tooltip::new("Close"), false, FindBarEvent::Close, cx));
        let enter = crate::ui::scaled(crate::ui::ease::DURATION_BASE);
        if enter.is_zero() {
            return bar.into_any_element();
        }
        bar.with_animation("find-bar-fade-up", Animation::new(enter).with_easing(crate::ui::ease::ease_out), |bar, t| {
            bar.opacity(t).top(px(BAR_TOP + FADE_UP * (1.0 - t)))
        })
        .into_any_element()
    }
}

// ---- The Chat column's side: ⌘F, ⌘G, the bar's events, the Quote button ----

gpui::actions!(milagre_gpui_chat, [FindInChat, FindNext, FindPrevious, QuoteSelection]);

/// The key context of the Chat column: its shortcuts work while focus is anywhere in it (composer, transcript, bar).
pub const KEY_CONTEXT: &str = "ChatColumn";

/// ⌘F and ⇧⌘' from the effective key table (`chat.find`, `chat.quote`), ⌘G and ⇧⌘G as the desktop's find bar
/// hard-codes them; once per app.
pub fn install_keys(cx: &mut gpui::App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    let rules = default_keybindings();
    let mut keys =
        vec![KeyBinding::new("cmd-g", FindNext, Some(KEY_CONTEXT)), KeyBinding::new("cmd-shift-g", FindPrevious, Some(KEY_CONTEXT))];
    for binding in gpui_bindings(&rules, cfg!(target_os = "macos"), GpuiOptions::default()) {
        // GPUI keeps a binding's strings for the life of the app; these two are installed once.
        let stroke: &'static str = binding.keystroke.clone().leak();
        match binding.command.as_str() {
            "chat.find" => keys.push(KeyBinding::new(stroke, FindInChat, Some(KEY_CONTEXT))),
            "chat.quote" => keys.push(KeyBinding::new(stroke, QuoteSelection, Some(KEY_CONTEXT))),
            _ => {}
        }
    }
    cx.bind_keys(keys);
}

/// The quote shortcut's label for the button ("⇧⌘'").
fn quote_shortcut() -> Option<SharedString> {
    let rules = default_keybindings();
    primary_key_for(&rules, "chat.quote", None).and_then(|key| key_label_for(key, cfg!(target_os = "macos"))).map(SharedString::from)
}

/// The Chat column's find and quote state.
#[derive(Default)]
pub struct ChatFind {
    bar: Option<Entity<FindBar>>,
    _bar: Option<Subscription>,
    /// Where focus was when the bar opened; it goes back there on close.
    return_to: Option<FocusHandle>,
    /// The passage the selection offers, with the list's scroll position when it was offered.
    passage: Option<(Passage, ListOffset)>,
    /// Snapshot seed (never in tests): `MILAGRE_GPUI_FIND=<query>` opens the bar with it on the first frame.
    seed: Option<String>,
    /// The transcript's bounds last frame, in window coordinates: the Quote button stays inside them.
    area: Rc<Cell<Bounds<Pixels>>>,
}

impl ChatFind {
    pub fn from_env() -> Self {
        Self { seed: std::env::var("MILAGRE_GPUI_FIND").ok().filter(|query| !query.is_empty()), ..Self::default() }
    }

    pub fn bar(&self) -> Option<&Entity<FindBar>> {
        self.bar.as_ref()
    }

    pub fn passage(&self) -> Option<&Passage> {
        self.passage.as_ref().map(|(passage, _)| passage)
    }
}

impl ChatView {
    /// ⌘F: opens the bar, or refocuses it and selects its text. `seed` replaces the query (a ⌘K message result).
    pub fn open_find(&mut self, seed: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        let bar = match &self.find.bar {
            Some(bar) => bar.clone(),
            None => {
                self.find.return_to = window.focused(cx);
                let transcript = self.transcript.clone();
                let bar = cx.new(|cx| FindBar::new(transcript, window, cx));
                let subscription = cx.subscribe_in(&bar, window, |this, _, event: &FindBarEvent, window, cx| match event {
                    FindBarEvent::Query(query) => this.transcript.update(cx, |transcript, cx| transcript.set_find_query(query, cx)),
                    FindBarEvent::Next => this.transcript.update(cx, |transcript, cx| transcript.step_find(1, cx)),
                    FindBarEvent::Previous => this.transcript.update(cx, |transcript, cx| transcript.step_find(-1, cx)),
                    FindBarEvent::Close => this.close_find(window, cx),
                });
                // The transcript's matches start empty: the bar opens with no query.
                self.transcript.update(cx, |transcript, cx| transcript.set_find_query("", cx));
                self.find.bar = Some(bar.clone());
                self.find._bar = Some(subscription);
                bar
            }
        };
        bar.update(cx, |bar, cx| bar.focus_and_select(seed, window, cx));
        cx.notify();
    }

    /// Escape or the close button: the highlights go and focus goes back where it was (the composer by default).
    pub fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.bar.take().is_none() {
            return;
        }
        self.find._bar = None;
        self.transcript.update(cx, |transcript, cx| transcript.close_find(cx));
        let back = self.find.return_to.take().unwrap_or_else(|| self.composer.focus_handle(cx));
        window.focus(&back, cx);
        cx.notify();
    }

    pub fn find_open(&self) -> bool {
        self.find.bar.is_some()
    }

    pub fn find_bar(&self) -> Option<&Entity<FindBar>> {
        self.find.bar()
    }

    /// The passage the Quote button offers now.
    pub fn passage(&self) -> Option<&Passage> {
        self.find.passage()
    }

    /// Quote (the button or ⇧⌘'): the passage goes to the composer as a quote chip and the selection goes.
    pub fn quote_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((passage, _)) = self.find.passage.take() else { return };
        self.composer.update(cx, |composer, cx| composer.add_quote(&passage.text, Some(&passage.source), cx));
        TextSelection::clear(window, cx);
        cx.notify();
    }

    pub(super) fn on_transcript_event(&mut self, event: &TranscriptEvent, cx: &mut Context<Self>) {
        match event {
            TranscriptEvent::Passage(passage) => {
                let scroll = self.transcript.read(cx).list_state().logical_scroll_top();
                let next = passage.clone().map(|passage| (passage, scroll));
                if self.find.passage != next {
                    self.find.passage = next;
                    cx.notify();
                }
            }
        }
    }

    /// The column's find and quote handlers, on its root element.
    pub(super) fn find_actions<E: InteractiveElement>(&self, element: E, cx: &mut Context<Self>) -> E {
        element
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(|this, _: &FindInChat, window, cx| this.open_find(None, window, cx)))
            .on_action(cx.listener(|this, _: &FindNext, _, cx| {
                if this.find.bar.is_some() {
                    this.transcript.update(cx, |transcript, cx| transcript.step_find(1, cx));
                } else {
                    cx.propagate();
                }
            }))
            .on_action(cx.listener(|this, _: &FindPrevious, _, cx| {
                if this.find.bar.is_some() {
                    this.transcript.update(cx, |transcript, cx| transcript.step_find(-1, cx));
                } else {
                    cx.propagate();
                }
            }))
            .on_action(cx.listener(|this, _: &QuoteSelection, window, cx| {
                if this.find.passage.is_some() {
                    this.quote_selection(window, cx);
                } else {
                    cx.propagate();
                }
            }))
    }

    /// Escape with focus in the transcript: the Quote button goes, then the bar closes (the desktop's window-wide
    /// Escape closes the bar when nothing else took it; the composer keeps its own Escape for its menu).
    pub(super) fn on_transcript_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key != "escape" || event.keystroke.modifiers.modified() {
            return;
        }
        if self.find.passage.take().is_some() {
            cx.notify();
        }
        if self.find.bar.is_some() {
            cx.stop_propagation();
            self.close_find(window, cx);
        }
    }

    /// What floats over the transcript: the find bar and the Quote button. Also opens the snapshot seed's bar, and
    /// drops the Quote button once the list scrolled from where it was offered (the desktop hides it on scroll).
    pub(super) fn find_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if let Some(seed) = self.find.seed.take() {
            self.open_find(Some(&seed), window, cx);
        }
        let scroll = self.transcript.read(cx).list_state().logical_scroll_top();
        if self.find.passage.as_ref().is_some_and(|(_, at)| *at != scroll) {
            self.find.passage = None;
        }
        let area = self.find.area.clone();
        let mut overlays: Vec<AnyElement> =
            vec![canvas(move |bounds, _, _| area.set(bounds), |_, _, _, _| {}).absolute().top_0().left_0().size_full().into_any_element()];
        if let Some(bar) = &self.find.bar {
            overlays.push(bar.clone().into_any_element());
        }
        if let Some((passage, _)) = &self.find.passage {
            let area = self.find.area.get();
            let origin = button_origin(passage.at, area);
            let view = cx.weak_entity();
            let theme = *cx.theme();
            overlays.push(
                quote_button(origin, quote_shortcut(), &theme, move |_, window, cx| {
                    view.update(cx, |this, cx| this.quote_selection(window, cx)).ok();
                })
                .into_any_element(),
            );
        }
        overlays
    }
}
