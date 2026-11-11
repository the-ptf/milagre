# Proposal: isolated synthetic authority restart

Status: proposal only, awaiting parent API agreement before implementation. This checkpoint adds no runtime code, dependency, constructor or profile reader. Existing 135-test/six-doctest evidence covers the current disposable implementation, not the restart behavior proposed here.

## Scope and source findings

`policy::TemporaryAuthority` currently writes only device kinds/removal times, deletes its store on drop, and keeps revocation epochs and retirement in memory. `TemporaryRecords` uses path-based metadata checks and rename; it does not pin descriptors or exclude another writer. Its `Removed.at` and pairing window times belong to one monotonic clock domain. Reopening that snapshot directly would lose epochs, durable retirement and clock meaning. It must not become an existing-profile constructor.

Introduce a separate fresh synthetic store, then share a private authority core between disposable and restartable wrappers. Keep `TemporaryAuthority::create_synthetic` and `Supervisor::spawn_synthetic` behavior unchanged. First implement store/authority recovery with a local subprocess harness; wire a restartable supervisor only after that checkpoint passes. No existing profile import, production owner startup, network, phone, mobile or daemon writer is included.

## Proposed capability/API

Round 1 revision accepts all five parent refinements. Names below specify the proposed public ownership boundary; these are not implemented APIs. All capability fields are private; none implements Clone, Serialize, Deserialize or secret-bearing Debug.

```rust
pub struct SyntheticProfile;    // pinned root + marker/lock identities + broker ledger
pub struct WriterLease;         // two independent exclusive locks + acquiring PID
pub struct PersistentAuthority; // owns its bound Registry and all synchronous work
pub struct PersistentLimits {
    pub policy: policy::Limits,
    pub registry: registry::Limits,
}
pub struct CleanStop;           // redacted durability receipt, never an opener
pub struct RetiredStop;         // distinct terminal-identity receipt
pub struct StoppedAuthority;    // revoked state + writer lease, cannot resume/commit
pub struct Quarantine;          // writer lease + redacted diagnostics only
pub struct RetiredProfile;      // writer lease + redacted diagnostics only
pub struct CloseFailure;        // StoreFault + StoppedAuthority, private fields
pub struct Released;            // diagnostic release receipt, never an opener
pub struct Destroyed;           // diagnostic cleanup receipt

pub enum OpenedAuthority {
    Ready(PersistentAuthority),
    Quarantined(Quarantine),
    Retired(RetiredProfile),
}
impl SyntheticProfile {
    pub fn create(options: SyntheticStoreLimits, rng: &mut impl CryptoRngCore)
        -> Result<Self, StoreFault>;
    pub fn acquire_writer(&mut self) -> Result<WriterLease, StoreFault>;
    pub fn destroy(&mut self) -> Result<Destroyed, StoreFault>;
}
impl PersistentAuthority {
    pub fn resume(
        writer: WriterLease, limits: PersistentLimits, rng: &mut impl CryptoRngCore,
    ) -> OpenedAuthority;
    pub fn close_for_restart(self) -> Result<CleanStop, CloseFailure>;
    pub fn retire_identity(self) -> Result<RetiredStop, CloseFailure>;
}
impl CloseFailure {
    pub fn into_parts(self) -> (StoreFault, StoppedAuthority);
}
impl StoppedAuthority {
    pub fn diagnostics(&self) -> StoreDiagnostics;
    pub fn release(self) -> Released;
}
// Quarantine and RetiredProfile expose the same diagnostics/release surface only.
```

`resume` always returns an owning outcome: a ready authority, a quarantine guard for any dirt/schema/config/IO failure, or a terminal retired guard. No failure drops the moved lease invisibly. `acquire_writer` failure leaves the borrowed profile intact. Busy returns before snapshot reads or cleanup. The ready authority owns its Registry internally, removing the possibility of passing the wrong registry to a consuming close. Narrow operation methods delegate to the shared authority core; no API lets callers extract its Registry, storage or writer lease.

Close first consumes admission, revokes every issued Session through the shared epoch guard, cancels all pending tickets and queued/inflight work, closes owned carriers, releases owned payload leases, and drops transient channel/session state. Persisted identity material stays private only for the terminal snapshot write, then is dropped before returning either receipt or stopped guard. It then attempts the durable terminal transition while retaining both writer locks. A failure returns `CloseFailure` containing that **already revoked** `StoppedAuthority`. The guard offers diagnostics and explicit release, never resume, retry-Clean, pairing, or replay of the failed write. The profile remains marked unclean/uncertain. Dropping the failure/guard also closes its descriptors after teardown, without any disk write. The store/authority checkpoints spawn no task or thread; subprocess joining remains the harness broker's responsibility. Supervisor integration must later provide a guard that also owns and joins its worker before a close receipt is possible.

