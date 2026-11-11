//! Handover transcripts written off the owner actor, as bounded jobs the owner alone builds (HANDOFF-PROPOSAL.md,
//! the contract agreed with the runtime).
//!
//! - **Where.** `<copy>/.owner/handovers/<sha1(project)[..12]>/<session>.md` ([`Isolation::handovers`]). The owner
//!   computes it; no job takes a path. The handovers folder is opened once (no link followed) and pinned (device,
//!   inode, canonical path); every file operation goes through a held folder descriptor (`openat`, `renameat`,
//!   `unlinkat`), so a path swapped later can't redirect a write, a rename or a delete.
//! - **Bounded.** At most [`MAX_TRANSCRIPT_JOBS`] reservations; [`TranscriptJobs::job`] refuses the next with
//!   `TRANSCRIPTS_AT_CAPACITY`. Each job's transcript is at most [`MAX_TRANSCRIPT_BYTES`].
//! - **Owned, once.** A [`TranscriptJob`] can't be cloned. Whatever happens to it, its completion guard reports
//!   exactly one [`JobOutcome`] to the inbox the owner drains: `Staged` or `Failed` from [`TranscriptJob::run`], or
//!   `Unknown` when it is dropped unrun, panics or is cancelled with its worker. A dropped observer can't lose it.
//! - **Two phases.** The job renders and writes a temporary file (exclusive create, 0600, fsync). Only the owner, on its
//!   actor and after checking its own generation and ownership, renames it into place ([`StagedTranscript::commit`]),
//!   or removes it ([`StagedTranscript::discard`]). Neither is ever retried by rewriting: a discard that fails keeps the
//!   reservation, and retrying it only unlinks the job's own temporary name through the held descriptor.

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rustix::fs::{AtFlags, Mode, OFlags};
use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::handover::{self, Clock};
use crate::isolation::Isolation;
use crate::jsjson;
use crate::ownership::RootPin;
use crate::{Result, StoreError};

/// Transcript jobs out at once (reserved, running, staged or waiting for cleanup).
pub const MAX_TRANSCRIPT_JOBS: usize = 4;
/// The largest transcript a job writes (UTF-8 bytes); a larger one fails the job.
pub const MAX_TRANSCRIPT_BYTES: usize = 32 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JobId(pub u64);

/// The most a job's input may weigh (its session, worktree and messages, as JSON bytes); a larger one is refused
/// before anything is copied.
pub const MAX_TRANSCRIPT_INPUT_BYTES: usize = 32 << 20;
/// The most all reserved jobs' inputs may weigh together; past it a new job is refused (`TRANSCRIPTS_AT_CAPACITY`)
/// before anything is copied. A running job also holds its rendered transcript (at most MAX_TRANSCRIPT_BYTES) until it
/// is written; once staged it keeps only its brief prompt (at most 256 KiB).
pub const MAX_TRANSCRIPT_BUDGET_BYTES: usize = 64 << 20;

/// What a job renders, borrowed from the owner's state: only the Chat's session, its worktree and its messages before
/// the handoff's divider are measured, then copied (the session's provider set to the one handed from).
pub struct TranscriptSource<'a> {
    pub state: &'a Value,
    pub session: u64,
    /// Node's `before`: only messages whose id is less than the divider's.
    pub before: Option<f64>,
    /// The provider handed from (Node sets the session's provider to it for the transcript).
    pub provider: Option<&'a str>,
    /// The message id the brief catches up after.
    pub catch_up_after: Option<Value>,
    pub clock: Clock,
}

/// What a job owns: the copied part of the state.
struct TranscriptInput {
    state: Value,
    session: u64,
    catch_up_after: Option<Value>,
    clock: Clock,
    bytes: usize,
}

/// Counts what `serde_json` would write, without keeping it.
struct Counter(usize);

impl std::io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn weight(value: &Value) -> usize {
    let mut counter = Counter(0);
    let _ = serde_json::to_writer(&mut counter, value);
    counter.0
}

