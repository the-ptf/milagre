//! Bounded, fail-closed static Bash classification. This is policy analysis, not a sandbox.
mod git_options;
mod remote;
use milagre_providers::codex::guard::{CommandClassifier, RemoteAction};
use std::time::{Duration, Instant};
use tree_sitter::{Node, ParseOptions, Parser};

const UNSUPPORTED: &str = "Command policy cannot classify this shell syntax or executable.";
const LIMIT: &str = "Command policy input exceeds its analysis limit.";
type Result<T> = std::result::Result<T, &'static str>;

/// Stateless parser. Debug and errors never include command text.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShellClassifier;
impl CommandClassifier for ShellClassifier {
    fn actions(&self, command: &str) -> std::result::Result<Vec<RemoteAction>, String> {
        let mut context = Context {
            actions: Vec::new(),
            nodes: 0,
            bytes: 0,
            started: Instant::now(),
        };
        context
            .script(command, 0)
            .map(|()| context.actions)
            .map_err(str::to_owned)
    }
}
struct Context {
    actions: Vec<RemoteAction>,
    nodes: usize,
    bytes: usize,
    started: Instant,
}
#[derive(Default)]
struct Word {
    text: String,
    dynamic: bool,
}
impl Context {
    fn script(&mut self, source: &str, depth: usize) -> Result<()> {
        self.bytes += source.len();
        if depth > 16 || self.bytes > 128 * 1024 {
            return Err(LIMIT);
        }
        if source.contains('\0') {
            return Err(UNSUPPORTED);
        }
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .map_err(|_| UNSUPPORTED)?;
        // A bounded input plus bounded node/depth visits prevents unbounded recursive analysis.
        let mut cancelled = false;
        let mut progress = |_: &tree_sitter::ParseState| {
            cancelled = self.started.elapsed() > Duration::from_millis(250);
            cancelled
        };
        let tree = parser
            .parse_with_options(
                &mut |offset, _| &source.as_bytes()[offset..],
                None,
                Some(ParseOptions::new().progress_callback(&mut progress)),
            )
            .ok_or(if cancelled { LIMIT } else { UNSUPPORTED })?;
        if tree.root_node().has_error() {
            return Err(UNSUPPORTED);
        }
        self.visit(tree.root_node(), source, depth)
    }
    fn count(&mut self, depth: usize) -> Result<()> {
        self.nodes += 1;
        if depth > 64 || self.nodes > 8192 || self.started.elapsed() > Duration::from_millis(250) {
            Err(LIMIT)
        } else {
            Ok(())
        }
    }
    fn visit(&mut self, node: Node<'_>, source: &str, depth: usize) -> Result<()> {
        self.count(depth)?;
        match node.kind() {
            "program" | "list" | "pipeline" | "subshell" | "compound_statement"
            | "if_statement" | "elif_clause" | "else_clause" | "negated_command" => {
                for child in node.named_children(&mut node.walk()) {
                    self.visit(child, source, depth + 1)?;
                }
                Ok(())
            }
            "comment" => Ok(()),
            "command" => {
                let mut words = Vec::new();
                for child in node.named_children(&mut node.walk()) {
                    if child.kind() == "variable_assignment" {
                        return Err(UNSUPPORTED);
                    }
                    words.push(self.word(child, source, depth + 1)?);
                }
                self.command(&words, depth + 1)
            }
            // Redirections, heredocs, loops, functions, arithmetic, assignments, aliases and
            // unsupported grammar nodes are deliberately not traversed as if they were safe.
            _ => Err(UNSUPPORTED),
        }
    }
    fn word(&mut self, node: Node<'_>, source: &str, depth: usize) -> Result<Word> {
        self.count(depth)?;
        let raw = node.utf8_text(source.as_bytes()).map_err(|_| UNSUPPORTED)?;
        match node.kind() {
            "command_name" | "concatenation" | "string" => {
                let mut result = Word::default();
                for child in node.named_children(&mut node.walk()) {
                    let word = self.word(child, source, depth + 1)?;
                    result.text.push_str(&word.text);
                    result.dynamic |= word.dynamic;
                }
                Ok(result)
            }
            "raw_string" => Ok(Word {
                text: raw[1..raw.len() - 1].into(),
                dynamic: false,
            }),
            "ansi_c_string" => Ok(Word {
                text: ansi(&raw[2..raw.len() - 1])?,
                dynamic: false,
            }),
            "word" | "number" => Ok(Word {
                text: unescape(raw, false)?,
                dynamic: false,
            }),
            "string_content" => Ok(Word {
                text: unescape(raw, true)?,
                dynamic: false,
            }),
            "command_substitution" => {
                for child in node.named_children(&mut node.walk()) {
                    self.visit(child, source, depth + 1)?;
                }
                Ok(Word {
                    text: String::new(),
                    dynamic: true,
                })
            }
            _ => Err(UNSUPPORTED),
        }
    }
    fn command(&mut self, words: &[Word], depth: usize) -> Result<()> {
        self.count(depth)?;
        let first = words.first().ok_or(UNSUPPORTED)?;
        if first.dynamic {
            return Err(UNSUPPORTED);
        }
        let executable = first.text.as_str();
        // Arbitrary paths may point to unrelated executable code with a trusted basename.
        let name = if let Some(n) = executable
            .strip_prefix("/usr/bin/")
            .or_else(|| executable.strip_prefix("/bin/"))
        {
            n
        } else {
            executable
        };
        if name.contains('/') {
            return Err(UNSUPPORTED);
        }
        let rest = &words[1..];
        if matches!(name, "echo" | "printf") {
            // Substitutions were visited above. Their output remains data to these builtins.
            // printf can assign shell variables through -v or %n, so only literal %s
            // formatting is supported. Its remaining arguments are data.
            if name == "printf"
                && rest.first().is_some_and(|w| {
                    w.dynamic
                        || w.text.starts_with('-')
                        || (w.text.contains('%')
                            && !matches!(w.text.as_str(), "%s" | "%s\n" | "%s\\n" | "%s "))
                })
            {
                return Err(UNSUPPORTED);
            }
            return Ok(());
        }
        if rest.iter().any(|w| w.dynamic) {
            return Err(UNSUPPORTED);
        }
        let args: Vec<&str> = rest.iter().map(|w| w.text.as_str()).collect();
        match name {
            "command" => {
                let skip = usize::from(args.first() == Some(&"--"));
                if args
                    .first()
                    .is_some_and(|x| x.starts_with('-') && *x != "--")
                {
                    return Err(UNSUPPORTED);
                }
                self.command(&rest[skip..], depth + 1)
            }
            "nohup" | "time" => self.command(rest, depth + 1),
            "env" => {
                let skip = usize::from(
                    args.first()
                        .is_some_and(|a| matches!(*a, "-i" | "--ignore-environment")),
                );
                self.command(&rest[skip..], depth + 1)
            }
            "bash" | "sh" | "dash" => {
                // Login shells, startup-file options, stdin, script files and positional
                // parameters require environment/file interpretation unavailable here.
                if args.len() != 2 || args[0] != "-c" {
                    return Err(UNSUPPORTED);
                }
                self.script(args[1], depth + 1)
            }
            "eval" => self.script(&args.join(" "), depth + 1),
            "git" => self.add(remote::git(&args)?),
            "gh" => self.add(remote::gh(&args)?),
            // This deliberately excludes interpreters, package scripts, find/awk/sed execution
            // forms, xargs (stdin changes argv), network clients and arbitrary executables.
            "true" | "false" | ":" | "pwd" | "ls" | "cat" | "head" | "tail" | "wc" | "grep"
            | "sleep" => Ok(()),
            _ => Err(UNSUPPORTED),
        }
    }
    fn add(&mut self, actions: Vec<RemoteAction>) -> Result<()> {
        for action in actions {
            if !self.actions.contains(&action) {
                self.actions.push(action);
            }
        }
        Ok(())
    }
}
fn unescape(raw: &str, double: bool) -> Result<String> {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let n = chars.next().ok_or(UNSUPPORTED)?;
            if n == '\n' {
                continue;
            }
            if double && !matches!(n, '$' | '`' | '"' | '\\') {
                out.push('\\');
            }
            out.push(n);
        } else {
            if (!double && matches!(c, '$' | '`' | '*' | '?' | '[' | ']' | '{' | '}' | '~'))
                || matches!(c, '$' | '`')
            {
                return Err(UNSUPPORTED);
            }
            out.push(c);
        }
    }
    Ok(out)
}
fn ansi(raw: &str) -> Result<String> {
    let mut chars = raw.chars().peekable();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let n = chars.next().ok_or(UNSUPPORTED)?;
        let decoded = match n {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'a' => '\x07',
            'b' => '\x08',
            'e' | 'E' => '\x1b',
            'f' => '\x0c',
            'v' => '\x0b',
            '\\' => '\\',
            '\'' => '\'',
            '"' => '"',
            '?' => '?',
            'x' | 'u' | 'U' | '0'..='7' => {
                let (radix, max) = match n {
                    'x' => (16, 2),
                    'u' => (16, 4),
                    'U' => (16, 8),
                    _ => (8, 3),
                };
                let mut digits = String::new();
                if n.is_digit(8) {
                    digits.push(n);
                }
                while digits.len() < max && chars.peek().is_some_and(|c| c.is_digit(radix)) {
                    digits.push(chars.next().ok_or(UNSUPPORTED)?);
                }
                let value = u32::from_str_radix(&digits, radix).map_err(|_| UNSUPPORTED)?;
                if value == 0 {
                    return Err(UNSUPPORTED);
                }
                char::from_u32(value).ok_or(UNSUPPORTED)?
            }
            _ => return Err(UNSUPPORTED),
        };
        out.push(decoded);
    }
    Ok(out)
}
