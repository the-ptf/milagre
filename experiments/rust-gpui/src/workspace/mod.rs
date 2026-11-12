//! Root view: the sidebar, the Chat card and the side panel on one surface (`canvas`, one film grain under all of
//! them, no lines between them); the Chat card (`shell/card.rs`) is the only detached part.
//!
//! How re-rendering works in this GPUI, and so how the views are mounted (CONVENTIONS.md has the rule):
//! a `cx.notify()` re-renders the notifying view and every view on the path up to this root. A view that
//! re-renders re-renders its plain child views too, but reuses the last frame of its cached ones
//! (`AnyView::cached`) unless they are dirty themselves; a dirty cached view re-renders its whole subtree,
//! cached views inside it included.
//!
//! So only the panel and the grain are cached here: nothing inside it changes on its own. The sidebar and the Chat column
//! are plain children, because things inside them change all the time (a spinner turns in a sidebar row,
//! the composer takes a key) and a cached container would then rebuild everything under it. Their renders
//! stay cheap instead: the sidebar's rows, the transcript and the running row are cached leaves inside them.

pub mod chat;
pub mod chrome;
pub mod link;
mod overlays;
pub mod panel;
pub mod preview;
pub mod shell;
pub mod sidebar;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wiring_tests;

use gpui::{Context, Entity, KeyBinding, Subscription, Window, div, prelude::*};

use crate::overlays::palette::{PaletteEvent, PaletteView};
use crate::overlays::{OpenGitActions, TogglePalette};
use crate::routines::RoutinesView;
use crate::settings::{self, SettingsModal, ToggleSettings};
use crate::theme::ActiveTheme;
use crate::ui::grain::GrainView;
use crate::workspace::chat::{ChatEvent, ChatView};
use crate::workspace::panel::dock;
use crate::workspace::panel::terminal::{self, TerminalDrawer};
use crate::workspace::panel::{Panel, PanelEvent};
use crate::workspace::shell::keys::{NewChat, ToggleSidebar};
use crate::workspace::sidebar::{Sidebar, SidebarEvent};

