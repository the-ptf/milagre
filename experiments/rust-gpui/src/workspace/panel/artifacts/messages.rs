//! What an Artifact page's helper (`ARTIFACT_PAGE_SCRIPT`) says to its viewer, and what the viewer tells it.
//!
//! The page is untrusted: it can post anything through the bridge, so a message is read as known fields only, numbers
//! finite and strings capped at 600 characters, as the phone's `ARTIFACT_SHELL_SCRIPT` does. Anything else is dropped.

use serde_json::{Map, Value, json};

use super::document::PAGE_KEY;

/// One message from the page's helper.
#[derive(Clone, Debug, PartialEq)]
pub enum PageMessage {
    /// The helper is running: the viewer sends its mode, pins and scale.
    Ready,
    /// The page's scroll width against its viewport's, so a wider page can be fitted.
    Size { scroll_width: f64, client_width: f64 },
    /// Ctrl-wheel or a pinch over the page, at a point of its viewport.
    Zoom { dy: f64, cx: f64, cy: f64 },
    /// A double-click away from text and controls: fit the page again.
    Fit,
    /// A pin was clicked: its key and where it sits on screen.
    Pin { key: String, sx: f64, sy: f64 },
    /// In comment mode, a click pinned a spot (fractions of the page, its anchor and the text near it), at a point of
    /// the page's viewport.
    Press { x: f64, y: f64, anchor: String, near: String, sx: f64, sy: f64 },
    /// Where the watched pin is now in the viewport, and whether it is in view (the page scrolled or reflowed).
    Anchor { key: String, sx: f64, sy: f64, shown: bool },
    /// C outside a field.
    Key,
}

const TEXT_CAP: usize = 600;

fn number(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn text(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(|s| s.chars().take(TEXT_CAP).collect())
}

/// A pin's key: a string, or a number as text.
fn key(map: &Map<String, Value>) -> Option<String> {
    map.get("k").and_then(|k| k.as_str().map(|s| s.chars().take(TEXT_CAP).collect()).or_else(|| k.as_f64().map(|n| n.to_string())))
}

/// Reads one message the bridge forwarded (JSON text). `None` for anything that is not a known, well-formed one.
pub fn parse(raw: &str) -> Option<PageMessage> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let map = value.as_object()?;
    if map.get("milagre").and_then(Value::as_str) != Some(PAGE_KEY) {
        return None;
    }
    Some(match map.get("t")?.as_str()? {
        "ready" => PageMessage::Ready,
        "size" => PageMessage::Size { scroll_width: number(map, "sw")?, client_width: number(map, "cw")? },
        "zoom" => PageMessage::Zoom { dy: number(map, "dy")?, cx: number(map, "cx")?, cy: number(map, "cy")? },
        "fit" => PageMessage::Fit,
        "pin" => PageMessage::Pin { key: key(map)?, sx: number(map, "sx")?, sy: number(map, "sy")? },
        "anchor" => PageMessage::Anchor {
            key: key(map)?,
            sx: number(map, "sx")?,
            sy: number(map, "sy")?,
            shown: map.get("shown").and_then(Value::as_bool).unwrap_or(false),
        },
        "press" => PageMessage::Press {
            x: number(map, "x")?.clamp(0.0, 1.0),
            y: number(map, "y")?.clamp(0.0, 1.0),
            anchor: text(map, "a").unwrap_or_default(),
            near: text(map, "near").unwrap_or_default(),
            sx: number(map, "sx").unwrap_or(0.0),
            sy: number(map, "sy").unwrap_or(0.0),
        },
        "key" => PageMessage::Key,
        _ => return None,
    })
}

/// A pin the page draws: a comment sent on it, at its anchor or its fractions of the page (`PagePin`).
#[derive(Clone, Debug, PartialEq)]
pub struct PagePin {
    pub key: String,
    pub x: f64,
    pub y: f64,
    pub anchor: Option<String>,
    pub number: u32,
    pub fill: String,
    pub ink: String,
    pub label: String,
    /// The open one: its bubble stands in for it.
    pub hide: bool,
}

/// A command for the page, as the JavaScript that delivers it: a `message` the helper reads (it takes messages from
/// its parent, which for a top-level page is the window itself).
pub fn command(mut body: Value) -> String {
    if let Some(map) = body.as_object_mut() {
        map.insert("milagre".into(), Value::String(PAGE_KEY.into()));
    }
    format!("window.postMessage({body},\"*\")")
}

/// `{t:"mode"}`: mouse input, comment mode, and the cursor a click pins with.
pub fn mode(comment: bool, cursor: &str) -> String {
    command(json!({ "t": "mode", "input": "mouse", "comment": comment, "cursor": cursor }))
}

/// `{t:"reveal"}`: scrolls pin `key` into view.
pub fn reveal(key: &str) -> String {
    command(json!({ "t": "reveal", "k": key }))
}

/// `{t:"scale"}`: the viewer's zoom, so pins keep their size; with a point, the page keeps it in place.
pub fn scale(scale: f64, at: Option<(f64, f64)>) -> String {
    match at {
        Some((cx, cy)) => command(json!({ "t": "scale", "s": scale, "cx": cx, "cy": cy })),
        None => command(json!({ "t": "scale", "s": scale })),
    }
}

/// `{t:"pins"}`: the pins to draw, and the one whose place the page reports as it scrolls (`anchor`).
pub fn pins(pins: &[PagePin], watch: Option<&str>) -> String {
    let list: Vec<Value> = pins
        .iter()
        .map(|pin| {
            let mut value = json!({
                "k": pin.key, "x": pin.x, "y": pin.y, "n": pin.number,
                "fill": pin.fill, "ink": pin.ink, "label": pin.label,
            });
            if let (Some(anchor), Some(map)) = (&pin.anchor, value.as_object_mut()) {
                map.insert("a".into(), Value::String(anchor.clone()));
            }
            if pin.hide {
                value["hide"] = Value::Bool(true);
            }
            value
        })
        .collect();
    command(json!({ "t": "pins", "pins": list, "watch": watch.map_or(Value::Null, |k| Value::String(k.into())) }))
}
