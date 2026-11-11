//! A fake PTY with the shape of terminals.test.cjs's `fakePty`, and helpers shared by the test files.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use milagre_terminals::paths::host_basename;
use milagre_terminals::{ExitInfo, PtyOutput, PtyProcess, PtySpawner, ResolveChat, SpawnRequest, TerminalEvent, Worktree};

pub struct FakePty {
    pub request: SpawnRequest,
    pub process: Mutex<String>,
    pub written: Mutex<Vec<String>>,
    pub sizes: Mutex<Vec<(u16, u16)>>,
    pub killed: AtomicBool,
    output: Arc<dyn PtyOutput>,
}

impl FakePty {
    pub fn emit(&self, text: &str) {
        self.output.data(text);
    }
    pub fn exit(&self) {
        self.output.exit(ExitInfo { exit_code: 0, signal: None });
    }
    pub fn set_process(&self, name: &str) {
        *self.process.lock().unwrap() = name.to_owned();
    }
    pub fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }
    pub fn written(&self) -> Vec<String> {
        self.written.lock().unwrap().clone()
    }
    pub fn sizes(&self) -> Vec<(u16, u16)> {
        self.sizes.lock().unwrap().clone()
    }
}

struct Handle(Arc<FakePty>);

impl PtyProcess for Handle {
    fn pid(&self) -> Option<u32> {
        Some(4242)
    }
    fn process(&self) -> String {
        self.0.process.lock().unwrap().clone()
    }
    fn write(&self, data: &str) -> Result<(), String> {
        self.0.written.lock().unwrap().push(data.to_owned());
        Ok(())
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.0.sizes.lock().unwrap().push((cols, rows));
        Ok(())
    }
    fn kill(&self) {
        self.0.killed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct FakeSpawner {
    pub ptys: Mutex<Vec<Arc<FakePty>>>,
}

impl FakeSpawner {
    pub fn pty(&self, index: usize) -> Arc<FakePty> {
        self.ptys.lock().unwrap()[index].clone()
    }
    pub fn count(&self) -> usize {
        self.ptys.lock().unwrap().len()
    }
}

impl PtySpawner for FakeSpawner {
    fn spawn(&self, request: SpawnRequest, output: Arc<dyn PtyOutput>) -> Result<Box<dyn PtyProcess>, String> {
        let pty = Arc::new(FakePty {
            process: Mutex::new(host_basename(&request.file).to_owned()),
            request,
            written: Mutex::default(),
            sizes: Mutex::default(),
            killed: AtomicBool::new(false),
            output,
        });
        self.ptys.lock().unwrap().push(pty.clone());
        Ok(Box::new(Handle(pty)))
    }
}

/// `resolveChat` over a fixed map; unknown Chats fail as archived ones do.
pub fn resolver(chats: HashMap<String, Vec<Worktree>>) -> ResolveChat {
    let chats = Arc::new(chats);
    Arc::new(move |chat_id: String| {
        let chats = chats.clone();
        Box::pin(async move { chats.get(&chat_id).cloned().ok_or_else(|| "This Chat is archived.".to_owned()) })
    })
}

pub fn worktree(path: &std::path::Path, label: Option<&str>) -> Worktree {
    Worktree { path: path.to_string_lossy().into_owned(), label: label.map(str::to_owned) }
}

#[derive(Clone, Default)]
pub struct Events(pub Arc<Mutex<Vec<TerminalEvent>>>);

impl Events {
    pub fn sink(&self) -> Arc<dyn Fn(TerminalEvent) + Send + Sync> {
        let events = self.0.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    }
    pub fn take(&self) -> Vec<TerminalEvent> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}
