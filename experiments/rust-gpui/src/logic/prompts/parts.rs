//! After `packages/shared/src/prompt-parts.mjs`: quotes, mention tokens, `[Image #N]` tokens, the prompt title
//! and the parts a prompt splits into (composer and user bubble).

use std::sync::atomic::{AtomicU64, Ordering};

use super::skills::{SkillPart, prompt_skill_parts};
use super::text::{
    MAX_SAFE_INTEGER, is_chat_path, is_trailing_punctuation, parse_number, prose_prompt, scan_prefixed, strip_trailing_punctuation,
};
use crate::data::Provider;
use crate::logic::copy::js;

// ---- Quotes ----

/// `passageText`: line endings as `\n`, leading newlines and trailing whitespace dropped.
fn passage_text(passage: &str) -> String {
    let normalized = passage.replace("\r\n", "\n").replace('\r', "\n");
    js::trim_end_js(normalized.trim_start_matches('\n')).to_string()
}

/// `quoteMarkdown`: a passage as a Markdown blockquote: `> ` on each line, a bare `>` on blank ones. Empty when
/// it has no text.
pub fn quote_markdown(passage: &str) -> String {
    let text = passage_text(passage);
    let lines: Vec<&str> = text.split('\n').collect();
    if !lines.iter().any(|line| !js::trim(line).is_empty()) {
        return String::new();
    }
    lines.iter().map(|line| if js::trim(line).is_empty() { ">".to_string() } else { format!("> {line}") }).collect::<Vec<_>>().join("\n")
}

/// A quote chip for the composer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerQuote {
    pub id: String,
    pub text: String,
    pub source: Option<String>,
}

static QUOTE_COUNT: AtomicU64 = AtomicU64::new(0);

/// `composerQuote`: a quote chip, or `None` when the passage has no text. Ids count up (`quote-1`, ...) across the
/// process, as the TypeScript module's counter does.
pub fn composer_quote(passage: &str, source: Option<&str>) -> Option<ComposerQuote> {
    let text = passage_text(passage);
    if js::trim(&text).is_empty() {
        return None;
    }
    let id = format!("quote-{}", QUOTE_COUNT.fetch_add(1, Ordering::Relaxed) + 1);
    Some(ComposerQuote { id, text, source: source.filter(|source| !source.is_empty()).map(str::to_string) })
}

/// Whose words a quoted passage is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteFrom {
    User,
    Assistant,
}

/// `quoteSource`: where a quoted passage came from, as its chip names it (no provider reads as Claude).
pub fn quote_source(from: QuoteFrom, provider: Option<Provider>) -> String {
    match from {
        QuoteFrom::User => "Your message".to_string(),
        QuoteFrom::Assistant => format!("{} reply", provider.unwrap_or(Provider::Claude).name()),
    }
}

/// `quotedMessage`: what a composer sends: each quote as a blockquote, a blank line apart, then the typed text,
/// kept as typed.
pub fn quoted_message<S: AsRef<str>>(quotes: &[S], text: &str) -> String {
    let blocks: Vec<String> = quotes.iter().map(|quote| quote_markdown(quote.as_ref())).filter(|block| !block.is_empty()).collect();
    if blocks.is_empty() {
        return text.to_string();
    }
    if js::trim(text).is_empty() { blocks.join("\n\n") } else { format!("{}\n\n{text}", blocks.join("\n\n")) }
}

/// `quoteKeys`: a stable key per quote of one message, its text and how many times that text came before.
pub fn quote_keys<S: AsRef<str>>(quotes: &[S]) -> Vec<(String, String)> {
    let mut seen: Vec<(&str, usize)> = Vec::new();
    quotes
        .iter()
        .map(|quote| {
            let text = quote.as_ref();
            let count = match seen.iter_mut().find(|(seen_text, _)| *seen_text == text) {
                Some((_, count)) => {
                    *count += 1;
                    *count
                }
                None => {
                    seen.push((text, 1));
                    1
                }
            };
            (format!("{count}:{text}"), text.to_string())
        })
        .collect()
}

/// `/^ {0,3}> ?(.*)$/` on one line: the quote's text, or `None`. `.` stops at the line terminators U+2028 and U+2029.
fn quote_line(line: &str) -> Option<&str> {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = line[indent..].strip_prefix('>')?;
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    (!rest.contains(['\u{2028}', '\u{2029}'])).then_some(rest)
}

/// What `splitQuotes` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitQuotes {
    pub quotes: Vec<String>,
    pub text: String,
}

