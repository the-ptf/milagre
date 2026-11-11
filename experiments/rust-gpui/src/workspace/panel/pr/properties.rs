//! The Summary's Reviewers and Labels rows with their pickers (`pr/Properties.tsx`). Each picker reads its options
//! when it opens and applies every toggle at once, showing it before GitHub answers.
//!
//! The pickers are drawn here, not with `ui::PickerPanel`: its rows take an icon name, and these carry an avatar
//! or a label-coloured dot. They keep the picker's metrics (32px rows, 48 with a description, 13 medium, a 14px tick
//! for the chosen) but not its arrow-key roving.

use gpui::{AnyElement, App, Context, Entity, FontWeight, Rgba, SharedString, Window, div, prelude::*, px, rgb};
use gpui_component::input::{InputEvent, InputState};

use super::PrView;
use super::avatar::avatar;
use super::bridge::Write;
use super::model::{Label, PullRequestDetail, PullState, RepoLabel, Reviewer, ReviewerState};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, Input, Popover, Tooltip};

/// A label's GitHub colour as a chip: a tint of it behind text mixed toward the ink, so it stays readable in both
/// themes (the desktop's `pr-label` class sets lightness per theme).
pub fn label_colors(theme: &Theme, hex: &str) -> (Rgba, Rgba) {
    let base = u32::from_str_radix(hex.trim_start_matches('#'), 16).map(rgb).unwrap_or(theme.ink3);
    let mix = |a: Rgba, b: Rgba, t: f32| Rgba { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1.0 };
    let fill = Rgba { a: 0.16, ..base };
    (fill, mix(base, theme.ink, 0.55))
}

/// A review's state as a badge on the reviewer's avatar: a glyph on a filled disc, not only a colour.
fn badge(theme: &Theme, state: ReviewerState) -> Option<(IconName, Rgba, Rgba)> {
    match state {
        ReviewerState::Approved => Some((IconName::Tick02, theme.green_ink, theme.on_green)),
        ReviewerState::ChangesRequested => Some((IconName::Cancel01, theme.red_ink, theme.on_red)),
        ReviewerState::Commented => Some((IconName::Comment01, theme.field, theme.ink2)),
        ReviewerState::Requested => Some((IconName::Clock01, theme.field, theme.ink2)),
        ReviewerState::Dismissed => None,
    }
}

fn reviewer_avatar(theme: &Theme, reviewer: &Reviewer) -> AnyElement {
    let disc = badge(theme, reviewer.state).map(|(icon, fill, ink)| {
        // A 14px disc in a 2px surface ring over the avatar's bottom-right corner.
        div()
            .absolute()
            .right(px(-10.0))
            .bottom(px(-10.0))
            .flex()
            .items_center()
            .justify_center()
            .size(px(18.0))
            .rounded_full()
            .bg(theme.surface)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(14.0))
                    .rounded_full()
                    .bg(fill)
                    .child(Icon::new(icon).size(IconSize::S12).color(ink)),
            )
    });
    div()
        .id(SharedString::from(format!("pr-reviewer-{}", reviewer.login)))
        .debug_selector({
            let name = format!("pr-reviewer-{}", reviewer.login);
            move || name.clone()
        })
        .relative()
        .flex()
        .when(reviewer.stale, |el| el.opacity(0.6))
        .tooltip(Tooltip::text(format!("{} \u{b7} {}", reviewer.login, reviewer.state.label())))
        .child(avatar(theme, &reviewer.login, 20.0, reviewer.team))
        .children(disc)
        .into_any_element()
}

/// A property row: its values wrap, its add button stays at the end of the first line.
fn property(
    theme: &Theme,
    id: &'static str,
    glyph: IconName,
    label: &'static str,
    action: Option<AnyElement>,
    values: impl IntoIterator<Item = AnyElement>,
) -> AnyElement {
    div()
        .debug_selector(move || id.to_string())
        .flex()
        .items_start()
        .gap(px(8.0))
        .min_h(px(32.0))
        .child(div().flex().flex_none().h(px(32.0)).items_center().child(Icon::new(glyph).size(IconSize::S14).color(theme.ink3)))
        .child(div().flex().flex_none().h(px(32.0)).w(px(76.0)).items_center().text_step(TEXT_12).text_color(theme.ink2).child(label))
        .child(div().flex().flex_1().min_w_0().min_h(px(32.0)).flex_wrap().items_center().gap(px(6.0)).py(px(4.0)).children(values))
        .children(action.map(|action| div().flex().flex_none().h(px(32.0)).items_center().child(action)))
        .into_any_element()
}

