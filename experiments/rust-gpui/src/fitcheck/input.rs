//! Fit check (b): gpui-component's `Textarea` and `Input` (state in gpui-base's `InputBaseState`)
//! against the composer (`ChatComposer.tsx`, `PromptEditor.tsx`, `lib/editor-model.ts`) and the
//! spike's hand-built `workspace/chat/composer.rs`.

use gpui::{
    AppContext as _, ClipboardItem, Context, Entity, EntityInputHandler as _, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, Styled as _, VisualTestContext, Window, div, px,
};
use gpui_component::input::{InlineToken, Input, InputState, Textarea, TextareaState};

use super::harness::{draw, mount};
use crate::testing::bounds;
use crate::theme::ActiveTheme;

/// A composer-sized text area that grows from 1 to 8 rows, and a one-line field.
pub struct InputProbe {
    pub area: Entity<TextareaState>,
    pub field: Entity<InputState>,
}

impl InputProbe {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let area = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 8).placeholder("Ask anything…"));
        let field = cx.new(|cx| InputState::new(window, cx).placeholder("Search"));
        Self { area, field }
    }
}

impl Render for InputProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .size_full()
            .p_4()
            .flex()
            .flex_col()
            .gap_4()
            .bg(theme.page)
            .child(div().debug_selector(|| "textarea".into()).w(px(480.0)).child(Textarea::new(&self.area)))
            .child(div().debug_selector(|| "input".into()).w(px(320.0)).child(Input::new(&self.field)))
    }
}

fn mount_probe(cx: &mut gpui::TestAppContext) -> (Entity<InputProbe>, &mut VisualTestContext) {
    mount(cx, InputProbe::new)
}

fn focus_area(probe: &Entity<InputProbe>, cx: &mut VisualTestContext) -> Entity<TextareaState> {
    let area = probe.read_with(cx, |p, _| p.area.clone());
    area.update_in(cx, |state, window, cx| state.focus(window, cx));
    draw(cx);
    area
}

fn value(area: &Entity<TextareaState>, cx: &mut VisualTestContext) -> String {
    area.read_with(cx, |s, _| s.value().to_string())
}

#[gpui::test]
fn typing_reaches_the_textarea_and_it_grows_to_eight_rows(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    let one_row = bounds(cx, "textarea").size.height;
    cx.simulate_input("first line");
    for line in 2..=4 {
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input(&format!("line {line}"));
    }
    draw(cx);
    assert_eq!(value(&area, cx), "first line\nline 2\nline 3\nline 4");
    let four_rows = bounds(cx, "textarea").size.height;
    assert!(four_rows > one_row, "the area grew with its text ({one_row:?} to {four_rows:?})");
    for line in 5..=14 {
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input(&format!("line {line}"));
    }
    draw(cx);
    let capped = bounds(cx, "textarea").size.height;
    let row = (four_rows - one_row) / 3.0;
    assert!(capped > four_rows, "it kept growing past four rows");
    assert!(capped <= one_row + row * 7.0 + px(1.0), "it stopped at eight rows ({capped:?}, row {row:?})");
}

#[gpui::test]
fn undo_and_redo_restore_the_text(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    cx.simulate_input("hello");
    cx.simulate_keystrokes("cmd-a backspace");
    assert_eq!(value(&area, cx), "");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(value(&area, cx), "hello", "undo brings the deleted text back");
    cx.simulate_keystrokes("cmd-shift-z");
    assert_eq!(value(&area, cx), "", "redo deletes it again");
}

#[gpui::test]
fn alt_arrows_move_by_word_and_alt_backspace_deletes_one(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    cx.simulate_input("alpha beta gamma");
    cx.simulate_keystrokes("alt-left");
    assert_eq!(area.read_with(cx, |s, _| s.cursor()), "alpha beta ".len());
    cx.simulate_keystrokes("alt-left");
    assert_eq!(area.read_with(cx, |s, _| s.cursor()), "alpha ".len());
    cx.simulate_keystrokes("cmd-right alt-backspace");
    assert_eq!(value(&area, cx), "alpha beta ");
}

