//! The Changes panel (P-02 to P-04): the Worktree's changed files and commits, and the diff of the file picked.
//!
//! - Header: file count and `+n −m` totals with the Unified / Split buttons, the comparison picker (Automatic and
//!   the branches `logic::diff::git::comparison_options` lists) beside the current branch, and the Files /
//!   Commits segmented control.
//! - Files: the list "Not committed" and the list "On this branch", each flat up to ten files and the folder
//!   tree beyond (`files.rs`); a click opens the diff view under the lists (`workspace::panel::diff`, WP-31) with
//!   every file of that list, scrolled to the one picked; the list marks the file whose header is pinned.
//! - Commits: the commits since the base; a click opens one with its files (`commits.rs`), and a file of it opens
//!   the commit's files in the diff view, read-only.
//!
//! One [`ChangesView`] serves every Chat: [`ChangesView::set_chat`] swaps the data and brings back that Chat's
//! own view, picked file, comparison and folded folders. It is mounted as a cached view by the panel, so it
//! renders only when something it shows changes (typing in the composer never reaches it).
//!
//! "Send N comments" in the diff is a [`ChangesEvent::SendToChat`], which the panel sends to the Chat as it sends
//! "Fix in Chat". Not built here: the Link variant, the refresh button and the "branch no longer exists" notice.

pub mod commits;
pub mod data;
pub mod diff;
pub mod files;
pub mod fixture;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, AnyView, ClickEvent, Context, Entity, EventEmitter, FontWeight, ScrollHandle, SharedString, StyleRefinement, Subscription,
    Window, div, prelude::*, px, relative,
};

use self::data::{ChangesData, Section, WorktreeChanges};
use self::files::{RowEnv, counts_inline};
use crate::logic::diff::git::{DiffFileEntry, comparison_options};
use crate::theme::{ActiveTheme, CONTROL_XS, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{
    EmptySize, EmptyState, Icon, IconName, IconSize, ScrollArea, SectionLabel, Segmented, SegmentedOption, Select, SelectOption,
    SelectVariant, Skeleton, Tooltip,
};
use crate::workspace::panel::diff::{DiffEvent, DiffLayout, DiffPrefs, DiffView};

/// Files or Commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum View {
    #[default]
    Files,
    Commits,
}

/// How the diff lays its two sides out: the session's [`DiffPrefs`], shared with every diff (the desktop remembers it
/// across launches).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Layout {
    #[default]
    Unified,
    Split,
}

impl From<Layout> for DiffLayout {
    fn from(layout: Layout) -> Self {
        match layout {
            Layout::Unified => DiffLayout::Unified,
            Layout::Split => DiffLayout::Split,
        }
    }
}

/// What the Changes panel asks of the window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangesEvent {
    /// "Send N comments" in the diff: the message for the Chat.
    SendToChat(String),
}

impl EventEmitter<ChangesEvent> for ChangesView {}

/// Where a file was picked: one of the two lists, or a commit's files.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Section(Section),
    Commit(String),
}

