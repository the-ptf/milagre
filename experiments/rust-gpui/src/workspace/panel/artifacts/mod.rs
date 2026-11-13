//! The Artifact tab of the side panel (WP-34, P-17): the Chat's Artifact page in a webview, its tabs and its zoom,
//! and the pages HTML replies open (T-19, T-20 as cards, `card.rs`).
//!
//! Ported from `ArtifactPage.tsx` and the Artifacts half of `ArtifactDock` (`ArtifactCard.tsx`). What differs:
//!
//! - The page fills the whole panel body, instead of a floating dock. The zoom bar floats over the page's bottom-left
//!   corner as on the desktop, and a page split into tabs shows them in a pill at its top-left instead of the title's
//!   menu (a menu would open under the page). Both are GPUI glass pills: a native page draws above GPUI (D1), so the
//!   host cuts a hole of each pill's shape in the page ([`Cutout`]) and GPUI's pill shows through it, over the page's
//!   paper, and takes the mouse there. The page runs to the panel's left edge; the resize handle's band over it is a
//!   cutout that passes the mouse only, so the edge still drags.
//! - Zoom is WebKit's page zoom, which lays the page out at the width it then fits, as the desktop's scaled iframe
//!   does. Ctrl-wheel or a pinch over the page zooms about the pointer, a double-click away from text fits, and the
//!   fit is the page's own width when it is wider than the panel, else 100%.
//! - Comments (`../comments.rs`): the comment button and Send float in a pill at the page's top-right; in comment mode
//!   a click on the page pins a comment there (the helper finds the element and the text near it, `press`), written in
//!   a GPUI bubble at the pin, which a cutout lets show over the page and which follows the pin as the page scrolls
//!   (`anchor`). The page draws the pins (sent ones in ink, green once resolved; waiting ones in the accent). Send sends
//!   Electron's message to the Chat and records the comments ([`ArtifactsEvent`]). C in the page toggles comment mode,
//!   Escape leaves it. The bubble's field takes AppKit's keys back from the page as it opens. Share and Mermaid
//!   diagrams (Pele) are not ported.
//! - The fixture's page, or a data layer's ([`ArtifactsView::start_live`], [`ArtifactsView::set_live_page`]: the
//!   Chat's page as Milagre's daemon keeps it, its tabs, files and sent comments), a skeleton while it is read.
//!
//! The page loads from the `milagre-artifact` protocol (`protocol.rs`): a document with the policy and the helper
//! first (`document.rs`), and its files by name. The helper's messages come through the host's bridge
//! (`messages.rs`).

pub mod card;
pub mod document;
pub mod fixture;
pub mod messages;
pub mod protocol;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{
    App, Bounds, ClickEvent, Context, Entity, FontWeight, Global, Pixels, Rgba, ScrollHandle, SharedString, Subscription, WeakEntity,
    Window, canvas, div, point, prelude::*, px, rgb,
};

use self::fixture::{HtmlArtifact, SentComment};
use self::messages::PageMessage;
use self::protocol::Previews;
use super::comments::{self, Bubble, CommentHost, Comments, Draft, Target};
use super::dock::HANDLE_REACH;
use super::{Panel, PanelTab};
use crate::platform::webview::{Cutout, HostRequest, WebEvent, WebHost, WebHostOptions};
use crate::theme::{ActiveTheme, Appearance, TEXT_12, TextStepExt, Theme};
use crate::ui::glass::{GLASS_BLUR, GLASS_PILL_FILL};
use crate::ui::{Button, ButtonSize, ButtonVariant, Glass, IconButton, IconButtonSize, IconName, Tab};

/// How far the floating pills sit from the page's edges (the desktop's `bottom-4 left-4`).
const PILL_INSET: Pixels = px(16.0);
/// The pills' padding around their buttons.
const PILL_PAD: Pixels = px(4.0);
/// DESIGN.md `paper`: a page that stays white in every theme (not in `theme/` yet). Shows while the page loads.
const PAPER: u32 = 0xffffff;
/// The zoom's range and step (`ArtifactPage.tsx`, the zoom bar's buttons).
pub const MIN_SCALE: f64 = 0.25;
pub const MAX_SCALE: f64 = 3.0;
pub const ZOOM_STEP: f64 = 1.25;

/// The floating pills' slots, each cut out of the page where it is drawn: the page tabs, the zoom bar, the comment
/// button with Send, the open comment bubble.
const SLOT_TABS: usize = 0;
const SLOT_ZOOM: usize = 1;
const SLOT_TOOLS: usize = 2;
const SLOT_BUBBLE: usize = 3;
const SLOTS: usize = 4;

/// What the Artifact tab asks a data layer to do (live only; the fixture does them in place).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactsEvent {
    /// Send the comments to the Chat as this message (Electron's `designFeedbackMessage`).
    Send(String),
    /// Record the comments just sent (`artifact:add-comments [{chatId, comments}]`).
    AddComments(Vec<serde_json::Value>),
}

impl gpui::EventEmitter<ArtifactsEvent> for ArtifactsView {}

/// The page's scroll width must pass the viewport's by more than this to count as wider than the panel.
const WIDE_SLACK: f64 = 1.0;

/// Forwards what the page's helper posts to its parent (the page itself, at the top level) to the host.
const PAGE_BRIDGE: &str = r#"(function(){var KEY="milagre:artifact-page";addEventListener("message",function(e){if(e.source!==window)return;var d=e.data;if(!d||typeof d!=="object"||d.milagre!==KEY||typeof d.t!=="string")return;try{window.ipc.postMessage(JSON.stringify(d))}catch(x){}})})()"#;

