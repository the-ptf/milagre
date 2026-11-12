#![recursion_limit = "512"]
use milagre_pr_details::{
    CapturedContext, DetailsReader, GithubSelectionOwner, LocalCommits, Readiness,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
/// What Node's `thisComputer` says on this platform.
fn computer() -> &'static str {
    if cfg!(target_os = "macos") {
        "this Mac"
    } else {
        "this computer"
    }
}
fn run_git(dir: &Path, args: &[&str], date: &str) -> String {
    let out = Command::new("/usr/bin/git")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Synthetic")
        .env("GIT_AUTHOR_EMAIL", "synthetic@example.invalid")
        .env("GIT_COMMITTER_NAME", "Synthetic")
        .env("GIT_COMMITTER_EMAIL", "synthetic@example.invalid")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
/// A real local checkout with four commits and fixed dates, so every fixture has the
/// same object ids. The PR head is the second commit: HEAD is two commits ahead of it.
fn init_repo(dir: &Path) -> Vec<String> {
    run_git(dir, &["init", "-b", "main"], "2020-01-01T00:00:00Z");
    (0..4)
        .map(|n| {
            let date = format!("2020-01-01T00:00:0{n}Z");
            fs::write(dir.join("tracked.txt"), format!("{n}\n")).unwrap();
            run_git(dir, &["add", "tracked.txt"], &date);
            run_git(dir, &["commit", "-m", &format!("c{n}")], &date);
            run_git(dir, &["rev-parse", "HEAD"], &date)
        })
        .collect()
}
fn head_oid() -> &'static str {
    static OID: OnceLock<String> = OnceLock::new();
    OID.get_or_init(|| {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        init_repo(dir.path())[1].clone()
    })
}
/// The real `git rev-list --count <head>..HEAD`, which is what the runtime wires up
/// through the bounded Git reader (its own test covers that path against Node).
fn real_count(project: PathBuf) -> LocalCommits {
    Arc::new(move |head, _| {
        let out = Command::new("/usr/bin/git")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &project)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .current_dir(&project)
            .args(["rev-list", "--count", &format!("{head}..HEAD")])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(if out.status.success() {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0)
        } else {
            0
        })
    })
}
/// The library caps live gh children at eight across the whole process, so tests that
/// hold a child must not all run at once. At most four fixtures are alive together.
struct Slot;
static SLOTS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());
impl Slot {
    fn take() -> Self {
        let mut used = SLOTS.0.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= 4 {
            used = SLOTS.1.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        Slot
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        *SLOTS.0.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        SLOTS.1.notify_one();
    }
}
struct Fixture {
    _slot: Slot,
    root: tempfile::TempDir,
    project: PathBuf,
    program: PathBuf,
    reader: DetailsReader,
    selection: GithubSelectionOwner,
    ready: Arc<AtomicBool>,
}
fn fixture(response: Value) -> Fixture {
    let slot = Slot::take();
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let project = root.path().join("project");
    let home = root.path().join("home");
    let account = root.path().join("account");
    for p in [&project, &home, &account] {
        fs::create_dir(p).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
    }
    for (name, text) in [
        ("hosts.yml", "synthetic-login: alice\n"),
        ("config.yml", "synthetic: true\n"),
    ] {
        let p = account.join(name);
        fs::write(&p, text).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o600)).unwrap();
    }
    init_repo(&project);
    fs::write(project.join("response.json"), response.to_string()).unwrap();
    let script = root.path().join("fake.py");
    fs::write(
        &script,
        r#"import json,os,sys
import time
args=sys.argv[1:]
with open('calls.jsonl','a') as f: f.write(json.dumps({'args':args,'env':dict(os.environ),'pid':os.getpid(),'t':time.time()})+'\n')
assert args[:4]==['api','graphql','--hostname','github.com']
assert 'owner=example' in args and 'name=repo' in args
assert not any(x in os.environ for x in ['GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS'])
assert os.environ['GH_PROMPT_DISABLED']=='1'
while os.path.exists('hold'): time.sleep(0.005)
if os.path.exists('delay'): time.sleep(0.2)
data=json.load(open('response.json'))
number=int([a for a in args if a.startswith('number=')][0].split('=')[1])
with open('ends.jsonl','a') as f: f.write(json.dumps({'number':number,'t':time.time()})+'\n')
if data.get('_exitCode'):
    sys.stderr.write(data.get('_stderr',''))
    sys.stdout.write(data.get('_stdout',''))
    sys.exit(data['_exitCode'])
if data.get('_stderr'): sys.stderr.write(data['_stderr'])
if 'after=next-page' in args: data=data['page2']
elif 'page2' in data: del data['page2']
data={k:v for k,v in data.items() if not k.startswith('_')}
pr=data.get('data',{}).get('repository',{}).get('pullRequest')
if isinstance(pr,dict) and 'number' in pr and not any(a.startswith('after=') for a in args): pr['number']=number
data.setdefault('data',{}).setdefault('viewer',{'login':'alice'})
print(json.dumps(data))
"#,
    )
    .unwrap();
    let program = root.path().join("gh");
    fs::write(
        &program,
        format!(
            "#!/bin/sh\nexec /usr/bin/python3 '{}' \"$@\"\n",
            script.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let ready = Arc::new(AtomicBool::new(true));
    let check = ready.clone();
    let selection = GithubSelectionOwner::capture(CapturedContext {
        project: project.clone(),
        program: program.clone(),
        home,
        config_directory: account,
        owner: "example".into(),
        repository: "repo".into(),
        account_login: "alice".into(),
        path: "/usr/bin:/bin".into(),
        computer_label: computer().into(),
        lifetime: Arc::new(()),
        check: Arc::new(move || {
            if check.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err("Owner revoked".into())
            }
        }),
        local_commits: Some(real_count(project.clone())),
    })
    .unwrap();
    let reader = selection.reader().unwrap();
    Fixture {
        _slot: slot,
        root,
        project,
        program,
        reader,
        selection,
        ready,
    }
}
fn payload() -> Value {
    let text = payload_template()
        .to_string()
        .replace("__HEAD__", head_oid());
    serde_json::from_str(&text).unwrap()
}
fn payload_template() -> Value {
    json!({"data":{"repository":{"pullRequest":{
    "id":"PR_12","number":12,"url":"https://github.com/example/repo/pull/12","title":"Use Rust","body":"Body","state":"OPEN","isDraft":false,
    "author":{"login":"alice"},"baseRefName":"main","headRefName":"rust","baseRefOid":"1111111111111111111111111111111111111111","headRefOid":"__HEAD__",
    "additions":3,"deletions":1,"changedFiles":2,"mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","autoMergeRequest":{"mergeMethod":"SQUASH"},
    "labels":{"nodes":[{"name":"rust","color":"f00fff"},null]},
    "commits":{"nodes":[{"commit":{"oid":"abc","messageHeadline":"Port"}}]},
    "checks":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
        {"kind":"CheckRun","name":"unit","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://example.test/unit","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}}},
        {"kind":"StatusContext","context":"lint","state":"FAILURE","targetUrl":"https://example.test/lint"},
        {"kind":"CheckRun","name":"queued","status":"QUEUED"},
        {"kind":"CheckRun","name":"skipped","status":"COMPLETED","conclusion":"SKIPPED"}
    ]}}}}]},
    "latestReviews":{"nodes":[{"author":{"login":"bob"},"state":"APPROVED","commit":{"oid":"old"}},{"author":{"login":"carol"},"state":"COMMENTED"}]},
    "reviewRequests":{"nodes":[{"requestedReviewer":{"login":"bob"}},{"requestedReviewer":{"combinedSlug":"example/team"}}]},
    "files":{"nodes":[{"path":"src/main.rs","additions":3,"deletions":1,"changeType":"RENAMED"}],"pageInfo":{"hasNextPage":true,"endCursor":"next-page"}},
    "reviewThreads":{"nodes":[{"id":"T123","path":"src/main.rs","originalLine":4,"diffSide":"LEFT","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"id":"C1","author":null,"body":"Review","pullRequestReview":{"state":"PENDING"}}]}}]},
    "comments":{"nodes":[{"id":"C2","author":{"login":"dave"},"body":"Hello"}]},"pending":{"nodes":[{"id":"R123","comments":{"totalCount":1}}]}
}}},"page2":{"data":{"repository":{"pullRequest":{"files":{"nodes":[{"path":"README.md","additions":0,"deletions":1,"changeType":"DELETED"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}})
}
fn request(project: &Path) -> Vec<Value> {
    vec![json!({"cwd":project,"number":12})]
}
fn node_result(f: &Fixture, response: &Value) -> Value {
    node_result_number(f, response, json!(12))
}
fn node_result_number(f: &Fixture, response: &Value, number: Value) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = r#"const fs=require('node:fs');const {createPullRequestReview}=require(process.argv[1]+'/packages/core/src/pull-request-review.cjs');
const {response,number,cwd}=JSON.parse(fs.readFileSync(0,'utf8'));
// The failing gh process, as promisified execFile rejects it. Git is Node's own, in the real checkout.
const exec=async(_cmd,args)=>{
  if(response._exitCode) throw Object.assign(new Error('Command failed: gh'),{code:response._exitCode,stdout:response._stdout??'',stderr:response._stderr??''});
  const {_stderr,...rest}=response;
  return {stdout:JSON.stringify(args.includes('after=next-page')?rest.page2:rest)};
};
const review=createPullRequestReview({exec});
review.detail({cwd,number}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});"#;
    use std::io::Write;
    let mut child = Command::new("node")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .arg("-e")
        .arg(script)
        .arg(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"response":response,"number":number,"cwd":f.project})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn complete_detail_and_pagination_match_actual_node_and_exact_captured_environment() {
    let p = payload();
    let f = fixture(p.clone());
    let actual = f.reader.invoke(&request(&f.project)).unwrap();
    assert_eq!(actual, node_result(&f, &p));
    assert_eq!(actual["pr"]["localCommits"], 2, "the real local count");
    let calls = fs::read_to_string(f.project.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0]["env"]["GH_CONFIG_DIR"],
        json!(f.root.path().join("account"))
    );
    assert_eq!(calls[0]["env"]["HOME"], json!(f.root.path().join("home")));
    assert_eq!(actual["pr"]["files"].as_array().unwrap().len(), 2);
}
#[test]
fn invalid_requests_and_revocation_start_no_child() {
    let f = fixture(payload());
    for args in [
        vec![],
        vec![json!({"cwd":f.project.join("foreign"),"number":12})],
        vec![json!({"cwd":f.project,"number":12,"host":"attacker"})],
    ] {
        assert!(f.reader.invoke(&args).is_err());
    }
    f.ready.store(false, Ordering::Release);
    assert!(f.reader.invoke(&request(&f.project)).is_err());
    assert!(!f.project.join("calls.jsonl").exists());
}
#[test]
fn replaced_project_or_program_refuses_without_launch() {
    {
        let f = fixture(payload());
        let old = f.root.path().join("original");
        fs::rename(&f.project, &old).unwrap();
        fs::create_dir(&f.project).unwrap();
        assert!(f.reader.invoke(&request(&f.project)).is_err());
        assert!(!old.join("calls.jsonl").exists());
    }
    let f = fixture(payload());
    fs::write(&f.program, "#!/bin/sh\nexit 99\n").unwrap();
    assert!(f.reader.invoke(&request(&f.project)).is_err());
    assert!(!f.project.join("calls.jsonl").exists());
}
#[test]
fn graphql_errors_and_missing_pr_are_node_results_not_success_stubs() {
    for payload in [
        json!({"errors":[{"message":"Repository unavailable"}]}),
        json!({"data":{"repository":{"pullRequest":null}}}),
    ] {
        let f = fixture(payload.clone());
        assert_eq!(
            f.reader.invoke(&request(&f.project)).unwrap(),
            node_result(&f, &payload)
        );
    }
}

