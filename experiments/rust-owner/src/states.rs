//! The single writer of each Project's in-memory state: `packages/core/src/project-states.cjs` with message-store.cjs
//! lazy Chats, ported for Projects inside an [`Isolation`].
//!
//! Node runs this on timers and promises; here time is the caller's ([`ProjectStates::advance`]), so a run is
//! deterministic and replayable. What happens is the same, in the same order:
//!
//! - every change goes through [`ProjectStates::update`], one at a time (`&mut self`);
//! - a change is kept at once and saved 250 ms after the last change to its Project (`debounce_ms`), at most one save
//!   per Project at a time; [`ProjectStates::flush`] is the durability boundary (quit, an accepted user message);
//! - a Chat nobody touched for ten minutes (`idle_ms`), not busy and saved as it is, is unloaded by a sweep every
//!   minute (`sweep_ms`); a change or read that names it loads it back; a read that names Chats sheds the old ones on
//!   the Project's first read;
//! - a failed save keeps the state dirty and puts `persistence: { error, code?, saving }` on the state until a save
//!   succeeds; `persist: false` changes stay in memory (transient) until the next persisted one, a retry or close.
//!
//! Saves are synchronous here, so Node's "a sweep skips a Project whose save is in flight" can't arise; everything
//! else about ordering is as Node's timers order it (each due save and sweep runs at its own time, earliest first).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::chat_db::{ChatId, LookupField};
use crate::commands::{chat_page, PageOptions};
use crate::error::{Result, StoreError};
use crate::isolation::Isolation;
use crate::jsjson;
use crate::message_store::{self, chat_number, Msg, MsgRef, ProjectState};
use crate::owner::{OwnedProject, Same};
use crate::project::ProjectRepository;
use crate::write::{SaveOptions, SaveReport};

/// project-states.cjs timing. Node's defaults.
#[derive(Clone, Debug)]
pub struct Timing {
    pub debounce_ms: i64,
    pub idle_ms: i64,
    pub sweep_ms: i64,
    /// Lazy Chats (the runtime's `messages` option). Without it every message stays in memory.
    pub lazy: bool,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            debounce_ms: 250,
            idle_ms: 10 * 60 * 1000,
            sweep_ms: 60 * 1000,
            lazy: true,
        }
    }
}

/// What the states told the world: Node's `persistenceChanged`, the `unloaded` hook, and each save's outcome.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Saved {
        project: PathBuf,
        report: SaveReport,
    },
    SaveFailed {
        project: PathBuf,
        error: String,
    },
    Persistence {
        project: PathBuf,
        persistence: Option<Value>,
    },
    Unloaded {
        project: PathBuf,
    },
}

struct Slot {
    owner: OwnedProject,
    state: ProjectState,
    dirty: Option<ProjectState>,
    /// The save timer: when it fires (Node's `due` + setTimeout).
    timer: Option<i64>,
    due: Option<i64>,
    transient: bool,
    failure: Option<Value>,
    touches: HashMap<ChatId, i64>,
    read_at: i64,
}

/// The in-memory states of the Projects of one isolated copy, each owned (locked) by this process while open.
pub struct ProjectStates {
    /// Tests only (see `fail_next_commit`).
    #[cfg(feature = "test-fixtures")]
    fail_next_commit: Option<String>,
    isolation: Isolation,
    timing: Timing,
    now: i64,
    slots: HashMap<PathBuf, Slot>,
    order: Vec<PathBuf>,
    sweep_next: Option<i64>,
    closed: bool,
    busy: HashSet<(PathBuf, ChatId)>,
    events: Vec<Event>,
    sweep_min_age: Duration,
    /// Locks a dropped Project could not release (its root no longer holds): left on disk, told by `take_stranded`.
    stranded: crate::ownership::StrandedLocks,
}

fn without_key(state: &ProjectState, key: &str) -> ProjectState {
    if !state.rest.contains_key(key) {
        return state.clone();
    }
    let mut next = state.clone();
    Arc::make_mut(&mut next.rest).shift_remove(key);
    next
}