pub fn clamp_scale(scale: f64) -> f64 {
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

/// The zoom that fits: the page's width when it is wider than the room, else 100%.
pub fn fit_scale(room_width: f64, wide: Option<f64>) -> f64 {
    match wide {
        Some(wide) if room_width > 0.0 && wide > 0.0 => clamp_scale((room_width / wide).min(1.0)),
        _ => 1.0,
    }
}

/// The dock in the window, for the transcript's cards to open a page in.
struct ArtifactDock(WeakEntity<ArtifactsView>);

impl Global for ArtifactDock {}

/// Opens page `id` in the Artifact tab (an HTML reply's Open).
pub fn open(id: &str, cx: &mut App) {
    let Some(view) = cx.try_global::<ArtifactDock>().and_then(|dock| dock.0.upgrade()) else { return };
    view.update(cx, |view, cx| view.open_page(id, cx));
}

/// Which owner of the shared registry a view is.
fn next_owner() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub struct ArtifactsView {
    panel: WeakEntity<Panel>,
    previews: Arc<Mutex<Previews>>,
    owner: u64,
    page: HtmlArtifact,
    tab: Option<SharedString>,
    /// The address of what the page shows, registered in `previews`.
    url: Option<String>,
    host: Option<Entity<WebHost>>,
    shown: bool,
    scale: f64,
    /// The zoom follows the fit until the user zooms.
    following: bool,
    /// The page's scroll width when it is wider than its viewport.
    wide: Option<f64>,
    room: (f64, f64),
    error: Option<String>,
    probe: Option<probe::Mode>,
    probe_scroll: ScrollHandle,
    /// The pills drawn this frame (see the `SLOT_` names), which the host cuts out of the page.
    pills: [Option<Bounds<Pixels>>; SLOTS],
    /// The page's left edge under the panel's resize handle, where the page lets the mouse through to it.
    edge: Option<Bounds<Pixels>>,
    renders: usize,
    /// A data layer feeds the page; `loading` until its first read for the Chat answers.
    live: bool,
    loading: bool,
    comments: Comments,
    /// Where the open bubble's pin is in the page's viewport (CSS pixels), and whether it is in view.
    anchor: Option<(String, f64, f64, bool)>,
    _subscriptions: Vec<Subscription>,
}

impl CommentHost for ArtifactsView {
    fn comments(&self) -> &Comments {
        &self.comments
    }

    fn comments_mut(&mut self) -> &mut Comments {
        &mut self.comments
    }

    fn send_feedback(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.send(cx);
    }

    /// The page draws the pins and the comment cursor: it hears of every change.
    fn comments_changed(&mut self, cx: &mut Context<Self>) {
        if self.comments.open.is_none() {
            self.anchor = None;
        }
        self.push_page(cx);
        cx.notify();
    }
}

impl ArtifactsView {
    pub fn new(panel: &Entity<Panel>, cx: &mut Context<Self>) -> Self {
        // Built inside `Panel::new`, so the panel cannot be read yet: it opens on Changes, and says when that changes.
        let observe = cx.observe(panel, |this, panel, cx| {
            let shown = {
                let panel = panel.read(cx);
                panel.is_open() && panel.active() == PanelTab::Artifact
            };
            this.set_shown(shown, cx);
        });
        let shown = false;
        cx.set_global(ArtifactDock(cx.entity().downgrade()));
        let page = fixture::page(fixture::CHAT_PAGE).expect("the fixture has the Chat's page");
        let mut this = Self {
            panel: panel.downgrade(),
            previews: Arc::new(Mutex::new(Previews::default())),
            owner: next_owner(),
            page,
            tab: None,
            url: None,
            host: None,
            shown,
            scale: 1.0,
            following: true,
            wide: None,
            room: (0.0, 0.0),
            error: None,
            probe: if cfg!(test) { None } else { probe::Mode::from_env() },
            probe_scroll: ScrollHandle::new(),
            pills: [None; SLOTS],
            edge: None,
            renders: 0,
            live: false,
            loading: false,
            comments: Comments::default(),
            anchor: None,
            _subscriptions: vec![observe],
        };
        this.register(cx);
        this.apply_env_seed(cx);
        this
    }

    /// `MILAGRE_GPUI_ARTIFACT=page|reply` opens the tab at startup, on the Chat's page or the reply's.
    fn apply_env_seed(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        let Ok(which) = std::env::var("MILAGRE_GPUI_ARTIFACT") else { return };
        let id = if which == "reply" { fixture::REPLY_PAGE } else { fixture::CHAT_PAGE };
        let (id, this) = (id.to_string(), cx.entity().downgrade());
        cx.defer(move |cx| {
            let _ = this.update(cx, |this, cx| this.open_page(&id, cx));
        });
    }

    /// A data layer's Chat changed: its page is being read (a skeleton until [`Self::set_live_page`] answers).
    pub fn start_live(&mut self, cx: &mut Context<Self>) {
        self.live = true;
        self.loading = true;
        if let Some(url) = self.url.take() {
            self.previews.lock().unwrap_or_else(|poison| poison.into_inner()).release(self.owner, &url);
        }
        if let Some(host) = &self.host {
            host.update(cx, |host, cx| host.set_shown(false, cx));
        }
        self.error = None;
        self.comments.reset();
        self.anchor = None;
        cx.notify();
    }

    /// A data layer's read of the Chat's page. A new page or version (or other HTML or files) loads again, on the tab
    /// shown while the page still has it; the same page only takes its sent comments, which its helper redraws.
    pub fn set_live_page(&mut self, page: HtmlArtifact, cx: &mut Context<Self>) {
        let was_loading = std::mem::replace(&mut self.loading, false);
        self.live = true;
        let same = !was_loading
            && self.url.is_some()
            && page.id == self.page.id
            && page.version == self.page.version
            && page.tabs == self.page.tabs
            && page.assets.len() == self.page.assets.len()
            && page.assets.iter().zip(&self.page.assets).all(|(a, b)| a.name == b.name && a.bytes == b.bytes);
        if same {
            self.page.comments = page.comments;
            self.page.title = page.title;
            self.push_page(cx);
            cx.notify();
            return;
        }
        // Comments waiting on another page have nothing left to go to.
        if page.id != self.page.id {
            self.comments.reset();
            self.anchor = None;
        }
        if self.tab.as_ref().is_some_and(|tab| !page.tabs.iter().any(|t| &t.id == tab)) {
            self.tab = None;
        }
        self.page = page;
        // Shown again only while the panel really draws this tab (its own word, read now), never on a stale flag.
        let drawn = self.panel.upgrade().is_some_and(|panel| {
            let panel = panel.read(cx);
            panel.is_open() && panel.active() == PanelTab::Artifact
        });
        self.shown = drawn;
        if let Some(host) = &self.host {
            host.update(cx, |host, cx| host.set_shown(drawn, cx));
        }
        self.register(cx);
        cx.notify();
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    pub fn page(&self) -> &HtmlArtifact {
        &self.page
    }

    /// The tab shown (the page's first when none was picked).
    pub fn tab_id(&self) -> SharedString {
        self.page.tab(self.tab.as_deref()).id.clone()
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    pub fn is_shown(&self) -> bool {
        self.shown
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    pub fn host(&self) -> Option<&Entity<WebHost>> {
        self.host.as_ref()
    }

    pub fn previews(&self) -> Arc<Mutex<Previews>> {
        self.previews.clone()
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if shown == self.shown {
            return;
        }
        self.shown = shown;
        if let Some(host) = &self.host {
            let shown = shown && !self.loading;
            host.update(cx, |host, cx| host.set_shown(shown, cx));
        }
        cx.notify();
    }

    /// Registers what the page shows now and loads it.
    fn register(&mut self, cx: &mut Context<Self>) {
        let html = self.page.tab(self.tab.as_deref()).html.clone();
        let mut previews = self.previews.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(url) = self.url.take() {
            previews.release(self.owner, &url);
        }
        match previews.register(self.owner, &html, &self.page.assets, true, &protocol::random_token()) {
            Ok(url) => {
                self.error = None;
                self.url = Some(url);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        drop(previews);
        if let (Some(host), Some(url)) = (&self.host, &self.url) {
            host.read(cx).load_url(url);
        }
        self.wide = None;
        self.following = true;
        self.set_scale(fit_scale(self.room.0, None), None, cx);
    }

    /// Shows page `id` (the Chat's own, or one an HTML reply opened) and brings the tab into view.
    pub fn open_page(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(page) = fixture::page(id)
            && page.id != self.page.id
        {
            self.page = page;
            self.tab = None;
            self.register(cx);
        }
        if let Some(panel) = self.panel.upgrade() {
            panel.update(cx, |panel, cx| panel.activate(PanelTab::Artifact, cx));
        }
        cx.notify();
    }

    /// Shows tab `id` of the page.
    pub fn select_tab(&mut self, id: SharedString, cx: &mut Context<Self>) {
        if self.tab_id() == id {
            return;
        }
        self.tab = Some(id);
        self.register(cx);
        cx.notify();
    }

    fn set_scale(&mut self, scale: f64, at: Option<(f64, f64)>, cx: &mut Context<Self>) {
        let scale = clamp_scale(scale);
        let changed = (scale - self.scale).abs() > f64::EPSILON;
        self.scale = scale;
        if let Some(host) = &self.host {
            let host = host.read(cx);
            host.set_zoom(scale);
            host.run_script(&messages::scale(scale, at));
        }
        if changed {
            cx.notify();
        }
    }

    /// Zoom by the user: the fit stops following. `at` is a point of the page's viewport that stays put.
    pub fn zoom_to(&mut self, scale: f64, at: Option<(f64, f64)>, cx: &mut Context<Self>) {
        self.following = false;
        let at = at.or_else(|| Some((self.room.0 / 2.0 / self.scale, self.room.1 / 2.0 / self.scale)));
        self.set_scale(scale, at, cx);
    }

    pub fn zoom_by(&mut self, factor: f64, cx: &mut Context<Self>) {
        self.zoom_to(self.scale * factor, None, cx);
    }

    /// Back to the fit, which then follows the panel's width again.
    pub fn fit(&mut self, cx: &mut Context<Self>) {
        self.following = true;
        self.set_scale(fit_scale(self.room.0, self.wide), None, cx);
    }

    /// The page body's size, each prepaint: a following fit tracks it.
    fn set_room(&mut self, width: f64, height: f64, cx: &mut Context<Self>) {
        if (width, height) == self.room {
            return;
        }
        self.room = (width, height);
        if self.following {
            self.set_scale(fit_scale(width, self.wide), None, cx);
        }
    }

    /// A message from the page's helper.
    pub fn on_page(&mut self, message: PageMessage, window: &mut Window, cx: &mut Context<Self>) {
        match message {
            PageMessage::Ready => {
                self.push_page(cx);
                if let Some(host) = &self.host {
                    host.read(cx).run_script(&messages::scale(self.scale, None));
                }
                if let Some(mode) = self.probe {
                    probe::start(mode, cx);
                }
            }
            PageMessage::Size { scroll_width, client_width } => {
                if scroll_width > client_width + WIDE_SLACK {
                    // The page's own width in CSS pixels, whatever the zoom (`ArtifactPage.tsx` keeps `sw`).
                    self.wide = Some(scroll_width);
                    if self.following {
                        self.set_scale(fit_scale(self.room.0, self.wide), None, cx);
                    }
                }
            }
            PageMessage::Zoom { dy, cx: x, cy: y } => self.zoom_to(self.scale * (-dy * 0.01).exp(), Some((x, y)), cx),
            PageMessage::Fit => self.fit(cx),
            PageMessage::Key => {
                let on = !self.comments.commenting;
                comments::set_commenting(self, on, cx);
            }
            PageMessage::Press { x, y, anchor, near, sx, sy } => self.pin_on_page((x, y), anchor, near, (sx, sy), window, cx),
            PageMessage::Pin { key, sx, sy } => self.open_pin(&key, (sx, sy), window, cx),
            PageMessage::Anchor { key, sx, sy, shown } => {
                if self.comments.open.as_deref() == Some(key.as_str()) {
                    self.anchor = Some((key, sx, sy, shown));
                    cx.notify();
                }
            }
        }
    }

    pub fn comments_state(&self) -> &Comments {
        &self.comments
    }

    /// Why the page shows an error instead of itself.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Where the open bubble sits in the page's viewport, and whether it is in view.
    pub fn bubble_anchor(&self) -> Option<(f64, f64, bool)> {
        self.anchor.as_ref().map(|(_, sx, sy, shown)| (*sx, *sy, *shown))
    }

    /// How many comments Send sends.
    pub fn feedback(&self) -> usize {
        self.comments.written()
    }

    /// In comment mode, a click on the page pinned a comment at `spot` (fractions of the page) on the tab shown, on
    /// the element `anchor` names, near `near`; its bubble opens at `at` in the viewport (`onPin` for a page).
    pub fn pin_on_page(
        &mut self,
        (x, y): (f64, f64),
        anchor: String,
        near: String,
        at: (f64, f64),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.comments.commenting {
            return;
        }
        let tab = self.page.tab(self.tab.as_deref()).clone();
        let draft = Draft {
            key: comments::new_comment_id(),
            target: Target { id: self.page.id.to_string(), title: self.page.title.to_string(), version: self.page.version, html: true },
            x,
            y,
            text: String::new(),
            node_id: None,
            anchor: Some(anchor).filter(|a| !a.is_empty()),
            near: Some(near).filter(|n| !n.is_empty()),
            tab: self.page.has_tabs().then(|| (tab.id.to_string(), tab.title.to_string())),
        };
        let key = self.comments.pin(draft, cx);
        self.comments.open = None;
        self.anchor = Some((key.clone(), at.0, at.1, true));
        comments::open_bubble(self, &key, window, cx);
    }

    /// A pin on the page was clicked: its bubble opens there.
    pub fn open_pin(&mut self, key: &str, at: (f64, f64), window: &mut Window, cx: &mut Context<Self>) {
        self.anchor = Some((key.to_string(), at.0, at.1, true));
        comments::open_bubble(self, key, window, cx);
    }

    /// Escape in the page: the bubble closes first, then comment mode ends.
    pub fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.comments.open.is_some() {
            comments::close_bubble(self, window, cx);
        } else if self.comments.commenting {
            comments::set_commenting(self, false, cx);
        }
    }

    /// Send: the comments waiting go to the Chat as one message and are recorded; comment mode ends. In the fixture
    /// they become the page's sent comments.
    pub fn send(&mut self, cx: &mut Context<Self>) {
        let written = self.comments.take_written(cx);
        if written.is_empty() {
            return;
        }
        if self.live {
            cx.emit(ArtifactsEvent::Send(comments::feedback_message(None, &written)));
            cx.emit(ArtifactsEvent::AddComments(written.iter().map(comments::comment_value).collect()));
        } else {
            self.page.comments.extend(written.iter().map(|draft| SentComment {
                id: draft.key.clone().into(),
                tab: draft.tab.as_ref().map(|(id, _)| id.clone()).unwrap_or_default().into(),
                x: draft.x,
                y: draft.y,
                anchor: draft.anchor.clone().map(Into::into),
                text: draft.text.trim().to_string().into(),
                resolved: false,
                note: None,
            }));
        }
        self.comments.commenting = false;
        self.comments_changed(cx);
    }

    /// The page's pins on the tab shown: the sent comments (resolved ones only with "Show resolved comments" or while
    /// open), coloured from the theme as the desktop's are, then the comments waiting; the open one hidden (its
    /// bubble stands in for it) and watched.
    pub fn pins(&self, theme: &Theme) -> Vec<messages::PagePin> {
        let tab = self.tab_id();
        let open = self.comments.open.as_deref();
        let mut pins: Vec<messages::PagePin> = self
            .page
            .pins(&tab, &css(theme.ink), &css(theme.surface), &css(theme.green_ink), &css(theme.on_green))
            .into_iter()
            .filter(|pin| {
                let resolved = self.page.comments.iter().any(|c| format!("sent:{}", c.id) == pin.key && c.resolved);
                self.comments.show_resolved || !resolved || open == Some(pin.key.as_str())
            })
            .collect();
        for (n, draft) in self.comments.drafts.iter().enumerate() {
            if draft.target.id != self.page.id.as_ref() || !self.page.on_tab(draft.tab.as_ref().map_or("", |(id, _)| id.as_str()), &tab) {
                continue;
            }
            let text = draft.text.trim();
            pins.push(messages::PagePin {
                key: draft.key.clone(),
                x: draft.x,
                y: draft.y,
                anchor: draft.anchor.clone(),
                number: n as u32 + 1,
                fill: css(theme.accent_ink),
                ink: css(theme.on_accent),
                label: if text.is_empty() { format!("Comment {}", n + 1) } else { format!("Comment {}: {text}", n + 1) },
                hide: false,
            });
        }
        for pin in &mut pins {
            pin.hide = open == Some(pin.key.as_str());
        }
        pins
    }

    /// Tells the page the mode (comment mode and its cursor) and the pins to draw.
    fn push_page(&self, cx: &App) {
        let Some(host) = &self.host else { return };
        let theme = cx.theme();
        let host = host.read(cx);
        host.run_script(&messages::mode(self.comments.commenting, &comments::comment_cursor(&css(theme.accent), &css(theme.surface))));
        host.run_script(&messages::pins(&self.pins(theme), self.comments.open.as_deref()));
    }

    fn ensure_host(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.host.is_some() || !self.shown || self.loading {
            return;
        }
        let Some(url) = self.url.clone() else { return };
        let previews = self.previews.clone();
        let options = WebHostOptions {
            url,
            scheme: protocol::SCHEME,
            protocol: std::rc::Rc::new(move |request: &HostRequest| {
                previews.lock().unwrap_or_else(|poison| poison.into_inner()).handle(request)
            }),
            scripts: vec![PAGE_BRIDGE.to_string()],
            dark: cx.theme().appearance == Appearance::Dark,
        };
        let host = cx.new(|cx| WebHost::new(options, window, cx));
        let events = cx.subscribe_in(&host, window, |this, _, event: &WebEvent, window, cx| match event {
            WebEvent::Message(raw) => {
                if let Some(message) = messages::parse(raw) {
                    this.on_page(message, window, cx);
                }
            }
            WebEvent::External(url) => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    cx.open_url(url);
                }
            }
            WebEvent::Escape => this.escape(window, cx),
        });
        self._subscriptions.push(events);
        if let Some(error) = host.read(cx).error() {
            self.error = Some(format!("The page could not open: {error}"));
        }
        self.host = Some(host);
    }

    /// Pill `slot` was drawn at `bounds` (window coordinates): the page lets it show and takes no mouse there.
    fn set_pill(&mut self, slot: usize, bounds: Option<Bounds<Pixels>>, cx: &mut Context<Self>) {
        self.pills[slot] = bounds;
        self.send_cutouts(cx);
    }

    /// The page body's bounds, each prepaint: its left edge is the resize handle's.
    fn set_page_bounds(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        let edge = Bounds { origin: bounds.origin, size: gpui::size(px(HANDLE_REACH), bounds.size.height) };
        if self.edge != Some(edge) {
            self.edge = Some(edge);
            self.send_cutouts(cx);
        }
    }

    fn send_cutouts(&mut self, cx: &mut Context<Self>) {
        let pills = self.pills.iter().enumerate().filter_map(|(slot, bounds)| {
            let bounds = (*bounds)?;
            Some(if slot == SLOT_BUBBLE {
                // The bubble's own box (its corners are rounded inside it).
                Cutout { bounds, radius: px(3.0), see_through: true }
            } else {
                // The glass's edge is a ring 1px outside the pill.
                Cutout { bounds: bounds.dilate(px(1.0)), radius: px(f32::MAX), see_through: true }
            })
        });
        let edge = self.edge.map(|bounds| Cutout { bounds, radius: px(0.0), see_through: false });
        let cutouts = pills.chain(edge).collect();
        if let Some(host) = &self.host {
            host.update(cx, |host, _| host.set_cutouts(cutouts));
        }
    }

    /// An element that reports where `slot` is drawn each frame (window coordinates), so the page cuts it out.
    fn report(&self, slot: usize, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let view = cx.entity().downgrade();
        canvas(
            move |bounds, _, cx| {
                if let Some(view) = view.upgrade() {
                    view.update(cx, |view, cx| view.set_pill(slot, Some(bounds), cx));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// A floating glass pill (the composer's jump pill): `content` in a capsule, reporting where it is drawn.
    fn pill(&self, id: &'static str, slot: usize, theme: &Theme, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let report = self.report(slot, cx);
        let glass =
            Glass::new(GLASS_BLUR, gpui::Hsla::from(theme.surface).opacity(GLASS_PILL_FILL)).edge(theme.line).outset().radius(px(f32::MAX));
        div()
            .id(id)
            .debug_selector(move || id.to_string())
            .absolute()
            .flex()
            .items_center()
            .gap(px(2.0))
            .p(PILL_PAD)
            .rounded_full()
            .child(glass)
            .child(report)
            // A press on a pill is the pill's, not the page's.
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
    }

    /// The page's tabs, in a pill at the page's top-left (only for a page split into tabs).
    fn tabs_pill(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.page.has_tabs() {
            return None;
        }
        let pill = self.pill("artifact-tabs", SLOT_TABS, theme, cx).left(PILL_INSET);
        let active = self.tab_id();
        let tabs = self.page.tabs.iter().map(|tab| {
            let id = tab.id.clone();
            Tab::new(SharedString::from(format!("artifact-tab-{}", tab.id)), tab.title.clone())
                .selector(format!("artifact-tab-{}", tab.id))
                .active(tab.id == active)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select_tab(id.clone(), cx)))
        });
        Some(pill.top(PILL_INSET).children(tabs).into_any_element())
    }

    /// The page's zoom bar (`ZoomBar.tsx`), floating at its bottom-left: Hugeicons MinusSign, PlusSign and FitToScreen
    /// in 28px pill buttons, the reading between them.
    fn zoom_pill(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let pill = self.pill("artifact-zoom-bar", SLOT_ZOOM, theme, cx).left(PILL_INSET);
        let button = |id: &'static str, icon: IconName, on_click: fn(&mut Self, &mut Context<Self>)| {
            IconButton::new(id, icon)
                .size(IconButtonSize::S28)
                .pill()
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| on_click(this, cx)))
        };
        let zoom = format!("{}%", (self.scale * 100.0).round());
        pill.bottom(PILL_INSET)
            .child(button("artifact-zoom-out", IconName::MinusSign, |this, cx| this.zoom_by(1.0 / ZOOM_STEP, cx)))
            .child(
                Button::new("artifact-zoom", zoom)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::S24)
                    .selector("artifact-zoom")
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_to(1.0, None, cx))),
            )
            .child(button("artifact-zoom-in", IconName::PlusSign, |this, cx| this.zoom_by(ZOOM_STEP, cx)))
            .child(div().mx(px(2.0)).h(px(16.0)).w(px(1.0)).bg(theme.line))
            .child(button("artifact-fit", IconName::FitToScreen, Self::fit))
            .into_any_element()
    }
}