/// `splitQuotes`: a message's leading blockquotes and the rest, the inverse of [`quoted_message`]. A blank line
/// ends a quote; the first line that isn't one ends them all. A body without leading quotes (or with an empty one)
/// comes back whole.
pub fn split_quotes(body: &str) -> SplitQuotes {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut quotes: Vec<String> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    let mut index = 0;
    while index < lines.len() {
        if let Some(text) = quote_line(lines[index]) {
            current.get_or_insert_with(Vec::new).push(text);
            index += 1;
            continue;
        }
        if !js::trim(lines[index]).is_empty() || (current.is_none() && quotes.is_empty()) {
            break;
        }
        if let Some(lines) = current.take() {
            quotes.push(lines.join("\n"));
        }
        index += 1;
    }
    if let Some(lines) = current {
        quotes.push(lines.join("\n"));
    }
    if quotes.is_empty() || quotes.iter().any(|quote| js::trim(quote).is_empty()) {
        return SplitQuotes { quotes: Vec::new(), text: body.to_string() };
    }
    SplitQuotes { quotes: quotes.iter().map(|quote| passage_text(quote)).collect(), text: lines[index..].join("\n") }
}

// ---- Mention formats ----

/// `formatFileMention`: `@path`, or `@"path"` when the path has whitespace or a quote, reads as a Chat reference,
/// or starts with `computer:`.
pub fn format_file_mention(path: &str) -> String {
    if path.chars().any(|c| js::is_space(c) || c == '"') || is_chat_path(path) || path.starts_with("computer:") {
        format!("@\"{path}\"")
    } else {
        format!("@{path}")
    }
}

/// `formatChatMention`: a reference to a Chat in the sending Project.
pub fn format_chat_mention(id: u64) -> String {
    format!("@chat:{id}")
}

/// `formatComputerMention`: a reference to a computer by its name, quoted when it has whitespace.
pub fn format_computer_mention(name: &str) -> String {
    let clean: String = name.chars().filter(|c| *c != '"' && *c != '\n').collect();
    let clean = js::trim(&clean);
    if clean.chars().any(js::is_space) { format!("@computer:\"{clean}\"") } else { format!("@computer:{clean}") }
}

/// `formatImageMention`: `[Image #1]` inline token for a 1-based attached image index.
pub fn format_image_mention(index: u64) -> String {
    format!("[Image #{index}]")
}

/// `imageLabel`: `"Image #1"` display label for a 1-based attached image index.
pub fn image_label(index: u64) -> String {
    format!("Image #{index}")
}

// ---- Tokens ----

/// A Chat reference in prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatToken {
    pub id: u64,
    pub start: usize,
    pub end: usize,
}

/// `(^|\s)@"[^"\n]+"` spans: (match start including the whitespace, end).
fn quoted_spans(prose: &str) -> Vec<(usize, usize)> {
    scan_prefixed(prose, |text, at| {
        let rest = text.get(at..)?.strip_prefix("@\"")?;
        let inner = rest.find(['"', '\n'])?;
        (inner > 0 && rest[inner..].starts_with('"')).then_some(at + 2 + inner + 1)
    })
    .into_iter()
    .map(|(index, _, end)| (index, end))
    .collect()
}

/// `chatMentionTokens`: Chat references in prose, complete tokens only (never code or file paths).
pub fn chat_mention_tokens(prompt: &str) -> Vec<ChatToken> {
    let prose = prose_prompt(prompt);
    let quoted = quoted_spans(&prose);
    let matches = scan_prefixed(&prose, |text, at| {
        let rest = text.get(at..)?.strip_prefix("@chat:")?;
        rest.bytes().next().filter(|b| (b'1'..=b'9').contains(b))?;
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let after = &rest[digits..];
        // (?=$|\s|[.,!?;:)\]}]+(?=$|\s))
        let terminated = match after.chars().next() {
            None => true,
            Some(c) if js::is_space(c) => true,
            Some(c) if is_trailing_punctuation(c) => {
                after.trim_start_matches(is_trailing_punctuation).chars().next().is_none_or(js::is_space)
            }
            Some(_) => false,
        };
        terminated.then_some(at + 6 + digits)
    });
    let mut tokens = Vec::new();
    for (index, group, end) in matches {
        if quoted.iter().any(|(span_start, span_end)| index >= *span_start && index < *span_end) {
            continue;
        }
        let start = index + group;
        let id = parse_number(&prose[start + 6..end]);
        if id > MAX_SAFE_INTEGER {
            continue;
        }
        tokens.push(ChatToken { id, start, end });
    }
    tokens
}

/// A computer reference in prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerToken {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

