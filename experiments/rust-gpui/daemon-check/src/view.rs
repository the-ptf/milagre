//! What the check crate puts in front of the base crate's views, without editing them.
//!
//! - [`open_on_select`]: the explicit open-on-select seam. A caller that selected a Chat row calls it; it opens the
//!   row's Project on this connection (`project:open`, which may persist owner state) and then reads the Chat's first
//!   page. The adapter's own `chat_messages` never opens anything.
//! - [`transcript_items`]: a message page as the base transcript's items (`Item::User`, `Item::Prose`).
//!
//! Seams the base crate does not have yet (so the GPUI test swaps the Chat column's public `transcript` entity):
//! `ChatView` has no way to be given a Chat (its title and Project label are private fixture text), `Workspace`
//! routes a sidebar selection only to the panel, and `Transcript` has no setter for a new item list.

use anyhow::{Context as _, Result, bail};
use milagre_gpui_spike::data::{DataSource, LOCAL, MessagePage, PageRequest, Role, ScopeKey};
use milagre_gpui_spike::workspace::chat::transcript::{Item, Prose};

use crate::DaemonAdapter;

/// Opens the selected row's Project on this connection, then reads that Chat's opening page. `key` is the row's
/// Chat key (`<path>#<id>`, this computer's).
pub async fn open_on_select(adapter: &DaemonAdapter, key: &str) -> Result<MessagePage> {
    let (path, id) = key.rsplit_once('#').context("a Chat key is <path>#<id>")?;
    let id: u64 = id.parse().context("a Chat id is a number")?;
    adapter.open_project(LOCAL.into(), path.to_owned().into()).await?;
    adapter.chat_messages(ScopeKey::project(LOCAL, path), id, PageRequest::OPEN).await
}

/// The page as transcript items, oldest first: a user message is `Item::User`, a reply `Item::Prose`. Steps and
/// message contexts have no item mapping in this stage: a message carrying them is an error, not dropped.
pub fn transcript_items(page: &MessagePage) -> Result<Vec<Item>> {
    page.messages
        .iter()
        .map(|message| {
            if !message.steps.is_empty() || message.context.is_some() {
                bail!("message {} has steps or a context; transcript cards for them are not mapped in this stage", message.id);
            }
            Ok(match message.role {
                Role::User => Item::User(message.body.clone()),
                Role::Assistant => Item::Prose(Prose::new(message.body.clone())),
            })
        })
        .collect()
}