#[test]
fn detail_edge_shapes_match_the_actual_node_mapper() {
    let mut vectors = Vec::new();
    vectors.push(json!({"data":{"repository":{"pullRequest":{"number":12}}}}));
    let mut p = payload();
    let pr = &mut p["data"]["repository"]["pullRequest"];
    pr["state"] = json!("CLOSED");
    pr["reviewDecision"] = json!("unknown");
    pr["isDraft"] = json!(true);
    pr["autoMergeRequest"] = json!({"mergeMethod":"unknown"});
    pr["reviewThreads"]["nodes"][0]["isOutdated"] = json!(true);
    vectors.push(p);
    let mut p = payload();
    let pr = &mut p["data"]["repository"]["pullRequest"];
    pr["checks"] = json!({"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
        {"kind":"StatusContext","context":"status-error","state":"ERROR"},
        {"kind":"StatusContext","context":"status-success","state":"SUCCESS"},
        {"kind":"CheckRun","name":"neutral","status":"COMPLETED","conclusion":"NEUTRAL"},
        {"kind":"CheckRun","name":"timed","status":"COMPLETED","conclusion":"TIMED_OUT"},
        {"kind":"CheckRun","name":"stale","status":"COMPLETED","conclusion":"STALE"},
        {"kind":"CheckRun","name":"running","status":"IN_PROGRESS"},null,
        {"kind":"CheckRun","name":"","status":"COMPLETED","conclusion":"SUCCESS"}
    ]}}}}]});
    vectors.push(p);
    let mut p = payload();
    let pr = &mut p["data"]["repository"]["pullRequest"];
    pr["latestReviews"] = json!({"nodes":[{"author":{"login":"bob"},"state":"APPROVED","commit":{"oid":"old"}},
        {"author":{"login":"bob"},"state":"CHANGES_REQUESTED","commit":{"oid":pr["headRefOid"]}},
        {"author":null,"state":"COMMENTED"},{"author":{"login":"ignored"},"state":"PENDING"}]});
    pr["reviewRequests"] = json!({"nodes":[]});
    vectors.push(p);
    let mut p = payload();
    let pr = &mut p["data"]["repository"]["pullRequest"];
    pr["title"] = json!("Açúcar 日本語 😀");
    pr["additions"] = json!("3");
    pr["deletions"] = json!(false);
    pr["pending"] = json!({"nodes":[]});
    pr["author"] = Value::Null;
    pr["comments"] = json!({"nodes":[null,{"id":"x","author":null}]});
    vectors.push(p);
    for (index, payload) in vectors.into_iter().enumerate() {
        let f = fixture(payload.clone());
        assert_eq!(
            f.reader.invoke(&request(&f.project)).unwrap(),
            node_result(&f, &payload),
            "vector {index}"
        );
    }
}

