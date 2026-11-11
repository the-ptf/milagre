//! The PR panel (P-09, `PullRequestPanel.tsx`): the tab of a Chat whose branch opened a pull request.
//!
//! - Header (`header.rs`): the repository and number linking to GitHub, the merge action (Merge, Merge when ready,
//!   Ready for review, or "Merges when ready"), the ⋯ menu (merge anyway, auto-merge, merge method, convert to
//!   draft, open on GitHub, copy link), the title, the state pill, author and age, the branches and counts, the
//!   status line (what blocks it, or how it ended) and the Worktree's work the PR does not have yet.
//! - Checks bar and the Summary / Files switch (`tabs.rs`).
//! - Summary (`summary.rs`): reviewers and labels with their pickers (`properties.rs`), then Description (GitHub's
//!   HTML through `github_html_to_markdown`), Checks and Comments, each a folding section.
//! - Files (`files.rs`): the PR's files as the folder tree; a click opens the diff view over the Chat column
//!   (`workspace::panel::diff`, WP-31; the window draws it through `diff::over_chat`) with every file of the PR, scrolled to the one picked, its review threads
//!   under their lines and the review bar over its bottom (`review.rs`). A line comment there goes to the viewer's
//!   pending review ("Add to review") or waits for the Chat ("Send to Chat", then "Send N comments").
//!
//! One [`PrView`] serves every Chat: [`PrView::set_chat`] reads the PR the Chat names through the [`bridge::PrBridge`]
//! (the fixture today) and brings back that PR's own tab, folds and picked file. Writes show at once and then go to
//! the bridge; a failure takes the change back and says why under the header.
//!
//! Not built (the desktop has them): the Link Chat variant (a Project avatar beside the repository), the 30 s poll,
//! the merge method remembered across launches (it lasts the session), avatars from GitHub (initials stand in), the
//! header's narrow-width label swaps (the container queries). "Fix in Chat" and "N files not in the PR yet" are
//! [`PrEvent`]s the window answers.

mod avatar;
pub mod bridge;
mod files;
pub mod fixture;
mod header;
pub mod model;
mod properties;
mod review;
mod summary;
mod tabs;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use gpui::{AnyElement, Context, Entity, EventEmitter, ScrollHandle, SharedString, Subscription, Task, Window, div, prelude::*, px};
use gpui_base::TextViewState;

use self::bridge::{PrBridge, Write, apply};
use self::fixture::{FixtureBridge, Variant};
use self::model::{MergeMethod, PullRequestDetail, ReviewEvent, repo_of};
use self::review::ReviewForm;
use crate::logic::files::github_markdown::github_html_to_markdown;
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt};
use crate::ui::{EmptySize, EmptyState, IconName, ScrollArea, SpinnerRing};
use crate::workspace::panel::diff::DiffView;

/// What the PR tab asks of the rest of the window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrEvent {
    /// The Worktree's work the PR does not have yet: show the Changes tab.
    OpenChanges,
    /// "Fix in Chat" on a thread: send this to the Chat.
    FixInChat(String),
}

impl EventEmitter<PrEvent> for PrView {}

/// The merge button asks twice: the first press arms it, and it disarms after this long.
pub const CONFIRM_FOR: Duration = Duration::from_secs(4);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PrTab {
    #[default]
    Summary,
    Files,
}

/// Which two-step action is armed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirm {
    Merge,
    Admin,
}

/// The PR sections that fold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Description,
    Checks,
    Comments,
}

/// What each PR keeps of its tab.
#[derive(Clone, Debug)]
struct ViewState {
    tab: PrTab,
    open: HashSet<Section>,
    newest_first: bool,
    collapsed: HashSet<String>,
    selected: Option<String>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            tab: PrTab::Summary,
            open: HashSet::from([Section::Comments]),
            newest_first: true,
            collapsed: HashSet::new(),
            selected: None,
        }
    }
}

pub struct PrView {
    chat: SharedString,
    number: Option<u32>,
    bridge: Rc<dyn PrBridge>,
    detail: Option<PullRequestDetail>,
    /// Why the PR could not be read.
    read_error: Option<String>,
    /// Uncommitted files in the Worktree: what the PR does not have yet.
    local_files: usize,
    states: HashMap<u32, ViewState>,
    /// The merge method last picked in each repository (the session's, the desktop saves it).
    methods: HashMap<String, MergeMethod>,
    confirming: Option<Confirm>,
    _confirm_timer: Option<Task<()>>,
    busy: Option<&'static str>,
    write_error: Option<String>,
    texts: HashMap<String, Entity<TextViewState>>,
    /// The diff view, made on the first pick, and the PR and file it was opened on (if it is open).
    diff: Option<Entity<DiffView>>,
    diff_open: Option<SharedString>,
    /// The file whose header the diff has pinned: the tree marks it.
    visible: Option<String>,
    /// What the diff's thread rows were last drawn from, so they are measured again only when it changes.
    diff_threads: String,
    _diff_sub: Option<Subscription>,
    review: ReviewForm,
    scroll: ScrollHandle,
    seeded: bool,
    renders: usize,
}

