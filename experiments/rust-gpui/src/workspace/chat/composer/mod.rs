//! The composer (`PromptComposer.tsx` and `PromptEditor.tsx`): quote chips, the prompt editor, the send row, and the
//! `@` and `/` menu above it.
//!
//! - `editor.rs`: gpui-component's text area over the prompt string; chips are its atomic tokens, re-derived from
//!   the string after every edit with `logic::prompts`; our own undo history (`history.rs`).
//! - `chips.rs`: what each chip shows and how it looks (`PromptChip.tsx`).
//! - `menu.rs`: the trigger token at the caret, the menu's rows and its panel.
//! - `mentions.rs`: the files, Chats, computers and skills the chips and menus read, behind [`MentionSource`].
//!
//! Keys: the composer catches the text area's actions before it sees them (`capture_action`): Enter sends (or
//! picks a menu row; Shift+Enter is a newline; nothing during an IME composition), Tab picks a row or takes the
//! suggestion, Up and Down move the menu highlight or step through sent prompts from the first or last line, ⌘Z
//! and ⇧⌘Z (and Ctrl+Y) replay our history, a paste of images or files becomes an event. Escape closes the menu,
//! else it goes on to the window (where it will stop the running turn).
//!
//! WP-25 (the bar and what it sends): `bar.rs` is the bottom row (attach, permission and model chips, context slot,
//! mic, send or stop), `send.rs` the send decision table, the outgoing message and the sink trait, `attachments.rs`
//! the tray, `queue.rs` the queued messages docked above the composer.
//!
//! Seams for later packages: [`ComposerAttachment`] events (pasted and dropped files also go to the tray here, which
//! then calls [`Composer::insert_image_mentions`]); [`Composer::set_mentions`], [`Composer::set_image_count`],
//! [`Composer::set_can_undo`], [`Composer::set_suggestion`], [`Composer::set_prompt_history`],
//! [`Composer::add_quote`] and [`Composer::set_text`] (drafts) take real data; [`Composer::set_sink`],
//! [`Composer::set_running`], [`Composer::set_model`], [`Composer::set_queue`] and friends take the Chat's state.

mod attachments;
mod bar;
#[cfg(test)]
mod bar_tests;
mod chips;
pub(crate) mod context;
mod editor;
mod external;
mod history;
mod mentions;
mod menu;
mod model_picker;
mod models;
pub mod new_chat;
mod permission;
mod pick_list;
#[cfg(test)]
mod picker_tests;
mod queue;
mod send;
#[cfg(test)]
mod tests;

use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    App, ClickEvent, ClipboardEntry, Context, Entity, EntityInputHandler, EventEmitter, ExternalPaths, FocusHandle, Focusable, Global,
    Image, KeyBinding, Pixels, SharedString, Subscription, UTF16Selection, Window, div, prelude::*, px,
};
use gpui_component::input::{
    Cut, Enter, Escape, IndentInline, InputEvent, MoveDown, MoveUp, OutdentInline, Paste, Redo, Textarea, TextareaState, Undo,
};

pub use attachments::{Attachment, AttachmentKind, ERROR_PASTE, ERROR_SIZE, ERROR_TYPE, MAX_ATTACHMENT_BYTES, Tray};
pub use bar::{BarState, permission_label};
pub use chips::{CHIP_EM, ChipKind};
pub use history::EditKind;
pub use mentions::{FixtureMentions, MentionSource, SkillOption, SkillScope};
pub use menu::{MenuKind, PromptToken, prompt_token};
pub use queue::{Queue, QueuedEntry};
pub use send::{Delivery, FixtureSink, MessageSink, OutgoingAttachment, OutgoingImage, OutgoingMessage, SendAction, SendState, SinkCall};

use editor::{Catalog, PromptEditor};
use menu::{MenuState, OpenMenu, Pick, insert_prompt_token, menu_footer, menu_rows, skill_names};

use crate::logic::copy::js;
use crate::logic::prompts::mentions::{PROMPT_PLACEHOLDER, mentioned_images, shift_image_mentions};
use crate::logic::prompts::parts::{
    ComposerQuote, composer_quote, format_chat_mention, format_computer_mention, format_file_mention, quoted_message,
};
use crate::theme::{
    ActiveTheme, CONTROL_MD, CONTROL_XS, RADIUS_CONTROL, RADIUS_INLINE, RADIUS_WINDOW, TEXT_11, TEXT_12, TextStepExt, Theme,
};
use crate::ui::Glass;
use crate::ui::glass::GLASS_COMPOSER_FILL;
use crate::ui::{Icon, IconName, IconSize};