#[test]
fn account_replacement_during_a_read_rejects_late_result_and_reaps_child() {
    let f = fixture(payload());
    fs::write(f.project.join("delay"), "").unwrap();
    let account = f.root.path().join("account");
    let old = f.root.path().join("old-account");
    let calls = f.project.join("calls.jsonl");
    let mutation = std::thread::spawn(move || {
        let by = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !calls.exists() {
            assert!(
                std::time::Instant::now() < by,
                "child did not reach barrier"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        fs::rename(&account, old).unwrap();
        fs::create_dir(account).unwrap();
    });
    assert!(f.reader.invoke(&request(&f.project)).is_err());
    mutation.join().unwrap();
    let calls = fs::read_to_string(f.project.join("calls.jsonl")).unwrap();
    let call: Value = serde_json::from_str(calls.lines().next().unwrap()).unwrap();
    let status = Command::new("/bin/ps")
        .args(["-p", &call["pid"].to_string(), "-o", "pid="])
        .output()
        .unwrap();
    assert!(
        !status.status.success(),
        "Revoked reader must reap its retained child"
    );
}

#[test]
fn invalid_numeric_pr_numbers_match_node_without_starting_a_child() {
    let f = fixture(payload());
    // Node's `number()` returns a result for anything but a positive safe integer:
    // strings, a missing number, booleans and containers included.
    for number in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9e16),
        json!("12"),
        json!(null),
        json!(true),
        json!([12]),
        json!({"n":12}),
    ] {
        let actual = f
            .reader
            .invoke(&[json!({"cwd":f.project,"number":number})])
            .unwrap();
        assert_eq!(actual, node_result_number(&f, &payload(), number.clone()));
        assert_eq!(actual["ok"], false, "{number}");
    }
    let missing = f.reader.invoke(&[json!({"cwd":f.project})]).unwrap();
    assert_eq!(missing, node_result_number(&f, &payload(), json!(null)));
    assert!(!f.project.join("calls.jsonl").exists());
}

