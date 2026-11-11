//! Fixed physical slots: selection never relocates another device's queue entry.
use super::{FixedId, Submission, QUEUE_SLOTS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ticket {
    pub slot: usize,
    generation: u64,
}
#[derive(Clone, Copy)]
pub(super) struct Entry {
    pub device: [u8; 64],
    pub submission: Submission,
}
#[derive(Default)]
struct Slot {
    generation: u64,
    entry: Option<Entry>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    Full,
    Exhausted,
}
#[derive(Default)]
pub(super) struct Buckets {
    slots: [Slot; QUEUE_SLOTS],
    next: usize,
}
impl Buckets {
    pub fn len(&self) -> usize {
        self.entries().count()
    }
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.slots.iter().filter_map(|s| s.entry.as_ref())
    }
    pub fn contains(&self, id: FixedId) -> bool {
        self.entries().any(|e| e.submission.id == id)
    }
    pub fn contains_device(&self, device: [u8; 64]) -> bool {
        self.entries().any(|e| e.device == device)
    }
    pub fn admission(&self) -> Result<Ticket, Refusal> {
        // Start immediately behind the next visit. Never move occupied entries.
        for offset in 0..QUEUE_SLOTS {
            let slot = (self.next + QUEUE_SLOTS - 1 + offset) % QUEUE_SLOTS;
            if self.slots[slot].entry.is_none() {
                let generation = self.slots[slot]
                    .generation
                    .checked_add(1)
                    .ok_or(Refusal::Exhausted)?;
                return Ok(Ticket { slot, generation });
            }
        }
        Err(Refusal::Full)
    }
    pub fn insert(&mut self, ticket: Ticket, device: [u8; 64], submission: Submission) -> bool {
        if self.contains_device(device) {
            return false;
        }
        let Some(slot) = self.slots.get_mut(ticket.slot) else {
            return false;
        };
        if slot.entry.is_some() || slot.generation.checked_add(1) != Some(ticket.generation) {
            return false;
        }
        slot.generation = ticket.generation;
        slot.entry = Some(Entry { device, submission });
        true
    }
    pub fn ticket(&self, slot: usize) -> Ticket {
        Ticket {
            slot,
            generation: self.slots[slot].generation,
        }
    }
    pub fn visit(&mut self) -> Ticket {
        let ticket = self.ticket(self.next);
        self.next = (self.next + 1) % QUEUE_SLOTS;
        ticket
    }
    pub fn get(&self, ticket: Ticket) -> Option<&Entry> {
        self.slots
            .get(ticket.slot)
            .filter(|s| s.generation == ticket.generation)?
            .entry
            .as_ref()
    }
    pub fn take(&mut self, ticket: Ticket, id: FixedId) -> Option<Submission> {
        let slot = self.slots.get_mut(ticket.slot)?;
        if slot.generation != ticket.generation || slot.entry.as_ref()?.submission.id != id {
            return None;
        }
        slot.entry.take().map(|e| e.submission)
    }
    #[cfg(test)]
    pub fn exhaust_next_vacancy(&mut self) {
        let ticket = self.admission().unwrap();
        self.slots[ticket.slot].generation = u64::MAX;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistent_supervisor::fixed::FixedOutcome;
    fn submission(n: u16) -> Submission {
        Submission {
            id: FixedId {
                scope: [0; 16],
                slot: n,
                generation: 1,
            },
            outcome: FixedOutcome::Success,
        }
    }
    #[test]
    fn vacancies_start_behind_cursor_and_occupied_slots_never_move() {
        let mut q = Buckets::default();
        let a = q.admission().unwrap();
        assert_eq!(a.slot, 15);
        assert!(q.insert(a, [1; 64], submission(1)));
        for expected in 0..16 {
            let visited = q.visit();
            assert_eq!(visited.slot, expected);
            assert_eq!(q.get(a).unwrap().submission.id, submission(1).id);
            if expected != 15 {
                let b = q.admission().unwrap();
                assert_eq!(b.slot, expected);
                assert!(q.insert(b, [2; 64], submission(2)));
                assert!(q.take(b, submission(2).id).is_some());
            }
        }
    }
    #[test]
    fn full_and_reuse_refuse_stale_tickets_before_any_mutation() {
        let mut q = Buckets::default();
        let old = q.admission().unwrap();
        assert!(q.insert(old, [0; 64], submission(0)));
        assert!(q.take(old, submission(0).id).is_some());
        let fresh = q.admission().unwrap();
        assert_eq!(fresh.slot, old.slot);
        assert_ne!(fresh, old);
        assert!(q.insert(fresh, [0; 64], submission(0))); // Same ID cannot bypass reuse generation.
        assert!(q.take(old, submission(0).id).is_none());
        assert!(!q.insert(old, [1; 64], submission(1)));
        for n in 1..16 {
            assert!(q.insert(q.admission().unwrap(), [n as u8; 64], submission(n)));
        }
        assert_eq!(q.len(), 16);
        assert_eq!(q.admission(), Err(Refusal::Full));
        assert_eq!(q.get(fresh).unwrap().submission.id, submission(0).id);
    }
    #[test]
    fn exhausted_vacancy_never_wraps_or_installs_partial_entry() {
        let mut q = Buckets::default();
        let ticket = q.admission().unwrap();
        q.exhaust_next_vacancy();
        assert_eq!(q.admission(), Err(Refusal::Exhausted));
        assert!(!q.insert(ticket, [1; 64], submission(1)));
        assert_eq!(q.len(), 0);
        assert_eq!(q.visit().slot, 0);
    }
}
