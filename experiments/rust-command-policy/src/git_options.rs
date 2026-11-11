//! Exact per-subcommand Git options. No abbreviations or unknown flags are admitted.
use crate::{Result, UNSUPPORTED};
struct Options {
    switches: &'static [&'static str],
    values: &'static [&'static str],
    optional: &'static [&'static str],
    inline: &'static [&'static str],
    counts: bool,
}
const NONE: Options = Options {
    switches: &[],
    values: &[],
    optional: &[],
    inline: &[],
    counts: false,
};
fn options(command: &str) -> Option<Options> {
    Some(match command {
        "status" => Options {
            switches: &[
                "--short",
                "-s",
                "--branch",
                "-b",
                "--show-stash",
                "--long",
                "--verbose",
                "-v",
                "--null",
                "-z",
            ],
            optional: &["--porcelain", "--untracked-files", "--ignore-submodules"],
            ..NONE
        },
        "log" | "show" => Options {
            switches: &[
                "--oneline",
                "--stat",
                "--numstat",
                "--shortstat",
                "--name-only",
                "--name-status",
                "--patch",
                "-p",
                "--no-patch",
                "-s",
                "--no-decorate",
                "--all",
                "--reverse",
                "--topo-order",
                "--graph",
                "--no-ext-diff",
                "--no-textconv",
            ],
            inline: &["--format", "--pretty"],
            values: &[
                "--date",
                "--max-count",
                "-n",
                "--since",
                "--until",
                "--author",
                "--grep",
            ],
            optional: &["--decorate"],
            counts: true,
        },
        "diff" => Options {
            switches: &[
                "--stat",
                "--numstat",
                "--shortstat",
                "--name-only",
                "--name-status",
                "--patch",
                "-p",
                "--no-patch",
                "-s",
                "--cached",
                "--staged",
                "--check",
                "--quiet",
                "--exit-code",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--minimal",
                "--word-diff",
                "--ignore-all-space",
                "-w",
                "--ignore-space-change",
                "-b",
            ],
            values: &["--diff-filter"],
            inline: &["--unified"],
            ..NONE
        },
        "rev-parse" => Options {
            switches: &[
                "--verify",
                "--quiet",
                "-q",
                "--show-toplevel",
                "--show-prefix",
                "--show-cdup",
                "--git-dir",
                "--is-inside-work-tree",
                "--is-bare-repository",
                "--symbolic-full-name",
            ],
            optional: &["--short", "--abbrev-ref"],
            ..NONE
        },
        "ls-files" => Options {
            switches: &[
                "-z",
                "--cached",
                "--deleted",
                "--modified",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--stage",
                "--unmerged",
                "--error-unmatch",
                "--full-name",
                "--deduplicate",
            ],
            values: &["--format"],
            ..NONE
        },
        "ls-tree" => Options {
            switches: &[
                "-r",
                "-t",
                "-d",
                "-l",
                "-z",
                "--name-only",
                "--name-status",
                "--full-tree",
                "--full-name",
            ],
            values: &["--format"],
            ..NONE
        },
        "branch" => Options {
            switches: &[
                "--list",
                "--show-current",
                "--all",
                "-a",
                "--remotes",
                "-r",
                "--delete",
                "-d",
                "-D",
                "--move",
                "-m",
                "-M",
                "--copy",
                "-c",
                "-C",
                "--verbose",
                "-v",
                "--no-track",
            ],
            values: &["--format", "--sort", "--set-upstream-to"],
            ..NONE
        },
        "fetch" => Options {
            switches: &[
                "--quiet",
                "-q",
                "--verbose",
                "-v",
                "--prune",
                "--prune-tags",
                "--tags",
                "--no-tags",
                "--force",
                "-f",
                "--dry-run",
                "--atomic",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
            ],
            values: &[
                "--depth",
                "--deepen",
                "--shallow-since",
                "--shallow-exclude",
            ],
            ..NONE
        },
        "commit" => Options {
            switches: &[
                "--all",
                "-a",
                "--amend",
                "--no-edit",
                "--no-gpg-sign",
                "--allow-empty",
                "--allow-empty-message",
                "--dry-run",
                "--quiet",
                "-q",
                "--verbose",
                "-v",
            ],
            values: &["--message", "-m", "--file", "-F"],
            ..NONE
        },
        "add" => Options {
            switches: &[
                "--all",
                "-A",
                "--update",
                "-u",
                "--force",
                "-f",
                "--intent-to-add",
                "-N",
                "--dry-run",
                "-n",
                "--verbose",
                "-v",
            ],
            ..NONE
        },
        "restore" => Options {
            switches: &[
                "--staged",
                "--worktree",
                "--ours",
                "--theirs",
                "--ignore-unmerged",
                "--quiet",
                "-q",
            ],
            values: &["--source", "-s"],
            ..NONE
        },
        "reset" => Options {
            switches: &[
                "--soft", "--mixed", "--hard", "--merge", "--keep", "--quiet", "-q",
            ],
            ..NONE
        },
        "checkout" => Options {
            switches: &[
                "--detach",
                "--force",
                "-f",
                "--quiet",
                "-q",
                "--ours",
                "--theirs",
                "--no-track",
            ],
            values: &["-b", "-B", "--orphan"],
            ..NONE
        },
        "switch" => Options {
            switches: &["--detach", "--force", "-f", "--quiet", "-q", "--no-track"],
            values: &["-c", "-C", "--orphan"],
            ..NONE
        },
        "merge" => Options {
            switches: &[
                "--no-edit",
                "--no-commit",
                "--no-ff",
                "--ff-only",
                "--abort",
                "--continue",
                "--squash",
                "--no-gpg-sign",
                "--quiet",
                "-q",
            ],
            values: &["--message", "-m"],
            ..NONE
        },
        "rebase" => Options {
            switches: &[
                "--abort",
                "--continue",
                "--skip",
                "--quit",
                "--autostash",
                "--no-autostash",
                "--keep-empty",
                "--no-gpg-sign",
                "--quiet",
                "-q",
            ],
            values: &["--onto"],
            ..NONE
        },
        "cherry-pick" => Options {
            switches: &[
                "--abort",
                "--continue",
                "--skip",
                "--quit",
                "--no-commit",
                "-n",
                "--no-edit",
                "--ff",
                "--allow-empty",
                "--keep-redundant-commits",
                "--no-gpg-sign",
            ],
            values: &["--mainline", "-m"],
            ..NONE
        },
        "stash" => Options {
            switches: &[
                "--include-untracked",
                "-u",
                "--all",
                "-a",
                "--keep-index",
                "-k",
                "--no-keep-index",
                "--index",
                "--quiet",
                "-q",
            ],
            values: &["--message", "-m"],
            ..NONE
        },
        "blame" => Options {
            switches: &[
                "--line-porcelain",
                "--porcelain",
                "-p",
                "--incremental",
                "-w",
                "--root",
                "--show-email",
                "-e",
                "--show-number",
                "-n",
                "--show-name",
                "-f",
            ],
            values: &["--date", "-L"],
            ..NONE
        },
        "rev-list" => Options {
            switches: &[
                "--objects",
                "--count",
                "--parents",
                "--children",
                "--boundary",
                "--left-right",
                "--cherry-pick",
                "--reverse",
                "--topo-order",
                "--all",
            ],
            values: &["--max-count", "-n", "--since", "--until"],
            inline: &["--format"],
            counts: true,
            ..NONE
        },
        "show-ref" => Options {
            switches: &[
                "--head",
                "--heads",
                "--tags",
                "--verify",
                "--quiet",
                "-q",
                "--dereference",
                "-d",
            ],
            optional: &["--hash"],
            ..NONE
        },
        "tag" => Options {
            switches: &[
                "--delete",
                "-d",
                "--list",
                "-l",
                "--annotate",
                "-a",
                "--force",
                "-f",
            ],
            values: &["--message", "-m", "--format", "--sort"],
            ..NONE
        },
        "push" | "send-pack" => Options {
            switches: &[
                "--force",
                "-f",
                "--dry-run",
                "-n",
                "--delete",
                "-d",
                "--tags",
                "--all",
                "--mirror",
                "--atomic",
                "--porcelain",
                "--set-upstream",
                "-u",
                "--follow-tags",
                "--no-verify",
                "--quiet",
                "-q",
                "--verbose",
                "-v",
            ],
            optional: &["--force-with-lease"],
            ..NONE
        },
        "subtree" => Options {
            switches: &["--quiet", "-q"],
            values: &["--prefix", "-P"],
            ..NONE
        },
        _ => return None,
    })
}
pub(crate) fn validate(command: &str, args: &[&str]) -> Result<()> {
    let spec = options(command).ok_or(UNSUPPORTED)?;
    let mut i = 0;
    let mut paths = false;
    if command == "stash"
        && args.first().is_some_and(|a| !a.starts_with('-'))
        && !matches!(
            args[0],
            "push"
                | "pop"
                | "apply"
                | "drop"
                | "list"
                | "show"
                | "clear"
                | "branch"
                | "create"
                | "store"
        )
    {
        return Err(UNSUPPORTED);
    }
    while i < args.len() {
        let arg = args[i];
        i += 1;
        // Unknown remote protocols can invoke arbitrary git-remote-* helpers. Known remote names
        // still require trusted repository configuration under the owner execution contract.
        if arg.contains("::") {
            return Err(UNSUPPORTED);
        }
        if paths || !arg.starts_with('-') || arg == "-" {
            continue;
        }
        if arg == "--" {
            paths = true;
            continue;
        }
        if spec.switches.contains(&arg) {
            continue;
        }
        let (flag, inline) = arg
            .split_once('=')
            .map_or((arg, None), |(a, b)| (a, Some(b)));
        if spec.optional.contains(&flag) {
            continue;
        }
        if spec.inline.contains(&flag) {
            if inline.is_none() {
                return Err(UNSUPPORTED);
            }
            continue;
        }
        if command == "diff"
            && arg.starts_with("-U")
            && arg.len() > 2
            && arg[2..].bytes().all(|b| b.is_ascii_digit())
        {
            continue;
        }
        if spec.values.contains(&flag) {
            if inline.is_none() {
                let value = args.get(i).ok_or(UNSUPPORTED)?;
                // Defense in depth: a future arity-table mistake cannot hide another option.
                // Use inline syntax for a legitimate literal value beginning with a dash.
                if value.starts_with('-') {
                    return Err(UNSUPPORTED);
                }
                i += 1;
            }
            continue;
        }
        if spec.counts && arg.len() > 1 && arg[1..].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        return Err(UNSUPPORTED);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_admitted_option_is_exact_and_has_a_named_subcommand() {
        let mut accepted = std::collections::BTreeSet::new();
        for command in [
            "status",
            "log",
            "show",
            "diff",
            "rev-parse",
            "ls-files",
            "ls-tree",
            "branch",
            "fetch",
            "commit",
            "add",
            "restore",
            "reset",
            "checkout",
            "switch",
            "merge",
            "rebase",
            "cherry-pick",
            "stash",
            "blame",
            "rev-list",
            "show-ref",
            "tag",
            "push",
            "send-pack",
            "subtree",
        ] {
            let spec = options(command).unwrap();
            for (kind, flags) in [
                ("switches", spec.switches),
                ("values", spec.values),
                ("optional", spec.optional),
            ] {
                for flag in flags {
                    accepted.insert((command.to_owned(), (*flag).to_owned(), kind.to_owned()));
                    if kind != "switches" {
                        accepted.insert((
                            command.to_owned(),
                            (*flag).to_owned(),
                            format!("{kind}-inline"),
                        ));
                    }
                }
            }
            for flag in spec.inline {
                accepted.insert((
                    command.to_owned(),
                    (*flag).to_owned(),
                    "inline-only".to_owned(),
                ));
                assert!(validate(command, &[flag]).is_err());
                assert!(validate(command, &[flag, "--zz-probe-flag"]).is_err());
                assert!(validate(command, &[&format!("{flag}=value")]).is_ok());
            }
            if command == "diff" {
                accepted.insert((
                    command.to_owned(),
                    "-U3".to_owned(),
                    "attached-count".to_owned(),
                ));
            }
            if spec.counts {
                accepted.insert((command.to_owned(), "-3".to_owned(), "count".to_owned()));
            }
            for flag in spec.switches {
                assert!(validate(command, &[flag]).is_ok(), "{command} {flag}");
                assert!(validate(command, &[&format!("{flag}=unknown")]).is_err());
            }
            for flag in spec.values {
                assert!(validate(command, &[flag, "value"]).is_ok());
                assert!(validate(command, &[&format!("{flag}=value")]).is_ok());
                assert!(validate(command, &[flag]).is_err());
                assert!(validate(command, &[flag, "--zz-probe-flag"]).is_err());
            }
            for flag in spec.optional {
                assert!(validate(command, &[flag]).is_ok());
                assert!(validate(command, &[&format!("{flag}=value")]).is_ok());
            }
            for flag in spec
                .switches
                .iter()
                .chain(spec.values)
                .chain(spec.optional)
                .chain(spec.inline)
            {
                if flag.starts_with("--") {
                    for end in 3..flag.len() {
                        let prefix = &flag[..end];
                        if !spec.switches.contains(&prefix)
                            && !spec.values.contains(&prefix)
                            && !spec.optional.contains(&prefix)
                            && !spec.inline.contains(&prefix)
                        {
                            assert!(
                                validate(command, &[prefix, "value"]).is_err(),
                                "abbreviation {command} {prefix}"
                            );
                        }
                    }
                }
            }
            assert!(validate(command, &["--future-flag"]).is_err());
        }
        let snapshot: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/accepted-git-options.json")).unwrap();
        let recorded: std::collections::BTreeSet<_> = snapshot
            .iter()
            .map(|row| {
                (
                    row["subcommand"].as_str().unwrap().to_owned(),
                    row["flag"].as_str().unwrap().to_owned(),
                    row["kind"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            accepted, recorded,
            "review the accepted flag corpus when changing its surface"
        );
    }
}