/// `computerMentionTokens`: computer references in prose, complete tokens only (never code). Names keep the case
/// they were written in.
pub fn computer_mention_tokens(prompt: &str) -> Vec<ComputerToken> {
    let prose = prose_prompt(prompt);
    let matches = scan_prefixed(&prose, |text, at| {
        let rest = text.get(at..)?.strip_prefix("@computer:")?;
        let after = at + "@computer:".len();
        if let Some(quoted) = rest.strip_prefix('"') {
            let inner = quoted.find(['"', '\n'])?;
            if inner > 0 && quoted[inner..].starts_with('"') {
                return Some(after + 1 + inner + 1);
            }
            return None;
        }
        let run: usize = rest.chars().take_while(|c| !js::is_space(*c) && *c != '"').map(char::len_utf8).sum();
        (run > 0).then_some(after + run)
    });
    let mut tokens = Vec::new();
    for (index, group, end) in matches {
        let start = index + group;
        let body = &prose[start + "@computer:".len()..end];
        if let Some(quoted) = body.strip_prefix('"') {
            let name = js::trim(&quoted[..quoted.len() - 1]);
            if !name.is_empty() {
                tokens.push(ComputerToken { name: name.to_string(), start, end });
            }
            continue;
        }
        let name = strip_trailing_punctuation(body);
        if !name.is_empty() {
            tokens.push(ComputerToken { name: name.to_string(), start, end: start + "@computer:".len() + name.len() });
        }
    }
    tokens
}

/// Which attached images a prompt may name: a count (`[Image #1]` to `[Image #n]`) or a predicate on the 1-based index.
#[derive(Clone, Copy)]
pub enum Images<'a> {
    Count(usize),
    Valid(&'a dyn Fn(u64) -> bool),
}

impl Images<'_> {
    /// `hasImage`.
    pub fn has(&self, index: u64) -> bool {
        match self {
            Images::Count(count) => index >= 1 && index <= *count as u64,
            Images::Valid(valid) => valid(index),
        }
    }

    /// `!images` in TypeScript: no count, or a count of zero.
    fn is_empty(&self) -> bool {
        matches!(self, Images::Count(0))
    }
}

/// `[Image #N]` tokens in `text` (`/\[Image #([1-9]\d*)\]/g`): (start, end, index).
pub(crate) fn image_token_matches(text: &str) -> Vec<(usize, usize, u64)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = text[at..].find("[Image #") {
        let start = at + open;
        let digits_at = start + "[Image #".len();
        let rest = &text[digits_at..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && !rest.starts_with('0') && rest[digits..].starts_with(']') {
            let end = digits_at + digits + 1;
            found.push((start, end, parse_number(&rest[..digits])));
            at = end;
        } else {
            at = start + 1;
        }
    }
    found
}

/// An image token in prose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageToken {
    pub index: u64,
    pub start: usize,
    pub end: usize,
}

fn image_tokens(prompt: &str, images: &Images<'_>) -> Vec<ImageToken> {
    if images.is_empty() {
        return Vec::new();
    }
    let prose = prose_prompt(prompt);
    image_token_matches(&prose)
        .into_iter()
        .filter(|(_, _, index)| *index <= MAX_SAFE_INTEGER && images.has(*index))
        .map(|(start, end, index)| ImageToken { index, start, end })
        .collect()
}

/// `onlyImageMentions`: true when a sent prompt is only its attached images' tokens (`[Image #1] [Image #2]`): the
/// images show, not a text bubble. `None` or a count of zero is no images.
pub fn only_image_mentions(prompt: &str, images: Option<&Images<'_>>) -> bool {
    let Some(images) = images.filter(|images| !images.is_empty()) else { return false };
    if js::trim(prompt).is_empty() {
        return false;
    }
    let mut rest = String::new();
    let mut at = 0;
    for (start, end, index) in image_token_matches(prompt) {
        rest.push_str(&prompt[at..start]);
        if !images.has(index) {
            rest.push_str(&prompt[start..end]);
        }
        at = end;
    }
    rest.push_str(&prompt[at..]);
    js::trim(&rest).is_empty()
}

