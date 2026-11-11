//! Constant-space, payload-free local close observations, not remote root-cause attribution.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum DisconnectReason {
    PeerEof = 1,
    ReadIo,
    InvalidFrame,
    WriteTimeout,
    WriteIo,
    OutgoingBytes,
    OutgoingFrames,
    WriterQueueClosed,
    AuthenticationTimeout,
    AuthenticationRejected,
    InflightLimit,
    DuplicateId,
    HandlerRequested,
    GracefulShutdown,
    ForcedServerDrop,
    ErrorReplyFailure,
}
impl DisconnectReason {
    pub const ALL: [Self; 16] = [
        Self::PeerEof,
        Self::ReadIo,
        Self::InvalidFrame,
        Self::WriteTimeout,
        Self::WriteIo,
        Self::OutgoingBytes,
        Self::OutgoingFrames,
        Self::WriterQueueClosed,
        Self::AuthenticationTimeout,
        Self::AuthenticationRejected,
        Self::InflightLimit,
        Self::DuplicateId,
        Self::HandlerRequested,
        Self::GracefulShutdown,
        Self::ForcedServerDrop,
        Self::ErrorReplyFailure,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::PeerEof => "peerEof",
            Self::ReadIo => "readIo",
            Self::InvalidFrame => "invalidFrame",
            Self::WriteTimeout => "writeTimeout",
            Self::WriteIo => "writeIo",
            Self::OutgoingBytes => "outgoingBytes",
            Self::OutgoingFrames => "outgoingFrames",
            Self::WriterQueueClosed => "writerQueueClosed",
            Self::AuthenticationTimeout => "authenticationTimeout",
            Self::AuthenticationRejected => "authenticationRejected",
            Self::InflightLimit => "inflightLimit",
            Self::DuplicateId => "duplicateId",
            Self::HandlerRequested => "handlerRequested",
            Self::GracefulShutdown => "gracefulShutdown",
            Self::ForcedServerDrop => "forcedServerDrop",
            Self::ErrorReplyFailure => "errorReplyFailure",
        }
    }
    pub(crate) fn from_tag(tag: u8) -> Self {
        Self::ALL[usize::from(tag) - 1]
    }
}
#[derive(Clone, Debug)]
pub struct DisconnectDiagnostics {
    counts: [u64; 16],
    pub error_reply_failures: u64,
    pub admission_capacity: u64,
    pub admission_peer_credentials: u64,
    pub admission_setup_io: u64,
    pub listener_accept_io: u64,
}
impl DisconnectDiagnostics {
    pub fn count(&self, reason: DisconnectReason) -> u64 {
        self.counts[reason as usize - 1]
    }
    pub fn value(&self) -> Value {
        let mut unexpected = serde_json::Map::new();
        for reason in DisconnectReason::ALL {
            if !matches!(
                reason,
                DisconnectReason::GracefulShutdown | DisconnectReason::ForcedServerDrop
            ) {
                unexpected.insert(reason.name().into(), json!(self.count(reason)));
            }
        }
        json!({"disconnects":unexpected,
            "shutdowns":{"graceful":self.count(DisconnectReason::GracefulShutdown),"forced":self.count(DisconnectReason::ForcedServerDrop)},
            "errorReplyFailures":self.error_reply_failures,
            "admissionRejected":{"capacity":self.admission_capacity,"peerCredentials":self.admission_peer_credentials,"setupIo":self.admission_setup_io},
            "listenerAcceptIo":self.listener_accept_io})
    }
}
pub(crate) fn increment(counter: &AtomicU64) {
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
        Some(n.saturating_add(1))
    });
}
#[derive(Default)]
pub(crate) struct Counters {
    counts: [AtomicU64; 16],
    pub error_reply_failures: AtomicU64,
    pub admission_capacity: AtomicU64,
    pub admission_peer_credentials: AtomicU64,
    pub admission_setup_io: AtomicU64,
    pub listener_accept_io: AtomicU64,
}
impl Counters {
    pub fn record(&self, reason: DisconnectReason) {
        increment(&self.counts[reason as usize - 1]);
    }
    pub fn snapshot(&self) -> DisconnectDiagnostics {
        DisconnectDiagnostics {
            counts: std::array::from_fn(|i| self.counts[i].load(Ordering::Relaxed)),
            error_reply_failures: self.error_reply_failures.load(Ordering::Relaxed),
            admission_capacity: self.admission_capacity.load(Ordering::Relaxed),
            admission_peer_credentials: self.admission_peer_credentials.load(Ordering::Relaxed),
            admission_setup_io: self.admission_setup_io.load(Ordering::Relaxed),
            listener_accept_io: self.listener_accept_io.load(Ordering::Relaxed),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_counters_saturate_and_keep_shutdowns_separate() {
        let counters = Counters::default();
        counters.counts[0].store(u64::MAX - 1, Ordering::Relaxed);
        counters.record(DisconnectReason::PeerEof);
        counters.record(DisconnectReason::PeerEof);
        counters.record(DisconnectReason::GracefulShutdown);
        counters.record(DisconnectReason::ForcedServerDrop);
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.count(DisconnectReason::PeerEof), u64::MAX);
        assert_eq!(
            snapshot.value()["shutdowns"],
            json!({"graceful":1,"forced":1})
        );
        assert_eq!(
            snapshot.value()["disconnects"].as_object().unwrap().len(),
            14
        );
        assert!(snapshot.value().to_string().len() < 1024);
    }
}
