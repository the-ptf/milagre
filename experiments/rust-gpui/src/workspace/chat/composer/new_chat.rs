//! The new Chat (`NewChatHeading.tsx` and `ChatComposer.tsx` `NewChatHeader`, DESIGN.md: the desktop tray is radius
//! 20, the composer's 14 plus its 6 padding):
//!
//! - the heading, "Start building in [Project ▾]" centred over the tray (17 medium ink, the Project a field-filled
//!   trigger whose list moves the new Chat to another Project);
//! - the tray: the composer and a row of trigger chips in one `inset` box with a `line` border. The chips are Run on
//!   (the computer: shown only when the data layer lists computers), Isolation (This checkout or New Worktree), the
//!   Worktree or the branch to start one from, and "Linear issue" when Linear is on and connected. Each opens a picker
//!   upward; picking an issue starts the Chat from it at once, as the desktop's `startFromIssue` does.
//!
//! What the pickers list is [`NewChatOptions`]: the fixture's below, or the data layer's ([`Composer::
//! set_new_chat_options`]: the live Preview reads the loaded Projects, the Project's Worktrees and branches, and
//! Linear through the daemon). The host reads the choice back with [`Composer::new_chat_choice`] when it sends.

use gpui::{AnyElement, Entity, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::Composer;
use super::pick_list::{PickList, Row, panel, popup, popup_at};
use crate::logic::copy::model_copy::UI_COPY;
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_17, TextStepExt, Theme};
use crate::ui::{Chip, Dismiss, Icon, IconName, IconSize, Popover};

/// DESIGN.md "Radius": the desktop new-Chat tray is 20.
pub const TRAY_RADIUS: f32 = 20.0;
/// The tray's widest: the desktop's 704 box less the gutters' 12 + 12 is 680 (`chat-gutter`, `max-w-[var(--chat-width)]`),
/// where the Chat column the port draws is 536 at the same setting, so the tray takes the difference on top of it.
const TRAY_EXTRA: f32 = 680.0 - 536.0;
const PICKER_WIDTH: f32 = 320.0;
const BRANCH_WIDTH: f32 = 420.0;
/// The heading's Project list (`ProjectPicker`: 300 wide) and the room under the heading (`pb-6`).
const PROJECT_WIDTH: f32 = 300.0;
const HEADING_GAP: f32 = 24.0;

/// The new-Chat tray's widest width, centred in the pane: the Chat column's and the tray's extra.
pub fn tray_width() -> f32 {
    crate::theme::column_width() + TRAY_EXTRA
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Isolation {
    /// The desktop's default until a person picks New Worktree (`loadChatPreferences`).
    #[default]
    Local,
    Worktree,
}

impl Isolation {
    fn name(self) -> &'static str {
        match self {
            Isolation::Local => "This checkout",
            Isolation::Worktree => UI_COPY.new_worktree,
        }
    }

    fn description(self) -> &'static str {
        match self {
            Isolation::Local => "Work in the selected checkout",
            Isolation::Worktree => "Start a new branch in its own Worktree",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Isolation::Local => IconName::Folder01,
            Isolation::Worktree => IconName::GitFork,
        }
    }
}

/// A Project a new Chat can start in: its path (what the host sends) and the name the heading shows.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatProject {
    pub path: SharedString,
    pub name: SharedString,
}

/// A computer the new Chat can run on (Run on): its name, the Project's folder there, and whether it is online.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatComputer {
    pub name: SharedString,
    pub folder: SharedString,
    pub online: bool,
}

/// A checkout of the Project (This checkout's list): its id in the Project's state, name and folder.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatWorktree {
    pub id: u64,
    pub name: SharedString,
    pub path: SharedString,
}

/// A Linear issue to start from (`LinearIssue` in `packages/shared/src/linear.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatIssue {
    pub key: SharedString,
    pub title: SharedString,
    pub url: SharedString,
    pub description: Option<SharedString>,
    pub workspace: Option<SharedString>,
}

impl NewChatIssue {
    /// The first message of a Chat started from the issue (`issueFirstMessage` in `linear-issue.mjs`): the key and
    /// title, the description, the link, then whatever was typed.
    pub fn first_message(&self, typed: &str) -> String {
        let mut text = format!("Work on Linear issue {}: {}", self.key, self.title);
        if let Some(description) = self.description.as_ref().filter(|d| !d.is_empty()) {
            text.push_str(&format!("\n\n{description}"));
        }
        text.push_str(&format!("\n\n{}", self.url));
        if !typed.trim().is_empty() {
            text.push_str(&format!("\n\n{}", typed.trim()));
        }
        text
    }
}

