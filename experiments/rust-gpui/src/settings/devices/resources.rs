//! The memory and disk rows (`ComputerResourceList` in `settings/ComputerResources.tsx`): a computer's name with two
//! gauges, a chevron, and under it, when open, what Milagre uses (`BREAKDOWN_TITLE`) with Clean up worktrees.

use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, div, prelude::*, px, relative,
};

use super::cleanup;
use super::logic::{Gauge, GaugeKind, MEASURING_TOOLTIP, UNREADABLE, part_opacity, resource_gauges};
use super::model::DevicesStore;
use super::view::DevicesView;
use crate::settings::group::slug;
use crate::theme::{ActiveTheme, RADIUS_INLINE, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, Tooltip};

/// One computer on the page: `detail` is its second line (This Mac, its route, or Offline).
#[derive(Clone, Debug, PartialEq)]
pub struct ResourceRow {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub online: bool,
    /// "Seen 2h ago", for an offline computer.
    pub seen: Option<String>,
}

fn is_desktop(name: &str) -> bool {
    let name = name.to_lowercase();
    ["studio", "mini", "imac"].iter().any(|word| name.contains(word))
}

/// Opacity of a theme colour (a part's slice of the accent).
fn faded(color: gpui::Rgba, opacity: f32) -> Hsla {
    Hsla::from(color).opacity(opacity)
}

fn bar(gauge: &Gauge, open: bool, theme: &crate::theme::Theme) -> AnyElement {
    let shares = gauge.shares;
    let mut track = div().flex().h(px(4.0)).w_full().gap(px(1.0)).overflow_hidden().rounded_full().bg(theme.inset);
    if open && !gauge.parts.is_empty() {
        for (index, part) in gauge.parts.iter().enumerate() {
            track = track.child(div().h_full().w(relative(part.share as f32)).bg(faded(theme.accent, part_opacity(index))));
        }
    } else {
        track = track.child(div().h_full().rounded_full().w(relative(shares.milagre as f32)).bg(theme.accent));
    }
    track =
        track.child(div().h_full().rounded_full().w(relative(shares.other as f32)).bg(if gauge.low { theme.orange } else { theme.ink4 }));
    let kind = if gauge.kind == GaugeKind::Memory { "memory" } else { "disk" };
    div()
        .id(SharedString::from(format!("resource-bar-{kind}")))
        .debug_selector(move || format!("resource-bar-{kind}"))
        .w_full()
        .tooltip(Tooltip::text(gauge.tooltip.clone()))
        .child(track)
        .into_any_element()
}

fn gauge_view(gauge: &Gauge, open: bool, theme: &crate::theme::Theme) -> AnyElement {
    let kind = if gauge.kind == GaugeKind::Memory { "memory" } else { "disk" };
    let tone = if gauge.low { theme.orange_ink } else { theme.ink2 };
    div()
        .debug_selector(move || format!("resource-meter-{kind}"))
        .min_w_0()
        .flex_1()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(px(8.0))
                .child(
                    Icon::new(if gauge.kind == GaugeKind::Memory { IconName::RamMemory } else { IconName::HardDrive })
                        .size(IconSize::S16)
                        .color(tone),
                )
                .child(
                    div()
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if gauge.low { theme.orange_ink } else { theme.ink })
                        .child(gauge.free.clone()),
                )
                .child(div().min_w_0().flex_1().truncate().text_step(TEXT_12).text_color(theme.ink3).child(gauge.of.clone()))
                .when(gauge.measuring || gauge.refreshing, |d| {
                    d.child(
                        div()
                            .id(SharedString::from(format!("resource-measuring-{kind}")))
                            .debug_selector(|| "resource-measuring".into())
                            .tooltip(Tooltip::text(MEASURING_TOOLTIP))
                            .child(Icon::new(IconName::Loading03).size(IconSize::S14).color(theme.ink3)),
                    )
                }),
        )
        .child(bar(gauge, open, theme))
        .into_any_element()
}

fn who(row: &ResourceRow, warning: Option<&str>, theme: &crate::theme::Theme) -> AnyElement {
    let icon = if is_desktop(&row.name) { IconName::Computer } else { IconName::Laptop };
    div()
        .w(px(130.0))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(Icon::new(icon).size(IconSize::S16).color(if row.online { theme.ink2 } else { theme.ink4 }))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .truncate()
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if row.online { theme.ink } else { theme.ink2 })
                        .child(row.name.clone()),
                )
                .child(
                    div()
                        .truncate()
                        .text_step(TEXT_12)
                        .text_color(if warning.is_some() { theme.orange_ink } else { theme.ink3 })
                        .child(warning.map_or_else(|| row.detail.clone(), str::to_string)),
                ),
        )
        .into_any_element()
}

