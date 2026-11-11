# Proposal: isolated synthetic authority restart

Status: proposal only, awaiting parent API agreement before implementation. This checkpoint adds no runtime code, dependency, constructor or profile reader. Existing 128-test/six-doctest evidence covers the current disposable implementation, not the restart behavior proposed here.

## Scope and source findings

`policy::TemporaryAuthority` currently writes only device kinds/removal times, deletes its store on drop, and keeps revocation epochs and retirement in memory. `TemporaryRecords` uses path-based metadata checks and rename; it does not pin descriptors or exclude another writer. Its `Removed.at` and pairing window times belong to one monotonic clock domain. Reopening that snapshot directly would lose epochs, durable retirement and clock meaning. It must not become an existing-profile constructor.

Introduce a separate fresh synthetic store, then share a private authority core between disposable and restartable wrappers. Keep `TemporaryAuthority::create_synthetic` and `Supervisor::spawn_synthetic` behavior unchanged. First implement store/authority recovery with a local subprocess harness; wire a restartable supervisor only after that checkpoint passes. No existing profile import, production owner startup, network, phone, mobile or daemon writer is included.

## Proposed capability/API

Names below are proposed Rust signatures, not available APIs:

```rust
pub struct SyntheticProfile;       // private pinned directory/marker identity
pub struct WriterLease;            // non-Clone, private fields, owns exclusive lock
pub struct PersistentAuthority;    // shares private AuthorityCore policy logic
pub struct CleanStop;              // durability receipt, not an opening credential
pub enum OpenedAuthority {
    Ready(PersistentAuthority),
    Quarantined(Quarantine),
    Retired(RetiredProfile),
}

impl SyntheticProfile {
    pub fn create(options: SyntheticStoreLimits, rng: &mut impl CryptoRngCore)
        -> Result<Self>;
    pub fn acquire_writer(&mut self) -> Result<WriterLease>;
    pub fn destroy(self) -> Result<()>;
}
impl PersistentAuthority {
    pub fn resume(writer: WriterLease, limits: Limits)
        -> Result<OpenedAuthority>;
    pub fn close_for_restart(self, registry: Registry) -> Result<CleanStop>;
    pub fn retire_identity(self, registry: Registry) -> Result<CleanStop>;
}
```

`CryptoRngCore` above denotes the existing `RngCore + CryptoRng` bounds, not a new randomness implementation. Creation generates a new synthetic box key and pairing token internally. It accepts no identity, path, existing directory, arbitrary descriptor, serialized capability or key material. No Ed25519 signing seed is needed for this authority-only checkpoint; host proof identity persistence stays separate. Diagnostics expose public profile id, generation and state, never secret values. Synthetic secrets are private-file plaintext in this experiment, not encrypted-at-rest production storage.

The profile capability retains an opened directory descriptor and the expected marker id/device/inode. It can start a new writer after the previous lease releases. `WriterLease` moves into the authority and is never publicly cloneable. Same-process lease ownership is checked as well as OS locking. Authority/registry binding is opaque: create the registry through this authority, then reject sessions from any other profile or boot generation. This adds a restart-specific registry factory; existing temporary registry construction remains unchanged.

For process replacement, a trusted test broker retains the fresh `SyntheticProfile` across worker deaths. A crate-private subprocess harness transfers only its inherited descriptor and expected capability identity through an anonymous pipe to a fixed test worker. This bootstrap decoder is not a public `from_path`/`from_fd` API, CLI profile opener or service endpoint. Each worker opens its own lock-file description relative to the pinned directory; inheriting/duplicating one locked open-file description would allow a child to share the writer's lock and is forbidden. The broker holds no writer descriptor while a worker runs. All unrelated descriptors are close-on-exec. A second worker must return Busy without reading secret state or mutating disk.

This survives replacement of the authority worker while the synthetic test broker remains alive. Recovery after the broker itself dies, machine reboot, arbitrary process attachment, and a production profile locator are explicitly deferred. The next implementation must prove descriptor transfer and writer exclusion with actual subprocesses, not claim process replacement from a same-process drop/reopen test.

## Disk format v1

A newly created 0700 directory contains exactly three persistent files, all 0600 regular files with one link and expected owner: `marker.json`, `writer.lock`, and `authority.json`. A bounded create-new transaction file may exist during replacement. No Node filenames are reused. Marker contains `{format:"milagre-rust-remote-synthetic",version:1,profile_id:<random128>}`. Marker and lock inode identities remain pinned for the capability lifetime.

One strictly decoded, bounded `authority.json` snapshot contains:

| Field                                    | Contract                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `profile_id`, `revision`      | Exact schema version and marker binding; checked u64 revision, no wrap.                                                                                                                                                    |
| `identity_generation`, `boot_generation` | Checked counters. Identity generation changes only on an explicit owner reset; boot generation durably increments before every admission-capable run.                                                                      |
| `identity_status`                        | `current` or terminal `retired`. Ordinary shutdown does not retire identity.                                                                                                                                               |
| `run_state`                              | `clean` or `running`. Running is durably committed before admitting any HELLO or opening a pairing window.                                                                                                                 |
| `box_secret`, `pairing_token`            | Internally generated synthetic identity only; canonical fixed-size encoding. Public box key is derived and checked, not separately trusted.                                                                                |
| `devices`                                | Unique canonical public keys with stored kind, checked `epoch`, and `active` or `removed` state. Removed entries retain `removal_generation`. Re-pairing changes state without resetting epoch or erasing removal history. |
| `policy_generation`                      | Durable checked counter for pairing-window/removal ordering across clock resets. No persisted monotonic timestamps are compared across boots.                                                                              |

