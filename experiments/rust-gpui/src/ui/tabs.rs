//! [`Tab`] and [`Tabs`] (the desktop's `primitives/Tabs.tsx`): a 28px tab with an optional 14px icon and count.
//! The active tab is `hover-2` with an ink label (DESIGN.md: a selection is ink, never accent); the others are
//! `ink-2` (the desktop's `text-ink-2`) with the `hover` fill and an ink label on hover; keyboard focus shows the
//! accent ring.
//!
//! [`Tab`] is one tab, for a strip the caller lays out (`div().flex()`, or a horizontally scrolling one, as the
//! panel's; tabs must be its direct children for `ScrollHandle::scroll_to_item` to bring a tab into view). Tabs are
//! no-drag, so a strip can live in a window header. [`Tabs`] is the whole strip with the roving behaviour: one Tab
//! stop, Left and Right, Home and End move the focus and pick (`focus::roving_keys`).
//!
//! Our own, not gpui-component's `TabBar`: its tabs draw a squared "folder" look with its own sizes (the bar's
//! `h` is the only way to reach 28) and would be re-skinned in every part, and gpui-base's `Tab` has no keyboard
//! model (it says so in a TODO). What is left of the desktop's `Tabs`: `aria-controls` panels, and `disabled` tabs
//! skip the arrows but their ring is not drawn.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, FocusHandle, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::focus::{RovingAxis, focus_ring, item_focus, roving_keys};
use super::press::Press;
use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_12, TextStepExt};
use crate::workspace::chrome::NoDrag;

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Tab {
    id: ElementId,
    selector: Option<SharedString>,
    label: SharedString,
    icon: Option<IconName>,
    count: Option<SharedString>,
    active: bool,
    wide: bool,
    disabled: bool,
    handle: Option<FocusHandle>,
    on_click: Option<ClickHandler>,
}

impl Tab {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            selector: None,
            label: label.into(),
            icon: None,
            count: None,
            active: false,
            wide: false,
            disabled: false,
            handle: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A number after the label, in `ink-3` (Changes 4).
    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// The desktop strip's 10px side inset (`Tabs`); a bare `Tab` keeps the panel header's 6.
    pub fn wide(mut self) -> Self {
        self.wide = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    fn handle(mut self, handle: FocusHandle) -> Self {
        self.handle = Some(handle);
        self
    }

    /// The name tests find it by; its icon is `<selector>-icon`. The element id's text by default.
    pub fn selector(mut self, selector: impl Into<SharedString>) -> Self {
        self.selector = Some(selector.into());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Tab {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = self.handle.clone().unwrap_or_else(|| item_focus(&self.id, window, cx));
        let selector = self.selector.unwrap_or_else(|| self.id.to_string().into());
        let icon_selector = format!("{selector}-icon");
        let color = if self.active { theme.ink } else { theme.ink2 };
        let (hover, ink) = (theme.hover, theme.ink);
        let enabled = !self.disabled;
        // React: a pressed tab is `hover-2` (no scale), at once.
        let press = (enabled && !self.active).then(|| Press::with(self.id.clone(), 1.0, std::time::Duration::ZERO, window, cx));
        let pressed = press.as_ref().is_some_and(Press::engaged);
        div()
            .id(self.id)
            .debug_selector(move || selector.to_string())
            .map(|el| match &press {
                Some(press) => press.wire(el),
                None => el,
            })
            .track_focus(&handle)
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.0))
            .h(CONTROL_SM)
            .px(px(if self.wide { 10.0 } else { 6.0 }))
            .rounded(RADIUS_CONTROL)
            .text_step(TEXT_12)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .text_color(color)
            .when(enabled, |el| el.cursor_pointer())
            .when(!enabled, |el| el.opacity(0.4))
            .when(self.active || pressed, |el| el.bg(theme.hover2))
            .when(!self.active && enabled && !pressed, |el| el.hover(move |style| style.bg(hover).text_color(ink)))
            .no_drag()
            .when_some(self.on_click.filter(|_| enabled), |el, handler| {
                let click_focus = handle.clone();
                el.on_click(move |event, window, cx| {
                    // The press stops at the header (`no_drag`), so the tab takes focus itself: the arrow keys
                    // then move from it.
                    click_focus.focus(window, cx);
                    // Keep a double-click on a tab from reaching a header's zoom.
                    cx.stop_propagation();
                    handler(event, window, cx);
                })
            })
            .when_some(self.icon, |el, icon| {
                el.child(div().debug_selector(move || icon_selector.clone()).child(Icon::new(icon).size(IconSize::S14).color(color)))
            })
            .child(
                div()
                    .flex()
                    .gap(px(4.0))
                    .child(self.label)
                    .when_some(self.count, |el, count| el.child(div().text_color(theme.ink3).child(count))),
            )
            .child(focus_ring(&handle, RADIUS_CONTROL))
    }
}

type Change = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// One tab of a [`Tabs`] strip.
#[derive(Clone)]
pub struct TabOption {
    value: SharedString,
    label: SharedString,
    icon: Option<IconName>,
    count: Option<u32>,
    disabled: bool,
}

impl TabOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self { value: value.into(), label: label.into(), icon: None, count: None, disabled: false }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// A panel's tab strip with roving focus; see the module docs. Tab `i`'s selector is `<id>-<value>`.
#[derive(IntoElement)]
pub struct Tabs {
    id: ElementId,
    value: SharedString,
    options: Vec<TabOption>,
    on_change: Option<Change>,
}

impl Tabs {
    pub fn new(id: impl Into<ElementId>, value: impl Into<SharedString>, options: impl IntoIterator<Item = TabOption>) -> Self {
        Self { id: id.into(), value: value.into(), options: options.into_iter().collect(), on_change: None }
    }

    pub fn on_change(mut self, handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Tabs {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let enabled: Vec<usize> = (0..self.options.len()).filter(|&ix| !self.options[ix].disabled).collect();
        let tab_id = |option: &TabOption| ElementId::from((self.id.clone(), option.value.clone()));
        let handles: Vec<FocusHandle> = self.options.iter().map(|option| item_focus(&tab_id(option), window, cx)).collect();
        let stop = enabled.iter().copied().find(|&ix| self.options[ix].value == self.value).or_else(|| enabled.first().copied());
        let keys = {
            let (options, change) = (self.options.clone(), self.on_change.clone());
            roving_keys(
                enabled.iter().map(|&ix| handles[ix].clone()).collect(),
                enabled.clone(),
                RovingAxis::Horizontal,
                move |ix, window, cx| {
                    if let Some(change) = &change {
                        change(&options[ix].value, window, cx);
                    }
                },
            )
        };
        let selector = self.id.to_string();
        div()
            .id(self.id.clone())
            .debug_selector(move || selector.clone())
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(2.0))
            .on_key_down(keys)
            .children(self.options.iter().enumerate().map(|(ix, option)| {
                let (value, change) = (option.value.clone(), self.on_change.clone());
                let mut tab = Tab::new(tab_id(option), option.label.clone())
                    .wide()
                    .active(option.value == self.value)
                    .disabled(option.disabled)
                    .handle(handles[ix].clone().tab_stop(stop == Some(ix)))
                    .on_click(move |_, window, cx| {
                        if let Some(change) = &change {
                            change(&value, window, cx);
                        }
                    });
                if let Some(icon) = option.icon {
                    tab = tab.icon(icon);
                }
                if let Some(count) = option.count {
                    tab = tab.count(count.to_string());
                }
                tab
            }))
    }
}
