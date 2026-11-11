//! The Artifact pages the dock shows while there is no daemon: the Chat's page (two tabs, two files, two sent
//! comments) and the page an HTML reply in the transcript opens. Panel-local, like `panel/fixture.rs`; the shapes
//! follow `HtmlArtifact` and `ArtifactTab` in `packages/shared/src/artifact.ts`, trimmed to what the dock reads.

use gpui::SharedString;

use super::messages::PagePin;
use super::protocol::Asset;

/// One tab of a page (`ArtifactTab`).
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactTab {
    pub id: SharedString,
    pub title: SharedString,
    pub html: &'static str,
}

/// A comment sent on the page, which the page draws as a pin (`htmlSentPins`).
#[derive(Clone, Debug, PartialEq)]
pub struct SentComment {
    pub id: &'static str,
    pub tab: &'static str,
    pub x: f64,
    pub y: f64,
    pub anchor: Option<&'static str>,
    pub text: &'static str,
    pub resolved: bool,
}

/// An Artifact page (`HtmlArtifact`): its tabs (one, with the page's own title, when it has none) and files.
#[derive(Clone, Debug)]
pub struct HtmlArtifact {
    pub id: SharedString,
    pub title: SharedString,
    pub version: u32,
    pub tabs: Vec<ArtifactTab>,
    pub assets: Vec<Asset>,
    pub comments: Vec<SentComment>,
}

impl HtmlArtifact {
    /// The tab to show: the one named, else the first (`artifactTab`).
    pub fn tab(&self, id: Option<&str>) -> &ArtifactTab {
        id.and_then(|id| self.tabs.iter().find(|tab| tab.id.as_ref() == id)).unwrap_or(&self.tabs[0])
    }

    /// Whether the dock shows a tab row: only a page split into more than one tab.
    pub fn has_tabs(&self) -> bool {
        self.tabs.len() > 1
    }

    /// The sent comments on `tab`, as the pins the page draws, numbered in the order they were sent.
    pub fn pins(&self, tab: &str, ink: &str, surface: &str, green_ink: &str, on_green: &str) -> Vec<PagePin> {
        self.comments
            .iter()
            .enumerate()
            .filter(|(_, comment)| comment.tab == tab)
            .map(|(ix, comment)| PagePin {
                key: format!("sent:{}", comment.id),
                x: comment.x,
                y: comment.y,
                anchor: comment.anchor.map(str::to_string),
                number: ix as u32 + 1,
                fill: if comment.resolved { green_ink } else { ink }.to_string(),
                ink: if comment.resolved { on_green } else { surface }.to_string(),
                label: format!("Sent comment {}{}: {}", ix + 1, if comment.resolved { ", resolved" } else { "" }, comment.text),
            })
            .collect()
    }
}

/// The Chat's own page.
pub const CHAT_PAGE: &str = "relay-report";
/// The page the HTML reply in the transcript opens.
pub const REPLY_PAGE: &str = "intro-timing";

