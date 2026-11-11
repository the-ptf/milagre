//! What's new (O-12; `UpdateReleaseNotes.tsx`): the release notes of a version, as markdown. Loading shows a status
//! line; a failure a card with "Try again"; a version with no notes says so.

use gpui::{AnyElement, App, AppContext as _, Context, Entity, IntoElement, Render, Task, Window, div, prelude::*, px};
use gpui_base::TextViewState;

use super::{Host, STEP, call, footer};
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt};
use crate::ui::markdown::{Markdown, base_extensions, open_with_system, text_view_style};
use crate::ui::{Button, ButtonSize, ButtonVariant, Dialog, ErrorVariant, InlineError};

/// 13 on a 20 line: release notes are prose.
const SIZE: f32 = 13.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notes {
    Loading,
    Failed,
    Empty,
    Text(String),
}

pub struct ReleaseNotesDialog {
    host: Host,
    version: String,
    notes: Notes,
    text: Option<Entity<TextViewState>>,
    _task: Option<Task<()>>,
}

impl ReleaseNotesDialog {
    pub fn notes(&self) -> &Notes {
        &self.notes
    }

    /// Reads the notes (again, after a failure).
    pub fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.notes = Notes::Loading;
        self.text = None;
        cx.notify();
        let future = self.host.release_notes(&self.version);
        self._task = Some(call(window, cx, STEP, future, |this, result, _, cx| {
            this.notes = match result {
                Ok(text) if text.trim().is_empty() => Notes::Empty,
                Ok(text) => {
                    this.text = Some(cx.new(|cx| TextViewState::markdown(&text, cx)));
                    Notes::Text(text)
                }
                Err(_) => Notes::Failed,
            };
            cx.notify();
        }));
    }
}

impl Render for ReleaseNotesDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let body: AnyElement = match (&self.notes, &self.text) {
            (Notes::Failed, _) => InlineError::new("Could not load release notes. Check your connection and try again.")
                .variant(ErrorVariant::Card)
                .action(
                    Button::new("notes-retry", "Try again")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .selector("notes-retry")
                        .on_click(move |_, window, cx| view.update(cx, |this, cx| this.load(window, cx))),
                )
                .into_any_element(),
            (Notes::Loading, _) => div().text_color(theme.ink2).child("Loading release notes\u{2026}").into_any_element(),
            (Notes::Empty, _) => div().text_color(theme.ink2).child("No release notes were published for this version.").into_any_element(),
            (Notes::Text(_), Some(state)) => {
                Markdown::new(state, text_view_style(&theme, SIZE), base_extensions(), open_with_system()).size(SIZE).into_any_element()
            }
            (Notes::Text(_), None) => div().into_any_element(),
        };
        div().flex().flex_col().gap(px(12.0)).child(div().debug_selector(|| "notes-body".into()).text_step(TEXT_13).child(body)).child(
            footer(
                None,
                vec![
                    Button::new("notes-close", "Close")
                        .variant(ButtonVariant::Secondary)
                        .selector("notes-close")
                        .on_click(|_, window, cx| Dialog::close(window, cx))
                        .into_any_element(),
                ],
            ),
        )
    }
}

/// Opens "What's new" for `version` and reads its notes.
pub fn open(version: &str, host: Host, window: &mut Window, cx: &mut App) -> Entity<ReleaseNotesDialog> {
    let view = cx.new(|_| ReleaseNotesDialog { host, version: version.to_string(), notes: Notes::Loading, text: None, _task: None });
    view.update(cx, |dialog, cx| dialog.load(window, cx));
    let body = view.clone();
    Dialog::new("What\u{2019}s new")
        .description(format!("Milagre v{version}"))
        .width(600.0)
        .body(move |_, _| body.clone().into_any_element())
        .open(window, cx);
    view
}