impl ProjectStates {
    /// States for the Projects of `isolation`, the clock starting at `now` (ms since the epoch).
    /// Tests only, compiled only with the `test-fixtures` feature (the crate's own tests enable it; no build of the
    /// owner does): the next change that would be kept fails after its closure ran, where a failed load or settle of a
    /// real change lands (nothing is kept). For checking callers' rollback.
    #[cfg(feature = "test-fixtures")]
    pub fn fail_next_commit(&mut self, message: &str) {
        self.fail_next_commit = Some(message.into());
    }

    pub fn new(isolation: Isolation, timing: Timing, now: i64) -> Self {
        ProjectStates {
            #[cfg(feature = "test-fixtures")]
            fail_next_commit: None,
            isolation,
            timing,
            now,
            slots: HashMap::new(),
            order: Vec::new(),
            sweep_next: None,
            closed: false,
            busy: HashSet::new(),
            events: Vec::new(),
            sweep_min_age: Duration::from_secs(60),
            stranded: Default::default(),
        }
    }

    /// Locks left on disk since the last take because a Project was dropped while its root no longer held (moved,
    /// replaced, a link on or above it). Nothing was removed; an operator removes them.
    pub fn take_stranded(&self) -> crate::ownership::Stranded {
        self.stranded.take()
    }

    /// The isolated copy these states write in.
    pub fn isolation(&self) -> &Isolation {
        &self.isolation
    }

    /// Node's saveProjectState sweep age (a minute); tests that save from a fixed clock may shorten it.
    pub fn set_sweep_min_age(&mut self, age: Duration) {
        self.sweep_min_age = age;
    }

    pub fn now(&self) -> i64 {
        self.now
    }

    /// What happened since the last call.
    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// The runtime's `active(projectPath, chat)`: a Chat with a turn running isn't unloaded.
    pub fn set_busy(&mut self, project: &Path, chat: ChatId, busy: bool) -> Result<()> {
        let key = self.key(project)?;
        if busy {
            self.busy.insert((key, chat));
        } else {
            self.busy.remove(&(key, chat));
        }
        Ok(())
    }

    fn active(&self, key: &Path, chat: ChatId) -> bool {
        self.busy.contains(&(key.to_path_buf(), chat))
    }

    pub fn has(&self, project: &Path) -> bool {
        self.key(project)
            .is_ok_and(|key| self.slots.contains_key(&key))
    }

    /// Whether these states still own an open Project: for a content callback (a sidecar, an artifact) about to write
    /// next to the Project's state. Fails when it isn't open here or its lock was released, removed or replaced
    /// (see OwnerGuard::verify); the error never carries the lock's token.
    pub fn assert_owned(&self, project: &Path) -> Result<()> {
        let key = self.key(project)?;
        let slot = self.slots.get(&key).ok_or_else(|| {
            StoreError::Invalid(format!("{} isn't open in these states.", key.display()))
        })?;
        slot.owner.verify_owned()
    }

    /// The state a Project holds in memory now, if it is open (no read, no load).
    pub fn current(&self, project: &Path) -> Option<ProjectState> {
        let key = self.key(project).ok()?;
        self.slots.get(&key).map(|slot| slot.state.clone())
    }

    pub fn projects(&self) -> Vec<PathBuf> {
        self.order.clone()
    }

    /// The key these states hold a Project under (its path inside the isolation, resolved without creating anything):
    /// one spelling per Project, for callers that key their own maps by it.
    pub fn canonical(&self, project: &Path) -> Result<PathBuf> {
        self.key(project)
    }

    /// A Project's key: its path inside the isolation, resolved without creating anything.
    ///
    /// A Project open here was checked in full when it opened (no link on its path, nothing linked in its
    /// `.milagre`), and every write checks again what a write could follow (`OwnedProject::verify_owned`): its key is
    /// its path worked out from the text alone. Any other path is resolved in full (`Isolation::resolve`), which walks
    /// the disk.
    fn key(&self, project: &Path) -> Result<PathBuf> {
        let normal = self.isolation.normalize(project)?;
        if self.slots.contains_key(&normal) {
            return Ok(normal);
        }
        self.isolation.resolve(project)
    }

