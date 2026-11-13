//! Exec-only crash evidence. None of this transport/reconciliation exists in normal builds.
use super::*;
use owner::{Data, Locks, Pin};
use serde_json::json;
use std::{
    cell::RefCell,
    io::{Read, Write},
    os::unix::{
        net::UnixStream,
        process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const CHILD_TEST: &str = "store::copied::crash::exec_child";
const FRAME: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const POINTS: [&str; 6] = [
    "written",
    "file-synced",
    "before-rename",
    "renamed",
    "directory-synced",
    "before-install",
];
thread_local! { static CHANNEL: RefCell<Option<UnixStream>> = const { RefCell::new(None) }; }

fn send(stream: &mut UnixStream, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Io)?;
    if bytes.len() > FRAME {
        return Err(Error::Capacity);
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| Error::Io)?;
    stream.write_all(&bytes).map_err(|_| Error::Io)
}
fn receive(stream: &mut UnixStream) -> Result<Value> {
    let mut prefix = [0; 4];
    stream.read_exact(&mut prefix).map_err(|_| Error::Io)?;
    let size = u32::from_be_bytes(prefix) as usize;
    if size > FRAME {
        return Err(Error::Capacity);
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).map_err(|_| Error::Io)?;
    serde_json::from_slice(&bytes).map_err(|_| Error::Io)
}
fn configure(stream: &UnixStream) -> Result<()> {
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|_| Error::Io)?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|_| Error::Io)
}
pub(super) fn pause(fault: Fault, point: &str, stage: Option<&str>, model: &Model) -> Result<()> {
    if !matches!(
        fault,
        Fault::Crash | Fault::CrashIo(_) | Fault::CrashIoAndCleanup(_)
    ) {
        return Ok(());
    }
    let diagnostic = model.observe(Ok(Value::Null));
    CHANNEL.with_borrow_mut(|channel| {
        let channel = channel.as_mut().ok_or(Error::Closed)?;
        send(
            channel,
            &json!({"point":point,"stage":stage,"saves":diagnostic["saves"],
            "running":diagnostic["runningCount"],"effects":diagnostic["effects"]}),
        )?;
        if receive(channel)? != json!("continue") {
            return Err(Error::Io);
        }
        Ok(())
    })
}

