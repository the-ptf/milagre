//! The fonts Settings › Appearance offers as bundled, embedded in the binary and registered at startup, so a choice
//! applies without the font installed (the desktop ships the same families through fontsource: `app/src/fonts.css`).
//!
//! - Inter 4.1 (rsms/inter), Geist and Geist Mono 1.9.2 (vercel/geist-font), JetBrains Mono 2.304
//!   (JetBrains/JetBrainsMono), each under the SIL Open Font License 1.1; the licence texts are beside the files in
//!   `assets/fonts/<family>/OFL.txt`.
//! - Static instances, not the variable fonts the desktop loads: GPUI's text system picks a face by weight among the
//!   family's fonts and does not set a variable font's axes. The views use 400, 500, 600 and 700, and italic once
//!   (markdown emphasis), so each family ships those five faces.
//!
//! The system defaults (SF Pro for text, SF Mono for code, DESIGN.md "Type") are the system's own and are never
//! bundled: Apple's licence does not allow it.

use std::borrow::Cow;
use std::cell::Cell;

use gpui::App;

/// The families registered at startup, as Settings › Appearance names them.
pub const BUNDLED_FAMILIES: [&str; 4] = ["Inter", "Geist", "Geist Mono", "JetBrains Mono"];

macro_rules! faces {
    ($dir:literal, $stem:literal) => {
        [
            include_bytes!(concat!("../../assets/fonts/", $dir, "/", $stem, "-Regular.ttf")).as_slice(),
            include_bytes!(concat!("../../assets/fonts/", $dir, "/", $stem, "-Medium.ttf")).as_slice(),
            include_bytes!(concat!("../../assets/fonts/", $dir, "/", $stem, "-SemiBold.ttf")).as_slice(),
            include_bytes!(concat!("../../assets/fonts/", $dir, "/", $stem, "-Bold.ttf")).as_slice(),
            include_bytes!(concat!("../../assets/fonts/", $dir, "/", $stem, "-Italic.ttf")).as_slice(),
        ]
    };
}

/// Every embedded face: the five of each family in [`BUNDLED_FAMILIES`] order.
pub(crate) const FACES: [[&[u8]; 5]; 4] =
    [faces!("inter", "Inter"), faces!("geist", "Geist"), faces!("geist-mono", "GeistMono"), faces!("jetbrains-mono", "JetBrainsMono")];

/// The faces as the text system takes them (borrowed: the bytes live in the binary).
pub(crate) fn all_faces() -> Vec<Cow<'static, [u8]>> {
    FACES.iter().flatten().map(|bytes| Cow::Borrowed(*bytes)).collect()
}

/// Registers the bundled faces with the platform text system; called once from `app::init`, before the stored
/// Appearance choice is applied. A failure is logged and leaves the system fonts, as a missing font does on the desktop.
pub fn register(cx: &App) {
    match cx.text_system().add_fonts(all_faces()) {
        Ok(()) => REGISTERED.with(|registered| registered.set(true)),
        Err(error) => eprintln!("milagre-gpui: the bundled fonts did not load: {error:#}"),
    }
}

thread_local! {
    // Per thread, like `theme::live`: the UI thread owns the text system, and each headless test runs on its own.
    static REGISTERED: Cell<bool> = const { Cell::new(false) };
}

/// Whether a family ships with the app and [`register`] loaded it: the platform's font list does not include fonts
/// added from memory, so the Appearance probe asks here too.
pub fn is_bundled(family: &str) -> bool {
    REGISTERED.with(Cell::get) && BUNDLED_FAMILIES.contains(&family)
}

#[cfg(test)]
mod tests {
    use gpui::{FontStyle, FontWeight, PlatformTextSystem, font};

    use super::*;
    use crate::theme::{MONO, SANS};

    /// The real macOS text system (CoreText), not the test platform's fixed-advance stand-in.
    fn text_system() -> gpui_apple::AppleTextSystem {
        gpui_apple::AppleTextSystem::new()
    }

    #[test]
    fn every_bundled_family_resolves_to_its_own_faces() {
        let text = text_system();
        text.add_fonts(all_faces()).expect("the embedded fonts load");
        for (family, faces) in BUNDLED_FAMILIES.iter().zip(FACES) {
            assert_eq!(faces.len(), 5, "{family}");
            let weights = [FontWeight::NORMAL, FontWeight::MEDIUM, FontWeight::SEMIBOLD, FontWeight::BOLD];
            let ids: Vec<_> =
                weights.iter().map(|weight| text.font_id(&gpui::Font { weight: *weight, ..font(*family) }).expect("resolves")).collect();
            for (i, a) in ids.iter().enumerate() {
                for b in &ids[i + 1..] {
                    assert_ne!(a, b, "{family}: each weight is its own face");
                }
            }
            let italic = text.font_id(&gpui::Font { style: FontStyle::Italic, ..font(*family) }).expect("resolves");
            assert!(!ids.contains(&italic), "{family}: italic is its own face");
            // The upright face is ours, not a fallback: Inter is drawn on a 2048 grid, the others on 1000.
            let units = text.font_metrics(ids[0]).units_per_em;
            assert_eq!(units, if *family == "Inter" { 2048 } else { 1000 }, "{family}");
        }
    }

    #[test]
    fn the_mono_families_are_monospaced_and_the_defaults_resolve() {
        let text = text_system();
        text.add_fonts(all_faces()).expect("the embedded fonts load");
        let advance = |family: &str, ch: char| {
            let id = text.font_id(&font(family.to_string())).expect("resolves");
            let glyph = text.glyph_for_char(id, ch).expect("has the glyph");
            text.advance(id, glyph).expect("advance").width
        };
        // DESIGN.md's defaults, what CSS `ui-monospace` and `system-ui` give the desktop: SF Mono and SF Pro.
        for family in ["Geist Mono", "JetBrains Mono", MONO] {
            assert_eq!(advance(family, 'm'), advance(family, 'i'), "{family} is monospaced");
        }
        assert_ne!(advance(SANS, 'm'), advance(SANS, 'i'), "SF Pro is proportional");
        assert!(text.font_id(&font(MONO)).is_ok());
    }

    #[test]
    fn a_bundled_family_counts_as_installed_once_registered() {
        assert!(!is_bundled("Inter"));
        REGISTERED.with(|registered| registered.set(true));
        assert!(BUNDLED_FAMILIES.iter().all(|family| is_bundled(family)));
        assert!(!is_bundled("Fira Code"));
    }
}
