//! Terminal capability for one explicitly opened dedicated Chat connection.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}
impl Default for TerminalSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}
impl TerminalSize {
    fn check(self) -> Result<()> {
        if !(2..=1000).contains(&self.cols) || !(1..=500).contains(&self.rows) {
            return Err(input("size", "Expected 2..=1000 columns and 1..=500 rows"));
        }
        Ok(())
    }
}

/// Weak actions for the exact Client/guard pair. No shell, cwd, arbitrary RPC,
/// reconnect, retry, or implicit view-opening capability is exposed.
#[derive(Clone)]
pub struct TerminalActions {
    handle: Weak<Handle>,
}
impl Client {
    pub(crate) fn owned_terminals_for(
        &self,
        authority: &Arc<Authority>,
    ) -> Result<TerminalActions> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !Weak::ptr_eq(&self.handle.authority, &Arc::downgrade(authority)) {
            return Err(Error::InvalidScope);
        }
        Ok(TerminalActions {
            handle: Arc::downgrade(&self.handle),
        })
    }
}
impl TerminalActions {
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
    fn id(id: &str) -> Result<()> {
        if id.len() != 36
            || !id.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            })
        {
            return Err(input("terminal_id", "Expected a canonical lowercase UUID"));
        }
        Ok(())
    }
    fn key(client: &Client, chat: u64) -> Result<String> {
        ScriptedActions::chat(chat)?;
        Ok(format!("{}#{chat}", client.handle.project))
    }
    // Drop the transient Client before waiting. Holding an action or an admitted
    // wait cannot keep a dropped Client alive, and nothing retries a lost receipt.
    fn enqueue(
        client: Client,
        method: &'static str,
        argument: Value,
    ) -> Result<reply::Receiver<Value>> {
        let args = json!([argument]);
        if args.to_string().len() > 512 * 1024 {
            return Err(input(
                "payload",
                "Encoded terminal arguments exceed 512 KiB",
            ));
        }
        let (reply, wait) = reply::channel();
        client.submit(Kind::Call {
            method,
            args,
            reply,
        })?;
        Ok(wait)
    }
    pub async fn list(&self, chat: u64) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        Self::enqueue(client, "terminal:list", json!({"chatId":key}))?.await
    }
    pub async fn profiles(&self) -> Result<Value> {
        Self::enqueue(self.client()?, "terminal:profiles", json!({}))?.await
    }
    /// Open the daemon-owned default shell in this Chat's granted Project folder.
    /// An uncertain result must be reconciled with list, never replayed blindly.
    pub async fn open(&self, chat: u64, size: TerminalSize) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        size.check()?;
        Self::enqueue(
            client,
            "terminal:open",
            json!({"chatId":key,"cols":size.cols,"rows":size.rows}),
        )?
        .await
    }
    /// Read using the server's UTF-16 offset, reset, and ended metadata unchanged.
    /// The daemon can long-poll. This client's I/O operations are serialized.
    pub async fn read(&self, terminal_id: &str, after: u64, limit: Option<u64>) -> Result<Value> {
        let client = self.client()?;
        Self::id(terminal_id)?;
        if after > 9_007_199_254_740_991 {
            return Err(input(
                "after",
                "Expected a JSON-safe unsigned UTF-16 offset",
            ));
        }
        if limit.is_some_and(|limit| !(4096..=1_048_576).contains(&limit)) {
            return Err(input("limit", "Expected 4096..=1048576 UTF-16 units"));
        }
        let mut argument = json!({"terminalId":terminal_id,"after":after});
        if let Some(limit) = limit {
            argument["limit"] = json!(limit);
        }
        Self::enqueue(client, "terminal:read", argument)?.await
    }
    /// At most 64 KiB of UTF-8 per input. A lost receipt can mean input ran;
    /// neither disconnect nor a dropped future proves it was not written.
    pub async fn input(&self, terminal_id: &str, data: &str) -> Result<Value> {
        let client = self.client()?;
        Self::id(terminal_id)?;
        if data.len() > 64 * 1024 {
            return Err(input("data", "Terminal input exceeds 65536 UTF-8 bytes"));
        }
        Self::enqueue(
            client,
            "terminal:input",
            json!({"terminalId":terminal_id,"data":data}),
        )?
        .await
    }
    pub async fn resize(&self, terminal_id: &str, size: TerminalSize) -> Result<Value> {
        let client = self.client()?;
        Self::id(terminal_id)?;
        size.check()?;
        Self::enqueue(
            client,
            "terminal:resize",
            json!({"terminalId":terminal_id,"cols":size.cols,"rows":size.rows}),
        )?
        .await
    }
    pub async fn close(&self, terminal_id: &str) -> Result<Value> {
        let client = self.client()?;
        Self::id(terminal_id)?;
        Self::enqueue(client, "terminal:close", json!({"terminalId":terminal_id}))?.await
    }
}
