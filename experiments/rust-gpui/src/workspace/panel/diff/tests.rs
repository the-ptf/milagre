//! The diff view in the headless test platform: the row model, the held file, large and binary files, folding,
//! layouts, line comments from drag to send, outdated comments, code selection and copy, and the 10,000-line timing.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

use gpui::{Entity, TestAppContext, VisualTestContext, px};

use super::comments::{ChangesMode, DiffSide, Target};
use super::rows::{Body, DiffLayout, FileRows, Row, diff_ranges, file_rows};
use super::{DiffEvent, DiffSource, DiffView, ThreadAnchor};
use crate::logic::diff::git::{DiffFileEntry, DiffFileResult, DiffStatus};
use crate::logic::diff::parse_patch;
use crate::testing;

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn entry(path: &str, added: u32, removed: u32) -> DiffFileEntry {
    DiffFileEntry { path: path.into(), old_path: None, status: DiffStatus::Modified, added, removed, binary: false, untracked: false }
}

/// A modified file: `n` context lines around a changed pair, starting at line `at`.
fn small_patch(at: u32, word: &str) -> String {
    format!(
        "@@ -{at},5 +{at},5 @@\n const a = 1;\n const b = 2;\n-const value = \"{word}\";\n+const value = \"{word}-new\";\n const c = 3;\n const d = 4;\n"
    )
}

/// `lines` added lines in one hunk: the 10,000-line file.
fn big_patch(lines: usize) -> String {
    let mut out = format!("@@ -0,0 +1,{lines} @@\n");
    for i in 0..lines {
        out.push_str(&format!("+export const value{i} = compute({i}, \"label {i}\") // line {i}\n"));
    }
    out
}

struct Files(Vec<(DiffFileEntry, String)>);

impl Files {
    fn standard() -> Self {
        let mut files: Vec<(DiffFileEntry, String)> =
            (0..12).map(|i| (entry(&format!("src/file{i:02}.ts"), 1, 1), small_patch(10 + i, &format!("w{i}")))).collect();
        let mut binary = entry("assets/logo.png", 0, 0);
        binary.binary = true;
        files.insert(3, (binary, String::new()));
        files.push((entry("src/huge.ts", 4000, 0), big_patch(4000)));
        Self(files)
    }

    fn source(&self, chat: &str) -> DiffSource {
        let patches: HashMap<String, String> = self.0.iter().map(|(e, p)| (e.path.clone(), p.clone())).collect();
        DiffSource {
            chat: chat.to_string().into(),
            mode: ChangesMode::Uncommitted,
            base: None,
            files: self.0.iter().map(|(e, _)| e.clone()).collect(),
            loader: Rc::new(move |entry: &DiffFileEntry| {
                patches.get(&entry.path).map(|patch| DiffFileResult { patch: patch.clone(), binary: entry.binary, too_large: false })
            }),
            back_label: "Fix the intro".into(),
            review: false,
            comments: true,
        }
    }
}

fn mount(cx: &mut TestAppContext) -> (Entity<DiffView>, &mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, |_, cx| DiffView::new(cx));
    draw(cx);
    (view, cx)
}

