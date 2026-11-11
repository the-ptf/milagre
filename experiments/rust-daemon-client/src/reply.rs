//! Small executor-independent one-shot. Dropping the receiver cancels only its local wait.
use crate::{Error, Result};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

struct State<T> {
    value: Option<Result<T>>,
    waker: Option<Waker>,
}
pub(crate) struct Sender<T>(Arc<Mutex<State<T>>>);
pub(crate) struct Receiver<T>(Arc<Mutex<State<T>>>);

pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let state = Arc::new(Mutex::new(State {
        value: None,
        waker: None,
    }));
    (Sender(state.clone()), Receiver(state))
}
impl<T> Sender<T> {
    pub(crate) fn send(self, value: Result<T>) {
        let waker = {
            let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            state.value = Some(value);
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}
impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        let waker = {
            let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if state.value.is_none() {
                state.value = Some(Err(Error::Disconnected));
            }
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}
impl<T> Future for Receiver<T> {
    type Output = Result<T>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(value) = state.value.take() {
            Poll::Ready(value)
        } else {
            state.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
