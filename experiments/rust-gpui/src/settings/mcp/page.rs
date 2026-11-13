//! Settings › MCP servers for this computer (`McpSettings.tsx`, `McpServerRow.tsx`): the accounts' checks grouped
//! into Needs sign-in, Your servers and the outside groups, the switches, Edit and Remove, Add server. Every write
//! goes to the [`Host`] fixture and is followed by a re-check, as `mcp:changed` makes the desktop do.

use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Window, div,
    prelude::*, px,
};

use super::host::Host;
use super::logic::{
    Account, AccountCheck, Chip, ChipState, Definition, Grouped, Row, Target, Transport, chip_line, edit_target, group_rows, intro_status,
    remove_targets, source_rank, summary, target_places, transport_line,
};
use super::sheet::{McpSheet, SaveFn};
use crate::settings::group::slug;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_22, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Checkbox, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError,
    SectionLabel, SpinnerRing,
};

/// How long one account's check takes in the fixture.
pub const CHECK_MS: u64 = 150;
/// The debounce between a write's event and the refresh it causes (`scheduleRefresh`).
pub const REFRESH_DEBOUNCE_MS: u64 = 50;
/// How long the fixture's browser sign-in takes.
pub const SIGN_IN_MS: u64 = 1500;
/// "Checked 12 s ago" keeps counting while the page is open.
const CLOCK_TICK_S: u64 = 5;

/// `check` keeps the last answer while `checking` is set, so rows stay on screen during a re-check.
#[derive(Clone)]
struct Entry {
    account: Account,
    check: Option<AccountCheck>,
    checking: bool,
}

pub struct McpView {
    pub(crate) host: Host,
    entries: Vec<Entry>,
    error: String,
    open: Option<String>,
    other_open: bool,
    confirming: Option<String>,
    signing_in: BTreeSet<String>,
    sign_in_runs: BTreeMap<String, u64>,
    /// A new URL server waiting for the refresh its save triggers, to start "Add and sign in".
    pending_sign_in: Option<String>,
    run: u64,
    refresh_run: u64,
    now_s: u64,
    checked_at_s: Option<u64>,
    found: Option<String>,
    sheet_open_at_start: bool,
    sheet: Option<Entity<McpSheet>>,
}

