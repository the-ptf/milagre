//! Vectors ported from `diff-parse.test.ts`, `diff-layout.test.ts`, `diff-tree.test.ts` and `git-diff.test.ts`,
//! plus cases for what the TS leaves untested (UTF-16 offsets, binary files, empty files, CRLF, locale order).

use super::codes::{GitCode, git_message};
use super::collate::locale_compare;
use super::git::*;
use super::layout::{WordChanges, utf16_range_to_bytes};
use super::parse::{LineKind, count_hunks};
use super::tree::{Counted, DiffTreeNode};
use super::*;
use std::cmp::Ordering;

const PATCH: &str = "diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,4 @@ function x
 one
-two
+TWO
 three
 four
@@ -20 +20,2 @@
 keep
+extra
";

type Row = (LineKind, String, Option<u32>, Option<u32>);

fn lines(hunk: &DiffHunk) -> Vec<Row> {
    hunk.lines.iter().map(|l| (l.kind, l.text.clone(), l.old_number, l.new_number)).collect()
}

fn kinds(hunk: &DiffHunk) -> Vec<LineKind> {
    hunk.lines.iter().map(|l| l.kind).collect()
}

fn texts(hunk: &DiffHunk) -> Vec<&str> {
    hunk.lines.iter().map(|l| l.text.as_str()).collect()
}

#[test]
fn numbers_lines_on_both_sides_and_keeps_hunk_metadata() {
    let hunks = parse_patch(PATCH);
    assert_eq!(hunks.len(), 2);
    let h = &hunks[0];
    assert_eq!((h.old_start, h.old_lines, h.new_start, h.new_lines), (1, 4, 1, 4));
    assert_eq!(h.header, "@@ -1,4 +1,4 @@ function x");
    let row = |kind, text: &str, o, n| (kind, text.to_string(), o, n);
    assert_eq!(
        lines(h),
        vec![
            row(LineKind::Context, "one", Some(1), Some(1)),
            row(LineKind::Remove, "two", Some(2), None),
            row(LineKind::Add, "TWO", None, Some(2)),
            row(LineKind::Context, "three", Some(3), Some(3)),
            row(LineKind::Context, "four", Some(4), Some(4)),
        ]
    );
}

#[test]
fn a_header_without_counts_means_one_line() {
    let hunks = parse_patch(PATCH);
    let second = &hunks[1];
    assert_eq!((second.old_lines, second.new_lines), (1, 2));
    let numbers: Vec<_> = second.lines.iter().map(|l| l.new_number).collect();
    assert_eq!(numbers, vec![Some(20), Some(21)]);
}

#[test]
fn ignores_the_no_newline_marker() {
    let hunks = parse_patch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n");
    assert_eq!(kinds(&hunks[0]), vec![LineKind::Remove, LineKind::Add]);
}

