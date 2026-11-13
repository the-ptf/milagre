use super::{
    files::Prepared, process::Owned, wire, Control, Disposal, Error, Execution, FixtureCase, RegisteredWorkspace, Report, Shared, Slot,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::{io::AsRawFd, process::CommandExt},
    panic::{catch_unwind, AssertUnwindSafe},
    process::{Command, Stdio},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
#[derive(Clone, Copy)]
pub(super) enum Fault {
    None,
    #[cfg(test)]
    PanicAfterSpawn,
    #[cfg(test)]
    SpawnFailure,
    #[cfg(test)]
    PartialPreparation,
    #[cfg(test)]
    ThreadSpawnFailure,
    #[cfg(test)]
    MalformedFrame,
}
fn nonblocking(fd: i32) -> Result<(), Error> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(Error::Protocol);
    }
    Ok(())
}
fn check(shared: &Shared, until: Instant) -> Result<(), Error> {
    shared.active()?;
    if Instant::now() >= until {
        return Err(Error::Deadline);
    }
    Ok(())
}
fn pause() {
    std::thread::sleep(Duration::from_millis(5));
}
// Registered turns include the five-second prelaunch window in their total budget.
// These limits are internal policy, never coordinator-supplied durations.
const REGISTERED_AFTER_PRELAUNCH: Duration = Duration::from_secs(25);
const FIRST_RECEIPT: Duration = Duration::from_secs(5);
const READ_IDLE: Duration = Duration::from_secs(10);
struct Timing {
    until: Instant,
    receipt: Option<Instant>,
    idle: Option<Instant>,
}
impl Timing {
    fn registered(prelaunch: Instant, spawn: Instant) -> Result<Self, Error> {
        let until = prelaunch.checked_add(REGISTERED_AFTER_PRELAUNCH).ok_or(Error::Deadline)?;
        Ok(Self {
            until,
            receipt: Some(spawn.checked_add(FIRST_RECEIPT).unwrap_or(until).min(until)),
            idle: Some(spawn.checked_add(READ_IDLE).unwrap_or(until).min(until)),
        })
    }
    fn wrapper(start: Instant) -> Self {
        Self { until: start + Duration::from_secs(30), receipt: None, idle: None }
    }
    fn read_until(&self) -> Instant {
        self.until.min(self.receipt.unwrap_or(self.until)).min(self.idle.unwrap_or(self.until))
    }
    fn read_completed(&self, now: Instant) -> Result<(), Error> {
        if self.idle.is_some() && now >= self.read_until() {
            return Err(Error::Deadline);
        }
        Ok(())
    }
    fn received(&mut self, now: Instant) -> Result<(), Error> {
        // A read that returns late cannot revive its idle or receipt budget.
        self.read_completed(now)?;
        if self.idle.is_some() {
            self.idle = Some(now.checked_add(READ_IDLE).unwrap_or(self.until).min(self.until));
        }
        Ok(())
    }
    fn validated(&mut self, shared: &Shared, now: Instant) -> Result<(), Error> {
        if self.receipt.is_some() {
            shared.active()?;
            self.read_completed(now)?;
            self.receipt = None;
        }
        Ok(())
    }
}
fn write(out: &mut impl Write, bytes: &[u8], shared: &Shared, until: Instant) -> Result<(), Error> {
    let mut offset = 0;
    while offset < bytes.len() {
        check(shared, until)?;
        match out.write(&bytes[offset..]) {
            Ok(0) => return Err(Error::Protocol),
            Ok(count) => offset += count,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => pause(),
            Err(_) => return Err(Error::Protocol),
        }
    }
    Ok(())
}
fn receipt(input: &mut impl Read, shared: &Shared, timing: &mut Timing) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        check(shared, timing.read_until())?;
        match input.read(&mut chunk) {
            Ok(0) => return Err(Error::Protocol),
            Ok(count) => {
                timing.received(Instant::now())?;
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > wire::RECEIPT_LIMIT + 1 {
                    return Err(Error::Bounds);
                }
                if let Some(end) = bytes.iter().position(|b| *b == b'\n') {
                    if end + 1 != bytes.len() {
                        return Err(Error::Protocol);
                    }
                    bytes.pop();
                    return Ok(bytes);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => pause(),
            Err(_) => return Err(Error::Protocol),
        }
    }
}
fn execute(owned: &mut Owned, prepared: &Prepared, shared: &Shared, text: &str, fault: Fault, spawn: Instant) -> Result<Execution, Error> {
    #[cfg(test)]
    if matches!(fault, Fault::PanicAfterSpawn) {
        panic!("injected private fixture worker panic");
    }
    let _ = fault;
    let mut timing = if prepared.is_registered() { Timing::registered(shared.deadline, spawn)? } else { Timing::wrapper(Instant::now()) };
    check(shared, timing.read_until())?;
    let child = owned.child();
    let pid = child.id();
    let mut input = child.stdin.take().ok_or(Error::Protocol)?;
    let mut output = child.stdout.take().ok_or(Error::Protocol)?;
    nonblocking(input.as_raw_fd())?;
    nonblocking(output.as_raw_fd())?;
    let mut random = [0u8; 32];
    unsafe {
        libc::arc4random_buf(random.as_mut_ptr().cast(), random.len());
    }
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let prompt = wire::Prompt {
        jsonrpc: "2.0".into(),
        id: 1,
        method: "session/prompt".into(),
        params: wire::PromptParams { nonce: nonce.clone(), prompt: [wire::Text { r#type: "text".into(), text: text.into() }] },
    };
    let mut frame = serde_json::to_vec(&prompt).map_err(|_| Error::Protocol)?;
    if frame.len() > wire::FRAME_LIMIT {
        return Err(Error::Bounds);
    }
    #[cfg(test)]
    if matches!(fault, Fault::MalformedFrame) {
        frame = b"{}".to_vec();
    }
    let frame_bytes = frame.len();
    let frame_digest = format!("{:x}", Sha256::digest(&frame));
    frame.push(b'\n');
    write(&mut input, &frame, shared, timing.read_until())?;
    let raw = receipt(&mut output, shared, &mut timing)?;
    let receipt: wire::NativeReceipt = serde_json::from_slice(&raw).map_err(|_| Error::Protocol)?;
    let cwd = prepared.cwd().dev_ino();
    if receipt.identity != wire::IDENTITY
        || receipt.pid != pid
        || (receipt.cwd_device, receipt.cwd_inode) != cwd
        || receipt.nonce != nonce
        || receipt.frame_bytes != frame_bytes
        || receipt.frame_sha256 != frame_digest
        || receipt.text_bytes != text.len()
        || receipt.text_sha256 != format!("{:x}", Sha256::digest(text.as_bytes()))
        || !receipt.isolated_environment
    {
        return Err(Error::Protocol);
    }
    let execution = Execution {
        compiled_identity: wire::IDENTITY,
        pid,
        cwd_device: cwd.0,
        cwd_inode: cwd.1,
        nonce,
        frame_bytes,
        frame_sha256: frame_digest,
        text_bytes: receipt.text_bytes,
        text_sha256: receipt.text_sha256,
        parent_artifact_sha256: prepared.digest(),
    };
    // Parsing and identity/digest validation must finish within the receipt limit.
    timing.validated(shared, Instant::now())?;
    shared.parsed.store(true, Ordering::Release);
    shared.consumed(execution.clone());
    // A natural success requires EOF after the single closed receipt. IgnoreCancel
    // holds its pipes until cancellation, which drives the retained cleanup below.
    let mut extra = [0u8; 1];
    loop {
        check(shared, timing.read_until())?;
        match output.read(&mut extra) {
            Ok(0) => {
                timing.read_completed(Instant::now())?;
                break;
            }
            Ok(_) => return Err(Error::Protocol),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => pause(),
            Err(_) => return Err(Error::Protocol),
        }
    }
    // EOF alone does not prove normal exit. Reap through this exact retained Child,
    // without signalling; an error/cancellation falls through to cleanup below.
    loop {
        check(shared, timing.until)?;
        if let Some(status) = owned.natural_exit()? {
            if status.code() != Some(0) {
                return Err(Error::Protocol);
            }
            break;
        }
        pause();
    }
    Ok(execution)
}

// Own child, descriptors and capacity together across unexpected unwinding too.
struct Resources {
    prepared: Option<Prepared>,
    owned: Option<Owned>,
    workspace: Option<RegisteredWorkspace>,
    slot: Option<Slot>,
}
impl Drop for Resources {
    fn drop(&mut self) {
        if let Some(child) = self.owned.as_mut() {
            if child.finish(Instant::now() + Duration::from_secs(2)).is_err() {
                std::mem::forget(self.owned.take());
                std::mem::forget(self.prepared.take());
                std::mem::forget(self.slot.take());
                std::mem::forget(self.workspace.take());
                return;
            }
        }
        if let Some(pins) = self.prepared.as_mut() {
            if !pins.storage.cleanup() {
                std::mem::forget(self.prepared.take());
                std::mem::forget(self.slot.take());
                std::mem::forget(self.workspace.take());
            }
        }
    }
}

#[cfg(test)]
pub(super) fn run(
    shared: Arc<Shared>,
    case: FixtureCase,
    text: String,
    slot: Slot,
    fault: Fault,
    automatic: Option<Control>,
) -> Option<Disposal> {
    run_in(shared, case, text, slot, fault, automatic, None)
}
pub(super) fn run_in(
    shared: Arc<Shared>,
    case: FixtureCase,
    text: String,
    slot: Slot,
    fault: Fault,
    automatic: Option<Control>,
    workspace: Option<RegisteredWorkspace>,
) -> Option<Disposal> {
    let mut resources = Resources { prepared: None, owned: None, slot: Some(slot), workspace };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let until = shared.deadline;
        shared.active()?;
        shared.before_deadline()?;
        resources.prepared = Some(Prepared::fixed()?);
        let pins = resources.prepared.as_mut().ok_or(Error::Identity)?;
        pins.register(resources.workspace.take());
        // Resource ownership is installed before the first fallible directory/copy step.
        #[cfg(test)]
        if matches!(fault, Fault::PartialPreparation) {
            pins.fail_partial_preparation(until)?;
        } else {
            pins.populate(until)?;
        }
        #[cfg(not(test))]
        pins.populate(until)?;
        shared.prepared()?;
        if let Some(control) = &automatic {
            control.stamp(control.capture()?)?;
        }
        while !shared.stamped()? {
            check(&shared, until)?;
            pause();
        }
        pins.check(until)?;
        // Final validation and one-shot commitment are serialized on this worker.
        // Cancel under the same gate wins before commitment, or requests cleanup after it.
        #[cfg(test)]
        if let Some(barrier) = shared.before_commit.lock().unwrap().take() {
            barrier.wait();
            barrier.wait();
        }
        #[cfg(test)]
        shared.pause_at(super::TestPoint::BeforeCommit);
        shared.commit()?;
        #[cfg(test)]
        if let Some(barrier) = shared.after_commit.lock().unwrap().take() {
            barrier.wait();
            barrier.wait();
        }
        #[cfg(test)]
        shared.pause_at(super::TestPoint::AfterCommit);
        let cwd = pins.cwd().file.as_raw_fd();
        let mut command = Command::new(pins.executable());
        command
            .args(wire::KIRO_ARGS)
            .env_clear()
            .env("HOME", pins.home())
            .env("TMPDIR", pins.tmp())
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env(
                "MILAGRE_COPY_FIXTURE_CASE",
                match case {
                    FixtureCase::Ready => "ready",
                    FixtureCase::IgnoreCancel => "ignore-cancel",
                },
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                #[cfg(test)]
                if matches!(fault, Fault::SpawnFailure) {
                    return Err(std::io::Error::from_raw_os_error(libc::ENOEXEC));
                }
                // Only async-signal-safe syscalls between fork and exec, no allocation/locks.
                if libc::fchdir(cwd) != 0 || libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        // Include a cooperative slow spawn in the registered first-receipt budget.
        let spawn = Instant::now();
        let child = command.spawn().map_err(|_| Error::Spawn)?;
        let pid = child.id();
        resources.owned = Some(Owned::new(child));
        shared.pid.store(pid, Ordering::Release);
        execute(resources.owned.as_mut().ok_or(Error::Spawn)?, pins, &shared, &text, fault, spawn)
    }))
    .unwrap_or(Err(Error::WorkerPanic));
    let natural_zero = result.is_ok();
    let mut report = Report { result, reaped: false, exit_code: None, resources_removed: false };
    if report.result == Err(Error::CleanupUncertain) && resources.prepared.is_none() {
        // Storage creation retained an unprovable root before a Pin could be minted.
        std::mem::forget(resources);
        shared.publish(report, true);
        return None;
    }
    if let Some(child) = resources.owned.as_mut() {
        #[cfg(test)]
        if shared.has_pause(super::TestPoint::Cleanup) {
            // Deliberately withhold disposal of this exact still-owned Child. The
            // actor must fail the turn yet retain every service until actual join.
            report.result = Err(Error::CleanupUncertain);
            shared.publish(report.clone(), false);
            shared.pause_at(super::TestPoint::Cleanup);
        }
        loop {
            match child.finish(Instant::now() + Duration::from_secs(2)) {
                Ok(status) => {
                    report.reaped = true;
                    report.exit_code = status.code();
                    break;
                }
                Err(_) => {
                    report.result = Err(Error::CleanupUncertain);
                    shared.publish(report.clone(), child.lost());
                    if child.lost() {
                        // Unknown is sticky: no further probe, signal, reap or deletion.
                        std::mem::forget(resources);
                        return None;
                    }
                    pause(); // Still owned: continue reaping without dropping the capacity slot.
                }
            }
        }
    }
    resources.owned.take(); // Confirmed reap: dropping cannot signal or wait again.
    if let Some(pins) = resources.prepared.as_mut() {
        report.resources_removed = pins.storage.cleanup();
        if !report.resources_removed {
            report.result = Err(Error::CleanupUncertain);
            std::mem::forget(resources);
            shared.publish(report, true);
            return None;
        }
        resources.workspace = pins.take_registered();
    } else {
        // Nothing native was created. The reservation still owns any input copies.
        report.resources_removed = true;
    }
    let disposition = if report.reaped {
        Disposal::Reaped { pid: shared.pid.load(Ordering::Acquire), exit_code: report.exit_code, natural_zero }
    } else {
        Disposal::NoChild
    };
    // The legacy wrapper releases capacity before publication. A registered flight
    // retains capacity through destruction of its external workspace descriptor copies.
    resources.prepared.take();
    if resources.workspace.is_none() {
        resources.slot.take();
    }
    shared.publish(report, true);
    #[cfg(test)]
    if let Some(barrier) = shared.before_return.lock().unwrap().take() {
        barrier.wait();
        barrier.wait();
    }
    #[cfg(test)]
    shared.pause_at(super::TestPoint::BeforeReturn);
    // Registered directories belong to the service owner; only descriptor copies
    // are dropped here. No joined acknowledgment exists until these drops finish.
    resources.workspace.take();
    resources.slot.take();
    drop(resources);
    drop(automatic);
    Some(disposition)
}

#[cfg(test)]
#[path = "worker_timing_tests.rs"]
mod timing_tests;
