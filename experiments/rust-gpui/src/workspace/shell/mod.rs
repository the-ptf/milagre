//! The app shell (WP-18): what the window owns around the columns. After the desktop's `App.tsx` (view routing, the
//! Escape cascade, the 44px title-drag strip), `components/SidebarNav.tsx` (the bar beside the traffic lights),
//! `components/agents/PanelToggles.tsx` (the corner toggles) and `lib/window-chrome.ts` (where those sit).
//!
//! - [`top_bar`]: the bar beside the traffic lights (sidebar toggle, Routines, Link Projects, Search) and the panel
//!   toggles in the Chat column's top-right corner, with the clearance the Chat header keeps from both.
//! - [`keys`]: the shell's commands from the effective key table (⌘B, ⌘N, ⇧⌘T) and the macOS menu bar.
//! - [`window_state`]: the window's frame and the sidebar's collapsed state, saved and restored.
//!
//! The look stays design A (the integrated sidebar): the bar is drawn over the sidebar's 44px header while the
//! sidebar is open and over the Chat header's leading edge while it is a rail, as the desktop's bar moves.

pub mod keys;
pub mod top_bar;
pub mod window_state;

#[cfg(test)]
mod tests;

use std::rc::Rc;

use gpui::{AnyElement, Context, KeyDownEvent, Window, div, prelude::*};

use self::top_bar::{Bar, Corner, CornerItem};
use super::Workspace;
use crate::theme::ActiveTheme;
use crate::workspace::sidebar::{SIDEBAR_WIDTH, rail::RAIL_WIDTH};

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
    pub fn new_chat(&mut self, cx: &mut Context<Self>) {
        self.routines_open = false;
        self.chat.update(cx, |chat, cx| chat.composer.update(cx, |composer, cx| composer.start_new_chat(cx)));
        cx.notify();
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
        let routines_unread = !self.routines.read(cx).unread_routines.is_empty();
        let this = cx.entity();
        let bar = Bar {
            collapsed,
            routines_active: self.view() == View::Routines,
            routines_unread,
            ground: top_bar::ground(collapsed, cx),
            on_toggle: Rc::new({
                let this = this.clone();
                move |_, cx| this.update(cx, |this, cx| this.toggle_sidebar(cx))
            }),
            on_routines: Rc::new({
                let this = this.clone();
                // The Chat column (and the composer's focus) goes: the window keeps the keys, for Escape.
                move |window, cx| {
                    this.update(cx, |this, cx| {
                        this.open_routines(cx);
                        window.focus(&this.focus, cx);
                    })
                }
            }),
            on_search: Rc::new(|window, cx| {
                if let Ok(action) = cx.build_action(PALETTE_ACTION, None) {
                    window.dispatch_action(action, cx);
                }
            }),
        };
        top_bar::bar(bar, cx.theme())
    }

    /// The Chat column with the corner toggles over its top-right, and its header kept clear of them and of the bar.
    pub(super) fn chat_column(&self, column: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        let items = self.corner_items(cx);
        let collapsed = self.sidebar.read(cx).is_collapsed();
        let column_left = if collapsed { RAIL_WIDTH } else { SIDEBAR_WIDTH } + 1.0;
        let insets = (top_bar::chat_leading_inset(column_left), top_bar::chat_trailing_inset(items.len()));
        self.chat.update(cx, |chat, _| chat.set_header_insets(insets.0, insets.1));
        let (panel, terminals) = (self.panel.clone(), self.terminals.clone());
        let on_toggle: top_bar::CornerHandler = Rc::new(move |corner, window, cx| match corner {
            Corner::Terminal => terminals.update(cx, |drawer, cx| drawer.toggle(window, cx)),
            Corner::Tab(tab) => panel.update(cx, |panel, cx| panel.toggle_tab(tab, cx)),
        });
        div().relative().size_full().min_w_0().child(column).child(top_bar::corner(&items, on_toggle)).into_any_element()
    }

    /// The corner's toggles for the Chat on screen.
    pub fn corner_items(&self, cx: &gpui::App) -> Vec<CornerItem> {
        let panel = self.panel.read(cx);
        let showing = (panel.is_open() && !panel.is_expanded()).then(|| panel.active());
        top_bar::corner_items(&panel.visible_tabs(), showing, self.terminals.read(cx).is_open())
    }
}
