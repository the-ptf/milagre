//! Overlays: the dialogs, sheets and menus that open over the window (WP-08's layer). Each lives in its own folder
//! and opens through [`crate::ui::Dialog`] or [`crate::ui::Popover`].

pub mod dialogs;

use gpui::actions;

actions!(milagre_overlays, [OpenGitActions]);
