//! WP-34: the protocol and its files, the content security policy, the page's messages, and the Artifact tab in the
//! headless window (where no native view is built, so the host's placement stands in for it). The expected strings
//! are what `packages/shared/src/artifact-document.mjs` and `artifact-assets.mjs` return for the same input.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, px};

use super::document::{self, ARTIFACT_CSP, PAGE_HELPER, Range, artifact_csp, artifact_document, byte_range, rewrite_asset_urls};
use super::fixture::{self, CHAT_PAGE, REPLY_PAGE};
use super::messages::{self, PageMessage};
use super::protocol::{ASSET_CSP, Asset, PREFIX, Previews, RegisterError};
use super::{ArtifactDock, ArtifactsView, MAX_SCALE, MIN_SCALE, ZOOM_STEP, fit_scale};
use crate::platform::webview::{HostRequest, HostResponse};
use crate::testing;
use crate::workspace::panel::{Panel, PanelTab};

// The protocol and its files.

fn get<'a>(url: &'a str) -> HostRequest<'a> {
    HostRequest { method: "GET", url, range: None }
}

fn registered() -> (Previews, String) {
    let mut previews = Previews::default();
    let page = fixture::page(CHAT_PAGE).unwrap();
    let url = previews.register(7, &page.tabs[0].html, &page.assets, true, &"ab".repeat(24)).unwrap();
    (previews, url)
}

#[test]
fn a_page_registers_under_an_unguessable_address() {
    let token = super::protocol::random_token();
    assert_eq!(token.len(), 48);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(token, super::protocol::random_token());
    let (_, url) = registered();
    assert_eq!(url, format!("{PREFIX}{}", "ab".repeat(24)));
}

#[test]
fn the_document_is_served_with_its_policy_and_the_helper() {
    let (previews, url) = registered();
    let response = previews.handle(&get(&url));
    assert_eq!(response.status, 200);
    assert_eq!(response.header("Content-Type"), Some("text/html; charset=utf-8"));
    assert_eq!(response.header("Content-Security-Policy"), Some(artifact_csp("milagre-artifact:").as_str()));
    assert_eq!(response.header("Cache-Control"), Some("no-store"));
    assert_eq!(response.header("Referrer-Policy"), Some("no-referrer"));
    assert_eq!(response.header("X-Content-Type-Options"), Some("nosniff"));
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""), "the policy comes first");
    assert!(body.contains(PAGE_HELPER), "a page carries its helper");
    // The page's `assets/<name>` now point under its own address.
    assert!(body.contains(&format!("src=\"{url}/assets/chart.svg\"")));
    assert!(body.contains(&format!("src=\"{url}/assets/swatch.png\"")));
    assert!(!body.contains("src=\"assets/") && !body.contains("src=\"./assets/"));
    // A query or a trailing slash still finds it.
    assert_eq!(previews.handle(&get(&format!("{url}?v=2"))).status, 200);
    assert_eq!(previews.handle(&get(&format!("{url}/"))).status, 200);
}

#[test]
fn a_file_is_served_whole_sandboxed_and_typed() {
    let (previews, url) = registered();
    let response = previews.handle(&get(&format!("{url}/assets/swatch.png")));
    assert_eq!(response.status, 200);
    assert_eq!(response.header("Content-Type"), Some("image/png"));
    assert_eq!(response.header("Content-Security-Policy"), Some(ASSET_CSP));
    assert_eq!(response.header("Accept-Ranges"), Some("bytes"));
    assert_eq!(response.header("Content-Length"), Some(response.body.len().to_string().as_str()));
    assert!(response.body.starts_with(b"\x89PNG"));
    let svg = previews.handle(&get(&format!("{url}/assets/chart%2Esvg")));
    assert_eq!((svg.status, svg.header("Content-Type")), (200, Some("image/svg+xml")), "names are percent-decoded");
}

#[test]
fn a_file_is_served_by_byte_range() {
    let (previews, url) = registered();
    let file = format!("{url}/assets/chart.svg");
    let whole = previews.handle(&get(&file)).body;
    let part = previews.handle(&HostRequest { method: "GET", url: &file, range: Some("bytes=4-13") });
    assert_eq!(part.status, 206);
    assert_eq!(part.header("Content-Range"), Some(format!("bytes 4-13/{}", whole.len()).as_str()));
    assert_eq!(part.header("Content-Length"), Some("10"));
    assert_eq!(part.body, whole[4..14]);
    let tail = previews.handle(&HostRequest { method: "GET", url: &file, range: Some("bytes=-5") });
    assert_eq!(tail.body, whole[whole.len() - 5..]);
    let past = previews.handle(&HostRequest { method: "GET", url: &file, range: Some("bytes=99999-") });
    assert_eq!(past.status, 416);
    assert_eq!(past.header("Content-Range"), Some(format!("bytes */{}", whole.len()).as_str()));
    assert!(past.body.is_empty());
}

