# Rust command-policy checkpoint

A native, synchronous static classifier for the Rust provider's `CommandClassifier` boundary.
It parses source; it never executes a shell command, reads a script or config file, starts a
provider, or accesses a network. It is not wired into a production owner.

```rust
use milagre_command_policy::ShellClassifier;
use milagre_providers::codex::guard::CommandClassifier;

assert!(ShellClassifier.actions("git status").unwrap().is_empty());
assert!(ShellClassifier.actions("git $subcommand").is_err());
// Owner integration: options.command_classifier = Some(Arc::new(ShellClassifier));
```

The crate depends on `../rust-providers` and implements its existing trait directly. The
provider applies babysit level rules to the returned `RemoteAction` facts before handling a
permission mode or a user's answer. An error must stay a denial, including under Full. An
empty vector means the supported source was classified without a remote write; it never means
unknown syntax. A single unsupported part makes the entire command return an error, even if
other parts contained recognized actions. No command text appears in errors or `Debug`.

## Execution preconditions and remaining owner work

This is **source classification, not a shell sandbox or a proof about installed programs**.
Before using it for constrained execution, the owner must ensure a known noninteractive Bash
compatible shell, a controlled environment and PATH, no inherited shell functions or startup
scripts, and trusted Git/gh executables and configuration. A preexisting function named `git`,
a replacement executable on PATH, a Git commit hook, an external diff driver, a signing helper,
a credential/transport helper or a compromised CLI can execute unrelated code. Static source
alone cannot discover those without I/O. This crate deliberately performs no I/O.

The isolated owner has **not demonstrated those execution preconditions**, and this checkpoint
must not be treated as permission to enable production babysit turns. The owner still needs
an execution capability enforcing them, plus real provider-boundary tests using this classifier.
Existing provider tests prove that classification errors/guard denials precede Full-mode
handling; this crate tests action facts and level rules, not a running provider session.

## Supported surface

- Bash command lists, pipelines, subshells, compound blocks, `if` branches and negation. Every
  branch is inspected regardless of whether it would execute. Single/double/ANSI-C quotes,
  escaped characters and adjacent literal fragments are decoded. Comments stay comments.
- Literal `command`, `nohup`, `time`, and `env`/`env -i` wrappers. `bash -c`, `sh -c`, `dash -c`
  and literal `eval` scripts are parsed recursively. Login shells and startup options are refused.
- Command substitutions are inspected as executable syntax. Their unknown output can be data
  for `echo` and the supported `printf` formats; using it as a command or Git/gh argument is
  refused. `printf -v`, `%n` and opaque formats are refused because they can assign variables.
- Recognized Git writes (`push`, `send-pack`, `subtree push`) and an explicit local-command
  allowlist. Known global options and a literal inline `alias.name=push` are supported; unknown
  aliases/configuration, shell aliases and execution-helper options are refused. Git subcommands
  in the local allowlist remain subject to the trusted configuration precondition above.
- Known `gh pr`/`issue`/`repo` operations, REST route/method/field classification and parsed
  GraphQL queries/mutations. GraphQL aliases are resolved by field name. Unknown mutation
  fields, fragments and opaque `updatePullRequest` input objects are refused.

Only literal `true`, `false`, `:`, `pwd`, `cd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep` and
`sleep` join the data-only `echo`/`printf` commands in the non-Git allowlist. This is intentionally
small. In particular, an arbitrary executable is not classified safe based on its absence from
the Node word scan. Arbitrary executable paths are refused; `/bin/` and `/usr/bin/` paths are
accepted only for recognized names.

## Explicit unsupported behavior

Variables, glob/brace/tilde expansion, process substitution, arithmetic, functions, loops,
assignments, redirections, heredocs/here-strings, `source`, shell script files, `xargs`, `sudo`,
login shells, zsh/fish/ksh, interpreters, package/test scripts, network clients and unknown
executables return an error. Even `npm test` is opaque source and is refused, because it may
run a script that pushes or merges. This is a substantial compatibility gap for babysit fixes.

REST writes with unknown endpoints, query/fragment strings, percent-encoded routes, ambiguous
traversal, unknown methods or unsupported API options are refused. GraphQL input from files
**or stdin** is `GraphqlFile`; an edited PR/issue body from files **or stdin** is `BodyFile`.
No pipe/heredoc dataflow is inferred. Recognized opaque facts are always denied by existing
provider policy at every babysit level.

Limits: 128 KiB cumulative source, 8,192 visited AST nodes, 64 AST depth, 16 nested-script depth,
and a 250 ms elapsed analysis budget checked during AST traversal and Tree-sitter progress.
Limits return an error. GraphQL's parser also has its own recursion limit (50).

## Node comparison and intentional differences

`node scripts/record.cjs` runs the repository's actual `babysit-guard.test.cjs` callbacks and
records every distinct call to the real `actionsOf`. Private export access is confined to the
recorder's VM. No production source is modified. It adds the adversarial inputs in
`tests/adversarial.json`, still through the real Node function. `--check` detects fixture drift.
The recorder never executes any input command.

Current fixtures contain **218 distinct inputs: 133 classified and 85 explicitly refused**.
`tests/outcomes.json` pins the exact accepted/refused surface so widening or reducing it requires
review. For the 133 accepted inputs, 122 match Node's facts exactly. The 11 deviations are:

1. Six opaque-stdin cases return an always-denied file/body fact. Node sometimes infers a body
   from unrelated text elsewhere on the line and even returns no action for bare GraphQL stdin.
2. Three Node false positives are corrected: `echo git push`, a mutation name inside a GraphQL
   query string, and a mutation name inside an ordinary comment body. Actual command positions
   and parsed mutation fields decide the actions.
3. Two `updatePullRequest(input:{state:OPEN|CLOSED})` cases return `Close`, where Node returns
   `Reply`. GitHub documents that this mutation can close/reopen a PR. An entire variable input
   is refused because it may carry `state`; an explicit `state` field is conservatively `Close`
   even if its value is a variable.

Tests also cover 60 adversarial cases, level rules, limits, static errors/Debug and 1,000
malformed Unicode/token combinations. This is a bounded checkpoint, not complete shell or
GitHub API parity. Windows shells/process execution are unsupported.

## Validation

```text
cargo test --manifest-path experiments/rust-command-policy/Cargo.toml
cargo clippy --manifest-path experiments/rust-command-policy/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-command-policy/Cargo.toml -- --check
node experiments/rust-command-policy/scripts/record.cjs --check
```

Parser sources checked: [Tree-sitter Bash 0.25.1](https://docs.rs/tree-sitter-bash/0.25.1/tree_sitter_bash/),
[its grammar](https://github.com/tree-sitter/tree-sitter-bash/blob/v0.25.1/src/node-types.json),
[graphql-parser 0.4.1 operation AST](https://docs.rs/graphql-parser/0.4.1/graphql_parser/query/enum.OperationDefinition.html).
The PR-state correction follows [GitHub UpdatePullRequestInput](https://docs.github.com/en/graphql/reference/pulls#updatepullrequestinput).
Both parser dependencies are MIT licensed. Cargo.lock pins the resolved versions.
