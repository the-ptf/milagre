//! Root view: three flush, full-height columns separated by 1px hairlines.
//!
//! How re-rendering works in this GPUI, and so how the views are mounted (CONVENTIONS.md has the rule):
//! a `cx.notify()` re-renders the notifying view and every view on the path up to this root. A view that
//! re-renders re-renders its plain child views too, but reuses the last frame of its cached ones
//! (`AnyView::cached`) unless they are dirty themselves; a dirty cached view re-renders its whole subtree,
//! cached views inside it included.
//!
//! So only the panel is cached here: nothing inside it changes on its own. The sidebar and the Chat column
//! are plain children, because things inside them change all the time (a spinner turns in a sidebar row,
//! the composer takes a key) and a cached container would then rebuild everything under it. Their renders
//! stay cheap instead: the sidebar's rows, the transcript and the running row are cached leaves inside them.

pub mod chat;
pub mod chrome;
mod overlays;
pub mod panel;
pub mod shell;
pub mod sidebar;

#[cfg(test)]
mod tests;

use gpui::{Context, Entity, KeyBinding, Subscription, Window, div, prelude::*, px};

use crate::overlays::palette::{PaletteEvent, PaletteView};
use crate::overlays::{OpenGitActions, TogglePalette};
use crate::routines::RoutinesView;
use crate::settings::{self, SettingsModal, ToggleSettings};
use crate::theme::{ActiveTheme, Theme};
use crate::workspace::chat::{ChatEvent, ChatView};
use crate::workspace::panel::dock;
use crate::workspace::panel::terminal::{self, TerminalDrawer};
use crate::workspace::panel::{Panel, PanelEvent};
use crate::workspace::shell::keys::{NewChat, ToggleSidebar};
use crate::workspace::sidebar::{Sidebar, SidebarEvent};