#[test]
fn fixed_graphql_queries_match_actual_node_source() {
    let node = include_str!("../../../packages/core/src/pull-request-review.cjs");
    for (name, query) in [
        ("DETAIL_QUERY", include_str!("../src/detail.graphql")),
        ("FILES_QUERY", include_str!("../src/files.graphql")),
    ] {
        let prefix = format!("const {name} = `");
        let actual = node
            .split_once(&prefix)
            .unwrap()
            .1
            .split_once("`;")
            .unwrap()
            .0;
        assert_eq!(
            query, actual,
            "Re-audit normalization when the Node PR query changes"
        );
        assert!(query.starts_with("query("));
        assert!(!query.contains("mutation("));
    }
}

#[test]
fn owner_starts_unknown_and_only_actual_viewer_establishes_ready() {
    let f = fixture(payload());
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Unknown);
    assert!(!f.project.join("calls.jsonl").exists());
    f.reader.invoke(&request(&f.project)).unwrap();
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
    let calls = fs::read_to_string(f.project.join("calls.jsonl")).unwrap();
    for call in calls.lines() {
        let call: Value = serde_json::from_str(call).unwrap();
        assert!(call["args"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .any(|s| s.starts_with("query=") && s.contains("viewer { login }")));
    }
}

#[test]
fn wrong_missing_and_changed_page_viewer_refuse_without_partial_data_and_recover_on_a_later_read() {
    for variant in ["wrong", "missing", "second-page"] {
        let mut p = payload();
        match variant {
            "wrong" => p["data"]["viewer"] = json!({"login":"bob"}),
            "missing" => p["data"]["viewer"] = Value::Null,
            _ => p["page2"]["data"]["viewer"] = json!({"login":"bob"}),
        }
        let f = fixture(p);
        let error = f.reader.invoke(&request(&f.project)).unwrap_err();
        assert_eq!(error.code, "PR_ACCOUNT_NOT_READY");
        assert!(f.selection.snapshot().unwrap().readiness == Readiness::Revoked);
        // Nothing permanent happened to the selection.
        assert_eq!(f.selection.snapshot().unwrap().generation, 0);
        let calls = |f: &Fixture| {
            fs::read_to_string(f.project.join("calls.jsonl"))
                .unwrap()
                .lines()
                .count()
        };
        let first = calls(&f);
        // No retry inside the failed read; a later read proves the viewer again, and
        // while the account is still wrong it is refused again.
        assert_eq!(
            f.reader.invoke(&request(&f.project)).unwrap_err().code,
            "PR_ACCOUNT_NOT_READY"
        );
        assert!(calls(&f) > first, "{variant}: a later read re-validates");
        // `gh auth login` as the selected account: the next read recovers.
        fs::write(f.project.join("response.json"), payload().to_string()).unwrap();
        let result = f.reader.invoke(&request(&f.project)).unwrap();
        assert_eq!(result["ok"], true, "{variant}");
        assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
    }
}

