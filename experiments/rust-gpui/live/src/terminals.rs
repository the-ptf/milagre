//! [`LiveTerminals`]: the Terminal drawer on the runtime's own PTYs (`OwnedChatGuard::terminal_actions`).
//!
//! Two connections, as the client's contract requires (a `terminal:read` long-polls up to eight seconds and holds
//! every later call on its connection): the main one opens Terminals and sends input, resizes and closes; a second
//! connection through the same guard only reads. Each Terminal has one control thread (open, then its input, resizes
//! and close in order) and one reader thread (`read(after)` with the offset the runtime returned, a reset clearing
//! the screen, `ended` closing the tab). The client's futures need no executor, so each thread blocks on its own.
//! A Terminal opens in the owned Project's Chat the drawer belongs to; any other key is refused in the grid.
//!
//! Node-daemon mode ([`LiveTerminals::daemon`]): the same two connections, opened per Terminal on the Chat's own Project
//! (`Daemon::lasting_writer`, which opens its view) and closed with it. Refused in read-only mode.

use std::sync::Arc;
use std::sync::mpsc;

use futures::executor::block_on;
use milagre_daemon_client::{Client, TerminalActions, TerminalSize};
use milagre_gpui_spike::workspace::panel::terminal::remote::{RemoteOutput, RemoteTerminal, TerminalHost};
use milagre_gpui_spike::workspace::panel::terminal::session::GridSize;

use crate::daemon::{Daemon, Writer};
use crate::sinks::{chat_id, split_key};

enum Lanes {
    Owned {
        project: String,
        controls: TerminalActions,
        reads: TerminalActions,
        /// The reader connection, kept open while terminals may read (the capability holds it weakly).
        _reader: Client,
    },
    Daemon(Arc<Daemon>),
}

pub struct LiveTerminals {
    lanes: Lanes,
    shell: String,
}

impl LiveTerminals {
    /// Reads the runtime's default shell (it names the tabs; a failed read leaves the generic name).
    pub async fn new(project: String, controls: TerminalActions, reads: TerminalActions, reader: Client) -> Self {
        let shell = controls
            .profiles()
            .await
            .ok()
            .and_then(|profiles| profiles["defaultShell"].as_str().map(|path| path.rsplit('/').next().unwrap_or(path).to_owned()))
            .unwrap_or_else(|| "shell".into());
        Self { lanes: Lanes::Owned { project, controls, reads, _reader: reader }, shell }
    }

    /// The drawer on Milagre's daemon: each Terminal on its Chat's Project. Named after `$SHELL` (the daemon's
    /// profiles need an open view, so they are not read up front).
    pub fn daemon(daemon: Arc<Daemon>) -> Self {
        let shell = std::env::var("SHELL").ok().and_then(|s| s.rsplit('/').next().map(str::to_owned)).unwrap_or_else(|| "shell".into());
        Self { lanes: Lanes::Daemon(daemon), shell }
    }
}

/// One Terminal's two capabilities, and the daemon connections they live on (dropped with them).
struct Lane {
    controls: TerminalActions,
    reads: TerminalActions,
    keep: Option<(Writer, Writer)>,
}

fn size_of(size: GridSize) -> TerminalSize {
    TerminalSize { cols: size.cols.clamp(2, 1000) as u16, rows: size.lines.clamp(1, 500) as u16 }
}

enum Control {
    Input(Vec<u8>),
    Resize(GridSize),
    Close,
}

struct Sink(mpsc::Sender<Control>);

impl RemoteTerminal for Sink {
    fn input(&self, bytes: Vec<u8>) {
        let _ = self.0.send(Control::Input(bytes));
    }
    fn resize(&self, size: GridSize) {
        let _ = self.0.send(Control::Resize(size));
    }
    fn close(&self) {
        let _ = self.0.send(Control::Close);
    }
}

impl TerminalHost for LiveTerminals {
    fn shell_name(&self) -> String {
        self.shell.clone()
    }

