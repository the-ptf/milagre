//! The sidebar's plan usage (`SidebarUsage.tsx` and `UsageCard.tsx`): a row per provider in the expanded sidebar,
//! a mark with a tiny bar per provider on the collapsed rail, and the card both open beside the sidebar.
//!
//! A row is the provider's logo, its name, a warning icon when the last read failed, then one or two right-aligned
//! columns: "23% 5h" with a thin bar under that label's column (`w-26` shared by the windows; a single window spans
//! it). The bar's fill is ink, orange from 80 %, red from 95 % (`UsageBar`). Resting 120ms on a row opens the card
//! (closing gives 150ms to cross to it). The rules are `logic::usage::report`'s; [`CardModel`] is the card's data.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    Anchor, AnyElement, App, Bounds, FontWeight, Pixels, Rgba, Window, anchored, canvas, deferred, div, point, prelude::*, px, relative,
};

use crate::data::{Provider, ProviderUsage, UsageSnapshot, UsageStatus};
use crate::logic::usage::report::{
    UsageDisplay, UsageTone, format_percent, format_resets_in, format_updated_ago, shown_percent, shown_suffix, usage_tone,
};
use crate::settings::accounts::AccountsStore;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme, sidebar_step};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, ProviderLogo};

/// How long the pointer rests on a row before the card opens, and the time to cross to it (`OPEN_DELAY_MS`, `CLOSE_DELAY_MS`).
pub const OPEN_DELAY: Duration = Duration::from_millis(120);
pub const CLOSE_DELAY: Duration = Duration::from_millis(150);
pub const CARD_WIDTH: f32 = 288.0;
const CARD_GAP: f32 = 8.0;
const VIEWPORT_MARGIN: f32 = 12.0;
const ROW_HEIGHT: f32 = 32.0;
/// The meters' shared width (`w-26`) and the gap between two columns (`gap-2`).
const METERS_WIDTH: f32 = 104.0;
const METERS_GAP: f32 = 8.0;

/// Where each provider's row (or rail mark) was painted, so the card can sit beside it.
pub type RowBounds = Rc<RefCell<HashMap<Provider, Bounds<Pixels>>>>;
/// A row's pointer handler: which provider, and whether the pointer is on it.
pub type HoverHandler = Rc<dyn Fn(Provider, bool, &mut Window, &mut App)>;

/// What the rows need from the sidebar.
#[derive(Clone)]
pub struct UsageHooks {
    pub on_hover: HoverHandler,
    pub bounds: RowBounds,
    /// The provider whose card is open: its row stays highlighted.
    pub open: Option<Provider>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The usage block's content: a row per provider with numbers, or marks in a row when Settings › Appearance asks
/// for the compact layout. The caller owns the container.
pub fn rows(usage: &UsageSnapshot, hooks: &UsageHooks, theme: &Theme) -> Vec<AnyElement> {
    let compact = crate::theme::live::compact_usage();
    let report = usage.report();
    crate::logic::usage::report::visible_providers(&report)
        .into_iter()
        .map(|row| if compact { mark(row, hooks, theme).into_any_element() } else { row_view(row, hooks, theme).into_any_element() })
        .collect()
}

/// The collapsed rail's marks, in a column.
pub fn rail_marks(usage: &UsageSnapshot, hooks: &UsageHooks, theme: &Theme) -> Vec<AnyElement> {
    let report = usage.report();
    crate::logic::usage::report::visible_providers(&report).into_iter().map(|row| mark(row, hooks, theme).into_any_element()).collect()
}

/// Records where the element it is a child of was painted.
fn track(hooks: &UsageHooks, provider: Provider) -> impl IntoElement + use<> {
    let bounds = hooks.bounds.clone();
    canvas(move |b, _, _| bounds.borrow_mut().insert(provider, b), |_, _, _, _| ()).absolute().size_full()
}

fn hover_handler(hooks: &UsageHooks, provider: Provider) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    let on_hover = hooks.on_hover.clone();
    move |hovered, window, cx| on_hover(provider, *hovered, window, cx)
}

/// A meter's fill in its usage tone: ink, orange from 80 %, red from 95 % (`UsageBar`).
fn fill_color(used_percent: f64, theme: &Theme) -> Rgba {
    match usage_tone(used_percent) {
        UsageTone::Normal => theme.ink,
        UsageTone::Warning => theme.orange,
        UsageTone::Critical => theme.red,
    }
}

