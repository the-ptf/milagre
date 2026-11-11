//! Milagre's design tokens for GPUI: colours, type, radii, sizes. The values are DESIGN.md's tables.
//!
//! - `colors.rs`: [`Theme`] (Milagre Blue, `dark()` and `light()`), the colour tokens as a GPUI global.
//! - `typography.rs`: font families, the desktop type scale ([`TextStep`]), the Chat text size.
//! - `metrics.rs`: radii, control heights, the 44px header.
//! - `elevation.rs`: shadow tokens as GPUI box shadows (`theme.shadow_btn()`).
//!
//! Views read the active theme through [`ActiveTheme::theme`] on any GPUI context, and import tokens from
//! `crate::theme` directly (everything is re-exported here):
//!
//! ```ignore
//! use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_13, TextStepExt};
//! let theme = cx.theme();
//! div().bg(theme.canvas).text_color(theme.ink3).rounded(RADIUS_CONTROL).text_step(TEXT_13)
//! ```
//!
//! Never write a hex colour or a raw size in a view: add the token here (with its DESIGN.md row) instead.

mod colors;
mod elevation;
mod metrics;
mod typography;

pub use colors::*;
pub use metrics::*;
pub use typography::*;

#[cfg(test)]
mod tests;
