//! The Chat list's undo history, desktop and phone alike (`packages/shared/src/undo-history.ts`): Done, Reopen,
//! pins, deletions and Links, each recorded with how to take it back. Undo walks back through it and redo forward
//! again, long after the toast has gone, like Finder. The toast always shows the step just taken, so its button
//! undoes (or redoes) exactly what it names.

use std::rc::Rc;

/// The icon a toast leads with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastKind {
    Done,
    Deleted,
    Undone,
}

/// A step that can be taken back. The closures do the work and report whether it could be done: `false` from
/// `undo` means it can't be any more (the deletion went ahead), and the toast says so. Anything else, including
/// a closure with nothing to report, returns `true`.
pub struct UndoAction {
    /// What the toast says once the action is done, "Moved to Done".
    pub text: String,
    pub kind: Option<ToastKind>,
    /// Takes it back.
    pub undo: Box<dyn Fn() -> bool>,
    /// What the toast says once it is undone; "Undone" when not given.
    pub undone_text: Option<String>,
    /// The undone toast's icon; [`ToastKind::Undone`] (the undo arrow) when not given.
    pub undone_kind: Option<ToastKind>,
    /// Does it again after an undo. Without one, an undo is the end of it and redo skips it.
    pub redo: Option<Box<dyn Fn()>>,
    /// How long the undo keeps working after the action (a deletion's Undo window), in ms; forever when not given.
    pub undo_window_ms: Option<i64>,
    /// Which screen's toast shows it, where two are on screen at once (the iPad's list beside a Chat).
    pub place: Option<String>,
}

impl UndoAction {
    /// An action with just its text and `undo`; set the other fields with struct update syntax or by hand.
    pub fn new(text: impl Into<String>, undo: impl Fn() -> bool + 'static) -> Self {
        Self {
            text: text.into(),
            kind: None,
            undo: Box::new(undo),
            undone_text: None,
            undone_kind: None,
            redo: None,
            undo_window_ms: None,
            place: None,
        }
    }
}

/// What a recorded action is called to drop it again (`drop`): the same action, by identity.
pub type ActionHandle = Rc<UndoAction>;

/// The button a toast offers: undo the step it names, redo it, or none for a plain notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastButton {
    Undo,
    Redo,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoToast {
    pub id: u64,
    pub text: String,
    pub kind: Option<ToastKind>,
    pub button: Option<ToastButton>,
    pub place: Option<String>,
}

// What a toast says, before it gets its id.
struct ToastBody {
    text: String,
    kind: Option<ToastKind>,
    button: Option<ToastButton>,
    place: Option<String>,
}

struct Entry {
    action: ActionHandle,
    /// The ms time after which it can't be undone; `None` is never.
    until: Option<i64>,
}

const LIMIT: usize = 50;

/// A subscription to the history's changes; give it back to [`UndoHistory::unsubscribe`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Subscription(u64);

pub struct UndoHistory {
    now: Box<dyn Fn() -> i64>,
    past: Vec<Entry>,
    future: Vec<ActionHandle>,
    toast: Option<UndoToast>,
    /// The action the toast names, so dropping that action takes its toast too.
    shown: Option<ActionHandle>,
    next_id: u64,
    listeners: Vec<(u64, Box<dyn Fn()>)>,
    next_listener: u64,
}

impl UndoHistory {
    /// A history reading the time from `now`, in ms (`createUndoHistory(now)`).
    pub fn new(now: impl Fn() -> i64 + 'static) -> Self {
        Self {
            now: Box::new(now),
            past: Vec::new(),
            future: Vec::new(),
            toast: None,
            shown: None,
            next_id: 1,
            listeners: Vec::new(),
            next_listener: 1,
        }
    }

    fn emit(&self) {
        for (_, listener) in &self.listeners {
            listener();
        }
    }

    fn show(&mut self, next: Option<ToastBody>, action: Option<ActionHandle>) {
        self.shown = action;
        self.toast = next.map(|ToastBody { text, kind, button, place }| {
            let id = self.next_id;
            self.next_id += 1;
            UndoToast { id, text, kind, button, place }
        });
        self.emit();
    }

    fn entry(&self, action: &ActionHandle) -> Entry {
        Entry { action: Rc::clone(action), until: action.undo_window_ms.map(|window| (self.now)() + window) }
    }

    /// The latest step that can still be undone; ones past their window drop off.
    fn live(&mut self) -> Option<&Entry> {
        let now = (self.now)();
        while self.past.last().is_some_and(|entry| entry.until.is_some_and(|until| until <= now)) {
            self.past.pop();
        }
        self.past.last()
    }

    fn push_past(&mut self, entry: Entry) {
        self.past.push(entry);
        if self.past.len() > LIMIT {
            self.past.remove(0);
        }
    }

