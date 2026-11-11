//! The Subchats section's rows: the open Chat's Subchats (nested under their parents) and, when the open Chat is
//! itself a Subchat, its parent. Built from the same `FamilyChat` list the Chat column's bookmark reads, which the
//! Workspace pushes (`DetailsView::set_family`); until it does, from the data source's own Chats.

use std::sync::Arc;

use crate::data::{self, ChatId, DataSource, ScopeKey, SessionStatus};
use crate::logic::activity::subchat_states::SubchatKind;
use crate::logic::marks::chat_mark::ChatMark;
use crate::workspace::chat::pills::bookmark::{self, FamilyChat};

/// One Subchat row.
#[derive(Clone, Debug, PartialEq)]
pub struct SubchatRow {
    pub key: String,
    pub title: String,
    pub kind: SubchatKind,
    /// 0 for a direct Subchat of the open Chat, 1 and 2 below it.
    pub depth: usize,
}

/// The open Chat's parent.
#[derive(Clone, Debug, PartialEq)]
pub struct ParentRow {
    pub key: String,
    pub title: String,
    pub kind: SubchatKind,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Family {
    pub parent: Option<ParentRow>,
    pub subchats: Vec<SubchatRow>,
}

impl Family {
    pub fn is_empty(&self) -> bool {
        self.parent.is_none() && self.subchats.is_empty()
    }

    /// Whether any Subchat waits on the user (the heading's hint).
    pub fn asking(&self) -> bool {
        self.subchats.iter().any(|row| row.kind == SubchatKind::NeedsYou)
    }
}

/// Subchats nest at most two levels under the Chat they belong to.
const MAX_DEPTH: usize = 2;

pub fn family(chats: &[FamilyChat], key: &str) -> Family {
    let parent = bookmark::bookmark(chats, key)
        .filter(|found| chats.iter().any(|chat| chat.key == found.parent.key))
        .map(|found| ParentRow { key: found.parent.key, title: found.parent.title, kind: found.parent.kind });
    let mut subchats = Vec::new();
    collect(chats, key, 0, &mut subchats);
    Family { parent, subchats }
}

fn collect(chats: &[FamilyChat], parent: &str, depth: usize, out: &mut Vec<SubchatRow>) {
    if depth > MAX_DEPTH {
        return;
    }
    for chat in chats.iter().filter(|chat| !chat.archived && chat.parent.as_deref() == Some(parent)) {
        out.push(SubchatRow { key: chat.key.clone(), title: chat.title.clone(), kind: chat.kind, depth });
        collect(chats, &chat.key, depth + 1, out);
    }
}

/// The Chats of the open Chat's scope, as the data source has them: a Chat with a turn running is Working, any other
/// is Done. The Workspace's list (with marks from the sidebar) replaces it.
pub fn from_source(source: &Arc<dyn DataSource>, key: &str) -> Vec<FamilyChat> {
    let Some((scope, _)) = key.rsplit_once('#') else { return Vec::new() };
    let scope = ScopeKey(scope.to_owned().into());
    let Ok(read) = data::now(source.read_state(scope.clone())) else { return Vec::new() };
    read.state
        .sessions
        .iter()
        .map(|(id, chat): (&ChatId, _)| {
            let running = chat.status == SessionStatus::Running;
            FamilyChat {
                key: scope.chat_key(*id),
                title: chat.display_title(&[]).to_string(),
                parent: chat.parent.map(|parent| scope.chat_key(parent)),
                archived: chat.archived,
                done: chat.done_at.is_some(),
                kind: if running { SubchatKind::Working } else { SubchatKind::Done },
                mark: if running { ChatMark::Running } else { ChatMark::Idle },
                background: 0,
            }
        })
        .collect()
}