impl PrView {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        let forced = if cfg!(test) { None } else { std::env::var("MILAGRE_GPUI_PR_VARIANT").ok().and_then(|key| Variant::from_key(&key)) };
        let bridge: Rc<dyn PrBridge> = Rc::new(forced.map_or_else(FixtureBridge::new, FixtureBridge::forced));
        Self::with_bridge(bridge)
    }

    pub fn with_bridge(bridge: Rc<dyn PrBridge>) -> Self {
        Self {
            chat: SharedString::default(),
            number: None,
            bridge,
            detail: None,
            read_error: None,
            local_files: 0,
            states: HashMap::new(),
            methods: HashMap::new(),
            confirming: None,
            _confirm_timer: None,
            busy: None,
            write_error: None,
            texts: HashMap::new(),
            diff: None,
            diff_open: None,
            visible: None,
            diff_threads: String::new(),
            _diff_sub: None,
            review: ReviewForm::default(),
            scroll: ScrollHandle::new(),
            seeded: false,
            renders: 0,
        }
    }

    /// Shows the PR `chat` names (`number`), with the count of uncommitted files its Worktree holds.
    pub fn set_chat(&mut self, chat: SharedString, number: Option<u32>, local_files: usize, cx: &mut Context<Self>) {
        self.chat = chat;
        self.local_files = local_files;
        self.confirming = None;
        self._confirm_timer = None;
        self.write_error = None;
        self.busy = None;
        self.review = ReviewForm::default();
        if self.number != number || self.detail.is_none() {
            self.number = number;
            self.load(cx);
        }
        cx.notify();
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.diff_open = None;
        self.texts.clear();
        match self.number.map(|number| self.bridge.detail(number)) {
            Some(Ok(detail)) => {
                self.detail = Some(detail);
                self.read_error = None;
            }
            Some(Err(message)) => {
                self.detail = None;
                self.read_error = Some(message);
            }
            None => {
                self.detail = None;
                self.read_error = Some("This Chat has no PR.".to_string());
            }
        }
        self.rebuild_texts(cx);
        self.rebuild_diff(cx);
    }

    /// One parsed text per description and comment, kept so a redraw never parses again.
    fn rebuild_texts(&mut self, cx: &mut Context<Self>) {
        let Some(pr) = &self.detail else { return };
        let mut wanted: Vec<(String, String)> = vec![("description".to_string(), pr.body.clone())];
        wanted.extend(pr.comments.iter().map(|c| (c.id.clone(), c.body.clone())));
        wanted.extend(pr.threads.iter().flat_map(|t| t.comments.iter().map(|c| (c.id.clone(), c.body.clone()))));
        self.texts.retain(|key, _| wanted.iter().any(|(k, _)| k == key));
        for (key, body) in wanted {
            self.texts.entry(key).or_insert_with(|| {
                let source = github_html_to_markdown(&body);
                cx.new(|cx| TextViewState::markdown(&source, cx))
            });
        }
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn detail(&self) -> Option<&PullRequestDetail> {
        self.detail.as_ref()
    }

    pub fn number(&self) -> Option<u32> {
        self.number
    }

    pub fn tab(&self) -> PrTab {
        self.state().tab
    }

    pub fn busy(&self) -> Option<&'static str> {
        self.busy
    }

    pub fn confirming(&self) -> Option<Confirm> {
        self.confirming
    }

    pub fn write_error(&self) -> Option<&str> {
        self.write_error.as_deref()
    }

    pub fn selected(&self) -> Option<String> {
        self.state().selected
    }

    pub fn is_open(&self, section: Section) -> bool {
        self.state().open.contains(&section)
    }

    pub fn is_collapsed(&self, folder: &str) -> bool {
        self.state().collapsed.contains(folder)
    }

    pub fn newest_first(&self) -> bool {
        self.state().newest_first
    }

    /// The merge method in force for the open PR.
    pub fn method(&self) -> MergeMethod {
        self.detail
            .as_ref()
            .and_then(|pr| repo_of(&pr.url))
            .and_then(|repo| self.methods.get(&repo).copied())
            .or_else(|| self.detail.as_ref().and_then(|pr| pr.auto_merge))
            .unwrap_or(MergeMethod::Squash)
    }

    fn state(&self) -> ViewState {
        self.number.and_then(|n| self.states.get(&n)).cloned().unwrap_or_default()
    }

    fn state_mut(&mut self) -> &mut ViewState {
        self.states.entry(self.number.unwrap_or(0)).or_default()
    }

    pub fn set_tab(&mut self, tab: PrTab, cx: &mut Context<Self>) {
        self.state_mut().tab = tab;
        cx.notify();
    }

    pub fn toggle_section(&mut self, section: Section, cx: &mut Context<Self>) {
        let open = &mut self.state_mut().open;
        if !open.remove(&section) {
            open.insert(section);
        }
        cx.notify();
    }

    pub fn toggle_sort(&mut self, cx: &mut Context<Self>) {
        let state = self.state_mut();
        state.newest_first = !state.newest_first;
        cx.notify();
    }

    pub fn toggle_folder(&mut self, path: &str, cx: &mut Context<Self>) {
        let collapsed = &mut self.state_mut().collapsed;
        if !collapsed.remove(path) {
            collapsed.insert(path.to_string());
        }
        cx.notify();
    }

    pub fn set_method(&mut self, method: MergeMethod, cx: &mut Context<Self>) {
        if let Some(repo) = self.detail.as_ref().and_then(|pr| repo_of(&pr.url)) {
            self.methods.insert(repo, method);
        }
        cx.notify();
    }

    /// Opens a file of the PR in the Files tab's diff.
    pub fn open_file(&mut self, path: &str, cx: &mut Context<Self>) {
        let state = self.state_mut();
        state.selected = Some(path.to_string());
        state.tab = PrTab::Files;
        self.rebuild_diff(cx);
        cx.notify();
    }

    pub fn close_file(&mut self, cx: &mut Context<Self>) {
        self.state_mut().selected = None;
        self.diff_open = None;
        self.visible = None;
        cx.notify();
    }

    /// Whether the Files tab has a file open: its diff shows over the Chat column.
    pub fn diff_over_chat(&self) -> bool {
        self.state().tab == PrTab::Files && self.diff_open.is_some() && self.detail.is_some()
    }

    /// The diff view while it is open.
    pub fn diff_view(&self) -> Option<Entity<DiffView>> {
        self.diff_open.as_ref().and(self.diff.clone())
    }

    /// The file the diff has pinned at the top, which the tree marks.
    pub fn visible_path(&self) -> Option<&str> {
        self.visible.as_deref()
    }

    fn rebuild_diff(&mut self, cx: &mut Context<Self>) {
        let (Some(pr), Some(number)) = (self.detail.clone(), self.number) else {
            self.diff_open = None;
            return;
        };
        let Some(path) = self.state().selected else {
            self.diff_open = None;
            return;
        };
        if !pr.files.iter().any(|file| file.path == path) {
            self.state_mut().selected = None;
            self.diff_open = None;
            return;
        }
        let key: SharedString = format!("{}:{number}:{path}", self.chat).into();
        if self.diff_open.as_ref() == Some(&key) {
            return;
        }
        let diff = self.diff_entity(cx);
        let source = files::diff_source(&self.chat, &pr, number, self.bridge.clone());
        diff.update(cx, |diff, cx| diff.set_source(source, Some(&path), cx));
        self.diff_threads.clear();
        self.visible = Some(path);
        self.diff_open = Some(key);
        self.sync_diff_threads(cx);
    }

    /// Runs a write: shows its change at once, asks the bridge, and takes the change back with the reason if the
    /// bridge refuses.
    pub fn write(&mut self, label: &'static str, write: Write, cx: &mut Context<Self>) -> bool {
        let (Some(pr), Some(number)) = (self.detail.clone(), self.number) else { return false };
        self.write_error = None;
        self.busy = Some(label);
        self.detail = Some(apply(&pr, &write));
        let result = self.bridge.write(number, &write);
        self.busy = None;
        let ok = match result {
            Ok(()) => true,
            Err(message) => {
                self.detail = Some(pr);
                self.write_error = Some(message);
                false
            }
        };
        self.rebuild_texts(cx);
        self.rebuild_diff(cx);
        self.sync_diff_threads(cx);
        cx.notify();
        ok
    }

    /// The merge button: the first press arms it, the second (within [`CONFIRM_FOR`]) merges. `admin` is "Merge
    /// anyway" past the rules that block it.
    pub fn merge(&mut self, admin: bool, cx: &mut Context<Self>) {
        let step = if admin { Confirm::Admin } else { Confirm::Merge };
        if self.confirming != Some(step) {
            self.confirming = Some(step);
            self._confirm_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CONFIRM_FOR).await;
                this.update(cx, |this, cx| this.disarm(cx)).ok();
            }));
            cx.notify();
            return;
        }
        self.disarm(cx);
        let method = self.method();
        self.write("merge", Write::Merge { method, admin, auto: None }, cx);
    }

    pub fn disarm(&mut self, cx: &mut Context<Self>) {
        if self.confirming.take().is_some() {
            self._confirm_timer = None;
            cx.notify();
        }
    }

    pub fn set_auto_merge(&mut self, on: bool, cx: &mut Context<Self>) {
        let method = self.method();
        self.write("auto", Write::Merge { method, admin: false, auto: Some(on) }, cx);
    }

    pub fn set_draft(&mut self, draft: bool, cx: &mut Context<Self>) {
        self.write("ready", Write::Ready { draft }, cx);
    }

    pub fn submit_review(&mut self, event: ReviewEvent, body: String, cx: &mut Context<Self>) -> bool {
        self.write("review", Write::SubmitReview { event, body }, cx)
    }

    /// Snapshot runs pick the tab and the file through the environment (never in tests).
    fn apply_env_seed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if cfg!(test) || self.seeded || self.detail.is_none() {
            return;
        }
        self.seeded = true;
        match std::env::var("MILAGRE_GPUI_PR_TAB").as_deref() {
            Ok("files") => self.state_mut().tab = PrTab::Files,
            Ok("summary") | Err(_) => {}
            Ok(_) => {}
        }
        if let Ok(sections) = std::env::var("MILAGRE_GPUI_PR_SECTIONS") {
            let open = &mut self.state_mut().open;
            for (key, section) in [("description", Section::Description), ("checks", Section::Checks), ("comments", Section::Comments)] {
                if sections.split(',').any(|s| s == key) {
                    open.insert(section);
                } else {
                    open.remove(&section);
                }
            }
        }
        if let Ok(file) = std::env::var("MILAGRE_GPUI_PR_FILE") {
            let path = self.detail.as_ref().and_then(|pr| pr.files.iter().find(|f| f.path.ends_with(&file)).map(|f| f.path.clone()));
            if let Some(path) = path {
                self.open_file(&path, cx);
            }
        }
        if let Ok(scenario) = std::env::var("MILAGRE_GPUI_GIT_DIALOG") {
            crate::overlays::dialogs::git_actions::open_from_env(&scenario, window, cx);
        }
    }

    fn notice(&self, theme: &crate::theme::Theme) -> AnyElement {
        match &self.read_error {
            Some(message) => div()
                .debug_selector(|| "pr-notice".to_string())
                .child(
                    EmptyState::new().size(EmptySize::Panel).icon(IconName::GitPullRequest).title("No pull request").help(message.clone()),
                )
                .into_any_element(),
            None => div()
                .debug_selector(|| "pr-notice".to_string())
                .flex()
                .items_center()
                .gap(px(8.0))
                .p(px(12.0))
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(SpinnerRing::new())
                .child("Loading the PR\u{2026}")
                .into_any_element(),
        }
    }
}