/// Owns the exact Child until reaped; a cached terminal status prevents later signals.
struct OwnedChild {
    child: Option<Child>,
    reaped: Option<ExitStatus>,
    signals: usize,
    lost: bool,
}
impl OwnedChild {
    fn stop(&mut self) -> Result<ExitStatus> {
        if let Some(status) = self.reaped {
            return Ok(status);
        }
        if self.lost {
            return Err(Error::Uncertain);
        }
        let child = self.child.as_mut().ok_or(Error::Uncertain)?;
        match child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = Some(status);
                self.child = None;
                return Ok(status);
            }
            Ok(None) => {}
            Err(_) => {
                self.lost = true;
                return Err(Error::Uncertain);
            }
        }
        // An unreaped exact child (including a zombie) keeps its PID reserved.
        child.kill().map_err(|_| Error::Uncertain)?;
        self.signals += 1;
        let until = Instant::now() + TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.reaped = Some(status);
                    self.child = None;
                    return Ok(status);
                }
                Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(5)),
                Ok(None) => return Err(Error::Uncertain),
                Err(_) => {
                    self.lost = true;
                    return Err(Error::Uncertain);
                }
            }
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct Captured {
    name: String,
    file: File,
    bytes: Arc<[u8]>,
}
struct Admission(Option<Copy>);
impl Drop for Admission {
    fn drop(&mut self) {
        if let Some(copy) = self.0.take() {
            if copy.destroy().is_err() {
                eprintln!("crash fixture admission cleanup retained its exact owner");
            }
        }
    }
}
/// A test parent retains its capability and exact candidate evidence before letting rename run.
struct FlightState {
    copy: Option<Copy>,
    destroying: Option<u64>,
    child: OwnedChild,
    channel: UnixStream,
    captured: Option<Captured>,
    expected: Arc<[u8]>,
    at: i64,
}
static RETAINED_FLIGHT: Mutex<Option<Box<FlightState>>> = Mutex::new(None);
struct Flight {
    state: Option<Box<FlightState>>,
}
impl std::ops::Deref for Flight {
    type Target = FlightState;
    fn deref(&self) -> &Self::Target {
        self.state.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for Flight {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.state.as_mut().unwrap()
    }
}
impl Flight {
    fn start(poison: bool) -> Result<Self> {
        Self::scenario(if poison { "poison" } else { "crash" })
    }
    fn scenario(scenario: &str) -> Result<Self> {
        let (copy, mut writer) = tests::setup();
        let mut admission = Admission(Some(copy));
        let copy = admission.0.as_ref().unwrap();
        let at = tests::due(&writer);
        writer.close()?;
        drop(writer);
        let (channel, child_channel) = UnixStream::pair().map_err(|_| Error::Io)?;
        configure(&channel)?;
        let (descriptors, header, expected) = {
            let root = copy.0.data.lock().map_err(|_| Error::Uncertain)?;
            let data = root.as_ref().ok_or(Error::Closed)?;
            data.verify()?;
            let canonical = data.canonical.as_ref().ok_or(Error::Ownership)?;
            let source =
                String::from_utf8(canonical.bytes.to_vec()).map_err(|_| Error::Ownership)?;
            let mut model = Model::open(Some(source), at)?;
            let stamp = model.prepare("claimDue", &[json!(at)], at)?;
            let expected: Arc<[u8]> =
                Arc::from(model.pending_image(stamp)?.ok_or(Error::Io)?.as_bytes());
            let sources = [
                &data.parent,
                data.dir()?,
                data.marker.as_ref().unwrap(),
                data.lock.as_ref().unwrap(),
                &canonical.file,
            ];
            // High temporary descriptors avoid dup2 collisions with fixed inherited slots.
            let mut descriptors = Vec::new();
            for fd in sources
                .iter()
                .map(|file| file.as_raw_fd())
                .chain([child_channel.as_raw_fd()])
            {
                let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 220) };
                if duplicate < 0 {
                    return Err(Error::Io);
                }
                descriptors.push(unsafe { File::from_raw_fd(duplicate) });
            }
            let token = std::str::from_utf8(&data.token).map_err(|_| Error::Ownership)?;
            (
                descriptors,
                json!({"name":data.name,"token":token,"at":at,"scenario":scenario}),
                expected,
            )
        };
        let numbers: Vec<_> = descriptors.iter().map(AsRawFd::as_raw_fd).collect();
        let mut command = Command::new(std::env::current_exe().map_err(|_| Error::Io)?);
        command
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        // SAFETY: only dup2 runs between fork and exec; source FDs remain owned until spawn returns.
        unsafe {
            command.pre_exec(move || {
                for (i, fd) in numbers.iter().enumerate() {
                    if libc::dup2(*fd, 198 + i as i32) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(|_| Error::Io)?;
        let mut flight = Self {
            state: Some(Box::new(FlightState {
                copy: admission.0.take(),
                destroying: None,
                child: OwnedChild {
                    child: Some(child),
                    reaped: None,
                    signals: 0,
                    lost: false,
                },
                channel,
                captured: None,
                expected,
                at,
            })),
        };
        drop(descriptors);
        drop(child_channel);
        send(&mut flight.channel, &header)?;
        // The first barrier is before any rename and grants no authority to change bytes.
        if scenario != "poison" {
            let event = receive(&mut flight.channel)?;
            flight.capture(&event)?;
            flight.check_observation(&event)?;
        }
        Ok(flight)
    }
    fn copy(&self) -> &Copy {
        self.copy.as_ref().unwrap()
    }
    fn capture(&mut self, event: &Value) -> Result<()> {
        if event["point"] != "written" {
            return Err(Error::Uncertain);
        }
        let name = event["stage"].as_str().ok_or(Error::Uncertain)?.to_owned();
        let token = name
            .strip_prefix(".routines-")
            .and_then(|name| name.strip_suffix(".tmp"))
            .ok_or(Error::Ownership)?;
        if uuid::Uuid::parse_str(token)
            .map_err(|_| Error::Ownership)?
            .to_string()
            != token
        {
            return Err(Error::Ownership);
        }
        let root = self.copy().0.data.lock().map_err(|_| Error::Uncertain)?;
        let data = root.as_ref().ok_or(Error::Closed)?;
        data.verify()?;
        if data.stage_count()? != 1 {
            return Err(Error::Uncertain);
        }
        let file = io::open_at(data.dir()?, &name, libc::O_RDONLY, 0)?;
        io::pin_at(data.dir()?, &name, &file, false)?;
        let bytes = io::bytes(&file, LIMIT)?;
        // Capture ownership before any semantic assertion can fail in a mutant.
        drop(root);
        self.captured = Some(Captured {
            name,
            file,
            bytes: Arc::from(bytes),
        });
        if self.captured.as_ref().unwrap().bytes != self.expected {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    fn check_observation(&self, event: &Value) -> Result<()> {
        if event["saves"] != 0 || event["running"] != 0 || event["effects"] != json!([]) {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    fn reach(&mut self, target: &str) -> Result<()> {
        for point in POINTS.into_iter().skip(1) {
            if target == "written" {
                break;
            }
            send(&mut self.channel, &json!("continue"))?;
            let event = receive(&mut self.channel)?;
            if event["point"] != point {
                return Err(Error::Uncertain);
            }
            self.check_observation(&event)?;
            if target == point {
                return Ok(());
            }
        }
        if target == "written" {
            Ok(())
        } else {
            Err(Error::Uncertain)
        }
    }
    fn killed(&mut self) -> Result<()> {
        if self.child.stop()?.signal() != Some(libc::SIGKILL) {
            return Err(Error::Uncertain);
        }
        let signals = self.child.signals;
        self.child.stop()?;
        if self.child.signals != signals {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    /// No caller boolean establishes exit or publication. The retained exact Child and
    /// pre-rename FD are the only inputs. Locks cover all checks and canonical-pin update.
    fn reconcile(&mut self) -> Result<bool> {
        if self.child.reaped.is_none() || self.child.child.is_some() || self.child.lost {
            return Err(Error::Uncertain);
        }
        let mut root = self.copy().0.data.lock().map_err(|_| Error::Uncertain)?;
        let data = root.as_mut().ok_or(Error::Closed)?;
        data.base()?;
        let locks = fresh_locks(data)?;
        verify_markers(data)?;
        data.stage_count()?;
        let current = io::open_at(data.dir()?, FILE, libc::O_RDONLY, 0)?;
        let old = data.canonical.as_ref().ok_or(Error::Ownership)?;
        let replacement = !io::same(&current, &old.file)?;
        if replacement {
            let captured = self.captured.as_ref().ok_or(Error::Uncertain)?;
            io::pin_at(data.dir()?, FILE, &captured.file, false)?;
            if io::bytes(&captured.file, LIMIT)?.as_slice() != captured.bytes.as_ref()
                || captured.bytes != self.expected
            {
                return Err(Error::Ownership);
            }
            if !io::absent(data.dir()?, &captured.name)? {
                return Err(Error::Ownership);
            }
            io::sync(data.dir()?)?;
            data.canonical = Some(Pin {
                file: captured.file.try_clone().map_err(|_| Error::Io)?,
                bytes: captured.bytes.clone(),
            });
        }
        data.verify()?;
        drop(locks);
        Ok(replacement)
    }
    fn cleanup(&mut self) -> Result<()> {
        self.child.stop()?;
        if let Some(id) = self.destroying {
            if owner::retained_copy_id() != Some(id) {
                return Err(Error::Uncertain);
            }
            Copy::cleanup_retained()?;
            self.destroying = None;
            return Ok(());
        }
        self.reconcile()?;
        if let Some(captured) = &self.captured {
            let root = self.copy().0.data.lock().map_err(|_| Error::Uncertain)?;
            let data = root.as_ref().ok_or(Error::Closed)?;
            let _locks = data.acquire()?;
            if !io::absent(data.dir()?, &captured.name)? {
                io::unlink_owned(data.dir()?, &captured.name, &captured.file)?;
                io::sync(data.dir()?)?;
            }
        }
        self.destroying = Some(self.copy().0.id);
        self.copy.take().ok_or(Error::Closed)?.destroy()?;
        self.destroying = None;
        Ok(())
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        if (self.copy.is_some() || self.destroying.is_some()) && self.cleanup().is_err() {
            let state = self.state.take().unwrap();
            let mut slot = RETAINED_FLIGHT
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if slot.is_none() {
                *slot = Some(state);
            } else {
                std::mem::forget(state);
            }
            eprintln!("retained entire crash fixture owner after uncertain cleanup/reap");
        }
    }
}
fn cleanup_retained_flight() -> Result<()> {
    let state = RETAINED_FLIGHT
        .lock()
        .map_err(|_| Error::Uncertain)?
        .take()
        .ok_or(Error::Closed)?;
    let mut flight = Flight { state: Some(state) };
    flight.cleanup()
}
fn fresh_locks(data: &Data) -> Result<Locks> {
    let directory = io::open_at(
        &data.parent,
        &data.name,
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    io::lock(&directory)?;
    io::pin_at(&data.parent, &data.name, &directory, true)?;
    if !io::same(&directory, data.dir()?)? {
        return Err(Error::Ownership);
    }
    let file = io::open_at(data.dir()?, LOCK, libc::O_RDWR, 0)?;
    io::lock(&file)?;
    if !io::same(&file, data.lock.as_ref().ok_or(Error::Ownership)?)? {
        return Err(Error::Ownership);
    }
    Ok(Locks { directory, file })
}
fn verify_markers(data: &Data) -> Result<()> {
    for (name, file) in [(MARKER, &data.marker), (LOCK, &data.lock)] {
        let file = file.as_ref().ok_or(Error::Ownership)?;
        io::pin_at(data.dir()?, name, file, false)?;
        if io::bytes(file, 128)? != data.token {
            return Err(Error::Ownership);
        }
    }
    Ok(())
}

#[test]
#[ignore = "exec-only child: requires inherited descriptors from its owning test parent"]
fn exec_child() {
    // SAFETY: only the parent exec protocol reserves fd 203 for this connected socket.
    let mut channel = unsafe { UnixStream::from_raw_fd(203) };
    configure(&channel).unwrap();
    let header = receive(&mut channel).unwrap();
    let copy = Copy::inherited(
        header["name"].as_str().unwrap().to_owned(),
        header["token"].as_str().unwrap().as_bytes().to_vec(),
    )
    .unwrap();
    let at = header["at"].as_i64().unwrap();
    let mut writer = copy.open(at).unwrap();
    if header["scenario"] == "poison" {
        let copy_for_poison = copy.clone();
        let panic = std::panic::catch_unwind(|| {
            let _held = copy_for_poison.0.data.lock().unwrap();
            panic!("private crash fixture poisons its owned writer mutex");
        });
        assert!(panic.is_err());
        for _ in 0..2 {
            assert!(copy.open(at).is_err());
            assert!(writer
                .execute("claimDue", &[json!(at)], at, super::super::Fault::None)
                .is_err());
            assert!(writer.close().is_err());
        }
        drop(writer);
        for _ in 0..2 {
            assert!(Copy::cleanup_retained().is_err());
        }
        assert!(matches!(Copy::create(None, at), Err(Error::Busy)));
        send(&mut channel, &json!({"point":"poison-refused"})).unwrap();
        let _ = receive(&mut channel);
        panic!("poison child must be killed by its exact parent");
    }
    CHANNEL.with_borrow_mut(|slot| *slot = Some(channel));
    if header["scenario"] != "crash" {
        let fault = match header["scenario"].as_str().unwrap() {
            "pre-refusal" => Fault::CrashIo(Point::BeforeRename),
            "post-refusal" => Fault::CrashIo(Point::DirectorySync),
            "cleanup-refusal" | "replacement" => Fault::CrashIoAndCleanup(Point::BeforeRename),
            _ => panic!("unknown closed native scenario"),
        };
        let result = writer.execute_fault("claimDue", &[json!(at)], at, fault);
        let class = match result {
            Err(Error::Io) => "io",
            Err(Error::Uncertain) => "uncertain",
            Ok(_) => "published",
            Err(_) => "other",
        };
        let diagnostic = writer.diagnostic();
        CHANNEL.with_borrow_mut(|slot| send(slot.as_mut().unwrap(), &json!({"point":"outcome", "class":class,
            "saves":diagnostic["saves"],"running":diagnostic["runningCount"],"effects":diagnostic["effects"]}))).unwrap();
        let command = CHANNEL
            .with_borrow_mut(|slot| receive(slot.as_mut().unwrap()))
            .unwrap();
        let closed = if command == "close" {
            writer.close().is_ok()
        } else {
            assert_eq!(command, "drop");
            drop(writer);
            false
        };
        CHANNEL.with_borrow_mut(|slot| {
            send(
                slot.as_mut().unwrap(),
                &json!({"point":"settled", "closed":closed}),
            )
            .unwrap();
            let _ = receive(slot.as_mut().unwrap());
        });
        panic!("fault child must be killed by its exact parent");
    }
    let result = writer
        .execute_fault("claimDue", &[json!(at)], at, Fault::Crash)
        .unwrap();
    CHANNEL
        .with_borrow_mut(|slot| send(slot.as_mut().unwrap(), &json!({"unexpectedResult":result})))
        .unwrap();
    panic!("crash child crossed every stopped publication barrier");
}

#[test]
fn killed_publication_barriers_reopen_only_the_retained_canonical_inode() {
    let _serial = tests::SERIAL.lock().unwrap();
    for (index, point) in POINTS.into_iter().enumerate() {
        let mut flight = Flight::start(false).unwrap();
        flight.reach(point).unwrap();
        assert!(tests::both_busy(flight.copy()));
        assert!(flight.copy().open(flight.at).is_err());
        assert!(flight.reconcile().is_err()); // A barrier report is not exit/cleanup proof.
        flight.killed().unwrap();
        assert_eq!(tests::locks_busy(flight.copy()), (false, false));
        let renamed = index >= 3;
        assert_eq!(flight.reconcile().unwrap(), renamed, "{point}");
        let bytes = tests::actual(flight.copy());
        let disk: Value = serde_json::from_slice(&bytes).unwrap();
        if renamed {
            assert_eq!(bytes.as_slice(), flight.expected.as_ref());
        } else {
            assert_eq!(disk["runs"]["id1"], Value::Null);
        }
        let stage_name = flight.captured.as_ref().unwrap().name.clone();
        let mut reopened = flight.copy().open(flight.at).unwrap();
        assert_eq!(
            reopened.diagnostic()["runningCount"],
            if renamed { 1 } else { 0 }
        );
        if renamed {
            assert_eq!(
                reopened
                    .execute(
                        "claimDue",
                        &[json!(flight.at)],
                        flight.at,
                        super::super::Fault::None
                    )
                    .unwrap(),
                json!([])
            );
            reopened
                .execute(
                    "recoverInterrupted",
                    &[],
                    flight.at,
                    super::super::Fault::None,
                )
                .unwrap();
            let recovered = tests::actual(flight.copy());
            let view: Value = serde_json::from_slice(&recovered).unwrap();
            assert_eq!(view["runs"]["id1"][0]["status"], "failed");
            reopened
                .execute(
                    "recoverInterrupted",
                    &[],
                    flight.at,
                    super::super::Fault::None,
                )
                .unwrap();
            assert_eq!(tests::actual(flight.copy()), recovered);
        } else {
            let root = flight.copy().0.data.lock().unwrap();
            let data = root.as_ref().unwrap();
            assert_eq!(data.stage_count().unwrap(), 1);
            io::pin_at(
                data.dir().unwrap(),
                &stage_name,
                &flight.captured.as_ref().unwrap().file,
                false,
            )
            .unwrap();
            drop(root);
            assert_eq!(
                reopened
                    .execute(
                        "claimDue",
                        &[json!(flight.at)],
                        flight.at,
                        super::super::Fault::None
                    )
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        reopened.close().unwrap();
        drop(reopened);
        // Reopened writes establish a new authoritative canonical pin; cleanup must
        // recognize it directly, not restore the earlier crashed candidate.
        flight.cleanup().unwrap();
        assert!(flight.copy.is_none());
        eprintln!("native crash barrier {point}: SIGKILL reaped, canonical verified, no replay, exact cleanup");
    }
}

#[test]
fn poisoned_writer_refuses_permanently_in_child_until_process_exit() {
    let _serial = tests::SERIAL.lock().unwrap();
    let mut flight = Flight::start(true).unwrap();
    assert_eq!(
        receive(&mut flight.channel).unwrap(),
        json!({"point":"poison-refused"})
    );
    assert!(tests::both_busy(flight.copy()));
    flight.killed().unwrap();
    assert!(!flight.reconcile().unwrap());
    let mut reopened = flight.copy().open(flight.at).unwrap();
    assert_eq!(reopened.diagnostic()["runningCount"], 0);
    reopened.close().unwrap();
    drop(reopened);
    flight.cleanup().unwrap();
}

fn outcome(flight: &mut Flight) -> Result<Value> {
    for _ in 0..6 {
        send(&mut flight.channel, &json!("continue"))?;
        let event = receive(&mut flight.channel)?;
        if event["point"] == "outcome" {
            return Ok(event);
        }
        flight.check_observation(&event)?;
    }
    Err(Error::Uncertain)
}
fn moved(dir: &File, from: &str, to: &str) -> Result<()> {
    let from = io::name(from)?;
    let to = io::name(to)?;
    if unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) } != 0
    {
        return Err(Error::Io);
    }
    Ok(())
}
fn stage_name() -> String {
    format!(".routines-{}.tmp", uuid::Uuid::new_v4())
}
fn new_file(dir: &File, name: &str, bytes: &[u8]) -> File {
    let mut file = io::open_at(
        dir,
        name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .unwrap();
    file.write_all(bytes).unwrap();
    io::sync(&file).unwrap();
    file
}

#[test]
fn native_fault_child_withholds_results_and_retains_uncertain_locks_after_drop() {
    let _serial = tests::SERIAL.lock().unwrap();
    for scenario in ["pre-refusal", "post-refusal", "cleanup-refusal"] {
        let mut flight = Flight::scenario(scenario).unwrap();
        let event = outcome(&mut flight).unwrap();
        let observed = flight.check_observation(&event).is_ok();
        let held_before_drop = tests::locks_busy(flight.copy());
        send(&mut flight.channel, &json!("drop")).unwrap();
        assert_eq!(receive(&mut flight.channel).unwrap()["point"], "settled");
        let held_after_drop = tests::locks_busy(flight.copy());
        flight.killed().unwrap();
        let renamed = flight.reconcile().unwrap();
        flight.cleanup().unwrap();
        assert!(
            observed,
            "{scenario} published a model/result before native success"
        );
        assert_eq!(
            held_before_drop,
            (true, true),
            "{scenario} lost active writer locks"
        );
        assert_eq!(
            event["class"],
            if scenario == "pre-refusal" {
                "io"
            } else {
                "uncertain"
            }
        );
        assert_eq!(
            held_after_drop,
            if scenario == "pre-refusal" {
                (false, false)
            } else {
                (true, true)
            },
            "{scenario}"
        );
        assert_eq!(renamed, scenario == "post-refusal");
    }
}

#[test]
fn child_close_preserves_replacement_stage_inode() {
    let _serial = tests::SERIAL.lock().unwrap();
    let mut flight = Flight::scenario("replacement").unwrap();
    let event = outcome(&mut flight).unwrap();
    assert_eq!(event["class"], "uncertain");
    let name = flight.captured.as_ref().unwrap().name.clone();
    let backup = stage_name();
    let dir = flight
        .copy()
        .0
        .data
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .dir()
        .unwrap()
        .try_clone()
        .unwrap();
    moved(&dir, &name, &backup).unwrap();
    let sentinel = new_file(&dir, &name, b"test-owned replacement must survive");
    send(&mut flight.channel, &json!("close")).unwrap();
    let settled = receive(&mut flight.channel).unwrap();
    let preserved = io::pin_at(&dir, &name, &sentinel, false).is_ok();
    let held = tests::both_busy(flight.copy());
    // Restore only this test's exact entries before asserting, so a killed mutant
    // cannot strand a copy by panicking ahead of teardown.
    if !io::absent(&dir, &name).unwrap() {
        io::unlink_owned(&dir, &name, &sentinel).unwrap();
    }
    moved(&dir, &backup, &name).unwrap();
    io::sync(&dir).unwrap();
    flight.killed().unwrap();
    flight.cleanup().unwrap();
    assert!(!settled["closed"].as_bool().unwrap());
    assert!(preserved, "replacement inode was deleted");
    assert!(held, "failed close released writer locks");
}

#[test]
fn replacement_canonical_refuses_reconciliation_without_adopting_equal_bytes() {
    let _serial = tests::SERIAL.lock().unwrap();
    let mut flight = Flight::start(false).unwrap();
    flight.reach("renamed").unwrap();
    flight.killed().unwrap();
    let name = flight.captured.as_ref().unwrap().name.clone();
    let dir = flight
        .copy()
        .0
        .data
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .dir()
        .unwrap()
        .try_clone()
        .unwrap();
    moved(&dir, FILE, &name).unwrap();
    let replacement = new_file(&dir, FILE, &flight.expected);
    let refused = flight.reconcile().is_err();
    let unchanged = io::pin_at(&dir, FILE, &replacement, false).is_ok();
    io::unlink_owned(&dir, FILE, &replacement).unwrap();
    moved(&dir, &name, FILE).unwrap();
    io::sync(&dir).unwrap();
    assert!(flight.reconcile().unwrap());
    flight.cleanup().unwrap();
    assert!(refused && unchanged);
}

#[test]
fn failed_crash_cleanup_parks_the_whole_exact_owner_until_restored() {
    let _serial = tests::SERIAL.lock().unwrap();
    let mut flight = Flight::start(false).unwrap();
    flight.killed().unwrap();
    let name = flight.captured.as_ref().unwrap().name.clone();
    let original = flight.captured.as_ref().unwrap().file.try_clone().unwrap();
    let backup = stage_name();
    let dir = flight
        .copy()
        .0
        .data
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .dir()
        .unwrap()
        .try_clone()
        .unwrap();
    moved(&dir, &name, &backup).unwrap();
    let sentinel = new_file(&dir, &name, b"retained replacement");
    drop(flight);
    let busy = matches!(Copy::create(None, 0), Err(Error::Busy));
    let refused = cleanup_retained_flight().is_err();
    let exact = {
        let slot = RETAINED_FLIGHT.lock().unwrap();
        let state = slot.as_ref().unwrap();
        state.child.reaped.is_some()
            && io::same(&state.captured.as_ref().unwrap().file, &original).unwrap()
    };
    io::unlink_owned(&dir, &name, &sentinel).unwrap();
    moved(&dir, &backup, &name).unwrap();
    io::sync(&dir).unwrap();
    cleanup_retained_flight().unwrap();
    drop(dir);
    Copy::create(None, 0).unwrap().destroy().unwrap();
    assert!(busy && refused && exact);
}

#[test]
fn final_copy_destroy_failure_retains_its_phase_and_exact_capacity() {
    let _serial = tests::SERIAL.lock().unwrap();
    let mut flight = Flight::start(false).unwrap();
    flight.killed().unwrap();
    let id = flight.copy().0.id;
    let dir = flight
        .copy()
        .0
        .data
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .dir()
        .unwrap()
        .try_clone()
        .unwrap();
    let name = stage_name();
    let extra = new_file(&dir, &name, b"test-owned crash orphan");
    assert!(flight.cleanup().is_err());
    assert!(flight.copy.is_none());
    assert_eq!(flight.destroying, Some(id));
    drop(flight);
    let busy = matches!(Copy::create(None, 0), Err(Error::Busy));
    let refused = cleanup_retained_flight().is_err();
    assert_eq!(owner::retained_copy_id(), Some(id));
    io::unlink_owned(&dir, &name, &extra).unwrap();
    io::sync(&dir).unwrap();
    cleanup_retained_flight().unwrap();
    drop(dir);
    Copy::create(None, 0).unwrap().destroy().unwrap();
    assert!(busy && refused);
}
