//! [`Tooltip`] (DESIGN.md "Radius": `rounded-chip` for tooltips; the desktop's `primitives/Tooltip.tsx`): the ink
//! capsule `bg-ink`, 12 medium `on-ink`, 8 by 4 padding, `rounded-chip`, `shadow-raised`, with an optional
//! shortcut after the label.
//!
//! The view is gpui-component's `Tooltip` (its placement, enter animation and key-binding row), re-skinned: our
//! ink fill, chip radius, 12px text, no border. It is attached through GPUI's own `.tooltip(..)` hook, which shows
//! it after GPUI's fixed hover delay (500ms; the desktop's is 400) and hides it on press or leave:
//!
//! ```ignore
//! div().id("search").tooltip(Tooltip::text("Search")).child(...)
//! div().id("palette").tooltip(Tooltip::new("Command palette").shortcut("⌘K").build()).child(...)
//! ```
//!
//! gpui-component's managed tooltip (one overlay per window that slides between neighbouring triggers, a settable
//! delay) hangs off a crate-private trait (`ManagedTooltipExt`), so it is out of reach from here; adopting it
//! means upstreaming or vendoring that one trait. Not built: `side="bottom"` for triggers at the window's top
//! edge, wrapping at 280px, Escape hiding it, the ⌘-held hints beside icon buttons, and the delay being 400.

use gpui::{AnyView, App, FontWeight, SharedString, Window, div, prelude::*, px};
use gpui_component::tooltip::Tooltip as WidgetTooltip;

use super::ShortcutKeys;
use crate::theme::{ActiveTheme, RADIUS_CHIP, TEXT_12, TextStepExt};

/// A tooltip's text and optional shortcut.
pub struct Tooltip {
    label: SharedString,
    shortcut: Option<SharedString>,
}

impl Tooltip {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self { label: label.into(), shortcut: None }
    }

    /// A shortcut after the label (`"⌘K"`), drawn as plain keys.
    pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
        self.shortcut = Some(shortcut.into());
        self
    }

    /// A builder for `.tooltip(...)` that shows `label`.
    pub fn text(label: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        Self::new(label).build()
    }

    /// The builder for `.tooltip(...)`.
    pub fn build(self) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let Tooltip { label, shortcut } = self;
        move |window, cx| {
            let theme = *cx.theme();
            let (label, shortcut) = (label.clone(), shortcut.clone());
            WidgetTooltip::element(move |_, _| {
                div()
                    .debug_selector(|| "tooltip".into())
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .whitespace_nowrap()
                    .child(label.clone())
                    .when_some(shortcut.clone(), |el, shortcut| el.child(div().opacity(0.6).child(ShortcutKeys::new(shortcut).plain())))
            })
            // The widget's own look (popover fill, border, shadcn shadow, 8px radius, 14px text) replaced.
            .bg(theme.ink)
            .text_color(theme.on_ink)
            .border_0()
            .rounded(RADIUS_CHIP)
            .shadow(theme.shadow_raised())
            .m(px(6.0))
            .px(px(8.0))
            .py(px(4.0))
            .text_step(TEXT_12)
            .font_weight(FontWeight::MEDIUM)
            .build(window, cx)
        }
    }
}
