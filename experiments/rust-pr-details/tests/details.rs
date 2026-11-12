#![recursion_limit = "512"]
use milagre_pr_details::{CapturedContext, DetailsReader, GithubSelectionOwner, Readiness};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Fixture {
    root: tempfile::TempDir,
    project: PathBuf,
    program: PathBuf,
    reader: DetailsReader,
    selection: GithubSelectionOwner,
    ready: Arc<AtomicBool>,
}
fn fixture(response: Value) -> Fixture {
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
    fs::write(project.join("response.json"), response.to_string()).unwrap();
    let script = root.path().join("fake.py");
    fs::write(
        &script,
        r#"import json,os,sys
args=sys.argv[1:]
with open('calls.jsonl','a') as f: f.write(json.dumps({'args':args,'env':dict(os.environ),'pid':os.getpid()})+'\n')
assert args[:4]==['api','graphql','--hostname','github.com']
assert 'owner=example' in args and 'name=repo' in args
assert not any(x in os.environ for x in ['GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS'])
assert os.environ['GH_PROMPT_DISABLED']=='1'
if os.path.exists('delay'):
    import time
    time.sleep(0.2)
data=json.load(open('response.json'))
if 'after=next-page' in args: data=data['page2']
elif 'page2' in data: del data['page2']
data.setdefault('data',{}).setdefault('viewer',{'login':'alice'})
if data.get('_exitCode'): sys.exit(data['_exitCode'])
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
        computer_label: "this test Mac".into(),
        lifetime: Arc::new(()),
        check: Arc::new(move || {
            if check.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err("Owner revoked".into())
            }
        }),
        local_commits: Some(Arc::new(|_, _| Ok(2))),
    })
    .unwrap();
    let reader = selection.reader().unwrap();
    Fixture {
        root,
        project,
        program,
        reader,
        selection,
        ready,
    }
}
fn payload() -> Value {
    json!({"data":{"repository":{"pullRequest":{
    "id":"PR_12","number":12,"url":"https://github.com/example/repo/pull/12","title":"Use Rust","body":"Body","state":"OPEN","isDraft":false,
    "author":{"login":"alice"},"baseRefName":"main","headRefName":"rust","baseRefOid":"1111111111111111111111111111111111111111","headRefOid":"2222222222222222222222222222222222222222",
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
fn node_result(response: &Value) -> Value {
    node_result_number(response, json!(12))
}
fn node_result_number(response: &Value, number: Value) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = r#"const fs=require('node:fs');const {createPullRequestReview}=require(process.argv[1]+'/packages/core/src/pull-request-review.cjs');
const {response,number}=JSON.parse(fs.readFileSync(0,'utf8'));
const review=createPullRequestReview({exec:async(_cmd,args)=>({stdout:JSON.stringify(args.includes('after=next-page')?response.page2:response)}),git:{read:{run:async()=>({ok:true,stdout:'2\n'})}}});
review.detail({cwd:'/synthetic',number}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1});"#;
    use std::io::Write;
    let mut child = Command::new("node")
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
            json!({"response":response,"number":number})
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
    assert_eq!(actual, node_result(&p));
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
        vec![json!({"cwd":f.project,"number":"12"})],
        vec![json!({"cwd":f.project})],
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
    let f = fixture(payload());
    let old = f.root.path().join("original");
    fs::rename(&f.project, &old).unwrap();
    fs::create_dir(&f.project).unwrap();
    assert!(f.reader.invoke(&request(&f.project)).is_err());
    assert!(!old.join("calls.jsonl").exists());
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
            node_result(&payload)
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
            node_result(&payload),
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
    for number in [json!(0), json!(-1), json!(1.5), json!(9e16)] {
        assert_eq!(
            f.reader
                .invoke(&[json!({"cwd":f.project,"number":number})])
                .unwrap(),
            node_result_number(&payload(), number)
        );
    }
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
fn wrong_missing_and_changed_page_viewer_revoke_without_partial_data_or_retry() {
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
        assert_eq!(f.selection.snapshot().unwrap().generation, 1);
        let before = fs::read(f.project.join("calls.jsonl")).unwrap();
        assert_eq!(
            f.reader.invoke(&request(&f.project)).unwrap_err().code,
            "PR_ACCOUNT_NOT_READY"
        );
        assert_eq!(before, fs::read(f.project.join("calls.jsonl")).unwrap());
    }
}

#[test]
fn authentication_failure_revokes_the_generation_without_startup_probe() {
    let f = fixture(json!({"_exitCode":4}));
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Unknown);
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_ACCOUNT_NOT_READY"
    );
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Revoked);
}

#[test]
fn close_drop_and_same_size_account_file_edit_expire_real_grants() {
    let f = fixture(payload());
    f.selection.close();
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Closed);
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
    let f = fixture(payload());
    drop(f.selection);
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(!f.project.join("calls.jsonl").exists());
    let f = fixture(payload());
    fs::write(
        f.root.path().join("account/hosts.yml"),
        "synthetic-login: bobby\n",
    )
    .unwrap();
    assert_eq!(
        f.reader.invoke(&request(&f.project)).unwrap_err().code,
        "PR_SELECTION_REVOKED"
    );
    assert!(f.selection.snapshot().unwrap().readiness == Readiness::Revoked);
    assert!(!f.project.join("calls.jsonl").exists());
}
