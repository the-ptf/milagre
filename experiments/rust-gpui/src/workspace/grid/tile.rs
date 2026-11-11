//! A tile's frame and header (`ChatTile`), the drop overlay (`GridDropOverlay`), the split tile's menu
//! (`TileFamilyMenu.tsx`) and the corner's grid and Subchats buttons (`LayoutToggle`, `SubchatsButton`).

use gpui::{AnyElement, App, ClickEvent, Context, ElementId, FontWeight, MouseDownEvent, Pixels, SharedString, div, prelude::*, px};

use super::{ChatGrid, GridDropTarget, TileInfo};
use crate::logic::marks::chat_mark::{ChatMark, chat_mark_tone};
use crate::logic::marks::tone::Tone;
use crate::theme::{
    ActiveTheme, HEADER_HEIGHT, RADIUS_CARD, RADIUS_CONTROL, RADIUS_INLINE, RADIUS_WINDOW, TEXT_10, TEXT_12, TEXT_13, TextStepExt, Theme,
};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, Tooltip};
use crate::workspace::chat::pills::bookmark::family_menu;
use crate::workspace::chrome::NoDrag;
use crate::workspace::shell::top_bar::{BUTTON, CORNER_RIGHT, GAP};

/// A tile header's height (`h-9`).
pub const TILE_HEADER: f32 = 36.0;
/// The tile menu's width (`width={288}`).
const MENU_WIDTH: f32 = 288.0;

/// Which of a header's controls show.
#[derive(Clone, Copy, Debug)]
pub(super) struct Controls {
    pub split: bool,
    pub pinned: bool,
    pub menu_open: bool,
    /// A split tile's title opens its menu.
    pub has_menu_rows: bool,
}

fn tone_color(tone: Tone, theme: &Theme) -> gpui::Rgba {
    match tone {
        Tone::Accent => theme.accent,
        Tone::Green => theme.green,
        Tone::Orange => theme.orange,
        Tone::Red => theme.red,
        Tone::Ink3 => theme.ink3,
        Tone::Ink4 => theme.ink4,
    }
}

/// The header's live dot: the mark's tone, nothing for an idle Chat. (A static dot: an animated mark needs a view of
/// its own, CONVENTIONS.md, and the tile header re-renders with the grid.)
fn mark_dot(mark: ChatMark, theme: &Theme) -> AnyElement {
    if mark == ChatMark::Idle {
        return div().into_any_element();
    }
    div().flex_none().size(px(8.0)).mx(px(2.0)).rounded_full().bg(tone_color(chat_mark_tone(mark), theme)).into_any_element()
}

fn key_id(prefix: &str, key: &str) -> ElementId {
    ElementId::from(SharedString::from(format!("{prefix}-{key}")))
}

