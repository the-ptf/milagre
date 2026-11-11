use crate::{Result, UNSUPPORTED};
use graphql_parser::query::{Definition, OperationDefinition, Selection, Value};
use milagre_providers::codex::guard::RemoteAction::{self, *};
use regex::Regex;
use std::sync::LazyLock;

pub(crate) fn git(args: &[&str]) -> Result<Vec<RemoteAction>> {
    let mut i = 0;
    let mut alias = None;
    while args.get(i).is_some_and(|a| a.starts_with('-')) {
        match args[i] {
            "--no-pager" | "--no-optional-locks" | "--literal-pathspecs" => i += 1,
            "-C" | "--git-dir" | "--work-tree" | "--namespace" => {
                args.get(i + 1).ok_or(UNSUPPORTED)?;
                i += 2;
            }
            "-c" => {
                let config = args.get(i + 1).ok_or(UNSUPPORTED)?;
                if let Some((name, value)) = config
                    .strip_prefix("alias.")
                    .and_then(|x| x.split_once('='))
                {
                    // Only a literal alias of push is resolved; shell aliases and extra tokens fail closed.
                    if value != "push" || name.is_empty() || alias.is_some() {
                        return Err(UNSUPPORTED);
                    }
                    alias = Some(name);
                } else if !config.starts_with("user.name=") && !config.starts_with("user.email=") {
                    return Err(UNSUPPORTED);
                }
                i += 2;
            }
            _ => return Err(UNSUPPORTED),
        }
    }
    let sub = *args.get(i).ok_or(UNSUPPORTED)?;
    let rest = &args[i + 1..];
    if rest.iter().any(|a| {
        [
            "--exec",
            "--upload-pack",
            "--receive-pack",
            "--config",
            "--filter",
            "--ext-diff",
            "--textconv",
            "--output",
            "--open-files-in-pager",
        ]
        .iter()
        .any(|p| a.starts_with(p))
    }) {
        return Err(UNSUPPORTED);
    }
    if rest.iter().any(|a| *a == "-x" || a.starts_with("ext::")) {
        return Err(UNSUPPORTED);
    }
    if alias == Some(sub) || matches!(sub, "push" | "send-pack") {
        return Ok(vec![Push]);
    }
    if alias.is_some() {
        return Err(UNSUPPORTED);
    }
    if sub == "subtree" {
        return if rest.first() == Some(&"push") {
            Ok(vec![Push])
        } else {
            Err(UNSUPPORTED)
        };
    }
    match sub {
        "status" | "log" | "diff" | "show" | "rev-parse" | "ls-files" | "ls-tree" | "branch"
        | "fetch" | "commit" | "add" | "restore" | "reset" | "checkout" | "switch" | "merge"
        | "rebase" | "cherry-pick" | "stash" | "blame" | "rev-list" | "show-ref" | "tag" => {
            Ok(vec![])
        }
        _ => Err(UNSUPPORTED),
    }
}
pub(crate) fn gh(args: &[&str]) -> Result<Vec<RemoteAction>> {
    let mut i = 0;
    while args.get(i).is_some_and(|a| a.starts_with('-')) {
        if matches!(args[i], "-R" | "--repo") {
            args.get(i + 1).ok_or(UNSUPPORTED)?;
            i += 2;
        } else if args[i].starts_with("--repo=") {
            i += 1;
        } else {
            return Err(UNSUPPORTED);
        }
    }
    if args.iter().any(|a| matches!(*a, "--editor" | "-e")) {
        return Err(UNSUPPORTED);
    }
    let group = *args.get(i).ok_or(UNSUPPORTED)?;
    if group == "api" {
        return api(&args[i + 1..]);
    }
    let cmd = *args.get(i + 1).ok_or(UNSUPPORTED)?;
    let rest = &args[i + 2..];
    match (group, cmd) {
        ("pr", "merge") => Ok(vec![Merge]),
        ("pr" | "issue", "close" | "reopen") => Ok(vec![Close]),
        ("pr", "update-branch") | ("repo", "sync") => Ok(vec![Push]),
        ("pr", "comment" | "review" | "ready") | ("issue", "comment" | "edit") => Ok(vec![Reply]),
        ("pr", "edit") => {
            let mut rerequest = false;
            let mut edits = false;
            let mut at = 0;
            while at < rest.len() {
                let word = rest[at];
                if matches!(word, "--add-reviewer" | "-R" | "--repo") {
                    rerequest |= word == "--add-reviewer";
                    rest.get(at + 1).ok_or(UNSUPPORTED)?;
                    at += 1;
                } else if word.starts_with("--add-reviewer=") {
                    rerequest = true;
                } else if word.starts_with('-') && !word.starts_with("--repo=") {
                    edits = true;
                }
                at += 1;
            }
            let mut out = Vec::new();
            if rerequest {
                out.push(Rerequest);
            }
            if edits || !rerequest {
                out.push(Reply);
            }
            Ok(out)
        }
        ("pr", "view" | "list" | "status" | "checks" | "diff")
        | ("issue", "view" | "list" | "status")
        | ("repo", "view" | "list") => Ok(vec![]),
        _ => Err(UNSUPPORTED),
    }
}
fn api(args: &[&str]) -> Result<Vec<RemoteAction>> {
    let mut endpoint = None;
    let mut method = None;
    let mut fields = Vec::new();
    let mut input = None;
    let mut i = 0;
    while i < args.len() {
        let word = args[i];
        if !word.starts_with('-') {
            if endpoint.replace(word).is_some() {
                return Err(UNSUPPORTED);
            }
            i += 1;
            continue;
        }
        let (flag, inline) = if word.starts_with("--") {
            word.split_once('=')
                .map_or((word, None), |(f, v)| (f, Some(v)))
        } else if word.len() > 2 && matches!(word.as_bytes().get(1), Some(b'X' | b'f' | b'F')) {
            (&word[..2], Some(&word[2..]))
        } else {
            (word, None)
        };
        if matches!(
            flag,
            "--paginate" | "--slurp" | "--silent" | "--include" | "--verbose"
        ) {
            if inline.is_some() {
                return Err(UNSUPPORTED);
            }
            i += 1;
            continue;
        }
        if !matches!(
            flag,
            "-X" | "--method"
                | "-f"
                | "-F"
                | "--field"
                | "--raw-field"
                | "--input"
                | "-q"
                | "--jq"
                | "--hostname"
                | "--cache"
                | "-p"
                | "--preview"
        ) {
            return Err(UNSUPPORTED);
        }
        let value = match inline {
            Some(v) => v,
            None => {
                i += 1;
                *args.get(i).ok_or(UNSUPPORTED)?
            }
        };
        match flag {
            "-X" | "--method" => {
                if method.replace(value.to_ascii_uppercase()).is_some() {
                    return Err(UNSUPPORTED);
                }
            }
            "-f" | "-F" | "--field" | "--raw-field" => fields.push(value),
            "--input" => {
                input = match input {
                    None => Some(value),
                    Some(_) => return Err(UNSUPPORTED),
                };
            }
            _ => {}
        }
        i += 1;
    }
    let endpoint = endpoint.ok_or(UNSUPPORTED)?;
    if endpoint == "graphql" {
        if input.is_some() || fields.iter().any(|f| f.starts_with("query=@")) {
            return Ok(vec![GraphqlFile]);
        }
        let queries: Vec<_> = fields
            .iter()
            .filter_map(|v| v.strip_prefix("query="))
            .collect();
        if queries.len() != 1 {
            return Err(UNSUPPORTED);
        }
        return graphql(queries[0]);
    }
    let method = method
        .as_deref()
        .unwrap_or(if fields.is_empty() && input.is_none() {
            "GET"
        } else {
            "POST"
        });
    if method == "GET" {
        return Ok(vec![]);
    }
    if !matches!(method, "POST" | "PATCH" | "PUT" | "DELETE") {
        return Err(UNSUPPORTED);
    }
    // Decode ambiguities, host substitution and endpoint traversal must never bypass the route map.
    if endpoint.contains(['%', '\\', '{', '}', '?', '#'])
        || endpoint.split('/').any(|p| matches!(p, "." | ".."))
    {
        return Err(UNSUPPORTED);
    }
    let route = format!(
        "/{}",
        endpoint
            .split(['?', '#'])
            .next()
            .ok_or(UNSUPPORTED)?
            .trim_matches('/')
    );
    static ROUTES: LazyLock<Vec<(RemoteAction, Regex)>> = LazyLock::new(|| {
        [
            (Merge, r"/pulls/\d+/merge$|/merges$"),
            (Rerequest, r"/requested_reviewers$"),
            (Reply, r"/(?:comments|replies|reviews)(?:/|$)"),
            (
                Push,
                r"/git/refs(?:/|$)|/contents(?:/|$)|/update-branch$|/merge-upstream$",
            ),
            (Reply, r"/(?:pulls|issues)/\d+$"),
            (Reply, r"/issues/\d+/(?:labels|assignees)(?:/|$)"),
        ]
        .into_iter()
        .map(|(a, p)| (a, Regex::new(p).expect("constant regex")))
        .collect()
    });
    static EDIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"/(?:pulls|issues)/\d+$").expect("constant regex"));
    let action = ROUTES
        .iter()
        .find(|(_, p)| p.is_match(&route))
        .map(|(a, _)| *a)
        .ok_or(UNSUPPORTED)?;
    if EDIT.is_match(&route) {
        if fields.iter().any(|v| v.starts_with("state=")) {
            return Ok(vec![Close]);
        }
        if input.is_some() {
            return Ok(vec![BodyFile]);
        }
        // Bracketed state keys may be decoded by gh into a closing body; don't infer safe edits.
        if fields.iter().any(|v| v.starts_with("state[")) {
            return Err(UNSUPPORTED);
        }
    }
    Ok(vec![action])
}
fn graphql(query: &str) -> Result<Vec<RemoteAction>> {
    let doc = graphql_parser::parse_query::<String>(query).map_err(|_| UNSUPPORTED)?;
    let mut actions = Vec::new();
    for definition in doc.definitions {
        match definition {
            Definition::Operation(OperationDefinition::Mutation(mutation)) => {
                for item in mutation.selection_set.items {
                    let Selection::Field(field) = item else {
                        return Err(UNSUPPORTED);
                    };
                    let action = match field.name.as_str() {
                        "updatePullRequest" => {
                            // Unlike Node's name-only match, this mutation can close/reopen.
                            // An opaque input variable could carry state, so fail closed.
                            let input = field
                                .arguments
                                .iter()
                                .find(|(name, _)| name == "input")
                                .map(|(_, value)| value)
                                .ok_or(UNSUPPORTED)?;
                            let Value::Object(fields) = input else {
                                return Err(UNSUPPORTED);
                            };
                            if fields.contains_key("state") {
                                Close
                            } else {
                                Reply
                            }
                        }
                        "mergePullRequest"
                        | "enablePullRequestAutoMerge"
                        | "enqueuePullRequest"
                        | "mergeBranch" => Merge,
                        "closePullRequest" | "reopenPullRequest" => Close,
                        "createCommitOnBranch"
                        | "updateRef"
                        | "updateRefs"
                        | "createRef"
                        | "deleteRef"
                        | "updatePullRequestBranch" => Push,
                        "addPullRequestReviewComment"
                        | "addPullRequestReviewThreadReply"
                        | "addPullRequestReviewThread"
                        | "addPullRequestReview"
                        | "submitPullRequestReview"
                        | "addComment"
                        | "updateIssueComment"
                        | "updatePullRequestReviewComment"
                        | "markPullRequestReadyForReview"
                        | "convertPullRequestToDraft" => Reply,
                        "requestReviews" | "requestReviewsByLogin" => Rerequest,
                        "resolveReviewThread" | "unresolveReviewThread" => Resolve,
                        _ => return Err(UNSUPPORTED),
                    };
                    if !actions.contains(&action) {
                        actions.push(action);
                    }
                }
            }
            Definition::Operation(
                OperationDefinition::Query(_) | OperationDefinition::SelectionSet(_),
            ) => {}
            _ => return Err(UNSUPPORTED),
        }
    }
    // Preserve Node's precedence within a single GraphQL request.
    actions.sort_by_key(|a| match a {
        Merge => 0,
        Close => 1,
        Push => 2,
        Reply => 3,
        Rerequest => 4,
        Resolve => 5,
        _ => 6,
    });
    Ok(actions)
}
