//! The list the composer's pickers share (model list, permission modes, Run on, Isolation, branch, Project): rows
//! with the menu rows' metrics (32px, 48 with a subtitle, 4px corners, 13 medium, one `hover-2` highlight that
//! follows both pointer and keyboard, an inset accent ring on keyboard focus) but with a coloured icon or a provider
//! mark, which `ui::MenuRow` cannot draw (Full permissions are orange). Keyboard as the React pickers: Up and Down
//! move through the rows (wrapping), Home and End jump, Enter or Space picks the focused row, and the checked row
//! (else the first) takes focus when the list opens.

use std::rc::Rc;

use gpui::{
    App, ElementId, FocusHandle, FontWeight, IntoElement, KeyDownEvent, ParentElement, RenderOnce, Rgba, SharedString, Styled, Window, div,
    prelude::*, px,
};

use crate::theme::{ActiveTheme, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Icon, IconName, IconSize, RovingAxis, inset_ring, item_focus, roving_index};

type Pick = Rc<dyn Fn(&mut Window, &mut App)>;

pub enum Lead {
    Icon(IconName, Option<Rgba>),
}

pub struct Row {
    pub id: ElementId,
    pub lead: Option<Lead>,
    pub title: SharedString,
    pub title_color: Option<Rgba>,
    pub subtitle: Option<SharedString>,
    pub meta: Option<SharedString>,
    pub checked: bool,
    pub disabled: bool,
    pub on_pick: Pick,
}

impl Row {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, on_pick: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        Self {
            id: id.into(),
            lead: None,
            title: title.into(),
            title_color: None,
            subtitle: None,
            meta: None,
            checked: false,
            disabled: false,
            on_pick: Rc::new(on_pick),
        }
    }

    pub fn icon(mut self, icon: IconName, color: Option<Rgba>) -> Self {
        self.lead = Some(Lead::Icon(icon, color));
        self
    }

    pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(IntoElement)]
pub struct PickList {
    id: ElementId,
    rows: Vec<Row>,
    empty: Option<SharedString>,
}

impl PickList {
    pub fn new(id: impl Into<ElementId>, rows: Vec<Row>) -> Self {
        Self { id: id.into(), rows, empty: None }
    }

    pub fn empty(mut self, text: impl Into<SharedString>) -> Self {
        self.empty = Some(text.into());
        self
    }
}

impl RenderOnce for PickList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handles: Vec<FocusHandle> = self.rows.iter().map(|row| item_focus(&row.id, window, cx)).collect();
        let opened = window.use_keyed_state((self.id.clone(), "opened"), cx, |_, _| false);
        if !*opened.read(cx) {
            opened.update(cx, |opened, _| *opened = true);
            let start =
                self.rows.iter().position(|row| row.checked && !row.disabled).or_else(|| self.rows.iter().position(|row| !row.disabled));
            if let Some(handle) = start.and_then(|ix| handles.get(ix)) {
                handle.focus(window, cx);
            }
        }
        let picks: Vec<(Pick, bool)> = self.rows.iter().map(|row| (row.on_pick.clone(), row.disabled)).collect();
        let key_handles = handles.clone();
        let (hover2, accent) = (theme.hover2, theme.accent);
        let empty = self.rows.is_empty();
        div()
            .id(self.id)
            .flex()
            .flex_col()
            .gap(px(1.0))
            .on_key_down(move |event: &KeyDownEvent, window, cx| {
                let key = event.keystroke.key.as_str();
                let current = key_handles.iter().position(|handle| handle.is_focused(window));
                match key {
                    "enter" | "space" => {
                        if let Some((pick, false)) = current.and_then(|ix| picks.get(ix)) {
                            pick(window, cx);
                            cx.stop_propagation();
                        }
                    }
                    "up" | "down" | "home" | "end" => {
                        let enabled: Vec<usize> = (0..key_handles.len()).filter(|ix| !picks[*ix].1).collect();
                        let at = current.and_then(|ix| enabled.iter().position(|e| *e == ix));
                        if let Some(to) = roving_index(key, at, enabled.len(), RovingAxis::Vertical) {
                            key_handles[enabled[to]].focus(window, cx);
                            cx.stop_propagation();
                        }
                    }
                    _ => {}
                }
            })
            .children(self.rows.into_iter().zip(handles).map(|(row, handle)| {
                let height = if row.subtitle.is_some() { 48.0 } else { 32.0 };
                let enabled = !row.disabled;
                let pick = row.on_pick.clone();
                let selector = row.id.to_string();
                div()
                    .id(row.id)
                    .debug_selector(move || selector.clone())
                    .track_focus(&handle)
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.0))
                    .w_full()
                    .h(px(height))
                    .px(px(8.0))
                    .rounded(RADIUS_INLINE)
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(row.title_color.unwrap_or(theme.ink))
                    .when(enabled, |el| {
                        el.cursor_pointer()
                            .hover(move |style| style.bg(hover2))
                            .active(move |style| style.bg(hover2))
                            .focus_visible(move |style| style.bg(hover2).shadow(inset_ring(accent)))
                            .on_click(move |_, window, cx| pick(window, cx))
                    })
                    .when(!enabled, |el| el.opacity(0.4))
                    .when_some(row.lead, |el, lead| {
                        let Lead::Icon(icon, color) = lead;
                        el.child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .size(px(20.0))
                                .child(Icon::new(icon).size(IconSize::S14).color(color.unwrap_or(theme.ink2))),
                        )
                    })
                    .child(div().flex().flex_col().flex_1().min_w_0().child(div().truncate().child(row.title)).when_some(
                        row.subtitle,
                        |el, subtitle| {
                            el.child(
                                div().truncate().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(subtitle),
                            )
                        },
                    ))
                    .when_some(row.meta, |el, meta| {
                        el.child(div().flex_none().text_step(TEXT_11).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(meta))
                    })
                    .when(row.checked, |el| {
                        el.child(div().flex_none().child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink)))
                    })
            }))
            .when(empty, |el| {
                el.child(
                    div()
                        .px(px(8.0))
                        .py(px(20.0))
                        .text_center()
                        .text_step(TEXT_12)
                        .text_color(theme.ink3)
                        .child(self.empty.unwrap_or_else(|| "Nothing found".into())),
                )
            })
    }
}

/// A composer popover opened upward whose open state the composer owns (`BarState::open`), so a snapshot or an
/// action can open it and only one is open at a time.
pub fn popup(composer: &gpui::Entity<super::Composer>, key: &'static str, open: bool) -> crate::ui::Popover {
    let composer = composer.clone();
    crate::ui::Popover::new(key).above().bare().open(open).on_open_change(move |open, window, cx| {
        composer.update(cx, |composer, cx| {
            composer.bar.permission_menu = false;
            if open {
                composer.bar.open = Some(key);
            } else if composer.bar.open == Some(key) {
                composer.bar.open = None;
                // The context card goes with its pointer: no hover end comes for a card that is gone.
                composer.context_card_hovered = false;
            }
            cx.notify();
        });
        window.refresh();
    })
}

/// The surface of a picker popover: `surface`, `rounded-card`, `shadow-raised`, 6px padding, an optional title
/// (13 semibold, as `PickerPanel`'s).
pub fn panel(width: f32, title: Option<&str>, theme: &crate::theme::Theme) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .w(px(width))
        .p(px(6.0))
        .rounded(crate::theme::RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .text_color(theme.ink)
        .when_some(title.map(|title| title.to_string()), |el, title| {
            el.child(
                div()
                    .px(px(8.0))
                    .pt(px(4.0))
                    .pb(px(8.0))
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.ink)
                    .child(title),
            )
        })
}