#[test]
fn anything_else_is_not_found() {
    let (mut previews, url) = registered();
    let not_found = |response: HostResponse| response.status == 404;
    assert!(not_found(previews.handle(&HostRequest { method: "POST", url: &url, range: None })));
    assert!(not_found(previews.handle(&get(&format!("{PREFIX}{}", "cd".repeat(24))))));
    assert!(not_found(previews.handle(&get(&format!("{url}/assets/missing.png")))));
    assert!(not_found(previews.handle(&get(&format!("{url}/assets/../assets/chart.svg")))));
    assert!(not_found(previews.handle(&get(&format!("{url}/chart.svg")))));
    assert!(not_found(previews.handle(&get("milagre-artifact://other/x"))));
    // Another owner cannot release it; its owner can, and then nothing of it is served.
    previews.release(8, &url);
    assert_eq!(previews.handle(&get(&url)).status, 200);
    previews.release(7, &url);
    assert!(not_found(previews.handle(&get(&url))));
    assert!(not_found(previews.handle(&get(&format!("{url}/assets/chart.svg")))));
    assert!(previews.is_empty());
}

#[test]
fn registering_has_limits_and_drops_badly_named_files() {
    let mut previews = Previews::default();
    let huge = "x".repeat(super::protocol::MAX_BYTES + 1);
    assert_eq!(previews.register(1, &huge, &[], true, "00"), Err(RegisterError::TooLarge));
    let bad = Asset { name: "../secret".into(), mime: "text/plain".into(), bytes: std::sync::Arc::from(&b"x"[..]) };
    let url = previews.register(1, "<img src=\"assets/../secret\">", &[bad], true, "01").unwrap();
    assert_eq!(previews.handle(&get(&format!("{url}/assets/../secret"))).status, 404);
    for n in 0..super::protocol::MAX_ENTRIES - 1 {
        previews.register(2, "<p>", &[], false, &format!("{n:04}")).unwrap();
    }
    assert_eq!(previews.register(2, "<p>", &[], false, "full"), Err(RegisterError::TooMany));
    previews.clear(2);
    assert_eq!(previews.len(), 1);
}

// The content security policy.

#[test]
fn the_policy_blocks_fetch_and_remote_scripts() {
    let directives: Vec<&str> = ARTIFACT_CSP.split("; ").collect();
    assert_eq!(directives[0], "default-src 'none'", "anything not listed, connect-src included, falls back to none");
    assert!(!ARTIFACT_CSP.contains("connect-src"), "no fetch, XHR, WebSocket or EventSource");
    assert!(directives.contains(&"script-src 'unsafe-inline'"), "inline scripts only: no host, no https:, no 'self'");
    assert!(!ARTIFACT_CSP.contains("unsafe-eval"));
    assert!(directives.contains(&"form-action 'none'") && directives.contains(&"base-uri 'none'"));
    assert!(!ARTIFACT_CSP.contains("frame-src") && !ARTIFACT_CSP.contains("child-src"), "frames fall back to none too");
}

#[test]
fn the_policy_matches_the_shared_module() {
    assert_eq!(
        ARTIFACT_CSP,
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: blob: https:; \
         font-src data: https:; media-src data: blob: https:; form-action 'none'; base-uri 'none'"
    );
    assert_eq!(
        artifact_csp("milagre-artifact:"),
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: blob: https: \
         milagre-artifact:; font-src data: https: milagre-artifact:; media-src data: blob: https: milagre-artifact:; \
         form-action 'none'; base-uri 'none'"
    );
    // The page's files load from the scheme, but scripts and connections still do not.
    let page = artifact_csp("milagre-artifact:");
    assert!(page.contains("script-src 'unsafe-inline';"));
    assert!(!page.contains("connect-src"));
}

#[test]
fn an_inline_reply_gets_the_plain_policy_and_no_helper() {
    let mut previews = Previews::default();
    let url = previews.register(1, "<p>hi</p>", &[], false, "02").unwrap();
    let response = previews.handle(&get(&url));
    assert_eq!(response.header("Content-Security-Policy"), Some(ARTIFACT_CSP));
    assert!(!String::from_utf8(response.body).unwrap().contains("__milagrePage"));
}

// The document.

#[test]
fn the_policy_goes_after_the_doctype_and_comments() {
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{ARTIFACT_CSP}\">");
    assert_eq!(
        artifact_document("<!-- c --><!DOCTYPE html><html><body>x</body></html>", false, ""),
        format!("<!-- c --><!DOCTYPE html>{meta}<html><body>x</body></html>")
    );
    // A bare fragment gets a doctype, a charset and a viewport.
    assert_eq!(
        artifact_document("<p>hi</p>", false, ""),
        format!(
            "<!doctype html>{meta}<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><p>hi</p>"
        )
    );
    // A comment that only mentions a doctype is not one.
    assert!(artifact_document("<!-- <!doctype x> --><p>", false, "").starts_with("<!doctype html><meta"));
}

