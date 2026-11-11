use super::*;
use serde_json::json;
pub(super) static SERIAL: Mutex<()> = Mutex::new(());
const START: i64 = 1_767_607_200_000;
fn spec() -> Value {
    json!({"name":"check","prompt":"look","trigger":{"kind":"schedule","cron":"0 * * * *","timezone":"UTC"},"target":{"kind":"new-chat","projectPath":"/synthetic","workspace":"project"},"createdBy":{"kind":"user"}})
}
pub(super) fn setup() -> (Copy, Writer) {
    let copy = Copy::create(None, START).unwrap();
    let mut writer = copy.open(START).unwrap();
    writer
        .execute("create", &[spec()], START, super::super::Fault::None)
        .unwrap();
    (copy, writer)
}
pub(super) fn actual(copy: &Copy) -> Vec<u8> {
    let root = copy.0.data.lock().unwrap();
    let data = root.as_ref().unwrap();
    let file = io::open_at(data.dir().unwrap(), FILE, libc::O_RDONLY, 0).unwrap();
    io::bytes(&file, LIMIT).unwrap()
}
pub(super) fn due(writer: &Writer) -> i64 {
    writer.diagnostic()["list"][0]["nextRunAt"]
        .as_i64()
        .unwrap()
}
fn finish(copy: Copy, mut writer: Writer) {
    writer.close().unwrap();
    drop(writer);
    copy.destroy().unwrap();
}
pub(super) fn both_busy(copy: &Copy) -> bool {
    locks_busy(copy) == (true, true)
}
pub(super) fn locks_busy(copy: &Copy) -> (bool, bool) {
    let root = copy.0.data.lock().unwrap();
    let data = root.as_ref().unwrap();
    let directory = io::open_at(
        &data.parent,
        &data.name,
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .unwrap();
    let file = io::open_at(data.dir().unwrap(), LOCK, libc::O_RDWR, 0).unwrap();
    (
        matches!(io::lock(&directory), Err(Error::Busy)),
        matches!(io::lock(&file), Err(Error::Busy)),
    )
}
fn rename(dir: &File, from: &str, to: &str) {
    let from = io::name(from).unwrap();
    let to = io::name(to).unwrap();
    assert_eq!(
        unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) },
        0
    );
}

#[test]
fn native_publication_pins_actual_bytes_and_excludes_independent_writers() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    assert!(both_busy(&copy));
    assert!(matches!(copy.open(START), Err(Error::Busy)));
    assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
    let before = writer.observe(Ok(Value::Null)).unwrap();
    assert_eq!(actual(&copy), before["file"].as_str().unwrap().as_bytes());
    let at = due(&writer);
    let result = writer
        .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
        .unwrap();
    assert_eq!(result[0]["run"]["id"], "id2");
    assert_eq!(writer.diagnostic()["saves"], 2);
    assert_eq!(
        serde_json::from_slice::<Value>(&actual(&copy)).unwrap()["runs"]["id1"][0]["status"],
        "running"
    );
    finish(copy, writer);
}

#[test]
fn pre_rename_io_failures_and_caught_panics_preserve_old_file_and_ids() {
    let _serial = SERIAL.lock().unwrap();
    for point in [
        Point::Stage,
        Point::PartialWrite,
        Point::FileSync,
        Point::BeforeRename,
        Point::Rename,
    ] {
        for fault in [Fault::Io(point), Fault::Panic(point)] {
            let (copy, mut writer) = setup();
            let bytes = actual(&copy);
            let before = writer.diagnostic();
            let at = due(&writer);
            assert!(matches!(
                writer.execute_fault("claimDue", &[json!(at)], at, fault),
                Err(Error::Io)
            ));
            assert_eq!(actual(&copy), bytes);
            let after = writer.diagnostic();
            for key in ["file", "list", "views", "saves", "runningCount"] {
                assert_eq!(after[key], before[key], "{point:?}/{key}");
            }
            assert_eq!(after["idCalls"], 2);
            assert_eq!(after["effects"], json!([]));
            assert!(both_busy(&copy));
            assert_eq!(
                copy.0
                    .data
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .stage_count()
                    .unwrap(),
                0
            );
            assert_eq!(
                writer
                    .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
                    .unwrap()[0]["run"]["id"],
                "id3"
            );
            finish(copy, writer);
        }
    }
}

