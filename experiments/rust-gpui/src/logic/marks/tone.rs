//! The palette keys the shared logic names a fill by (`"orange"`, `"ink4"`). A view maps each to a `Theme` colour.

/// A key of the colour palette, as `chatMarkTone` and `presenceTone` return them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tone {
    Accent,
    Green,
    Orange,
    Red,
    Ink3,
    Ink4,
}

impl Tone {
    /// The key the TypeScript uses.
    pub fn key(self) -> &'static str {
        match self {
            Tone::Accent => "accent",
            Tone::Green => "green",
            Tone::Orange => "orange",
            Tone::Red => "red",
            Tone::Ink3 => "ink3",
            Tone::Ink4 => "ink4",
        }
    }
}