fn open(view: &Entity<DiffView>, cx: &mut VisualTestContext, files: &Files, target: Option<&str>) {
    let source = files.source("chat-1");
    view.update(cx, |v, cx| v.set_source(source, target, cx));
    draw(cx);
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

// --- the row model ---------------------------------------------------------------------------------------------

#[test]
fn a_file_is_its_header_hunks_lines_slots_and_end() {
    let hunks = parse_patch("@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n+C\n d\n");
    let slots = HashSet::from([(0, 3)]);
    let threads = HashSet::from([(0, 0)]);
    let input = |layout, collapsed| FileRows {
        file: 2,
        collapsed,
        layout,
        body: Body::Hunks(&hunks),
        slots: &slots,
        threads: &threads,
        stale: true,
        loose: false,
    };
    let unified = file_rows(&input(DiffLayout::Unified, false));
    assert_eq!(unified.first(), Some(&Row::Header { file: 2 }));
    assert_eq!(unified.last(), Some(&Row::End { file: 2 }));
    assert_eq!(unified.iter().filter(|r| matches!(r, Row::Line { .. })).count(), 6);
    let at = unified.iter().position(|r| *r == Row::Line { file: 2, hunk: 0, line: 3 }).unwrap();
    assert_eq!(unified[at + 1], Row::Slot { file: 2, hunk: 0, line: 3 }, "a slot sits under its line");
    let first = unified.iter().position(|r| *r == Row::Line { file: 2, hunk: 0, line: 0 }).unwrap();
    assert_eq!(unified[first + 1], Row::Threads { file: 2, hunk: 0, line: 0 }, "threads under theirs");
    assert!(unified.contains(&Row::Stale { file: 2 }));

    let split = file_rows(&input(DiffLayout::Split, false));
    let pairs: Vec<(Option<usize>, Option<usize>)> =
        split.iter().filter_map(|r| if let Row::Split { left, right, .. } = r { Some((*left, *right)) } else { None }).collect();
    assert_eq!(pairs, vec![(Some(0), Some(0)), (Some(1), Some(3)), (Some(2), Some(4)), (Some(5), Some(5))]);
    assert_eq!(split.iter().filter(|r| matches!(r, Row::Threads { .. })).count(), 1, "a context row's threads come once");
    let collapsed = file_rows(&input(DiffLayout::Unified, true));
    assert_eq!(collapsed, vec![Row::Header { file: 2 }, Row::End { file: 2 }]);
}

#[test]
fn the_splice_is_the_changed_middle() {
    let a = [Row::Orphans, Row::Header { file: 0 }, Row::Message { file: 0 }, Row::End { file: 0 }, Row::Tail];
    let b = [
        Row::Orphans,
        Row::Header { file: 0 },
        Row::Hunk { file: 0, hunk: 0 },
        Row::Line { file: 0, hunk: 0, line: 0 },
        Row::End { file: 0 },
        Row::Tail,
    ];
    assert_eq!(diff_ranges(&a, &b), Some((2..3, 2..4)));
    assert_eq!(diff_ranges(&a, &a), None);
    assert_eq!(diff_ranges(&a[..2], &a), Some((2..2, 2..5)));
}

// --- the view --------------------------------------------------------------------------------------------------

#[gpui::test]
fn the_picked_file_is_held_at_the_top_while_files_around_it_load(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let files = Files::standard();
    open(&view, cx, &files, Some("src/file07.ts"));
    let (top, start, holding) = view.read_with(cx, |v, _| {
        (v.list_state().logical_scroll_top(), v.file_range("src/file07.ts").unwrap().start, v.holding().map(str::to_string))
    });
    assert_eq!((top.item_ix, top.offset_in_item), (start, px(0.0)), "the picked file's header is the top row");
    assert_eq!(holding.as_deref(), Some("src/file07.ts"));
    assert!(view.read_with(cx, |v, _| v.is_loaded("src/file07.ts") && v.is_loaded("src/file08.ts")));
    assert!(drawn(cx, "diff-header-src/file07.ts"));
    // Files above it load later (a scroll brings them near); the held header keeps its place as they grow.
    view.update(cx, |v, cx| {
        v.release_hold();
        v.list_state().scroll_by(px(-200.0));
        cx.notify();
    });
    draw(cx);
    let start_after = view.read_with(cx, |v, _| v.file_range("src/file07.ts").unwrap().start);
    assert!(start_after >= start, "files above grew from their loading row");
    assert_eq!(
        view.read_with(cx, |v, _| v.visible_path().map(str::to_string)).as_deref(),
        Some("src/file06.ts"),
        "the pinned header is the one above"
    );
}

#[gpui::test]
fn binary_and_large_files_say_so_and_a_large_one_shows_on_request(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let files = Files::standard();
    open(&view, cx, &files, Some("assets/logo.png"));
    assert!(drawn(cx, "diff-message-assets/logo.png"));
    open(&view, cx, &files, Some("src/huge.ts"));
    assert!(drawn(cx, "diff-message-src/huge.ts"), "4,000 changed lines wait for Show diff");
    assert!(!view.read_with(cx, |v, _| v.is_loaded("src/huge.ts")));
    view.update(cx, |v, cx| v.show_large("src/huge.ts", cx));
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.is_loaded("src/huge.ts")));
    assert!(!drawn(cx, "diff-message-src/huge.ts"));
    let rows = view.read_with(cx, |v, _| v.file_range("src/huge.ts").unwrap().len());
    assert_eq!(rows, 4000 + 3, "header, hunk header, its lines, end");
}