/// A track and its fill: `line-strong`, fully round, the fill's share of it the shown percent.
fn bar(used_percent: f64, height: f32, theme: &Theme, fill_id: Option<String>) -> gpui::Div {
    let shown = shown_percent(used_percent, UsageDisplay::Used).clamp(0.0, 100.0) as f32 / 100.0;
    div().relative().flex_none().w_full().h(px(height)).rounded_full().overflow_hidden().bg(theme.line_strong).child(
        div()
            .absolute()
            .top_0()
            .left_0()
            .h_full()
            .w(relative(shown))
            .rounded_full()
            .bg(fill_color(used_percent, theme))
            .when_some(fill_id.filter(|_| shown > 0.0), |el, id| el.debug_selector(move || id.clone())),
    )
}

fn row_view(row: &crate::data::AccountUsage, hooks: &UsageHooks, theme: &Theme) -> impl IntoElement + use<> {
    let provider = row.provider;
    let name = provider.name();
    let open = hooks.open == Some(provider);
    let (hover, hover2) = (theme.hover, theme.hover2);
    let windows = row.windows.iter().take(2).collect::<Vec<_>>();
    div()
        .id(("usage-row", provider as usize))
        .debug_selector(move || format!("usage-row-{name}"))
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .h(px(ROW_HEIGHT))
        .px(px(8.0))
        .rounded(RADIUS_CONTROL)
        .text_step(sidebar_step(TEXT_12))
        .text_color(if open { theme.ink } else { theme.ink2 })
        .cursor_pointer()
        .when(open, |el| el.bg(hover2))
        .when(!open, |el| el.hover(move |style| style.bg(hover)))
        .on_hover(hover_handler(hooks, provider))
        .child(track(hooks, provider))
        .child(div().flex().flex_none().items_center().justify_center().child(ProviderLogo::new(provider).size(14.0)))
        .child(div().min_w_0().truncate().text_color(theme.ink2).child(name))
        // The last read failed: its last-known numbers stay at full strength, and this says so.
        .when(row.status == UsageStatus::Error, |el| el.child(Icon::new(IconName::Alert02).size(IconSize::S12).color(theme.red_ink)))
        .child(div().flex_1())
        .when(windows.is_empty(), |el| el.child(div().text_color(theme.ink3).child("\u{2014}")))
        .when(!windows.is_empty(), |el| {
            el.child(div().flex().flex_none().items_center().gap(px(METERS_GAP)).w(px(METERS_WIDTH)).children(
                windows.iter().enumerate().map(|(i, w)| {
                    let (meter, track_id, fill_id) =
                        (format!("usage-meter-{name}-{i}"), format!("usage-track-{name}-{i}"), format!("usage-fill-{name}-{i}"));
                    let fill = shown_percent(w.used_percent, UsageDisplay::Used);
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .items_end()
                        .gap(px(2.0))
                        .child(
                            div()
                                .debug_selector(move || meter.clone())
                                .flex()
                                .items_baseline()
                                .gap(px(4.0))
                                .whitespace_nowrap()
                                .font_weight(FontWeight::MEDIUM)
                                .child(div().text_color(theme.ink).child(format_percent(fill)))
                                .child(div().text_color(theme.ink3).child(w.short_label.clone())),
                        )
                        .child(bar(w.used_percent, 2.0, theme, Some(fill_id)).debug_selector(move || track_id.clone()))
                }),
            ))
        })
}

/// A provider's mark (`data-usage-compact` and the collapsed rail): the logo at 14 with its fullest window as a 16 by
/// 2 bar near the bottom, centred.
fn mark(row: &crate::data::AccountUsage, hooks: &UsageHooks, theme: &Theme) -> impl IntoElement + use<> {
    let provider = row.provider;
    let name = provider.name();
    let peak = row.windows.iter().map(|w| w.used_percent).fold(0.0_f64, f64::max);
    let open = hooks.open == Some(provider);
    let (hover, hover2) = (theme.hover, theme.hover2);
    div()
        .id(("usage-mark", provider as usize))
        .debug_selector(move || format!("usage-mark-{name}"))
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(ROW_HEIGHT))
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .when(open, |el| el.bg(hover2))
        .when(!open, |el| el.hover(move |style| style.bg(hover)))
        .on_hover(hover_handler(hooks, provider))
        .child(track(hooks, provider))
        .child(ProviderLogo::new(provider).size(14.0))
        .when(!row.windows.is_empty(), |el| {
            el.child(div().absolute().bottom(px(4.0)).left(px(8.0)).w(px(16.0)).child(bar(peak, 2.0, theme, None)))
        })
}

