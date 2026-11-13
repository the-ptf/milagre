//! The viewer's letterbox geometry and touch mapping, ported from `shared/simulator-receiver.mjs`
//! (`simulatorGeometry`, `simulatorPoint`, `simulatorAppearance`), and the keyboard's HID usages. Pure functions:
//! `tests.rs` checks them against vectors the JavaScript produced.

use super::types::{Device, Orientation, Platform, ScreenPoint, Status};

/// The stage keeps this much room around the device on every side; the bezel is drawn inside it.
pub const STAGE_INSET: f32 = 24.0;

/// Where the screen sits in the stage, in stage pixels. `width`/`height` are on screen (after rotation);
/// `raw_width`/`raw_height` are the capture's own axes at the same scale. `rotation` is 0, 90, -90 or 180.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
    pub raw_width: f32,
    pub raw_height: f32,
    pub rotation: i32,
}

/// `simulatorGeometry`: the capture follows Device Hub's raw portrait orientation, already-rotated buffers included.
pub fn geometry(status: &Status, box_width: f32, box_height: f32, inset: f32) -> Option<Geometry> {
    if status.width == 0 || status.height == 0 || box_width <= inset * 2.0 || box_height <= inset * 2.0 {
        return None;
    }
    let (raw_w, raw_h) = (status.width as f32, status.height as f32);
    let rotation = rotation(status);
    let sideways = rotation.abs() == 90;
    let (width, height) = if sideways { (raw_h, raw_w) } else { (raw_w, raw_h) };
    let scale = ((box_width - inset * 2.0) / width).min((box_height - inset * 2.0) / height);
    Some(Geometry {
        left: (box_width - width * scale) / 2.0,
        top: (box_height - height * scale) / 2.0,
        width: width * scale,
        height: height * scale,
        raw_width: raw_w * scale,
        raw_height: raw_h * scale,
        rotation,
    })
}

/// How far the capture turns on screen, in degrees clockwise. A landscape status over a buffer that is already
/// wider than tall needs no turn.
pub fn rotation(status: &Status) -> i32 {
    let degrees: i32 = match status.orientation {
        Orientation::LandscapeLeft => 90,
        Orientation::LandscapeRight => -90,
        Orientation::PortraitUpsideDown => 180,
        Orientation::Portrait => 0,
    };
    if degrees.abs() == 90 && status.width > status.height { 0 } else { degrees }
}

/// `simulatorPoint`: a stage point to the capture's 0..1 axes. A start outside the screen (or outside its rounded
/// corners, `radius` > 0) is ignored; a captured drag (`clamp`) is held at the edge.
pub fn point(x: f32, y: f32, geometry: &Geometry, clamp: bool, radius: f32) -> Option<ScreenPoint> {
    let mut nx = (x - geometry.left) / geometry.width;
    let mut ny = (y - geometry.top) / geometry.height;
    if !nx.is_finite() || !ny.is_finite() || (!clamp && !((0.0..=1.0).contains(&nx) && (0.0..=1.0).contains(&ny))) {
        return None;
    }
    if !clamp && radius > 0.0 {
        let r = radius.min(geometry.width / 2.0).min(geometry.height / 2.0);
        let (px, py) = (nx * geometry.width, ny * geometry.height);
        let cx = px.clamp(r, geometry.width - r);
        let cy = py.clamp(r, geometry.height - r);
        if (px - cx).powi(2) + (py - cy).powi(2) > r * r {
            return None;
        }
    }
    nx = nx.clamp(0.0, 1.0);
    ny = ny.clamp(0.0, 1.0);
    Some(match geometry.rotation {
        90 => ScreenPoint { x: ny, y: 1.0 - nx },
        -90 => ScreenPoint { x: 1.0 - ny, y: nx },
        180 => ScreenPoint { x: 1.0 - nx, y: 1.0 - ny },
        _ => ScreenPoint { x: nx, y: ny },
    })
}

/// `simulatorAppearance(device).radius`: the screen's corner radius as a share of its short side. Unknown models
/// keep a modest corner; a custom simulator name cannot override a known model type. (The cutout the JavaScript
/// also returns is no longer drawn: hardware cutouts are part of the captured pixels.)
pub fn corner_share(device: &Device) -> f32 {
    let model = device.device_type.as_deref().unwrap_or(&device.name).replace(['-', '_'], " ").to_lowercase();
    if device.platform == Platform::Android {
        return 0.09;
    }
    if model.contains("ipad") {
        return 0.045;
    }
    let mut rest = model.as_str();
    while let Some(ix) = rest.find("iphone") {
        let after = rest[ix + "iphone".len()..].trim_start();
        if after.starts_with("se") {
            return 0.025;
        }
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let tail = &after[digits.len()..];
            let tail = tail.strip_prefix('e').unwrap_or(tail);
            if tail.is_empty() || tail.starts_with(char::is_whitespace) {
                let generation: u32 = digits.parse().unwrap_or(0);
                return if generation >= 11 { 0.14 } else { 0.025 };
            }
        }
        if let Some(tail) = after.strip_prefix('x') {
            let tail = tail.strip_prefix(['r', 's']).unwrap_or(tail);
            if !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                return 0.12;
            }
        }
        if after.strip_prefix("air").is_some_and(|tail| !tail.starts_with(|c: char| c.is_ascii_alphanumeric())) {
            return 0.14;
        }
        rest = &rest[ix + "iphone".len()..];
    }
    0.09
}

/// The device frame around the screen: the bezel's thickness and the screen's corner radius, in stage pixels
/// (the receiver's `layout`).
pub fn bezel_and_radius(geometry: &Geometry, device: &Device) -> (f32, f32) {
    let short = geometry.width.min(geometry.height);
    ((short * 0.025).min(8.0), short * corner_share(device))
}

/// The USB HID keyboard usage for a GPUI key name (`Keystroke::key`), for `Input::Key`. `None` for keys the
/// simulator has no usage for (function keys, media keys), which are not sent.
pub fn hid_usage(key: &str) -> Option<u8> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return match c {
            'a'..='z' => Some(4 + (c as u8 - b'a')),
            '1'..='9' => Some(30 + (c as u8 - b'1')),
            '0' => Some(39),
            '-' => Some(45),
            '=' => Some(46),
            '[' => Some(47),
            ']' => Some(48),
            '\\' => Some(49),
            ';' => Some(51),
            '\'' => Some(52),
            '`' => Some(53),
            ',' => Some(54),
            '.' => Some(55),
            '/' => Some(56),
            ' ' => Some(44),
            _ => None,
        };
    }
    Some(match key {
        "enter" => 40,
        "escape" => 41,
        "backspace" => 42,
        "tab" => 43,
        "space" => 44,
        "home" => 74,
        "pageup" => 75,
        "delete" => 76,
        "end" => 77,
        "pagedown" => 78,
        "right" => 79,
        "left" => 80,
        "down" => 81,
        "up" => 82,
        _ => return None,
    })
}
