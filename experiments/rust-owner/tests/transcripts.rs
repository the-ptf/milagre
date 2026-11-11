//! Transcript jobs: bounded reservations, one outcome per job whatever happens to it (run, failed, dropped unrun,
//! panicked), a temporary file written and renamed only through held folder descriptors, and nothing written, renamed
//! or removed through a path that was swapped for a link or another folder.

use std::collections::BTreeMap;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::handover::{self, Clock, Zone};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::transcripts::{
    test_hooks, JobOutcome, TranscriptJobs, TranscriptSource, MAX_TRANSCRIPT_JOBS,
};
use milagre_owner_store::StoreError;
use serde_json::{json, Value};

const CLOCK: Clock = Clock {
    zone: Zone::Utc,
    now_ms: 0.0,
};

fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.is_dir() {
            out.insert(path.strip_prefix(dir).unwrap().join("<folder>"), Vec::new());
            for entry in std::fs::read_dir(&path).unwrap() {
                stack.push(entry.unwrap().path());
            }
        } else {
            out.insert(
                path.strip_prefix(dir).unwrap().to_path_buf(),
                std::fs::read(&path).unwrap_or_default(),
            );
        }
    }
    out
}

struct Setup {
    base: tempfile::TempDir,
    isolation: Isolation,
    jobs: TranscriptJobs,
    project: PathBuf,
}

fn setup() -> Setup {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    let jobs = TranscriptJobs::new(&isolation).unwrap();
    Setup {
        base,
        isolation,
        jobs,
        project,
    }
}

fn state() -> Value {
    json!({
        "sessions": { "7": { "title": "Fix the build", "provider": "claude", "worktree_id": 1 } },
        "worktrees": { "1": { "path": "/tmp/wt" } },
        "messages": [
            { "id": 1, "session_id": 7, "role": "user", "body": "Make the tests pass" },
            { "id": 2, "session_id": 7, "role": "assistant", "body": "Done." },
            { "id": 3, "session_id": 7, "role": "user", "body": "And the docs" },
        ],
    })
}

/// A source over a state that lives for the test (leaked: tests only).
fn source_of(state: Value, after: Option<Value>) -> TranscriptSource<'static> {
    TranscriptSource {
        state: Box::leak(Box::new(state)),
        session: 7,
        before: None,
        provider: None,
        catch_up_after: after,
        clock: CLOCK,
    }
}

fn input(after: Option<Value>) -> TranscriptSource<'static> {
    source_of(state(), after)
}

fn temporaries(dir: &Path) -> Vec<PathBuf> {
    tree(dir)
        .into_keys()
        .filter(|path| path.extension().is_some_and(|ext| ext == "tmp"))
        .collect()
}

#[test]
fn a_staged_transcript_commits_where_node_would_name_it() {
    let mut s = setup();
    let job = s.jobs.job(&s.project, input(Some(json!(1)))).unwrap();
    job.run();
    let mut outcomes = s.jobs.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let JobOutcome::Staged {
        staged,
        brief_prompt,
    } = outcomes.remove(0)
    else {
        panic!("not staged")
    };
    let brief_prompt = brief_prompt.expect("a prompt").prompt;
    assert!(
        brief_prompt.contains("Earlier messages are left out"),
        "{brief_prompt}"
    );
    assert!(!brief_prompt.contains("Make the tests pass"));
    assert!(brief_prompt.starts_with("<transcript>\n"));
    let path = staged.commit().unwrap();
    let node_path = handover::transcript_path(
        &s.jobs.folder().to_string_lossy(),
        &s.project.to_string_lossy(),
        &json!(7),
    );
    assert_eq!(path, PathBuf::from(node_path));
    let full = handover::render_transcript(&state(), &json!(7), None, &CLOCK).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), full);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(temporaries(s.jobs.folder()).is_empty());
    s.jobs.finish(staged.id());
    assert_eq!(s.jobs.outstanding(), 0);
}

#[test]
fn reservations_are_bounded_before_anything_is_made() {
    let mut s = setup();
    let mut held = Vec::new();
    for _ in 0..MAX_TRANSCRIPT_JOBS {
        held.push(s.jobs.job(&s.project, input(None)).unwrap());
    }
    let before = tree(s.jobs.folder());
    let refused = s.jobs.job(&s.project, input(None)).err().unwrap();
    assert!(matches!(refused, StoreError::TranscriptsAtCapacity(_)));
    assert_eq!(refused.code(), Some("TRANSCRIPTS_AT_CAPACITY"));
    assert_eq!(tree(s.jobs.folder()), before);
    // A reservation ends only when the owner finishes it, not when its job is dropped.
    let first = held.remove(0);
    let id = first.id();
    drop(first);
    assert!(s.jobs.job(&s.project, input(None)).is_err());
    let outcomes = s.jobs.take_outcomes();
    assert!(matches!(
        &outcomes[..],
        [JobOutcome::Unknown { leftover: None, .. }]
    ));
    s.jobs.finish(id);
    assert!(s.jobs.job(&s.project, input(None)).is_ok());
}

#[test]
fn a_job_dropped_unrun_reports_unknown_once() {
    let mut s = setup();
    let job = s.jobs.job(&s.project, input(None)).unwrap();
    let id = job.id();
    drop(job);
    let outcomes = s.jobs.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert!(
        matches!(&outcomes[0], JobOutcome::Unknown { id: found, leftover: None } if *found == id)
    );
    assert!(s.jobs.take_outcomes().is_empty());
}

