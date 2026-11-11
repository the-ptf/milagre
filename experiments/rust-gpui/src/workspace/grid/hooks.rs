//! The window's side of the grid, the split and the Link workspace: what `workspace/mod.rs` calls, kept here so the
//! shared root file only gains a few lines.

use gpui::{AnyElement, Context, Entity, InteractiveElement, KeyBinding, Subscription, Window, div, prelude::*};

use super::{ChatGrid, GridEvent, ToggleGrid, tile};
use crate::workspace::Workspace;
use crate::workspace::chat::find_bar::FindInChat;
use crate::workspace::chat::{ChatEvent, ChatView};
use crate::workspace::link::{LinkEvent, LinkWorkspace};
use crate::workspace::shell::top_bar;
use crate::workspace::sidebar::{SIDEBAR_WIDTH, Sidebar, rail::RAIL_WIDTH};

/// The root's key context: ⌘F reaches the open Chat's find bar from anywhere in the window.
pub const WORKSPACE_CONTEXT: &str = "Workspace";

/// ⌘F (`chat.find`) in the window's own context, once per app. The Chat column binds the same keys in its deeper
/// context, so while focus is in a Chat its own handler runs first.
fn install_window_find(cx: &mut gpui::App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    use crate::logic::keybindings::{GpuiOptions, default_keybindings, gpui_bindings};
    let keys: Vec<KeyBinding> = gpui_bindings(&default_keybindings(), cfg!(target_os = "macos"), GpuiOptions::default())
        .into_iter()
        .filter(|binding| binding.command == "chat.find")
        .map(|binding| {
            let stroke: &'static str = binding.keystroke.leak();
            KeyBinding::new(stroke, FindInChat, Some(WORKSPACE_CONTEXT))
        })
        .collect();
    cx.bind_keys(keys);
}

/// An open Link workspace and its subscription.
pub struct OpenLink {
    pub view: Entity<LinkWorkspace>,
    _events: Subscription,
}

impl Workspace {
    /// Makes the grid around the window's Chat column and wires its events: a tile focused opens that Chat; the family
    /// menu's "Open beside parent" and "Show all N side by side" open the split.
    pub(crate) fn new_grid(
        sidebar: &Entity<Sidebar>,
        chat: &Entity<ChatView>,
        cx: &mut Context<Self>,
    ) -> (Entity<ChatGrid>, Vec<Subscription>) {
        super::install_keys(cx);
        install_window_find(cx);
        let grid = cx.new(|cx| ChatGrid::new(chat.clone(), cx));
        let sidebar = sidebar.clone();
        let focus = cx.subscribe(&grid, move |_, _, event: &GridEvent, cx| match event {
            GridEvent::Focus(key) => sidebar.update(cx, |sidebar, cx| sidebar.select_key(key, cx)),
        });
        let split = cx.subscribe(chat, |this, _, event: &ChatEvent, cx| match event {
            ChatEvent::Beside(parent) => this.grid.update(cx, |grid, cx| grid.open_beside(parent, cx)),
            ChatEvent::ShowAll => this.grid.update(cx, |grid, cx| grid.show_family(cx)),
            _ => {}
        });
        (grid, vec![focus, split])
    }

