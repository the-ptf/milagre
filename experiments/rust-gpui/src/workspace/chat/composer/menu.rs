//! The `@` and `/` menu (`PromptComposer.tsx`): which token the caret is in, the rows for it, and the panel above
//! the composer. `@` lists files, Chats and computers; `/` lists Milagre's commands and the skills, ranked by what is
//! typed. One highlight moves with the arrow keys or the pointer; Enter or Tab inserts the row, Escape closes it.
//!
//! Ported here because no shared module has them: `promptToken`, `insertPromptToken`, and `insertImageMentions`
//! (`apps/desktop/app/src/lib/file-mentions.ts`; `fileMentionPath` comes with attachments, WP-25), `skillMatchRank` and `rankSkillMatches`
//! (`packages/shared/src/skill-catalog.ts`). The menu filters through `logic::prompts`
//! (`matching_mention_chats`, `matching_mention_computers`).
//!
//! The panel is a positioned element of the composer, as the desktop's is (`absolute bottom-full`), drawn deferred
//! so it paints over the transcript. When `ui::popover`'s menu wrappers land, its surface and rows move onto them.

use std::ops::Range;

use gpui::{
    Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, deferred, div, prelude::FluentBuilder as _, px, relative,
};

use super::Composer;
use super::mentions::{MentionSource, SkillScope};
use crate::logic::copy::js;
use crate::logic::prompts::mentions::{matching_mention_chats, matching_mention_computers};
use crate::logic::prompts::parts::format_image_mention;
use crate::theme::{CONTROL_MD, RADIUS_CARD, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::SectionLabel;

/// The panel's gap above the composer (`mb-2`), its padding (`p-1.5`), the list's cap (`max-h-64`), the row's
/// inset (`px-2`) and the gap between a row's name and description (`gap-2`).
const MENU_GAP: f32 = 8.0;
const MENU_PAD: f32 = 6.0;
const MENU_MAX_HEIGHT: f32 = 256.0;
const ROW_PAD_X: f32 = 8.0;
const ROW_GAP: f32 = 8.0;
/// The share of a row a name may take before it truncates (`max-w-[45%]`).
const NAME_SHARE: f32 = 0.45;
/// With Chats or computers to show, the `@` menu keeps only the best three files.
const FILES_BESIDE_OTHERS: usize = 3;

/// Which menu a token opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    At,
    Slash,
}

/// The `@` or `/` word the caret ends (`PromptToken`): `start` is the trigger's byte offset, `end` the caret,
/// `query` what follows the trigger, lower-cased.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptToken {
    pub kind: MenuKind,
    pub query: String,
    pub start: usize,
    pub end: usize,
}

/// `promptToken`: `/(^|\s)([@/])([^\s@"]*)$/` on the draft up to the caret.
pub fn prompt_token(draft: &str, caret: usize) -> Option<PromptToken> {
    let head = draft.get(..caret)?;
    let start = head.char_indices().rev().find(|(_, c)| js::is_space(*c)).map_or(0, |(at, c)| at + c.len_utf8());
    let word = &head[start..];
    let kind = match word.chars().next()? {
        '@' => MenuKind::At,
        '/' => MenuKind::Slash,
        _ => return None,
    };
    let query = &word[1..];
    if query.contains(['@', '"']) {
        return None;
    }
    Some(PromptToken { kind, query: query.to_lowercase(), start, end: caret })
}

/// `insertPromptToken`: `mention` in place of the token, followed by a space unless one follows already. Returns
/// the draft and the caret after that space.
pub fn insert_prompt_token(draft: &str, token: &PromptToken, mention: &str) -> (String, usize) {
    let suffix = &draft[token.end..];
    let space = if suffix.starts_with(' ') { "" } else { " " };
    (format!("{}{mention}{space}{suffix}", &draft[..token.start]), token.start + mention.len() + 1)
}

/// `insertImageMentions`: `[Image #N]` tokens for `indices` in place of `range`, with a space before them when the
/// text before does not end in one and after them unless a space follows. Returns the draft and the caret after.
pub fn insert_image_mentions(draft: &str, indices: &[u64], range: Range<usize>) -> (String, usize) {
    if indices.is_empty() {
        return (draft.to_string(), range.end.min(draft.len()));
    }
    let clamp = |at: usize| (0..=at.min(draft.len())).rev().find(|at| draft.is_char_boundary(*at)).unwrap_or(0);
    let start = clamp(range.start);
    let end = clamp(range.end).max(start);
    let (before, after) = (&draft[..start], &draft[end..]);
    let lead = if !before.is_empty() && !before.ends_with(js::is_space) { " " } else { "" };
    let trail = if after.starts_with(' ') { "" } else { " " };
    let mentions = indices.iter().map(|index| format_image_mention(*index)).collect::<Vec<_>>().join(" ");
    let inserted = format!("{lead}{mentions}{trail}");
    (format!("{before}{inserted}{after}"), before.len() + inserted.len())
}

