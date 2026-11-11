//! The Simulator tab: the iOS simulator or Android emulator attached to the Chat, live, with touch, button and
//! key input. The desktop's `agents/SimulatorTrack.tsx` (device list, attach, detach) and the receiver page it
//! hosts in an iframe, `shared/simulator-receiver.mjs` (stream, letterbox geometry, input, connection states).
//!
//! - [`SimulatorView`] holds the device list and one viewer session; `render.rs` draws it.
//! - Everything it asks the host goes through [`bridge::SimulatorBridge`]; video comes from a
//!   [`bridge::FrameSource`]. The fixture (`fixture.rs`) answers both with three PNG frames.
//! - The session logic is the receiver's: open, pull frames every 67 ms, poll status every second, claim control
//!   once ready, one input RPC in flight, rotate waits for the next display generation, bounded reconnects after a
//!   failure, pause while not on screen and reconnect when shown.
//!
//! Not ported: WebRTC and H.264 (`video/avcc`) receivers (the desktop's two other transports), the foldable
//! pose and hinge controls, Simlock leasing. The toolbar adds Pause, Copy screenshot and Detach to the receiver's
//! "More" row.

pub mod bridge;
pub mod fixture;
pub mod frames;
pub mod geometry;
pub mod input;
mod render;
pub mod types;

#[cfg(test)]
mod tests;

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{Bounds, ClipboardItem, Context, EventEmitter, FocusHandle, Pixels, RenderImage, SharedString, Task};

use self::bridge::{BridgeFuture, FrameSource, SimulatorBridge, now_or_later};
use self::fixture::{FixtureBridge, Scenario};
use self::frames::Picture;
use self::geometry::{STAGE_INSET, corner_share};
use self::input::{InputQueue, TOO_SLOW};
use self::types::{
    Connection, Device, EncodedFrame, HardwareButton, Input, KeyPhase, Opened, ScreenPoint, SimulatorList, Status, TouchPhase,
};

/// The frame relay's pull interval (about 15 frames a second).
const FRAME_INTERVAL: Duration = Duration::from_millis(67);
const STATUS_INTERVAL: Duration = Duration::from_secs(1);
/// While a device is attached the list is read again: devices boot and stop on their own.
const LIST_INTERVAL: Duration = Duration::from_secs(5);
const CONNECT_DEADLINE: Duration = Duration::from_secs(45);
const ROTATE_DEADLINE: Duration = Duration::from_secs(8);
const REPAIR_CONFIRM: Duration = Duration::from_secs(6);
const COPIED_FOR: Duration = Duration::from_millis(1500);
const MAX_RECONNECTS: u32 = 5;

/// What the panel hears: how many devices the Chat has attached (the tab shows only while there is one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimulatorEvent {
    Attached(usize),
}

impl EventEmitter<SimulatorEvent> for SimulatorView {}

pub struct SimulatorView {
    bridge: Rc<dyn SimulatorBridge>,
    chat: SharedString,
    list: SimulatorList,
    list_error: Option<SharedString>,
    loading: bool,
    /// The device on screen; `None` shows the device list.
    selected: Option<Device>,
    attaching: bool,
    busy: bool,
    list_timer: Option<Task<()>>,

    // One viewer session, as the receiver keeps it. `epoch` changes on every stop, so late answers are dropped.
    epoch: u64,
    active: bool,
    error: Option<SharedString>,
    opened: Option<Opened>,
    source: Option<Box<dyn FrameSource>>,
    status: Option<Status>,
    last_capture: Option<Status>,
    frames: bool,
    painted_generation: Option<u64>,
    rotating_generation: Option<u64>,
    claiming: bool,
    tried_control: bool,
    repairing: bool,
    confirm_repair: bool,
    sequence: u64,
    after: u64,
    queue: InputQueue,
    reconnects: u32,
    last_frame: Option<EncodedFrame>,
    picture: Option<Picture>,
    /// Pictures replaced since the last paint, dropped from the sprite atlas once the new one is up.
    stale: Vec<Arc<RenderImage>>,
    frame_timer: Option<Task<()>>,
    heartbeat: Option<Task<()>>,
    deadline: Option<Task<()>>,
    reconnect_timer: Option<Task<()>>,
    rotation_timer: Option<Task<()>>,
    confirm_timer: Option<Task<()>>,
    copied_timer: Option<Task<()>>,