#[test]
fn post_rename_io_and_panics_never_publish_claims_and_close_only_reconciles() {
    let _serial = SERIAL.lock().unwrap();
    for point in [Point::DirectorySync, Point::FinalVerify] {
        for fault in [Fault::Io(point), Fault::Panic(point)] {
            let (copy, mut writer) = setup();
            let old = writer.diagnostic();
            let at = due(&writer);
            assert!(matches!(
                writer.execute_fault("claimDue", &[json!(at)], at, fault),
                Err(Error::Uncertain)
            ));
            let disk: Value = serde_json::from_slice(&actual(&copy)).unwrap();
            assert_eq!(disk["runs"]["id1"][0]["status"], "running");
            assert_eq!(writer.diagnostic()["file"], old["file"]);
            assert_eq!(writer.diagnostic()["saves"], old["saves"]);
            assert_eq!(writer.diagnostic()["effects"], json!([]));
            for op in ["list", "reload", "claimDue"] {
                assert!(matches!(
                    writer.execute(op, &[json!(at)], at, super::super::Fault::None),
                    Err(Error::Uncertain)
                ));
            }
            assert!(writer.observe(Ok(Value::Null)).is_err());
            assert!(both_busy(&copy));
            writer.close().unwrap();
            assert_eq!(writer.diagnostic()["file"], old["file"]);
            drop(writer);
            let mut reopened = copy.open(at).unwrap();
            reopened
                .execute("recoverInterrupted", &[], at, super::super::Fault::None)
                .unwrap();
            assert_eq!(reopened.diagnostic()["runningCount"], 0);
            assert_eq!(
                reopened
                    .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
                    .unwrap(),
                json!([])
            );
            let bytes = actual(&copy);
            reopened
                .execute("recoverInterrupted", &[], at, super::super::Fault::None)
                .unwrap();
            assert_eq!(actual(&copy), bytes);
            finish(copy, reopened);
        }
    }
}

#[test]
fn uncertain_cleanup_and_last_writer_drop_retain_locks_and_capacity() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let at = due(&writer);
    assert!(matches!(
        writer.execute_fault(
            "claimDue",
            &[json!(at)],
            at,
            Fault::IoAndCleanup(Point::PartialWrite)
        ),
        Err(Error::Uncertain)
    ));
    drop(writer);
    assert!(both_busy(&copy));
    assert!(matches!(copy.open(at), Err(Error::Busy)));
    assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
    drop(copy);
    Copy::cleanup_retained().unwrap();
    Copy::create(None, START).unwrap().destroy().unwrap();
}

#[test]
fn partial_construction_errors_panics_and_cleanup_uncertainty_own_every_resource() {
    let _serial = SERIAL.lock().unwrap();
    let seed = Some("{\"version\":1,\"routines\":[],\"runs\":{}}".to_owned());
    for point in [Point::Child, Point::Marker, Point::Lock, Point::Seed] {
        for fault in [Fault::Io(point), Fault::Panic(point)] {
            assert!(matches!(
                Copy::create_fault(seed.clone(), START, fault),
                Err(Error::Io)
            ));
            Copy::create(None, START).unwrap().destroy().unwrap();
        }
        assert!(matches!(
            Copy::create_fault(seed.clone(), START, Fault::IoAndCleanup(point)),
            Err(Error::Uncertain)
        ));
        assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
        let locks = owner::retained_blocks_writers();
        assert!(locks.0);
        if matches!(point, Point::Lock | Point::Seed) {
            assert_eq!(locks.1, Some(true));
        }
        Copy::cleanup_retained().unwrap();
    }
}

