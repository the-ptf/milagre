//! Non-abortable blocking jobs remain owned until completion, even when their async caller is cancelled.
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};
#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
}
#[derive(Default)]
pub(crate) struct Jobs {
    state: Mutex<State>,
    changed: Notify,
}
struct Completion(Arc<Jobs>);
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_one();
    }
}
impl Jobs {
    pub async fn run<T: Send + 'static>(self: &Arc<Self>, work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err("Blocking jobs stopped".into());
            }
            state.active += 1;
            let completion = Completion(self.clone());
            tokio::task::spawn_blocking(move || {
                let result = crate::supervisor::guarded_sync(work).unwrap_or_else(|_| Err("Blocking job panicked".into()));
                let _ = tx.send(result);
                drop(completion);
            });
        }
        rx.await.map_err(|_| "Blocking job stopped".to_owned())?
    }
    pub async fn close(&self) {
        self.state.lock().unwrap().closed = true;
        loop {
            if self.state.lock().unwrap().active == 0 {
                return;
            }
            self.changed.notified().await;
        }
    }
}
