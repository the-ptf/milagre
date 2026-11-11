//! Isolated synthetic service model. Owns its records, approval state and attempts.
//! No live-profile loading, daemon writer, listener, or caller-supplied Allow booleans.
use crate::budget::{ConnectionBudget, DeviceBudget, GlobalBudget};
use crate::channel::{
    self, Accepted, Authorized, DesktopAccess, DeviceKind, IdentityStatus, OwnerApproval,
    Persistence, ServiceDecision, StoredDevice,
};
use crate::peer::{Direction, FrameReader, FrameWriter, FRAME_TIMEOUT_MS, MAX_FRAME_BYTES};
use crate::SecretKey;
use rand_core::{CryptoRng, RngCore};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("policy denied or ticket stale")]
    Denied,
    #[error("attempt or state limit reached")]
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
    pub sources: usize,
    pub attempts_per_source: u32,
    pub attempts_global: u32,
    pub attempt_window_ms: u64,
    pub pairing_window_ms: u64,
    pub known_ticket_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            records: 64,
            pending: 16,
            pending_desktops: 4,
            sources: 64,
            attempts_per_source: 8,
            attempts_global: 32,
            attempt_window_ms: 60_000,
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
    spent: bool,
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
    authorized: Authorized,
    budget: ConnectionBudget,
    _permit: SessionPermit,
}
impl Session {
    pub fn reply(&self) -> &[u8] {
        &self.authorized.reply
    }
    pub fn device(&self) -> &channel::Device {
        &self.authorized.device
    }
    pub fn channel(&mut self) -> &mut channel::Channel {
        &mut self.authorized.channel
    }
    pub fn budget(&self) -> ConnectionBudget {
        self.budget.clone()
    }
    pub fn reader(&self, direction: Direction) -> FrameReader {
        FrameReader::with_budget(
            direction,
            MAX_FRAME_BYTES,
            FRAME_TIMEOUT_MS,
            self.budget.clone(),
        )
        .unwrap()
    }
    pub fn writer(&self, direction: Direction) -> FrameWriter {
        FrameWriter::with_budget(direction, self.budget.clone())
    }
}

/// Synthetic-only authority backed by its own newly created temporary records.
/// All methods require exclusive access. Approval methods are trusted owner events,
/// not network messages. A future service must authenticate their caller separately.
pub struct TemporaryAuthority {
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
    attempt_until: u64,
    global_attempts: u32,
    sources: BTreeMap<u64, u32>,
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
            || limits.sources == 0
            || limits.sources > 4096
            || limits.attempts_per_source == 0
            || limits.attempts_global == 0
            || limits.attempt_window_ms == 0
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
                spent: true,
            },
            pending: BTreeMap::new(),
            next: 0,
            last_time: 0,
            attempt_until: 0,
            global_attempts: 0,
            sources: BTreeMap::new(),
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
    /// One fresh pairing grant per trusted owner action. The wire token is unchanged
    /// for known-device reconnects. New grants invalidate all older new-device tickets.
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
            spent: false,
        };
        self.pending
            .retain(|_, p| !p.accepted.device().first_pairing);
        Ok(())
    }
    fn may_pair(&self, key: &str, now: u64) -> bool {
        !self.retired
            && !self.grant.spent
            && now < self.grant.until
            && match self.records.get(key) {
                Some(Record::Removed { at }) => *at < self.grant.opened,
                _ => true,
            }
    }
    fn attempt(&mut self, source: u64, now: u64) -> Result<()> {
        if now >= self.attempt_until {
            self.attempt_until = now
                .checked_add(self.limits.attempt_window_ms)
                .ok_or(PolicyError::Time)?;
            self.global_attempts = 0;
            self.sources.clear();
        }
        if self.global_attempts >= self.limits.attempts_global {
            return Err(PolicyError::Limited);
        }
        // Even a rejected source costs a global attempt; source churn cannot evade it.
        self.global_attempts += 1;
        if !self.sources.contains_key(&source) && self.sources.len() >= self.limits.sources {
            return Err(PolicyError::Limited);
        }
        let attempts = self.sources.entry(source).or_default();
        if *attempts >= self.limits.attempts_per_source {
            return Err(PolicyError::Limited);
        }
        *attempts += 1;
        Ok(())
    }
    /// source is a stable carrier-assigned origin, never a peer-provided ID. Limits run
    /// before cryptography, and count malformed, bad-token, known and new attempts.
    pub fn begin(
        &mut self,
        source: u64,
        hello: &[u8],
        now: u64,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<Ticket> {
        self.clock(now)?;
        if self.retired {
            return Err(PolicyError::Denied);
        }
        self.attempt(source, now)?;
        if self.pending.len() >= self.limits.pending {
            return Err(PolicyError::Limited);
        }
        let accepted = channel::host_accept(
            &self.host,
            hello,
            &self.token,
            |key| matches!(self.records.get(key), Some(Record::Active { .. })),
            |key| self.may_pair(key, now),
            rng,
        )?;
        let device = accepted.device();
        let record = self.records.get(&device.key).copied();
        if device.kind == DeviceKind::Desktop && self.desktop != DesktopAccess::Enabled
            || matches!(record, Some(Record::Active { kind }) if kind != device.kind)
        {
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
        self.grant.spent = true;
        self.pending.clear();
    }
    pub fn remove(&mut self, key: &str, now: u64) -> Result<()> {
        self.clock(now)?;
        if !matches!(self.records.get(key), Some(Record::Active { .. })) {
            return Err(PolicyError::Denied);
        }
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
    /// Consumes the ticket, commits new records, spends the grant, then derives and
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
            // Ambiguous IO failure also retires the model; it cannot retry a spent
            // grant after a rename that succeeded but a directory sync that failed.
            if let Err(e) = self.storage.commit(&next) {
                self.retire();
                return Err(e);
            }
            self.records = next;
            self.grant.spent = true;
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
        Ok(Session {
            authorized,
            budget,
            _permit: permit,
        })
    }
}
