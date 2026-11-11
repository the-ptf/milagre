//! Isolated synthetic service model. Owns its records, approval state and admission.
//! No live-profile loading, daemon writer, listener, or caller-supplied Allow booleans.
use crate::admission::{
    Admission, AdmissionError, Limits as AdmissionLimits, Source, Status as AdmissionStatus,
};
use crate::budget::{ConnectionBudget, DeviceBudget, GlobalBudget};
use crate::channel::{
    self, Accepted, DesktopAccess, DeviceKind, IdentityStatus, OwnerApproval, Persistence,
    ServiceDecision, StoredDevice,
};
use crate::peer::{Direction, FrameReader, FrameWriter, FRAME_TIMEOUT_MS, MAX_FRAME_BYTES};
use crate::SecretKey;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_core::{CryptoRng, RngCore};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, RwLock,
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error(transparent)]
    Admission(#[from] AdmissionError),
    #[error("policy denied or ticket stale")]
    Denied,
    #[error("state limit reached")]
    Limited,
    #[error("time moved backwards or overflowed")]
    Time,
    #[error("temporary record commit failed: {0}")]
    Storage(#[from] std::io::Error),
    #[error(transparent)]
    Protocol(#[from] crate::Error),
}
pub type Result<T> = std::result::Result<T, PolicyError>;
#[derive(Clone, Copy)]
pub struct Limits {
    pub records: usize,
    pub pending: usize,
    pub pending_desktops: usize,
    pub admission: AdmissionLimits,
    pub pairing_window_ms: u64,
    pub known_ticket_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            records: 64,
            pending: 16,
            pending_desktops: 4,
            admission: AdmissionLimits::default(),
            pairing_window_ms: 600_000,
            known_ticket_ms: 15_000,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
enum Record {
    Active { kind: DeviceKind },
    Removed { at: u64 },
}
/// Opaque, instance-bound, non-cloneable connection generation.
pub struct Ticket {
    authority: [u8; 16],
    id: u64,
}
struct Pending {
    accepted: Accepted,
    record: Option<Record>,
    grant: u64,
    approved: bool,
    deadline: u64,
}
struct Grant {
    generation: u64,
    opened: u64,
    until: u64,
}

/// Creates a NEW marked temporary directory only. Cannot open/import an existing
/// directory or profile. No signing/box key or pairing token is persisted.
struct TemporaryRecords {
    directory: PathBuf,
    transaction: u64,
}
const MARKER: &str = "RUST_REMOTE_SYNTHETIC_ONLY";
impl TemporaryRecords {
    fn create(rng: &mut (impl RngCore + CryptoRng)) -> Result<Self> {
        let mut nonce = [0; 16];
        rng.fill_bytes(&mut nonce);
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let directory = std::env::temp_dir().join(format!("milagre-remote-synthetic-{suffix}"));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?; // create-new, never reuse an existing capability
        let store = Self {
            directory,
            transaction: 0,
        };
        let mut marker = Self::create_file(&store.directory.join(MARKER))?;
        marker.write_all(b"temporary synthetic remote protocol test records\n")?;
        marker.sync_all()?;
        Ok(store)
    }
    fn create_file(path: &Path) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)
    }
    fn commit(&mut self, records: &BTreeMap<String, Record>) -> Result<()> {
        // Refuse a moved/replaced marker or directory; this is an isolated test
        // capability, not a defense against a malicious process with the same UID.
        if !fs::symlink_metadata(&self.directory)?.is_dir()
            || !fs::symlink_metadata(self.directory.join(MARKER))?.is_file()
        {
            return Err(PolicyError::Denied);
        }
        self.transaction = self
            .transaction
            .checked_add(1)
            .ok_or(PolicyError::Limited)?;
        let temporary = self
            .directory
            .join(format!("transaction-{}", self.transaction));
        let result = (|| -> Result<()> {
            let mut file = Self::create_file(&temporary)?;
            serde_json::to_writer(&mut file, records).map_err(std::io::Error::other)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temporary, self.directory.join("records.json"))?;
            File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}
impl Drop for TemporaryRecords {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.directory).is_ok_and(|m| m.is_dir()) {
            // Never recursively remove files supplied by someone else.
            let _ = fs::remove_file(self.directory.join("records.json"));
            let _ = fs::remove_file(self.directory.join(MARKER));
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

const GLOBAL_BYTES: usize = 256 * 1024 * 1024;
const DEVICE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSIONS: usize = 16;
const MAX_DEVICE_SESSIONS: usize = 4;
#[derive(Default)]
struct Revocations {
    retired: bool,
    epochs: BTreeMap<String, u64>,
}
#[derive(Clone)]
struct Access {
    state: Arc<RwLock<Revocations>>,
    key: String,
    epoch: u64,
}
impl Access {
    fn with<T>(&self, action: impl FnOnce() -> crate::Result<T>) -> crate::Result<T> {
        let state = self.state.read().map_err(|_| crate::Error::Unauthorized)?;
        if state.retired || state.epochs.get(&self.key).copied().unwrap_or(0) != self.epoch {
            return Err(crate::Error::Unauthorized);
        }
        action()
    }
}
struct DeviceSlot {
    budget: DeviceBudget,
    active: Arc<AtomicUsize>,
}
struct SessionPermit {
    global: Arc<AtomicUsize>,
    device: Arc<AtomicUsize>,
}
impl SessionPermit {
    fn take(global: Arc<AtomicUsize>, device: Arc<AtomicUsize>) -> Result<Self> {
        let take = |counter: &AtomicUsize, max| {
            counter
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                    (n < max).then_some(n + 1)
                })
                .is_ok()
        };
        if !take(&global, MAX_SESSIONS) {
            return Err(PolicyError::Limited);
        }
        if !take(&device, MAX_DEVICE_SESSIONS) {
            global.fetch_sub(1, Ordering::SeqCst);
            return Err(PolicyError::Limited);
        }
        Ok(Self { global, device })
    }
}
impl Drop for SessionPermit {
    fn drop(&mut self) {
        self.global.fetch_sub(1, Ordering::SeqCst);
        self.device.fetch_sub(1, Ordering::SeqCst);
    }
}
/// Holds channel ownership and the service admission permit through the connection.
/// All readers/writers made here share one connection budget; reconnects of the same
/// device share its device budget. Reserve carrier/decrypt/phone buffers separately.
pub struct Session {
    access: Access,
    device: channel::Device,
    reply: Vec<u8>,
    channel: Option<channel::Channel>,
    budget: ConnectionBudget,
    permit: Option<SessionPermit>,
}
impl Session {
    pub fn reply(&self) -> crate::Result<&[u8]> {
        self.with_access(|| Ok(self.reply.as_slice()))
    }
    pub fn device(&self) -> &channel::Device {
        &self.device
    }
    pub fn is_revoked(&self) -> bool {
        self.channel.is_none() || self.access.with(|| Ok(())).is_err()
    }
    pub fn revoke(&mut self) {
        self.channel = None;
        self.reply = Vec::new();
        self.permit = None;
    }
    pub fn seal_encoded(&mut self, bytes: &[u8]) -> crate::Result<Vec<u8>> {
        self.access.clone().with(|| {
            self.channel
                .as_mut()
                .ok_or(crate::Error::Unauthorized)?
                .seal_encoded(bytes)
        })
    }
    pub(crate) fn with_access<T>(
        &self,
        action: impl FnOnce() -> crate::Result<T>,
    ) -> crate::Result<T> {
        if self.channel.is_none() {
            return Err(crate::Error::Unauthorized);
        }
        self.access.with(action)
    }
    pub fn open_encoded(&mut self, bytes: &[u8]) -> crate::Result<Vec<u8>> {
        self.access.clone().with(|| {
            self.channel
                .as_mut()
                .ok_or(crate::Error::Unauthorized)?
                .open_encoded(bytes)
        })
    }
    pub fn budget(&self) -> ConnectionBudget {
        self.budget.clone()
    }
    pub fn reader(&self, direction: Direction) -> crate::Result<FrameReader> {
        self.with_access(|| Ok(()))?;
        FrameReader::with_budget(
            direction,
            MAX_FRAME_BYTES,
            FRAME_TIMEOUT_MS,
            self.budget.clone(),
        )
    }
    pub fn writer(&self, direction: Direction) -> crate::Result<FrameWriter> {
        self.with_access(|| Ok(()))?;
        Ok(FrameWriter::with_budget(direction, self.budget.clone()))
    }
}

/// Synthetic-only authority backed by its own newly created temporary records.
/// All methods require exclusive access. Approval methods are trusted owner events,
/// not network messages. A future service must authenticate their caller separately.
pub struct TemporaryAuthority {
    revocations: Arc<RwLock<Revocations>>,
    instance: [u8; 16],
    global: GlobalBudget,
    active: Arc<AtomicUsize>,
    devices: BTreeMap<String, DeviceSlot>,
    host: SecretKey,
    token: String,
    limits: Limits,
    desktop: DesktopAccess,
    retired: bool,
    records: BTreeMap<String, Record>,
    storage: TemporaryRecords,
    grant: Grant,
    pending: BTreeMap<u64, Pending>,
    next: u64,
    last_time: u64,
    admission: Admission,
}
impl TemporaryAuthority {
    pub fn create_synthetic(
        host: SecretKey,
        token: String,
        desktop: DesktopAccess,
        limits: Limits,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<Self> {
        if token.is_empty()
            || token.len() > 1024
            || limits.records == 0
            || limits.records > 4096
            || limits.pending == 0
            || limits.pending > 64
            || limits.pending_desktops > limits.pending
            || !limits.admission.valid()
            || limits.pairing_window_ms == 0
            || limits.known_ticket_ms == 0
        {
            return Err(PolicyError::Limited);
        }
        let mut instance = [0; 16];
        rng.fill_bytes(&mut instance);
        let mut storage = TemporaryRecords::create(rng)?;
        let records = BTreeMap::new();
        storage.commit(&records)?;
        Ok(Self {
            revocations: Arc::new(RwLock::new(Revocations::default())),
            instance,
            global: GlobalBudget::new(GLOBAL_BYTES)?,
            active: Arc::new(AtomicUsize::new(0)),
            devices: BTreeMap::new(),
            host,
            token,
            limits,
            desktop,
            retired: false,
            records,
            storage,
            grant: Grant {
                generation: 0,
                opened: 0,
                until: 0,
            },
            pending: BTreeMap::new(),
            next: 0,
            last_time: 0,
            admission: Admission::new(limits.admission),
        })
    }
    /// Public test artifacts only; no token or private key is written here.
    pub fn temporary_directory(&self) -> &Path {
        &self.storage.directory
    }
    fn clock(&mut self, now: u64) -> Result<()> {
        if now < self.last_time {
            return Err(PolicyError::Time);
        }
        self.last_time = now;
        self.pending.retain(|_, p| now < p.deadline);
        Ok(())
    }
    pub fn expire(&mut self, now: u64) -> Result<usize> {
        let before = self.pending.len();
        self.clock(now)?;
        Ok(before - self.pending.len())
    }
    /// A fresh multi-device pairing window per trusted owner action, matching Node.
    /// Each pending ticket is single-use; a new window invalidates older new-device tickets.
    pub fn open_pairing(&mut self, now: u64) -> Result<()> {
        self.clock(now)?;
        if self.retired {
            return Err(PolicyError::Denied);
        }
        let until = now
            .checked_add(self.limits.pairing_window_ms)
            .ok_or(PolicyError::Time)?;
        let generation = self
            .grant
            .generation
            .checked_add(1)
            .ok_or(PolicyError::Limited)?;
        self.grant = Grant {
            generation,
            opened: now,
            until,
        };
        self.pending
            .retain(|_, p| !p.accepted.device().first_pairing);
        Ok(())
    }
    fn may_pair(&self, key: &str, now: u64) -> bool {
        !self.retired
            && now < self.grant.until
            && match self.records.get(key) {
                Some(Record::Removed { at }) => *at < self.grant.opened,
                _ => true,
            }
    }
    /// Owner-facing diagnostic state, not a wire error or proof of a remote IP.
    pub fn admission_status(&mut self, source: Source, now: u64) -> Result<AdmissionStatus> {
        self.clock(now)?;
        self.admission.refresh(now)?;
        Ok(self.admission.status(source))
    }
    /// The clear HELLO key routes RESERVED WORK CAPACITY only. It is untrusted and
    /// must still pass host_accept and the authoritative stored-kind/persistence checks.
    /// Source::Relay deliberately carries no invented per-phone/per-IP identity.
    pub fn begin(
        &mut self,
        source: Source,
        hello: &[u8],
        now: u64,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<Ticket> {
        self.clock(now)?;
        if self.retired {
            return Err(PolicyError::Denied);
        }
        self.admission.refresh(now)?;
        if self.pending.len() >= self.limits.pending {
            return Err(PolicyError::Limited);
        }
        // Cheap shape/length rejection does not spend either cryptographic lane.
        let shaped = hello.len() >= 105
            && hello.len() <= channel::MAX_HELLO_BYTES
            && hello.first() == Some(&1);
        if !shaped {
            let error = if hello.len() > channel::MAX_HELLO_BYTES {
                crate::Error::TooLarge
            } else {
                crate::Error::BadHello
            };
            self.admission.malformed();
            return Err(error.into());
        }
        let key = URL_SAFE_NO_PAD.encode(&hello[33..65]);
        let known_candidate = matches!(self.records.get(&key), Some(Record::Active { .. }));
        self.admission.check(source, known_candidate)?;
        self.admission
            .crypto(known_candidate.then_some(key.as_str()), hello.len())?;
        let accepted = channel::host_accept(
            &self.host,
            hello,
            &self.token,
            |key| matches!(self.records.get(key), Some(Record::Active { .. })),
            |key| self.may_pair(key, now),
            rng,
        );
        let accepted = match accepted {
            Ok(value) => value,
            Err(error) => {
                self.admission.failed(source, known_candidate, error);
                return Err(error.into());
            }
        };
        let device = accepted.device();
        let record = self.records.get(&device.key).copied();
        if device.kind == DeviceKind::Desktop && self.desktop != DesktopAccess::Enabled
            || matches!(record, Some(Record::Active { kind }) if kind != device.kind)
        {
            self.admission
                .failed(source, known_candidate, crate::Error::Unauthorized);
            return Err(PolicyError::Denied);
        }
        // A replacement for this key cancels only its older ticket.
        self.pending
            .retain(|_, p| p.accepted.device().key != device.key);
        if device.first_pairing
            && device.kind == DeviceKind::Desktop
            && self
                .pending
                .values()
                .filter(|p| {
                    p.accepted.device().first_pairing
                        && p.accepted.device().kind == DeviceKind::Desktop
                })
                .count()
                >= self.limits.pending_desktops
        {
            return Err(PolicyError::Limited);
        }
        let deadline = if device.first_pairing {
            self.grant.until
        } else {
            now.checked_add(self.limits.known_ticket_ms)
                .ok_or(PolicyError::Time)?
        };
        self.next = self.next.checked_add(1).ok_or(PolicyError::Limited)?;
        self.pending.insert(
            self.next,
            Pending {
                accepted,
                record,
                grant: self.grant.generation,
                approved: false,
                deadline,
            },
        );
        Ok(Ticket {
            authority: self.instance,
            id: self.next,
        })
    }
    fn ticket_id(&self, ticket: &Ticket) -> Result<u64> {
        if ticket.authority != self.instance {
            return Err(PolicyError::Denied);
        }
        Ok(ticket.id)
    }
    pub fn pending_device(&self, ticket: &Ticket) -> Result<&channel::Device> {
        let id = self.ticket_id(ticket)?;
        Ok(self
            .pending
            .get(&id)
            .ok_or(PolicyError::Denied)?
            .accepted
            .device())
    }
    pub fn approve_desktop(&mut self, ticket: &Ticket, now: u64) -> Result<()> {
        self.clock(now)?;
        let id = self.ticket_id(ticket)?;
        let p = self.pending.get_mut(&id).ok_or(PolicyError::Denied)?;
        if !p.accepted.device().first_pairing || p.accepted.device().kind != DeviceKind::Desktop {
            return Err(PolicyError::Denied);
        }
        p.approved = true;
        Ok(())
    }
    pub fn cancel(&mut self, ticket: Ticket) -> Result<()> {
        let id = self.ticket_id(&ticket)?;
        self.pending.remove(&id).ok_or(PolicyError::Denied)?;
        Ok(())
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.revocations
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retired = true;
        self.pending.clear();
    }
    pub fn remove(
        &mut self,
        registry: &mut crate::registry::Registry,
        key: &str,
        now: u64,
    ) -> Result<()> {
        self.clock(now)?;
        if !matches!(self.records.get(key), Some(Record::Active { .. })) {
            return Err(PolicyError::Denied);
        }
        // Shared epochs revoke even completed Sessions held outside this registry.
        // The write lock waits for any in-progress guarded crypto/delivery to finish.
        {
            let mut state = self.revocations.write().unwrap_or_else(|e| e.into_inner());
            let epoch = state.epochs.entry(key.to_owned()).or_default();
            if let Some(next) = epoch.checked_add(1) {
                *epoch = next;
            } else {
                state.retired = true;
                drop(state);
                self.retire();
                registry.retire();
                return Err(PolicyError::Limited);
            }
        }
        registry.close_device(key);
        // Invalidate in-memory access first, fail closed if disk cannot be updated.
        self.pending.retain(|_, p| p.accepted.device().key != key);
        self.records
            .insert(key.to_owned(), Record::Removed { at: now });
        if let Err(e) = self.storage.commit(&self.records) {
            self.retire();
            return Err(e);
        }
        Ok(())
    }
    /// Consumes the ticket, commits new records, then derives and
    /// consumes ServiceDecision internally. No caller can assert "persisted" here.
    pub fn complete(&mut self, ticket: Ticket, mut now: impl FnMut() -> u64) -> Result<Session> {
        self.clock(now())?;
        let id = self.ticket_id(&ticket)?;
        let p = self.pending.remove(&id).ok_or(PolicyError::Denied)?;
        let d = p.accepted.device();
        if self.retired || self.records.get(&d.key).copied() != p.record {
            return Err(PolicyError::Denied);
        }
        if self.active.load(Ordering::SeqCst) >= MAX_SESSIONS
            || self
                .devices
                .get(&d.key)
                .is_some_and(|slot| slot.active.load(Ordering::SeqCst) >= MAX_DEVICE_SESSIONS)
        {
            return Err(PolicyError::Limited);
        }
        let (stored, persistence) = if d.first_pairing {
            if p.grant != self.grant.generation
                || !self.may_pair(&d.key, self.last_time)
                || d.kind == DeviceKind::Desktop && !p.approved
            {
                return Err(PolicyError::Denied);
            }
            if !self.records.contains_key(&d.key) && self.records.len() >= self.limits.records {
                return Err(PolicyError::Limited);
            }
            let mut next = self.records.clone();
            next.insert(d.key.clone(), Record::Active { kind: d.kind });
            // Ambiguous IO failure retires the model; it cannot retry after a rename
            // that succeeded but a directory sync that failed.
            if let Err(e) = self.storage.commit(&next) {
                self.retire();
                return Err(e);
            }
            self.records = next;
            (StoredDevice::New, Persistence::Committed)
        } else {
            match p.record {
                Some(Record::Active { kind }) if kind == d.kind => {
                    (StoredDevice::Known(kind), Persistence::NotRequired)
                }
                _ => return Err(PolicyError::Denied),
            }
        };
        let decision = ServiceDecision::Allow {
            device_key: d.key.clone(),
            identity: IdentityStatus::Current,
            stored,
            owner: if p.approved {
                OwnerApproval::Granted
            } else {
                OwnerApproval::NotRequired
            },
            persistence,
            desktop: self.desktop,
        };
        let slot = self
            .devices
            .entry(d.key.clone())
            .or_insert_with(|| DeviceSlot {
                budget: self.global.device(DEVICE_BYTES).unwrap(),
                active: Arc::new(AtomicUsize::new(0)),
            });
        let permit = SessionPermit::take(self.active.clone(), slot.active.clone())?;
        let budget = slot.budget.connection(DEVICE_BYTES)?;
        // Re-read the monotonic service clock AFTER persistence, never a cached pre-IO time.
        let key = d.key.clone();
        let kind = d.kind;
        let new = d.first_pairing;
        let authorized = p.accepted.authorize(decision, || {
            let final_now = now();
            let time_valid = final_now >= self.last_time && final_now < p.deadline;
            self.last_time = self.last_time.max(final_now);
            time_valid
                && !self.retired
                && ticket.authority == self.instance
                && self.records.get(&key) == Some(&Record::Active { kind })
                && (!new || (p.grant == self.grant.generation && final_now < self.grant.until))
        })?;
        let epoch = self
            .revocations
            .read()
            .map_err(|_| PolicyError::Denied)?
            .epochs
            .get(&authorized.device.key)
            .copied()
            .unwrap_or(0);
        Ok(Session {
            access: Access {
                state: self.revocations.clone(),
                key: authorized.device.key.clone(),
                epoch,
            },
            device: authorized.device,
            reply: authorized.reply,
            channel: Some(authorized.channel),
            budget,
            permit: Some(permit),
        })
    }
}

impl Drop for TemporaryAuthority {
    fn drop(&mut self) {
        self.retire();
    }
}