/// The prompt's text: the Chat size plus one on a 20px line (`text-[calc(var(--chat-size)+1px)] leading-5`).
pub fn prompt_text_size() -> f32 {
    crate::theme::prompt_text_size()
}
pub const PROMPT_LINE_HEIGHT: f32 = 20.0;
/// The prompt box: 68 at rest (`min-h-[68px]`), growing with its lines to 100 (`maxHeight={100}`), then scrolling.
const EDITOR_MIN_HEIGHT: f32 = 68.0;
const EDITOR_MAX_HEIGHT: f32 = 100.0;
/// The text area's inset (gpui-component's medium field: 8 above and below, 10 at the sides; the desktop's
/// `px-2 py-2` with the composer's 12, so the text sits 20 in on both).
const EDITOR_PAD_Y: f32 = 8.0;
const EDITOR_PAD_X: f32 = 10.0;
/// Rows the text area grows to before the box caps it: four rows and the insets are 96; past them the box is 100
/// and the text scrolls.
pub const MAX_ROWS: usize = 4;
/// The composer's padding (`p-3`); at the sides less the text area's 2px-wider inset.
const FRAME_PAD: f32 = 12.0;
const FRAME_PAD_X: f32 = FRAME_PAD - (EDITOR_PAD_X - 8.0);
/// Between quotes, prompt and send row (`gap-y-1.5`).
const ROW_GAP: f32 = 6.0;
/// The send row's height (`CONTROL_SM`) for the composer's resting height.
const SEND_ROW_HEIGHT: f32 = 28.0;
/// The composer at rest: padding, the 68px prompt, the gap and the 28px send row.
pub const COMPOSER_MIN_HEIGHT: f32 = 2.0 * FRAME_PAD + EDITOR_MIN_HEIGHT + ROW_GAP + SEND_ROW_HEIGHT;
/// Quote chips: rows 32 high (`h-8`), the list at most 120 (`max-h-30`), inset 10 (`pl-2.5`).
const QUOTES_MAX_HEIGHT: f32 = 120.0;
const QUOTE_PAD_LEFT: f32 = 10.0;
/// Between the docked queue and the composer's box (`mb-2`).
const QUEUE_GAP: f32 = 8.0;
const KEY_CONTEXT: &str = "Composer";
pub const PLACEHOLDER: &str = PROMPT_PLACEHOLDER;

pub enum ComposerEvent {
    /// The message to send now (idle, or steering the running turn): quotes as blockquotes, then the prompt.
    Send(SharedString),
    /// The message waits for the running turn: it is in the composer's queue (`Composer::queued`).
    Queued(SharedString),
    /// The send button was Stop: the running turn should end.
    Stop,
    /// Compact now was pressed on the context card: send `/compact`.
    Compact,
}

/// Attachments the composer hands to the tray (WP-25). `at` is the selection the paste or drop replaced, where
/// the uploaded images' `[Image #N]` mentions go (`insert_image_mentions`).
#[derive(Clone, Debug)]
pub enum ComposerAttachment {
    Pasted {
        images: Vec<Image>,
        paths: Vec<PathBuf>,
        at: Range<usize>,
    },
    Dropped {
        paths: Vec<PathBuf>,
        at: Range<usize>,
    },
    /// An image chip was deleted from the text: its image goes, and the mentions after it were renumbered.
    ImageRemoved(u64),
    /// An image chip or an image tile was clicked: preview that image (1-based).
    OpenImage(u64),
    /// A file tile was clicked: preview that file.
    OpenFile(PathBuf),
}

pub struct Composer {
    focus_handle: FocusHandle,
    editor: Option<PromptEditor>,
    /// The text area's text this frame, marked IME text included (the draft is `editor.value()`).
    shown: String,
    source: Rc<dyn MentionSource>,
    image_count: usize,
    can_undo: bool,
    quotes: Vec<ComposerQuote>,
    /// Prompts sent in this Chat, oldest first (`chatHistory`'s `promptHistory`).
    prompt_history: Vec<String>,
    /// Where Up and Down stand in `prompt_history`, and the draft to restore past its newest entry.
    browsing: Option<(usize, String)>,
    suggestion: Option<SharedString>,
    menu: MenuState,
    prefill: Option<(String, Option<Range<usize>>)>,
    /// A highlighted row for a snapshot, applied once the prefilled menu is open.
    prefill_active: Option<usize>,
    /// `MILAGRE_GPUI_COMPOSER_BAR`: a snapshot's seeded bar state (`bar.rs` `seed_demo`).
    demo: Option<String>,
    tray: attachments::Tray,
    queue: queue::Queue,
    bar: bar::BarState,
    new_chat: Option<new_chat::NewChat>,
    /// The first Chat's starter tasks (`starters` in `ChatComposer.tsx`), over the tray of an empty new Chat.
    starters: Vec<crate::onboarding::model::Starter>,
    sink: Option<Rc<dyn MessageSink>>,
    /// The context ring's keyboard focus, and the pending open or close of its card (`ContextRing.tsx`).
    context_focus: gpui::FocusHandle,
    context_pointer: Option<gpui::Task<()>>,
    context_card_hovered: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ComposerEvent> for Composer {}
impl EventEmitter<ComposerAttachment> for Composer {}

impl Focusable for Composer {
    /// The text area's, once it exists; until the first frame the composer's own, which hands focus on.
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.as_ref().map_or_else(|| self.focus_handle.clone(), |editor| editor.state.focus_handle(cx))
    }
}

struct ComposerKeys;
impl Global for ComposerKeys {}

/// Ctrl+Y redoes, as on the desktop (the text area binds it only off macOS).
pub fn bind_keys(cx: &mut App) {
    if cx.has_global::<ComposerKeys>() {
        return;
    }
    cx.set_global(ComposerKeys);
    cx.bind_keys([KeyBinding::new("ctrl-y", Redo, Some(KEY_CONTEXT))]);
}

