//! The Usage page (`TokenUsagePage.tsx`): a Plan usage tab (every account's limits) and an Analytics tab (what
//! Claude Code and Codex used and would cost on the API), under one title with a computer picker.
//!
//! This file holds the state, the toolbar and the actions; `plan_cards.rs` draws the Plan usage tab and
//! `analytics.rs` the Analytics tab. Fixture data only: the numbers come from `fixture.rs`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use gpui::{
    AnyElement, App, Context, FocusHandle, FontWeight, IntoElement, KeyDownEvent, ParentElement, Render, SharedString, Styled, WeakEntity,
    Window, div, prelude::*, px,
};

use super::fixture;
use super::model::AccountsStore;
use super::plan::PlanSnapshot;
use super::token_usage::{Days, Metric, Range, Report};
use crate::data::{Data, LOCAL, Polled, Provider, poll_once};
use crate::logic::usage::report::UsageDisplay;
use crate::logic::usage::time::FixedZone;
use crate::settings::SettingsModal;
use crate::settings::store::{SettingsStore, UsageDisplayMode};
use crate::theme::{ActiveTheme, TEXT_13, TEXT_22, TextStepExt};
use crate::ui::{Select, SelectOption};

/// The fixture's refresh of plan usage.
const PLAN_REFRESH_MS: u64 = 500;
/// The first read of the transcripts on a computer.
const FIRST_SCAN_MS: u64 = 350;
/// "Set as default" taking effect.
const SET_DEFAULT_MS: u64 = 400;

