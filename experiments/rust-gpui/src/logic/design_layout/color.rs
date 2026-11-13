//! CSS colours as a design names them (`designPaint` in `design-colors.mjs`): hex with or without alpha, `rgb()`,
//! `rgba()`, `hsl()`, `hsla()` in comma or space syntax, the CSS names and `transparent`.

use super::data::tables;

/// The colour text and icons draw in when they name no fill (`DESIGN_INK`).
pub const DESIGN_INK: &str = "#202720";
/// The grey a shape, or an image still to add, paints when it names no fill (`DESIGN_PLACEHOLDER`).
pub const DESIGN_PLACEHOLDER: &str = "#d8ded8";

/// A colour as 0-255 channels and a 0-1 alpha. `None` from [`paint`] is a value CSS would not accept.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paint {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Paint {
    pub const TRANSPARENT: Paint = Paint { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

    /// The colour as `0xRRGGBB`, channels rounded as `designPaint`'s hex does.
    pub fn rgb_hex(self) -> u32 {
        let byte = |v: f64| v.clamp(0.0, 255.0).round() as u32;
        (byte(self.r) << 16) | (byte(self.g) << 8) | byte(self.b)
    }
}

fn clamp(value: f64, maximum: f64) -> f64 {
    value.clamp(0.0, maximum)
}

fn hex_digit(c: u8) -> Option<u32> {
    (c as char).to_digit(16)
}

fn hex_paint(source: &str) -> Option<Paint> {
    let digits = source.strip_prefix('#')?.as_bytes();
    if !digits.iter().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let pair = |i: usize| -> f64 { (hex_digit(digits[i]).unwrap() * 16 + hex_digit(digits[i + 1]).unwrap()) as f64 };
    let single = |i: usize| -> f64 { (hex_digit(digits[i]).unwrap() * 17) as f64 };
    match digits.len() {
        3 => Some(Paint { r: single(0), g: single(1), b: single(2), a: 1.0 }),
        4 => Some(Paint { r: single(0), g: single(1), b: single(2), a: hex_digit(digits[3]).unwrap() as f64 / 15.0 }),
        6 => Some(Paint { r: pair(0), g: pair(2), b: pair(4), a: 1.0 }),
        8 => Some(Paint { r: pair(0), g: pair(2), b: pair(4), a: pair(6) / 255.0 }),
        _ => None,
    }
}