#[test]
fn closed_copy_and_last_copy_drop_keep_slot_until_checked_destruction() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    writer.close().unwrap();
    drop(writer);
    assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
    drop(copy);
    assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
    Copy::cleanup_retained().unwrap();
    Copy::create(None, START).unwrap().destroy().unwrap();
}

#[test]
fn replacement_stage_sentinel_survives_failed_close_and_drop() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let at = due(&writer);
    assert!(writer
        .execute_fault(
            "claimDue",
            &[json!(at)],
            at,
            Fault::IoAndCleanup(Point::PartialWrite)
        )
        .is_err());
    let (name, sentinel) = {
        let root = copy.0.data.lock().unwrap();
        let data = root.as_ref().unwrap();
        let dir = data.dir().unwrap();
        let name = io::entries(dir)
            .unwrap()
            .into_iter()
            .find(|s| s.ends_with(".tmp"))
            .unwrap();
        rename(dir, &name, "saved-stage");
        let mut sentinel = io::open_at(
            dir,
            &name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .unwrap();
        sentinel.write_all(b"sentinel").unwrap();
        (name, sentinel)
    };
    assert!(writer.close().is_err());
    assert_eq!(io::bytes(&sentinel, 32).unwrap(), b"sentinel");
    assert!(both_busy(&copy));
    {
        let root = copy.0.data.lock().unwrap();
        let dir = root.as_ref().unwrap().dir().unwrap();
        io::unlink_owned(dir, &name, &sentinel).unwrap();
        rename(dir, "saved-stage", &name);
    }
    finish(copy, writer);
}

#[test]
fn same_byte_canonical_replacement_is_fenced_without_deleting_the_replacement() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let bytes = actual(&copy);
    let replacement = {
        let root = copy.0.data.lock().unwrap();
        let dir = root.as_ref().unwrap().dir().unwrap();
        rename(dir, FILE, "saved-canonical");
        let mut file = io::open_at(
            dir,
            FILE,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .unwrap();
        file.write_all(&bytes).unwrap();
        file
    };
    assert!(matches!(
        writer.execute("list", &[], START, super::super::Fault::None),
        Err(Error::Uncertain)
    ));
    assert!(writer.close().is_err());
    assert_eq!(io::bytes(&replacement, LIMIT).unwrap(), bytes);
    assert!(both_busy(&copy));
    {
        let root = copy.0.data.lock().unwrap();
        let dir = root.as_ref().unwrap().dir().unwrap();
        io::unlink_owned(dir, FILE, &replacement).unwrap();
        rename(dir, "saved-canonical", FILE);
    }
    finish(copy, writer);
}

#[test]
fn fixed_seed_bytes_and_load_upkeep_remain_distinct() {
    let _serial = SERIAL.lock().unwrap();
    let missing = Copy::create(None, START).unwrap();
    let mut writer = missing.open(START).unwrap();
    assert_eq!(
        writer.observe(Ok(Value::Null)).unwrap()["file"],
        Value::Null
    );
    finish(missing, writer);
    let mut model = Model::open(None, START).unwrap();
    model
        .execute("create", &[spec()], START, super::super::Fault::None)
        .unwrap();
    model
        .execute(
            "complete",
            &[json!("id1"), json!("done")],
            START,
            super::super::Fault::None,
        )
        .unwrap();
    let seed = model.published.unwrap();
    let now = START + 31 * super::super::DAY;
    let copy = Copy::create(Some(seed.clone()), now).unwrap();
    let mut writer = copy.open(now).unwrap();
    let observed = writer.observe(Ok(Value::Null)).unwrap();
    assert_eq!(actual(&copy), seed.as_bytes());
    assert_eq!(observed["list"], json!([]));
    assert_eq!(observed["effects"][0]["kind"], "purged");
    assert_eq!(observed["saves"], 0);
    finish(copy, writer);
}