fn parts_column(gauge: Option<&Gauge>, cleanup_button: Option<AnyElement>, theme: &crate::theme::Theme) -> AnyElement {
    let Some(gauge) = gauge else { return div().min_w_0().flex_1().into_any_element() };
    let mut column = div().min_w_0().flex_1().flex().flex_col().gap(px(6.0));
    if gauge.measuring {
        column = column.child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!("{MEASURING_TOOLTIP}\u{2026}")));
    } else {
        let kind = if gauge.kind == GaugeKind::Memory { "memory" } else { "disk" };
        column = column.child(div().debug_selector(move || format!("resource-parts-{kind}")).flex().flex_col().gap(px(6.0)).children(
            gauge.parts.iter().enumerate().map(|(index, part)| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_step(TEXT_12)
                    .child(div().size(px(8.0)).flex_none().rounded(RADIUS_INLINE).bg(faded(theme.accent, part_opacity(index))))
                    .child(div().min_w_0().flex_1().truncate().text_color(theme.ink2).child(part.label.clone()))
                    .child(div().text_color(theme.ink).child(part.value.clone()))
            }),
        ));
    }
    column.children(cleanup_button).into_any_element()
}

impl DevicesView {
    /// The rows of the list, one open at a time. `initially_open` is set by the page, not here.
    pub(super) fn resource_rows(&mut self, rows: &[ResourceRow], store: &DevicesStore, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        rows.iter()
            .map(|row| {
                let open = self.open_row.as_deref() == Some(row.id.as_str());
                let id = slug(&row.id);
                let resources = store.resources.get(&row.id);
                let gauges = resources.and_then(resource_gauges);
                if !row.online || gauges.is_none() {
                    let text = if !row.online {
                        row.seen.clone().unwrap_or_else(|| "Offline".into())
                    } else if resources.is_some() {
                        UNREADABLE.to_string()
                    } else {
                        format!("Milagre on {} can't report memory and disk yet. Update it to see them.", row.name)
                    };
                    return div()
                        .debug_selector(move || format!("resources-{id}"))
                        .flex()
                        .items_center()
                        .gap(px(20.0))
                        .px(px(16.0))
                        .py(px(12.0))
                        .opacity(if row.online { 1.0 } else { 0.7 })
                        .child(who(row, None, &theme))
                        .child(div().min_w_0().flex_1().truncate().text_step(TEXT_12).text_color(theme.ink3).child(text))
                        .child(div().w(px(14.0)))
                        .into_any_element();
                }
                let (memory, disk) = gauges.expect("checked above");
                let toggle_id = row.id.clone();
                let warning = memory.low.then_some("Low on memory");
                let cleanup_button = {
                    let computer = if row.id == "this-mac" { None } else { Some(row.name.clone()) };
                    Button::new(SharedString::from(format!("resource-cleanup-{id}")), crate::settings::devices::logic::CLEANUP_BUTTON)
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .on_click(move |_, window, cx| cleanup::open(computer.clone(), window, cx))
                        .into_any_element()
                };
                let header = div()
                    .id(SharedString::from(format!("resource-toggle-{id}")))
                    .debug_selector({
                        let id = id.clone();
                        move || format!("resource-toggle-{id}")
                    })
                    .flex()
                    .items_center()
                    .gap(px(20.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_half_color(&theme)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_row = if this.open_row.as_deref() == Some(toggle_id.as_str()) { None } else { Some(toggle_id.clone()) };
                        cx.notify();
                    }))
                    .child(who(row, warning, &theme))
                    .child(gauge_view(&memory, open, &theme))
                    .child(match &disk {
                        Some(disk) => gauge_view(disk, open, &theme),
                        None => div().min_w_0().flex_1().into_any_element(),
                    })
                    .child(div().w(px(14.0)).flex_none().child(
                        Icon::new(if open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S14).color(theme.ink3),
                    ));
                div()
                    .debug_selector(move || format!("resources-{id}"))
                    .when(open, |d| d.bg(hover_half_color(&theme)))
                    .child(header)
                    .when(open, |d| {
                        d.child(
                            div()
                                .debug_selector(|| "resource-breakdown".into())
                                .flex()
                                .items_start()
                                .gap(px(20.0))
                                .px(px(16.0))
                                .pb(px(16.0))
                                .pt(px(4.0))
                                .child(div().w(px(130.0)).flex_none())
                                .child(parts_column(Some(&memory), None, &theme))
                                .child(parts_column(disk.as_ref(), Some(cleanup_button), &theme))
                                .child(div().w(px(14.0)).flex_none()),
                        )
                    })
                    .into_any_element()
            })
            .collect()
    }
}

fn hover_half_color(theme: &crate::theme::Theme) -> Hsla {
    Hsla::from(theme.hover).opacity(0.5)
}
