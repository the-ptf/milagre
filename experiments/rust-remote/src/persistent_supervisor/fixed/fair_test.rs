//! Test-only round barriers. No scheduling or acceptance authority.
use super::*;
#[derive(Default)]
struct Turns {
    entered: usize,
    released: usize,
    open: bool,
}
#[derive(Default)]
pub(crate) struct FairTest {
    turns: Mutex<Turns>,
    changed: Condvar,
    pub visits: Mutex<Vec<(usize, Option<FixedId>)>>,
}
impl FairTest {
    pub fn before_round(&self) {
        let mut turns = self.turns.lock().unwrap();
        turns.entered += 1;
        self.changed.notify_all();
        while !turns.open && turns.released < turns.entered {
            turns = self.changed.wait(turns).unwrap();
        }
    }
    pub fn entered(&self) -> usize {
        self.turns.lock().unwrap().entered
    }
    pub fn release(&self) {
        self.turns.lock().unwrap().released += 1;
        self.changed.notify_all();
    }
    pub fn open(&self) {
        self.turns.lock().unwrap().open = true;
        self.changed.notify_all();
    }
    pub fn record(&self, slot: usize, id: Option<FixedId>) {
        self.visits.lock().unwrap().push((slot, id));
    }
}
