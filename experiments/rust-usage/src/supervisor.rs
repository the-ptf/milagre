//! Tracked callback tasks. Dropped callers do not cancel shared work; shutdown aborts tasks and waits for callback futures to drop.
use std::{
    collections::HashMap,
    future::{poll_fn, Future},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex, Weak},
    task::Poll,
};
use tokio::{sync::watch, task::JoinHandle};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskError {
    Stopped,
    Panicked,
}
pub type Receiver<T> = watch::Receiver<Option<Result<T, TaskError>>>;
#[derive(Default)]
struct State {
    closed: bool,
    next: u64,
    tasks: HashMap<u64, JoinHandle<()>>,
    changed: Arc<tokio::sync::Notify>,
}
#[derive(Default)]
pub struct Supervisor {
    state: Arc<Mutex<State>>,
    shutdown: tokio::sync::Mutex<()>,
}
struct Completion<T: Clone> {
    id: u64,
    state: Weak<Mutex<State>>,
    tx: watch::Sender<Option<Result<T, TaskError>>>,
}
impl<T: Clone> Drop for Completion<T> {
    fn drop(&mut self) {
        if self.tx.borrow().is_none() {
            self.tx.send_replace(Some(Err(TaskError::Stopped)));
        }
        if let Some(s) = self.state.upgrade() {
            let mut state = s.lock().unwrap();
            state.tasks.remove(&self.id);
            state.changed.notify_one();
        }
    }
}
pub async fn guarded<T>(future: impl Future<Output = T>) -> Result<T, TaskError> {
    let mut future = Box::pin(future);
    poll_fn(move |cx| match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
        Ok(Poll::Ready(v)) => Poll::Ready(Ok(v)),
        Ok(Poll::Pending) => Poll::Pending,
        Err(_) => Poll::Ready(Err(TaskError::Panicked)),
    })
    .await
}
pub fn guarded_sync<T>(f: impl FnOnce() -> T) -> Result<T, TaskError> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|_| TaskError::Panicked)
}
impl Supervisor {
    pub fn spawn<T: Clone + Send + Sync + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
    ) -> Result<Receiver<T>, TaskError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(TaskError::Stopped);
        }
        state.next += 1;
        let id = state.next;
        let (tx, rx) = watch::channel(None);
        let completion = Completion { id, state: Arc::downgrade(&self.state), tx };
        let handle = tokio::spawn(async move {
            let result = guarded(future).await;
            completion.tx.send_replace(Some(result));
            drop(completion);
        });
        state.tasks.insert(id, handle);
        Ok(rx)
    }
    pub async fn run<T: Clone + Send + Sync + 'static>(&self, future: impl Future<Output = T> + Send + 'static) -> Result<T, TaskError> {
        wait(self.spawn(future)?).await
    }
    pub fn active(&self) -> usize {
        self.state.lock().unwrap().tasks.len()
    }
    pub fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        for task in state.tasks.values() {
            task.abort();
        }
    }
    pub async fn shutdown(&self) {
        let _serial = self.shutdown.lock().await;
        let changed = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            for task in state.tasks.values() {
                task.abort();
            }
            state.changed.clone()
        };
        // Keep handles registered until completion, even if this shutdown caller is cancelled.
        // Completion drops only after the callback future has been dropped.
        loop {
            if self.state.lock().unwrap().tasks.is_empty() {
                return;
            }
            changed.notified().await;
        }
    }
}
pub async fn wait<T: Clone>(mut rx: Receiver<T>) -> Result<T, TaskError> {
    loop {
        if let Some(v) = rx.borrow().clone() {
            return v;
        }
        if rx.changed().await.is_err() {
            return Err(TaskError::Stopped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_shutdown_keeps_tracking_until_callback_drops() {
        let supervisor = Supervisor::default();
        let (started, entered) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Mark(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Mark {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let mark = Mark(dropped.clone());
        let result = supervisor
            .spawn(async move {
                let _mark = mark;
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            })
            .unwrap();
        entered.await.unwrap();
        let mut shutdown = Box::pin(supervisor.shutdown());
        assert!(poll_fn(|cx| Poll::Ready(shutdown.as_mut().poll(cx))).await.is_pending());
        drop(shutdown);
        assert_eq!(supervisor.active(), 1);
        supervisor.shutdown().await;
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(supervisor.active(), 0);
        assert_eq!(wait(result).await, Err(TaskError::Stopped));
    }
}