/// The parts of `source.state` a transcript of its session reads, measured, then copied only within `budget` bytes.
fn take_input(source: &TranscriptSource<'_>, budget: usize) -> Result<TranscriptInput> {
    let state = source.state;
    let key = source.session.to_string();
    let session_id = Value::from(source.session);
    let session = state
        .get("sessions")
        .and_then(|sessions| sessions.get(&key))
        .filter(|session| !jsjson::is_undefined(session))
        .ok_or_else(|| StoreError::Invalid(format!("Chat {key} isn't in the state.")))?;
    let worktree_key = jsjson::property_key(session.get("worktree_id"));
    let worktree = state
        .get("worktrees")
        .and_then(|worktrees| worktrees.as_object())
        .and_then(|worktrees| worktrees.get(&worktree_key));
    let Some(Value::Array(messages)) = state.get("messages") else {
        return Err(StoreError::Invalid(
            "The state's messages aren't a list.".into(),
        ));
    };
    let before = source.before.map(Value::from);
    let mut kept = Vec::new();
    for message in messages {
        // Node reads `session_id` of every message: one that is null or undefined throws there.
        if message.is_null() || jsjson::is_undefined(message) {
            return Err(StoreError::Invalid(
                "A message of the state is null.".into(),
            ));
        }
        let ours = jsjson::strict_equals(
            message.get("session_id").unwrap_or(&jsjson::undefined()),
            &session_id,
        );
        let earlier = before
            .as_ref()
            .is_none_or(|before| crate::handover::greater(Some(before), message.get("id")));
        if ours && earlier {
            kept.push(message);
        }
    }
    let mut bytes = weight(session) + worktree.map_or(0, weight) + 64;
    for message in &kept {
        bytes += weight(message) + 1;
        if bytes > MAX_TRANSCRIPT_INPUT_BYTES {
            return Err(StoreError::Invalid(format!(
                "The Chat is too large to hand over (more than {} MiB).",
                MAX_TRANSCRIPT_INPUT_BYTES >> 20
            )));
        }
    }
    if bytes > budget {
        return Err(StoreError::TranscriptsAtCapacity(format!(
            "Handoffs being prepared hold {} MiB already; try again once one has started.",
            (MAX_TRANSCRIPT_BUDGET_BYTES - budget) >> 20
        )));
    }
    let mut session = session.clone();
    if let (Some(provider), Some(map)) = (source.provider, session.as_object_mut()) {
        map.insert("provider".into(), Value::String(provider.into()));
    }
    let mut sessions = serde_json::Map::new();
    sessions.insert(key, session);
    let mut copy = serde_json::Map::new();
    copy.insert("sessions".into(), Value::Object(sessions));
    if let Some(worktree) = worktree {
        let mut worktrees = serde_json::Map::new();
        worktrees.insert(worktree_key, worktree.clone());
        copy.insert("worktrees".into(), Value::Object(worktrees));
    }
    copy.insert(
        "messages".into(),
        Value::Array(kept.into_iter().cloned().collect()),
    );
    Ok(TranscriptInput {
        state: Value::Object(copy),
        session: source.session,
        catch_up_after: source.catch_up_after.clone(),
        clock: source.clock,
        bytes,
    })
}

/// How a job ended, reported once per job.
pub enum JobOutcome {
    /// The temporary file is written; `brief_prompt` is what the brief's model is asked (`safe_brief_request` over the
    /// transcript after the catch-up id), `None` if it couldn't be made (the minimal brief then).
    Staged {
        staged: StagedTranscript,
        brief_prompt: Option<handover::BriefRequest>,
    },
    /// The job failed. A temporary file it may have made is in `leftover`, to discard.
    Failed {
        id: JobId,
        error: String,
        leftover: Option<StagedTranscript>,
    },
    /// The job was dropped unrun, panicked or was cancelled: what it wrote is unknown. A temporary file it may have
    /// made is in `leftover`, to discard. Never run again.
    Unknown {
        id: JobId,
        leftover: Option<StagedTranscript>,
    },
}