#[test]
fn asset_references_are_rewritten_only_when_whole() {
    let html = "a assets/x.png ./assets/x.png myassets/x.png assets/x.pngx \"assets/x.png\" /assets/x.png";
    assert_eq!(rewrite_asset_urls(html, &["x.png"], |_| "U".into()), "a U U myassets/x.png assets/x.pngx \"U\" /assets/x.png");
}

#[test]
fn byte_ranges_match_the_shared_module() {
    let cases = [
        ("bytes=0-9", Range::Part { offset: 0, length: 10 }),
        ("bytes=-5", Range::Part { offset: 15, length: 5 }),
        ("bytes=5-", Range::Part { offset: 5, length: 15 }),
        ("bytes=20-", Range::Unsatisfiable),
        ("bytes=-0", Range::Unsatisfiable),
        ("bytes=-50", Range::Part { offset: 0, length: 20 }),
        ("bytes=x", Range::Whole),
        ("bytes=3-1", Range::Unsatisfiable),
        ("bytes=-", Range::Whole),
    ];
    for (header, expected) in cases {
        assert_eq!(byte_range(Some(header), 20), expected, "{header}");
    }
    assert_eq!(byte_range(None, 20), Range::Whole);
}

#[test]
fn file_names_and_types() {
    assert!(document::valid_asset_name("chart.svg") && document::valid_asset_name("a_b-1.PNG"));
    assert!(!document::valid_asset_name(".hidden") && !document::valid_asset_name("a/b") && !document::valid_asset_name(""));
    assert!(!document::valid_asset_name(&"a".repeat(101)));
    assert_eq!(document::asset_type("x.JPG"), "image/jpeg");
    assert_eq!(document::asset_type("clip.webm"), "video/webm");
    assert_eq!(document::asset_type("data.bin"), "application/octet-stream");
}

// The page's messages.

#[test]
fn page_messages_are_read_as_known_fields_only() {
    let key = "\"milagre\":\"milagre:artifact-page\"";
    assert_eq!(messages::parse(&format!("{{{key},\"t\":\"ready\"}}")), Some(PageMessage::Ready));
    assert_eq!(
        messages::parse(&format!("{{{key},\"t\":\"size\",\"sw\":1100,\"cw\":540}}")),
        Some(PageMessage::Size { scroll_width: 1100.0, client_width: 540.0 })
    );
    assert_eq!(
        messages::parse(&format!("{{{key},\"t\":\"zoom\",\"dy\":-12.5,\"cx\":10,\"cy\":20}}")),
        Some(PageMessage::Zoom { dy: -12.5, cx: 10.0, cy: 20.0 })
    );
    assert_eq!(
        messages::parse(&format!("{{{key},\"t\":\"pin\",\"k\":3,\"sx\":1,\"sy\":2}}")),
        Some(PageMessage::Pin { key: "3".into(), sx: 1.0, sy: 2.0 })
    );
    let long = "x".repeat(900);
    let Some(PageMessage::Press { near, .. }) =
        messages::parse(&format!("{{{key},\"t\":\"press\",\"x\":0.1,\"y\":0.2,\"near\":\"{long}\"}}"))
    else {
        panic!("a press reads")
    };
    assert_eq!(near.len(), 600, "text is capped");
    // Without the key, with a missing or mistyped field, or of an unknown type: dropped.
    assert_eq!(messages::parse("{\"t\":\"ready\"}"), None);
    assert_eq!(messages::parse(&format!("{{{key},\"t\":\"size\",\"sw\":\"wide\",\"cw\":1}}")), None);
    assert_eq!(messages::parse(&format!("{{{key},\"t\":\"zoom\",\"dy\":1}}")), None);
    assert_eq!(messages::parse(&format!("{{{key},\"t\":\"navigate\",\"to\":\"https://x\"}}")), None);
    assert_eq!(messages::parse("[1,2]"), None);
}