/// `promptTitle`: a Chat's name from the first line of its prompt: the `[Image #N]` tokens of attached images are
/// dropped and the spaces collapsed, and a line that was only tokens reads "Image" or "N images". `images` is
/// `None` when unknown (every token counts); a token with no image behind it stays as text.
pub fn prompt_title(line: &str, images: Option<&Images<'_>>) -> String {
    let mut found: Vec<u64> = Vec::new();
    let mut replaced = String::new();
    let mut at = 0;
    for (start, end, index) in image_token_matches(line) {
        replaced.push_str(&line[at..start]);
        if images.is_some_and(|images| !images.has(index)) {
            replaced.push_str(&line[start..end]);
        } else if !found.contains(&index) {
            found.push(index);
        }
        at = end;
    }
    replaced.push_str(&line[at..]);
    // .replace(/\s+/g, " ").trim()
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in replaced.chars() {
        if js::is_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let text = js::trim(&collapsed);
    if !text.is_empty() || found.is_empty() {
        return text.to_string();
    }
    if found.len() == 1 { "Image".to_string() } else { format!("{} images", found.len()) }
}

/// `skillLabel`: "frontend-design" becomes "Frontend Design"; a plugin prefix ("plugin:name") is dropped.
pub fn skill_label(name: &str) -> String {
    let slug = name.rfind(':').map_or(name, |at| &name[at + 1..]);
    slug.split(|c: char| matches!(c, '-' | '_' | '.') || js::is_space(c))
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            let first: String = chars.next().expect("non-empty").to_uppercase().collect();
            first + chars.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A file mention in prose.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileToken {
    path: String,
    start: usize,
    end: usize,
}

/// `fileTokens`: `(^|\s)@(?:"([^"\n]+)"|([^\s"]\S*))` where `files` accepts the path.
fn file_tokens(prompt: &str, files: &dyn Fn(&str) -> bool) -> Vec<FileToken> {
    let prose = prose_prompt(prompt);
    let matches = scan_prefixed(&prose, |text, at| {
        let rest = text.get(at..)?.strip_prefix('@')?;
        if let Some(quoted) = rest.strip_prefix('"')
            && let Some(inner) = quoted.find(['"', '\n'])
            && inner > 0
            && quoted[inner..].starts_with('"')
        {
            return Some(at + 1 + 1 + inner + 1);
        }
        let first = rest.chars().next().filter(|c| !js::is_space(*c) && *c != '"')?;
        let run: usize =
            first.len_utf8() + rest[first.len_utf8()..].chars().take_while(|c| !js::is_space(*c)).map(char::len_utf8).sum::<usize>();
        Some(at + 1 + run)
    });
    let mut tokens = Vec::new();
    for (index, group, end) in matches {
        let start = index + group;
        let body = &prose[start + 1..end];
        let quoted = body.len() >= 2
            && body.starts_with('"')
            && body.ends_with('"')
            && !body[1..body.len() - 1].contains(['"', '\n'])
            && body.len() > 2;
        if quoted {
            let path = &body[1..body.len() - 1];
            if files(path) {
                tokens.push(FileToken { path: path.to_string(), start, end });
            }
            continue;
        }
        if is_chat_path(body) || body.starts_with("computer:") {
            continue;
        }
        let path = if files(body) { body } else { strip_trailing_punctuation(body) };
        if !path.is_empty() && files(path) {
            tokens.push(FileToken { path: path.to_string(), start, end: start + 1 + path.len() });
        }
    }
    tokens
}

/// One part of a prompt (`promptParts`'s items). The parts' `text` joins back into the prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptPart {
    Text { text: String },
    Skill { text: String, name: String },
    File { text: String, path: String },
    Chat { text: String, id: u64, start: usize },
    Computer { text: String, name: String },
    Image { text: String, index: u64 },
}

impl PromptPart {
    pub fn text(&self) -> &str {
        match self {
            PromptPart::Text { text }
            | PromptPart::Skill { text, .. }
            | PromptPart::File { text, .. }
            | PromptPart::Chat { text, .. }
            | PromptPart::Computer { text, .. }
            | PromptPart::Image { text, .. } => text,
        }
    }
}

/// `promptParts`'s options. `files`, `chats` and `computers` say which mentions exist; `images` which `[Image #N]`
/// tokens have an image behind them.
pub struct PromptPartsOptions<'a> {
    pub skills: &'a [&'a str],
    pub files: &'a dyn Fn(&str) -> bool,
    pub images: Images<'a>,
    pub chats: &'a dyn Fn(u64) -> bool,
    pub computers: &'a dyn Fn(&str) -> bool,
}

impl<'a> PromptPartsOptions<'a> {
    /// Skills and files only, no images, Chats or computers (the TypeScript defaults).
    pub fn new(skills: &'a [&'a str], files: &'a dyn Fn(&str) -> bool) -> Self {
        Self { skills, files, images: Images::Count(0), chats: &|_| false, computers: &|_| false }
    }
}

#[derive(Clone, Debug)]
enum MarkKind {
    Skill(String),
    Chat(u64),
    Computer(String),
    File(String),
    Image(u64),
}

#[derive(Clone, Debug)]
struct Mark {
    start: usize,
    end: usize,
    kind: MarkKind,
}