#[test]
fn authentication_failure_is_node_s_sign_in_result_and_a_later_read_recovers() {
    let f = fixture(
        json!({"_exitCode":4,"_stderr":"gh: To get started with GitHub CLI, please run:  gh auth login\n"}),
    );
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Unknown);
    let result = f.reader.invoke(&request(&f.project)).unwrap();
    assert_eq!(
        result,
        json!({"ok":false,"message":format!("Sign in to GitHub on {} with `gh auth login`, then try again.",computer())})
    );
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Unknown);
    assert_eq!(f.selection.snapshot().unwrap().generation, 0);
    fs::write(f.project.join("response.json"), payload().to_string()).unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
}

fn failure(code: i64, stdout: &str, stderr: &str) -> Value {
    json!({"_exitCode":code,"_stdout":stdout,"_stderr":stderr})
}

#[test]
fn failed_gh_runs_match_actual_node_error_classification() {
    let long = format!("gh: {}", "x".repeat(450));
    let vectors = vec![
        // Real gh: exit 1, GraphQL errors on stdout and the same words on stderr.
        failure(
            1,
            r#"{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository with the name 'example/repo'."}]}"#,
            "gh: Could not resolve to a Repository with the name 'example/repo'.\n",
        ),
        failure(
            1,
            r#"{"message":"Bad credentials","status":"401"}"#,
            "gh: Bad credentials (HTTP 401)\n",
        ),
        // Auth detection from stderr alone, in each of Node's three phrasings.
        failure(
            1,
            "",
            "To get started with GitHub CLI, please run:  gh auth login\n",
        ),
        failure(1, "", "You are not logged in to any GitHub hosts.\n"),
        failure(1, "", "Authentication Required for this request\n"),
        failure(4, "", ""),
        // stderr sign-in wins over a GraphQL error body.
        failure(
            1,
            r#"{"errors":[{"message":"Some GraphQL failure"}]}"#,
            "gh auth login\n",
        ),
        // Words the old Rust list revoked on but Node shows as GitHub's own text.
        failure(
            1,
            "",
            "gh: HTTP 401: Requires authentication (https://api.github.com/graphql)\n",
        ),
        failure(1, "", "gh: Bad credentials\n"),
        // Raw text on either stream, prefixes, blank lines, and the 400 cut.
        failure(1, "plain text\nsecond line", ""),
        failure(1, "", "\n\n  GraphQL: Something broke  \nmore\n"),
        failure(1, "", &long),
        failure(1, "not json", "Açúcar 日本語 😀 failed\n"),
        failure(
            1,
            r#"{"errors":[{"message":""}]}"#,
            "gh: empty message falls through\n",
        ),
        // A zero exit is never classified from stderr: Node reads the GraphQL errors.
        json!({"_stderr":"gh auth login\nnot logged in\n","errors":[{"message":"Bad credentials"}]}),
        json!({"errors":[{"message":""}]}),
        json!({"errors":[{"nope":true}]}),
    ];
    for (index, vector) in vectors.into_iter().enumerate() {
        let f = fixture(vector.clone());
        let actual = f.reader.invoke(&request(&f.project)).unwrap();
        assert_eq!(actual, node_result(&f, &vector), "vector {index}");
        assert_eq!(actual["ok"], false, "vector {index}");
    }
}