/// One window of the card.
#[derive(Clone, Debug, PartialEq)]
pub struct CardWindow {
    pub label: String,
    pub detail: Option<String>,
    pub percent: f64,
    /// "46% used".
    pub used: String,
    /// "Resets in 6d 16h"; empty when the host gave no time.
    pub resets: String,
}

/// What the card says about a provider's usage.
#[derive(Clone, Debug, PartialEq)]
pub struct CardModel {
    pub provider: Provider,
    /// The account's email or label, "Account unavailable" without one.
    pub account: String,
    /// The Project has several saved accounts for the provider: the line is a picker (a chevron after it).
    pub picker: bool,
    pub updated: String,
    pub message: Option<String>,
    pub windows: Vec<CardWindow>,
    /// Shown only when above zero: "0 left" would read as something used up.
    pub banked: Option<u32>,
}

impl CardModel {
    pub fn build(usage: &ProviderUsage, accounts: Option<&AccountsStore>, now: i64) -> Self {
        let display = UsageDisplay::Used;
        let account = usage
            .account
            .as_ref()
            .and_then(|a| a.email.clone().filter(|e| !e.is_empty()).or_else(|| Some(a.label.clone()).filter(|l| !l.is_empty())))
            .unwrap_or_else(|| "Account unavailable".to_owned());
        let picker = accounts.is_some_and(|store| {
            store
                .groups
                .iter()
                .find(|group| group.provider == usage.provider)
                .is_some_and(|group| group.accounts.iter().filter(|entry| !entry.account.missing).count() >= 2)
        });
        Self {
            provider: usage.provider,
            account,
            picker,
            updated: format_updated_ago(&usage.updated_at, now),
            message: usage.message.as_ref().map(ToString::to_string),
            windows: usage
                .windows
                .iter()
                .map(|w| CardWindow {
                    label: w.label.clone(),
                    detail: w.detail.clone(),
                    percent: w.used_percent,
                    used: format!("{} {}", format_percent(shown_percent(w.used_percent, display)), shown_suffix(display)),
                    resets: format_resets_in(w.resets_at.as_deref(), now).unwrap_or_default(),
                })
                .collect(),
            banked: usage.banked_resets.filter(|n| *n > 0),
        }
    }
}

/// The usage card's account picker: whether its choices are open, and what opens or closes them.
pub struct Picker {
    pub open: bool,
    pub toggle: PickerToggle,
}

/// Opens (`true`) or closes the usage card's account picker.
pub type PickerToggle = Rc<dyn Fn(bool, &mut App)>;

