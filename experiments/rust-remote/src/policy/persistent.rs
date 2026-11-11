//! Fresh-capability restart under a retained synthetic broker. No existing-store
//! constructor or network listener. Private fixed workers retain ownership here;
//! supervisor dispatch and asynchronous output remain unwired.
#[allow(dead_code)]
pub(crate) mod claim_worker;
pub(crate) mod composition;
#[allow(dead_code)]
pub(crate) mod fixed_executor;
use super::*;
use crate::{
    registry::{self, CloseReason, Handle, Registry, WorkCursor, WorkPage, WorkToken},
    synthetic_store::{
        snapshot::{self, Device, Kind, Snapshot},
        Released, StoreDiagnostics, StoreFault, WriterLease,
    },
};
use composition::Phase;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Default)]
pub struct PersistentLimits {
    pub policy: Limits,
    pub registry: registry::Limits,
}
/// Every resume outcome retains the moved writer until explicit release or Drop.
#[allow(clippy::large_enum_variant)]
pub enum OpenedAuthority {
    Ready(PersistentAuthority),
    Rejected(RejectedAuthority),
    Quarantined(Quarantine),
    Retired(RetiredProfile),
}
impl PersistentLimits {
    /// Pure configuration check. Call before acquiring a writer when possible.
    pub fn validate(&self) -> std::result::Result<(), StoreFault> {
        if !self.policy.valid() || !self.registry.valid() {
            return Err(StoreFault::InvalidLimits);
        }
        Ok(())
    }
}
/// A validated, read-only limit rejection. No write attempt can produce this proof.
pub struct RejectedAuthority {
    writer: Option<WriterLease>,
    diagnostics: StoreDiagnostics,
}
pub struct RejectedReleaseFailure {
    fault: StoreFault,
    quarantine: Quarantine,
}
impl RejectedReleaseFailure {
    pub fn into_parts(self) -> (StoreFault, Quarantine) {
        (self.fault, self.quarantine)
    }
}
impl RejectedAuthority {
    fn reject(writer: WriterLease, mut diag: StoreDiagnostics) -> OpenedAuthority {
        if let Err(fault) = writer.check_unstarted() {
            return OpenedAuthority::Quarantined(Quarantine(stopped(writer, diag, fault)));
        }
        diag.fault = Some(StoreFault::InvalidLimits);
        OpenedAuthority::Rejected(Self {
            writer: Some(writer),
            diagnostics: diag,
        })
    }
    pub fn diagnostics(&self) -> StoreDiagnostics {
        self.diagnostics
    }
    pub fn retry(
        mut self,
        limits: PersistentLimits,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> OpenedAuthority {
        let writer = self.writer.take().unwrap();
        if let Err(fault) = writer.check_unstarted() {
            return OpenedAuthority::Quarantined(Quarantine(stopped(
                writer,
                self.diagnostics,
                fault,
            )));
        }
        PersistentAuthority::resume(writer, limits, rng)
    }
    #[expect(
        clippy::result_large_err,
        reason = "retain exact locks without allocating on failure"
    )]
    pub fn release(mut self) -> std::result::Result<Released, RejectedReleaseFailure> {
        let mut writer = self.writer.take().unwrap();
        match writer.restore_unstarted() {
            Ok(()) => Ok(writer.release()),
            Err(fault) => Err(RejectedReleaseFailure {
                fault,
                quarantine: Quarantine(stopped(writer, self.diagnostics, fault)),
            }),
        }
    }
}
impl Drop for RejectedAuthority {
    fn drop(&mut self) {
        if let Some(writer) = &mut self.writer {
            let _ = writer.restore_unstarted();
        }
        // Failed proof checks fall through to ordinary dirty WriterLease Drop.
    }
}
pub struct CleanStop(StoreDiagnostics);
pub struct RetiredStop(StoreDiagnostics);
pub struct StoppedAuthority {
    writer: WriterLease,
    diagnostics: StoreDiagnostics,
}
pub struct Quarantine(StoppedAuthority);
pub struct RetiredProfile(StoppedAuthority);
pub struct CloseFailure {
    fault: StoreFault,
    stopped: StoppedAuthority,
}
impl CloseFailure {
    pub fn into_parts(self) -> (StoreFault, StoppedAuthority) {
        (self.fault, self.stopped)
    }
}
impl StoppedAuthority {
    pub fn diagnostics(&self) -> StoreDiagnostics {
        self.diagnostics
    }
    pub fn release(self) -> Released {
        self.writer.release()
    }
}
macro_rules! diagnostic_guard {
    ($t:ty) => {
        impl $t {
            pub fn diagnostics(&self) -> StoreDiagnostics {
                self.0.diagnostics()
            }
            pub fn release(self) -> Released {
                self.0.release()
            }
        }
    };
}
diagnostic_guard!(Quarantine);
diagnostic_guard!(RetiredProfile);
impl CleanStop {
    pub fn diagnostics(&self) -> StoreDiagnostics {
        self.0
    }
}
impl RetiredStop {
    pub fn diagnostics(&self) -> StoreDiagnostics {
        self.0
    }
}