#[test]
fn a_silent_failed_exit_says_gh_did_not_answer() {
    // Node falls back to execFile's "Command failed: gh api ..." text, which carries
    // the whole argv including the query. This service never repeats it.
    let f = fixture(failure(1, "", ""));
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap(),
        json!({"ok":false,"message":"GitHub didn't answer."})
    );
}

#[test]
fn close_expires_the_grant_for_good() {
    let f = fixture(payload());
    f.selection.close();
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Closed);
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
}

#[test]
fn dropping_the_owner_expires_the_grant_for_good() {
    let f = fixture(payload());
    drop(f.selection);
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
}

#[test]
fn an_account_file_edit_between_reads_is_adopted_by_the_next_read() {
    // `gh auth login` between reads rewrites hosts.yml: the next read adopts it,
    // and still has to see the selected viewer before it accepts anything.
    let f = fixture(payload());
    fs::write(
        f.root.path().join("account/hosts.yml"),
        "synthetic-login: bobby\n",
    )
    .unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
    assert_eq!(f.selection.snapshot().unwrap().generation, 0);
}

#[test]
fn account_file_edit_during_a_read_refuses_that_read_and_the_next_one_recovers() {
    let f = fixture(payload());
    fs::write(f.project.join("delay"), "").unwrap();
    let hosts = f.root.path().join("account/hosts.yml");
    let calls = f.project.join("calls.jsonl");
    let edit = std::thread::spawn(move || {
        wait_for(|| calls.exists());
        fs::write(hosts, "synthetic-login: bobby\n").unwrap();
    });
    let error = f.reader.invoke(&request(&f.project)).unwrap_err();
    edit.join().unwrap();
    assert_eq!(error.code, "PR_SELECTION_REVOKED");
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Revoked);
    fs::remove_file(f.project.join("delay")).unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
}

