//! Exact-child-only lifecycle for the native fake, which has no descendant code.
//! WNOWAIT preserves PID ownership before cancellation; lost ownership is sticky.
use super::Error;
use std::{
    process::{Child, ExitStatus},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Held,
    Reaped,
    Lost,
}
trait Process {
    fn probe(&mut self) -> std::io::Result<bool>;
    fn signal_child(&mut self) -> std::io::Result<()>;
    fn reap(&mut self) -> std::io::Result<ExitStatus>;
}
impl Process for Child {
    fn probe(&mut self) -> std::io::Result<bool> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let result = unsafe { libc::waitid(libc::P_PID, self.id(), info.as_mut_ptr(), libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if result < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        Ok(info.si_pid != 0)
    }
    fn signal_child(&mut self) -> std::io::Result<()> {
        // This dedicated compiled fake cannot spawn descendants. Exact-child cleanup
        // is deliberately separate from the ACP transport's process-group contract.
        if unsafe { libc::kill(self.id() as i32, libc::SIGKILL) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    fn reap(&mut self) -> std::io::Result<ExitStatus> {
        self.wait()
    }
}
struct Ownership<P: Process> {
    process: P,
    state: State,
    signalled: bool,
}
impl<P: Process> Ownership<P> {
    fn new(process: P) -> Self {
        Self { process, state: State::Held, signalled: false }
    }
    fn probe(&mut self) -> Result<bool, Error> {
        if self.state != State::Held {
            return Err(Error::CleanupUncertain);
        }
        loop {
            match self.process.probe() {
                Ok(exited) => return Ok(exited),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.state = State::Lost;
                    return Err(Error::CleanupUncertain);
                }
            }
        }
    }
    fn signal(&mut self) -> Result<(), Error> {
        if self.probe()? {
            return Ok(());
        }
        if self.process.signal_child().is_err() {
            // The exact child may have exited between WNOWAIT and kill. Only a
            // second successful ownership probe may classify that as natural exit.
            if !self.probe()? {
                return Err(Error::CleanupUncertain);
            }
        }
        self.signalled = true;
        Ok(())
    }
    fn reap_exited(&mut self) -> Result<ExitStatus, Error> {
        if !self.probe()? {
            return Err(Error::CleanupUncertain);
        }
        loop {
            match self.process.reap() {
                Ok(status) => {
                    self.state = State::Reaped;
                    return Ok(status);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.state = State::Lost;
                    return Err(Error::CleanupUncertain);
                }
            }
        }
    }
}
pub(super) struct Owned {
    inner: Option<Ownership<Child>>,
    status: Option<ExitStatus>,
}
impl Owned {
    pub(super) fn new(child: Child) -> Self {
        Self { inner: Some(Ownership::new(child)), status: None }
    }
    pub(super) fn child(&mut self) -> &mut Child {
        &mut self.inner.as_mut().expect("owned child").process
    }
    pub(super) fn finish(&mut self, until: Instant) -> Result<ExitStatus, Error> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        let inner = self.inner.as_mut().ok_or(Error::CleanupUncertain)?;
        if !inner.signalled {
            inner.signal()?;
        }
        loop {
            if inner.probe()? {
                let status = inner.reap_exited()?;
                self.status = Some(status);
                return Ok(status);
            }
            if Instant::now() >= until {
                return Err(Error::CleanupUncertain);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    /// Observe normal exit without sending a signal. The worker owns all retries.
    pub(super) fn natural_exit(&mut self) -> Result<Option<ExitStatus>, Error> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        let inner = self.inner.as_mut().ok_or(Error::CleanupUncertain)?;
        if !inner.probe()? {
            return Ok(None);
        }
        let status = inner.reap_exited()?;
        self.status = Some(status);
        Ok(Some(status))
    }
    pub(super) fn lost(&self) -> bool {
        self.inner.as_ref().is_none_or(|inner| inner.state == State::Lost)
    }
}
// Standalone emergency retention. The worker's resource guard separately retains
// scratch and the capacity slot if this owned process cannot be reaped.
impl Drop for Owned {
    fn drop(&mut self) {
        if self.inner.as_ref().is_some_and(|inner| inner.state == State::Held) {
            let _ = self.finish(Instant::now() + Duration::from_secs(2));
        }
        if self.inner.as_ref().is_some_and(|inner| inner.state != State::Reaped) {
            std::mem::forget(self.inner.take());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, os::unix::process::ExitStatusExt};
    struct Fake {
        probes: VecDeque<std::io::Result<bool>>,
        trace: Vec<&'static str>,
        fail_reap: bool,
    }
    impl Process for Fake {
        fn probe(&mut self) -> std::io::Result<bool> {
            self.trace.push("probe");
            self.probes.pop_front().unwrap_or(Ok(true))
        }
        fn signal_child(&mut self) -> std::io::Result<()> {
            self.trace.push("signal");
            Ok(())
        }
        fn reap(&mut self) -> std::io::Result<ExitStatus> {
            self.trace.push("reap");
            if self.fail_reap {
                Err(std::io::Error::from_raw_os_error(libc::ECHILD))
            } else {
                Ok(ExitStatus::from_raw(0))
            }
        }
    }
    #[test]
    fn signal_precedes_reap_and_reaped_handles_never_signal_again() {
        let mut child = Ownership::new(Fake {
            probes: VecDeque::from([Err(std::io::ErrorKind::Interrupted.into()), Ok(false)]),
            trace: vec![],
            fail_reap: false,
        });
        child.signal().unwrap();
        child.reap_exited().unwrap();
        let before = child.process.trace.clone();
        assert_eq!(before, vec!["probe", "probe", "signal", "probe", "reap"]);
        assert_eq!(child.signal(), Err(Error::CleanupUncertain));
        assert_eq!(child.process.trace, before);
    }
    #[test]
    fn natural_exit_reaps_without_a_signal_and_cannot_be_reaped_twice() {
        let mut child = Ownership::new(Fake { probes: VecDeque::new(), trace: vec![], fail_reap: false });
        child.signal().unwrap();
        child.reap_exited().unwrap();
        assert_eq!(child.process.trace, vec!["probe", "probe", "reap"]);
        assert_eq!(child.reap_exited(), Err(Error::CleanupUncertain));
        assert_eq!(child.process.trace, vec!["probe", "probe", "reap"]);
    }
    #[test]
    fn unknown_ownership_never_signals_or_waits_again() {
        for at_reap in [false, true] {
            let probes = if at_reap { VecDeque::new() } else { VecDeque::from([Err(std::io::Error::from_raw_os_error(libc::ECHILD))]) };
            let mut child = Ownership::new(Fake { probes, trace: vec![], fail_reap: at_reap });
            if at_reap {
                child.signal().unwrap();
                assert_eq!(child.reap_exited(), Err(Error::CleanupUncertain));
            } else {
                assert_eq!(child.signal(), Err(Error::CleanupUncertain));
            }
            let before = child.process.trace.clone();
            assert_eq!(child.signal(), Err(Error::CleanupUncertain));
            assert_eq!(child.probe(), Err(Error::CleanupUncertain));
            assert_eq!(child.process.trace, before);
        }
    }
}
