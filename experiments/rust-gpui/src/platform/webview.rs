//! A web page in a GPUI window: a wry `WKWebView` child view placed over a GPUI element (WP-34, decision D1).
//!
//! On `gpui-pre` a native view sits above GPUI's Metal layer: GPUI cannot draw over it, and does not clip it
//! (COMPONENT-FIT.md, D1). So the host does both itself:
//!
//! - **Clipping.** The webview lives inside a plain `NSView` that clips its subviews (`clipsToBounds`). Each prepaint
//!   the element sets that container to the visible part of its bounds (its bounds cut by GPUI's content mask: a
//!   scroll container, the panel, the window) and places the webview inside it at its full document size, so the
//!   page keeps its layout width and is cut off where GPUI would cut it. Fully clipped, the container hides.
//! - **Following.** Prepaint runs whenever the element's bounds or clip change (a cached view re-renders when either
//!   does), so a resize, a scroll or a panel moving re-places it. The container keeps its distance from the top of
//!   GPUI's (unflipped) view when the window resizes, so it does not jump for the frame before.
//! - **Hiding.** The owner says whether the page is shown ([`WebHost::set_shown`]): a tab that is not drawn runs no
//!   prepaint, so it could not hide by itself. A GPUI overlay open over the window ([`set_overlay_open`]) hides every
//!   page too, since GPUI would draw it under the page.
//! - **Focus.** A click in the page makes the webview AppKit's first responder; the page's bridge script reports it
//!   and the host takes GPUI's focus too ([`WebHost::focus_handle`]), so GPUI's own focus rings let go. When GPUI's
//!   focus moves elsewhere, or a mouse press lands outside the page, the host hands AppKit's first responder back to
//!   GPUI's view. Command shortcuts need nothing: AppKit offers key equivalents to GPUI's view (the window's content
//!   view) before the webview, so GPUI's bindings still run with the page focused. Escape is a plain key the page
//!   keeps, so the bridge forwards it ([`WebEvent::Escape`]).
//! - **Navigation.** The page may only load the host's own scheme; any other address (a link, `target=_blank`) is
//!   refused and reported ([`WebEvent::External`]) for the owner to open in the browser.
//!
//! The scheme's responses come from the owner ([`HostRequest`] in, [`HostResponse`] out). Messages from the page come
//! in through wry's `window.ipc` and reach the owner as [`WebEvent::Message`] JSON, unread.
//!
//! In the headless test platform there is no `NSWindow`, so no native view is built: the host still records where
//! it would place the page ([`WebHost::placement`]), which is what its tests check.

use std::borrow::Cow;
use std::rc::Rc;

use gpui::{
    App, Bounds, Context, Element, ElementId, Entity, EventEmitter, FocusHandle, Focusable, Global, GlobalElementId, Hitbox,
    HitboxBehavior, InspectorElementId, IntoElement, LayoutId, MouseDownEvent, Pixels, Render, Size, Style, Subscription, Task, Window,
    div, point, prelude::*,
};

/// One request of the page to the host's scheme.
#[derive(Clone, Copy, Debug)]
pub struct HostRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    /// The `Range` header, when the page asked for part of a file.
    pub range: Option<&'a str>,
}

/// The host's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl HostResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

pub type ProtocolHandler = Rc<dyn Fn(&HostRequest) -> HostResponse>;

/// What a host loads and how.
pub struct WebHostOptions {
    /// The first address, on `scheme`.
    pub url: String,
    /// The custom scheme the page and its files load from (`milagre-artifact`).
    pub scheme: &'static str,
    pub protocol: ProtocolHandler,
    /// Scripts run at the start of every document, in the main frame, before the page's own (not under its CSP).
    pub scripts: Vec<String>,
    pub dark: bool,
}

/// What the host tells its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum WebEvent {
    /// A message the page posted through `window.ipc`, as JSON text.
    Message(String),
    /// Escape pressed in the page.
    Escape,
    /// The page tried to go to (or open) an address outside the host's scheme; it was refused.
    External(String),
}

