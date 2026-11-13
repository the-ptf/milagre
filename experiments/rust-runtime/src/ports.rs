//! Port ownership is limited to this fixture runtime's real terminal descendants.
use milagre_ports::{parse_ps, watcher::system_kill, ProcessRow, Signal};
use milagre_terminals::Terminals;
use std::{
    collections::{HashMap, HashSet},
    process::{Command, Stdio},
};

/// Revalidate signal targets against the current private shell trees, independent of the watcher's cached listing.
/// The ps sample is read-only; it never admits another application's roots, a terminal shell, or a mixed group.
pub fn scoped_signal(terminals: &Terminals, target: i64, signal: Signal) -> bool {
    if (-1..=1).contains(&target) || target == i64::MIN {
        return false;
    }
    let shells: HashSet<i64> = terminals
        .shells()
        .into_iter()
        .flat_map(|(_, pids)| pids.into_iter().map(i64::from))
        .collect();
    if shells.is_empty() {
        return false;
    }
    let Ok(sample) = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid=,comm="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    if !sample.status.success() || sample.stdout.len() > 8 * 1024 * 1024 {
        return false;
    }
    let rows = parse_ps(&String::from_utf8_lossy(&sample.stdout));
    if !allowed_target(&rows, &shells, target) {
        return false;
    }
    system_kill(target, signal)
}
fn allowed_target(rows: &[ProcessRow], shells: &HashSet<i64>, target: i64) -> bool {
    if (-1..=1).contains(&target) || target == i64::MIN {
        return false;
    }
    let by_pid: HashMap<i64, &ProcessRow> = rows.iter().map(|row| (row.pid, row)).collect();
    let descendant = |pid: i64| {
        if shells.contains(&pid) {
            return false;
        }
        let mut current = pid;
        let mut seen = HashSet::new();
        while let Some(row) = by_pid.get(&current) {
            if !seen.insert(current) {
                return false;
            }
            if shells.contains(&row.ppid) {
                return true;
            }
            current = row.ppid;
        }
        false
    };
    if target > 0 {
        return descendant(target);
    }
    let group = -target;
    let members = rows
        .iter()
        .filter(|row| row.pgid == group)
        .collect::<Vec<_>>();
    !members.is_empty() && members.iter().all(|row| descendant(row.pid))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signals_require_current_descendants_and_preserve_shells_and_unrelated_groups() {
        let rows = parse_ps("100 1 100 sh\n101 100 100 listener\n102 100 102 sh\n103 102 102 listener\n200 1 200 unrelated\n201 200 102 unrelated\n");
        let shells = HashSet::from([100]);
        assert!(allowed_target(&rows, &shells, 101));
        assert!(allowed_target(&rows, &shells, 103));
        for target in [-1, 0, 1, i64::MIN, 100, 200, -100, -102, -200, 999] {
            assert!(!allowed_target(&rows, &shells, target));
        }
        let rows = rows
            .into_iter()
            .filter(|row| row.pid != 201)
            .collect::<Vec<_>>();
        assert!(allowed_target(&rows, &shells, -102));
    }
}
