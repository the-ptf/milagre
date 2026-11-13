//! The picked file's diff under the list: the diff view (`workspace::panel::diff`) over every file of the list the
//! file was picked from, scrolled to it and holding it at the top. A section's files take line comments for the Chat;
//! a commit's are read-only, as `CommitFiles.tsx` draws them.

use std::rc::Rc;

use gpui::SharedString;

use super::Source;
use super::data::{Section, WorktreeChanges};
use crate::workspace::panel::diff::{ChangesMode, DiffSource};

/// The diff source for files picked from `source`, or `None` when that list has no files.
pub fn source_for(chat: &SharedString, source: &Source, changes: &Rc<WorktreeChanges>) -> Option<DiffSource> {
    let (files, mode, base, comments) = match source {
        Source::Section(Section::Uncommitted) => (changes.uncommitted.files.clone(), ChangesMode::Uncommitted, None, true),
        Source::Section(Section::Committed) => {
            (changes.committed.files.clone(), ChangesMode::Committed, changes.history.base.clone(), true)
        }
        Source::Commit(sha) => {
            let files = changes.commit_files.get(sha)?.files.clone();
            (files, ChangesMode::Committed, Some(sha[..8.min(sha.len())].to_string()), false)
        }
    };
    let data = changes.clone();
    Some(DiffSource {
        chat: chat.clone(),
        mode,
        base,
        files,
        loader: Rc::new(move |entry| data.patches.get(&entry.path).cloned()),
        back_label: SharedString::default(),
        review: false,
        comments,
    })
}