impl Source {
    /// A short stable key for element ids.
    pub fn key(&self) -> String {
        match self {
            Source::Section(Section::Uncommitted) => "u".to_string(),
            Source::Section(Section::Committed) => "c".to_string(),
            Source::Commit(sha) => format!("k{}", &sha[..8.min(sha.len())]),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selected {
    pub source: Source,
    pub path: String,
}

/// One Chat's own view of its changes.
#[derive(Clone, Debug, Default)]
struct ViewState {
    view: View,
    /// The comparison base: `""` is Automatic, else a full ref.
    comparison: SharedString,
    selected: Option<Selected>,
    collapsed: HashSet<String>,
    open_commit: Option<String>,
}

/// The share of the body the lists keep while a diff is open.
const LIST_SHARE: f32 = 0.42;
const HEADER_PAD: f32 = 12.0;

pub struct ChangesView {
    chat: SharedString,
    data: ChangesData,
    states: HashMap<SharedString, ViewState>,
    /// The diff view, made on the first pick, and what it shows (source key and path), if it is open.
    diff: Option<Entity<DiffView>>,
    diff_open: Option<SharedString>,
    /// The file whose header the diff has pinned: the list marks it.
    visible: Option<String>,
    _diff_sub: Option<Subscription>,
    list_scroll: ScrollHandle,
    renders: usize,
}

impl ChangesView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        if cfg!(not(test)) {
            let layout = match std::env::var("MILAGRE_GPUI_CHANGES_LAYOUT").as_deref() {
                Ok("split") => Some(DiffLayout::Split),
                Ok("unified") => Some(DiffLayout::Unified),
                _ => None,
            };
            let wrap = std::env::var("MILAGRE_GPUI_DIFF_WRAP").is_ok();
            if layout.is_some() || wrap {
                let prefs = DiffPrefs::get(cx);
                cx.set_global(DiffPrefs { layout: layout.unwrap_or(prefs.layout), wrap: wrap || prefs.wrap });
            }
        }
        Self {
            chat: SharedString::default(),
            data: ChangesData::Loading,
            states: HashMap::new(),
            diff: None,
            diff_open: None,
            visible: None,
            _diff_sub: None,
            list_scroll: ScrollHandle::new(),
            renders: 0,
        }
    }

    /// Shows `chat`'s changes: its data, and the view, picked file and folds it had.
    pub fn set_chat(&mut self, chat: SharedString, data: ChangesData, cx: &mut Context<Self>) {
        self.chat = chat;
        self.data = data;
        self.rebuild_diff(cx);
        cx.notify();
    }

    /// Replaces the data for the same Chat (a read finished, a refresh came back).
    pub fn set_data(&mut self, data: ChangesData, cx: &mut Context<Self>) {
        self.data = data;
        self.rebuild_diff(cx);
        cx.notify();
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn view(&self) -> View {
        self.state().view
    }

    pub fn layout(&self, cx: &gpui::App) -> Layout {
        match DiffPrefs::get(cx).layout {
            DiffLayout::Unified => Layout::Unified,
            DiffLayout::Split => Layout::Split,
        }
    }

    pub fn selected(&self) -> Option<&Selected> {
        self.states.get(&self.chat).and_then(|s| s.selected.as_ref())
    }

    /// The diff view while it is open.
    pub fn diff_view(&self) -> Option<Entity<DiffView>> {
        self.diff_open.as_ref().and(self.diff.clone())
    }

    /// The file the diff has pinned at the top, which the list marks.
    pub fn visible_path(&self) -> Option<&str> {
        self.visible.as_deref()
    }

    pub fn comparison(&self) -> SharedString {
        self.state().comparison
    }

    pub fn open_commit(&self) -> Option<&str> {
        self.states.get(&self.chat).and_then(|s| s.open_commit.as_deref())
    }

    pub fn is_collapsed(&self, folder: &str) -> bool {
        self.states.get(&self.chat).is_some_and(|s| s.collapsed.contains(folder))
    }

    /// The file count the panel's Changes tab shows.
    pub fn file_count(&self) -> usize {
        self.data.file_count()
    }

    fn state(&self) -> ViewState {
        self.states.get(&self.chat).cloned().unwrap_or_default()
    }

    fn state_mut(&mut self) -> &mut ViewState {
        self.states.entry(self.chat.clone()).or_default()
    }

    pub fn set_view(&mut self, view: View, cx: &mut Context<Self>) {
        self.state_mut().view = view;
        self.rebuild_diff(cx);
        cx.notify();
    }

    pub fn set_layout(&mut self, layout: Layout, cx: &mut Context<Self>) {
        if self.layout(cx) == layout {
            return;
        }
        match &self.diff {
            Some(diff) => diff.update(cx, |diff, cx| diff.set_layout(layout.into(), cx)),
            None => {
                let prefs = DiffPrefs::get(cx);
                cx.set_global(DiffPrefs { layout: layout.into(), ..prefs });
            }
        }
        cx.notify();
    }

    pub fn select_comparison(&mut self, value: SharedString, cx: &mut Context<Self>) {
        self.state_mut().comparison = value;
        cx.notify();
    }

    pub fn toggle_folder(&mut self, source: &Source, path: &str, cx: &mut Context<Self>) {
        let _ = source;
        let collapsed = &mut self.state_mut().collapsed;
        if !collapsed.remove(path) {
            collapsed.insert(path.to_string());
        }
        cx.notify();
    }

    pub fn toggle_commit(&mut self, sha: &str, cx: &mut Context<Self>) {
        let state = self.state_mut();
        state.open_commit = if state.open_commit.as_deref() == Some(sha) { None } else { Some(sha.to_string()) };
        // A file picked in another commit's list goes away with it.
        if matches!(&state.selected, Some(Selected { source: Source::Commit(open), .. }) if Some(open.as_str()) != state.open_commit.as_deref())
        {
            state.selected = None;
        }
        self.rebuild_diff(cx);
        cx.notify();
    }

    pub fn select_file(&mut self, source: Source, path: String, cx: &mut Context<Self>) {
        self.state_mut().selected = Some(Selected { source, path });
        self.rebuild_diff(cx);
        cx.notify();
    }

    pub fn close_diff(&mut self, cx: &mut Context<Self>) {
        self.state_mut().selected = None;
        self.diff_open = None;
        self.visible = None;
        cx.notify();
    }

    fn diff_entity(&mut self, cx: &mut Context<Self>) -> Entity<DiffView> {
        if let Some(diff) = &self.diff {
            return diff.clone();
        }
        let diff = cx.new(DiffView::new);
        self._diff_sub = Some(cx.subscribe(&diff, |this, _, event: &DiffEvent, cx| match event {
            DiffEvent::Close => this.close_diff(cx),
            DiffEvent::Send(message) => {
                this.close_diff(cx);
                cx.emit(ChangesEvent::SendToChat(message.clone()));
            }
            DiffEvent::VisibleFile(path) => {
                if this.visible != *path {
                    this.visible = path.clone();
                    cx.notify();
                }
            }
            DiffEvent::Refresh | DiffEvent::AddToReview { .. } => {}
        }));
        self.diff = Some(diff.clone());
        diff
    }

    /// Opens the diff on the picked file, when the data has it and the view shows its list.
    fn rebuild_diff(&mut self, cx: &mut Context<Self>) {
        let state = self.state();
        let source = match (&state.selected, &self.data) {
            (Some(selected), ChangesData::Ready(changes)) if self.selection_listed(&state, selected, changes) => {
                diff::source_for(&self.chat, &selected.source, changes).map(|source| (selected.clone(), source))
            }
            _ => None,
        };
        let Some((selected, source)) = source else {
            if state.selected.is_some() {
                self.state_mut().selected = None;
            }
            self.diff_open = None;
            self.visible = None;
            return;
        };
        // A refresh (new data) shows the new patches even for the same pick.
        let data = match &self.data {
            ChangesData::Ready(changes) => std::rc::Rc::as_ptr(changes) as usize,
            _ => 0,
        };
        let key: SharedString = format!("{}:{data:x}:{}:{}", self.chat, selected.source.key(), selected.path).into();
        if self.diff_open.as_ref() == Some(&key) {
            return;
        }
        let diff = self.diff_entity(cx);
        diff.update(cx, |diff, cx| diff.set_source(source, Some(&selected.path), cx));
        self.visible = Some(selected.path.clone());
        self.diff_open = Some(key);
    }

    /// Whether the picked file is still in the list it was picked from, and that list is on screen.
    fn selection_listed(&self, state: &ViewState, selected: &Selected, changes: &WorktreeChanges) -> bool {
        match (&selected.source, state.view) {
            (Source::Section(section), View::Files) => changes.list(*section).files.iter().any(|f| f.path == selected.path),
            (Source::Commit(sha), View::Commits) => {
                state.open_commit.as_deref() == Some(sha.as_str())
                    && changes.commit_files.get(sha).is_some_and(|r| r.files.iter().any(|f| f.path == selected.path))
            }
            _ => false,
        }
    }
}

/// The 24px Unified / Split button. The glyphs are drawn (a frame with a bar across the top, or down the
/// middle) until `LayoutTop` and `Layout2Column` are generated into `IconName`.
fn layout_button(id: &'static str, kind: Layout, active: bool, theme: &Theme, cx: &mut Context<ChangesView>) -> AnyElement {
    let color = if active { theme.ink } else { theme.ink3 };
    let hover = theme.hover;
    let bar = div().absolute().bg(color);
    let glyph = div().relative().flex_none().size(px(14.0)).rounded(px(3.0)).border_1().border_color(color).child(match kind {
        Layout::Unified => bar.left_0().right_0().top(px(3.5)).h(px(1.0)),
        Layout::Split => bar.top_0().bottom_0().left(px(5.5)).w(px(1.0)),
    });
    div()
        .id(id)
        .debug_selector(move || id.to_string())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(CONTROL_XS)
        .rounded(RADIUS_CONTROL)
        .cursor_pointer()
        .when(active, |el| el.bg(theme.hover2))
        .when(!active, |el| el.hover(move |style| style.bg(hover)))
        .tooltip(Tooltip::text(match kind {
            Layout::Unified => "Unified",
            Layout::Split => "Split",
        }))
        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.set_layout(kind, cx)))
        .child(glyph)
        .into_any_element()
}

