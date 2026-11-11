//! Canvas Links in the sidebar (S-15, WP-49): `shared/chat-links.mjs` and the provider half of
//! `components/sidebar/SidebarLinks.tsx`.
//!
//! - The rules, pure: which Links reach a Chat's Worktree, whether two Chats are linked already, the endpoints a new
//!   Link gets, why a Chat can't be picked, how a Link's other end is named, and the message "Link and ask" sends.
//! - The `Sidebar`'s side: the Links it knows, the Create Link popover a drop or "Link with…" opens
//!   ([`Sidebar::ask_link`]), the "Link with…" and "Remove Link with…" pickers ([`Sidebar::pick_link`]), and the
//!   writes (`canvas:link-add`, `linked:grant`, the ask, `canvas:link-remove`, `canvas:link-restore`), each through
//!   [`SidebarActions`](super::SidebarActions) and, where React offers one, an undo step in the sidebar's toast.
//!
//! The sidebar applies a write to its own list of Links at once (the desktop sets the list the host answers with);
//! a new Link takes the next fixture id, `link-N`.

use gpui::{AppContext as _, Bounds, Context, Pixels, SharedString, Window};

use super::actions::SidebarCall;
use super::link_popover::{LinkAsk, LinkPicker, LinkPopover, PickerEntry, PickerEvent, PickerMode, PopoverEvent};
use super::{SIDEBAR_WIDTH, Sidebar};
use crate::data::LOCAL;

/// One end of a Link: a Worktree of a Project, or the whole Project (`worktree_path` `None`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LinkEnd {
    pub project_id: String,
    pub worktree_path: Option<String>,
}

impl LinkEnd {
    pub fn worktree(project_id: &str, path: &str) -> Self {
        Self { project_id: project_id.into(), worktree_path: Some(path.into()) }
    }
}

/// `ProjectLink`: a canvas Link between two ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanvasLink {
    pub id: String,
    pub a: LinkEnd,
    pub b: LinkEnd,
}

/// What a new Link joins (`LinkScope`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LinkScope {
    #[default]
    Worktrees,
    Projects,
}

/// Why a Chat can't be linked to another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkProblem {
    SameWorktree,
    Linked,
}

impl LinkProblem {
    /// `LINK_PROBLEM_LABEL`: the short reason a list shows beside a Chat that can't be picked.
    pub fn label(self) -> &'static str {
        match self {
            LinkProblem::SameWorktree => "Same worktree",
            LinkProblem::Linked => "Already linked",
        }
    }

    /// `DROP_HINTS`: what a drop on a row that can't be linked says.
    pub fn drop_hint(self) -> &'static str {
        match self {
            LinkProblem::SameWorktree => "Same worktree: a Link joins two different Worktrees",
            LinkProblem::Linked => "Already linked",
        }
    }
}

/// `endpointCovers`: one end of a Link stands for this Worktree (the Worktree itself, or its whole Project).
pub fn endpoint_covers(end: &LinkEnd, worktree: &LinkEnd) -> bool {
    end.project_id == worktree.project_id && (end.worktree_path.is_none() || end.worktree_path == worktree.worktree_path)
}

/// `linkBetween`: the Link that already joins the two Worktrees, either way round.
pub fn link_between<'a>(links: &'a [CanvasLink], a: &LinkEnd, b: &LinkEnd) -> Option<&'a CanvasLink> {
    links.iter().find(|link| {
        (endpoint_covers(&link.a, a) && endpoint_covers(&link.b, b)) || (endpoint_covers(&link.a, b) && endpoint_covers(&link.b, a))
    })
}

/// `linkedEnds`: every Link that reaches the Worktree, with its other end, in the Links' order.
pub fn linked_ends<'a>(links: &'a [CanvasLink], worktree: &LinkEnd) -> Vec<(&'a CanvasLink, &'a LinkEnd)> {
    links
        .iter()
        .filter_map(|link| {
            if endpoint_covers(&link.a, worktree) {
                Some((link, &link.b))
            } else if endpoint_covers(&link.b, worktree) {
                Some((link, &link.a))
            } else {
                None
            }
        })
        .collect()
}

/// `canLinkProjects`: a Project↔Project Link only joins two different Projects.
pub fn can_link_projects(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && a != b
}

