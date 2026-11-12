//! A Terminal whose shell runs elsewhere (a daemon's PTY), drawn by the same emulator and grid.
//!
//! A data layer that owns terminals sets [`Host`]. The drawer then opens each new Terminal through
//! [`TerminalHost::open`] instead of a local PTY: keys and sizes go to the returned [`RemoteTerminal`], and the
//! shell's output comes back as [`RemoteOutput`]s, which the view parses into its grid exactly as a local PTY's
//! bytes. The fixture app sets no host and keeps its local shell.

use std::sync::Arc;

use gpui::Global;

use super::session::GridSize;

/// Where a remote Terminal's keys, sizes and closing go.
pub trait RemoteTerminal: Send + Sync {
    fn input(&self, bytes: Vec<u8>);
    fn resize(&self, size: GridSize);
    /// The Terminal's tab closed: the host closes the shell.
    fn close(&self);
}

/// What the host's shell wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteOutput {
    Data(Vec<u8>),
    /// The host dropped output the reader had not read: the screen starts over from what follows.
    Reset,
    /// The shell ended.
    Ended,
    /// The host could not open or read the Terminal: shown in the grid, then the tab ends.
    Failed(String),
}

pub trait TerminalHost: Send + Sync + 'static {
    /// The shell's name for the tab, until it sets a title.
    fn shell_name(&self) -> String;
    /// Opens a Terminal for the Chat with this key at `size`. Output arrives on the receiver, in order.
    fn open(&self, chat: &str, size: GridSize) -> (Arc<dyn RemoteTerminal>, async_channel::Receiver<RemoteOutput>);
}

/// The app's terminal host, as a GPUI global.
#[derive(Clone)]
pub struct Host(pub Arc<dyn TerminalHost>);

impl Global for Host {}