#[gpui::test]
fn the_header_folds_its_file(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file01.ts"));
    let before = view.read_with(cx, |v, _| v.file_range("src/file01.ts").unwrap().len());
    let fold = testing::bounds(cx, "diff-fold-src/file01.ts");
    cx.simulate_click(fold.center(), gpui::Modifiers::none());
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.is_collapsed("src/file01.ts")));
    assert_eq!(view.read_with(cx, |v, _| v.file_range("src/file01.ts").unwrap().len()), 2);
    assert!(before > 2);
}

#[gpui::test]
fn split_keeps_the_place_and_wrap_is_remembered_for_every_diff(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file05.ts"));
    let header = testing::bounds(cx, "diff-layout-split");
    cx.simulate_click(header.center(), gpui::Modifiers::none());
    draw(cx);
    let (layout, top, start) =
        view.read_with(cx, |v, _| (v.layout(), v.list_state().logical_scroll_top().item_ix, v.file_range("src/file05.ts").unwrap().start));
    assert_eq!(layout, DiffLayout::Split);
    assert_eq!(top, start, "the same file stays at the top");
    assert!(view.read_with(cx, |v, _| v.rows().iter().any(|r| matches!(r, Row::Split { .. }))));
    let other = gpui::AppContext::new(cx, DiffView::new);
    assert_eq!(other.read_with(cx, |v, _| v.layout()), DiffLayout::Split, "a new diff takes the session's layout");
}

#[gpui::test]
fn a_dragged_range_takes_a_comment_that_sits_under_it_and_goes_to_the_chat(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let files = Files::standard();
    open(&view, cx, &files, Some("src/file02.ts"));
    let path = "src/file02.ts".to_string();
    let target = |line| Target { path: path.clone(), hunk: 0, line, side: None };
    // Press the "+" on the removed row, drag down to the added one, let go.
    cx.update(|window, cx| view.update(cx, |v, cx| v.start_comment(target(2), false, true, window, cx)));
    view.update(cx, |v, cx| v.drag_comment(target(3), cx));
    assert_eq!(view.read_with(cx, |v, _| v.draft().map(|d| (d.lo(), d.hi(), d.dragging))), Some((2, 3, true)));
    assert!(!view.read_with(cx, |v, _| v.rows().iter().any(|r| matches!(r, Row::Slot { .. }))), "no editor while dragging");
    cx.update(|window, cx| view.update(cx, |v, cx| v.finish_drag(window, cx)));
    draw(cx);
    assert!(drawn(cx, "diff-comment-editor"));
    cx.update(|window, cx| view.update(cx, |v, cx| v.set_editor_text("Use the constant.", window, cx)));
    cx.update(|window, cx| view.update(cx, |v, cx| v.save_comment(window, cx)));
    draw(cx);
    let comments = view.read_with(cx, |v, _| v.comment_views());
    assert_eq!(comments.len(), 1);
    assert_eq!((comments[0].comment.start, comments[0].comment.end, comments[0].outdated), (14, 14, false));
    assert_eq!(comments[0].comment.snippet, vec!["-const value = \"w2\";".to_string(), "+const value = \"w2-new\";".to_string()]);
    assert!(view.read_with(cx, |v, _| v.rows().contains(&Row::Slot { file: 2, hunk: 0, line: 3 })), "under its last row");
    assert!(drawn(cx, "diff-send"));
    // Send: one message, then the comment is gone.
    let events = Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    let _sub = cx.update(|_, cx| cx.subscribe(&view, move |_, event: &DiffEvent, _| seen.borrow_mut().push(event.clone())));
    let send = testing::bounds(cx, "diff-send");
    cx.simulate_click(send.center(), gpui::Modifiers::none());
    draw(cx);
    let sent = events.borrow().iter().find_map(|e| if let DiffEvent::Send(m) = e { Some(m.clone()) } else { None }).expect("a message");
    assert!(sent.starts_with("Review comments on the diff (uncommitted changes):\n\n1. src/file02.ts, line 14 (new):\n```typescript\n"));
    assert!(sent.ends_with("```\nUse the constant."));
    assert!(view.read_with(cx, |v, _| v.comment_views().is_empty()));
    assert!(!drawn(cx, "diff-send"));
}

