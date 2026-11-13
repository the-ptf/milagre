//! The window's side of the Link workspace and of ⌘F: what `workspace/mod.rs` calls, kept here so the shared root file
//! only gains a few lines.

use gpui::{AnyElement, Context, Entity, InteractiveElement, KeyBinding, Subscription, Window, div, prelude::*};

use super::{LinkEvent, LinkWorkspace};
use crate::workspace::Workspace;
use crate::workspace::chat::find_bar::FindInChat;

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
    /// Binds ⌘F for the window, once per app.
    pub(crate) fn install_window_keys(cx: &mut Context<Self>) {
        install_window_find(cx);
    }

    /// The root's find handler: ⌘F for the open Chat (the Link's Chat while a Link is open).
    pub(crate) fn window_actions<E: InteractiveElement>(&self, element: E, cx: &mut Context<Self>) -> E {
        element.key_context(WORKSPACE_CONTEXT).on_action(cx.listener(|this, _: &FindInChat, window, cx| {
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