    fn show_done(&mut self, action: &ActionHandle) {
        self.show(
            Some(ToastBody { text: action.text.clone(), kind: action.kind, button: Some(ToastButton::Undo), place: action.place.clone() }),
            Some(Rc::clone(action)),
        );
    }

    /// Records an action just taken and shows its toast with Undo. A new action ends whatever could be redone.
    pub fn record(&mut self, action: UndoAction) -> ActionHandle {
        let action = Rc::new(action);
        let entry = self.entry(&action);
        self.push_past(entry);
        self.future.clear();
        self.show_done(&action);
        action
    }

    /// Takes back an action that failed: out of the history, and its toast goes.
    pub fn drop_action(&mut self, action: &ActionHandle) {
        self.past.retain(|entry| !Rc::ptr_eq(&entry.action, action));
        self.future.retain(|item| !Rc::ptr_eq(item, action));
        if self.shown.as_ref().is_some_and(|shown| Rc::ptr_eq(shown, action)) {
            self.show(None, None);
        }
    }

    /// A toast with nothing to undo, such as an error; the history stays as it was.
    pub fn notify(&mut self, text: &str, place: Option<&str>) {
        self.show(Some(ToastBody { text: text.to_owned(), kind: None, button: None, place: place.map(str::to_owned) }), None);
    }

    /// Undoes the latest action; `false` when there is nothing left to undo.
    pub fn undo(&mut self) -> bool {
        let Some(top) = self.live().map(|entry| Rc::clone(&entry.action)) else { return false };
        self.past.pop();
        if !(top.undo)() {
            self.show(
                Some(ToastBody { text: "Too late to undo that".to_owned(), kind: None, button: None, place: top.place.clone() }),
                None,
            );
            return true;
        }
        if top.redo.is_some() {
            self.future.push(Rc::clone(&top));
        }
        let text = top.undone_text.clone().unwrap_or_else(|| "Undone".to_owned());
        let kind = top.undone_kind.unwrap_or(ToastKind::Undone);
        let button = top.redo.is_some().then_some(ToastButton::Redo);
        self.show(Some(ToastBody { text, kind: Some(kind), button, place: top.place.clone() }), Some(top));
        true
    }

    /// Does the last undone action again; `false` when nothing was undone.
    pub fn redo(&mut self) -> bool {
        let Some(action) = self.future.last().cloned() else { return false };
        let Some(redo) = action.redo.as_ref() else { return false };
        self.future.pop();
        redo();
        let entry = self.entry(&action);
        self.push_past(entry);
        self.show_done(&action);
        true
    }

    pub fn can_undo(&mut self) -> bool {
        self.live().is_some()
    }

    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Hides the toast `id` if it is still the one showing; an older toast's timer never closes a newer one.
    pub fn dismiss(&mut self, id: u64) {
        if self.toast.as_ref().is_some_and(|toast| toast.id == id) {
            self.show(None, None);
        }
    }

    pub fn toast(&self) -> Option<&UndoToast> {
        self.toast.as_ref()
    }

    /// `listener` runs after every change of the toast.
    pub fn subscribe(&mut self, listener: impl Fn() + 'static) -> Subscription {
        let id = self.next_listener;
        self.next_listener += 1;
        self.listeners.push((id, Box::new(listener)));
        Subscription(id)
    }

