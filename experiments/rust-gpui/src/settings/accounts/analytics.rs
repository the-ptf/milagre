//! The Analytics tab (`TokenUsagePage.tsx`): the total with its provider split, the 90-day calendar that picks
//! the days the page covers (a click picks a day, a drag picks a span), then where it went (Projects and their
//! Chats), the models and the token mix. All plain boxes, no chart library.

use gpui::{
    AnyElement, Context, FontWeight, IntoElement, MouseButton, ParentElement, Rgba, SharedString, Styled, div, prelude::*, px, relative,
};

use super::style::shadow_card;
use super::token_usage::{
    ChatKind, Days, Metric, ProjectUsage, Range, Report, TOKEN_CATEGORIES, TOKEN_USAGE_PROVIDERS, ago, cache_hit_rate, calendar_day_label,
    calendar_levels, calendar_summary, calendar_weeks, chat_meta, covered_days, format_metric, format_share, format_token_count,
    format_usd, metric_of, period_label, provider_color, split_value, token_total,
};
use super::usage::UsageView;
use crate::data::Provider;
use crate::settings::appearance::color::mix;
use crate::theme::{
    ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TEXT_22, TEXT_26,
    TextStepExt, Theme, hex, to_hex,
};
use crate::ui::{Icon, IconName, IconSize, ProviderLogo, SpinnerRing};

/// Chats a Project shows when opened, before "Show N more Chats".
const FIRST_CHATS: usize = 5;
const WEEKDAYS: [&str; 7] = ["Mon", "", "Wed", "", "Fri", "", ""];
const SHADE_SHARES: [f64; 5] = [20.0, 38.0, 56.0, 76.0, 100.0];
const CELL: f32 = 22.0;

/// The calendar's shades: nothing, then the accent mixed in more strongly for each fifth of the busy days.
pub fn shades(theme: &Theme) -> [Rgba; 6] {
    let (surface, accent) = (to_hex(theme.surface), to_hex(theme.accent));
    let mut out = [theme.hover2; 6];
    for (index, share) in SHADE_SHARES.iter().enumerate() {
        out[index + 1] = hex(&mix(&surface, &accent, share / 100.0));
    }
    out
}

/// `inkOf`: ink mixed into the surface.
fn ink_of(theme: &Theme, share: f64) -> Rgba {
    hex(&mix(&to_hex(theme.surface), &to_hex(theme.ink), share / 100.0))
}

fn card(theme: &Theme) -> gpui::Div {
    div().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.surface)
}

/// A bar split by provider, in the fixed provider order, each part as long as its share of `whole`.
fn split_bar(values: &[(Provider, f64)], whole: f64, height: f32) -> gpui::Div {
    let shown: Vec<&(Provider, f64)> = values.iter().filter(|(_, value)| *value > 0.0).collect();
    let used: f64 = shown.iter().map(|(_, value)| *value).sum();
    let mut bar = div().flex().w_full().h(px(height)).gap(px(2.0));
    for (provider, value) in shown {
        let mut part = div().h_full().min_w(px(3.0)).rounded_full().flex_basis(relative(0.0)).flex_grow(*value as f32);
        if let Some(color) = provider_color(*provider) {
            part = part.bg(color);
        }
        bar = bar.child(part);
    }
    if whole > used {
        bar = bar.child(div().h_full().flex_basis(relative(0.0)).flex_grow((whole - used) as f32));
    }
    bar
}

