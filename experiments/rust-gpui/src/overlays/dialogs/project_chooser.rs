//! The screens of a window with no Project (O-05; `App.tsx`): "Choose a Project" while none is open (the sidebar
//! beside it is the window's), and "Project could not open" with Retry when opening the last one failed.
//!
//! The view draws the middle of the window and tells the window what was pressed ([`ChooserEvent`]); it opens
//! nothing itself.

use gpui::{Context, EventEmitter, FontWeight, IntoElement, Render, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, RADIUS_WINDOW, TEXT_13, TEXT_17, TEXT_22, TextStepExt};
use crate::ui::{Button, ButtonVariant, InlineError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChooserState {
    /// No Project is open; a notice may say why.
    Choose { notice: Option<String> },
    /// Opening the last Project failed with this message.
    StartupError(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChooserEvent {
    /// "Add Project": the Add Project dialog.
    AddProject,
    /// "Retry": load the last Project again.
    Retry,
    /// "Open another project": the folder chooser.
    OpenAnother,
}

pub struct ProjectChooser {
    state: ChooserState,
}

impl EventEmitter<ChooserEvent> for ProjectChooser {}

impl ProjectChooser {
    pub fn new(state: ChooserState) -> Self {
        Self { state }
    }

    pub fn state(&self) -> &ChooserState {
        &self.state
    }

    pub fn set_state(&mut self, state: ChooserState, cx: &mut Context<Self>) {
        self.state = state;
        cx.notify();
    }
}

impl Render for ProjectChooser {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let shell = div().flex().flex_col().size_full().items_center().justify_center().gap(px(12.0)).p(px(24.0)).text_color(theme.ink);
        match self.state.clone() {
            ChooserState::Choose { notice } => {
                let add = view;
                shell
                    .debug_selector(|| "project-chooser".into())
                    .text_center()
                    .child(InlineError::new(notice.unwrap_or_default()))
                    .child(div().text_step(TEXT_22).font_weight(FontWeight::SEMIBOLD).child("Choose a Project"))
                    .child(
                        div().text_step(TEXT_13).text_color(theme.ink3).child("Open a Project or Link from the sidebar, or add a Project."),
                    )
                    .child(
                        Button::new("chooser-add", "Add Project")
                            .selector("chooser-add")
                            .on_click(move |_, _, cx| add.update(cx, |_, cx| cx.emit(ChooserEvent::AddProject))),
                    )
                    .into_any_element()
            }
            ChooserState::StartupError(message) => {
                let (retry, another) = (view.clone(), view);
                shell
                    .debug_selector(|| "project-startup-error".into())
                    .child(
                        div()
                            .w_full()
                            .max_w(px(576.0))
                            .p(px(24.0))
                            .rounded(RADIUS_WINDOW)
                            .border_1()
                            .border_color(theme.line)
                            .bg(theme.surface)
                            .shadow(theme.shadow_raised())
                            .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).child("Project could not open"))
                            .child(
                                div()
                                    .debug_selector(|| "project-startup-message".into())
                                    .mt(px(12.0))
                                    .text_step(TEXT_13)
                                    .text_color(theme.ink2)
                                    .child(message),
                            )
                            .child(
                                div()
                                    .mt(px(24.0))
                                    .flex()
                                    .gap(px(12.0))
                                    .child(
                                        Button::new("chooser-retry", "Retry")
                                            .selector("chooser-retry")
                                            .on_click(move |_, _, cx| retry.update(cx, |_, cx| cx.emit(ChooserEvent::Retry))),
                                    )
                                    .child(
                                        Button::new("chooser-another", "Open another project")
                                            .variant(ButtonVariant::Secondary)
                                            .selector("chooser-another")
                                            .on_click(move |_, _, cx| another.update(cx, |_, cx| cx.emit(ChooserEvent::OpenAnother))),
                                    ),
                            ),
                    )
                    .into_any_element()
            }
        }
    }
}