fn env_prefill() -> Option<(String, Option<Range<usize>>)> {
    let text = std::env::var("MILAGRE_GPUI_COMPOSER_TEXT").ok()?.replace("\\n", "\n");
    let select = std::env::var("MILAGRE_GPUI_COMPOSER_SELECT").ok().and_then(|range| {
        let (start, end) = range.split_once("..")?;
        Some(start.parse().ok()?..end.parse().ok()?)
    });
    Some((text, select))
}

impl Composer {
    /// Empty, unless `MILAGRE_GPUI_COMPOSER_TEXT` prefills it for a snapshot (`\n` for a newline), with
    /// `MILAGRE_GPUI_COMPOSER_SELECT=<start>..<end>` (bytes), `MILAGRE_GPUI_COMPOSER_IMAGES=<n>` attached images,
    /// `MILAGRE_GPUI_COMPOSER_QUOTE=<passage>`, `MILAGRE_GPUI_COMPOSER_ACTIVE=<row>` (a highlighted menu row) and
    /// `MILAGRE_GPUI_COMPOSER_BAR=1|stop` (a running Chat with a tray and a queue, or with the Stop button).
    pub fn new(cx: &mut Context<Self>) -> Self {
        bind_keys(cx);
        let env = |name: &str| std::env::var(name).ok();
        let quotes =
            env("MILAGRE_GPUI_COMPOSER_QUOTE").and_then(|passage| composer_quote(&passage, Some("Claude reply"))).into_iter().collect();
        let menu = MenuState::default();
        // `MILAGRE_GPUI_COMPOSER_OPEN=<popover>[,tray]`: a snapshot opens a picker (`model`, `permission`, `context`,
        // `project`, `computer`, `isolation`, `branch`) and/or the new-Chat tray.
        let mut bar = bar::BarState::default();
        let mut new_chat = None;
        let mut starters = Vec::new();
        for part in env("MILAGRE_GPUI_COMPOSER_OPEN").unwrap_or_default().split(',') {
            match part {
                "tray" => new_chat = Some(new_chat::NewChat::fixture()),
                "starters" => {
                    new_chat = Some(new_chat::NewChat::fixture());
                    starters = crate::onboarding::model::first_chat_starters("milagre-ade");
                }
                "model" => bar.open = Some("composer-model"),
                "permission" => bar.open = Some("composer-permission"),
                "context" => bar.open = Some("composer-context"),
                "project" | "computer" | "isolation" | "branch" => {
                    new_chat = Some(new_chat::NewChat::fixture());
                    bar.open = Some(match part {
                        "project" => "new-chat-project",
                        "computer" => "new-chat-computer",
                        "isolation" => "new-chat-isolation",
                        _ => "new-chat-branch",
                    });
                }
                _ => {}
            }
        }
        if bar.open == Some("composer-context") || env("MILAGRE_GPUI_COMPOSER_OPEN").is_some_and(|v| v.contains("context")) {
            bar.context = Some((146_000.0, 200_000.0));
        }
        Self {
            focus_handle: cx.focus_handle(),
            editor: None,
            shown: String::new(),
            source: Rc::new(FixtureMentions::default()),
            image_count: env("MILAGRE_GPUI_COMPOSER_IMAGES").and_then(|n| n.parse().ok()).unwrap_or(0),
            can_undo: true,
            quotes,
            prompt_history: Vec::new(),
            browsing: None,
            suggestion: None,
            menu,
            prefill: env_prefill(),
            prefill_active: env("MILAGRE_GPUI_COMPOSER_ACTIVE").and_then(|row| row.parse().ok()),
            demo: env("MILAGRE_GPUI_COMPOSER_BAR"),
            tray: attachments::Tray::default(),
            queue: queue::Queue::default(),
            bar,
            new_chat,
            starters,
            sink: None,
            context_focus: cx.focus_handle(),
            context_pointer: None,
            context_card_hovered: false,
            _subscriptions: Vec::new(),
        }
    }

    /// The draft as the text area shows it (an open IME composition included).
    pub fn text(&self) -> &str {
        &self.shown
    }

    pub fn selected_range(&self) -> Range<usize> {
        self.editor.as_ref().map_or(0..0, PromptEditor::selection)
    }

    pub fn marked_range(&self) -> Option<Range<usize>> {
        self.editor.as_ref().and_then(PromptEditor::marked)
    }

    /// The text area, for tests and for wiring that needs the field itself.
    pub fn input(&self) -> Option<&Entity<TextareaState>> {
        self.editor.as_ref().map(|editor| &editor.state)
    }

    pub fn quotes(&self) -> &[ComposerQuote] {
        &self.quotes
    }

    /// The menu the caret opens this frame, if any.
    pub fn open_menu(&self) -> Option<OpenMenu> {
        let editor = self.editor.as_ref()?;
        if self.menu.dismissed || editor.marked().is_some() {
            return None;
        }
        let token = prompt_token(editor.value(), editor.selection().start)?;
        let rows = menu_rows(&token, &*self.source, self.can_undo);
        Some(OpenMenu { footer: menu_footer(token.kind, &*self.source), token, rows })
    }

    pub fn menu_state(&self) -> (usize, bool) {
        (self.menu.active, self.menu.engaged)
    }

    // ---- Seams ----