pub struct Workspace {
    pub sidebar: Entity<Sidebar>,
    pub chat: Entity<ChatView>,
    pub panel: Entity<Panel>,
    pub settings: Entity<SettingsModal>,
    /// ⌘K (WP-50), above everything else.
    pub palette: Entity<PaletteView>,
    dialog_host: crate::overlays::dialogs::Host,
    /// The window's own focus, where it falls back to when a modal closes over a column that is gone.
    focus: gpui::FocusHandle,
    allow_prompt: Entity<crate::overlays::dialogs::allow_prompt::ComputerAllowPrompt>,
    /// Each Chat's Terminals, in a drawer under the Chat column.
    pub terminals: Entity<TerminalDrawer>,
    /// The Routines page, in place of the Chat column while the sidebar's Routines button is on (WP-45).
    pub routines: Entity<RoutinesView>,
    routines_open: bool,
    /// The sidebar row picked when Routines opened: a different pick closes it.
    routines_at: Option<usize>,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        shell::keys::install_keys(cx);
        dock::install_keys(cx);
        settings::init(cx);
        cx.bind_keys([KeyBinding::new("cmd-k", TogglePalette, None)]);
        let (sidebar, chat, panel, settings) =
            (cx.new(Sidebar::new), cx.new(ChatView::new), cx.new(Panel::new), cx.new(SettingsModal::new));
        // The panel's place in the window changed: lay the columns out again.
        let layout = cx.subscribe_in(&panel, window, |this, _, event: &PanelEvent, window, cx| match event {
            PanelEvent::Layout => cx.notify(),
            PanelEvent::FixInChat(text) => this.fix_in_chat(text, window, cx),
        });
        let palette = cx.new(PaletteView::new);
        let dialog_host: crate::overlays::dialogs::Host = std::rc::Rc::new(crate::overlays::dialogs::FixtureHost::new());
        let allow_prompt = crate::overlays::dialogs::allow_prompt::new(dialog_host.clone(), "this computer", cx);
        let palette_events =
            cx.subscribe_in(&palette, window, |this, _, event: &PaletteEvent, window, cx| this.on_palette_event(event, window, cx));
        let new_chat = cx.subscribe(&sidebar, |this, _, event: &SidebarEvent, cx| match event {
            SidebarEvent::NewChat => {
                this.routines_open = false;
                this.chat.update(cx, |chat, cx| chat.composer.update(cx, |composer, cx| composer.start_new_chat(cx)))
            }
            SidebarEvent::Routines => this.open_routines(cx),
        });
        let open_chat = cx.subscribe(&chat, |this, _, event: &ChatEvent, cx| {
            if let ChatEvent::OpenChat(key) = event {
                this.sidebar.update(cx, |sidebar, cx| sidebar.select_key(key, cx));
            }
        });
        let follow = cx.observe(&sidebar, |this, _, cx| this.follow_sidebar(None, cx));
        // A web page draws over GPUI: it hides while Settings is open (src/platform/webview.rs).
        let web = cx
            .observe(&settings, |_, settings, cx| crate::platform::webview::set_overlay_open("settings", settings.read(cx).is_open(), cx));
        Self::refocus_after_settings(&settings, window, cx);
        let routines = cx.new(|cx| RoutinesView::new(window, cx));
        let routines_open = crate::routines::start_from_env().is_some();
        let routines_at = sidebar.read(cx).selected();
        Self {
            sidebar,
            chat,
            panel,
            settings,
            palette,
            dialog_host,
            focus: cx.focus_handle(),
            allow_prompt,
            terminals: cx.new(TerminalDrawer::new),
            routines,
            routines_open,
            routines_at,
            _subscriptions: vec![layout, follow, web, new_chat, open_chat, palette_events],
        }
    }

    /// The sidebar's Routines button: the Routines page takes the Chat column's place until another Chat is picked.
    fn open_routines(&mut self, cx: &mut Context<Self>) {
        self.routines_open = true;
        self.routines_at = self.sidebar.read(cx).selected();
        cx.notify();
    }

    /// A different Chat picked in the sidebar: the panel shows that Chat's tab and width. The sidebar does not
    /// notify itself on a selection (only the two rows do, and every view above them re-renders), so `render`
    /// calls this too; it is two reads when nothing changed.
    fn follow_sidebar(&mut self, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let sidebar = self.sidebar.read(cx);
        let row = sidebar.selected().and_then(|ix| sidebar.row(ix)).cloned();
        let Some(row) = row else { return };
        if self.panel.read(cx).chat() != row.key.as_ref() {
            let key = row.key.clone();
            self.panel.update(cx, |panel, cx| panel.set_chat(key, cx));
        }
        self.terminals.update(cx, |terminals, cx| terminals.set_chat(row.key.clone(), cx));
        // The Chat column needs the window (the composer's text area); `render` always follows too.
        if let Some(window) = window
            && self.chat.read(cx).key() != Some(row.key.as_ref())
        {
            self.chat.update(cx, |chat, cx| chat.set_chat(&row, window, cx));
            let chats = self.sidebar.read(cx).family_chats();
            self.chat.update(cx, |chat, cx| chat.set_family(&chats, cx));
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.follow_sidebar(Some(window), cx);
        Self::open_overlay_from_env(window, cx);
        let theme = *cx.theme();
        if self.routines_open {
            // The first row picked after the sidebar loads is not a different pick.
            let picked = self.sidebar.read(cx).selected();
            if self.routines_at.is_none() {
                self.routines_at = picked;
            } else if picked != self.routines_at {
                self.routines_open = false;
            }
        }
        let columns = if self.routines_open {
            div().flex().flex_1().min_w_0().h_full().child(self.routines.clone()).into_any_element()
        } else {
            let column = self.chat_column(terminal::column(self.chat.clone(), &self.terminals, window, cx), cx);
            dock::layout(&self.panel, column, cx)
        };
        let settings = self.settings.clone();
        let palette = self.palette.clone();
        terminal::on_actions(dock::on_actions(div(), &self.panel), &self.terminals)
            .id("workspace")
            .track_focus(&self.focus)
            .on_action(move |_: &ToggleSettings, window, cx| {
                settings.update(cx, |modal, cx| modal.toggle(window, cx));
            })
            .on_action(cx.listener(|this, _: &TogglePalette, window, cx| this.toggle_palette(window, cx)))
            .on_action(cx.listener(|this, _: &OpenGitActions, window, cx| this.open_git_actions(window, cx)))
            .relative()
            .flex()
            .flex_row()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            // The shell's window-level keys: ⌘B, ⌘N, the Window menu, and Escape after every view under focus.
            .on_key_down(cx.listener(Self::on_escape_key))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &NewChat, _, cx| this.new_chat(cx)))
            .map(shell::keys::on_window_actions)
            .child(self.sidebar.clone())
            .child(hairline(&theme))
            .child(columns)
            // Over the columns' headers, under Settings and the overlays.
            .child(self.top_bar(cx))
            .child(self.settings.clone())
            .child(palette)
    }
}

fn hairline(theme: &Theme) -> impl IntoElement + use<> {
    div().flex_none().w(px(1.0)).h_full().bg(theme.line)
}