impl Render for PrView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        self.apply_env_seed(window, cx);
        let theme = *cx.theme();
        let root = div().id("pr-view").debug_selector(|| "pr-root".to_string()).flex().flex_col().size_full().text_color(theme.ink);
        let Some(pr) = self.detail.clone() else { return root.child(self.notice(&theme)) };
        let state = self.state();
        let content = match state.tab {
            PrTab::Summary => self.summary(&pr, &state, window, cx),
            PrTab::Files => self.files(&pr, &state, cx),
        };
        let column = div()
            .flex()
            .flex_col()
            .w_full()
            .pb(px(12.0))
            .child(self.header(&pr, cx))
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            .child(self.tabs(&pr, state.tab, cx))
            .child(content);
        // The diff opens over the Chat column (`diff::over_chat`); the list keeps the whole body.
        let list = div().relative().min_h_0().flex_1().child(ScrollArea::new("pr-scroll", &self.scroll).child(column));
        root.child(list)
    }
}

/// How many uncommitted files the Worktree has: what an open PR does not have yet (`useLocalChanges`).
pub fn local_files(data: &crate::workspace::panel::changes::data::ChangesData) -> usize {
    match data {
        crate::workspace::panel::changes::data::ChangesData::Ready(changes) => changes.uncommitted.files.len(),
        _ => 0,
    }
}
