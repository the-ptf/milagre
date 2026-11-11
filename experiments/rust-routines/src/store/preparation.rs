//! In-memory preparation only. There is no storage success flag or I/O phase here.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static IDENTITIES: AtomicU64 = AtomicU64::new(0);

fn reserve(counter: &AtomicU64) -> Result<u64> {
    counter
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
        .map(|n| n + 1)
        .map_err(|_| Error::Refused("model identity exhausted".into()))
}
pub(super) fn identity() -> Result<u64> {
    reserve(&IDENTITIES)
}

impl Model {
    pub(super) fn ready(&self) -> Result<()> {
        if matches!(self.phase, Phase::Ready) {
            Ok(())
        } else {
            refuse("model has an outstanding preparation")
        }
    }
    pub(super) fn preparing(&self) -> Result<Stamp> {
        match self.phase {
            Phase::Preparing(stamp)
                if stamp.origin == self.origin && stamp.generation == self.generation =>
            {
                Ok(stamp)
            }
            _ => refuse("model is not preparing this operation"),
        }
    }
    pub(super) fn prepare(&mut self, op: &str, args: &[Value], now: i64) -> Result<Stamp> {
        self.ready()?;
        let generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| Error::Refused("preparation generation exhausted".into()))?;
        let stamp = Stamp {
            origin: self.origin,
            generation,
        };
        // Reserve before dispatch: create consumes its first ID before transact.
        self.generation = generation;
        self.effects.clear();
        self.phase = Phase::Preparing(stamp);
        match self.dispatch(op, args, now) {
            Ok(candidate) => {
                debug_assert_eq!(candidate.stamp, stamp);
                self.phase = Phase::Pending(Box::new(candidate));
                Ok(stamp)
            }
            Err(error) => {
                self.phase = Phase::Ready;
                Err(error)
            }
        }
    }
    pub(super) fn no_write(&self, result: Value) -> Result<Candidate> {
        let stamp = self.preparing()?;
        limits::values(&[&result])?;
        Ok(Candidate {
            stamp,
            publication: None,
            maintained_at: self.maintained_at,
            result,
            effects: Vec::new(),
        })
    }
    fn candidate(&self, stamp: Stamp) -> Result<&Candidate> {
        if stamp.origin != self.origin || stamp.generation != self.generation {
            return refuse("preparation origin or generation does not match");
        }
        match &self.phase {
            Phase::Pending(candidate) if candidate.stamp == stamp => Ok(candidate),
            _ => refuse("preparation is not pending"),
        }
    }
    pub(super) fn pending_image(&self, stamp: Stamp) -> Result<Option<&str>> {
        Ok(self
            .candidate(stamp)?
            .publication
            .as_ref()
            .map(|p| p.image.as_str()))
    }
    pub(super) fn discard(&mut self, stamp: Stamp) -> Result<()> {
        self.candidate(stamp)?;
        // All candidates in this slice are pre-I/O. A future writer must retain its
        // native cleanup obligation rather than expose this as a post-rename escape.
        self.phase = Phase::Ready;
        Ok(())
    }
    pub(super) fn install(&mut self, stamp: Stamp) -> Result<Value> {
        self.candidate(stamp)?;
        let Phase::Pending(candidate) = std::mem::replace(&mut self.phase, Phase::Ready) else {
            unreachable!("checked pending phase under exclusive borrow")
        };
        let Candidate {
            publication,
            maintained_at,
            result,
            effects,
            ..
        } = *candidate;
        if let Some(publication) = publication {
            self.data = publication.data;
            self.positions = publication.positions;
            self.run_index = publication.run_index;
            self.tracked = publication.tracked;
            self.published = Some(publication.image);
            self.saves = publication.saves;
        }
        self.maintained_at = maintained_at;
        self.effects = effects;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_reservation_refuses_exhaustion_without_wrapping() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(reserve(&counter).unwrap(), u64::MAX);
        assert!(reserve(&counter).is_err());
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
    }
}
