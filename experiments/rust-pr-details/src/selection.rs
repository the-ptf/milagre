//! Account identity is learned from the actual viewer on every accepted response.
//! A private grant binds the immutable selection to its live owner generation.
use crate::{program_pin, segment, CapturedContext, DetailsReader, FilePin, ServiceError};
use milagre_owner_store::ownership::RootPin;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Arc, Mutex, Weak},
};

type MetadataPin = (u64, u64, u32, u32, u64, u64, i64, i64, i64, i64);
#[derive(Clone, PartialEq, Eq)]
struct AccountFile {
    metadata: MetadataPin,
    hash: [u8; 32],
}
fn metadata_pin(m: &fs::Metadata) -> Result<MetadataPin, ServiceError> {
    if !m.is_file()
        || m.uid() != rustix::process::geteuid().as_raw()
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > 128 * 1024
    {
        return Err(ServiceError::authority(
            "The selected GitHub account file is not private and bounded",
        ));
    }
    Ok((
        m.dev(),
        m.ino(),
        m.mode(),
        m.uid(),
        m.nlink(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
fn file_pin(path: &Path) -> Result<Option<AccountFile>, ServiceError> {
    let fd = match rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => {
            return Err(ServiceError::authority(
                "The selected GitHub account file cannot be checked",
            ))
        }
    };
    let mut file = File::from(fd);
    let before = metadata_pin(
        &file
            .metadata()
            .map_err(|_| ServiceError::authority("The selected account file changed"))?,
    )?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::authority("The selected account file cannot be checked"))?;
    if bytes.len() > 128 * 1024
        || metadata_pin(
            &file
                .metadata()
                .map_err(|_| ServiceError::authority("The selected account file changed"))?,
        )? != before
    {
        return Err(ServiceError::authority(
            "The selected account file changed during inspection",
        ));
    }
    let named = fs::symlink_metadata(path)
        .map_err(|_| ServiceError::authority("The selected account file changed"))?;
    if metadata_pin(&named)? != before {
        return Err(ServiceError::authority(
            "The selected account file was replaced",
        ));
    }
    Ok(Some(AccountFile {
        metadata: before,
        hash: Sha256::digest(&bytes).into(),
    }))
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Unknown,
    Ready,
    Revoked,
    Closed,
}
pub struct SelectionSnapshot {
    pub generation: u64,
    pub readiness: Readiness,
}
#[derive(Clone)]
struct Failure {
    error: ServiceError,
    /// Only account-configuration trouble can recover: a later read re-pins the
    /// files and re-proves the viewer login. Owner, root, executable and close
    /// failures never recover.
    recoverable: bool,
}
struct State {
    /// Counts permanent changes only (close, owner/root/executable loss). A
    /// recoverable account refusal keeps the generation, so the issued reader
    /// stays bound to the same owner.
    generation: u64,
    readiness: Readiness,
    failure: Option<Failure>,
}
struct Inner {
    context: CapturedContext,
    project: RootPin,
    home: RootPin,
    config: RootPin,
    program: FilePin,
    files: Mutex<[Option<AccountFile>; 2]>,
    state: Mutex<State>,
}
impl Inner {
    fn fail(&self, error: ServiceError) -> ServiceError {
        if let Ok(mut state) = self.state.lock() {
            if state.failure.as_ref().is_none_or(|f| f.recoverable) {
                state.generation += 1;
                state.readiness = Readiness::Revoked;
                state.failure = Some(Failure {
                    error,
                    recoverable: false,
                });
            }
            return state.failure.clone().unwrap().error;
        }
        ServiceError::authority("GitHub selection state is unavailable")
    }
    fn fail_recoverable(&self, error: ServiceError) -> ServiceError {
        if let Ok(mut state) = self.state.lock() {
            if state.failure.is_none() && state.readiness != Readiness::Closed {
                state.readiness = Readiness::Revoked;
                state.failure = Some(Failure {
                    error,
                    recoverable: true,
                });
            }
            return state.failure.clone().map_or_else(
                || ServiceError::authority("The GitHub selection was closed"),
                |f| f.error,
            );
        }
        ServiceError::authority("GitHub selection state is unavailable")
    }
    fn check(&self, generation: u64) -> Result<(), ServiceError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
            if let Some(failure) = &state.failure {
                return Err(failure.error.clone());
            }
            if state.generation != generation || state.readiness == Readiness::Closed {
                return Err(ServiceError::authority("The GitHub selection was closed"));
            }
        }
        if let Err(error) = self.validate_permanent() {
            return Err(self.fail(error));
        }
        let pins = self
            .files
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?
            .clone();
        for (index, name) in ["hosts.yml", "config.yml"].iter().enumerate() {
            let current = match file_pin(&self.context.config_directory.join(name)) {
                Ok(current) => current,
                Err(error) => return Err(self.fail_recoverable(error)),
            };
            if current != pins[index] {
                return Err(self.fail_recoverable(ServiceError::authority(
                    "The selected GitHub account configuration changed",
                )));
            }
        }
        let state = self
            .state
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
        if state.generation != generation
            || state.failure.is_some()
            || state.readiness == Readiness::Closed
        {
            return Err(state.failure.clone().map_or_else(
                || ServiceError::authority("The GitHub selection was closed"),
                |f| f.error,
            ));
        }
        Ok(())
    }
    /// Owner, root, executable: loss of any of these ends the selection for good.
    fn validate_permanent(&self) -> Result<(), ServiceError> {
        (self.context.check)().map_err(ServiceError::authority)?;
        for root in [&self.project, &self.home, &self.config] {
            root.check().map_err(ServiceError::authority)?;
        }
        if program_pin(&self.context.program).map_err(ServiceError::authority)? != self.program {
            return Err(ServiceError::authority("The selected GitHub CLI changed"));
        }
        Ok(())
    }
    /// Before the first page of a read, never in the middle of one: adopt the
    /// account files as they are now (a `gh auth login` rewrites them) and clear
    /// a recoverable account refusal. Every page of the read still has to show
    /// the selected viewer login before anything is accepted. Permanent failures
    /// and a closed selection stay refused.
    fn recover(&self, generation: u64) -> Result<(), ServiceError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
            if let Some(failure) = state.failure.as_ref().filter(|f| !f.recoverable) {
                return Err(failure.error.clone());
            }
            if state.generation != generation || state.readiness == Readiness::Closed {
                return Err(ServiceError::authority("The GitHub selection was closed"));
            }
        }
        if let Err(error) = self.validate_permanent() {
            return Err(self.fail(error));
        }
        let mut fresh = [None, None];
        for (index, name) in ["hosts.yml", "config.yml"].iter().enumerate() {
            fresh[index] = match file_pin(&self.context.config_directory.join(name)) {
                Ok(pin) => pin,
                Err(error) => return Err(self.fail_recoverable(error)),
            };
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
        if state.generation != generation
            || state.readiness == Readiness::Closed
            || state.failure.as_ref().is_some_and(|f| !f.recoverable)
        {
            return Err(state.failure.clone().map_or_else(
                || ServiceError::authority("The GitHub selection was closed"),
                |f| f.error,
            ));
        }
        *self
            .files
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))? = fresh;
        if state.failure.take().is_some() && state.readiness == Readiness::Revoked {
            state.readiness = Readiness::Unknown;
        }
        Ok(())
    }
}
/// The trusted backend owns this separately from its model-provider account owner.
/// Capture does not run a CLI or assert authentication. Drop/close revokes grants.
pub struct GithubSelectionOwner {
    inner: Arc<Inner>,
}
impl GithubSelectionOwner {
    pub fn capture(context: CapturedContext) -> Result<Self, ServiceError> {
        (context.check)().map_err(ServiceError::authority)?;
        if !segment(&context.owner, 100)
            || !segment(&context.repository, 100)
            || !segment(&context.account_login, 100)
            || context.path.contains('\0')
            || context.computer_label.is_empty()
            || context.computer_label.len() > 256
            || context.computer_label.contains('\0')
        {
            return Err(ServiceError::invalid("Invalid explicit GitHub selection"));
        }
        let project = RootPin::take(&context.project)
            .map_err(|_| ServiceError::authority("Invalid dedicated Project"))?;
        let home = RootPin::take(&context.home)
            .map_err(|_| ServiceError::authority("Invalid selected HOME"))?;
        let config = RootPin::take(&context.config_directory)
            .map_err(|_| ServiceError::authority("Invalid selected GitHub account directory"))?;
        let program = program_pin(&context.program).map_err(ServiceError::authority)?;
        let files = [
            file_pin(&context.config_directory.join("hosts.yml"))?,
            file_pin(&context.config_directory.join("config.yml"))?,
        ];
        let owner = Self {
            inner: Arc::new(Inner {
                context,
                project,
                home,
                config,
                program,
                files: Mutex::new(files),
                state: Mutex::new(State {
                    generation: 0,
                    readiness: Readiness::Unknown,
                    failure: None,
                }),
            }),
        };
        owner.inner.check(0)?;
        Ok(owner)
    }
    pub fn reader(&self) -> Result<DetailsReader, ServiceError> {
        let generation = self.snapshot()?.generation;
        self.inner.check(generation)?;
        Ok(DetailsReader::from_grant(
            self.inner.context.clone(),
            ReadGrant {
                inner: Arc::downgrade(&self.inner),
                generation,
            },
        ))
    }
    pub fn snapshot(&self) -> Result<SelectionSnapshot, ServiceError> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
        Ok(SelectionSnapshot {
            generation: state.generation,
            readiness: state.readiness,
        })
    }
    pub fn close(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            if state.readiness != Readiness::Closed {
                state.generation += 1;
                state.readiness = Readiness::Closed;
            }
        }
    }
}
impl Drop for GithubSelectionOwner {
    fn drop(&mut self) {
        self.close();
    }
}
pub(crate) struct ReadGrant {
    inner: Weak<Inner>,
    generation: u64,
}
impl ReadGrant {
    pub(crate) fn check(&self) -> Result<(), ServiceError> {
        self.inner
            .upgrade()
            .ok_or_else(|| ServiceError::authority("GitHub selection owner is gone"))?
            .check(self.generation)
    }
    /// First step of every read job: see `Inner::recover`.
    pub(crate) fn begin_read(&self) -> Result<(), ServiceError> {
        self.inner
            .upgrade()
            .ok_or_else(|| ServiceError::authority("GitHub selection owner is gone"))?
            .recover(self.generation)
    }
    /// gh itself says it is not logged in. That is a normal answer (Node shows it
    /// as a result), not a revocation: nothing was accepted, and the next read
    /// proves the viewer again.
    pub(crate) fn unready(&self) {
        if let Some(inner) = self.inner.upgrade() {
            if let Ok(mut state) = inner.state.lock() {
                if state.failure.is_none() && state.readiness == Readiness::Ready {
                    state.readiness = Readiness::Unknown;
                }
            }
        }
    }
    pub(crate) fn observed(&self, data: &Value) -> Result<(), ServiceError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| ServiceError::authority("GitHub selection owner is gone"))?;
        inner.check(self.generation)?;
        let actual = data["viewer"]["login"].as_str().filter(|s| segment(s, 100));
        if actual.is_none_or(|actual| !actual.eq_ignore_ascii_case(&inner.context.account_login)) {
            return Err(inner.fail_recoverable(ServiceError::account(
                "GitHub answered with a different or unavailable selected account",
            )));
        }
        let mut state = inner
            .state
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
        if state.generation != self.generation
            || state.failure.is_some()
            || state.readiness == Readiness::Closed
        {
            return Err(state.failure.clone().map_or_else(
                || ServiceError::authority("GitHub selection was closed"),
                |f| f.error,
            ));
        }
        state.readiness = Readiness::Ready;
        Ok(())
    }
}