/// The zone the page shows reset times in.
pub const ZONE: FixedZone = FixedZone(-300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageTab {
    Plan,
    Analytics,
}

/// The page entity.
pub struct UsageView {
    pub(super) modal: WeakEntity<SettingsModal>,
    pub(super) tab: UsageTab,
    pub(super) metric: Metric,
    pub(super) range: Range,
    pub(super) days: Option<Days>,
    pub(super) computer: String,
    pub(super) this_mac: String,
    pub(super) computers: Vec<(String, String)>,
    pub(super) plan: PlanSnapshot,
    pub(super) plan_loading: bool,
    pub(super) pending: Option<(Provider, String)>,
    pub(super) errors: HashMap<Provider, String>,
    pub(super) report: Option<Report>,
    report_reads: u32,
    /// Which computers have had their first scan.
    scanned: HashSet<String>,
    pub(super) drag: Option<Days>,
    pub(super) hovered: Option<usize>,
    pub(super) opened: HashMap<String, bool>,
    pub(super) shown_all: HashSet<String>,
    pub(super) focus: FocusHandle,
    found: Option<String>,
}

impl UsageView {
    pub fn new(modal: WeakEntity<SettingsModal>, cx: &mut Context<Self>) -> Self {
        cx.observe_global::<AccountsStore>(|_, cx| cx.notify()).detach();
        cx.observe_global::<SettingsStore>(|_, cx| cx.notify()).detach();
        let (this_mac, computers) = read_computers(cx);
        // Snapshot aid: `MILAGRE_GPUI_USAGE=analytics` opens on that tab.
        let tab = match std::env::var("MILAGRE_GPUI_USAGE").as_deref() {
            Ok("analytics") => UsageTab::Analytics,
            _ => UsageTab::Plan,
        };
        let mut view = Self {
            modal,
            tab,
            metric: Metric::Cost,
            range: Range::Week,
            days: None,
            computer: LOCAL.to_string(),
            this_mac,
            computers,
            plan: fixture::plan_snapshot(true),
            plan_loading: false,
            pending: None,
            errors: HashMap::new(),
            report: None,
            report_reads: 0,
            scanned: HashSet::new(),
            drag: None,
            hovered: None,
            opened: HashMap::new(),
            shown_all: HashSet::new(),
            focus: cx.focus_handle(),
            found: None,
        };
        if tab == UsageTab::Analytics {
            // The snapshot aid has no time to wait for the first scan.
            view.scanned.insert(view.computer.clone());
            view.read_report(cx);
        }
        view
    }

    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    pub fn plan_loading_for_test(&self) -> bool {
        self.plan_loading
    }

    pub fn computer_ids_for_test(&self) -> Vec<String> {
        self.computers.iter().map(|(id, _)| id.clone()).collect()
    }

    pub fn tab(&self) -> UsageTab {
        self.tab
    }

    pub fn metric(&self) -> Metric {
        self.metric
    }

    pub fn range(&self) -> Range {
        self.range
    }

    pub fn days(&self) -> Option<&Days> {
        self.days.as_ref()
    }

    pub fn report(&self) -> Option<&Report> {
        self.report.as_ref()
    }

    pub fn computer(&self) -> &str {
        &self.computer
    }

    pub fn is_local(&self) -> bool {
        self.computer == LOCAL
    }

    pub fn display(cx: &App) -> UsageDisplay {
        match cx.global::<SettingsStore>().usage_display_mode {
            UsageDisplayMode::Used => UsageDisplay::Used,
            UsageDisplayMode::Remaining => UsageDisplay::Remaining,
        }
    }

    /// The name the footnotes give the picked computer.
    pub(super) fn computer_name(&self) -> String {
        if self.is_local() {
            "this Mac".to_string()
        } else {
            self.computers.iter().find(|(id, _)| *id == self.computer).map_or_else(|| "that computer".to_string(), |(_, name)| name.clone())
        }
    }

    pub fn set_tab(&mut self, tab: UsageTab, cx: &mut Context<Self>) {
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        if tab == UsageTab::Analytics {
            self.read_report(cx);
        }
        cx.notify();
    }

    pub fn set_metric(&mut self, metric: Metric, cx: &mut Context<Self>) {
        self.metric = metric;
        cx.notify();
    }

    /// A period button: reads that range and drops the days picked on the calendar.
    pub fn set_range(&mut self, range: Range, cx: &mut Context<Self>) {
        self.range = range;
        self.days = None;
        self.read_report(cx);
        cx.notify();
    }

    /// The calendar picked days (a click or a drag).
    pub fn set_days(&mut self, days: Option<Days>, cx: &mut Context<Self>) {
        self.days = days;
        self.read_report(cx);
        cx.notify();
    }

    pub fn set_computer(&mut self, computer: &str, cx: &mut Context<Self>) {
        self.computer = computer.to_string();
        self.days = None;
        self.drag = None;
        self.report = None;
        self.plan = fixture::plan_snapshot(self.is_local());
        self.errors.clear();
        if self.tab == UsageTab::Analytics {
            self.read_report(cx);
        }
        cx.notify();
    }

    /// Reads the report for the period; the first read on a computer scans its transcripts, which takes a moment.
    fn read_report(&mut self, cx: &mut Context<Self>) {
        self.report_reads += 1;
        let read = self.report_reads;
        let scale = if self.is_local() { 1.0 } else { 0.4 };
        let range = self.range;
        let days = self.days.clone();
        let computer = self.computer.clone();
        if self.scanned.insert(computer) {
            self.report = None;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(FIRST_SCAN_MS)).await;
                this.update(cx, |this, cx| {
                    if this.report_reads == read {
                        this.report = Some(fixture::token_report(range, days.as_ref(), scale));
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        } else {
            self.report = Some(fixture::token_report(range, days.as_ref(), scale));
        }
    }

    /// The refresh button over Plan usage.
    pub fn refresh_plan(&mut self, cx: &mut Context<Self>) {
        if self.plan_loading {
            return;
        }
        self.plan_loading = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(PLAN_REFRESH_MS)).await;
            this.update(cx, |this, cx| {
                this.plan_loading = false;
                this.plan = fixture::plan_snapshot(this.is_local());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// "Set as default" on an account's card: makes it the computer default for its provider.
    pub fn set_default(&mut self, provider: Provider, id: &str, cx: &mut Context<Self>) {
        if self.pending.is_some() || !self.is_local() {
            return;
        }
        self.pending = Some((provider, id.to_string()));
        self.errors.remove(&provider);
        cx.notify();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SET_DEFAULT_MS)).await;
            this.update(cx, |this, cx| {
                cx.update_global::<AccountsStore, _>(|store, _| store.set_default(provider, &id));
                this.pending = None;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// "Manage accounts": opens the Accounts section.
    pub fn manage_accounts(&mut self, cx: &mut Context<Self>) {
        use crate::settings::{SelectedSection, SettingsSectionId};
        if let Some(modal) = self.modal.upgrade() {
            cx.defer(move |cx| {
                modal.update(cx, |modal, cx| modal.select_section(SelectedSection::Section(SettingsSectionId::Accounts), cx));
            });
        }
    }

    /// Escape clears the picked days before it leaves the page.
    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let m = &event.keystroke.modifiers;
        if event.keystroke.key == "escape" && !m.platform && !m.control && !m.alt && self.tab == UsageTab::Analytics && self.days.is_some()
        {
            cx.stop_propagation();
            self.set_days(None, cx);
        }
    }
}

fn read_computers(cx: &App) -> (String, Vec<(String, String)>) {
    let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else { return ("This Mac".to_string(), Vec::new()) };
    match poll_once(source.computers()) {
        Polled::Ready(Ok(snapshot)) => {
            let mac = if snapshot.this_mac.trim().is_empty() { "This Mac".to_string() } else { snapshot.this_mac.to_string() };
            (mac, snapshot.computers.into_iter().map(|c| (c.id.to_string(), c.name.to_string())).collect())
        }
        _ => ("This Mac".to_string(), Vec::new()),
    }
}

impl Render for UsageView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();

        let computer_picker = (!self.computers.is_empty()).then(|| {
            let mut options = vec![SelectOption::new(LOCAL.to_string(), self.this_mac.clone())];
            options.extend(self.computers.iter().map(|(id, name)| SelectOption::new(id.clone(), name.clone())));
            Select::new("usage-computer", self.computer.clone(), options)
                .compact()
                .width(200.0)
                .on_change(cx.listener(|this, value: &SharedString, _, cx| this.set_computer(value, cx)))
        });

        let title = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .child(div().text_step(TEXT_22).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Usage"))
            .children(computer_picker);

        let tabs = div().flex().min_w_0().flex_1().gap(px(24.0)).children([UsageTab::Plan, UsageTab::Analytics].map(|tab| {
            let (id, label) = match tab {
                UsageTab::Plan => ("usage-tab-plan", "Plan usage"),
                UsageTab::Analytics => ("usage-tab-analytics", "Analytics"),
            };
            let active = self.tab == tab;
            div()
                .id(id)
                .debug_selector(move || id.to_string())
                .h(px(32.0))
                .flex()
                .items_center()
                .cursor_pointer()
                .border_b_2()
                .border_color(if active { theme.ink } else { gpui::transparent_black().into() })
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { theme.ink } else { theme.ink3 })
                .when(!active, |el| el.hover(move |style| style.text_color(theme.ink)))
                .on_click(cx.listener(move |this, _, _, cx| this.set_tab(tab, cx)))
                .child(label)
        }));

        let controls: AnyElement = match self.tab {
            UsageTab::Plan => self.plan_controls(cx),
            UsageTab::Analytics => self.analytics_controls(cx),
        };

        let body: AnyElement = match self.tab {
            UsageTab::Plan => self.plan_body(cx),
            UsageTab::Analytics => self.analytics_body(cx),
        };

        div()
            .id("usage-page")
            .debug_selector(|| "settings-section-usage".into())
            .key_context("UsagePage")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(title)
            .child(div().flex().items_center().gap(px(16.0)).child(tabs).child(div().flex_none().child(controls)))
            .child(div().min_w_0().child(body))
    }
}
