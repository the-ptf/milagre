//! The PR header (`Header` in `PullRequestPanel.tsx`): repository and number, the merge action and the ⋯ menu, the
//! title, state pill, author and age, branches and counts, the status line and the work the PR does not have yet.

use gpui::{AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement, div, prelude::*, px};

use super::avatar::avatar;
use super::model::{
    MergeMethod, PullRequestDetail, PullState, StatusTone, ago, can_merge_now, merge_status, not_in_pr_label, now_ms, repo_of,
};
use super::{Confirm, PrEvent, PrView};
use crate::logic::prs::blockers::{PrState, pull_request_state_pill};
use crate::theme::{ActiveTheme, RADIUS_CHIP, TEXT_11, TEXT_12, TEXT_15, TextStepExt, Theme, mono};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Dismiss, Icon, IconButton, IconButtonSize, IconName, IconSize, MenuList, MenuRow, Popover, Tooltip,
};
use crate::workspace::panel::changes::files::counts_inline;

/// What the status line under the branch says in which colours, by tone (`STATUS_LINE`).
fn status_style(theme: &Theme, tone: StatusTone) -> Option<(IconName, gpui::Rgba, gpui::Rgba)> {
    match tone {
        StatusTone::Blocked => Some((IconName::AlertCircle, theme.red_ink, theme.red_ink)),
        StatusTone::Draft => Some((IconName::GitPullRequestDraft, theme.ink3, theme.ink)),
        StatusTone::Merged => Some((IconName::GitMerge, theme.purple_ink, theme.purple_ink)),
        StatusTone::Closed => Some((IconName::GitPullRequestClosed, theme.red_ink, theme.red_ink)),
        StatusTone::Ready | StatusTone::Pending => None,
    }
}

/// The pill's fill and ink by the palette key `pullRequestStatePill` names.
fn palette(theme: &Theme, key: &str) -> gpui::Rgba {
    match key {
        "purpleTint" => theme.purple_tint,
        "purpleInk" => theme.purple_ink,
        "redTint" => theme.red_tint,
        "redInk" => theme.red_ink,
        "hover" => theme.hover,
        _ => theme.ink2,
    }
}

fn pill_icon(label: &str) -> IconName {
    match label {
        "Merged" => IconName::GitMerge,
        "Closed" => IconName::GitPullRequestClosed,
        _ => IconName::GitPullRequestDraft,
    }
}

fn pr_state(state: PullState) -> PrState {
    match state {
        PullState::Open => PrState::Open,
        PullState::Merged => PrState::Merged,
        PullState::Closed => PrState::Closed,
    }
}

impl PrView {
    pub(super) fn header(&self, pr: &PullRequestDetail, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let now = now_ms();
        let open = pr.state == PullState::Open;
        let pill = pull_request_state_pill(pr_state(pr.state), pr.is_draft);
        let status = merge_status(pr);
        let line = status_style(&theme, status.tone);
        let not_in_pr = if open { not_in_pr_label(self.local_files, pr.local_commits as usize) } else { String::new() };
        let url = pr.url.clone();

        let link = div()
            .id("pr-link")
            .debug_selector(|| "pr-link".to_string())
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(4.0))
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .cursor_pointer()
            .hover(move |style| style.text_color(theme.ink))
            .on_click({
                let url = url.clone();
                move |_, _, cx| cx.open_url(&url)
            })
            .child(div().min_w_0().truncate().child(repo_of(&pr.url).unwrap_or_default()))
            .child(div().flex_none().text_color(theme.accent_ink).child(format!("#{}", pr.number)))
            .child(Icon::new(IconName::LinkSquare02).size(IconSize::S12).color(theme.accent_ink));