impl ArtifactsView {
    /// The page's comment button and Send, in a pill at its top-right (the dock header's in Electron).
    fn tools_pill(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let feedback = self.feedback();
        let (ink, on_ink) = (theme.ink, theme.on_ink);
        let send = (feedback > 0).then(|| {
            div()
                .id("artifact-send")
                .debug_selector(|| "artifact-send".to_string())
                .flex()
                .items_center()
                .gap_1()
                .h(px(28.0))
                .px_3()
                .rounded_full()
                .bg(ink)
                .text_color(on_ink)
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .hover(|style| style.opacity(0.9))
                .child("Send")
                .child(div().px(px(6.0)).rounded_full().bg(Rgba { a: 0.2, ..on_ink }).child(feedback.to_string()))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.send(cx)))
        });
        let mut pill = self.pill("artifact-tools", SLOT_TOOLS, theme, cx).top(PILL_INSET).right(PILL_INSET).items_start();
        if self.comments.options {
            // The options open under the button: the pill grows into a column.
            pill = pill.rounded(px(18.0));
        }
        pill.children(send).child(comments::comment_button(self, "artifact", "Comment on the page", theme, cx)).into_any_element()
    }

    /// The open comment's bubble at its pin, in the page's pixels (`at.sx * scale`), kept inside the page's width;
    /// none while its pin is scrolled out of view.
    fn bubble_layer(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let open = self.comments.open.clone()?;
        let (key, sx, sy, shown) = self.anchor.clone()?;
        if key != open || !shown {
            return None;
        }
        let content = match open.strip_prefix("sent:") {
            Some(id) => {
                let comment = self.page.comments.iter().find(|c| c.id.as_ref() == id)?;
                Bubble::Sent {
                    text: comment.text.to_string(),
                    resolved: comment.resolved.then(|| comment.note.as_ref().map(|n| n.to_string()).unwrap_or_default()),
                }
            }
            None => {
                let number = self.comments.drafts.iter().position(|d| d.key == open)? as u32 + 1;
                Bubble::Draft { key: open.clone(), number }
            }
        };
        let left = (sx * self.scale).min(self.room.0 - f64::from(comments::BUBBLE_WIDTH)).max(0.0);
        let top = (sy * self.scale).max(0.0);
        Some(
            div()
                .absolute()
                .left(px(left as f32))
                .top(px(top as f32))
                .child(comments::bubble(self, content, theme, cx).relative().child(self.report(SLOT_BUBBLE, cx)))
                .into_any_element(),
        )
    }
}

