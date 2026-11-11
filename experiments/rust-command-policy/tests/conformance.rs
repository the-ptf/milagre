use milagre_command_policy::ShellClassifier;
use milagre_providers::codex::guard::{babysit_denial, CommandClassifier, RemoteAction};
use serde_json::Value;
fn actions(value: &Value) -> Vec<RemoteAction> {
    serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn replay_actual_node_guard_with_explicit_supported_surface() {
    let node: Vec<Value> = serde_json::from_str(include_str!("node-traces.json")).unwrap();
    let expected: Vec<Value> = serde_json::from_str(include_str!("outcomes.json")).unwrap();
    assert_eq!(node.len(), 218);
    assert_eq!(node.len(), expected.len());
    let mut counts = (0, 0, 0);
    for (case, expect) in node.iter().zip(&expected) {
        assert_eq!(case["command"], expect["command"]);
        let command = case["command"].as_str().unwrap();
        match ShellClassifier.actions(command) {
            Ok(actual) => {
                assert_eq!(
                    serde_json::to_value(&actual).unwrap(),
                    expect["actions"],
                    "{command}"
                );
                counts.0 += 1;
                let from_node = actions(&case["actions"]);
                if from_node != actual {
                    counts.2 += 1;
                    // Three real false positives in Node's word/regex scanning; other
                    // differences are conservative opaque-stdin facts, always denied.
                    let false_positive=matches!(command,
                        "echo git push" |
                        "gh api graphql -f 'query=query { repository(name: \"mergePullRequest\") { id } }'" |
                        "gh api graphql -f 'query=mutation { addComment(input: {body: \"mergePullRequest\"}) { clientMutationId } }'");
                    if !false_positive {
                        assert!(
                            actual.contains(&RemoteAction::GraphqlFile)
                                || actual.contains(&RemoteAction::BodyFile)
                                || (actual == [RemoteAction::Close]
                                    && command.contains("updatePullRequest")),
                            "undocumented difference: {command}"
                        );
                        for level in 1..=5 {
                            assert!(babysit_denial(&actual, level, true).is_some());
                        }
                    }
                }
            }
            Err(error) => {
                assert_eq!(Value::String(error), expect["error"], "{command}");
                counts.1 += 1;
            }
        }
    }
    assert_eq!(counts, (133, 85, 11));
}
#[test]
fn adversarial_cases_fail_closed_or_name_the_actual_action() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("adversarial.json")).unwrap();
    for case in cases {
        let command = case["command"].as_str().unwrap();
        let result = ShellClassifier.actions(command);
        if case["error"] == true {
            assert!(result.is_err(), "{command}: {result:?}");
        } else {
            assert_eq!(result.unwrap(), actions(&case["actions"]), "{command}");
        }
    }
}
#[test]
fn level_rules_receive_facts_before_any_full_mode_decision() {
    for (command, minimum) in [
        ("git push", 3),
        ("gh pr comment 1 --body hi", 4),
        ("gh pr edit 1 --add-reviewer me", 5),
    ] {
        let facts = ShellClassifier.actions(command).unwrap();
        for level in 1..=5 {
            assert_eq!(
                babysit_denial(&facts, level, true).is_some(),
                level < minimum
            );
        }
    }
    for command in [
        "gh pr merge 1",
        "gh pr close 1",
        "gh api graphql --input -",
        "gh api repos/o/r/pulls/1 --input body.json",
    ] {
        let facts = ShellClassifier.actions(command).unwrap();
        for level in 1..=5 {
            for resolve in [false, true] {
                assert!(babysit_denial(&facts, level, resolve).is_some());
            }
        }
    }
}
#[test]
fn bounded_recursion_and_input_refuse_instead_of_returning_no_actions() {
    assert!(ShellClassifier
        .actions(&" ".repeat(128 * 1024 + 1))
        .is_err());
    assert!(ShellClassifier
        .actions(&format!("{}git push{}", "(".repeat(100), ")".repeat(100)))
        .is_err());
    assert!(ShellClassifier.actions(&"echo hi;".repeat(5000)).is_err());
    let mut script = "git push".to_string();
    for _ in 0..10 {
        script = format!("bash -c '{}'", script.replace('\'', "'\\''"));
    }
    assert!(ShellClassifier.actions(&script).is_err());
    assert!(ShellClassifier.actions("echo \0password").is_err());
}
#[test]
fn errors_and_debug_do_not_disclose_input() {
    let secret = "synthetic-secret-not-real";
    let error = ShellClassifier
        .actions(&format!("{secret} $UNKNOWN"))
        .unwrap_err();
    assert!(!error.contains(secret));
    assert_eq!(format!("{:?}", ShellClassifier), "ShellClassifier");
    fn send_sync<T: Send + Sync>() {}
    send_sync::<ShellClassifier>();
}
#[test]
fn malformed_unicode_and_shell_tokens_never_panic() {
    let tokens = [
        "é", "💥", "\\", "'", "\"", "$", "(", ")", "{", "}", "*", "\n", "gh api -", "git ", "\0",
        "a", "#", ";", "|", "`",
    ];
    let mut seed = 7u64;
    for _ in 0..1000 {
        let mut text = String::new();
        for _ in 0..24 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            text.push_str(tokens[(seed >> 32) as usize % tokens.len()]);
        }
        assert!(std::panic::catch_unwind(|| ShellClassifier.actions(&text)).is_ok());
    }
}