/// The GPUI overlays open over the window (a modal, a menu over the panel). While any is, every page hides.
#[derive(Default)]
pub struct WebOverlays {
    open: Vec<&'static str>,
}

impl Global for WebOverlays {}

impl WebOverlays {
    pub fn any(&self) -> bool {
        !self.open.is_empty()
    }
}

/// Marks the overlay `name` open or closed.
pub fn set_overlay_open(name: &'static str, open: bool, cx: &mut App) {
    let overlays = cx.default_global::<WebOverlays>();
    let was = overlays.open.contains(&name);
    if open == was {
        return;
    }
    if open {
        overlays.open.push(name);
    } else {
        overlays.open.retain(|n| *n != name);
    }
}

/// Where the page goes: the visible part of the element (window coordinates, the container's frame) and the whole
/// page relative to that part's top-left corner (the webview's frame inside the container).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub visible: Bounds<Pixels>,
    pub inner: Bounds<Pixels>,
}

/// The page at `document`, cut by `clip`. `None` when nothing of it shows.
pub fn placement(document: Bounds<Pixels>, clip: Bounds<Pixels>) -> Option<Placement> {
    let visible = document.intersect(&clip);
    if f32::from(visible.size.width) <= 0.0 || f32::from(visible.size.height) <= 0.0 {
        return None;
    }
    let inner = Bounds { origin: point(document.origin.x - visible.origin.x, document.origin.y - visible.origin.y), size: document.size };
    Some(Placement { visible, inner })
}

/// A frame in AppKit's coordinates: from the bottom-left of the containing view unless that view is flipped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NativeRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A top-left `rect` inside a view `container_height` tall, as that view's subview frame.
pub fn to_appkit(rect: Bounds<Pixels>, container_height: f64, flipped: bool) -> NativeRect {
    let (x, y) = (f64::from(f32::from(rect.origin.x)), f64::from(f32::from(rect.origin.y)));
    let (width, height) = (f64::from(f32::from(rect.size.width)), f64::from(f32::from(rect.size.height)));
    NativeRect { x, y: if flipped { y } else { container_height - y - height }, width, height }
}

/// The script every page gets first: focus and Escape go to the host. `{host: ...}` marks the host's own messages.
const BRIDGE: &str = r#"(function(){if(window.__milagreHost)return;window.__milagreHost=1;
function up(m){try{window.ipc.postMessage(JSON.stringify(m))}catch(e){}}
addEventListener("focus",function(){up({host:"focus"})});
addEventListener("mousedown",function(){up({host:"focus"})},true);
addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.isComposing)up({host:"escape"})},true);
})()"#;

/// What the host's channel carries from wry's callbacks to the GPUI side.
enum Signal {
    Ipc(String),
    External(String),
}

/// The host's own messages (`BRIDGE`).
#[derive(Debug, PartialEq)]
enum HostMessage {
    Focus,
    Escape,
}

fn host_message(raw: &str) -> Option<HostMessage> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    match value.get("host")?.as_str()? {
        "focus" => Some(HostMessage::Focus),
        "escape" => Some(HostMessage::Escape),
        _ => None,
    }
}

/// Whether the page may load `url` itself: its own scheme, or a blank document.
pub fn allowed_navigation(url: &str, scheme: &str) -> bool {
    url.strip_prefix(scheme).is_some_and(|rest| rest.starts_with("://")) || url == "about:blank" || url == "about:srcdoc"
}