impl UsageView {
    /// A `Tabs`: a `hover` track, the picked chip raised on `surface`.
    fn pill_tabs(&self, id: &'static str, value: Option<&str>, options: &[(&'static str, String)], cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        div()
            .debug_selector(move || id.to_string())
            .flex()
            .p(px(2.0))
            .rounded(RADIUS_CONTROL)
            .bg(theme.hover)
            .children(options.iter().map(|(option, label)| {
                let picked = value == Some(*option);
                let option = *option;
                div()
                    .id(SharedString::from(format!("{id}-{option}")))
                    .debug_selector(move || format!("{id}-{option}"))
                    .flex()
                    .items_center()
                    .h(px(28.0))
                    .px(px(12.0))
                    .rounded(RADIUS_CHIP)
                    .cursor_pointer()
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if picked { theme.ink } else { theme.ink2 })
                    .when(picked, |el| el.bg(theme.surface).shadow(shadow_card(&theme)))
                    .when(!picked, |el| el.hover(move |style| style.text_color(theme.ink)))
                    .on_click(cx.listener(move |this, _, _, cx| match id {
                        "usage-metric" => this.set_metric(Metric::parse(option), cx),
                        _ => {
                            if let Some(range) = Range::parse(option) {
                                this.set_range(range, cx);
                            }
                        }
                    }))
                    .child(label.clone())
            }))
            .into_any_element()
    }

    /// Cost / Tokens and the period, right of the tabs.
    pub(super) fn analytics_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let metric = [("cost", "Cost".to_string()), ("tokens", "Tokens".to_string())];
        let periods: Vec<(&'static str, String)> = Range::ALL.iter().map(|range| (range.value(), range.short().to_string())).collect();
        let picked = if self.days().is_some() { None } else { Some(self.range().value()) };
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(self.pill_tabs("usage-metric", Some(self.metric().value()), &metric, cx))
            .child(self.pill_tabs("usage-period", picked, &periods, cx))
            .into_any_element()
    }

    pub(super) fn analytics_body(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let metric = self.metric();
        let name = self.computer_name();
        let report = self.report();
        let empty = report.is_some_and(|report| !report.refreshing && token_total(&report.totals) == 0.0);

        let mut page = div().debug_selector(|| "usage-analytics".into()).min_w_0().flex().flex_col().gap(px(16.0));
        if let Some(report) = report {
            if report.refreshing {
                page = page.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink3)
                        .child(SpinnerRing::new().size(12.0))
                        .child(if report.first_scan {
                            "Reading the Claude Code and Codex transcripts for the first time. This can take a minute\u{2026}"
                        } else {
                            "Reading new transcripts\u{2026}"
                        }),
                );
            }
            let pricing = match report.pricing {
                super::token_usage::PricingStatus::Ok => None,
                super::token_usage::PricingStatus::Loading => Some("Loading model prices\u{2026}"),
                super::token_usage::PricingStatus::Stale => Some("Model prices couldn't be refreshed; costs use the last list."),
                super::token_usage::PricingStatus::Unavailable => Some("Model prices couldn't be loaded, so costs show $0 until they are."),
            };
            if let Some(text) = pricing {
                page = page.child(div().text_step(TEXT_12).text_color(theme.ink3).child(text));
            }
        } else {
            page = page.child(
                div()
                    .debug_selector(|| "usage-loading".into())
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink3)
                    .child(SpinnerRing::new().size(14.0))
                    .child("Loading usage\u{2026}"),
            );
        }
        let Some(report) = report else { return page.into_any_element() };

        page = page.child(self.total_card(report, metric, cx)).child(self.calendar_card(report, metric, cx));
        if empty {
            page = page.child(
                card(&theme)
                    .debug_selector(|| "usage-empty".into())
                    .px(px(16.0))
                    .py(px(40.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("No usage in this period"))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(format!("Claude Code and Codex sessions on {name} show here as they run.")),
                    ),
            );
        } else {
            page = page.child(
                div().flex().flex_wrap().items_start().gap(px(16.0)).child(self.where_it_went(report, metric, cx)).child(
                    div()
                        .min_w(px(300.0))
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(16.0))
                        .child(self.models_card(report, metric, &theme))
                        .child(self.token_mix(report, metric, &theme)),
                ),
            );
        }
        let updated = report.pricing_fetched_at.map(|at| format!(" (updated {})", ago(at, report.generated_at))).unwrap_or_default();
        page.child(div().text_step(TEXT_11).text_color(theme.ink3).child(format!(
            "Read from the Claude Code and Codex transcripts on {name}, including sessions run outside Milagre. Costs are estimates at API prices from LiteLLM's model list{updated}, not your plan's bill. Kiro and Antigravity aren't counted."
        )))
        .into_any_element()
    }

    fn total_card(&self, report: &Report, metric: Metric, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let totals = &report.totals;
        let providers: Vec<Provider> = TOKEN_USAGE_PROVIDERS
            .into_iter()
            .filter(|provider| report.providers.iter().any(|(candidate, _)| candidate == provider))
            .collect();
        let value_of = |provider: Provider| {
            report.providers.iter().find(|(candidate, _)| *candidate == provider).map_or(0.0, |(_, totals)| metric_of(metric, totals))
        };
        let whole = metric_of(metric, totals);
        let sub = format!(
            "{} \u{b7} {} requests{}{}",
            if metric == Metric::Cost {
                format!("{} tokens", format_token_count(token_total(totals)))
            } else {
                format!("{} at API prices", format_usd(totals.cost_usd))
            },
            format_token_count(totals.requests),
            if token_total(totals) > 0.0 {
                format!(" \u{b7} {}% from cache", (cache_hit_rate(totals) * 100.0).round())
            } else {
                String::new()
            },
            if totals.unpriced_tokens > 0.0 {
                format!(" \u{b7} {} tokens unpriced", format_token_count(totals.unpriced_tokens))
            } else {
                String::new()
            },
        );
        let clear = self.days().is_some().then(|| {
            div()
                .id("usage-clear-days")
                .debug_selector(|| "usage-clear-days".into())
                .flex()
                .items_center()
                .gap(px(4.0))
                .h(px(20.0))
                .px(px(8.0))
                .rounded_full()
                .bg(theme.hover)
                .cursor_pointer()
                .text_step(TEXT_11)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .hover(move |style| style.bg(theme.hover2).text_color(theme.ink))
                .on_click(cx.listener(|this, _, _, cx| this.set_days(None, cx)))
                .child("Clear")
                .child(Icon::new(IconName::Cancel01).size(IconSize::S12).color(theme.ink2))
        });
        let split =
            (!providers.is_empty()).then(|| {
                let values: Vec<(Provider, f64)> = providers.iter().map(|provider| (*provider, value_of(*provider))).collect();
                div().min_w(px(280.0)).flex_1().child(split_bar(&values, whole, 10.0)).child(
                    div().mt(px(12.0)).flex().justify_between().gap(px(16.0)).children(providers.iter().enumerate().map(
                        |(index, provider)| {
                            let entry = report
                                .providers
                                .iter()
                                .find(|(candidate, _)| candidate == provider)
                                .map(|(_, totals)| *totals)
                                .unwrap_or_default();
                            let color = provider_color(*provider);
                            div()
                                .flex()
                                .flex_col()
                                .when(index > 0, |el| el.items_end())
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .text_step(TEXT_12)
                                        .text_color(theme.ink2)
                                        .child(div().size(px(8.0)).rounded_full().when_some(color, |el, color| el.bg(color)))
                                        .child(format!("{} \u{b7} {}", provider.name(), format_share(value_of(*provider), whole))),
                                )
                                .child(div().mt(px(2.0)).text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(
                                    format!("{} \u{b7} {} tokens", format_usd(entry.cost_usd), format_token_count(token_total(&entry))),
                                ))
                        },
                    )),
                )
            });
        card(&theme)
            .debug_selector(|| "usage-total".into())
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(48.0))
            .gap_y(px(16.0))
            .px(px(24.0))
            .py(px(20.0))
            .child(
                div()
                    .min_w(px(280.0))
                    .flex_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(period_label(report.range, report.days.as_ref()))
                            .children(clear),
                    )
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_step(TEXT_26)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .child(format_metric(metric, whole)),
                    )
                    .child(div().mt(px(4.0)).text_step(TEXT_13).text_color(theme.ink2).child(sub)),
            )
            .children(split)
            .into_any_element()
    }

    /// Whether `key` is shown at full strength: inside the drag, else covered by the report.
    fn day_opacity(&self, key: &str, covered: &std::collections::HashSet<String>) -> f32 {
        match &self.drag {
            Some(drag) => {
                if drag.contains(key) {
                    1.0
                } else {
                    0.35
                }
            }
            None => {
                if covered.contains(key) {
                    1.0
                } else {
                    0.35
                }
            }
        }
    }

    fn start_drag(&mut self, key: &str, window: &mut gpui::Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.drag = Some(Days::one(key));
        cx.notify();
    }

    fn enter_day(&mut self, index: usize, key: &str, entered: bool, cx: &mut Context<Self>) {
        if entered {
            self.hovered = Some(index);
            if let Some(drag) = &mut self.drag {
                drag.to = key.to_string();
            }
            cx.notify();
        } else if self.hovered == Some(index) {
            self.hovered = None;
            cx.notify();
        }
    }

    /// The mouse button came up: the dragged span, whichever way it ran, is what the page covers.
    pub fn finish_drag(&mut self, cx: &mut Context<Self>) {
        if let Some(drag) = self.drag.take() {
            self.set_days(Some(drag.ordered()), cx);
        }
    }

    pub fn dragging(&self) -> Option<&Days> {
        self.drag.as_ref()
    }

    fn calendar_card(&self, report: &Report, metric: Metric, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let weeks = calendar_weeks(&report.calendar);
        let levels = calendar_levels(&report.calendar, metric);
        let covered = covered_days(&report.calendar, report.since, report.until);
        let summary = calendar_summary(&report.calendar, metric);
        let shades = shades(&theme);
        let value_of = |index: usize| {
            let day = &report.calendar[index];
            if metric == Metric::Cost { day.cost_usd } else { day.tokens }
        };

        let weekday_column = div().flex().flex_col().gap(px(4.0)).w(px(36.0)).pt(px(18.0)).children(
            WEEKDAYS.iter().map(|label| div().flex().items_center().h(px(CELL)).text_step(TEXT_11).text_color(theme.ink3).child(*label)),
        );
        let columns = weeks.iter().map(|week| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(div().h(px(14.0)).whitespace_nowrap().text_step(TEXT_11).text_color(theme.ink3).child(week.month.unwrap_or("")))
                .children(week.days.iter().map(|slot| match slot {
                    Some(index) => {
                        let index = *index;
                        let day = &report.calendar[index];
                        let key = day.key.clone();
                        let (down_key, move_key) = (key.clone(), key.clone());
                        div()
                            .id(SharedString::from(format!("usage-day-{key}")))
                            .debug_selector({
                                let key = key.clone();
                                move || format!("usage-day-{key}")
                            })
                            .size(px(CELL))
                            .rounded(RADIUS_INLINE)
                            .bg(shades[levels[index] as usize])
                            .opacity(self.day_opacity(&key, &covered))
                            .cursor_pointer()
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, window, cx| this.start_drag(&down_key, window, cx)),
                            )
                            .on_hover(cx.listener(move |this, entered: &bool, _, cx| this.enter_day(index, &move_key, *entered, cx)))
                            .into_any_element()
                    }
                    None => div().size(px(CELL)).into_any_element(),
                }))
        });

        let hovered_line = match self.hovered {
            Some(index) => {
                let day = &report.calendar[index];
                format!("{}: {} \u{b7} {} tokens", calendar_day_label(day), format_usd(day.cost_usd), format_token_count(day.tokens))
            }
            None => format!(
                "{} active {}{}.",
                summary.active,
                if summary.active == 1 { "day" } else { "days" },
                summary
                    .busiest
                    .as_ref()
                    .map_or(String::new(), |(label, value)| format!(". Busiest day {label} ({})", format_metric(metric, *value)))
            ),
        };
        let _ = value_of;

        card(&theme)
            .id("usage-calendar")
            .debug_selector(|| "usage-calendar".into())
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(48.0))
            .gap_y(px(16.0))
            .px(px(24.0))
            .py(px(20.0))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.finish_drag(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.finish_drag(cx)))
            .child(
                div()
                    .child(
                        div()
                            .mb(px(8.0))
                            .pl(px(40.0))
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink2)
                            .child("Past 90 days"),
                    )
                    .child(div().flex().gap(px(4.0)).child(weekday_column).children(columns)),
            )
            .child(
                div()
                    .min_w(px(240.0))
                    .flex_1()
                    .child(
                        div()
                            .text_step(TEXT_22)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .child(format!("{} in 90 days", format_metric(metric, summary.total))),
                    )
                    .child(
                        div()
                            .debug_selector(|| "usage-day-detail".into())
                            .mt(px(8.0))
                            .text_step(TEXT_13)
                            .text_color(theme.ink2)
                            .child(hovered_line),
                    )
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child("Click a day, or drag across days, to see only them."),
                    )
                    .child(
                        div()
                            .mt(px(12.0))
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .child("Less")
                            .children(shades.iter().map(|shade| div().size(px(12.0)).rounded(RADIUS_INLINE).bg(*shade)))
                            .child("More"),
                    ),
            )
            .into_any_element()
    }

    fn where_it_went(&self, report: &Report, metric: Metric, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let whole = metric_of(metric, &report.totals);
        let largest = report.projects.iter().map(|project| metric_of(metric, &project.totals)).fold(0.0, f64::max);
        let rows: Vec<AnyElement> = report
            .projects
            .iter()
            .enumerate()
            .map(|(index, project)| self.project_row(project, index, metric, whole, largest, report.generated_at, cx))
            .collect();
        card(&theme)
            .debug_selector(|| "usage-where".into())
            .min_w(px(420.0))
            .flex_1()
            .p(px(16.0))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .gap(px(16.0))
                    .px(px(8.0))
                    .pb(px(8.0))
                    .child(div().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Where it went"))
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(format!("Projects and Chats, by {}", if metric == Metric::Cost { "cost" } else { "tokens" })),
                    ),
            )
            .child(div().flex().flex_col().children(rows))
            .when_some(report.more_projects.as_ref(), |el, (count, totals)| {
                el.child(
                    div()
                        .flex()
                        .justify_between()
                        .px(px(8.0))
                        .pt(px(8.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink3)
                        .child(format!("{count} more {}", if *count == 1 { "Project" } else { "Projects" }))
                        .child(format_metric(metric, metric_of(metric, totals))),
                )
            })
            .into_any_element()
    }

    /// Whether a Project's Chats are listed: the top Project starts open; one opened or closed by hand stays so.
    pub fn project_open(&self, key: &str, index: usize) -> bool {
        self.opened.get(key).copied().unwrap_or(index == 0)
    }

    pub fn toggle_project(&mut self, key: &str, index: usize, cx: &mut Context<Self>) {
        let open = self.project_open(key, index);
        self.opened.insert(key.to_string(), !open);
        cx.notify();
    }

    pub fn show_all_chats(&mut self, key: &str, cx: &mut Context<Self>) {
        self.shown_all.insert(key.to_string());
        cx.notify();
    }

    #[allow(clippy::too_many_arguments)]
    fn project_row(
        &self,
        project: &ProjectUsage,
        index: usize,
        metric: Metric,
        whole: f64,
        largest: f64,
        now: i64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = *cx.theme();
        let key = project.key().to_string();
        let open = self.project_open(&key, index);
        let all = self.shown_all.contains(&key);
        let value = metric_of(metric, &project.totals);
        let shown = if all { project.chats.len() } else { project.chats.len().min(FIRST_CHATS) };
        let hidden = project.chats.len() - shown;
        let name = if project.milagre {
            project.name.clone()
        } else {
            format!("{} \u{b7} {} {}", project.name, project.count, if project.count == 1 { "folder" } else { "folders" })
        };
        let unit = |count: u32| match (project.milagre, count == 1) {
            (true, true) => "Chat",
            (true, false) => "Chats",
            (false, true) => "folder",
            (false, false) => "folders",
        };
        let width = ((value / largest.max(1.0)) * 100.0).max(2.0) / 100.0;
        let values: Vec<(Provider, f64)> =
            TOKEN_USAGE_PROVIDERS.iter().map(|provider| (*provider, split_value(metric, &project.providers, *provider))).collect();
        let toggle_key = key.clone();
        let head = div()
            .id(SharedString::from(format!("usage-project-{key}")))
            .debug_selector({
                let key = key.clone();
                move || format!("usage-project-{key}")
            })
            .flex()
            .flex_col()
            .gap(px(6.0))
            .w_full()
            .px(px(8.0))
            .py(px(8.0))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_project(&toggle_key, index, cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Icon::new(if open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S14).color(theme.ink4),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if project.milagre { theme.ink } else { theme.ink2 })
                            .child(name),
                    )
                    .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(format_share(value, whole)))
                    .child(
                        div()
                            .flex_none()
                            .w(px(72.0))
                            .flex()
                            .justify_end()
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .child(format_metric(metric, value)),
                    ),
            )
            .child(div().pl(px(22.0)).child(div().w(relative(width as f32)).child(split_bar(&values, value, 8.0))));

        let chats = open.then(|| {
            div()
                .flex()
                .flex_col()
                .pb(px(8.0))
                .children(project.chats.iter().take(shown).map(|chat| {
                    let dot = chat.providers.first().and_then(|provider| provider_color(*provider));
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .h(px(32.0))
                        .pl(px(30.0))
                        .pr(px(8.0))
                        .child(div().size(px(6.0)).flex_none().rounded_full().when_some(dot, |el, dot| el.bg(dot)))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .truncate()
                                .text_step(TEXT_13)
                                .text_color(if chat.kind == ChatKind::Chat { theme.ink } else { theme.ink2 })
                                .child(chat.title.clone()),
                        )
                        .child(
                            div()
                                .max_w(relative(0.4))
                                .flex_none()
                                .truncate()
                                .text_step(TEXT_11)
                                .text_color(theme.ink3)
                                .child(chat_meta(chat, now)),
                        )
                        .child(
                            div()
                                .flex_none()
                                .w(px(72.0))
                                .flex()
                                .justify_end()
                                .text_step(TEXT_13)
                                .text_color(theme.ink)
                                .child(format_metric(metric, metric_of(metric, &chat.totals))),
                        )
                }))
                .when(hidden > 0, |el| {
                    let more_key = key.clone();
                    el.child(
                        div()
                            .id(SharedString::from(format!("usage-more-{key}")))
                            .debug_selector({
                                let key = key.clone();
                                move || format!("usage-more-{key}")
                            })
                            .flex()
                            .items_center()
                            .h(px(32.0))
                            .pl(px(44.0))
                            .pr(px(8.0))
                            .cursor_pointer()
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink3)
                            .hover(move |style| style.text_color(theme.ink))
                            .on_click(cx.listener(move |this, _, _, cx| this.show_all_chats(&more_key, cx)))
                            .child(format!("Show {hidden} more {}", unit(hidden as u32))),
                    )
                })
                .when_some(project.more.as_ref().filter(|_| all), |el, (count, totals)| {
                    el.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .h(px(32.0))
                            .pl(px(44.0))
                            .pr(px(8.0))
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(div().flex_1().child(format!("{count} smaller {}", unit(*count))))
                            .child(format_metric(metric, metric_of(metric, totals))),
                    )
                })
        });

        div()
            .debug_selector({
                let key = key.clone();
                move || format!("usage-project-block-{key}")
            })
            .child(head)
            .children(chats)
            .into_any_element()
    }

    fn models_card(&self, report: &Report, metric: Metric, theme: &Theme) -> AnyElement {
        let theme = *theme;
        let largest = report.models.iter().map(|model| metric_of(metric, &model.totals)).fold(0.0, f64::max);
        card(&theme)
            .debug_selector(|| "usage-models".into())
            .p(px(16.0))
            .child(div().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Models"))
            .child(div().mt(px(8.0)).flex().flex_col().gap(px(10.0)).children(report.models.iter().map(|model| {
                let width = ((metric_of(metric, &model.totals) / largest.max(1.0)) * 100.0).max(1.0) / 100.0;
                div()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(ProviderLogo::new(model.provider).size(12.0))
                            .child(div().min_w_0().flex_1().truncate().text_step(TEXT_13).text_color(theme.ink).child(model.model.clone()))
                            .child(
                                div()
                                    .flex_none()
                                    .text_step(TEXT_11)
                                    .text_color(theme.ink3)
                                    .child(format!("{}% cached", (cache_hit_rate(&model.totals) * 100.0).round())),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(64.0))
                                    .flex()
                                    .justify_end()
                                    .text_step(TEXT_13)
                                    .when(metric == Metric::Cost && !model.priced, |el| el.text_color(theme.ink3).child("Unpriced"))
                                    .when(!(metric == Metric::Cost && !model.priced), |el| {
                                        el.font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.ink)
                                            .child(format_metric(metric, metric_of(metric, &model.totals)))
                                    }),
                            ),
                    )
                    .child(div().mt(px(6.0)).h(px(4.0)).w(relative(width as f32)).rounded_full().bg(theme.hover2))
            })))
            .into_any_element()
    }

    fn token_mix(&self, report: &Report, metric: Metric, theme: &Theme) -> AnyElement {
        let theme = *theme;
        let totals = &report.totals;
        let mut order = TOKEN_CATEGORIES;
        order.sort_by(|a, b| a.ink_share().total_cmp(&b.ink_share()));
        let value =
            |category: super::token_usage::Category| if metric == Metric::Cost { category.cost(totals) } else { category.tokens(totals) };
        let visible: Vec<_> = order.iter().copied().filter(|category| value(*category) > 0.0).collect();
        let last = visible.len().saturating_sub(1);
        card(&theme)
            .debug_selector(|| "usage-token-mix".into())
            .p(px(16.0))
            .child(div().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Token mix"))
            .child(div().mt(px(12.0)).flex().h(px(10.0)).gap(px(2.0)).children(visible.iter().enumerate().map(|(index, category)| {
                div()
                    .h_full()
                    .min_w(px(3.0))
                    .flex_basis(relative(0.0))
                    .flex_grow(value(*category) as f32)
                    .bg(ink_of(&theme, category.ink_share()))
                    .when(index == 0, |el| el.rounded_l_full())
                    .when(index == last, |el| el.rounded_r_full())
            })))
            .child(div().mt(px(12.0)).flex().flex_col().gap(px(6.0)).children(order.iter().map(|category| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(div().size(px(8.0)).flex_none().rounded_full().bg(ink_of(&theme, category.ink_share())))
                    .child(div().flex_1().child(category.label()))
                    .child(div().text_color(theme.ink3).child(format_token_count(category.tokens(totals))))
                    .child(div().w(px(64.0)).flex().justify_end().text_color(theme.ink).child(format_usd(category.cost(totals))))
            })))
            .child(div().mt(px(12.0)).text_step(TEXT_12).text_color(theme.ink3).child(format!(
                "{}% cache hit rate \u{b7} cache reads saved about {}{}",
                (cache_hit_rate(totals) * 100.0).round(),
                format_usd(totals.cache_savings_usd),
                if totals.reasoning > 0.0 {
                    format!(" \u{b7} {} reasoning tokens", format_token_count(totals.reasoning))
                } else {
                    String::new()
                }
            )))
            .into_any_element()
    }
}
