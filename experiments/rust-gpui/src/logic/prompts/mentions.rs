//! After `packages/shared/src/prompt-mentions.mjs`: which attached files and images a prompt names, renumbering
//! `[Image #N]` tokens when attachments change, native edits across image chips, and the `@` menu's matching.
//!
//! Offsets are byte offsets (see the module docs). Not ported: `chatMentionChoices`, which builds the Chat choices
//! from the full state with `chatTitle` and `isListedChat` (`chats.mjs`); [`matching_mention_chats`] takes those
//! choices as input.

use super::parts::{Images, PromptPart, PromptPartsOptions, format_image_mention, image_token_matches, prompt_parts};
use super::skills::Selection;
use super::text::{MAX_SAFE_INTEGER, prose_prompt};

/// An empty composer's hint, on desktop and phone: what @ and / open.
pub const PROMPT_PLACEHOLDER: &str = "Type @ for files, Chats and computers, / for skills";

/// `mentionedFile`: the attached file an `@path` mention names: the file at that absolute path, else the file at
/// `<root>/<path>`, else the one attached file whose path ends with `/<path>`. A suffix shared by several files
/// names none.
pub fn mentioned_file<'a>(path: &str, files: &'a [String], root: &str) -> Option<&'a String> {
    if path.is_empty() {
        return None;
    }
    let rooted = format!("{}/{path}", root.strip_suffix('/').unwrap_or(root));
    let exact = files.iter().find(|file| *file == path).or_else(|| files.iter().find(|file| **file == rooted));
    if exact.is_some() {
        return exact;
    }
    let suffix = format!("/{}", path.strip_prefix('/').unwrap_or(path));
    let mut suffixed = files.iter().filter(|file| file.ends_with(&suffix));
    match (suffixed.next(), suffixed.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

/// `isMentionOfFile`: whether `@path` in a sent prompt names one of the message's files, for [`prompt_parts`].
pub fn is_mention_of_file<'a>(files: &'a [String], root: &'a str) -> impl Fn(&str) -> bool + 'a {
    move |path| mentioned_file(path, files, root).is_some()
}

/// `mentionedFiles`: the absolute files a prompt renders inline as chips; their attachment tiles are left out.
/// In order of first mention.
pub fn mentioned_files(prompt: &str, files: &[String], root: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    if files.is_empty() {
        return found;
    }
    let is_file = is_mention_of_file(files, root);
    for part in prompt_parts(prompt, &PromptPartsOptions::new(&[], &is_file)) {
        if let PromptPart::File { path, .. } = part
            && let Some(file) = mentioned_file(&path, files, root)
            && !found.contains(file)
        {
            found.push(file.clone());
        }
    }
    found
}

/// `mentionedImages`: the 1-based image indices a prompt renders inline as chips, in order of first mention.
pub fn mentioned_images(prompt: &str, count: usize) -> Vec<u64> {
    let mut found: Vec<u64> = Vec::new();
    if count < 1 {
        return found;
    }
    let none = |_: &str| false;
    let options = PromptPartsOptions { images: Images::Count(count), ..PromptPartsOptions::new(&[], &none) };
    for part in prompt_parts(prompt, &options) {
        if let PromptPart::Image { index, .. } = part
            && !found.contains(&index)
        {
            found.push(index);
        }
    }
    found
}

/// `shiftImageMentions`: remove `[Image #<removed>]` (1-based) and decrement `[Image #N]` tokens with
/// `N > removed` in prose. Collapses the duplicate space left behind when an inline image token is stripped.
pub fn shift_image_mentions(prompt: &str, removed: u64) -> String {
    if prompt.is_empty() || !(1..=MAX_SAFE_INTEGER).contains(&removed) {
        return prompt.to_string();
    }
    let prose = prose_prompt(prompt);
    let matches = image_token_matches(&prose);
    if matches.is_empty() {
        return prompt.to_string();
    }
    let bytes = prompt.as_bytes();
    let mut result = String::new();
    let mut end = 0;
    for (start, token_end, index) in matches {
        if index == removed {
            let (mut slice_start, mut slice_end) = (start, token_end);
            if slice_start > end
                && bytes[slice_start - 1] == b' '
                && (slice_end >= bytes.len() || bytes[slice_end] == b' ' || bytes[slice_end] == b'\n')
            {
                slice_start -= 1;
            } else if slice_end < bytes.len() && bytes[slice_end] == b' ' && (slice_start == end || bytes[slice_start - 1] == b'\n') {
                slice_end += 1;
            }
            result.push_str(&prompt[end..slice_start]);
            end = slice_end;
            continue;
        }
        result.push_str(&prompt[end..start]);
        if index > removed {
            result.push_str(&format_image_mention(index - 1));
        } else {
            result.push_str(&prompt[start..token_end]);
        }
        end = token_end;
    }
    result.push_str(&prompt[end..]);
    result
}

/// `remapImageMentions`: remap prose references when attachment lists are merged: `[Image #N]` becomes
/// `[Image #indices[N-1]]`. Code and unknown (or zero) references stay literal.
pub fn remap_image_mentions(prompt: &str, indices: &[u64]) -> String {
    let prose = prose_prompt(prompt);
    let mut result = String::new();
    let mut at = 0;
    for (start, end, index) in image_token_matches(prompt) {
        result.push_str(&prompt[at..start]);
        let in_prose = prose[start..end] == prompt[start..end];
        let mapped = usize::try_from(index).ok().and_then(|i| indices.get(i.wrapping_sub(1))).copied().filter(|mapped| *mapped != 0);
        match mapped {
            Some(mapped) if in_prose => result.push_str(&format_image_mention(mapped)),
            _ => result.push_str(&prompt[start..end]),
        }
        at = end;
    }
    result.push_str(&prompt[at..]);
    result
}

/// What [`edit_image_mentions`] returns: the new value and where the caret goes (`None`: leave it to the field).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageEdit {
    pub value: String,
    pub caret: Option<usize>,
}

