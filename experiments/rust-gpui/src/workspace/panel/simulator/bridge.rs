//! The seams a real host connection plugs into: [`SimulatorBridge`] (the `simulators.*` RPCs of
//! `shared/simulator.ts` `SimulatorApi`, scoped to one Chat) and [`FrameSource`] (the video of one open viewer).
//!
//! Both return boxed futures so a daemon client can answer asynchronously; the fixture answers at once. The view
//! polls each future once before spawning it ([`now_or_later`]), so a bridge that answers at once draws in the
//! same frame (what snapshot mode needs) and one that does not is awaited on the foreground executor.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll, Waker};

use super::types::{EncodedFrame, Input, Opened, SimulatorList, Status};

pub type BridgeFuture<T> = Pin<Box<dyn Future<Output = anyhow::Result<T>>>>;

/// The host's simulator API for one window. Every call names the Chat or the viewer it acts on, as the
/// desktop's capability-scoped bridge does (`createSimulatorBridge`): a viewer id is only ever one `open` returned.
pub trait SimulatorBridge {
    /// `simulators.list`: running devices, those attached to `chat`, and the others it may attach.
    fn list(&self, chat: &str) -> BridgeFuture<SimulatorList>;
    fn attach(&self, chat: &str, device: &str) -> BridgeFuture<SimulatorList>;
    fn detach(&self, chat: &str, device: &str) -> BridgeFuture<SimulatorList>;
    /// Opens a viewer on `device` for `chat`. One viewer per view at a time; the view closes it before reopening.
    fn open(&self, chat: &str, device: &str) -> BridgeFuture<Opened>;
    fn status(&self, viewer: &str) -> BridgeFuture<Status>;
    /// Asks for input control; `take_over` takes it from another viewer.
    fn control(&self, viewer: &str, take_over: bool) -> BridgeFuture<Status>;
    /// Sends one input event. `false` means the host refused it (stale generation, lost control): the view
    /// drops what it queued and reads the status again.
    fn input(&self, viewer: &str, sequence: u64, generation: u64, event: Input) -> BridgeFuture<bool>;
    /// Restarts the simulator's input, closing its running apps (iOS). Every viewer of the device reopens.
    fn repair(&self, viewer: &str) -> BridgeFuture<()>;
    fn close(&self, viewer: &str) -> BridgeFuture<()>;
    /// The video of an open viewer.
    fn frames(&self, opened: &Opened) -> Box<dyn FrameSource>;
}

/// One viewer's video. The frame relay pulls (`simulators.frame` with `after`), never pushed; a WebRTC or H.264
/// receiver implements the same trait and hands back decoded-ready payloads (see `frames.rs`).
pub trait FrameSource {
    /// The first frame after `after`, or `None` when none is newer yet.
    fn next(&mut self, after: u64) -> BridgeFuture<Option<EncodedFrame>>;
}

/// Polls `future` once: its output if it is already done, else the future to await.
pub fn now_or_later<T>(mut future: BridgeFuture<T>) -> Result<anyhow::Result<T>, BridgeFuture<T>> {
    match future.as_mut().poll(&mut TaskContext::from_waker(Waker::noop())) {
        Poll::Ready(value) => Ok(value),
        Poll::Pending => Err(future),
    }
}