/// The card beside the sidebar (`UsageCard`): its bottom edge level with the row's, `left` the sidebar's right edge
/// plus a gap, kept inside the window.
#[allow(clippy::too_many_arguments)]
pub fn card(
    provider: Provider,
    usage: &UsageSnapshot,
    bounds: Bounds<Pixels>,
    sidebar_right: f32,
    window: &Window,
    cx: &App,
    picker: Picker,
    on_hover: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> Option<AnyElement> {
    let theme = *cx.theme();
    let provider_usage = usage.providers.iter().find(|p| p.provider == provider)?;
    // Preview with live usage: the fixture's account store is not this computer's. The picker lists the Project on
    // screen's accounts and the refresh button reads again only when the data layer backs those writes
    // (`PreviewAccountWrites`); otherwise both are off.
    let live = crate::workspace::preview::usage_is_live(cx);
    let writes = cx.has_global::<crate::workspace::preview::PreviewAccountWrites>();
    let mut model = CardModel::build(provider_usage, if live { None } else { cx.try_global::<AccountsStore>() }, now_ms());
    let group = live
        .then(|| cx.try_global::<crate::workspace::preview::PreviewProjectAccounts>())
        .flatten()
        .and_then(|accounts| accounts.0.iter().find(|group| group.provider == provider).cloned())
        .filter(|group| writes && group.accounts.iter().filter(|entry| !entry.account.missing).count() >= 2);
    if live {
        model.picker = group.is_some();
    }
    let reading = cx.has_global::<crate::workspace::preview::PreviewUsageReading>();
    let Picker { open: picker_open, toggle: on_picker } = picker;
    let viewport = window.viewport_size();
    let left = (sidebar_right + CARD_GAP).min(f32::from(viewport.width) - CARD_WIDTH - VIEWPORT_MARGIN);
    let bottom = bounds.bottom().min(viewport.height - px(VIEWPORT_MARGIN));
    let name = provider.name();
    let header = div()
        .flex()
        .items_start()
        .gap(px(8.0))
        .px(px(16.0))
        .py(px(12.0))
        .child(div().mt(px(2.0)).flex().text_color(theme.ink).child(ProviderLogo::new(provider).size(16.0)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .id("usage-card-account")
                        .debug_selector(|| "usage-card-account".into())
                        .flex()
                        .items_center()
                        .gap(px(4.0))
                        .text_step(TEXT_15)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(div().min_w_0().truncate().child(model.account.clone()))
                        .when(model.picker, |el| el.child(Icon::new(IconName::ArrowDown01).size(IconSize::S12).color(theme.ink3)))
                        .when(group.is_some(), |el| {
                            let toggle = on_picker.clone();
                            el.cursor_pointer().on_click(move |_, _, cx| toggle(!picker_open, cx))
                        }),
                )
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(model.updated.clone())),
        )
        .when(!live, |el| el.child(IconButton::new("usage-card-refresh", IconName::Refresh).size(IconButtonSize::S28).glyph(IconSize::S16)))
        .when(live && writes, |el| {
            el.child(div().when(reading, |el| el.opacity(0.4)).child(
                IconButton::new("usage-card-refresh", IconName::Refresh).size(IconButtonSize::S28).glyph(IconSize::S16).on_click(
                    move |_, _, cx| {
                        if !cx.has_global::<crate::workspace::preview::PreviewUsageReading>() {
                            crate::workspace::preview::account_write(crate::workspace::preview::AccountWrite::RefreshUsage, cx);
                        }
                    },
                ),
            ))
        });
    // The picker's choices (`projectAccountOptions`): "Use computer default", then each saved account.
    let picker =
        group.filter(|_| picker_open).map(|group| {
            let current = group.account_id.clone().unwrap_or_default();
            div().flex().flex_col().gap(px(2.0)).px(px(8.0)).pb(px(8.0)).children(group.choices().into_iter().enumerate().map(
                |(n, choice)| {
                    let selected = choice.value == current;
                    let (value, disabled) = (choice.value.clone(), choice.disabled);
                    let close = on_picker.clone();
                    div()
                        .id(("usage-card-pick", n))
                        .debug_selector(move || format!("usage-card-pick-{n}"))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(RADIUS_CONTROL)
                        .text_step(TEXT_13)
                        .when(disabled, |el| el.opacity(0.4))
                        .when(!disabled, |el| {
                            el.cursor_pointer().hover(move |style| style.bg(theme.hover)).on_click(move |_, _, cx| {
                                close(false, cx);
                                if !selected {
                                    let account_id = (!value.is_empty()).then(|| value.clone());
                                    crate::workspace::preview::account_write(
                                        crate::workspace::preview::AccountWrite::Assign { provider, account_id },
                                        cx,
                                    );
                                }
                            })
                        })
                        .child(div().flex_1().min_w_0().child(div().truncate().text_color(theme.ink).child(choice.label.clone())).children(
                            choice.description.clone().map(|d| div().truncate().text_step(TEXT_12).text_color(theme.ink3).child(d)),
                        ))
                        .when(selected, |el| el.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink)))
                },
            ))
        });
    let windows = (!model.windows.is_empty()).then(|| {
        div().flex().flex_col().gap(px(12.0)).px(px(16.0)).pt(px(12.0)).pb(px(16.0)).border_t_1().border_color(theme.line).children(
            model.windows.iter().map(|w| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .justify_between()
                            .gap(px(8.0))
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .child(w.label.clone())
                            .children(
                                w.detail
                                    .clone()
                                    .map(|d| div().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(d)),
                            ),
                    )
                    .child(bar(w.percent, 6.0, &theme, None))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_step(TEXT_12)
                            .text_color(theme.ink2)
                            .child(w.used.clone())
                            .child(w.resets.clone()),
                    )
            }),
        )
    });
    let banked = model.banked.map(|n| {
        div()
            .flex()
            .items_center()
            .justify_between()
            .px(px(16.0))
            .py(px(12.0))
            .border_t_1()
            .border_color(theme.line)
            .text_step(TEXT_12)
            .child(div().text_color(theme.ink2).child("Banked resets"))
            .child(div().text_color(theme.ink).child(format!("{n} left")))
    });
    Some(
        deferred(
            anchored().position(point(px(left), bottom)).anchor(Anchor::BottomLeft).child(
                div()
                    .id("usage-card")
                    .debug_selector(move || format!("usage-card-{name}"))
                    .occlude()
                    .w(px(CARD_WIDTH))
                    .rounded(RADIUS_CARD)
                    .bg(theme.surface)
                    .text_color(theme.ink)
                    .shadow(theme.shadow_raised())
                    .on_hover(move |hovered, window, cx| on_hover(*hovered, window, cx))
                    .child(header)
                    .children(picker)
                    .when_some(model.message.clone(), |el, message| {
                        el.child(
                            div()
                                .mx(px(16.0))
                                .mb(px(12.0))
                                .px(px(12.0))
                                .py(px(6.0))
                                .rounded(RADIUS_CONTROL)
                                .bg(theme.field)
                                .text_step(TEXT_12)
                                .child(message),
                        )
                    })
                    .children(windows)
                    .children(banked),
            ),
        )
        .with_priority(1)
        .into_any_element(),
    )
}