    pub fn set_mentions(&mut self, source: Rc<dyn MentionSource>, window: &mut Window, cx: &mut Context<Self>) {
        self.source = source;
        self.resync(window, cx);
    }

    pub fn set_image_count(&mut self, count: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.image_count = count;
        self.resync(window, cx);
    }

    /// Whether the Chat is saved, so `/undo` is offered.
    pub fn set_can_undo(&mut self, can_undo: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.can_undo = can_undo;
        self.resync(window, cx);
    }

    /// A predicted follow-up, offered in an empty composer (Tab takes it).
    pub fn set_suggestion(&mut self, suggestion: Option<SharedString>, cx: &mut Context<Self>) {
        self.suggestion = suggestion;
        cx.notify();
    }

    /// Prompts sent in this Chat, oldest first; Up and Down step through them.
    pub fn set_prompt_history(&mut self, history: Vec<String>) {
        self.prompt_history = history;
        self.browsing = None;
    }

    /// A passage quoted into the next message (the transcript's Quote button).
    pub fn add_quote(&mut self, passage: &str, source: Option<&str>, cx: &mut Context<Self>) {
        if let Some(quote) = composer_quote(passage, source) {
            self.quotes.push(quote);
            cx.notify();
        }
    }

    pub fn remove_quote(&mut self, id: &str, cx: &mut Context<Self>) {
        self.quotes.retain(|quote| quote.id != id);
        cx.notify();
    }

    /// The first Chat's starter tasks for a Project named `name`, shown over an empty new Chat until one is picked, the
    /// Chat is left, or something is typed (`firstChat === project.path` in `App.tsx`).
    pub fn set_starters(&mut self, name: Option<&str>, cx: &mut Context<Self>) {
        self.starters = name.map(crate::onboarding::model::first_chat_starters).unwrap_or_default();
        cx.notify();
    }

    pub fn starters(&self) -> &[crate::onboarding::model::Starter] {
        &self.starters
    }

    /// A starter picked: its prompt is sent as the first message and the starters go (`onPick`).
    fn pick_starter(&mut self, prompt: String, window: &mut Window, cx: &mut Context<Self>) {
        self.starters.clear();
        self.set_text(&prompt, window, cx);
        self.submit(window, cx);
        cx.notify();
    }

    fn render_starters(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let composer = cx.entity().downgrade();
        crate::onboarding::FirstChatStarters::new(self.starters.clone(), move |starter, window, cx| {
            let prompt = starter.prompt.clone();
            composer.update(cx, |composer, cx| composer.pick_starter(prompt, window, cx)).ok();
        })
    }