#[test]
fn commands_reach_the_helper_as_its_own_messages() {
    let js = messages::scale(1.5, Some((10.0, 20.0)));
    assert!(js.starts_with("window.postMessage({") && js.ends_with("},\"*\")"));
    let body: serde_json::Value = serde_json::from_str(&js["window.postMessage(".len()..js.len() - ",\"*\")".len()]).unwrap();
    assert_eq!(body["milagre"], "milagre:artifact-page");
    assert_eq!((body["t"].as_str(), body["s"].as_f64(), body["cx"].as_f64()), (Some("scale"), Some(1.5), Some(10.0)));
    let page = fixture::page(CHAT_PAGE).unwrap();
    let pins = page.pins("overview", "#000000", "#ffffff", "#007e33", "#ffffff");
    assert_eq!(pins.len(), 2);
    assert_eq!((pins[1].number, pins[1].fill.as_str()), (2, "#007e33"), "the resolved pin is green");
    assert!(messages::pins(&pins, None).contains("\"a\":\"h1:1@0.62,0.5\""));
    assert!(page.pins("regions", "", "", "", "").is_empty());
}

#[test]
fn the_fit_is_the_page_width_when_wider_else_100() {
    assert_eq!(fit_scale(560.0, None), 1.0);
    assert_eq!(fit_scale(560.0, Some(400.0)), 1.0);
    assert!((fit_scale(560.0, Some(1120.0)) - 0.5).abs() < 1e-9);
    assert_eq!(fit_scale(100.0, Some(10_000.0)), MIN_SCALE);
    assert_eq!(fit_scale(0.0, Some(1120.0)), 1.0);
}

// The tab in the window.

fn mount(cx: &mut TestAppContext) -> (Entity<Panel>, Entity<ArtifactsView>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |workspace, _| workspace.panel.clone());
    let view = cx.update(|_, cx| cx.global::<ArtifactDock>().0.upgrade()).expect("the panel built the Artifact tab");
    (panel, view, cx)
}

fn redraw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn open_tab(panel: &Entity<Panel>, cx: &mut VisualTestContext) {
    panel.update(cx, |panel, cx| panel.activate(PanelTab::Artifact, cx));
    redraw(cx);
}

#[gpui::test]
fn the_page_fills_the_body_with_the_pills_floating_over_it(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    assert!(!view.read_with(cx, |view, _| view.is_shown()), "the panel opens on Changes");
    open_tab(&panel, cx);
    assert!(view.read_with(cx, |view, _| view.is_shown()));
    let host = view.read_with(cx, |view, _| view.host().cloned()).expect("showing the tab builds the host");
    let body = testing::bounds(cx, "artifact-page");
    let placed = host.read_with(cx, |host, _| host.placement()).expect("the page is placed");
    assert_eq!(placed.visible, body, "the page covers exactly the page body");
    assert_eq!(placed.inner.origin, gpui::point(px(0.0), px(0.0)));
    assert_eq!(panel.read_with(cx, |panel, _| panel.width()), 320.0, "the shared default width");
    // The pills float over the page's corners, and the page leaves a hole for each (the glass's 1px ring included).
    let zoom = testing::bounds(cx, "artifact-zoom-bar");
    let tabs = testing::bounds(cx, "artifact-tabs");
    assert!(body.contains(&zoom.origin) && body.contains(&tabs.origin), "{zoom:?} and {tabs:?} over {body:?}");
    assert!(zoom.bottom() < body.bottom() && zoom.left() > body.left(), "the zoom at the bottom-left");
    assert!(tabs.top() > body.top() && tabs.bottom() < zoom.top(), "the page tabs at the top-left");
    // The comment button floats at the top-right.
    let tools = testing::bounds(cx, "artifact-tools");
    assert!(tools.top() > body.top() && tools.right() < body.right() && tools.left() > tabs.right(), "{tools:?}");
    let cutouts = host.read_with(cx, |host, _| host.cutouts().to_vec());
    let holes: Vec<_> = cutouts.iter().filter(|c| c.see_through).map(|c| c.bounds).collect();
    assert_eq!(holes, vec![tabs.dilate(px(1.0)), zoom.dilate(px(1.0)), tools.dilate(px(1.0))]);
}

#[gpui::test]
fn the_page_runs_to_the_panels_left_edge_and_lets_the_resize_handle_through(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    let body = testing::bounds(cx, "artifact-page");
    let header = testing::bounds(cx, "panel-header");
    let card = testing::bounds(cx, "chat-card");
    let lead = crate::workspace::shell::card::panel_lead();
    assert_eq!(body.left(), header.left() - lead, "no inset: the page covers the panel's half of the gap");
    assert_eq!(body.left() - card.right(), lead, "the Chat card keeps its own half");
    assert_eq!(body.right(), header.right(), "the right edge is the panel's");
    let host = view.read_with(cx, |view, _| view.host().cloned()).unwrap();
    let edges: Vec<_> = host.read_with(cx, |host, _| host.cutouts().iter().filter(|c| !c.see_through).map(|c| c.bounds).collect());
    let band = gpui::Bounds { origin: body.origin, size: gpui::size(px(super::HANDLE_REACH), body.size.height) };
    assert_eq!(edges, vec![band], "the handle's band over the page passes the mouse, the page still drawn there");
}

