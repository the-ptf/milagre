//! The prompt editor: gpui-component's text area (`TextareaState`) over the composer's string model, as
//! `PromptEditor.tsx` and `lib/editor-model.ts` keep a `contentEditable` over a plain string.
//!
//! - **The string is the draft.** The text area's text is the prompt, character for character; a chip is an atomic
//!   inline token whose text is its source (`/tldr`, `@src/app.rs`), so the text area's value is always the prompt
//!   string and copying a selection copies chips as their text.
//! - **Chips are a view of the string.** After every edit the draft is split with `logic::prompts`
//!   (`prompt_parts`, with the skills, files, Chats, computers and images the composer knows) and the text area's
//!   tokens are made to match: a typed `/tldr` becomes a chip, `/tldrx` stops being one, as on the desktop.
//! - **Editing is the text area's**: typing, IME and dead keys (the platform input handler), word and line
//!   movement, one arrow step and one backspace per chip, selection, copy and paste of text.
//! - **Undo is ours** (`super::history`, after `createEditHistory`): every change records the draft and caret it
//!   replaced; the composer catches `Undo` and `Redo` and puts a recorded draft back, chips included.

use std::ops::Range;
use std::time::Instant;

use gpui::{App, AppContext as _, Context, Entity, EntityInputHandler as _, Window};
use gpui_component::input::{InlineToken, InputContent, TextareaState};

use super::chips::token_for;
use super::history::{EditHistory, EditKind, Snapshot};
use super::mentions::MentionSource;
use super::{Composer, MAX_ROWS};
use crate::logic::prompts::parts::{Images, PromptPart, PromptPartsOptions, prompt_parts};
use crate::logic::prompts::text::utf16_to_byte;

/// What the draft's chips are resolved against: the source of files, Chats and computers, the names `/` knows and
/// how many images are attached.
pub struct Catalog<'a> {
    pub source: &'a dyn MentionSource,
    pub skills: &'a [String],
    pub images: usize,
}

impl Catalog<'_> {
    /// `promptParts` with what the composer knows (`PromptComposer.tsx`'s `parts`).
    pub fn parts(&self, value: &str) -> Vec<PromptPart> {
        let skills: Vec<&str> = self.skills.iter().map(String::as_str).collect();
        let files = |path: &str| self.source.is_file(path);
        let chats = |id: u64| self.source.chats().iter().any(|chat| chat.id == id && chat.available);
        let computers = |name: &str| self.source.computers().iter().any(|computer| computer.name.to_lowercase() == name.to_lowercase());
        prompt_parts(
            value,
            &PromptPartsOptions {
                skills: &skills,
                files: &files,
                images: Images::Count(self.images),
                chats: &chats,
                computers: &computers,
            },
        )
    }

    /// The chips of `value`: each one's byte range and token.
    pub fn chips(&self, value: &str) -> Vec<(Range<usize>, InlineToken)> {
        let mut offset = 0;
        let mut chips = Vec::new();
        for part in self.parts(value) {
            let range = offset..offset + part.text().len();
            offset = range.end;
            if let Some(token) = token_for(&part, self.source) {
                chips.push((range, token));
            }
        }
        chips
    }

    /// The draft as the text area's content: the text with its chips as tokens. A chip whose range the text area
    /// refuses (it would split a grapheme) stays text.
    pub fn content(&self, value: &str) -> InputContent {
        self.chips(value).into_iter().fold(InputContent::new(value.to_string()), |content, (range, token)| {
            content.clone().with_token(range, token).unwrap_or(content)
        })
    }
}

/// The range a change replaced in `previous` and the text that took its place in `next`: the common prefix and
/// suffix left out.
fn changed_span(previous: &str, next: &str) -> (Range<usize>, String) {
    let prefix: usize = previous.chars().zip(next.chars()).take_while(|(a, b)| a == b).map(|(a, _)| a.len_utf8()).sum();
    let suffix: usize =
        previous[prefix..].chars().rev().zip(next[prefix..].chars().rev()).take_while(|(a, b)| a == b).map(|(a, _)| a.len_utf8()).sum();
    (prefix..previous.len() - suffix, next[prefix..next.len() - suffix].to_string())
}

