//! What `@` and `/` can name: the Project's files, its Chats, the computers and the skills. [`MentionSource`] is the
//! seam the real data plugs into (`project:files`, `chatMentionChoices` over the state, `computers:list`,
//! `skills:list`); [`FixtureMentions`] is the fixture the port runs on until then.

use crate::logic::prompts::mentions::{MentionChat, MentionComputer};

/// Where a skill comes from (`SkillOption.scope`). The `/` menu lists Milagre's own, then the Project's, then the
/// user's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillScope {
    Bundled,
    Workspace,
    User,
}

impl SkillScope {
    /// The `/` menu's order of scopes (`["bundled", "workspace", "user"]` in `PromptComposer.tsx`).
    pub const MENU_ORDER: [SkillScope; 3] = [SkillScope::Bundled, SkillScope::Workspace, SkillScope::User];

    /// The group heading its skills sit under in the `/` menu.
    pub fn group(self) -> &'static str {
        match self {
            SkillScope::Bundled => "Milagre skills",
            SkillScope::Workspace => "Workspace skills",
            SkillScope::User => "User skills",
        }
    }
}

/// A skill `/` offers (`SkillOption` in `packages/shared/src/model.ts`, the fields the menu reads).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillOption {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    /// The CLI folder it was found in ("claude", "codex", "agents"), shown at the row's end.
    pub provider: String,
}

/// The data the composer's chips and menus read. Implemented by the fixture now; by the daemon's data later.
pub trait MentionSource {
    /// Project files (relative paths) matching what is typed after `@`, best first (`useProjectFiles`).
    fn search_files(&self, query: &str) -> Vec<String>;
    /// Whether `@path` names a file that exists: only those show as chips (`useKnownFiles`).
    fn is_file(&self, path: &str) -> bool;
    /// The Chats `@` can name, including unavailable ones so old chips keep a label (`chatMentionChoices`).
    fn chats(&self) -> &[MentionChat];
    /// The Chat the composer belongs to; the menu leaves it out.
    fn current_chat(&self) -> Option<u64>;
    /// This computer and the paired ones (`useMentionComputers`).
    fn computers(&self) -> &[MentionComputer];
    /// The skills `/` offers, in the host's order (`useSkills`).
    fn skills(&self) -> &[SkillOption];
}

/// The fixture: a few files of every chip look (badge letters, the React mark, an image, a plain file), Chats,
/// three computers (one offline) and a skill per scope.
pub struct FixtureMentions {
    files: Vec<String>,
    chats: Vec<MentionChat>,
    computers: Vec<MentionComputer>,
    skills: Vec<SkillOption>,
}

/// The fixture's open Chat ("Fix Linux onboarding intro hang", `ChatView`).
pub const FIXTURE_CURRENT_CHAT: u64 = 1;

impl Default for FixtureMentions {
    fn default() -> Self {
        let files = [
            "src/app.rs",
            "src/workspace/chat/composer/mod.rs",
            "src/workspace/chat/transcript.rs",
            "apps/desktop/app/src/components/PromptComposer.tsx",
            "apps/desktop/app/src/components/PromptEditor.tsx",
            "apps/desktop/app/src/lib/editor-model.ts",
            "packages/shared/src/prompt-parts.mjs",
            "packages/shared/src/prompt-mentions.mjs",
            "assets/hugeicons/magic-wand-01.svg",
            "docs/agents/ui.md",
            "DESIGN.md",
            "README.md",
            "Cargo.toml",
            "scripts/release.sh",
        ];
        let chat = |id: u64, title: &str, branch: &str, at: i64| MentionChat {
            id,
            title: title.into(),
            branch: branch.into(),
            at,
            last_at: Some(at),
            available: true,
        };
        let chats = vec![
            chat(FIXTURE_CURRENT_CHAT, "Fix Linux onboarding intro hang", "milagre/linux-intro", 90),
            chat(12, "Port the composer to GPUI", "milagre/chat-tie0", 80),
            chat(7, "Sidebar filters", "milagre/sidebar-filters", 70),
            chat(9, "Relay duration limit", "milagre/relay-backoff", 60),
            chat(15, "Design council round 8", "milagre/design-council", 50),
            chat(18, "Workspace switcher", "milagre/workspace-switcher", 40),
            MentionChat { available: false, ..chat(21, "Archived spike", "milagre/old-spike", 99) },
        ];
        let computer = |name: &str, is_self: bool, online: bool| MentionComputer { name: name.into(), is_self, online };
        let computers = vec![computer("Santo", true, true), computer("Studio", false, true), computer("Victor's MacBook", false, false)];
        let skill = |name: &str, description: &str, scope: SkillScope, provider: &str| SkillOption {
            name: name.into(),
            description: description.into(),
            scope,
            provider: provider.into(),
        };
        let skills = vec![
            skill("tldr", "Shorten a long thread to what matters", SkillScope::Bundled, "milagre"),
            skill("frontend-design", "Distinctive, production-grade interfaces", SkillScope::Workspace, "claude"),
            skill("review-pr", "Review a pull request for correctness", SkillScope::User, "codex"),
        ];
        Self { files: files.iter().map(|file| file.to_string()).collect(), chats, computers, skills }
    }
}

impl MentionSource for FixtureMentions {
    /// Case-insensitive: names that start with the query first, then names that contain it, then paths; the
    /// host's own ranking is not ported.
    fn search_files(&self, query: &str) -> Vec<String> {
        let needle = query.to_lowercase();
        let mut ranked: Vec<(usize, &String)> = self
            .files
            .iter()
            .filter_map(|path| {
                let lower = path.to_lowercase();
                let name = lower.rsplit('/').next().unwrap_or(&lower);
                let rank = if name.starts_with(&needle) {
                    0
                } else if name.contains(&needle) {
                    1
                } else if lower.contains(&needle) {
                    2
                } else {
                    return None;
                };
                Some((rank, path))
            })
            .collect();
        ranked.sort_by_key(|(rank, _)| *rank);
        ranked.into_iter().map(|(_, path)| path.clone()).collect()
    }

    fn is_file(&self, path: &str) -> bool {
        self.files.iter().any(|file| file == path)
    }

    fn chats(&self) -> &[MentionChat] {
        &self.chats
    }

    fn current_chat(&self) -> Option<u64> {
        Some(FIXTURE_CURRENT_CHAT)
    }

    fn computers(&self) -> &[MentionComputer] {
        &self.computers
    }

    fn skills(&self) -> &[SkillOption] {
        &self.skills
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixture_search_puts_name_matches_before_path_matches() {
        let fixture = FixtureMentions::default();
        let found = fixture.search_files("prompt");
        assert_eq!(&found[..2], ["apps/desktop/app/src/components/PromptComposer.tsx", "apps/desktop/app/src/components/PromptEditor.tsx"]);
        assert!(found.contains(&"packages/shared/src/prompt-parts.mjs".to_string()));
        assert_eq!(fixture.search_files("chat/").first().map(String::as_str), Some("src/workspace/chat/composer/mod.rs"));
        assert!(fixture.search_files("nothing-like-this").is_empty());
        assert!(fixture.is_file("src/app.rs") && !fixture.is_file("src/app"));
    }
}