`Drop` of a ready authority, writer lease, quarantine or stopped guard **never commits Clean**, never performs reset/retirement recovery, and never writes a snapshot. Ready-authority Drop revokes/clears runtime ownership, marks its broker run unclean, then closes descriptors. CleanStop is possible only through successful explicit `close_for_restart`. Retirement returns a different receipt and cannot be mistaken for restart eligibility.

`destroy(&mut self)` excludes active writers and retains the profile/cleanup ownership on any error. During partial cleanup the profile enters Destroying, refuses acquisition, and retains its cleanup lock until explicit retry or Drop. A retry deletes only remaining names tracked as owned by this capability; it never replays an authority transaction. Success makes the profile permanently Destroyed. Quarantine guards must be released first. No `reset_synthetic`, unquarantine, empty-state fallback, or reset-in-place API is included. The only fresh start after quarantine is safe destruction and a separately created capability.

`StoreFault` is a closed, redacted enum: Busy, Unsupported, WrongProcess, IdentityChanged, Permission, InvalidLimits, InvalidSchema, TooLarge, Exhausted, DirtyRun, UnexpectedEntry, and Io { stage: IoStage, kind: ErrorKind }. IO stages are fixed labels such as OpenRoot, LockRoot, LockFile, ReadSnapshot, WriteTransaction, SyncFile, Rename, SyncDirectory, Close, Unlink. No arbitrary message/path/JSON token, serde error text, raw input bytes, secret-bearing source chain, or Debug traversal of owned state is exposed. StoreDiagnostics contains only the fault code, public capability id and validated generation/state counters. Parse failures never echo a field/value. Consuming IO errors retain ownership in the typed guard, not in an unstructured error string.

`CryptoRngCore` above denotes the existing `RngCore + CryptoRng` bounds, not a new randomness implementation. Creation generates a new synthetic box key and pairing token internally. It accepts no identity, path, existing directory, arbitrary descriptor, serialized capability or key material. No Ed25519 signing seed is needed for this authority-only checkpoint; host proof identity persistence stays separate. Diagnostics expose public profile id, generation and state, never secret values. Synthetic secrets are private-file plaintext in this experiment, not encrypted-at-rest production storage.

The profile capability retains an opened directory descriptor and the expected marker id/device/inode. It can start a new writer after the previous lease releases. `WriterLease` moves into the authority and is never publicly cloneable. Same-process lease ownership is checked as well as OS locking. Authority/registry binding is opaque: the authority creates and owns its registry, rejecting sessions from any other profile or boot generation. Existing temporary registry construction remains unchanged.

For process replacement, a trusted test broker retains the fresh SyntheticProfile across worker deaths. A crate-private subprocess harness transfers only an **unlocked** pinned root capability and expected marker/root/lock identities through an inherited descriptor and anonymous control pipe to a fixed worker. This is not a public from_path/from_fd API, arbitrary binary launcher or service endpoint. The worker opens its own root and lock-file descriptions and acquires both locks itself; no acquired WriterLease is transferred across PIDs. The broker holds no writer-lock description while the worker runs. All unrelated descriptors are close-on-exec. The worker PID and exact attempt generation are bound to the broker's private launch record.

The retained broker also keeps a fail-closed run ledger: Pending/Active, CleanAcknowledged, RetiredAcknowledged or Uncertain. It marks an attempt Active before delegation. Reacquisition requires the previous writer to have terminated/released ownership; readiness additionally requires a valid Clean snapshot **and** the broker's matching post-sync Clean acknowledgment. A killed worker, lost acknowledgment, close IO error or ordinary Drop makes the attempt Uncertain. This closes the ambiguous-final-sync hole: a Clean rename might be visible even when directory sync failed, but visible Clean alone cannot authorize resume. A crash after durable Clean but before its acknowledgment conservatively quarantines. No acknowledgment is minted before all-session revocation, all required syncs and writer release. The private control pipe accepts one receipt bound to that worker/attempt; receipt replay cannot open another run. Same-process operation uses the same ledger state transitions. The ledger is not a durable production recovery mechanism.

This survives replacement of the authority worker while the synthetic test broker remains alive. Recovery after the broker itself dies, machine reboot, arbitrary process attachment, and a production profile locator are explicitly deferred. The next implementation must prove descriptor transfer and writer exclusion with actual subprocesses, not claim process replacement from a same-process drop/reopen test.