    /// The Chat column's body: the grid, whose focused tile holds the Chat column (or which shows it alone). Brings the
    /// grid up to date with the sidebar first.
    pub(crate) fn chat_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let focused = self.chat.read(cx).key().map(str::to_string);
        let (rows, family, collapsed) = {
            let sidebar = self.sidebar.read(cx);
            let rows: Vec<_> = (0..sidebar.row_count()).filter_map(|ix| sidebar.row(ix).cloned()).collect();
            (rows, sidebar.family_chats(), sidebar.is_collapsed())
        };
        // Snapshot seed (never in tests): `MILAGRE_GPUI_GRID` closes the side panel, so the grid has the room for two columns.
        {
            use std::sync::atomic::{AtomicBool, Ordering};
            static SEEDED: AtomicBool = AtomicBool::new(false);
            if !cfg!(test) && std::env::var_os("MILAGRE_GPUI_GRID").is_some() && !SEEDED.swap(true, Ordering::Relaxed) {
                self.panel.update(cx, |panel, cx| panel.close(cx));
            }
        }
        let panel = self.panel.read(cx);
        let panel_width = if panel.is_open() && !panel.is_expanded() { panel.width() } else { 0.0 };
        let left = if collapsed { RAIL_WIDTH } else { SIDEBAR_WIDTH } + 1.0;
        let width = f32::from(window.viewport_size().width) - left - panel_width;
        self.grid.update(cx, |grid, cx| grid.sync(focused.as_deref(), &rows, family, width, cx));
        let tiled = self.grid.read(cx).has_tiles();
        self.chat.update(cx, |chat, cx| chat.set_tiled(tiled, cx));
        // Always the grid: alone, it draws the Chat column and is still the pane a drop lands beside.
        self.grid.clone().into_any_element()
    }

    /// The corner's grid and Subchats buttons left of the panel toggles, with the Chat header kept clear of them.
    pub(crate) fn grid_corner(&self, column: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        let items = self.corner_items(cx).len();
        let extra = tile::corner_count(self.grid.read(cx));
        let leading = self.chat.read(cx).header_insets().0;
        self.chat.update(cx, |chat, _| chat.set_header_insets(leading, top_bar::chat_trailing_inset(items + extra)));
        div().relative().size_full().min_w_0().child(column).child(tile::corner_buttons(&self.grid, items, cx)).into_any_element()
    }

    /// The root's grid and find handlers: ⌘⇧M, and ⌘F for the open Chat (the grid's focused tile, or the Link's Chat).
    pub(crate) fn grid_actions<E: InteractiveElement>(&self, element: E, cx: &mut Context<Self>) -> E {
        element
            .key_context(WORKSPACE_CONTEXT)
            .on_action(cx.listener(|this, _: &ToggleGrid, _, cx| {
                if this.link.is_none() && !this.routines_open {
                    this.grid.update(cx, |grid, cx| grid.toggle_grid(cx));
                }
            }))
            .on_action(cx.listener(|this, _: &FindInChat, window, cx| {
                if let Some(link) = &this.link {
                    let chat = link.view.read(cx).chat.clone();
                    chat.update(cx, |chat, cx| chat.open_find(None, window, cx));
                } else if !this.routines_open {
                    this.chat.update(cx, |chat, cx| chat.open_find(None, window, cx));
                }
            }))
    }

    /// Opens the Link workspace (on fixture data) in place of the sidebar and the columns.
    pub fn open_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.link.is_some() {
            return;
        }
        let view = cx.new(|cx| LinkWorkspace::new(window, cx));
        let events = cx.subscribe(&view, |this, _, event: &LinkEvent, cx| match event {
            LinkEvent::Close => this.close_link(cx),
        });
        self.link = Some(OpenLink { view, _events: events });
        cx.notify();
    }

    pub fn close_link(&mut self, cx: &mut Context<Self>) {
        if self.link.take().is_some() {
            cx.notify();
        }
    }

    /// The Link workspace when one is open, else `columns`.
    pub(crate) fn link_or(&self, columns: AnyElement) -> AnyElement {
        match &self.link {
            Some(link) => div().flex().flex_1().min_w_0().h_full().child(link.view.clone()).into_any_element(),
            None => columns,
        }
    }

    /// Snapshot seed (never in tests): `MILAGRE_GPUI_LINK=1` opens the Link workspace on the first frame.
    pub(crate) fn open_link_from_env(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use std::sync::atomic::{AtomicBool, Ordering};
        static SEEDED: AtomicBool = AtomicBool::new(false);
        if !cfg!(test) && std::env::var_os("MILAGRE_GPUI_LINK").is_some() && !SEEDED.swap(true, Ordering::Relaxed) {
            self.open_link(window, cx);
        }
    }
}