/// A CSS number, optionally with a percent sign: what `Number(part.replace(/%$/, ""))` accepts.
fn css_number(part: &str) -> Option<f64> {
    let body = part.strip_suffix('%').unwrap_or(part);
    if body.is_empty() || body.contains(['%', ' ']) {
        return None;
    }
    let digits = body.trim_start_matches(['+', '-']);
    if digits.is_empty() || !digits.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    body.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn alpha(value: Option<&str>) -> f64 {
    match value {
        None => 1.0,
        Some(v) if v.ends_with('%') => clamp(css_number(v).unwrap_or(f64::NAN) / 100.0, 1.0),
        Some(v) => clamp(v.parse::<f64>().unwrap_or(f64::NAN), 1.0),
    }
}

/// `designPaint`: the colour a value paints, or `None` when CSS would not accept it.
pub fn paint(value: &str) -> Option<Paint> {
    let source = value.trim();
    if source.eq_ignore_ascii_case("transparent") {
        return Some(Paint::TRANSPARENT);
    }
    if source.starts_with('#') {
        return hex_paint(source);
    }
    let lower = source.to_ascii_lowercase();
    let function = ["rgba", "rgb", "hsla", "hsl"].into_iter().find(|name| lower.starts_with(&format!("{name}(")));
    let Some(function) = function else {
        return tables().colors.get(&lower).map(|[r, g, b]| Paint { r: *r, g: *g, b: *b, a: 1.0 });
    };
    let content = source[function.len() + 1..].strip_suffix(')')?.trim();
    if content.contains(')') {
        return None;
    }
    let parts: Vec<&str> = content.split([' ', ',', '/', '\t', '\n']).filter(|part| !part.is_empty()).collect();
    // The grammar: three or four numbers, all comma separated, or space separated with an optional `/ alpha`.
    let commas = content.contains(',');
    let well_formed = if commas {
        content.split(',').map(str::trim).all(|part| css_number(part).is_some()) && matches!(content.split(',').count(), 3 | 4)
    } else {
        let (main, slash) = match content.split_once('/') {
            Some((main, alpha)) => (main, Some(alpha.trim())),
            None => (content, None),
        };
        let main: Vec<&str> = main.split_whitespace().collect();
        main.len() == 3 && main.iter().all(|p| css_number(p).is_some()) && slash.is_none_or(|a| css_number(a).is_some())
    };
    if !well_formed || parts.iter().any(|part| css_number(part).is_none()) {
        return None;
    }
    let percent = |part: &str| part.ends_with('%');
    if function.starts_with("rgb") {
        if commas && !parts[..3].iter().all(|p| percent(p) == percent(parts[0])) {
            return None;
        }
        let channel = |part: &str| {
            let n = css_number(part).unwrap();
            if percent(part) { n * 2.55 } else { n }
        };
        return Some(Paint { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha(parts.get(3).copied()) });
    }
    if percent(parts[0]) || !percent(parts[1]) || !percent(parts[2]) {
        return None;
    }
    let hue = ((css_number(parts[0]).unwrap() % 360.0) + 360.0) % 360.0;
    let saturation = clamp(css_number(parts[1]).unwrap() / 100.0, 1.0);
    let lightness = clamp(css_number(parts[2]).unwrap() / 100.0, 1.0);
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let second = chroma * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match hue {
        h if h < 60.0 => (chroma, second, 0.0),
        h if h < 120.0 => (second, chroma, 0.0),
        h if h < 180.0 => (0.0, chroma, second),
        h if h < 240.0 => (0.0, second, chroma),
        h if h < 300.0 => (second, 0.0, chroma),
        _ => (chroma, 0.0, second),
    };
    let offset = lightness - chroma / 2.0;
    // `designPaint` rounds through hex; keep the same 0-255 integers.
    let channel = |c: f64| clamp((c + offset) * 255.0, 255.0).round();
    Some(Paint { r: channel(r), g: channel(g), b: channel(b), a: alpha(parts.get(3).copied()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_forms_designs_use() {
        // Expected values from `designPaint` run in node.
        assert_eq!(paint("#abc"), Some(Paint { r: 170.0, g: 187.0, b: 204.0, a: 1.0 }));
        assert_eq!(paint("#3b5bdb").map(Paint::rgb_hex), Some(0x3b5bdb));
        assert_eq!(paint("#00000080").map(|p| (p.a * 255.0).round()), Some(128.0));
        assert_eq!(paint("#0008").map(|p| p.a), Some(8.0 / 15.0));
        assert_eq!(paint("transparent"), Some(Paint::TRANSPARENT));
        assert_eq!(paint("rebeccapurple").map(Paint::rgb_hex), Some(0x663399));
        assert_eq!(paint("rgba(59, 91, 219, 0.1)"), Some(Paint { r: 59.0, g: 91.0, b: 219.0, a: 0.1 }));
        assert_eq!(paint("rgb(100% 0% 50% / 50%)").map(|p| (p.rgb_hex(), p.a)), Some((0xff007f, 0.5)));
        assert_eq!(paint("hsl(120, 100%, 25%)").map(Paint::rgb_hex), Some(0x008000));
        assert_eq!(paint("hsla(0 100% 50% / 0.25)").map(|p| (p.rgb_hex(), p.a)), Some((0xff0000, 0.25)));
        assert_eq!(paint("rgb(10%, 20, 30)"), None);
        assert_eq!(paint("hsl(10%, 20%, 30%)"), None);
        assert_eq!(paint("#12345"), None);
        assert_eq!(paint("not-a-colour"), None);
    }
}
