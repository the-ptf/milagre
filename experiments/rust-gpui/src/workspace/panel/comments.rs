//! Comment mode on the Designs canvas and the Artifact page, shared by both tabs: the comments waiting for Send
//! (`PinControls` in `ArtifactCard.tsx`), the numbered pin and its bubble (`CommentPin.tsx`), the comment button with
//! its options (`CommentOptions.tsx`), and the message and records Send makes (`designFeedbackMessage`, the
//! `DesignComment`s `artifact:add-comments` takes) from `packages/shared/src/artifact.ts`.
//!
//! A pin's point is its top-left corner. A comment being written shows as an accent pin; one sent shows in ink, green
//! once the agent resolved it (hidden then unless "Show resolved comments" is on). A pin opens into its bubble: a
//! comment being written in a text field (Enter keeps it, ⌘Enter sends everything waiting, Escape closes, Delete
//! removes it; one closed empty is dropped), a sent one read back with "Sent to the agent" or the agent's note.
//! Resolving is the agent's (`artifact_resolve_comment`), never the window's.

use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, Focusable as _, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, prelude::*, px,
};
use gpui_component::input::{Enter, Escape, InputEvent, TextareaState};
use serde_json::{Value, json};

use crate::theme::{TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconButton, IconButtonSize, IconName, IconSize, TextArea, Tooltip};

/// A pin's size on screen (DESIGN.md, Sizes: 20); the bubble's width (`w-64`).
pub const PIN: f32 = 20.0;
pub const BUBBLE_WIDTH: f32 = 256.0;
/// The key that turns comment mode on and off, pressed on its own (`COMMENT_KEY`).
pub const COMMENT_KEY: &str = "c";

/// What a comment is on: a design's version, or the Artifact page (`ArtifactRef`).
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub id: String,
    pub title: String,
    pub version: u32,
    /// The Artifact page (`format: "html"`).
    pub html: bool,
}

/// A comment pinned and not sent yet (`DesignPin` without `commentId`).
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    /// Its comment id, named here so the message can carry it before the host records it.
    pub key: String,
    pub target: Target,
    /// Where, as fractions of the design's screen or of the whole page.
    pub x: f64,
    pub y: f64,
    pub text: String,
    /// The design layer under the point.
    pub node_id: Option<String>,
    /// On the page: the element and point it finds the pin by again, and the text there.
    pub anchor: Option<String>,
    pub near: Option<String>,
    /// On a page split into tabs: the tab's id and title.
    pub tab: Option<(String, String)>,
}

/// `newCommentId`: eight hex digits.
pub fn new_comment_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNT.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    format!("{:08x}", hasher.finish() as u32)
}