    // ---- reading and changing ------------------------------------------------------------------------------

    /// compactProjectDetails: long details of the messages a change added go to sidecars. Failures leave it as is.
    fn slim(
        owner: &OwnedProject,
        next: ProjectState,
        previous: Option<&ProjectState>,
    ) -> ProjectState {
        if previous.is_some_and(|previous| previous.same_messages(&next)) || next.messages.is_none()
        {
            return next;
        }
        let known: Option<HashSet<*const Msg>> =
            previous.map(|previous| previous.message_list().iter().map(Arc::as_ptr).collect());
        match owner.compact_details(next.message_list(), known.as_ref()) {
            Ok((messages, true)) => {
                let unloaded = next.unloaded.clone();
                let mut compacted = next.with_messages(messages);
                compacted.unloaded = unloaded;
                compacted
            }
            _ => next,
        }
    }

    fn open_slot(&mut self, key: &Path, chats: Option<&[ChatId]>) -> Result<()> {
        if self.slots.contains_key(key) {
            return Ok(());
        }
        let mut owner = OwnedProject::open(&self.isolation, key, Some(self.stranded.clone()))?;
        let (state, _) = match owner.load_shared() {
            Ok(read) => read,
            Err(error) => {
                owner.release()?;
                return Err(error);
            }
        };
        let mut state = Self::slim(&owner, state, None);
        // A change that names no Chats loads every one back, so only a read that names them sheds the old ones here.
        if self.timing.lazy && chats.is_some() {
            state = self.shed_old(key, &mut owner, &state);
        }
        let slot = Slot {
            owner,
            state,
            dirty: None,
            timer: None,
            due: None,
            transient: false,
            failure: None,
            touches: HashMap::new(),
            read_at: self.now,
        };
        self.slots.insert(key.to_path_buf(), slot);
        self.order.push(key.to_path_buf());
        if self.timing.lazy && self.sweep_next.is_none() && self.timing.sweep_ms > 0 {
            self.sweep_next = Some(self.now + self.timing.sweep_ms);
        }
        Ok(())
    }

    /// shedOld: a state just read, without the Chats whose last message is older than `idle_ms` and that aren't busy.
    fn shed_old(&self, key: &Path, owner: &mut OwnedProject, state: &ProjectState) -> ProjectState {
        let mut old = BTreeSet::new();
        if let Some(sessions) = state.sessions() {
            for (id, session) in sessions {
                let last = session
                    .get("summary")
                    .and_then(|summary| summary.get("lastAt"));
                let last = last.and_then(|value| {
                    chat_number(Some(value))
                        .map(|n| n as f64)
                        .or_else(|| value.as_f64())
                });
                let Some(chat) = chat_number(Some(&Value::String(id.clone()))) else {
                    continue;
                };
                if last.is_some_and(|last| (self.now as f64) - last >= self.timing.idle_ms as f64)
                    && !self.active(key, chat)
                {
                    old.insert(chat);
                }
            }
        }
        if old.is_empty() || state.messages.is_none() {
            return state.clone();
        }
        let (_, store) = owner.cache();
        message_store::unload_chats(store, state, &old)
    }

    fn touch(&mut self, key: &Path, chats: impl IntoIterator<Item = ChatId>) {
        let now = self.now;
        if let Some(slot) = self.slots.get_mut(key) {
            for chat in chats {
                slot.touches.insert(chat, now);
            }
        }
    }

    /// prepare: the state with the Chats a change asked for loaded (every unloaded one when it named none).
    fn prepare(&mut self, key: &Path, chats: Option<&[ChatId]>) -> Result<()> {
        if let Some(chats) = chats {
            self.touch(key, chats.iter().copied());
        }
        let slot = self.slots.get_mut(key).expect("open");
        if slot.state.unloaded.is_empty() {
            return Ok(());
        }
        let wanted: Vec<ChatId> = match chats {
            None => slot.state.unloaded.iter().copied().collect(),
            Some(chats) => chats
                .iter()
                .copied()
                .filter(|chat| slot.state.unloaded.contains(chat))
                .collect(),
        };
        if chats.is_none() {
            let now = self.now;
            for chat in &wanted {
                slot.touches.insert(*chat, now);
            }
        }
        if !wanted.is_empty() {
            let state = slot.state.clone();
            let (db, store) = slot.owner.cache();
            slot.state = message_store::load_chats(db, store, &state, &wanted)?;
        }
        Ok(())
    }