#[gpui::test]
fn hiding_the_tab_or_opening_settings_hides_the_page(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    let host = view.read_with(cx, |view, _| view.host().cloned()).unwrap();
    panel.update(cx, |panel, cx| panel.activate(PanelTab::Changes, cx));
    redraw(cx);
    assert!(!host.read_with(cx, |host, _| host.is_shown()));
    assert_eq!(host.read_with(cx, |host, _| host.placement()), None, "a hidden tab's page is not placed");
    open_tab(&panel, cx);
    assert!(host.read_with(cx, |host, _| host.placement()).is_some(), "back, and placed again");
    panel.update(cx, |panel, cx| panel.close(cx));
    redraw(cx);
    assert_eq!(host.read_with(cx, |host, _| host.placement()), None, "the panel closed");
    open_tab(&panel, cx);
    cx.update(|_, cx| crate::platform::webview::set_overlay_open("settings", true, cx));
    redraw(cx);
    assert_eq!(host.read_with(cx, |host, _| host.placement()), None, "a GPUI overlay would draw under the page");
    cx.update(|_, cx| crate::platform::webview::set_overlay_open("settings", false, cx));
    redraw(cx);
    assert!(host.read_with(cx, |host, _| host.placement()).is_some());
}

#[gpui::test]
fn resizing_the_window_moves_the_page_with_its_body(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    let host = view.read_with(cx, |view, _| view.host().cloned()).unwrap();
    let before = host.read_with(cx, |host, _| host.placement()).unwrap().visible;
    cx.simulate_resize(gpui::size(px(1280.0), px(760.0)));
    redraw(cx);
    let after = host.read_with(cx, |host, _| host.placement()).unwrap().visible;
    assert_ne!(before, after);
    // The page goes where its body is, cut by the window (the dock may lay the panel out past the edge for a frame).
    let window = gpui::Bounds { origin: gpui::point(px(0.0), px(0.0)), size: cx.update(|window, _| window.viewport_size()) };
    assert_eq!(after, testing::bounds(cx, "artifact-page").intersect(&window));
}

#[gpui::test]
fn the_page_tabs_switch_what_is_registered(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    let (first, previews) = view.read_with(cx, |view, _| (view.url().unwrap().to_string(), view.previews()));
    let regions = testing::bounds(cx, "artifact-tab-regions");
    cx.simulate_click(regions.center(), Modifiers::none());
    redraw(cx);
    assert_eq!(view.read_with(cx, |view, _| view.tab_id()).as_ref(), "regions");
    let second = view.read_with(cx, |view, _| view.url().unwrap().to_string());
    assert_ne!(first, second, "each tab shown gets a new address");
    let previews = previews.lock().unwrap();
    assert_eq!(previews.len(), 1, "the tab left is released");
    assert_eq!(previews.handle(&get(&first)).status, 404);
    assert!(String::from_utf8(previews.handle(&get(&second)).body).unwrap().contains("<h2>Regions</h2>"));
}

#[gpui::test]
fn the_zoom_steps_resets_and_fits(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    let click = |cx: &mut VisualTestContext, selector: &'static str| {
        let at = testing::bounds(cx, selector).center();
        cx.simulate_click(at, Modifiers::none());
        redraw(cx);
    };
    click(cx, "artifact-zoom-in");
    assert!((view.read_with(cx, |view, _| view.scale()) - ZOOM_STEP).abs() < 1e-9);
    for _ in 0..10 {
        click(cx, "artifact-zoom-in");
    }
    assert_eq!(view.read_with(cx, |view, _| view.scale()), MAX_SCALE);
    click(cx, "artifact-zoom");
    assert_eq!(view.read_with(cx, |view, _| view.scale()), 1.0, "the reading resets to 100%");
    // The page reports it is wider than the panel: Fit zooms out to its width.
    view.update_in(cx, |view, window, cx| view.on_page(PageMessage::Size { scroll_width: 1100.0, client_width: 540.0 }, window, cx));
    click(cx, "artifact-fit");
    let room = f64::from(f32::from(testing::bounds(cx, "artifact-page").size.width));
    assert!((view.read_with(cx, |view, _| view.scale()) - room / 1100.0).abs() < 1e-6);
    // Ctrl-wheel in the page zooms out from there, not below the minimum.
    view.update_in(cx, |view, window, cx| view.on_page(PageMessage::Zoom { dy: 100_000.0, cx: 5.0, cy: 5.0 }, window, cx));
    assert_eq!(view.read_with(cx, |view, _| view.scale()), MIN_SCALE);
    view.update_in(cx, |view, window, cx| view.on_page(PageMessage::Fit, window, cx));
    assert!((view.read_with(cx, |view, _| view.scale()) - room / 1100.0).abs() < 1e-6, "a double-click fits again");
}