impl super::Sidebar {
    /// The rows' handlers: hover opens the card after [`OPEN_DELAY`], leaving closes it after [`CLOSE_DELAY`].
    pub(super) fn usage_hooks(&self, cx: &mut gpui::Context<Self>) -> UsageHooks {
        let sidebar = cx.entity();
        UsageHooks {
            on_hover: Rc::new(move |provider, hovered, _, cx| {
                sidebar.update(cx, |this, cx| if hovered { this.usage_enter(provider, cx) } else { this.usage_leave(cx) })
            }),
            bounds: self.usage_bounds.clone(),
            open: self.usage_card,
        }
    }

    fn usage_enter(&mut self, provider: Provider, cx: &mut gpui::Context<Self>) {
        self.usage_task = None;
        if self.usage_card == Some(provider) {
            return;
        }
        self.usage_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(OPEN_DELAY).await;
            let _ = this.update(cx, |this, cx| {
                this.usage_card = Some(provider);
                cx.notify();
            });
        }));
    }

    fn usage_leave(&mut self, cx: &mut gpui::Context<Self>) {
        self.usage_task = None;
        if self.usage_card.is_some() {
            self.usage_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CLOSE_DELAY).await;
                let _ = this.update(cx, |this, cx| {
                    this.usage_card = None;
                    this.usage_picker = false;
                    cx.notify();
                });
            }));
        }
    }

    fn usage_card_pointer(&mut self, on_card: bool, cx: &mut gpui::Context<Self>) {
        if on_card {
            self.usage_task = None;
        } else {
            self.usage_leave(cx);
        }
    }

    /// Snapshot aid: opens the card once the rows have been painted (their bounds are known from the first frame).
    pub(super) fn open_usage_demo(&mut self, provider: Provider, cx: &mut gpui::Context<Self>) {
        self.usage_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let _ = this.update(cx, |this, cx| {
                this.usage_card = Some(provider);
                cx.notify();
            });
        }));
    }

    /// The open card, drawn over everything beside the sidebar.
    pub(super) fn usage_overlay(&mut self, window: &Window, cx: &mut gpui::Context<Self>) -> Option<AnyElement> {
        let provider = self.usage_card?;
        let bounds = *self.usage_bounds.borrow().get(&provider)?;
        let right = if self.collapsed { super::rail::RAIL_WIDTH } else { super::SIDEBAR_WIDTH };
        let sidebar = cx.entity();
        let picker_sidebar = sidebar.clone();
        let on_picker: PickerToggle = Rc::new(move |open, cx| {
            picker_sidebar.update(cx, |this, cx| {
                this.usage_picker = open;
                cx.notify();
            })
        });
        let picker = Picker { open: self.usage_picker, toggle: on_picker };
        card(provider, &self.data.usage, bounds, right, window, cx, picker, move |on, _, cx| {
            sidebar.update(cx, |this, cx| this.usage_card_pointer(on, cx))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::fixture::{FixtureData, NOW};

    #[test]
    fn the_card_says_what_react_says() {
        let usage = FixtureData::default().usage;
        let codex = usage.providers.iter().find(|p| p.provider == Provider::Codex).unwrap();
        let model = CardModel::build(codex, None, NOW);
        assert_eq!(model.account, "victor@codex.example");
        assert_eq!(model.updated, "Updated 4m ago");
        assert_eq!(model.windows[0].used, "86% used");
        assert_eq!(model.windows[0].resets, "Resets in 2d 2h");
        assert_eq!(model.banked, Some(1));
        let claude = usage.providers.iter().find(|p| p.provider == Provider::Claude).unwrap();
        assert_eq!(CardModel::build(claude, None, NOW).banked, None, "no banked row without resets");
    }
}