#[test]
fn read_observation_identity_error_fences_the_writer_after_restoration() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    {
        let mut root = copy.0.data.lock().unwrap();
        let data = root.as_mut().unwrap();
        let marker = data.marker.as_mut().unwrap();
        use std::io::{Seek, SeekFrom};
        marker.seek(SeekFrom::Start(0)).unwrap();
        marker.write_all(b"changed").unwrap();
    }
    assert!(writer.observe(Ok(Value::Null)).is_err());
    {
        let mut root = copy.0.data.lock().unwrap();
        let data = root.as_mut().unwrap();
        let marker = data.marker.as_mut().unwrap();
        use std::io::{Seek, SeekFrom};
        marker.seek(SeekFrom::Start(0)).unwrap();
        marker.write_all(&data.token).unwrap();
    }
    assert!(matches!(
        writer.execute("list", &[], START, super::super::Fault::None),
        Err(Error::Uncertain)
    ));
    finish(copy, writer);
}

#[test]
fn mode_link_count_bytes_and_lock_token_changes_refuse_without_repair() {
    let _serial = SERIAL.lock().unwrap();
    for change in ["root-mode", "file-mode", "hardlink", "bytes", "lock-token"] {
        let (copy, mut writer) = setup();
        let bytes = actual(&copy);
        {
            let mut root = copy.0.data.lock().unwrap();
            let data = root.as_mut().unwrap();
            match change {
                "root-mode" => {
                    assert_eq!(
                        unsafe { libc::fchmod(data.dir().unwrap().as_raw_fd(), 0o500) },
                        0
                    );
                }
                "file-mode" => {
                    assert_eq!(
                        unsafe {
                            libc::fchmod(data.canonical.as_ref().unwrap().file.as_raw_fd(), 0o400)
                        },
                        0
                    );
                }
                "hardlink" => {
                    assert_eq!(
                        unsafe {
                            libc::linkat(
                                data.dir().unwrap().as_raw_fd(),
                                c"routines.json".as_ptr(),
                                data.dir().unwrap().as_raw_fd(),
                                c"extra-link".as_ptr(),
                                0,
                            )
                        },
                        0
                    );
                }
                "bytes" | "lock-token" => {
                    let file = if change == "bytes" {
                        &mut data.canonical.as_mut().unwrap().file
                    } else {
                        data.lock.as_mut().unwrap()
                    };
                    use std::io::{Seek, SeekFrom};
                    file.seek(SeekFrom::Start(0)).unwrap();
                    file.write_all(b"changed").unwrap();
                }
                _ => unreachable!(),
            }
        }
        assert!(
            matches!(
                writer.execute("list", &[], START, super::super::Fault::None),
                Err(Error::Uncertain)
            ),
            "{change}"
        );
        assert!(writer.close().is_err(), "{change}");
        {
            let mut root = copy.0.data.lock().unwrap();
            let data = root.as_mut().unwrap();
            match change {
                "root-mode" => {
                    assert_eq!(
                        unsafe { libc::fchmod(data.dir().unwrap().as_raw_fd(), 0o700) },
                        0
                    );
                }
                "file-mode" => {
                    assert_eq!(
                        unsafe {
                            libc::fchmod(data.canonical.as_ref().unwrap().file.as_raw_fd(), 0o600)
                        },
                        0
                    );
                }
                "hardlink" => {
                    assert_eq!(
                        unsafe {
                            libc::unlinkat(
                                data.dir().unwrap().as_raw_fd(),
                                c"extra-link".as_ptr(),
                                0,
                            )
                        },
                        0
                    );
                }
                "bytes" | "lock-token" => {
                    let (file, original) = if change == "bytes" {
                        (&mut data.canonical.as_mut().unwrap().file, bytes.as_slice())
                    } else {
                        (data.lock.as_mut().unwrap(), data.token.as_slice())
                    };
                    use std::io::{Seek, SeekFrom};
                    file.seek(SeekFrom::Start(0)).unwrap();
                    file.write_all(original).unwrap();
                }
                _ => unreachable!(),
            }
        }
        finish(copy, writer);
    }
}