    /// withPersistence: save status is runtime metadata, kept on the state but never saved.
    fn with_persistence(failure: Option<&Value>, state: ProjectState) -> ProjectState {
        if state.rest.get("persistence") == failure {
            return state;
        }
        let mut next = without_key(&state, "persistence");
        if let Some(failure) = failure {
            Arc::make_mut(&mut next.rest).insert("persistence".into(), failure.clone());
        }
        next
    }

    /// update: runs `change` on the latest state and keeps what it returns (None: unchanged). `chats` names the
    /// Chats it reads or writes (loaded first); None loads every unloaded Chat; `Some(&[])` none. Returns the state
    /// and whether it changed.
    pub fn update(
        &mut self,
        project: &Path,
        chats: Option<&[ChatId]>,
        persist: bool,
        change: impl FnOnce(&ProjectState) -> Option<ProjectState>,
    ) -> Result<(ProjectState, bool)> {
        self.try_update(project, chats, persist, |state| Ok(change(state)))
    }

    /// update with a change that can fail: its error rejects the update and nothing is kept (Node's change throwing).
    pub fn try_update(
        &mut self,
        project: &Path,
        chats: Option<&[ChatId]>,
        persist: bool,
        change: impl FnOnce(&ProjectState) -> Result<Option<ProjectState>>,
    ) -> Result<(ProjectState, bool)> {
        if self.closed {
            return Err(StoreError::Invalid("Project state is closed".into()));
        }
        let key = self.key(project)?;
        self.open_slot(&key, chats)?;
        if self.timing.lazy {
            self.prepare(&key, chats)?;
        }
        let state = self.slots[&key].state.clone();
        let Some(changed) = change(&state)? else {
            return Ok((state, false));
        };
        #[cfg(feature = "test-fixtures")]
        if let Some(message) = self.fail_next_commit.take() {
            return Err(StoreError::Invalid(message));
        }
        let mut next = changed;
        let mut unloaded = None;
        if self.timing.lazy {
            let slot = self.slots.get_mut(&key).expect("open");
            let (db, store) = slot.owner.cache();
            let (settled, touched) = message_store::settle(db, store, Some(&state), next)?;
            next = settled;
            unloaded = Some(next.unloaded.clone());
            self.touch(&key, touched);
        }
        let slot = self.slots.get_mut(&key).expect("open");
        next = Self::slim(&slot.owner, next, Some(&state));
        if let Some(unloaded) = unloaded {
            next.unloaded = unloaded;
        }
        next = Self::with_persistence(slot.failure.as_ref(), next);
        slot.state = next.clone();
        if persist {
            slot.transient = false;
            slot.dirty = Some(next.clone());
            slot.due = Some(self.now + self.timing.debounce_ms);
            slot.timer = slot.due;
        } else {
            slot.transient = true;
        }
        Ok((next, true))
    }

    /// get: the latest state (unloaded Chats' messages left out).
    pub fn get(&mut self, project: &Path) -> Result<ProjectState> {
        Ok(self.update(project, Some(&[]), true, |_| None)?.0)
    }

    /// load: the latest state with the Chats `chats` loaded.
    pub fn load(&mut self, project: &Path, chats: &[ChatId]) -> Result<ProjectState> {
        Ok(self.update(project, Some(chats), true, |_| None)?.0)
    }

    /// The state and the message cache for a read that loads nothing (readWith).
    fn read_with<T>(
        &mut self,
        project: &Path,
        read: impl FnOnce(&mut Slot) -> Result<T>,
    ) -> Result<T> {
        let key = self.key(project)?;
        self.update(&key, Some(&[]), true, |_| None)?;
        read(self.slots.get_mut(&key).expect("open"))
    }