/// Whether `previous` with `[from, to)` replaced by something could be `next`: the bytes before and after match.
fn matches_edit(previous: &str, next: &str, from: i64, to: i64) -> bool {
    if from < 0 || to < from || to as usize > previous.len() {
        return false;
    }
    let (from, to) = (from as usize, to as usize);
    next.len() >= from + previous.len() - to
        && next.as_bytes().starts_with(&previous.as_bytes()[..from])
        && next.as_bytes().ends_with(&previous.as_bytes()[to..])
}

/// `editImageMentions`: expand a native text edit across any image chip it touches, preserving surrounding text.
/// `selection` is the field's selection before the edit, when known (bytes); it tells apart which of several
/// identical tokens was edited.
pub fn edit_image_mentions(previous: &str, next: &str, images: &Images<'_>, selection: Option<Selection>) -> ImageEdit {
    // The changed span: common prefix and suffix, on char boundaries.
    let mut start = previous.chars().zip(next.chars()).take_while(|(a, b)| a == b).map(|(a, _)| a.len_utf8()).sum::<usize>();
    let mut end = previous.len();
    let mut next_end = next.len();
    for (a, b) in previous[start..].chars().rev().zip(next[start..].chars().rev()) {
        if a != b {
            break;
        }
        end -= a.len_utf8();
        next_end -= b.len_utf8();
    }
    if let Some(selection) = selection {
        let (mut from, mut to) = (selection.start as i64, selection.end as i64);
        let delta = next.len() as i64 - previous.len() as i64;
        if from == to && delta < 0 {
            if matches_edit(previous, next, from + delta, to) {
                from += delta;
            } else {
                to -= delta;
            }
        }
        if matches_edit(previous, next, from, to) {
            start = from as usize;
            end = to as usize;
            next_end = next.len() - (previous.len() - end);
        }
    }
    let Some(inserted) = next.get(start..next_end) else { return ImageEdit { value: next.to_string(), caret: None } };
    let (mut from, mut to) = (start, end);
    let mut offset = 0;
    let none = |_: &str| false;
    let options = PromptPartsOptions { images: *images, ..PromptPartsOptions::new(&[], &none) };
    for part in prompt_parts(previous, &options) {
        let part_end = offset + part.text().len();
        if matches!(part, PromptPart::Image { .. }) {
            if start == end && start > offset && start < part_end {
                from = part_end;
                to = part_end;
            } else if start < part_end && end > offset {
                from = from.min(offset);
                to = to.max(part_end);
            }
        }
        offset = part_end;
    }
    if from == start && to == end {
        return ImageEdit { value: next.to_string(), caret: None };
    }
    match (previous.get(..from), previous.get(to..)) {
        (Some(head), Some(tail)) => ImageEdit { value: format!("{head}{inserted}{tail}"), caret: Some(from + inserted.len()) },
        _ => ImageEdit { value: next.to_string(), caret: None },
    }
}