#[gpui::test]
fn an_html_reply_opens_its_page_in_the_tab(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    assert_ne!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Artifact);
    // What the card's Open calls.
    cx.update(|_, cx| super::open(&super::card::fixture_reply().page, cx));
    redraw(cx);
    assert_eq!(panel.read_with(cx, |panel, _| panel.active()), PanelTab::Artifact);
    assert!(view.read_with(cx, |view, _| view.is_shown()));
    assert_eq!(view.read_with(cx, |view, _| view.page().id.clone()).as_ref(), REPLY_PAGE);
    assert!(cx.debug_bounds("artifact-tabs").is_none(), "a one-tab page has no tabs pill");
    assert!(cx.debug_bounds("artifact-tab-overview").is_none());
    let host = view.read_with(cx, |view, _| view.host().cloned()).unwrap();
    let holes = host.read_with(cx, |host, _| host.cutouts().iter().filter(|c| c.see_through).count());
    assert_eq!(holes, 1, "only the zoom's: a reply's page takes no comments");
}

#[gpui::test]
fn the_reply_card_draws_in_the_transcript(cx: &mut TestAppContext) {
    use crate::workspace::chat::fixture::cards_demo;
    use crate::workspace::chat::transcript::{Card, Item, Transcript};
    let items = cards_demo();
    let ix = items.iter().position(|item| matches!(item, Item::Card(Card::Html(_)))).expect("the cards demo has an HTML reply");
    let (_, cx) = testing::mount_in_root(cx, move |_, cx| Transcript::with_items(items, cx));
    cx.simulate_resize(gpui::size(px(800.0), px(9000.0)));
    redraw(cx);
    let open = cx.debug_bounds(testing::leak(format!("html-reply-open-{ix}"))).expect("the card draws its Open");
    assert_eq!(open.size.height, px(28.0));
}

// A data layer's page (live).

fn live_page(version: u32, comments: usize) -> fixture::HtmlArtifact {
    fixture::HtmlArtifact {
        id: "41251d23".into(),
        title: "Status".into(),
        version,
        tabs: vec![
            fixture::ArtifactTab { id: "status".into(), title: "Status".into(), html: "<h1>Status</h1>".into() },
            fixture::ArtifactTab { id: "shots".into(), title: "Screenshots".into(), html: "<img src=\"assets/a.png\">".into() },
        ],
        assets: vec![Asset::owned("a.png", Some("image/png"), vec![1, 2, 3])],
        comments: (0..comments)
            .map(|i| fixture::SentComment {
                id: format!("c{i}").into(),
                tab: "status".into(),
                x: 0.1,
                y: 0.2,
                anchor: None,
                text: "Say more".into(),
                resolved: false,
                note: None,
            })
            .collect(),
    }
}

#[gpui::test]
fn a_live_page_is_a_skeleton_until_read_then_loads_and_keeps_its_tab(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    view.update(cx, |v, cx| v.start_live(cx));
    redraw(cx);
    assert!(view.read_with(cx, |v, _| v.is_loading() && v.url().is_none()));
    testing::bounds(cx, "artifact-skeleton");
    assert!(cx.debug_bounds("artifact-tabs").is_none(), "no pills over a skeleton");
    view.update(cx, |v, cx| v.set_live_page(live_page(7, 0), cx));
    redraw(cx);
    assert!(cx.debug_bounds("artifact-skeleton").is_none());
    let url = view.read_with(cx, |v, _| v.url().map(str::to_owned)).expect("registered");
    let previews = view.read_with(cx, |v, _| v.previews());
    let served = previews.lock().unwrap().handle(&get(&format!("{url}/assets/a.png")));
    assert_eq!((served.status, served.body.clone()), (200, vec![1, 2, 3]), "its file is served");
    view.update(cx, |v, cx| v.select_tab("shots".into(), cx));
    let shots_url = view.read_with(cx, |v, _| v.url().map(str::to_owned)).unwrap();
    // The same page with a new comment: no reload, the tab stays.
    view.update(cx, |v, cx| v.set_live_page(live_page(7, 1), cx));
    assert_eq!(view.read_with(cx, |v, _| v.url().map(str::to_owned)), Some(shots_url.clone()));
    assert_eq!(view.read_with(cx, |v, _| (v.tab_id().to_string(), v.page().comments.len())), ("shots".into(), 1));
    // A new version loads again, on the same tab while the page has it.
    view.update(cx, |v, cx| v.set_live_page(live_page(8, 1), cx));
    assert_ne!(view.read_with(cx, |v, _| v.url().map(str::to_owned)), Some(shots_url));
    assert_eq!(view.read_with(cx, |v, _| v.tab_id().to_string()), "shots");
}

