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
struct State {
    generation: u64,
    readiness: Readiness,
    failure: Option<ServiceError>,
}
struct Inner {
    context: CapturedContext,
    project: RootPin,
    home: RootPin,
    config: RootPin,
    program: FilePin,
    files: [Option<AccountFile>; 2],
    state: Mutex<State>,
}
impl Inner {
    fn fail(&self, error: ServiceError) -> ServiceError {
        if let Ok(mut state) = self.state.lock() {
            if state.failure.is_none() {
                state.generation += 1;
                state.readiness = Readiness::Revoked;
                state.failure = Some(error.clone());
            }
            return state.failure.clone().unwrap();
        }
        ServiceError::authority("GitHub selection state is unavailable")
    }
    fn check(&self, generation: u64) -> Result<(), ServiceError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            if state.generation != generation || state.readiness == Readiness::Closed {
                return Err(ServiceError::authority("The GitHub selection was closed"));
            }
        }
        let validate = || -> Result<(), ServiceError> {
            (self.context.check)().map_err(ServiceError::authority)?;
            for root in [&self.project, &self.home, &self.config] {
                root.check().map_err(ServiceError::authority)?;
            }
            if program_pin(&self.context.program).map_err(ServiceError::authority)? != self.program
            {
                return Err(ServiceError::authority("The selected GitHub CLI changed"));
            }
            for (index, name) in ["hosts.yml", "config.yml"].iter().enumerate() {
                if file_pin(&self.context.config_directory.join(name))? != self.files[index] {
                    return Err(ServiceError::authority(
                        "The selected GitHub account configuration changed",
                    ));
                }
            }
            Ok(())
        };
        if let Err(error) = validate() {
            return Err(self.fail(error));
        }
        let state = self
            .state
            .lock()
            .map_err(|_| ServiceError::authority("GitHub selection state is unavailable"))?;
        if state.generation != generation
            || state.failure.is_some()
            || state.readiness == Readiness::Closed
        {
            return Err(state
                .failure
                .clone()
                .unwrap_or_else(|| ServiceError::authority("The GitHub selection was closed")));
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
                files,
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
    pub(crate) fn deny_account(&self, message: impl Into<String>) -> ServiceError {
        let error = ServiceError::account(message);
        self.inner
            .upgrade()
            .map(|inner| inner.fail(error.clone()))
            .unwrap_or(error)
    }
    pub(crate) fn observed(&self, data: &Value) -> Result<(), ServiceError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| ServiceError::authority("GitHub selection owner is gone"))?;
        inner.check(self.generation)?;
        let actual = data["viewer"]["login"].as_str().filter(|s| segment(s, 100));
        if actual.is_none_or(|actual| !actual.eq_ignore_ascii_case(&inner.context.account_login)) {
            return Err(inner.fail(ServiceError::account(
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
            return Err(state
                .failure
                .clone()
                .unwrap_or_else(|| ServiceError::authority("GitHub selection was closed")));
        }
        state.readiness = Readiness::Ready;
        Ok(())
    }
}
