//! Private single-thread owner of actual copied services. The composed target alone connects its native flight.
mod native_api;
mod provider;
mod storage;
use milagre_accounts::{AccountSandbox, AccountService, IdentityState, Readiness, Selection};
use milagre_owner_store::{
    chat_host::{ChatHost, Notice, TurnId},
    isolation::{Isolation, Policy},
    states::{ProjectStates, Timing},
    OwnedProject,
};
use milagre_registry::{
    writer::{RegistryCopy, Seeds},
    ProjectGrant, Registry, Snapshot,
};
use provider::{CaptureProvider, SharedMailbox};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use storage::{Directory, Root};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Bounds,
    Storage,
    Identity,
    Selection,
    NotReady,
    Request,
    Owner,
    Registry,
    Revoked,
    Busy,
    Closed,
    Worker,
    CleanupUncertain,
    Deadline,
}
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy)]
pub(super) enum Scenario {
    Ready,
    SignedOut,
    MissingSelection,
}
#[derive(Clone, Copy)]
pub(super) enum Mutation {
    ReobserveReady,
    ReobserveSignedOut,
    FailedObservation,
    Metadata,
    FailedMetadata,
    ReopenAccount,
    RegistryBytes,
    SwapProject,
    RestoreProject,
    Panic,
}
#[derive(Clone, Copy)]
pub(super) enum Close {
    Project,
    All,
}
#[derive(Clone)]
pub(super) struct AdmissionId {
    scope: Arc<()>,
    serial: u64,
}
impl PartialEq for AdmissionId {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.scope, &other.scope) && self.serial == other.serial
    }
}
impl Eq for AdmissionId {}
impl std::fmt::Debug for AdmissionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdmissionId(<private>)")
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Evidence {
    pub(super) generation: u64,
    pub(super) turn: u64,
    pub(super) cwd: (u64, u64),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Closed {
    pub(super) no_native_connection: bool,
    pub(super) host_closed: bool,
    pub(super) accounts_closed: bool,
    pub(super) resources_removed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Locks {
    pub(super) account_busy: bool,
    pub(super) project_busy: Option<bool>,
}
#[allow(dead_code)]
pub(super) struct BoundStart {
    pub(super) prompt: String,
    pub(super) directories: [std::fs::File; 3],
    pub(super) evidence: Evidence,
}
#[derive(Debug)]
#[allow(dead_code)]
pub(super) enum DeliveryError {
    Rejected(Error),
    Retained(Error),
}
impl From<Error> for DeliveryError {
    fn from(error: Error) -> Self {
        Self::Rejected(error)
    }
}
#[allow(dead_code)]
pub(super) enum Signal {
    Started(String),
    TurnStarted,
    Completed,
    Cancelled,
    Failed,
    Exited,
    StartFailed,
}
struct Gate {
    scope: Arc<()>,
    active: AtomicBool,
    cancellation: AtomicU64,
}
impl Gate {
    fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    fn cancel(&self) {
        if self.cancellation.try_update(Ordering::AcqRel, Ordering::Acquire, |v| v.checked_add(1)).is_err() {
            self.revoke();
        }
    }
}
#[derive(Clone)]
pub(super) struct Cancel(Arc<Gate>);
impl Cancel {
    pub(super) fn cancel(&self) {
        self.0.cancel();
    }
}
enum Command {
    Send(String),
    Validate(AdmissionId),
    Mutate(Mutation),
    Close(Close, bool),
    Locks,
    Notices,
    Descriptor,
}
enum Reply {
    Admission(AdmissionId),
    Evidence(Evidence),
    Closed(Closed),
    Locks(Locks),
    Notices(Vec<Notice>),
    Descriptor((u64, u64)),
    Unit,
}
struct Envelope {
    command: Command,
    reply: mpsc::SyncSender<Result<Reply>>,
}
pub(super) struct Fixture {
    sender: Option<mpsc::SyncSender<Envelope>>,
    worker: Option<thread::JoinHandle<Result<Closed>>>,
    gate: Arc<Gate>,
}
impl Fixture {
    pub(super) fn create(scenario: Scenario) -> Result<Self> {
        let gate = Arc::new(Gate { scope: Arc::new(()), active: AtomicBool::new(true), cancellation: AtomicU64::new(0) });
        let retained = gate.clone();
        // One outstanding command: non-Clone facade and mutable request methods.
        // One 64 KiB input plus one bounded callback, independent of owner-store state.
        let (sender, receiver) = mpsc::sync_channel::<Envelope>(1);
        let (started, startup) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("synthetic-acp-service-owner".into())
            .spawn(move || {
                let mut owner = match ServiceOwner::create(scenario, retained) {
                    Ok(owner) => {
                        let _ = started.send(Ok(()));
                        owner
                    }
                    Err(error) => {
                        let _ = started.send(Err(error));
                        return Err(error);
                    }
                };
                loop {
                    let envelope = match receiver.recv_timeout(Duration::from_millis(20)) {
                        Ok(envelope) => envelope,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            owner.observe_cancel()?;
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| owner.apply(envelope.command)));
                    match result {
                        Ok(reply) => {
                            let _ = envelope.reply.send(reply);
                        }
                        Err(_) => {
                            owner.gate.revoke();
                            let _ = envelope.reply.send(Err(Error::Worker));
                            break;
                        }
                    }
                }
                owner.finish()
            })
            .map_err(|_| Error::Worker)?;
        let mut fixture = Self { sender: Some(sender), worker: Some(worker), gate };
        match startup.recv() {
            Ok(Ok(())) => Ok(fixture),
            Ok(Err(error)) => {
                fixture.sender.take();
                let _ = fixture.worker.take().unwrap().join();
                Err(error)
            }
            Err(_) => Err(Error::Worker),
        }
    }
    fn request(&mut self, command: Command) -> Result<Reply> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender.as_ref().ok_or(Error::Closed)?.send(Envelope { command, reply }).map_err(|_| Error::Closed)?;
        receiver.recv().map_err(|_| Error::Worker)?
    }
    pub(super) fn send(&mut self, text: &str) -> Result<AdmissionId> {
        if text.len() > 64 * 1024 {
            return Err(Error::Bounds);
        }
        match self.request(Command::Send(text.into()))? {
            Reply::Admission(id) => Ok(id),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn validate(&mut self, id: &AdmissionId) -> Result<Evidence> {
        match self.request(Command::Validate(id.clone()))? {
            Reply::Evidence(value) => Ok(value),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn mutate(&mut self, mutation: Mutation) -> Result<()> {
        self.request(Command::Mutate(mutation)).map(|_| ())
    }
    pub(super) fn close(&mut self, target: Close, force: bool) -> Result<Closed> {
        match self.request(Command::Close(target, force))? {
            Reply::Closed(value) => Ok(value),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn locks(&mut self) -> Result<Locks> {
        match self.request(Command::Locks)? {
            Reply::Locks(value) => Ok(value),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn notices(&mut self) -> Result<Vec<Notice>> {
        match self.request(Command::Notices)? {
            Reply::Notices(value) => Ok(value),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn retained_descriptor(&mut self) -> Result<(u64, u64)> {
        match self.request(Command::Descriptor)? {
            Reply::Descriptor(value) => Ok(value),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn cancel_handle(&self) -> Cancel {
        Cancel(self.gate.clone())
    }
    pub(super) fn finish(mut self) -> Result<Closed> {
        self.sender.take();
        self.worker.take().ok_or(Error::Closed)?.join().map_err(|_| Error::Worker)?
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.gate.cancel();
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Ready {
    proof: Readiness,
    epoch: u64,
    state: IdentityState,
}
struct Captured {
    id: AdmissionId,
    chat: String,
    turn: TurnId,
    selection: Selection,
    readiness: Ready,
    owner: [u8; 16],
    generation: u64,
    epoch: u64,
    cancellation: u64,
    snapshot: Snapshot,
    _grant: ProjectGrant,
    descriptor: Directory,
    prompt: Option<String>,
}
#[derive(Default)]
struct Staging {
    arena: Option<Root>,
    account_root: Option<Root>,
    sandbox: Option<AccountSandbox>,
    accounts: Option<AccountService>,
    host: Option<ChatHost>,
    cleanup_uncertain: bool,
}
impl Staging {
    fn cleanup(&mut self) -> Result<()> {
        if self.cleanup_uncertain {
            return Err(Error::CleanupUncertain);
        }
        if self.sandbox.is_some() && self.account_root.is_none() {
            return Err(Error::CleanupUncertain);
        }
        if let Some(host) = self.host.as_mut() {
            let owned = host.states.projects();
            let result = host.shutdown(true);
            let stranded = host.take_notices().iter().any(stranded_notice);
            if stranded
                || result.is_err() && owned.iter().any(|p| !host.states.has(p))
                || result.is_ok() && owned.iter().any(|p| !lock_absent(p))
            {
                self.cleanup_uncertain = true;
                return Err(Error::CleanupUncertain);
            }
            result.map_err(|_| Error::CleanupUncertain)?;
        }
        if let Some(accounts) = self.accounts.as_mut() {
            accounts.close();
        }
        self.host.take();
        self.accounts.take();
        self.sandbox.take();
        if let Some(root) = &self.account_root {
            root.cleanup()?;
        }
        self.account_root.take();
        if let Some(root) = &self.arena {
            root.cleanup()?;
        }
        self.arena.take();
        Ok(())
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        if self.cleanup().is_err() {
            std::mem::forget(self.host.take());
            std::mem::forget(self.accounts.take());
            std::mem::forget(self.sandbox.take());
            std::mem::forget(self.arena.take());
            std::mem::forget(self.account_root.take());
        }
    }
}
pub(super) struct ServiceOwner {
    arena: Option<Root>,
    account_root: Option<Root>,
    sandbox: Option<AccountSandbox>,
    accounts: Option<AccountService>,
    host: Option<ChatHost>,
    isolation: Isolation,
    registry_copy: RegistryCopy,
    registry: Registry,
    project: PathBuf,
    isolation_pin: Directory,
    home: Directory,
    tmp: Directory,
    runtime: tokio::runtime::Runtime,
    mailbox: SharedMailbox,
    gate: Arc<Gate>,
    ready: Option<Ready>,
    capture: Option<Captured>,
    pending: Option<(String, TurnId)>,
    epoch: u64,
    seen_cancel: u64,
    sent: bool,
    project_closed: bool,
    accounts_closed: bool,
    cleaned: bool,
    cleanup_uncertain: bool,
    native_connection: bool,
}
impl ServiceOwner {
    fn create(scenario: Scenario, gate: Arc<Gate>) -> Result<Self> {
        let mut staging = Staging::default();
        let result = (|| {
            staging.arena = Some(Root::create()?);
            let isolation = Isolation::create(&staging.arena.as_ref().unwrap().path.join("isolation"), &Policy::default())
                .map_err(|_| Error::Storage)?;
            let project = isolation.project(Path::new("project")).map_err(|_| Error::Storage)?;
            for name in ["home", "tmp"] {
                std::fs::create_dir(isolation.root().join(name)).map_err(|_| Error::Storage)?;
            }
            let seed = match scenario {
                Scenario::MissingSelection => {
                    json!({ "accounts": [], "selected": {"kiro":"default"}, "scopes": {project.to_str().unwrap(): {"kiro":"11111111-1111-4111-8111-111111111111"}} })
                }
                _ => json!({ "accounts": [], "selected": {"kiro":"default"}, "scopes": {} }),
            };
            staging.sandbox = Some(AccountSandbox::create(Some(&seed.to_string())).map_err(|_| Error::Storage)?);
            staging.account_root = Some(Root::owned(staging.sandbox.as_ref().unwrap().path().to_owned())?);
            staging.accounts = Some(staging.sandbox.as_ref().unwrap().open().map_err(|_| Error::Owner)?);
            let registry_copy = RegistryCopy::create(
                isolation.clone(),
                Seeds {
                    registry: Some(
                        serde_json::to_vec(
                            &json!({"projects":[{"id":project,"path":project,"name":"project","git":false}],"links":[],"projectGroups":[]}),
                        )
                        .map_err(|_| Error::Storage)?,
                    ),
                    recent: None,
                },
            )
            .map_err(|_| Error::Registry)?;
            let active = gate.clone();
            let registry =
                registry_copy
                    .reader(Arc::new(move || {
                        if active.active.load(Ordering::Acquire) {
                            Ok(())
                        } else {
                            Err("Synthetic coordinator closed.".into())
                        }
                    }))
                    .map_err(|_| Error::Registry)?;
            // The copied owner store opens existing metadata. Seed an empty Project,
            // then register its sole worktree through the actual owner update API.
            std::fs::create_dir(project.join(".milagre")).map_err(|_| Error::Storage)?;
            std::fs::write(project.join(".milagre/coordination.json"), b"{\"next_id\":2,\"worktrees\":{},\"sessions\":{},\"messages\":[]}")
                .map_err(|_| Error::Storage)?;
            staging.host = Some(ChatHost::new(ProjectStates::new(isolation.clone(), Timing::default(), 0)));
            staging
                .host
                .as_mut()
                .unwrap()
                .states
                .try_update(&project, None, true, |latest| {
                    let mut state = latest.clone();
                    Arc::make_mut(&mut state.rest).insert("worktrees".into(), json!({"1":{"id":1,"path":project,"name":"main"}}));
                    Ok(Some(state))
                })
                .map_err(|_| Error::Owner)?;
            let mailbox = Arc::new(Mutex::new(provider::Mailbox::default()));
            staging.host.as_mut().unwrap().register(Box::new(CaptureProvider { mailbox: mailbox.clone() }));
            staging.host.as_mut().unwrap().open_project(&project).map_err(|_| Error::Owner)?;
            // Complete fallible setup while Staging still owns every resource.
            let isolation_pin = Directory::open(isolation.root())?;
            let home = Directory::open(&isolation.root().join("home"))?;
            let tmp = Directory::open(&isolation.root().join("tmp"))?;
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| Error::Worker)?;
            let mut owner = Self {
                arena: staging.arena.take(),
                account_root: staging.account_root.take(),
                sandbox: staging.sandbox.take(),
                accounts: staging.accounts.take(),
                host: staging.host.take(),
                isolation_pin,
                home,
                tmp,
                project,
                isolation,
                registry_copy,
                registry,
                runtime,
                mailbox,
                gate,
                ready: None,
                capture: None,
                pending: None,
                epoch: 0,
                seen_cancel: 0,
                sent: false,
                project_closed: false,
                accounts_closed: false,
                cleaned: false,
                cleanup_uncertain: false,
                native_connection: false,
            };
            owner.observe(match scenario {
                Scenario::SignedOut => IdentityState::SignedOut,
                _ => IdentityState::Ready,
            })?;
            Ok(owner)
        })();
        if result.is_err() {
            staging.cleanup()?;
        }
        result
    }
    fn account(&self) -> Result<&AccountService> {
        self.accounts.as_ref().ok_or(Error::Closed)
    }
    fn host(&mut self) -> Result<&mut ChatHost> {
        self.host.as_mut().ok_or(Error::Closed)
    }
    fn bump(&mut self) -> Result<()> {
        let Some(next) = self.epoch.checked_add(1) else {
            self.gate.revoke();
            self.ready = None;
            return Err(Error::Revoked);
        };
        self.epoch = next;
        self.ready = None;
        Ok(())
    }
    fn observe(&mut self, state: IdentityState) -> Result<()> {
        self.bump()?;
        let accounts = self.accounts.as_mut().ok_or(Error::Closed)?;
        let observation = accounts.begin_observation("kiro", "default").map_err(|_| Error::NotReady)?;
        let proof = accounts.observed(observation, state).map_err(|_| Error::NotReady)?;
        self.ready = Some(Ready { proof, epoch: self.epoch, state });
        Ok(())
    }
    fn observe_cancel(&mut self) -> Result<()> {
        let now = self.gate.cancellation.load(Ordering::Acquire);
        if now != self.seen_cancel {
            self.seen_cancel = now;
            self.bump()?;
            self.reject_capture()?;
        }
        Ok(())
    }
    fn reject_capture(&mut self) -> Result<()> {
        if let Some((chat, turn)) = self.pending.clone() {
            if self.host.as_ref().is_some_and(|h| h.active_turn(&chat) == Some(turn)) {
                provider::reject(&self.mailbox, &chat, turn)?;
                if !self.host()?.tick(0).is_empty() {
                    return Err(Error::Owner);
                }
            }
        }
        Ok(())
    }
    fn pins(&self) -> Result<()> {
        self.arena.as_ref().ok_or(Error::Closed)?.check()?;
        self.account_root.as_ref().ok_or(Error::Closed)?.check()?;
        self.isolation_pin.check()?;
        self.home.check()?;
        self.tmp.check()?;
        if std::fs::symlink_metadata(self.project.join(".git")).is_ok() {
            return Err(Error::Identity);
        }
        Ok(())
    }
    fn send(&mut self, text: String) -> Result<AdmissionId> {
        self.send_until(text, Instant::now() + Duration::from_secs(5))
    }
    pub(super) fn send_until(&mut self, text: String, deadline: Instant) -> Result<AdmissionId> {
        let already_pending = self.pending.is_some();
        let result = self.send_inner(text, deadline);
        if result.is_err() && !already_pending && self.pending.is_some() {
            self.gate.cancel();
            self.reject_capture()?;
        }
        result
    }
    fn send_inner(&mut self, text: String, deadline: Instant) -> Result<AdmissionId> {
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        self.observe_cancel()?;
        if !self.gate.active.load(Ordering::Acquire) || self.project_closed {
            return Err(Error::Closed);
        }
        if self.sent {
            return Err(Error::Busy);
        }
        if text.len() > 64 * 1024 {
            return Err(Error::Bounds);
        }
        self.pins()?;
        let selection = self.account()?.pin(Some(self.project.to_str().ok_or(Error::Identity)?)).map_err(|_| Error::Selection)?;
        if selection.account_id("kiro").map_err(|_| Error::Selection)? != "default" {
            return Err(Error::Selection);
        }
        let ready = self.ready.take().ok_or(Error::NotReady)?;
        if ready.state != IdentityState::Ready {
            self.ready = Some(ready);
            return Err(Error::NotReady);
        }
        let owner = *self.account()?.owner_id().map_err(|_| Error::Owner)?.as_bytes();
        let generation = self.account()?.generation().map_err(|_| Error::Owner)?;
        let cancellation = self.gate.cancellation.load(Ordering::Acquire);
        let project = self.project.clone();
        self.host()?.require_project_ready(&project).map_err(|_| Error::Owner)?;
        let sent = self
            .host()?
            .send(&json!({"projectPath":project,"worktreeId":1,"provider":"kiro","model":"kiro:auto","permissionMode":"ask","body":text}))
            .map_err(|_| Error::Owner)?;
        self.sent = true;
        if let Some(turn) = sent.turn {
            self.pending = Some((format!("{}#{}", project.display(), sent.session_id), turn));
        }
        let start = self.mailbox.lock().map_err(|_| Error::Worker)?.start.take().ok_or(Error::Request)?;
        let chat = start.request.0["chatId"].as_str().ok_or(Error::Request)?.to_owned();
        if sent.turn != Some(start.turn)
            || start.request.0["cwd"] != json!(project)
            || chat != format!("{}#{}", project.display(), sent.session_id)
        {
            return Err(Error::Request);
        }
        let snapshot = self.registry.snapshot().map_err(|_| Error::Registry)?;
        let prepared_snapshot = snapshot.clone();
        let prepared_path = project.clone();
        let grant = self.runtime.block_on(async move {
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), async move {
                let grant = prepared_snapshot.project(&prepared_path).await.map_err(|_| Error::Registry)?;
                if !grant.contains_folder(&prepared_path).await.map_err(|_| Error::Registry)? {
                    return Err(Error::Registry);
                }
                Ok(grant)
            })
            .await
            .map_err(|_| Error::Deadline)?
        })?;
        let descriptor = Directory::open(&project)?;
        if !descriptor.descriptor_is_directory() {
            return Err(Error::Identity);
        }
        let id = AdmissionId { scope: self.gate.scope.clone(), serial: 1 };
        self.capture = Some(Captured {
            id: id.clone(),
            chat,
            turn: start.turn,
            selection,
            readiness: ready,
            owner,
            generation,
            epoch: self.epoch,
            cancellation,
            snapshot,
            _grant: grant,
            descriptor,
            prompt: Some(start.request.0["prompt"].as_str().ok_or(Error::Request)?.to_owned()),
        });
        self.validate(&id)?;
        Ok(id)
    }
    pub(super) fn validate(&mut self, id: &AdmissionId) -> Result<Evidence> {
        // An unrelated observation ID cannot revoke the current admission.
        if !Arc::ptr_eq(&id.scope, &self.gate.scope) || self.capture.as_ref().is_none_or(|c| c.id.serial != id.serial) {
            return Err(Error::Revoked);
        }
        let result = self.validate_inner(id);
        if result.is_err() {
            self.bump()?;
            let _ = self.reject_capture(); // Failed owner folds stay retained for close/recovery.
        }
        result
    }
    fn validate_inner(&mut self, id: &AdmissionId) -> Result<Evidence> {
        self.observe_cancel()?;
        if !self.gate.active.load(Ordering::Acquire) || self.project_closed {
            return Err(Error::Revoked);
        }
        self.pins()?;
        let capture = self.capture.as_ref().ok_or(Error::Revoked)?;
        if !Arc::ptr_eq(&id.scope, &self.gate.scope)
            || id.serial != capture.id.serial
            || self.epoch != capture.epoch
            || self.epoch != capture.readiness.epoch
            || self.gate.cancellation.load(Ordering::Acquire) != capture.cancellation
        {
            return Err(Error::Revoked);
        }
        let _retained_opaque_proof = &capture.readiness.proof;
        let account = self.account()?;
        if *account.owner_id().map_err(|_| Error::Owner)?.as_bytes() != capture.owner
            || account.generation().map_err(|_| Error::Owner)? != capture.generation
            || account
                .pin(Some(self.project.to_str().ok_or(Error::Identity)?))
                .map_err(|_| Error::Selection)?
                .account_id("kiro")
                .map_err(|_| Error::Selection)?
                != capture.selection.account_id("kiro").map_err(|_| Error::Selection)?
        {
            return Err(Error::Revoked);
        }
        capture.snapshot.check().map_err(|_| Error::Registry)?;
        capture.descriptor.check()?;
        let evidence = Evidence { generation: capture.generation, turn: capture.turn.0, cwd: capture.descriptor.identity() };
        let (chat, turn) = (capture.chat.clone(), capture.turn);
        let project = self.project.clone();
        self.host()?.require_project_ready(&project).map_err(|_| Error::Owner)?;
        if self.host()?.active_turn(&chat) != Some(turn) {
            return Err(Error::Revoked);
        }
        Ok(evidence)
    }
    pub(super) fn mutate(&mut self, mutation: Mutation) -> Result<()> {
        if self.cleanup_uncertain {
            return Err(Error::CleanupUncertain);
        }
        if self.accounts_closed {
            return Err(Error::Closed);
        }
        // Test-only byte/path tampering exercises actual snapshot/descriptor checks.
        // Every actual service mutation invalidates before it runs, including failures.
        if !matches!(mutation, Mutation::RegistryBytes | Mutation::SwapProject | Mutation::RestoreProject) {
            self.bump()?;
        }
        match mutation {
            Mutation::ReobserveReady => self.observe(IdentityState::Ready),
            Mutation::ReobserveSignedOut => self.observe(IdentityState::SignedOut),
            Mutation::FailedObservation => self
                .accounts
                .as_mut()
                .ok_or(Error::Closed)?
                .begin_observation("invalid", "default")
                .map(|_| ())
                .map_err(|_| Error::NotReady),
            Mutation::Metadata | Mutation::FailedMetadata => {
                let scope =
                    if matches!(mutation, Mutation::FailedMetadata) { "invalid" } else { self.project.to_str().ok_or(Error::Identity)? };
                self.accounts.as_mut().ok_or(Error::Closed)?.assign(scope, "codex", None, None).map(|_| ()).map_err(|_| Error::Owner)
            }
            Mutation::ReopenAccount => {
                self.accounts.as_mut().ok_or(Error::Closed)?.close();
                self.accounts = Some(self.sandbox.as_ref().ok_or(Error::Closed)?.open().map_err(|_| Error::Owner)?);
                Ok(())
            }
            Mutation::RegistryBytes => {
                std::fs::write(self.registry_copy.path().join("project-registry.json"), b"{\"projects\":[]}").map_err(|_| Error::Registry)
            }
            Mutation::SwapProject => {
                std::fs::rename(&self.project, self.project.with_extension("held")).map_err(|_| Error::Identity)?;
                std::fs::create_dir(&self.project).map_err(|_| Error::Identity)
            }
            Mutation::RestoreProject => {
                std::fs::remove_dir(&self.project).map_err(|_| Error::Identity)?;
                std::fs::rename(self.project.with_extension("held"), &self.project).map_err(|_| Error::Identity)?;
                let project = self.project.clone();
                self.host()?.open_project(&project).map_err(|_| Error::Owner)
            }
            Mutation::Panic => panic!("synthetic service owner panic"),
        }
    }
    pub(super) fn close(&mut self, target: Close, force: bool) -> Result<Closed> {
        if self.cleanup_uncertain {
            return Err(Error::CleanupUncertain);
        }
        if !force
            && self.pending.as_ref().is_some_and(|(chat, turn)| self.host.as_ref().is_some_and(|h| h.active_turn(chat) == Some(*turn)))
        {
            return Err(Error::Busy);
        }
        self.gate.revoke();
        self.bump()?;
        self.reject_capture()?;
        // The composed actor must establish native disposal before calling close.
        // The admission-only target has no native flight. Copied services retain their ps helper.
        let project = self.project.clone();
        if !self.project_closed {
            let had_slot = self.host()?.states.has(&project);
            let result = self.host()?.forget(&project, true);
            if result.is_err() && had_slot && !self.host()?.states.has(&project) || result.is_ok() && !lock_absent(&project) {
                // ProjectStates consumes its slot before owner.release. Retrying
                // after that release failed cannot establish that the lock is gone.
                self.cleanup_uncertain = true;
                return Err(Error::CleanupUncertain);
            }
            result.map_err(|_| Error::Owner)?;
            self.project_closed = true;
        }
        if matches!(target, Close::All) && !self.accounts_closed {
            let owned = self.host()?.states.projects();
            let result = self.host()?.shutdown(true);
            if result.is_err() && owned.iter().any(|p| !self.host.as_ref().unwrap().states.has(p))
                || result.is_ok() && !lock_absent(&project)
            {
                self.cleanup_uncertain = true;
                return Err(Error::CleanupUncertain);
            }
            result.map_err(|_| Error::Owner)?;
            self.accounts.as_mut().ok_or(Error::Closed)?.close();
            self.accounts_closed = true;
        }
        Ok(Closed {
            no_native_connection: !self.native_connection,
            host_closed: self.project_closed,
            accounts_closed: self.accounts_closed,
            resources_removed: false,
        })
    }
    pub(super) fn finish(mut self) -> Result<Closed> {
        let mut report = match self.close(Close::All, true) {
            Ok(report) => report,
            Err(error) => {
                std::mem::forget(self);
                return Err(error);
            }
        };
        self.host.take();
        self.accounts.take();
        self.sandbox.take();
        if self.account_root.as_ref().is_some_and(|r| r.cleanup().is_err()) || self.arena.as_ref().is_some_and(|r| r.cleanup().is_err()) {
            std::mem::forget(self);
            return Err(Error::CleanupUncertain);
        }
        report.resources_removed = true;
        self.cleaned = true;
        Ok(report)
    }
    fn apply(&mut self, command: Command) -> Result<Reply> {
        self.observe_cancel()?;
        match command {
            Command::Send(text) => self.send(text).map(Reply::Admission),
            Command::Validate(id) => self.validate(&id).map(Reply::Evidence),
            Command::Mutate(mutation) => self.mutate(mutation).map(|_| Reply::Unit),
            Command::Close(target, force) => self.close(target, force).map(Reply::Closed),
            Command::Locks => {
                let account_busy = self.sandbox.as_ref().ok_or(Error::Closed)?.open().is_err();
                let project_busy = if self.capture.as_ref().is_some_and(|c| c.descriptor.check().is_err()) {
                    None // Do not acquire a lock in a replacement directory just to probe.
                } else {
                    Some(OwnedProject::open(&self.isolation, &self.project, None).is_err())
                };
                Ok(Reply::Locks(Locks { account_busy, project_busy }))
            }
            Command::Notices => {
                let notices = self.host()?.take_notices();
                if notices.iter().any(stranded_notice) {
                    self.cleanup_uncertain = true;
                    self.gate.revoke();
                }
                Ok(Reply::Notices(notices))
            }
            Command::Descriptor => Ok(Reply::Descriptor(self.capture.as_ref().ok_or(Error::Revoked)?.descriptor.retained_identity()?)),
        }
    }
}

fn lock_absent(project: &Path) -> bool {
    std::fs::symlink_metadata(project.join(".milagre/runtime.lock")).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
fn stranded_notice(notice: &Notice) -> bool {
    matches!(notice, Notice::LockStranded { .. }) || matches!(notice, Notice::Failed { what, .. } if what == "releasing Project locks")
}
impl Drop for ServiceOwner {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }
        if self.close(Close::All, true).is_err() {
            // A failed owner close is not permission to delete its state or release
            // the account writer. Retain those actual objects instead of a success flag.
            std::mem::forget(self.host.take());
            std::mem::forget(self.accounts.take());
            std::mem::forget(self.sandbox.take());
            std::mem::forget(self.arena.take());
            std::mem::forget(self.account_root.take());
            return;
        }
        self.host.take();
        self.accounts.take();
        self.sandbox.take();
        if let Some(root) = &self.account_root {
            let _ = root.cleanup();
        }
        if let Some(root) = &self.arena {
            let _ = root.cleanup();
        }
        self.cleaned = true;
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn gate() -> Arc<Gate> {
        Arc::new(Gate { scope: Arc::new(()), active: AtomicBool::new(true), cancellation: AtomicU64::new(0) })
    }

    #[test]
    fn owner_guard_closes_services_and_removes_its_generated_roots() {
        let gate = gate();
        let mut owner = ServiceOwner::create(Scenario::Ready, gate.clone()).unwrap();
        let id = owner.send("guard drop".into()).unwrap();
        owner.validate(&id).unwrap();
        let arena = owner.arena.as_ref().unwrap().path.clone();
        let account_root = owner.account_root.as_ref().unwrap().path.clone();
        drop(owner);
        assert!(!gate.active.load(Ordering::Acquire));
        assert!(!arena.exists() && !account_root.exists());
    }

    #[test]
    fn consumed_owner_slot_failure_remains_uncertain_in_isolated_process() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "service_owner::lifecycle_tests::retain_failed_release_child", "--nocapture"])
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        let manifests: Vec<_> =
            stdout.lines().filter_map(|line| line.split_once("SERVICE_RETAINED_ROOTS ").map(|(_, json)| json)).collect();
        assert_eq!(manifests.len(), 2, "{}\n{}", stdout, String::from_utf8_lossy(&output.stderr));
        // Only the parent, after the retaining test process exits, removes these
        // four exact generated roots. The owner never resets its uncertain state.
        for manifest in manifests {
            let roots: serde_json::Value = serde_json::from_str(manifest).unwrap();
            let roots = roots.as_array().unwrap();
            assert_eq!(roots.len(), 2);
            for (record, prefix) in roots.iter().zip(["milagre-acp-service-", "milagre-account-copy-"]) {
                let path = PathBuf::from(record["path"].as_str().unwrap());
                assert_eq!(path.parent(), Some(Path::new("/private/tmp")));
                assert!(path.file_name().unwrap().to_str().unwrap().starts_with(prefix));
                let root = Root::owned(path).unwrap();
                assert_eq!(root.identity(), (record["device"].as_u64().unwrap(), record["inode"].as_u64().unwrap()));
                root.cleanup().unwrap();
                assert!(!root.path.exists());
            }
        }
        assert!(output.status.success(), "{}\n{}", stdout, String::from_utf8_lossy(&output.stderr));
    }

    fn record(roots: [&Root; 2]) {
        let records: Vec<_> = roots.iter().map(|r| json!({"path":r.path,"device":r.identity().0,"inode":r.identity().1})).collect();
        println!("SERVICE_RETAINED_ROOTS {}", serde_json::to_string(&records).unwrap());
    }

    #[test]
    #[ignore = "The fixed parent test verifies retained resources and removes them only after process exit"]
    fn retain_failed_release_child() {
        let mut owner = ServiceOwner::create(Scenario::Ready, gate()).unwrap();
        owner.send("release must not become success on retry".into()).unwrap();
        owner.reject_capture().unwrap();
        owner.host.as_mut().unwrap().states.flush(None).unwrap();
        let lock = owner.project.join(".milagre/runtime.lock");
        std::fs::write(lock.join("fixed-extra-entry"), b"prevent lock directory removal").unwrap();
        let sandbox = owner.sandbox.as_ref().unwrap().clone();
        assert_eq!(owner.close(Close::All, true), Err(Error::CleanupUncertain));
        assert!(!owner.host.as_ref().unwrap().states.has(&owner.project));
        assert!(!lock.join("owner.json").exists());
        assert_eq!(owner.close(Close::All, true), Err(Error::CleanupUncertain));
        assert!(sandbox.open().is_err());
        assert_eq!(owner.mutate(Mutation::ReopenAccount), Err(Error::CleanupUncertain));
        assert!(sandbox.open().is_err());
        record([owner.arena.as_ref().unwrap(), owner.account_root.as_ref().unwrap()]);
        assert_eq!(owner.finish(), Err(Error::CleanupUncertain));
        assert!(sandbox.open().is_err() && lock.exists());

        // The partially built bundle has the same consuming shutdown hazard.
        let mut owner = ServiceOwner::create(Scenario::Ready, gate()).unwrap();
        owner.host.as_mut().unwrap().states.flush(None).unwrap();
        std::fs::write(owner.project.join(".milagre/runtime.lock/fixed-extra-entry"), b"prevent removal").unwrap();
        let sandbox = owner.sandbox.as_ref().unwrap().clone();
        let mut staging = Staging {
            arena: owner.arena.take(),
            account_root: owner.account_root.take(),
            sandbox: owner.sandbox.take(),
            accounts: owner.accounts.take(),
            host: owner.host.take(),
            cleanup_uncertain: false,
        };
        owner.cleaned = true;
        drop(owner);
        assert_eq!(staging.cleanup(), Err(Error::CleanupUncertain));
        assert_eq!(staging.cleanup(), Err(Error::CleanupUncertain));
        assert!(sandbox.open().is_err());
        record([staging.arena.as_ref().unwrap(), staging.account_root.as_ref().unwrap()]);
        drop(staging);
        assert!(sandbox.open().is_err());
    }
}