fn diagnostics(s: &Snapshot, fault: Option<StoreFault>) -> StoreDiagnostics {
    StoreDiagnostics {
        profile_id: s.profile,
        revision: Some(s.revision),
        boot: Some(s.boot),
        retired: s.retired,
        fault,
    }
}
fn stopped(writer: WriterLease, mut diag: StoreDiagnostics, fault: StoreFault) -> StoppedAuthority {
    diag.fault = Some(fault);
    StoppedAuthority {
        writer,
        diagnostics: diag,
    }
}
fn increment(value: &mut u64) -> std::result::Result<(), StoreFault> {
    *value = value.checked_add(1).ok_or(StoreFault::Exhausted)?;
    Ok(())
}

/// Shared policy storage backend. It never releases an authorization before commit.
pub(super) struct RestartRecords {
    writer: WriterLease,
    state: Snapshot,
    from_previous_boot: BTreeSet<String>,
    fault: Option<StoreFault>,
    #[cfg(test)]
    before_commit: Option<Box<dyn FnOnce() + Send>>,
}
impl RestartRecords {
    // Return only after all remaining snapshot/secret/history fields have dropped.
    fn into_writer(self) -> WriterLease {
        self.writer
    }

    pub(super) fn history_limit(&self) -> usize {
        let l = self.writer.limits();
        l.history_slots.min(l.parsed_bytes / 640)
    }
    fn advance(
        &mut self,
        mutate: impl FnOnce(&mut Snapshot) -> std::result::Result<(), StoreFault>,
    ) -> std::result::Result<(), StoreFault> {
        if let Some(fault) = self.fault {
            return Err(fault);
        }
        let result = (|| {
            let mut next = self.state.clone();
            increment(&mut next.revision)?;
            mutate(&mut next)?;
            #[cfg(test)]
            if let Some(checkpoint) = self.before_commit.take() {
                checkpoint();
            }
            self.writer.commit(&next)?;
            self.state = next;
            Ok(())
        })();
        if let Err(fault) = result {
            self.fault = Some(fault);
        }
        result
    }
    pub(super) fn open_window(&mut self) -> std::result::Result<(), StoreFault> {
        self.advance(|s| increment(&mut s.policy))
    }
    pub(super) fn may_repair(&self, key: &str, at: u64, opened: u64) -> bool {
        let key_bytes = decode_key(key);
        self.state
            .devices
            .iter()
            .find(|d| Some(d.key) == key_bytes)
            .is_some_and(|d| {
                d.removed
                    .is_some_and(|generation| generation < self.state.policy)
                    && (self.from_previous_boot.contains(key) || at < opened)
            })
    }
    pub(super) fn commit_records(
        &mut self,
        records: &BTreeMap<String, Record>,
    ) -> std::result::Result<(), StoreFault> {
        let limit = self.history_limit();
        let result = self.advance(|s| {
            if records.len() > limit || records.len() < s.devices.len() {
                return Err(StoreFault::TooLarge);
            }
            // One bounded candidate vector. Existing tombstone epochs never disappear.
            let mut next = Vec::new();
            next.try_reserve_exact(records.len())
                .map_err(|_| StoreFault::TooLarge)?;
            let removal = records.iter().any(|(key, r)| {
                matches!(r, Record::Removed { .. })
                    && decode_key(key)
                        .and_then(|k| s.devices.binary_search_by_key(&k, |d| d.key).ok())
                        .is_some_and(|i| s.devices[i].removed.is_none())
            });
            if removal {
                increment(&mut s.policy)?;
            }
            for (key, record) in records {
                let key = decode_key(key).ok_or(StoreFault::InvalidSchema)?;
                let old = s
                    .devices
                    .binary_search_by_key(&key, |d| d.key)
                    .ok()
                    .map(|i| s.devices[i]);
                let mut device = old.unwrap_or(Device {
                    key,
                    kind: Kind::Phone,
                    epoch: 0,
                    removed: None,
                    last_removed: None,
                });
                match record {
                    Record::Active { kind } => {
                        device.kind = match kind {
                            DeviceKind::Phone => Kind::Phone,
                            DeviceKind::Desktop => Kind::Desktop,
                        };
                        device.removed = None;
                    }
                    Record::Removed { .. } => {
                        if old.is_none() {
                            return Err(StoreFault::InvalidSchema);
                        }
                        if device.removed.is_none() {
                            increment(&mut device.epoch)?;
                            device.removed = Some(s.policy);
                            device.last_removed = Some(s.policy);
                        }
                    }
                }
                next.push(device);
            }
            next.sort_unstable_by_key(|d| d.key);
            s.devices = next;
            Ok(())
        });
        if result.is_ok() {
            // Loaded tombstones retain cross-boot ordering until that key is re-paired.
            self.from_previous_boot
                .retain(|key| matches!(records.get(key), Some(Record::Removed { .. })));
        }
        result
    }
}
fn decode_key(key: &str) -> Option<[u8; 32]> {
    let mut bytes = [0; 32];
    (URL_SAFE_NO_PAD.decode_slice(key, &mut bytes).ok()? == 32).then_some(bytes)
}

