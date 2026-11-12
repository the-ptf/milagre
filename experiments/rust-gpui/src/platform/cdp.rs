//! A throwaway Chromium driven over the DevTools protocol (CDP), for the Browser panel spike only
//! (`BROWSER-EXPLORATION.md`, option B). Production browsers belong to the daemon, which already launches and drives
//! them over CDP (`packages/core/src/browsers*.cjs`); this file exists so the GPUI side can be measured before the
//! shared client grows `browser:*` methods, and is deleted when it does.
//!
//! - **Launch.** An installed Chrome or Chromium (`MILAGRE_GPUI_BROWSER_SPIKE_CHROME`, else the usual app paths),
//!   `--headless=new` so no window or Dock icon ever shows, with a fresh profile under `/tmp` that is removed on drop.
//!   Never the user's own profile.
//! - **Transport.** `--remote-debugging-pipe`: CDP messages are NUL-terminated JSON on file descriptors 3 (to the
//!   browser) and 4 (from it). No port is opened, so nothing else on the computer can reach this browser, and no
//!   WebSocket client is needed.
//! - **Sessions.** Flat sessions (`Target.attachToTarget` with `flatten`): one pipe, page commands carry `sessionId`.
//!
//! A reader thread answers calls through one-shot channels and hands every event to the owner's channel. Screencast
//! frames are acknowledged on that thread at once, as `browsers-cdp.cjs` does, so the browser never waits on GPUI.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use serde_json::{Value, json};

/// A message larger than this is dropped, as the daemon's `MAX_MESSAGE` does.
const MAX_MESSAGE: usize = 32 * 1024 * 1024;

/// One CDP event: its method, params and the flat session it came from (`None` for the browser itself).
#[derive(Clone, Debug)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session: Option<String>,
}

type Reply = mpsc::Sender<anyhow::Result<Value>>;

/// A headless Chromium this process launched, and the pipe to it.
pub struct Chromium {
    child: Mutex<Child>,
    writer: Arc<Mutex<File>>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next_id: AtomicU64,
    profile: PathBuf,
}

/// The browser binaries tried, in order, when `MILAGRE_GPUI_BROWSER_SPIKE_CHROME` is not set.
const CANDIDATES: [&str; 4] = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

/// The Chromium the spike would launch, if one is installed.
pub fn find_browser() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MILAGRE_GPUI_BROWSER_SPIKE_CHROME") {
        return Some(PathBuf::from(path));
    }
    CANDIDATES.iter().map(PathBuf::from).find(|path| path.exists())
}