/// One tile: its header over its body (the focused Chat's column, or another Chat's transcript).
pub(super) fn frame(
    info: &TileInfo,
    focused: bool,
    controls: Controls,
    body: AnyElement,
    measure: impl IntoElement,
    cx: &mut Context<ChatGrid>,
) -> AnyElement {
    let theme = *cx.theme();
    let key = info.key.clone();
    let needs_you = info.needs_you() && !focused;
    let border = if focused {
        theme.line_strong
    } else if needs_you {
        theme.orange
    } else {
        theme.line
    };
    let selector = format!("chat-tile-{key}");
    let title: AnyElement = if controls.split && controls.has_menu_rows {
        let key = key.clone();
        div()
            .id(key_id("tile-menu", &key))
            .debug_selector({
                let selector = format!("tile-menu-{key}");
                move || selector.clone()
            })
            .flex()
            .min_w_0()
            .items_center()
            .gap_1()
            .px_1()
            .rounded(RADIUS_INLINE)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.ink)
            .when(controls.menu_open, |el| el.bg(theme.hover))
            .hover(move |style| style.bg(theme.hover))
            .child(div().min_w_0().truncate().child(info.title.clone()))
            .child(Icon::new(IconName::UnfoldMore).size(IconSize::S12).color(theme.ink3))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                cx.stop_propagation();
                this.toggle_menu(&key, cx);
            }))
            .into_any_element()
    } else {
        div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(info.title.clone()).into_any_element()
    };
    let button = |id: &str,
                  icon: IconName,
                  label: &'static str,
                  pressed: bool,
                  handler: fn(&mut ChatGrid, &str, &mut Context<ChatGrid>),
                  cx: &mut Context<ChatGrid>| {
        let key = info.key.clone();
        let listener = cx.listener(move |this, _: &ClickEvent, _, cx| {
            cx.stop_propagation();
            handler(this, &key, cx);
        });
        div()
            .id(key_id(&format!("tip-{id}"), &info.key))
            .flex_none()
            .tooltip(Tooltip::new(label).build())
            .child(
                div()
                    .debug_selector({
                        let selector = format!("{id}-{}", info.key);
                        move || selector.clone()
                    })
                    .child(
                        IconButton::new(key_id(id, &info.key), icon)
                            .size(IconButtonSize::S24)
                            .pressed(pressed)
                            .on_click(move |event, window, cx| listener(event, window, cx)),
                    ),
            )
            .into_any_element()
    };
    let draft = super::logic::is_draft_tile_key(&key);
    let mut trailing: Vec<AnyElement> = Vec::new();
    if needs_you {
        trailing.push(div().flex_none().font_weight(FontWeight::MEDIUM).text_color(theme.orange_ink).child("Needs you").into_any_element());
    }
    if controls.split {
        trailing.push(button("tile-close", IconName::Cancel01, "Close", false, |this, key, cx| this.close_tile(key, cx), cx));
    } else {
        if !draft {
            let (icon, label) = if controls.pinned { (IconName::PinOff, "Remove from grid") } else { (IconName::Pin, "Keep in grid") };
            trailing.push(button("tile-pin", icon, label, controls.pinned, |this, key, cx| this.toggle_pin(key, cx), cx));
        }
        // Mark read: in the fixture this only takes the tile away (its row's mark stays until the data layer says).
        if info.mark == ChatMark::Unread && !focused {
            trailing.push(button("tile-dismiss", IconName::Cancel01, "Mark read", false, |this, key, cx| this.dismiss(key, cx), cx));
        }
    }
    let header = div()
        .flex()
        .flex_none()
        .items_center()
        .gap_1()
        .h(px(TILE_HEADER))
        .px_3()
        .border_b_1()
        .border_color(theme.line)
        .text_step(TEXT_13)
        .child(mark_dot(info.mark, &theme))
        .child(title)
        .child(div().flex_1().min_w_0().truncate().text_color(theme.ink3).child(info.detail.clone()))
        .children(trailing);
    let focus_key = key.clone();
    div()
        .id(key_id("chat-tile", &key))
        .debug_selector(move || selector.clone())
        .relative()
        .flex_1()
        .min_w_0()
        .min_h(px(super::TILE_MIN_HEIGHT))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(RADIUS_WINDOW)
        .border_1()
        .border_color(border)
        .bg(theme.surface)
        .when(!focused && !needs_you, |el| el.hover(move |style| style.border_color(theme.line_strong)))
        .when(!focused, |el| el.cursor_pointer().on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.focus_tile(&focus_key, cx))))
        .child(measure)
        .child(header)
        .child(div().relative().flex().flex_col().flex_1().min_h_0().child(body))
        .into_any_element()
}