impl JobOutcome {
    pub fn id(&self) -> JobId {
        match self {
            JobOutcome::Staged { staged, .. } => staged.id,
            JobOutcome::Failed { id, .. } | JobOutcome::Unknown { id, .. } => *id,
        }
    }
}

type Inbox = Arc<Mutex<VecDeque<JobOutcome>>>;

/// The owner's side: the pinned handovers folder, the reservations and the inbox.
pub struct TranscriptJobs {
    pin: RootPin,
    dir: Arc<OwnedFd>,
    inbox: Inbox,
    out: HashSet<JobId>,
    /// The input bytes each reserved job holds, charged against MAX_TRANSCRIPT_BUDGET_BYTES until it is finished.
    charged: std::collections::HashMap<JobId, usize>,
    next: u64,
}

fn io(error: rustix::io::Errno, what: &'static str, path: &Path) -> StoreError {
    StoreError::io(std::io::Error::from(error), what, path)
}

fn identity(fd: &OwnedFd) -> std::io::Result<(u64, u64)> {
    let stat = rustix::fs::fstat(fd)?;
    Ok((stat.st_dev as u64, stat.st_ino as u64))
}

impl TranscriptJobs {
    /// Opens the isolation's handovers folder (made if missing) and pins it.
    pub fn new(isolation: &Isolation) -> Result<Self> {
        let path = isolation.handovers()?;
        let pin = RootPin::take(&path)?;
        let lost = |why: &str| StoreError::OwnershipLost {
            lock: path.clone(),
            why: why.into(),
        };
        pin.check().map_err(lost)?;
        let dir = rustix::fs::openat(
            rustix::fs::CWD,
            &path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| io(error, "open", &path))?;
        if identity(&dir).ok() != Some(pin.identity()) {
            return Err(lost("the handovers folder changed while it was opened"));
        }
        Ok(TranscriptJobs {
            pin,
            dir: Arc::new(dir),
            inbox: Arc::default(),
            out: HashSet::new(),
            charged: std::collections::HashMap::new(),
            next: 0,
        })
    }

    /// The handovers folder.
    pub fn folder(&self) -> &Path {
        self.pin.path()
    }

    /// Reservations out now: jobs not yet finished with [`TranscriptJobs::finish`].
    pub fn outstanding(&self) -> usize {
        self.out.len()
    }

    /// Reserves a job for `project`'s session `input.session`. Refused at [`MAX_TRANSCRIPT_JOBS`] with
    /// `TRANSCRIPTS_AT_CAPACITY`, and for a session id of 0, before anything is made.
    pub fn job(&mut self, project: &Path, source: TranscriptSource<'_>) -> Result<TranscriptJob> {
        if self.out.len() >= MAX_TRANSCRIPT_JOBS {
            return Err(StoreError::TranscriptsAtCapacity(format!(
                "{MAX_TRANSCRIPT_JOBS} handoffs are being prepared; try again once one has started."
            )));
        }
        if source.session == 0 {
            return Err(StoreError::Invalid("A transcript needs a Chat id.".into()));
        }
        let used: usize = self.charged.values().sum();
        let input = take_input(&source, MAX_TRANSCRIPT_BUDGET_BYTES.saturating_sub(used))?;
        self.next += 1;
        let id = JobId(self.next);
        self.out.insert(id);
        self.charged.insert(id, input.bytes);
        let digest = Sha1::digest(project.as_os_str().as_encoded_bytes());
        Ok(TranscriptJob {
            id,
            folder: self.pin.clone(),
            dir: self.dir.clone(),
            project: hex::encode(digest)[..12].to_string(),
            input,
            guard: Completion {
                id,
                inbox: self.inbox.clone(),
                leftover: None,
                reported: false,
            },
        })
    }

