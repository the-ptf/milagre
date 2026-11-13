//! The entity behind Settings › Phone & sharing, This Mac, Worktrees and a paired Computer's page. One view keeps what
//! those pages remember between frames (a confirmation waiting for its second click, the open row of the resources
//! list, the text fields); the data lives in the global [`DevicesStore`](super::model::DevicesStore).

use gpui::{
    AnyElement, App, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render, Styled, Subscription, Window, div, prelude::*,
};
use gpui_component::input::{InputEvent, InputState};

use super::model::DevicesStore;
use crate::settings::group::slug;
use crate::ui::Input;

/// Which of the pages this view draws now (the Settings shell picks it with the selected section).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Devices,
    ThisMac { name: String },
    Worktrees,
    Computer { id: String },
}

/// This Mac's page has a sub-page: Computer use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MacPage {
    Main,
    ComputerUse,
}

pub struct DevicesView {
    pub(super) target: Target,
    pub(super) found: Option<String>,
    pub(super) mac_page: MacPage,
    // Devices.
    pub(super) confirm_reset: bool,
    pub(super) confirming_device: Option<String>,
    pub(super) gateway: Option<Entity<InputState>>,
    pub(super) token: Option<Entity<InputState>>,
    pub(super) simlock_check: Option<(bool, String)>,
    // This Mac and Computer pages.
    pub(super) open_row: Option<String>,
    hooked: bool,
    pub(super) name: Option<(String, Entity<InputState>)>,
    pub(super) confirm_remove: bool,
    pub(super) update_confirming: bool,
    pub(super) error: String,
    pub(super) subs: Vec<Subscription>,
    /// The host's visit and page this view last read ([`crate::settings::host::visit`]), and the pairing code drawn
    /// from the host's SVG, kept by its text.
    seen_visit: Option<(u64, Target)>,
    pub(super) qr: Option<(String, Option<std::sync::Arc<gpui::RenderImage>>)>,
}

impl DevicesView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        cx.observe_global::<DevicesStore>(|_, cx| cx.notify()).detach();
        Self {
            target: Target::Devices,
            found: None,
            mac_page: MacPage::Main,
            confirm_reset: false,
            confirming_device: None,
            gateway: None,
            token: None,
            simlock_check: None,
            // Snapshot aid: `MILAGRE_GPUI_SETTINGS_OPEN=<computer id>` opens that row of This Mac's list.
            open_row: std::env::var("MILAGRE_GPUI_SETTINGS_OPEN").ok().filter(|v| !v.is_empty()),
            hooked: false,
            name: None,
            confirm_remove: false,
            update_confirming: false,
            error: String::new(),
            subs: Vec::new(),
            seen_visit: None,
            qr: None,
        }
    }

    /// Reads Phone & sharing or This Mac from a data layer's host when Settings opened or came to the page since the
    /// last read ([`super::hosted`]).
    pub fn visit(&mut self, cx: &mut Context<Self>) {
        let Some(visit) = crate::settings::host::visit(cx) else { return };
        if !matches!(self.target, Target::Devices | Target::ThisMac { .. }) {
            return;
        }
        let seen = Some((visit, self.target.clone()));
        if self.seen_visit == seen {
            return;
        }
        self.seen_visit = seen;
        if !cx.global::<DevicesStore>().hosted.on {
            cx.update_global::<DevicesStore, _>(|store, _| store.forget_fixture());
        }
        match self.target {
            Target::Devices => super::hosted::read_devices_page(visit, cx),
            _ => super::hosted::read_this_mac(visit, cx),
        }
    }

    /// The host's pairing code (an SVG), drawn once for each text.
    pub(super) fn qr_image(&mut self, svg: &str, cx: &App) -> Option<std::sync::Arc<gpui::RenderImage>> {
        if self.qr.as_ref().map(|(text, _)| text.as_str()) != Some(svg) {
            let image = gpui::Image::from_bytes(gpui::ImageFormat::Svg, svg.as_bytes().to_vec()).to_image_data(cx.svg_renderer()).ok();
            self.qr = Some((svg.to_string(), image));
        }
        self.qr.as_ref().and_then(|(_, image)| image.clone())
    }

    /// The page to draw and the row a Settings search result lit up.
    pub fn set_target(&mut self, target: Target, found: Option<&str>, cx: &mut Context<Self>) {
        let mut changed = false;
        if self.target != target {
            changed = true;
            self.confirm_reset = false;
            self.confirming_device = None;
            self.confirm_remove = false;
            self.update_confirming = false;
            self.error.clear();
            self.mac_page = MacPage::Main;
            // A Computer page opens its own memory and disk breakdown.
            self.open_row = if let Target::Computer { id } = &target { Some(id.clone()) } else { self.open_row.take() };
            self.target = target;
        }
        if self.found.as_deref() != found {
            changed = true;
            self.found = found.map(str::to_string);
        }
        if changed {
            cx.notify();
        }
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    pub fn mac_page(&self) -> MacPage {
        self.mac_page
    }

    pub fn open_row(&self) -> Option<&str> {
        self.open_row.as_deref()
    }

    /// A text field made once and kept; `on_commit` runs on Enter and on blur.
    pub(super) fn field(
        &mut self,
        placeholder: &str,
        masked: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
        on_commit: Option<fn(&mut Self, &mut Window, &mut Context<Self>)>,
    ) -> Entity<InputState> {
        let input = if masked {
            Input::password_state(placeholder.to_string(), window, cx)
        } else {
            Input::state(placeholder.to_string(), window, cx)
        };
        if let Some(commit) = on_commit {
            let sub = cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                    commit(this, window, cx);
                }
            });
            self.subs.push(sub);
        }
        input
    }
}

impl Render for DevicesView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Snapshot aid: `MILAGRE_GPUI_CLEANUP=1` opens the Clean up worktrees dialog with the Worktrees page.
        if !self.hooked && self.target == Target::Worktrees && std::env::var_os("MILAGRE_GPUI_CLEANUP").is_some() {
            self.hooked = true;
            cx.defer_in(window, |_, window, cx| super::cleanup::open(None, window, cx));
        }
        let (selector, page): (String, AnyElement) = match self.target.clone() {
            Target::Devices => ("devices".into(), self.devices_page(window, cx)),
            Target::ThisMac { name } => ("this-mac".into(), self.this_mac_page(&name, window, cx)),
            Target::Worktrees => ("worktrees".into(), self.worktrees_page(cx)),
            Target::Computer { id } => (format!("computer-{}", slug(&id)), self.computer_page(&id, window, cx)),
        };
        div().debug_selector(move || format!("settings-section-{selector}")).flex().flex_col().child(page)
    }
}

/// Wraps a labelled piece of a page so a search result that names it lights it up.
pub(super) fn lit(el: impl IntoElement, found: Option<&str>, title: &str, cx: &App) -> AnyElement {
    use crate::theme::{ActiveTheme, RADIUS_CONTROL};
    let theme = *cx.theme();
    let on = found == Some(title);
    div()
        .rounded(RADIUS_CONTROL)
        .when(on, |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
        .child(el)
        .into_any_element()
}

/// Opens a link in the default browser (the Privacy policy and Support links).
pub(super) fn open_link(url: &'static str, cx: &mut App) {
    cx.open_url(url);
}
