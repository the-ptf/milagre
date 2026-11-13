//! The pairing QR code (`<img data-phone-qr>` in `DevicesSettings`, 176px, `rounded-card bg-paper`).
//!
//! The host draws the real code (an SVG of the pairing link). This port has no `qrcode` crate and pairs nothing, so the
//! page shows a fixture: a 29 by 29 module matrix with the three finder squares, the timing lines and an alignment
//! square a scanner looks for, and data modules derived from the link so a new link looks different. It is not a valid
//! code and says nothing; swapping in the `qrcode` crate changes [`matrix`] only.

use gpui::{Bounds, IntoElement, ParentElement, Styled, canvas, div, fill, point, px, rgb, size};

use crate::theme::RADIUS_CARD;

/// Modules per side (a version 3 symbol).
pub const MODULES: usize = 29;
/// Quiet zone, in modules, on each side.
const QUIET: usize = 2;
/// The paper and the ink of a printed code: the same in both themes, so a phone camera can read it.
const PAPER: u32 = 0xFFFFFF;
const INK: u32 = 0x111111;

fn finder(x: usize, y: usize, ox: usize, oy: usize) -> Option<bool> {
    let (dx, dy) = (x.checked_sub(ox)?, y.checked_sub(oy)?);
    if dx > 6 || dy > 6 {
        return None;
    }
    let ring = dx == 0 || dx == 6 || dy == 0 || dy == 6;
    let core = (2..=4).contains(&dx) && (2..=4).contains(&dy);
    Some(ring || core)
}

/// The module matrix for a pairing link: `true` is dark.
pub fn matrix(seed: &str) -> Vec<Vec<bool>> {
    // FNV-1a over the link, then xorshift for the data modules.
    let mut state: u64 = 0xcbf29ce484222325;
    for byte in seed.bytes() {
        state = (state ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let last = MODULES - 7;
    let mut rows = vec![vec![false; MODULES]; MODULES];
    for (y, row) in rows.iter_mut().enumerate() {
        for (x, cell) in row.iter_mut().enumerate() {
            let in_finder_zone = (x < 8 && y < 8) || (x >= MODULES - 8 && y < 8) || (x < 8 && y >= MODULES - 8);
            *cell = if let Some(dark) = finder(x, y, 0, 0).or_else(|| finder(x, y, last, 0)).or_else(|| finder(x, y, 0, last)) {
                dark
            } else if in_finder_zone {
                false
            } else if y == 6 {
                x % 2 == 0
            } else if x == 6 {
                y % 2 == 0
            } else if (MODULES - 9..=MODULES - 5).contains(&x) && (MODULES - 9..=MODULES - 5).contains(&y) {
                // Alignment square: a dark ring, a light ring, a dark centre.
                let (dx, dy) = (x.abs_diff(MODULES - 7), y.abs_diff(MODULES - 7));
                dx.max(dy) != 1
            } else {
                next() & 1 == 1
            };
        }
    }
    rows
}

/// The code at `side` pixels square.
pub fn qr_code(seed: &str, side: f32) -> impl IntoElement {
    let rows = matrix(seed);
    div().size(px(side)).flex_none().rounded(RADIUS_CARD).overflow_hidden().child(
        canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                window.paint_quad(fill(bounds, rgb(PAPER)));
                let cell = bounds.size.width / (MODULES + 2 * QUIET) as f32;
                for (y, row) in rows.iter().enumerate() {
                    let mut x = 0;
                    while x < MODULES {
                        if !row[x] {
                            x += 1;
                            continue;
                        }
                        let start = x;
                        while x < MODULES && row[x] {
                            x += 1;
                        }
                        let origin = point(bounds.origin.x + cell * (start + QUIET) as f32, bounds.origin.y + cell * (y + QUIET) as f32);
                        window.paint_quad(fill(Bounds { origin, size: size(cell * (x - start) as f32, cell) }, rgb(INK)));
                    }
                }
            },
        )
        .size_full(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_matrix_has_finders_timing_and_follows_the_link() {
        let m = matrix("https://relay.milagre.cloud/pair#k=a");
        assert_eq!(m.len(), MODULES);
        assert!(m.iter().all(|row| row.len() == MODULES));
        // The three finder squares: dark ring, light gap, dark core.
        for (ox, oy) in [(0, 0), (MODULES - 7, 0), (0, MODULES - 7)] {
            assert!(m[oy][ox] && m[oy][ox + 6] && m[oy + 6][ox]);
            assert!(!m[oy + 1][ox + 1] && m[oy + 3][ox + 3]);
        }
        // The timing line alternates.
        assert!(m[6][8] && !m[6][9] && m[6][10]);
        let other = matrix("https://relay.milagre.cloud/pair#k=b");
        assert_ne!(m, other, "a new link draws a different code");
        assert_eq!(m, matrix("https://relay.milagre.cloud/pair#k=a"), "and the same link the same one");
    }
}