    pub fn unsubscribe(&mut self, subscription: Subscription) {
        self.listeners.retain(|(id, _)| *id != subscription.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;

    fn step(done: &Rc<RefCell<BTreeSet<&'static str>>>, id: &'static str) -> UndoAction {
        let (undo_set, redo_set) = (Rc::clone(done), Rc::clone(done));
        UndoAction {
            kind: Some(ToastKind::Done),
            undone_text: Some("Back in Chats".to_owned()),
            redo: Some(Box::new(move || {
                redo_set.borrow_mut().insert(id);
            })),
            ..UndoAction::new("Moved to Done", move || undo_set.borrow_mut().remove(id))
        }
    }

    fn toast(history: &UndoHistory) -> UndoToast {
        history.toast().cloned().expect("a toast")
    }

    #[test]
    fn undo_walks_back_through_the_steps_and_redo_forward_with_the_toast_naming_each_one() {
        let mut history = UndoHistory::new(|| 0);
        let done = Rc::new(RefCell::new(BTreeSet::new()));
        done.borrow_mut().insert("a");
        history.record(step(&done, "a"));
        done.borrow_mut().insert("b");
        history.record(step(&done, "b"));
        assert_eq!(
            toast(&history),
            UndoToast { id: 2, text: "Moved to Done".into(), kind: Some(ToastKind::Done), button: Some(ToastButton::Undo), place: None }
        );

        assert!(history.undo());
        assert_eq!(done.borrow().iter().copied().collect::<Vec<_>>(), ["a"]);
        assert_eq!(toast(&history).text, "Back in Chats");
        assert_eq!(toast(&history).button, Some(ToastButton::Redo));
        assert_eq!(toast(&history).kind, Some(ToastKind::Undone));
        assert!(history.undo());
        assert!(done.borrow().is_empty());
        assert!(!history.undo(), "nothing left to undo");

        assert!(history.redo());
        assert_eq!(done.borrow().iter().copied().collect::<Vec<_>>(), ["a"]);
        assert_eq!(toast(&history).button, Some(ToastButton::Undo));

        // A new step ends what could be redone.
        done.borrow_mut().insert("c");
        history.record(step(&done, "c"));
        assert!(!history.redo());
        assert!(history.can_undo());
    }

    #[test]
    fn a_deletion_can_only_be_undone_inside_its_window_and_a_late_undo_says_so() {
        let clock = Rc::new(Cell::new(0));
        let mut history = UndoHistory::new({
            let clock = Rc::clone(&clock);
            move || clock.get()
        });
        history.record(UndoAction::new("Pinned", || true));
        history.record(UndoAction {
            kind: Some(ToastKind::Deleted),
            undo_window_ms: Some(6000),
            ..UndoAction::new("Chat deleted", || true)
        });
        clock.set(7000);
        // The expired deletion drops off, so undo takes back the pin before it.
        assert!(history.undo());
        assert_eq!(toast(&history).text, "Undone");
        assert!(!history.can_undo());

        history.record(UndoAction { undo_window_ms: Some(6000), ..UndoAction::new("Chat deleted", || false) });
        assert!(history.undo());
        assert_eq!(toast(&history), UndoToast { id: 5, text: "Too late to undo that".into(), kind: None, button: None, place: None });
        assert!(!history.can_redo());
    }

    #[test]
    fn a_notice_leaves_the_history_alone_and_dismissing_an_older_toast_keeps_the_newer_one() {
        let mut history = UndoHistory::new(|| 0);
        history.record(UndoAction::new("Link created", || true));
        let first = toast(&history).id;
        history.notify("Could not ask “Fix flaky test”", None);
        history.dismiss(first);
        assert_eq!(toast(&history).text, "Could not ask “Fix flaky test”");
        assert_eq!(toast(&history).button, None);
        assert!(history.can_undo());
        let current = toast(&history).id;
        history.dismiss(current);
        assert!(history.toast().is_none());
    }

    #[test]
    fn a_failed_step_drops_out_of_the_history_and_takes_its_toast_with_it() {
        let mut history = UndoHistory::new(|| 0);
        history.record(UndoAction::new("Pinned", || true));
        let failed = history.record(UndoAction { redo: Some(Box::new(|| {})), ..UndoAction::new("Moved to Done", || true) });
        history.drop_action(&failed);
        assert!(history.toast().is_none());
        assert!(history.undo());
        assert_eq!(toast(&history).text, "Undone", "undo went to the pin before it");
    }

    #[test]
    fn an_undo_without_a_redo_is_the_end_of_it_and_the_places_are_kept() {
        let mut history = UndoHistory::new(|| 0);
        history.record(UndoAction { place: Some("list".into()), undone_kind: Some(ToastKind::Done), ..UndoAction::new("Pinned", || true) });
        assert_eq!(toast(&history).place.as_deref(), Some("list"));
        assert!(history.undo());
        assert_eq!(toast(&history).place.as_deref(), Some("list"));
        assert_eq!(toast(&history).kind, Some(ToastKind::Done));
        assert!(!history.can_redo());
        assert!(!history.redo());
        history.notify("Oops", Some("detail"));
        assert_eq!(toast(&history).place.as_deref(), Some("detail"));
    }

    #[test]
    fn the_history_keeps_the_last_fifty_steps() {
        let mut history = UndoHistory::new(|| 0);
        let undone = Rc::new(Cell::new(0));
        for _ in 0..60 {
            let undone = Rc::clone(&undone);
            history.record(UndoAction::new("Step", move || {
                undone.set(undone.get() + 1);
                true
            }));
        }
        while history.undo() {}
        assert_eq!(undone.get(), 50);
    }

    #[test]
    fn subscribers_hear_every_change_until_they_unsubscribe() {
        let mut history = UndoHistory::new(|| 0);
        let heard = Rc::new(Cell::new(0));
        let subscription = history.subscribe({
            let heard = Rc::clone(&heard);
            move || heard.set(heard.get() + 1)
        });
        history.record(UndoAction::new("a", || true));
        history.notify("b", None);
        assert_eq!(heard.get(), 2);
        history.unsubscribe(subscription);
        history.notify("c", None);
        assert_eq!(heard.get(), 2);
    }
}
