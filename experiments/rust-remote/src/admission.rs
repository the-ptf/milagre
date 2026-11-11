//! Bounded authentication work and failure-specific enrollment quotas.
//! A clear HELLO key selects capacity only; it never authenticates a peer.
use crate::Error;
use std::collections::BTreeMap;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// One multiplexed relay. There is NO per-phone IP visibility at the host.
    Relay,
    /// Stable origin assigned by a trusted future direct-carrier adapter, not a peer field.
    Direct(u64),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    KnownCandidate,
    KnownDevice,
    Enrollment,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    GlobalEnrollment,
    DirectSource,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("enrollment failure quota exhausted ({scope:?}); retry at {retry_at_ms}")]
    FailureQuota { scope: Scope, retry_at_ms: u64 },
    #[error("authentication work lane saturated ({lane:?}); retry at {retry_at_ms}")]
    Saturated { lane: Lane, retry_at_ms: u64 },
    #[error("admission clock overflow")]
    Clock,
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub sources: usize,
    pub failures_per_source: u32,
    pub failures_global: u32,
    pub failure_window_ms: u64,
    pub known_crypto_units: u32,
    pub known_key_units: u32,
    pub enrollment_crypto_units: u32,
    pub crypto_window_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            sources: 64,
            failures_per_source: 8,
            failures_global: 32,
            failure_window_ms: 60_000,
            known_crypto_units: 64,
            known_key_units: 8,
            enrollment_crypto_units: 16,
            crypto_window_ms: 1000,
        }
    }
}
impl Limits {
    pub(crate) fn valid(self) -> bool {
        self.sources > 0
            && self.sources <= 4096
            && self.failures_per_source > 0
            && self.failures_global > 0
            && self.failure_window_ms > 0
            && (1..=1024).contains(&self.known_crypto_units)
            && (1..=1024).contains(&self.known_key_units)
            && (1..=1024).contains(&self.enrollment_crypto_units)
            && (10..=1000).contains(&self.crypto_window_ms)
    }
}
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failures {
    pub bad_hello: u64,
    pub malformed: u64,
    pub bad_token: u64,
    pub unknown_device: u64,
    pub policy: u64,
    pub known_candidate: u64,
    pub untracked_source: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub failure_reset_ms: u64,
    pub crypto_reset_ms: u64,
    pub enrollment_failures: u32,
    pub direct_source_failures: u32,
    pub global_enrollment_locked: bool,
    pub direct_source_locked: bool,
    pub source_entries: usize,
    pub source_table_full: bool,
    pub known_units_remaining: u32,
    pub known_key_entries: usize,
    pub enrollment_units_remaining: u32,
    pub failures: Failures,
}
pub(crate) struct Admission {
    limits: Limits,
    failure_until: u64,
    crypto_until: u64,
    failures: u32,
    sources: BTreeMap<u64, u32>,
    known_work: u32,
    known_keys: BTreeMap<String, u32>,
    enrollment_work: u32,
    totals: Failures,
}
impl Admission {
    pub(crate) fn new(limits: Limits) -> Self {
        Self {
            limits,
            failure_until: 0,
            crypto_until: 0,
            failures: 0,
            sources: BTreeMap::new(),
            known_work: 0,
            known_keys: BTreeMap::new(),
            enrollment_work: 0,
            totals: Failures::default(),
        }
    }
    pub(crate) fn refresh(&mut self, now: u64) -> Result<(), AdmissionError> {
        // Compute all new deadlines before mutating; overflow cannot partially reset a quota.
        let failure = if now >= self.failure_until {
            Some(
                now.checked_add(self.limits.failure_window_ms)
                    .ok_or(AdmissionError::Clock)?,
            )
        } else {
            None
        };
        let crypto = if now >= self.crypto_until {
            Some(
                now.checked_add(self.limits.crypto_window_ms)
                    .ok_or(AdmissionError::Clock)?,
            )
        } else {
            None
        };
        if let Some(until) = failure {
            self.failure_until = until;
            self.failures = 0;
            self.sources.clear();
        }
        if let Some(until) = crypto {
            self.crypto_until = until;
            self.known_work = 0;
            self.known_keys.clear();
            self.enrollment_work = 0;
        }
        Ok(())
    }
    pub(crate) fn check(
        &self,
        source: Source,
        known_candidate: bool,
    ) -> Result<(), AdmissionError> {
        if known_candidate {
            return Ok(());
        }
        if self.failures >= self.limits.failures_global {
            return Err(AdmissionError::FailureQuota {
                scope: Scope::GlobalEnrollment,
                retry_at_ms: self.failure_until,
            });
        }
        if let Source::Direct(id) = source {
            if self.sources.get(&id).copied().unwrap_or(0) >= self.limits.failures_per_source {
                return Err(AdmissionError::FailureQuota {
                    scope: Scope::DirectSource,
                    retry_at_ms: self.failure_until,
                });
            }
        }
        Ok(())
    }
    pub(crate) fn crypto(
        &mut self,
        known_key: Option<&str>,
        length: usize,
    ) -> Result<(), AdmissionError> {
        // At most four work units for the 16 KiB HELLO cap. This is an operation/byte
        // bound, not a measured wall-clock CPU guarantee. Calls are serialized by &mut.
        let units = length.div_ceil(4096).max(1) as u32;
        if let Some(key) = known_key {
            let used = self.known_keys.get(key).copied().unwrap_or(0);
            if units > self.limits.known_key_units.saturating_sub(used) {
                return Err(AdmissionError::Saturated {
                    lane: Lane::KnownDevice,
                    retry_at_ms: self.crypto_until,
                });
            }
        }
        let (used, limit, lane) = if known_key.is_some() {
            (
                &mut self.known_work,
                self.limits.known_crypto_units,
                Lane::KnownCandidate,
            )
        } else {
            (
                &mut self.enrollment_work,
                self.limits.enrollment_crypto_units,
                Lane::Enrollment,
            )
        };
        if units > limit.saturating_sub(*used) {
            return Err(AdmissionError::Saturated {
                lane,
                retry_at_ms: self.crypto_until,
            });
        }
        *used += units;
        if let Some(key) = known_key {
            *self.known_keys.entry(key.to_owned()).or_default() += units;
        }
        Ok(())
    }
    pub(crate) fn malformed(&mut self) {
        self.totals.malformed = self.totals.malformed.saturating_add(1);
        self.totals.bad_hello = self.totals.bad_hello.saturating_add(1);
    }
    pub(crate) fn failed(&mut self, source: Source, known_candidate: bool, error: Error) {
        let field = match error {
            Error::BadToken => &mut self.totals.bad_token,
            Error::UnknownPhone => &mut self.totals.unknown_device,
            Error::Unauthorized => &mut self.totals.policy,
            _ => &mut self.totals.bad_hello,
        };
        *field = field.saturating_add(1);
        if known_candidate {
            self.totals.known_candidate = self.totals.known_candidate.saturating_add(1);
            return;
        }
        self.failures = self.failures.saturating_add(1);
        if let Source::Direct(id) = source {
            if self.sources.contains_key(&id) || self.sources.len() < self.limits.sources {
                let value = self.sources.entry(id).or_default();
                *value = value.saturating_add(1);
            } else {
                self.totals.untracked_source = self.totals.untracked_source.saturating_add(1);
            }
        }
    }
    pub(crate) fn status(&self, source: Source) -> Status {
        let direct = match source {
            Source::Direct(id) => self.sources.get(&id).copied().unwrap_or(0),
            Source::Relay => 0,
        };
        Status {
            failure_reset_ms: self.failure_until,
            crypto_reset_ms: self.crypto_until,
            enrollment_failures: self.failures,
            direct_source_failures: direct,
            global_enrollment_locked: self.failures >= self.limits.failures_global,
            direct_source_locked: direct >= self.limits.failures_per_source,
            source_entries: self.sources.len(),
            source_table_full: self.sources.len() >= self.limits.sources,
            known_units_remaining: self.limits.known_crypto_units - self.known_work,
            known_key_entries: self.known_keys.len(),
            enrollment_units_remaining: self.limits.enrollment_crypto_units - self.enrollment_work,
            failures: self.totals,
        }
    }
}
