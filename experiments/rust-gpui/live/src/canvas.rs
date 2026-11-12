//! The Designs and Artifact tabs on Milagre's daemon, as Electron's `ArtifactsProvider` (`ArtifactCard.tsx`) and
//! `ArtifactCanvas.tsx` drive them through `window.milagre.artifacts`:
//!
//! - Reads ([`fetch`], on a short request-only connection of the Chat's Project, each one of [`crate::daemon::READS`]):
//!   `artifact:list [{chatId}]` (the Chat's designs and its live Artifact page, inline replies left out),
//!   `artifact:comments [{chatId}]` (the comments sent on them, resolved ones with the agent's note), then for each
//!   design every version the host keeps (`artifact:get [{chatId, id, version}]`, its `document`), and for the page
//!   `artifact:get [{chatId, id}]` (its HTML, tabs and files' names) and each file in 256 KiB chunks
//!   (`artifact:asset [{chatId, name, offset}]`, base64). Versions and files are immutable: each is read once per
//!   Chat ([`Cache`]).
//! - When: the Chat opens, the window syncs again, and (as Electron's `revisionKey` and `designActivity`) once an
//!   agent step that shows, revises or deletes a design or page, or resolves a comment, has finished in the Chat
//!   ([`LiveCanvas::agent_event`]); and after this window's own write.
//! - The tabs show only when the list has a design (Designs) or a page (Artifact) for the Chat
//!   (`Panel::set_live_canvas`); each is a skeleton until its first read answers.
//! - Writes: Delete on a design (`artifact:delete [{chatId, id}]`, on a write connection; refused in read-only
//!   mode). Send with a chosen version goes to the Chat as Electron's message ("I chose the design …"), through the
//!   composer (`PanelEvent::FixInChat`). Placing new comments (`artifact:add-comments`) has no UI here yet, and
//!   resolving a comment is the agent's tool (`artifact_resolve_comment`), not a window command: see CLIENT-GAPS.md.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use gpui::{Context, Entity, Subscription, Task};
use milagre_gpui_spike::workspace::panel::Panel;
use milagre_gpui_spike::workspace::panel::artifacts::fixture::{ArtifactTab, HtmlArtifact, SentComment};
use milagre_gpui_spike::workspace::panel::artifacts::protocol::Asset;
use milagre_gpui_spike::workspace::panel::designs::fixture::DesignArtifact;
use milagre_gpui_spike::workspace::panel::designs::{DesignPin, DesignsEvent};
use serde_json::{Value, json};

use crate::daemon::Daemon;

/// Files of a page read at most (the page's own limit is the host's).
pub const MAX_ASSET_BYTES: usize = 48 * 1024 * 1024;
/// The step title an agent's `artifact_resolve_comment` shows (`RESOLVED_STEP`).
pub const RESOLVED_STEP: &str = "Resolved a design comment";

/// What one Chat's reads keep: design versions' documents by `(id, version)`, page files by hash.
#[derive(Default)]
pub struct Cache {
    documents: HashMap<(String, u32), Value>,
    files: HashMap<String, Arc<[u8]>>,
}

/// What one read brought back.
#[derive(Clone, Default)]
pub struct Fetched {
    pub designs: Vec<DesignArtifact>,
    pub pins: Vec<DesignPin>,
    pub page: Option<HtmlArtifact>,
    pub errors: Vec<String>,
    /// Every request, as `method args` (tests and evidence).
    pub asked: Vec<(String, Value)>,
}

impl Fetched {
    pub fn has_designs(&self) -> bool {
        !self.designs.is_empty()
    }

