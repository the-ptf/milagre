//! The footer's Filters menu (`FiltersButton` in `components/sidebar/FiltersMenu.tsx`, `ComputersMenu.tsx`): which
//! computers and Projects this Mac's sidebar lists and what a Chat row's second line shows, all kept per Mac.
//! Computers ›, Projects › and Show › open beside the menu; what the sidebar leaves out stays quiet.
//!
//! The model (choices, counts, the tooltip) is pure and tested; [`render`] draws the menu above the footer button with
//! its submenu beside it. Two small departures from the desktop, both the shared [`MenuRow`]'s limits: a submenu
//! row's chevron is a text "›" in its trailing slot, and a Project or computer choice shows its tick at the row's end
//! instead of a checkbox before it.

use std::collections::HashSet;

use gpui::{Anchor, AnyElement, App, Pixels, SharedString, Window, anchored, deferred, div, point, prelude::*, px};

use super::list::SidebarData;
use crate::data::{ComputerState, LOCAL};
use crate::logic::identity::project_list::project_initial;
use crate::logic::lists::chat_row::{CHAT_ROW_FIELDS, ChatRowField, ChatRowShow};
use crate::theme::{ActiveTheme, RADIUS_CARD};
use crate::ui::{IconName, MenuList, MenuRow};

/// The main panel's width (`MAIN_WIDTH`) and each submenu's (`SUB_WIDTH`).
pub const MAIN_WIDTH: f32 = 232.0;
const GAP: f32 = 6.0;
const MENU_PADDING: f32 = 6.0;
const ROW_STEP: f32 = 33.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sub {
    Computers,
    Projects,
    Show,
}

impl Sub {
    pub fn width(self) -> f32 {
        match self {
            Sub::Computers => 272.0,
            Sub::Projects => 256.0,
            Sub::Show => 208.0,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Sub::Computers => "computers",
            Sub::Projects => "projects",
            Sub::Show => "show",
        }
    }
}

/// What a press in the menu does.
#[derive(Clone, Debug, PartialEq)]
pub enum FilterAction {
    OpenSub(Sub),
    ToggleComputer(String),
    /// Index into `SidebarData::scopes`.
    ToggleProject(usize),
    ToggleField(ChatRowField),
    AddComputer,
    /// Left or Escape in a submenu: back to the menu.
    CloseSub,
    Close,
}

/// A Project in Filters › Projects.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectChoice {
    pub scope: usize,
    pub name: SharedString,
    pub initial: String,
    pub computer: String,
    pub shown: bool,
    /// The Project of the Chat on screen: it shows while open even when unchecked.
    pub open: bool,
}

/// A computer in Filters › Computers.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputerChoice {
    pub id: String,
    pub name: SharedString,
    /// "This Mac", "Connected", "Offline: message".
    pub line: String,
    pub away: bool,
    pub shown: bool,
}

/// Every Project the sidebar knows, checked while it is listed; a Chats home is not a choice.
pub fn project_choices(data: &SidebarData, open_scope: Option<usize>) -> Vec<ProjectChoice> {
    data.scopes
        .iter()
        .enumerate()
        .filter(|(_, scope)| !scope.project.is_chats_home())
        .map(|(ix, scope)| ProjectChoice {
            scope: ix,
            name: scope.project.name.clone(),
            initial: project_initial(&scope.project.name),
            computer: scope.project.computer.to_string(),
            shown: !scope.project.hidden,
            open: open_scope == Some(ix),
        })
        .collect()
}

pub fn computer_choices(data: &SidebarData, hidden: &HashSet<String>) -> Vec<ComputerChoice> {
    let mut out = vec![ComputerChoice {
        id: LOCAL.to_owned(),
        name: data.computers.this_mac.clone(),
        line: "This Mac".to_owned(),
        away: false,
        shown: !hidden.contains(LOCAL),
    }];
    out.extend(data.computers.computers.iter().map(|computer| {
        let line = match computer.state {
            ComputerState::Online => "Connected".to_owned(),
            ComputerState::Connecting => "Connecting…".to_owned(),
            ComputerState::Reconnecting => "Reconnecting…".to_owned(),
            ComputerState::Off => "Off".to_owned(),
            ComputerState::Offline | ComputerState::Refused => match &computer.message {
                Some(message) => format!("Offline · {message}"),
                None => "Offline".to_owned(),
            },
        };
        ComputerChoice {
            id: computer.id.to_string(),
            name: computer.name.clone(),
            line,
            away: computer.state != ComputerState::Online,
            shown: !hidden.contains(computer.id.as_ref()),
        }
    }));
    out
}

