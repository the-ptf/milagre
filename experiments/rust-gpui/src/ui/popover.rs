//! [`Popover`], [`MenuList`] and [`MenuRow`] (DESIGN.md "Elevation", "States" and "Components"; the desktop's
//! `primitives/Popover.tsx`).
//!
//! The popover wraps gpui-component's `Popover` (a gpui-base `Popover` underneath): that brings the anchoring,
//! opening from the trigger, and closing on an outside press and on Escape (the `use-dismiss.ts` rules; its
//! window-blur dismissal is not covered). What is ours is the surface: `surface` fill, `rounded-card`,
//! `shadow-raised` and no border (the shadow paints its own ring), 6px padding, at least 192px wide, 6px under
//! its trigger and lined up with the trigger's right edge (`.align_start()` for the left).
//!
//! ```ignore
//! Popover::new("chat-actions")
//!     .trigger(|open| IconButton::new("more", IconName::MoreHorizontal).pressed(open).into_any_element())
//!     .content(|dismiss, _window, _cx| {
//!         MenuList::new("chat-menu")
//!             .dismiss(dismiss)
//!             .row(MenuRow::new("rename", "Rename Chat").icon(IconName::Edit02).trailing_shortcut("⌘R").on_click(|_, _, _| ..))
//!             .separator()
//!             .row(MenuRow::new("archive", "Archive").danger().on_click(|_, _, _| ..))
//!             .into_any_element()
//!     })
//! ```
//!
//! A [`MenuRow`] is 32px high (28 with `.compact()`, 48 with a subtitle), 4px corners, 13 medium ink, with a 20px
//! slot for a 14px icon, a trailing 11px `ink-3` text or [`ShortcutKeys`](super::ShortcutKeys), and a 14px tick
//! when `checked` (no fill). The highlight is `hover-2` for the pointer and for keyboard focus alike, and keyboard
//! focus adds the 2px accent ring inset. A [`MenuList`] is the keyboard side: the first row takes focus when the
//! menu opens, the arrow keys, Home and End move between rows (wrapping), Enter or Space presses the focused row.
//!
//! Not built: flipping above the trigger when there is no room below, point anchors (context menus), and
//! returning focus to the opener (gpui-component's popover does not restore it).

use std::rc::Rc;

use gpui::{
    Anchor, AnyElement, App, ClickEvent, ElementId, FocusHandle, FontWeight, IntoElement, KeyDownEvent, ParentElement, Pixels, RenderOnce,
    SharedString, Window, div, prelude::*, px,
};
use gpui_component::Selectable;
use gpui_component::popover::{Popover as WidgetPopover, PopoverState};

use super::focus::{RovingAxis, focused_index, inset_ring, item_focus, roving_index};
use super::scroll_fade::ScrollFade;
use super::{Icon, IconName, IconSize, SectionLabel, ShortcutKeys};
use crate::platform::webview::set_overlay_open;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt};

/// How far a menu keeps from the window's edges (`INSET` in `Popover.tsx`).
const WINDOW_INSET: Pixels = px(8.0);

type WindowFn = Rc<dyn Fn(&mut Window, &mut App)>;
type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// Closes the popover a piece of its content sits in.
#[derive(Clone)]
pub struct Dismiss(WindowFn);

impl Dismiss {
    pub fn call(&self, window: &mut Window, cx: &mut App) {
        (self.0)(window, cx);
    }
}

type ContentFn = Rc<dyn Fn(&Dismiss, &mut Window, &mut App) -> AnyElement>;

/// The trigger the widget popover marks open (`Selectable`), built by our closure from the open state.
#[derive(IntoElement)]
struct Trigger {
    build: Box<dyn FnOnce(bool) -> AnyElement>,
    open: bool,
}