/// `skillMatchRank`: 0 when the name (or the part after a plugin prefix) starts with the query, 1 when the name
/// contains it, 2 when only the description does, `None` for no match.
pub fn skill_match_rank(name: &str, description: &str, query: &str) -> Option<u8> {
    let needle = js::trim(query).to_lowercase();
    if needle.is_empty() {
        return Some(0);
    }
    let full = name.strip_prefix('/').unwrap_or(name).to_lowercase();
    let short = full.rsplit(':').next().unwrap_or(&full);
    if full.starts_with(&needle) || short.starts_with(&needle) {
        Some(0)
    } else if full.contains(&needle) {
        Some(1)
    } else if format!("{full} {description}").to_lowercase().contains(&needle) {
        Some(2)
    } else {
        None
    }
}

/// `rankSkillMatches`: the matching items, name-prefix matches first, then name matches, then description matches;
/// ties keep their order.
pub fn rank_skill_matches<T>(items: Vec<T>, query: &str, read: impl Fn(&T) -> (&str, &str)) -> Vec<T> {
    let mut ranked: Vec<(u8, T)> = items
        .into_iter()
        .filter_map(|item| {
            let (name, description) = read(&item);
            skill_match_rank(name, description, query).map(|rank| (rank, item))
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);
    ranked.into_iter().map(|(_, item)| item).collect()
}

/// `/undo`, offered once the Chat is saved; it opens Undo changes instead of reaching the agent.
const UNDO_COMMAND: (&str, &str) = ("undo", "Undo a task's file changes");
/// Milagre's own commands (`COMMANDS`): `/storage` is `STORAGE_COMMAND` with its hint.
const COMMANDS: [(&str, &str); 5] = [
    ("storage", "Clean up old worktrees on this computer"),
    ("summarize", "Digest the thread so far"),
    ("blockers", "Find blockers across worktrees"),
    ("plan", "Draft the next steps"),
    ("review", "Review the current agent output"),
];

/// What choosing a row inserts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    File(String),
    Chat(u64),
    Computer(String),
    /// A command or skill, as `/name`.
    Command(String),
}

/// One row (`MenuRow`): a name, a description, the group heading it sits under and, for skills, where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuRow {
    pub name: SharedString,
    pub desc: SharedString,
    pub group: Option<&'static str>,
    pub source: Option<SharedString>,
    pub pick: Pick,
}

/// The commands and skills `/` offers, before ranking: Milagre's commands (unless a skill has the name), then the
/// skills by scope.
fn command_rows(source: &dyn MentionSource, can_undo: bool) -> Vec<MenuRow> {
    let skills = source.skills();
    let commands = can_undo.then_some(UNDO_COMMAND).into_iter().chain(COMMANDS);
    let commands = commands.filter(|(key, _)| !skills.iter().any(|skill| skill.name.to_lowercase() == *key)).map(|(key, desc)| MenuRow {
        name: format!("/{key}").into(),
        desc: desc.into(),
        group: Some(SkillScope::Bundled.group()),
        source: None,
        pick: Pick::Command(format!("/{key}")),
    });
    let skills = SkillScope::MENU_ORDER.into_iter().flat_map(|scope| {
        skills.iter().filter(move |skill| skill.scope == scope).map(move |skill| MenuRow {
            name: format!("/{}", skill.name).into(),
            desc: skill.description.clone().into(),
            group: Some(scope.group()),
            source: Some(skill.provider.clone().into()),
            pick: Pick::Command(format!("/{}", skill.name)),
        })
    });
    commands.chain(skills).collect()
}

/// Every name `/` knows, for telling a typed `/name` apart from a path (the `skills` of `promptParts`).
pub fn skill_names(source: &dyn MentionSource, can_undo: bool) -> Vec<String> {
    command_rows(source, can_undo).into_iter().map(|row| row.name[1..].to_string()).collect()
}