/// `nearText`: one line, no double quotes, at most 80 characters (cut at a word, with an ellipsis).
pub fn near_text(text: &str) -> String {
    let line = text.split(|c: char| c == '"' || c.is_whitespace()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if line.chars().count() <= 80 {
        return line;
    }
    let cut: String = line.chars().take(80).collect();
    let cut = match cut.rfind(char::is_whitespace) {
        Some(at) if !cut.ends_with(char::is_whitespace) => cut[..at].to_string(),
        _ => cut.trim_end().to_string(),
    };
    format!("{cut}\u{2026}")
}

const REVISE: &str = "Read the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id.";
const REVISE_ARTIFACT: &str =
    "Read the current page with artifact_read, then update it in place with artifact_show. Keep one Artifact page for this Chat.";
const RESOLVE_SUFFIX: &str = " Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.";

fn design_name(target: &Target) -> String {
    if target.html {
        format!("the artifact \"{}\" ({})", target.title, target.id)
    } else {
        format!("the design \"{}\" ({}, version {})", target.title, target.id, target.version)
    }
}

/// `designFeedbackMessage`: the design chosen (its id, title and version), then the comments, as Electron writes them.
pub fn feedback_message(choice: Option<(&str, &str, u32)>, comments: &[Draft]) -> String {
    let mut parts = Vec::new();
    if let Some((id, title, version)) = choice {
        let target = Target { id: id.into(), title: title.into(), version, html: false };
        parts.push(format!("I chose {}. Continue from this one.", design_name(&target)));
    }
    if !comments.is_empty() {
        let lines: Vec<String> = comments
            .iter()
            .enumerate()
            .map(|(index, comment)| {
                let at = format!(", {}% across and {}% down", (comment.x * 100.0).round(), (comment.y * 100.0).round());
                let layer = comment.node_id.as_ref().map(|id| format!(", layer \"{id}\"")).unwrap_or_default();
                let tab = match (&comment.tab, comment.target.html) {
                    (Some((id, title)), true) => format!(", on the tab {id} (\"{}\")", near_text(title)),
                    _ => String::new(),
                };
                let near = comment.near.as_deref().map(near_text).filter(|n| comment.target.html && !n.is_empty());
                let near = near.map(|n| format!(", near \"{n}\"")).unwrap_or_default();
                format!(
                    "{}. (comment {}) On {}{at}{layer}{tab}{near}: {}",
                    index + 1,
                    comment.key,
                    design_name(&comment.target),
                    comment.text.trim()
                )
            })
            .collect();
        let html_only = comments.iter().all(|c| c.target.html);
        let mixed = !html_only && comments.iter().any(|c| c.target.html);
        let revise = if html_only {
            REVISE_ARTIFACT.to_string()
        } else if mixed {
            format!("{REVISE} {REVISE_ARTIFACT}")
        } else {
            REVISE.to_string()
        };
        let heading = if comments.len() == 1 { "A comment" } else { "Comments" };
        let on = if html_only {
            "artifact"
        } else if mixed {
            "designs and artifact"
        } else {
            "designs"
        };
        parts.push(format!("{heading} on the {on}:\n\n{}\n\n{revise}{RESOLVE_SUFFIX}", lines.join("\n")));
    }
    parts.join("\n\n")
}

/// The `DesignComment` `artifact:add-comments` records for a draft sent (`{chatId, comments}`'s items).
pub fn comment_value(draft: &Draft) -> Value {
    let mut design = json!({"id": draft.target.id, "title": draft.target.title, "version": draft.target.version});
    if draft.target.html {
        design["format"] = json!("html");
    }
    let mut value = json!({"id": draft.key, "design": design, "x": draft.x, "y": draft.y, "text": draft.text});
    if let Some(node) = &draft.node_id {
        value["nodeId"] = json!(node);
    }
    if let Some(anchor) = &draft.anchor {
        value["anchor"] = json!(anchor);
    }
    if let Some(near) = &draft.near {
        value["near"] = json!(near);
    }
    if let Some((id, title)) = &draft.tab {
        value["tab"] = json!({"id": id, "title": title});
    }
    value
}

/// `commentCursor`: the pin's own shape in `fill`, ringed in `ring`, its point (top-left) on the spot a click pins.
pub fn comment_cursor(fill: &str, ring: &str) -> String {
    let svg = |size: u32| {
        let markup = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{size}\" height=\"{size}\" viewBox=\"0 0 22 22\"><path d=\"M2 2H11A9 9 0 0 1 20 11A9 9 0 0 1 11 20A9 9 0 0 1 2 11Z\" fill=\"{fill}\" stroke=\"{ring}\" stroke-width=\"1.5\" stroke-linejoin=\"miter\"/></svg>"
        );
        let encoded: String = markup
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        format!("url(\"data:image/svg+xml,{encoded}\")")
    };
    format!("image-set({} 1x, {} 2x) 2 2, crosshair", svg(22), svg(44))
}

/// What a tab keeps of comment mode: whether it is on, the comments waiting, the bubble open and its text field.
#[derive(Default)]
pub struct Comments {
    pub commenting: bool,
    pub show_resolved: bool,
    /// The comment button's options are open (right-click).
    pub options: bool,
    pub drafts: Vec<Draft>,
    /// The pin whose bubble is open: a draft's key, or `sent:<id>`.
    pub open: Option<String>,
    editor: Option<(Entity<TextareaState>, Subscription)>,
}

impl Comments {
    /// The comments with text (what Send sends).
    pub fn written(&self) -> usize {
        self.drafts.iter().filter(|d| !d.text.trim().is_empty()).count()
    }

    pub fn draft(&self, key: &str) -> Option<&Draft> {
        self.drafts.iter().find(|d| d.key == key)
    }

    /// The open bubble's text field.
    pub fn editor(&self) -> Option<&Entity<TextareaState>> {
        self.editor.as_ref().map(|(editor, _)| editor)
    }

    /// Whether the open bubble's text field has the keyboard.
    pub fn typing(&self, window: &Window, cx: &App) -> bool {
        self.editor().is_some_and(|editor| editor.read(cx).focus_handle(cx).is_focused(window))
    }