fn none_yet(theme: &Theme) -> AnyElement {
    div().text_step(TEXT_12).text_color(theme.ink3).child("None yet").into_any_element()
}

fn matches(text: &str, query: &str) -> bool {
    text.to_lowercase().contains(query.to_lowercase().trim())
}

/// What a picker row shows besides its leading glyph and label.
struct RowState {
    description: Option<String>,
    selected: bool,
    disabled: bool,
}

/// One picker row: leading glyph, label, optional description, a tick when chosen.
fn picker_row(
    theme: &Theme,
    id: SharedString,
    leading: AnyElement,
    label: &str,
    state: RowState,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let RowState { description, selected, disabled } = state;
    let hover2 = theme.hover2;
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(if description.is_some() { 48.0 } else { 32.0 }))
        .px(px(8.0))
        .rounded(RADIUS_INLINE)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| el.cursor_pointer().hover(move |style| style.bg(hover2)).on_click(move |_, window, cx| on_click(window, cx)))
        .child(div().flex().flex_none().items_center().justify_center().w(px(20.0)).child(leading))
        .child(div().flex().flex_col().flex_1().min_w_0().child(div().truncate().child(label.to_string())).children(
            description.map(|d| div().truncate().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(d)),
        ))
        .when(selected, |el| el.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink)))
        .into_any_element()
}

struct Search {
    input: Entity<InputState>,
    _typing: gpui::Subscription,
}

/// The picker's surface: search over a scrolling list, or `empty` when nothing matches.
fn picker(
    id: &'static str,
    placeholder: &'static str,
    empty: &'static str,
    rows: impl FnOnce(&str, &Theme, &mut App) -> Vec<AnyElement>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = *cx.theme();
    let search = window
        .use_keyed_state(SharedString::from(format!("{id}-search-state")), cx, |window, cx| {
            let input = Input::state(placeholder, window, cx);
            let _typing = cx.subscribe_in(&input, window, |_, _, event: &InputEvent, window, _| {
                if matches!(event, InputEvent::Change) {
                    window.refresh();
                }
            });
            Search { input, _typing }
        })
        .read(cx)
        .input
        .clone();
    let query = search.read(cx).value().to_string();
    let rows = rows(&query, &theme, cx);
    let empty_label =
        rows.is_empty().then(|| div().flex().justify_center().py(px(12.0)).text_step(TEXT_12).text_color(theme.ink3).child(empty));
    div()
        .id(id)
        .debug_selector(move || id.to_string())
        .flex()
        .flex_col()
        .w(px(260.0))
        .p(px(6.0))
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .text_color(theme.ink)
        .child(div().flex_none().mb(px(8.0)).child(Input::new(format!("{id}-search"), &search).leading(IconName::Search01)))
        .child(
            div()
                .id(SharedString::from(format!("{id}-list")))
                .flex()
                .flex_col()
                .gap(px(1.0))
                .max_h(px(256.0))
                .overflow_y_scroll()
                .children(rows),
        )
        .children(empty_label)
        .into_any_element()
}

impl PrView {
    pub(super) fn toggle_reviewer(&mut self, login: &str, cx: &mut Context<Self>) {
        let Some(pr) = &self.detail else { return };
        let add = !pr.reviewers.iter().any(|r| r.login == login);
        let (add_list, remove) = if add { (vec![login.to_string()], vec![]) } else { (vec![], vec![login.to_string()]) };
        self.write("reviewers", Write::Reviewers { add: add_list, remove }, cx);
    }

    pub(super) fn toggle_label(&mut self, label: &RepoLabel, cx: &mut Context<Self>) {
        let Some(pr) = &self.detail else { return };
        let add = !pr.labels.iter().any(|l| l.name == label.name);
        let write = if add {
            Write::Labels { add: vec![Label { name: label.name.clone(), color: label.color.clone() }], remove: vec![] }
        } else {
            Write::Labels { add: vec![], remove: vec![label.name.clone()] }
        };
        self.write("labels", write, cx);
    }

    pub(super) fn reviewers_row(&self, pr: &PullRequestDetail, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let add = (pr.state == PullState::Open).then(|| {
            Popover::new("pr-reviewers-picker")
                .bare()
                .width(px(260.0))
                .trigger(|open| {
                    IconButton::new("pr-reviewers-add", IconName::UserAdd01).size(IconButtonSize::S24).pressed(open).into_any_element()
                })
                .content(move |_dismiss, window, cx| {
                    let view = view.clone();
                    picker(
                        "pr-reviewers",
                        "Search people",
                        "No one found",
                        move |query, theme, cx| reviewer_rows(&view, query, theme, cx),
                        window,
                        cx,
                    )
                })
                .into_any_element()
        });
        let values: Vec<AnyElement> = if pr.reviewers.is_empty() {
            vec![none_yet(&theme)]
        } else {
            vec![
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .pl(px(2.0))
                    .children(pr.reviewers.iter().map(|reviewer| reviewer_avatar(&theme, reviewer)))
                    .into_any_element(),
            ]
        };
        property(&theme, "pr-reviewers", IconName::UserGroup, "Reviewers", add, values)
    }

