//! Fixture data while there is no daemon: a few devices, a bridge that keeps attachments per Chat and records
//! every input, and a frame source cycling three PNG frames (`fixture/frame-*.png`, written by the ignored test
//! `tests::write_fixture_frames`). Rotate changes the fixture device's orientation and display generation the
//! way Device Hub does; the frames stay in the raw portrait capture, so the view turns them.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::SharedString;

use super::bridge::{BridgeFuture, FrameSource, SimulatorBridge};
use super::types::{
    Device, EncodedFrame, FrameData, HardwareButton, Input, Opened, Orientation, Platform, SimulatorList, Status, Transport,
};

/// The three frames, cycled. 780 by 1688 pixels: an iPhone's 390 by 844 points at 2x.
pub const FRAMES: [&[u8]; 3] =
    [include_bytes!("fixture/frame-1.png"), include_bytes!("fixture/frame-2.png"), include_bytes!("fixture/frame-3.png")];
pub const FRAME_SIZE: (u32, u32) = (780, 1688);

/// How the fixture's device behaves, for snapshots and tests (`MILAGRE_GPUI_SIMULATOR_STATE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scenario {
    /// Opens, streams and takes control.
    #[default]
    Live,
    /// `open` never answers.
    Connecting,
    /// Another viewer holds control: View only until Take control.
    ViewOnly,
    /// `open` fails.
    Error,
    /// The attached device is not running.
    Offline,
    /// Live, turned to landscape.
    Landscape,
}

impl Scenario {
    pub fn from_name(name: &str) -> Option<Scenario> {
        Some(match name {
            "live" => Scenario::Live,
            "connecting" => Scenario::Connecting,
            "view-only" => Scenario::ViewOnly,
            "error" => Scenario::Error,
            "offline" => Scenario::Offline,
            "landscape" => Scenario::Landscape,
            _ => return None,
        })
    }
}

pub fn iphone() -> Device {
    Device {
        id: "6F1C2B0A-16PR-4E2D-9A11-0C0FFEE16PRO".into(),
        name: "iPhone 16 Pro".into(),
        platform: Platform::Ios,
        version: "18.5".into(),
        device_type: Some("com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro".into()),
    }
}

pub fn pixel() -> Device {
    Device { id: "emulator-5554".into(), name: "Pixel 9".into(), platform: Platform::Android, version: "15".into(), device_type: None }
}

pub fn ipad() -> Device {
    Device {
        id: "1B2C3D4E-IPAD-4F00-8A00-00000000A1R5".into(),
        name: "iPad Air 11-inch (M2)".into(),
        platform: Platform::Ios,
        version: "18.5".into(),
        device_type: Some("com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2".into()),
    }
}

/// What the fixture host knows; shared by the bridge and its frame sources.
pub struct FixtureHost {
    pub scenario: Scenario,
    pub attached: HashMap<SharedString, Vec<SharedString>>,
    pub orientation: Orientation,
    pub generation: u64,
    /// Whether this viewer holds input control.
    pub controlling: bool,
    pub next_viewer: u64,
    pub open: Vec<SharedString>,
    /// Every input event accepted, in order, with its sequence and generation.
    pub inputs: Vec<(u64, u64, Input)>,
    pub closed: Vec<SharedString>,
    pub repairs: usize,
    /// Whether `attach_at_start` puts the default device on a Chat the first time it is listed.
    attach_at_start: Rc<dyn Fn(&str) -> bool>,
}

impl FixtureHost {
    fn status(&self) -> Status {
        Status {
            width: FRAME_SIZE.0,
            height: FRAME_SIZE.1,
            orientation: self.orientation,
            generation: self.generation,
            display_generation: None,
            controlling: self.controlling,
            ready: true,
            input_hint: false,
        }
    }

    fn devices(&self) -> Vec<Device> {
        let all = [iphone(), pixel(), ipad()];
        if self.scenario == Scenario::Offline { all.into_iter().skip(1).collect() } else { all.into_iter().collect() }
    }

    fn list(&mut self, chat: &str) -> SimulatorList {
        let at_start = (self.attach_at_start)(chat);
        let ids = self.attached.entry(chat.into()).or_insert_with(|| if at_start { vec![iphone().id] } else { Vec::new() }).clone();
        let known = [iphone(), pixel(), ipad()];
        let attached: Vec<Device> = known.iter().filter(|d| ids.contains(&d.id)).cloned().collect();
        let devices = self.devices();
        let available = devices.iter().filter(|d| !ids.contains(&d.id)).cloned().collect();
        SimulatorList { devices, attached, available, supported: true }
    }
}

/// The fixture's [`SimulatorBridge`].
#[derive(Clone)]
pub struct FixtureBridge {
    pub host: Rc<RefCell<FixtureHost>>,
}

impl FixtureBridge {
    /// `attach_at_start(chat)` decides which Chats start with the iPhone attached.
    pub fn new(scenario: Scenario, attach_at_start: impl Fn(&str) -> bool + 'static) -> Self {
        let host = FixtureHost {
            scenario,
            attached: HashMap::new(),
            orientation: if scenario == Scenario::Landscape { Orientation::LandscapeLeft } else { Orientation::Portrait },
            generation: 1,
            controlling: false,
            next_viewer: 0,
            open: Vec::new(),
            inputs: Vec::new(),
            closed: Vec::new(),
            repairs: 0,
            attach_at_start: Rc::new(attach_at_start),
        };
        Self { host: Rc::new(RefCell::new(host)) }
    }
}

