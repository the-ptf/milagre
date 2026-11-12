//! A Chat row's context menu (`ChatMenu` in `components/sidebar/ChatRow.tsx`, cut down to the items Victor keeps): the entries are a pure
//! function of [`MenuContext`] (what the Chat is and where it lives), so the order and the conditions are testable
//! without a window; [`render`] draws them in a 240px card at the pointer, which keeps inside the window (flipping
//! upwards near the bottom, as `ChatMenu` does) and closes on Escape and on a press outside.
//!
//! GPUI has no native context-menu API, so this is our own `deferred(anchored())` over the sidebar with the shared
//! [`MenuList`] inside. It takes focus on its first row when it opens and hands it back to the sidebar on close.

use gpui::{Anchor, AnyElement, App, Pixels, Point, SharedString, Window, anchored, deferred, div, prelude::*, px};

use crate::theme::{ActiveTheme, RADIUS_CARD};
use crate::ui::{IconName, MenuList, MenuRow};

/// The menu's width (`MENU_WIDTH`).
pub const MENU_WIDTH: f32 = 240.0;
/// Keeps the card this far from the window's edges.
const EDGE_MARGIN: f32 = 8.0;

/// What the menu's conditions read, built from the Chat, its Worktree and its Project.
#[derive(Clone, Debug, Default)]
pub struct MenuContext {
    pub key: String,
    /// The Worktree's folder; none for a Chat without one.
    pub path: Option<SharedString>,
    /// The checked-out branch.
    pub branch: Option<SharedString>,
    /// An own Worktree that is not the main checkout and not a shared Link Chat's: a Linear issue can be tied to it.
    pub linkable: bool,
    /// The Linear issue key the Worktree carries.
    pub linear_key: Option<SharedString>,
    pub unread: bool,
    pub pinned: bool,
    /// Marked Done (the Done section's row): Reopen replaces Mark Done.
    pub done: bool,
    /// A Subchat: it can detach from its parent.
    pub has_parent: bool,
    /// A Chat without a Project (the Chats home) or a folder outside Git: no path, branch, Finder, editor or commit.
    pub gitless: bool,
    /// The Chat lives on another computer: no Finder or editor.
    pub remote: bool,
    /// A canvas Link reaches its Worktree.
    pub linked: bool,
}