fn skeleton(theme: &Theme) -> AnyElement {
    let bar = |id: &'static str, width: f32| Skeleton::new().pulse(id).h(px(12.0)).w(px(width));
    div()
        .debug_selector(|| "changes-skeleton".to_string())
        .flex()
        .flex_col()
        .gap(px(14.0))
        .p(px(HEADER_PAD))
        .child(bar("sk-head", 120.0))
        .child(Skeleton::new().h(px(24.0)).w_full())
        .children((0..6).map(|i| {
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(Skeleton::new().h(px(14.0)).w(px(14.0)))
                .child(Skeleton::new().h(px(12.0)).w(px(90.0 + (i * 23 % 90) as f32)))
                .child(div().flex_1())
                .child(Skeleton::new().secondary().h(px(12.0)).w(px(40.0)))
        }))
        .text_color(theme.ink)
        .into_any_element()
}

impl ChangesView {
    fn header(&self, changes: &WorktreeChanges, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let state = self.state();
        let (added, removed) = changes.totals();
        let count = changes.file_count();
        let counts = div()
            .flex()
            .min_w_0()
            .flex_1()
            .items_center()
            .gap(px(8.0))
            .text_step(TEXT_12)
            .child(
                div()
                    .debug_selector(|| "changes-count".to_string())
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink2)
                    .child(format!("{count} {}", if count == 1 { "file" } else { "files" })),
            )
            .child(counts_inline(&theme, added, removed));
        let toolbar = div()
            .flex()
            .flex_none()
            .items_center()
            .h(px(36.0))
            .px(px(HEADER_PAD))
            .gap(px(2.0))
            .child(counts)
            .child(layout_button("layout-unified", Layout::Unified, self.layout(cx) == Layout::Unified, &theme, cx))
            .child(layout_button("layout-split", Layout::Split, self.layout(cx) == Layout::Split, &theme, cx));

