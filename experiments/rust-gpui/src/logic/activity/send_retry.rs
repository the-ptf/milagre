//! After `packages/shared/src/send-retry.mjs`: which failed calls to the computer may be tried again, and the waits
//! between tries. `retrySend` is asynchronous in TypeScript; here [`next_delay`] holds the policy and
//! [`retry_send`] runs it synchronously with an injected clock and wait, so a caller on any runtime can reuse it.

/// The waits between tries of a send the computer couldn't take: quick at first, then every 30 s.
pub const SEND_RETRY_DELAYS: [u64; 6] = [1000, 2000, 4000, 8000, 15000, 30000];
/// How long a send keeps trying before it fails as it would have at once.
pub const SEND_RETRY_BUDGET: u64 = 10 * 60 * 1000;
/// How long a read the screen waits on (branches, installed agents) keeps trying before it shows its error.
pub const READ_RETRY_BUDGET: u64 = 60 * 1000;

/// Why a failed call may be tried again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryKind {
    /// It never reached the host: the host was busy, closing, or disconnected from this window.
    Unsent,
    /// It may have run and only its answer was lost: a deadline passed or the connection dropped.
    Unknown,
}

/// The parts of a thrown error `retryKind` reads. `message` is the error's text (`String(error)` when it is no
/// error object).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallError {
    /// An explicit `retry` field the sender set ("unsent" or "unknown"); anything else is ignored.
    pub retry: Option<String>,
    pub name: Option<String>,
    pub code: Option<String>,
    pub status: Option<u16>,
    pub message: String,
}

/// `ipcErrorMessage`: Electron serializes thrown errors as strings; this drops its
/// `Error invoking remote method '...': ` prefix (and one `Error: `).
pub fn ipc_error_message(message: &str) -> &str {
    let Some(rest) = message.strip_prefix("Error invoking remote method '") else { return message };
    let Some(quote) = rest.find('\'') else { return message };
    if quote == 0 {
        return message;
    }
    let Some(rest) = rest[quote..].strip_prefix("': ") else { return message };
    rest.strip_prefix("Error: ").unwrap_or(rest)
}

/// `retryKind`: `None` for the host's own answer, such as a refusal, which a retry would only get again.
pub fn retry_kind(error: Option<&CallError>) -> Option<RetryKind> {
    let error = error?;
    match error.retry.as_deref() {
        Some("unsent") => return Some(RetryKind::Unsent),
        Some("unknown") => return Some(RetryKind::Unknown),
        _ => {}
    }
    if error.name.as_deref() == Some("RelayTransportError") {
        return matches!(error.code.as_deref(), Some("lost") | Some("host-offline")).then_some(RetryKind::Unknown);
    }
    let message = ipc_error_message(&error.message);
    if error.status == Some(429) || (error.status == Some(503) && message == "Bridge is closing") {
        return Some(RetryKind::Unsent);
    }
    // A proxy's unavailable response doesn't prove the Mac skipped the request.
    if matches!(error.status, Some(502) | Some(503) | Some(504)) {
        return Some(RetryKind::Unknown);
    }
    if message.starts_with("Milagre host is disconnected. Your command was not sent.") {
        return Some(RetryKind::Unsent);
    }
    // The daemon client's deadline, on this Mac or forwarded by the phone bridge.
    if message.starts_with("Timed out: ") || message == "Daemon connection closed" {
        return Some(RetryKind::Unknown);
    }
    None
}

/// The wait before try number `tries + 1` (`tries` failures so far, `elapsed` ms since the first), or `None` when
/// the budget would run out: the error is then thrown as it was.
pub fn next_delay(tries: usize, elapsed: u64, delays: &[u64], budget: u64) -> Option<u64> {
    let delay = delays[tries.min(delays.len() - 1)];
    (elapsed + delay <= budget).then_some(delay)
}