/// What the new-Chat pickers list. An empty list hides its chip (no computers: no Run on; no Worktrees: no Git
/// chips); `issues: None` is Linear off or not connected (no issue chip).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewChatOptions {
    pub projects: Vec<NewChatProject>,
    pub computers: Vec<NewChatComputer>,
    pub worktrees: Vec<NewChatWorktree>,
    pub branches: Vec<SharedString>,
    /// The branch a new Worktree starts from unless another is picked (the Project's base, else the first).
    pub base_branch: Option<SharedString>,
    pub issues: Option<Vec<NewChatIssue>>,
    /// The isolation a new Chat starts on until one is picked on this computer.
    pub isolation: Isolation,
}

impl NewChatOptions {
    /// The fixture's lists.
    pub fn fixture() -> Self {
        Self {
            projects: PROJECTS.iter().map(|name| NewChatProject { path: (*name).into(), name: (*name).into() }).collect(),
            computers: COMPUTERS
                .iter()
                .map(|(name, folder, online)| NewChatComputer { name: (*name).into(), folder: (*folder).into(), online: *online })
                .collect(),
            worktrees: WORKTREES
                .iter()
                .enumerate()
                .map(|(ix, (name, folder))| NewChatWorktree { id: ix as u64 + 1, name: (*name).into(), path: (*folder).into() })
                .collect(),
            branches: BRANCHES.iter().map(|branch| (*branch).into()).collect(),
            base_branch: None,
            isolation: Isolation::Worktree,
            issues: Some(
                ISSUES
                    .iter()
                    .map(|(key, title)| NewChatIssue {
                        key: (*key).into(),
                        title: (*title).into(),
                        url: format!("https://linear.app/milagre/issue/{}", key.to_lowercase()).into(),
                        description: None,
                        workspace: None,
                    })
                    .collect(),
            ),
        }
    }

    fn base_index(&self) -> usize {
        self.base_branch.as_ref().and_then(|base| self.branches.iter().position(|b| b == base)).unwrap_or(0)
    }
}

/// What the tray has picked: the Project's path and indexes into [`NewChatOptions`]' lists.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChat {
    pub project: SharedString,
    pub computer: usize,
    pub isolation: Isolation,
    pub worktree: usize,
    pub branch: usize,
    /// The branch was picked here (not the Project's base): the desktop's `baseOverride`.
    pub branch_picked: bool,
}

impl NewChat {
    pub(super) fn fixture() -> Self {
        Self::for_options(&NewChatOptions::fixture(), None)
    }

    /// The first choice for `options`: `project` (a path or a name) when it is listed, else the first Project; the
    /// options' isolation, from the Project's base.
    fn for_options(options: &NewChatOptions, project: Option<&str>) -> Self {
        let picked = project.and_then(|p| options.projects.iter().find(|o| o.path == p || o.name == p));
        let project = picked.or(options.projects.first()).map(|o| o.path.clone()).unwrap_or_default();
        Self { project, computer: 0, isolation: options.isolation, worktree: 0, branch: options.base_index(), branch_picked: false }
    }
}

/// The fixture's lists: (name, folder, online) computers, Projects, Worktrees (name, folder) and branches.
const COMPUTERS: [(&str, &str, bool); 3] = [
    ("Santo \u{b7} This computer", "~/Code/milagre-ade", true),
    ("deer", "~/Code/milagre-ade", true),
    ("pico", "~/Code/milagre-ade", false),
];
const PROJECTS: [&str; 4] = ["milagre-ade", "happiergym", "studio", "angelo"];
const WORKTREES: [(&str, &str); 3] =
    [("main", "milagre-ade"), ("chat-tie0", "chat-tie0"), ("i-have-some-spare-tokens-t6vn", "i-have-some-spare-tokens-t6vn")];
const BRANCHES: [&str; 4] = ["main", "poc/rust-tauri-local", "release/0.232", "docs/gpui"];
const ISSUES: [(&str, &str); 2] = [("MIL-412", "Phone loses the relay after sleep"), ("MIL-418", "Sidebar flickers on reconnect")];

