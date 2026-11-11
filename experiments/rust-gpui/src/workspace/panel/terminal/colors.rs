//! The Terminal's colours: the theme's 16 ANSI colours, the xterm 256-colour cube and grey ramp, and how a cell's
//! attributes (bold, dim, inverse, hidden) turn its foreground and background into what is painted.
//!
//! The ANSI table is Milagre Blue's (`packages/shared/src/themes/palettes/milagre.ts`, shared with Gray): GitHub's
//! terminal colours, one table per scheme. Foreground is `ink`, the cursor is `ink` with `surface` under it, the
//! selection is `accent` at 30% (`build.ts`), and the background is transparent over the panel's `surface`
//! (`terminal-sessions.ts` `terminalTheme`).

use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{Hsla, Rgba, rgb, rgba};

use crate::theme::{Appearance, Theme};

/// `lightAnsi` in `palettes/milagre.ts`: black, red, green, yellow, blue, magenta, cyan, white, then the bright row.
pub const LIGHT_ANSI: [u32; 16] = [
    0x24292f, 0xcf222e, 0x116329, 0x7d4e00, 0x0969da, 0x8250df, 0x1b7c83, 0x6e7781, 0x57606a, 0xa40e26, 0x1a7f37, 0x633c01, 0x218bff,
    0xa475f9, 0x3192aa, 0x8c959f,
];
/// `darkAnsi` in `palettes/milagre.ts`.
pub const DARK_ANSI: [u32; 16] = [
    0x484f58, 0xff7b72, 0x3fb950, 0xd29922, 0x58a6ff, 0xbc8cff, 0x39c5cf, 0xb1bac4, 0x6e7681, 0xffa198, 0x56d364, 0xe3b341, 0x79c0ff,
    0xd2a8ff, 0x56d4dd, 0xffffff,
];

/// How much a dim (SGR 2) foreground keeps of its colour.
const DIM_ALPHA: f32 = 0.5;

/// The colours one Terminal paints with, taken from the theme once per frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub ansi: [Rgba; 16],
    pub foreground: Rgba,
    /// What an inverse cell with the default background shows: the panel's surface.
    pub background: Rgba,
    pub cursor: Rgba,
    /// The glyph under a block cursor.
    pub cursor_accent: Rgba,
    pub selection: Rgba,
}

impl Palette {
    pub fn from_theme(theme: &Theme) -> Self {
        let table = match theme.appearance {
            Appearance::Dark => &DARK_ANSI,
            Appearance::Light => &LIGHT_ANSI,
        };
        let accent = theme.accent;
        Self {
            ansi: table.map(rgb),
            foreground: theme.ink,
            background: theme.surface,
            cursor: theme.ink,
            cursor_accent: theme.surface,
            selection: Rgba { a: 0.3, ..accent },
        }
    }

    /// A colour as the program named it: a theme colour, one it set with OSC 4/10/11 (`overrides`), a 256-colour
    /// index or a 24-bit value.
    pub fn resolve(&self, color: Color, overrides: &Colors) -> Rgba {
        match color {
            Color::Spec(Rgb { r, g, b }) => rgb(u32::from_be_bytes([0, r, g, b])),
            Color::Indexed(index) => self.indexed(index as usize, overrides),
            Color::Named(named) => self.named(named, overrides),
        }
    }

    fn indexed(&self, index: usize, overrides: &Colors) -> Rgba {
        if let Some(Rgb { r, g, b }) = overrides[index] {
            return rgb(u32::from_be_bytes([0, r, g, b]));
        }
        if index < 16 { self.ansi[index] } else { rgb(xterm_256(index as u8)) }
    }

    fn named(&self, named: NamedColor, overrides: &Colors) -> Rgba {
        let index = named as usize;
        if let Some(Rgb { r, g, b }) = overrides[index] {
            return rgb(u32::from_be_bytes([0, r, g, b]));
        }
        match named {
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimForeground => dim(self.foreground),
            // DimBlack .. DimWhite follow Cursor: the normal colour at half strength.
            _ if index >= NamedColor::DimBlack as usize && index <= NamedColor::DimWhite as usize => {
                dim(self.ansi[index - NamedColor::DimBlack as usize])
            }
            _ if index < 16 => self.ansi[index],
            _ => self.foreground,
        }
    }

    /// The foreground and (if not the default) background a cell paints, after its attributes.
    pub fn cell(&self, cell: &Cell, overrides: &Colors) -> CellColors {
        let flags = cell.flags;
        // xterm.js draws bold text in bright colours (`drawBoldTextInBrightColors`, on by default).
        let fg = match cell.fg {
            Color::Named(named) if flags.contains(Flags::BOLD) && (named as usize) < 8 => Color::Indexed(named as u8 + 8),
            Color::Indexed(index) if flags.contains(Flags::BOLD) && index < 8 => Color::Indexed(index + 8),
            other => other,
        };
        let mut fg = self.resolve(fg, overrides);
        let mut bg = match cell.bg {
            Color::Named(NamedColor::Background) => None,
            other => Some(self.resolve(other, overrides)),
        };
        if flags.contains(Flags::INVERSE) {
            let under = bg.unwrap_or(self.background);
            bg = Some(fg);
            fg = under;
        }
        if flags.contains(Flags::DIM) {
            fg = dim(fg);
        }
        if flags.contains(Flags::HIDDEN) {
            fg = rgba(0);
        }
        CellColors { fg: fg.into(), bg: bg.map(Into::into) }
    }
}

/// What one cell paints.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellColors {
    pub fg: Hsla,
    pub bg: Option<Hsla>,
}

fn dim(color: Rgba) -> Rgba {
    Rgba { a: color.a * DIM_ALPHA, ..color }
}

/// xterm's colours 16 to 255: a 6x6x6 cube (levels 0, 95, 135, 175, 215, 255), then 24 greys from 8 to 238.
pub fn xterm_256(index: u8) -> u32 {
    const LEVELS: [u32; 6] = [0, 95, 135, 175, 215, 255];
    match index {
        0..=15 => 0,
        16..=231 => {
            let i = u32::from(index - 16);
            (LEVELS[(i / 36) as usize] << 16) | (LEVELS[(i / 6 % 6) as usize] << 8) | LEVELS[(i % 6) as usize]
        }
        _ => {
            let grey = 8 + 10 * u32::from(index - 232);
            (grey << 16) | (grey << 8) | grey
        }
    }
}