#[test]
fn a_non_private_account_file_is_refused_until_it_is_private_again() {
    let f = fixture(payload());
    let hosts = f.root.path().join("account/hosts.yml");
    fs::set_permissions(&hosts, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
    fs::set_permissions(&hosts, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
}

fn wait_for(mut condition: impl FnMut() -> bool) {
    let by = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < by, "condition not reached");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn single_page() -> Value {
    let mut p = payload();
    p["data"]["repository"]["pullRequest"]["files"]["pageInfo"] =
        json!({"hasNextPage":false,"endCursor":null});
    p.as_object_mut().unwrap().remove("page2");
    p
}
fn calls(f: &Fixture) -> Vec<Value> {
    fs::read_to_string(f.project.join("calls.jsonl"))
        .map(|text| {
            text.lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        })
        .unwrap_or_default()
}
fn gone_process(pid: &Value) -> bool {
    !Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .output()
        .unwrap()
        .status
        .success()
}
fn number_args(project: &Path, number: u64) -> Vec<Value> {
    vec![json!({"cwd":project,"number":number})]
}

#[test]
fn concurrent_reads_of_one_pr_join_a_single_gh_read() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    std::thread::scope(|s| {
        let first = s.spawn(|| f.reader.invoke(&request(&f.project)));
        wait_for(|| !calls(&f).is_empty());
        let others: Vec<_> = (0..3)
            .map(|_| s.spawn(|| f.reader.invoke(&request(&f.project))))
            .collect();
        std::thread::sleep(Duration::from_millis(150));
        fs::remove_file(f.project.join("hold")).unwrap();
        let expected = first.join().unwrap().unwrap();
        assert_eq!(expected["ok"], true);
        for other in others {
            assert_eq!(other.join().unwrap().unwrap(), expected);
        }
    });
    assert_eq!(calls(&f).len(), 1, "every waiter shared one gh child");
}

#[test]
fn different_numbers_queue_one_at_a_time_in_order() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    std::thread::scope(|s| {
        let first = s.spawn(|| f.reader.invoke(&number_args(&f.project, 12)));
        wait_for(|| calls(&f).len() == 1);
        let second = s.spawn(|| f.reader.invoke(&number_args(&f.project, 13)));
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(calls(&f).len(), 1, "the second PR waits, it is not refused");
        fs::remove_file(f.project.join("hold")).unwrap();
        assert_eq!(first.join().unwrap().unwrap()["pr"]["number"], 12);
        assert_eq!(second.join().unwrap().unwrap()["pr"]["number"], 13);
    });
    let calls = calls(&f);
    assert_eq!(calls.len(), 2);
    let ends: Vec<f64> = fs::read_to_string(f.project.join("ends.jsonl"))
        .unwrap()
        .lines()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["t"]
                .as_f64()
                .unwrap()
        })
        .collect();
    assert!(
        calls[1]["t"].as_f64().unwrap() >= ends[0],
        "the queued read started only after the first one finished"
    );
}

#[test]
fn the_queue_is_small_and_refuses_beyond_its_bound() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    std::thread::scope(|s| {
        let mut held = Vec::new();
        for number in 1..=4u64 {
            let f = &f;
            held.push(s.spawn(move || f.reader.invoke(&number_args(&f.project, number))));
            if number == 1 {
                wait_for(|| calls(f).len() == 1);
            }
            std::thread::sleep(Duration::from_millis(60));
        }
        let error = f.reader.invoke(&number_args(&f.project, 5)).unwrap_err();
        assert_eq!(error.code, "PR_READ_BUSY");
        fs::remove_file(f.project.join("hold")).unwrap();
        for read in held {
            assert_eq!(read.join().unwrap().unwrap()["ok"], true);
        }
    });
    assert_eq!(calls(&f).len(), 4);
}

#[test]
fn a_lone_waiter_whose_client_went_away_cancels_and_reaps_the_child() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    let gone = AtomicBool::new(false);
    std::thread::scope(|s| {
        let read = s.spawn(|| {
            f.reader
                .invoke_cancellable(&request(&f.project), &|| gone.load(Ordering::Acquire))
        });
        wait_for(|| calls(&f).len() == 1);
        let started = Instant::now();
        gone.store(true, Ordering::Release);
        let error = read.join().unwrap().unwrap_err();
        assert_eq!(error.code, "PR_READ_CANCELLED");
        assert!(started.elapsed() < Duration::from_secs(3), "not 30 seconds");
    });
    // Still held, yet the child is gone and the slot is free.
    let pid = calls(&f)[0]["pid"].clone();
    wait_for(|| gone_process(&pid));
    assert_eq!(f.reader.monitor().active_children(), 0);
    fs::remove_file(f.project.join("hold")).unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
    assert_eq!(calls(&f).len(), 2);
}

