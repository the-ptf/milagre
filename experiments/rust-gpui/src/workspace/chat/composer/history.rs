//! The prompt editor's own undo history, after `createEditHistory` in `apps/desktop/app/src/lib/editor-model.ts`:
//! typing (or deleting) within 500 ms of the last keystroke joins one step; a chip, a paste and anything else are a
//! step each; at most 200 steps. The draft is the string; a step is the string and the caret before the edit.
//!
//! gpui-component's text area has an undo manager of its own, but it coalesces by adjacency rather than time and its
//! steps hold the token annotations, while here chips are a view of the string (`super::editor`). The composer
//! catches `Undo` and `Redo` before the text area sees them and replays these steps instead.

use std::time::{Duration, Instant};

/// How long a run of typing or deleting keeps joining the same step.
const COALESCE: Duration = Duration::from_millis(500);
/// The most steps kept; the oldest go first.
const MAX_STEPS: usize = 200;

/// A draft and its caret (UTF-8 bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub value: String,
    pub caret: usize,
}

impl Snapshot {
    pub fn new(value: impl Into<String>, caret: usize) -> Self {
        Self { value: value.into(), caret }
    }
}

/// What kind of edit a step records (`EditKind`): only typing and deleting coalesce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
    Type,
    Delete,
    Chip,
    Paste,
    Other,
}

#[derive(Default)]
pub struct EditHistory {
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    last: Option<(EditKind, Instant)>,
}

impl EditHistory {
    /// Call before applying an edit, with the state it replaces.
    pub fn record(&mut self, before: Snapshot, kind: EditKind, now: Instant) {
        let joins = self.last.is_some_and(|(last, at)| {
            last == kind && matches!(kind, EditKind::Type | EditKind::Delete) && now.saturating_duration_since(at) < COALESCE
        });
        if !joins {
            self.undo.push(before);
        }
        if self.undo.len() > MAX_STEPS {
            let excess = self.undo.len() - MAX_STEPS;
            self.undo.drain(..excess);
        }
        self.redo.clear();
        self.last = Some((kind, now));
    }

    pub fn undo(&mut self, current: Snapshot) -> Option<Snapshot> {
        let previous = self.undo.pop()?;
        self.redo.push(current);
        self.last = None;
        Some(previous)
    }

    pub fn redo(&mut self, current: Snapshot) -> Option<Snapshot> {
        let next = self.redo.pop()?;
        self.undo.push(current);
        self.last = None;
        Some(next)
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    #[cfg(test)]
    pub fn steps(&self) -> usize {
        self.undo.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `editor-model.test.ts`: "undo coalesces typing within 500 ms and keeps one entry per chip edit".
    #[test]
    fn undo_coalesces_typing_within_500_ms_and_keeps_one_entry_per_chip_edit() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let s = Snapshot::new;
        let mut history = EditHistory::default();
        history.record(s("", 0), EditKind::Type, at(0));
        history.record(s("h", 1), EditKind::Type, at(100));
        history.record(s("hi", 2), EditKind::Type, at(300));
        history.record(s("hi ", 3), EditKind::Type, at(1000));
        history.record(s("hi x", 4), EditKind::Chip, at(1000));
        history.record(s("hi /x ", 6), EditKind::Chip, at(1000));
        assert_eq!(history.undo(s("hi /x y", 7)), Some(s("hi /x ", 6)));
        assert_eq!(history.undo(s("hi /x ", 6)), Some(s("hi x", 4)));
        assert_eq!(history.undo(s("hi x", 4)), Some(s("hi ", 3)));
        assert_eq!(history.undo(s("hi ", 3)), Some(s("", 0)), "the first burst is one step");
        assert_eq!(history.undo(s("", 0)), None);
        assert_eq!(history.redo(s("", 0)), Some(s("hi ", 3)));
        assert_eq!(history.redo(s("hi ", 3)), Some(s("hi x", 4)));
        // A new edit drops what could be redone.
        history.record(s("hi x", 4), EditKind::Paste, at(2000));
        assert_eq!(history.redo(s("hi xz", 5)), None);
        history.clear();
        assert_eq!(history.undo(s("", 0)), None);
    }

    #[test]
    fn deleting_coalesces_like_typing_but_not_with_it_and_the_stack_keeps_200_steps() {
        let start = Instant::now();
        let mut history = EditHistory::default();
        history.record(Snapshot::new("abc", 3), EditKind::Delete, start);
        history.record(Snapshot::new("ab", 2), EditKind::Delete, start + Duration::from_millis(400));
        history.record(Snapshot::new("a", 1), EditKind::Type, start + Duration::from_millis(450));
        assert_eq!(history.steps(), 2, "a burst of deletes is one step; typing after it starts another");
        for n in 0..250 {
            history.record(Snapshot::new(n.to_string(), 0), EditKind::Other, start);
        }
        assert_eq!(history.steps(), MAX_STEPS);
        assert_eq!(history.undo(Snapshot::new("x", 0)).map(|s| s.value), Some("249".to_string()));
    }
}