## Disk format v1

A newly created 0700 directory contains exactly three persistent files, all 0600 regular files with one link and expected owner: `marker.json`, `writer.lock`, and `authority.json`. A bounded create-new transaction file may exist during replacement. No Node filenames are reused. Marker contains `{format:"milagre-rust-remote-synthetic",version:1,profile_id:<random128>}`. Marker and lock inode identities remain pinned for the capability lifetime.

One strictly decoded, bounded `authority.json` snapshot contains:

| Field                                    | Contract                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `profile_id`, `revision`      | Exact schema version and marker binding; checked u64 revision, no wrap.                                                                                                                                                    |
| `identity_generation`, `boot_generation` | Checked counters. Identity generation is initialized once and cannot reset in v1; boot generation durably increments before every admission-capable run.                                                                   |
| `identity_status`                        | `current` or terminal `retired`. Ordinary shutdown does not retire identity.                                                                                                                                               |
| `run_state`                              | `clean` or `running`. Running is durably committed before admitting any HELLO or opening a pairing window.                                                                                                                 |
| `box_secret`, `pairing_token`            | Internally generated synthetic identity only; canonical fixed-size encoding. Public box key is derived and checked, not separately trusted.                                                                                |
| `devices`                                | Unique canonical public keys with stored kind, checked `epoch`, and `active` or `removed` state. Removed entries retain `removal_generation`. Re-pairing changes state without resetting epoch or erasing removal history. |
| `policy_generation`                      | Durable checked counter for pairing-window/removal ordering across clock resets. No persisted monotonic timestamps are compared across boots.                                                                              |

Bound both serialized and parsed storage. Initial hard ceilings: 2 MiB snapshot bytes, 4,096 lifetime distinct device slots, 3 MiB charged parsed state, and 12 MiB aggregate working reservation for current/candidate state, input, encode output and parser scratch. Lower configured limits remain possible; higher limits are rejected. Decode directly into fixed-size typed records (decoded 32-byte keys, enums, checked u64 fields), with no serde Value tree or unbounded owned strings. Enforce object fields, nesting, token/string sizes and record count while streaming, before extending a container; use fallible allocation and explicit capacity charges. Canonical sorted device entries permit duplicate/order rejection without a second unbounded key set. Bound serializer output as it is written, not only after building a Vec. An allocator-observation test must substantiate the reservation estimates; the limits alone are not proof of allocation accounting.

Retain the existing configurable active-device cap (default 64). Tombstones consume existing history slots and are never silently evicted; a full history refuses only enrollment of another previously unseen key. Removal requires no new slot. Re-pairing never resets epoch. Reject inconsistent removal/policy/boot generations, unknown or duplicate fields, noncanonical encoding and checked-counter exhaustion. No wrap, tombstone garbage collection or authority-wide retirement after 64 removals. This is explicitly different from Node's capped/evicting lists.

A new pairing window durably advances policy generation. A removal advances it and records the resulting generation in the tombstone. Removed keys can enroll only under a later explicitly opened window. Preserve the existing same-process strict-time rule for a removal and reopen at the same monotonic millisecond; after restart all old windows are closed and a new owner action opens a later generation. Multiple approved enrollments in a window remain allowed. Tickets and approval grants are never restored from disk.

## Descriptor and writer rules

All snapshot, marker, transaction and lock operations use fixed names relative to the pinned directory descriptor. No fresh path traversal after capability creation. Use no-follow/exclusive creation and descriptor metadata checks; refuse symlinks, extra links, wrong owner/modes, replaced marker/lock inode, unexpected type or schema version. Snapshot replacement changes its inode by design; marker and lock replacement do not. Filesystem operations need maintained descriptor-relative and locking APIs, verified against primary documentation before selecting/pinning a dependency. This proposal adds no dependency and makes no platform-support claim.

Acquire two nonblocking exclusive advisory locks in a fixed order: **root directory inode first, then writer.lock inode**. Each worker opens a new root description relative to the retained unlocked root descriptor, compares its metadata with the pinned root identity, and locks it. Only under that root lock may it validate the expected marker and lock-file identities, open a new independent lock-file description and lock it. Never use dup/inheritance of an already locked description as acquisition. Replacing writer.lock cannot create a second writer because the first still owns the unchanged root inode lock; after release the replacement inode fails the expected identity check. Root path substitution also cannot change the pinned root inode.