Use bounded streaming decoding with duplicate/unknown field rejection, canonical keys and integer ranges, before constructing the full state. Initial caps: 2 MiB snapshot, 4,096 lifetime distinct key slots, and the existing configurable active-device cap (default 64). Tombstones consume existing slots and are never silently evicted; a full history refuses only enrollment of another previously unseen key. Removal of an existing active key requires no new slot. This is explicitly different from Node's capped/evicting lists. No tombstone garbage collection or authority-wide retirement after 64 removals.

A new pairing window durably advances policy generation. A removal advances it and records the resulting generation in the tombstone. Removed keys can enroll only under a later explicitly opened window. Preserve the existing same-process strict-time rule for a removal and reopen at the same monotonic millisecond; after restart all old windows are closed and a new owner action opens a later generation. Multiple approved enrollments in a window remain allowed. Tickets and approval grants are never restored from disk.

## Descriptor and writer rules

All snapshot, marker, transaction and lock operations use fixed names relative to the pinned directory descriptor. No fresh path traversal after capability creation. Use no-follow/exclusive creation and descriptor metadata checks; refuse symlinks, extra links, wrong owner/modes, replaced marker/lock inode, unexpected type or schema version. Snapshot replacement changes its inode by design; marker and lock replacement do not. Filesystem operations need maintained descriptor-relative and locking APIs, verified against primary documentation before selecting/pinning a dependency. This proposal adds no dependency and makes no platform-support claim.

A nonblocking OS advisory lock on the fixed lock inode stays held from validation through final directory sync and authority/session teardown. POSIX/macOS is the first test target; unsupported platforms must return Unsupported, not fall back to path checks or pretend locking succeeded. Advisory locking and private permissions coordinate cooperating processes, not a malicious same-UID process. Descriptor pinning confines operations after directory rename; no cleanup follows a substituted path.

Snapshot transaction: create new file relative to root, bounded encode, write all, file sync, rename relative to root, directory sync. Only then report Committed. An error after mutation starts is PersistenceUnknown; fail closed and never release ACCEPT or retry the operation automatically. At most one transaction file can be outstanding; an unknown transaction is not adopted as the newest state. Successful rename without successful directory sync is still ambiguous.

No general recursive deletion. `destroy` first excludes writers and validates the original capability, then unlinks only this format's known files and tracked transaction names relative to the descriptor. Unexpected entries cause an explicit cleanup error. Ordinary authority drop never deletes the restart store. Test harness cleanup owns only the fresh synthetic capability and must not follow a renamed/substituted external pathname.

## Crash, revocation and restart semantics

1. **Clean resume:** hold the writer lock, validate the entire snapshot and binding, require `clean/current`, increment boot generation, commit `running`, then create the in-memory authority/registry. Pairing is closed. Active devices may perform fresh authenticated known-device handshakes; pending approvals, work, frames, counters, admission windows and session keys are discarded. Constructor failure after writing Running leaves a quarantined store rather than advertising readiness.
2. **Removal:** revoke current in-memory access and all matching registry work first, consume pending tickets, increment the device epoch and policy generation, persist the tombstone, then acknowledge. Failed or ambiguous IO poisons this writer and revokes all its sessions. It may never write Clean on drop. The already durable Running state forces quarantine on the next attempt even if disk still contains the old active record.
3. **Clean handoff:** consume the authority and bound registry, stop admission, revoke every issued Session (including externally retained handles), close carriers/cancel work and flush all required state, then commit Clean and release the writer lock. Only this successful transition returns CleanStop. Drop attempts a clean close only when state is unpoisoned and teardown is complete; otherwise it leaves Running. A crash after Clean cannot leave usable sessions because revocation precedes that commit.
4. **Crash/ambiguity:** seeing Running, malformed/truncated data, missing files or an unknown transaction does not silently restore known devices or reset to empty. Return Quarantined with redacted diagnostics; no HELLO, pairing, ACCEPT or registry establishment. Initial version has no automatic replay/recovery. Owner-directed recovery is a separate consuming `Quarantine::reset_synthetic` proposal: create fresh synthetic identity/token, advance identity generation, retain tombstones/epochs, disable all old active records, and commit a new Clean snapshot. It never restores old approvals or unacknowledged enrollments. If the snapshot cannot be validated enough to preserve history, refuse reset and require creation of a completely new synthetic capability. This reset requires explicit owner intent, never a carrier command.
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
- Writer exclusion: two independent worker processes, inherited-descriptor trap, lock release on kill, rejected lock replacement/symlink/hardlink/permission changes, root rename/substitution, bounded cleanup, no access outside the fresh capability.
- Fault injection at create/write/file-sync/rename/directory-sync and every Running/Clean/removal/retirement boundary. Kill a worker after runtime revocation but before tombstone commit; the successor must quarantine, never admit the old key. No ACCEPT before commit; failed writers cannot clean themselves on drop.
- Strict decode and bounds: duplicate fields/keys, unknown versions, noncanonical keys, truncated/oversized snapshots, impossible epoch/generation state and counter overflow. More than 64 distinct removals do not retire the service; at 4,096 history slots known reconnects and removal still work while unseen enrollment fails.
- Existing 128 tests, six doctests and six Node checks remain required. Add synthetic fixtures from actual Node device serialization/pairing predicates only; never load the service startup graph or existing profile. Production migration, broker-loss recovery and mobile interoperability remain explicitly untested.

## Parent decision requested

Agree to this separate capability and conservative quarantine-on-unclean-run contract before implementation. In particular, the first checkpoint supports clean authority-worker replacement under a surviving synthetic broker; it does not automatically recover an arbitrary crashed production owner. After agreement: implement bounded descriptor store and restart authority first, then propose supervisor wiring with separate CloseForRestart and RetireIdentity owner actions.
