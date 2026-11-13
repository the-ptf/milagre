//! After `packages/shared/src/prompt-skills.mjs`: slash skills in a prompt.

use super::text::{prose_prompt, scan_prefixed};
use crate::logic::copy::js;

fn is_name_char(c: char) -> bool {
    js::is_word(c) || matches!(c, '.' | ':' | '-')
}

/// A standalone slash token in prose; offsets refer to the original prompt (bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillToken {
    pub name: String,
    /// The offset of the `/`.
    pub start: usize,
    pub end: usize,
}

/// `promptSkillTokens`: `(^|\s)/([a-zA-Z0-9][\w.:-]*)` followed by the end, whitespace, or one of `,!?;()[]{}` and
/// then the end or whitespace.
pub fn prompt_skill_tokens(prompt: &str) -> Vec<SkillToken> {
    let prose = prose_prompt(prompt);
    scan_prefixed(&prose, |text, at| {
        let rest = text.get(at..)?.strip_prefix('/')?;
        let first = rest.chars().next().filter(char::is_ascii_alphanumeric)?;
        let name_len =
            first.len_utf8() + rest[first.len_utf8()..].chars().take_while(|c| is_name_char(*c)).map(char::len_utf8).sum::<usize>();
        let after = &rest[name_len..];
        let mut chars = after.chars();
        let terminated = match chars.next() {
            None => true,
            Some(c) if js::is_space(c) => true,
            Some(',' | '!' | '?' | ';' | '(' | ')' | '[' | ']' | '{' | '}') => chars.next().is_none_or(js::is_space),
            Some(_) => false,
        };
        terminated.then_some(at + 1 + name_len)
    })
    .into_iter()
    .map(|(index, group, end)| {
        let start = index + group;
        SkillToken { name: prose[start + 1..end].to_string(), start, end }
    })
    .collect()
}

/// A stretch of a prompt: plain text, or a recognised skill (`/name`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkillPart<'a> {
    pub text: &'a str,
    pub skill: bool,
}

/// `promptSkillParts`: complete commands from the catalog, with the prompt kept verbatim. A literal catalog name
/// wins over stripping sentence punctuation (`/docs.v2.` is a skill when the catalog has `docs.v2.`).
pub fn prompt_skill_parts<'a>(prompt: &'a str, names: &[&str]) -> Vec<SkillPart<'a>> {
    let known: Vec<String> = names.iter().map(|name| name.to_lowercase()).collect();
    let is_known = |name: &str| known.iter().any(|known| *known == name.to_lowercase());
    let mut parts = Vec::new();
    let mut end = 0;
    for token in prompt_skill_tokens(prompt) {
        let mut name = token.name.as_str();
        if !is_known(name) {
            name = name.trim_end_matches(['.', ':']);
        }
        if !is_known(name) {
            continue;
        }
        if token.start > end {
            parts.push(SkillPart { text: &prompt[end..token.start], skill: false });
        }
        end = token.start + name.len() + 1;
        parts.push(SkillPart { text: &prompt[token.start..end], skill: true });
    }
    if end < prompt.len() {
        parts.push(SkillPart { text: &prompt[end..], skill: false });
    }
    parts
}

/// A caret or selected range, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub start: usize,
    pub end: usize,
}

/// `promptSkillAtSelection`: the (lower-case) skill whose command contains the caret or range.
pub fn prompt_skill_at_selection(parts: &[SkillPart<'_>], selection: Selection) -> Option<String> {
    let mut start = 0;
    for part in parts {
        let end = start + part.text.len();
        if part.skill && selection.start >= start && selection.end <= end {
            return Some(part.text[1..].to_lowercase());
        }
        start = end;
    }
    None
}

/// What `promptSkillQuery` finds: the partial command at the caret, with the rest of its word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillQuery {
    pub start: usize,
    pub end: usize,
    /// Lower-case, what is typed before the caret.
    pub query: String,
}