Every capability/writer operation verifies its acquiring PID before file access or mutation. A forked/inherited locked descriptor cannot authorize work in the child. Child-side refusal/Drop closes only child descriptors and never issues an explicit unlock against the parent's shared open-file description; subprocess tests must prove a competing independent writer stays excluded until the parent releases its own locks. Wrong-PID teardown must not enter potentially inherited Rust mutexes/RwLocks; this is descriptor refusal, not support for continuing an inherited multithreaded authority after fork. The private exec bootstrap accepts only unlocked broker provenance and opens independent descriptions. It does not adopt arbitrary locked descriptors. Platforms unable to satisfy these directory-lock/open-description semantics return Unsupported; no path-only fallback.

Before any snapshot read, transaction sweep, write or cleanup, check PID, both lock ownership states, root identity and pinned marker/lock identities. Type, owner, permissions and single-link checks apply to regular files; directory identity uses device/inode and owner/mode (not regular-file link count). Hold both locks through final sync and runtime teardown; close errors retain the owning guard. Destruction locks the root before checking/sweeping names and never follows a replaced path. POSIX/macOS is the first verification target, not a claimed already-supported platform. Primary-source library/OS verification precedes implementation. Advisory locks coordinate cooperating processes, not a malicious same-UID process.

Snapshot transaction: create new file relative to root, bounded encode, write all, file sync, rename relative to root, directory sync. Only then report Committed. An error after mutation starts marks the run Uncertain; fail closed and never release ACCEPT or retry the operation automatically. At most one transaction file can be outstanding; an unknown transaction is not adopted as the newest state. Successful rename without successful directory sync is still ambiguous.

No general recursive deletion. `destroy` first excludes writers and validates the original capability, then unlinks only this format's known files and tracked transaction names relative to the descriptor. Unexpected entries cause an explicit cleanup error. Ordinary authority drop never deletes the restart store. Test harness cleanup owns only the fresh synthetic capability and must not follow a renamed/substituted external pathname.

## Crash, revocation and restart semantics

1. **Clean resume:** hold both writer locks, validate the snapshot/binding and the matching broker Clean acknowledgment, require `clean/current`, increment boot generation, commit `running`, then create the in-memory authority/registry. Pairing is closed. Active devices may perform fresh authenticated known-device handshakes; pending approvals, work, frames, counters, admission windows and session keys are discarded. Constructor failure after writing Running leaves a quarantined store rather than advertising readiness.
2. **Removal:** revoke current in-memory access and all matching registry work first, consume pending tickets, increment the device epoch and policy generation, persist the tombstone, then acknowledge. Failed or ambiguous IO poisons this writer and revokes all its sessions. It may never write Clean on drop. The already durable Running state forces quarantine on the next attempt even if disk still contains the old active record.
3. **Clean handoff:** consume the authority and bound registry, stop admission, revoke every issued Session (including externally retained handles), close carriers/cancel work and flush all required state, then commit Clean and release both writer locks. Only this successful transition returns CleanStop. Drop never writes Clean, even when state appears unpoisoned and teardown is complete. If close fails, return the revoked writer guard; the broker records Uncertain and the caller must explicitly release it or drop it without further writes. A crash after Clean cannot leave usable sessions because revocation precedes that commit.
4. **Crash/ambiguity:** seeing Running, malformed/truncated data, missing files or an unknown transaction does not silently restore known devices or reset to empty. Return Quarantined with redacted diagnostics; no HELLO, pairing, ACCEPT or registry establishment. Initial version has no automatic replay/recovery, reset_synthetic or reset-in-place. Quarantined is an owning read-only diagnostic state. Release its guard, safely destroy through the original profile capability, and explicitly create a separate fresh capability if desired. Product/production recovery is gated out of this checkpoint. A matching visible Clean file without a broker Clean acknowledgment remains quarantined.

5. **Identity retirement:** revoke runtime access first, persist terminal Retired, acknowledge only after durability. Failed retirement leaves Running/quarantine. A retired store cannot be resumed as Current; replacement means an explicitly created new synthetic profile. `close_for_restart` and `retire_identity` are separate operations so ordinary worker replacement does not permanently retire the host.

Every Session/Ticket/WorkToken/handle binds to profile id, identity generation, boot generation and a fresh runtime nonce where applicable; device sessions also carry the persisted epoch. No deserializer exists for these capabilities. A successor registry rejects an old completed Session even if its device key is active again. A killed process cannot keep a socket in this synthetic harness, and a clean predecessor must revoke/close before releasing ownership. Persisted boot generation does not resume cryptographic counters or channels; all reconnects require fresh crypto.

