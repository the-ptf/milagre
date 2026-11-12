//! The app shell (WP-18): what the window owns around the columns. After the desktop's `App.tsx` (view routing, the
//! Escape cascade, the 44px title-drag strip), `components/SidebarNav.tsx` (the bar beside the traffic lights),
//! `components/agents/PanelToggles.tsx` (the corner toggles) and `lib/window-chrome.ts` (where those sit).
//!
//! - [`top_bar`]: the bar beside the traffic lights (sidebar toggle, Routines, Link Projects, Search) and the panel
//!   toggle in the window's top-right corner, with the clearance the Chat header and the panel's tab strip keep.
//! - [`keys`]: the shell's commands from the effective key table (⌘B, ⌘N, ⇧⌘T) and the macOS menu bar.
//! - [`window_state`]: the window's frame and the sidebar's collapsed state, saved and restored.
//! - [`persist`]: the small JSON files beside it (diff comments, the merge method).
//!
//! - [`card`]: the Chat card, the one detached part of the window (design `gpui-chat-card-a`).
//!
//! The look is Chat card A: the sidebar, the top row and the panel are one surface under one grain; the bar is drawn
//! over the sidebar's 44px header while the sidebar is open and over the Chat header's leading edge while it is a
//! rail, as the desktop's bar moves.

pub mod card;
pub mod keys;
pub mod persist;
pub mod top_bar;
pub mod window_state;

#[cfg(test)]
mod card_tests;
#[cfg(test)]
mod tests;

use std::rc::Rc;

use gpui::{AnyElement, Context, KeyDownEvent, Window, div, prelude::*};

use self::top_bar::{Bar, CornerItem};
use super::Workspace;
use crate::theme::ActiveTheme;
use crate::workspace::sidebar::SIDEBAR_WIDTH;
use crate::workspace::sidebar::rail::RAIL_WIDTH;

/// What the window shows right of the sidebar. Settings opens over either (`SettingsModal`); the Canvas view is not
/// migrated (PORT-MAP scope decisions).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Chat,
    Routines,
}

/// One step of the Escape cascade (`App.tsx`: Settings, Link, Find, the Run pane, the Routine page, the view, then the
/// Chat's own steps). The Chat's steps (deny an approval, dismiss a question, interrupt) are its own key handlers,
/// deeper in the tree, so they run first while the Chat has focus; these are what is left for the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscapeStep {
    CloseSettings,
    CloseRunPane,
    CloseRoutinePage,
    BackToChat,
}

/// Where the Routines view is, for the cascade.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoutinesState {
    pub run_pane_open: bool,
    pub page_open: bool,
    /// The Routine form is open: its fields and its Cancel own Escape.
    pub editing: bool,
}

/// What the window's state says Escape closes next, or `None` when Escape is not the shell's.
pub fn escape_step(settings_open: bool, view: View, routines: RoutinesState) -> Option<EscapeStep> {
    if settings_open {
        return Some(EscapeStep::CloseSettings);
    }
    let RoutinesState { run_pane_open, page_open: routine_page_open, editing } = routines;
    match view {
        View::Routines if editing => None,
        View::Routines if run_pane_open => Some(EscapeStep::CloseRunPane),
        View::Routines if routine_page_open => Some(EscapeStep::CloseRoutinePage),
        View::Routines => Some(EscapeStep::BackToChat),
        View::Chat => None,
    }
}

/// The command palette's action (`overlays/palette`, WP-50), named so the bar's Search button works once it is
/// registered and does nothing before.
const PALETTE_ACTION: &str = "milagre_overlays::TogglePalette";

/// The shell's part of the Workspace: the view on screen, the bar, the corner and the window-level keys.
impl Workspace {
    pub fn view(&self) -> View {
        if self.routines_open { View::Routines } else { View::Chat }
    }

