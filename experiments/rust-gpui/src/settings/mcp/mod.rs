//! Settings › MCP servers (WP-43: `McpSettings.tsx`, `McpServerRow.tsx`, `McpServerSheet.tsx`,
//! `LocalMcpSettings.tsx`, `shared/mcp.ts`, `shared/local-mcp.ts`; G-14 and G-15).
//!
//! - `logic.rs`: the rules of `mcp.ts` (grouping checks into rows, summary lines, targets, validation, catalog).
//! - `host.rs`: the fixture standing in for the computer's `mcp:*` commands; `page.rs`: [`McpView`] (checks,
//!   switches, sign-in, Edit, Remove); `sheet.rs`: the Add and Edit sheet.
//! - `local_logic.rs`, `local.rs`: Milagre MCP (the local clients and custom connections) under the same page.
//! - `sections.rs`: the section bodies of MCP, Skills and Integrations that `settings/mod.rs` registers.
//!
//! Nothing talks to the daemon yet: every write goes to a fixture host and is followed by a re-check, as
//! `mcp:changed` makes the desktop do. Not built: the services' Simple Icons glyphs in the catalog (the tile
//! shows the initial), and the computer page's remote variant (`remote`, URL servers only), which WP-44 hosts.

pub mod host;
pub mod local;
pub mod local_logic;
pub mod logic;
pub mod page;
pub mod sections;
pub mod sheet;

#[cfg(test)]
pub(crate) mod tests;

use gpui::{App, Window};

pub use local::LocalMcpView;
pub use page::McpView;
pub use sections::{ToolSections, section_body};

/// `cx.listener` gives a closure over the event it was built for; a checkbox's toggle hands `bool`. This adapts
/// the one to the other.
pub(crate) trait Adapt {
    fn adapt(self) -> ToggleFn;
}

/// What a checkbox's `on_toggle` takes.
pub(crate) type ToggleFn = Box<dyn Fn(bool, &mut Window, &mut App)>;

impl<F> Adapt for F
where
    F: Fn(&bool, &mut Window, &mut App) + 'static,
{
    fn adapt(self) -> ToggleFn {
        Box::new(move |on, window, cx| self(&on, window, cx))
    }
}

/// A 16px radio: an `ink-3` ring at rest, an ink fill with an 8px `on-ink` dot when picked (DESIGN.md "States":
/// selection is ink). For rows that carry more than a label, which the `RadioGroup` primitive does not draw.
pub(crate) fn radio_dot(picked: bool, theme: &crate::theme::Theme) -> gpui::AnyElement {
    use gpui::{IntoElement as _, ParentElement as _, Styled as _, div, prelude::*, px};
    div()
        .size(px(16.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(if picked { theme.ink } else { theme.ink3 })
        .when(picked, |d| d.bg(theme.ink))
        .when(picked, |d| d.child(div().size(px(8.0)).rounded_full().bg(theme.on_ink)))
        .into_any_element()
}