/// Where a Chat dragged out of the sidebar would land: the half it takes, the edge it goes in at and what the drop
/// does. Drawn in window coordinates over the grid.
pub(super) fn drop_overlay(target: &GridDropTarget, theme: &Theme) -> AnyElement {
    let (area, bar) = (target.area, target.bar);
    gpui::deferred(
        div()
            .debug_selector(|| "grid-drop".into())
            .absolute()
            .left(px(0.0))
            .top(px(0.0))
            .size_full()
            .child(
                div()
                    .absolute()
                    .left(px(area.left))
                    .top(px(area.top))
                    .w(px(area.width))
                    .h(px(area.height))
                    .rounded(RADIUS_WINDOW)
                    .bg(theme.accent_tint),
            )
            .child(div().absolute().left(px(bar.left)).top(px(bar.top)).w(px(4.0)).h(px(bar.height)).rounded_full().bg(theme.accent))
            .child(
                div()
                    .absolute()
                    .left(px(area.left + 12.0))
                    .top(px(area.top + area.height - 40.0))
                    .px(px(10.0))
                    .py_1()
                    .rounded_full()
                    .bg(theme.accent_ink)
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.on_accent)
                    .whitespace_nowrap()
                    .child(target.label()),
            ),
    )
    .with_priority(2)
    .into_any_element()
}

/// The split tile's menu: "Open alone" first, then the Chats of its family that aren't on screen, with their states
/// in words; picking one replaces this tile. `None` when the tile's Chat is gone.
pub(super) fn tile_menu(grid: &ChatGrid, tile: &str, tiles: &[String], theme: &Theme, cx: &mut Context<ChatGrid>) -> Option<AnyElement> {
    let theme = *theme;
    tiles.iter().position(|key| key == tile)?;
    let painted = grid.painted.borrow().tiles.iter().find(|(key, _)| key == tile).map(|(_, bounds)| *bounds);
    let pane = grid.painted.borrow().pane;
    // Under the tile's title, in the grid's own coordinates; before the first paint, under the first row.
    let (left, top): (Pixels, Pixels) = match painted {
        Some(bounds) => (bounds.origin.x - pane.origin.x + px(8.0), bounds.origin.y - pane.origin.y + px(TILE_HEADER)),
        None => (px(super::GRID_INSET + 8.0), HEADER_HEIGHT + px(TILE_HEADER)),
    };
    let rows = family_menu(&grid.family, tile)
        .map(|menu| menu.ancestors.into_iter().chain(menu.subchats).filter(|entry| !tiles.contains(&entry.key)).collect::<Vec<_>>())
        .unwrap_or_default();
    let open_alone = {
        let tile = tile.to_string();
        menu_row("tile-open-alone", IconName::ArrowExpand01, "Open alone".into(), None, &theme)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open_alone(&tile, cx)))
    };
    Some(
        gpui::deferred(
            div()
                .id("tile-family-menu")
                .debug_selector(|| "tile-family-menu".into())
                .absolute()
                .left(left)
                .top(top)
                .w(px(MENU_WIDTH))
                .p_1()
                .flex()
                .flex_col()
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .occlude()
                .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, _, cx| this.close_menu(cx)))
                .child(open_alone)
                .when(!rows.is_empty(), |el| el.child(div().my_1().h(px(1.0)).bg(theme.line)))
                .children(rows.into_iter().map(|entry| {
                    let (tile, next) = (tile.to_string(), entry.key.clone());
                    let word = match entry.role {
                        Some(role) => format!("{role} \u{b7} {}", entry.word),
                        None => entry.word.to_string(),
                    };
                    menu_row(&format!("tile-family-{}", entry.key), IconName::BubbleChat, entry.title.into(), Some(word), &theme)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.swap(&tile, &next, cx)))
                })),
        )
        .with_priority(1)
        .into_any_element(),
    )
}

fn menu_row(id: &str, icon: IconName, title: SharedString, detail: Option<String>, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let theme = *theme;
    let selector = id.to_string();
    div()
        .id(ElementId::from(SharedString::from(id.to_string())))
        .debug_selector(move || selector.clone())
        .flex()
        .items_center()
        .gap_2()
        .h(px(32.0))
        .px_2()
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_13)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover))
        .child(Icon::new(icon).size(IconSize::S14).color(theme.ink2))
        .child(div().flex_1().min_w_0().truncate().text_color(theme.ink).child(title))
        .children(detail.map(|detail| div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(detail)))
}