/// The rows a token's menu shows.
pub fn menu_rows(token: &PromptToken, source: &dyn MentionSource, can_undo: bool) -> Vec<MenuRow> {
    match token.kind {
        MenuKind::Slash => rank_skill_matches(command_rows(source, can_undo), &token.query, |row| (row.name.as_ref(), row.desc.as_ref())),
        MenuKind::At => {
            let chats = matching_mention_chats(source.chats(), &token.query, source.current_chat());
            // Only with another computer to name: this one alone is no choice.
            let computers = source.computers();
            let computers = if computers.len() > 1 { matching_mention_computers(computers, &token.query) } else { Vec::new() };
            let mut files = source.search_files(&token.query);
            if !chats.is_empty() || !computers.is_empty() {
                files.truncate(FILES_BESIDE_OTHERS);
            }
            let files = files.into_iter().map(|path| MenuRow {
                name: path.rsplit('/').find(|name| !name.is_empty()).unwrap_or(&path).to_string().into(),
                desc: path.clone().into(),
                group: Some("Files"),
                source: None,
                pick: Pick::File(path),
            });
            let chats = chats.into_iter().map(|chat| MenuRow {
                name: chat.title.into(),
                desc: chat.branch.into(),
                group: Some("Chats"),
                source: None,
                pick: Pick::Chat(chat.id),
            });
            let computers = computers.into_iter().map(|computer| MenuRow {
                desc: if computer.is_self {
                    "This Mac"
                } else if computer.online {
                    "Online"
                } else {
                    "Offline"
                }
                .into(),
                name: computer.name.clone().into(),
                group: Some("Computers"),
                source: None,
                pick: Pick::Computer(computer.name),
            });
            files.chain(chats).chain(computers).collect()
        }
    }
}

/// The line under the rows.
pub fn menu_footer(kind: MenuKind, source: &dyn MentionSource) -> &'static str {
    match kind {
        MenuKind::At if source.computers().len() > 1 => "Type to search files, Chats and computers",
        MenuKind::At => "Type to search files and Chats",
        MenuKind::Slash => "Type to search commands & skills",
    }
}

/// What the open menu shows this frame.
pub struct OpenMenu {
    pub token: PromptToken,
    pub rows: Vec<MenuRow>,
    pub footer: &'static str,
}

/// The highlight and its scroll position, kept on the composer across frames.
#[derive(Default)]
pub struct MenuState {
    /// Escape or a pick closed the menu for this token; typing opens it again.
    pub dismissed: bool,
    /// The highlighted row.
    pub active: usize,
    /// Whether the highlight shows: after an arrow key or while the pointer is over the rows.
    pub engaged: bool,
    /// The token the highlight belongs to; a new one starts at the first row.
    pub key: Option<(MenuKind, String)>,
    pub scroll: ScrollHandle,
}

impl MenuState {
    /// Keeps `active` on the token it was set for: a new menu or query starts at the first row, unengaged.
    pub fn follow(&mut self, token: &PromptToken) {
        let key = Some((token.kind, token.query.clone()));
        if self.key != key {
            self.key = key;
            self.active = 0;
            self.engaged = false;
        }
    }
}

/// Whether the rows carry group headings: a `/` search lists its matches best first across groups, so it has none.
fn shows_groups(menu: &OpenMenu) -> bool {
    menu.token.kind == MenuKind::At || menu.token.query.is_empty()
}

/// Row `ix`'s index among the list's children (headings included), for scrolling it into view.
pub fn child_index(menu: &OpenMenu, ix: usize) -> usize {
    let show_groups = shows_groups(menu);
    let mut child = 0;
    let mut previous = None;
    for (i, row) in menu.rows.iter().enumerate() {
        if show_groups && row.group.is_some() && row.group != previous {
            child += 1;
        }
        previous = row.group;
        if i == ix {
            break;
        }
        child += 1;
    }
    child
}