/// A pipe whose two ends are above the descriptors the child needs (3 and 4) and close on exec.
fn pipe() -> anyhow::Result<(RawFd, RawFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` is a valid two-element array for `pipe` to fill.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        bail!("pipe: {}", std::io::Error::last_os_error());
    }
    let mut lifted = [0 as RawFd; 2];
    for (ix, fd) in fds.into_iter().enumerate() {
        // SAFETY: plain descriptor calls on descriptors this function owns.
        unsafe {
            lifted[ix] = libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10);
            libc::close(fd);
        }
        if lifted[ix] < 0 {
            bail!("fcntl: {}", std::io::Error::last_os_error());
        }
    }
    Ok((lifted[0], lifted[1]))
}

impl Chromium {
    /// Launches a headless browser on a fresh `/tmp` profile; every event goes to `events`.
    pub fn launch(events: async_channel::Sender<CdpEvent>) -> anyhow::Result<Self> {
        let binary = find_browser().ok_or_else(|| anyhow!("No Chrome or Chromium is installed."))?;
        let profile = PathBuf::from("/tmp").join(format!("milagre-gpui-browser-spike-{}-{}", std::process::id(), unique()));
        std::fs::create_dir_all(&profile)?;
        // to_child: we write, the browser reads on fd 3. from_child: the browser writes on fd 4, we read.
        let (to_child_read, to_child_write) = pipe()?;
        let (from_child_read, from_child_write) = pipe()?;
        let mut command = Command::new(&binary);
        command
            .args([
                "--headless=new",
                "--remote-debugging-pipe",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-extensions",
                "--disable-component-update",
                "--mute-audio",
                "--password-store=basic",
                "--use-mock-keychain",
                "--window-size=1280,800",
            ])
            // Screencast frames come from the compositor at the window's own scale, whatever scale the page is
            // emulated at: a 2x panel needs a 2x browser (`BROWSER-EXPLORATION.md`, "Sharpness").
            .arg(format!("--force-device-scale-factor={}", device_scale()))
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe calls (`dup2`) between fork and exec. dup2 clears close-on-exec on the
        // copies, and the originals (all at 10 or above) close on exec.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(to_child_read, 3) < 0 || libc::dup2(from_child_write, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().with_context(|| format!("launch {}", binary.display()));
        // SAFETY: each descriptor is owned here and wrapped or closed exactly once.
        unsafe {
            libc::close(to_child_read);
            libc::close(from_child_write);
        }
        let child = match child {
            Ok(child) => child,
            Err(error) => {
                // SAFETY: as above.
                unsafe {
                    libc::close(to_child_write);
                    libc::close(from_child_read);
                }
                let _ = std::fs::remove_dir_all(&profile);
                return Err(error);
            }
        };
        // SAFETY: the descriptors are open and owned by nothing else from here on.
        let writer = Arc::new(Mutex::new(unsafe { File::from_raw_fd(to_child_write) }));
        let reader = unsafe { File::from_raw_fd(from_child_read) };
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::default();
        spawn_reader(reader, writer.clone(), pending.clone(), events);
        Ok(Self { child: Mutex::new(child), writer, pending, next_id: AtomicU64::new(1_000_000), profile })
    }

    /// Sends `method` and returns the channel its reply arrives on.
    pub fn call(&self, session: Option<&str>, method: &str, params: Value) -> mpsc::Receiver<anyhow::Result<Value>> {
        let (reply, receiver) = mpsc::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(id, reply.clone());
        if let Err(error) = write_message(&self.writer, id, session, method, params) {
            self.pending.lock().unwrap().remove(&id);
            let _ = reply.send(Err(error));
        }
        receiver
    }

    /// Sends `method` and waits for its reply.
    pub fn call_blocking(&self, session: Option<&str>, method: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
        self.call(session, method, params).recv_timeout(timeout).map_err(|_| anyhow!("{method}: no reply in {timeout:?}"))?
    }

    /// Sends `method` without waiting (input events): its reply, or error, is dropped.
    pub fn send(&self, session: Option<&str>, method: &str, params: Value) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = write_message(&self.writer, id, session, method, params);
    }

    /// The browser process's id, for the bench's CPU numbers.
    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    /// Opens `url` in a new page and attaches a flat session to it. Returns the session id.
    pub fn open_page(&self, url: &str) -> anyhow::Result<String> {
        let timeout = Duration::from_secs(10);
        let target = self.call_blocking(None, "Target.createTarget", json!({ "url": url }), timeout)?;
        let target_id = target["targetId"].as_str().ok_or_else(|| anyhow!("Target.createTarget: no targetId"))?;
        let attached = self.call_blocking(None, "Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), timeout)?;
        attached["sessionId"].as_str().map(str::to_owned).ok_or_else(|| anyhow!("Target.attachToTarget: no sessionId"))
    }
}

impl Chromium {
    /// Closes the browser (killing it, by handle, if it has not gone in a second) and removes its profile. Safe to
    /// call more than once; dropping calls it too.
    pub fn close(&self) {
        let mut child = self.child.lock().unwrap();
        if matches!(child.try_wait(), Ok(None)) {
            self.send(None, "Browser.close", json!({}));
            for _ in 0..40 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

impl Drop for Chromium {
    fn drop(&mut self) {
        self.close();
    }
}

/// The browser's own scale: `MILAGRE_GPUI_BROWSER_SPIKE_SCALE`, else 2 (every Mac screen Milagre runs on).
pub fn device_scale() -> f32 {
    std::env::var("MILAGRE_GPUI_BROWSER_SPIKE_SCALE").ok().and_then(|scale| scale.parse().ok()).unwrap_or(2.0)
}

fn unique() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn write_message(writer: &Mutex<File>, id: u64, session: Option<&str>, method: &str, params: Value) -> anyhow::Result<()> {
    let mut message = json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session {
        message["sessionId"] = Value::String(session.to_owned());
    }
    let mut bytes = serde_json::to_vec(&message)?;
    bytes.push(0);
    writer.lock().unwrap().write_all(&bytes).context("write to the browser")
}

fn spawn_reader(reader: File, writer: Arc<Mutex<File>>, pending: Arc<Mutex<HashMap<u64, Reply>>>, events: async_channel::Sender<CdpEvent>) {
    std::thread::Builder::new()
        .name("cdp-reader".into())
        .spawn(move || {
            let mut reader = BufReader::with_capacity(1 << 20, reader);
            let mut buffer = Vec::new();
            let mut ack_id = 1u64;
            loop {
                buffer.clear();
                match reader.read_until(0, &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if buffer.last() == Some(&0) {
                    buffer.pop();
                }
                if buffer.len() > MAX_MESSAGE {
                    continue;
                }
                let Ok(message) = serde_json::from_slice::<Value>(&buffer) else { continue };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = pending.lock().unwrap().remove(&id) {
                        let result = match message.get("error") {
                            Some(error) => Err(anyhow!("the browser rejected the command: {error}")),
                            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = reply.send(result);
                    }
                    continue;
                }
                let Some(method) = message.get("method").and_then(Value::as_str) else { continue };
                let session = message.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if method == "Page.screencastFrameAck" {
                    continue;
                }
                if method == "Page.screencastFrame"
                    && let Some(frame_session) = params.get("sessionId").and_then(Value::as_i64)
                {
                    ack_id += 1;
                    let _ = write_message(
                        &writer,
                        ack_id,
                        session.as_deref(),
                        "Page.screencastFrameAck",
                        json!({ "sessionId": frame_session }),
                    );
                }
                if events.send_blocking(CdpEvent { method: method.to_owned(), params, session }).is_err() {
                    break;
                }
            }
            // The browser went away: every caller still waiting hears so.
            for (_, reply) in pending.lock().unwrap().drain() {
                let _ = reply.send(Err(anyhow!("the browser closed")));
            }
        })
        .expect("spawn the CDP reader thread");
}