        let row = div()
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(8.0))
            .child(link)
            .child(div().flex_1())
            .children(self.primary_action(pr, status.tone == StatusTone::Ready, cx))
            .child(self.more_button(cx));

        let title =
            div().debug_selector(|| "pr-title".to_string()).text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).child(pr.title.clone());

        let state_pill = pill.map(|pill| {
            let (fill, ink) = (palette(&theme, pill.fill), palette(&theme, pill.ink));
            div()
                .debug_selector({
                    let name = format!("pr-state-pill-{}", pill.label);
                    move || name.clone()
                })
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.0))
                .px(px(8.0))
                .py(px(1.0))
                .rounded_full()
                .bg(fill)
                .text_color(ink)
                .text_step(TEXT_11)
                .font_weight(FontWeight::SEMIBOLD)
                .child(Icon::new(pill_icon(pill.label)).size(IconSize::S12).color(ink))
                .child(pill.label)
        });
        let byline = div()
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .text_step(TEXT_12)
            .children(state_pill)
            .child(avatar(&theme, &pr.author, 20.0, false))
            .child(div().flex_none().font_weight(FontWeight::SEMIBOLD).child(pr.author.clone()))
            .child(div().min_w_0().truncate().text_color(theme.ink3).child(format!("\u{b7} updated {}", ago(pr.updated_at, now))));

        let branches = div()
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .text_step(TEXT_12)
            .child(
                div()
                    .debug_selector(|| "pr-branches".to_string())
                    .min_w_0()
                    .truncate()
                    .font_family(mono())
                    .text_step(TEXT_11)
                    .text_color(theme.ink3)
                    .child(
                        div()
                            .flex()
                            .child(div().text_color(theme.ink2).child(pr.base_ref_name.clone()))
                            .child(format!(" \u{2190} {}", pr.head_ref_name)),
                    ),
            )
            .child(div().flex_1())
            .child(div().flex_none().text_color(theme.ink2).child(format!(
                "{} file{}",
                pr.changed_files,
                if pr.changed_files == 1 { "" } else { "s" }
            )))
            .child(counts_inline(&theme, pr.additions, pr.deletions));

        let status_row = line.map(|(icon, icon_ink, title_ink)| {
            div()
                .debug_selector(|| "pr-status".to_string())
                .flex()
                .min_w_0()
                .items_start()
                .gap(px(6.0))
                .text_step(TEXT_12)
                .child(div().flex().flex_none().h(px(16.0)).items_center().child(Icon::new(icon).size(IconSize::S14).color(icon_ink)))
                .child(
                    div().min_w_0().text_color(theme.ink2).child(
                        div()
                            .flex()
                            .flex_wrap()
                            .child(div().font_weight(FontWeight::SEMIBOLD).text_color(title_ink).child(status.title))
                            .child(format!(" \u{b7} {}", status.detail)),
                    ),
                )
        });

        let local = (!not_in_pr.is_empty()).then(|| {
            let view = cx.entity();
            div()
                .id("pr-local")
                .debug_selector(|| "pr-local".to_string())
                .flex()
                .min_w_0()
                .items_center()
                .gap(px(6.0))
                .self_start()
                .mx(px(-4.0))
                .px(px(4.0))
                .rounded(RADIUS_CHIP)
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .cursor_pointer()
                .hover(move |style| style.bg(theme.hover).text_color(theme.ink))
                .on_click(move |_, _, cx| view.update(cx, |_, cx| cx.emit(PrEvent::OpenChanges)))
                .child(Icon::new(IconName::CloudUpload).size(IconSize::S14).color(theme.ink3))
                .child(div().truncate().child(format!("{} not in the PR yet", not_in_pr.replace(" \u{b7} ", " and "))))
                .child(Icon::new(IconName::ArrowRight01).size(IconSize::S12).color(theme.ink3))
        });

        let error = self.write_error.as_ref().map(|message| {
            div().debug_selector(|| "pr-write-error".to_string()).text_step(TEXT_12).text_color(theme.red_ink).child(message.clone())
        });

        div()
            .debug_selector(|| "pr-identity".to_string())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(12.0))
            .py(px(12.0))
            .child(row)
            .child(title)
            .child(byline)
            .child(branches)
            .children(status_row)
            .children(local)
            .children(error)
            .into_any_element()
    }

    /// The header's one action: Ready for review, Merge, "Merges when ready" or Merge when ready.
    fn primary_action(&self, pr: &PullRequestDetail, ready: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = *cx.theme();
        let view = cx.entity();
        let busy = self.busy.is_some();
        let open = pr.state == PullState::Open;
        let conflicts = pr.merge_state_status == "DIRTY";
        if open && pr.is_draft {
            return Some(
                Button::new("pr-ready", "Ready for review")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .disabled(busy)
                    .selector("pr-ready")
                    .on_click(move |_, _, cx| view.update(cx, |this, cx| this.set_draft(false, cx)))
                    .into_any_element(),
            );
        }
        if open && can_merge_now(pr) {
            let label = if self.busy == Some("merge") {
                "Merging\u{2026}"
            } else if self.confirming == Some(Confirm::Merge) {
                "Confirm merge"
            } else {
                "Merge"
            };
            // GitHub lets an UNSTABLE PR merge past failing optional checks: only a ready PR gets the primary button.
            return Some(
                Button::new("pr-merge", label)
                    .variant(if ready { ButtonVariant::Primary } else { ButtonVariant::Secondary })
                    .size(ButtonSize::S28)
                    .icon(IconName::GitMerge)
                    .disabled(busy)
                    .selector("pr-merge")
                    .on_click(move |_, _, cx| view.update(cx, |this, cx| this.merge(false, cx)))
                    .into_any_element(),
            );
        }
        if open && pr.auto_merge.is_some() {
            return Some(
                div()
                    .debug_selector(|| "pr-auto-merge".to_string())
                    .flex()
                    .flex_none()
                    .h(px(28.0))
                    .items_center()
                    .gap(px(6.0))
                    .px(px(4.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(Icon::new(IconName::GitMerge).size(IconSize::S14).color(theme.ink2))
                    .child("Merges when ready")
                    .into_any_element(),
            );
        }
        if open && !conflicts {
            return Some(
                Button::new("pr-auto", "Merge when ready")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .icon(IconName::GitMerge)
                    .disabled(busy)
                    .selector("pr-auto")
                    .on_click(move |_, _, cx| view.update(cx, |this, cx| this.set_auto_merge(true, cx)))
                    .into_any_element(),
            );
        }
        None
    }

    fn more_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity();
        div()
            .id("pr-more-tip")
            .flex_none()
            .debug_selector(|| "pr-more".to_string())
            .tooltip(Tooltip::text("More actions"))
            .child(
                Popover::new("pr-more-menu")
                    .trigger(|open| {
                        IconButton::new("pr-more-button", IconName::MoreHorizontal)
                            .size(IconButtonSize::S28)
                            .glyph(IconSize::S16)
                            .pressed(open)
                            .into_any_element()
                    })
                    .content(move |dismiss, _window, cx| more_menu(&view, dismiss, cx)),
            )
            .into_any_element()
    }
}