pub struct Workspace {
    pub sidebar: Entity<Sidebar>,
    pub chat: Entity<ChatView>,
    /// The Link workspace, in place of the sidebar and the columns while open (WP-48).
    pub link: Option<link::hooks::OpenLink>,
    pub panel: Entity<Panel>,
    /// The film grain under the whole window: the sidebar, the top row and the panel are transparent over it.
    pub grain: Entity<GrainView>,
    /// The Chat card's own grain, stronger than the surface's (`shell/card.rs`).
    pub card_grain: Entity<GrainView>,
    pub settings: Entity<SettingsModal>,
    /// ⌘K (WP-50), above everything else.
    pub palette: Entity<PaletteView>,
    dialog_host: crate::overlays::dialogs::Host,
    /// The window's own focus, where it falls back to when a modal closes over a column that is gone.
    focus: gpui::FocusHandle,
    allow_prompt: Entity<crate::overlays::dialogs::allow_prompt::ComputerAllowPrompt>,
    /// The update pill and card, the provider update card and the host and save notices (WP-52).
    pub notices: Entity<crate::notices::NoticesLayer>,
    /// First launch with no Project: the agent and Project steps over the whole window (WP-51).
    pub onboarding: Entity<crate::onboarding::OnboardingLayer>,
    /// Each Chat's Terminals, in a drawer under the Chat column.
    pub terminals: Entity<TerminalDrawer>,
    /// The Routines page, in place of the Chat column while the sidebar's Routines button is on (WP-45).
    pub routines: Entity<RoutinesView>,
    routines_open: bool,
    /// The sidebar row picked when Routines opened: a different pick closes it.
    routines_at: Option<usize>,
    /// The Project the empty new-Chat screen started in, for the Chat its first message makes.
    new_chat_project: Option<String>,
    /// Snapshot seed (never in tests): `MILAGRE_GPUI_NEW_CHAT=1` opens on the empty new-Chat screen.
    seed_new_chat: bool,
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
        let notices = cx.new(|cx| crate::notices::NoticesLayer::new(dialog_host.clone(), cx));
        let update = notices.read(cx).update.clone();
        crate::notices::driver::install(&update, cx);
        let onboarding = cx.new(|cx| crate::onboarding::OnboardingLayer::new(window, cx));
        // A Project opened from onboarding starts its first Chat with the starter tasks over the composer.
        let first_chat = cx.subscribe(&onboarding, |this, _, event: &crate::onboarding::OnboardingEvent, cx| {
            if let crate::onboarding::OnboardingEvent::Opened { name, .. } = event {
                this.chat.update(cx, |chat, cx| {
                    chat.composer.update(cx, |composer, cx| {
                        composer.start_new_chat(cx);
                        composer.set_starters(Some(name), cx);
                    })
                });
            }
        });
        let notice_events = cx.subscribe_in(&notices, window, |this, _, event: &crate::notices::NoticeEvent, window, cx| match event {
            crate::notices::NoticeEvent::OpenSettings => this.settings.update(cx, |settings, cx| settings.open(window, cx)),
        });
        let palette_events =
            cx.subscribe_in(&palette, window, |this, _, event: &PaletteEvent, window, cx| this.on_palette_event(event, window, cx));
        let new_chat = cx.subscribe_in(&sidebar, window, |this, _, event: &SidebarEvent, window, cx| match event {
            SidebarEvent::NewChat => this.show_new_chat(window, cx),
            // The live data layer loads it (its controller subscribes); the fixture has no unloaded Projects.
            SidebarEvent::OpenProject(_) => {}
        });
        // A Subchat picked in the Details panel opens although the sidebar has no row for it.
        let details = panel.read(cx).details().clone();
        let open_subchat = cx.subscribe(&details, |this, _, event: &crate::workspace::panel::details::DetailsEvent, cx| {
            let crate::workspace::panel::details::DetailsEvent::OpenChat(key) = event;
            this.open_chat_key(key, cx);
        });
        let open_chat = cx.subscribe_in(&chat, window, |this, _, event: &ChatEvent, window, cx| {
            if let ChatEvent::OpenChat(key) = event {
                this.open_chat_key(key, cx);
            }
            if let ChatEvent::StartChat(text) = event {
                this.start_chat_from(text, window, cx);
            }
        });
        Self::install_window_keys(cx);
        let follow = cx.observe(&sidebar, |this, _, cx| this.follow_sidebar(None, cx));
        // A web page draws over GPUI: it hides while Settings is open (src/platform/webview.rs).
        let web = cx
            .observe(&settings, |_, settings, cx| crate::platform::webview::set_overlay_open("settings", settings.read(cx).is_open(), cx));
        // The palette draws over the page too.
        let palette_web = cx.observe(&palette, |_, palette, cx| {
            crate::platform::webview::set_overlay_open("palette", palette.read(cx).is_open(), cx);
        });
        Self::refocus_after_settings(&settings, window, cx);
        let routines = cx.new(|cx| RoutinesView::new(window, cx));
        let routines_open = crate::routines::start_from_env().is_some();
        let routines_at = sidebar.read(cx).selected();
        Self {
            sidebar,
            chat,
            link: None,
            panel,
            grain: cx.new(|_| GrainView::new()),
            card_grain: cx.new(|_| GrainView::card()),
            settings,
            palette,
            dialog_host,
            focus: cx.focus_handle(),
            allow_prompt,
            notices,
            onboarding,
            terminals: cx.new(TerminalDrawer::new),
            routines,
            routines_open,
            routines_at,
            new_chat_project: None,
            seed_new_chat: std::env::var_os("MILAGRE_GPUI_NEW_CHAT").is_some(),
            _subscriptions: vec![
                layout,
                follow,
                web,
                palette_web,
                new_chat,
                open_chat,
                open_subchat,
                palette_events,
                notice_events,
                first_chat,
            ],
        }
    }

    /// New Chat (the sidebar's button, ⌘N, the palette): the Chat column clears to the empty new-Chat screen, the
    /// sidebar selection goes, and the panel is closed with it (it has no Chat to show).
    pub fn show_new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.routines_open = false;
        let project = self.sidebar.read(cx).new_chat_project().unwrap_or_default();
        self.new_chat_project = Some(project.clone());
        self.sidebar.update(cx, |sidebar, cx| sidebar.clear_selection(cx));
        self.chat.update(cx, |chat, cx| chat.set_new_chat(&project, window, cx));
        self.panel.update(cx, |panel, cx| {
            panel.set_chat("", cx);
            panel.close(cx);
        });
        self.terminals.update(cx, |terminals, cx| terminals.set_chat("".into(), cx));
        cx.notify();
    }

    /// The first message sent on the empty new-Chat screen: a fixture Chat joins the sidebar and opens.
    fn start_chat_from(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let project = self.new_chat_project.take();
        let Some(row) = self.sidebar.update(cx, |sidebar, cx| sidebar.create_chat(text, project.as_deref(), cx)) else { return };
        self.follow_sidebar(Some(window), cx);
        self.chat.update(cx, |chat, cx| chat.start_chat(&row, text, window, cx));
        cx.notify();
    }

    /// Opens a Chat by key, with or without a sidebar row (the sidebar lists top-level Chats only). The Details panel's
    /// `DetailsEvent::OpenChat(key)` calls this.
    pub fn open_chat_key(&mut self, key: &str, cx: &mut Context<Self>) {
        self.sidebar.update(cx, |sidebar, cx| sidebar.open_key(key, cx));
        cx.notify();
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
        let row = self.sidebar.read(cx).selected_row().cloned();
        let Some(row) = row else { return };
        // Preview: the panel is hidden and holds fixture data; following the Chat would load it (and compile the
        // highlighting grammars of its files, about 170 MB kept for the process's life) for nothing.
        let preview = preview::is_on(cx);
        if !preview && self.panel.read(cx).chat() != row.key.as_ref() {
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
            if !preview {
                self.panel.update(cx, |panel, cx| panel.set_family(&chats, cx));
            }
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.follow_sidebar(Some(window), cx);
        if std::mem::take(&mut self.seed_new_chat) {
            self.show_new_chat(window, cx);
        }
        // A dialog or sheet (gpui-component's layers in `Root`) draws over the page: hide it while one is open.
        {
            use gpui_component::WindowExt as _;
            let open = window.has_active_dialog(cx) || window.has_active_sheet(cx);
            crate::platform::webview::set_overlay_open("dialog", open, cx);
        }
        Self::open_overlay_from_env(window, cx);
        self.open_link_from_env(window, cx);
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
        let preview = preview::is_on(cx);
        let columns = if preview {
            // Preview: the Chat column and its Terminal; the panel only once a data layer feeds its Changes (the one
            // tab the runtime backs), with its diff over the Chat as in the app. Routines are not backed.
            let body = self.chat.clone().into_any_element();
            let live_panel = self.panel.read(cx).is_live();
            let body = if live_panel { self.diff_over_chat(body, window, cx) } else { body };
            let column = self.chat_column(terminal::column(body, &self.terminals, window, cx), cx);
            if live_panel { dock::layout(&self.panel, column, cx) } else { column }
        } else if self.routines_open {
            div().flex().flex_1().min_w_0().h_full().child(self.routines_column(cx)).into_any_element()
        } else {
            let body = self.chat.clone().into_any_element();
            let body = self.diff_over_chat(body, window, cx);
            let column = self.chat_column(terminal::column(body, &self.terminals, window, cx), cx);
            dock::layout(&self.panel, column, cx)
        };
        let columns = self.link_or(columns);
        let settings = self.settings.clone();
        let palette = self.palette.clone();
        // The Link workspace draws its own columns on the page; everything else sits on the one grained surface.
        let surface = if self.link.is_some() { theme.page } else { theme.canvas };
        let grain = self.link.is_none().then(|| {
            gpui::AnyView::from(self.grain.clone())
                .cached(gpui::StyleRefinement::default().absolute().top_0().left_0().size_full())
                .into_any_element()
        });
        terminal::on_actions(dock::on_actions(div(), &self.panel), &self.terminals)
            .id("workspace")
            .track_focus(&self.focus)
            .on_action(move |_: &ToggleSettings, window, cx| {
                // Preview: Settings would show the fixture's values; it stays closed.
                if !preview::is_on(cx) {
                    settings.update(cx, |modal, cx| modal.toggle(window, cx));
                }
            })
            .on_action(cx.listener(|this, _: &TogglePalette, window, cx| this.toggle_palette(window, cx)))
            .on_action(cx.listener(|this, _: &OpenGitActions, window, cx| this.open_git_actions(window, cx)))
            .relative()
            .flex()
            .size_full()
            .bg(surface)
            .text_color(theme.ink)
            .font_family(crate::theme::ui_font())
            // The shell's window-level keys: ⌘B, ⌘N, the Window menu, and Escape after every view under focus.
            .on_key_down(cx.listener(Self::on_escape_key))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &NewChat, window, cx| this.new_chat(window, cx)))
            .map(shell::keys::on_window_actions)
            .map(|el| self.window_actions(el, cx))
            .map(|el| self.sidebar_drag(el, cx))
            // One top row in every state: open, the sidebar's header carries the traffic lights and the bar; as a rail they
            // run on over the Chat header's leading edge.
            .flex_row()
            // First, so everything paints over it.
            .children(grain)
            .when(self.link.is_none(), |el| el.child(self.sidebar.clone()))
            .child(columns)
            // Over the columns' headers, under Settings and the overlays.
            .child(self.top_bar(cx))
            .children(self.corner(cx))
            .when(!preview, |el| el.child(self.notices.clone()))
            .child(self.onboarding.clone())
            .child(self.settings.clone())
            .child(palette)
    }
}