impl Selectable for Trigger {
    fn selected(mut self, selected: bool) -> Self {
        self.open = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for Trigger {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        (self.build)(self.open)
    }
}

/// A floating panel opened from its trigger.
#[derive(IntoElement)]
pub struct Popover {
    id: ElementId,
    align_start: bool,
    bare: bool,
    above: bool,
    width: Option<Pixels>,
    trigger: Option<Box<dyn FnOnce(bool) -> AnyElement>>,
    content: Option<ContentFn>,
    open: Option<bool>,
    on_open_change: Option<OpenChange>,
}

impl Popover {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            align_start: false,
            bare: false,
            above: false,
            width: None,
            trigger: None,
            content: None,
            open: None,
            on_open_change: None,
        }
    }

    /// The trigger, drawn from whether the popover is open (a toggle's `.pressed(open)`).
    pub fn trigger(mut self, build: impl FnOnce(bool) -> AnyElement + 'static) -> Self {
        self.trigger = Some(Box::new(build));
        self
    }

    /// What the panel holds; called on every render while it is open.
    pub fn content(mut self, build: impl Fn(&Dismiss, &mut Window, &mut App) -> AnyElement + 'static) -> Self {
        self.content = Some(Rc::new(build));
        self
    }

    /// Lines up with the trigger's left edge instead of its right.
    pub fn align_start(mut self) -> Self {
        self.align_start = true;
        self
    }

    /// No surface of its own: the content draws it (a [`PickerPanel`](super::PickerPanel), which is already a
    /// raised card).
    pub fn bare(mut self) -> Self {
        self.bare = true;
        self
    }

    /// Opens above the trigger instead of below it (the composer's chips sit at the window's bottom).
    pub fn above(mut self) -> Self {
        self.above = true;
        self
    }

    /// A fixed width; otherwise it fits its rows, from 192px.
    pub fn width(mut self, width: Pixels) -> Self {
        self.width = Some(width);
        self
    }

    /// Controls the open state from the caller (pair with `on_open_change`).
    pub fn open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }

    pub fn on_open_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Popover {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let content = self.content;
        let bare = self.bare;
        // A web page draws over GPUI, so an open popover hides it (`platform::webview::set_overlay_open`). Its state
        // is tracked by id: from the caller's `open` on each render, and from the widget's open changes.
        let overlay: SharedString = format!("popover:{}", self.id).into();
        if let Some(open) = self.open {
            set_overlay_open(overlay.clone(), open, cx);
        }
        let on_open_change = self.on_open_change;
        WidgetPopover::new(self.id)
            .anchor(match (self.above, self.align_start) {
                (false, true) => Anchor::TopLeft,
                (false, false) => Anchor::TopRight,
                (true, true) => Anchor::BottomLeft,
                (true, false) => Anchor::BottomRight,
            })
            .offset(px(6.0))
            .appearance(!bare)
            // Over the widget's own surface (`popover_style`: its fill, its shadow, `p_3`); the radius and
            // shadow replace the widget's 8px and shadow.
            .when(!bare, |popover| {
                popover
                    .bg(theme.surface)
                    .text_color(theme.ink)
                    .rounded(RADIUS_CARD)
                    .shadow(theme.shadow_raised())
                    .p(px(6.0))
                    .min_w(px(192.0))
            })
            .when_some(self.width, |popover, width| popover.w(width))
            .when_some(self.trigger, |popover, build| popover.trigger(Trigger { build, open: false }))
            .when_some(self.open, |popover, open| popover.open(open))
            .on_open_change(move |open, window, cx| {
                set_overlay_open(overlay.clone(), *open, cx);
                if let Some(handler) = &on_open_change {
                    handler(*open, window, cx);
                }
            })
            .content(move |_state: &mut PopoverState, window, cx| {
                let entity = cx.entity();
                let dismiss = Dismiss(Rc::new(move |window, cx| entity.update(cx, |state, cx| state.dismiss(window, cx))));
                match &content {
                    Some(content) => content(&dismiss, window, cx),
                    None => div().into_any_element(),
                }
            })
    }
}

type RowHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

enum Trailing {
    Text(SharedString),
    Shortcut(SharedString),
}