    // Hidden-pause: a frame that was not painted before the next one arrived means the tab is not on screen.
    pause_when_hidden: bool,
    awaiting_paint: bool,
    hidden_paused: bool,

    // What the user sees and does.
    extras_open: bool,
    copied: bool,
    touch: Option<ScreenPoint>,
    stage: Bounds<Pixels>,
    viewer_height: Pixels,
    focus: FocusHandle,
    /// The rail's glyphs, by glyph and colour.
    glyphs: std::cell::RefCell<std::collections::HashMap<(render::Glyph, u32), Arc<RenderImage>>>,
    /// `MILAGRE_GPUI_SIMULATOR_STATE` for a snapshot, applied once the first list arrives.
    snapshot_state: Option<String>,
    renders: usize,
}

impl SimulatorView {
    /// A view over `bridge`. Pick a Chat with [`SimulatorView::set_chat`].
    pub fn new(bridge: Rc<dyn SimulatorBridge>, cx: &mut Context<Self>) -> Self {
        Self {
            bridge,
            chat: SharedString::default(),
            list: SimulatorList { supported: true, ..SimulatorList::default() },
            list_error: None,
            loading: true,
            selected: None,
            attaching: false,
            busy: false,
            list_timer: None,
            epoch: 0,
            active: false,
            error: None,
            opened: None,
            source: None,
            status: None,
            last_capture: None,
            frames: false,
            painted_generation: None,
            rotating_generation: None,
            claiming: false,
            tried_control: false,
            repairing: false,
            confirm_repair: false,
            sequence: 0,
            after: 0,
            queue: InputQueue::default(),
            reconnects: 0,
            last_frame: None,
            picture: None,
            stale: Vec::new(),
            frame_timer: None,
            heartbeat: None,
            deadline: None,
            reconnect_timer: None,
            rotation_timer: None,
            confirm_timer: None,
            copied_timer: None,
            pause_when_hidden: !cfg!(test) && std::env::var_os("MILAGRE_GPUI_SNAPSHOT").is_none(),
            awaiting_paint: false,
            hidden_paused: false,
            extras_open: false,
            copied: false,
            touch: None,
            stage: Bounds::default(),
            viewer_height: Pixels::ZERO,
            focus: cx.focus_handle(),
            glyphs: Default::default(),
            snapshot_state: None,
            renders: 0,
        }
    }

    /// The panel's view over the fixture. `attach_at_start` picks the Chats that start with the iPhone attached;
    /// `MILAGRE_GPUI_SIMULATOR_STATE` (live, connecting, view-only, error, offline, landscape, paused, list, more)
    /// picks what a snapshot shows.
    pub fn fixture(attach_at_start: impl Fn(&str) -> bool + 'static, cx: &mut Context<Self>) -> Self {
        let state = if cfg!(test) { None } else { std::env::var("MILAGRE_GPUI_SIMULATOR_STATE").ok() };
        let scenario = state.as_deref().and_then(Scenario::from_name).unwrap_or_default();
        let mut view = Self::new(Rc::new(FixtureBridge::new(scenario, attach_at_start)), cx);
        view.snapshot_state = state;
        view
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn attached_count(&self) -> usize {
        self.list.attached.len()
    }

    pub fn selected(&self) -> Option<&Device> {
        self.selected.as_ref()
    }

    pub fn status(&self) -> Option<&Status> {
        self.status.as_ref()
    }

    pub fn extras_open(&self) -> bool {
        self.extras_open
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Lets a test turn the hidden-pause on (it is off under `cfg(test)`, where nothing paints between pulls).
    #[cfg(test)]
    pub fn set_pause_when_hidden(&mut self, on: bool) {
        self.pause_when_hidden = on;
    }

    /// The header's state, after the receiver's `render()`.
    pub fn connection(&self) -> Connection {
        if self.is_offline() {
            return Connection::Offline;
        }
        if !self.active {
            return if self.error.is_some() { Connection::Error } else { Connection::Paused };
        }
        if !(self.display_ready() && !self.repairing) {
            let repainting = self.frames && self.status.as_ref().is_some_and(|s| self.painted_generation != Some(s.display_generation()));
            return if self.rotating_generation.is_some() || repainting { Connection::Rotating } else { Connection::Connecting };
        }
        if self.status.as_ref().is_some_and(|s| s.controlling) { Connection::Live } else { Connection::ViewOnly }
    }

    /// The selected device is attached but not running.
    fn is_offline(&self) -> bool {
        !self.loading && self.selected.as_ref().is_some_and(|device| !self.list.is_running(&device.id))
    }

    fn display_ready(&self) -> bool {
        self.active
            && self.frames
            && self.status.as_ref().is_some_and(|status| status.ready && self.painted_generation == Some(status.display_generation()))
    }

    /// Ready and holding control: what every input waits for.
    fn controllable(&self) -> bool {
        self.display_ready() && !self.repairing && self.status.as_ref().is_some_and(|s| s.controlling)
    }

    /// The capture the layout uses: the live status, else the last one, else an iPhone's 390 by 844.
    fn capture(&self) -> Status {
        self.status.clone().filter(|s| s.width > 0 && s.height > 0).or_else(|| self.last_capture.clone()).unwrap_or(Status {
            width: 390,
            height: 844,
            ..Status::default()
        })
    }

    fn geometry(&self) -> Option<geometry::Geometry> {
        geometry::geometry(&self.capture(), f32::from(self.stage.size.width), f32::from(self.stage.size.height), STAGE_INSET)
    }

    // ---------------------------------------------------------------------------------------------------------
    // Async plumbing

    /// Runs `future`, then `done` on this view: at once when the bridge answered at once, else when it does.
    fn call<T: 'static>(
        &mut self,
        future: BridgeFuture<T>,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, anyhow::Result<T>, &mut Context<Self>) + 'static,
    ) {
        match now_or_later(future) {
            Ok(value) => done(self, value, cx),
            Err(future) => cx
                .spawn(async move |this, cx| {
                    let value = future.await;
                    this.update(cx, |this, cx| done(this, value, cx)).ok();
                })
                .detach(),
        }
    }

