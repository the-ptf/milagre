//! Kernel process identities. Missing/inaccessible identities fail closed, never fall back to a bare PID.

use std::sync::Arc;

use crate::parse::ProcessRow;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub ppid: i64,
    pub pgid: i64,
    pub started_at: String,
}

pub type ReadIdentity = Arc<dyn Fn(i64) -> Option<ProcessIdentity> + Send + Sync>;

impl ProcessIdentity {
    /// Parentage may change when a shell exits; birth time and group must not.
    pub fn matches(&self, row: &ProcessRow) -> bool {
        self.pgid == row.pgid && !self.started_at.is_empty() && row.started_at.as_ref() == Some(&self.started_at)
    }
}

pub fn system_identity(pid: i64) -> Option<ProcessIdentity> {
    if !(2..=i32::MAX as i64).contains(&pid) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // PROC_PIDTBSDINFO returns parent, group and microsecond birth time in one kernel snapshot.
        let read = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
        if read != size {
            return None;
        }
        let info = unsafe { info.assume_init() };
        if i64::from(info.pbi_pid) != pid || info.pbi_status == libc::SZOMB {
            return None;
        }
        Some(ProcessIdentity {
            ppid: info.pbi_ppid.into(),
            pgid: info.pbi_pgid.into(),
            started_at: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }
    #[cfg(target_os = "linux")]
    {
        parse_linux_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?, pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    None
}

/// /proc/PID/stat: comm can contain spaces and ')' characters. Starttime is field 22, in clock ticks.
#[cfg(any(target_os = "linux", test))]
fn parse_linux_stat(text: &str, pid: i64) -> Option<ProcessIdentity> {
    let (prefix, rest) = text.rsplit_once(") ")?;
    if prefix.split_once(" (")?.0.parse::<i64>().ok()? != pid {
        return None;
    }
    let fields: Vec<_> = rest.split_whitespace().collect();
    if matches!(*fields.first()?, "Z" | "X" | "x") {
        return None;
    }
    let started = *fields.get(19)?;
    started.parse::<u64>().ok()?;
    Some(ProcessIdentity { ppid: fields.get(1)?.parse().ok()?, pgid: fields.get(2)?.parse().ok()?, started_at: started.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_stat_handles_parentheses_and_rejects_dead_or_malformed_rows() {
        let stat = "42 (a ) tricky name) S 10 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 98765 0";
        assert_eq!(parse_linux_stat(stat, 42), Some(ProcessIdentity { ppid: 10, pgid: 42, started_at: "98765".into() }));
        assert!(parse_linux_stat(&stat.replace(") S ", ") Z "), 42).is_none());
        assert!(parse_linux_stat(stat, 43).is_none());
        assert!(parse_linux_stat("42 (x) S 10", 42).is_none());
    }
}
