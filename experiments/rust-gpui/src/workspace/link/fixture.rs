//! A named Link on fixture data: its Projects, its shared Chats and each member Worktree's changes. The shapes follow
//! `OpenLink`, `LinkState` and `WorktreeBinding` (`packages/shared/src/model.d.mts`); the daemon's `link:open`,
//! `link:state` and the Link diff lists (`useLinkDiffLists`) replace this once the port talks to it.

use crate::logic::marks::chat_mark::ChatMark;

/// One Project of the Link (`OpenLink.projects`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkProject {
    pub id: &'static str,
    pub name: &'static str,
    pub path: &'static str,
}

/// A changed file in a member's Worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: &'static str,
    pub added: u32,
    pub removed: u32,
}

/// A shared Chat's Worktree in one Project (`WorktreeBinding`), with its two diff lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub project_id: &'static str,
    pub project_path: &'static str,
    pub worktree_path: &'static str,
    pub branch: &'static str,
    pub base: &'static str,
    pub uncommitted: Vec<ChangedFile>,
    pub committed: Vec<ChangedFile>,
}

impl Member {
    pub fn files(&self) -> impl Iterator<Item = &ChangedFile> {
        self.uncommitted.iter().chain(&self.committed)
    }

    /// `changedFileCount`: every file of both lists.
    pub fn file_count(&self) -> usize {
        self.uncommitted.len() + self.committed.len()
    }

    pub fn counts(&self) -> (u32, u32) {
        self.files().fold((0, 0), |(a, r), file| (a + file.added, r + file.removed))
    }
}

/// A Chat of the Link (`LinkState.sessions`): its Worktrees are created as it changes each Project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkChat {
    pub id: u64,
    pub title: &'static str,
    pub mark: ChatMark,
    pub members: Vec<Member>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub id: &'static str,
    pub name: &'static str,
    pub projects: Vec<LinkProject>,
    pub chats: Vec<LinkChat>,
}

impl Link {
    /// The Chat key a Link Chat has (`chatKeyForScope({ kind: "link" })`).
    pub fn chat_key(&self, id: u64) -> String {
        format!("milagre-link:{}#{id}", self.id)
    }

    pub fn project(&self, id: &str) -> Option<&LinkProject> {
        self.projects.iter().find(|project| project.id == id)
    }
}

fn file(path: &'static str, added: u32, removed: u32) -> ChangedFile {
    ChangedFile { path, added, removed }
}

pub fn link() -> Link {
    let web = Member {
        project_id: "web",
        project_path: "/Users/dev/Code/shop-web",
        worktree_path: "/Users/dev/.milagre/worktrees/shop-web/checkout-a1",
        branch: "milagre/shared-checkout",
        base: "main",
        uncommitted: vec![file("src/checkout/CartSummary.tsx", 42, 8), file("src/checkout/api.ts", 17, 3)],
        committed: vec![file("src/checkout/PaymentStep.tsx", 88, 31), file("src/lib/money.ts", 12, 0)],
    };
    let api = Member {
        project_id: "api",
        project_path: "/Users/dev/Code/payments-api",
        worktree_path: "/Users/dev/.milagre/worktrees/payments-api/checkout-b2",
        branch: "milagre/shared-checkout",
        base: "main",
        uncommitted: vec![file("internal/checkout/handler.go", 64, 12)],
        committed: vec![file("internal/checkout/totals.go", 23, 9), file("api/openapi.yaml", 31, 2)],
    };
    Link {
        id: "k7f2",
        name: "Checkout",
        projects: vec![
            LinkProject { id: "web", name: "shop-web", path: "/Users/dev/Code/shop-web" },
            LinkProject { id: "api", name: "payments-api", path: "/Users/dev/Code/payments-api" },
            LinkProject { id: "mobile", name: "mobile-app", path: "/Users/dev/Code/mobile-app" },
        ],
        chats: vec![
            LinkChat {
                id: 3,
                title: "Share the checkout totals between web and API",
                mark: ChatMark::Running,
                members: vec![web.clone(), api],
            },
            LinkChat { id: 2, title: "Rename the cart events", mark: ChatMark::Unread, members: vec![web] },
            LinkChat { id: 1, title: "Plan the checkout Link", mark: ChatMark::Idle, members: vec![] },
        ],
    }
}

/// `LINK_PENDING_WORKTREE_TEXT` (`packages/shared/src/worktree-link.mjs`).
pub const PENDING_WORKTREE_TEXT: &str = "No Worktree yet. The Chat creates one when it changes this Project.";