#[test]
fn root_rename_and_symlink_do_not_redirect_cleanup() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let backup = {
        let root = copy.0.data.lock().unwrap();
        let data = root.as_ref().unwrap();
        let backup = format!("{}-saved", data.name);
        rename(&data.parent, &data.name, &backup);
        let target = io::name(&backup).unwrap();
        let name = io::name(&data.name).unwrap();
        assert_eq!(
            unsafe { libc::symlinkat(target.as_ptr(), data.parent.as_raw_fd(), name.as_ptr()) },
            0
        );
        backup
    };
    assert!(matches!(
        writer.execute("list", &[], START, super::super::Fault::None),
        Err(Error::Uncertain)
    ));
    assert!(writer.close().is_err());
    {
        let root = copy.0.data.lock().unwrap();
        let data = root.as_ref().unwrap();
        let name = io::name(&data.name).unwrap();
        assert_eq!(
            unsafe { libc::unlinkat(data.parent.as_raw_fd(), name.as_ptr(), 0) },
            0
        );
        rename(&data.parent, &backup, &data.name);
    }
    finish(copy, writer);
}

#[test]
fn canonical_and_lock_symlinks_never_become_owned_entries() {
    let _serial = SERIAL.lock().unwrap();
    for name in [FILE, LOCK] {
        let (copy, mut writer) = setup();
        {
            let root = copy.0.data.lock().unwrap();
            let dir = root.as_ref().unwrap().dir().unwrap();
            rename(dir, name, "saved-file");
            let part = io::name(name).unwrap();
            assert_eq!(
                unsafe { libc::symlinkat(c"saved-file".as_ptr(), dir.as_raw_fd(), part.as_ptr()) },
                0
            );
        }
        assert!(matches!(
            writer.execute("list", &[], START, super::super::Fault::None),
            Err(Error::Uncertain)
        ));
        assert!(copy.open(START).is_err());
        assert!(writer.close().is_err());
        {
            let root = copy.0.data.lock().unwrap();
            let dir = root.as_ref().unwrap().dir().unwrap();
            let part = io::name(name).unwrap();
            assert_eq!(
                unsafe { libc::unlinkat(dir.as_raw_fd(), part.as_ptr(), 0) },
                0
            );
            rename(dir, "saved-file", name);
        }
        finish(copy, writer);
    }
}

#[test]
fn bounded_orphans_are_preserved_and_never_adopted_or_swept() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let old = actual(&copy);
    let mut orphans = Vec::new();
    {
        let root = copy.0.data.lock().unwrap();
        let dir = root.as_ref().unwrap().dir().unwrap();
        for _ in 0..8 {
            let name = format!(".routines-{}.tmp", uuid::Uuid::new_v4());
            let mut file = io::open_at(
                dir,
                &name,
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
            .unwrap();
            file.write_all(b"opaque orphan, never a candidate").unwrap();
            orphans.push((name, file));
        }
    }
    assert!(matches!(
        writer.execute("create", &[spec()], START, super::super::Fault::None),
        Err(Error::Capacity)
    ));
    assert_eq!(actual(&copy), old);
    assert_eq!(
        copy.0
            .data
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .stage_count()
            .unwrap(),
        8
    );
    {
        let root = copy.0.data.lock().unwrap();
        let dir = root.as_ref().unwrap().dir().unwrap();
        for (name, file) in orphans {
            assert_eq!(
                io::bytes(&file, LIMIT).unwrap(),
                b"opaque orphan, never a candidate"
            );
            io::unlink_owned(dir, &name, &file).unwrap();
        }
    }
    finish(copy, writer);
}