impl ChatGrid {
    /// Mark read from an unfocused tile: the tile goes (the fixture has no read state to write).
    pub fn dismiss(&mut self, key: &str, cx: &mut Context<Self>) {
        self.active.retain(|item| item != key);
        self.grid_tiles.retain(|item| item != key);
        if let Some(info) = self.info.get_mut(key) {
            info.mark = ChatMark::Idle;
        }
        cx.notify();
    }
}

/// How many buttons the corner's grid controls add left of the panel toggles (`LayoutToggle`, `SubchatsButton`).
pub fn corner_count(grid: &ChatGrid) -> usize {
    1 + usize::from(grid.focused_family().is_some())
}

/// The grid button and, on a Chat with Subchats, the Subchats button with its count, left of `offset` corner toggles.
pub fn corner_buttons(grid: &gpui::Entity<ChatGrid>, offset: usize, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let (grid_on, family, shown) = {
        let g = grid.read(cx);
        (g.layout() == super::ChatLayout::Grid, g.focused_family().map(|(_, children)| children.len()), g.family_shown())
    };
    let right = CORNER_RIGHT + offset as f32 * (BUTTON + GAP);
    let toggle = {
        let grid = grid.clone();
        div()
            .id("tip-layout-toggle")
            .tooltip(Tooltip::new(if grid_on { "Show one Chat" } else { "Show active Chats as a grid" }).shortcut(shortcut()).build())
            .child(
                div().debug_selector(|| "layout-toggle".into()).child(
                    IconButton::new("layout-toggle", IconName::GridView)
                        .size(IconButtonSize::S32)
                        .glyph(IconSize::S16)
                        .pressed(grid_on)
                        .on_click(move |_, _, cx| grid.update(cx, |grid, cx| grid.toggle_grid(cx))),
                ),
            )
    };
    let subchats = family.map(|count| {
        let grid = grid.clone();
        let label = if shown {
            "Back to the open Chat".to_string()
        } else {
            format!("Show the {count} subchat{} side by side", if count == 1 { "" } else { "s" })
        };
        div()
            .id("tip-subchats-toggle")
            .relative()
            .tooltip(Tooltip::new(label).build())
            .child(
                div().debug_selector(|| "subchats-toggle".into()).child(
                    IconButton::new("subchats-toggle", IconName::HierarchySquare02)
                        .size(IconButtonSize::S32)
                        .glyph(IconSize::S16)
                        .pressed(shown)
                        .on_click(move |_, _, cx| grid.update(cx, |grid, cx| grid.toggle_family(cx))),
                ),
            )
            .child(
                div()
                    .absolute()
                    .top(px(-2.0))
                    .right(px(-2.0))
                    .h(px(16.0))
                    .min_w(px(16.0))
                    .px_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(theme.accent)
                    .text_step(TEXT_10)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.on_accent)
                    .child(count.to_string()),
            )
    });
    div()
        .id("grid-corner")
        .debug_selector(|| "grid-corner".into())
        .absolute()
        .top((HEADER_HEIGHT - px(BUTTON)) / 2.0)
        .right(px(right))
        .flex()
        .flex_row_reverse()
        .items_center()
        .gap(px(GAP))
        .occlude()
        .no_drag()
        .child(toggle)
        .children(subchats)
        .into_any_element()
}

/// ⌘⇧M's label for the grid button's tooltip.
fn shortcut() -> SharedString {
    use crate::logic::keybindings::rules::primary_key_for;
    use crate::logic::keybindings::{default_keybindings, key_label_for};
    let rules = default_keybindings();
    primary_key_for(&rules, "grid.toggle", None).and_then(|key| key_label_for(key, cfg!(target_os = "macos"))).unwrap_or_default().into()
}