/// `retrySend`: runs `attempt` until the computer answers it. A failure `retryable` accepts is tried again after a
/// wait while the budget lasts; any other failure, or one past the budget, is returned. `now` is a clock in ms
/// and `wait` sleeps that long.
pub fn retry_send<T, E>(
    mut attempt: impl FnMut() -> Result<T, E>,
    retryable: impl Fn(&E) -> bool,
    delays: &[u64],
    budget: u64,
    mut now: impl FnMut() -> u64,
    mut wait: impl FnMut(u64),
) -> Result<T, E> {
    let started = now();
    let mut tries = 0;
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let delay = delays[tries.min(delays.len() - 1)];
                if !retryable(&error) || now() + delay - started > budget {
                    return Err(error);
                }
                wait(delay);
                tries += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn error(message: &str, status: Option<u16>) -> CallError {
        CallError { message: message.into(), status, ..Default::default() }
    }

    #[test]
    fn a_busy_or_unreachable_computer_is_told_apart_from_one_that_answered() {
        let kind = |e: CallError| retry_kind(Some(&e));
        assert_eq!(kind(error("Your computer is busy right now. Try again in a moment.", Some(429))), Some(RetryKind::Unsent));
        assert_eq!(kind(error("Bridge is closing", Some(503))), Some(RetryKind::Unsent));
        assert_eq!(kind(error("Service unavailable", Some(503))), Some(RetryKind::Unknown));
        assert_eq!(kind(error("Milagre host is disconnected. Your command was not sent.", None)), Some(RetryKind::Unsent));
        assert_eq!(kind(CallError { retry: Some("unknown".into()), ..error("Connection lost.", None) }), Some(RetryKind::Unknown));
        assert_eq!(kind(CallError { retry: Some("unsent".into()), ..error("x", Some(409)) }), Some(RetryKind::Unsent));
        assert_eq!(kind(error("The computer took too long to answer", Some(504))), Some(RetryKind::Unknown));
        let relay = |code: &str| CallError { name: Some("RelayTransportError".into()), code: Some(code.into()), ..error("x", None) };
        assert_eq!(kind(relay("host-offline")), Some(RetryKind::Unknown));
        assert_eq!(kind(relay("lost")), Some(RetryKind::Unknown));
        assert_eq!(kind(relay("bad-token")), None);
        // The bridge's own daemon call timed out, forwarded with the host's refusal status.
        assert_eq!(kind(error("Timed out: chat:send. It may still be running.", Some(409))), Some(RetryKind::Unknown));
        assert_eq!(
            kind(error("Error invoking remote method 'chat:send': Error: Daemon connection closed", None)),
            Some(RetryKind::Unknown)
        );
        // The host's answers: a retry would get them again.
        assert_eq!(kind(error("That chat is no longer in the project.", Some(409))), None);
        assert_eq!(kind(error("Choose a base branch before sending.", None)), None);
        assert_eq!(retry_kind(None), None);
        // A bad `retry` value is ignored and the rest decides.
        assert_eq!(kind(CallError { retry: Some("soon".into()), ..error("busy", Some(429)) }), Some(RetryKind::Unsent));
    }

    #[test]
    fn ipc_prefixes_come_off() {
        assert_eq!(ipc_error_message("Error invoking remote method 'chat:send': Error: boom"), "boom");
        assert_eq!(ipc_error_message("Error invoking remote method 'chat:send': boom"), "boom");
        assert_eq!(ipc_error_message("Error invoking remote method '': boom"), "Error invoking remote method '': boom");
        assert_eq!(ipc_error_message("plain"), "plain");
    }

    /// A clock the waits move forward, so a test runs the whole budget at once.
    struct Clock {
        time: Cell<u64>,
        waits: RefCell<Vec<u64>>,
    }

    impl Clock {
        fn new() -> Self {
            Self { time: Cell::new(0), waits: RefCell::new(Vec::new()) }
        }
        fn now(&self) -> u64 {
            self.time.get()
        }
        fn wait(&self, ms: u64) {
            self.waits.borrow_mut().push(ms);
            self.time.set(self.time.get() + ms);
        }
    }

    #[test]
    fn a_send_the_computer_turned_away_is_tried_again_until_it_goes() {
        let clock = Clock::new();
        let mut tries = 0;
        let result: Result<u32, &str> = retry_send(
            || {
                tries += 1;
                if tries < 4 { Err("busy") } else { Ok(7) }
            },
            |_| true,
            &SEND_RETRY_DELAYS,
            SEND_RETRY_BUDGET,
            || clock.now(),
            |ms| clock.wait(ms),
        );
        assert_eq!(result, Ok(7));
        assert_eq!(tries, 4);
        assert_eq!(*clock.waits.borrow(), vec![1000, 2000, 4000]);
    }

    #[test]
    fn the_waits_grow_to_30_s_and_stop_when_the_budget_runs_out() {
        let clock = Clock::new();
        let result: Result<(), &str> =
            retry_send(|| Err("busy"), |_| true, &SEND_RETRY_DELAYS, 100_000, || clock.now(), |ms| clock.wait(ms));
        assert_eq!(result, Err("busy"));
        assert_eq!(*clock.waits.borrow(), vec![1000, 2000, 4000, 8000, 15000, 30000, 30000]);
        assert!(clock.now() <= 100_000);
        assert_eq!(next_delay(0, 0, &SEND_RETRY_DELAYS, 100_000), Some(1000));
        assert_eq!(next_delay(9, 99_000, &SEND_RETRY_DELAYS, 100_000), None);
    }

    #[test]
    fn an_answer_from_the_computer_is_not_tried_again() {
        let clock = Clock::new();
        let mut tries = 0;
        let refused = error("That chat is no longer in the project.", Some(409));
        let result: Result<(), CallError> = retry_send(
            || {
                tries += 1;
                Err(refused.clone())
            },
            |e| retry_kind(Some(e)).is_some(),
            &SEND_RETRY_DELAYS,
            SEND_RETRY_BUDGET,
            || clock.now(),
            |ms| clock.wait(ms),
        );
        assert_eq!(result, Err(refused));
        assert_eq!(tries, 1);
        assert!(clock.waits.borrow().is_empty());
    }

    #[test]
    fn a_call_that_may_have_run_is_retried_only_when_the_caller_allows_it() {
        let clock = Clock::new();
        let mut tries = 0;
        let lost = CallError { retry: Some("unknown".into()), ..error("Connection lost.", None) };
        let result: Result<(), CallError> = retry_send(
            || {
                tries += 1;
                Err(lost.clone())
            },
            |e| retry_kind(Some(e)) == Some(RetryKind::Unsent),
            &SEND_RETRY_DELAYS,
            SEND_RETRY_BUDGET,
            || clock.now(),
            |ms| clock.wait(ms),
        );
        assert_eq!(result, Err(lost));
        assert_eq!(tries, 1);
    }
}