    /// The text field's text into its draft.
    fn sync(&mut self, cx: &App) {
        let (Some(open), Some(editor)) = (self.open.as_ref(), self.editor()) else { return };
        let text = editor.read(cx).value().to_string();
        if let Some(draft) = self.drafts.iter_mut().find(|d| &d.key == open) {
            draft.text = text;
        }
    }

    /// Closes the bubble, keeping its comment for Send; one left empty is dropped.
    pub fn close(&mut self, cx: &App) {
        self.sync(cx);
        if let Some(open) = self.open.take() {
            self.drafts.retain(|d| d.key != open || !d.text.trim().is_empty());
        }
        self.editor = None;
    }

    /// Pins a new comment and opens its bubble (`onPin`): the bubble open before closes, dropped if left empty.
    pub fn pin(&mut self, draft: Draft, cx: &App) -> String {
        self.close(cx);
        let key = draft.key.clone();
        self.drafts.push(draft);
        self.open = Some(key.clone());
        key
    }

    pub fn remove(&mut self, key: &str) {
        self.drafts.retain(|d| d.key != key);
        if self.open.as_deref() == Some(key) {
            self.open = None;
            self.editor = None;
        }
    }

    /// The comments with text, taken for Send; nothing waits after.
    pub fn take_written(&mut self, cx: &App) -> Vec<Draft> {
        self.sync(cx);
        self.open = None;
        self.editor = None;
        std::mem::take(&mut self.drafts).into_iter().filter(|d| !d.text.trim().is_empty()).collect()
    }

    /// Everything waiting goes (another Chat).
    pub fn reset(&mut self) {
        *self = Self { show_resolved: self.show_resolved, ..Self::default() };
    }
}