#[test]
fn tolerates_crlf_without_leaking_the_carriage_return() {
    let hunks = parse_patch("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    assert_eq!(texts(&hunks[0]), vec!["a", "b", "c"]);
    assert_eq!(hunks[0].header, "@@ -1,2 +1,2 @@");
}

#[test]
fn a_removed_line_that_looks_like_a_file_header_stays_a_removal() {
    let hunks = parse_patch("@@ -1,2 +1,1 @@\n--- not a header\n keep\n");
    let got: Vec<_> = hunks[0].lines.iter().map(|l| (l.kind, l.text.as_str())).collect();
    assert_eq!(got, vec![(LineKind::Remove, "-- not a header"), (LineKind::Context, "keep")]);
}

#[test]
fn an_empty_context_line_that_lost_its_space_is_still_context() {
    let hunks = parse_patch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
    assert_eq!(kinds(&hunks[0]), vec![LineKind::Context, LineKind::Context, LineKind::Remove, LineKind::Add]);
}

#[test]
fn binary_notices_and_empty_patches_have_no_hunks() {
    assert!(parse_patch("").is_empty());
    assert!(parse_patch("diff --git a/x b/x\nBinary files a/x and b/x differ\n").is_empty());
}

#[test]
fn parsing_edge_cases_the_ts_does_not_test() {
    // A new file: old side empty, every line an addition numbered from 1.
    let hunks = parse_patch("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    assert_eq!((hunks[0].old_start, hunks[0].old_lines, hunks[0].new_lines), (0, 0, 2));
    assert_eq!(count_hunks(&hunks), (2, 0));
    // A deleted file.
    let hunks = parse_patch("@@ -1,2 +0,0 @@\n-one\n-two\n");
    assert_eq!(count_hunks(&hunks), (0, 2));
    // An empty file patch has a header only, or none.
    assert!(parse_patch("diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n").is_empty());
    // Lines past the header counts are dropped, and the next header then opens a new hunk.
    let hunks = parse_patch("@@ -1 +1 @@\n-a\n+b\n+extra\n@@ -5 +5 @@\n");
    assert_eq!(hunks.len(), 2);
    assert_eq!(texts(&hunks[0]), vec!["a", "b"]);
    // A header while the previous hunk is still open is dropped as a line, not a new hunk.
    let hunks = parse_patch("@@ -1,2 +1,2 @@\n a\n@@ -5 +5 @@\n b\n");
    assert_eq!(hunks.len(), 1);
    assert_eq!(texts(&hunks[0]), vec!["a", "b"]);
    // A rename header before the hunk, and a line that starts with a multi-byte character, are not lines.
    let hunks = parse_patch("rename from a\nrename to b\n@@ -1 +1 @@\n-é\n+ü\n");
    assert_eq!(texts(&hunks[0]), vec!["é", "ü"]);
    // A "no newline" marker with CRLF.
    let hunks = parse_patch("@@ -1 +1 @@\r\n-a\r\n\\ No newline at end of file\r\n+b\r\n");
    assert_eq!(texts(&hunks[0]), vec!["a", "b"]);
    // Counts that do not close leave the hunk open at the end of the patch.
    let hunks = parse_patch("@@ -1,5 +1,5 @@\n a\n");
    assert_eq!(hunks[0].lines.len(), 1);
}

// ---- layout ------------------------------------------------------------------------------------------------------

fn rows(patch: &str) -> Vec<(Option<String>, Option<String>)> {
    let hunks = parse_patch(patch);
    split_rows(&hunks[0]).iter().map(|r| (r.left.map(|l| l.text.clone()), r.right.map(|l| l.text.clone()))).collect()
}

fn pair(l: Option<&str>, r: Option<&str>) -> (Option<String>, Option<String>) {
    (l.map(str::to_string), r.map(str::to_string))
}

#[test]
fn pairs_removals_with_additions_row_by_row() {
    assert_eq!(
        rows("@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n+C\n"),
        vec![pair(Some("a"), Some("a")), pair(Some("b"), Some("B")), pair(Some("c"), Some("C"))]
    );
}

#[test]
fn fills_the_shorter_side_with_empty_cells() {
    assert_eq!(rows("@@ -1,3 +1,2 @@\n-a\n-b\n-c\n+A\n"), vec![pair(Some("a"), Some("A")), pair(Some("b"), None), pair(Some("c"), None)]);
    assert_eq!(rows("@@ -1 +1,3 @@\n-a\n+A\n+B\n+C\n"), vec![pair(Some("a"), Some("A")), pair(None, Some("B")), pair(None, Some("C"))]);
}

#[test]
fn pure_additions_and_context_never_pair_across_blocks() {
    assert_eq!(rows("@@ -1,2 +1,3 @@\n a\n+x\n b\n"), vec![pair(Some("a"), Some("a")), pair(None, Some("x")), pair(Some("b"), Some("b"))]);
}

#[test]
fn separate_change_blocks_pair_independently() {
    assert_eq!(
        rows("@@ -1,4 +1,4 @@\n-a\n+A\n m\n-b\n+B\n"),
        vec![pair(Some("a"), Some("A")), pair(Some("m"), Some("m")), pair(Some("b"), Some("B"))]
    );
}

#[test]
fn a_removal_after_additions_opens_a_new_block() {
    assert_eq!(rows("@@ -1,2 +1,2 @@\n+x\n-y\n"), vec![pair(None, Some("x")), pair(Some("y"), None)]);
}

#[test]
fn split_rows_of_an_empty_hunk_is_empty() {
    assert!(rows("@@ -1,0 +1,0 @@\n").is_empty());
}

fn wc(old: &[(usize, usize)], new: &[(usize, usize)]) -> WordChanges {
    WordChanges { old: old.to_vec(), new: new.to_vec() }
}

#[test]
fn word_changes_marks_only_the_tokens_that_differ() {
    let got = word_changes("const total = price * 2;", "const total = cost * 2;");
    assert_eq!(got, wc(&[(14, 19)], &[(14, 18)]));
}

#[test]
fn adjacent_changed_tokens_merge_into_one_range() {
    let got = word_changes("call(a, b)", "call(x, y)");
    let slice = |text: &str, ranges: &[(usize, usize)]| -> Vec<String> { ranges.iter().map(|&(s, e)| text[s..e].to_string()).collect() };
    assert_eq!(slice("call(a, b)", &got.old), vec!["a", "b"]);
    assert_eq!(slice("call(x, y)", &got.new), vec!["x", "y"]);
    // Nothing shared, too dissimilar.
    assert_eq!(word_changes("one two", "uno dos"), WordChanges::default());
}

#[test]
fn identical_long_or_dissimilar_lines_are_skipped() {
    assert_eq!(word_changes("same", "same"), WordChanges::default());
    let long = "x ".repeat(300);
    assert_eq!(word_changes(&long, &format!("{long}y")), WordChanges::default());
    assert_eq!(word_changes("abcdefghij", "klmnopqrst"), WordChanges::default());
}

#[test]
fn pure_insertion_marks_only_the_new_side() {
    assert_eq!(word_changes("foo(a)", "foo(a, b)"), wc(&[], &[(5, 8)]));
}

#[test]
fn word_changes_handle_an_exhausted_side_and_empty_lines() {
    assert_eq!(word_changes("foo(a, b)", "foo(a)"), wc(&[(5, 8)], &[]));
    assert_eq!(word_changes("foo(a)", "foo(a) + b"), wc(&[], &[(6, 10)]));
    assert_eq!(word_changes("foo(a) + b", "foo(a)"), wc(&[(6, 10)], &[]));
    assert_eq!(word_changes("", "foo(a)"), WordChanges::default());
    assert_eq!(word_changes("foo(a)", ""), WordChanges::default());
}

#[test]
fn word_changes_boundary_at_500_utf16_units() {
    let a = "a".repeat(250) + " " + &"b".repeat(249);
    assert_eq!(utf16_len(&a), 500);
    let b = a.replace("bbb", "ccc");
    assert!(!word_changes(&a, &b).old.is_empty());
    assert_eq!(word_changes(&a, &format!("{b}d")), WordChanges::default());
}

#[test]
fn word_change_offsets_count_utf16_units() {
    // "😀" is one code point and two UTF-16 units; it is its own token (not a word, not a space).
    let got = word_changes("a 😀 b", "a 😁 b");
    assert_eq!(got, wc(&[(2, 4)], &[(2, 4)]));
    let (s, e) = utf16_range_to_bytes("a 😀 b", got.old[0]);
    assert_eq!(&"a 😀 b"[s..e], "😀");
    // Non-ASCII letters are not word characters in JS (`\w` is ASCII): each is its own token.
    let got = word_changes("a café b", "a cafe b");
    assert_eq!(got, wc(&[(2, 6)], &[(2, 6)]));
    // Past the end clamps.
    assert_eq!(utf16_range_to_bytes("ab", (1, 9)), (1, 2));
}

#[test]
fn unicode_whitespace_is_one_token() {
    // NBSP and the ideographic space count as \s in JS.
    let got = word_changes("a\u{a0}\u{3000}b c", "a\u{a0}\u{3000}b d");
    assert_eq!(got, wc(&[(5, 6)], &[(5, 6)]));
}

// ---- tree --------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct F {
    path: String,
    added: u32,
    removed: u32,
}

impl Counted for F {
    fn path(&self) -> &str {
        &self.path
    }
    fn added(&self) -> u32 {
        self.added
    }
    fn removed(&self) -> u32 {
        self.removed
    }
}

fn f(path: &str, added: u32, removed: u32) -> F {
    F { path: path.to_string(), added, removed }
}

fn names(nodes: &[DiffTreeNode<F>]) -> Vec<&str> {
    nodes.iter().map(DiffTreeNode::name).collect()
}

fn folder(node: &DiffTreeNode<F>) -> &tree::DiffTreeFolder<F> {
    match node {
        DiffTreeNode::Folder(folder) => folder,
        DiffTreeNode::File { .. } => panic!("expected a folder"),
    }
}

#[test]
fn merges_a_chain_of_single_child_folders_into_one_row() {
    let tree = build_diff_tree(&[f("packages/app/src/Calendar/A.tsx", 4, 1), f("packages/app/src/Calendar/B.tsx", 2, 3)]);
    assert_eq!(tree.len(), 1);
    let folder = folder(&tree[0]);
    assert_eq!(folder.name, "packages/app/src/Calendar");
    assert_eq!(folder.path, "packages/app/src/Calendar");
    assert_eq!((folder.added, folder.removed), (6, 4));
    assert_eq!(names(&folder.children), vec!["A.tsx", "B.tsx"]);
}

#[test]
fn stops_merging_where_a_folder_branches_or_holds_a_file() {
    let tree = build_diff_tree(&[f("src/a/x.ts", 1, 0), f("src/b/y.ts", 1, 0), f("lib/z.ts", 1, 0)]);
    assert_eq!(names(&tree), vec!["lib", "src"]);
    assert_eq!(names(&folder(&tree[1]).children), vec!["a", "b"]);
    let mixed = build_diff_tree(&[f("src/only/x.ts", 1, 0), f("src/top.ts", 1, 0)]);
    assert_eq!(mixed[0].name(), "src");
}

#[test]
fn folders_come_before_files_each_alphabetical() {
    let tree = build_diff_tree(&[f("z.ts", 1, 0), f("b/x.ts", 1, 0), f("a.ts", 1, 0), f("a/x.ts", 1, 0)]);
    assert_eq!(names(&tree), vec!["a", "b", "a.ts", "z.ts"]);
}

#[test]
fn sums_counts_through_nested_folders() {
    let tree = build_diff_tree(&[f("a/b/x.ts", 1, 2), f("a/b/y.ts", 3, 4), f("a/z.ts", 5, 6)]);
    let a = folder(&tree[0]);
    assert_eq!((a.added, a.removed), (9, 12));
    let b = folder(&a.children[0]);
    assert_eq!((b.added, b.removed), (4, 6));
}

#[test]
fn root_files_stay_at_the_top_and_an_empty_list_is_an_empty_tree() {
    assert!(build_diff_tree::<F>(&[]).is_empty());
    assert!(matches!(build_diff_tree(&[f("README.md", 1, 0)])[0], DiffTreeNode::File { .. }));
}

#[test]
fn a_file_node_keeps_its_entry_and_full_path() {
    let tree = build_diff_tree(&[f("a/b.ts", 2, 1)]);
    let DiffTreeNode::File { name, path, file } = &folder(&tree[0]).children[0] else { panic!("file") };
    assert_eq!((name.as_str(), path.as_str(), file.added), ("b.ts", "a/b.ts", 2));
}

#[test]
fn locale_compare_orders_like_icu_for_file_names() {
    // Case-insensitive first, lowercase before uppercase on a tie, digits before letters, punctuation first.
    assert_eq!(locale_compare("a", "B"), Ordering::Less);
    assert_eq!(locale_compare("a", "A"), Ordering::Less);
    assert_eq!(locale_compare("A", "b"), Ordering::Less);
    assert_eq!(locale_compare("10", "2"), Ordering::Less);
    assert_eq!(locale_compare("1", "a"), Ordering::Less);
    assert_eq!(locale_compare("_a", "a"), Ordering::Less);
    assert_eq!(locale_compare("a-b", "a.b"), Ordering::Less);
    assert_eq!(locale_compare("é", "f"), Ordering::Less);
    assert_eq!(locale_compare("e", "é"), Ordering::Less);
    assert_eq!(locale_compare("same", "same"), Ordering::Equal);
    assert_eq!(locale_compare("ab", "abc"), Ordering::Less);
    let tree = build_diff_tree(&[f("B.ts", 1, 0), f("a.ts", 1, 0), f("b.ts", 1, 0), f("A.ts", 1, 0)]);
    assert_eq!(names(&tree), vec!["a.ts", "A.ts", "b.ts", "B.ts"]);
}

// ---- git-diff ----------------------------------------------------------------------------------------------------

fn history() -> GitHistoryRepo {
    GitHistoryRepo { branch: Some("feature".into()), base: Some("main".into()), branches_version: Some("v1".into()), ..Default::default() }
}

fn branches() -> Vec<GitBranch> {
    vec![GitBranch { git_ref: "refs/heads/main".into(), name: "main".into() }]
}

fn catalog(version: &str) -> GitBranchCatalog {
    GitBranchCatalog { version: version.into(), branches: branches() }
}

#[test]
fn omitted_catalogues_retain_only_the_matching_version() {
    let data = history();
    let with = |b: Vec<GitBranch>| GitHistory::Repo(Box::new(GitHistoryRepo { branches: Some(b), ..data.clone() }));
    let repo = GitHistory::Repo(Box::new(data.clone()));
    assert_eq!(with_history_branches(repo.clone(), Some(&catalog("v1"))), with(branches()));
    assert_eq!(with_history_branches(repo.clone(), Some(&catalog("other"))), with(vec![]));
    assert_eq!(with_history_branches(repo, None), with(vec![]));
    // Legacy hosts that already send branches (and no version) are left alone.
    let legacy = GitHistory::Repo(Box::new(GitHistoryRepo { branches: Some(branches()), branches_version: None, ..data }));
    assert_eq!(with_history_branches(legacy.clone(), None), legacy);
    let not_repo = GitHistory::NotRepo { message: "Not a repository".into() };
    assert_eq!(with_history_branches(not_repo.clone(), Some(&catalog("v1"))), not_repo);
}

#[test]
fn live_base_checks_take_precedence_over_a_cached_catalogue() {
    let base = |missing: Option<bool>, with_branches: bool| GitHistoryRepo {
        base_missing: missing,
        branches: with_branches.then(branches),
        ..history()
    };
    assert!(comparison_base_missing(&base(Some(true), true), "refs/heads/main"));
    assert!(!comparison_base_missing(&base(Some(false), true), "refs/heads/just-created"));
    assert!(comparison_base_missing(&base(None, true), "refs/heads/deleted"));
    assert!(!comparison_base_missing(&base(Some(true), false), ""));
    assert!(!comparison_base_missing(&base(None, false), "refs/heads/x"));
}

#[test]
fn commit_labels_distinguish_the_root_a_parent_unknown_metadata_and_truncated_counts() {
    assert_eq!(commit_comparison_label(Some(None)), "First commit");
    assert_eq!(commit_comparison_label(Some(Some(&"a".repeat(40)))), "Compared with first parent");
    assert_eq!(commit_comparison_label(None), "Commit changes");
    let entry = |i: usize| DiffFileEntry {
        path: i.to_string(),
        old_path: None,
        status: DiffStatus::Added,
        added: 1,
        removed: 0,
        binary: false,
        untracked: false,
    };
    let list = DiffFilesRepo { files: (0..1000).map(entry).collect(), ..Default::default() };
    assert_eq!(diff_file_count_label(&list), "1000 files");
    assert_eq!(diff_file_count_label(&DiffFilesRepo { truncated: true, ..list.clone() }), "1000+ files");
    assert_eq!(diff_file_count_label(&DiffFilesRepo { files: vec![], ..list.clone() }), "0 files");
    assert_eq!(diff_file_count_label(&DiffFilesRepo { files: vec![entry(0)], ..list.clone() }), "1 file");
    assert_eq!(diff_file_count_label(&DiffFilesRepo { files: vec![entry(0)], truncated: true, ..list }), "1+ files");
}

#[test]
fn history_unavailable_matches_the_two_host_errors() {
    assert!(is_git_history_unavailable("Command is not available from mobile"));
    assert!(is_git_history_unavailable("Unknown command: git:history"));
    assert!(is_git_history_unavailable("Error: Unknown command: git:history. Try later"));
    assert!(is_git_history_unavailable("Unknown command: git:history for x"));
    assert!(!is_git_history_unavailable("Unknown command: git:history-extra"));
    assert!(!is_git_history_unavailable("Unknown command: git:diff-files"));
    assert!(!is_git_history_unavailable("Command is not available from mobile."));
}

#[test]
fn comparison_options_group_and_order_the_picker() {
    let br = |git_ref: &str, name: &str| GitBranch { git_ref: git_ref.into(), name: name.into() };
    let data = GitHistoryRepo {
        branch: Some("feature".into()),
        suggested: Some("refs/remotes/origin/main".into()),
        branches: Some(vec![
            br("refs/remotes/upstream/dev", "upstream/dev"),
            br("refs/heads/feature", "feature"),
            br("refs/remotes/origin/main", "origin/main"),
            br("refs/heads/main", "main"),
            br("refs/remotes/origin/dev", "origin/dev"),
        ]),
        automatic: Some(AutomaticBase { name: "main".into(), git_ref: None, reason: "merge base".into() }),
        ..Default::default()
    };
    let options = comparison_options(Some(&data));
    let got: Vec<_> = options.iter().map(|o| (o.label.as_str(), o.group.as_str(), o.disabled)).collect();
    assert_eq!(
        got,
        vec![
            ("Automatic", "", false),
            ("origin/main", "Suggested", false),
            ("feature", "Local", true),
            ("main", "Local", false),
            ("upstream/dev", "Remote · upstream", false),
            ("origin/dev", "Remote · origin", false),
        ]
    );
    assert_eq!(options[0].description.as_deref(), Some("main, merge base"));
    assert_eq!(options[2].description.as_deref(), Some("current"));
    assert!(options[1].remote);
    let plain = comparison_options(Some(&history()));
    assert_eq!(plain[0].description.as_deref(), Some("main, the automatic base"));
    assert_eq!(comparison_options(None)[0].description.as_deref(), Some("Recorded base or project default"));
    // A remote ref with an empty branch part is not remote.
    let odd = GitHistoryRepo { branches: Some(vec![br("refs/remotes/origin/", "x")]), ..Default::default() };
    assert_eq!(comparison_options(Some(&odd)).len(), 2);
    assert_eq!(comparison_options(Some(&odd))[1].group, "Local");
}

#[test]
fn branch_names_and_initials() {
    assert_eq!(branch_name("refs/heads/main"), "main");
    assert_eq!(branch_name("refs/remotes/origin/main"), "origin/main");
    assert_eq!(branch_name("main"), "main");
    assert_eq!(commit_initials("  victor lucas  "), "VL");
    assert_eq!(commit_initials("Ada Byron King"), "AB");
    assert_eq!(commit_initials("cher"), "C");
    assert_eq!(commit_initials("   "), "?");
    assert_eq!(commit_initials(""), "?");
    assert_eq!(commit_initials("😀 x"), "😀X");
}

#[test]
fn stats_notices_and_git_messages() {
    assert!(commit_stats_notice(StatsUnavailable::Timeout).contains("read time limit"));
    assert!(commit_stats_notice(StatsUnavailable::TooLarge).contains("output limit"));
    assert_eq!(git_message(GitCode::NoOrigin, None), "This repo has no origin remote.");
    assert_eq!(git_message(GitCode::Detached, None), "Check out a branch to push.");
    assert_eq!(git_message(GitCode::DetachedCommit, None), "Check out a branch to commit.");
    assert_eq!(git_message(GitCode::GhMissing, None), "Install the GitHub CLI (`brew install gh`) to open PRs.");
    assert_eq!(git_message(GitCode::GhMissing, Some("win32")), "Install the GitHub CLI (`winget install --id GitHub.cli`) to open PRs.");
    assert_eq!(git_message(GitCode::GhMissing, Some("linux")), "Install the GitHub CLI (cli.github.com) to open PRs.");
    assert_eq!(GitCode::from_wire("WORKTREE_CHANGED"), Some(GitCode::WorktreeChanged));
    assert_eq!(GitCode::from_wire("nope"), None);
}