    pub fn has_page(&self) -> bool {
        self.page.is_some()
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn number(value: &Value, key: &str) -> Option<u32> {
    value[key].as_u64().and_then(|n| u32::try_from(n).ok())
}

/// The Chat's designs and page, and the comments on them (see the module doc). Reads only.
pub async fn fetch(daemon: &Daemon, project: &str, key: &str, cache: &Mutex<Cache>) -> Fetched {
    let mut fetched = Fetched::default();
    fn ask(fetched: &mut Fetched, method: &str, args: &Value) {
        fetched.asked.push((method.to_owned(), args.clone()));
    }
    let request = json!([{"chatId": key}]);
    ask(&mut fetched, "artifact:list", &request);
    let list = match daemon.read(project, "artifact:list", request.clone()).await {
        Ok(list) => list,
        Err(error) => {
            fetched.errors.push(format!("artifact:list: {error:#}"));
            return fetched;
        }
    };
    let summaries: Vec<&Value> = list.as_array().into_iter().flatten().filter(|s| s["inline"] != true).collect();
    if summaries.is_empty() {
        return fetched;
    }
    ask(&mut fetched, "artifact:comments", &request);
    let comments = match daemon.read(project, "artifact:comments", request).await {
        Ok(comments) => comments.as_array().cloned().unwrap_or_default(),
        Err(error) => {
            // A host from before comments were kept has none.
            fetched.errors.push(format!("artifact:comments: {error:#}"));
            Vec::new()
        }
    };

    // Designs: every kept version, oldest first; a version the host no longer keeps ends the run there.
    for summary in summaries.iter().filter(|s| s["format"] == "design") {
        let (id, Some(latest)) = (text(summary, "id"), number(summary, "version")) else { continue };
        let kept = number(summary, "versions").unwrap_or(1).clamp(1, latest);
        let first = latest + 1 - kept;
        let missing: Vec<u32> = {
            let cache = cache.lock().unwrap_or_else(|p| p.into_inner());
            (first..=latest).filter(|v| !cache.documents.contains_key(&(id.clone(), *v))).collect()
        };
        if !missing.is_empty() {
            let calls: Vec<(&'static str, Value)> =
                missing.iter().map(|v| ("artifact:get", json!([{"chatId": key, "id": id, "version": v}]))).collect();
            for (method, args) in &calls {
                ask(&mut fetched, method, args);
            }
            match daemon.read_many(project, calls).await {
                Ok(answers) => {
                    let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
                    for (version, answer) in missing.iter().zip(answers) {
                        match answer {
                            Ok(answer) if answer["document"].is_object() => {
                                cache.documents.insert((id.clone(), *version), answer["document"].clone());
                            }
                            Ok(_) => fetched.errors.push(format!("artifact:get {id} v{version}: no document")),
                            Err(error) => fetched.errors.push(format!("artifact:get {id} v{version}: {error:#}")),
                        }
                    }
                }
                Err(error) => fetched.errors.push(format!("artifact:get {id}: {error:#}")),
            }
        }
        let cache = cache.lock().unwrap_or_else(|p| p.into_inner());
        // The newest run of versions read without a gap.
        let mut start = latest + 1;
        while start > first && cache.documents.contains_key(&(id.clone(), start - 1)) {
            start -= 1;
        }
        let documents: Vec<Value> = (start..=latest).filter_map(|v| cache.documents.get(&(id.clone(), v)).cloned()).collect();
        let group = summary["group"].as_str().filter(|g| !g.is_empty()).map(str::to_owned);
        match DesignArtifact::from_documents(id.clone(), text(summary, "title"), group, start, documents) {
            Ok(design) => fetched.designs.push(design),
            Err(error) => fetched.errors.push(format!("design {id}: {error}")),
        }
    }
    let shown: std::collections::HashSet<&str> = fetched.designs.iter().map(|d| d.id.as_str()).collect();
    let mut numbers: HashMap<String, u32> = HashMap::new();
    let pins: Vec<DesignPin> = comments
        .iter()
        .filter(|c| shown.contains(c["design"]["id"].as_str().unwrap_or_default()))
        .filter_map(|c| {
            let design = c["design"]["id"].as_str()?.to_owned();
            let n = numbers.entry(design.clone()).or_insert(0);
            *n += 1;
            Some(DesignPin {
                id: text(c, "id"),
                version: number(&c["design"], "version")?,
                x: c["x"].as_f64()?,
                y: c["y"].as_f64()?,
                number: *n,
                text: text(c, "text"),
                resolved: c["resolved"].is_object(),
                design,
            })
        })
        .collect();
    fetched.pins = pins;

    // The page: its HTML, tabs and files, and the comments sent on it.
    if let Some(summary) = summaries.iter().find(|s| s["format"] == "html") {
        let id = text(summary, "id");
        let args = json!([{"chatId": key, "id": id}]);
        ask(&mut fetched, "artifact:get", &args);
        match daemon.read(project, "artifact:get", args).await {
            Ok(page) => {
                let mut assets = Vec::new();
                let mut total = 0usize;
                for file in page["assets"].as_array().into_iter().flatten() {
                    let (name, hash, size) = (text(file, "name"), text(file, "hash"), file["size"].as_u64().unwrap_or(0) as usize);
                    total += size;
                    if total > MAX_ASSET_BYTES {
                        fetched.errors.push(format!("artifact:asset {name}: over {MAX_ASSET_BYTES} bytes of files, not read"));
                        continue;
                    }
                    let known = cache.lock().unwrap_or_else(|p| p.into_inner()).files.get(&hash).cloned();
                    let bytes = match known {
                        Some(bytes) => bytes,
                        None => match read_file(daemon, project, key, &name, size, &mut fetched).await {
                            Some(bytes) => {
                                let bytes: Arc<[u8]> = Arc::from(bytes);
                                cache.lock().unwrap_or_else(|p| p.into_inner()).files.insert(hash, bytes.clone());
                                bytes
                            }
                            None => continue,
                        },
                    };
                    let mut asset = Asset::owned(&name, file["type"].as_str(), Vec::new());
                    asset.bytes = bytes;
                    assets.push(asset);
                }
                let title = page["title"].as_str().map_or_else(|| text(summary, "title"), str::to_owned);
                let tabs: Vec<ArtifactTab> = match page["tabs"].as_array().filter(|tabs| !tabs.is_empty()) {
                    Some(tabs) => tabs
                        .iter()
                        .map(|tab| ArtifactTab {
                            id: text(tab, "id").into(),
                            title: text(tab, "title").into(),
                            html: text(tab, "html").into(),
                        })
                        .collect(),
                    None => vec![ArtifactTab { id: "".into(), title: title.clone().into(), html: text(&page, "html").into() }],
                };
                let comments = comments
                    .iter()
                    .filter(|c| c["design"]["id"] == id.as_str())
                    .filter_map(|c| {
                        Some(SentComment {
                            id: text(c, "id").into(),
                            tab: c["tab"]["id"].as_str().unwrap_or_default().to_owned().into(),
                            x: c["x"].as_f64()?,
                            y: c["y"].as_f64()?,
                            anchor: c["anchor"].as_str().filter(|a| !a.is_empty()).map(|a| a.to_owned().into()),
                            text: text(c, "text").into(),
                            resolved: c["resolved"].is_object(),
                        })
                    })
                    .collect();
                fetched.page = Some(HtmlArtifact {
                    id: id.into(),
                    title: title.into(),
                    version: number(&page, "version").unwrap_or(1),
                    tabs,
                    assets,
                    comments,
                });
            }
            Err(error) => fetched.errors.push(format!("artifact:get {id}: {error:#}")),
        }
    }
    fetched
}

/// One page file, chunk by chunk (`artifact:asset` answers up to 256 KiB from `offset`).
async fn read_file(daemon: &Daemon, project: &str, key: &str, name: &str, size: usize, fetched: &mut Fetched) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(size);
    while bytes.len() < size || (size == 0 && bytes.is_empty()) {
        let args = json!([{"chatId": key, "name": name, "offset": bytes.len()}]);
        fetched.asked.push(("artifact:asset".to_owned(), args.clone()));
        let chunk = match daemon.read(project, "artifact:asset", args).await {
            Ok(chunk) => chunk,
            Err(error) => {
                fetched.errors.push(format!("artifact:asset {name}: {error:#}"));
                return None;
            }
        };
        let part = base64::engine::general_purpose::STANDARD.decode(chunk["base64"].as_str().unwrap_or_default()).ok()?;
        if part.is_empty() {
            break;
        }
        bytes.extend_from_slice(&part);
    }
    Some(bytes)
}

/// Whether an agent event (`agent:event`'s `event`) is a step that may change the Chat's designs, page or comments:
/// one that shows or revises them (an `artifact` step), deletes a design or resolves a comment.
pub fn touches_canvas(event: &Value) -> bool {
    let step = &event["step"];
    let title = step["title"].as_str().unwrap_or_default();
    step["kind"] == "artifact"
        || title == RESOLVED_STEP
        || title.contains("design_delete")
        || step["tool"].as_str().is_some_and(|t| t.starts_with("design_") || t.starts_with("artifact_"))
}

/// Evidence snapshots (`MILAGRE_GPUI_LIVE_PANEL=Designs|Artifact`): the Chat to show on that tab and its read, made
/// before the window opens.
#[derive(Clone)]
pub struct Seed {
    pub key: String,
    pub project: String,
    pub fetched: Fetched,
    pub tab: milagre_gpui_spike::workspace::panel::PanelTab,
}

impl gpui::Global for Seed {}

#[derive(Clone, Debug, PartialEq)]
struct Shown {
    key: String,
    project: String,
}

/// Keeps the Designs and Artifact tabs on the daemon's answers for the Chat the panel shows. Owned by the controller.
pub struct LiveCanvas {
    daemon: Arc<Daemon>,
    panel: Entity<Panel>,
    shown: Option<Shown>,
    cache: Arc<Mutex<Cache>>,
    /// Bumped on every Chat switch: an answer for an earlier Chat is dropped.
    generation: u64,
    reading: bool,
    /// Another read was asked for while one ran.
    again: bool,
    /// A step that touches the canvas started in the shown Chat since the last read.
    dirty: bool,
    sent: Vec<(String, Value)>,
    refused: Vec<String>,
    errors: Vec<String>,
    reads: u64,
    seeded: Option<(String, Fetched)>,
    _subscriptions: Vec<Subscription>,
    _tasks: Vec<Task<()>>,
}

impl LiveCanvas {
    pub fn new(daemon: Arc<Daemon>, panel: Entity<Panel>, cx: &mut Context<Self>) -> Self {
        let designs = panel.read(cx).designs().clone();
        let events = cx.subscribe(&designs, |this, _, event: &DesignsEvent, cx| {
            if let DesignsEvent::Delete(id) = event {
                this.delete(id.clone(), cx);
            }
        });
        Self {
            daemon,
            panel,
            shown: None,
            cache: Arc::new(Mutex::new(Cache::default())),
            generation: 0,
            reading: false,
            again: false,
            dirty: false,
            sent: Vec::new(),
            refused: Vec::new(),
            errors: Vec::new(),
            reads: 0,
            seeded: None,
            _subscriptions: vec![events],
            _tasks: Vec::new(),
        }
    }

    /// A read made before the window opened ([`Seed`]), applied when its Chat shows.
    pub fn seed(&mut self, key: &str, fetched: Fetched) {
        self.seeded = Some((key.to_owned(), fetched));
    }

    /// The panel shows Chat `key` of `project`: another Chat starts both tabs afresh (skeletons) and reads.
    pub fn show(&mut self, key: &str, project: &str, cx: &mut Context<Self>) {
        let shown = Shown { key: key.to_owned(), project: project.to_owned() };
        if self.shown.as_ref() == Some(&shown) {
            return;
        }
        self.shown = Some(shown);
        self.generation += 1;
        self.cache = Arc::new(Mutex::new(Cache::default()));
        self.dirty = false;
        let (designs, artifacts) = {
            let panel = self.panel.read(cx);
            (panel.designs().clone(), panel.artifacts().clone())
        };
        designs.update(cx, |d, cx| d.start_live(cx));
        artifacts.update(cx, |a, cx| a.start_live(cx));
        if let Some((_, fetched)) = self.seeded.take().filter(|(seed, _)| seed == key) {
            self.apply(key, fetched, cx);
            return;
        }
        self.read(cx);
    }

    /// The window synced again: the shown Chat is read again.
    pub fn resynced(&mut self, cx: &mut Context<Self>) {
        if self.shown.is_some() {
            self.read(cx);
        }
    }

    /// An `agent:event` (`{chatId, event}`): a canvas step in the shown Chat marks it; once a step or the turn has
    /// ended there, the Chat is read again.
    pub fn agent_event(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let Some(shown) = &self.shown else { return };
        if payload["chatId"].as_str() != Some(shown.key.as_str()) {
            return;
        }
        let event = &payload["event"];
        if touches_canvas(event) {
            self.dirty = true;
        }
        let ended = matches!(
            event["type"].as_str(),
            Some("step-completed" | "turn-completed" | "turn-failed" | "turn-interrupted" | "turn-cancelled")
        );
        if self.dirty && ended {
            self.dirty = false;
            self.read(cx);
        }
    }

    /// Reads the shown Chat's designs, page and comments ([`fetch`]) off the window's thread.
    pub fn read(&mut self, cx: &mut Context<Self>) {
        let Some(shown) = self.shown.clone() else { return };
        if self.reading {
            self.again = true;
            return;
        }
        self.reading = true;
        let (daemon, cache, generation) = (self.daemon.clone(), self.cache.clone(), self.generation);
        let work = crate::usage::off_thread(move || futures::executor::block_on(fetch(&daemon, &shown.project, &shown.key, &cache)));
        let task = cx.spawn(async move |this, cx| {
            let Ok(fetched) = work.await else { return };
            let _ = this.update(cx, |this, cx| {
                this.reading = false;
                this.reads += 1;
                this.sent.extend(fetched.asked.iter().cloned());
                if this.generation == generation
                    && let Some(key) = this.shown.as_ref().map(|s| s.key.clone())
                {
                    this.apply(&key, fetched, cx);
                }
                if std::mem::take(&mut this.again) {
                    this.read(cx);
                }
            });
        });
        self._tasks.retain(|task| !task.is_ready());
        self._tasks.push(task);
    }

    fn apply(&mut self, key: &str, fetched: Fetched, cx: &mut Context<Self>) {
        for error in &fetched.errors {
            eprintln!("live: canvas {key}: {error}");
        }
        self.errors.extend(fetched.errors.iter().cloned());
        let (has_designs, has_page) = (fetched.has_designs(), fetched.has_page());
        let (designs, artifacts) = {
            let panel = self.panel.read(cx);
            (panel.designs().clone(), panel.artifacts().clone())
        };
        designs.update(cx, |d, cx| d.set_live(fetched.designs, fetched.pins, cx));
        if let Some(page) = fetched.page {
            artifacts.update(cx, |a, cx| a.set_live_page(page, cx));
        }
        self.panel.update(cx, |panel, cx| panel.set_live_canvas(key.to_owned().into(), has_designs, has_page, cx));
        cx.notify();
    }

    /// Delete on a design: `artifact:delete [{chatId, id}]` on a write connection, then the Chat is read again. The
    /// board already dropped it; a refusal brings it back with the read.
    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(shown) = self.shown.clone() else { return };
        let args = json!([{"chatId": shown.key, "id": id}]);
        if self.daemon.read_only() {
            eprintln!("live: read-only, not sent: artifact:delete {args}");
            self.refused.push(format!("artifact:delete {args}"));
            self.read(cx);
            return;
        }
        self.sent.push(("artifact:delete".to_owned(), args.clone()));
        let daemon = self.daemon.clone();
        let work = crate::usage::off_thread(move || {
            futures::executor::block_on(async {
                let writer = daemon.writer(&shown.project).await?;
                writer.call("artifact:delete", args).await
            })
        });
        let task = cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => this.errors.push(format!("artifact:delete {id}: {error:#}")),
                    Err(_) => this.errors.push(format!("artifact:delete {id}: the write thread ended")),
                }
                this.read(cx);
            });
        });
        self._tasks.push(task);
    }

    /// Every request sent (tests and evidence).
    pub fn sent(&self) -> &[(String, Value)] {
        &self.sent
    }

    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    pub fn reads(&self) -> u64 {
        self.reads
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_steps_are_the_ones_that_change_designs_pages_or_comments() {
        assert!(touches_canvas(&json!({"type": "step-started", "step": {"kind": "artifact", "title": "Created Sign in"}})));
        assert!(touches_canvas(&json!({"type": "step-started", "step": {"kind": "other", "title": RESOLVED_STEP}})));
        assert!(touches_canvas(&json!({"type": "step-started", "step": {"kind": "other", "title": "mcp__milagre__design_delete"}})));
        assert!(!touches_canvas(&json!({"type": "step-started", "step": {"kind": "shell", "title": "ls"}})));
        assert!(!touches_canvas(&json!({"type": "text-delta", "text": "artifact"})));
    }
}
