//! The new-Chat tray (`ChatComposer.tsx` `NewChatHeader`, DESIGN.md: the desktop tray is radius 20, the composer's 14
//! plus its 6 padding): the composer and a row of trigger chips in one `inset` box with a `line` border. The chips
//! are the Project (the "Start building in" heading's picker, folded in here), Run on (the computer), Isolation
//! (This checkout or New Worktree) and the branch, each opening a picker upward. The Linear issue chip is not built.
//!
//! [`Composer::start_new_chat`] turns the tray on; the sidebar's New Chat button needs only
//! `chat.composer.update(cx, |composer, cx| composer.start_new_chat(cx))`. The choices are fixtures.

use gpui::{AnyElement, Entity, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::Composer;
use super::pick_list::{PickList, Row, panel, popup};
use crate::logic::copy::model_copy::UI_COPY;
use crate::theme::{ActiveTheme, Theme};
use crate::ui::{Chip, Dismiss, Icon, IconName, IconSize, Popover};

/// DESIGN.md "Radius": the desktop new-Chat tray is 20.
pub const TRAY_RADIUS: f32 = 20.0;
/// The tray's widest: the desktop's 704 box less the gutters' 12 + 12 is 680 (`chat-gutter`, `max-w-[var(--chat-width)]`),
/// where the Chat column the port draws is 536 at the same setting, so the tray takes the difference on top of it.
const TRAY_EXTRA: f32 = 680.0 - 536.0;
const PICKER_WIDTH: f32 = 320.0;
const BRANCH_WIDTH: f32 = 420.0;

/// The new-Chat tray's widest width, centred in the pane: the Chat column's and the tray's extra.
pub fn tray_width() -> f32 {
    crate::theme::column_width() + TRAY_EXTRA
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
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

/// What the tray has picked.
#[derive(Clone, Debug, PartialEq)]
pub struct NewChat {
    pub project: SharedString,
    pub computer: usize,
    pub isolation: Isolation,
    pub worktree: usize,
    pub branch: usize,
}

impl NewChat {
    pub(super) fn fixture() -> Self {
        Self { project: PROJECTS[0].into(), computer: 0, isolation: Isolation::Worktree, worktree: 0, branch: 0 }
    }
}

/// (name, folder, online)
const COMPUTERS: [(&str, &str, bool); 3] = [
    ("Santo \u{b7} This computer", "~/Code/milagre-ade", true),
    ("deer", "~/Code/milagre-ade", true),
    ("pico", "~/Code/milagre-ade", false),
];
const PROJECTS: [&str; 4] = ["milagre-ade", "happiergym", "studio", "angelo"];
const WORKTREES: [(&str, &str); 3] =
    [("main", "milagre-ade"), ("chat-tie0", "chat-tie0"), ("i-have-some-spare-tokens-t6vn", "i-have-some-spare-tokens-t6vn")];
const BRANCHES: [&str; 4] = ["main", "poc/rust-tauri-local", "release/0.232", "docs/gpui"];

impl Composer {
    /// Starts a new Chat: the composer sits in the tray with its chips.
    pub fn start_new_chat(&mut self, cx: &mut gpui::Context<Self>) {
        self.new_chat = Some(NewChat::fixture());
        self.bar.open = None;
        cx.notify();
    }

    /// Back to a Chat's plain composer.
    pub fn end_new_chat(&mut self, cx: &mut gpui::Context<Self>) {
        self.new_chat = None;
        self.starters.clear();
        cx.notify();
    }

    pub fn new_chat(&self) -> Option<&NewChat> {
        self.new_chat.as_ref()
    }

    /// The tray's chips; the caller puts the composer box under them.
    pub(super) fn render_tray_header(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> Option<AnyElement> {
        // Preview mode: the Project, computer and branch chips are fixture lists no live data layer backs yet.
        if crate::workspace::preview::is_on(cx) {
            return None;
        }
        let state = self.new_chat.clone()?;
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
        let branch_label: SharedString = match state.isolation {
            Isolation::Local => WORKTREES[state.worktree].0.into(),
            Isolation::Worktree => BRANCHES[state.branch].into(),
        };
        let chips = div()
            .debug_selector(|| "new-chat-chips".into())
            .flex()
            .items_center()
            .gap_1()
            .min_w_0()
            .px(px(10.0))
            .pb_1()
            .child(tray_popup(
                &composer,
                open,
                "new-chat-project",
                "Project",
                PICKER_WIDTH,
                cx,
                chip("new-chat-project-chip", IconName::Folder01, state.project.clone()),
                project_rows,
            ))
            .child(tray_popup(
                &composer,
                open,
                "new-chat-computer",
                "Run on",
                PICKER_WIDTH,
                cx,
                chip("new-chat-computer-chip", IconName::Computer, COMPUTERS[state.computer].0.into()),
                computer_rows,
            ))
            .child(tray_popup(
                &composer,
                open,
                "new-chat-isolation",
                "Isolation",
                PICKER_WIDTH,
                cx,
                chip("new-chat-isolation-chip", state.isolation.icon(), state.isolation.name().into()),
                isolation_rows,
            ))
            .child(tray_popup(
                &composer,
                open,
                "new-chat-branch",
                "Branch",
                BRANCH_WIDTH,
                cx,
                chip("new-chat-branch-chip", IconName::GitBranch, branch_label),
                branch_rows,
            ));
        Some(chips.into_any_element())
    }
}

type Rows = fn(&Entity<Composer>, &NewChat, &Dismiss) -> (&'static str, Vec<Row>);

#[allow(clippy::too_many_arguments)]
fn tray_popup(
    composer: &Entity<Composer>,
    open: Option<&'static str>,
    key: &'static str,
    _name: &'static str,
    width: f32,
    _cx: &gpui::App,
    trigger: impl FnOnce(bool) -> AnyElement + 'static,
    rows: Rows,
) -> Popover {
    let composer = composer.clone();
    popup(&composer.clone(), key, open == Some(key)).align_start().trigger(trigger).content(move |dismiss, _, cx| {
        let theme = *cx.theme();
        let Some(state) = composer.read(cx).new_chat.clone() else { return div().into_any_element() };
        let (title, rows) = rows(&composer, &state, dismiss);
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

fn project_rows(composer: &Entity<Composer>, state: &NewChat, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = PROJECTS
        .iter()
        .map(|name| {
            Row::new(format!("project-{name}"), *name, set(composer, dismiss, move |chat| chat.project = (*name).into()))
                .icon(IconName::Folder01, None)
                .checked(state.project == *name)
        })
        .collect();
    ("Project", rows)
}

fn computer_rows(composer: &Entity<Composer>, state: &NewChat, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = COMPUTERS
        .iter()
        .enumerate()
        .map(|(ix, (name, folder, online))| {
            let row = Row::new(format!("computer-{ix}"), *name, set(composer, dismiss, move |chat| chat.computer = ix))
                .icon(IconName::Computer, None)
                .subtitle(*folder)
                .checked(state.computer == ix)
                .disabled(!online);
            if *online { row } else { row.meta("Offline") }
        })
        .collect();
    ("Run on", rows)
}

fn isolation_rows(composer: &Entity<Composer>, state: &NewChat, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    let rows = [Isolation::Local, Isolation::Worktree]
        .into_iter()
        .map(|option| {
            Row::new(format!("isolation-{}", option.name()), option.name(), set(composer, dismiss, move |chat| chat.isolation = option))
                .icon(option.icon(), None)
                .subtitle(option.description())
                .checked(state.isolation == option)
        })
        .collect();
    ("Isolation", rows)
}

fn branch_rows(composer: &Entity<Composer>, state: &NewChat, dismiss: &Dismiss) -> (&'static str, Vec<Row>) {
    match state.isolation {
        Isolation::Local => (
            "Choose a Worktree",
            WORKTREES
                .iter()
                .enumerate()
                .map(|(ix, (name, folder))| {
                    Row::new(format!("worktree-{ix}"), *name, set(composer, dismiss, move |chat| chat.worktree = ix))
                        .icon(IconName::GitBranch, None)
                        .subtitle(*folder)
                        .checked(state.worktree == ix)
                })
                .collect(),
        ),
        Isolation::Worktree => (
            "Branch from",
            BRANCHES
                .iter()
                .enumerate()
                .map(|(ix, name)| {
                    Row::new(format!("branch-{ix}"), *name, set(composer, dismiss, move |chat| chat.branch = ix))
                        .icon(IconName::GitBranch, None)
                        .checked(state.branch == ix)
                })
                .collect(),
        ),
    }
}