/// A Chat the `@` menu can offer (`chatMentionChoices`'s items).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionChat {
    pub id: u64,
    pub title: String,
    pub branch: String,
    pub at: i64,
    pub last_at: Option<i64>,
    pub available: bool,
}

/// `matchingMentionChats`: files precede this separately labelled group; newest matching Chats come first, at most
/// five. The query matches the title case-insensitively; the current Chat is left out.
pub fn matching_mention_chats(chats: &[MentionChat], query: &str, current_id: Option<u64>) -> Vec<MentionChat> {
    let needle = query.to_lowercase();
    let mut matching: Vec<MentionChat> = chats
        .iter()
        .filter(|chat| chat.available && Some(chat.id) != current_id && chat.title.to_lowercase().contains(&needle))
        .cloned()
        .collect();
    matching.sort_by(|a, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));
    matching.truncate(5);
    matching
}

/// A computer the `@` menu can offer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionComputer {
    pub name: String,
    pub is_self: bool,
    pub online: bool,
}

/// `matchingMentionComputers`: this computer first, then the paired ones, online before offline, by name; at most
/// five. A query matches a name case-insensitively; one name shows once. Names sort by a case-insensitive compare
/// first (an approximation of `localeCompare`, exact for ASCII names that differ in letters).
pub fn matching_mention_computers(computers: &[MentionComputer], query: &str) -> Vec<MentionComputer> {
    let needle = query.to_lowercase();
    let mut seen: Vec<String> = Vec::new();
    let mut matching: Vec<MentionComputer> = computers
        .iter()
        .filter(|computer| {
            let key = computer.name.to_lowercase();
            if computer.name.is_empty() || seen.contains(&key) || !key.contains(&needle) {
                return false;
            }
            seen.push(key);
            true
        })
        .cloned()
        .collect();
    matching.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then(b.online.cmp(&a.online))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| b.name.cmp(&a.name)))
    });
    matching.truncate(5);
    matching
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(n: usize) -> Images<'static> {
        Images::Count(n)
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn mentioned_images_and_shift_image_mentions_track_and_renumber_inline_image_tokens() {
        let prompt = "[Image #1] before [Image #2] and `[Image #2]` then [Image #3]";
        assert_eq!(mentioned_images(prompt, 3), vec![1, 2, 3]);
        assert_eq!(shift_image_mentions(prompt, 2), "[Image #1] before and `[Image #2]` then [Image #2]");
        assert_eq!(mentioned_images(prompt, 0), Vec::<u64>::new());
    }

    #[test]
    fn shifting_collapses_the_space_around_the_removed_token() {
        assert_eq!(shift_image_mentions("[Image #1] look", 1), "look");
        assert_eq!(shift_image_mentions("look [Image #1]", 1), "look");
        assert_eq!(shift_image_mentions("a\n[Image #1] b", 1), "a\nb");
        assert_eq!(shift_image_mentions("a [Image #1] b", 1), "a b");
        assert_eq!(shift_image_mentions("no tokens", 1), "no tokens");
        assert_eq!(shift_image_mentions("[Image #1]", 0), "[Image #1]");
        assert_eq!(shift_image_mentions("", 1), "");
    }

    #[test]
    fn merging_drafts_remaps_image_references_without_changing_code_or_unknown_indices() {
        assert_eq!(
            remap_image_mentions("[Image #1] and [Image #2], `[Image #1]`, [Image #3]", &[2, 1]),
            "[Image #2] and [Image #1], `[Image #1]`, [Image #3]"
        );
        assert_eq!(remap_image_mentions("[Image #1]", &[0]), "[Image #1]");
    }

    #[test]
    fn native_edits_remove_whole_image_chips_and_preserve_the_surrounding_draft() {
        let draft = "see [Image #1] next";
        let edit = |value: &str, caret: Option<usize>| ImageEdit { value: value.into(), caret };
        assert_eq!(edit_image_mentions(draft, "see [Image #1 next", &count(1), None), edit("see  next", Some(4)));
        assert_eq!(edit_image_mentions(draft, "see Image #1] next", &count(1), None), edit("see  next", Some(4)));
        assert_eq!(edit_image_mentions(draft, "see [Inew1] next", &count(1), None), edit("see new next", Some(7)));
        assert_eq!(edit_image_mentions(draft, "see [Image X#1] next", &count(1), None), edit("see [Image #1]X next", Some(15)));
        assert_eq!(edit_image_mentions(draft, "see [Image #1] next!", &count(1), None), edit("see [Image #1] next!", None));
        assert_eq!(edit_image_mentions("`[Image #1]`", "`[Image #1`", &count(1), None), edit("`[Image #1`", None));
        assert_eq!(
            edit_image_mentions("[Image #1] [Image #2]", "[Image #2]", &count(2), Some(Selection { start: 0, end: 11 })),
            edit("[Image #2]", None)
        );
    }

    #[test]
    fn a_collapsed_selection_picks_which_identical_token_was_edited() {
        let previous = "[Image #1] [Image #1]";
        // Backspace with the caret after the second token's first char removes that char.
        let next = "[Image #1] Image #1]";
        let edit = edit_image_mentions(previous, next, &count(1), Some(Selection { start: 11, end: 11 }));
        assert_eq!(edit, ImageEdit { value: "[Image #1] ".into(), caret: Some(11) });
    }

    #[test]
    fn mentioned_files_resolve_absolute_rooted_and_unique_suffix_paths() {
        let list = files(&["/repo/src/a.ts", "/repo/docs/b.md", "/repo/x/c.ts", "/repo/y/c.ts"]);
        assert_eq!(mentioned_file("/repo/src/a.ts", &list, "/repo").map(String::as_str), Some("/repo/src/a.ts"));
        assert_eq!(mentioned_file("docs/b.md", &list, "/repo/").map(String::as_str), Some("/repo/docs/b.md"));
        assert_eq!(mentioned_file("b.md", &list, "/other").map(String::as_str), Some("/repo/docs/b.md"));
        assert_eq!(mentioned_file("/b.md", &list, "/other").map(String::as_str), Some("/repo/docs/b.md"));
        assert_eq!(mentioned_file("c.ts", &list, "/repo"), None);
        assert_eq!(mentioned_file("", &list, "/repo"), None);
        let prompt = "read @src/a.ts and @docs/b.md and @src/a.ts again, not @c.ts";
        assert_eq!(mentioned_files(prompt, &list, "/repo"), vec!["/repo/src/a.ts", "/repo/docs/b.md"]);
        assert_eq!(mentioned_files(prompt, &[], "/repo"), Vec::<String>::new());
    }

    #[test]
    fn the_chat_menu_lists_newest_matching_chats_first() {
        let chat = |id: u64, title: &str, at: i64, available: bool| MentionChat {
            id,
            title: title.into(),
            branch: String::new(),
            at,
            last_at: None,
            available,
        };
        let chats = [
            chat(1, "Fix login", 10, true),
            chat(2, "fix signup", 30, true),
            chat(3, "Fix cache", 30, true),
            chat(4, "Fix hidden", 99, false),
            chat(5, "Current fix", 50, true),
            chat(6, "Other", 60, true),
        ];
        let ids = |found: Vec<MentionChat>| found.iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(ids(matching_mention_chats(&chats, "FIX", Some(5))), vec![3, 2, 1]);
        assert_eq!(ids(matching_mention_chats(&chats, "", None)).len(), 5);
    }

    #[test]
    fn the_computer_menu_puts_this_computer_first_then_online_then_by_name() {
        let computer = |name: &str, is_self: bool, online: bool| MentionComputer { name: name.into(), is_self, online };
        let list = [
            computer("Zed", false, true),
            computer("alpha", false, false),
            computer("Home", true, true),
            computer("beta", false, true),
            computer("BETA", false, true),
            computer("", false, true),
        ];
        let names: Vec<String> = matching_mention_computers(&list, "").into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["Home", "beta", "Zed", "alpha"]);
        let names: Vec<String> = matching_mention_computers(&list, "ET").into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["beta"]);
    }

    #[test]
    fn the_placeholder_matches_the_typescript_source() {
        assert_eq!(PROMPT_PLACEHOLDER, "Type @ for files, Chats and computers, / for skills");
        let Some(ts) = crate::logic::copy::source::shared("prompt-mentions.mjs") else { return };
        assert!(ts.contains(&format!("\"{PROMPT_PLACEHOLDER}\"")));
    }
}