/// `promptParts`: split a prompt into text, skill, Chat, computer, file and image parts. Skills win over Chats,
/// those over computers, files and images, wherever two tokens overlap.
pub fn prompt_parts(prompt: &str, options: &PromptPartsOptions<'_>) -> Vec<PromptPart> {
    let mut marks: Vec<Mark> = Vec::new();
    let overlaps = |marks: &[Mark], start: usize, end: usize| marks.iter().any(|mark| start < mark.end && end > mark.start);
    let mut offset = 0;
    for part in prompt_skill_parts(prompt, options.skills) {
        let SkillPart { text, skill } = part;
        if skill {
            marks.push(Mark { start: offset, end: offset + text.len(), kind: MarkKind::Skill(text[1..].to_string()) });
        }
        offset += text.len();
    }
    for token in chat_mention_tokens(prompt) {
        if (options.chats)(token.id) && !overlaps(&marks, token.start, token.end) {
            marks.push(Mark { start: token.start, end: token.end, kind: MarkKind::Chat(token.id) });
        }
    }
    for token in computer_mention_tokens(prompt) {
        if (options.computers)(&token.name) && !overlaps(&marks, token.start, token.end) {
            marks.push(Mark { start: token.start, end: token.end, kind: MarkKind::Computer(token.name) });
        }
    }
    for token in file_tokens(prompt, options.files) {
        if !overlaps(&marks, token.start, token.end) {
            marks.push(Mark { start: token.start, end: token.end, kind: MarkKind::File(token.path) });
        }
    }
    for token in image_tokens(prompt, &options.images) {
        if !overlaps(&marks, token.start, token.end) {
            marks.push(Mark { start: token.start, end: token.end, kind: MarkKind::Image(token.index) });
        }
    }
    marks.sort_by_key(|mark| mark.start);
    let mut parts = Vec::new();
    let mut end = 0;
    for mark in marks {
        if mark.start > end {
            parts.push(PromptPart::Text { text: prompt[end..mark.start].to_string() });
        }
        let text = prompt[mark.start..mark.end].to_string();
        parts.push(match mark.kind {
            MarkKind::Skill(name) => PromptPart::Skill { text, name },
            MarkKind::File(path) => PromptPart::File { text, path },
            MarkKind::Chat(id) => PromptPart::Chat { text, id, start: mark.start },
            MarkKind::Computer(name) => PromptPart::Computer { text, name },
            MarkKind::Image(index) => PromptPart::Image { text, index },
        });
        end = mark.end;
    }
    if end < prompt.len() {
        parts.push(PromptPart::Text { text: prompt[end..].to_string() });
    }
    parts
}

/// A block of a message with images placed in reading order (`promptImageBlocks`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImageBlock<T> {
    Text(String),
    Image { index: u64, image: T },
}