/// A colour as CSS.
fn css(color: Rgba) -> String {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", byte(color.r), byte(color.g), byte(color.b))
}

impl Render for ArtifactsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        self.ensure_host(window, cx);
        // The keyboard probe opens the panel on this tab itself (the seeded tab alone leaves the page unshown).
        if self.probe == Some(probe::Mode::Keys)
            && !self.shown
            && self.renders == 1
            && let Some(panel) = self.panel.upgrade()
        {
            cx.defer(move |cx| panel.update(cx, |panel, cx| panel.activate(PanelTab::Artifact, cx)));
        }
        let theme = *cx.theme();
        let view = cx.entity().downgrade();
        let room = canvas(
            move |bounds, _, cx| {
                if let Some(view) = view.upgrade() {
                    let (w, h) = (f64::from(f32::from(bounds.size.width)), f64::from(f32::from(bounds.size.height)));
                    view.update(cx, |view, cx| {
                        view.set_room(w, h, cx);
                        view.set_page_bounds(bounds, cx);
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let page: gpui::AnyElement = match (&self.host, &self.error) {
            _ if self.loading => crate::workspace::panel::skeletons::page(&theme),
            (_, Some(error)) => div()
                .p_4()
                .text_step(TEXT_12)
                .text_color(theme.red_ink)
                .debug_selector(|| "artifact-error".to_string())
                .child(error.clone())
                .into_any_element(),
            (Some(host), None) if self.probe == Some(probe::Mode::Scroll) => probe::scrolled(host.clone(), &self.probe_scroll),
            (Some(host), None) => div().size_full().child(host.clone()).into_any_element(),
            (None, None) => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .font_weight(FontWeight::NORMAL)
                .child("Loading artifact\u{2026}")
                .into_any_element(),
        };
        // Pills drawn this frame report themselves in prepaint; one not drawn leaves no hole.
        self.pills = [None; SLOTS];
        let (tabs, zoom, tools, bubble) = match self.error {
            None if !self.loading => (
                self.tabs_pill(&theme, cx),
                Some(self.zoom_pill(&theme, cx)),
                // Comments are on the Chat's own page; an HTML reply's page (opened from its card) takes none.
                (self.live || self.page.id.as_ref() != fixture::REPLY_PAGE).then(|| self.tools_pill(&theme, cx)),
                self.bubble_layer(&theme, cx),
            ),
            _ => (None, None, None, None),
        };
        div()
            .id("artifact-panel")
            .debug_selector(|| "panel-body-Artifact".to_string())
            .size_full()
            .flex()
            .flex_col()
            .text_color(theme.ink)
            .child(
                div()
                    .id("artifact-page")
                    .debug_selector(|| "artifact-page".to_string())
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(rgb(PAPER))
                    .child(room)
                    .child(page)
                    .children(tabs)
                    .children(zoom)
                    .children(tools)
                    .children(bubble),
            )
    }
}

impl Drop for ArtifactsView {
    fn drop(&mut self) {
        self.previews.lock().unwrap_or_else(|poison| poison.into_inner()).clear(self.owner);
    }
}

/// `MILAGRE_GPUI_WEBVIEW_PROBE`: checks the native view against the GPUI element in a real window and prints the
/// result, then quits. `1` checks the panel as is, then after a window resize; `scroll` puts
/// the page in a scrolled container that cuts its top and bottom off, to check the clipping.
mod probe {
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Mode {
        Panel,
        Scroll,
        /// `keys`: the keyboard reaches the composer around the page (`keys::run`).
        Keys,
    }

    impl Mode {
        pub fn from_env() -> Option<Self> {
            match std::env::var("MILAGRE_GPUI_WEBVIEW_PROBE").ok()?.as_str() {
                "scroll" => Some(Mode::Scroll),
                "keys" => Some(Mode::Keys),
                "" | "0" => None,
                _ => Some(Mode::Panel),
            }
        }
    }

    /// How far the scroll probe scrolls its content: the page starts this far above the container's top.
    pub const SCROLLED: f32 = 160.0;
    const SPACER: f32 = 40.0;
    /// How much taller than the container the page is, so it also runs past the bottom.
    const EXTRA: f32 = 400.0;

    pub fn scrolled(host: Entity<WebHost>, handle: &ScrollHandle) -> gpui::AnyElement {
        if handle.offset().y == px(0.0) {
            handle.set_offset(point(px(0.0), px(-SCROLLED)));
        }
        div()
            .id("artifact-probe-scroll")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(handle)
            .child(div().h(px(SPACER)))
            .child(div().w_full().h(px(900.0 + EXTRA)).child(host))
            .into_any_element()
    }

    fn check(label: &str, view: &Entity<ArtifactsView>, cx: &mut App) -> bool {
        let Some(host) = view.read(cx).host.clone() else {
            eprintln!("probe {label}: no host");
            return false;
        };
        let host = host.read(cx);
        let (Some(expected), Some(native)) = (host.placement(), host.native_report()) else {
            eprintln!("probe {label}: not placed (placement {:?})", host.placement());
            return false;
        };
        let v = expected.visible;
        let (ex, ey, ew, eh) =
            (f32::from(v.origin.x) as f64, f32::from(v.origin.y) as f64, f32::from(v.size.width) as f64, f32::from(v.size.height) as f64);
        let inner_y = f32::from(expected.inner.origin.y) as f64;
        let inner_h = f32::from(expected.inner.size.height) as f64;
        let close = |a: f64, b: f64| (a - b).abs() < 0.5;
        let aligned = close(ex, native.x)
            && close(ey, native.y)
            && close(ew, native.width)
            && close(eh, native.height)
            && close(inner_y, native.inner_y)
            && close(inner_h, native.inner_height);
        eprintln!(
            "probe {label}: gpui visible ({ex:.1}, {ey:.1}, {ew:.1} x {eh:.1}) inner y {inner_y:.1} h {inner_h:.1} | appkit ({:.1}, {:.1}, {:.1} x {:.1}) inner y {:.1} h {:.1} | {} | hit test at centre reaches page: {}",
            native.x,
            native.y,
            native.width,
            native.height,
            native.inner_y,
            native.inner_height,
            if aligned { "ALIGNED" } else { "MISALIGNED" },
            native.hit_page
        );
        // Each see-through cutout (the pills) gives the mouse to GPUI; the page next to it keeps it.
        let mut cut = true;
        for cutout in host.cutouts().iter().filter(|c| c.see_through) {
            let centre = cutout.bounds.center();
            let beside = gpui::point(centre.x, cutout.bounds.top() - px(12.0));
            let (inside, outside) = (host.native_hits_page(centre), host.native_hits_page(beside));
            eprintln!("probe {label}: pill at {centre:?}: page hit inside {inside:?}, just above {outside:?}");
            cut &= inside == Some(false) && outside == Some(true);
        }
        // The resize handle's band over the page's left edge gives the mouse to GPUI too; past it the page has it.
        for cutout in host.cutouts().iter().filter(|c| !c.see_through) {
            let y = cutout.bounds.center().y;
            let on = host.native_hits_page(gpui::point(cutout.bounds.left() + px(2.0), y));
            let past = host.native_hits_page(gpui::point(cutout.bounds.right() + px(3.0), y));
            eprintln!("probe {label}: handle band {:?}: page hit on it {on:?}, past it {past:?}", cutout.bounds);
            cut &= on == Some(false) && past == Some(true);
        }
        aligned && native.hit_page && cut
    }

    pub fn start(mode: Mode, cx: &mut Context<ArtifactsView>) {
        // Once per run: the page is ready again after a tab switch.
        static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let view = cx.entity();
        let Some(window) = cx.windows().first().copied() else { return };
        if mode == Mode::Keys {
            keys::run(view, window, cx);
            return;
        }
        cx.spawn(async move |_, cx| {
            let executor = cx.background_executor().clone();
            let wait = |ms| executor.timer(Duration::from_millis(ms));
            wait(800).await;
            let mut ok = cx.update(|cx| check("initial", &view, cx));
            if let Some(host) = cx.update(|cx| view.read(cx).host.clone()) {
                let (tx, rx) = async_channel::bounded::<String>(1);
                cx.update(|cx| {
                    host.read(cx).run_script_with_result(
                        "(document.getElementById('checks') ? document.getElementById('checks').innerText : 'no checks on this tab') + ' | helper: ' + !!window.__milagrePage + ', pins drawn: ' + !!document.querySelector('milagre-pins') + ', zoom ' + Math.round(innerWidth) + 'px wide'",
                        move |text| {
                            let _ = tx.try_send(text);
                        },
                    )
                });
                if let Ok(text) = rx.recv().await {
                    eprintln!("probe page checks: {}", text.replace("\\n", " | "));
                }
            }
            let _ = cx.update_window(window, |_, window, _| window.resize(gpui::size(px(1280.0), px(780.0))));
            wait(600).await;
            ok &= cx.update(|cx| check("after window resize to 1280x780", &view, cx));
            if mode != Mode::Panel {
                let _ = cx.update_window(window, |_, window, cx| {
                    view.update(cx, |view, cx| {
                        view.probe_scroll.set_offset(point(px(0.0), px(-(SCROLLED + 80.0))));
                        cx.notify();
                    });
                    window.refresh();
                });
                wait(600).await;
                ok &= cx.update(|cx| check("after scrolling 80px more", &view, cx));
            }
            eprintln!("probe: {}", if ok { "PASS" } else { "FAIL" });
            if std::env::var_os("MILAGRE_GPUI_SNAPSHOT").is_none() {
                cx.update(|cx| cx.quit());
            }
        })
        .detach();
    }

    /// The keyboard and the page (`MILAGRE_GPUI_WEBVIEW_PROBE=keys`, panel seeded on the Artifact tab), in a real
    /// window with AppKit key events sent to it (never to another app):
    /// 1. the page takes AppKit's keys (as a click or its own `focus()` does), then the panel closes: the keys come
    ///    back to GPUI's view and typing reaches the composer;
    /// 2. the page is hidden and grabs the keys by itself (an `autofocus` page loading again on a live read): they
    ///    come back, and GPUI's focus stays on the composer;
    /// 3. the panel opens again, the page holds the keys, and a press on the composer gives them back.
    pub mod keys {
        use super::*;
        use crate::platform::webview::native;
        use gpui::Focusable as _;

        fn composer(window: &mut Window, cx: &mut App) -> Option<Entity<crate::workspace::chat::composer::Composer>> {
            let root = window.root::<gpui_component::Root>().flatten()?;
            let workspace = root.read(cx).view().clone().downcast::<crate::workspace::Workspace>().ok()?;
            let chat = workspace.read(cx).chat.clone();
            Some(chat.read(cx).composer.clone())
        }

        /// A frame now: the probe's window is never activated, so AppKit may not ask GPUI for one by itself.
        fn frame(window: &mut Window, cx: &mut App) {
            window.refresh();
            window.draw(cx).clear(cx);
        }

        fn text(window: &mut Window, cx: &mut App) -> String {
            composer(window, cx).map(|c| c.read(cx).text().to_owned()).unwrap_or_default()
        }

        fn composer_focused(window: &mut Window, cx: &mut App) -> bool {
            composer(window, cx).is_some_and(|c| c.read(cx).focus_handle(cx).contains_focused(window, cx))
        }

        pub fn run(view: Entity<ArtifactsView>, window: gpui::AnyWindowHandle, cx: &mut Context<ArtifactsView>) {
            cx.spawn(async move |_, cx| {
                let executor = cx.background_executor().clone();
                let wait = |ms| executor.timer(Duration::from_millis(ms));
                let step = |label: &str, ok: bool| {
                    eprintln!("probe keys {label}: {}", if ok { "ok" } else { "FAILED" });
                    ok
                };
                wait(800).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let panel = cx.update(|cx| view.read(cx).panel.upgrade());
                let Some(panel) = panel else { return };
                let host = || cx.update(|cx| view.read(cx).host.clone());
                let Some(host) = host() else {
                    eprintln!("probe keys: no page host");
                    return;
                };
                let mut ok = true;
                // The composer has GPUI's focus, as on a Chat's open.
                let _ = cx.update_window(window, |_, window, cx| {
                    if let Some(c) = composer(window, cx) {
                        window.focus(&c.read(cx).focus_handle(cx), cx);
                    }
                });
                wait(200).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let start = cx.update_window(window, |_, window, cx| text(window, cx)).unwrap_or_default();

                // 1. The page takes the keys, then the panel closes.
                cx.update(|cx| host.read(cx).probe_focus_page());
                wait(300).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                ok &= step("page took the keys", cx.update(|cx| host.read(cx).native_report().is_some_and(|r| r.focused)));
                cx.update(|cx| panel.update(cx, |p, cx| p.close(cx)));
                wait(300).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let _ = cx.update_window(window, |_, window, cx| {
                    if let Some(c) = composer(window, cx) {
                        window.focus(&c.read(cx).focus_handle(cx), cx);
                    }
                });
                wait(100).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                ok &= step(
                    "keys back after the panel closed",
                    cx.update_window(window, |_, w, _| native::gpui_holds_keys(w)).ok().flatten() == Some(true),
                );
                if let Ok(Some(ns_window)) = cx.update_window(window, |_, w, _| native::ns_window(w)) {
                    native::probe_type(&ns_window, "a");
                }
                wait(200).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let now = cx.update_window(window, |_, w, cx| text(w, cx)).unwrap_or_default();
                ok &= step(&format!("typed 'a' into the composer ({now:?})"), now == format!("{start}a"));

                // 2. Hidden, the page grabs the keys by itself (and reports focus).
                cx.update(|cx| host.read(cx).probe_focus_page());
                cx.update(|cx| host.read(cx).run_script("window.dispatchEvent(new Event('focus'))"));
                wait(400).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                ok &= step(
                    "a hidden page's focus is given back",
                    cx.update_window(window, |_, w, _| native::gpui_holds_keys(w)).ok().flatten() == Some(true),
                );
                ok &= step(
                    "GPUI's focus stays on the composer",
                    cx.update_window(window, |_, w, cx| composer_focused(w, cx)).unwrap_or(false),
                );
                if let Ok(Some(ns_window)) = cx.update_window(window, |_, w, _| native::ns_window(w)) {
                    native::probe_type(&ns_window, "b");
                }
                wait(200).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let now = cx.update_window(window, |_, w, cx| text(w, cx)).unwrap_or_default();
                ok &= step(&format!("typed 'b' into the composer ({now:?})"), now == format!("{start}ab"));

                // 3. Shown again, the page holds the keys; a press on the composer gives them back.
                cx.update(|cx| panel.update(cx, |p, cx| p.activate(PanelTab::Artifact, cx)));
                wait(800).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                cx.update(|cx| host.read(cx).probe_focus_page());
                wait(300).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                ok &= step("shown page took the keys", cx.update(|cx| host.read(cx).native_report().is_some_and(|r| r.focused)));
                // A press in GPUI's part of the window (over the transcript), then the composer focused as its click does.
                let at = gpui::point(px(520.0), px(220.0));
                let _ = cx.update_window(window, |_, w, cx| {
                    let event = gpui::MouseDownEvent {
                        button: gpui::MouseButton::Left,
                        position: at,
                        modifiers: Default::default(),
                        click_count: 1,
                        first_mouse: false,
                    };
                    w.dispatch_event(gpui::PlatformInput::MouseDown(event.clone()), cx);
                    w.dispatch_event(
                        gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                            button: event.button,
                            position: at,
                            modifiers: Default::default(),
                            click_count: 1,
                        }),
                        cx,
                    );
                    if let Some(c) = composer(w, cx) {
                        w.focus(&c.read(cx).focus_handle(cx), cx);
                    }
                });
                wait(300).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                ok &= step(
                    "a press on the composer took the keys back",
                    cx.update_window(window, |_, w, _| native::gpui_holds_keys(w)).ok().flatten() == Some(true),
                );
                if let Ok(Some(ns_window)) = cx.update_window(window, |_, w, _| native::ns_window(w)) {
                    native::probe_type(&ns_window, "c");
                }
                wait(200).await;
                let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                let now = cx.update_window(window, |_, w, cx| text(w, cx)).unwrap_or_default();
                ok &= step(&format!("typed 'c' into the composer ({now:?})"), now == format!("{start}abc"));

                // 4. Every panel tab in turn, twice (the Artifact page shown and hidden again, the Designs board
                // given the focus as a press on it does), then the composer focused as its click does (a press in a
                // window that is not active hovers nothing, so the click itself is the headless test's:
                // `the_composer_types_after_every_panel_tab`) and typing: AppKit's keys must still be GPUI's.
                let tabs = cx.update(|cx| panel.read(cx).visible_tabs());
                eprintln!("probe keys tabs: {tabs:?}");
                let designs = cx.update(|cx| panel.read(cx).designs().clone());
                let mut typed = format!("{start}abc");
                for (round, letter) in ["d", "e"].into_iter().enumerate() {
                    for tab in tabs.iter().copied() {
                        cx.update(|cx| panel.update(cx, |p, cx| p.activate(tab, cx)));
                        wait(500).await;
                        let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                        if tab == PanelTab::Designs {
                            let _ = cx.update_window(window, |_, w, cx| w.focus(&designs.read(cx).focus_handle(cx), cx));
                        }
                        if tab == PanelTab::Artifact {
                            // The page takes the keys while shown (a click in it, or its own focus()).
                            cx.update(|cx| host.read(cx).probe_focus_page());
                        }
                        wait(200).await;
                        let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                    }
                    let _ = cx.update_window(window, |_, w, cx| {
                        crate::platform::webview::reclaim_keyboard(w);
                        if let Some(c) = composer(w, cx) {
                            w.focus(&c.read(cx).focus_handle(cx), cx);
                        }
                    });
                    wait(200).await;
                    let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                    ok &= step(
                        &format!("round {round}: after every tab GPUI holds the keys"),
                        cx.update_window(window, |_, w, _| native::gpui_holds_keys(w)).ok().flatten() == Some(true),
                    );
                    if let Ok(Some(ns_window)) = cx.update_window(window, |_, w, _| native::ns_window(w)) {
                        native::probe_type(&ns_window, letter);
                    }
                    wait(200).await;
                    let _ = cx.update_window(window, |_, w, cx| frame(w, cx));
                    typed.push_str(letter);
                    let now = cx.update_window(window, |_, w, cx| text(w, cx)).unwrap_or_default();
                    ok &= step(&format!("round {round}: after every tab, typed '{letter}' ({now:?})"), now == typed);
                }
                eprintln!("probe keys: {}", if ok { "PASS" } else { "FAIL" });
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
    }
}