impl McpView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let host = Host::fixture();
        let entries = host
            .accounts()
            .into_iter()
            .map(|account| {
                let check = Some(host.check(&account));
                Entry { account, check, checking: false }
            })
            .collect();
        let view = Self {
            host,
            entries,
            error: String::new(),
            open: None,
            other_open: false,
            confirming: None,
            signing_in: BTreeSet::new(),
            sign_in_runs: BTreeMap::new(),
            pending_sign_in: None,
            run: 0,
            refresh_run: 0,
            now_s: 0,
            checked_at_s: Some(0),
            found: None,
            sheet_open_at_start: std::env::var("MILAGRE_GPUI_MCP_SHEET").is_ok(),
            sheet: None,
        };
        view.start_clock(cx);
        view
    }

    fn start_clock(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(CLOCK_TICK_S)).await;
                if this
                    .update(cx, |this, cx| {
                        this.now_s += CLOCK_TICK_S;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    /// The row a Settings search result lit up.
    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    /// The sheet last opened (it may have closed since).
    pub fn sheet(&self) -> Option<Entity<McpSheet>> {
        self.sheet.clone()
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    pub fn open_row(&self) -> Option<&str> {
        self.open.as_deref()
    }

    pub fn is_signing_in(&self, name: &str) -> bool {
        self.signing_in.contains(name)
    }

    pub fn checking(&self) -> bool {
        self.entries.iter().any(|entry| entry.checking)
    }

    pub fn rows(&self) -> Grouped {
        group_rows(&self.checks())
    }

    fn checks(&self) -> Vec<AccountCheck> {
        self.entries.iter().filter_map(|entry| entry.check.clone()).collect()
    }

    fn find_row(&self, name: &str) -> Option<Row> {
        let grouped = self.rows();
        grouped
            .user
            .into_iter()
            .chain(grouped.attention)
            .chain(grouped.other.into_iter().flat_map(|(_, rows)| rows))
            .find(|row| row.name == name)
    }

    // ---- reading the computer -------------------------------------------------------------------------------------

    /// The Refresh button: every account is checked again, each filling in as it answers.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.run += 1;
        let run = self.run;
        self.error.clear();
        let accounts = self.host.accounts();
        self.entries = accounts
            .iter()
            .map(|account| {
                let check = self.entries.iter().find(|entry| entry.account.key() == account.key()).and_then(|entry| entry.check.clone());
                Entry { account: account.clone(), check, checking: true }
            })
            .collect();
        cx.notify();
        cx.spawn(async move |this, cx| {
            for account in accounts {
                cx.background_executor().timer(Duration::from_millis(CHECK_MS)).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if this.run != run {
                            return false;
                        }
                        let check = this.host.check(&account);
                        if let Some(entry) = this.entries.iter_mut().find(|entry| entry.account.key() == account.key()) {
                            entry.check = Some(check);
                            entry.checking = false;
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    return;
                }
            }
            this.update(cx, |this, cx| {
                if this.run != run {
                    return;
                }
                this.checked_at_s = Some(this.now_s);
                this.after_refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// "Add and sign in": the accounts that now say the new server needs a sign-in get one.
    fn after_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(name) = self.pending_sign_in.take() else { return };
        if self.find_row(&name).is_some_and(|row| row.needs_sign_in()) {
            self.sign_in(&name, cx);
        }
    }

    /// Writes announce themselves, often several at once; one refresh answers them all.
    pub fn schedule_refresh(&mut self, cx: &mut Context<Self>) {
        self.refresh_run += 1;
        let run = self.refresh_run;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(REFRESH_DEBOUNCE_MS)).await;
            this.update(cx, |this, cx| {
                if this.refresh_run == run {
                    this.refresh(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// One account's check, after a toggle: the others keep their answers.
    fn recheck_account(&mut self, account: &Account, cx: &mut Context<Self>) {
        let run = self.run;
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.account.key() == account.key()) {
            entry.checking = true;
        }
        let account = account.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(CHECK_MS)).await;
            this.update(cx, |this, cx| {
                if this.run != run {
                    return;
                }
                let check = this.host.check(&account);
                if let Some(entry) = this.entries.iter_mut().find(|entry| entry.account.key() == account.key()) {
                    entry.check = Some(check);
                    entry.checking = false;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---- writes ---------------------------------------------------------------------------------------------------

    fn toggle(&mut self, chip: &Chip, name: &str, on: bool, cx: &mut Context<Self>) {
        self.host.toggle(&chip.account, name, on);
        self.recheck_account(&chip.account, cx);
    }

    pub fn sign_in(&mut self, name: &str, cx: &mut Context<Self>) {
        self.signing_in.insert(name.to_string());
        let run = self.sign_in_runs.entry(name.to_string()).or_default();
        *run += 1;
        let run = *run;
        let name = name.to_string();
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SIGN_IN_MS)).await;
            this.update(cx, |this, cx| {
                if this.sign_in_runs.get(&name) != Some(&run) || !this.signing_in.remove(&name) {
                    return;
                }
                this.host.finish_sign_in(&name);
                this.schedule_refresh(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn cancel_sign_in(&mut self, name: &str, cx: &mut Context<Self>) {
        self.signing_in.remove(name);
        *self.sign_in_runs.entry(name.to_string()).or_default() += 1;
        cx.notify();
    }

    /// Every config is tried, even after one fails; the failures are reported once, by place.
    pub fn remove_row(&mut self, name: &str, cx: &mut Context<Self>) {
        self.error.clear();
        self.confirming = None;
        let Some(row) = self.find_row(name) else { return };
        let mut failed: Vec<(Target, String)> = Vec::new();
        for target in remove_targets(&row) {
            if let Err(message) = self.host.remove(name, target) {
                failed.push((target, message));
            }
        }
        if !failed.is_empty() {
            let places = target_places(&failed.iter().map(|(target, _)| *target).collect::<Vec<_>>());
            let reasons = failed.iter().map(|(_, message)| message.as_str()).collect::<Vec<_>>().join(" ");
            self.error = format!("Couldn’t remove {name} from {places}. {reasons}");
        }
        self.schedule_refresh(cx);
        cx.notify();
    }

    /// The sheet's Add or Save.
    pub fn save(
        &mut self,
        def: Definition,
        target: Target,
        previous: Option<(String, Target)>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        // Only a new URL server added here signs in straight away.
        self.pending_sign_in = (def.is_url() && previous.is_none()).then(|| def.name().to_string());
        let result = self.host.save(def, target, previous.as_ref().map(|(name, target)| (name.as_str(), *target)));
        if result.is_err() {
            self.pending_sign_in = None;
            return result;
        }
        self.schedule_refresh(cx);
        Ok(())
    }

    fn save_fn(cx: &mut Context<Self>) -> SaveFn {
        let this = cx.entity();
        Rc::new(move |def, target, previous, cx: &mut App| this.update(cx, |view, cx| view.save(def, target, previous, cx)))
    }

    pub fn open_sheet(
        &mut self,
        initial: Option<(Definition, Target)>,
        previous: Option<(String, Target)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let on_save = Self::save_fn(cx);
        self.sheet = Some(McpSheet::open(initial, previous, false, on_save, window, cx));
    }

    fn edit(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.error.clear();
        let Some(row) = self.find_row(name) else { return };
        let target = edit_target(&row);
        match self.host.definition(name, target) {
            Some(def) => self.open_sheet(Some((def, target)), Some((name.to_string(), target)), window, cx),
            None => {
                self.error = "Couldn’t read this server’s settings. Edit it in its CLI config.".to_string();
                cx.notify();
            }
        }
    }

    fn toggle_open(&mut self, name: &str, cx: &mut Context<Self>) {
        self.open = if self.open.as_deref() == Some(name) { None } else { Some(name.to_string()) };
        self.confirming = None;
        cx.notify();
    }
}

// ---- drawing ------------------------------------------------------------------------------------------------------

fn card(theme: &Theme, rows: Vec<AnyElement>) -> AnyElement {
    let mut card = div().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.surface).overflow_hidden().flex().flex_col();
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
        }
        card = card.child(row);
    }
    card.into_any_element()
}

fn tile(row: &Row, warn: bool, theme: &Theme) -> AnyElement {
    let icon = if row.transport == Transport::Command { IconName::CommandLine } else { IconName::Globe02 };
    let (fill, ink) = if warn { (theme.orange_tint, theme.orange_ink) } else { (theme.hover, theme.ink2) };
    div()
        .size(px(32.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(RADIUS_CONTROL)
        .bg(fill)
        .child(Icon::new(icon).size(IconSize::S16).color(ink))
        .into_any_element()
}

fn failed_mark(theme: &Theme) -> AnyElement {
    div()
        .debug_selector(|| "mcp-failed".into())
        .flex()
        .flex_none()
        .child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.red_ink))
        .into_any_element()
}

fn title_lines(title: String, subtitle: String, subtitle_red: bool, theme: &Theme) -> AnyElement {
    div()
        .min_w_0()
        .flex_1()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title))
        .child(div().truncate().text_step(TEXT_12).text_color(if subtitle_red { theme.red_ink } else { theme.ink3 }).child(subtitle))
        .into_any_element()
}

impl McpView {
    fn switch(&self, row: &Row, chip: &Chip, cx: &mut Context<Self>) -> AnyElement {
        let name = row.name.clone();
        let chip_value = chip.clone();
        let id = format!("mcp-switch-{}-{}", slug(&chip.key()), slug(&row.name));
        let page = cx.entity();
        Checkbox::new(SharedString::from(id), chip.state != ChipState::Disabled)
            .disabled(chip.disabled_by_provider)
            .on_toggle(move |on, _, cx| page.update(cx, |this, cx| this.toggle(&chip_value, &name, on, cx)))
            .into_any_element()
    }

    fn account_lines(&self, row: &Row, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        row.chips
            .iter()
            .map(|chip| {
                let failed = chip.state == ChipState::Failed;
                div()
                    .min_h(px(40.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(div().w(px(256.0)).flex_none().truncate().text_step(TEXT_13).text_color(theme.ink).child(chip.account_name()))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .truncate()
                            .text_step(TEXT_12)
                            .text_color(if failed { theme.red_ink } else { theme.ink3 })
                            .child(chip_line(chip)),
                    )
                    .child(self.switch(row, chip, cx))
                    .into_any_element()
            })
            .collect()
    }

    fn sign_in_row(&self, row: &Row, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let signing_in = self.signing_in.contains(&row.name);
        let name = row.name.clone();
        let subtitle = if signing_in {
            "Finish in your browser, then come back.".to_string()
        } else {
            transport_line(row.transport, row.detail.as_deref())
        };
        let action = if signing_in {
            let name = name.clone();
            Button::new(SharedString::from(format!("mcp-cancel-{}", slug(&row.name))), "Cancel")
                .variant(ButtonVariant::Secondary)
                .on_click(cx.listener(move |this, _, _, cx| this.cancel_sign_in(&name, cx)))
                .into_any_element()
        } else {
            let name = name.clone();
            Button::new(SharedString::from(format!("mcp-sign-in-{}", slug(&row.name))), "Sign in")
                .on_click(cx.listener(move |this, _, _, cx| this.sign_in(&name, cx)))
                .into_any_element()
        };
        let slug_name = slug(&row.name);
        div()
            .debug_selector(move || format!("mcp-attention-{slug_name}"))
            .flex()
            .items_center()
            .gap(px(12.0))
            .when(compact, |d| d.min_h(px(48.0)).px(px(12.0)).py(px(8.0)))
            .when(!compact, |d| d.min_h(px(60.0)).px(px(16.0)).py(px(12.0)))
            .when(!compact, |d| d.child(tile(row, true, &theme)))
            .child(title_lines(row.short_name(), subtitle, false, &theme))
            .child(action)
            .into_any_element()
    }

    fn server_row(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let open = self.open.as_deref() == Some(row.name.as_str());
        let failed = row.failed_chip();
        let subtitle = match failed {
            Some(chip) => format!("{}: {}", chip.account.provider.name(), chip.error.clone().unwrap_or_else(|| "Failed".to_string())),
            None => transport_line(row.transport, row.detail.as_deref()),
        };
        let name = row.name.clone();
        let slug_name = slug(&row.name);
        let head = div()
            .id(SharedString::from(format!("mcp-row-head-{slug_name}")))
            .debug_selector({
                let head = format!("mcp-row-head-{slug_name}");
                move || head.clone()
            })
            .min_h(px(60.0))
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .px(px(16.0))
            .py(px(12.0))
            .cursor_pointer()
            .hover(|s| s.bg(theme.hover2))
            .on_click({
                let name = name.clone();
                cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_open(&name, cx))
            })
            .child(tile(row, false, &theme))
            .child(title_lines(row.name.clone(), subtitle, failed.is_some(), &theme))
            .when(row.everywhere, |d| {
                d.child(
                    div()
                        .rounded(RADIUS_CHIP)
                        .bg(theme.field)
                        .px(px(8.0))
                        .py(px(2.0))
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink2)
                        .child("Everywhere"),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .when(failed.is_some(), |d| d.child(failed_mark(&theme)))
                    .child(summary(row)),
            )
            .child(chevron(open, &theme));
        let sel = format!("mcp-row-{slug_name}");
        let mut out = div().debug_selector(move || sel.clone()).flex().flex_col().child(head);
        if open {
            let places = target_places(&remove_targets(row));
            let confirming = self.confirming.as_deref() == Some(row.name.as_str());
            let footer = if confirming {
                let remove_name = name.clone();
                div()
                    .debug_selector(|| "mcp-remove-question".into())
                    .mt(px(4.0))
                    .min_h(px(44.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .text_step(TEXT_12)
                            .text_color(theme.ink)
                            .child(format!("Remove {} from {places}? Chats stop loading it.", row.name)),
                    )
                    .child(Button::new("mcp-remove-cancel", "Cancel").variant(ButtonVariant::Secondary).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.confirming = None;
                            cx.notify();
                        },
                    )))
                    .child(
                        Button::new("mcp-remove-confirm", "Remove")
                            .variant(ButtonVariant::Danger)
                            .on_click(cx.listener(move |this, _, _, cx| this.remove_row(&remove_name, cx))),
                    )
            } else {
                let edit_name = name.clone();
                let ask_name = name.clone();
                div()
                    .mt(px(4.0))
                    .min_h(px(44.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().min_w_0().flex_1().text_step(TEXT_12).text_color(theme.ink3).child(if row.everywhere {
                        "Everywhere adds it to providers whose config lacks it."
                    } else {
                        ""
                    }))
                    .child(
                        Button::new("mcp-edit", "Edit")
                            .variant(ButtonVariant::Secondary)
                            .on_click(cx.listener(move |this, _, window, cx| this.edit(&edit_name, window, cx))),
                    )
                    .child(Button::new("mcp-remove", "Remove").variant(ButtonVariant::DangerGhost).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.confirming = Some(ask_name.clone());
                            cx.notify();
                        },
                    )))
            };
            out = out
                .child(div().px(px(16.0)).pt(px(4.0)).pb(px(12.0)).flex().flex_col().children(self.account_lines(row, cx)).child(footer));
        }
        out.into_any_element()
    }

    /// A row set up outside Milagre. One account: its line and switch sit on the row. Several: it opens like a
    /// server row.
    fn outside_row(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let failed = row.chips.iter().any(|chip| chip.state == ChipState::Failed);
        let name_block = title_lines(row.short_name(), transport_line(row.transport, row.detail.as_deref()), false, &theme);
        let sel = format!("mcp-row-{}", slug(&row.name));
        if let [only] = row.chips.as_slice() {
            let line = if only.state == ChipState::Connected {
                format!("{} · {} tools", only.account.provider.name(), only.tools)
            } else {
                chip_line(only)
            };
            return div()
                .debug_selector(move || sel.clone())
                .min_h(px(48.0))
                .flex()
                .items_center()
                .gap(px(12.0))
                .px(px(12.0))
                .py(px(8.0))
                .child(name_block)
                .child(
                    div()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .truncate()
                        .text_step(TEXT_12)
                        .text_color(if failed { theme.red_ink } else { theme.ink3 })
                        .when(failed, |d| d.child(failed_mark(&theme)))
                        .child(line),
                )
                .child(self.switch(row, only, cx))
                .into_any_element();
        }
        let open = self.open.as_deref() == Some(row.name.as_str());
        let name = row.name.clone();
        let head = div()
            .id(SharedString::from(format!("mcp-row-head-{}", slug(&row.name))))
            .debug_selector({
                let head = format!("mcp-row-head-{}", slug(&row.name));
                move || head.clone()
            })
            .min_h(px(48.0))
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .px(px(12.0))
            .py(px(8.0))
            .cursor_pointer()
            .hover(|s| s.bg(theme.hover2))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_open(&name, cx)))
            .child(name_block)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .when(failed, |d| d.child(failed_mark(&theme)))
                    .child(summary(row)),
            )
            .child(chevron(open, &theme));
        div()
            .debug_selector(move || sel.clone())
            .flex()
            .flex_col()
            .child(head)
            .when(open, |d| d.child(div().px(px(12.0)).pb(px(8.0)).flex().flex_col().children(self.account_lines(row, cx))))
            .into_any_element()
    }

    fn outside_header(&self, count: usize, attention: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let count_text = if attention > 0 { format!("{count} · {attention} needs sign-in") } else { count.to_string() };
        div()
            .id("mcp-other")
            .debug_selector(|| "mcp-other".into())
            .min_h(px(52.0))
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.0))
            .px(px(16.0))
            .cursor_pointer()
            .hover(|s| s.bg(theme.hover2))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.other_open = !this.other_open;
                cx.notify();
            }))
            .child(Icon::new(IconName::FolderGit).size(IconSize::S16).color(theme.ink2))
            .child(
                div()
                    .flex_1()
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .child("From Projects, plugins and claude.ai"),
            )
            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(count_text))
            .child(chevron(self.other_open, &theme))
            .into_any_element()
    }

    fn outside_groups(&self, grouped: &Grouped, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let outside_attention: Vec<&Row> = grouped.attention.iter().filter(|row| !row.editable).collect();
        let mut sources: Vec<String> =
            outside_attention.iter().map(|row| row.source.clone().unwrap_or_else(|| "Built in".to_string())).collect();
        sources.extend(grouped.other.iter().map(|(source, _)| source.clone()));
        sources.sort();
        sources.dedup();
        sources.sort_by(|a, b| source_rank(a).cmp(&source_rank(b)).then_with(|| a.cmp(b)));
        let groups = sources.into_iter().map(|source| {
            let attention: Vec<&Row> =
                outside_attention.iter().copied().filter(|row| row.source.as_deref().unwrap_or("Built in") == source).collect();
            let rows: Vec<&Row> =
                grouped.other.iter().find(|(s, _)| *s == source).map(|(_, rows)| rows.iter().collect()).unwrap_or_default();
            let where_ = if source == "claude.ai connectors" {
                Button::new("mcp-manage-claude-ai", "Manage on claude.ai")
                    .variant(ButtonVariant::Link)
                    .size(ButtonSize::S24)
                    .on_click(|_, _, cx| cx.open_url("https://claude.ai/settings/connectors"))
                    .into_any_element()
            } else if source == "Project" {
                div().text_step(TEXT_12).text_color(theme.ink3).child(".mcp.json").into_any_element()
            } else if source.starts_with("Plugin") {
                div().text_step(TEXT_12).text_color(theme.ink3).child("Claude Code plugin").into_any_element()
            } else {
                div().into_any_element()
            };
            let mut cards: Vec<AnyElement> = attention.iter().map(|row| self.sign_in_row(row, true, cx)).collect();
            cards.extend(rows.iter().map(|row| self.outside_row(row, cx)));
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .min_h(px(24.0))
                        .px(px(2.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(SectionLabel::new(source.clone()))
                        .child(where_),
                )
                .child(card(&theme, cards))
        });
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .px(px(16.0))
            .pt(px(12.0))
            .pb(px(16.0))
            .child(
                div()
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child("Set up outside Milagre. Turn them on or off here; change them where they live."),
            )
            .children(groups)
            .into_any_element()
    }
}

