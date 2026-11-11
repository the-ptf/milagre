//! The Settings › Appearance choices the views read while they draw (`applyAppearance` in `lib/appearance.ts` sets the
//! same CSS variables on the desktop): the interface and monospace fonts, the Chat and code sizes, the Chat column's
//! width, the sidebar's size, the provider icon style and the sidebar usage layout.
//!
//! [`crate::settings::appearance::model::apply`] writes them when the stored choice changes, then refreshes the windows
//! once; a view reads them in `render` through the functions here, so a change rebuilds the views once and nothing
//! polls per frame. They live in a thread-local (the UI thread owns every view; a headless test runs on its own thread,
//! so one test's choice never reaches another). The defaults are the constants the views were built to
//! ([`CHAT_TEXT`], [`CODE_TEXT`], [`SANS`], [`MONO`]).

use std::cell::RefCell;

use super::{CHAT_TEXT, CODE_TEXT, SANS, TextStep};

/// The Chat column's width at the default Comfortable setting (the desktop's 704px box less its gutters and the
/// port's padding), and the room the chosen box width keeps beyond the column.
pub const DEFAULT_COLUMN: f32 = 536.0;
const DEFAULT_BOX: f32 = 704.0;
/// "Full" fills the pane: the column is as wide as the room allows.
const FULL_COLUMN: f32 = 4000.0;

/// What the views read; `Default` is today's look.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveStyle {
    /// The interface font family; [`SANS`] for System.
    pub ui_font: &'static str,
    /// The monospace family, or `None` for the system's own ([`MONO`] or its fallback).
    pub mono_font: Option<&'static str>,
    pub chat_size: f32,
    pub code_size: f32,
    /// Added to the sidebar's text sizes (`--sidebar-delta`), in px.
    pub sidebar_delta: f32,
    /// The Chat column's box width in px (`--chat-width`); `None` fills the pane.
    pub chat_width: Option<f32>,
    /// Provider marks as one-colour outlines (`providerIcons: "simplified"`).
    pub simplified_icons: bool,
    /// The sidebar's usage rows as marks with a bar (`sidebarUsage: "compact"`).
    pub compact_usage: bool,
    /// How fast panels open and close (`--motion-scale`): 1 Normal, 0.6 Fast, 0 Off.
    pub motion_scale: f32,
}

impl Default for LiveStyle {
    fn default() -> Self {
        Self {
            ui_font: SANS,
            mono_font: None,
            chat_size: CHAT_TEXT.size,
            code_size: CODE_TEXT.size,
            sidebar_delta: 0.0,
            chat_width: Some(DEFAULT_BOX),
            simplified_icons: false,
            compact_usage: false,
            motion_scale: 1.0,
        }
    }
}

thread_local! {
    static LIVE: RefCell<LiveStyle> = RefCell::new(LiveStyle::default());
}

/// Sets what the views read. Returns whether it changed.
pub fn set_live(style: LiveStyle) -> bool {
    LIVE.with(|live| {
        let changed = *live.borrow() != style;
        *live.borrow_mut() = style;
        changed
    })
}

pub fn live() -> LiveStyle {
    LIVE.with(|live| live.borrow().clone())
}

/// The interface font family.
pub fn ui_font() -> &'static str {
    LIVE.with(|live| live.borrow().ui_font)
}

/// The chosen monospace family, if it is not the system's.
pub(super) fn chosen_mono() -> Option<&'static str> {
    LIVE.with(|live| live.borrow().mono_font)
}

/// Chat text at the chosen size, line height 1.6 (`--chat-size`).
pub fn chat_text() -> TextStep {
    let size = LIVE.with(|live| live.borrow().chat_size);
    TextStep { size, line_height: size * 1.6 }
}

/// Code at the chosen size, line height 1.5 (`--code-size`; the default 12 stays on its 18px line).
pub fn code_text() -> TextStep {
    let size = LIVE.with(|live| live.borrow().code_size);
    TextStep { size, line_height: size * 1.5 }
}

/// The composer's prompt text: a px larger than the Chat text (`calc(var(--chat-size) + 1px)`).
pub fn prompt_text_size() -> f32 {
    chat_text().size + 1.0
}

/// A sidebar text step at the chosen size (`calc(13px + var(--sidebar-delta))`); the line height stays, as its rows
/// are fixed-height.
pub fn sidebar_step(step: TextStep) -> TextStep {
    TextStep { size: step.size + LIVE.with(|live| live.borrow().sidebar_delta), line_height: step.line_height }
}

/// The Chat content column's width: [`DEFAULT_COLUMN`] at the default box, the box's change added to it otherwise.
pub fn column_width() -> f32 {
    match LIVE.with(|live| live.borrow().chat_width) {
        Some(width) => (DEFAULT_COLUMN + width - DEFAULT_BOX).max(240.0),
        None => FULL_COLUMN,
    }
}

pub fn simplified_icons() -> bool {
    LIVE.with(|live| live.borrow().simplified_icons)
}

pub fn compact_usage() -> bool {
    LIVE.with(|live| live.borrow().compact_usage)
}

/// The Appearance "Motion" speed as a duration scale; read through `ui::motion_scale`, which also stops it in tests.
pub(crate) fn chosen_motion_scale() -> f32 {
    LIVE.with(|live| live.borrow().motion_scale)
}
