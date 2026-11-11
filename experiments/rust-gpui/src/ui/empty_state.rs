//! [`EmptyState`] (DESIGN.md "States": "Empty, loading and error states go through `EmptyState`, `SpinnerRing` and
//! `InlineError`"; the desktop's `primitives/EmptyState.tsx`): what a list or panel shows with nothing in it,
//! centred: an optional 18px `ink-4` icon, a title, a line of help and an action.
//!
//! `Panel` (the default: 24 by 40 padding) suits a panel, `Page` (24 by 64) a whole page, `Compact` (12 by 24) a list or
//! menu: one 12px `ink-3` line, no icon. The title is 13 medium `ink`, the help 12 `ink-3` at most 320px wide.
//! Titles have no full stop; help lines end with one. Our own.

use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, TEXT_12, TEXT_13, TextStepExt};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EmptySize {
    Compact,
    #[default]
    Panel,
    Page,
}

#[derive(IntoElement)]
pub struct EmptyState {
    icon: Option<IconName>,
    title: Option<SharedString>,
    help: Option<SharedString>,
    action: Option<AnyElement>,
    size: EmptySize,
}

impl Default for EmptyState {
    fn default() -> Self {
        Self::new()
    }
}

impl EmptyState {
    pub fn new() -> Self {
        Self { icon: None, title: None, help: None, action: None, size: EmptySize::default() }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// The help line, in `ink-3`.
    pub fn help(mut self, help: impl Into<SharedString>) -> Self {
        self.help = Some(help.into());
        self
    }

    /// A secondary or ghost button (the screen's primary stays where it is).
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    pub fn size(mut self, size: EmptySize) -> Self {
        self.size = size;
        self
    }
}

impl RenderOnce for EmptyState {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let compact = self.size == EmptySize::Compact;
        // `px-3 py-6`, `px-6 py-10`, `px-6 py-16`.
        let (x, y) = match self.size {
            EmptySize::Compact => (12.0, 24.0),
            EmptySize::Panel => (24.0, 40.0),
            EmptySize::Page => (24.0, 64.0),
        };
        div()
            .debug_selector(|| "empty-state".into())
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .px(px(x))
            .py(px(y))
            .text_center()
            .when(!compact, |el| {
                el.children(self.icon.map(|icon| div().mb(px(4.0)).child(Icon::new(icon).size(IconSize::S18).color(theme.ink4))))
            })
            .when_some(self.title, |el, title| {
                if compact {
                    el.child(div().text_step(TEXT_12).text_color(theme.ink3).child(title))
                } else {
                    el.child(div().text_step(TEXT_13).font_weight(gpui::FontWeight::MEDIUM).text_color(theme.ink).child(title))
                }
            })
            .when_some(self.help, |el, help| el.child(div().max_w(px(320.0)).text_step(TEXT_12).text_color(theme.ink3).child(help)))
            .children(self.action.map(|action| div().mt(px(8.0)).child(action)))
    }
}