#[gpui::test]
fn live_tabs_show_only_while_the_data_layer_says_the_chat_has_them(cx: &mut TestAppContext) {
    let (panel, _view, cx) = mount(cx);
    // The Chat the window shows (the panel follows it).
    let key: gpui::SharedString = panel.read_with(cx, |p, _| p.chat().to_string()).into();
    panel.update(cx, |p, cx| p.set_live_details(key.clone(), Default::default(), cx));
    assert_eq!(panel.read_with(cx, |p, _| p.visible_tabs()), vec![PanelTab::Details]);
    panel.update(cx, |p, cx| p.set_live_canvas(key.clone(), true, false, cx));
    assert_eq!(panel.read_with(cx, |p, _| p.visible_tabs()), vec![PanelTab::Details, PanelTab::Designs]);
    panel.update(cx, |p, cx| p.set_live_canvas("/p#2".into(), true, true, cx));
    assert_eq!(panel.read_with(cx, |p, _| p.visible_tabs()), vec![PanelTab::Details, PanelTab::Designs], "another Chat's word is ignored");
    panel.update(cx, |p, cx| {
        p.set_live_canvas(key.clone(), true, true, cx);
        p.activate(PanelTab::Artifact, cx);
    });
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Artifact);
    panel.update(cx, |p, cx| p.set_live_canvas(key.clone(), true, false, cx));
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Details, "a tab that goes falls back to Details");
}

// Comment mode on the page.

/// `ArtifactPage`'s comments: the comment button arms comment mode (the page hears it); a press the page's helper
/// reports pins a comment on the tab shown, with its anchor and nearby text, and opens its bubble at the pin, cut out of
/// the page and focused; the bubble follows the pin as the page scrolls and hides off screen; Enter keeps it; a sent
/// pin opens read back; Escape closes, then leaves comment mode; Send sends Electron's message and records the
/// comment. The composer still types after it all.
#[gpui::test]
fn comment_mode_pins_on_the_page_and_send_sends_the_comments(cx: &mut TestAppContext) {
    let (panel, view, cx) = mount(cx);
    open_tab(&panel, cx);
    view.update(cx, |v, cx| v.set_live_page(live_page(7, 1), cx));
    redraw(cx);
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    {
        let sink = events.clone();
        cx.update(|_, cx| cx.subscribe(&view, move |_, event: &super::ArtifactsEvent, _| sink.borrow_mut().push(event.clone())).detach());
    }
    let at = testing::bounds(cx, "artifact-comment").center();
    cx.simulate_click(at, gpui::Modifiers::none());
    redraw(cx);
    assert!(view.read_with(cx, |v, _| v.comments_state().commenting));

    let press = PageMessage::Press { x: 0.4, y: 0.3, anchor: "h1:1@0.5,0.5".into(), near: "Status".into(), sx: 40.0, sy: 60.0 };
    view.update_in(cx, |v, window, cx| v.on_page(press, window, cx));
    redraw(cx);
    let body = testing::bounds(cx, "artifact-page");
    let bubble = testing::bounds(cx, "comment-bubble");
    let scale = view.read_with(cx, |v, _| v.scale()) as f32;
    assert!((bubble.origin.x - (body.origin.x + px(40.0 * scale))).abs() < px(1.0), "{bubble:?} in {body:?}");
    assert!((bubble.origin.y - (body.origin.y + px(60.0 * scale))).abs() < px(1.0));
    let host = view.read_with(cx, |v, _| v.host().cloned()).unwrap();
    assert!(host.read_with(cx, |h, _| h.cutouts().iter().any(|c| c.see_through && c.bounds == bubble)), "the page lets the bubble show");
    let draft = view.read_with(cx, |v, _| v.comments_state().drafts[0].clone());
    assert_eq!((draft.anchor.as_deref(), draft.near.as_deref()), (Some("h1:1@0.5,0.5"), Some("Status")));
    assert_eq!(draft.tab, Some(("status".into(), "Status".into())));
    let pins = view.read_with(cx, |v, cx| v.pins(crate::theme::ActiveTheme::theme(cx)));
    assert!(pins.iter().any(|p| p.key == draft.key && p.hide), "the page hides the open pin under its bubble: {pins:?}");

    // The page scrolls: the bubble follows; scrolled out of view, it hides.
    let key = draft.key.clone();
    view.update_in(cx, |v, window, cx| v.on_page(PageMessage::Anchor { key: key.clone(), sx: 40.0, sy: 20.0, shown: true }, window, cx));
    redraw(cx);
    assert!((testing::bounds(cx, "comment-bubble").origin.y - (body.origin.y + px(20.0 * scale))).abs() < px(1.0));
    view.update_in(cx, |v, window, cx| v.on_page(PageMessage::Anchor { key: key.clone(), sx: 40.0, sy: -300.0, shown: false }, window, cx));
    redraw(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none());
    view.update_in(cx, |v, window, cx| v.on_page(PageMessage::Anchor { key: key.clone(), sx: 40.0, sy: 60.0, shown: true }, window, cx));
    redraw(cx);

    cx.simulate_input("Which week?");
    cx.simulate_keystrokes("enter");
    redraw(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none(), "Enter keeps it");
    assert_eq!(view.read_with(cx, |v, _| (v.feedback(), v.comments_state().drafts[0].text.clone())), (1, "Which week?".into()));

    // A sent comment's pin opens it read back; Escape closes it, then leaves comment mode.
    view.update_in(cx, |v, window, cx| v.on_page(PageMessage::Pin { key: "sent:c0".into(), sx: 10.0, sy: 10.0 }, window, cx));
    redraw(cx);
    testing::bounds(cx, "comment-bubble");
    view.update_in(cx, |v, window, cx| v.escape(window, cx));
    view.update_in(cx, |v, window, cx| v.escape(window, cx));
    redraw(cx);
    assert!(cx.debug_bounds("comment-bubble").is_none());
    assert!(!view.read_with(cx, |v, _| v.comments_state().commenting));

    let at = testing::bounds(cx, "artifact-send").center();
    cx.simulate_click(at, gpui::Modifiers::none());
    redraw(cx);
    let sent = events.borrow().clone();
    let [super::ArtifactsEvent::Send(message), super::ArtifactsEvent::AddComments(recorded)] = sent.as_slice() else { panic!("{sent:?}") };
    assert_eq!(
        message,
        &format!(
            "A comment on the artifact:\n\n1. (comment {key}) On the artifact \"Status\" (41251d23), 40% across and 30% down, on the tab status (\"Status\"), near \"Status\": Which week?\n\nRead the current page with artifact_read, then update it in place with artifact_show. Keep one Artifact page for this Chat. Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id."
        )
    );
    assert_eq!(
        recorded,
        &vec![serde_json::json!({"id": key, "design": {"id": "41251d23", "title": "Status", "version": 7, "format": "html"},
            "x": 0.4, "y": 0.3, "text": "Which week?", "anchor": "h1:1@0.5,0.5", "near": "Status", "tab": {"id": "status", "title": "Status"}})]
    );
    assert_eq!(view.read_with(cx, |v, _| v.feedback()), 0);

    // The composer still takes typing once the bubble is gone: a click in it, then keys.
    let composer = cx.update(|window, cx| {
        let workspace = window
            .root::<gpui_component::Root>()
            .flatten()
            .unwrap()
            .read(cx)
            .view()
            .clone()
            .downcast::<crate::workspace::Workspace>()
            .unwrap();
        workspace.read(cx).chat.read(cx).composer.clone()
    });
    let before = composer.read_with(cx, |c, _| c.text().to_owned());
    let at = testing::bounds(cx, "composer-input").center();
    cx.simulate_click(at, gpui::Modifiers::none());
    cx.simulate_input("ok");
    assert_eq!(composer.read_with(cx, |c, _| c.text().to_owned()), format!("{before}ok"));
}

