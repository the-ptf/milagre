//! A realistic Worktree diff for the Changes panel while the panel has no daemon: twelve files not
//! committed (so the Files view draws the folder tree), three on the branch, five commits, a branch
//! catalogue. Patches are written as `git diff` prints them; the counts in the file lists are computed from
//! the patches, so the two always agree (`tests.rs` checks it).

use std::collections::HashMap;
use std::rc::Rc;

use super::data::{ChangesData, WorktreeChanges};
use crate::logic::diff::git::{
    AutomaticBase, CommitStats, DiffFileEntry, DiffFileResult, DiffFilesRepo, DiffStatus, GitBranch, GitCommit, GitHistoryRepo,
    ProjectDefault,
};
use crate::logic::diff::parse::count_hunks;
use crate::logic::diff::parse_patch;

/// One hunk: `(old_start, new_start, scope, body)`; each body line starts with ` `, `+` or `-`.
type Hunk = (u32, u32, &'static str, &'static str);

fn patch(old: Option<&str>, new: Option<&str>, hunks: &[Hunk]) -> String {
    let path = new.or(old).unwrap_or("");
    let mut out = format!("diff --git a/{} b/{path}\n", old.unwrap_or(path));
    out.push_str(&match old {
        Some(old) => format!("--- a/{old}\n"),
        None => "--- /dev/null\n".to_string(),
    });
    out.push_str(&match new {
        Some(new) => format!("+++ b/{new}\n"),
        None => "+++ /dev/null\n".to_string(),
    });
    for (old_start, new_start, scope, body) in hunks {
        let lines: Vec<&str> = body.lines().collect();
        let count = |keep: &[char]| lines.iter().filter(|l| keep.contains(&l.chars().next().unwrap_or(' '))).count();
        let (old_n, new_n) = (count(&[' ', '-']), count(&[' ', '+']));
        let scope = if scope.is_empty() { String::new() } else { format!(" {scope}") };
        out.push_str(&format!("@@ -{old_start},{old_n} +{new_start},{new_n} @@{scope}\n"));
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn entry(path: &str, old_path: Option<&str>, status: DiffStatus, text: &str) -> (DiffFileEntry, DiffFileResult) {
    let (added, removed) = count_hunks(&parse_patch(text));
    let entry = DiffFileEntry {
        path: path.to_string(),
        old_path: old_path.map(str::to_string),
        status,
        added,
        removed,
        binary: false,
        untracked: status == DiffStatus::Added,
    };
    (entry, DiffFileResult { patch: text.to_string(), binary: false, too_large: false })
}

fn binary(path: &str) -> (DiffFileEntry, DiffFileResult) {
    let entry = DiffFileEntry {
        path: path.to_string(),
        old_path: None,
        status: DiffStatus::Modified,
        added: 0,
        removed: 0,
        binary: true,
        untracked: false,
    };
    (entry, DiffFileResult { patch: String::new(), binary: true, too_large: false })
}

const CHANGES_PANEL: &str = "apps/desktop/app/src/components/changes/ChangesPanel.tsx";
const DIFF_TREE: &str = "apps/desktop/app/src/components/changes/DiffTree.tsx";
const DIFF_INDICATORS: &str = "apps/desktop/app/src/components/changes/DiffIndicators.tsx";
const FIT_FOLDER: &str = "apps/desktop/app/src/lib/fit-folder.ts";
const DIFF_TREE_LIB: &str = "apps/desktop/app/src/lib/diff-tree.ts";
const GIT_DIFF: &str = "packages/shared/src/git-diff.ts";
const GIT_DIFF_OLD: &str = "packages/shared/src/git-diff-types.ts";
const DESIGN: &str = "DESIGN.md";
const MOBILE_CHANGES: &str = "apps/mobile/src/screens/changes/ChangesScreen.tsx";
const LOGO: &str = "apps/desktop/app/public/milagre-mark.png";
const README: &str = "experiments/rust-gpui/README.md";
const PANEL_RS: &str = "experiments/rust-gpui/src/workspace/panel/mod.rs";

fn changes_panel_patch() -> String {
    patch(
        Some(CHANGES_PANEL),
        Some(CHANGES_PANEL),
        &[
            (
                52,
                52,
                "export function ChangesPanel({",
                " export function ChangesPanel({\n   lists,\n   comparison,\n-  mode,\n-  onModeChange,\n+  mode,\n+  onModeChange,\n+  refreshing,\n   onRefresh,\n   onSelectFile,\n   activePath,\n",
            ),
            (
                120,
                121,
                "const prShown = mode === \"pr\" && pullRequest;",
                " const prShown = mode === \"pr\" && pullRequest;\n   const prs = pullRequest?.choices ?? [];\n-  const tabs: PrTab[] = prs.map((pr) => ({ key: `pr:${pr.number}`, number: pr.number, pr }));\n+  const tabs: PrTab[] = prs.map((pr) => ({ key: `pr:${pr.number}`, number: pr.number, pr, hint: pr.project }));\n   // The shown PR keeps its tab even when the Chat's list hasn't caught up with it.\n",
            ),
        ],
    )
}

fn diff_tree_patch() -> String {
    patch(
        Some(DIFF_TREE),
        Some(DIFF_TREE),
        &[(
            30,
            30,
            "export function FlatList({ files, onSelectFile, activePath, commentCounts }: { files: DiffFileEntry[] } & TreeProps) {",
            "   return (\n     <div className=\"@container\">\n-      <div data-diff-flat-list className=\"grid grid-cols-[6px_16px_minmax(0,1fr)_auto_auto_16px_6px] gap-x-1.5\">\n+      <div\n+        data-diff-flat-list\n+        className=\"grid grid-cols-[6px_16px_minmax(0,1fr)_auto_auto_16px_6px] gap-x-1.5 @[440px]:grid-cols-[6px_16px_fit-content(45%)_minmax(0,1fr)_auto_auto_16px_6px]\"\n+      >\n         {files.map((file) => {\n           const cut = file.path.lastIndexOf(\"/\");\n",
        )],
    )
}

fn diff_indicators_patch() -> String {
    patch(
        None,
        Some(DIFF_INDICATORS),
        &[(
            0,
            1,
            "",
            "+import type { DiffFileEntry } from \"../../electron\";\n+\n+// Added and deleted carry their colour; modified and renamed stay neutral so the list isn't a wall of colour.\n+const STATUS = {\n+  added: { letter: \"A\", label: \"Added\", className: \"bg-green-tint text-green-ink\" },\n+  deleted: { letter: \"D\", label: \"Deleted\", className: \"bg-red-tint text-red-ink\" },\n+  modified: { letter: \"M\", label: \"Modified\", className: \"bg-field text-ink-2\" },\n+  renamed: { letter: \"R\", label: \"Renamed\", className: \"bg-field text-ink-2\" },\n+} as const;\n+\n+export function StatusBox({ status }: { status: DiffFileEntry[\"status\"] }) {\n+  const { letter, label, className } = STATUS[status];\n+  return (\n+    <span aria-label={label} data-status={letter} className={`flex size-4 items-center justify-center ${className}`}>\n+      {letter}\n+    </span>\n+  );\n+}\n",
        )],
    )
}

fn fit_folder_patch() -> String {
    patch(
        Some(FIT_FOLDER),
        None,
        &[(
            1,
            0,
            "",
            "-/** Shortens a folder path by whole segments until `fits(candidate)` says it does. */\n-export function fitFolder(path: string, fits: (candidate: string) => boolean): string | undefined {\n-  const parts = path.split(\"/\");\n-  for (let keep = parts.length; keep > 1; keep--) {\n-    const candidate = keep === parts.length ? path : `…/${parts.slice(parts.length - keep + 1).join(\"/\")}`;\n-    if (fits(candidate)) return candidate;\n-  }\n-  return undefined;\n-}\n-\n-export const shortestFolder = (path: string) => `…/${path.split(\"/\").pop()}`;\n",
        )],
    )
}

fn diff_tree_lib_patch() -> String {
    patch(
        Some(DIFF_TREE_LIB),
        Some(DIFF_TREE_LIB),
        &[(
            18,
            18,
            "export function buildDiffTree<T extends Counted>(files: T[]): DiffTreeNode<T>[] {",
            "   const root = folder(\"\", \"\");\n   for (const file of files) {\n-    const parts = file.path.split(\"/\");\n+    const parts = file.path.split(\"/\").filter(Boolean);\n     const name = parts.pop() ?? \"\";\n     let node = root;\n     parts.forEach((part, i) => {\n",
        )],
    )
}

fn git_diff_patch() -> String {
    patch(
        Some(GIT_DIFF_OLD),
        Some(GIT_DIFF),
        &[(
            88,
            88,
            "export function commitInitials(author: string): string {",
            "-  const initials = author.trim().split(/\\s+/).map((word) => word[0]).slice(0, 2).join(\"\");\n+  const initials = author\n+    .trim()\n+    .split(/\\s+/)\n+    .filter(Boolean)\n+    .map((word) => word[0])\n+    .slice(0, 2)\n+    .join(\"\");\n   return initials.toUpperCase() || \"?\";\n",
        )],
    )
}

fn design_patch() -> String {
    patch(
        Some(DESIGN),
        Some(DESIGN),
        &[(
            262,
            262,
            "## Sizes",
            " - Desktop controls: 24 for icon and extra-small buttons, 28 small (composer chips, tabs, approval buttons), 32 default\n-  (buttons, selects, rows), 36 inputs. Two-line list rows are 48. Heights are fixed, never derived from padding.\n+  (buttons, selects), 36 inputs. Tree rows in the Changes panel are 28, two-line list rows are 48. Heights are fixed,\n+  never derived from padding.\n",
        )],
    )
}

fn mobile_patch() -> String {
    patch(
        Some(MOBILE_CHANGES),
        Some(MOBILE_CHANGES),
        &[
            (
                40,
                40,
                "export function ChangesScreen() {",
                "   const { lists, comparison } = useChanges();\n-  const files = lists.uncommitted.files;\n+  const files = [...lists.uncommitted.files, ...lists.committed.files];\n   const [mode, setMode] = useState<DiffLayout>(\"unified\");\n",
            ),
            (
                96,
                96,
                "function FileRow({ file, onPress }: FileRowProps) {",
                "   return (\n     <Pressable onPress={onPress} style={styles.row}>\n-      <Text style={styles.name}>{file.path}</Text>\n+      <Text numberOfLines={1} style={styles.name}>\n+        {file.path}\n+      </Text>\n     </Pressable>\n   );\n",
            ),
        ],
    )
}

fn readme_patch() -> String {
    patch(
        Some(README),
        Some(README),
        &[(
            256,
            256,
            "## Panel tabs notes",
            " ## Panel tabs notes\n \n-- The panel header shows six `ui::Tab`s.\n+- The panel header shows the tabs the Chat has content for.\n",
        )],
    )
}

fn panel_rs_patch() -> String {
    patch(
        Some(PANEL_RS),
        Some(PANEL_RS),
        &[(12, 12, "pub const PANEL_WIDTH: f32 = 518.0;", "-pub const PANEL_WIDTH: f32 = 518.0;\n+pub const PANEL_WIDTH: f32 = 320.0;\n")],
    )
}

/// A one-hunk edit: a context line, then the lines out and in.
fn tiny(path: &str, status: DiffStatus, scope: &'static str, body: &'static str) -> (DiffFileEntry, DiffFileResult) {
    let text = match status {
        DiffStatus::Added => patch(None, Some(path), &[(0, 1, scope, body)]),
        _ => patch(Some(path), Some(path), &[(14, 14, scope, body)]),
    };
    entry(path, None, status, &text)
}

/// The files of the "On this branch" list, reused for the "On this branch" list and commit files.
fn committed_files() -> Vec<(DiffFileEntry, DiffFileResult)> {
    vec![
        entry(README, None, DiffStatus::Modified, &readme_patch()),
        entry(PANEL_RS, None, DiffStatus::Modified, &panel_rs_patch()),
        entry(DESIGN, None, DiffStatus::Modified, &design_patch()),
    ]
}

fn commit(sha: &str, author: &str, email: &str, date: &str, message: &str, files: &[&DiffFileEntry]) -> GitCommit {
    let (added, removed) = files.iter().fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
    GitCommit {
        sha: sha.to_string(),
        author: author.to_string(),
        email: email.to_string(),
        date: date.to_string(),
        message: message.to_string(),
        stats: CommitStats::Counts { files: files.len() as u32, added, removed },
    }
}

fn branch(git_ref: &str) -> GitBranch {
    GitBranch { git_ref: git_ref.to_string(), name: crate::logic::diff::git::branch_name(git_ref).to_string() }
}

/// The Worktree of the Chat on screen: Changes with files in folders, badges of all four kinds, a binary file,
/// and history.
pub fn worktree() -> WorktreeChanges {
    let uncommitted_rows = vec![
        entry(CHANGES_PANEL, None, DiffStatus::Modified, &changes_panel_patch()),
        entry(DIFF_TREE, None, DiffStatus::Modified, &diff_tree_patch()),
        entry(DIFF_INDICATORS, None, DiffStatus::Added, &diff_indicators_patch()),
        entry(FIT_FOLDER, None, DiffStatus::Deleted, &fit_folder_patch()),
        entry(DIFF_TREE_LIB, None, DiffStatus::Modified, &diff_tree_lib_patch()),
        entry(GIT_DIFF, Some(GIT_DIFF_OLD), DiffStatus::Renamed, &git_diff_patch()),
        entry(MOBILE_CHANGES, None, DiffStatus::Modified, &mobile_patch()),
        tiny(
            "apps/desktop/app/src/components/changes/DiffComments.tsx",
            DiffStatus::Modified,
            "export function DiffComments({ comments }: Props) {",
            " export function DiffComments({ comments }: Props) {\n-  const open = comments.filter((c) => !c.resolved);\n+  const open = comments.filter((comment) => !comment.resolved && !comment.outdated);\n   return <ol>{open.map(renderComment)}</ol>;\n",
        ),
        tiny(
            "apps/desktop/app/src/components/changes/DiffFile.tsx",
            DiffStatus::Modified,
            "export function DiffFile({ file, layout }: Props) {",
            " export function DiffFile({ file, layout }: Props) {\n+  if (file.binary) return <BinaryNotice path={file.path} />;\n   return <DiffView patch={file.patch} layout={layout} />;\n",
        ),
        tiny(
            "apps/desktop/app/src/lib/pull-request-view.ts",
            DiffStatus::Modified,
            "export type ChangesMode = DiffMode | \"pr\";",
            "-export type ChangesMode = DiffMode | \"pr\";\n+export type ChangesMode = DiffMode | `pr`;\n",
        ),
        tiny(
            "packages/shared/src/git-diff.test.mjs",
            DiffStatus::Added,
            "",
            "+import { commitInitials } from \"./git-diff.ts\";\n+\n+test(\"initials skip extra spaces\", () => {\n+  expect(commitInitials(\"  Ana   Lima \")).toBe(\"AL\");\n+});\n",
        ),
        binary(LOGO),
    ];
    let committed_rows = committed_files();
    let mut patches = HashMap::new();
    let mut uncommitted = Vec::new();
    for (entry, result) in uncommitted_rows {
        patches.insert(entry.path.clone(), result);
        uncommitted.push(entry);
    }
    let mut committed = Vec::new();
    for (entry, result) in committed_rows {
        patches.insert(entry.path.clone(), result);
        committed.push(entry);
    }
    let by_path = |path: &str| uncommitted.iter().chain(&committed).find(|f| f.path == path).expect("fixture file");
    let commits = vec![
        commit(
            "9f3a1c2e7b4d5a60918273645f0e1d2c3b4a5968",
            "Marina Costa",
            "marina@milagre.dev",
            "2026-11-10T16:42:00Z",
            "Fix Changes panel comparison picker width\n\nThe chip clipped branch names under 300px; both ends of a long name stay visible now.",
            &[by_path(README), by_path(PANEL_RS)],
        ),
        commit(
            "4be07d91a2c35f6e8071b2d3c4a5f60718293a4b",
            "Victor Lucas",
            "victor@milagre.dev",
            "2026-11-09T11:05:00Z",
            "Name Changes rows 28px in DESIGN.md",
            &[by_path(DESIGN)],
        ),
        commit(
            "c1d2e3f4a5b60718293a4b5c6d7e8f9012345678",
            "Marina Costa",
            "marina@milagre.dev",
            "2026-11-07T09:20:00Z",
            "Show commit author initials in history",
            &[by_path(GIT_DIFF), by_path(DIFF_TREE_LIB)],
        ),
        commit(
            "7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607",
            "Jo\u{e3}o Pereira",
            "joao@milagre.dev",
            "2026-11-05T18:51:00Z",
            "Split diff tree rows into flat list and folders",
            &[by_path(DIFF_TREE), by_path(CHANGES_PANEL), by_path(MOBILE_CHANGES)],
        ),
        GitCommit {
            sha: "0123456789abcdef0123456789abcdef01234567".to_string(),
            author: "Victor Lucas".to_string(),
            email: "victor@milagre.dev".to_string(),
            date: "2026-11-02T14:03:00Z".to_string(),
            message: "Port the diff engine to Rust".to_string(),
            stats: CommitStats::Unavailable(crate::logic::diff::git::StatsUnavailable::TooLarge),
        },
    ];
    let mut commit_files = HashMap::new();
    for commit in &commits {
        let files: Vec<DiffFileEntry> = match commit.sha.as_str() {
            sha if sha.starts_with("9f3a") => vec![by_path(README).clone(), by_path(PANEL_RS).clone()],
            sha if sha.starts_with("4be0") => vec![by_path(DESIGN).clone()],
            sha if sha.starts_with("c1d2") => vec![by_path(GIT_DIFF).clone(), by_path(DIFF_TREE_LIB).clone()],
            sha if sha.starts_with("7a8b") => {
                vec![by_path(DIFF_TREE).clone(), by_path(CHANGES_PANEL).clone(), by_path(MOBILE_CHANGES).clone()]
            }
            _ => Vec::new(),
        };
        commit_files.insert(
            commit.sha.clone(),
            DiffFilesRepo {
                commit: Some(commit.sha.clone()),
                commit_parent: Some(Some("parent".to_string())),
                files,
                ..Default::default()
            },
        );
    }
    let history = GitHistoryRepo {
        branch: Some("milagre/changes-panel".to_string()),
        base: Some("main".to_string()),
        comparison_ref: Some("refs/heads/main".to_string()),
        head: Some("9f3a1c2e7b4d5a60918273645f0e1d2c3b4a5968".to_string()),
        total: Some(commits.len() as u32),
        automatic: Some(AutomaticBase {
            name: "main".to_string(),
            git_ref: Some("refs/heads/main".to_string()),
            reason: "the Project's default branch".to_string(),
        }),
        project_default: Some(ProjectDefault { name: "main".to_string(), git_ref: Some("refs/heads/main".to_string()) }),
        suggested: Some("refs/heads/main".to_string()),
        branches: Some(vec![
            branch("refs/heads/main"),
            branch("refs/heads/develop"),
            branch("refs/heads/milagre/changes-panel"),
            branch("refs/remotes/origin/main"),
            branch("refs/remotes/origin/release-0.232"),
        ]),
        commits,
        ..Default::default()
    };
    WorktreeChanges {
        uncommitted: DiffFilesRepo { files: uncommitted, ..Default::default() },
        committed: DiffFilesRepo { base: Some("main".to_string()), files: committed, ..Default::default() },
        history,
        patches,
        commit_files,
    }
}

/// A small Worktree: two files, no history to speak of.
pub fn small_worktree() -> WorktreeChanges {
    let full = worktree();
    let keep = [CHANGES_PANEL, DIFF_INDICATORS];
    let files: Vec<DiffFileEntry> = full.uncommitted.files.iter().filter(|f| keep.contains(&f.path.as_str())).cloned().collect();
    let patches = full.patches.iter().filter(|(path, _)| keep.contains(&path.as_str())).map(|(p, r)| (p.clone(), r.clone())).collect();
    let history = GitHistoryRepo { commits: Vec::new(), total: Some(0), ..full.history.clone() };
    WorktreeChanges {
        uncommitted: DiffFilesRepo { files, ..Default::default() },
        committed: DiffFilesRepo::default(),
        history,
        patches,
        commit_files: HashMap::new(),
    }
}

/// An empty Worktree: nothing changed.
pub fn clean_worktree() -> WorktreeChanges {
    WorktreeChanges { history: GitHistoryRepo { total: Some(0), ..worktree().history }, ..Default::default() }
}

/// The panel's Changes data for the fixture Chat with `variant` (see `panel::fixture`).
pub fn data(variant: Variant) -> ChangesData {
    match variant {
        Variant::Full => ChangesData::Ready(Rc::new(worktree())),
        Variant::Small => ChangesData::Ready(Rc::new(small_worktree())),
        Variant::Clean => ChangesData::Ready(Rc::new(clean_worktree())),
        Variant::NotRepo => ChangesData::NotRepo("This folder isn't a Git repository.".to_string()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Full,
    Small,
    Clean,
    NotRepo,
}