    /// The outcomes reported since the last take, in order.
    pub fn take_outcomes(&self) -> Vec<JobOutcome> {
        let mut inbox = self
            .inbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inbox.drain(..).collect()
    }

    /// Ends a job's reservation: only once its outcome is taken and anything it left is committed or discarded.
    pub fn finish(&mut self, id: JobId) {
        self.out.remove(&id);
        self.charged.remove(&id);
    }

    /// Input bytes the reserved jobs hold now.
    pub fn charged_bytes(&self) -> usize {
        self.charged.values().sum()
    }
}

/// One transcript to render and stage. Built only by [`TranscriptJobs::job`]; run it once on a blocking worker.
pub struct TranscriptJob {
    id: JobId,
    folder: RootPin,
    dir: Arc<OwnedFd>,
    project: String,
    input: TranscriptInput,
    guard: Completion,
}

impl TranscriptJob {
    pub fn id(&self) -> JobId {
        self.id
    }

    /// Renders both transcripts and writes the full one to a temporary file in the Project's handovers folder. Reports
    /// its outcome to the owner's inbox (never returns it: the owner takes it from there).
    pub fn run(mut self) {
        let outcome = self.stage();
        let id = self.id;
        match outcome {
            // The staged file travels in the outcome; the guard's copy is dropped only once it is reported.
            Ok((staged, brief_prompt)) => self.guard.report(JobOutcome::Staged {
                staged,
                brief_prompt,
            }),
            Err(error) => {
                let leftover = self.guard.leftover.take();
                self.guard.report(JobOutcome::Failed {
                    id,
                    error: error.to_string(),
                    leftover,
                });
            }
        }
        self.guard.leftover = None;
    }

    fn stage(&mut self) -> Result<(StagedTranscript, Option<handover::BriefRequest>)> {
        let input = &self.input;
        let session = Value::from(input.session);
        let full = handover::render_transcript_bounded(
            &input.state,
            &session,
            None,
            &input.clock,
            MAX_TRANSCRIPT_BYTES,
        )?;
        let temporary_id = random()?;
        let folder = self.folder.path().join(&self.project);
        match rustix::fs::mkdirat(
            &*self.dir,
            self.project.as_str(),
            Mode::from_raw_mode(0o700),
        ) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(io(error, "mkdir", &folder)),
        }
        let sub = rustix::fs::openat(
            &*self.dir,
            self.project.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| io(error, "open", &folder))?;
        let sub = Arc::new(sub);
        let name = format!("{}.md", input.session);
        let temporary = format!(".{}.{}.{temporary_id:016x}.tmp", input.session, self.id.0);
        let staged = StagedTranscript {
            id: self.id,
            folder: self.folder.clone(),
            project: self.project.clone(),
            dir: sub.clone(),
            temporary: temporary.clone(),
            name,
        };
        let file = rustix::fs::openat(
            &*sub,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|error| io(error, "open", &folder.join(&temporary)))?;
        // From here a temporary file exists: whatever follows, the owner hears of it to discard it.
        self.guard.leftover = Some(staged.duplicate());
        #[cfg(feature = "test-fixtures")]
        test_hooks::run();
        let mut file = std::fs::File::from(file);
        file.write_all(full.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| StoreError::io(error, "write", &folder.join(&temporary)))?;
        drop(file);
        // Only the brief's prompt (at most 256 KiB) outlives the job: the transcript is dropped once it is cut.
        let catch_up = input.catch_up_after.is_some();
        let brief_prompt = match &input.catch_up_after {
            None => handover::safe_brief_request(&full, false).ok(),
            Some(after) => {
                drop(full);
                handover::render_transcript_bounded(
                    &input.state,
                    &session,
                    Some(after),
                    &input.clock,
                    MAX_TRANSCRIPT_BYTES,
                )
                .ok()
                .and_then(|text| handover::safe_brief_request(&text, catch_up).ok())
            }
        };
        Ok((staged, brief_prompt))
    }
}