#[test]
fn copy_destruction_failure_retains_both_locks_and_never_sweeps_foreign_content() {
    let _serial = SERIAL.lock().unwrap();
    let copy = Copy::create(None, START).unwrap();
    let (dir, sentinel) = {
        let root = copy.0.data.lock().unwrap();
        let data = root.as_ref().unwrap();
        let dir = data.dir().unwrap().try_clone().unwrap();
        let mut sentinel = io::open_at(
            &dir,
            "foreign",
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .unwrap();
        sentinel.write_all(b"preserve me").unwrap();
        (dir, sentinel)
    };
    assert!(matches!(copy.destroy(), Err(Error::Uncertain)));
    assert_eq!(owner::retained_blocks_writers(), (true, Some(true)));
    assert_eq!(io::bytes(&sentinel, 32).unwrap(), b"preserve me");
    assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
    io::unlink_owned(&dir, "foreign", &sentinel).unwrap();
    drop(sentinel);
    drop(dir);
    Copy::cleanup_retained().unwrap();
}

#[test]
fn invalid_and_oversized_seed_admission_never_creates_a_writable_copy() {
    let _serial = SERIAL.lock().unwrap();
    for seed in [
        "broken".to_owned(),
        "x".repeat(LIMIT + 1),
        "{\"version\":2,\"routines\":[],\"runs\":{}}".to_owned(),
    ] {
        assert!(matches!(
            Copy::create(Some(seed), START),
            Err(Error::Model(super::super::Error::Refused(_)))
        ));
        Copy::create(None, START).unwrap().destroy().unwrap();
    }
}

#[test]
fn reviewed_ownership_source_inputs_are_pinned_without_refreshing_model_history() {
    use sha2::{Digest, Sha256};
    let plan = include_str!("../../../WRITER-PLAN.md")
        .split("## Audit source pins")
        .nth(1)
        .unwrap();
    let rows = plan
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let fields = line.split('`').collect::<Vec<_>>();
            (fields[1], fields[3])
        })
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(rows.len(), 10);
    for (path, body, expected) in [
        (
            "experiments/rust-accounts/src/store.rs",
            include_bytes!("../../../../rust-accounts/src/store.rs").as_slice(),
            "0a007fa1d12c91674a5dac8dda9b35f0db81a38f3a89fa0cfe3a4fb534ecb894",
        ),
        (
            "experiments/rust-accounts/src/service.rs",
            include_bytes!("../../../../rust-accounts/src/service.rs").as_slice(),
            "7727c2dbe77a02ade9e86b29e7a5e09c17fc2e666656a56e5b442dd59898e2f8",
        ),
        (
            "experiments/rust-accounts/src/recovery_tests.rs",
            include_bytes!("../../../../rust-accounts/src/recovery_tests.rs").as_slice(),
            "1df044ab1fa290028bd89077ba495d9bf359a6f6e65bdbd6a3d7fce78c392a0d",
        ),
        (
            "experiments/rust-registry/src/writer/storage.rs",
            include_bytes!("../../../../rust-registry/src/writer/storage.rs").as_slice(),
            "96c8d4a5c78cd115ae87972c27e41ccc29bb3db2bdfc085af24fb8f1e622903a",
        ),
        (
            "experiments/rust-registry/src/writer/mod.rs",
            include_bytes!("../../../../rust-registry/src/writer/mod.rs").as_slice(),
            "6414b6ef0802101d833610247e9f2d7f8f595ab0d792eb2a4aae03fd84138dc6",
        ),
        (
            "experiments/rust-owner/src/isolation.rs",
            include_bytes!("../../../../rust-owner/src/isolation.rs").as_slice(),
            "00a1c891e3696573dd8ed57db4cb9899f8d962dfda924d31202f9e4c0551e8a4",
        ),
    ] {
        assert_eq!(format!("{:x}", Sha256::digest(body)), expected);
        assert_eq!(rows[path], expected);
    }
    let manifest: Value =
        serde_json::from_str(include_str!("../../../store-oracle-manifest.json")).unwrap();
    for path in [
        "packages/core/src/routines/store.cjs",
        "packages/core/src/routines/store.test.cjs",
        "packages/core/src/runtime.cjs",
    ] {
        assert_eq!(manifest["sources"][path].as_str().unwrap(), rows[path]);
    }
    // Historical accepted input, not a claim about today's changed Model source.
    assert_eq!(
        rows["experiments/rust-routines/src/store/mod.rs"],
        "8bbb422060095a5370b8f728bf15d479fe4b42a551ccd1bc1dbaa272be91db8b"
    );
}