/// What the host sends a new Chat with ([`Composer::new_chat_choice`]).
#[derive(Clone, Debug, PartialEq)]
pub struct NewChatChoice {
    /// The Project's path.
    pub project: SharedString,
    pub isolation: Isolation,
    /// This checkout's Worktree id (for `Isolation::Local`).
    pub worktree: Option<u64>,
    /// The branch a new Worktree starts from, and whether it was picked here rather than the Project's base.
    pub base_branch: Option<SharedString>,
    pub branch_picked: bool,
    /// The issue the Chat starts from (it always gets its own Worktree).
    pub issue: Option<NewChatIssue>,
}

impl Composer {
    /// Starts a new Chat: the composer sits in the tray with its chips.
    pub fn start_new_chat(&mut self, cx: &mut gpui::Context<Self>) {
        self.start_new_chat_in(None, cx);
    }

    /// Starts a new Chat in `project` (a path or a name; the first listed Project when it is not listed).
    pub fn start_new_chat_in(&mut self, project: Option<&str>, cx: &mut gpui::Context<Self>) {
        let options = self.options(cx);
        let mut chat = NewChat::for_options(&options, project);
        // The isolation picked last stays the next new Chat's, as the desktop saves it (`saveChatPreferences`).
        chat.isolation = self.new_chat_isolation.unwrap_or(chat.isolation);
        self.new_chat = Some(chat);
        self.new_chat_wanted = project.map(SharedString::from);
        self.new_chat_issue = None;
        self.bar.open = None;
        cx.notify();
    }

    /// Back to a Chat's plain composer.
    pub fn end_new_chat(&mut self, cx: &mut gpui::Context<Self>) {
        self.new_chat = None;
        self.new_chat_wanted = None;
        self.new_chat_issue = None;
        self.starters.clear();
        cx.notify();
    }

    pub fn new_chat(&self) -> Option<&NewChat> {
        self.new_chat.as_ref()
    }

    /// The data layer's lists for the pickers (the fixture's until it sets them; nothing in preview mode until then).
    /// The choice keeps its Project when the new lists still have it, else the one asked for at the start; the branch
    /// goes back to the Project's base unless one was picked here.
    pub fn set_new_chat_options(&mut self, options: NewChatOptions, cx: &mut gpui::Context<Self>) {
        if self.new_chat_options.as_ref() == Some(&options) {
            return;
        }
        if let Some(chat) = self.new_chat.as_mut() {
            let keep = options.projects.iter().any(|p| p.path == chat.project);
            let wanted = if keep { Some(chat.project.to_string()) } else { self.new_chat_wanted.as_ref().map(|w| w.to_string()) };
            let fresh = NewChat::for_options(&options, wanted.as_deref());
            let branch =
                chat.branch_picked.then(|| self.new_chat_options.as_ref().and_then(|o| o.branches.get(chat.branch).cloned())).flatten();
            let picked = branch.and_then(|branch| options.branches.iter().position(|b| *b == branch));
            *chat = NewChat {
                isolation: self.new_chat_isolation.unwrap_or(if keep { chat.isolation } else { fresh.isolation }),
                computer: chat.computer.min(options.computers.len().saturating_sub(1)),
                worktree: if keep { chat.worktree.min(options.worktrees.len().saturating_sub(1)) } else { 0 },
                branch: picked.unwrap_or(fresh.branch),
                branch_picked: picked.is_some(),
                ..fresh
            };
        }
        self.new_chat_options = Some(options);
        cx.notify();
    }

    /// Picks the isolation, as its picker does (kept for the next new Chat this session).
    pub fn set_new_chat_isolation(&mut self, isolation: Isolation, cx: &mut gpui::Context<Self>) {
        self.new_chat_isolation = Some(isolation);
        if let Some(chat) = self.new_chat.as_mut() {
            chat.isolation = isolation;
        }
        cx.notify();
    }

    /// Picks the branch a new Worktree starts from, by name, as the branch picker does. False when it is not listed.
    pub fn set_new_chat_branch(&mut self, branch: &str, cx: &mut gpui::Context<Self>) -> bool {
        let Some(ix) = self.options(cx).branches.iter().position(|b| b == branch) else { return false };
        let Some(chat) = self.new_chat.as_mut() else { return false };
        chat.branch = ix;
        chat.branch_picked = true;
        cx.notify();
        true
    }

