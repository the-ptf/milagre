//! Hex and OKLCH colour maths (`packages/shared/src/themes/color.ts`): mixing in OKLab, alpha, WCAG contrast and
//! the "move toward" solver that keeps text readable. Colours are `#rrggbb` or `#rrggbbaa` strings, as in TypeScript,
//! so the theme sources read like the originals.

/// Parses `#rrggbb` or `#rrggbbaa`; `None` for anything else.
pub fn parse(hex: &str) -> Option<Rgb> {
    let h = hex.strip_prefix('#')?;
    if !(h.len() == 6 || h.len() == 8) || !h.is_ascii() {
        return None;
    }
    let n = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|v| v as f64 / 255.0);
    let alpha = if h.len() == 8 { n(6)? } else { 1.0 };
    Some(Rgb { r: n(0)?, g: n(2)?, b: n(4)?, alpha })
}

pub fn is_hex(value: &str) -> bool {
    parse(value).is_some()
}

/// A strict `#rrggbb` seed (the custom theme editor's format).
pub fn is_seed(value: &str) -> bool {
    value.len() == 7 && parse(value).is_some()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub alpha: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklch {
    pub l: f64,
    pub c: f64,
    pub h: f64,
    pub alpha: f64,
}

fn parse_or_black(hex: &str) -> Rgb {
    parse(hex).unwrap_or(Rgb { r: 0.0, g: 0.0, b: 0.0, alpha: 1.0 })
}

fn to_linear(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn from_linear(c: f64) -> f64 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// JS `Math.round` on the clamped channel, as two hex digits.
fn byte(c: f64) -> String {
    let v = (c.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
    format!("{v:02x}")
}

#[derive(Clone, Copy)]
struct Lab {
    l: f64,
    a: f64,
    b: f64,
    alpha: f64,
}

fn to_oklab(hex: &str) -> Lab {
    let Rgb { r, g, b, alpha } = parse_or_black(hex);
    let (lr, lg, lb) = (to_linear(r), to_linear(g), to_linear(b));
    let l = (0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb).cbrt();
    let m = (0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb).cbrt();
    let s = (0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb).cbrt();
    Lab {
        l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        alpha,
    }
}

fn from_oklab(lab: Lab) -> String {
    let Lab { l: big_l, a, b, alpha } = lab;
    let l = (big_l + 0.3963377774 * a + 0.2158037573 * b).powi(3);
    let m = (big_l - 0.1055613458 * a - 0.0638541728 * b).powi(3);
    let s = (big_l - 0.0894841775 * a - 1.291485548 * b).powi(3);
    let r = from_linear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    let g = from_linear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    let bl = from_linear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
    format!("#{}{}{}{}", byte(r), byte(g), byte(bl), if alpha < 1.0 { byte(alpha) } else { String::new() })
}

pub fn hex_to_oklch(hex: &str) -> Oklch {
    let Lab { l, a, b, alpha } = to_oklab(hex);
    let h = b.atan2(a).to_degrees();
    Oklch { l, c: a.hypot(b), h: if h < 0.0 { h + 360.0 } else { h }, alpha }
}

pub fn oklch_to_hex(l: f64, c: f64, h: f64, alpha: f64) -> String {
    let rad = h.to_radians();
    from_oklab(Lab { l, a: c * rad.cos(), b: c * rad.sin(), alpha })
}

pub fn from_oklch(l: f64, c: f64, h: f64) -> String {
    oklch_to_hex(l, c, h, 1.0)
}

/// `t` of the way from `a` to `b`, in OKLab so midpoints don't go muddy.
pub fn mix(a: &str, b: &str, t: f64) -> String {
    let (x, y) = (to_oklab(a), to_oklab(b));
    let lerp = |p: f64, q: f64| p + (q - p) * t;
    from_oklab(Lab { l: lerp(x.l, y.l), a: lerp(x.a, y.a), b: lerp(x.b, y.b), alpha: lerp(x.alpha, y.alpha) })
}

pub fn with_alpha(hex: &str, alpha: f64) -> String {
    let base = hex[..7].to_lowercase();
    if alpha >= 1.0 { base } else { format!("{base}{}", byte(alpha)) }
}

/// `color` painted over an opaque `background`, blended in sRGB as browsers do.
pub fn over(color: &str, background: &str) -> String {
    let (fg, bg) = (parse_or_black(color), parse_or_black(background));
    let blend = |f: f64, b: f64| byte(f * fg.alpha + b * (1.0 - fg.alpha));
    format!("#{}{}{}", blend(fg.r, bg.r), blend(fg.g, bg.g), blend(fg.b, bg.b))
}

/// WCAG relative luminance; alpha is ignored.
pub fn luminance(hex: &str) -> f64 {
    let Rgb { r, g, b, .. } = parse_or_black(hex);
    0.2126 * to_linear(r) + 0.7152 * to_linear(g) + 0.0722 * to_linear(b)
}

pub fn contrast_ratio(a: &str, b: &str) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// `color` with its OKLCH lightness moved toward `toward`'s only as far as it takes to reach `ratio` against every
/// background (`readableOn`).
pub fn readable_on(color: &str, toward: &str, backgrounds: &[String], ratio: f64) -> String {
    let worst = |c: &str| backgrounds.iter().map(|bg| contrast_ratio(c, bg)).fold(f64::INFINITY, f64::min);
    if worst(color) >= ratio {
        return color.to_string();
    }
    let from = hex_to_oklch(&color[..7]);
    let target = hex_to_oklch(&toward[..7]).l;
    let at = |t: f64| oklch_to_hex(from.l + (target - from.l) * t, from.c, from.h, 1.0);
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..16 {
        let t = (lo + hi) / 2.0;
        if worst(&at(t)) >= ratio {
            hi = t;
        } else {
            lo = t;
        }
    }
    let result = at(hi);
    if worst(&result) >= ratio { result } else { toward.to_string() }
}

/// The better of white and `page` as text on `background`.
pub fn on_color(background: &str, page: &str) -> String {
    if contrast_ratio("#ffffff", background) >= contrast_ratio(page, background) { "#ffffff".to_string() } else { page.to_string() }
}

/// HSV (hue 0..360, saturation and value 0..1) of a `#rrggbb` colour, for the colour picker.
pub fn hex_to_hsv(hex: &str) -> (f64, f64, f64) {
    let Rgb { r, g, b, .. } = parse_or_black(hex);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (if h < 0.0 { h + 360.0 } else { h }, if max == 0.0 { 0.0 } else { d / max }, max)
}

pub fn hsv_to_hex(h: f64, s: f64, v: f64) -> String {
    let c = v * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    format!("#{}{}{}", byte(r + m), byte(g + m), byte(b + m))
}