The conservative dirty-run policy deliberately sacrifices automatic crash availability to prevent an unacknowledged removal from becoming an allowed reconnect. It is the proposed initial checkpoint, not a claim of seamless recovery. It also does not protect against disk rollback or another privileged process restoring an older complete Clean snapshot; anti-rollback storage requires a separate trust anchor and is outside this fresh-capability test.

## Node data compatibility inventory

| Actual source                         | Existing Node contract                                                                                                                                                                                                                                                            | Proposal difference/gap                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/daemon/src/devices.cjs`         | `devices.json` has `devices` plus `removed`; stored kind is phone/computer; device name, pairedAt, lastSeen, isNew and announced persist. Up to 32 active devices and 32 removal timestamps; oldest entries are evicted. Legacy `relay-phones.json` migrates on missing new file. | Separate incompatible v1 format, no importer/exporter. Internal desktop kind needs explicit computer mapping in any later migration. No metadata/notices/claim migration. Persisted epochs and history slots are additional policy. |
| `apps/daemon/src/phone.cjs`           | `mobile.json` stores enabled, token and lan. Pairing windows are process-local ten-minute windows; removedAt must precede window opening.                                                                                                                                         | Synthetic token survives clean restart, but enabled/LAN preferences and live services are absent. Windows are closed at restart. Generation ordering avoids cross-boot monotonic comparisons.                                       |
| `apps/daemon/src/relay-identity.cjs`  | `relay-identity.json` stores separate signing/box key pairs; host id derives from signing public key. Retired signing keys and draining identities have separate files and lifetimes.                                                                                             | Only internally generated synthetic box identity persists here. No signing-key import, host identity, retired-room drain, key conversion or relay lifecycle.                                                                        |
| `writePrivate` and device write queue | Create-new private temporary file, rename, ordered device writes; the inspected helper has no explicit file/directory fsync or writer lock. Unreadable device data can become empty state.                                                                                        | Descriptor pinning, explicit syncs, exclusive writer, strict failure quarantine and terminal retirement are stronger but different behavior. No claim of Node disk-format compatibility.                                            |

These are source-only observations. No existing files, real device keys, credentials or profile directories were opened.

## Acceptance tests before a runtime checkpoint

- Same-process and actual subprocess clean restart: known records/kinds/epochs survive, stable synthetic box identity/token, pairing closed, fresh handshake required, old Session/Ticket/approval/work/cursor rejected, new re-pair under a later window accepted.
- Writer exclusion: actual independent subprocesses; replace writer.lock while the first writer is alive and prove the root lock prevents a second writer; after release the substituted inode still fails validation. Pass inherited locked descriptions to a child and prove wrong-PID/adoption refusal cannot unlock the parent; independently opened root descriptions remain excluded. Include kill/release, symlink/hardlink/permission changes, root rename/substitution, and validation-before-read/sweep instrumentation.
- Fault injection at create/write/file-sync/rename/directory-sync and every Running/Clean/removal/retirement boundary. Kill a worker after runtime revocation but before tombstone commit; the successor must quarantine, never admit the old key. No ACCEPT before commit. Drop never issues a Clean write in any state. Every consuming close fault returns the already-revoked writer guard; its release/Drop must release both locks without replay. Kill after Clean rename/before sync or acknowledgment and require broker-ledger quarantine despite a visible Clean file.
- Strict decode and bounds: duplicate fields/keys, unknown versions, noncanonical keys, truncated/oversized snapshots, impossible epoch/generation state and counter overflow. More than 64 distinct removals do not retire the service; at 4,096 history slots known reconnects and removal still work while unseen enrollment fails.
- Existing 135 tests, six doctests and six Node checks remain required. Add synthetic fixtures from actual Node device serialization/pairing predicates only; never load the service startup graph or existing profile. Production migration, broker-loss recovery and mobile interoperability remain explicitly untested.

## Contract checkpoint and next sequence

All five round-1 refinements are accepted in this revision. The exact error-ownership shape above returns revoked guards on consuming close failure, keeps quarantine read-only, and gives Drop no commit path. The retained broker acknowledgment is required to enforce quarantine even when an ambiguous Clean rename is visible on disk. Confirm this revised API/ownership shape before concluding the contract; no runtime implementation has begun.

After agreement, checkpoint 1 implements only fresh descriptor store/capability, locking, strict bounded snapshots, explicit commit and subprocess/fault-injection evidence. Checkpoint 2 adds the persistent authority, composed revocation, persisted epochs/tombstones and explicit clean close. Existing temporary behavior remains unchanged. Supervisor ownership/wiring is a later separately reviewed checkpoint. No reset, production recovery, existing-profile/import/network/mobile/host change or push is included.