    // ---- saving --------------------------------------------------------------------------------------------

    fn set_persistence(&mut self, key: &Path, persistence: Option<Value>) {
        let slot = self.slots.get_mut(key).expect("open");
        slot.failure = persistence.clone();
        slot.state = Self::with_persistence(slot.failure.as_ref(), slot.state.clone());
        self.events.push(Event::Persistence {
            project: key.to_path_buf(),
            persistence: slot.state.rest.get("persistence").cloned(),
        });
    }

    fn sweep_clock(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(self.now.max(0) as u64)
    }

    /// write: saves the Project's dirty state, if any. A failure keeps it dirty and says so on the state.
    fn write(&mut self, key: &Path) -> Result<()> {
        let Some(slot) = self.slots.get_mut(key) else {
            return Ok(());
        };
        let Some(dirty) = slot.dirty.take() else {
            return Ok(());
        };
        let state = without_key(&dirty, "persistence");
        if let Some(failure) = slot.failure.clone() {
            let mut saving = failure.as_object().cloned().unwrap_or_default();
            saving.insert("saving".into(), Value::Bool(true));
            self.set_persistence(key, Some(Value::Object(saving)));
        }
        let options = SaveOptions {
            sweep_min_age: self.sweep_min_age,
            now: Some(self.sweep_clock()),
            ..Default::default()
        };
        let slot = self.slots.get_mut(key).expect("open");
        match slot.owner.save_state(&state, &options, Same::Identity) {
            Ok(report) => {
                self.events.push(Event::Saved {
                    project: key.to_path_buf(),
                    report,
                });
                let slot = self.slots.get_mut(key).expect("open");
                if let Some(failure) = slot.failure.clone() {
                    let unsaved = slot.dirty.is_some() || slot.transient;
                    let next = unsaved.then(|| {
                        let mut kept = failure.as_object().cloned().unwrap_or_default();
                        kept.insert("saving".into(), Value::Bool(false));
                        Value::Object(kept)
                    });
                    self.set_persistence(key, next);
                }
                Ok(())
            }
            Err(error) => {
                if slot.dirty.is_none() {
                    slot.dirty = Some(state);
                }
                let mut failure = Map::new();
                failure.insert("error".into(), Value::String(error.to_string()));
                if let Some(code) = error.code() {
                    failure.insert("code".into(), Value::String(code.into()));
                }
                failure.insert("saving".into(), Value::Bool(false));
                self.events.push(Event::SaveFailed {
                    project: key.to_path_buf(),
                    error: error.to_string(),
                });
                self.set_persistence(key, Some(Value::Object(failure)));
                Err(error)
            }
        }
    }

    /// Moves the clock to `now`, running the saves and sweeps that fall due on the way, each at its own time.
    /// A failed save is reported in the events (as Node logs it) and stays dirty.
    pub fn advance(&mut self, now: i64) {
        loop {
            let next_save = self
                .order
                .iter()
                .filter_map(|key| self.slots[key].timer.map(|at| (at, key.clone())))
                .min_by_key(|(at, _)| *at);
            let next_sweep = self.sweep_next.filter(|_| !self.closed);
            let save_first = match (&next_save, next_sweep) {
                (Some((at, _)), Some(sweep)) => *at <= sweep,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };
            if save_first {
                let (at, key) = next_save.unwrap();
                if at > now {
                    break;
                }
                self.now = self.now.max(at);
                self.slots.get_mut(&key).expect("open").timer = None;
                let _ = self.write(&key);
            } else {
                let at = next_sweep.unwrap();
                if at > now {
                    break;
                }
                self.now = self.now.max(at);
                self.sweep_next = Some(at + self.timing.sweep_ms);
                let _ = self.unload_idle();
            }
        }
        self.now = self.now.max(now);
    }

