//! Preview mode: the window runs on a real Chat runtime that serves only part of what the fixture shows.
//!
//! A live data layer sets [`PreviewMode`] before it opens the window. Then nothing the runtime does not back may look
//! real: the side panel (Details, PR, Changes, diff, Designs, Artifact, Browser, Simulator), Routines, Settings and the
//! notices are not shown; the sidebar's menus keep only Mark as unread and its Done, Pin, Rename and drag do nothing;
//! the usage block gives way to a line naming the fixed account and model and what is not available; the Terminal
//! drawer is labelled as this computer's local shell. The fixture app never sets it.

use gpui::{App, Global, SharedString};

pub const UNAVAILABLE: &str = "Not available in this preview";
pub const LOCAL_SHELL: &str = "local shell (this computer, not the runtime)";

#[derive(Clone, Debug)]
pub struct PreviewMode {
    /// The signed-in account the runtime was created with (its label).
    pub account: SharedString,
    /// The model fixed for this runtime.
    pub model: SharedString,
}

impl Global for PreviewMode {}

pub fn is_on(cx: &App) -> bool {
    cx.has_global::<PreviewMode>()
}

pub fn get(cx: &App) -> Option<&PreviewMode> {
    cx.try_global::<PreviewMode>()
}