#[test]
fn a_job_that_panics_after_creating_its_file_reports_it_for_discard() {
    let mut s = setup();
    let job = s.jobs.job(&s.project, input(None)).unwrap();
    test_hooks::after_temporary_created(|| panic!("worker died"));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job.run()));
    assert!(result.is_err());
    let mut outcomes = s.jobs.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    let JobOutcome::Unknown {
        leftover: Some(leftover),
        ..
    } = outcomes.remove(0)
    else {
        panic!("the temporary file wasn't reported")
    };
    assert_eq!(temporaries(s.jobs.folder()).len(), 1);
    leftover.discard().unwrap();
    leftover.discard().unwrap();
    assert!(temporaries(s.jobs.folder()).is_empty());
}

#[test]
fn a_job_that_can_t_render_fails_without_a_file() {
    let mut s = setup();
    let bad = source_of(
        json!({ "sessions": { "7": { "title": 5 } }, "messages": [] }),
        None,
    );
    s.jobs.job(&s.project, bad).unwrap().run();
    let outcomes = s.jobs.take_outcomes();
    assert!(matches!(
        &outcomes[..],
        [JobOutcome::Failed { leftover: None, .. }]
    ));
    assert!(temporaries(s.jobs.folder()).is_empty());
}

/// The Project's transcript folder swapped for a link after the file was staged: the commit is refused, nothing
/// lands behind the link, and the discard removes the file from the folder it was written in (held), never by path.
#[test]
fn a_transcript_folder_swapped_after_staging_is_not_committed_through() {
    let mut s = setup();
    s.jobs.job(&s.project, input(None)).unwrap().run();
    let JobOutcome::Staged { staged, .. } = s.jobs.take_outcomes().remove(0) else {
        panic!()
    };
    let folder = staged.path().parent().unwrap().to_path_buf();
    let moved = s.base.path().join("moved");
    let sentinel = s.base.path().join("sentinel");
    std::fs::create_dir(&sentinel).unwrap();
    std::fs::write(sentinel.join("keep"), "keep").unwrap();
    std::fs::rename(&folder, &moved).unwrap();
    symlink(&sentinel, &folder).unwrap();
    let before = tree(&sentinel);
    assert!(matches!(
        staged.commit(),
        Err(StoreError::OwnershipLost { .. })
    ));
    staged.discard().unwrap();
    assert_eq!(tree(&sentinel), before, "something landed behind the link");
    assert!(
        temporaries(&moved).is_empty(),
        "the held folder kept its temporary file"
    );
    assert!(!moved.join("7.md").exists());
}

/// The same swap while the job writes: the write goes to the folder it opened (held), the sentinel stays as it was,
/// and the commit is refused.
#[test]
fn a_transcript_folder_swapped_while_writing_is_not_written_through() {
    let mut s = setup();
    // Make the Project folder first, then swap it once the job holds it.
    s.jobs.job(&s.project, input(None)).unwrap().run();
    let JobOutcome::Staged { staged, .. } = s.jobs.take_outcomes().remove(0) else {
        panic!()
    };
    staged.commit().unwrap();
    s.jobs.finish(staged.id());
    let folder = staged.path().parent().unwrap().to_path_buf();
    let moved = s.base.path().join("moved");
    let sentinel = s.base.path().join("sentinel");
    std::fs::create_dir(&sentinel).unwrap();
    let before = tree(&sentinel);
    let (from, to, link) = (folder.clone(), moved.clone(), sentinel.clone());
    test_hooks::after_temporary_created(move || {
        std::fs::rename(&from, &to).unwrap();
        symlink(&link, &from).unwrap();
    });
    s.jobs.job(&s.project, input(None)).unwrap().run();
    let JobOutcome::Staged { staged, .. } = s.jobs.take_outcomes().remove(0) else {
        panic!()
    };
    assert!(staged.commit().is_err());
    assert_eq!(
        tree(&sentinel),
        before,
        "the write followed the swapped path"
    );
    assert_eq!(
        temporaries(&moved).len(),
        1,
        "the write didn't stay in the folder it held"
    );
    staged.discard().unwrap();
    assert!(temporaries(&moved).is_empty());
}

/// The handovers folder itself swapped for a link: the commit is refused.
#[test]
fn a_handovers_folder_swapped_for_a_link_refuses_the_commit() {
    let mut s = setup();
    s.jobs.job(&s.project, input(None)).unwrap().run();
    let JobOutcome::Staged { staged, .. } = s.jobs.take_outcomes().remove(0) else {
        panic!()
    };
    let handovers = s.jobs.folder().to_path_buf();
    let moved = s.base.path().join("moved-handovers");
    std::fs::rename(&handovers, &moved).unwrap();
    symlink(&moved, &handovers).unwrap();
    assert!(matches!(
        staged.commit(),
        Err(StoreError::OwnershipLost { .. })
    ));
    staged.discard().unwrap();
    assert!(temporaries(&moved).is_empty());
}

#[test]
fn the_owner_folder_is_never_a_project_and_never_a_link() {
    let s = setup();
    assert!(s.isolation.project(Path::new(".owner")).is_err());
    assert!(s
        .isolation
        .project(Path::new(".owner/handovers/x"))
        .is_err());
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let elsewhere = base.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    symlink(&elsewhere, isolation.root().join(".owner")).unwrap();
    assert!(TranscriptJobs::new(&isolation).is_err());
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
}