/// One web page placed over a GPUI element. Draw it with `.child(host_entity)`.
pub struct WebHost {
    focus_handle: FocusHandle,
    native: Option<native::Native>,
    error: Option<String>,
    shown: bool,
    overlay: bool,
    document: Option<Bounds<Pixels>>,
    placement: Option<Placement>,
    _task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<WebEvent> for WebHost {}

impl Focusable for WebHost {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl WebHost {
    pub fn new(options: WebHostOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        let overlays = cx.default_global::<WebOverlays>().any();
        let mut subscriptions = vec![
            cx.observe_global::<WebOverlays>(|this, cx| {
                let overlay = cx.global::<WebOverlays>().any();
                if overlay != this.overlay {
                    this.overlay = overlay;
                    this.reapply();
                    cx.notify();
                }
            }),
            // GPUI's focus moved elsewhere (a click in the composer, a shortcut): AppKit's goes with it.
            cx.on_blur(&focus_handle, window, |this, _, _| this.release_native_focus()),
        ];
        let (tx, rx) = async_channel::unbounded::<Signal>();
        let (native, error) = if cfg!(test) {
            (None, None)
        } else {
            match native::Native::build(options, tx, window) {
                Ok(native) => (Some(native), None),
                Err(error) => (None, Some(error)),
            }
        };
        let task = native.is_some().then(|| {
            cx.spawn_in(window, async move |this, cx| {
                while let Ok(signal) = rx.recv().await {
                    if this.update_in(cx, |this, window, cx| this.signal(signal, window, cx)).is_err() {
                        break;
                    }
                }
            })
        });
        subscriptions.shrink_to_fit();
        Self {
            focus_handle,
            native,
            error,
            shown: true,
            overlay: overlays,
            document: None,
            placement: None,
            _task: task,
            _subscriptions: subscriptions,
        }
    }

    fn signal(&mut self, signal: Signal, window: &mut Window, cx: &mut Context<Self>) {
        match signal {
            Signal::External(url) => cx.emit(WebEvent::External(url)),
            Signal::Ipc(raw) => match host_message(&raw) {
                Some(HostMessage::Focus) => {
                    if !self.focus_handle.is_focused(window) {
                        window.focus(&self.focus_handle, cx);
                    }
                }
                Some(HostMessage::Escape) => {
                    self.release_native_focus();
                    cx.emit(WebEvent::Escape);
                }
                None => cx.emit(WebEvent::Message(raw)),
            },
        }
    }

    /// Whether the native view was built; `false` in tests and when wry failed ([`WebHost::error`]).
    pub fn is_native(&self) -> bool {
        self.native.is_some()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn is_shown(&self) -> bool {
        self.shown
    }

    /// Shows or hides the page, for an owner whose tab came into view or went out of it. Hidden, the page stays
    /// loaded; the focus goes back to GPUI.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        self.reapply();
        cx.notify();
    }

    /// Where the page was last placed (`None` while hidden or fully clipped).
    pub fn placement(&self) -> Option<Placement> {
        self.placement
    }

    /// The element's whole bounds, last prepaint.
    pub fn document(&self) -> Option<Bounds<Pixels>> {
        self.document
    }

    /// The prepaint of the element: the page goes where its bounds and the clip say.
    fn place(&mut self, document: Bounds<Pixels>, clip: Bounds<Pixels>) -> Option<Placement> {
        self.document = Some(document);
        self.placement = if self.shown && !self.overlay { placement(document, clip) } else { None };
        self.apply();
        self.placement
    }

    /// Shown or hidden changed between frames: hide now, or wait for the next prepaint to place it.
    fn reapply(&mut self) {
        if !self.shown || self.overlay {
            self.placement = None;
            self.apply();
        }
    }

    fn apply(&mut self) {
        if let Some(native) = &self.native {
            if self.placement.is_none() {
                native.release_focus();
            }
            native.apply(self.placement);
        }
    }

    fn release_native_focus(&self) {
        if let Some(native) = &self.native {
            native.release_focus();
        }
    }

    pub fn load_url(&self, url: &str) {
        if let Some(native) = &self.native {
            let _ = native.webview.load_url(url);
        }
    }

    /// Runs `js` in the page (not under its CSP).
    pub fn run_script(&self, js: &str) {
        if let Some(native) = &self.native {
            let _ = native.webview.evaluate_script(js);
        }
    }