/// One menu row; see the module docs.
#[derive(IntoElement)]
pub struct MenuRow {
    id: ElementId,
    title: SharedString,
    subtitle: Option<SharedString>,
    icon: Option<IconName>,
    trailing: Option<Trailing>,
    checked: Option<bool>,
    danger: bool,
    disabled: bool,
    compact: bool,
    handle: Option<FocusHandle>,
    on_click: Option<RowHandler>,
}

impl MenuRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            subtitle: None,
            icon: None,
            trailing: None,
            checked: None,
            danger: false,
            disabled: false,
            compact: false,
            handle: None,
            on_click: None,
        }
    }

    /// A 14px glyph in the 20px slot before the title.
    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A second line (12 `ink-3`); the row is 48 high.
    pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// 11px `ink-3` text at the row's end.
    pub fn trailing(mut self, text: impl Into<SharedString>) -> Self {
        self.trailing = Some(Trailing::Text(text.into()));
        self
    }

    /// Keycaps at the row's end.
    pub fn trailing_shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
        self.trailing = Some(Trailing::Shortcut(shortcut.into()));
        self
    }

    /// A checkable row: `true` shows the 14px tick (and nothing else changes: no fill).
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// `red-ink` text and icon.
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// 28px high instead of 32.
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    fn with_handle(mut self, handle: FocusHandle) -> Self {
        self.handle = Some(handle);
        self
    }
}

impl RenderOnce for MenuRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = self.handle.clone().unwrap_or_else(|| item_focus(&self.id, window, cx));
        let selector = self.id.to_string();
        let height = if self.subtitle.is_some() {
            48.0
        } else if self.compact {
            28.0
        } else {
            32.0
        };
        let tone = if self.danger { theme.red_ink } else { theme.ink };
        let icon_tone = if self.danger { theme.red_ink } else { theme.ink2 };
        let enabled = !self.disabled;
        let checked = self.checked == Some(true);
        row_shell(self.id, handle, px(height), tone, enabled, &theme)
            .debug_selector(move || selector.clone())
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |event, window, cx| handler(event, window, cx)))
            .when_some(self.icon, |el, icon| {
                el.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(20.0))
                        .child(Icon::new(icon).size(IconSize::S14).color(icon_tone)),
                )
            })
            .child(div().flex().flex_col().flex_1().min_w_0().child(div().truncate().child(self.title)).when_some(
                self.subtitle,
                |el, subtitle| {
                    el.child(div().truncate().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(subtitle))
                },
            ))
            .when_some(self.trailing, |el, trailing| match trailing {
                Trailing::Text(text) => {
                    el.child(div().flex_none().text_step(TEXT_11).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(text))
                }
                Trailing::Shortcut(shortcut) => el.child(ShortcutKeys::new(shortcut)),
            })
            .when(checked, |el| {
                el.child(
                    div()
                        .debug_selector(|| "menu-tick".into())
                        .flex_none()
                        .child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink)),
                )
            })
    }
}

/// The shell every menu and picker row shares: the metrics (4px corners, 8px inset, 13 medium), the one moving
/// highlight (`hover-2` on hover, press and keyboard focus) and the inset accent ring on keyboard focus.
pub(super) fn row_shell(
    id: ElementId,
    handle: FocusHandle,
    height: Pixels,
    tone: gpui::Rgba,
    enabled: bool,
    theme: &crate::theme::Theme,
) -> gpui::Stateful<gpui::Div> {
    let (hover2, accent) = (theme.hover2, theme.accent);
    div()
        .id(id)
        .track_focus(&handle)
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(height)
        .px(px(8.0))
        .rounded(RADIUS_INLINE)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(tone)
        .when(enabled, |el| {
            el.cursor_pointer().hover(move |style| style.bg(hover2)).focus_visible(move |style| style.bg(hover2).shadow(inset_ring(accent)))
        })
        .when(!enabled, |el| el.opacity(0.4))
}