#[gpui::test]
fn ime_marked_text_is_replaced_by_the_committed_text(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    cx.simulate_input("Say ");
    // What AppKit's NSTextInputClient sends for Option+E (dead key), then E: a marked accent, then é.
    area.update_in(cx, |s, window, cx| s.replace_and_mark_text_in_range(None, "´", Some(1..1), window, cx));
    let marked = area.update_in(cx, |s, window, cx| s.marked_text_range(window, cx));
    assert_eq!(marked, Some(4..5), "the dead key is marked text");
    area.update_in(cx, |s, window, cx| s.replace_text_in_range(None, "é", window, cx));
    assert_eq!(value(&area, cx), "Say é");
    assert_eq!(area.update_in(cx, |s, window, cx| s.marked_text_range(window, cx)), None);
    // A composition of several characters (Japanese): marked, then committed as other text.
    area.update_in(cx, |s, window, cx| s.replace_and_mark_text_in_range(None, "にほん", Some(3..3), window, cx));
    area.update_in(cx, |s, window, cx| s.replace_text_in_range(None, "日本", window, cx));
    assert_eq!(value(&area, cx), "Say é日本");
}

#[gpui::test]
fn paste_inserts_multi_line_plain_text(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    cx.simulate_input("Before: ");
    cx.write_to_clipboard(ClipboardItem::new_string("line one\nline two".into()));
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(value(&area, cx), "Before: line one\nline two");
}

/// Composer chips (`@file`, `/skill`, `[Image #1]`) as gpui-base's atomic inline tokens: one unit for
/// the caret, backspace and undo, with their own label.
#[gpui::test]
fn atomic_tokens_delete_and_undo_as_one_unit(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let area = focus_area(&probe, cx);
    cx.simulate_input("Look at ");
    area.update_in(cx, |s, window, cx| {
        s.replace_with_token(InlineToken::new("file:src/app.rs", "@src/app.rs").with_label("app.rs"), window, cx).expect("token inserted")
    });
    cx.simulate_input(" please");
    draw(cx);
    assert_eq!(value(&area, cx), "Look at @src/app.rs please");
    let spans = area.read_with(cx, |s, _| s.tokens().iter().map(|t| (t.range(), t.token().label().to_string())).collect::<Vec<_>>());
    assert_eq!(spans, vec![("Look at ".len().."Look at @src/app.rs".len(), "app.rs".to_string())]);

    // The caret steps over the token in one move, and backspace removes all of it.
    cx.simulate_keystrokes("alt-left left");
    assert_eq!(area.read_with(cx, |s, _| s.cursor()), "Look at @src/app.rs".len());
    cx.simulate_keystrokes("left");
    assert_eq!(area.read_with(cx, |s, _| s.cursor()), "Look at ".len(), "one left arrow crosses the whole token");
    cx.simulate_keystrokes("right backspace");
    assert_eq!(value(&area, cx), "Look at  please");
    assert!(area.read_with(cx, |s, _| s.tokens().is_empty()));
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(value(&area, cx), "Look at @src/app.rs please");
    assert_eq!(area.read_with(cx, |s, _| s.tokens().len()), 1, "undo restores the token, not just its text");
}

#[gpui::test]
fn the_one_line_input_keeps_one_line(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount_probe(cx);
    let field = probe.read_with(cx, |p, _| p.field.clone());
    field.update_in(cx, |s, window, cx| s.focus(window, cx));
    cx.write_to_clipboard(ClipboardItem::new_string("one\ntwo".into()));
    cx.simulate_keystrokes("cmd-v");
    let text = field.read_with(cx, |s, _| s.value().to_string());
    assert!(!text.contains('\n'), "a pasted newline does not survive in a one-line input: {text:?}");
    // gpui-component's medium input is 32 at the bridge's rem 16; DESIGN.md's inputs are 36 (U-04 has
    // 28, 32 and 36), which `Input::h(CONTROL_LG)` gives (the `controls` gallery page).
    assert_eq!(bounds(cx, "input").size.height, crate::theme::CONTROL_MD);
}
