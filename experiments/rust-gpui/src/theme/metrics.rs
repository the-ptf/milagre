//! Radii, control heights and window chrome sizes (DESIGN.md "Radius: desktop" and "Sizes").
//!
//! Heights are fixed, never derived from padding. Spacing is Tailwind's 4px grid, which GPUI's `p_1`,
//! `gap_2`, ... already are (`gap_1` is 4, `p_3` is 12); use `px(...)` only for the 2, 6 and 10 the
//! design allows in dense rows and 28px controls.

use gpui::{Pixels, px};

/// Code, kbd, menu items.
pub const RADIUS_INLINE: Pixels = px(4.0);
/// Chips, tooltips; a 20 or 24px project tile.
pub const RADIUS_CHIP: Pixels = px(6.0);
/// Buttons, inputs, menus, option rows.
pub const RADIUS_CONTROL: Pixels = px(8.0);
/// Cards, popovers, toasts.
pub const RADIUS_CARD: Pixels = px(10.0);
/// Dialogs, the composer, panels, Settings.
pub const RADIUS_WINDOW: Pixels = px(14.0);

/// Icon and extra-small buttons; the hit-area floor.
pub const CONTROL_XS: Pixels = px(24.0);
/// Small: composer chips, tabs, approval buttons.
pub const CONTROL_SM: Pixels = px(28.0);
/// Default: buttons, selects, rows.
pub const CONTROL_MD: Pixels = px(32.0);
/// Inputs.
pub const CONTROL_LG: Pixels = px(36.0);
/// Two-line list rows.
pub const ROW_TWO_LINE: Pixels = px(48.0);

/// Height of every column header (sidebar header with the traffic lights, Chat header, panel tab strip).
pub const HEADER_HEIGHT: Pixels = px(44.0);

/// The width of every hairline between columns and under headers (and the Details panel's section dividers).
/// The no-dividers experiment sets it to 0: nothing draws and the Details sections get a vertical gap instead.
/// Set it back to `px(1.0)` to bring every hairline back.
pub const HAIRLINE: Pixels = px(0.0);

/// A project tile's corner radius for its size (DESIGN.md "Radius": `projectAvatarRadius`):
/// 16 → 4, 20 and 24 → 6, 32 and 40 → 10, 72 → 20.
pub fn project_avatar_radius(size: f32) -> Pixels {
    match size {
        s if s <= 16.0 => px(4.0),
        s if s <= 24.0 => px(6.0),
        s if s <= 40.0 => px(10.0),
        _ => px(20.0),
    }
}