/// A random part for a temporary name; the job fails rather than fall back to a predictable one.
fn random() -> Result<u64> {
    let mut bytes = [0u8; 8];
    use std::io::Read;
    let path = Path::new("/dev/urandom");
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| StoreError::io(error, "read", path))?;
    Ok(u64::from_le_bytes(bytes))
}

/// Reports exactly one outcome per job: the job's own, or `Unknown` when it is dropped without one (unrun, a panic,
/// a cancelled worker).
struct Completion {
    id: JobId,
    inbox: Inbox,
    leftover: Option<StagedTranscript>,
    reported: bool,
}

impl Completion {
    fn report(&mut self, outcome: JobOutcome) {
        if self.reported {
            return;
        }
        self.reported = true;
        self.inbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(outcome);
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        let leftover = self.leftover.take();
        self.report(JobOutcome::Unknown {
            id: self.id,
            leftover,
        });
    }
}

/// A written temporary transcript, held through its folder's descriptor. Can't be cloned; the owner commits or
/// discards it.
pub struct StagedTranscript {
    id: JobId,
    folder: RootPin,
    project: String,
    dir: Arc<OwnedFd>,
    temporary: String,
    name: String,
}

impl StagedTranscript {
    fn duplicate(&self) -> StagedTranscript {
        StagedTranscript {
            id: self.id,
            folder: self.folder.clone(),
            project: self.project.clone(),
            dir: self.dir.clone(),
            temporary: self.temporary.clone(),
            name: self.name.clone(),
        }
    }

    pub fn id(&self) -> JobId {
        self.id
    }

    /// Where it lands once committed (the path Node's `transcriptPath` gives, inside the copy).
    pub fn path(&self) -> PathBuf {
        self.folder.path().join(&self.project).join(&self.name)
    }

    /// Renames it into place, through the held descriptor, once the handovers folder still holds its pin and its
    /// Project folder's path still leads to the folder held. The caller has checked its generation and ownership. An
    /// error may leave it renamed or not: the caller treats it as possibly committed and never retries the rename.
    pub fn commit(&self) -> Result<PathBuf> {
        let path = self.path();
        let lost = |why: &str| StoreError::OwnershipLost {
            lock: self.folder.path().to_path_buf(),
            why: why.into(),
        };
        self.folder.check().map_err(lost)?;
        let sub = self.folder.path().join(&self.project);
        let meta =
            std::fs::symlink_metadata(&sub).map_err(|_| lost("the transcript folder is gone"))?;
        if meta.file_type().is_symlink()
            || Some((meta.dev(), meta.ino())) != identity(&self.dir).ok()
        {
            return Err(lost("the transcript folder was replaced"));
        }
        rustix::fs::renameat(
            &*self.dir,
            self.temporary.as_str(),
            &*self.dir,
            self.name.as_str(),
        )
        .map_err(|error| io(error, "rename", &path))?;
        rustix::fs::fsync(&*self.dir).map_err(|error| io(error, "fsync", &sub))?;
        Ok(path)
    }

    /// Removes the temporary file through the held descriptor (never by path). Already gone counts as done; another
    /// error keeps it for a later try, which does the same and nothing more.
    pub fn discard(&self) -> Result<()> {
        match rustix::fs::unlinkat(&*self.dir, self.temporary.as_str(), AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(io(
                error,
                "unlink",
                &self.folder.path().join(&self.project).join(&self.temporary),
            )),
        }
    }
}

/// Test hooks: run a closure after a job's temporary file is created and before it is written.
#[cfg(feature = "test-fixtures")]
pub mod test_hooks {
    use std::cell::RefCell;

    thread_local! {
        static AFTER_CREATE: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }

    pub fn after_temporary_created(hook: impl FnOnce() + 'static) {
        AFTER_CREATE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn run() {
        if let Some(hook) = AFTER_CREATE.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }
}