/// How an edit the text area made is recorded: one that cut into a chip is a chip edit, as `replaceRange`'s `chip`
/// flag makes it; otherwise a paste or cut the composer saw coming, else typing or deleting.
fn classify(previous: &str, next: &str, chips: &[Range<usize>], pending: Option<EditKind>) -> EditKind {
    let (removed, inserted) = changed_span(previous, next);
    if chips.iter().any(|chip| removed.start < chip.end && removed.end > chip.start) {
        return EditKind::Chip;
    }
    pending.unwrap_or(if inserted.is_empty() { EditKind::Delete } else { EditKind::Type })
}

pub struct PromptEditor {
    pub state: Entity<TextareaState>,
    history: EditHistory,
    /// The draft as last seen, with the caret (selection start) it had before the next edit.
    last: Snapshot,
    selection: Range<usize>,
    /// The IME's marked text, in bytes, while a composition is open.
    marked: Option<Range<usize>>,
    /// Set by an action the composer catches before the text area applies it (a paste, a cut).
    pub pending_kind: Option<EditKind>,
}

impl PromptEditor {
    /// One row at rest, growing to [`MAX_ROWS`] (the composer sizes the box around it); Enter is the composer's.
    pub fn new(window: &mut Window, cx: &mut Context<Composer>) -> Self {
        let state = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, MAX_ROWS).placeholder("").submit_on_enter(true));
        Self { state, history: EditHistory::default(), last: Snapshot::new("", 0), selection: 0..0, marked: None, pending_kind: None }
    }

    pub fn value(&self) -> &str {
        &self.last.value
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn marked(&self) -> Option<Range<usize>> {
        self.marked.clone()
    }

    /// The text area notified (a caret move, marked text, a blink): mirror its selection and marked text.
    pub fn observe(&mut self, window: &mut Window, cx: &mut App) {
        let (value, selection, marked) = self.state.update(cx, |state, cx| {
            let marked = state.marked_text_range(window, cx);
            (state.value(), state.selected_range(), marked)
        });
        self.marked = marked.and_then(|range| Some(utf16_to_byte(&value, range.start)?..utf16_to_byte(&value, range.end)?));
        if value.as_ref() == self.last.value {
            self.last.caret = selection.start;
            self.selection = selection;
        }
    }

    /// The text area changed the text. Records the draft it replaced and returns it, or `None` when only the
    /// tokens changed.
    pub fn text_changed(&mut self, catalog: &Catalog<'_>, now: Instant, cx: &mut App) -> Option<String> {
        let (value, selection) = self.state.read_with(cx, |state, _| (state.value().to_string(), state.selected_range()));
        self.selection = selection.clone();
        if value == self.last.value {
            self.last.caret = selection.start;
            return None;
        }
        let chips: Vec<Range<usize>> = catalog.chips(&self.last.value).into_iter().map(|(range, _)| range).collect();
        let kind = classify(&self.last.value, &value, &chips, self.pending_kind.take());
        let before = std::mem::replace(&mut self.last, Snapshot::new(value, selection.start));
        self.history.record(before.clone(), kind, now);
        Some(before.value)
    }

    /// Makes the text area's tokens the chips of its text, keeping the selection and scroll. Not while an IME
    /// composition is open: its text is not the draft's yet.
    pub fn sync_tokens(&mut self, catalog: &Catalog<'_>, window: &mut Window, cx: &mut App) {
        if self.marked.is_some() {
            return;
        }
        let wanted = catalog.chips(&self.last.value);
        let current: Vec<(Range<usize>, InlineToken)> =
            self.state.read(cx).tokens().iter().map(|span| (span.range(), span.token().clone())).collect();
        if wanted == current || self.state.read(cx).value().as_ref() != self.last.value {
            return;
        }
        let content = catalog.content(&self.last.value);
        self.state.update(cx, |state, cx| {
            let selection = state.selected_range();
            let reversed = state.is_selection_reversed();
            let scroll = state.scroll_offset();
            state.set_value(content, window, cx);
            state.set_selected_range_with_direction(selection, reversed, cx);
            state.set_scroll_offset(scroll, cx);
        });
        self.selection = self.state.read(cx).selected_range();
    }

    /// Puts a draft in from outside (a pick, history, a suggestion, undo): one undo step of `kind`, made at `now`,
    /// unless `None`; the caret at `selection`, the view scrolled to it.
    pub fn set(
        &mut self,
        value: String,
        selection: Range<usize>,
        record: Option<(EditKind, Instant)>,
        catalog: &Catalog<'_>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some((kind, now)) = record
            && value != self.last.value
        {
            if value.is_empty() {
                self.history.clear();
            } else {
                self.history.record(self.last.clone(), kind, now);
            }
        }
        let content = catalog.content(&value);
        self.state.update(cx, |state, cx| {
            state.set_value(content, window, cx);
            state.set_selected_range(selection.start.min(value.len())..selection.end.min(value.len()), cx);
        });
        self.selection = self.state.read(cx).selected_range();
        self.last = Snapshot::new(value, self.selection.start);
        self.pending_kind = None;
    }

    /// Steps back (or forward) through the history. False when there is nothing to step to.
    pub fn step(&mut self, redo: bool, catalog: &Catalog<'_>, window: &mut Window, cx: &mut App) -> bool {
        let current = Snapshot::new(self.last.value.clone(), self.selection.start);
        let next = if redo { self.history.redo(current) } else { self.history.undo(current) };
        let Some(next) = next else { return false };
        self.set(next.value, next.caret..next.caret, None, catalog, window, cx);
        true
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::chat::composer::mentions::FixtureMentions;

    /// `editor-model.test.ts`: "Backspace and Delete next to a chip remove the whole chip" and "replacing a range
    /// never leaves half a chip", as the kinds those edits record.
    #[test]
    fn an_edit_that_cuts_into_a_chip_is_a_chip_step() {
        let chips = [Range { start: 2, end: 4 }];
        assert_eq!(classify("a /x b", "a  b", &chips, None), EditKind::Chip);
        assert_eq!(classify("a /x b", "a /xb", &chips, None), EditKind::Delete);
        assert_eq!(classify("a /x b", "a /x bc", &chips, None), EditKind::Type);
        assert_eq!(classify("a /x b", "a /x b!", &chips, Some(EditKind::Paste)), EditKind::Paste);
        assert_eq!(classify("a /x b", "a y b", &chips, Some(EditKind::Paste)), EditKind::Chip, "a chip edit wins over a paste");
        assert_eq!(classify("", "日本", &[], None), EditKind::Type);
    }

    #[test]
    fn the_changed_span_leaves_the_common_ends_out() {
        assert_eq!(changed_span("hello", "help"), (3..5, "p".into()));
        assert_eq!(changed_span("aa", "aaa"), (2..2, "a".into()));
        assert_eq!(changed_span("é!", "!"), (0..2, String::new()));
    }

    /// Every chip kind turns the prompt string into tokens over exactly its source text, and the text with its
    /// tokens reads back as the same string.
    #[test]
    fn every_chip_kind_round_trips_through_the_content() {
        let source = FixtureMentions::default();
        let skills = vec!["tldr".to_string()];
        let catalog = Catalog { source: &source, skills: &skills, images: 2 };
        let prompt = "Run /tldr on @src/app.rs, ask @chat:12 and @computer:Santo or @computer:\"Victor's MacBook\" about [Image #2]. \
                      Not /nope, @missing.rs, @chat:404, `[Image #1]` or [Image #3].";
        let content = catalog.content(prompt);
        assert_eq!(content.text().as_ref(), prompt, "the content's text is the prompt string");
        let tokens: Vec<(&str, &str)> = content.tokens().iter().map(|span| (&prompt[span.range()], span.token().id().as_ref())).collect();
        assert_eq!(
            tokens,
            [
                ("/tldr", "skill:tldr"),
                ("@src/app.rs", "file:src/app.rs"),
                ("@chat:12", "chat:12"),
                ("@computer:Santo", "computer:Santo"),
                ("@computer:\"Victor's MacBook\"", "computer-offline:Victor's MacBook"),
                ("[Image #2]", "image:2"),
            ]
        );
        for span in content.tokens() {
            assert_eq!(span.token().text().as_ref(), &prompt[span.range()], "a token's text is its source");
        }
    }
}
