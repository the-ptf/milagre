//! The sidebar's undo book: Done, Reopen, Pin, Unpin and Delete each recorded with how to take them back, the toast
//! that names the latest step, and ⌘Z / ⇧⌘Z over the last 50 (`lib/undo-history.ts`, `SidebarToast.tsx`; the history
//! itself is `logic::lists::undo_history`).
//!
//! The history's closures take no context, so each one only queues an [`Op`]; the sidebar applies the queue right
//! after the history call returns (`Sidebar::undo`, `redo`), without recording it again.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui::{AnyElement, App, Window, actions, div, prelude::*, px};

use super::SIDEBAR_WIDTH;
use crate::logic::lists::undo_history::{ToastButton, ToastKind, UndoAction, UndoHistory, UndoToast};
use crate::ui::{IconName, Toast};

actions!(milagre_gpui_sidebar, [Undo, Redo]);

/// How long the toast stays (`TOAST_MS`).
pub const TOAST_MS: u64 = 6000;
/// How long a deletion can be taken back (`DELETE_UNDO_MS`).
pub const DELETE_UNDO_MS: i64 = 6000;
/// The toast's clearance from the sidebar's edges (`inset-x-3`).
const TOAST_INSET: f32 = 12.0;

/// A change the book queues for the sidebar to apply. Chats are named by key.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Done(String),
    Reopen(String),
    Pin(String, Option<f64>),
    Archive(String),
    UndoArchive(String),
}

pub struct UndoBook {
    pub history: UndoHistory,
    queue: Rc<RefCell<Vec<Op>>>,
    /// Added to the system clock, so a test can move past the deletion window.
    skew: Rc<Cell<i64>>,
}

impl UndoBook {
    pub fn new() -> Self {
        let skew = Rc::new(Cell::new(0));
        let clock = Rc::clone(&skew);
        let now = move || {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
            ms + clock.get()
        };
        Self { history: UndoHistory::new(now), queue: Rc::default(), skew }
    }

    /// Moves the book's clock forward (tests).
    pub fn advance(&self, ms: i64) {
        self.skew.set(self.skew.get() + ms);
    }

    pub fn drain(&self) -> Vec<Op> {
        std::mem::take(&mut *self.queue.borrow_mut())
    }

    fn queue_op(&self, op: Op) -> Box<dyn Fn() -> bool> {
        let queue = Rc::clone(&self.queue);
        Box::new(move || {
            queue.borrow_mut().push(op.clone());
            true
        })
    }

    fn queue_redo(&self, op: Op) -> Box<dyn Fn()> {
        let queue = Rc::clone(&self.queue);
        Box::new(move || queue.borrow_mut().push(op.clone()))
    }

    /// Done as a step: ⌘Z reopens the Chat, ⇧⌘Z moves it to Done again.
    pub fn done(&mut self, key: &str) {
        self.history.record(UndoAction {
            kind: Some(ToastKind::Done),
            undone_text: Some("Back in Chats".into()),
            redo: Some(self.queue_redo(Op::Done(key.into()))),
            ..UndoAction::new("Moved to Done", self.queue_op(Op::Reopen(key.into())))
        });
    }

    /// Reopen, the same step the other way round.
    pub fn reopen(&mut self, key: &str) {
        self.history.record(UndoAction {
            kind: Some(ToastKind::Undone),
            undone_text: Some("Moved to Done".into()),
            undone_kind: Some(ToastKind::Done),
            redo: Some(self.queue_redo(Op::Reopen(key.into()))),
            ..UndoAction::new("Back in Chats", self.queue_op(Op::Done(key.into())))
        });
    }

    /// A pin changed from `before` to `after`; recorded only when pinned-ness changed (a reorder is not a step).
    pub fn pin(&mut self, key: &str, before: Option<f64>, after: Option<f64>) {
        if before.is_some() == after.is_some() {
            return;
        }
        let (text, undone) = if after.is_none() { ("Unpinned", "Pinned") } else { ("Pinned", "Unpinned") };
        self.history.record(UndoAction {
            undone_text: Some(undone.into()),
            redo: Some(self.queue_redo(Op::Pin(key.into(), after))),
            ..UndoAction::new(text, self.queue_op(Op::Pin(key.into(), before)))
        });
    }

    /// A deletion, undoable only inside its window; no redo (⇧⌘Z never deletes a Worktree).
    pub fn delete(&mut self, key: &str) {
        self.history.record(UndoAction {
            kind: Some(ToastKind::Deleted),
            undone_text: Some("Chat restored".into()),
            undo_window_ms: Some(DELETE_UNDO_MS),
            ..UndoAction::new("Chat deleted", self.queue_op(Op::UndoArchive(key.into())))
        });
    }
}

impl Default for UndoBook {
    fn default() -> Self {
        Self::new()
    }
}

/// The toast's icon.
fn glyph(kind: ToastKind) -> IconName {
    match kind {
        ToastKind::Done => IconName::Tick02,
        ToastKind::Deleted => IconName::Delete02,
        ToastKind::Undone => IconName::Undo02,
    }
}

/// The toast pill in its slot just above the usage meters: a zero-height box the pill hangs from, so the list above
/// does not move when it shows.
pub fn toast_slot(toast: Option<&UndoToast>, on_press: impl Fn(ToastButton, &mut Window, &mut App) + 'static) -> AnyElement {
    let slot = div().relative().flex_none().h(px(0.0)).w(px(SIDEBAR_WIDTH));
    let Some(toast) = toast else { return slot.into_any_element() };
    let mut pill = Toast::new(toast.text.clone());
    if let Some(kind) = toast.kind {
        pill = pill.icon(glyph(kind));
    }
    if let Some(button) = toast.button {
        let (id, label, shortcut) = match button {
            ToastButton::Undo => ("toast-undo", "Undo", "⌘Z"),
            ToastButton::Redo => ("toast-redo", "Redo", "⇧⌘Z"),
        };
        pill = pill.action(id, label, Some(shortcut), move |_, window, cx| on_press(button, window, cx));
    }
    slot.child(div().absolute().left(px(TOAST_INSET)).right(px(TOAST_INSET)).bottom(px(6.0)).child(pill)).into_any_element()
}
