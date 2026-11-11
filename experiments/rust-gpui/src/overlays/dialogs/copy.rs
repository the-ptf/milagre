//! The words and small rules the dialogs share with the desktop: `packages/shared/src/worktree-link.mjs`
//! (`deleteLinkText`, `linkRunningText`, `linkDeleteFailure`), `lib/pending-computers.ts` (`allowQuestion`) and
//! `lib/handover.ts` (`handoffLabel`).

use crate::data::Provider;

/// What a new shared Link Chat gets, as the Link dialog says it.
pub const LINK_CHAT_WORKTREES_TEXT: &str = "One Chat across the linked Projects. A Project gets a Worktree only when the Chat changes it.";
/// The same, for a Link being edited.
pub const LINK_UPDATE_WORKTREES_TEXT: &str =
    "New Chats get a Worktree in a Project only when they change it. Chats already started keep theirs.";

/// Under the question of the allow prompt: what Allow gives, and how to take it back.
pub const ALLOW_DETAIL: &str =
    "It can do anything this window can, except pair and remove devices. You can remove it any time in Settings \u{203a} Phone & sharing.";

/// The confirmation before a Named Link is deleted. `chats` counts its Chats not archived yet.
pub struct DeleteLinkText {
    pub title: String,
    pub message: String,
    pub action: &'static str,
}

pub fn delete_link_text(name: &str, chats: usize) -> DeleteLinkText {
    let closing = match chats {
        0 => "It has no Chats.".to_string(),
        1 => "Its Chat is archived, and its transcript stays on disk.".to_string(),
        n => format!("Its {n} Chats are archived, and their transcripts stay on disk."),
    };
    DeleteLinkText {
        title: format!("Delete {name}?"),
        message: format!(
            "{closing} Worktrees without changes are removed. Ones with changes or unpushed commits stay, as Chats in their Projects. The Projects themselves don't change."
        ),
        action: "Delete Link",
    }
}

fn listed(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Why a Link can't be deleted yet: its Chats whose turn is running, by title.
pub fn link_running_text(titles: &[String]) -> String {
    let many = titles.len() > 1;
    format!(
        "{} {} running. Stop {} before deleting the Link.",
        listed(titles),
        if many { "are" } else { "is" },
        if many { "them" } else { "it" }
    )
}

/// A failed Link delete as the desktop says it: a computer too old to delete Links is asked to update, by name.
pub fn link_delete_failure(message: &str, computer: &str) -> String {
    let lowered = message.to_lowercase();
    if ["not available from mobile", "unknown command", "no handler"].iter().any(|refusal| lowered.contains(refusal)) {
        format!("Update Milagre on {computer} to delete its Links.")
    } else {
        message.to_string()
    }
}

/// The prompt's question: the name the computer sent in its hello, or what it is when it sent none.
pub fn allow_question(name: Option<&str>, this_computer: &str) -> String {
    format!("{} wants to drive {this_computer}\u{2019}s chats", name.filter(|name| !name.is_empty()).unwrap_or("A computer"))
}

/// The two sides of a handoff divider: each side's model name from the catalog, else its provider's name.
pub struct HandoffLabel {
    pub from: String,
    pub to: String,
    pub restored: bool,
}

/// One side of a handoff: a provider and, when known, its model's catalog name.
#[derive(Clone, Debug)]
pub struct HandoffSide {
    pub provider: Provider,
    pub model_name: Option<String>,
}

pub fn handoff_label(from: &HandoffSide, to: &HandoffSide) -> HandoffLabel {
    let side = |side: &HandoffSide| side.model_name.clone().unwrap_or_else(|| side.provider.name().to_string());
    HandoffLabel { from: side(from), to: side(to), restored: from.provider == to.provider }
}