    /// Restores a draft (a Chat switch, a saved draft): a new history, the caret at the end.
    pub fn set_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_editor(window, cx);
        let end = text.len();
        self.put(text.to_string(), end..end, None, window, cx);
        if let Some(editor) = self.editor.as_mut() {
            editor.clear_history();
        }
    }

    /// The tray's uploads came back as these 1-based image indices: their `[Image #N]` mentions go in at `at`, or at
    /// the caret when the draft changed meanwhile (`insertImages`).
    pub fn insert_image_mentions(&mut self, indices: &[u64], at: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_ref() else { return };
        self.image_count = self.image_count.max(indices.iter().copied().max().unwrap_or(0) as usize);
        let (value, caret) = menu::insert_image_mentions(editor.value(), indices, at);
        self.put(value, caret..caret, Some(EditKind::Chip), window, cx);
    }

    // ---- The editor ----

    fn catalog_skills(&self) -> Vec<String> {
        skill_names(&*self.source, self.can_undo)
    }

    /// The text area is made on the first frame (it needs the window, and the Chat view makes the composer
    /// without one).
    fn ensure_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editor.is_some() {
            return;
        }
        self.watch_context_focus(window, cx);
        let editor = PromptEditor::new(window, cx);
        let state = editor.state.clone();
        self._subscriptions.push(cx.subscribe_in(&state, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::Change = event {
                this.text_changed(window, cx);
            }
        }));
        self._subscriptions.push(cx.observe_in(&state, window, |this, state, window, cx| {
            this.shown = state.read(cx).value().to_string();
            if let Some(editor) = this.editor.as_mut() {
                editor.observe(window, cx);
            }
        }));
        // Focus given to the composer goes to its text area.
        self._subscriptions.push(cx.on_focus(&self.focus_handle, window, |this, window, cx| {
            if let Some(editor) = this.editor.as_ref() {
                window.focus(&editor.state.focus_handle(cx), cx);
            }
        }));
        self.editor = Some(editor);
        if let Some((text, select)) = self.prefill.take() {
            let end = text.len();
            let select = select.filter(|range| {
                range.start <= range.end && range.end <= end && text.is_char_boundary(range.start) && text.is_char_boundary(range.end)
            });
            self.put(text, select.unwrap_or(end..end), None, window, cx);
        }
        if let Some(mode) = self.demo.take() {
            self.seed_demo(&mode, window, cx);
        }
    }

    /// Puts a draft in from outside, recording `kind` as one undo step.
    fn put(&mut self, value: String, selection: Range<usize>, kind: Option<EditKind>, window: &mut Window, cx: &mut Context<Self>) {
        let skills = self.catalog_skills();
        let now = cx.background_executor().now();
        let catalog = Catalog { source: &*self.source, skills: &skills, images: self.image_count };
        let Some(editor) = self.editor.as_mut() else { return };
        editor.set(value, selection, kind.map(|kind| (kind, now)), &catalog, window, cx);
        self.shown = editor.value().to_string();
        cx.notify();
    }

    /// Chips again after what they read changed.
    fn resync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let skills = self.catalog_skills();
        let catalog = Catalog { source: &*self.source, skills: &skills, images: self.image_count };
        if let Some(editor) = self.editor.as_mut() {
            editor.sync_tokens(&catalog, window, cx);
        }
        cx.notify();
    }

    /// The text area changed the text: record it, drop the images whose chips went, make the chips match.
    fn text_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let skills = self.catalog_skills();
        let now = cx.background_executor().now();
        let source = self.source.clone();
        let Some(editor) = self.editor.as_mut() else { return };
        let catalog = Catalog { source: &*source, skills: &skills, images: self.image_count };
        if let Some(previous) = editor.text_changed(&catalog, now, cx) {
            self.menu.dismissed = false;
            // Deleting an image's chip removes the image too, and renumbers the chips after it.
            let after = mentioned_images(editor.value(), self.image_count);
            let mut removed: Vec<u64> =
                mentioned_images(&previous, self.image_count).into_iter().filter(|index| !after.contains(index)).collect();
            removed.sort_unstable_by(|a, b| b.cmp(a));
            if !removed.is_empty() {
                let mut value = editor.value().to_string();
                for index in &removed {
                    cx.emit(ComposerAttachment::ImageRemoved(*index));
                    self.tray.remove_image_number(*index);
                    value = shift_image_mentions(&value, *index);
                }
                self.image_count = self.image_count.saturating_sub(removed.len());
                let caret = editor.selection().start.min(value.len());
                let caret = (0..=caret).rev().find(|at| value.is_char_boundary(*at)).unwrap_or(0);
                let catalog = Catalog { source: &*source, skills: &skills, images: self.image_count };
                editor.set(value, caret..caret, None, &catalog, window, cx);
            }
        }
        let catalog = Catalog { source: &*source, skills: &skills, images: self.image_count };
        editor.sync_tokens(&catalog, window, cx);
        self.shown = editor.value().to_string();
        cx.notify();
    }

    fn composing(&self) -> bool {
        self.editor.as_ref().is_some_and(|editor| editor.marked().is_some())
    }

    // ---- Keys ----

    fn on_enter(&mut self, action: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        // An IME composition commits on Enter; Shift+Enter is a newline.
        if self.composing() || action.shift {
            return;
        }
        cx.stop_propagation();
        if !self.pick_active(window, cx) {
            self.submit(window, cx);
        }
    }

    fn on_tab(&mut self, _: &IndentInline, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        if self.pick_active(window, cx) {
            return;
        }
        if let Some(suggestion) = self.visible_suggestion()
            && self.selected_range() == (0..0)
        {
            let end = suggestion.len();
            self.put(suggestion.to_string(), end..end, Some(EditKind::Chip), window, cx);
            return;
        }
        window.focus_next(cx);
    }

    fn on_shift_tab(&mut self, _: &OutdentInline, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        window.focus_prev(cx);
    }

    fn on_up(&mut self, _: &MoveUp, window: &mut Window, cx: &mut Context<Self>) {
        if self.move_highlight(-1, cx) || self.recall(true, window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_down(&mut self, _: &MoveDown, window: &mut Window, cx: &mut Context<Self>) {
        if self.move_highlight(1, cx) || self.recall(false, window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_undo(&mut self, _: &Undo, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        self.step(false, window, cx);
    }

    fn on_redo(&mut self, _: &Redo, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        self.step(true, window, cx);
    }

    fn step(&mut self, redo: bool, window: &mut Window, cx: &mut Context<Self>) {
        let skills = self.catalog_skills();
        let catalog = Catalog { source: &*self.source, skills: &skills, images: self.image_count };
        let Some(editor) = self.editor.as_mut() else { return };
        if editor.step(redo, &catalog, window, cx) {
            self.shown = editor.value().to_string();
            self.menu.dismissed = false;
            cx.notify();
        }
    }

    /// Images and files on the clipboard go to the tray; text pastes as plain text with its line endings as `\n`.
    fn on_paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else { return };
        let mut images = Vec::new();
        let mut paths = Vec::new();
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(image) => images.push(image.clone()),
                ClipboardEntry::ExternalPaths(external) => paths.extend(external.paths().iter().cloned()),
                ClipboardEntry::String(_) => {}
            }
        }
        if !images.is_empty() || !paths.is_empty() {
            cx.stop_propagation();
            let at = self.selected_range();
            cx.emit(ComposerAttachment::Pasted { images: images.clone(), paths: paths.clone(), at: at.clone() });
            self.attach_pasted(images, at.clone(), window, cx);
            self.attach_paths(paths, at, window, cx);
            return;
        }
        let Some(editor) = self.editor.as_mut() else { return };
        editor.pending_kind = Some(EditKind::Paste);
        if let Some(text) = item.text().filter(|text| text.contains('\r')) {
            cx.stop_propagation();
            let text = text.replace("\r\n", "\n").replace('\r', "\n");
            editor.state.update(cx, |state, cx| state.replace(text, window, cx));
        }
    }

    fn on_cut(&mut self, _: &Cut, _: &mut Window, _: &mut Context<Self>) {
        if let Some(editor) = self.editor.as_mut() {
            editor.pending_kind = Some(EditKind::Other);
        }
    }

    /// After the text area: Escape closes the menu; with no menu it goes on to the window.
    fn on_escape(&mut self, _: &Escape, _: &mut Window, cx: &mut Context<Self>) {
        if self.open_menu().is_some() {
            self.menu.dismissed = true;
            cx.notify();
        } else {
            cx.propagate();
        }
    }

    fn on_drop(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.selected_range();
        cx.emit(ComposerAttachment::Dropped { paths: paths.paths().to_vec(), at: at.clone() });
        self.attach_paths(paths.paths().to_vec(), at, window, cx);
    }

    // ---- Menu ----

    /// Moves the highlight (wrapping) while the menu has rows.
    fn move_highlight(&mut self, delta: isize, cx: &mut Context<Self>) -> bool {
        let Some(menu) = self.open_menu().filter(|menu| !menu.rows.is_empty()) else { return false };
        let len = menu.rows.len() as isize;
        self.menu.follow(&menu.token);
        self.menu.active = (self.menu.active as isize + delta).rem_euclid(len) as usize;
        self.menu.engaged = true;
        self.menu.scroll.scroll_to_item(menu::child_index(&menu, self.menu.active));
        cx.notify();
        true
    }

    /// Enter or Tab with the menu open: insert the highlighted row (the first when none is).
    fn pick_active(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(menu) = self.open_menu().filter(|menu| !menu.rows.is_empty()) else { return false };
        self.menu.follow(&menu.token);
        let ix = self.menu.active.min(menu.rows.len() - 1);
        self.pick(&menu, ix, window, cx);
        true
    }

    fn pick_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(menu) = self.open_menu().filter(|menu| ix < menu.rows.len()) {
            self.pick(&menu, ix, window, cx);
        }
    }

    /// `pick`: the row's mention in place of the token, a space after it, the menu closed.
    fn pick(&mut self, menu: &OpenMenu, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_ref() else { return };
        let mention = match &menu.rows[ix].pick {
            Pick::File(path) => format_file_mention(path),
            Pick::Chat(id) => format_chat_mention(*id),
            Pick::Computer(name) => format_computer_mention(name),
            Pick::Command(name) => name.clone(),
        };
        let (value, caret) = insert_prompt_token(editor.value(), &menu.token, &mention);
        self.menu.dismissed = true;
        self.put(value, caret..caret, Some(EditKind::Chip), window, cx);
        if let Some(editor) = self.editor.as_ref() {
            window.focus(&editor.state.focus_handle(cx), cx);
        }
    }

    /// Up on the first line steps back through sent prompts; Down on the last line steps forward, and past the
    /// newest restores the draft that was there (`recall`).
    fn recall(&mut self, up: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(editor) = self.editor.as_ref() else { return false };
        let (value, selection) = (editor.value().to_string(), editor.selection());
        let at_edge = if up { !value[..selection.start].contains('\n') } else { !value[selection.end..].contains('\n') };
        if !selection.is_empty() || !at_edge || (self.browsing.is_none() && !up) {
            return false;
        }
        let base = self.browsing.as_ref().map_or(self.prompt_history.len(), |(index, _)| *index) as isize;
        let index = base + if up { -1 } else { 1 };
        if index < 0 {
            return false;
        }
        let index = index as usize;
        let stash = self.browsing.take().map_or(value, |(_, stash)| stash);
        let next = self.prompt_history.get(index).cloned().unwrap_or_else(|| stash.clone());
        self.browsing = (index < self.prompt_history.len()).then_some((index, stash));
        self.menu.dismissed = true;
        let end = next.len();
        self.put(next, end..end, Some(EditKind::Chip), window, cx);
        true
    }

    fn visible_suggestion(&self) -> Option<SharedString> {
        let empty = self.editor.as_ref().is_none_or(|editor| editor.value().is_empty());
        self.suggestion
            .clone()
            .filter(|_| empty && self.quotes.is_empty() && self.tray.is_empty() && !self.bar.running && self.open_menu().is_none())
    }

    // ---- Send ----

    /// Enter: what the send decision table says (`SendState::enter`); nothing to send sends nothing, and Enter never
    /// stops a turn.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let action = self.send_state().enter();
        self.dispatch(action, window, cx);
    }

    /// The send button: Stop while a turn runs and nothing is typed, otherwise the same as Enter.
    pub fn press_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.send_state().button() {
            SendAction::Stop => self.stop(cx),
            action => self.dispatch(action, window, cx),
        }
    }

    /// The Stop button: the sink and the Chat hear it.
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(sink) = &self.sink {
            sink.stop();
        }
        cx.emit(ComposerEvent::Stop);
    }

    /// Builds the one outgoing message, hands it on (sent now, or queued) and clears the draft, tray and quotes.
    fn dispatch(&mut self, action: SendAction, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(action, SendAction::Nothing | SendAction::Stop) {
            return;
        }
        let text = self.editor.as_ref().map(|editor| js::trim(editor.value()).to_string()).unwrap_or_default();
        let quotes: Vec<&str> = self.quotes.iter().map(|quote| quote.text.as_str()).collect();
        let message = quoted_message(&quotes, &text);
        let (images, files) = self.tray.outgoing();
        let outgoing = OutgoingMessage {
            prompt: message.clone(),
            text,
            quotes: quotes.iter().map(|quote| quote.to_string()).collect(),
            files,
            images,
            delivery: action,
        };
        if self.prompt_history.last() != Some(&message) && !message.is_empty() {
            self.prompt_history.push(message.clone());
        }
        let quote_chips = std::mem::take(&mut self.quotes);
        if action == SendAction::Queue {
            self.enqueue(outgoing, quote_chips, cx);
            cx.emit(ComposerEvent::Queued(message.into()));
        } else {
            if let Some(sink) = &self.sink {
                sink.send(outgoing);
            }
            cx.emit(ComposerEvent::Send(message.into()));
        }
        self.browsing = None;
        self.menu.dismissed = false;
        self.image_count = 0;
        self.tray.clear();
        self.put(String::new(), 0..0, Some(EditKind::Other), window, cx);
    }

    // ---- Render ----

    fn render_quotes(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        div()
            .id("composer-quotes")
            .flex()
            .flex_col()
            .gap_1()
            .max_h(px(QUOTES_MAX_HEIGHT))
            .overflow_y_scroll()
            .px(px(FRAME_PAD - FRAME_PAD_X))
            .children(self.quotes.iter().enumerate().map(|(ix, quote)| {
                let id = quote.id.clone();
                let text: String = quote.text.split(js::is_space).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
                div()
                    .debug_selector(move || format!("composer-quote-{ix}"))
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_2()
                    .h(CONTROL_MD)
                    .min_w_0()
                    .pl(px(QUOTE_PAD_LEFT))
                    .pr_1()
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.inset)
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(Icon::new(IconName::LeftToRightBlockQuote).size(IconSize::S14).color(theme.ink3))
                    .child(div().flex_1().min_w_0().truncate().child(text))
                    .when_some(quote.source.clone(), |row, source| {
                        row.child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(source))
                    })
                    .child(
                        div()
                            .id(("composer-quote-remove", ix))
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(CONTROL_XS)
                            .rounded(RADIUS_INLINE)
                            .cursor_pointer()
                            .hover(|style| style.bg(theme.hover))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.remove_quote(&id, cx)))
                            .child(Icon::new(IconName::Cancel01).size(IconSize::S12).color(theme.ink3)),
                    )
            }))
    }

    /// The placeholder, or the suggestion with its Tab keycap, over the empty prompt (as `PromptEditor.tsx` draws
    /// it, in `ink-3`).
    fn render_placeholder(&self, theme: &Theme) -> impl IntoElement + use<> {
        let suggestion = self.visible_suggestion();
        div()
            .debug_selector(|| "composer-placeholder".into())
            .absolute()
            .top(px(EDITOR_PAD_Y))
            .left(px(EDITOR_PAD_X))
            .right(px(EDITOR_PAD_X))
            .flex()
            .items_center()
            .gap_2()
            .text_size(px(prompt_text_size()))
            .line_height(px(PROMPT_LINE_HEIGHT))
            .text_color(theme.ink3)
            .child(
                div().min_w_0().truncate().child(
                    suggestion.clone().unwrap_or_else(|| self.send_state().running_placeholder().unwrap_or(PROMPT_PLACEHOLDER).into()),
                ),
            )
            .when(suggestion.is_some(), |el| {
                el.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap_1()
                        .px(px(6.0))
                        .rounded(RADIUS_CONTROL)
                        .border_1()
                        .border_color(theme.line_strong)
                        .text_step(TEXT_12)
                        .line_height(px(PROMPT_LINE_HEIGHT))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(Icon::new(IconName::ArrowRightToLine).size(IconSize::S12).color(theme.ink3))
                        .child("Tab"),
                )
            })
    }

    /// The prompt box's height: its rows and insets, from 68 up to 100.
    fn editor_height(&self, cx: &App) -> Pixels {
        let rows = self.editor.as_ref().map_or(1, |editor| editor.state.read(cx).display_map().display_row_count().max(1));
        px((rows as f32 * PROMPT_LINE_HEIGHT + 2.0 * EDITOR_PAD_Y).clamp(EDITOR_MIN_HEIGHT, EDITOR_MAX_HEIGHT))
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_editor(window, cx);
        let theme = *cx.theme();
        let menu = self.open_menu();
        if let Some(menu) = &menu {
            self.menu.follow(&menu.token);
            if let Some(active) = self.prefill_active.take() {
                self.menu.active = active;
                self.menu.engaged = true;
            }
            self.menu.active = self.menu.active.min(menu.rows.len().saturating_sub(1));
        }
        let state = self.editor.as_ref().expect("made above").state.clone();
        let empty = self.shown.is_empty();
        let height = self.editor_height(cx);
        let entity = cx.entity().downgrade();
        let textarea = Textarea::new(&state)
            .appearance(false)
            .h(height)
            .text_size(px(prompt_text_size()))
            .line_height(px(PROMPT_LINE_HEIGHT))
            .text_color(theme.ink)
            .token(chips::render_chip)
            .on_token_click(move |event, _, cx| {
                if let Some(ChipKind::Image(index)) = ChipKind::from_token_id(event.token().id()) {
                    entity.update(cx, |_, cx| cx.emit(ComposerAttachment::OpenImage(index))).ok();
                }
            });
        let queue = self.render_queue(&theme, cx);
        let tray = self.render_tray(&theme, cx);
        let bar = div()
            .id("composer")
            .debug_selector(|| "composer".into())
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus_handle)
            .capture_action(cx.listener(Self::on_enter))
            .capture_action(cx.listener(Self::on_tab))
            .capture_action(cx.listener(Self::on_shift_tab))
            .capture_action(cx.listener(Self::on_up))
            .capture_action(cx.listener(Self::on_down))
            .capture_action(cx.listener(Self::on_undo))
            .capture_action(cx.listener(Self::on_redo))
            .capture_action(cx.listener(Self::on_paste))
            .capture_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_escape))
            .on_drop(cx.listener(Self::on_drop))
            .relative()
            .flex()
            .flex_col()
            .gap(px(ROW_GAP))
            .w_full()
            .min_h(px(COMPOSER_MIN_HEIGHT))
            // The 1px the border took is padding now: the glass draws its own edge inside the box.
            .pt(px(FRAME_PAD + 1.0))
            .pb(px(FRAME_PAD + 1.0))
            .px(px(FRAME_PAD_X + 1.0))
            .rounded(RADIUS_WINDOW)
            // Liquid glass: the transcript runs on behind the composer, blurred under a translucent surface.
            .child(Glass::surface(&theme, GLASS_COMPOSER_FILL).radius(RADIUS_WINDOW))
            .when(!self.quotes.is_empty(), |el| el.child(self.render_quotes(&theme, cx)))
            .when_some(tray, |el, tray| el.child(tray))
            .child(
                div()
                    .id("composer-input")
                    .debug_selector(|| "composer-input".into())
                    .relative()
                    .flex_none()
                    .w_full()
                    .h(height)
                    .child(textarea)
                    .when(empty && self.marked_range().is_none(), |el| el.child(self.render_placeholder(&theme))),
            )
            .child(self.render_send_row(&theme, cx))
            .when_some(menu, |el, menu| el.child(self.render_menu(&menu, &theme, cx)));
        let header = self.render_tray_header(&theme, cx);
        // `isNewChat && starters.length > 0`, and nothing typed or sent yet.
        let starters_shown = self.new_chat.is_some() && !self.starters.is_empty() && empty;
        let bar = match header {
            // The new-Chat tray: the chips and the composer in one `inset` box.
            Some(header) => div()
                .id("new-chat-tray")
                .debug_selector(|| "new-chat-tray".into())
                .flex()
                .flex_col()
                .w_full()
                .p(px(6.0))
                .pt(px(4.0))
                .rounded(px(new_chat::TRAY_RADIUS))
                .border_1()
                .border_color(theme.line)
                .bg(theme.inset)
                .child(header)
                .child(bar)
                .into_any_element(),
            None => bar.into_any_element(),
        };
        // The queue is docked above the composer's box, 8px clear of it (`mb-2`).
        div()
            .id("composer-dock")
            .flex()
            .flex_col()
            .gap(px(QUEUE_GAP))
            .w_full()
            .max_w(px(if self.new_chat.is_some() { new_chat::tray_width() } else { crate::theme::column_width() }))
            .when_some(queue, |el, queue| el.child(queue))
            .when(starters_shown, |el| el.child(self.render_starters(cx)))
            .child(bar)
    }
}