/// A view with comment mode: the Designs canvas or the Artifact page.
pub trait CommentHost: Render + Sized {
    fn comments(&self) -> &Comments;
    fn comments_mut(&mut self) -> &mut Comments;
    /// Send: everything waiting goes to the Chat.
    fn send_feedback(&mut self, window: &mut Window, cx: &mut Context<Self>);
    /// Comments or the mode changed (the page redraws its pins).
    fn comments_changed(&mut self, cx: &mut Context<Self>) {
        cx.notify();
    }
    /// The bubble's text field closed while it had the keyboard: where the keyboard goes now.
    fn bubble_left(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {}
}

/// Opens pin `key`'s bubble; a draft's opens with its text field focused (the bubble opens to be written in).
pub fn open_bubble<V: CommentHost>(view: &mut V, key: &str, window: &mut Window, cx: &mut Context<V>) {
    if view.comments().open.as_deref() == Some(key) {
        return;
    }
    view.comments_mut().close(cx);
    view.comments_mut().open = Some(key.to_string());
    if let Some(text) = view.comments().draft(key).map(|d| d.text.clone()) {
        let state = TextArea::state("Add a comment", (2, 8), window, cx);
        if !text.is_empty() {
            state.update(cx, |state, cx| state.set_value(text, window, cx));
        }
        // Enter and Escape are the bubble's (see [`bubble`]); the text follows each change.
        let subscription = cx.subscribe_in(&state, window, |view: &mut V, _, event: &InputEvent, _, cx| {
            if let InputEvent::Change = event {
                view.comments_mut().sync(cx);
                cx.notify();
            }
        });
        let handle = state.read(cx).focus_handle(cx);
        view.comments_mut().editor = Some((state, subscription));
        window.focus(&handle, cx);
        // A press in a web page left AppKit's keys with the page: the field takes them back.
        crate::platform::webview::reclaim_keyboard(window);
    }
    view.comments_changed(cx);
}

pub fn close_bubble<V: CommentHost>(view: &mut V, window: &mut Window, cx: &mut Context<V>) {
    let typing = view.comments().typing(window, cx);
    view.comments_mut().close(cx);
    view.comments_changed(cx);
    if typing {
        view.bubble_left(window, cx);
    }
}

/// The bubble's keys (`CommentPin`'s textarea): ⌘Enter sends everything waiting (with nothing written it only
/// closes), Enter keeps the comment and closes, Shift-Enter is a new line, Escape closes. Taken before the field.
fn on_enter<V: CommentHost>(view: &mut V, action: &Enter, window: &mut Window, cx: &mut Context<V>) {
    if action.shift {
        return;
    }
    cx.stop_propagation();
    view.comments_mut().sync(cx);
    let written = view.comments().open.as_ref().and_then(|k| view.comments().draft(k)).is_some_and(|d| !d.text.trim().is_empty());
    if action.secondary && written {
        view.send_feedback(window, cx);
    } else {
        close_bubble(view, window, cx);
    }
}

fn on_escape<V: CommentHost>(view: &mut V, window: &mut Window, cx: &mut Context<V>) {
    cx.stop_propagation();
    close_bubble(view, window, cx);
}

pub fn set_commenting<V: CommentHost>(view: &mut V, on: bool, cx: &mut Context<V>) {
    if view.comments().commenting != on {
        view.comments_mut().commenting = on;
        view.comments_changed(cx);
    }
}

/// A pin's face: its number on its fill, its point the top-left corner, ringed off what is under it.
pub fn pin_face(selector: String, number: u32, fill: gpui::Rgba, ink: gpui::Rgba, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector.clone())
        .size(px(PIN))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .rounded_tl(px(0.0))
        .bg(fill)
        .shadow(theme.shadow_raised())
        .text_size(px(10.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink)
        .cursor_pointer()
        .child(number.to_string())
}

/// What an open bubble holds.
pub enum Bubble {
    /// A comment being written (its draft's key and number).
    Draft { key: String, number: u32 },
    /// A sent comment, read back: the agent's note once it resolved it.
    Sent { text: String, resolved: Option<String> },
}

/// The open bubble (`CommentPin` open): a surface whose top-left corner is the pin's point. A press in it is its own.
pub fn bubble<V: CommentHost>(view: &V, content: Bubble, theme: &Theme, cx: &mut Context<V>) -> gpui::Stateful<gpui::Div> {
    let surface = div()
        .id("comment-bubble")
        .debug_selector(|| "comment-bubble".to_string())
        .w(px(BUBBLE_WIDTH))
        .flex()
        .flex_col()
        .gap_2()
        .p_2()
        .rounded(px(10.0))
        .rounded_tl(px(3.0))
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .text_color(theme.ink)
        .cursor_default()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .on_scroll(|_, _, cx| cx.stop_propagation());
    match content {
        Bubble::Sent { text, resolved } => surface.child(div().px_1().text_step(TEXT_13).child(text)).child(match resolved {
            None => div().px_1().text_step(TEXT_11).text_color(theme.ink3).child("Sent to the agent").into_any_element(),
            Some(note) => div()
                .debug_selector(|| "comment-resolved".to_string())
                .px_1()
                .flex()
                .items_start()
                .gap_1()
                .text_step(TEXT_12)
                .text_color(theme.green_ink)
                .child(div().mt(px(2.0)).child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S12).color(theme.green_ink)))
                .child(note)
                .into_any_element(),
        }),
        Bubble::Draft { key, number } => {
            let field = view.comments().editor().map(|editor| TextArea::new(format!("comment-field-{number}"), editor));
            surface
                .capture_action(cx.listener(|view, action: &Enter, window, cx| on_enter(view, action, window, cx)))
                .capture_action(cx.listener(|view, _: &Escape, window, cx| on_escape(view, window, cx)))
                .capture_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, window, cx| {
                    let keys = &event.keystroke;
                    if keys.key == "escape" {
                        on_escape(view, window, cx);
                    } else if keys.key == "enter" && (keys.modifiers.platform || keys.modifiers.control) {
                        on_enter(view, &Enter { secondary: true, shift: false }, window, cx);
                    }
                }))
                .children(field)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .child(
                            Button::new("comment-delete", "Delete")
                                .variant(ButtonVariant::DangerGhost)
                                .size(ButtonSize::S24)
                                .selector("comment-delete")
                                .on_click(cx.listener(move |view, _: &ClickEvent, window, cx| {
                                    view.comments_mut().remove(&key);
                                    view.comments_changed(cx);
                                    view.bubble_left(window, cx);
                                })),
                        )
                        .child("Enter to keep \u{b7} \u{2318}Enter to send"),
                )
        }
    }
}

