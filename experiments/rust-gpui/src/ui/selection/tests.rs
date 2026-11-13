//! The copy serialisation against what Chromium writes for the desktop's DOM (see `plain.rs`).

use super::{Flavor, Plain, join, plain_text};
use crate::ui::markdown::plain_text_source;

fn all(source: &str) -> String {
    plain_text(source, 0..source.len(), Flavor::Markdown).text
}

const RICH: &str = "# Title here\n\nFirst paragraph with **bold**, `code` and a [link](https://x.y).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted line\n\n```Rust title\nfn main() {\n    println!(\"hi\");\n}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 |   |\n\nLast paragraph.";

#[test]
fn a_whole_message_copies_as_chromium_serialises_its_blocks() {
    assert_eq!(
        all(RICH),
        "Title here\nFirst paragraph with bold, code and a link.\n\none\ntwo\nnested\nfirst\nsecond\nquoted line\n\nrust\nfn main() {\n    println!(\"hi\");\n}\nA\tB\n1\t2\n3\t\nLast paragraph."
    );
}

#[test]
fn paragraphs_are_followed_by_a_blank_line_and_headings_are_not() {
    assert_eq!(all("One.\n\nTwo.\n\n## Head\n\nThree."), "One.\n\nTwo.\n\nHead\nThree.");
    assert_eq!(plain_text("One.\n\nTwo.", 0..10, Flavor::Markdown).trailing_breaks, 2);
    assert_eq!(plain_text("- a\n- b", 0..7, Flavor::Markdown).trailing_breaks, 1);
}

#[test]
fn whitespace_collapses_in_flow_and_soft_breaks_are_spaces() {
    assert_eq!(all("a   b\nc  \n\n  d"), "a b c\n\nd");
    assert_eq!(all("line one  \nline two"), "line one\nline two", "two trailing spaces are a hard break");
    assert_eq!(all("`a  b` and  *c*"), "a b and c");
}

#[test]
fn loose_lists_hold_paragraphs() {
    assert_eq!(all("- one\n\n- two\n\nafter"), "one\n\ntwo\n\nafter");
}

#[test]
fn task_markers_and_list_markers_are_left_out() {
    assert_eq!(all("- [x] done\n- [ ] todo\n\n3. third\n4. fourth"), "done\ntodo\nthird\nfourth");
}

#[test]
fn code_blocks_keep_their_text_and_name_their_language() {
    assert_eq!(all("```\nplain\n\n  kept\n```"), "text\nplain\n\n  kept");
    assert_eq!(all("    indented"), "text\nindented");
    assert_eq!(all("```TS\nconst a = 1;\n```\nafter"), "ts\nconst a = 1;\nafter");
}

#[test]
fn routed_fences_copy_their_content() {
    assert_eq!(all("```markdown\n# Nested\n\n**bold** text\n```"), "Nested\nbold text");
    assert_eq!(all("```mermaid\ngraph TD\nA-->B\n```"), "graph TD\nA-->B");
}

#[test]
fn images_copy_as_the_link_the_desktop_shows() {
    assert_eq!(all("see ![a cat](cat.png) here"), "see a cat here");
    assert_eq!(all("![](cat.png)"), "cat.png");
}

#[test]
fn raw_html_is_text() {
    assert_eq!(all("<div>\nhi\n</div>\n\nafter"), "<div> hi </div>\nafter");
}

#[test]
fn a_range_copies_only_what_it_covers() {
    let source = "Alpha beta gamma.\n\nDelta epsilon.";
    let beta = source.find("beta").unwrap();
    let eps = source.find("epsilon").unwrap();
    assert_eq!(plain_text(source, beta..eps + 3, Flavor::Markdown).text, "beta gamma.\n\nDelta eps");
    assert_eq!(plain_text(source, beta..beta + 4, Flavor::Markdown).text, "beta");
    assert_eq!(plain_text(source, 3..3, Flavor::Markdown), Plain::default(), "a caret copies nothing");
}

#[test]
fn a_range_inside_a_code_block_leaves_out_its_label() {
    let source = "Intro.\n\n```rust\nlet a = 1;\nlet b = 2;\n```";
    let from = source.find("let b").unwrap();
    assert_eq!(plain_text(source, from..source.len(), Flavor::Markdown).text, "let b = 2;");
    let intro = source.find("tro").unwrap();
    assert_eq!(plain_text(source, intro..from + 3, Flavor::Markdown).text, "tro.\n\nrust\nlet a = 1;\nlet");
}

#[test]
fn a_range_across_table_cells_keeps_the_tabs() {
    let source = "| A | B |\n|---|---|\n| one | two |";
    let from = source.find("ne").unwrap();
    assert_eq!(plain_text(source, from..source.len(), Flavor::Markdown).text, "ne\ttwo");
}

#[test]
fn escapes_and_entities_copy_their_meaning() {
    assert_eq!(all(r"\*not bold\* &amp; 1 &lt; 2"), "*not bold* & 1 < 2");
}

#[test]
fn user_messages_keep_their_spaces_and_lines() {
    let typed = "first  line\n    indented *star*\n\n\nafter blanks";
    let source = plain_text_source(typed);
    let copied = plain_text(&source, 0..source.len(), Flavor::PreWrap).text;
    assert_eq!(copied, "first  line\n    indented *star*\n\nafter blanks", "runs of blank lines are one paragraph break");
}

#[test]
fn messages_join_with_the_newlines_their_last_block_asks_for() {
    let answer = plain_text("Answer.", 0..7, Flavor::Markdown);
    let list = plain_text("- item", 0..6, Flavor::Markdown);
    let user = Plain::block("Typed");
    assert_eq!(join([user.clone(), answer.clone(), list, user.clone()]), "Typed\nAnswer.\n\nitem\nTyped");
    assert_eq!(join([Plain::default(), user.clone(), Plain::default(), user]), "Typed\nTyped", "empty parts take no room");
}