/// `linkEndpoints`: the two ends of a new Link between two Chats' Worktrees. "projects" falls back to the Worktrees
/// when both are in one Project.
pub fn link_endpoints(a: &LinkEnd, b: &LinkEnd, scope: LinkScope) -> (LinkEnd, LinkEnd) {
    if scope == LinkScope::Projects && can_link_projects(&a.project_id, &b.project_id) {
        let whole = |end: &LinkEnd| LinkEnd { project_id: end.project_id.clone(), worktree_path: None };
        return (whole(a), whole(b));
    }
    (a.clone(), b.clone())
}

/// `findLink`: the Link just made between two ends, in the list the host answers with.
pub fn find_link<'a>(links: &'a [CanvasLink], a: &LinkEnd, b: &LinkEnd) -> Option<&'a CanvasLink> {
    links.iter().find(|link| (link.a == *a && link.b == *b) || (link.a == *b && link.b == *a))
}

/// `linkProblem`: both in one Worktree, or a Link already joins them.
pub fn link_problem(links: &[CanvasLink], source: &LinkEnd, target: &LinkEnd) -> Option<LinkProblem> {
    if source == target {
        return Some(LinkProblem::SameWorktree);
    }
    link_between(links, source, target).map(|_| LinkProblem::Linked)
}

/// `linkedEndLabel`: "web / login-form", or "All of web" for a whole Project.
pub fn linked_end_label(end: &LinkEnd, project: Option<&str>, branch: Option<&str>) -> String {
    let name = project.filter(|name| !name.is_empty()).unwrap_or("Unavailable Project");
    let Some(path) = &end.worktree_path else { return format!("All of {name}") };
    let folder = branch.filter(|branch| !branch.is_empty()).map(str::to_string).unwrap_or_else(|| {
        let trimmed = path.trim_end_matches(['/', '\\']);
        trimmed.rsplit(['/', '\\']).next().filter(|part| !part.is_empty()).unwrap_or(path).to_string()
    });
    format!("{name} / {folder}")
}

/// The Chat "Link and ask" writes to (`linkAskMessage`'s target).
pub struct AskTarget<'a> {
    pub label: &'a str,
    pub chat_ref: &'a str,
    pub worktree_path: &'a str,
    pub project_name: Option<&'a str>,
    pub branch: Option<&'a str>,
}

/// `linkAskMessage`: what goes to Chat A as a plain user message (`body`) and what its agent reads (`prompt`).
pub fn link_ask_message(text: &str, target: &AskTarget) -> (String, String) {
    let where_: Vec<&str> = [target.project_name, target.branch].into_iter().flatten().filter(|part| !part.is_empty()).collect();
    let where_ = if where_.is_empty() { String::new() } else { format!(" ({})", where_.join(" / ")) };
    let body = format!("{}\n\nDestination: “{}”{where_}, in a linked Worktree.", text.trim(), target.label);
    let prompt = format!(
        "{body}\n\nThat Chat is {} in the linked Worktree {}. If this needs changes there, make a Delegation to it with your Link \
         tools (a Negotiation if the two sides must agree first); otherwise answer here.",
        target.chat_ref, target.worktree_path
    );
    (body, prompt)
}

/// A Chat as the Link popovers name it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkChat {
    pub key: String,
    pub label: SharedString,
    /// The Worktree's branch (`sideName` falls back to the label).
    pub branch: Option<SharedString>,
    pub project: SharedString,
    pub end: Option<LinkEnd>,
}

impl LinkChat {
    /// `sideName`.
    pub fn side_name(&self) -> SharedString {
        self.branch.clone().unwrap_or_else(|| self.label.clone())
    }
}

/// Where a popover opens: beside the sidebar, level with the row (`anchorAt`).
pub fn anchor_at(top: Pixels) -> gpui::Point<Pixels> {
    gpui::point(gpui::px(SIDEBAR_WIDTH + 8.0), top.max(gpui::px(8.0)))
}

/// What the Link popovers have open.
pub(super) enum OpenLinks {
    Ask { popover: gpui::Entity<LinkPopover>, at: gpui::Point<Pixels>, _events: gpui::Subscription },
    Pick { picker: gpui::Entity<LinkPicker>, mode: PickerMode, at: gpui::Point<Pixels>, _events: gpui::Subscription },
}

impl Sidebar {
    /// The Links the sidebar knows (`canvas:links`).
    pub fn links(&self) -> &[CanvasLink] {
        &self.links
    }