#[gpui::test]
fn a_comment_goes_outdated_when_its_rows_change_and_orphaned_when_its_file_leaves(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let files = Files::standard();
    open(&view, cx, &files, Some("src/file04.ts"));
    view.update(cx, |v, cx| v.seed_comment("src/file04.ts", 0, 2, 3, None, "first", cx));
    draw(cx);
    assert!(!view.read_with(cx, |v, _| v.comment_views()[0].outdated));
    // The file's patch changes under the comment.
    let mut changed = Files::standard();
    changed.0[5].1 = small_patch(14, "other");
    open(&view, cx, &changed, Some("src/file04.ts"));
    let views = view.read_with(cx, |v, _| v.comment_views());
    assert!(views[0].outdated);
    assert!(view.read_with(cx, |v, _| v.rows().iter().any(|r| matches!(r, Row::Stale { .. }))), "below the hunks");
    assert!(view.read_with(cx, |v, _| v.sendable().is_empty()), "an outdated comment is not sent");
    // The file leaves the diff: the comment gathers at the top.
    let mut gone = Files::standard();
    gone.0.retain(|(e, _)| e.path != "src/file04.ts");
    open(&view, cx, &gone, None);
    assert_eq!(view.read_with(cx, |v, _| v.rows().first().copied()), Some(Row::Orphans));
    assert!(drawn(cx, "diff-orphans"));
    assert!(drawn(cx, "diff-comment-outdated"));
}

#[gpui::test]
fn editing_and_deleting_a_comment(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file01.ts"));
    view.update(cx, |v, cx| v.seed_comment("src/file01.ts", 0, 3, 3, None, "before", cx));
    draw(cx);
    let id = view.read_with(cx, |v, _| v.comment_views()[0].comment.id.clone());
    cx.update(|window, cx| view.update(cx, |v, cx| v.edit_comment(&id, window, cx)));
    draw(cx);
    assert_eq!(view.read_with(cx, |v, cx| v.editor_text(cx)), "before");
    cx.update(|window, cx| view.update(cx, |v, cx| v.set_editor_text("after", window, cx)));
    cx.update(|window, cx| view.update(cx, |v, cx| v.save_comment(window, cx)));
    assert_eq!(view.read_with(cx, |v, _| v.comment_views()[0].comment.body.clone()), "after");
    view.update(cx, |v, cx| v.delete_comment(&id, cx));
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.comment_views().is_empty()));
    assert!(!view.read_with(cx, |v, _| v.rows().iter().any(|r| matches!(r, Row::Slot { .. }))));
}

