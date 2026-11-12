//! The spike's [`BrowserBridge`]: one headless Chromium (`platform/cdp.rs`) with one page, captured with
//! `Page.startScreencast` and driven with `Input.dispatch*`, the same calls the daemon's viewer makes
//! (`packages/core/src/browsers-cdp.cjs` `connect`). In production this whole file is the daemon's: the GPUI view
//! keeps the trait and gets a client-backed implementation instead (`BROWSER-EXPLORATION.md`).

use std::sync::{Arc, Mutex, Weak};
use std::task::{Context as TaskContext, Poll, Wake};
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow};
use base64::Engine as _;
use serde_json::{Value, json};

use super::bridge::{BridgeFuture, BrowserBridge, BrowserFrame, BrowserInput, BrowserOpen, BrowserStatus, BrowserTarget, Navigate, Phase};
use crate::platform::cdp::{CdpEvent, Chromium};

/// The daemon's capture settings (`browsers-cdp.cjs`), except the size, which follows the viewer (see `Viewport`).
pub const QUALITY: u32 = 60;
const TIMEOUT: Duration = Duration::from_secs(10);

/// The page the spike opens when `MILAGRE_GPUI_BROWSER_SPIKE_URL` is not set: counters for clicks and keys, a
/// text field, a corner flag that changes colour on every press (what the latency bench reads back from frames),
/// 200 rows to scroll and, with `animate`, a canvas animation at the display's rate.
pub fn test_page(animate: bool) -> String {
    let html = format!(
        r#"<!doctype html><meta charset=utf-8><title>Milagre browser spike</title>
<style>body{{font:15px -apple-system,system-ui,sans-serif;margin:0;padding:20px;color:#111;background:#fff}}
h1{{font-size:22px;margin:0 0 8px}} input{{font:15px system-ui;padding:8px;width:240px}} button{{font:15px system-ui;padding:8px 14px}}
.row{{padding:10px 4px;border-bottom:1px solid #eee}} #flag{{position:fixed;right:0;top:0;width:32px;height:32px;background:rgb(255,0,0)}}</style>
<h1>Browser spike</h1><p>Clicks: <b id=clicks>0</b> · Keys: <b id=keys>0</b> · Scroll: <b id=scrolled>0</b></p>
<p><input id=field placeholder="Type here"> <button id=btn>Click me</button></p>
<canvas id=anim width=320 height=48 style="background:#f4f4f6"></canvas><div id=flag></div><div id=list></div>
<script>let c=0,k=0;const anim={animate};
addEventListener('mousedown',()=>{{c++;clicks.textContent=c;flag.style.background=c%2?'rgb(0,0,255)':'rgb(255,0,0)'}});
addEventListener('keydown',()=>{{k++;keys.textContent=k;flag.style.background=k%2?'rgb(0,255,0)':'rgb(255,0,0)'}});
addEventListener('scroll',()=>{{scrolled.textContent=Math.round(scrollY)}});
for(let i=1;i<=200;i++){{const d=document.createElement('div');d.className='row';d.textContent='Row '+i;list.appendChild(d)}}
if(anim){{const g=document.getElementById('anim').getContext('2d');let t=0;(function f(){{t++;g.clearRect(0,0,320,48);g.fillStyle='#36f';g.fillRect((t*4)%320,8,32,32);requestAnimationFrame(f)}})()}}</script>"#
    );
    format!("data:text/html;base64,{}", base64::engine::general_purpose::STANDARD.encode(html))
}

/// The address the spike opens.
pub fn start_url() -> String {
    std::env::var("MILAGRE_GPUI_BROWSER_SPIKE_URL").unwrap_or_else(|_| test_page(false))
}

struct History {
    entries: Vec<i64>,
    index: usize,
}

struct Inner {
    chromium: Chromium,
    session: String,
    latest: Mutex<Option<BrowserFrame>>,
    /// One slot: a new frame wakes the one waiting `frame` call.
    wake: async_channel::Sender<()>,
    woken: async_channel::Receiver<()>,
    status: Mutex<BrowserStatus>,
    history: Mutex<History>,
    /// The mouse button held, for move events' `buttons`.
    pressed: Mutex<&'static str>,
    viewport: Mutex<(u32, u32, f32)>,
}

impl Inner {
    fn start(url: &str) -> anyhow::Result<Arc<Self>> {
        let (events, received) = async_channel::unbounded();
        let chromium = Chromium::launch(events)?;
        let session = chromium.open_page(url)?;
        chromium.call_blocking(Some(&session), "Page.enable", json!({}), TIMEOUT)?;
        let (wake, woken) = async_channel::bounded(1);
        let inner = Arc::new(Self {
            chromium,
            session,
            latest: Mutex::new(None),
            wake,
            woken,
            status: Mutex::new(BrowserStatus { controlling: true, url: url.to_owned(), ..Default::default() }),
            history: Mutex::new(History { entries: vec![], index: 0 }),
            pressed: Mutex::new("none"),
            viewport: Mutex::new((0, 0, 1.0)),
        });
        inner.set_viewport(800, 600, 2.0);
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new().name("browser-spike-events".into()).spawn(move || pump(weak, received)).context("spawn")?;
        inner.refresh_history();
        Ok(inner)
    }

    fn page(&self, method: &str, params: Value) {
        self.chromium.send(Some(&self.session), method, params);
    }

    /// Lays the page out at `width` × `height` CSS pixels and `scale`, and captures it at that size in device pixels.
    fn set_viewport(&self, width: u32, height: u32, scale: f32) {
        let mut viewport = self.viewport.lock().unwrap();
        if *viewport == (width, height, scale) {
            return;
        }
        *viewport = (width, height, scale);
        self.page(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": false }),
        );
        self.page("Page.stopScreencast", json!({}));
        let max = |css: u32| (css as f32 * scale).ceil() as u32;
        self.page(
            "Page.startScreencast",
            json!({ "format": "jpeg", "quality": quality(), "maxWidth": max(width), "maxHeight": max(height), "everyNthFrame": 1 }),
        );
    }

    fn refresh_history(&self) {
        let Ok(result) = self.chromium.call_blocking(Some(&self.session), "Page.getNavigationHistory", json!({}), Duration::from_secs(2))
        else {
            return;
        };
        let entries: Vec<&Value> = result["entries"].as_array().map(|e| e.iter().collect()).unwrap_or_default();
        let index = result["currentIndex"].as_u64().unwrap_or(0) as usize;
        let mut status = self.status.lock().unwrap();
        if let Some(entry) = entries.get(index) {
            status.url = entry["url"].as_str().unwrap_or_default().to_owned();
            status.title = entry["title"].as_str().unwrap_or_default().to_owned();
        }
        status.can_go_back = index > 0;
        status.can_go_forward = index + 1 < entries.len();
        *self.history.lock().unwrap() = History { entries: entries.iter().filter_map(|e| e["id"].as_i64()).collect(), index };
    }

    fn send(&self, event: BrowserInput) {
        let (vw, vh) = self.latest.lock().unwrap().as_ref().map_or((0, 0), |frame| frame.viewport);
        let point = |x: f32, y: f32| (f64::from(x) * f64::from(vw), f64::from(y) * f64::from(vh));
        match event {
            BrowserInput::Mouse { phase, x, y, button, click_count, modifiers } => {
                let (x, y) = point(x, y);
                let mut pressed = self.pressed.lock().unwrap();
                if phase == Phase::Down {
                    *pressed = button.wire();
                }
                let (kind, button) = match phase {
                    Phase::Down => ("mousePressed", button.wire()),
                    Phase::Move => ("mouseMoved", *pressed),
                    Phase::Up => ("mouseReleased", button.wire()),
                };
                let buttons = if phase == Phase::Up { 0 } else { bits(*pressed) };
                self.page(
                    "Input.dispatchMouseEvent",
                    json!({ "type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": click_count, "modifiers": modifiers }),
                );
                if phase == Phase::Up {
                    *pressed = "none";
                }
            }
            BrowserInput::Wheel { x, y, delta_x, delta_y, modifiers } => {
                let (x, y) = point(x, y);
                self.page(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseWheel", "x": x, "y": y, "button": "none", "deltaX": delta_x, "deltaY": delta_y, "modifiers": modifiers }),
                );
            }
            BrowserInput::Key { down, key, code, key_code, text, modifiers, commands } => {
                let kind = if !down {
                    "keyUp"
                } else if text.is_some() {
                    "keyDown"
                } else {
                    "rawKeyDown"
                };
                let mut params =
                    json!({ "type": kind, "key": key, "code": code, "windowsVirtualKeyCode": key_code, "modifiers": modifiers });
                if let Some(text) = text {
                    params["text"] = json!(text);
                    params["unmodifiedText"] = json!(text);
                }
                if !commands.is_empty() {
                    params["commands"] = json!(commands);
                }
                self.page("Input.dispatchKeyEvent", params);
            }
            BrowserInput::Text(text) => self.page("Input.insertText", json!({ "text": text })),
            BrowserInput::Viewport { width, height, scale } => self.set_viewport(width, height, scale),
            BrowserInput::Navigate(Navigate::Reload) => self.page("Page.reload", json!({})),
            BrowserInput::Navigate(direction) => {
                let history = self.history.lock().unwrap();
                let step: isize = if direction == Navigate::Back { -1 } else { 1 };
                let target = history.index.checked_add_signed(step).and_then(|ix| history.entries.get(ix));
                if let Some(entry) = target {
                    self.page("Page.navigateToHistoryEntry", json!({ "entryId": entry }));
                }
            }
        }
    }
}

fn quality() -> u32 {
    std::env::var("MILAGRE_GPUI_BROWSER_SPIKE_QUALITY").ok().and_then(|q| q.parse().ok()).unwrap_or(QUALITY)
}

fn bits(button: &str) -> u32 {
    match button {
        "left" => 1,
        "right" => 2,
        "middle" => 4,
        _ => 0,
    }
}

/// The event thread: frames into the one slot, navigations into the status.
fn pump(inner: Weak<Inner>, events: async_channel::Receiver<CdpEvent>) {
    let mut sequence = 0u64;
    while let Ok(event) = events.recv_blocking() {
        let Some(inner) = inner.upgrade() else { break };
        match event.method.as_str() {
            "Page.screencastFrame" => {
                let received = Instant::now();
                let params = &event.params;
                let width = params["metadata"]["deviceWidth"].as_f64().unwrap_or(0.0).round() as u32;
                let height = params["metadata"]["deviceHeight"].as_f64().unwrap_or(0.0).round() as u32;
                let Some(Ok(jpeg)) = params["data"].as_str().map(|data| base64::engine::general_purpose::STANDARD.decode(data)) else {
                    continue;
                };
                if width == 0 || height == 0 {
                    continue;
                }
                sequence += 1;
                let generation = inner.status.lock().unwrap().generation;
                *inner.latest.lock().unwrap() = Some(BrowserFrame { sequence, jpeg, viewport: (width, height), generation, received });
                inner.status.lock().unwrap().ready = true;
                let _ = inner.wake.try_send(());
            }
            "Page.frameNavigated" if event.params["frame"]["parentId"].is_null() => inner.refresh_history(),
            "Page.navigatedWithinDocument" | "Page.loadEventFired" => inner.refresh_history(),
            _ => {}
        }
    }
}

/// The spike's bridge: launches its Chromium on `open`, on a thread, so the window never waits for it.
#[derive(Clone, Default)]
pub struct CdpSpike {
    inner: Arc<Mutex<Option<Arc<Inner>>>>,
}

impl CdpSpike {
    fn current(&self) -> anyhow::Result<Arc<Inner>> {
        self.inner.lock().unwrap().clone().ok_or_else(|| anyhow!("The browser is not open."))
    }

    /// The browser's process id, for the bench.
    pub fn browser_pid(&self) -> Option<u32> {
        self.current().ok().map(|inner| inner.chromium.pid())
    }

    /// `Runtime.evaluate` in the page, for the bench.
    pub fn evaluate(&self, expression: &str) -> anyhow::Result<Value> {
        let inner = self.current()?;
        let result = inner.chromium.call_blocking(
            Some(&inner.session),
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
            TIMEOUT,
        )?;
        Ok(result["result"]["value"].clone())
    }
}

impl BrowserBridge for CdpSpike {
    fn open(&self, _chat: &str, target: &str) -> BridgeFuture<BrowserOpen> {
        let (done, result) = async_channel::bounded(1);
        let (slot, url) = (self.inner.clone(), target.to_owned());
        std::thread::spawn(move || {
            let opened = Inner::start(&url).map(|inner| {
                *slot.lock().unwrap() = Some(inner);
                BrowserOpen {
                    viewer: "spike".into(),
                    target: BrowserTarget { id: "spike:page".into(), title: String::new(), url, browser: "Chromium (spike)".into() },
                }
            });
            let _ = done.send_blocking(opened);
        });
        Box::pin(async move { result.recv().await.map_err(|_| anyhow!("The browser did not start."))? })
    }

    fn frame(&self, _viewer: &str, after: u64) -> BridgeFuture<Option<BrowserFrame>> {
        let inner = self.current();
        Box::pin(async move {
            let inner = inner?;
            loop {
                if let Some(frame) = inner.latest.lock().unwrap().as_ref().filter(|frame| frame.sequence > after) {
                    return Ok(Some(frame.clone()));
                }
                inner.woken.recv().await.map_err(|_| anyhow!("The browser closed."))?;
            }
        })
    }

    fn status(&self, _viewer: &str) -> BridgeFuture<BrowserStatus> {
        let status = self.current().map(|inner| inner.status.lock().unwrap().clone());
        Box::pin(async move { status })
    }

    fn input(&self, _viewer: &str, _sequence: u64, _generation: u64, event: BrowserInput) -> BridgeFuture<bool> {
        let sent = self.current().map(|inner| {
            inner.send(event);
            true
        });
        Box::pin(async move { sent })
    }

    fn close(&self, _viewer: &str) -> BridgeFuture<()> {
        // A frame call in flight may still hold the page: close the browser now rather than on the last drop.
        if let Some(inner) = self.inner.lock().unwrap().take() {
            inner.chromium.close();
        }
        Box::pin(async { Ok(()) })
    }
}

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Runs `future` on this thread until it is done or `timeout` passes. For snapshots, which need the first frame
/// before the window draws, and the bench; never on the app's main thread otherwise.
pub fn block_on<T>(mut future: BridgeFuture<T>, timeout: Duration) -> anyhow::Result<T> {
    let deadline = Instant::now() + timeout;
    let waker = Arc::new(ThreadWaker(std::thread::current())).into();
    let mut cx = TaskContext::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(anyhow!("timed out after {timeout:?}"));
        }
        std::thread::park_timeout(deadline - now);
    }
}
