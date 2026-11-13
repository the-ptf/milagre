//! The simulator viewer's domain types, after `packages/shared/src/simulator.ts` (`SimulatorDevice`,
//! `SimulatorStatus`, `SimulatorInput`, `SimulatorList`, `SimulatorFrame`, `SimulatorOpen`) and the connection
//! labels of `shared/simulator-receiver.mjs` (`SIMULATOR_CONNECTION_LABELS`).

use gpui::SharedString;

/// Simlock leases are listed with ids under this prefix (`SIMLOCK_DEVICE_PREFIX`).
pub const SIMLOCK_DEVICE_PREFIX: &str = "simlock:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Ios,
    Android,
}

impl Platform {
    pub fn label(self) -> &'static str {
        match self {
            Platform::Ios => "iOS",
            Platform::Android => "Android",
        }
    }
}

/// `SimulatorDevice`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: SharedString,
    pub name: SharedString,
    pub platform: Platform,
    pub version: SharedString,
    /// CoreSimulator's model identifier, independent of the device's editable name.
    pub device_type: Option<SharedString>,
}

impl Device {
    /// "iOS 18.5", the line under the device's name.
    pub fn os_line(&self) -> String {
        format!("{} {}", self.platform.label(), self.version)
    }

    pub fn is_simlock(&self) -> bool {
        self.id.starts_with(SIMLOCK_DEVICE_PREFIX)
    }
}

/// `SimulatorOrientation`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    #[default]
    Portrait,
    PortraitUpsideDown,
    LandscapeLeft,
    LandscapeRight,
}

impl Orientation {
    pub fn is_landscape(self) -> bool {
        matches!(self, Orientation::LandscapeLeft | Orientation::LandscapeRight)
    }

    /// The Rotate button: iPhones have no upside-down portrait, so it always offers a usable next orientation.
    pub fn next(self) -> Orientation {
        if self.is_landscape() { Orientation::Portrait } else { Orientation::LandscapeLeft }
    }
}

/// `SimulatorStatus`. `width` and `height` are the raw capture's pixels, in Device Hub's portrait orientation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub width: u32,
    pub height: u32,
    pub orientation: Orientation,
    pub generation: u64,
    pub display_generation: Option<u64>,
    pub controlling: bool,
    pub ready: bool,
    /// `deviceHubInputActive` (or the older `inputBlocked`): a hint, it does not prove touches fail.
    pub input_hint: bool,
}

impl Status {
    pub fn display_generation(&self) -> u64 {
        self.display_generation.unwrap_or(self.generation)
    }
}

/// `SimulatorList`: every running device, the ones attached to this Chat and the others it may attach.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SimulatorList {
    pub devices: Vec<Device>,
    pub attached: Vec<Device>,
    pub available: Vec<Device>,
    pub supported: bool,
}

impl SimulatorList {
    pub fn is_running(&self, id: &str) -> bool {
        self.devices.iter().any(|device| device.id == id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    Begin,
    Move,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HardwareButton {
    Home,
    Back,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyPhase {
    Down,
    Up,
}

/// A point on the device's screen in its raw portrait capture, each axis 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenPoint {
    pub x: f32,
    pub y: f32,
}

/// `SimulatorInput`, less the foldable `pose` and `hinge` events (no fixture device folds).
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Touch {
        phase: TouchPhase,
        points: Vec<ScreenPoint>,
    },
    Button(HardwareButton),
    Rotate(Orientation),
    /// `usage` is the USB HID keyboard usage (4 to 255), which the host checks.
    Key {
        phase: KeyPhase,
        usage: u8,
        shifted: bool,
    },
}

/// How the host sends video for a viewer (`SimulatorOpen.transport`): absent means WebRTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// Pulled frames: JPEG, PNG, or H.264 in serve-sim AVCC envelopes.
    Frames,
    WebRtc,
}

/// `SimulatorOpen`, less the ICE servers a WebRTC receiver would need.
#[derive(Clone, Debug, PartialEq)]
pub struct Opened {
    pub viewer: SharedString,
    pub device: Device,
    pub transport: Transport,
}

/// One frame's payload, as the host's `simulators.frame` returns it (already base64-decoded).
#[derive(Clone, Debug, PartialEq)]
pub enum FrameData {
    Png(Vec<u8>),
    Jpeg(Vec<u8>),
    /// `video/avcc`: serve-sim envelopes (1 decoder configuration, 2 keyframe, 3 delta). Not decoded here.
    Avcc(Vec<u8>),
}

impl FrameData {
    pub fn bytes(&self) -> &[u8] {
        match self {
            FrameData::Png(bytes) | FrameData::Jpeg(bytes) | FrameData::Avcc(bytes) => bytes,
        }
    }
}

/// `SimulatorFrame`.
#[derive(Clone, Debug, PartialEq)]
pub struct EncodedFrame {
    pub sequence: u64,
    pub data: FrameData,
    pub status: Status,
}

/// The connection states the header shows (`SIMULATOR_CONNECTION_LABELS`), plus `Offline`: the attached device
/// is not running, so there is nothing to connect to (the device list says "Stopped").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connection {
    Connecting,
    Live,
    ViewOnly,
    Rotating,
    Blocked,
    Paused,
    Offline,
    Error,
}

impl Connection {
    pub fn label(self) -> &'static str {
        match self {
            Connection::Connecting => "Connecting",
            Connection::Live => "Live",
            Connection::ViewOnly => "View only",
            Connection::Rotating => "Changing display",
            Connection::Blocked => "Input blocked",
            Connection::Paused => "Paused",
            Connection::Offline => "Offline",
            Connection::Error => "Disconnected",
        }
    }
}