/// What an item does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    CopyBranch,
    Rename,
    Reload,
    UnlinkIssue,
    MarkUnread,
    Pin,
    Unpin,
    LinkWith,
    RemoveLink,
    Detach,
    Done,
    Reopen,
    /// Hides the Chat at once (`HIDE_ONLY`); the toast's Undo takes it back for 6 seconds.
    Delete,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MenuEntry {
    Row(MenuItem),
    Divider,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MenuItem {
    pub action: MenuAction,
    pub label: SharedString,
    pub icon: IconName,
    pub disabled: bool,
    pub danger: bool,
}

impl MenuItem {
    fn new(action: MenuAction, label: impl Into<SharedString>, icon: IconName) -> Self {
        Self { action, label: label.into(), icon, disabled: false, danger: false }
    }

    fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    fn danger(mut self) -> Self {
        self.danger = true;
        self
    }
}

/// The menu's items for this Chat, in `ChatMenu`'s order: Copy branch name, Rename, Reload, Unlink issue, Mark as
/// unread, Pin, Links, Detach, a divider, then Done or Reopen and Delete. (Copy path, bug report, Link issue, Mark as
/// read, Finder, editor and commit are not offered.)
pub fn entries(ctx: &MenuContext) -> Vec<MenuEntry> {
    use MenuAction as A;
    let row = |item: MenuItem| MenuEntry::Row(item);
    let mut out = Vec::new();
    if !ctx.gitless {
        out.push(row(MenuItem::new(A::CopyBranch, "Copy branch name", IconName::GitBranch).disabled(ctx.branch.is_none())));
    }
    out.push(row(MenuItem::new(A::Rename, "Rename Chat", IconName::PencilEdit02)));
    out.push(row(MenuItem::new(A::Reload, "Reload Chat", IconName::Refresh01)));
    if ctx.linkable && ctx.linear_key.is_some() {
        out.push(row(MenuItem::new(A::UnlinkIssue, "Unlink issue", IconName::Link04)));
    }
    if !ctx.unread {
        out.push(row(MenuItem::new(A::MarkUnread, "Mark as unread", IconName::Circle)));
    }
    out.push(row(if ctx.pinned {
        MenuItem::new(A::Unpin, "Unpin", IconName::PinOff)
    } else {
        MenuItem::new(A::Pin, "Pin", IconName::Pin)
    }));
    if ctx.path.is_some() && !ctx.remote {
        out.push(row(MenuItem::new(A::LinkWith, "Link with…", IconName::Link04)));
    }
    if ctx.linked {
        out.push(row(MenuItem::new(A::RemoveLink, "Remove Link with…", IconName::Unlink04)));
    }
    if ctx.has_parent {
        out.push(row(MenuItem::new(A::Detach, "Detach from parent", IconName::Unlink04)));
    }
    out.push(MenuEntry::Divider);
    out.push(row(if ctx.done {
        MenuItem::new(A::Reopen, "Reopen", IconName::Undo02)
    } else {
        MenuItem::new(A::Done, "Mark Done", IconName::Tick02)
    }));
    out.push(row(MenuItem::new(A::Delete, "Delete", IconName::Delete02).danger()));
    out
}

/// Where the card goes: at the pointer, pulled left so it fits, and above the pointer when there is no room below.
/// Returns the anchor corner and the point it sits on.
pub fn placement(at: Point<Pixels>, window_width: Pixels, window_height: Pixels, height: Pixels) -> (Anchor, Point<Pixels>) {
    let left = at.x.min(window_width - px(MENU_WIDTH + EDGE_MARGIN)).max(px(EDGE_MARGIN));
    if at.y + height > window_height - px(EDGE_MARGIN) {
        (Anchor::BottomLeft, Point { x: left, y: (at.y - px(EDGE_MARGIN)).max(px(EDGE_MARGIN) + height) })
    } else {
        (Anchor::TopLeft, Point { x: left, y: at.y })
    }
}

/// An estimate of the card's height for [`placement`]: 32px rows, 1px dividers, 12px of padding.
pub fn height_of(entries: &[MenuEntry]) -> Pixels {
    let rows = entries.iter().filter(|entry| matches!(entry, MenuEntry::Row(_))).count();
    let dividers = entries.len() - rows;
    px(rows as f32 * 33.0 + dividers as f32 * 9.0 + 12.0)
}

/// The open menu.
pub struct OpenMenu {
    pub context: MenuContext,
    pub at: Point<Pixels>,
}

/// Draws the card. `on_pick` runs an item; `on_close` is the press outside or Escape.
pub fn render(
    open: &OpenMenu,
    window: &Window,
    cx: &App,
    on_pick: impl Fn(MenuAction, &mut Window, &mut App) + Clone + 'static,
    on_close: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let theme = *cx.theme();
    let mut items = entries(&open.context);
    // Preview: only the Chat writes the data layer takes, with a divider only between two kept groups.
    if crate::workspace::preview::is_on(cx) {
        items.retain(|entry| match entry {
            MenuEntry::Row(item) => crate::workspace::preview::allows(cx, item.action),
            MenuEntry::Divider => true,
        });
        let rows = |entries: &[MenuEntry]| entries.iter().any(|entry| matches!(entry, MenuEntry::Row(_)));
        if let Some(at) = items.iter().position(|entry| *entry == MenuEntry::Divider)
            && (!rows(&items[..at]) || !rows(&items[at + 1..]))
        {
            items.remove(at);
        }
    }
    let size = window.viewport_size();
    let (anchor, position) = placement(open.at, size.width, size.height, height_of(&items));
    let mut list = MenuList::new("chat-menu-list");
    for entry in items {
        list = match entry {
            MenuEntry::Divider => list.separator(),
            MenuEntry::Row(item) => {
                let pick = on_pick.clone();
                let action = item.action;
                let mut row = MenuRow::new(format!("menu-{}", action_id(action)), item.label)
                    .icon(item.icon)
                    .disabled(item.disabled)
                    .on_click(move |_, window, cx| pick(action, window, cx));
                if item.danger {
                    row = row.danger();
                }
                list.row(row)
            }
        };
    }
    let (close_out, close_key) = (on_close.clone(), on_close);
    deferred(
        anchored().position(position).anchor(anchor).child(
            div()
                .id("chat-menu")
                .debug_selector(|| "chat-menu".into())
                .key_context("ChatMenu")
                .occlude()
                .w(px(MENU_WIDTH))
                .p(px(6.0))
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .on_mouse_down_out(move |_, window, cx| close_out(window, cx))
                .on_key_down(move |event, window, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        close_key(window, cx);
                    }
                })
                .child(list),
        ),
    )
    .with_priority(2)
    .into_any_element()
}

/// The id a row's `debug_selector` carries: `menu-<id>`.
pub fn action_id(action: MenuAction) -> &'static str {
    use MenuAction as A;
    match action {
        A::CopyBranch => "copy-branch",
        A::Rename => "rename",
        A::Reload => "reload",
        A::UnlinkIssue => "unlink-issue",
        A::MarkUnread => "unread",
        A::Pin => "pin",
        A::Unpin => "unpin",
        A::LinkWith => "link-with",
        A::RemoveLink => "remove-link",
        A::Detach => "detach",
        A::Done => "done",
        A::Reopen => "reopen",
        A::Delete => "delete",
    }
}