/// The disclosure arrow at a row's end.
fn chevron(open: bool, theme: &Theme) -> AnyElement {
    div()
        .flex_none()
        .child(Icon::new(if open { IconName::ArrowUp01 } else { IconName::ArrowDown01 }).size(IconSize::S16).color(theme.ink3))
        .into_any_element()
}

impl Render for McpView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.sheet_open_at_start {
            self.sheet_open_at_start = false;
            self.open_sheet(None, None, window, cx);
        }
        let theme = *cx.theme();
        let checking = self.entries.iter().any(|entry| entry.checking);
        let checks = self.checks();
        let problems: Vec<&AccountCheck> = checks.iter().filter(|check| check.problem.is_some()).collect();
        let grouped = group_rows(&checks);
        let own_attention: Vec<&Row> = grouped.attention.iter().filter(|row| row.editable).collect();
        let outside_attention = grouped.attention.iter().filter(|row| !row.editable).count();
        let outside_count = outside_attention + grouped.other.iter().map(|(_, rows)| rows.len()).sum::<usize>();
        let seconds = self.checked_at_s.map(|at| self.now_s.saturating_sub(at).max(1));

        let actions = div()
            .flex()
            .flex_none()
            .gap(px(8.0))
            .child(if checking {
                div()
                    .debug_selector(|| "mcp-refresh".into())
                    .size(px(32.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.surface)
                    .shadow(theme.shadow_btn())
                    .opacity(0.4)
                    .child(SpinnerRing::new().size(14.0).color(theme.ink2))
                    .into_any_element()
            } else {
                IconButton::new("mcp-refresh", IconName::Refresh)
                    .size(IconButtonSize::S32)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)))
                    .into_any_element()
            })
            .child(
                Button::new("mcp-add", "Add server")
                    .icon(IconName::Add01)
                    .on_click(cx.listener(|this, _, window, cx| this.open_sheet(None, None, window, cx))),
            );
        let intro = div()
            .text_step(TEXT_13)
            .text_color(theme.ink2)
            .child(format!("Tool servers your Chats load, for every account on this computer.{}", intro_status(checking, seconds)));

        let mut body = div().mt(px(24.0)).flex().flex_col().gap(px(24.0)).child(InlineError::new(self.error.clone()));
        if !problems.is_empty() {
            body = body.child(div().flex().flex_col().gap(px(4.0)).children(problems.iter().map(|check| {
                let key = slug(&check.account.key());
                div().debug_selector(move || format!("mcp-problem-{key}")).text_step(TEXT_12).text_color(theme.ink3).child(format!(
                    "{} · {}: {}",
                    check.account.provider.name(),
                    check.account.label,
                    check.problem.clone().unwrap_or_default()
                ))
            })));
        }
        if !own_attention.is_empty() {
            let rows = own_attention.iter().map(|row| self.sign_in_row(row, false, cx)).collect();
            body = body.child(
                div()
                    .debug_selector(|| "mcp-needs-sign-in".into())
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().px(px(4.0)).child(SectionLabel::new(format!("Needs sign-in · {}", own_attention.len()))))
                    .child(card(&theme, rows)),
            );
        }
        if !grouped.user.is_empty() {
            let rows = grouped.user.iter().map(|row| self.server_row(row, cx)).collect();
            body = body.child(
                div()
                    .debug_selector(|| "mcp-your-servers".into())
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().px(px(4.0)).child(SectionLabel::new(format!("Your servers · {}", grouped.user.len()))))
                    .child(card(&theme, rows)),
            );
        }
        if outside_count > 0 {
            let mut outside = div()
                .debug_selector(|| "mcp-outside".into())
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .bg(theme.surface)
                .overflow_hidden()
                .flex()
                .flex_col()
                .child(self.outside_header(outside_count, outside_attention, cx));
            if self.other_open {
                outside = outside.child(self.outside_groups(&grouped, cx));
            }
            body = body.child(outside);
        }
        if !checking && grouped.attention.is_empty() && grouped.user.is_empty() && grouped.other.is_empty() && problems.is_empty() {
            body = body.child(EmptyState::new().title("No MCP servers yet").help("Add one with Add server."));
        }

        div()
            .debug_selector(|| "settings-section-mcp".into())
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(16.0))
                    .child(div().text_step(TEXT_22).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("MCP servers"))
                    .child(actions),
            )
            .child(div().mt(px(20.0)).child(intro))
            .child(body)
    }
}
