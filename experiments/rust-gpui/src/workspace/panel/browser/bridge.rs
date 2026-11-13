//! The seam a real host connection plugs into: the streamed viewer of `packages/shared/src/browser.ts` (`BrowserApi`),
//! which the daemon already serves as `browser:open`, `browser:frame`, `browser:status`, `browser:input` and
//! `browser:close` (`packages/core/src/browsers.cjs`). The spike answers it from its own Chromium (`spike.rs`); the
//! shared daemon client answers it in production (`BROWSER-EXPLORATION.md`, "What the shared client needs").
//!
//! Field for field the wire shapes, except a frame carries JPEG bytes (the wire's base64, decoded) and the time it
//! reached this process, for the spike's latency numbers.

use std::time::Instant;

pub use crate::workspace::panel::simulator::bridge::BridgeFuture;

/// A page a viewer can open (`BrowserTarget`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserTarget {
    /// `browserId:pageId` on the wire.
    pub id: String,
    pub title: String,
    pub url: String,
    pub browser: String,
}

/// `BrowserOpen`.
#[derive(Clone, Debug)]
pub struct BrowserOpen {
    pub viewer: String,
    pub target: BrowserTarget,
}

/// `BrowserStatus`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserStatus {
    pub generation: u64,
    pub controlling: bool,
    pub ready: bool,
    pub title: String,
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// `BrowserFrame`: the newest capture, in the page's CSS pixels.
#[derive(Clone, Debug)]
pub struct BrowserFrame {
    pub sequence: u64,
    pub jpeg: Vec<u8>,
    pub viewport: (u32, u32),
    pub generation: u64,
    /// When this process had the frame (not on the wire).
    pub received: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Down,
    Move,
    Up,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
    None,
}

impl Button {
    pub fn wire(self) -> &'static str {
        match self {
            Button::Left => "left",
            Button::Middle => "middle",
            Button::Right => "right",
            Button::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Navigate {
    Back,
    Forward,
    Reload,
}

/// `BrowserInput`. Points are fractions of the frame (0 to 1), as the wire's are; modifiers are CDP's bits (Alt 1,
/// Control 2, Meta 4, Shift 8).
#[derive(Clone, Debug, PartialEq)]
pub enum BrowserInput {
    Mouse {
        phase: Phase,
        x: f32,
        y: f32,
        button: Button,
        click_count: u32,
        modifiers: u32,
    },
    Wheel {
        x: f32,
        y: f32,
        delta_x: f32,
        delta_y: f32,
        modifiers: u32,
    },
    Key {
        down: bool,
        key: String,
        code: String,
        key_code: u32,
        text: Option<String>,
        modifiers: u32,
        commands: Vec<&'static str>,
    },
    Text(String),
    Navigate(Navigate),
    /// The viewer's size in CSS pixels. `scale` is new: the wire event has none, and the daemon emulates scale 0
    /// (the browser window's own), which blurs text on a 2x screen (`BROWSER-EXPLORATION.md`).
    Viewport {
        width: u32,
        height: u32,
        scale: f32,
    },
}

/// The host's streamed browser viewer, scoped to one window as the desktop's bridge is. `list`, `attach`, `detach`
/// and `control` exist on the wire too; the spike has one page and one viewer, so it leaves them out.
pub trait BrowserBridge {
    /// Opens a viewer on `target` (a `BrowserTarget::id`) for `chat`.
    fn open(&self, chat: &str, target: &str) -> BridgeFuture<BrowserOpen>;
    /// The first frame after `after`; waits for one (the daemon long-polls up to 2.5 s, then answers `None`).
    fn frame(&self, viewer: &str, after: u64) -> BridgeFuture<Option<BrowserFrame>>;
    fn status(&self, viewer: &str) -> BridgeFuture<BrowserStatus>;
    /// `false` when the host refused it (lost control, stale generation).
    fn input(&self, viewer: &str, sequence: u64, generation: u64, event: BrowserInput) -> BridgeFuture<bool>;
    fn close(&self, viewer: &str) -> BridgeFuture<()>;
}
