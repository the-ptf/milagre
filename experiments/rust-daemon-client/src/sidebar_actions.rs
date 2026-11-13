//! Bounded metadata actions, separate from local frontend pin policy.
use super::*;

/// Weak capability for one exact opened owned-runtime connection. No arbitrary
/// patch, directory, account, model, clock or archive/delete authority.
/// ```compile_fail
/// use milagre_daemon_client::SidebarActions;
/// fn forbidden(actions: &SidebarActions) {
///     let _ = actions.patch(1, serde_json::json!({"model":"other"}));
/// }
/// ```
#[derive(Clone)]
pub struct SidebarActions {
    handle: Weak<Handle>,
}
impl Client {
    pub(crate) fn owned_sidebar_for(&self, authority: &Arc<Authority>) -> Result<SidebarActions> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !Weak::ptr_eq(&self.handle.authority, &Arc::downgrade(authority)) {
            return Err(Error::InvalidScope);
        }
        Ok(SidebarActions {
            handle: Arc::downgrade(&self.handle),
        })
    }
}
impl SidebarActions {
    fn client(&self) -> Result<Client> {
        let handle = self.handle.upgrade().ok_or(Error::Disconnected)?;
        if handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !handle.opened_view.load(Ordering::Acquire) {
            return Err(Error::ViewNotOpened);
        }
        Ok(Client { handle })
    }
    fn enqueue(&self, chat: u64, patch: Value) -> Result<reply::Receiver<Value>> {
        let client = self.client()?;
        ScriptedActions::chat(chat)?;
        let args = json!([client.handle.project, chat, patch]);
        if args.to_string().len() > 128 * 1024 {
            return Err(input("payload", "Encoded sidebar arguments exceed 128 KiB"));
        }
        let (reply, wait) = reply::channel();
        client.submit(Kind::Call {
            method: "chat:patch",
            args,
            reply,
        })?;
        // The transient Client drops here, before a pending reply is awaited.
        Ok(wait)
    }
    /// Empty title removes the explicit title. No trimming or truncation occurs.
    pub async fn rename(&self, chat: u64, title: &str) -> Result<Value> {
        drop(self.client()?);
        if title.len() > 3 * 16_384 || title.encode_utf16().count() > 16_384 {
            return Err(input("title", "Title exceeds 16384 UTF-16 units"));
        }
        self.enqueue(chat, json!({"title":title}))?.await
    }
    /// Done marks the Chat read and ends its targeting routines on the backend.
    /// Reopen clears Done, without restarting completed routines.
    pub async fn mark_done(&self, chat: u64, done: bool) -> Result<Value> {
        let patch = if done {
            json!({"done":true,"unread":false})
        } else {
            json!({"done":false})
        };
        self.enqueue(chat, patch)?.await
    }
    /// Keep a hidden Run Chat visible. Frontends own their device-local pin state.
    pub async fn keep(&self, chat: u64) -> Result<Value> {
        self.enqueue(chat, json!({"kept":true}))?.await
    }
    /// Restore an already archived Chat; never archives or deletes one.
    pub async fn restore(&self, chat: u64) -> Result<Value> {
        self.enqueue(chat, json!({"archived":false}))?.await
    }
}