        let history = &changes.history;
        let branch = history
            .branch
            .clone()
            .or_else(|| history.head.as_ref().map(|h| h[..8.min(h.len())].to_string()))
            .unwrap_or_else(|| "HEAD".into());
        let options = comparison_options(Some(history)).into_iter().map(|o| {
            let mut option = SelectOption::new(o.value, o.label).disabled(o.disabled);
            if let Some(description) = o.description {
                option = option.description(description);
            }
            if !o.group.is_empty() {
                option = option.group(o.group);
            }
            option
        });
        let view = cx.entity().downgrade();
        let compare = div()
            .flex()
            .flex_none()
            .items_center()
            .min_w_0()
            .gap(px(8.0))
            .px(px(HEADER_PAD))
            .pb(px(8.0))
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child(
                Select::new("comparison", state.comparison.clone(), options)
                    .variant(SelectVariant::Chip)
                    .compact()
                    .searchable()
                    .width(280.0)
                    .on_change(move |value, _window, cx| {
                        let value = value.clone();
                        view.update(cx, |this, cx| this.select_comparison(value, cx)).ok();
                    }),
            )
            .child("\u{2190}")
            .child(Icon::new(IconName::GitBranch).size(IconSize::S14).color(theme.ink3))
            .child(
                div()
                    .debug_selector(|| "current-branch".to_string())
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .font_family(mono())
                    .text_step(TEXT_11)
                    .child(branch),
            );

