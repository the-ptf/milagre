//! `milagre://` links opened on this computer (the bundle registers the scheme, `CFBundleURLTypes`). Electron's desktop
//! registers no scheme: the one `milagre://` link Milagre makes is a computer's pairing link (`milagre://pair?…`,
//! `mobile-pairing.cjs`), which Electron takes in its Add computer dialog (`computers:add [link, {}]`). The Preview
//! routes it the same way while it shows paired computers (the daemon's computer vault unlocked, [`crate::computers`]);
//! otherwise, and for any other link, the sidebar says what to do instead. Nothing is sent in read-only mode.

use std::sync::Mutex;

static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The platform's open-URLs callback (`Application::on_open_urls`): kept until the window takes them.
pub fn push(urls: Vec<String>) {
    if let Ok(mut opened) = OPENED.lock() {
        opened.extend(urls.into_iter().filter(|url| url.len() <= 8192));
    }
}

/// The links opened since the last call.
pub fn take() -> Vec<String> {
    OPENED.lock().map(|mut opened| std::mem::take(&mut *opened)).unwrap_or_default()
}

/// What a link asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// A computer's pairing link (`milagre://pair?…`), whole.
    Pair(String),
    /// Anything else: why it isn't opened.
    Unknown(String),
}

pub fn route(url: &str) -> Route {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("milagre://pair?") || lower.starts_with("milagre://pair/?") {
        Route::Pair(url.to_owned())
    } else if lower.starts_with("milagre://") {
        Route::Unknown("This preview opens Milagre's pairing links only.".into())
    } else {
        Route::Unknown("Not a Milagre link.".into())
    }
}

/// What the sidebar says about a pairing link the Preview can't take.
pub const PAIR_IN_MILAGRE: &str =
    "Pair this computer in Milagre: this preview adds computers only while Milagre's computer vault is unlocked.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_links_route_to_add_computer_and_nothing_else_does() {
        let link = "milagre://pair?relay=https%3A%2F%2Frelay.milagre.cloud&host=h&key=k&token=t&name=Studio";
        assert_eq!(route(link), Route::Pair(link.to_owned()));
        assert!(matches!(route("milagre://chat/1"), Route::Unknown(_)));
        assert!(matches!(route("https://milagre.cloud"), Route::Unknown(_)));
    }
}