    /// The Project the new Chat would settle on with `options` ([`Self::set_new_chat_options`]): its own when listed,
    /// else the one asked for at the start, else the first. A host reads it to fetch that Project's lists before setting
    /// them all at once.
    pub fn new_chat_project_for(&self, options: &NewChatOptions) -> Option<SharedString> {
        Self::settles_on(self.new_chat.as_ref(), self.new_chat_wanted.as_ref(), options)
    }

    fn settles_on(chat: Option<&NewChat>, wanted: Option<&SharedString>, options: &NewChatOptions) -> Option<SharedString> {
        let chat = chat?;
        let listed = |p: &str| options.projects.iter().find(|o| o.path.as_ref() == p || o.name.as_ref() == p).map(|o| o.path.clone());
        listed(&chat.project).or_else(|| wanted.and_then(|w| listed(w))).or_else(|| options.projects.first().map(|o| o.path.clone()))
    }

    /// What the pickers list now.
    pub fn new_chat_options(&self, cx: &gpui::App) -> NewChatOptions {
        self.options(cx)
    }

    fn options(&self, cx: &gpui::App) -> NewChatOptions {
        match &self.new_chat_options {
            Some(options) => options.clone(),
            None if crate::workspace::preview::is_on(cx) => NewChatOptions::default(),
            None => NewChatOptions::fixture(),
        }
    }

    /// The new Chat's choices as the host sends them, `None` off the new-Chat screen. `issue` is the one picked to start
    /// from (kept until the screen ends).
    pub fn new_chat_choice(&self, cx: &gpui::App) -> Option<NewChatChoice> {
        let chat = self.new_chat.as_ref()?;
        let options = self.options(cx);
        Some(NewChatChoice {
            project: chat.project.clone(),
            isolation: chat.isolation,
            worktree: options.worktrees.get(chat.worktree).map(|w| w.id),
            base_branch: options.branches.get(chat.branch).cloned(),
            branch_picked: chat.branch_picked,
            issue: self.new_chat_issue.clone(),
        })
    }

    /// Starts the Chat from a Linear issue: its first message (and whatever was typed) is sent at once, on its own
    /// Worktree (`startFromIssue`).
    pub fn start_from_issue(&mut self, issue: NewChatIssue, window: &mut gpui::Window, cx: &mut gpui::Context<Self>) {
        let text = issue.first_message(self.text());
        self.new_chat_issue = Some(issue);
        self.bar.open = None;
        self.set_text(&text, window, cx);
        // The issue stays on the choice until the new-Chat screen ends: the host reads it when it runs the send.
        self.submit(window, cx);
        cx.notify();
    }