/// `promptImageBlocks`: interleave a prompt's text and attached images in reading order. Each `[Image #N]` token in
/// prose places `images[N - 1]` at that position; attached images not referenced inline are appended at the end so
/// nothing is dropped. A token repeated in the prompt places its image each time.
pub fn prompt_image_blocks<T: Clone>(prompt: &str, images: &[T]) -> Vec<ImageBlock<T>> {
    if images.is_empty() {
        return vec![ImageBlock::Text(prompt.to_string())];
    }
    let tokens = image_tokens(prompt, &Images::Count(images.len()));
    if tokens.is_empty() {
        let mut blocks = vec![ImageBlock::Text(prompt.to_string())];
        blocks.extend(images.iter().enumerate().map(|(i, image)| ImageBlock::Image { index: i as u64 + 1, image: image.clone() }));
        return blocks;
    }
    let mut blocks = Vec::new();
    let mut referenced: Vec<u64> = Vec::new();
    let mut end = 0;
    for token in &tokens {
        if token.start > end {
            blocks.push(ImageBlock::Text(prompt[end..token.start].to_string()));
        }
        blocks.push(ImageBlock::Image { index: token.index, image: images[token.index as usize - 1].clone() });
        referenced.push(token.index);
        end = token.end;
    }
    if end < prompt.len() {
        blocks.push(ImageBlock::Text(prompt[end..].to_string()));
    }
    for (i, image) in images.iter().enumerate() {
        let index = i as u64 + 1;
        if !referenced.contains(&index) {
            blocks.push(ImageBlock::Image { index, image: image.clone() });
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(parts: &[PromptPart]) -> Vec<&'static str> {
        parts
            .iter()
            .map(|part| match part {
                PromptPart::Text { .. } => "text",
                PromptPart::Skill { .. } => "skill",
                PromptPart::File { .. } => "file",
                PromptPart::Chat { .. } => "chat",
                PromptPart::Computer { .. } => "computer",
                PromptPart::Image { .. } => "image",
            })
            .collect()
    }

    fn joined(parts: &[PromptPart]) -> String {
        parts.iter().map(PromptPart::text).collect()
    }

    fn plain(skills: &'static [&'static str], files: &'static dyn Fn(&str) -> bool) -> PromptPartsOptions<'static> {
        PromptPartsOptions::new(skills, files)
    }

    #[test]
    fn splits_skills_files_and_images_out_of_prose_and_keeps_the_text_verbatim() {
        let prompt = "Use /frontend-design to fix @src/surface.test.ts like [Image #1] and [Image #2] now";
        let files = |path: &str| path == "src/surface.test.ts";
        let options = PromptPartsOptions { images: Images::Count(2), ..PromptPartsOptions::new(&["frontend-design"], &files) };
        let parts = prompt_parts(prompt, &options);
        assert_eq!(kinds(&parts), vec!["text", "skill", "text", "file", "text", "image", "text", "image", "text"]);
        assert_eq!(parts[1], PromptPart::Skill { text: "/frontend-design".into(), name: "frontend-design".into() });
        assert_eq!(parts[3], PromptPart::File { text: "@src/surface.test.ts".into(), path: "src/surface.test.ts".into() });
        assert_eq!(parts[5], PromptPart::Image { text: "[Image #1]".into(), index: 1 });
        assert_eq!(parts[7], PromptPart::Image { text: "[Image #2]".into(), index: 2 });
        assert_eq!(joined(&parts), prompt);
    }

    #[test]
    fn out_of_range_or_code_fenced_image_tokens_stay_plain_text() {
        let prompt = "See `[Image #1]` and [Image #3] while [Image #2] is attached";
        let options = PromptPartsOptions { images: Images::Count(2), ..plain(&[], &|_| false) };
        let parts = prompt_parts(prompt, &options);
        let shape: Vec<String> = parts
            .iter()
            .map(|part| match part {
                PromptPart::Image { index, .. } => format!("image:{index}"),
                other => other.text().to_string(),
            })
            .collect();
        assert_eq!(shape, vec!["See `[Image #1]` and [Image #3] while ", "image:2", " is attached"]);
    }

    #[test]
    fn prompt_image_blocks_interleave_text_and_images_in_reading_order_and_append_unreferenced_images() {
        let images = ["img-1", "img-2", "img-3"];
        let blocks = prompt_image_blocks("[Image #1] first, then [Image #3] after", &images);
        assert_eq!(
            blocks,
            vec![
                ImageBlock::Image { index: 1, image: "img-1" },
                ImageBlock::Text(" first, then ".into()),
                ImageBlock::Image { index: 3, image: "img-3" },
                ImageBlock::Text(" after".into()),
                ImageBlock::Image { index: 2, image: "img-2" },
            ]
        );
    }

    #[test]
    fn prompt_image_blocks_fall_back_to_text_followed_by_all_images_when_none_are_referenced() {
        let blocks = prompt_image_blocks("Compare these two screenshots", &["a", "b"]);
        assert_eq!(
            blocks,
            vec![
                ImageBlock::Text("Compare these two screenshots".into()),
                ImageBlock::Image { index: 1, image: "a" },
                ImageBlock::Image { index: 2, image: "b" }
            ]
        );
        assert_eq!(prompt_image_blocks::<&str>("x", &[]), vec![ImageBlock::Text("x".into())]);
    }

    #[test]
    fn quoted_paths_keep_spaces_and_trailing_punctuation_stays_text() {
        let prompt = "see @\"my app/a b.ts\".";
        let parts = prompt_parts(prompt, &plain(&[], &|_| true));
        let file = parts.iter().find_map(|part| if let PromptPart::File { path, .. } = part { Some(path.as_str()) } else { None });
        assert_eq!(file, Some("my app/a b.ts"));
        assert_eq!(parts.last().map(PromptPart::text), Some("."));
        assert_eq!(joined(&parts), prompt);
    }

    #[test]
    fn mid_word_at_and_unknown_files_never_parse() {
        let parts = prompt_parts("email me@host.com and @team", &plain(&[], &|_| true));
        assert!(parts.iter().all(|part| matches!(part, PromptPart::Text { .. }) || part.text() == "@team"));
        let parts = prompt_parts("email me@host.com and @team", &plain(&[], &|path| path != "team"));
        assert!(parts.iter().all(|part| matches!(part, PromptPart::Text { .. })));
        // Trailing punctuation is tried off when the full token is not a file.
        let parts = prompt_parts("see @a.ts, ok", &plain(&[], &|path| path == "a.ts"));
        assert_eq!(parts[1], PromptPart::File { text: "@a.ts".into(), path: "a.ts".into() });
        assert_eq!(parts[2].text(), ", ok");
    }

    #[test]
    fn code_spans_are_text() {
        let parts = prompt_parts("`@src/a.ts`", &plain(&[], &|_| true));
        assert!(parts.iter().all(|part| matches!(part, PromptPart::Text { .. })));
    }

    #[test]
    fn format_file_mention_quotes_paths_with_spaces() {
        assert_eq!(format_file_mention("a b.ts"), "@\"a b.ts\"");
        assert_eq!(format_file_mention("a.ts"), "@a.ts");
        assert_eq!(format_file_mention("chat:12"), "@\"chat:12\"");
        assert_eq!(format_file_mention("computer:notes"), "@\"computer:notes\"");
        assert_eq!(format_file_mention("say\"hi"), "@\"say\"hi\"");
    }

    #[test]
    fn skill_label_title_cases_the_slug() {
        assert_eq!(skill_label("frontend-design"), "Frontend Design");
        assert_eq!(skill_label("plugin:review-code"), "Review Code");
        assert_eq!(skill_label("a_b.c d"), "A B C D");
        assert_eq!(skill_label("élan-vital"), "Élan Vital");
        assert_eq!(skill_label(""), "");
    }

    #[test]
    fn only_image_mentions_is_true_only_when_the_prompt_is_just_its_attached_images() {
        let count = |n: usize| Images::Count(n);
        assert!(only_image_mentions("[Image #1]", Some(&count(1))));
        assert!(only_image_mentions(" [Image #1]\n[Image #2] ", Some(&count(2))));
        assert!(!only_image_mentions("[Image #1] look at this", Some(&count(1))));
        assert!(!only_image_mentions("[Image #2]", Some(&count(1))));
        assert!(!only_image_mentions("[Image #1]", Some(&count(0))));
        assert!(!only_image_mentions("", Some(&count(1))));
        assert!(!only_image_mentions("[Image #1]", None));
    }

    #[test]
    fn prompt_title_drops_attached_image_tokens_and_names_an_image_only_line() {
        let count = |n: usize| Images::Count(n);
        assert_eq!(prompt_title("[Image #1]", Some(&count(1))), "Image");
        assert_eq!(prompt_title("[Image #1] [Image #2]", Some(&count(2))), "2 images");
        assert_eq!(prompt_title("[Image #1] [Image #1]", Some(&count(2))), "Image");
        assert_eq!(prompt_title("look at [Image #1]  please", Some(&count(1))), "look at please");
        assert_eq!(prompt_title("[Image #2] only", Some(&count(1))), "[Image #2] only");
        assert_eq!(prompt_title("[Image #2]", Some(&count(1))), "[Image #2]");
        assert_eq!(prompt_title("[Image #4]", None), "Image");
        assert_eq!(prompt_title("Fix the login", Some(&count(0))), "Fix the login");
        assert_eq!(prompt_title("", Some(&count(1))), "");
        let valid = |index: u64| index == 3;
        assert_eq!(prompt_title("[Image #3] and [Image #4]", Some(&Images::Valid(&valid))), "and [Image #4]");
    }

    #[test]
    fn chat_mentions_preserve_text_take_precedence_over_files_and_use_complete_safe_tokens_in_prose() {
        let prompt = "Read @chat:12, then @chat:12 and @chat:7. `@chat:8` \n```\n@chat:9\n```\n@chat:0 @chat:01 @chat:9007199254740992 @chat:12/foo @chat:12-other @chat:12.5";
        let ids: Vec<u64> = chat_mention_tokens(prompt).iter().map(|token| token.id).collect();
        assert_eq!(ids, vec![12, 12, 7]);
        let chats = |id: u64| id == 12;
        let parts = prompt_parts(prompt, &PromptPartsOptions { chats: &chats, ..plain(&[], &|_| false) });
        let found: Vec<u64> =
            parts.iter().filter_map(|part| if let PromptPart::Chat { id, .. } = part { Some(*id) } else { None }).collect();
        assert_eq!(found, vec![12, 12]);
        assert_eq!(joined(&parts), prompt);
        assert_eq!(format_chat_mention(12), "@chat:12");
        assert_eq!(prompt_parts("@chat:12", &plain(&[], &|_| true)), vec![PromptPart::Text { text: "@chat:12".into() }]);
        let all = |_: u64| true;
        assert_eq!(
            prompt_parts("@\"chat:12\"", &PromptPartsOptions { chats: &all, ..plain(&[], &|_| true) }),
            vec![PromptPart::File { text: "@\"chat:12\"".into(), path: "chat:12".into() }]
        );
    }

    #[test]
    fn chat_scanner_shields_complete_filenames_and_quoted_paths_even_when_a_chat_id_exists() {
        let all = |_: u64| true;
        for token in ["@chat:12.txt", "@chat:12.5", "@chat:12-other", "@\"notes @chat:12 plan.txt\""] {
            assert_eq!(chat_mention_tokens(token), vec![], "{token}");
            let parts = prompt_parts(token, &PromptPartsOptions { chats: &all, ..plain(&[], &|_| true) });
            assert!(matches!(parts[0], PromptPart::File { .. }), "{token}");
            assert_eq!(joined(&parts), token);
        }
        for path in ["chat:12", "chat:12!", "chat:12."] {
            assert_eq!(format_file_mention(path), format!("@\"{path}\""));
            assert_eq!(chat_mention_tokens(&format_file_mention(path)), vec![]);
        }
        let ids: Vec<u64> = chat_mention_tokens("See @chat:12). Then @chat:5!").iter().map(|token| token.id).collect();
        assert_eq!(ids, vec![12, 5]);
    }

    #[test]
    fn computer_mentions_plain_and_quoted_names_trailing_punctuation_never_code_or_a_file() {
        let prompt = "Run it on @computer:Santo, and @computer:\"Victor MacBook\". `@computer:Code` @computer:";
        let tokens: Vec<(String, String)> =
            computer_mention_tokens(prompt).iter().map(|t| (t.name.clone(), prompt[t.start..t.end].to_string())).collect();
        assert_eq!(
            tokens,
            vec![
                ("Santo".to_string(), "@computer:Santo".to_string()),
                ("Victor MacBook".to_string(), "@computer:\"Victor MacBook\"".to_string())
            ]
        );
        let computers = |name: &str| name == "Santo";
        let parts = prompt_parts(prompt, &PromptPartsOptions { computers: &computers, ..plain(&[], &|_| true) });
        let others: Vec<&PromptPart> = parts.iter().filter(|part| !matches!(part, PromptPart::Text { .. })).collect();
        assert_eq!(others, vec![&PromptPart::Computer { text: "@computer:Santo".into(), name: "Santo".into() }]);
        assert_eq!(joined(&parts), prompt);
        assert_eq!(format_computer_mention("Santo"), "@computer:Santo");
        assert_eq!(format_computer_mention("Victor \"Big\" MacBook"), "@computer:\"Victor Big MacBook\"");
        assert_eq!(format_computer_mention(" Santo\n"), "@computer:Santo");
        assert_eq!(format_file_mention("computer:notes"), "@\"computer:notes\"");
    }

    #[test]
    fn a_quote_is_a_blockquote_on_every_line_with_bare_marks_on_blank_lines() {
        assert_eq!(quote_markdown("Name: Nora\r\nURL  \n"), "> Name: Nora\n> URL");
        assert_eq!(quote_markdown("\na\n\n  b"), "> a\n>\n>   b");
        assert_eq!(quote_markdown("  \n"), "");
    }

    #[test]
    fn quotes_go_before_the_typed_text_a_blank_line_apart_and_a_quote_only_message_has_no_trailing_text() {
        assert_eq!(quoted_message::<&str>(&[], "as typed  "), "as typed  ");
        assert_eq!(quoted_message(&["one", "two\n\nlines"], "Why?"), "> one\n\n> two\n>\n> lines\n\nWhy?");
        assert_eq!(quoted_message(&["only"], "  "), "> only");
        assert_eq!(quoted_message(&["  "], "text"), "text");
    }

    #[test]
    fn leading_quotes_split_back_out_of_a_sent_message() {
        let split =
            |quotes: &[&str], text: &str| SplitQuotes { quotes: quotes.iter().map(|q| q.to_string()).collect(), text: text.to_string() };
        let body = quoted_message(&["one", "two\n\nlines"], "Why?\n> not a quote");
        assert_eq!(split_quotes(&body), split(&["one", "two\n\nlines"], "Why?\n> not a quote"));
        assert_eq!(split_quotes("> only\n>more"), split(&["only\nmore"], ""));
        assert_eq!(split_quotes("> a\n\n\n> b\nquestion"), split(&["a", "b"], "question"));
        assert_eq!(split_quotes("no quote\n> later"), split(&[], "no quote\n> later"));
        assert_eq!(split_quotes("\n> after a blank line"), split(&[], "\n> after a blank line"));
        assert_eq!(split_quotes(">\n\nempty quote"), split(&[], ">\n\nempty quote"));
        assert_eq!(split_quotes("    > code"), split(&[], "    > code"));
        assert_eq!(split_quotes("> a\r\nrest"), split(&["a"], "rest"));
    }

    #[test]
    fn a_quote_chip_keeps_its_passage_and_source_and_an_empty_passage_makes_none() {
        let first = composer_quote("\n  indented\nline  \n", Some("Claude reply")).unwrap();
        let second = composer_quote("again", None).unwrap();
        assert_eq!(first.text, "  indented\nline");
        assert_eq!(first.source.as_deref(), Some("Claude reply"));
        assert_eq!(second.source, None);
        assert_ne!(first.id, second.id);
        assert_eq!(composer_quote(" \n", None), None);
        assert_eq!(quote_source(QuoteFrom::User, Some(Provider::Codex)), "Your message");
        assert_eq!(quote_source(QuoteFrom::Assistant, Some(Provider::Codex)), "Codex reply");
        assert_eq!(quote_source(QuoteFrom::Assistant, None), "Claude reply");
        let keys: Vec<String> = quote_keys(&["a", "b", "a"]).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, vec!["1:a", "1:b", "2:a"]);
        assert_eq!(format_image_mention(1), "[Image #1]");
        assert_eq!(image_label(1), "Image #1");
    }

    #[test]
    fn image_tokens_reject_leading_zeros_and_unclosed_brackets() {
        let found = |text: &str| image_token_matches(text).into_iter().collect::<Vec<_>>();
        assert_eq!(found("[Image #01] [Image #1"), vec![]);
        assert_eq!(found("a [Image #12]b"), vec![(2, 13, 12)]);
        assert_eq!(found("[Image #[Image #2]"), vec![(8, 18, 2)]);
    }
}
