//! `when` expressions: names, `!`, `&&`, `||` and parentheses.

use super::{is_js_space, utf16_len};
use std::collections::HashSet;

const MAX_WHEN_LENGTH: usize = 256;

/// The context keys a `when` can name, with what each means. Any other name is false.
pub const WHEN_KEYS: &[(&str, &str)] = &[
    ("terminalFocus", "A Terminal has the keyboard."),
    ("editableFocus", "A text field, the composer or another editor has the keyboard."),
    ("composerFocus", "The composer has the keyboard."),
    ("chatView", "A Chat is on screen (not Settings, the canvas, Routines or Usage)."),
    ("linkOpen", "A Link's workspace is on screen."),
    ("gridShown", "Active Chats show as a grid."),
    ("isMac", "Milagre runs on a Mac."),
    ("isIpad", "Milagre runs on an iPad."),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhenNode {
    Identifier(String),
    Not(Box<WhenNode>),
    And(Box<WhenNode>, Box<WhenNode>),
    Or(Box<WhenNode>, Box<WhenNode>),
}

/// The names that are true now; a name the context doesn't hold is false.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WhenContext(HashSet<String>);

impl WhenContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a name true (`true`) or false (`false`, same as absent).
    pub fn set(&mut self, name: &str, value: bool) {
        if value {
            self.0.insert(name.to_string());
        } else {
            self.0.remove(name);
        }
    }

    pub fn with(mut self, name: &str) -> Self {
        self.set(name, true);
        self
    }

    pub fn is_true(&self, name: &str) -> bool {
        self.0.contains(name)
    }
}

/// `/[A-Za-z_][A-Za-z0-9_.]*|&&|\|\||!|\(|\)|\S/g`
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if is_js_space(c) {
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let len = if c.is_ascii_alphabetic() || c == '_' {
            rest.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')).unwrap_or(rest.len())
        } else if rest.starts_with("&&") || rest.starts_with("||") {
            2
        } else {
            c.len_utf8()
        };
        tokens.push(rest[..len].to_string());
        rest = &rest[len..];
    }
    tokens
}

struct Parser {
    tokens: Vec<String>,
    at: usize,
    depth: u32,
}

impl Parser {
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.at).map(String::as_str)
    }

    fn or(&mut self) -> Option<WhenNode> {
        let mut left = self.and()?;
        while self.peek() == Some("||") {
            self.at += 1;
            let right = self.and()?;
            left = WhenNode::Or(Box::new(left), Box::new(right));
        }
        Some(left)
    }

    fn and(&mut self) -> Option<WhenNode> {
        let mut left = self.unary()?;
        while self.peek() == Some("&&") {
            self.at += 1;
            let right = self.unary()?;
            left = WhenNode::And(Box::new(left), Box::new(right));
        }
        Some(left)
    }

    fn unary(&mut self) -> Option<WhenNode> {
        let token = self.peek()?.to_string();
        if token == "!" {
            self.at += 1;
            return self.unary().map(|node| WhenNode::Not(Box::new(node)));
        }
        if token == "(" {
            self.depth += 1;
            if self.depth > 32 {
                return None;
            }
            self.at += 1;
            let node = self.or()?;
            if self.peek() != Some(")") {
                return None;
            }
            self.at += 1;
            self.depth -= 1;
            return Some(node);
        }
        if token.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
            self.at += 1;
            return Some(WhenNode::Identifier(token));
        }
        None
    }
}

/// A `when` expression read into a tree, or `None` when it doesn't parse.
pub fn parse_when(value: &str) -> Option<WhenNode> {
    let text = value.trim_matches(is_js_space);
    if text.is_empty() || utf16_len(text) > MAX_WHEN_LENGTH {
        return None;
    }
    let tokens = tokenize(text);
    let count = tokens.len();
    let mut parser = Parser { tokens, at: 0, depth: 0 };
    let tree = parser.or()?;
    (parser.at == count).then_some(tree)
}

/// Whether a `when` tree holds in `context`; a name the context doesn't set is false.
pub fn evaluate_when(node: &WhenNode, context: &WhenContext) -> bool {
    match node {
        WhenNode::Identifier(name) => context.is_true(name),
        WhenNode::Not(inner) => !evaluate_when(inner, context),
        WhenNode::And(left, right) => evaluate_when(left, context) && evaluate_when(right, context),
        WhenNode::Or(left, right) => evaluate_when(left, context) || evaluate_when(right, context),
    }
}

/// The names a `when` tree uses, in reading order (repeats kept).
pub fn when_names(node: &WhenNode) -> Vec<&str> {
    match node {
        WhenNode::Identifier(name) => vec![name.as_str()],
        WhenNode::Not(inner) => when_names(inner),
        WhenNode::And(left, right) | WhenNode::Or(left, right) => {
            let mut names = when_names(left);
            names.extend(when_names(right));
            names
        }
    }
}