#[test]
fn post_rename_drop_parks_exact_candidate_until_retained_close_only_cleanup() {
    let _serial = SERIAL.lock().unwrap();
    for fault in [
        Fault::Io(Point::DirectorySync),
        Fault::Panic(Point::FinalVerify),
    ] {
        for retain_copy in [false, true] {
            let (copy, mut writer) = setup();
            let at = due(&writer);
            let before = writer.diagnostic();
            assert!(matches!(
                writer.execute_fault("claimDue", &[json!(at)], at, fault),
                Err(Error::Uncertain)
            ));
            let candidate = actual(&copy);
            let saved: Value = serde_json::from_slice(&candidate).unwrap();
            assert_eq!(saved["runs"]["id1"][0]["id"], "id2");
            assert_eq!(saved["runs"]["id1"][0]["status"], "running");
            assert_eq!(writer.diagnostic()["file"], before["file"]);
            assert_eq!(writer.diagnostic()["saves"], before["saves"]);
            assert_eq!(writer.diagnostic()["effects"], json!([]));
            drop(writer);
            assert!(both_busy(&copy));
            // The old copy baseline can refuse identity verification before flock;
            // both independent kernel locks and new-copy admission remain Busy.
            assert!(copy.open(at).is_err());
            assert!(matches!(Copy::create(None, START), Err(Error::Busy)));
            assert_eq!(actual(&copy), candidate);
            if retain_copy {
                // Cleanup closes the exact parked writer. The remaining copy handle
                // prevents destruction, so Busy here is not a mutation retry/result.
                assert!(matches!(Copy::cleanup_retained(), Err(Error::Busy)));
                assert_eq!(actual(&copy), candidate);
                let mut reopened = copy.open(at).unwrap();
                assert_eq!(
                    reopened
                        .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
                        .unwrap(),
                    json!([])
                );
                reopened
                    .execute("recoverInterrupted", &[], at, super::super::Fault::None)
                    .unwrap();
                let observed = reopened.diagnostic();
                assert_eq!(observed["runningCount"], 0);
                assert_eq!(observed["views"][0]["runs"][0]["id"], "id2");
                assert_eq!(observed["views"][0]["runs"][0]["status"], "failed");
                assert_eq!(
                    reopened
                        .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
                        .unwrap(),
                    json!([])
                );
                finish(copy, reopened);
            } else {
                drop(copy);
                Copy::cleanup_retained().unwrap();
                Copy::create(None, START).unwrap().destroy().unwrap();
            }
        }
    }
}

#[test]
fn same_inode_stage_byte_interference_fences_until_close_without_publication() {
    let _serial = SERIAL.lock().unwrap();
    let (copy, mut writer) = setup();
    let original = actual(&copy);
    let at = due(&writer);
    assert!(matches!(
        writer.execute_fault("claimDue", &[json!(at)], at, Fault::ChangeStageBytes),
        Err(Error::Uncertain)
    ));
    assert_eq!(actual(&copy), original);
    assert_eq!(writer.diagnostic()["runningCount"], 0);
    assert!(matches!(
        writer.execute("list", &[], START, super::super::Fault::None),
        Err(Error::Uncertain)
    ));
    assert!(both_busy(&copy));
    finish(copy, writer);
}