/// Owns the shared policy and its bound registry. Neither can be extracted.
/// Public operations remain synchronous and exclusive. A private synthetic executor
/// core may retain fixed-result workers; terminal ownership includes their joins.
pub struct PersistentAuthority {
    phase: Phase,
    fixed: fixed_executor::Core,
    pending_carriers: BTreeMap<u64, composition::Binding>,
    core: Option<TemporaryAuthority>,
    registry: Option<Registry>,
    pid: u32,
}
impl PersistentAuthority {
    pub fn resume(
        mut writer: WriterLease,
        limits: PersistentLimits,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> OpenedAuthority {
        let mut state = match writer.load() {
            Ok(s) => s,
            Err(fault) => {
                let diag = writer.diagnostics();
                return OpenedAuthority::Quarantined(Quarantine(stopped(writer, diag, fault)));
            }
        };
        let diag = diagnostics(&state, None);
        if state.retired {
            return OpenedAuthority::Retired(RetiredProfile(StoppedAuthority {
                writer,
                diagnostics: diag,
            }));
        }
        let l = limits.policy;
        if limits.validate().is_err()
            || state.devices.iter().filter(|d| d.removed.is_none()).count() > l.records
        {
            return RejectedAuthority::reject(writer, diag);
        }
        let mut registry = match Registry::new(limits.registry, rng) {
            Ok(r) => r,
            Err(_) => return RejectedAuthority::reject(writer, diag),
        };
        let running = (|| {
            increment(&mut state.revision)?;
            increment(&mut state.boot)?;
            state.running = true;
            writer.commit(&state)?;
            Ok::<_, StoreFault>(())
        })();
        if let Err(fault) = running {
            return OpenedAuthority::Quarantined(Quarantine(stopped(writer, diag, fault)));
        }
        let mut instance = [0; 16];
        rng.fill_bytes(&mut instance);
        let binding = SessionBinding {
            profile: state.profile,
            identity: state.identity,
            boot: state.boot,
            instance,
        };
        registry.binding = Some(binding);
        let crate::synthetic_store::hydration::Hydrated {
            records,
            epochs,
            from_previous_boot,
        } = crate::synthetic_store::hydration::hydrate(
            &state,
            |kind| Record::Active {
                kind: match kind {
                    Kind::Phone => DeviceKind::Phone,
                    Kind::Desktop => DeviceKind::Desktop,
                },
            },
            || Record::Removed { at: 0 },
        );
        let core = TemporaryAuthority {
            revocations: Arc::new(RwLock::new(Revocations {
                retired: false,
                epochs,
            })),
            instance,
            global: writer.global(),
            active: Arc::new(AtomicUsize::new(0)),
            devices: BTreeMap::new(),
            host: SecretKey::from(state.secret),
            token: snapshot::hex(&state.token),
            limits: l,
            // Desktop access starts disabled; the owner may enable it for this run.
            desktop: DesktopAccess::Disabled,
            retired: false,
            records,
            storage: RecordStore::Persistent(Box::new(RestartRecords {
                writer,
                state,
                from_previous_boot,
                fault: None,
                #[cfg(test)]
                before_commit: None,
            })),
            binding: Some(binding),
            grant: Grant {
                generation: 0,
                opened: 0,
                until: 0,
            },
            pending: BTreeMap::new(),
            next: 0,
            last_time: 0,
            admission: Admission::new(l.admission),
        };
        OpenedAuthority::Ready(Self {
            phase: Phase::Running,
            fixed: fixed_executor::Core::default(),
            pending_carriers: BTreeMap::new(),
            core: Some(core),
            registry: Some(registry),
            pid: std::process::id(),
        })
    }
    fn check_policy(&self) -> super::Result<()> {
        if self.pid != std::process::id() {
            return Err(StoreFault::WrongProcess.into());
        }
        if self.phase != Phase::Running
            || self
                .core
                .as_ref()
                .is_none_or(|c| c.retired || c.revocations.is_poisoned())
        {
            return Err(PolicyError::Denied);
        }
        Ok(())
    }
    fn check_registry(&self) -> registry::Result<()> {
        if self.pid != std::process::id() {
            return Err(crate::Error::Unauthorized.into());
        }
        if self.phase != Phase::Running
            || self
                .core
                .as_ref()
                .is_none_or(|c| c.retired || c.revocations.is_poisoned())
        {
            return Err(registry::RegistryError::Revoked);
        }
        Ok(())
    }
    // Fork continuation is unsupported. Refuse before inherited Rust locks; discard
    // runtime allocations until child exit, closing only the child's FD aliases.
    fn abandon_inherited(&mut self) -> StoppedAuthority {
        let mut core = self.core.take().unwrap();
        let RecordStore::Persistent(store) =
            std::mem::replace(&mut core.storage, RecordStore::Closed)
        else {
            unreachable!()
        };
        let diag = diagnostics(&store.state, Some(StoreFault::WrongProcess));
        let writer = (*store).into_writer();
        std::mem::forget(core);
        std::mem::forget(self.registry.take());
        std::mem::forget(std::mem::take(&mut self.fixed));
        StoppedAuthority {
            writer,
            diagnostics: diag,
        }
    }
    fn core(&mut self) -> &mut TemporaryAuthority {
        self.core.as_mut().expect("owned while ready")
    }
    fn fail_closed<T>(&mut self, result: super::Result<T>) -> super::Result<T> {
        if self.core().retired {
            self.abort_in_place();
        }
        self.reconcile_bound();
        result
    }
    pub fn host_public_key(&self) -> crate::PublicKey {
        self.core.as_ref().unwrap().host.public_key()
    }
    /// Trusted owner-only invitation delivery, allowed only within an open window.
    /// The callback must not log or persist this synthetic pairing token.
    pub fn with_pairing_invitation<T>(
        &mut self,
        now: u64,
        read: impl FnOnce(&str) -> T,
    ) -> super::Result<T> {
        self.check_policy()?;
        let core = self.core();
        core.clock(now)?;
        if core.retired || now >= core.grant.until {
            return Err(PolicyError::Denied);
        }
        Ok(read(&core.token))
    }
    pub fn open_pairing(&mut self, now: u64) -> super::Result<()> {
        self.check_policy()?;
        let result = self.core().open_pairing(now);
        self.fail_closed(result)
    }
    pub fn admission_status(&mut self, source: Source, now: u64) -> super::Result<AdmissionStatus> {
        self.check_policy()?;
        self.core().admission_status(source, now)
    }
    pub fn begin(
        &mut self,
        source: Source,
        hello: &[u8],
        now: u64,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> super::Result<Ticket> {
        self.check_policy()?;
        let result = self.core().begin(source, hello, now, rng);
        self.reconcile_bound();
        result
    }
    /// Explicit trusted owner action; this run starts with desktop access disabled.
    pub fn enable_desktop(&mut self) -> super::Result<()> {
        self.check_policy()?;
        if self.core().retired {
            return Err(PolicyError::Denied);
        }
        self.core().desktop = DesktopAccess::Enabled;
        Ok(())
    }
    pub fn approve_desktop(&mut self, ticket: &Ticket, now: u64) -> super::Result<()> {
        self.check_policy()?;
        self.core().approve_desktop(ticket, now)
    }
    pub fn pending_device(&self, ticket: &Ticket) -> super::Result<&channel::Device> {
        self.check_policy()?;
        self.core.as_ref().unwrap().pending_device(ticket)
    }
    pub fn cancel(&mut self, ticket: Ticket) -> super::Result<()> {
        self.check_policy()?;
        self.core().cancel(ticket)
    }
    pub fn open_carrier(&mut self, id: u64, now: u64) -> registry::Result<Handle> {
        self.check_registry()?;
        let result = self.registry.as_mut().unwrap().open_carrier(id, now);
        self.reconcile_bound();
        result
    }
    /// Ticket authorization and establishment stay inside the same owning boundary.
    /// Any failure closes this pending carrier; no reply or Session escapes.
    pub fn complete(
        &mut self,
        handle: &Handle,
        ticket: Ticket,
        now: impl FnMut() -> u64,
    ) -> std::result::Result<(), PersistentError> {
        self.complete_access(handle, ticket, now).map(|_| ())
    }
    fn complete_access(
        &mut self,
        handle: &Handle,
        ticket: Ticket,
        mut now: impl FnMut() -> u64,
    ) -> std::result::Result<Access, PersistentError> {
        self.check_policy()?;
        if let Err(error) = self.registry.as_mut().unwrap().pending(handle, now()) {
            let _ = self.core().cancel(ticket);
            self.registry
                .as_mut()
                .unwrap()
                .close(handle, CloseReason::Protocol);
            self.reconcile_bound();
            return Err(error.into());
        }
        let result = (|| {
            let session = self.core().complete(ticket, &mut now)?;
            let access = session.access();
            self.registry
                .as_mut()
                .unwrap()
                .establish(handle, session, now())?;
            Ok(access)
        })();
        if result.is_err() {
            self.registry
                .as_mut()
                .unwrap()
                .close(handle, CloseReason::Protocol);
        }
        if self.core().retired {
            self.abort_in_place();
        }
        self.reconcile_bound();
        result
    }
    pub fn remove_device(&mut self, key: &str, now: u64) -> super::Result<()> {
        self.check_policy()?;
        self.fixed.cancel_device(key);
        let result = self
            .core
            .as_mut()
            .unwrap()
            .remove(self.registry.as_mut().unwrap(), key, now);
        self.fail_closed(result)
    }
    pub fn disconnect(&mut self, handle: &Handle) -> bool {
        if self.check_registry().is_err() {
            return false;
        }
        let closed = self
            .registry
            .as_mut()
            .unwrap()
            .close(handle, CloseReason::Disconnected);
        self.reconcile_bound();
        closed
    }
    pub(crate) fn inspect_fixed_candidate(
        &mut self,
        token: &WorkToken,
        now: u64,
    ) -> registry::claim::ReadyInspection {
        if let Err(error) = self.check_registry() {
            return registry::claim::ReadyInspection {
                candidate: Err(error.into()),
                promoted: Vec::new(),
            };
        }
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .inspect_ready_candidate(token, now);
        self.reconcile_bound();
        result
    }
    pub fn receive_request(
        &mut self,
        h: &Handle,
        bytes: &[u8],
        now: u64,
    ) -> registry::Result<Vec<WorkToken>> {
        self.check_registry()?;
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .receive_request(h, bytes, now);
        self.reconcile_bound();
        result
    }
    pub fn take_output(
        &mut self,
        h: &Handle,
        now: u64,
        consume: impl FnOnce(&[u8]) -> crate::Result<()>,
    ) -> registry::Result<bool> {
        self.check_registry()?;
        let result = self.registry.as_mut().unwrap().take_output(h, now, consume);
        self.reconcile_bound();
        result
    }
    pub fn drain_work(
        &mut self,
        cursor: Option<&WorkCursor>,
        limit: usize,
        now: u64,
    ) -> registry::Result<WorkPage> {
        self.check_registry()?;
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .drain_work(cursor, limit, now);
        self.reconcile_bound();
        result
    }
    pub fn finish_request(
        &mut self,
        t: &WorkToken,
        response: &[u8],
        now: u64,
    ) -> registry::Result<Vec<WorkToken>> {
        self.check_registry()?;
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .finish_request(t, response, now);
        self.reconcile_bound();
        result
    }
    pub fn dispatch_synthetic(
        &mut self,
        t: &WorkToken,
        http: &crate::http_dispatch::MemoryHttp,
        now: u64,
    ) -> registry::Result<(crate::http_dispatch::DispatchRecord, Vec<WorkToken>)> {
        self.check_registry()?;
        let result = self
            .registry
            .as_mut()
            .unwrap()
            .dispatch_synthetic(t, http, now);
        self.reconcile_bound();
        result
    }
    pub fn tick(&mut self, now: u64) -> std::result::Result<Vec<WorkToken>, PersistentError> {
        self.check_policy()?;
        let result = (|| {
            self.core().expire(now)?;
            let started = self.registry.as_mut().unwrap().tick(now)?;
            if self.poll_fixed(now).is_err() {
                return Err(PolicyError::Denied.into());
            }
            Ok(started)
        })();
        if result.is_err() {
            self.abort_in_place();
        }
        self.reconcile_bound();
        result
    }
    pub fn diagnostics(&self) -> StoreDiagnostics {
        match &self.core.as_ref().unwrap().storage {
            RecordStore::Persistent(s) => diagnostics(&s.state, s.fault),
            _ => unreachable!(),
        }
    }
    #[expect(
        clippy::result_large_err,
        reason = "retain writer ownership without allocating after an IO failure"
    )]
    fn stop(mut self, retired: bool) -> std::result::Result<StoreDiagnostics, CloseFailure> {
        if self.pid != std::process::id() {
            return Err(CloseFailure {
                fault: StoreFault::WrongProcess,
                stopped: self.abandon_inherited(),
            });
        }
        if let Err(fault) = self.quiesce_for_join() {
            return Err(CloseFailure {
                fault,
                stopped: self.abort_without_commit(),
            });
        }
        let mut core = self.core.take().unwrap();
        let RecordStore::Persistent(mut store) =
            std::mem::replace(&mut core.storage, RecordStore::Closed)
        else {
            unreachable!()
        };
        drop(core); // drops transient host/token/channel/session state before terminal IO
        let mut diag = diagnostics(&store.state, None);
        let result = (|| {
            if let Some(fault) = store.fault {
                return Err(fault);
            }
            let mut next = store.state.clone();
            increment(&mut next.revision)?;
            next.running = false;
            next.retired = retired;
            if retired {
                // Sanitize only the new persisted terminal snapshot. No heap/disk
                // secure-erasure claim is made for earlier copies or filesystem history.
                next.secret.fill(0);
                next.token.fill(0);
            }
            let receipt = store.writer.commit(&next)?;
            diag = diagnostics(&next, None);
            Ok(receipt)
        })();
        let writer = (*store).into_writer(); // drops persisted material before returning guard
        match result {
            Err(fault) => Err(CloseFailure {
                fault,
                stopped: stopped(writer, diag, fault),
            }),
            Ok(receipt) => match writer.acknowledge(receipt) {
                Ok(()) => Ok(diag),
                Err((fault, writer)) => Err(CloseFailure {
                    fault,
                    stopped: stopped(writer, diag, fault),
                }),
            },
        }
    }
    #[cfg(test)]
    pub(crate) fn before_commit_for_test(&mut self, callback: Box<dyn FnOnce() + Send>) {
        let RecordStore::Persistent(store) = &mut self.core().storage else {
            unreachable!()
        };
        store.before_commit = Some(callback);
    }
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn fail_next_terminal_for_test(&mut self, stage: crate::synthetic_store::IoStage) {
        let RecordStore::Persistent(store) = &mut self.core().storage else {
            unreachable!()
        };
        store.writer.fail_next = Some(stage);
    }
    #[expect(
        clippy::result_large_err,
        reason = "retain writer ownership without allocating after an IO failure"
    )]
    pub fn close_for_restart(self) -> std::result::Result<CleanStop, CloseFailure> {
        self.stop(false).map(CleanStop)
    }
    #[expect(
        clippy::result_large_err,
        reason = "retain writer ownership without allocating after an IO failure"
    )]
    pub fn retire_identity(self) -> std::result::Result<RetiredStop, CloseFailure> {
        self.stop(true).map(RetiredStop)
    }
}
impl Drop for PersistentAuthority {
    fn drop(&mut self) {
        if self.core.is_some() && self.pid != std::process::id() {
            drop(self.abandon_inherited());
            return;
        }
        if let Some(core) = &mut self.core {
            core.retire();
        }
        if let Some(registry) = &mut self.registry {
            registry.retire();
        }
        self.fixed.drain();
        // WriterLease Drop invalidates the broker ledger. No snapshot writes here.
    }
}
#[derive(Debug, thiserror::Error)]
pub enum PersistentError {
    #[error(transparent)]
    Policy(#[from] PolicyError),
    #[error(transparent)]
    Registry(#[from] registry::RegistryError),
}
#[cfg(all(test, target_os = "macos"))]
pub(crate) mod tests;