#[test]
fn a_shared_read_survives_one_waiter_leaving_but_not_all_of_them() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    let (a_gone, b_gone) = (AtomicBool::new(false), AtomicBool::new(false));
    std::thread::scope(|s| {
        let a = s.spawn(|| {
            f.reader
                .invoke_cancellable(&request(&f.project), &|| a_gone.load(Ordering::Acquire))
        });
        wait_for(|| calls(&f).len() == 1);
        let b = s.spawn(|| {
            f.reader
                .invoke_cancellable(&request(&f.project), &|| b_gone.load(Ordering::Acquire))
        });
        std::thread::sleep(Duration::from_millis(100));
        // The runner's own client leaves; B still waits, so the read goes on.
        a_gone.store(true, Ordering::Release);
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            !gone_process(&calls(&f)[0]["pid"]),
            "B still needs this child"
        );
        // A's thread is the one running the read, so it returns when the read does.
        fs::remove_file(f.project.join("hold")).unwrap();
        assert_eq!(b.join().unwrap().unwrap()["ok"], true);
        assert_eq!(a.join().unwrap().unwrap_err().code, "PR_READ_CANCELLED");
    });
    assert_eq!(calls(&f).len(), 1);

    fs::write(f.project.join("hold"), "").unwrap();
    let (a_gone, b_gone) = (AtomicBool::new(false), AtomicBool::new(false));
    std::thread::scope(|s| {
        let a = s.spawn(|| {
            f.reader
                .invoke_cancellable(&request(&f.project), &|| a_gone.load(Ordering::Acquire))
        });
        wait_for(|| calls(&f).len() == 2);
        let b = s.spawn(|| {
            f.reader
                .invoke_cancellable(&request(&f.project), &|| b_gone.load(Ordering::Acquire))
        });
        std::thread::sleep(Duration::from_millis(100));
        b_gone.store(true, Ordering::Release);
        assert_eq!(b.join().unwrap().unwrap_err().code, "PR_READ_CANCELLED");
        a_gone.store(true, Ordering::Release);
        assert_eq!(a.join().unwrap().unwrap_err().code, "PR_READ_CANCELLED");
    });
    wait_for(|| gone_process(&calls(&f)[1]["pid"]));
    assert_eq!(f.reader.monitor().active_children(), 0);
}

#[test]
fn a_queued_waiter_that_leaves_never_starts_its_read() {
    let f = fixture(single_page());
    fs::write(f.project.join("hold"), "").unwrap();
    let gone = AtomicBool::new(false);
    std::thread::scope(|s| {
        let first = s.spawn(|| f.reader.invoke(&number_args(&f.project, 12)));
        wait_for(|| calls(&f).len() == 1);
        let queued = s.spawn(|| {
            f.reader
                .invoke_cancellable(&number_args(&f.project, 13), &|| {
                    gone.load(Ordering::Acquire)
                })
        });
        std::thread::sleep(Duration::from_millis(100));
        gone.store(true, Ordering::Release);
        assert_eq!(
            queued.join().unwrap().unwrap_err().code,
            "PR_READ_CANCELLED"
        );
        fs::remove_file(f.project.join("hold")).unwrap();
        assert_eq!(first.join().unwrap().unwrap()["ok"], true);
    });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(calls(&f).len(), 1, "PR 13 was never read");
}

#[test]
fn pause_cancels_reads_and_resume_restores_them_without_closing_the_selection() {
    let f = fixture(single_page());
    f.reader.pause();
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
    f.reader.resume();
    fs::write(f.project.join("hold"), "").unwrap();
    std::thread::scope(|s| {
        let read = s.spawn(|| f.reader.invoke(&request(&f.project)));
        wait_for(|| calls(&f).len() == 1);
        f.reader.pause();
        assert_eq!(
            read.join().unwrap().unwrap_err().code,
            "PR_SELECTION_REVOKED"
        );
    });
    wait_for(|| gone_process(&calls(&f)[0]["pid"]));
    f.reader.resume();
    fs::remove_file(f.project.join("hold")).unwrap();
    assert_eq!(f.reader.invoke(&request(&f.project)).unwrap()["ok"], true);
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Ready);
}

#[test]
fn a_file_list_past_the_page_limit_is_the_same_partial_list_as_node() {
    // GitHub keeps saying there is another page: Node reads 30 pages and shows what it has.
    let mut p = payload();
    p["page2"]["data"]["repository"]["pullRequest"]["files"]["pageInfo"] =
        json!({"hasNextPage":true,"endCursor":"next-page"});
    let f = fixture(p.clone());
    let actual = f.reader.invoke(&request(&f.project)).unwrap();
    assert_eq!(actual, node_result(&f, &p));
    assert_eq!(actual["pr"]["files"].as_array().unwrap().len(), 30);
    assert_eq!(calls(&f).len(), 30);
}