    /// unloadIdle: in each Project with nothing waiting to be saved, unloads the Chats not touched for `idle_ms`
    /// whose turn isn't busy and that chats.db holds as memory does.
    pub fn unload_idle(&mut self) -> Result<()> {
        if !self.timing.lazy || self.closed {
            return Ok(());
        }
        for key in self.order.clone() {
            let now = self.now;
            let idle_ms = self.timing.idle_ms;
            let slot = &self.slots[&key];
            if slot.dirty.is_some() || slot.state.messages.is_none() {
                continue;
            }
            let mut idle = BTreeSet::new();
            let mut checked = HashSet::new();
            for message in slot.state.message_list() {
                let Some(chat) = message_store::chat_of(message) else {
                    continue;
                };
                if !checked.insert(chat) {
                    continue;
                }
                let since = slot.touches.get(&chat).copied().unwrap_or(slot.read_at);
                if now - since >= idle_ms && !self.active(&key, chat) {
                    idle.insert(chat);
                }
            }
            if idle.is_empty() {
                continue;
            }
            let slot = self.slots.get_mut(&key).expect("open");
            let state = slot.state.clone();
            let (_, store) = slot.owner.cache();
            let next = message_store::unload_chats(store, &state, &idle);
            if next.same_messages(&state) {
                continue;
            }
            slot.state = next;
            self.events.push(Event::Unloaded {
                project: key.clone(),
            });
        }
        Ok(())
    }