    /// ⌘B and the bar's toggle.
    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar.update(cx, |sidebar, cx| sidebar.toggle_collapsed(cx));
    }

    /// ⌘N and File › New Chat: the Chat column opens its new-Chat composer, as the sidebar's button does.
    pub fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_new_chat(window, cx);
    }

    /// Escape that no view under focus took (they handle theirs first, bubbling up to here): the window's steps of
    /// the cascade.
    pub(super) fn on_escape_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key != "escape" || event.keystroke.modifiers.modified() {
            return;
        }
        let routines = {
            let r = self.routines.read(cx);
            RoutinesState { run_pane_open: r.run_pane_open(), page_open: r.open.is_some(), editing: r.editing.is_some() }
        };
        let Some(step) = escape_step(self.settings.read(cx).is_open(), self.view(), routines) else { return };
        match step {
            EscapeStep::CloseSettings => self.settings.update(cx, |settings, cx| settings.close(window, cx)),
            EscapeStep::CloseRunPane => self.routines.update(cx, |routines, cx| routines.close_run_chat(cx)),
            EscapeStep::CloseRoutinePage => self.routines.update(cx, |routines, cx| routines.back(cx)),
            EscapeStep::BackToChat => {
                self.routines_open = false;
                cx.notify();
            }
        }
        cx.stop_propagation();
    }

    /// Keys need somewhere to go once Settings closes (its focus goes with it): the window takes it, so ⌘B, Escape
    /// and the menus still reach the Workspace.
    pub(super) fn refocus_after_settings(
        settings: &gpui::Entity<crate::settings::SettingsModal>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut was_open = settings.read(cx).is_open();
        cx.observe_in(settings, window, move |this, settings, window, cx| {
            let open = settings.read(cx).is_open();
            if was_open && !open {
                window.focus(&this.focus, cx);
            }
            was_open = open;
        })
        .detach();
    }

    /// The bar beside the traffic lights, for the root to draw over the columns.
    pub(super) fn top_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let collapsed = self.sidebar.read(cx).is_collapsed();
        // Preview: Routines, Link Projects and Search would show fixture data; they do nothing and show no dot.
        let preview = crate::workspace::preview::is_on(cx);
        let routines_unread = !preview && !self.routines.read(cx).unread_routines.is_empty();
        let this = cx.entity();
        let bar = Bar {
            collapsed,
            routines_active: self.view() == View::Routines,
            routines_unread,
            ground: top_bar::ground(cx),
            on_toggle: Rc::new({
                let this = this.clone();
                move |_, cx| this.update(cx, |this, cx| this.toggle_sidebar(cx))
            }),
            on_routines: Rc::new({
                let this = this.clone();
                // The Chat column (and the composer's focus) goes: the window keeps the keys, for Escape.
                move |window, cx| {
                    if crate::workspace::preview::is_on(cx) {
                        return;
                    }
                    this.update(cx, |this, cx| {
                        this.open_routines(cx);
                        window.focus(&this.focus, cx);
                    })
                }
            }),
            on_link_projects: Rc::new({
                let this = this.clone();
                move |window, cx| {
                    if !crate::workspace::preview::is_on(cx) {
                        this.update(cx, |this, cx| this.open_link_projects_from_bar(window, cx))
                    }
                }
            }),
            on_search: Rc::new(|window, cx| {
                if crate::workspace::preview::is_on(cx) {
                    return;
                }
                if let Ok(action) = cx.build_action(PALETTE_ACTION, None) {
                    window.dispatch_action(action, cx);
                }
            }),
        };
        top_bar::bar(bar, cx.theme())
    }

    /// The Chat column on the card, its header (in the top row, outside the card) kept clear of the bar and of the
    /// panel toggle (the window root draws both; see [`Self::corner`]).
    pub(super) fn chat_column(&self, column: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        let collapsed = self.sidebar.read(cx).is_collapsed() && self.link.is_none();
        // As a rail, the lights and the bar reach over the Chat header's leading edge. The header starts inside the
        // card's border.
        let column_left = if collapsed { RAIL_WIDTH } else { SIDEBAR_WIDTH } + card::CARD_BORDER;
        // The toggle sits at the card's right edge, in the top row: so the panel's tab strip keeps its whole width.
        let trailing = top_bar::chat_trailing_inset(1);
        let leading = top_bar::chat_leading_inset(column_left);
        self.chat.update(cx, |chat, _| chat.set_header_insets(leading, trailing));
        self.panel.update(cx, |panel, cx| panel.set_header_trailing(gpui::px(0.0), cx));
        let open = self.panel.read(cx).is_open();
        card::column(column, open, cx.theme(), &self.card_grain)
    }

    /// The Routines page on the card, under an empty top row that still drags the window.
    pub(super) fn routines_column(&self, cx: &mut Context<Self>) -> AnyElement {
        let page = div()
            .flex()
            .flex_col()
            .size_full()
            .child(crate::workspace::chrome::top_row("routines-top-row"))
            .child(div().flex_none().h(card::header_gap()))
            .child(div().flex().flex_1().min_h_0().child(self.routines.clone()))
            .into_any_element();
        card::column(page, false, cx.theme(), &self.card_grain)
    }

    /// The panel toggle at the window's top-right, in the top bar's row. Not shown on the Routines page, which has
    /// no panel, or over the Link workspace, which draws its own.
    pub(super) fn corner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        // Preview: there is no side panel to toggle.
        if self.routines_open || self.link.is_some() || crate::workspace::preview::is_on(cx) {
            return None;
        }
        let items = self.corner_items(cx);
        let panel = self.panel.clone();
        let on_toggle: top_bar::CornerHandler = Rc::new(move |_, _, cx| {
            panel.update(cx, |panel, cx| {
                let tab = panel.active();
                panel.toggle_tab(tab, cx)
            })
        });
        let panel = self.panel.read(cx);
        // The card's right edge, from the window's.
        let card_right = card::right_gap(panel.is_open()) + if panel.is_open() { panel.live_width(cx) } else { 0.0 };
        Some(top_bar::corner(&items, card_right, on_toggle))
    }

    /// The corner's toggles for the Chat on screen.
    pub fn corner_items(&self, cx: &gpui::App) -> Vec<CornerItem> {
        top_bar::corner_items(self.panel.read(cx).is_open())
    }
}