#[test]
fn page_comment_messages_read_and_the_mode_says_comment() {
    let key = "\"milagre\":\"milagre:artifact-page\"";
    assert_eq!(
        messages::parse(&format!("{{{key},\"t\":\"press\",\"x\":1.4,\"y\":0.2,\"a\":\"p:1@0,0\",\"near\":\"Hi\",\"sx\":3,\"sy\":4}}")),
        Some(PageMessage::Press { x: 1.0, y: 0.2, anchor: "p:1@0,0".into(), near: "Hi".into(), sx: 3.0, sy: 4.0 })
    );
    assert_eq!(
        messages::parse(&format!("{{{key},\"t\":\"anchor\",\"k\":\"ab12cd34\",\"sx\":3,\"sy\":4,\"shown\":true}}")),
        Some(PageMessage::Anchor { key: "ab12cd34".into(), sx: 3.0, sy: 4.0, shown: true })
    );
    let mode = messages::mode(true, "crosshair");
    assert!(mode.contains("\"comment\":true") && mode.contains("\"cursor\":\"crosshair\""), "{mode}");
    let pin = messages::PagePin {
        key: "k".into(),
        x: 0.1,
        y: 0.2,
        anchor: None,
        number: 1,
        fill: "#000".into(),
        ink: "#fff".into(),
        label: "Comment 1".into(),
        hide: true,
    };
    let pins = messages::pins(&[pin], Some("k"));
    assert!(pins.contains("\"hide\":true") && pins.contains("\"watch\":\"k\""), "{pins}");
}