    /// `f` after `delay`, unless the returned task is dropped first.
    fn after(&self, delay: Duration, cx: &mut Context<Self>, f: impl FnOnce(&mut Self, &mut Context<Self>) + 'static) -> Task<()> {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| f(this, cx)).ok();
        })
    }

    // ---------------------------------------------------------------------------------------------------------
    // Device list

    /// Shows `chat`'s simulators: closes the viewer on screen and reads the list again.
    pub fn set_chat(&mut self, chat: impl Into<SharedString>, cx: &mut Context<Self>) {
        let chat = chat.into();
        if chat == self.chat && !self.loading {
            return;
        }
        self.stop(cx);
        self.chat = chat;
        self.selected = None;
        self.attaching = false;
        self.loading = true;
        self.list = SimulatorList { supported: true, ..SimulatorList::default() };
        self.refresh_list(cx);
        self.list_timer = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(LIST_INTERVAL).await;
                let polled = this.update(cx, |this, cx| {
                    if this.attached_count() > 0 {
                        this.refresh_list(cx);
                    }
                });
                if polled.is_err() {
                    break;
                }
            }
        }));
        self.apply_snapshot_state(cx);
    }

    /// The states a snapshot asks for that a scenario alone does not give.
    fn apply_snapshot_state(&mut self, cx: &mut Context<Self>) {
        match self.snapshot_state.take().as_deref() {
            Some("paused") => self.toggle_pause(cx),
            Some("list") => self.show_list(cx),
            Some("attach") => {
                self.show_list(cx);
                self.attaching = true;
            }
            Some("more") => self.extras_open = true,
            _ => {}
        }
    }

    pub fn refresh_list(&mut self, cx: &mut Context<Self>) {
        let chat = self.chat.clone();
        let future = self.bridge.list(&chat);
        self.call(future, cx, move |this, result, cx| {
            if this.chat != chat {
                return;
            }
            this.loading = false;
            match result {
                Ok(list) => this.accept_list(list, cx),
                Err(error) => this.list_error = Some(error.to_string().into()),
            }
            cx.notify();
        });
    }

    fn accept_list(&mut self, list: SimulatorList, cx: &mut Context<Self>) {
        let first = self.list.devices.is_empty() && self.list.attached.is_empty() && self.selected.is_none();
        let was_offline = self.is_offline();
        self.list = list;
        self.list_error = None;
        cx.emit(SimulatorEvent::Attached(self.list.attached.len()));
        // A device detached elsewhere leaves the viewer.
        if let Some(device) = &self.selected
            && !self.list.attached.iter().any(|d| d.id == device.id)
        {
            self.stop(cx);
            self.selected = None;
        }
        // The Chat's only device opens on its own (the desktop's docked viewer); several show the list.
        if first && self.selected.is_none() && self.list.attached.len() == 1 {
            self.select(self.list.attached[0].clone(), cx);
            return;
        }
        match (was_offline, self.is_offline()) {
            (false, true) => self.stop(cx),
            (true, false) => self.start(cx),
            _ => {}
        }
    }

    /// Opens `device`'s viewer.
    pub fn select(&mut self, device: Device, cx: &mut Context<Self>) {
        self.attaching = false;
        self.selected = Some(device);
        self.reconnects = 0;
        self.start(cx);
    }

    /// Back to the device list (the device name's chevron).
    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
        self.selected = None;
        self.extras_open = false;
        cx.notify();
    }

    pub fn set_attaching(&mut self, attaching: bool, cx: &mut Context<Self>) {
        self.attaching = attaching;
        cx.notify();
    }

    pub fn attach(&mut self, device: Device, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        let future = self.bridge.attach(&self.chat, &device.id);
        self.call(future, cx, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(list) => {
                    this.list = list;
                    cx.emit(SimulatorEvent::Attached(this.list.attached.len()));
                    this.select(device, cx);
                }
                Err(error) => this.list_error = Some(error.to_string().into()),
            }
            cx.notify();
        });
    }

    /// Detach from the Chat. With nothing left attached, the panel drops the tab.
    pub fn detach(&mut self, device: Device, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        if self.selected.as_ref().is_some_and(|d| d.id == device.id) {
            self.stop(cx);
            self.selected = None;
            self.extras_open = false;
        }
        let future = self.bridge.detach(&self.chat, &device.id);
        self.call(future, cx, move |this, result, cx| {
            this.busy = false;
            match result {
                Ok(list) => {
                    this.list = list;
                    cx.emit(SimulatorEvent::Attached(this.list.attached.len()));
                }
                Err(error) => this.list_error = Some(error.to_string().into()),
            }
            cx.notify();
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // Session: the receiver's start, stop, fail, acceptStatus, claim

    /// Opens a viewer on the selected device (and closes any open one first).
    pub fn start(&mut self, cx: &mut Context<Self>) {
        self.stop(cx);
        let Some(device) = self.selected.clone() else { return };
        if self.is_offline() {
            cx.notify();
            return;
        }
        self.active = true;
        self.error = None;
        self.hidden_paused = false;
        let epoch = self.epoch;
        self.deadline = Some(self.after(CONNECT_DEADLINE, cx, move |this, cx| {
            if this.epoch == epoch && !this.display_ready() {
                this.fail("Video or input could not connect. Check that the simulator is running and retry.", cx);
            }
        }));
        let future = self.bridge.open(&self.chat, &device.id);
        self.call(future, cx, move |this, result, cx| {
            let opened = match result {
                Ok(opened) => opened,
                Err(error) if this.epoch == epoch => return this.fail(&error.to_string(), cx),
                Err(_) => return,
            };
            if this.epoch != epoch || !this.active {
                let close = this.bridge.close(&opened.viewer);
                this.call(close, cx, |_, _, _| {});
                return;
            }
            this.source = Some(this.bridge.frames(&opened));
            this.opened = Some(opened);
            this.pull(epoch, cx);
            this.poll(epoch, cx);
            this.heartbeat = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(STATUS_INTERVAL).await;
                    if this.update(cx, |this, cx| this.poll(epoch, cx)).is_err() {
                        break;
                    }
                }
            }));
            cx.notify();
        });
        cx.notify();
    }

    /// Closes the viewer and drops everything the session holds. Late answers carry the old epoch and are ignored.
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        self.epoch += 1;
        self.active = false;
        self.frames = false;
        self.painted_generation = None;
        self.rotating_generation = None;
        self.claiming = false;
        self.tried_control = false;
        self.confirm_repair = false;
        self.sequence = 0;
        self.after = 0;
        self.queue = InputQueue::default();
        self.touch = None;
        self.status = None;
        self.source = None;
        self.awaiting_paint = false;
        for task in [&mut self.frame_timer, &mut self.heartbeat, &mut self.deadline, &mut self.rotation_timer, &mut self.confirm_timer] {
            *task = None;
        }
        self.reconnect_timer = None;
        if let Some(picture) = self.picture.take() {
            self.stale.push(picture.image);
        }
        if let Some(opened) = self.opened.take() {
            let close = self.bridge.close(&opened.viewer);
            self.call(close, cx, |_, _, _| {});
        }
        cx.notify();
    }

    /// Ends the session with `message` and reconnects with backoff (1, 2, 4, 8, 15 s), at most five times.
    fn fail(&mut self, message: &str, cx: &mut Context<Self>) {
        self.stop(cx);
        self.error = Some(SharedString::from(message.to_string()));
        self.extras_open = true;
        if self.reconnects < MAX_RECONNECTS {
            let delay = Duration::from_millis((1000u64 << self.reconnects).min(15_000));
            self.reconnects += 1;
            self.reconnect_timer = Some(self.after(delay, cx, |this, cx| {
                this.reconnect_timer = None;
                this.start(cx);
            }));
        }
        cx.notify();
    }

    fn accept_status(&mut self, mut value: Status, cx: &mut Context<Self>) {
        if self.status.as_ref().is_some_and(|s| s.generation > value.generation) {
            return;
        }
        if let Some(rotating) = self.rotating_generation {
            if value.generation == rotating || !value.ready {
                value.ready = false;
            } else {
                self.rotating_generation = None;
                self.rotation_timer = None;
            }
        }
        if self.status.as_ref().is_some_and(|s| s.generation != value.generation || s.controlling != value.controlling) {
            self.queue.clear();
            self.touch = None;
        }
        if value.width > 0 && value.height > 0 {
            self.last_capture = Some(value.clone());
        }
        let ready = value.ready;
        self.status = Some(value);
        if self.display_ready() {
            self.reconnects = 0;
            self.deadline = None;
        }
        if ready && !self.tried_control {
            self.tried_control = true;
            self.claim(false, cx);
        }
        cx.notify();
    }

    /// Asks for control: once without taking it when the display is ready, and with `take_over` from Take control.
    pub fn claim(&mut self, take_over: bool, cx: &mut Context<Self>) {
        let Some(viewer) = self.opened.as_ref().map(|o| o.viewer.clone()) else { return };
        let epoch = self.epoch;
        self.claiming = true;
        let future = self.bridge.control(&viewer, take_over);
        self.call(future, cx, move |this, result, cx| {
            if this.epoch != epoch {
                return;
            }
            this.claiming = false;
            match result {
                Ok(status) => this.accept_status(status, cx),
                Err(error) => this.fail(&error.to_string(), cx),
            }
        });
        cx.notify();
    }

    fn poll(&mut self, epoch: u64, cx: &mut Context<Self>) {
        if epoch != self.epoch || self.repairing {
            return;
        }
        let Some(viewer) = self.opened.as_ref().map(|o| o.viewer.clone()) else { return };
        let future = self.bridge.status(&viewer);
        self.call(future, cx, move |this, result, cx| {
            if this.epoch != epoch || this.repairing {
                return;
            }
            match result {
                Ok(status) => this.accept_status(status, cx),
                Err(error) => this.fail(&error.to_string(), cx),
            }
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // Frames

    fn pull(&mut self, epoch: u64, cx: &mut Context<Self>) {
        if epoch != self.epoch || self.repairing {
            return;
        }
        let Some(source) = self.source.as_mut() else { return };
        let future = source.next(self.after);
        self.call(future, cx, move |this, result, cx| {
            if this.epoch != epoch || this.repairing {
                return;
            }
            match result {
                Err(error) => this.fail(&error.to_string(), cx),
                Ok(None) => this.schedule_pull(epoch, cx),
                Ok(Some(frame)) if frame.sequence <= this.after => this.fail("Invalid simulator frame.", cx),
                Ok(Some(frame)) => this.decode(epoch, frame, cx),
            }
        });
    }

    fn schedule_pull(&mut self, epoch: u64, cx: &mut Context<Self>) {
        self.frame_timer = Some(self.after(FRAME_INTERVAL, cx, move |this, cx| this.pull(epoch, cx)));
    }

    /// The first frame decodes at once (so it is up in the same frame, as a snapshot needs); later ones decode on
    /// a background thread.
    fn decode(&mut self, epoch: u64, frame: EncodedFrame, cx: &mut Context<Self>) {
        let rotation = geometry::rotation(&frame.status);
        if self.picture.is_none() {
            let picture = frames::decode(&frame.data, rotation);
            return self.show(epoch, frame, picture, cx);
        }
        let data = frame.data.clone();
        let decoded = cx.background_executor().spawn(async move { frames::decode(&data, rotation) });
        cx.spawn(async move |this, cx| {
            let picture = decoded.await;
            this.update(cx, |this, cx| this.show(epoch, frame, picture, cx)).ok();
        })
        .detach();
    }

    fn show(&mut self, epoch: u64, frame: EncodedFrame, picture: anyhow::Result<Picture>, cx: &mut Context<Self>) {
        if self.epoch != epoch || self.repairing {
            return;
        }
        let picture = match picture {
            Ok(picture) => picture,
            Err(error) => return self.fail(&error.to_string(), cx),
        };
        // The last frame never reached the screen: the tab is hidden. Pause like the receiver does in a hidden page.
        if self.pause_when_hidden && self.awaiting_paint {
            self.stop(cx);
            self.hidden_paused = true;
            return;
        }
        if let Some(old) = self.picture.replace(picture) {
            self.stale.push(old.image);
        }
        self.awaiting_paint = true;
        self.after = frame.sequence;
        self.frames = true;
        self.painted_generation = Some(frame.status.display_generation());
        let status = frame.status.clone();
        self.last_frame = Some(frame);
        self.accept_status(status, cx);
        self.schedule_pull(epoch, cx);
    }

    /// Called as the stage paints: the picture is on screen, and the stage has this size.
    fn painted(&mut self, stage: Bounds<Pixels>, viewer_height: Pixels, cx: &mut Context<Self>) {
        self.awaiting_paint = false;
        if !self.stale.is_empty() {
            for image in std::mem::take(&mut self.stale) {
                cx.drop_image(image, None);
            }
        }
        if stage != self.stage || viewer_height != self.viewer_height {
            self.stage = stage;
            self.viewer_height = viewer_height;
            cx.notify();
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Input

    fn send(&mut self, event: Input, cx: &mut Context<Self>) {
        if self.queue.push(event).is_err() {
            return self.fail(TOO_SLOW, cx);
        }
        self.drain(cx);
    }

    fn drain(&mut self, cx: &mut Context<Self>) {
        let (Some(viewer), Some(generation)) = (self.opened.as_ref().map(|o| o.viewer.clone()), self.status.as_ref().map(|s| s.generation))
        else {
            return;
        };
        let Some(event) = self.queue.take() else { return };
        let epoch = self.epoch;
        self.sequence += 1;
        let future = self.bridge.input(&viewer, self.sequence, generation, event);
        self.call(future, cx, move |this, result, cx| {
            if this.epoch != epoch {
                return;
            }
            this.queue.sent();
            match result {
                Err(error) => return this.fail(&error.to_string(), cx),
                Ok(false) => {
                    this.queue.clear();
                    this.poll(epoch, cx);
                }
                Ok(true) => {}
            }
            this.drain(cx);
        });
    }

    pub fn press(&mut self, button: HardwareButton, cx: &mut Context<Self>) {
        if self.controllable() {
            self.send(Input::Button(button), cx);
        }
    }

    /// Rotate: waits for the next display generation before it takes touches in the new geometry.
    pub fn rotate(&mut self, cx: &mut Context<Self>) {
        if !self.controllable() || self.touch.is_some() {
            return;
        }
        let Some(status) = self.status.as_mut() else { return };
        let next = status.orientation.next();
        self.rotating_generation = Some(status.generation);
        status.ready = false;
        let epoch = self.epoch;
        self.rotation_timer = Some(self.after(ROTATE_DEADLINE, cx, move |this, cx| {
            if this.epoch == epoch {
                this.fail("The simulator did not finish changing its display. Retry to reconnect.", cx);
            }
        }));
        self.send(Input::Rotate(next), cx);
        cx.notify();
    }

    /// A press on the stage at `position` (window coordinates). Outside the screen or its rounded corners, ignored.
    pub fn touch_down(&mut self, position: gpui::Point<Pixels>, cx: &mut Context<Self>) -> bool {
        if !self.controllable() {
            return false;
        }
        let (Some(geometry), Some(device)) = (self.geometry(), self.selected.as_ref()) else { return false };
        let local = position - self.stage.origin;
        let radius = geometry.width.min(geometry.height) * corner_share(device);
        let Some(point) = geometry::point(f32::from(local.x), f32::from(local.y), &geometry, false, radius) else { return false };
        self.touch = Some(point);
        self.send(Input::Touch { phase: TouchPhase::Begin, points: vec![point] }, cx);
        true
    }

    /// A drag that started on the screen: held at the edge when it leaves it.
    pub fn touch_move(&mut self, position: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        if self.touch.is_none() {
            return;
        }
        let Some(geometry) = self.geometry() else { return };
        let local = position - self.stage.origin;
        if let Some(point) = geometry::point(f32::from(local.x), f32::from(local.y), &geometry, true, 0.0) {
            self.touch = Some(point);
            self.send(Input::Touch { phase: TouchPhase::Move, points: vec![point] }, cx);
        }
    }

    pub fn touch_up(&mut self, cx: &mut Context<Self>) {
        if let Some(point) = self.touch.take() {
            self.send(Input::Touch { phase: TouchPhase::End, points: vec![point] }, cx);
        }
    }

    /// A key on the focused stage. Returns whether it was sent (so the caller stops it going further).
    pub fn key(&mut self, key: &str, phase: KeyPhase, shifted: bool, cx: &mut Context<Self>) -> bool {
        let Some(usage) = geometry::hid_usage(key) else { return false };
        if !self.controllable() {
            return false;
        }
        self.send(Input::Key { phase, usage, shifted }, cx);
        true
    }

    // ---------------------------------------------------------------------------------------------------------
    // Toolbar

    pub fn toggle_extras(&mut self, cx: &mut Context<Self>) {
        self.extras_open = !self.extras_open;
        cx.notify();
    }

    /// Reconnect (Retry after a failure).
    pub fn reconnect(&mut self, cx: &mut Context<Self>) {
        self.extras_open = false;
        self.reconnects = 0;
        self.start(cx);
    }

    pub fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        if self.active {
            self.stop(cx);
            self.error = None;
        } else {
            self.reconnects = 0;
            self.start(cx);
        }
    }

    /// Reset input (iOS): the first press says what it does, the second within six seconds restarts.
    pub fn repair(&mut self, cx: &mut Context<Self>) {
        if self.repairing || !self.controllable() {
            return;
        }
        if !self.confirm_repair {
            self.confirm_repair = true;
            self.confirm_timer = Some(self.after(REPAIR_CONFIRM, cx, |this, cx| {
                this.confirm_repair = false;
                cx.notify();
            }));
            cx.notify();
            return;
        }
        let Some(viewer) = self.opened.as_ref().map(|o| o.viewer.clone()) else { return };
        let epoch = self.epoch;
        self.confirm_repair = false;
        self.repairing = true;
        // The host drops this viewer while it repairs: no poll or input may use it meanwhile.
        self.heartbeat = None;
        self.frame_timer = None;
        self.queue = InputQueue::default();
        let future = self.bridge.repair(&viewer);
        self.call(future, cx, move |this, result, cx| {
            this.repairing = false;
            if this.epoch != epoch {
                return;
            }
            match result {
                Ok(()) => {
                    // The host already dropped the viewer; do not close it again.
                    this.opened = None;
                    this.start(cx);
                }
                Err(error) => this.fail(&error.to_string(), cx),
            }
        });
        cx.notify();
    }

    /// Copies the frame on screen, as the host sent it, to the clipboard.
    pub fn copy_screenshot(&mut self, cx: &mut Context<Self>) {
        let Some(frame) = &self.last_frame else { return };
        let format = match frame.data {
            types::FrameData::Png(_) => gpui::ImageFormat::Png,
            types::FrameData::Jpeg(_) => gpui::ImageFormat::Jpeg,
            types::FrameData::Avcc(_) => return,
        };
        cx.write_to_clipboard(ClipboardItem::new_image(&gpui::Image::from_bytes(format, frame.data.bytes().to_vec())));
        self.copied = true;
        self.copied_timer = Some(self.after(COPIED_FOR, cx, |this, cx| {
            this.copied = false;
            cx.notify();
        }));
        cx.notify();
    }
}