    pub(super) fn labels_row(&self, pr: &PullRequestDetail, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let add = (pr.state == PullState::Open).then(|| {
            Popover::new("pr-labels-picker")
                .bare()
                .width(px(260.0))
                .trigger(|open| {
                    IconButton::new("pr-labels-add", IconName::PlusSign).size(IconButtonSize::S24).pressed(open).into_any_element()
                })
                .content(move |_dismiss, window, cx| {
                    let view = view.clone();
                    picker(
                        "pr-labels",
                        "Search labels",
                        "No labels",
                        move |query, theme, cx| label_rows(&view, query, theme, cx),
                        window,
                        cx,
                    )
                })
                .into_any_element()
        });
        let values: Vec<AnyElement> = if pr.labels.is_empty() {
            vec![none_yet(&theme)]
        } else {
            pr.labels
                .iter()
                .map(|label| {
                    let (fill, ink) = label_colors(&theme, &label.color);
                    div()
                        .debug_selector({
                            let name = format!("pr-label-{}", label.name);
                            move || name.clone()
                        })
                        .max_w_full()
                        .truncate()
                        .px(px(6.0))
                        .h(px(20.0))
                        .rounded(RADIUS_CHIP)
                        .bg(fill)
                        .text_color(ink)
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::MEDIUM)
                        .child(label.name.clone())
                        .into_any_element()
                })
                .collect()
        };
        property(&theme, "pr-labels", IconName::Tag01, "Labels", add, values)
    }
}

fn reviewer_rows(view: &Entity<PrView>, query: &str, theme: &Theme, cx: &mut App) -> Vec<AnyElement> {
    let this = view.read(cx);
    let Some(pr) = this.detail.clone() else { return Vec::new() };
    let mut logins: Vec<String> = pr.reviewers.iter().map(|reviewer| reviewer.login.clone()).collect();
    for candidate in this.bridge.reviewer_candidates() {
        if !logins.contains(&candidate) {
            logins.push(candidate);
        }
    }
    logins.retain(|login| *login != pr.author && matches(login, query));
    logins
        .into_iter()
        .map(|login| {
            let current = pr.reviewers.iter().find(|reviewer| reviewer.login == login);
            // GitHub can only take back a request; a review once given stays.
            let reviewed = current.is_some_and(|reviewer| reviewer.state != ReviewerState::Requested);
            let description = current.filter(|_| reviewed).map(|reviewer| reviewer.state.label().to_string());
            let team = current.is_some_and(|reviewer| reviewer.team) || login.contains('/');
            let (view, name) = (view.clone(), login.clone());
            picker_row(
                theme,
                SharedString::from(format!("pr-reviewer-option-{login}")),
                avatar(theme, &login, 18.0, team).into_any_element(),
                &login,
                RowState { description, selected: current.is_some(), disabled: reviewed },
                move |window, cx| {
                    view.update(cx, |this, cx| this.toggle_reviewer(&name, cx));
                    window.refresh();
                },
            )
        })
        .collect()
}

fn label_rows(view: &Entity<PrView>, query: &str, theme: &Theme, cx: &mut App) -> Vec<AnyElement> {
    let this = view.read(cx);
    let Some(pr) = this.detail.clone() else { return Vec::new() };
    // The repository's labels; the PR's own until they load.
    let all = this.bridge.repo_labels();
    all.into_iter()
        .filter(|label| matches(&label.name, query))
        .map(|label| {
            let chosen = pr.labels.iter().any(|entry| entry.name == label.name);
            let dot = u32::from_str_radix(&label.color, 16).map(rgb).unwrap_or(theme.ink3);
            let description = Some(label.description.clone()).filter(|d| !d.is_empty());
            let (view, option) = (view.clone(), label.clone());
            picker_row(
                theme,
                SharedString::from(format!("pr-label-option-{}", label.name)),
                div().size(px(8.0)).rounded_full().bg(dot).into_any_element(),
                &label.name,
                RowState { description, selected: chosen, disabled: false },
                move |window, cx| {
                    view.update(cx, |this, cx| this.toggle_label(&option, cx));
                    window.refresh();
                },
            )
        })
        .collect()
}