    /// Runs `js` in the page and hands its JSON result to `callback` (on WebKit's thread).
    pub fn run_script_with_result(&self, js: &str, callback: impl Fn(String) + Send + 'static) {
        if let Some(native) = &self.native {
            let _ = native.webview.evaluate_script_with_callback(js, callback);
        }
    }

    /// The page's zoom, where 1 is its natural size: the engine lays it out at the width it then fits.
    pub fn set_zoom(&self, zoom: f64) {
        if let Some(native) = &self.native {
            let _ = native.webview.zoom(zoom);
        }
    }

    /// The colour scheme the page sees (`prefers-color-scheme`).
    pub fn set_dark(&self, dark: bool) {
        if let Some(native) = &self.native {
            native.set_dark(dark);
        }
    }

    /// For checks: the container's frame in window coordinates (top-left), and whether a hit test at its centre
    /// reaches the page. `None` without a native view or while hidden.
    pub fn native_report(&self) -> Option<native::Report> {
        self.native.as_ref().and_then(native::Native::report)
    }
}

impl Render for WebHost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().id("web-host").track_focus(&self.focus_handle).size_full().child(WebHostElement { host: cx.entity() })
    }
}

/// The element the page is placed over: it fills its parent.
struct WebHostElement {
    host: Entity<WebHost>,
}

impl IntoElement for WebHostElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for WebHostElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = Style { size: Size::full(), flex_shrink: 1.0, ..Default::default() };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Hitbox> {
        let clip = window.content_mask().bounds;
        let placed = self.host.update(cx, |host, _| host.place(bounds, clip))?;
        // The page covers this part: what GPUI draws under it must not take the mouse.
        Some(window.insert_hitbox(placed.visible, HitboxBehavior::BlockMouse))
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        _: &mut App,
    ) {
        let Some(visible) = hitbox.as_ref().map(|hitbox| hitbox.bounds) else { return };
        let host = self.host.downgrade();
        // A press anywhere else in the window gives AppKit's focus back to GPUI.
        window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
            if phase.bubble()
                && !visible.contains(&event.position)
                && let Some(host) = host.upgrade()
            {
                host.read(cx).release_native_focus();
            }
        });
    }
}

/// Converts wry's request into the host's and the host's response into wry's.
fn serve(handler: &ProtocolHandler, request: &wry::http::Request<Vec<u8>>) -> wry::http::Response<Cow<'static, [u8]>> {
    let url = request.uri().to_string();
    let range = request.headers().get("range").and_then(|value| value.to_str().ok());
    let response = handler(&HostRequest { method: request.method().as_str(), url: &url, range });
    let mut builder = wry::http::Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(*name, value.as_str());
    }
    builder
        .body(Cow::Owned(response.body))
        .unwrap_or_else(|_| wry::http::Response::builder().status(500).body(Cow::Borrowed(&b""[..])).expect("a bare 500 builds"))
}

pub mod native {
    //! The AppKit side: the wry webview inside a clipping container in GPUI's view.

