//! Settings › Integrations (WP-43: `IntegrationsSettings` and `LinearSettings` in `Settings.tsx`,
//! `settings/BabysitPrsSettings.tsx`, `packages/shared/src/babysit.mjs` and `linear.ts`; G-18): the services
//! Milagre signs in to (Linear: a switch, one row per workspace, Move issues to In Progress, Add workspace) and
//! Babysit PRs, which opens its own page with an autosaving form.
//!
//! Without a data layer [`linear::LinearState`] and [`babysit::BabysitHost`] stand in for `linear:*` and
//! `babysit:settings:*`. With one ([`crate::settings::host::SettingsHost`]) the page reads `linear:enabled:read`,
//! `linear:status` and `babysit:settings:read` each time it shows, and writes with Electron's commands: `linear:enabled:save
//! [bool]`, `linear:move-to-started:save [bool]`, `linear:connect [{window: false}]` (the host opens the sign-in in the
//! system browser), `linear:disconnect [{workspace}]` and `babysit:settings:save [patch]`.

pub mod babysit;
pub mod babysit_model;
pub mod linear;

#[cfg(test)]
mod tests;

use gpui::{Context, FontWeight, IntoElement, ParentElement, Render, Styled, Window, div, prelude::*, px};

pub use babysit::{AUTOSAVE_MS, BabysitHost, BabysitState, Field, SAVE_MS};
pub use linear::LinearState;

use crate::settings::group::SettingsGroup;
use crate::theme::{ActiveTheme, TEXT_13, TEXT_22, TextStepExt};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Integrations,
    BabysitPrs,
}

pub struct IntegrationsView {
    page: Page,
    pub(crate) linear: LinearState,
    pub(crate) babysit: BabysitState,
    found: Option<String>,
    /// The host's visit this page last read at ([`crate::settings::host::visit`]).
    seen_visit: Option<u64>,
}

impl IntegrationsView {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self {
            page: if std::env::var("MILAGRE_GPUI_BABYSIT").is_ok() { Page::BabysitPrs } else { Page::Integrations },
            linear: LinearState::default(),
            babysit: BabysitState::default(),
            found: None,
            seen_visit: None,
        }
    }

    /// Reads the page from the data layer's host when Settings opened or came to it since the last read.
    pub fn visit(&mut self, cx: &mut Context<Self>) {
        let Some(visit) = crate::settings::host::visit(cx) else { return };
        if self.seen_visit == Some(visit) {
            return;
        }
        if self.seen_visit.is_none() {
            // Nothing from the fixture shows while the first read is on its way.
            self.linear = LinearState::unread();
        }
        self.seen_visit = Some(visit);
        self.read_linear(cx);
        self.read_babysit(cx);
    }

    /// The row a Settings search result lit up. A result inside Babysit PRs opens its page.
    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    pub fn page(&self) -> Page {
        self.page
    }

    pub fn open_babysit(&mut self, cx: &mut Context<Self>) {
        self.page = Page::BabysitPrs;
        cx.notify();
    }

    pub fn back(&mut self, cx: &mut Context<Self>) {
        self.flush_all(cx);
        self.page = Page::Integrations;
        cx.notify();
    }

    pub fn linear(&self) -> &LinearState {
        &self.linear
    }

    pub fn babysit_settings(&self) -> &babysit_model::Babysit {
        &self.babysit.settings
    }

    pub fn babysit_error(&self) -> &str {
        &self.babysit.error
    }
}

impl Render for IntegrationsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let found = self.found.clone();
        if self.page == Page::BabysitPrs {
            let form = self.babysit_form(found.as_deref(), window, cx);
            return div()
                .debug_selector(|| "babysit-prs-page".into())
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .child(
                            IconButton::new("babysit-back", IconName::ArrowLeft01)
                                .size(IconButtonSize::S28)
                                .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .text_step(TEXT_22)
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.ink)
                                .child(div().text_color(theme.ink3).child("Integrations"))
                                .child(Icon::new(IconName::ArrowRight01).size(IconSize::S16).color(theme.ink3))
                                .child("Babysit PRs"),
                        ),
                )
                .child(div().mt(px(12.0)).px(px(4.0)).child(InlineError::new(self.babysit.error.clone()).small()))
                .child(div().mt(px(20.0)).child(form))
                .into_any_element();
        }
        let mut linear_rows = self.linear_rows(found.as_deref(), cx);
        if let Some(error) = self.linear.error.clone() {
            linear_rows.push(
                div()
                    .debug_selector(|| "linear-error".into())
                    .px(px(16.0))
                    .py(px(12.0))
                    .text_step(crate::theme::TEXT_12)
                    .text_color(theme.red_ink)
                    .child(error)
                    .into_any_element(),
            );
        }
        let babysit_row = self.babysit_row(found.as_deref(), cx);
        div()
            .debug_selector(|| "settings-section-connections".into())
            .flex()
            .flex_col()
            .child(div().text_step(TEXT_22).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("Integrations"))
            .child(
                div()
                    .mt(px(4.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child("Services Milagre signs in to, so Chats can start from their issues and follow their pull requests."),
            )
            .child(
                div()
                    .mt(px(20.0))
                    .child(SettingsGroup::new().title("Issue trackers").highlighted_row(found.clone().map(Into::into)).rows(linear_rows))
                    .child(SettingsGroup::new().title("Pull requests").highlighted_row(found.map(Into::into)).row(babysit_row)),
            )
            .into_any_element()
    }
}