    /// flush: saves every dirty Project (or one). The durability boundary; the first failure is returned after the
    /// others were tried.
    pub fn flush(&mut self, project: Option<&Path>) -> Result<()> {
        let keys: Vec<PathBuf> = match project {
            Some(project) => vec![self.key(project)?],
            None => self.order.clone(),
        };
        let mut first = None;
        for key in keys {
            if let Some(slot) = self.slots.get_mut(&key) {
                slot.timer = None;
                if let Err(error) = self.write(&key) {
                    first.get_or_insert(error);
                }
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// retry: an explicit retry saves the latest state, transient changes included.
    pub fn retry(&mut self, project: &Path) -> Result<()> {
        let key = self.key(project)?;
        let slot = self.slots.get_mut(&key).ok_or_else(|| {
            StoreError::Invalid("Open the Project before retrying its save.".into())
        })?;
        if slot.failure.is_none() {
            return Ok(());
        }
        slot.dirty = Some(slot.state.clone());
        slot.transient = false;
        self.flush(Some(&key))
    }

    /// close: no more changes; transient changes are saved with the rest, then every lock is released.
    ///
    /// As in Node, a close whose flush fails rejects and keeps everything: the states stay closed to new changes but
    /// in memory, still dirty and owned (their locks held), so `retry` can save them and a later `close` finish.
    /// Locks are released only once every Project saved.
    pub fn close(&mut self) -> Result<()> {
        self.closed = true;
        for key in self.order.clone() {
            let slot = self.slots.get_mut(&key).expect("open");
            if slot.transient {
                slot.dirty = Some(slot.state.clone());
                slot.transient = false;
            }
        }
        self.flush(None)?;
        let mut released = Ok(());
        for key in std::mem::take(&mut self.order) {
            if let Some(slot) = self.slots.remove(&key) {
                if let Err(error) = slot.owner.release() {
                    released = released.and(Err(error));
                }
            }
        }
        released
    }

    /// Whether `close` has run (successfully or not): no change is taken any more.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// forget: saves a Project, then drops it (and its lock) as if it was never read.
    pub fn forget(&mut self, project: &Path) -> Result<()> {
        let key = self.key(project)?;
        self.flush(Some(&key))?;
        if let Some(slot) = self.slots.remove(&key) {
            self.order.retain(|known| known != &key);
            self.busy.retain(|(known, _)| known != &key);
            slot.owner.release()?;
        }
        Ok(())
    }

    /// Drops everything without saving, releasing the locks: the in-memory part of a crash (the owner of a real
    /// crash leaves its lock, which this owner then refuses until an operator removes it).
    pub fn abandon(self) -> Result<()> {
        for (_, slot) in self.slots {
            slot.owner.release()?;
        }
        Ok(())
    }

    // ---- reads (runtime.cjs read paths) --------------------------------------------------------------------

    /// wholeState: the state with every message, for a client that takes whole states.
    pub fn whole_state(&mut self, project: &Path) -> Result<Value> {
        self.read_with(project, |slot| {
            let state = slot.state.clone();
            let (db, store) = slot.owner.cache();
            Ok(message_store::whole_state(db, store, &state)?.to_value())
        })
    }

    /// The state as Node keeps it in memory (unloaded Chats' messages left out), with its unloaded Chats.
    pub fn state_value(&mut self, project: &Path) -> Result<(Value, Vec<ChatId>)> {
        let state = self.get(project)?;
        Ok((state.to_value(), state.unloaded.iter().copied().collect()))
    }

    /// chat:messages for an open Project: the Chat is loaded, then paged.
    pub fn chat_messages(
        &mut self,
        project: &Path,
        chat: ChatId,
        options: &PageOptions,
    ) -> Result<Value> {
        let state = self.load(project, &[chat])?;
        let values: Vec<Value> = state
            .message_list()
            .iter()
            .map(|message| message.value().clone())
            .collect();
        Ok(chat_page(&values, &Value::from(chat), options))
    }

    /// findMessage over the open state.
    pub fn find_message(
        &mut self,
        project: &Path,
        field: LookupField,
        value: &Value,
    ) -> Result<Option<MsgRef>> {
        self.read_with(project, |slot| {
            let state = slot.state.clone();
            let (db, store) = slot.owner.cache();
            message_store::find_message(db, store, &state, field, value)
        })
    }

    /// chat:message: one message with its step details read back from its sidecar.
    pub fn chat_message(&mut self, project: &Path, id: &Value) -> Result<Value> {
        let message = self
            .find_message(project, LookupField::Id, id)?
            .ok_or(StoreError::MessageGone)?;
        let key = self.key(project)?;
        Ok(self.slots[&key].owner.with_details(message.value()))
    }

    /// chat:all-messages: every message (or only marks), optionally with the state they come from.
    pub fn all_messages(&mut self, project: &Path, marks: bool, with_state: bool) -> Result<Value> {
        self.read_with(project, |slot| {
            let state = slot.state.clone();
            let (db, store) = slot.owner.cache();
            let messages = if marks {
                Value::Array(message_store::message_marks(db, store, &state)?)
            } else {
                Value::Array(
                    message_store::all_messages(db, store, &state)?
                        .iter()
                        .map(|message| message.value().clone())
                        .collect(),
                )
            };
            Ok(if with_state {
                serde_json::json!({ "state": state.to_value(), "messages": messages })
            } else {
                messages
            })
        })
    }

    /// chat:search: the Chats that aren't archived, searched with their bodies (unloaded ones read from chats.db).
    pub fn search(&mut self, project: &Path, query: &str, limit: usize) -> Result<Value> {
        let state = self.get(project)?;
        let open: Vec<ChatId> = state
            .sessions()
            .map(|sessions| {
                jsjson::js_entries(sessions)
                    .into_iter()
                    .filter(|(_, session)| !jsjson::truthy(session.get("archived")))
                    .filter_map(|(_, session)| chat_number(session.get("id")))
                    .collect()
            })
            .unwrap_or_default();
        let all = self.read_with(project, |slot| {
            let state = slot.state.clone();
            let (db, store) = slot.owner.cache();
            message_store::searchable_messages(db, store, &state, Some(&open))
        })?;
        crate::search::chat_search(state.sessions(), query, limit, &all)
    }

    /// chat:subagent: one subagent with its whole transcript.
    pub fn subagent(&mut self, project: &Path, chat: &Value, agent: &Value) -> Result<Value> {
        let state = self.get(project)?;
        let found = state
            .sessions()
            .and_then(|sessions| sessions.get(&jsjson::property_key(Some(chat))))
            .and_then(|session| session.get("subagents"))
            .and_then(Value::as_array)
            .and_then(|agents| {
                agents.iter().find(|item| {
                    item.get("id")
                        .is_some_and(|id| jsjson::strict_equals(id, agent))
                })
            });
        found
            .cloned()
            .ok_or_else(|| StoreError::Invalid("That subagent is no longer in this Chat.".into()))
    }

    /// chat:send-status with nothing in flight: the saved (or in-memory) message's Chat, else the queued entry's.
    pub fn send_status(&mut self, project: &Path, client_message_id: &Value) -> Result<Value> {
        let Some(id) = client_message_id.as_str().filter(|id| !id.is_empty()) else {
            return Err(StoreError::BadSendStatus);
        };
        if !self.has(project) {
            return Err(StoreError::BadSendStatus);
        }
        let value = Value::String(id.to_string());
        if let Some(message) = self.find_message(project, LookupField::ClientMessageId, &value)? {
            let mut receipt = Map::new();
            if let Some(chat) = message.get("session_id") {
                receipt.insert("sessionId".into(), chat.clone());
            }
            return Ok(Value::Object(receipt));
        }
        let state = self.get(project)?;
        for (_, session) in state.sessions().map(jsjson::js_entries).unwrap_or_default() {
            let queued = session
                .get("queued")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .get("clientMessageId")
                            .is_some_and(|known| jsjson::strict_equals(known, &value))
                    })
                });
            if queued {
                let mut receipt = Map::new();
                if let Some(id) = session.get("id") {
                    receipt.insert("sessionId".into(), id.clone());
                }
                return Ok(Value::Object(receipt));
            }
        }
        Ok(Value::Null)
    }

    /// The inbox projection: metadata and bounded assistant previews, idle Chats left unloaded.
    pub fn inbox(&mut self, project: &Path) -> Result<Value> {
        self.read_with(project, |slot| {
            let state = slot.state.clone();
            message_store::inbox_state(slot.owner.chats(), &state)
        })
    }

    /// The command boundary for a wire server: runtime.cjs's chat read commands, by name, with the daemon's
    /// arguments. The scope must be a Project these states have open.
    pub fn call(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let scope = || -> Result<PathBuf> {
            let scope = arg(0);
            let path = scope
                .as_str()
                .map(PathBuf::from)
                .filter(|path| self.has(path));
            path.ok_or_else(|| {
                StoreError::Invalid("Open the Project before reading its messages.".into())
            })
        };
        match method {
            "chat:messages" => {
                let project = scope()?;
                let chat = arg(1)
                    .as_i64()
                    .ok_or_else(|| StoreError::Invalid("Choose a Chat.".into()))?;
                self.chat_messages(&project, chat, &PageOptions::from_value(args.get(2)))
            }
            "chat:message" => {
                let project = scope()?;
                self.chat_message(&project, &arg(1))
            }
            "chat:all-messages" => {
                let project = scope()?;
                let options = arg(1);
                let marks = options.get("marks") == Some(&Value::Bool(true));
                let with_state = options.get("withState") == Some(&Value::Bool(true));
                self.all_messages(&project, marks, with_state)
            }
            "chat:search" => {
                let project = scope()?;
                let limit = arg(2).get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
                let query = match arg(1) {
                    Value::String(query) => query,
                    Value::Null => String::new(),
                    other => jsjson::property_key(Some(&other)),
                };
                self.search(&project, &query, limit)
            }
            "chat:subagent" => {
                let project = scope()?;
                self.subagent(&project, &arg(1), &arg(2))
            }
            "chat:send-status" => {
                let project = arg(0)
                    .as_str()
                    .map(PathBuf::from)
                    .filter(|path| self.has(path))
                    .ok_or(StoreError::BadSendStatus)?;
                self.send_status(&project, &arg(1))
            }
            other => Err(StoreError::Invalid(format!(
                "{other} isn't served by the Rust owner yet."
            ))),
        }
    }

    /// For a client that takes patches: what a change did to the messages (the daemon's messageChanges), from the
    /// state last sent (None before the first) to `next`.
    pub fn message_changes_from(previous: Option<&ProjectState>, next: &ProjectState) -> Value {
        message_store::message_changes(previous, Some(next))
    }

    /// The new-message helper for changes: a message the change creates.
    pub fn message(value: Value) -> MsgRef {
        Msg::new(value)
    }
}
