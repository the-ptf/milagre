//! Settings › Worktrees (`WorktreesSettings`, `MainSyncDefaultSetting` in `Settings.tsx`): how new Worktrees follow
//! the source branch on every Project, and the review that cleans up the ones no Chat uses. Each Project's own page
//! sets its own.

use gpui::{AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::cleanup;
use super::logic::{CLEANUP_INTRO, CLEANUP_TITLE, MAIN_SYNC_HINT, MAIN_SYNC_TITLE};
use super::model::DevicesStore;
use super::view::DevicesView;
use super::widgets::group_footer;
use crate::settings::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant};

impl DevicesView {
    pub(super) fn worktrees_page(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let store = cx.global::<DevicesStore>().clone();
        let theme = *cx.theme();
        let found = self.found.clone();
        let found = found.as_deref();
        let hl = found.map(|f| SharedString::from(f.to_string()));
        div()
            .flex()
            .flex_col()
            .child(page_header("Worktrees", None, cx))
            .child(
                SettingsGroup::new().title("Main branch").highlighted_row(hl.clone()).row(
                    CheckboxRow::new("worktrees-main-sync", MAIN_SYNC_TITLE, store.main_sync_default)
                        .description(MAIN_SYNC_HINT)
                        .highlighted(found)
                        .on_change(|next, _, cx| cx.update_global::<DevicesStore, _>(|s, _| s.main_sync_default = next)),
                ),
            )
            .child(
                SettingsGroup::new().title("Storage").highlighted_row(hl).row(
                    SettingRow::new(CLEANUP_TITLE).description(CLEANUP_INTRO).highlighted(found).control(
                        Button::new("worktrees-cleanup", "Review")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .on_click(|_, window, cx| cleanup::open(None, window, cx)),
                    ),
                ),
            )
            .child(group_footer("Each Project's page sets how its new Worktrees are named and set up.", cx))
            .children(store.last_toast.map(|toast| {
                div()
                    .debug_selector(|| "worktrees-cleanup-result".into())
                    .mt(px(-12.0))
                    .px(px(4.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(toast)
            }))
            .into_any_element()
    }
}