/// The ⋯ menu: merge anyway, auto-merge off, the merge method, convert to draft, open on GitHub, copy link.
/// Read from the view every time the popover draws, so a pressed "Merge anyway" shows its confirm.
fn more_menu(view: &Entity<PrView>, dismiss: &Dismiss, cx: &mut App) -> AnyElement {
    let this = view.read(cx);
    let Some(pr) = this.detail.clone() else { return div().into_any_element() };
    let (busy, confirming, method) = (this.busy.is_some(), this.confirming, this.method());
    let open = pr.state == PullState::Open;
    let conflicts = pr.merge_state_status == "DIRTY";
    let mut menu = MenuList::new("pr-menu");
    let mut grouped = false;
    if open && !pr.is_draft && !can_merge_now(&pr) && !conflicts && pr.viewer_can_merge_as_admin {
        let (view, dismiss) = (view.clone(), dismiss.clone());
        let confirm = confirming == Some(Confirm::Admin);
        menu = menu.row(
            MenuRow::new("pr-merge-anyway", if confirm { "Confirm merge anyway" } else { "Merge anyway" })
                .subtitle("Skips the rules that block it")
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    if confirm {
                        dismiss.call(window, cx);
                    }
                    view.update(cx, |this, cx| this.merge(true, cx));
                    window.refresh();
                }),
        );
        grouped = true;
    }
    if open && pr.auto_merge.is_some() {
        let (view, dismiss) = (view.clone(), dismiss.clone());
        menu = menu.row(MenuRow::new("pr-auto-off", "Turn off auto-merge").disabled(busy).on_click(move |_, window, cx| {
            dismiss.call(window, cx);
            view.update(cx, |this, cx| this.set_auto_merge(false, cx));
        }));
        grouped = true;
    }
    if open && !pr.is_draft {
        if grouped {
            menu = menu.separator();
        }
        menu = menu.label("Merge method");
        for entry in MergeMethod::ALL {
            let view = view.clone();
            menu = menu.row(MenuRow::new(format!("pr-method-{}", entry.key()), entry.label()).checked(entry == method).on_click(
                move |_, window, cx| {
                    view.update(cx, |this, cx| this.set_method(entry, cx));
                    window.refresh();
                },
            ));
        }
        let (view, dismiss) = (view.clone(), dismiss.clone());
        menu = menu.separator().row(MenuRow::new("pr-draft", "Convert to draft").disabled(busy).on_click(move |_, window, cx| {
            dismiss.call(window, cx);
            view.update(cx, |this, cx| this.set_draft(true, cx));
        }));
        grouped = true;
    }
    if grouped {
        menu = menu.separator();
    }
    let (url, dismiss_open) = (pr.url.clone(), dismiss.clone());
    menu = menu.row(MenuRow::new("pr-open-github", "Open on GitHub").on_click(move |_, window, cx| {
        dismiss_open.call(window, cx);
        cx.open_url(&url);
    }));
    let (url, dismiss_copy) = (pr.url.clone(), dismiss.clone());
    menu = menu.row(MenuRow::new("pr-copy-link", "Copy link").on_click(move |_, window, cx| {
        dismiss_copy.call(window, cx);
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url.clone()));
    }));
    div().w(px(220.0)).child(menu).into_any_element()
}