        let view = cx.entity().downgrade();
        let files_total = Some(count as u32).filter(|n| *n > 0);
        let mut files = SegmentedOption::new("files", "Files");
        if let Some(n) = files_total {
            files = files.count(n);
        }
        let mut commits = SegmentedOption::new("commits", "Commits");
        if let Some(n) = history.total.filter(|n| *n > 0) {
            commits = commits.count(n);
        }
        let switch = div().flex_none().px(px(HEADER_PAD)).pb(px(8.0)).child(
            Segmented::new("changes-view", Some(if state.view == View::Files { "files" } else { "commits" }), [files, commits]).on_change(
                move |value, _window, cx| {
                    let next = if value.as_ref() == "commits" { View::Commits } else { View::Files };
                    view.update(cx, |this, cx| this.set_view(next, cx)).ok();
                },
            ),
        );
        div()
            .debug_selector(|| "changes-header".to_string())
            .flex()
            .flex_col()
            .flex_none()
            .border_b_1()
            .border_color(theme.line)
            .child(toolbar)
            .child(compare)
            .child(switch)
            .into_any_element()
    }

    fn section_header(&self, section: Section, files: &[DiffFileEntry], theme: &Theme) -> AnyElement {
        let (added, removed) = files.iter().filter(|f| !f.binary).fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
        div()
            .flex()
            .items_center()
            .h(px(28.0))
            .px(px(HEADER_PAD))
            .gap(px(8.0))
            .child(SectionLabel::new(section.label()))
            .child(div().text_step(TEXT_11).text_color(theme.ink3).child(files.len().to_string()))
            .child(div().flex_1())
            .child(counts_inline(theme, added, removed))
            .into_any_element()
    }

    /// The scrolling list of the current view.
    fn rows(&self, changes: &WorktreeChanges, theme: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let state = self.state();
        match state.view {
            View::Files => {
                let mut out = Vec::new();
                for section in Section::ALL {
                    let files = &changes.list(section).files;
                    if files.is_empty() {
                        continue;
                    }
                    let source = Source::Section(section);
                    let selected =
                        state.selected.as_ref().filter(|s| s.source == source).map(|s| self.visible.as_deref().unwrap_or(s.path.as_str()));
                    let env = RowEnv { theme: *theme, source: &source, selected, collapsed: &state.collapsed };
                    out.push(self.section_header(section, files, theme));
                    out.extend(files::rows(files, &env, cx));
                    out.push(div().h(px(6.0)).into_any_element());
                }
                if out.is_empty() {
                    let message = changes.uncommitted.message.clone().or_else(|| changes.committed.message.clone());
                    let mut empty = EmptyState::new()
                        .size(EmptySize::Panel)
                        .icon(IconName::FileDiff)
                        .title(message.unwrap_or_else(|| "No changes yet.".to_string()));
                    empty = empty.help("Files you or the agent change in this Worktree show up here.");
                    out.push(empty.into_any_element());
                }
                out
            }
            View::Commits => {
                let open = state.open_commit.as_deref();
                let source = Source::Commit(open.unwrap_or_default().to_string());
                let selected =
                    state.selected.as_ref().filter(|s| s.source == source).map(|s| self.visible.as_deref().unwrap_or(s.path.as_str()));
                let env = RowEnv { theme: *theme, source: &source, selected, collapsed: &state.collapsed };
                commits::render(changes, open, &env, theme, cx)
            }
        }
    }
}

impl Render for ChangesView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let root =
            div().id("changes-view").debug_selector(|| "changes-root".to_string()).flex().flex_col().size_full().text_color(theme.ink);
        let changes = match &self.data {
            ChangesData::Loading => return root.child(skeleton(&theme)),
            ChangesData::NotRepo(message) => {
                return root.child(EmptyState::new().icon(IconName::GitBranch).title("No Git repository").help(message.clone()));
            }
            ChangesData::Ready(changes) => changes.clone(),
        };
        let header = self.header(&changes, cx);
        let rows = self.rows(&changes, &theme, cx);
        let has_diff = self.diff_open.is_some();
        // The diff is its own cached view: what changes in it (a scroll, a drag) never rebuilds the lists.
        let diff = self.diff_view().map(|diff| {
            div()
                .debug_selector(|| "diff-pane".to_string())
                .flex_1()
                .min_h_0()
                .border_t_1()
                .border_color(theme.line)
                .child(AnyView::from(diff).cached(StyleRefinement::default().size_full()))
        });
        let list =
            div().relative().min_h_0().when(has_diff, |el| el.flex_none().h(relative(LIST_SHARE))).when(!has_diff, |el| el.flex_1()).child(
                ScrollArea::new("changes-list", &self.list_scroll).child(div().flex().flex_col().w_full().py(px(6.0)).children(rows)),
            );
        root.child(header).child(div().flex().flex_col().flex_1().min_h_0().child(list).children(diff))
    }
}