    fn open(&self, chat: &str, size: GridSize) -> (Arc<dyn RemoteTerminal>, async_channel::Receiver<RemoteOutput>) {
        let (output, received) = async_channel::unbounded();
        let (controls_tx, controls_rx) = mpsc::channel();
        let sink: Arc<dyn RemoteTerminal> = Arc::new(Sink(controls_tx));
        let lane: Box<dyn FnOnce() -> Result<Lane, String> + Send> = match &self.lanes {
            Lanes::Owned { project, controls, reads, .. } => {
                if chat_id(project, chat).is_none() {
                    let _ = output.try_send(RemoteOutput::Failed("Terminals open in this runtime's Chats only.".into()));
                    return (sink, received);
                }
                let (controls, reads) = (controls.clone(), reads.clone());
                Box::new(move || Ok(Lane { controls, reads, keep: None }))
            }
            Lanes::Daemon(daemon) => {
                if daemon.read_only() {
                    let _ = output.try_send(RemoteOutput::Failed("Read-only: Terminals are off in this mode.".into()));
                    return (sink, received);
                }
                let Some((project, _)) = split_key(chat) else {
                    let _ = output.try_send(RemoteOutput::Failed("Terminals open in a Chat only.".into()));
                    return (sink, received);
                };
                let daemon = daemon.clone();
                Box::new(move || {
                    let open = |what: &str| {
                        block_on(daemon.lasting_writer(&project))
                            .map_err(|e| format!("Couldn't open the Terminal's {what} connection: {e:#}"))
                    };
                    let (control, reader) = (open("control")?, open("output")?);
                    let controls = control.terminals().map_err(|e| format!("{e:#}"))?;
                    let reads = reader.terminals().map_err(|e| format!("{e:#}"))?;
                    Ok(Lane { controls, reads, keep: Some((control, reader)) })
                })
            }
        };
        let Some(chat) = split_key(chat).map(|(_, id)| id) else {
            let _ = output.try_send(RemoteOutput::Failed("Terminals open in a Chat only.".into()));
            return (sink, received);
        };
        let (opened_tx, opened_rx) = mpsc::channel::<(String, TerminalActions, Option<Writer>)>();
        let failed = output.clone();
        std::thread::Builder::new()
            .name("milagre-terminal-controls".into())
            .spawn(move || {
                let Lane { controls, reads, keep } = match lane() {
                    Ok(lane) => lane,
                    Err(error) => {
                        let _ = failed.try_send(RemoteOutput::Failed(error));
                        return;
                    }
                };
                let (_control, reader) = match keep {
                    Some((control, reader)) => (Some(control), Some(reader)),
                    None => (None, None),
                };
                let id = match block_on(controls.open(chat, size_of(size))) {
                    Ok(opened) => match opened["id"].as_str() {
                        Some(id) => id.to_owned(),
                        None => {
                            let _ = failed.try_send(RemoteOutput::Failed(format!("The runtime opened no Terminal: {opened}")));
                            return;
                        }
                    },
                    Err(error) => {
                        let _ = failed.try_send(RemoteOutput::Failed(format!("Couldn't open a Terminal: {error}")));
                        return;
                    }
                };
                let _ = opened_tx.send((id.clone(), reads, reader));
                // In order: keys typed before the open finished wait in the channel.
                while let Ok(control) = controls_rx.recv() {
                    let result = match control {
                        Control::Input(bytes) => block_on(controls.input(&id, &String::from_utf8_lossy(&bytes))).map(|_| ()),
                        Control::Resize(size) => block_on(controls.resize(&id, size_of(size))).map(|_| ()),
                        Control::Close => {
                            let _ = block_on(controls.close(&id));
                            break;
                        }
                    };
                    if let Err(error) = result {
                        let _ = failed.try_send(RemoteOutput::Failed(format!("The Terminal stopped taking input: {error}")));
                    }
                }
            })
            .expect("a terminal control thread");
        std::thread::Builder::new()
            .name("milagre-terminal-reader".into())
            .spawn(move || {
                let Ok((id, reads, _reader)) = opened_rx.recv() else { return };
                let mut after = 0;
                while !output.is_closed() {
                    match block_on(reads.read(&id, after, None)) {
                        Ok(read) => {
                            if read["reset"] == true {
                                let _ = output.try_send(RemoteOutput::Reset);
                            }
                            if let Some(data) = read["data"].as_str().filter(|data| !data.is_empty()) {
                                let _ = output.try_send(RemoteOutput::Data(data.as_bytes().to_vec()));
                            }
                            after = read["offset"].as_u64().unwrap_or(after);
                            if read["ended"] == true {
                                let _ = output.try_send(RemoteOutput::Ended);
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = output.try_send(RemoteOutput::Failed(format!("The Terminal's output stopped: {error}")));
                            return;
                        }
                    }
                }
            })
            .expect("a terminal reader thread");
        (sink, received)
    }
}