/// Two or more computers: the computer is something a row can show and Projects list under their computer.
pub fn multi_computer(data: &SidebarData) -> bool {
    !data.computers.computers.is_empty()
}

/// The Show submenu's fields: the computer only with several computers.
pub fn show_fields(multi: bool) -> Vec<(ChatRowField, &'static str)> {
    CHAT_ROW_FIELDS.iter().copied().filter(|(field, _)| *field != ChatRowField::Computer || multi).collect()
}

/// `show` with `field` set to `on`.
pub fn with_field(show: ChatRowShow, field: ChatRowField, on: bool) -> ChatRowShow {
    let mut next = show;
    match field {
        ChatRowField::Computer => next.computer = on,
        ChatRowField::PullRequests => next.pull_requests = on,
        ChatRowField::LinearIssue => next.linear_issue = on,
        ChatRowField::Branch => next.branch = on,
        ChatRowField::Diff => next.diff = on,
        ChatRowField::LastActivity => next.last_activity = on,
    }
    next
}

/// The button's tooltip: what Filters leaves out, if anything.
pub fn tooltip(hidden_computers: usize, hidden_projects: usize) -> String {
    let parts: Vec<String> = [
        (hidden_computers > 0)
            .then(|| format!("{hidden_computers} {} hidden", if hidden_computers == 1 { "computer" } else { "computers" })),
        (hidden_projects > 0).then(|| format!("{hidden_projects} {} hidden", if hidden_projects == 1 { "Project" } else { "Projects" })),
    ]
    .into_iter()
    .flatten()
    .collect();
    if parts.is_empty() { "Filters".to_owned() } else { format!("Filters ({})", parts.join(", ")) }
}

fn icon_of(field: ChatRowField) -> IconName {
    match field {
        ChatRowField::Computer => IconName::Laptop,
        ChatRowField::PullRequests => IconName::GitPullRequest,
        ChatRowField::LinearIssue => IconName::Link04,
        ChatRowField::Branch => IconName::GitBranch,
        ChatRowField::Diff => IconName::PlusMinus01,
        ChatRowField::LastActivity => IconName::Clock01,
    }
}

/// Everything the panels draw, read from the sidebar when it renders.
pub struct FiltersView {
    pub sub: Option<Sub>,
    pub computers: Vec<ComputerChoice>,
    pub projects: Vec<ProjectChoice>,
    pub hidden_computers: usize,
    pub multi: bool,
    pub show: ChatRowShow,
    /// Where the main panel's bottom-left sits: just above the footer button.
    pub origin: gpui::Point<Pixels>,
    /// The Filters button, which the pane under the menu leaves to its own click.
    pub button: gpui::Bounds<Pixels>,
    /// Each computer's name by id, for the Projects sections.
    pub computer_names: Vec<(String, SharedString)>,
}

impl FiltersView {
    fn offered(&self) -> Vec<Sub> {
        let mut subs = Vec::new();
        if self.multi {
            subs.push(Sub::Computers);
        }
        subs.push(Sub::Projects);
        subs.push(Sub::Show);
        subs
    }
}