#[gpui::test]
fn split_comments_keep_their_column(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file01.ts"));
    view.update(cx, |v, cx| v.set_layout(DiffLayout::Split, cx));
    let target = |line| Target { path: "src/file01.ts".into(), hunk: 0, line, side: Some(DiffSide::Old) };
    cx.update(|window, cx| view.update(cx, |v, cx| v.start_comment(target(0), false, true, window, cx)));
    view.update(cx, |v, cx| v.drag_comment(target(3), cx));
    cx.update(|window, cx| view.update(cx, |v, cx| v.finish_drag(window, cx)));
    cx.update(|window, cx| view.update(cx, |v, cx| v.set_editor_text("old side", window, cx)));
    cx.update(|window, cx| view.update(cx, |v, cx| v.save_comment(window, cx)));
    let c = view.read_with(cx, |v, _| v.comment_views()[0].comment.clone());
    assert_eq!((c.side, c.start, c.end), (DiffSide::Old, 11, 13));
    assert_eq!(c.snippet.len(), 3, "the new column's row between is left out");
    view.update(cx, |v, cx| v.set_layout(DiffLayout::Unified, cx));
}

#[gpui::test]
fn pr_threads_sit_under_their_lines_and_the_rest_under_the_file(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file00.ts"));
    let threads = vec![
        ThreadAnchor { id: "t1".into(), path: "src/file00.ts".into(), line: Some(12), side: DiffSide::New },
        ThreadAnchor { id: "t2".into(), path: "src/file00.ts".into(), line: Some(12), side: DiffSide::Old },
        ThreadAnchor { id: "t3".into(), path: "src/file00.ts".into(), line: Some(900), side: DiffSide::New },
    ];
    let renderer: super::ThreadRenderer = Rc::new(|ids: &[String], _: &mut gpui::Window, _: &mut gpui::App| {
        use gpui::{InteractiveElement, IntoElement, ParentElement, div};
        div()
            .children(ids.iter().map(|id| {
                div()
                    .debug_selector({
                        let id = id.clone();
                        move || format!("thread-{id}")
                    })
                    .child(id.clone())
            }))
            .into_any_element()
    });
    view.update(cx, |v, cx| v.set_threads(threads, Some(renderer), cx));
    draw(cx);
    let rows = view.read_with(cx, |v, _| v.rows().to_vec());
    let at = |row: Row| rows.iter().position(|r| *r == row).unwrap();
    assert_eq!(
        at(Row::Threads { file: 0, hunk: 0, line: 3 }),
        at(Row::Line { file: 0, hunk: 0, line: 3 }) + 1,
        "RIGHT 12 is the added line"
    );
    assert_eq!(
        at(Row::Threads { file: 0, hunk: 0, line: 2 }),
        at(Row::Line { file: 0, hunk: 0, line: 2 }) + 1,
        "LEFT 12 is the removed line"
    );
    assert!(rows.contains(&Row::Loose { file: 0 }));
    assert!(drawn(cx, "thread-t1") && drawn(cx, "thread-t3"));
}

#[gpui::test]
fn a_drag_in_the_code_selects_lines_and_cmd_c_copies_them(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, &Files::standard(), Some("src/file00.ts"));
    let (first, last) = view.read_with(cx, |v, _| {
        let rows = v.rows();
        (
            rows.iter().position(|r| *r == Row::Line { file: 0, hunk: 0, line: 0 }).unwrap(),
            rows.iter().position(|r| *r == Row::Line { file: 0, hunk: 0, line: 2 }).unwrap(),
        )
    });
    // A real drag from the first row's text to the third's.
    let a = testing::bounds(cx, testing::leak(format!("diff-row-{first}")));
    let b = testing::bounds(cx, testing::leak(format!("diff-row-{last}")));
    let start = gpui::point(a.left() + px(super::render::GUTTER_W * 2.0 + super::render::MARKER_W + 1.0), a.center().y);
    let end = gpui::point(b.right() - px(4.0), b.center().y);
    cx.simulate_mouse_down(start, gpui::MouseButton::Left, gpui::Modifiers::none());
    cx.simulate_mouse_move(end, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    cx.simulate_mouse_up(end, gpui::MouseButton::Left, gpui::Modifiers::none());
    draw(cx);
    let text = view.read_with(cx, |v, _| v.selected_text());
    assert_eq!(text.as_deref(), Some("const a = 1;\nconst b = 2;\nconst value = \"w0\";"));
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), text.as_deref());
}