/// The platform's text input protocol, forwarded to the text area (the IME path the window drives through the
/// focused text area; here so the Chat column's tests can drive the composer as one input).
impl EntityInputHandler for Composer {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        let state = self.editor.as_ref()?.state.clone();
        state.update(cx, |state, cx| state.text_for_range(range, adjusted, window, cx))
    }

    fn selected_text_range(&mut self, ignore_disabled: bool, window: &mut Window, cx: &mut Context<Self>) -> Option<UTF16Selection> {
        let state = self.editor.as_ref()?.state.clone();
        state.update(cx, |state, cx| state.selected_text_range(ignore_disabled, window, cx))
    }

    fn marked_text_range(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<Range<usize>> {
        let state = self.editor.as_ref()?.state.clone();
        state.update(cx, |state, cx| state.marked_text_range(window, cx))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(state) = self.editor.as_ref().map(|editor| editor.state.clone()) {
            state.update(cx, |state, cx| state.unmark_text(window, cx));
        }
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(state) = self.editor.as_ref().map(|editor| editor.state.clone()) {
            state.update(cx, |state, cx| state.replace_text_in_range(range, text, window, cx));
            self.shown = state.read(cx).value().to_string();
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(state) = self.editor.as_ref().map(|editor| editor.state.clone()) {
            state.update(cx, |state, cx| state.replace_and_mark_text_in_range(range, text, selected, window, cx));
            self.shown = state.read(cx).value().to_string();
        }
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: gpui::Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::Bounds<Pixels>> {
        let state = self.editor.as_ref()?.state.clone();
        state.update(cx, |state, cx| state.bounds_for_range(range, bounds, window, cx))
    }

    fn character_index_for_point(&mut self, point: gpui::Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> Option<usize> {
        let state = self.editor.as_ref()?.state.clone();
        state.update(cx, |state, cx| state.character_index_for_point(point, window, cx))
    }
}