impl Composer {
    /// The panel above the composer: rows with their group headings, the empty line, the footer.
    pub(super) fn render_menu(&self, menu: &OpenMenu, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let show_groups = shows_groups(menu);
        let mut children: Vec<gpui::AnyElement> = Vec::new();
        let mut previous: Option<&'static str> = None;
        for (ix, row) in menu.rows.iter().enumerate() {
            if show_groups && row.group.is_some() && row.group != previous {
                let heading = row.group.unwrap_or_default();
                children.push(div().px(px(ROW_PAD_X)).pt(px(8.0)).pb(px(4.0)).child(SectionLabel::new(heading).menu()).into_any_element());
            }
            previous = row.group;
            children.push(self.render_menu_row(ix, row, theme, cx).into_any_element());
        }
        if menu.rows.is_empty() {
            children.push(
                div()
                    .flex()
                    .items_center()
                    .h(CONTROL_MD)
                    .px(px(ROW_PAD_X))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child(format!("No matches for \"{}\"", menu.token.query))
                    .into_any_element(),
            );
        }
        let panel = div()
            .id("composer-menu")
            .debug_selector(|| "composer-menu".into())
            .w_full()
            .p(px(MENU_PAD))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !hovered && this.menu.engaged {
                    this.menu.engaged = false;
                    cx.notify();
                }
            }))
            .child(
                div()
                    .id("composer-menu-rows")
                    .max_h(px(MENU_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .track_scroll(&self.menu.scroll)
                    .children(children),
            )
            .child(
                div()
                    .mt_1()
                    .px(px(ROW_PAD_X))
                    .pt(px(6.0))
                    .pb_1()
                    .border_t_1()
                    .border_color(theme.line)
                    .text_step(TEXT_11)
                    .text_color(theme.ink3)
                    .child(menu.footer),
            );
        // Above the composer, as wide as it; deferred so it paints over the transcript and takes its clicks.
        deferred(div().absolute().left_0().right_0().bottom(relative(1.0)).pb(px(MENU_GAP)).child(panel)).with_priority(1)
    }

    fn render_menu_row(&self, ix: usize, row: &MenuRow, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let highlighted = self.menu.engaged && self.menu.active == ix;
        let selector = format!("composer-menu-row-{ix}");
        div()
            .id(("composer-menu-row", ix))
            .debug_selector(move || selector.clone())
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .h(CONTROL_MD)
            .w_full()
            .px(px(ROW_PAD_X))
            .rounded(RADIUS_INLINE)
            .cursor_pointer()
            .when(highlighted, |row| row.bg(theme.hover2))
            // The prompt keeps focus: a press on a row never takes it.
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_mouse_move(cx.listener(move |this, _, _, cx| {
                if this.menu.active != ix || !this.menu.engaged {
                    this.menu.active = ix;
                    this.menu.engaged = true;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| this.pick_row(ix, window, cx)))
            .child(
                div()
                    .flex_none()
                    .max_w(relative(NAME_SHARE))
                    .truncate()
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .child(row.name.clone()),
            )
            .child(div().flex_1().min_w_0().truncate().text_step(TEXT_12).text_color(theme.ink3).child(row.desc.clone()))
            .when_some(row.source.clone(), |el, source| el.child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(source)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::chat::composer::mentions::FixtureMentions;

    fn token(kind: MenuKind, query: &str, start: usize, end: usize) -> Option<PromptToken> {
        Some(PromptToken { kind, query: query.into(), start, end })
    }

    #[test]
    fn the_caret_opens_a_menu_only_at_the_start_of_a_word() {
        assert_eq!(prompt_token("@", 1), token(MenuKind::At, "", 0, 1));
        assert_eq!(prompt_token("look at @Src/A", 14), token(MenuKind::At, "src/a", 8, 14));
        assert_eq!(prompt_token("run /tl", 7), token(MenuKind::Slash, "tl", 4, 7));
        assert_eq!(prompt_token("a\n/x", 4), token(MenuKind::Slash, "x", 2, 4));
        assert_eq!(prompt_token("/foo/bar", 8), token(MenuKind::Slash, "foo/bar", 0, 8), "a slash inside the word keeps the token");
        assert_eq!(prompt_token("me@host", 7), None, "an @ inside a word is not a mention");
        assert_eq!(prompt_token("@a@b", 4), None);
        assert_eq!(prompt_token("@\"my", 4), None);
        assert_eq!(prompt_token("@done ", 6), None, "a space ends the token");
        assert_eq!(prompt_token("é @x", "é @x".len()), token(MenuKind::At, "x", 3, 5));
        assert_eq!(prompt_token("@abc", 2), token(MenuKind::At, "a", 0, 2), "only what is before the caret counts");
    }

    #[test]
    fn a_picked_mention_replaces_its_token_and_gets_one_space_after_it() {
        let at = prompt_token("see @sr please", 7).unwrap();
        assert_eq!(insert_prompt_token("see @sr please", &at, "@src/app.rs"), ("see @src/app.rs please".into(), 16));
        let end = prompt_token("run /tl", 7).unwrap();
        assert_eq!(insert_prompt_token("run /tl", &end, "/tldr"), ("run /tldr ".into(), 10));
    }

    #[test]
    fn image_mentions_go_in_with_the_spaces_they_need() {
        assert_eq!(insert_image_mentions("", &[1], 0..0), ("[Image #1] ".into(), 11));
        assert_eq!(insert_image_mentions("look", &[1, 2], 4..4), ("look [Image #1] [Image #2] ".into(), 27));
        assert_eq!(insert_image_mentions("a  b", &[3], 2..2), ("a [Image #3] b".into(), 12));
        assert_eq!(insert_image_mentions("swap this", &[1], 5..9), ("swap [Image #1] ".into(), 16));
        assert_eq!(insert_image_mentions("x", &[], 0..1), ("x".into(), 1));
    }

    /// `skill-catalog.test.ts`'s ranking cases.
    #[test]
    fn skills_rank_by_name_prefix_then_name_then_description() {
        assert_eq!(skill_match_rank("/tldr", "Summaries", "tl"), Some(0));
        assert_eq!(skill_match_rank("plugin:review-code", "", "rev"), Some(0));
        assert_eq!(skill_match_rank("/code-review", "", "rev"), Some(1));
        assert_eq!(skill_match_rank("/plan", "Draft the next steps", "draft"), Some(2));
        assert_eq!(skill_match_rank("/plan", "Draft", "zzz"), None);
        assert_eq!(skill_match_rank("/plan", "Draft", "  "), Some(0));
        let ranked = rank_skill_matches(vec![("/aplan", ""), ("/plan", ""), ("/x", "a plan"), ("/planner", "")], "plan", |(n, d)| (*n, *d));
        assert_eq!(ranked, vec![("/plan", ""), ("/planner", ""), ("/aplan", ""), ("/x", "a plan")]);
    }

    #[test]
    fn the_at_menu_lists_files_chats_and_computers_in_that_order() {
        let source = FixtureMentions::default();
        let rows = menu_rows(&prompt_token("@", 1).unwrap(), &source, false);
        let groups: Vec<_> = rows.iter().map(|row| row.group.unwrap()).collect();
        assert_eq!(groups.iter().filter(|g| **g == "Files").count(), FILES_BESIDE_OTHERS, "three files beside Chats");
        assert_eq!(groups.iter().filter(|g| **g == "Chats").count(), 5, "at most five Chats, the open one left out");
        assert!(!rows.iter().any(|row| row.pick == Pick::Chat(1)));
        let computers: Vec<_> =
            rows.iter().filter(|row| row.group == Some("Computers")).map(|row| (row.name.to_string(), row.desc.to_string())).collect();
        assert_eq!(
            computers,
            [("Santo".into(), "This Mac".into()), ("Studio".into(), "Online".into()), ("Victor's MacBook".into(), "Offline".into())]
        );
        let rows = menu_rows(&prompt_token("@editor", 7).unwrap(), &source, false);
        assert_eq!(rows.iter().map(|row| row.name.to_string()).collect::<Vec<_>>(), ["editor-model.ts", "PromptEditor.tsx"]);
        assert_eq!(menu_footer(MenuKind::At, &source), "Type to search files, Chats and computers");
    }

    #[test]
    fn the_slash_menu_lists_commands_then_skills_by_scope_and_ranks_a_query() {
        let source = FixtureMentions::default();
        let names = |rows: Vec<MenuRow>| rows.into_iter().map(|row| row.name.to_string()).collect::<Vec<_>>();
        assert_eq!(
            names(menu_rows(&prompt_token("/", 1).unwrap(), &source, true)),
            ["/undo", "/storage", "/summarize", "/blockers", "/plan", "/review", "/tldr", "/frontend-design", "/review-pr"]
        );
        let re = names(menu_rows(&prompt_token("/re", 3).unwrap(), &source, false));
        assert_eq!(&re[..2], ["/review", "/review-pr"], "name prefixes first");
        assert!(re.contains(&"/tldr".to_string()), "then descriptions (\"thread\")");
        assert_eq!(names(menu_rows(&prompt_token("/design", 7).unwrap(), &source, false)), ["/frontend-design"]);
        assert!(skill_names(&source, false).contains(&"tldr".to_string()));
        assert!(!skill_names(&source, false).contains(&"undo".to_string()), "/undo only once the Chat is saved");
    }
}