/// `promptSkillQuery`: a partial slash command at the caret, including the rest of its word for replacement.
pub fn prompt_skill_query(prompt: &str, selection: Selection, names: &[&str]) -> Option<SkillQuery> {
    let caret = selection.start;
    if caret != selection.end || caret > prompt.len() {
        return None;
    }
    let prose = prose_prompt(prompt);
    if !prose.is_char_boundary(caret) {
        return None;
    }
    // /(^|\s)\/([\w.:-]*)$/ on prose[..caret]: the name chars run to the caret, a `/` sits before them, and that
    // is at the start or after whitespace.
    let head = &prose[..caret];
    let name_len: usize = head.chars().rev().take_while(|c| is_name_char(*c)).map(char::len_utf8).sum();
    let slash = caret - name_len;
    if !head[..slash].ends_with('/') {
        return None;
    }
    let start = slash - 1;
    if start != 0 && !head[..start].chars().next_back().is_some_and(js::is_space) {
        return None;
    }
    let tail_len: usize = prose[caret..].chars().take_while(|c| is_name_char(*c)).map(char::len_utf8).sum();
    let mut end = caret + tail_len;
    let word = &prose[start + 1..end];
    let lower_word = word.to_lowercase();
    if !names.iter().any(|name| name.to_lowercase().starts_with(&lower_word)) {
        end -= word.len() - word.trim_end_matches(['.', ':']).len();
    }
    let suffix = &prose[end..];
    if !suffix.is_empty() {
        let mut chars = suffix.chars();
        let first = chars.next().expect("non-empty");
        let ok = js::is_space(first)
            || (matches!(first, '.' | ',' | '!' | '?' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}')
                && chars.next().is_none_or(js::is_space));
        if !ok {
            return None;
        }
    }
    Some(SkillQuery { start, end, query: prose[start + 1..caret.min(end)].to_lowercase() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::prompts::text::utf16_to_byte;

    fn caret(at: usize) -> Selection {
        Selection { start: at, end: at }
    }

    fn query(draft: &str, at: usize, names: &[&str]) -> Option<(usize, usize, String)> {
        prompt_skill_query(draft, caret(at), names).map(|q| (q.start, q.end, q.query))
    }

    fn q(start: usize, end: usize, text: &str) -> Option<(usize, usize, String)> {
        Some((start, end, text.to_string()))
    }

    #[test]
    fn skill_completion_queries_follow_the_caret_and_ignore_code_paths_and_selected_text() {
        assert_eq!(query("/", 1, &[]), q(0, 1, ""));
        assert_eq!(query("run /TL then", 7, &[]), q(4, 7, "tl"));
        assert_eq!(query("run /tldr then", 7, &[]), q(4, 9, "tl"));
        assert_eq!(query("run /tl. please", 7, &[]), q(4, 7, "tl"));
        assert_eq!(query("run /tl. please", 8, &[]), q(4, 7, "tl"));
        assert_eq!(query("/docs.v2.", 9, &["docs.v2."]), q(0, 9, "docs.v2."));
        assert_eq!(query("/plugin:", 8, &["plugin:review-code"]), q(0, 8, "plugin:"));
        assert_eq!(query("/docs.", 6, &["docs.v2"]), q(0, 6, "docs."));
        for draft in
            ["https://host/tl", "/tl/file", "/tl?mode=compact", "` /tl `", "run `echo /tl", "``echo ` /tl ``", "```\n/tl", "~~~\n/tl"]
        {
            let at = draft.find("/tl").unwrap() + 3;
            assert_eq!(query(draft, at, &[]), None, "{draft}");
        }
        assert_eq!(prompt_skill_query("/tl", Selection { start: 0, end: 3 }, &[]), None);
        assert_eq!(query("/tl ", 4, &[]), None);
        assert_eq!(query("/tl", 99, &[]), None);
    }

    #[test]
    fn recognizes_complete_skills_in_prose_while_preserving_the_exact_text() {
        let draft = "run /tldr, then\n/Plugin:review-code and /docs.v2.";
        let parts = prompt_skill_parts(draft, &["tldr", "plugin:review-code", "docs.v2"]);
        let skills: Vec<&str> = parts.iter().filter(|part| part.skill).map(|part| part.text).collect();
        assert_eq!(skills, vec!["/tldr", "/Plugin:review-code", "/docs.v2"]);
        assert_eq!(parts.iter().map(|part| part.text).collect::<String>(), draft);
    }

    #[test]
    fn leaves_partial_skills_unknown_commands_code_and_urls_unrecognized() {
        let draft = "/tl /tldr-extra /unknown https://host/tldr /tldr/file /tldr.md /tldr?mode=compact /tldr#section @/tldr ` /tldr `\n```\n/tldr\n```\n~~~\n/tldr\n~~~";
        assert_eq!(prompt_skill_parts(draft, &["tldr"]), vec![SkillPart { text: draft, skill: false }]);
        assert_eq!(prompt_skill_parts("", &["tldr"]), vec![]);
    }

    #[test]
    fn prefers_a_literal_catalog_name_over_stripping_sentence_punctuation() {
        let parts = prompt_skill_parts("/docs.v2. /tldr?", &["docs.v2.", "tldr"]);
        let skills: Vec<&str> = parts.iter().filter(|part| part.skill).map(|part| part.text).collect();
        assert_eq!(skills, vec!["/docs.v2.", "/tldr"]);
    }

    #[test]
    fn selects_the_skill_at_a_caret_or_range_contained_within_the_command() {
        let text = "🙂 use /tldr please";
        let parts = prompt_skill_parts(text, &["tldr"]);
        // The TypeScript test gives UTF-16 offsets; convert them.
        let at = |utf16: usize| utf16_to_byte(text, utf16).unwrap();
        let sel = |a: usize, b: usize| Selection { start: at(a), end: at(b) };
        assert_eq!(prompt_skill_at_selection(&parts, sel(9, 9)).as_deref(), Some("tldr"));
        assert_eq!(prompt_skill_at_selection(&parts, sel(12, 12)).as_deref(), Some("tldr"));
        assert_eq!(prompt_skill_at_selection(&parts, sel(15, 15)), None);
        assert_eq!(prompt_skill_at_selection(&parts, sel(7, 12)).as_deref(), Some("tldr"));
        assert_eq!(prompt_skill_at_selection(&parts, sel(3, 12)), None);
    }

    #[test]
    fn tokens_need_a_boundary_before_and_after() {
        let names = |prompt: &str| prompt_skill_tokens(prompt).into_iter().map(|t| (t.name, t.start, t.end)).collect::<Vec<_>>();
        assert_eq!(names("/a /b"), vec![("a".into(), 0, 2), ("b".into(), 3, 5)]);
        assert_eq!(names("x/a"), vec![]);
        assert_eq!(names("(/a)"), vec![]);
        assert_eq!(names("/a, /b"), vec![("a".into(), 0, 2), ("b".into(), 4, 6)]);
        assert_eq!(names("/a,b"), vec![]);
        assert_eq!(names("/_a"), vec![]);
        assert_eq!(names("é /a"), vec![("a".into(), 3, 5)]);
    }
}