    /// Replaces the Links (`canvas:links-changed`), and the Link marks on the rows with them.
    pub fn set_links(&mut self, links: Vec<CanvasLink>, cx: &mut Context<Self>) {
        self.links = links;
        self.relabel_links();
        cx.notify();
    }

    /// Whether the Link popover or a picker is open, and which.
    pub fn link_overlay(&self) -> Option<&'static str> {
        match &self.link_open {
            Some(OpenLinks::Ask { .. }) => Some("ask"),
            Some(OpenLinks::Pick { mode, .. }) => Some(if *mode == PickerMode::Link { "link" } else { "remove" }),
            None => None,
        }
    }

    pub fn link_popover(&self) -> Option<gpui::Entity<LinkPopover>> {
        match &self.link_open {
            Some(OpenLinks::Ask { popover, .. }) => Some(popover.clone()),
            _ => None,
        }
    }

    pub fn link_picker(&self) -> Option<gpui::Entity<LinkPicker>> {
        match &self.link_open {
            Some(OpenLinks::Pick { picker, .. }) => Some(picker.clone()),
            _ => None,
        }
    }

    /// Whether the Chats of scope `scope` take part in Links (`linkProjectIdOf`): a Project of this computer with Git.
    pub(super) fn scope_linkable(&self, scope: usize) -> bool {
        self.data.scopes.get(scope).is_some_and(|scope| {
            !scope.project.is_chats_home() && scope.project.git && scope.project.computer.as_ref() == LOCAL && !scope.project.hidden
        })
    }

    /// The Link end of a Chat's Worktree (`worktreeOf`), when its scope can be linked.
    pub(super) fn link_end(&self, key: &str) -> Option<LinkEnd> {
        let (scope_ix, id) = self.locate(key)?;
        if !self.scope_linkable(scope_ix) {
            return None;
        }
        let scope = &self.data.scopes[scope_ix];
        let chat = scope.state.sessions.get(&id)?;
        let worktree = scope.state.worktree_of(chat)?;
        Some(LinkEnd::worktree(scope.project.scope().as_str(), &worktree.path))
    }

    pub(super) fn link_chat(&self, key: &str) -> Option<LinkChat> {
        let (scope_ix, id) = self.locate(key)?;
        let scope = &self.data.scopes[scope_ix];
        let chat = scope.state.sessions.get(&id)?;
        let label = self.rows.iter().find(|row| row.key.as_ref() == key).map(|row| row.title.clone());
        Some(LinkChat {
            key: key.to_string(),
            label: label.unwrap_or_else(|| chat.display_title(&[]).into()),
            branch: scope.state.worktree_of(chat).map(|worktree| worktree.name.clone()),
            project: super::list::project_label(&scope.project),
            end: self.link_end(key),
        })
    }

    /// The name of the Project with this id, for a Link's other end.
    fn project_named(&self, id: &str) -> Option<SharedString> {
        self.data.scopes.iter().find(|scope| scope.project.scope().as_str() == id).map(|scope| scope.project.name.clone())
    }

    /// The branch of the Worktree at `path` in Project `id`, from any Chat there.
    fn branch_at(&self, id: &str, path: &str) -> Option<SharedString> {
        let scope = self.data.scopes.iter().find(|scope| scope.project.scope().as_str() == id)?;
        scope
            .state
            .sessions
            .values()
            .filter_map(|chat| scope.state.worktree_of(chat))
            .find(|w| w.path.as_ref() == path)
            .map(|w| w.name.clone())
    }

    /// `endsFor`: each Link reaching the Chat's Worktree, by id, named by its other end.
    pub fn linked_ends_of(&self, key: &str) -> Vec<(String, String)> {
        let Some(end) = self.link_end(key) else { return Vec::new() };
        linked_ends(&self.links, &end)
            .into_iter()
            .map(|(link, other)| {
                let project = self.project_named(&other.project_id);
                let branch = other.worktree_path.as_deref().and_then(|path| self.branch_at(&other.project_id, path));
                (link.id.clone(), linked_end_label(other, project.as_deref(), branch.as_deref()))
            })
            .collect()
    }

    /// Recomputes the rows' Link marks (the hover card's lines and the menu's "Remove Link with…") from the Links.
    pub(super) fn relabel_links(&mut self) {
        let keys: Vec<String> = self.rows.iter().map(|row| row.key.to_string()).collect();
        let mut linked = std::collections::HashMap::new();
        for key in keys {
            let labels: Vec<String> = self.linked_ends_of(&key).into_iter().map(|(_, label)| label).collect();
            if !labels.is_empty() {
                linked.insert(key, labels);
            }
        }
        self.linked = linked;
    }

    /// Opens the Create Link popover: `source` asks to be linked with `target`, beside the sidebar at `top`.
    pub fn ask_link(&mut self, source: &str, target: &str, top: Pixels, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(source), Some(target)) = (self.link_chat(source), self.link_chat(target)) else { return };
        let projects = match (&source.end, &target.end) {
            (Some(a), Some(b)) => can_link_projects(&a.project_id, &b.project_id),
            _ => false,
        };
        let ask = LinkAsk { source, target, projects, can_ask: true };
        let popover = cx.new(|cx| LinkPopover::new(ask, window, cx));
        let events = cx.subscribe_in(&popover, window, |this, popover, event: &PopoverEvent, window, cx| {
            let ask = popover.read(cx).ask().clone();
            this.link_open = None;
            window.focus(&this.focus, cx);
            if let PopoverEvent::Confirm { scope, allow, text } = event {
                this.create_link(&ask, *scope, *allow, text, cx);
            }
            cx.notify();
        });
        popover.update(cx, |popover, cx| popover.focus(window, cx));
        self.menu = None;
        self.close_card();
        self.link_open = Some(OpenLinks::Ask { popover, at: anchor_at(top), _events: events });
        cx.notify();
    }

    /// Opens "Link with…" (every other Chat with a Worktree) or "Remove Link with…" (the Chat's Links).
    pub fn pick_link(&mut self, source: &str, mode: PickerMode, top: Pixels, window: &mut Window, cx: &mut Context<Self>) {
        let Some(source_chat) = self.link_chat(source) else { return };
        let entries = match mode {
            PickerMode::Remove => self
                .linked_ends_of(source)
                .into_iter()
                .map(|(id, label)| PickerEntry { key: id, title: label.into(), detail: None, problem: None })
                .collect(),
            PickerMode::Link => self.link_candidates(&source_chat),
        };
        let picker = cx.new(|cx| LinkPicker::new(mode, source_chat, entries, window, cx));
        let events = cx.subscribe_in(&picker, window, move |this, picker, event: &PickerEvent, window, cx| {
            let (mode, source) = {
                let picker = picker.read(cx);
                (picker.mode(), picker.source().key.clone())
            };
            let top = match &this.link_open {
                Some(OpenLinks::Pick { at, .. }) => at.y,
                _ => gpui::px(8.0),
            };
            this.link_open = None;
            window.focus(&this.focus, cx);
            if let PickerEvent::Pick(key) = event {
                match mode {
                    PickerMode::Remove => this.remove_link(key, true, cx),
                    PickerMode::Link => this.ask_link(&source, key, top, window, cx),
                }
            }
            cx.notify();
        });
        picker.update(cx, |picker, cx| picker.focus(window, cx));
        self.menu = None;
        self.close_card();
        self.link_open = Some(OpenLinks::Pick { picker, mode, at: anchor_at(top), _events: events });
        cx.notify();
    }

    /// `linkCandidates`: every other Chat with a Worktree, each saying why it can't be picked when it can't.
    fn link_candidates(&self, source: &LinkChat) -> Vec<PickerEntry> {
        let Some(a) = &source.end else { return Vec::new() };
        let mut out = Vec::new();
        for scope_ix in 0..self.data.scopes.len() {
            if !self.scope_linkable(scope_ix) {
                continue;
            }
            let scope = &self.data.scopes[scope_ix];
            let key_scope = scope.project.scope();
            let mut ids: Vec<_> = scope.state.sessions.iter().filter(|(_, chat)| !chat.archived).map(|(id, _)| *id).collect();
            ids.sort_unstable_by(|x, y| y.cmp(x));
            for id in ids {
                let key = key_scope.chat_key(id);
                if key == source.key {
                    continue;
                }
                let Some(chat) = self.link_chat(&key) else { continue };
                let Some(b) = &chat.end else { continue };
                let detail = match &chat.branch {
                    Some(branch) => format!("{} / {branch}", chat.project),
                    None => chat.project.to_string(),
                };
                out.push(PickerEntry {
                    key,
                    title: chat.label.clone(),
                    detail: Some(detail.into()),
                    problem: link_problem(&self.links, a, b).map(LinkProblem::label),
                });
            }
        }
        out
    }

    /// `create`: the Link (`canvas:link-add`), then Always allow (`linked:grant`), then the ask; one toast, whose
    /// Undo removes the Link.
    fn create_link(&mut self, ask: &LinkAsk, scope: LinkScope, allow: bool, text: &str, cx: &mut Context<Self>) {
        let (Some(a), Some(b)) = (&ask.source.end, &ask.target.end) else { return };
        let (first, second) = link_endpoints(a, b, scope);
        self.send(SidebarCall::AddLink { a: first.clone(), b: second.clone() });
        let created = match find_link(&self.links, &first, &second) {
            Some(link) => link.clone(),
            None => {
                self.next_link += 1;
                let link = CanvasLink { id: format!("link-{}", self.next_link), a: first, b: second };
                self.links.push(link.clone());
                link
            }
        };
        self.relabel_links();
        if allow {
            self.send(SidebarCall::GrantDelegations { chat: ask.source.key.clone(), link: created.id.clone() });
        }
        let text = text.trim();
        let toast = if text.is_empty() {
            "Link created".to_string()
        } else {
            let worktree = ask.target.end.as_ref().and_then(|end| end.worktree_path.clone()).unwrap_or_default();
            let target = AskTarget {
                label: &ask.target.label,
                chat_ref: &ask.target.key,
                worktree_path: &worktree,
                project_name: Some(&ask.target.project),
                branch: ask.target.branch.as_deref(),
            };
            let (body, prompt) = link_ask_message(text, &target);
            self.send(SidebarCall::AskChat { chat: ask.source.key.clone(), body, prompt });
            format!("Link created. Asked “{}”.", ask.source.label)
        };
        self.book.link_created(&toast, &created.id);
        self.after_book(cx);
        self.row_views.clear();
        cx.notify();
    }

    /// Removes a Link (`canvas:link-remove`); with `offer_undo`, the toast's Undo puts the same Link back.
    pub(super) fn remove_link(&mut self, id: &str, offer_undo: bool, cx: &mut Context<Self>) {
        let Some(at) = self.links.iter().position(|link| link.id == id) else { return };
        let link = self.links.remove(at);
        self.send(SidebarCall::RemoveLink { id: id.to_string() });
        self.relabel_links();
        if offer_undo {
            self.book.link_removed(&link);
            self.after_book(cx);
        }
        self.row_views.clear();
        cx.notify();
    }

    /// Puts a removed Link back, id and all (`canvas:link-restore`).
    pub(super) fn restore_link(&mut self, link: CanvasLink, cx: &mut Context<Self>) {
        if self.links.iter().any(|known| known.id == link.id) {
            return;
        }
        self.send(SidebarCall::RestoreLink { link: link.clone() });
        self.links.push(link);
        self.relabel_links();
        self.row_views.clear();
        cx.notify();
    }

    /// The popover or picker over the window, beside the sidebar.
    pub(super) fn link_overlays(&self) -> Option<gpui::AnyElement> {
        use gpui::{IntoElement, ParentElement, anchored, deferred, px};
        let (view, at): (gpui::AnyView, _) = match self.link_open.as_ref()? {
            OpenLinks::Ask { popover, at, .. } => (popover.clone().into(), *at),
            OpenLinks::Pick { picker, at, .. } => (picker.clone().into(), *at),
        };
        Some(deferred(anchored().position(at).snap_to_window_with_margin(px(8.0)).child(view)).with_priority(2).into_any_element())
    }

    /// The row's top in the window, for a popover opened from it (its menu, a drop on it).
    pub(super) fn row_top(&self, key: &str, cx: &gpui::App) -> Pixels {
        let ix = self.rows.iter().position(|row| row.key.as_ref() == key);
        ix.and_then(|ix| self.row_views.get(&ix))
            .map(|(view, _)| view.read(cx).bounds())
            .filter(|bounds: &Bounds<Pixels>| bounds.size.height > gpui::px(0.0))
            .map_or(gpui::px(8.0), |bounds| bounds.origin.y)
    }
}
