//! Remove Project (O-09; `RemoveProjectDialog.tsx`): confirm forgetting a Project. Files, Worktrees and saved Chats
//! stay on disk; running Chats keep running.

use std::rc::Rc;

use gpui::{AnyElement, App, AppContext as _, Context, Entity, IntoElement, Render, Task, Window, div, prelude::*, px};

use super::{Host, STEP, call, footer};
use crate::ui::{Button, ButtonVariant, Dialog, InlineError};

type Removed = Rc<dyn Fn(&str, &mut App)>;

pub struct RemoveProjectDialog {
    host: Host,
    path: String,
    busy: bool,
    error: String,
    on_removed: Removed,
    _task: Option<Task<()>>,
}

impl RemoveProjectDialog {
    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    /// Forgets the Project; a second press while it works does nothing.
    pub fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error.clear();
        cx.notify();
        let future = self.host.forget_project(&self.path);
        self._task = Some(call(window, cx, STEP, future, |this, result, window, cx| match result {
            Ok(()) => {
                (this.on_removed)(&this.path, cx);
                Dialog::close(window, cx);
            }
            Err(error) => {
                this.error = error.to_string();
                this.busy = false;
                cx.notify();
            }
        }));
    }
}

impl Render for RemoveProjectDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let buttons: Vec<AnyElement> = vec![
            Button::new("project-remove-cancel", "Cancel")
                .variant(ButtonVariant::Ghost)
                .disabled(self.busy)
                .selector("project-remove-cancel")
                .on_click(|_, window, cx| Dialog::close(window, cx))
                .into_any_element(),
            Button::new("project-remove-confirm", if self.busy { "Removing\u{2026}" } else { "Remove Project" })
                .variant(ButtonVariant::Danger)
                .disabled(self.busy)
                .selector("project-remove-confirm")
                .on_click(move |_, window, cx| view.update(cx, |this, cx| this.remove(window, cx)))
                .into_any_element(),
        ];
        div().flex().flex_col().gap(px(12.0)).child(InlineError::new(self.error.clone()).small()).child(footer(None, buttons))
    }
}

/// Opens it over the window. `on_removed` hears the Project's path once the host forgot it.
pub fn open(
    project: (&str, &str),
    host: Host,
    on_removed: impl Fn(&str, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> Entity<RemoveProjectDialog> {
    let (path, name) = (project.0.to_string(), project.1.to_string());
    let view =
        cx.new(|_| RemoveProjectDialog { host, path, busy: false, error: String::new(), on_removed: Rc::new(on_removed), _task: None });
    let body = view.clone();
    Dialog::new(format!("Remove {name}?"))
        .description(
            "This removes the Project from the list on your computer and paired phones. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back. Running Chats keep running.",
        )
        .width(440.0)
        .body(move |_, _| body.clone().into_any_element())
        .open(window, cx);
    view
}
