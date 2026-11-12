//! The `Sidebar` methods behind the menus, the hover card, rename, Done, Delete, Pin, undo and Filters (WP-20).
//!
//! Every change applies to the sidebar's own copy of the data at once, rebuilds the rows, sends its call through
//! [`SidebarActions`] and, for Done, Reopen, Pin, Unpin and Delete, is recorded in the undo book. ⌘Z and ⇧⌘Z (and
//! the toast's button) walk the book: its closures only queue an [`Op`], and [`Sidebar::apply_queue`] runs the queue
//! right after, without recording it a second time.

use std::time::Duration;

use gpui::{
    AnyElement, AnyView, App, Bounds, ClipboardItem, Context, Entity, Global, KeyBinding, Pixels, Point, Subscription, WeakEntity, Window,
    point, px,
};

use super::actions::{ArchiveMode, ChatPatch, SidebarCall};
use super::bottom::{FILTERS_LEFT, FOOTER_BAR, FiltersDot, Footer};
use super::filters::{self, FilterAction, FiltersView, Sub};
use super::menu::{self, MenuAction, MenuContext, OpenMenu};
use super::rename::{RenameEvent, RenameField};
use super::undo::{Op, Redo, TOAST_MS, Undo};
use super::{Sidebar, hover_card, pins, rail};
use crate::data::{Chat, ComputerState, LOCAL};
use crate::logic::lists::undo_history::ToastButton;

/// A rename in progress: the Chat's key and its field.
pub(super) struct Renaming {
    pub key: String,
    field: Entity<RenameField>,
    _subscription: Subscription,
}

impl Renaming {
    pub fn view(&self) -> AnyView {
        self.field.clone().into()
    }
}

struct UndoTarget(WeakEntity<Sidebar>);
impl Global for UndoTarget {}

/// ⌘Z and ⇧⌘Z reach the latest sidebar wherever focus is (a text field answers its own ⌘Z first: its binding sits in
/// a deeper key context).
pub(super) fn install_undo_keys(cx: &mut Context<Sidebar>) {
    struct Installed;
    impl Global for Installed {}
    let target = cx.weak_entity();
    cx.set_global(UndoTarget(target));
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    let app: &mut App = cx;
    app.bind_keys([KeyBinding::new("cmd-z", Undo, None), KeyBinding::new("cmd-shift-z", Redo, None)]);
    app.on_action(|_: &Undo, cx: &mut App| step(cx, true));
    app.on_action(|_: &Redo, cx: &mut App| step(cx, false));
}