enum Item {
    Row(MenuRow),
    Separator,
    Label(SharedString),
}

/// A column of rows, separators and group labels with the menu's keyboard behaviour.
#[derive(IntoElement)]
pub struct MenuList {
    id: ElementId,
    items: Vec<Item>,
    dismiss: Option<Dismiss>,
}

impl MenuList {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self { id: id.into(), items: Vec::new(), dismiss: None }
    }

    /// Closes the popover after a row is pressed.
    pub fn dismiss(mut self, dismiss: &Dismiss) -> Self {
        self.dismiss = Some(dismiss.clone());
        self
    }

    pub fn row(mut self, row: MenuRow) -> Self {
        self.items.push(Item::Row(row));
        self
    }

    /// A hairline between groups.
    pub fn separator(mut self) -> Self {
        self.items.push(Item::Separator);
        self
    }

    /// A group label (11 medium `ink-3`, inset to the rows' text).
    pub fn label(mut self, text: impl Into<SharedString>) -> Self {
        self.items.push(Item::Label(text.into()));
        self
    }
}

impl RenderOnce for MenuList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handles: Vec<FocusHandle> = self
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Row(row) => Some(item_focus(&row.id, window, cx)),
                _ => None,
            })
            .collect();
        // The first row takes focus when the menu opens (`Popover.tsx` focuses its first row).
        let opened = window.use_keyed_state((self.id.clone(), "opened"), cx, |_, _| false);
        if !*opened.read(cx) {
            opened.update(cx, |opened, _| *opened = true);
            if let Some(first) = handles.first().cloned() {
                // After the popover has moved focus into its own panel this frame.
                window.defer(cx, move |window, cx| first.focus(window, cx));
            }
        }
        // Fits its rows, up to the window's height less the popover inset (`Popover.tsx`'s `INSET`): it scrolls
        // only past that, never at a fixed height.
        let available = (window.viewport_size().height - WINDOW_INSET * 2.0).max(px(0.0));
        let key_handles = handles.clone();
        let mut next = handles.clone().into_iter();
        let dismiss = self.dismiss;
        let selector = self.id.to_string();
        let (scroll, fade) = ScrollFade::kept(&self.id, window, cx);
        // The fades sit over the scrolling list, in the popover's surface colour, not in it.
        let menu = div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex()
            .flex_col()
            .gap(px(1.0))
            .max_h(available)
            .overflow_y_scroll()
            .track_scroll(&scroll)
            .on_key_down(move |event: &KeyDownEvent, window, cx| {
                let current = focused_index(&key_handles, window);
                if let Some(to) = roving_index(&event.keystroke.key, current, key_handles.len(), RovingAxis::Vertical) {
                    key_handles[to].focus(window, cx);
                    cx.stop_propagation();
                }
            })
            .children(self.items.into_iter().enumerate().map(move |(ix, item)| {
                match item {
                    Item::Row(mut row) => {
                        let handle = next.next().expect("a handle for every row");
                        if let Some(dismiss) = dismiss.clone() {
                            let own = row.on_click.take();
                            row.on_click = Some(Rc::new(move |event, window, cx| {
                                if let Some(own) = &own {
                                    own(event, window, cx);
                                }
                                dismiss.call(window, cx);
                            }));
                        }
                        row.with_handle(handle).into_any_element()
                    }
                    Item::Separator => {
                        div().id(("separator", ix)).h(px(1.0)).mx(px(8.0)).my(px(4.0)).flex_none().bg(theme.line).into_any_element()
                    }
                    Item::Label(text) => div()
                        .id(("label", ix))
                        .flex_none()
                        .px(px(8.0))
                        .pt(px(8.0))
                        .pb(px(4.0))
                        .child(SectionLabel::new(text).menu())
                        .into_any_element(),
                }
            }));
        div().relative().flex().flex_col().max_h(available).child(menu).child(fade.overlay(theme.surface.into()))
    }
}