/// Draws the menu above its button, and the submenu beside it.
pub fn render(
    view: &FiltersView,
    window: &Window,
    cx: &App,
    act: impl Fn(FilterAction, &mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let theme = *cx.theme();
    let offered = view.offered();
    let hidden_projects = view.projects.iter().filter(|project| !project.shown).count();
    let main_height = offered.len() as f32 * ROW_STEP + 2.0 * MENU_PADDING;
    let mut list = MenuList::new("filters-main");
    for sub in &offered {
        let detail = match sub {
            Sub::Computers if view.hidden_computers > 0 => format!("{} hidden ›", view.hidden_computers),
            Sub::Projects if hidden_projects > 0 => format!("{hidden_projects} hidden ›"),
            _ => "›".to_owned(),
        };
        let (label, icon) = match sub {
            Sub::Computers => ("Computers", IconName::Laptop),
            Sub::Projects => ("Projects", IconName::Folder01),
            Sub::Show => ("Show", IconName::View),
        };
        let action = act.clone();
        let sub = *sub;
        let mut row = MenuRow::new(format!("filters-{}", sub.id()), label)
            .icon(icon)
            .trailing(detail)
            .on_click(move |_, window, cx| action(FilterAction::OpenSub(sub), window, cx));
        if view.sub == Some(sub) {
            row = row.checked(false);
        }
        list = list.row(row);
    }
    let (close_out, close_key, close_sub) = (act.clone(), act.clone(), act.clone());
    let size = window.viewport_size();
    let button = view.button;
    let panel = |id: &'static str, width: f32, content: AnyElement| {
        div()
            .id(id)
            .debug_selector(move || id.to_owned())
            .occlude()
            .w(px(width))
            .p(px(MENU_PADDING))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .child(content)
    };
    let main =
        panel("filters-panel", MAIN_WIDTH, list.into_any_element()).key_context("FiltersMenu").on_key_down(move |event, window, cx| {
            if event.keystroke.key == "escape" {
                cx.stop_propagation();
                close_key(FilterAction::Close, window, cx);
            }
        });
    // A click anywhere else closes the menu; a window-sized pane under both panels catches it. It closes on the release
    // and leaves the Filters button alone: its own click toggles.
    let backdrop = deferred(anchored().position(point(px(0.0), px(0.0))).child(
        div().id("filters-backdrop").w(size.width).h(size.height).on_mouse_up(gpui::MouseButton::Left, move |event, window, cx| {
            if !button.contains(&event.position) {
                close_out(FilterAction::Close, window, cx)
            }
        }),
    ))
    .with_priority(1);
    let main = deferred(anchored().position(view.origin).anchor(Anchor::BottomLeft).child(main)).with_priority(2);

    let sub = view.sub.map(|sub| {
        let mut list = MenuList::new(format!("filters-{}-list", sub.id()));
        match sub {
            Sub::Computers => {
                for computer in &view.computers {
                    let (id, action) = (computer.id.clone(), act.clone());
                    list = list.row(
                        MenuRow::new(format!("computer-{}", computer.id), computer.name.clone())
                            .subtitle(computer.line.clone())
                            .checked(computer.shown)
                            .on_click(move |_, window, cx| action(FilterAction::ToggleComputer(id.clone()), window, cx)),
                    );
                }
                let action = act.clone();
                list = list.separator().row(
                    MenuRow::new("add-computer", "Add computer")
                        .icon(IconName::Add01)
                        .on_click(move |_, window, cx| action(FilterAction::AddComputer, window, cx)),
                );
            }
            Sub::Projects => {
                let mut computers: Vec<&str> = Vec::new();
                for project in &view.projects {
                    if !computers.contains(&project.computer.as_str()) {
                        computers.push(&project.computer);
                    }
                }
                for (index, computer) in computers.iter().enumerate() {
                    if view.multi {
                        let name =
                            view.computer_names.iter().find(|(id, _)| id == computer).map(|(_, name)| name.clone()).unwrap_or_default();
                        list = list.label(if *computer == LOCAL { format!("{name} · This Mac") } else { name.to_string() });
                    }
                    let _ = index;
                    for project in view.projects.iter().filter(|project| project.computer == *computer) {
                        let (scope, action) = (project.scope, act.clone());
                        let mut row = MenuRow::new(format!("project-{scope}"), project.name.clone())
                            .checked(project.shown)
                            .on_click(move |_, window, cx| action(FilterAction::ToggleProject(scope), window, cx));
                        if project.open {
                            row = row.trailing("Open");
                        }
                        list = list.row(row);
                    }
                }
            }
            Sub::Show => {
                for (field, label) in show_fields(view.multi) {
                    let action = act.clone();
                    list = list.row(
                        MenuRow::new(format!("show-{}", field.id()), label)
                            .icon(icon_of(field))
                            .checked(view.show.get(field))
                            .on_click(move |_, window, cx| action(FilterAction::ToggleField(field), window, cx)),
                    );
                }
            }
        }
        // The submenu's top lines up with its row in the main panel (`row.top - 6`).
        let index = offered.iter().position(|offered| *offered == sub).unwrap_or(0);
        let top = view.origin.y - px(main_height) + px(index as f32 * ROW_STEP);
        let left = view.origin.x + px(MAIN_WIDTH + GAP);
        deferred(anchored().position(point(left, top)).anchor(Anchor::TopLeft).snap_to_window_with_margin(px(8.0)).child(
            panel("filters-sub-panel", sub.width(), list.into_any_element()).key_context("FiltersSub").on_key_down(
                move |event, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "escape" | "left") {
                        cx.stop_propagation();
                        close_sub(FilterAction::CloseSub, window, cx);
                    }
                },
            ),
        ))
        .with_priority(3)
    });
    div().child(backdrop).child(main).children(sub).into_any_element()
}
