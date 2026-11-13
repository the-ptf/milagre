//! [`ShortcutKeys`] (the desktop's `primitives/ShortcutKeys.tsx`): one keyboard vocabulary for tooltip labels,
//! menu rows and command rows. Our own: gpui-component's `Kbd` is a tiny keycap tied to its own keybinding
//! lookup and look.
//!
//! A keycap is 20px high with `rounded-inline`, a `surface` fill with `shadow-btn`, 11 semibold `ink-2`
//! (`.compact()`: 16px and 10px); `.plain()` draws the keys alone, set tight, in the surrounding colour (inside a
//! tooltip). The shortcut is written as in the desktop: `"⌘K"`, `"⇧⌘P"`, `"Ctrl+Shift+E"`, `"Esc"`, `"↵"`; the
//! modifier glyphs (⌃⌥⇧⌘) are drawn as text, since the Hugeicons set here has no Command or Option icon.
//! Keys come out in macOS menu order (⌃⌥⇧⌘, then the key).

use gpui::{App, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, RADIUS_INLINE, TEXT_10, TEXT_11, TextStepExt};

/// Splits a shortcut into its keys: `"⇧⌘P"` into `⇧ ⌘ P`, `"Ctrl+Shift+E"` into `Ctrl Shift E`.
pub fn parse_shortcut(shortcut: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for part in shortcut.split(['+', ' ']).filter(|part| !part.is_empty()) {
        // A word (`Shift`, `Esc`, `F12`, `Enter`) is one key; anything else is a run of single-character keys.
        if part.chars().count() > 1 && part.chars().all(|c| c.is_ascii_alphanumeric()) {
            keys.push(part.to_string());
        } else {
            keys.extend(part.chars().map(|c| c.to_string()));
        }
    }
    keys
}

/// The glyph or word a key is drawn as.
fn label(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "meta" | "cmd" | "command" | "⌘" => "⌘".into(),
        "shift" | "⇧" => "⇧".into(),
        "alt" | "option" | "⌥" => "⌥".into(),
        "ctrl" | "control" | "⌃" => "⌃".into(),
        "enter" | "return" | "↵" => "↵".into(),
        "escape" | "esc" => "Esc".into(),
        _ => key.to_uppercase(),
    }
}

/// Sort rank in macOS menu order: ⌃ ⌥ ⇧ ⌘, then the key.
fn rank(key: &str) -> u8 {
    match key {
        "⌃" => 0,
        "⌥" => 1,
        "⇧" => 2,
        "⌘" => 3,
        _ => 4,
    }
}

/// The keys of `shortcut` as drawn, in menu order.
pub fn shortcut_labels(shortcut: &str) -> Vec<String> {
    let mut labels: Vec<String> = parse_shortcut(shortcut).iter().map(|key| label(key)).collect();
    labels.sort_by_key(|key| rank(key));
    labels
}

#[derive(IntoElement)]
pub struct ShortcutKeys {
    shortcut: SharedString,
    plain: bool,
    compact: bool,
}

impl ShortcutKeys {
    pub fn new(shortcut: impl Into<SharedString>) -> Self {
        Self { shortcut: shortcut.into(), plain: false, compact: false }
    }

    /// The keys alone, in the surrounding colour and weight (a tooltip's hint).
    pub fn plain(mut self) -> Self {
        self.plain = true;
        self
    }

    /// 16px keycaps at 10px, for a hint under one of a row of close icon buttons.
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }
}

impl RenderOnce for ShortcutKeys {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (compact, plain) = (self.compact, self.plain);
        div()
            .debug_selector(|| "shortcut-keys".into())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(if compact || plain { 1.0 } else { 2.0 }))
            .children(shortcut_labels(&self.shortcut).into_iter().map(move |key| {
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .whitespace_nowrap()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_step(if compact { TEXT_10 } else { TEXT_11 })
                    .line_height(px(if compact { 10.0 } else { 11.0 }))
                    .when(!plain, |el| {
                        el.h(px(if compact { 16.0 } else { 20.0 }))
                            .min_w(px(if compact { 16.0 } else { 20.0 }))
                            .px(px(if compact { 2.0 } else { 4.0 }))
                            .rounded(RADIUS_INLINE)
                            .bg(theme.surface)
                            .shadow(theme.shadow_btn())
                            .text_color(theme.ink2)
                    })
                    .child(key)
            }))
    }
}