    use std::rc::Rc;

    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly as _};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization as _, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSAutoresizingMaskOptions, NSView,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use wry::WebViewExtMacOS as _;

    use super::{NativeRect, Placement, Signal, WebHostOptions, serve, to_appkit};

    pub struct Native {
        pub(super) webview: Rc<wry::WebView>,
        clip: Retained<NSView>,
        parent: Retained<NSView>,
    }

    /// Where the container ended up, read back from AppKit, for checks.
    #[derive(Clone, Copy, Debug)]
    pub struct Report {
        /// The container in window coordinates from the top-left (GPUI's).
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
        /// The webview's own frame inside the container (top-left).
        pub inner_y: f64,
        pub inner_height: f64,
        /// A hit test at the container's centre lands in the webview: clicks there reach the page.
        pub hit_page: bool,
        /// The webview is AppKit's first responder (or inside it).
        pub focused: bool,
    }

    fn ns_rect(rect: NativeRect) -> NSRect {
        NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.width, rect.height))
    }

    impl Native {
        pub(super) fn build(options: WebHostOptions, tx: async_channel::Sender<Signal>, window: &mut gpui::Window) -> Result<Self, String> {
            let WebHostOptions { url, scheme, protocol, scripts, dark } = options;
            let ipc = tx.clone();
            let navigation = tx.clone();
            let opener = tx;
            let mut builder = wry::WebViewBuilder::new()
                .with_url(url)
                .with_custom_protocol(scheme.to_string(), move |_, request| serve(&protocol, &request))
                .with_ipc_handler(move |request| {
                    let _ = ipc.try_send(Signal::Ipc(request.into_body()));
                })
                .with_navigation_handler(move |url| {
                    let allowed = super::allowed_navigation(&url, scheme);
                    if !allowed {
                        let _ = navigation.try_send(Signal::External(url));
                    }
                    allowed
                })
                .with_new_window_req_handler(move |url, _| {
                    let _ = opener.try_send(Signal::External(url));
                    wry::NewWindowResponse::Deny
                })
                .with_accept_first_mouse(true)
                .with_hotkeys_zoom(false)
                .with_back_forward_navigation_gestures(false)
                .with_visible(true)
                .with_initialization_script_for_main_only(super::BRIDGE, true);
            for script in scripts {
                builder = builder.with_initialization_script_for_main_only(script, true);
            }
            let webview = builder.build_as_child(&*window).map_err(|error| error.to_string())?;
            let page = webview.webview();
            // SAFETY: on the main thread, right after wry added the webview to GPUI's view.
            let parent = unsafe { page.superview() }.ok_or("the webview has no parent view")?;
            let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
            let clip = NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO);
            clip.setClipsToBounds(true);
            // GPUI's view is not flipped: keep the distance from its top while the window resizes.
            clip.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
            clip.setHidden(true);
            parent.addSubview(&clip);
            page.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
            clip.addSubview(&page);
            let native = Self { webview: Rc::new(webview), clip, parent };
            native.set_dark(dark);
            Ok(native)
        }

        pub(super) fn apply(&self, placement: Option<Placement>) {
            let Some(placement) = placement else {
                self.clip.setHidden(true);
                return;
            };
            let outer = to_appkit(placement.visible, self.parent.bounds().size.height, self.parent.isFlipped());
            self.clip.setFrame(ns_rect(outer));
            let inner = to_appkit(placement.inner, outer.height, self.clip.isFlipped());
            self.webview.webview().setFrame(ns_rect(inner));
            self.clip.setHidden(false);
        }

        fn has_focus(&self) -> bool {
            let page = self.webview.webview();
            let Some(responder) = page.window().and_then(|window| window.firstResponder()) else { return false };
            responder.downcast::<NSView>().is_ok_and(|view| view.isDescendantOf(&page))
        }

        pub(super) fn release_focus(&self) {
            if self.has_focus() {
                let _ = self.webview.focus_parent();
            }
        }

        pub(super) fn set_dark(&self, dark: bool) {
            // SAFETY: AppKit's appearance name constants, read on the main thread.
            let name = unsafe { if dark { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua } };
            let appearance = NSAppearance::appearanceNamed(name);
            self.webview.webview().setAppearance(appearance.as_deref());
        }

        pub(super) fn report(&self) -> Option<Report> {
            if self.clip.isHidden() {
                return None;
            }
            let window = self.clip.window()?;
            let content = window.contentView()?;
            let height = content.frame().size.height;
            let frame = self.clip.convertRect_toView(self.clip.bounds(), None);
            let page = self.webview.webview();
            let inner = page.frame();
            let centre = NSPoint::new(frame.origin.x + frame.size.width / 2.0, frame.origin.y + frame.size.height / 2.0);
            // `hitTest:` takes a point in the receiver's superview: the window's frame view.
            // SAFETY: AppKit view tree read on the main thread.
            let at = unsafe { content.superview() }.map_or(centre, |frame_view| frame_view.convertPoint_fromView(centre, None));
            let hit_page = content.hitTest(at).is_some_and(|view| view.isDescendantOf(&page));
            Some(Report {
                x: frame.origin.x,
                y: height - frame.origin.y - frame.size.height,
                width: frame.size.width,
                height: frame.size.height,
                inner_y: self.clip.frame().size.height - inner.origin.y - inner.size.height,
                inner_height: inner.size.height,
                hit_page,
                focused: self.has_focus(),
            })
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            self.clip.removeFromSuperview();
        }
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Bounds, point, px, size};

    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds { origin: point(px(x), px(y)), size: size(px(w), px(h)) }
    }

    #[test]
    fn an_unclipped_page_fills_its_container() {
        let placed = placement(rect(600.0, 85.0, 560.0, 700.0), rect(0.0, 0.0, 1440.0, 900.0)).unwrap();
        assert_eq!(placed.visible, rect(600.0, 85.0, 560.0, 700.0));
        assert_eq!(placed.inner, rect(0.0, 0.0, 560.0, 700.0));
    }

    #[test]
    fn a_page_scrolled_above_its_clip_is_cut_and_keeps_its_size() {
        // The page starts 120 above the clip's top and runs 200 past its bottom.
        let placed = placement(rect(600.0, 0.0, 560.0, 1000.0), rect(600.0, 120.0, 560.0, 680.0)).unwrap();
        assert_eq!(placed.visible, rect(600.0, 120.0, 560.0, 680.0));
        assert_eq!(placed.inner, rect(0.0, -120.0, 560.0, 1000.0));
    }

    #[test]
    fn a_page_entirely_outside_its_clip_is_not_placed() {
        assert_eq!(placement(rect(0.0, 900.0, 100.0, 100.0), rect(0.0, 0.0, 1440.0, 900.0)), None);
        assert_eq!(placement(rect(0.0, 0.0, 0.0, 100.0), rect(0.0, 0.0, 1440.0, 900.0)), None);
    }

    #[test]
    fn appkit_frames_count_from_the_bottom_unless_flipped() {
        let r = rect(10.0, 100.0, 200.0, 300.0);
        assert_eq!(to_appkit(r, 900.0, false), NativeRect { x: 10.0, y: 500.0, width: 200.0, height: 300.0 });
        assert_eq!(to_appkit(r, 900.0, true), NativeRect { x: 10.0, y: 100.0, width: 200.0, height: 300.0 });
        // The webview inside a 680-tall container, 120 above its top: its bottom is 200 below the container's.
        let inner = to_appkit(rect(0.0, -120.0, 560.0, 1000.0), 680.0, false);
        assert_eq!(inner.y, -200.0);
    }

    #[test]
    fn only_the_hosts_scheme_and_blank_pages_load() {
        assert!(allowed_navigation("milagre-artifact://preview/ab12", "milagre-artifact"));
        assert!(allowed_navigation("about:blank", "milagre-artifact"));
        assert!(!allowed_navigation("milagre-artifactx://preview/ab12", "milagre-artifact"));
        assert!(!allowed_navigation("https://example.com", "milagre-artifact"));
        assert!(!allowed_navigation("file:///etc/hosts", "milagre-artifact"));
    }

    #[test]
    fn the_bridge_marks_its_own_messages() {
        assert_eq!(host_message(r#"{"host":"focus"}"#), Some(HostMessage::Focus));
        assert_eq!(host_message(r#"{"host":"escape"}"#), Some(HostMessage::Escape));
        assert_eq!(host_message(r#"{"milagre":"milagre:artifact-page","t":"ready"}"#), None);
        assert_eq!(host_message("not json"), None);
    }

    #[gpui::test]
    fn overlays_open_and_close_by_name(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            set_overlay_open("settings", true, cx);
            set_overlay_open("settings", true, cx);
            set_overlay_open("menu", true, cx);
            set_overlay_open("settings", false, cx);
            assert!(cx.global::<WebOverlays>().any());
            set_overlay_open("menu", false, cx);
            assert!(!cx.global::<WebOverlays>().any());
        });
    }
}