    /// "Start building in [Project ▾]" over the tray.
    pub(super) fn render_new_chat_heading(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> Option<AnyElement> {
        let state = self.new_chat.clone()?;
        let options = self.options(cx);
        let name = options.projects.iter().find(|p| p.path == state.project).map(|p| p.name.clone())?;
        let composer = cx.entity();
        let open = self.bar.open == Some("new-chat-project");
        let (field, hover2, dim) = (theme.field, theme.hover2, theme.ink3);
        let picker = popup_at(&composer, "new-chat-project", open, false)
            .align_start()
            .trigger(move |open| {
                div()
                    .id("new-chat-project-chip")
                    .debug_selector(|| "new-chat-project-chip".into())
                    .flex()
                    .items_center()
                    .gap_1()
                    .h(px(32.0))
                    .max_w(px(480.0))
                    .px_2()
                    .rounded(RADIUS_CONTROL)
                    .cursor_pointer()
                    .bg(if open { hover2 } else { field })
                    .hover(move |style| style.bg(hover2))
                    .child(div().min_w_0().max_w(px(300.0)).truncate().child(name.clone()))
                    .child(Icon::new(IconName::ArrowDown01).size(IconSize::S14).color(dim))
                    .into_any_element()
            })
            .content(move |dismiss, _, cx| {
                let theme = *cx.theme();
                let Some(state) = composer.read(cx).new_chat.clone() else { return div().into_any_element() };
                let options = composer.read(cx).options(cx);
                let rows = project_rows(&composer, &state, &options, dismiss);
                panel(PROJECT_WIDTH, None, &theme)
                    .debug_selector(|| "new-chat-project".to_string())
                    .child(PickList::new("new-chat-project-list", rows).empty(UI_COPY.no_projects))
                    .into_any_element()
            });
        Some(
            div()
                .debug_selector(|| "new-chat-heading".into())
                .flex()
                .flex_wrap()
                .items_center()
                .justify_center()
                .gap(px(6.0))
                .w_full()
                .pb(px(HEADING_GAP))
                .text_step(TEXT_17)
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(theme.ink)
                .child(div().child("Start building in"))
                .child(picker)
                .into_any_element(),
        )
    }

    /// The tray's chips; the caller puts the composer box under them. `None` when no chip has anything to list.
    pub(super) fn render_tray_header(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> Option<AnyElement> {
        let state = self.new_chat.clone()?;
        let options = self.options(cx);
        let composer = cx.entity();
        let open = self.bar.open;
        let dim = theme.ink2;
        let chip = move |id: &'static str, icon: IconName, label: SharedString| {
            move |open: bool| {
                Chip::new(id)
                    .on(open)
                    .chevron()
                    .child(Icon::new(icon).size(IconSize::S14).color(dim))
                    .child(div().min_w_0().truncate().child(label))
                    .into_any_element()
            }
        };
        let git = !options.worktrees.is_empty();
        let branch_label: SharedString = match state.isolation {
            Isolation::Local => options.worktrees.get(state.worktree).map(|w| w.name.clone()).unwrap_or_default(),
            Isolation::Worktree => options.branches.get(state.branch).cloned().unwrap_or_else(|| "main".into()),
        };
        let computer = options.computers.get(state.computer).map(|c| c.name.clone());
        if computer.is_none() && !git && options.issues.is_none() {
            return None;
        }
        let chips = div()
            .debug_selector(|| "new-chat-chips".into())
            .flex()
            .items_center()
            .gap_1()
            .min_w_0()
            .px(px(10.0))
            .pb_1()
            .when_some(computer, |el, computer| {
                el.child(tray_popup(
                    &composer,
                    open,
                    "new-chat-computer",
                    PICKER_WIDTH,
                    chip("new-chat-computer-chip", IconName::Computer, computer),
                    computer_rows,
                ))
            })
            .when(git, |el| {
                el.child(tray_popup(
                    &composer,
                    open,
                    "new-chat-isolation",
                    PICKER_WIDTH,
                    chip("new-chat-isolation-chip", state.isolation.icon(), state.isolation.name().into()),
                    isolation_rows,
                ))
                .child(tray_popup(
                    &composer,
                    open,
                    "new-chat-branch",
                    BRANCH_WIDTH,
                    chip("new-chat-branch-chip", IconName::GitBranch, branch_label),
                    branch_rows,
                ))
            })
            .when(options.issues.is_some(), |el| {
                el.child(tray_popup(
                    &composer,
                    open,
                    "new-chat-issue",
                    BRANCH_WIDTH,
                    chip("new-chat-issue-chip", IconName::LinkSquare02, "Linear issue".into()),
                    issue_rows,
                ))
            });
        Some(chips.into_any_element())
    }
}

type Rows = fn(&Entity<Composer>, &NewChat, &NewChatOptions, &Dismiss) -> (&'static str, Vec<Row>);

fn tray_popup(
    composer: &Entity<Composer>,
    open: Option<&'static str>,
    key: &'static str,
    width: f32,
    trigger: impl FnOnce(bool) -> AnyElement + 'static,
    rows: Rows,
) -> Popover {
    let composer = composer.clone();
    popup(&composer.clone(), key, open == Some(key)).align_start().trigger(trigger).content(move |dismiss, _, cx| {
        let theme = *cx.theme();
        let Some(state) = composer.read(cx).new_chat.clone() else { return div().into_any_element() };
        let options = composer.read(cx).options(cx);
        let (title, rows) = rows(&composer, &state, &options, dismiss);
        panel(width, Some(title), &theme)
            .debug_selector(move || key.to_string())
            .child(PickList::new(format!("{key}-list"), rows))
            .into_any_element()
    })
}

fn set<F: Fn(&mut NewChat) + 'static>(
    composer: &Entity<Composer>,
    dismiss: &Dismiss,
    change: F,
) -> impl Fn(&mut gpui::Window, &mut gpui::App) + use<F> {
    let (composer, dismiss) = (composer.clone(), dismiss.clone());
    move |window, cx| {
        composer.update(cx, |c, cx| {
            if let Some(chat) = c.new_chat.as_mut() {
                change(chat);
            }
            cx.notify();
        });
        dismiss.call(window, cx);
    }
}

fn project_rows(composer: &Entity<Composer>, state: &NewChat, options: &NewChatOptions, dismiss: &Dismiss) -> Vec<Row> {
    options
        .projects
        .iter()
        .map(|project| {
            let path = project.path.clone();
            let pick = path.clone();
            Row::new(
                SharedString::from(format!("project-{path}")),
                project.name.clone(),
                set(composer, dismiss, move |chat| {
                    if chat.project != pick {
                        // Another Project: its own Worktrees and base, read again by the host.
                        chat.project = pick.clone();
                        chat.worktree = 0;
                        chat.branch_picked = false;
                    }
                }),
            )
            .icon(IconName::Folder01, None)
            .checked(state.project == path)
        })
        .collect()
}

fn computer_rows(composer: &Entity<Composer>, state: &NewChat, options: &NewChatOptions, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = options
        .computers
        .iter()
        .enumerate()
        .map(|(ix, computer)| {
            let row = Row::new(format!("computer-{ix}"), computer.name.clone(), set(composer, dismiss, move |chat| chat.computer = ix))
                .icon(IconName::Computer, None)
                .subtitle(computer.folder.clone())
                .checked(state.computer == ix)
                .disabled(!computer.online);
            if computer.online { row } else { row.meta("Offline") }
        })
        .collect();
    ("Run on", rows)
}

fn isolation_rows(composer: &Entity<Composer>, state: &NewChat, _: &NewChatOptions, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = [Isolation::Local, Isolation::Worktree]
        .into_iter()
        .map(|option| {
            let (remember, dismiss) = (composer.clone(), dismiss.clone());
            Row::new(format!("isolation-{}", option.name()), option.name(), move |window, cx| {
                remember.update(cx, |c, cx| c.set_new_chat_isolation(option, cx));
                dismiss.call(window, cx);
            })
            .icon(option.icon(), None)
            .subtitle(option.description())
            .checked(state.isolation == option)
        })
        .collect();
    ("Isolation", rows)
}

fn branch_rows(composer: &Entity<Composer>, state: &NewChat, options: &NewChatOptions, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    match state.isolation {
        Isolation::Local => (
            "Choose a Worktree",
            options
                .worktrees
                .iter()
                .enumerate()
                .map(|(ix, worktree)| {
                    let folder = worktree.path.rsplit('/').find(|part| !part.is_empty()).unwrap_or_default().to_owned();
                    Row::new(format!("worktree-{ix}"), worktree.name.clone(), set(composer, dismiss, move |chat| chat.worktree = ix))
                        .icon(IconName::GitBranch, None)
                        .subtitle(folder)
                        .checked(state.worktree == ix)
                })
                .collect(),
        ),
        Isolation::Worktree => (
            "Branch from",
            options
                .branches
                .iter()
                .enumerate()
                .map(|(ix, name)| {
                    Row::new(
                        format!("branch-{ix}"),
                        name.clone(),
                        set(composer, dismiss, move |chat| {
                            chat.branch = ix;
                            chat.branch_picked = true;
                        }),
                    )
                    .icon(IconName::GitBranch, None)
                    .checked(state.branch == ix)
                })
                .collect(),
        ),
    }
}

/// The issues to start from: picking one sends its first message at once.
fn issue_rows(composer: &Entity<Composer>, _: &NewChat, options: &NewChatOptions, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = options
        .issues
        .iter()
        .flatten()
        .enumerate()
        .map(|(ix, issue)| {
            let (composer, dismiss, picked) = (composer.clone(), dismiss.clone(), issue.clone());
            Row::new(format!("issue-{ix}"), format!("{} {}", issue.key, issue.title), move |window, cx| {
                dismiss.call(window, cx);
                let issue = picked.clone();
                composer.update(cx, |c, cx| c.start_from_issue(issue, window, cx));
            })
            .icon(IconName::LinkSquare02, None)
        })
        .collect();
    ("Start from a Linear issue", rows)
}