fn ready<T: 'static>(value: anyhow::Result<T>) -> BridgeFuture<T> {
    Box::pin(std::future::ready(value))
}

impl SimulatorBridge for FixtureBridge {
    fn list(&self, chat: &str) -> BridgeFuture<SimulatorList> {
        ready(Ok(self.host.borrow_mut().list(chat)))
    }

    fn attach(&self, chat: &str, device: &str) -> BridgeFuture<SimulatorList> {
        let mut host = self.host.borrow_mut();
        host.list(chat);
        let ids = host.attached.entry(chat.into()).or_default();
        if !ids.iter().any(|id| id == device) {
            ids.push(device.to_string().into());
        }
        ready(Ok(host.list(chat)))
    }

    fn detach(&self, chat: &str, device: &str) -> BridgeFuture<SimulatorList> {
        let mut host = self.host.borrow_mut();
        host.list(chat);
        host.attached.entry(chat.into()).or_default().retain(|id| id != device);
        ready(Ok(host.list(chat)))
    }

    fn open(&self, _chat: &str, device: &str) -> BridgeFuture<Opened> {
        let mut host = self.host.borrow_mut();
        match host.scenario {
            Scenario::Connecting => return Box::pin(std::future::pending()),
            Scenario::Error => {
                return ready(Err(anyhow::anyhow!("Simulator helper exited. Check that Xcode's command line tools are installed.")));
            }
            _ => {}
        }
        let Some(device) = host.devices().into_iter().find(|d| d.id == device) else {
            return ready(Err(anyhow::anyhow!("The simulator is not running.")));
        };
        host.next_viewer += 1;
        let viewer: SharedString = format!("viewer-{}", host.next_viewer).into();
        host.open.push(viewer.clone());
        ready(Ok(Opened { viewer, device, transport: Transport::Frames }))
    }

    fn status(&self, viewer: &str) -> BridgeFuture<Status> {
        let host = self.host.borrow();
        if !host.open.iter().any(|v| v == viewer) {
            return ready(Err(anyhow::anyhow!("This simulator viewer is closed.")));
        }
        ready(Ok(host.status()))
    }

    fn control(&self, _viewer: &str, take_over: bool) -> BridgeFuture<Status> {
        let mut host = self.host.borrow_mut();
        // Someone else holds the device in the view-only scenario until this viewer takes over.
        if take_over || host.scenario != Scenario::ViewOnly {
            host.controlling = true;
        }
        ready(Ok(host.status()))
    }

    fn input(&self, _viewer: &str, sequence: u64, generation: u64, event: Input) -> BridgeFuture<bool> {
        let mut host = self.host.borrow_mut();
        if !host.controlling || generation != host.generation {
            return ready(Ok(false));
        }
        match &event {
            Input::Rotate(orientation) => {
                host.orientation = *orientation;
                host.generation += 1;
            }
            Input::Button(HardwareButton::Home | HardwareButton::Back) | Input::Touch { .. } | Input::Key { .. } => {}
        }
        host.inputs.push((sequence, generation, event));
        ready(Ok(true))
    }

    fn repair(&self, viewer: &str) -> BridgeFuture<()> {
        let mut host = self.host.borrow_mut();
        host.repairs += 1;
        host.open.retain(|v| v != viewer);
        ready(Ok(()))
    }

    fn close(&self, viewer: &str) -> BridgeFuture<()> {
        let mut host = self.host.borrow_mut();
        host.open.retain(|v| v != viewer);
        host.closed.push(viewer.to_string().into());
        ready(Ok(()))
    }

    fn frames(&self, opened: &Opened) -> Box<dyn FrameSource> {
        Box::new(FixtureFrames { host: self.host.clone(), viewer: opened.viewer.clone() })
    }
}

/// Cycles [`FRAMES`]; each pull is the next sequence.
pub struct FixtureFrames {
    host: Rc<RefCell<FixtureHost>>,
    viewer: SharedString,
}

impl FrameSource for FixtureFrames {
    fn next(&mut self, after: u64) -> BridgeFuture<Option<EncodedFrame>> {
        let host = self.host.borrow();
        if !host.open.contains(&self.viewer) {
            return ready(Err(anyhow::anyhow!("This simulator viewer is closed.")));
        }
        let sequence = after + 1;
        let data = FrameData::Png(FRAMES[(sequence as usize - 1) % FRAMES.len()].to_vec());
        ready(Ok(Some(EncodedFrame { sequence, data, status: host.status() })))
    }
}

/// FNV-1a, the same spread `panel/fixture.rs` gives Chats over its variants.
fn spread(key: &str) -> u64 {
    key.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
}

/// Which Chats start with a simulator attached: about one in four of the others, and the Chat open at startup only
/// when a snapshot asks for the Simulator tab (so the panel's existing tab tests keep their five tabs).
pub fn attached_at_start(chat: &str, seeded: Option<&str>, seeded_has_simulator: bool) -> bool {
    if Some(chat) == seeded {
        return seeded_has_simulator;
    }
    spread(chat) & 0x1800 == 0x1800
}
