use std::sync::{Arc, Mutex};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExternalHealth {
    /// Threads that still retain an external execution permit.
    pub in_flight: usize,
    /// In-flight threads whose caller already timed out or cancelled.
    pub unobserved: usize,
}
#[derive(Default)]
pub(crate) struct Health(Mutex<ExternalHealth>);
impl Health {
    pub(crate) fn snapshot(&self) -> ExternalHealth {
        *self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub(crate) fn start(self: &Arc<Self>) -> Arc<Ticket> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).in_flight += 1;
        Arc::new(Ticket {
            health: self.clone(),
            state: Mutex::new((true, false)),
        })
    }
}
pub(crate) struct Ticket {
    health: Arc<Health>,
    state: Mutex<(bool, bool)>,
}
impl Ticket {
    pub(crate) fn unobserved(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.0 && !state.1 {
            state.1 = true;
            self.health
                .0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .unobserved += 1;
        }
    }
    pub(crate) fn finish(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.0 {
            state.0 = false;
            let mut health = self.health.0.lock().unwrap_or_else(|p| p.into_inner());
            health.in_flight -= 1;
            if state.1 {
                health.unobserved -= 1;
            }
        }
    }
}