fn step(cx: &mut App, undo: bool) {
    let Some(target) = cx.try_global::<UndoTarget>().map(|target| target.0.clone()) else { return };
    let _ = target.update(cx, |sidebar, cx| {
        if sidebar.overlay_open() {
            return;
        }
        if undo {
            sidebar.undo(cx)
        } else {
            sidebar.redo(cx)
        };
    });
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Sidebar {
    // ---- reading ----------------------------------------------------------------------------------------------

    /// The scope index and Chat number a key names.
    pub(super) fn locate(&self, key: &str) -> Option<(usize, u64)> {
        let (scope, id) = key.rsplit_once('#')?;
        let id = id.parse().ok()?;
        let at = self.data.scopes.iter().position(|data| data.project.scope().as_str() == scope)?;
        self.data.scopes[at].state.sessions.contains_key(&id).then_some((at, id))
    }

    fn chat_mut(&mut self, key: &str) -> Option<&mut Chat> {
        let (scope, id) = self.locate(key)?;
        self.data.scopes[scope].state.sessions.get_mut(&id)
    }

    /// Every call the sidebar made while it had no app-provided actions (the fixture's recording).
    pub fn calls(&self) -> Vec<SidebarCall> {
        self.recorder.as_ref().map(|recorder| recorder.calls()).unwrap_or_default()
    }

    pub(super) fn send(&self, call: SidebarCall) {
        self.actions.call(call);
    }

    /// A menu, the Filters panel or a rename is open: ⌘Z is theirs.
    pub fn overlay_open(&self) -> bool {
        self.menu.is_some() || self.filters_open.is_some() || self.renaming.is_some()
    }

    pub fn menu_open(&self) -> bool {
        self.menu.is_some()
    }

    pub fn card_key(&self) -> Option<&str> {
        self.card.as_ref().map(|(key, _)| key.as_str())
    }

    pub fn renaming_key(&self) -> Option<&str> {
        self.renaming.as_ref().map(|renaming| renaming.key.as_str())
    }

    pub fn filters_state(&self) -> Option<Option<Sub>> {
        self.filters_open
    }

    pub fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    pub fn toast_text(&self) -> Option<String> {
        self.book.history.toast().map(|toast| toast.text.clone())
    }

    pub fn row_title(&self, key: &str) -> Option<String> {
        self.rows.iter().find(|row| row.key.as_ref() == key).map(|row| row.title.to_string())
    }

    pub fn row_keys(&self) -> Vec<String> {
        self.rows.iter().map(|row| row.key.to_string()).collect()
    }

    pub fn show_fields(&self) -> crate::logic::lists::chat_row::ChatRowShow {
        self.show
    }

    pub fn is_pinned_key(&self, key: &str) -> bool {
        self.rows.iter().take(self.pinned).any(|row| row.key.as_ref() == key)
    }

    pub fn hidden_computers(&self) -> Vec<String> {
        let mut hidden: Vec<String> = self.list_filters.hidden_computers.iter().cloned().collect();
        hidden.sort();
        hidden
    }

    pub fn hidden_project_names(&self) -> Vec<String> {
        self.data.scopes.iter().filter(|scope| scope.project.hidden).map(|scope| scope.project.name.to_string()).collect()
    }

    /// Whether the Chat is in the Done section.
    pub fn is_done_key(&self, key: &str) -> bool {
        self.locate(key).is_some_and(|(scope, id)| self.data.scopes[scope].state.sessions[&id].is_done())
    }

    /// Whether the Chat is archived (deleted from the list, still inside its undo window).
    pub fn is_archived_key(&self, key: &str) -> bool {
        self.locate(key).is_some_and(|(scope, id)| self.data.scopes[scope].state.sessions[&id].archived)
    }

    /// What a canvas Link joins: the Chats whose Worktree it reaches and their labels (set by the canvas).
    pub fn set_linked(&mut self, linked: std::collections::HashMap<String, Vec<String>>, cx: &mut Context<Self>) {
        self.linked = linked;
        cx.notify();
    }

    /// Moves the undo book's clock forward (tests): a deletion past its window can no longer be taken back.
    pub fn advance_clock(&mut self, ms: i64) {
        self.book.advance(ms);
    }

    // ---- the context menu ---------------------------------------------------------------------------------------

    pub(super) fn menu_context(&self, key: &str) -> Option<MenuContext> {
        let (scope_ix, id) = self.locate(key)?;
        let scope = &self.data.scopes[scope_ix];
        let chat = &scope.state.sessions[&id];
        let worktree = scope.state.worktree_of(chat);
        let gitless = scope.project.is_chats_home() || !scope.project.git;
        let pinned = pins::pin_of(&self.data, &self.list_filters.pins, scope_ix, id).is_some();
        Some(MenuContext {
            key: key.to_owned(),
            path: worktree.map(|worktree| worktree.path.clone()).filter(|_| !gitless),
            branch: worktree.map(|worktree| worktree.name.clone()).filter(|_| !gitless),
            linkable: worktree.is_some_and(|worktree| worktree.shared_chat.is_none() && worktree.path != scope.project.path) && !gitless,
            linear_key: worktree.and_then(|worktree| worktree.linear_issue.clone()),
            unread: chat.unread,
            pinned,
            done: chat.is_done(),
            has_parent: chat.parent.is_some(),
            gitless,
            remote: scope.project.computer.as_ref() != LOCAL,
            linked: self.linked.get(key).is_some_and(|labels| !labels.is_empty()),
        })
    }

    /// Opens the row's menu at `at` (a Chat pending deletion has none).
    pub(super) fn open_menu(&mut self, ix: usize, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = self.rows.get(ix).map(|row| row.key.to_string()) else { return };
        if self.open_menu_key(&key, at, window, cx) {
            self.select(ix, cx);
        }
    }

    /// Opens the menu of the Chat with this key (a Done row has no list index). `false` when it has none.
    pub(super) fn open_menu_key(&mut self, key: &str, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.is_archived_key(key) {
            return false;
        }
        let Some(context) = self.menu_context(key) else { return false };
        self.close_card();
        self.filters_open = None;
        self.menu = Some(OpenMenu { context, at });
        let _ = window;
        cx.notify();
        true
    }

    pub fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    /// Runs a menu item for the open menu's Chat and closes the menu.
    pub fn run_menu(&mut self, action: MenuAction, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = self.menu.take() else { return };
        if crate::workspace::preview::is_on(cx) && !crate::workspace::preview::menu_allows(action) {
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        window.focus(&self.focus, cx);
        let context = open.context;
        let key = context.key.clone();
        match action {
            MenuAction::CopyBranch => {
                if let Some(branch) = &context.branch {
                    cx.write_to_clipboard(ClipboardItem::new_string(branch.to_string()));
                }
            }
            MenuAction::Rename => self.start_rename(&key, window, cx),
            MenuAction::Reload => self.send(SidebarCall::Reload { chat: key }),
            MenuAction::UnlinkIssue => self.send(SidebarCall::UnlinkIssue { chat: key }),
            MenuAction::MarkUnread => self.set_unread(&key, true, cx),
            MenuAction::Pin => self.pin(&key, true, true, cx),
            MenuAction::Unpin => self.pin(&key, false, true, cx),
            MenuAction::LinkWith => {
                self.send(SidebarCall::LinkWith { chat: key.clone() });
                let top = self.row_top(&key, cx);
                self.pick_link(&key, super::link_popover::PickerMode::Link, top, window, cx);
            }
            MenuAction::RemoveLink => {
                self.send(SidebarCall::RemoveLinkWith { chat: key.clone() });
                let top = self.row_top(&key, cx);
                self.pick_link(&key, super::link_popover::PickerMode::Remove, top, window, cx);
            }
            MenuAction::Detach => self.detach(&key, cx),
            MenuAction::Done => self.mark_done(&key, true, cx),
            MenuAction::Reopen => self.reopen(&key, true, cx),
        }
        cx.notify();
    }

    // ---- the changes --------------------------------------------------------------------------------------------

    /// Moves a Chat to Done at once; the host's write follows (`chat:patch { doneAt }`).
    pub fn mark_done(&mut self, key: &str, record: bool, cx: &mut Context<Self>) {
        let at = now_ms();
        let Some(chat) = self.chat_mut(key) else { return };
        if chat.done_at.is_some() {
            return;
        }
        chat.done_at = Some(at);
        self.send(SidebarCall::Patch { chat: key.to_owned(), patch: ChatPatch::DoneAt(Some(at)) });
        self.rebuild(None);
        if record {
            self.book.done(key);
            self.after_book(cx);
        }
        cx.notify();
    }

    pub fn reopen(&mut self, key: &str, record: bool, cx: &mut Context<Self>) {
        let Some(chat) = self.chat_mut(key) else { return };
        if chat.done_at.is_none() {
            return;
        }
        chat.done_at = None;
        self.send(SidebarCall::Patch { chat: key.to_owned(), patch: ChatPatch::DoneAt(None) });
        self.rebuild(None);
        if record {
            self.book.reopen(key);
            self.after_book(cx);
        }
        cx.notify();
    }

    /// Delete hides the Chat (`HIDE_ONLY`: its Worktree stays); the toast's Undo takes it back for 6 seconds.
    pub fn delete(&mut self, key: &str, record: bool, cx: &mut Context<Self>) {
        if crate::workspace::preview::is_on(cx) {
            return;
        }
        let Some(chat) = self.chat_mut(key) else { return };
        chat.archived = true;
        self.send(SidebarCall::Archive { chat: key.to_owned(), mode: ArchiveMode::HideOnly });
        self.rebuild(None);
        if record {
            self.book.delete(key);
            self.after_book(cx);
        }
        cx.notify();
    }

    fn undo_delete(&mut self, key: &str) {
        let Some(chat) = self.chat_mut(key) else { return };
        chat.archived = false;
        self.send(SidebarCall::UndoArchive { chat: key.to_owned() });
        self.rebuild(None);
    }

    /// Pins (after the Chats pinned in its scope) or unpins on this device.
    pub fn pin(&mut self, key: &str, pinned: bool, record: bool, cx: &mut Context<Self>) {
        if crate::workspace::preview::is_on(cx) {
            return;
        }
        let Some((scope, id)) = self.locate(key) else { return };
        let before = pins::pin_of(&self.data, &self.list_filters.pins, scope, id);
        let after = pinned.then(|| pins::next_order(&self.data, &self.list_filters.pins, scope, id));
        self.set_pin_order(key, after);
        if record {
            self.book.pin(key, before, after);
            self.after_book(cx);
        }
        cx.notify();
    }

    pub(super) fn set_pin_order(&mut self, key: &str, order: Option<f64>) {
        let Some((scope, id)) = self.locate(key) else { return };
        self.list_filters.pins = pins::with_order(&self.data, &self.list_filters.pins, scope, id, order);
        self.send(SidebarCall::Pin { chat: key.to_owned(), order });
        self.rebuild(None);
    }

    fn set_unread(&mut self, key: &str, unread: bool, cx: &mut Context<Self>) {
        let Some(chat) = self.chat_mut(key) else { return };
        chat.unread = unread;
        self.send(SidebarCall::Patch { chat: key.to_owned(), patch: ChatPatch::Unread(unread) });
        self.rebuild(None);
        cx.notify();
    }

    fn detach(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(chat) = self.chat_mut(key) else { return };
        chat.parent = None;
        self.send(SidebarCall::Patch { chat: key.to_owned(), patch: ChatPatch::Detach });
        self.rebuild(None);
        cx.notify();
    }

    // ---- rename -------------------------------------------------------------------------------------------------

    pub fn start_rename(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(title) = self.row_title(key) else { return };
        self.close_card();
        let field = gpui::AppContext::new(cx, |cx| RenameField::new(&title, window, cx));
        let owned = key.to_owned();
        let subscription = cx.subscribe_in(&field, window, move |this, _, event: &RenameEvent, window, cx| {
            let RenameEvent::Finished(name) = event;
            this.finish_rename(&owned, name.clone(), window, cx);
        });
        let renaming = Renaming { key: key.to_owned(), field, _subscription: subscription };
        let view = renaming.view();
        self.renaming = Some(renaming);
        if let Some(ix) = self.rows.iter().position(|row| row.key.as_ref() == key)
            && let Some((row, _)) = self.row_views.get(&ix)
        {
            row.update(cx, |row, cx| row.set_rename(Some(view), cx));
        }
        cx.notify();
    }

    fn finish_rename(&mut self, key: &str, name: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.renaming.as_ref().is_none_or(|renaming| renaming.key != key) {
            return;
        }
        self.renaming = None;
        if let Some(ix) = self.rows.iter().position(|row| row.key.as_ref() == key)
            && let Some((row, _)) = self.row_views.get(&ix)
        {
            row.update(cx, |row, cx| row.set_rename(None, cx));
        }
        window.focus(&self.focus, cx);
        if let Some(name) = name
            && self.row_title(key).as_deref() != Some(name.as_str())
        {
            let Some(chat) = self.chat_mut(key) else { return };
            // An emptied name puts the generated title back.
            chat.title = (!name.is_empty()).then(|| name.clone().into());
            self.send(SidebarCall::Patch { chat: key.to_owned(), patch: ChatPatch::Title(name.into()) });
            self.rebuild(None);
        }
        cx.notify();
    }

    // ---- undo ---------------------------------------------------------------------------------------------------

    /// ⌘Z: takes back the latest step; `false` when there is nothing to undo.
    pub fn undo(&mut self, cx: &mut Context<Self>) -> bool {
        let did = self.book.history.undo();
        self.apply_queue(cx);
        self.after_book(cx);
        did
    }

    /// ⇧⌘Z: does the latest undone step again.
    pub fn redo(&mut self, cx: &mut Context<Self>) -> bool {
        let did = self.book.history.redo();
        self.apply_queue(cx);
        self.after_book(cx);
        did
    }

    fn apply_queue(&mut self, cx: &mut Context<Self>) {
        for op in self.book.drain() {
            match op {
                Op::Done(key) => self.mark_done(&key, false, cx),
                Op::Reopen(key) => self.reopen(&key, false, cx),
                Op::Pin(key, order) => self.set_pin_order(&key, order),
                Op::Archive(key) => self.delete(&key, false, cx),
                Op::UndoArchive(key) => self.undo_delete(&key),
                Op::RemoveLink(id) => self.remove_link(&id, false, cx),
                Op::RestoreLink(link) => self.restore_link(link, cx),
            }
        }
    }

    /// The toast changed: a new one gets its 6 seconds.
    pub(super) fn after_book(&mut self, cx: &mut Context<Self>) {
        let id = self.book.history.toast().map(|toast| toast.id);
        if id != self.toast_shown {
            self.toast_shown = id;
            self._toast_timer = id.map(|id| {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(TOAST_MS)).await;
                    let _ = this.update(cx, |this, cx| {
                        this.book.history.dismiss(id);
                        this.toast_shown = None;
                        cx.notify();
                    });
                })
            });
        }
        cx.notify();
    }

    // ---- the hover card -----------------------------------------------------------------------------------------

    pub(super) fn close_card(&mut self) {
        self.card = None;
        self.hover_task = None;
    }

    /// The pointer came onto row `ix` (with its bounds) or left it.
    pub(super) fn hover_row(&mut self, ix: usize, bounds: Option<Bounds<Pixels>>, cx: &mut Context<Self>) {
        let Some(key) = self.rows.get(ix).map(|row| row.key.to_string()) else { return };
        match bounds {
            Some(bounds) => {
                self.hover_task = None;
                if self.card.as_ref().is_some_and(|(shown, _)| *shown == key) {
                    return;
                }
                self.card = None;
                if self.overlay_open() {
                    return;
                }
                self.hover_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(hover_card::OPEN_DELAY).await;
                    let _ = this.update(cx, |this, cx| {
                        if !this.overlay_open() {
                            this.card = Some((key, bounds));
                            cx.notify();
                        }
                    });
                }));
            }
            None => self.hover_leave(cx),
        }
    }

    /// The pointer left the row or the card: the card closes after its grace, unless the pointer reaches the other.
    fn hover_leave(&mut self, cx: &mut Context<Self>) {
        self.hover_task = None;
        if self.card.is_some() {
            self.hover_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(hover_card::CLOSE_GRACE).await;
                let _ = this.update(cx, |this, cx| {
                    this.card = None;
                    cx.notify();
                });
            }));
        }
    }

    fn hover_card_pointer(&mut self, on_card: bool, cx: &mut Context<Self>) {
        if on_card {
            self.hover_task = None;
        } else {
            self.hover_leave(cx);
        }
    }

    // ---- Filters ------------------------------------------------------------------------------------------------

    pub fn toggle_filters(&mut self, cx: &mut Context<Self>) {
        self.close_card();
        self.menu = None;
        self.filters_open = if self.filters_open.is_some() { None } else { Some(None) };
        cx.notify();
    }

    pub fn filter_action(&mut self, action: FilterAction, window: &mut Window, cx: &mut Context<Self>) {
        match action {
            FilterAction::OpenSub(sub) => self.filters_open = Some(Some(sub)),
            FilterAction::CloseSub => self.filters_open = Some(None),
            FilterAction::Close => {
                self.filters_open = None;
                window.focus(&self.focus, cx);
            }
            FilterAction::ToggleComputer(id) => {
                let hidden = !self.list_filters.hidden_computers.contains(&id);
                if hidden {
                    self.list_filters.hidden_computers.insert(id.clone());
                } else {
                    self.list_filters.hidden_computers.remove(&id);
                }
                self.send(SidebarCall::SetComputerHidden { computer: id, hidden });
                self.rebuild(None);
            }
            FilterAction::ToggleProject(scope) => {
                if let Some(data) = self.data.scopes.get_mut(scope) {
                    data.project.hidden = !data.project.hidden;
                    let call =
                        SidebarCall::SetProjectHidden { scope: data.project.scope().as_str().to_owned(), hidden: data.project.hidden };
                    self.send(call);
                    self.rebuild(None);
                }
            }
            FilterAction::ToggleField(field) => {
                let on = !self.show.get(field);
                self.show = filters::with_field(self.show, field, on);
                self.send(SidebarCall::SetRowField { field: field.id(), shown: on });
                self.rebuild(None);
            }
            FilterAction::AddComputer => {
                self.filters_open = None;
                self.send(SidebarCall::AddComputer);
            }
        }
        cx.notify();
    }

    fn filters_dot(&self) -> Option<FiltersDot> {
        let away = self.data.computers.computers.iter().any(|computer| computer.state != ComputerState::Online);
        let filtering = !self.list_filters.hidden_computers.is_empty() || self.data.scopes.iter().any(|scope| scope.project.hidden);
        if away {
            Some(FiltersDot::Away)
        } else if filtering {
            Some(FiltersDot::Filtering)
        } else {
            None
        }
    }

    /// The button's tooltip text.
    pub fn filters_tooltip(&self) -> String {
        filters::tooltip(self.list_filters.hidden_computers.len(), self.data.scopes.iter().filter(|scope| scope.project.hidden).count())
    }

    pub(super) fn footer(&self, cx: &mut Context<Self>) -> Footer {
        let (add, filters) = (cx.entity(), cx.entity());
        Footer {
            filters_open: self.filters_open.is_some(),
            filters_dot: self.filters_dot(),
            on_add_project: std::rc::Rc::new(move |_, cx| add.update(cx, |this, cx| this.add_project(cx))),
            on_filters: std::rc::Rc::new(move |_, cx| filters.update(cx, |this, cx| this.toggle_filters(cx))),
            button_bounds: self.filters_button.clone(),
        }
    }

    fn add_project(&mut self, cx: &mut Context<Self>) {
        self.send(SidebarCall::AddProject);
        cx.notify();
    }

    // ---- the rail -----------------------------------------------------------------------------------------------

    pub fn set_collapsed(&mut self, collapsed: bool, cx: &mut Context<Self>) {
        if self.collapsed != collapsed {
            self.collapsed = collapsed;
            self.close_card();
            self.rail_card = None;
            self.filters_open = None;
            self.menu = None;
            cx.notify();
        }
    }

    pub fn toggle_collapsed(&mut self, cx: &mut Context<Self>) {
        self.set_collapsed(!self.collapsed, cx);
    }

    pub fn rail_card_row(&self) -> Option<usize> {
        self.rail_card.map(|(ix, _)| ix)
    }

    pub(super) fn rail_hover(&mut self, ix: usize, hovered: bool, window: &Window, cx: &mut Context<Self>) {
        if hovered {
            self.rail_task = None;
            if self.rail_card.is_some_and(|(shown, _)| shown == ix) {
                return;
            }
            let y = window.mouse_position().y;
            self.rail_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(rail::OPEN_DELAY).await;
                let _ = this.update(cx, |this, cx| {
                    this.rail_card = Some((ix, y));
                    cx.notify();
                });
            }));
        } else {
            self.rail_leave(cx);
        }
    }

    fn rail_leave(&mut self, cx: &mut Context<Self>) {
        self.rail_task = None;
        if self.rail_card.is_some() {
            self.rail_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(rail::CLOSE_GRACE).await;
                let _ = this.update(cx, |this, cx| {
                    this.rail_card = None;
                    cx.notify();
                });
            }));
        }
    }

    fn rail_card_pointer(&mut self, on_card: bool, cx: &mut Context<Self>) {
        if on_card {
            self.rail_task = None;
        } else {
            self.rail_leave(cx);
        }
    }

    // ---- overlays -----------------------------------------------------------------------------------------------

    /// The menu, the hover card, the Filters panels and the rail's card, drawn over everything.
    pub(super) fn overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        let sidebar = cx.entity();
        if let Some(open) = &self.menu {
            let (pick, close) = (sidebar.clone(), sidebar.clone());
            out.push(menu::render(
                open,
                window,
                cx,
                move |action, window, cx| pick.update(cx, |this, cx| this.run_menu(action, window, cx)),
                move |window, cx| close.update(cx, |this, cx| this.close_menu(window, cx)),
            ));
        }
        if let Some((key, bounds)) = self.card.clone()
            && self.menu.is_none()
            && let Some(row) = self.rows.iter().find(|row| row.key.as_ref() == key).cloned()
        {
            let linked = self.linked.get(&key).cloned().unwrap_or_default();
            let model = hover_card::CardModel::build(
                &row,
                self.meta[self.rows.iter().position(|r| r.key.as_ref() == key).unwrap_or(0)],
                &self.data,
                linked,
            );
            let card = sidebar.clone();
            out.push(hover_card::render(&model, &row, bounds, window, cx, move |on, _, cx| {
                card.update(cx, |this, cx| this.hover_card_pointer(on, cx))
            }));
        }
        if let Some(sub) = self.filters_open {
            let size = window.viewport_size();
            let view = FiltersView {
                sub,
                computers: filters::computer_choices(&self.data, &self.list_filters.hidden_computers),
                projects: filters::project_choices(&self.data, self.selected.and_then(|ix| self.meta.get(ix)).map(|meta| meta.scope)),
                hidden_computers: self.list_filters.hidden_computers.len(),
                multi: filters::multi_computer(&self.data),
                show: self.show,
                origin: if self.collapsed {
                    point(px(rail::RAIL_WIDTH + 8.0), size.height - px(8.0))
                } else {
                    point(px(FILTERS_LEFT), size.height - px(FOOTER_BAR))
                },
                button: self.filters_button.get(),
                computer_names: std::iter::once((LOCAL.to_owned(), self.data.computers.this_mac.clone()))
                    .chain(self.data.computers.computers.iter().map(|computer| (computer.id.to_string(), computer.name.clone())))
                    .collect(),
            };
            let act = sidebar.clone();
            out.push(filters::render(&view, window, cx, move |action, window, cx| {
                act.update(cx, |this, cx| this.filter_action(action, window, cx))
            }));
        }
        if let Some((ix, y)) = self.rail_card
            && let Some(row) = self.rows.get(ix).cloned()
        {
            let name = super::list::project_label(&self.data.scopes[self.meta[ix].scope].project);
            let item = rail::item(&row, name, self.selected == Some(ix));
            let card = sidebar.clone();
            out.push(rail::popover(&item, &row, y, window, cx, move |on, _, cx| {
                card.update(cx, |this, cx| this.rail_card_pointer(on, cx))
            }));
        }
        out.extend(self.usage_overlay(window, cx));
        out.extend(self.drop_indicator(cx));
        out.extend(self.link_overlays());
        out
    }

    /// The toast's slot above the usage meters.
    pub(super) fn toast_slot(&self, cx: &mut Context<Self>) -> AnyElement {
        let sidebar = cx.entity();
        super::undo::toast_slot(self.book.history.toast(), move |button, _, cx| {
            sidebar.update(cx, |this, cx| {
                if button == ToastButton::Undo {
                    this.undo(cx)
                } else {
                    this.redo(cx)
                };
            })
        })
    }

    /// Snapshot seeds (`MILAGRE_GPUI_SIDEBAR_DEMO`): the state a picture of one menu, card or toast needs.
    pub(super) fn apply_demo(&mut self, demo: &str, window: &mut Window, cx: &mut Context<Self>) {
        // Row 0's box starts 52px down (the 44px header and the list's 8px), each row 56px below the one before.
        let top = |ix: usize| 52.0 + super::row::ROW_PITCH * ix as f32;
        let row = |ix: usize| Bounds {
            origin: point(px(super::row::ROW_INSET), px(top(ix))),
            size: gpui::size(px(super::SIDEBAR_WIDTH - 2.0 * super::row::ROW_INSET), px(super::row::ROW_HEIGHT)),
        };
        match demo {
            "menu" => self.open_menu(3, point(px(150.0), px(top(3) + 27.0)), window, cx),
            "menu-up" => self.open_menu(10, point(px(150.0), px(top(10) + 27.0)), window, cx),
            "card" => self.card = Some((self.rows[2].key.to_string(), row(2))),
            "card-prs" => self.card = Some((self.rows[0].key.to_string(), row(0))),
            // The hovered row of the design: its state swapped for the Done action.
            "hover-done" => {
                self.show_hover = Some(3);
                self.row_views.remove(&3);
            }
            "filters" => self.filters_open = Some(None),
            "filters-show" => self.filters_open = Some(Some(Sub::Show)),
            "filters-projects" => self.filters_open = Some(Some(Sub::Projects)),
            "filters-computers" => self.filters_open = Some(Some(Sub::Computers)),
            "done-open" => self.done_open = true,
            // Scrolled to the middle of the Chat list (both edge fades), and the Done list open and scrolled.
            "scrolled" => self.scroll.scroll_to_item(15, gpui::ScrollStrategy::Top),
            "done-scrolled" => {
                self.done_open = true;
                self.done_scroll.scroll_to_item(3, gpui::ScrollStrategy::Top);
            }
            // The Done list open with its first row under the pointer: Reopen in place of the run's length.
            "done-hover" => {
                self.done_open = true;
                self.done_hover = Some(0);
            }
            "toast" => {
                let key = self.rows[8].key.to_string();
                self.mark_done(&key, true, cx);
            }
            "toast-delete" => {
                let key = self.rows[8].key.to_string();
                self.delete(&key, true, cx);
            }
            "rename" => {
                let key = self.rows[2].key.to_string();
                self.start_rename(&key, window, cx);
            }
            "usage-card" => self.open_usage_demo(crate::data::Provider::Codex, cx),
            "usage-card-claude" => self.open_usage_demo(crate::data::Provider::Claude, cx),
            "usage-rail" => {
                self.collapsed = true;
                self.open_usage_demo(crate::data::Provider::Codex, cx);
            }
            "rail" => {
                self.collapsed = true;
                self.rail_card = Some((2, px(300.0)));
            }
            other => self.apply_drag_demo(other, window, cx),
        }
    }

    /// Every field Filters › Show offers (for tests and the PR screenshots).
    pub fn show_field_ids(&self) -> Vec<&'static str> {
        filters::show_fields(filters::multi_computer(&self.data)).into_iter().map(|(field, _)| field.id()).collect()
    }
}
