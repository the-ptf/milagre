//! Delete Link (O-10; `DeleteLinkDialog.tsx`): asks before a Named Link is deleted, saying how many Chats it
//! archives. The host is asked first, so a Link with a running Chat names it and cannot be deleted until it stops:
//! the check runs again every 2 s while one runs. A Link deleted elsewhere meanwhile closes the dialog
//! ([`DeleteLinkDialog::link_state`]).

use std::rc::Rc;
use std::time::Duration;

use gpui::{AnyElement, App, AppContext as _, Context, Entity, IntoElement, Render, Task, Window, div, prelude::*, px};

use super::copy::{delete_link_text, link_delete_failure, link_running_text};
use super::host::{LinkDeleteCheck, LinkDeleted, NamedLink};
use super::{Host, STEP, call, description_line, footer};
use crate::theme::ActiveTheme;
use crate::ui::{Button, ButtonVariant, Dialog, InlineError};

/// How often a Link with a running Chat is checked again, so Delete turns on once the Chat stops.
pub const RECHECK: Duration = Duration::from_secs(2);

type Deleted = Rc<dyn Fn(&NamedLink, &LinkDeleted, &mut App)>;

pub struct DeleteLinkDialog {
    host: Host,
    link: NamedLink,
    /// The computer's name for the "too old" message ("this Mac").
    computer: String,
    check: Option<LinkDeleteCheck>,
    busy: bool,
    error: String,
    /// Only the latest check lands.
    checks: usize,
    on_deleted: Deleted,
    _read: Option<Task<()>>,
    _recheck: Option<Task<()>>,
    _delete: Option<Task<()>>,
}

impl DeleteLinkDialog {
    pub fn check(&self) -> Option<&LinkDeleteCheck> {
        self.check.as_ref()
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    /// A Chat holds the delete while it runs.
    pub fn running_text(&self) -> String {
        self.check.as_ref().filter(|check| !check.running.is_empty()).map(|check| link_running_text(&check.running)).unwrap_or_default()
    }

    /// Whether the dialog is waiting for a running Chat to stop (and so rechecking).
    fn waiting(&self) -> bool {
        self.check.as_ref().is_some_and(|check| !check.running.is_empty()) && !self.busy
    }

    /// Asks the host again; only the newest answer lands.
    pub fn read(&mut self, cx: &mut Context<Self>) {
        self.checks += 1;
        let asked = self.checks;
        let future = self.host.check_delete_link(&self.link.id);
        self._read = Some(cx.spawn(async move |this, cx| {
            let result = future.await;
            this.update(cx, |this, cx| {
                if asked != this.checks {
                    return;
                }
                match result {
                    Ok(check) => {
                        this.check = Some(check);
                        this.error.clear();
                    }
                    Err(error) => this.error = link_delete_failure(&error.to_string(), &this.computer),
                }
                this.schedule_recheck(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    fn schedule_recheck(&mut self, cx: &mut Context<Self>) {
        self._recheck = self.waiting().then(|| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(RECHECK).await;
                this.update(cx, |this, cx| this.read(cx)).ok();
            })
        });
    }

    /// The Link's state changed on this or another device: closes when it was deleted, else checks again.
    pub fn link_state(&mut self, deleted: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if deleted {
            Dialog::close(window, cx);
        } else if self.waiting() {
            self.read(cx);
        }
    }

    pub fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.check.is_none() || !self.running_text().is_empty() {
            return;
        }
        self.busy = true;
        self.error.clear();
        self._recheck = None;
        cx.notify();
        let future = self.host.delete_link(&self.link.id);
        self._delete = Some(call(window, cx, STEP, future, |this, result, window, cx| match result {
            Ok(deleted) => {
                (this.on_deleted)(&this.link, &deleted, cx);
                Dialog::close(window, cx);
            }
            Err(error) => {
                this.error = link_delete_failure(&error.to_string(), &this.computer);
                this.busy = false;
                cx.notify();
            }
        }));
    }
}

impl Render for DeleteLinkDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let text = delete_link_text(&self.link.name, self.check.as_ref().map_or(0, |check| check.chats));
        let description = match (&self.check, self.error.is_empty()) {
            (Some(_), _) => text.message.clone(),
            (None, true) => "Checking the Link\u{2019}s Chats\u{2026}".to_string(),
            (None, false) => String::new(),
        };
        let shown_error = if self.error.is_empty() { self.running_text() } else { self.error.clone() };
        let blocked = self.busy || self.check.is_none() || !self.running_text().is_empty();
        let buttons: Vec<AnyElement> = vec![
            Button::new("link-delete-cancel", "Cancel")
                .variant(ButtonVariant::Ghost)
                .disabled(self.busy)
                .selector("link-delete-cancel")
                .on_click(|_, window, cx| Dialog::close(window, cx))
                .into_any_element(),
            Button::new("link-delete-confirm", if self.busy { "Deleting\u{2026}" } else { text.action })
                .variant(ButtonVariant::Danger)
                .disabled(blocked)
                .selector("link-delete-confirm")
                .on_click(move |_, window, cx| view.update(cx, |this, cx| this.remove(window, cx)))
                .into_any_element(),
        ];
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(div().debug_selector(|| "link-delete-description".into()).child(description_line(description, &theme)))
            .child(div().debug_selector(|| "link-delete-notice".into()).child(InlineError::new(shown_error).small()))
            .child(footer(None, buttons))
    }
}

/// Opens it over the window and checks the Link. `on_deleted` hears the result once the host deleted it.
pub fn open(
    link: NamedLink,
    computer: &str,
    host: Host,
    on_deleted: impl Fn(&NamedLink, &LinkDeleted, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> Entity<DeleteLinkDialog> {
    let title = delete_link_text(&link.name, 0).title;
    let view = cx.new(|cx| {
        let mut dialog = DeleteLinkDialog {
            host,
            link,
            computer: computer.to_string(),
            check: None,
            busy: false,
            error: String::new(),
            checks: 0,
            on_deleted: Rc::new(on_deleted),
            _read: None,
            _recheck: None,
            _delete: None,
        };
        dialog.read(cx);
        dialog
    });
    let body = view.clone();
    Dialog::new(title).width(440.0).body(move |_, _| body.clone().into_any_element()).open(window, cx);
    view
}