const OVERVIEW: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Relay latency</title><style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 28px; color: #191919; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; } p.lede { color: #5c6470; margin: 0 0 20px; }
  .row { display: flex; gap: 16px; align-items: center; margin: 16px 0; }
  figure { margin: 0; } figcaption { color: #5c6470; font-size: 12px; }
  table { border-collapse: collapse; margin-top: 12px; } td, th { border-bottom: 1px solid #e3e7ee; padding: 6px 12px; text-align: left; }
  #checks { margin-top: 20px; padding: 12px 14px; border-radius: 10px; background: #f4f7fb; font: 12px/1.6 ui-monospace, monospace; }
  #checks b { font-weight: 600; } .ok { color: #007e33; } .bad { color: #c4231a; }
</style></head><body>
  <h1>Relay latency, last 7 days</h1>
  <p class="lede">p50 and p95 per region, from the relay's own timings. Files load from the page's assets.</p>
  <div class="row">
    <figure><img id="chart" src="assets/chart.svg" width="320" height="140" alt="Latency per day"><figcaption>Chart (SVG file)</figcaption></figure>
    <figure><img id="swatch" src="./assets/swatch.png" width="96" height="96" alt="Accent swatch"><figcaption>Swatch (PNG file)</figcaption></figure>
  </div>
  <table><tr><th>Region</th><th>p50</th><th>p95</th></tr>
    <tr><td>Frankfurt</td><td>38 ms</td><td>91 ms</td></tr>
    <tr><td>São Paulo</td><td>52 ms</td><td>140 ms</td></tr>
    <tr><td>Virginia</td><td>41 ms</td><td>102 ms</td></tr></table>
  <div id="checks">Host checks running…</div>
  <script>
  (function(){
    var out = {}, el = document.getElementById("checks");
    function show(){ el.innerHTML = Object.keys(out).map(function(k){ return "<b>" + k + "</b>: " + out[k]; }).join("<br>"); }
    function mark(k, ok, text){ out[k] = '<span class="' + (ok ? "ok" : "bad") + '">' + text + "</span>"; show(); }
    document.addEventListener("securitypolicyviolation", function(e){
      if (e.violatedDirective.indexOf("connect-src") === 0 || e.effectiveDirective === "connect-src") mark("fetch", true, "blocked by CSP (" + e.effectiveDirective + ")");
      if (e.effectiveDirective === "script-src-elem" || e.violatedDirective.indexOf("script-src") === 0) { if (e.blockedURI && e.blockedURI.indexOf("http") === 0) mark("remote script", true, "blocked by CSP (" + e.effectiveDirective + ")"); }
    });
    out["fetch"] = "…"; out["remote script"] = "…"; out["assets"] = "…"; show();
    try { fetch("https://example.com/data.json").then(function(){ mark("fetch", false, "ALLOWED"); }, function(){ if (out["fetch"] === "…") mark("fetch", true, "blocked"); }); }
    catch (e) { mark("fetch", true, "blocked (" + e.name + ")"); }
    var s = document.createElement("script"); s.src = "https://example.com/remote.js";
    s.onload = function(){ mark("remote script", false, "ALLOWED"); };
    s.onerror = function(){ if (out["remote script"] === "…") mark("remote script", true, "blocked"); };
    document.head.appendChild(s);
    var imgs = [document.getElementById("chart"), document.getElementById("swatch")], left = imgs.length, bad = [];
    imgs.forEach(function(img){
      function done(ok){ if (!ok) bad.push(img.id); if (--left === 0) mark("assets", bad.length === 0, bad.length ? "failed: " + bad.join(", ") : "2 of 2 loaded"); }
      if (img.complete) done(img.naturalWidth > 0); else { img.onload = function(){ done(true); }; img.onerror = function(){ done(false); }; }
    });
  })();
  </script>
</body></html>"#;

const REGIONS: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 28px; color: #191919; background: #fff; }
  h2 { font-size: 18px; margin: 0 0 12px; } li { margin: 6px 0; }
  .wide { width: 1100px; height: 40px; margin-top: 16px; background: linear-gradient(90deg, #007df3, #7a4ae0); border-radius: 8px; }
</style></head><body>
  <h2>Regions</h2>
  <ul><li>Frankfurt: steady, one spike on Tuesday.</li><li>São Paulo: p95 up 18% after the Worker deploy.</li><li>Virginia: unchanged.</li></ul>
  <p>The bar below is wider than the dock, so Fit zooms out to show all of it.</p>
  <div class="wide"></div>
</body></html>"#;

const REPLY: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px 28px; color: #191919; background: #fff; }
  .bar { height: 14px; border-radius: 7px; background: #007df3; margin: 6px 0 14px; }
</style></head><body>
  <h2 style="margin:0 0 12px;font-size:18px">Dawn intro, time to Begin</h2>
  <div>Before the fix (Linux, never fires)</div><div class="bar" style="width:100%;background:#c4231a"></div>
  <div>After the fix (timer fallback)</div><div class="bar" style="width:34%"></div>
  <div>macOS, unchanged</div><div class="bar" style="width:28%"></div>
</body></html>"#;

static CHART: &[u8] = include_bytes!("fixture/chart.svg");
static SWATCH: &[u8] = include_bytes!("fixture/swatch.png");

/// Every page the fixture has.
pub fn pages() -> Vec<HtmlArtifact> {
    vec![
        HtmlArtifact {
            id: CHAT_PAGE.into(),
            title: "Relay latency report".into(),
            version: 3,
            tabs: vec![
                ArtifactTab { id: "overview".into(), title: "Overview".into(), html: OVERVIEW },
                ArtifactTab { id: "regions".into(), title: "Regions".into(), html: REGIONS },
            ],
            assets: vec![Asset::new("chart.svg", CHART), Asset::new("swatch.png", SWATCH)],
            comments: vec![
                SentComment {
                    id: "c1",
                    tab: "overview",
                    x: 0.32,
                    y: 0.12,
                    anchor: Some("h1:1@0.62,0.5"),
                    text: "Say which week this is.",
                    resolved: false,
                },
                SentComment {
                    id: "c2",
                    tab: "overview",
                    x: 0.5,
                    y: 0.5,
                    anchor: Some("table:1/tbody:1/tr:3/td:3@0.5,0.5"),
                    text: "Is 140 ms the Worker deploy?",
                    resolved: true,
                },
            ],
        },
        HtmlArtifact {
            id: REPLY_PAGE.into(),
            title: "Intro timing".into(),
            version: 1,
            tabs: vec![ArtifactTab { id: "".into(), title: "Intro timing".into(), html: REPLY }],
            assets: Vec::new(),
            comments: Vec::new(),
        },
    ]
}

/// The page `id`, if the fixture has it.
pub fn page(id: &str) -> Option<HtmlArtifact> {
    pages().into_iter().find(|page| page.id.as_ref() == id)
}