/// The comment button (`Comment01`, pressed while comment mode is on; C toggles it too) and, on a right-click, its
/// option: "Show resolved comments". `prefix` names its selectors (`designs` or `artifact`).
pub fn comment_button<V: CommentHost>(
    view: &V,
    prefix: &'static str,
    label: &'static str,
    theme: &Theme,
    cx: &mut Context<V>,
) -> AnyElement {
    let comments = view.comments();
    let (commenting, options, shown) = (comments.commenting, comments.options, comments.show_resolved);
    let button_id = SharedString::from(format!("{prefix}-comment"));
    let tip = if commenting { "Stop commenting".to_string() } else { label.to_string() };
    let button = div()
        .id(SharedString::from(format!("{prefix}-comment-wrap")))
        .tooltip(Tooltip::text(format!("{tip}. Right-click for comment options (C)")))
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(|view, _: &gpui::MouseDownEvent, _, cx| {
                cx.stop_propagation();
                let comments = view.comments_mut();
                comments.options = !comments.options;
                cx.notify();
            }),
        )
        .child(
            IconButton::new(button_id, IconName::Comment01)
                .size(IconButtonSize::S28)
                .pill()
                .pressed(commenting)
                .on_click(cx.listener(move |view, _: &ClickEvent, _, cx| set_commenting(view, !commenting, cx))),
        );
    if !options {
        return button.into_any_element();
    }
    let row = div()
        .id(SharedString::from(format!("{prefix}-show-resolved")))
        .debug_selector(move || format!("{prefix}-show-resolved"))
        .flex()
        .items_center()
        .gap_2()
        .h(px(28.0))
        .px_2()
        .rounded(px(14.0))
        .text_step(TEXT_12)
        .text_color(theme.ink)
        .cursor_pointer()
        .hover({
            let hover = theme.hover;
            move |style| style.bg(hover)
        })
        .child(div().size(px(14.0)).when(shown, |el| el.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink))))
        .child("Show resolved comments")
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(|view, _: &ClickEvent, _, cx| {
            let comments = view.comments_mut();
            comments.show_resolved = !comments.show_resolved;
            comments.options = false;
            view.comments_changed(cx);
        }));
    div().flex().flex_col().items_end().gap_1().child(button).child(row).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(html: bool) -> Draft {
        Draft {
            key: "ab12cd34".into(),
            target: Target { id: "welcome".into(), title: "Welcome".into(), version: 3, html },
            x: 0.256,
            y: 0.5,
            text: " Bigger ".into(),
            node_id: (!html).then(|| "title".into()),
            anchor: None,
            near: html.then(|| "A \"quoted\"   line".into()),
            tab: None,
        }
    }

    /// `designFeedbackMessage` and `nearText` as `packages/shared/src/artifact.ts` writes them.
    #[test]
    fn the_message_is_electrons() {
        assert_eq!(feedback_message(Some(("welcome", "Welcome", 2)), &[]), super::super::designs::choice_message("welcome", "Welcome", 2));
        assert_eq!(
            feedback_message(None, &[draft(false)]),
            "A comment on the designs:\n\n1. (comment ab12cd34) On the design \"Welcome\" (welcome, version 3), 26% across and 50% down, layer \"title\": Bigger\n\nRead the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id. Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id."
        );
        let mixed = feedback_message(None, &[draft(false), draft(true)]);
        assert!(mixed.starts_with("Comments on the designs and artifact:\n\n"), "{mixed}");
        assert!(mixed.contains(
            "2. (comment ab12cd34) On the artifact \"Welcome\" (welcome), 26% across and 50% down, near \"A quoted line\": Bigger"
        ));
        assert!(mixed.contains("Keep its id. Read the current page with artifact_read"));
        assert_eq!(near_text("  one\n two  "), "one two");
        let long = "word ".repeat(30);
        let cut = near_text(&long);
        assert!(cut.ends_with('\u{2026}') && cut.chars().count() <= 81 && !cut.contains("  "), "{cut}");
        let id = new_comment_id();
        assert!(id.len() == 8 && id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_ne!(new_comment_id(), new_comment_id());
        let cursor = comment_cursor("#007df3", "#ffffff");
        assert!(cursor.starts_with("image-set(url(\"data:image/svg+xml,%3Csvg") && cursor.ends_with(" 2x) 2 2, crosshair"), "{cursor}");
    }

    #[test]
    fn a_draft_records_as_a_design_comment() {
        let value = comment_value(&draft(false));
        assert_eq!(value["design"], json!({"id": "welcome", "title": "Welcome", "version": 3}));
        assert_eq!((value["nodeId"].as_str(), value.get("anchor")), (Some("title"), None));
        let page = comment_value(&Draft { tab: Some(("t1".into(), "Tab".into())), anchor: Some("h1:1@0,0".into()), ..draft(true) });
        assert_eq!(page["design"]["format"], json!("html"));
        assert_eq!((page["tab"].clone(), page["anchor"].clone()), (json!({"id": "t1", "title": "Tab"}), json!("h1:1@0,0")));
    }
}