// --- timing ----------------------------------------------------------------------------------------------------

/// The 10,000-line patch: open it held at the top, then scroll it a screen at a time to the end and back, drawing
/// every step. Run with `cargo test --release -- --ignored --nocapture ten_thousand` for the numbers in README.md.
#[gpui::test]
#[ignore]
fn ten_thousand_line_patch_timing(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let files = Files(vec![(entry("src/generated.ts", 10_000, 0), big_patch(10_000)), (entry("src/after.ts", 1, 1), small_patch(1, "x"))]);
    let frame = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        })
    };
    let opened = Instant::now();
    let source = files.source("chat-1");
    view.update(cx, |v, cx| {
        v.set_source(source, Some("src/generated.ts"), cx);
        v.show_large("src/generated.ts", cx);
    });
    frame(cx);
    let open_ms = opened.elapsed().as_secs_f64() * 1000.0;
    let parse = Instant::now();
    cx.run_until_parked();
    let parse_ms = parse.elapsed().as_secs_f64() * 1000.0;
    let mut frames = Vec::new();
    let mut deepest = 0;
    let mut background = 0.0;
    for step in 0..240 {
        let delta = if step < 200 { px(-600.0) } else { px(2400.0) };
        view.update(cx, |v, cx| {
            v.list_state().scroll_by(-delta);
            cx.notify();
        });
        // The frame: what the main thread does. Background parses run on another thread in the app (here they run
        // between frames, untimed).
        let started = Instant::now();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });
        frames.push(started.elapsed().as_secs_f64() * 1000.0);
        let parse = Instant::now();
        cx.run_until_parked();
        background += parse.elapsed().as_secs_f64() * 1000.0;
        let top = view.read_with(cx, |v, _| v.list_state().logical_scroll_top().item_ix);
        deepest = deepest.max(top);
    }
    let mut sorted = frames.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| sorted[((sorted.len() as f64 - 1.0) * p) as usize];
    let stats = view.read_with(cx, |v, _| v.stats());
    eprintln!(
        "timing: open+show 10,000 lines {open_ms:.1} ms (first frame; whole-file parse {parse_ms:.0} ms in the background); deepest row {deepest}; {} scroll frames: median {:.2} ms, p95 {:.2} ms, max {:.2} ms; {} row renders ({:.1}/frame), {} run lookups; later background parsing {background:.0} ms",
        frames.len(),
        pct(0.5),
        pct(0.95),
        pct(1.0),
        stats.row_renders,
        stats.row_renders as f64 / (frames.len() + 2) as f64,
        stats.highlighted_lines
    );
    assert!(deepest > 5000, "the scroll went deep into the file");
}

/// Syntax runs take their colours from the live theme's `syntax` when they are painted, so a theme switch recolours
/// a highlighted line without parsing it again.
#[test]
fn syntax_runs_recolour_with_the_theme_without_a_new_parse() {
    use super::render::styled_runs;
    use crate::settings::appearance::{model::palette_for, palette::Scheme};
    use crate::ui::markdown::highlight::Bucket;
    let runs = vec![(0..5, Bucket::Keyword), (5..9, Bucket::String)];
    let paint = |theme: &crate::theme::Theme| {
        styled_runs(9, Some(&runs), &[], None, &theme.syntax, theme.diff_add_word.into(), theme.accent_tint.into())
    };
    let blue = crate::theme::Theme::dark();
    let gruvbox = palette_for("gruvbox", Scheme::Dark, None).to_theme(Scheme::Dark);
    let (a, b) = (paint(&blue), paint(&gruvbox));
    assert_eq!(a[0].1.color, Some(blue.syntax.keyword.into()));
    assert_eq!(b[0].1.color, Some(gruvbox.syntax.keyword.into()));
    assert_ne!(a[0].1.color, b[0].1.color);
    assert_eq!(a.len(), b.len(), "the same runs, only recoloured");
}
