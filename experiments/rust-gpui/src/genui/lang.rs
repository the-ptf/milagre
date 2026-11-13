//! OpenUI Lang, the part of `@openuidev/lang-core` 0.3.2 `createParser(..).parse` that the contract in
//! `packages/shared/src/genui.ts` can reach, ported function for function: `preprocess` (`stripFences`,
//! `stripComments`), `autoClose`, `tokenize`, `split`, the Pratt `parseExpression`, and the materialising of
//! `root` through its references (`resolveRef`: a cycle or an unknown name is unresolved, a statement nothing
//! reaches is orphaned). Positional arguments become named props through the component table in `contract.rs`.
//!
//! What lang-core does at render time (`evaluateElementProps`, with `store: null` and no state) happens here while
//! materialising, since there is no state to wait for: operators, ternaries, member and index access over
//! literals, `Action([...])` plans, and the pure builtins (`Count`, `First`, `Last`, `Sum`, `Avg`, `Min`, `Max`,
//! `Round`, `Abs`, `Floor`, `Ceil`). Not ported, because nothing here can use them: `Query`, `Mutation`, `$state`
//! (reads as null), `Each`, `Sort`, `Filter`. `@OpenUrl`, `@Set`, `@Reset` and `@Run` parse and then do nothing,
//! like the desktop (`genuiActionEvents`).

use std::collections::{HashMap, HashSet};

/// A token of the language (`tokenize`'s numbered kinds).
#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    Newline,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Comma,
    Colon,
    Assign,
    Str(String),
    Num(f64),
    True,
    False,
    Null,
    /// A lower-case name: a reference or a field.
    Ident(String),
    /// A capitalised name: a component, a builtin or a reference.
    Type(String),
    /// `$name`, with the `$`.
    StateVar(String),
    /// `@Name`, without the `@`.
    At(String),
    Dot,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    EqEq,
    NotEq,
    Gt,
    Lt,
    Ge,
    Le,
    And,
    Or,
    Not,
    Question,
    Eof,
}

/// `tokenize`: a source string to tokens. Strings may be unterminated (the rest of the text is the string).
pub fn tokenize(src: &str) -> Vec<Tok> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut tokens: Vec<Tok> = Vec::new();
    let mut i = 0;
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    while i < n {
        while i < n && matches!(chars[i], ' ' | '\t' | '\r') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let simple = match c {
            '\n' => Some(Tok::Newline),
            '(' => Some(Tok::LParen),
            ')' => Some(Tok::RParen),
            '[' => Some(Tok::LBracket),
            ']' => Some(Tok::RBracket),
            '{' => Some(Tok::LBrace),
            '}' => Some(Tok::RBrace),
            ',' => Some(Tok::Comma),
            ':' => Some(Tok::Colon),
            '.' => Some(Tok::Dot),
            '?' => Some(Tok::Question),
            '+' => Some(Tok::Plus),
            '*' => Some(Tok::Star),
            '/' => Some(Tok::Slash),
            '%' => Some(Tok::Percent),
            _ => None,
        };
        if let Some(token) = simple {
            tokens.push(token);
            i += 1;
            continue;
        }
        let two = |double: char, one: Tok, both: Tok, i: &mut usize, tokens: &mut Vec<Tok>| {
            if next == Some(double) {
                tokens.push(both);
                *i += 2;
            } else {
                tokens.push(one);
                *i += 1;
            }
        };
        match c {
            '=' => {
                two('=', Tok::Assign, Tok::EqEq, &mut i, &mut tokens);
                continue;
            }
            '!' => {
                two('=', Tok::Not, Tok::NotEq, &mut i, &mut tokens);
                continue;
            }
            '>' => {
                two('=', Tok::Gt, Tok::Ge, &mut i, &mut tokens);
                continue;
            }
            '<' => {
                two('=', Tok::Lt, Tok::Le, &mut i, &mut tokens);
                continue;
            }
            '&' => {
                two('&', Tok::And, Tok::And, &mut i, &mut tokens);
                continue;
            }
            '|' => {
                two('|', Tok::Or, Tok::Or, &mut i, &mut tokens);
                continue;
            }
            _ => {}
        }
        if c == '"' {
            let start = i;
            i += 1;
            let mut closed = false;
            while i < n {
                if chars[i] == '\\' {
                    i += 2;
                } else if chars[i] == '"' {
                    i += 1;
                    closed = true;
                    break;
                } else {
                    i += 1;
                }
            }
            let raw: String = chars[start..i.min(n)].iter().collect();
            let json = if closed { raw.clone() } else { format!("{raw}\"") };
            // `JSON.parse`, else the text between the quotes.
            let value = match serde_json::from_str::<String>(&json) {
                Ok(value) => value,
                Err(_) => {
                    let stripped = raw.strip_prefix('"').unwrap_or(&raw);
                    stripped.strip_suffix('"').unwrap_or(stripped).to_string()
                }
            };
            tokens.push(Tok::Str(value));
            continue;
        }
        if c == '\'' {
            i += 1;
            let mut out = String::new();
            while i < n {
                if chars[i] == '\\' {
                    i += 1;
                    if i < n {
                        out.push(match chars[i] {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                        i += 1;
                    }
                } else if chars[i] == '\'' {
                    i += 1;
                    break;
                } else {
                    out.push(chars[i]);
                    i += 1;
                }
            }
            tokens.push(Tok::Str(out));
            continue;
        }
        if c == '-' {
            let after_value = matches!(
                tokens.last(),
                Some(
                    Tok::Num(_)
                        | Tok::Str(_)
                        | Tok::Ident(_)
                        | Tok::Type(_)
                        | Tok::RParen
                        | Tok::RBracket
                        | Tok::True
                        | Tok::False
                        | Tok::Null
                        | Tok::StateVar(_)
                        | Tok::At(_)
                )
            );
            let digit_next = next.is_some_and(|d| d.is_ascii_digit());
            if after_value || !digit_next {
                tokens.push(Tok::Minus);
                i += 1;
                continue;
            }
        }
        if c.is_ascii_digit() || (c == '-' && next.is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            if chars[i] == '-' {
                i += 1;
            }
            while i < n && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < n && chars[i] == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < n && (chars[i] == 'e' || chars[i] == 'E') {
                i += 1;
                if i < n && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let text: String = chars[start..i].iter().collect();
            // JavaScript's `+"1e"` is NaN; a lone exponent mark is read as that.
            tokens.push(Tok::Num(text.parse::<f64>().unwrap_or(f64::NAN)));
            continue;
        }
        if c == '$' && next.is_some_and(|d| d.is_ascii_alphabetic() || d == '_') {
            let start = i;
            i += 1;
            while i < n && is_word(chars[i]) {
                i += 1;
            }
            tokens.push(Tok::StateVar(chars[start..i].iter().collect()));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < n && is_word(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            tokens.push(match word.as_str() {
                "true" => Tok::True,
                "false" => Tok::False,
                "null" => Tok::Null,
                _ if c.is_ascii_uppercase() => Tok::Type(word),
                _ => Tok::Ident(word),
            });
            continue;
        }
        if c == '@' && next.is_some_and(|d| d.is_ascii_alphabetic() || d == '_') {
            i += 1;
            let start = i;
            while i < n && is_word(chars[i]) {
                i += 1;
            }
            tokens.push(Tok::At(chars[start..i].iter().collect()));
            continue;
        }
        i += 1;
    }
    tokens.push(Tok::Eof);
    tokens
}

/// One statement: `id = expression`, its expression as tokens.
#[derive(Clone, Debug)]
pub struct RawStatement {
    pub id: String,
    pub is_state: bool,
    pub tokens: Vec<Tok>,
}

/// `split`: tokens to statements, separated by newlines outside brackets. A line without `identifier =` is skipped.
pub fn split(tokens: &[Tok]) -> Vec<RawStatement> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < tokens.len() {
        while pos < tokens.len() && tokens[pos] == Tok::Newline {
            pos += 1;
        }
        if pos >= tokens.len() || tokens[pos] == Tok::Eof {
            break;
        }
        let (id, is_state) = match &tokens[pos] {
            Tok::Ident(name) | Tok::Type(name) => (name.clone(), false),
            Tok::StateVar(name) => (name.clone(), true),
            _ => {
                while pos < tokens.len() && !matches!(tokens[pos], Tok::Newline | Tok::Eof) {
                    pos += 1;
                }
                continue;
            }
        };
        pos += 1;
        if pos >= tokens.len() || tokens[pos] != Tok::Assign {
            while pos < tokens.len() && !matches!(tokens[pos], Tok::Newline | Tok::Eof) {
                pos += 1;
            }
            continue;
        }
        pos += 1;
        let mut expr = Vec::new();
        let mut depth = 0i32;
        let mut ternary = 0i32;
        while pos < tokens.len() && tokens[pos] != Tok::Eof {
            let token = &tokens[pos];
            if *token == Tok::Newline && depth <= 0 && ternary <= 0 {
                let mut peek = pos + 1;
                while peek < tokens.len() && tokens[peek] == Tok::Newline {
                    peek += 1;
                }
                let next = tokens.get(peek).unwrap_or(&Tok::Eof);
                if *next == Tok::Question || (*next == Tok::Colon && ternary > 0) {
                    pos += 1;
                    continue;
                }
                break;
            }
            if *token == Tok::Newline {
                pos += 1;
                continue;
            }
            match token {
                Tok::LParen | Tok::LBracket | Tok::LBrace => depth += 1,
                Tok::RParen | Tok::RBracket | Tok::RBrace if depth > 0 => depth -= 1,
                Tok::Question if depth == 0 => ternary += 1,
                Tok::Colon if depth == 0 && ternary > 0 => ternary -= 1,
                _ => {}
            }
            expr.push(token.clone());
            pos += 1;
        }
        if !expr.is_empty() {
            out.push(RawStatement { id, is_state, tokens: expr });
        }
    }
    out
}

/// An expression tree (`parseExpression`).
#[derive(Clone, Debug, PartialEq)]
pub enum Ast {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Arr(Vec<Ast>),
    Obj(Vec<(String, Ast)>),
    Ref(String),
    StateRef(String),
    Assign(String, Box<Ast>),
    Comp(String, Vec<Ast>),
    Bin(Op, Box<Ast>, Box<Ast>),
    Not(Box<Ast>),
    Neg(Box<Ast>),
    Ternary(Box<Ast>, Box<Ast>, Box<Ast>),
    Member(Box<Ast>, String),
    Index(Box<Ast>, Box<Ast>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    Gt,
    Lt,
    Ge,
    Le,
    And,
    Or,
}

const PREC_TERNARY: u8 = 1;
const PREC_OR: u8 = 2;
const PREC_AND: u8 = 3;
const PREC_EQ: u8 = 4;
const PREC_CMP: u8 = 5;
const PREC_ADD: u8 = 6;
const PREC_MUL: u8 = 7;
const PREC_UNARY: u8 = 8;
const PREC_MEMBER: u8 = 9;

/// Builtins that are functions, not components (`BUILTIN_NAMES`: the action names, `Each` and these).
const BUILTINS: &[&str] = &[
    "Count",
    "First",
    "Last",
    "Sum",
    "Avg",
    "Min",
    "Max",
    "Sort",
    "Filter",
    "Round",
    "Abs",
    "Floor",
    "Ceil",
    "Each",
    "Action",
    "Run",
    "ToAssistant",
    "OpenUrl",
    "Set",
    "Reset",
];

fn is_builtin(name: &str) -> bool {
    BUILTINS.contains(&name)
}

/// Nesting beyond this reads as null: a model-written block is shallow, and recursion needs a bound.
const MAX_DEPTH: usize = 64;

struct ExprParser<'a> {
    tokens: &'a [Tok],
    pos: usize,
    depth: usize,
}

impl ExprParser<'_> {
    fn cur(&self) -> &Tok {
        self.tokens.get(self.pos).unwrap_or(&Tok::Eof)
    }

    fn eat(&mut self, token: &Tok) {
        if self.cur() == token {
            self.pos += 1;
        }
    }

    fn infix_prec(&self) -> u8 {
        match self.cur() {
            Tok::Question => PREC_TERNARY,
            Tok::Or => PREC_OR,
            Tok::And => PREC_AND,
            Tok::EqEq | Tok::NotEq => PREC_EQ,
            Tok::Gt | Tok::Lt | Tok::Ge | Tok::Le => PREC_CMP,
            Tok::Plus | Tok::Minus => PREC_ADD,
            Tok::Star | Tok::Slash | Tok::Percent => PREC_MUL,
            Tok::Dot | Tok::LBracket => PREC_MEMBER,
            _ => 0,
        }
    }

    fn expr(&mut self, min_prec: u8) -> Ast {
        if self.depth >= MAX_DEPTH {
            // Skip the token so a pathological input still ends.
            self.pos += 1;
            return Ast::Null;
        }
        self.depth += 1;
        let mut left = self.prefix();
        while self.infix_prec() > min_prec {
            left = self.infix(left);
        }
        self.depth -= 1;
        left
    }

    fn prefix(&mut self) -> Ast {
        let token = self.cur().clone();
        match token {
            Tok::Str(value) => {
                self.pos += 1;
                Ast::Str(value)
            }
            Tok::Num(value) => {
                self.pos += 1;
                Ast::Num(value)
            }
            Tok::True => {
                self.pos += 1;
                Ast::Bool(true)
            }
            Tok::False => {
                self.pos += 1;
                Ast::Bool(false)
            }
            Tok::Null => {
                self.pos += 1;
                Ast::Null
            }
            Tok::LBracket => self.array(),
            Tok::LBrace => self.object(),
            Tok::StateVar(name) => {
                self.pos += 1;
                if *self.cur() == Tok::Assign {
                    self.pos += 1;
                    let value = self.expr(0);
                    return Ast::Assign(name, Box::new(value));
                }
                Ast::StateRef(name)
            }
            Tok::Type(name) => {
                if self.tokens.get(self.pos + 1) == Some(&Tok::LParen) && (!is_builtin(&name) || name == "Action") {
                    return self.component();
                }
                self.pos += 1;
                Ast::Ref(name)
            }
            Tok::At(name) => {
                if self.tokens.get(self.pos + 1) == Some(&Tok::LParen) {
                    return self.component();
                }
                self.pos += 1;
                Ast::Ref(name)
            }
            Tok::Ident(name) => {
                self.pos += 1;
                Ast::Ref(name)
            }
            Tok::Not => {
                self.pos += 1;
                Ast::Not(Box::new(self.expr(PREC_UNARY)))
            }
            Tok::Minus => {
                self.pos += 1;
                Ast::Neg(Box::new(self.expr(PREC_UNARY)))
            }
            Tok::LParen => {
                self.pos += 1;
                let inner = self.expr(0);
                self.eat(&Tok::RParen);
                inner
            }
            _ => {
                self.pos += 1;
                Ast::Null
            }
        }
    }

    fn infix(&mut self, left: Ast) -> Ast {
        let token = self.cur().clone();
        let binary = |op: Op, prec: u8, this: &mut Self, left: Ast| {
            this.pos += 1;
            Ast::Bin(op, Box::new(left), Box::new(this.expr(prec)))
        };
        match token {
            Tok::Plus => binary(Op::Add, PREC_ADD, self, left),
            Tok::Minus => binary(Op::Sub, PREC_ADD, self, left),
            Tok::Star => binary(Op::Mul, PREC_MUL, self, left),
            Tok::Slash => binary(Op::Div, PREC_MUL, self, left),
            Tok::Percent => binary(Op::Rem, PREC_MUL, self, left),
            Tok::EqEq => binary(Op::Eq, PREC_EQ, self, left),
            Tok::NotEq => binary(Op::Ne, PREC_EQ, self, left),
            Tok::Gt => binary(Op::Gt, PREC_CMP, self, left),
            Tok::Lt => binary(Op::Lt, PREC_CMP, self, left),
            Tok::Ge => binary(Op::Ge, PREC_CMP, self, left),
            Tok::Le => binary(Op::Le, PREC_CMP, self, left),
            Tok::And => binary(Op::And, PREC_AND, self, left),
            Tok::Or => binary(Op::Or, PREC_OR, self, left),
            Tok::Question => {
                self.pos += 1;
                let then = self.expr(0);
                self.eat(&Tok::Colon);
                let otherwise = self.expr(0);
                Ast::Ternary(Box::new(left), Box::new(then), Box::new(otherwise))
            }
            Tok::Dot => {
                self.pos += 1;
                let field = match self.cur().clone() {
                    Tok::Ident(name) | Tok::Type(name) | Tok::Str(name) => name,
                    Tok::Num(value) => js_number(value),
                    Tok::StateVar(name) => name.trim_start_matches('$').to_string(),
                    _ => "?".to_string(),
                };
                self.pos += 1;
                Ast::Member(Box::new(left), field)
            }
            Tok::LBracket => {
                self.pos += 1;
                let index = self.expr(0);
                self.eat(&Tok::RBracket);
                Ast::Index(Box::new(left), Box::new(index))
            }
            _ => left,
        }
    }

    fn component(&mut self) -> Ast {
        let name = match self.cur().clone() {
            Tok::Type(name) | Tok::At(name) => name,
            _ => String::new(),
        };
        self.pos += 1;
        self.eat(&Tok::LParen);
        let mut args = Vec::new();
        while !matches!(self.cur(), Tok::RParen | Tok::Eof) {
            args.push(self.expr(0));
            if *self.cur() == Tok::Comma {
                self.pos += 1;
            }
        }
        self.eat(&Tok::RParen);
        Ast::Comp(name, args)
    }

    fn array(&mut self) -> Ast {
        self.pos += 1;
        let mut els = Vec::new();
        while !matches!(self.cur(), Tok::RBracket | Tok::Eof) {
            els.push(self.expr(0));
            if *self.cur() == Tok::Comma {
                self.pos += 1;
            }
        }
        self.eat(&Tok::RBracket);
        Ast::Arr(els)
    }

    fn object(&mut self) -> Ast {
        self.pos += 1;
        let mut entries = Vec::new();
        while !matches!(self.cur(), Tok::RBrace | Tok::Eof) {
            let key = match self.cur().clone() {
                Tok::Ident(name) | Tok::Type(name) | Tok::Str(name) => name,
                Tok::Num(value) => js_number(value),
                Tok::StateVar(name) => name.trim_start_matches('$').to_string(),
                _ => "?".to_string(),
            };
            self.pos += 1;
            self.eat(&Tok::Colon);
            entries.push((key, self.expr(0)));
            if *self.cur() == Tok::Comma {
                self.pos += 1;
            }
        }
        self.eat(&Tok::RBrace);
        Ast::Obj(entries)
    }
}

/// `parseExpression`: a statement's tokens to a tree.
pub fn parse_expression(tokens: &[Tok]) -> Ast {
    ExprParser { tokens, pos: 0, depth: 0 }.expr(0)
}

/// JavaScript's `String(number)` for the values a block holds: integers without a point, else the shortest form.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if value == 0.0 {
        "0".into()
    } else if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// `autoClose`: an unterminated string and unclosed brackets are closed so a half-written block parses.
pub fn auto_close(input: &str) -> (String, bool) {
    let mut stack: Vec<char> = Vec::new();
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    for c in input.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' && in_str.is_some() {
            escaped = true;
            continue;
        }
        if let Some(quote) = in_str {
            if c == quote {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '(' | '[' | '{' => stack.push(c),
            ')' if stack.last() == Some(&'(') => {
                stack.pop();
            }
            ']' if stack.last() == Some(&'[') => {
                stack.pop();
            }
            '}' if stack.last() == Some(&'{') => {
                stack.pop();
            }
            _ => {}
        }
    }
    if in_str.is_none() && stack.is_empty() {
        return (input.to_string(), false);
    }
    let mut out = input.to_string();
    if let Some(quote) = in_str {
        if escaped {
            out.push('\\');
        }
        out.push(quote);
    }
    for open in stack.iter().rev() {
        out.push(match open {
            '(' => ')',
            '[' => ']',
            _ => '}',
        });
    }
    (out, true)
}

/// `skipString`: past a double-quoted string starting at `start`, or `start` when none starts there.
fn skip_string(chars: &[char], start: usize) -> usize {
    if chars.get(start) != Some(&'"') {
        return start;
    }
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '"' => return i + 1,
            _ => i += 1,
        }
    }
    i
}

fn is_fence_at(chars: &[char], i: usize) -> bool {
    chars.get(i) == Some(&'`') && chars.get(i + 1) == Some(&'`') && chars.get(i + 2) == Some(&'`')
}

/// `stripFences`: the code inside Markdown fences, or the input when it has none. String-aware.
pub fn strip_fences(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        let mut fence_start = None;
        while i < n {
            let next = skip_string(&chars, i);
            if next > i {
                i = next;
                continue;
            }
            if is_fence_at(&chars, i) {
                fence_start = Some(i);
                break;
            }
            i += 1;
        }
        let Some(fence_start) = fence_start else { break };
        let mut j = fence_start + 3;
        while j < n && chars[j] != '\n' {
            j += 1;
        }
        if j >= n {
            // The opening line only: whatever follows the fence's info line is nothing.
            blocks.push(String::new());
            break;
        }
        j += 1;
        let mut close = None;
        let mut k = j;
        while k < n {
            let next = skip_string(&chars, k);
            if next > k {
                k = next;
                continue;
            }
            if is_fence_at(&chars, k) {
                close = Some(k);
                break;
            }
            k += 1;
        }
        match close {
            Some(close) => {
                blocks.push(chars[j..close].iter().collect());
                i = close + 3;
            }
            None => {
                blocks.push(chars[j..].iter().collect());
                i = n;
            }
        }
    }
    if !blocks.is_empty() {
        return blocks.join("\n");
    }
    input.to_string()
}

/// `stripComments`: `//` and `#` to the end of a line, outside strings. As in lang-core, an unterminated string
/// carries into the next line.
pub fn strip_comments(input: &str) -> String {
    let mut in_str: Option<char> = None;
    input
        .split('\n')
        .map(|line| {
            let chars: Vec<char> = line.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                let c = chars[i];
                if let Some(quote) = in_str {
                    if c == '\\' && i + 1 < chars.len() {
                        i += 2;
                        continue;
                    }
                    if c == quote {
                        in_str = None;
                    }
                    i += 1;
                    continue;
                }
                if c == '"' || c == '\'' {
                    in_str = Some(c);
                } else if (c == '/' && chars.get(i + 1) == Some(&'/')) || c == '#' {
                    return chars[..i].iter().collect::<String>().trim_end().to_string();
                }
                i += 1;
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `preprocess`: fences, comments and surrounding whitespace off.
pub fn preprocess(input: &str) -> String {
    strip_comments(&strip_fences(input.trim())).trim().to_string()
}

/// A materialised value: what a prop holds once references are inlined and expressions evaluated.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
    /// A component the contract knows, with its positional arguments mapped to prop names.
    Element(Element),
    /// `Action([...])`: its steps.
    Plan(Vec<Step>),
    /// One step of a plan, outside `Action`.
    Step(Step),
}

/// An action step. Only [`Step::ToAssistant`] does anything.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    ToAssistant {
        message: String,
        context: Option<String>,
    },
    /// `Run`, `OpenUrl`, `Set`, `Reset`: parsed, never executed.
    Other(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub name: String,
    pub props: Vec<(&'static str, Value)>,
    /// The statement the element came from (`statementId`).
    pub statement: String,
}

impl Element {
    pub fn prop(&self, name: &str) -> Option<&Value> {
        self.props.iter().find(|(key, _)| *key == name).map(|(_, value)| value)
    }
}

/// How a component maps positional arguments: its prop names in order, and a validation per prop
/// (`compileSchema` and lang-core's leaf validation).
#[derive(Clone, Copy, Debug)]
pub struct Param {
    pub name: &'static str,
    pub required: bool,
    pub kind: Kind,
}

/// The JSON-schema leaf a prop has, as lang-core's `validateSchemaValue` can check it. `Other` is anything it skips
/// (a union, a tuple, an object): Zod decides those later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Str,
    Num,
    Enum(&'static [&'static str]),
    StrArray,
    NumArray,
    Other,
}

/// The outcome of a parse: the root and what the parser saw.
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    pub root: Option<Element>,
    pub incomplete: bool,
    pub unresolved: Vec<String>,
    pub orphaned: Vec<String>,
    pub statements: usize,
}

impl Parsed {
    fn empty(incomplete: bool) -> Self {
        Self { root: None, incomplete, unresolved: Vec::new(), orphaned: Vec::new(), statements: 0 }
    }
}

/// The component table the parser maps arguments with.
pub type Table = fn(&str) -> Option<&'static [Param]>;

/// `parse`: OpenUI Lang to its root element, mapping arguments with `table`. The entry is the statement named
/// `root`, else the first statement that is a component (lang-core's `pickEntryId`).
pub fn parse(input: &str, table: Table) -> Parsed {
    let text = preprocess(input);
    if text.is_empty() {
        return Parsed::empty(true);
    }
    let (closed, incomplete) = auto_close(&text);
    let statements = split(&tokenize(&closed));
    if statements.is_empty() {
        return Parsed::empty(incomplete);
    }
    // Later statements with the same name replace earlier ones (a `Map`), keeping the first's place.
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, (bool, Ast)> = HashMap::new();
    for statement in &statements {
        let ast = parse_expression(&statement.tokens);
        if !by_id.contains_key(&statement.id) {
            order.push(statement.id.clone());
        }
        by_id.insert(statement.id.clone(), (statement.is_state, ast));
    }
    let is_component_statement = |id: &String| {
        let (is_state, ast) = &by_id[id];
        !*is_state && matches!(ast, Ast::Comp(name, _) if !is_builtin(name) && name != "Query" && name != "Mutation")
    };
    let entry = if by_id.contains_key("root") {
        "root".to_string()
    } else {
        order.iter().find(|id| is_component_statement(id)).cloned().unwrap_or_else(|| order[0].clone())
    };
    let mut ctx = Context {
        symbols: by_id.iter().map(|(id, (_, ast))| (id.clone(), ast.clone())).collect(),
        table,
        visited: HashSet::new(),
        unresolved: Vec::new(),
        unreached: order
            .iter()
            .filter(|id| {
                **id != entry && !by_id[*id].0 && !matches!(&by_id[*id].1, Ast::Comp(name, _) if name == "Query" || name == "Mutation")
            })
            .cloned()
            .collect(),
        statement: entry.clone(),
        budget: NODE_BUDGET,
    };
    let root_ast = ctx.symbols[&entry].clone();
    let value = ctx.value(&root_ast);
    let root = match value {
        Value::Element(mut element) => {
            element.statement = entry;
            Some(element)
        }
        _ => None,
    };
    let orphaned: Vec<String> = order.iter().filter(|id| ctx.unreached.contains(*id)).cloned().collect();
    Parsed { root, incomplete, unresolved: ctx.unresolved, orphaned, statements: order.len() }
}

/// Elements materialised at most, so a block whose references fan out (`a = [b, b]`, `b = [c, c]`...) ends.
const NODE_BUDGET: usize = 20_000;

struct Context {
    symbols: HashMap<String, Ast>,
    table: Table,
    visited: HashSet<String>,
    unresolved: Vec<String>,
    unreached: HashSet<String>,
    statement: String,
    budget: usize,
}

impl Context {
    /// `resolveRef`: a name's statement, inlined; a cycle or an unknown name is unresolved.
    fn resolve(&mut self, name: &str) -> Value {
        if self.visited.contains(name) || !self.symbols.contains_key(name) {
            self.unresolved.push(name.to_string());
            return Value::Null;
        }
        let target = self.symbols[name].clone();
        self.unreached.remove(name);
        if matches!(&target, Ast::Comp(callee, _) if callee == "Query" || callee == "Mutation") {
            return Value::Null;
        }
        self.visited.insert(name.to_string());
        let previous = std::mem::replace(&mut self.statement, name.to_string());
        let mut value = self.value(&target);
        if let Value::Element(element) = &mut value {
            element.statement = name.to_string();
        }
        self.statement = previous;
        self.visited.remove(name);
        value
    }

    /// `materializeValue` and `evaluate` together.
    fn value(&mut self, node: &Ast) -> Value {
        if self.budget == 0 {
            return Value::Null;
        }
        self.budget -= 1;
        match node {
            Ast::Ref(name) => self.resolve(name),
            Ast::Str(value) => Value::Str(value.clone()),
            Ast::Num(value) => Value::Num(*value),
            Ast::Bool(value) => Value::Bool(*value),
            Ast::Null | Ast::StateRef(_) | Ast::Assign(..) => Value::Null,
            Ast::Arr(els) => {
                let mut items = Vec::new();
                for element in els {
                    let value = self.value(element);
                    // A component or reference that came to nothing is left out of its list.
                    if value == Value::Null && matches!(element, Ast::Comp(..) | Ast::Ref(_)) {
                        continue;
                    }
                    items.push(value);
                }
                Value::Arr(items)
            }
            Ast::Obj(entries) => Value::Obj(entries.iter().map(|(key, value)| (key.clone(), self.value(value))).collect()),
            Ast::Comp(name, args) => self.call(name, args),
            Ast::Bin(op, left, right) => {
                let (left, right) = (self.value(left), self.value(right));
                binary(*op, left, right)
            }
            Ast::Not(operand) => Value::Bool(!truthy(&self.value(operand))),
            Ast::Neg(operand) => Value::Num(-to_number(&self.value(operand))),
            Ast::Ternary(cond, then, otherwise) => {
                if truthy(&self.value(cond)) {
                    self.value(then)
                } else {
                    self.value(otherwise)
                }
            }
            Ast::Member(object, field) => match self.value(object) {
                Value::Obj(entries) => entries.into_iter().find(|(key, _)| key == field).map(|(_, value)| value).unwrap_or(Value::Null),
                Value::Arr(items) if field == "length" => Value::Num(items.len() as f64),
                Value::Str(text) if field == "length" => Value::Num(text.encode_utf16().count() as f64),
                _ => Value::Null,
            },
            Ast::Index(object, index) => {
                let (object, index) = (self.value(object), self.value(index));
                match (object, index) {
                    (Value::Arr(items), Value::Num(at)) if at >= 0.0 && at.fract() == 0.0 => {
                        items.into_iter().nth(at as usize).unwrap_or(Value::Null)
                    }
                    (Value::Obj(entries), key) => {
                        let key = to_text(&key);
                        entries.into_iter().find(|(name, _)| *name == key).map(|(_, value)| value).unwrap_or(Value::Null)
                    }
                    _ => Value::Null,
                }
            }
        }
    }

    fn call(&mut self, name: &str, args: &[Ast]) -> Value {
        match name {
            "Action" => {
                let steps = match args.first().map(|arg| self.value(arg)) {
                    Some(Value::Arr(items)) => items,
                    _ => Vec::new(),
                };
                Value::Plan(
                    steps
                        .into_iter()
                        .filter_map(|step| match step {
                            Value::Step(step) => Some(step),
                            _ => None,
                        })
                        .collect(),
                )
            }
            "ToAssistant" => {
                let message = args.first().map(|arg| to_text(&self.value(arg))).unwrap_or_default();
                let context = args.get(1).map(|arg| to_text(&self.value(arg)));
                Value::Step(Step::ToAssistant { message, context })
            }
            "Run" => Value::Step(Step::Other("run")),
            "OpenUrl" => Value::Step(Step::Other("open_url")),
            "Set" => Value::Step(Step::Other("set")),
            "Reset" => Value::Step(Step::Other("reset")),
            "Query" | "Mutation" => Value::Null,
            _ if is_builtin(name) => self.builtin(name, args),
            _ => self.component(name, args),
        }
    }

    fn builtin(&mut self, name: &str, args: &[Ast]) -> Value {
        let values: Vec<Value> = args.iter().map(|arg| self.value(arg)).collect();
        let list = |value: Option<&Value>| match value {
            Some(Value::Arr(items)) => Some(items.clone()),
            _ => None,
        };
        let number = |value: Option<&Value>| value.map(to_number).unwrap_or(0.0);
        match name {
            "Count" => Value::Num(list(values.first()).map_or(0, |items| items.len()) as f64),
            "First" => list(values.first()).and_then(|items| items.into_iter().next()).unwrap_or(Value::Null),
            "Last" => list(values.first()).and_then(|items| items.into_iter().last()).unwrap_or(Value::Null),
            "Sum" => Value::Num(list(values.first()).map_or(0.0, |items| items.iter().map(to_number).sum())),
            "Avg" => Value::Num(match list(values.first()) {
                Some(items) if !items.is_empty() => items.iter().map(to_number).sum::<f64>() / items.len() as f64,
                _ => 0.0,
            }),
            "Min" => Value::Num(match list(values.first()) {
                Some(items) if !items.is_empty() => items.iter().map(to_number).fold(f64::INFINITY, f64::min),
                _ => 0.0,
            }),
            "Max" => Value::Num(match list(values.first()) {
                Some(items) if !items.is_empty() => items.iter().map(to_number).fold(f64::NEG_INFINITY, f64::max),
                _ => 0.0,
            }),
            "Round" => {
                let factor = 10f64.powf(values.get(1).map_or(0.0, to_number));
                // `Math.round` rounds halves up.
                Value::Num(((number(values.first()) * factor) + 0.5).floor() / factor)
            }
            "Abs" => Value::Num(number(values.first()).abs()),
            "Floor" => Value::Num(number(values.first()).floor()),
            "Ceil" => Value::Num(number(values.first()).ceil()),
            // Sort, Filter, Each: need state or a template scope the contract never gives.
            _ => Value::Null,
        }
    }

    /// A catalog component: positional arguments to named props, then lang-core's leaf validation (a wrong leaf on
    /// an optional prop is pruned, on a required one drops the component; a missing required prop drops it too).
    fn component(&mut self, name: &str, args: &[Ast]) -> Value {
        let Some(params) = (self.table)(name) else { return Value::Null };
        let mut props: Vec<(&'static str, Value)> = Vec::new();
        for (param, arg) in params.iter().zip(args) {
            let mut value = self.value(arg);
            if !leaf_ok(&mut value, param.kind) {
                if param.required {
                    return Value::Null;
                }
                // Pruned: the prop is as if it were not given.
                continue;
            }
            props.push((param.name, value));
        }
        let missing = params.iter().any(|param| {
            param.required && !matches!(props.iter().find(|(key, _)| *key == param.name), Some((_, value)) if *value != Value::Null)
        });
        if missing {
            return Value::Null;
        }
        Value::Element(Element { name: name.to_string(), props, statement: self.statement.clone() })
    }
}

/// `validateSchemaValue` for a leaf: a null passes; a scalar must be its type (and in its enum); a list of scalars
/// loses the items that are not (array items are always pruned). Enums are only checked on a finished block in
/// lang-core; this port parses finished text, so it always checks.
fn leaf_ok(value: &mut Value, kind: Kind) -> bool {
    if *value == Value::Null {
        return true;
    }
    match kind {
        Kind::Str => matches!(value, Value::Str(_)),
        Kind::Num => matches!(value, Value::Num(_)),
        Kind::Enum(allowed) => matches!(value, Value::Str(text) if allowed.contains(&text.as_str())),
        Kind::StrArray => match value {
            Value::Arr(items) => {
                items.retain(|item| matches!(item, Value::Str(_)));
                true
            }
            _ => false,
        },
        Kind::NumArray => match value {
            Value::Arr(items) => {
                items.retain(|item| matches!(item, Value::Num(_)));
                true
            }
            _ => false,
        },
        Kind::Other => true,
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Num(number) => *number != 0.0 && !number.is_nan(),
        Value::Str(text) => !text.is_empty(),
        _ => true,
    }
}

/// `toNumber`.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Num(number) => *number,
        Value::Str(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { 0.0 } else { trimmed.parse::<f64>().unwrap_or(0.0) }
        }
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        _ => 0.0,
    }
}

/// JavaScript's `String(value)` for what a prop can hold.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Num(number) => js_number(*number),
        Value::Str(text) => text.clone(),
        Value::Arr(items) => items.iter().map(to_text).collect::<Vec<_>>().join(","),
        _ => "[object Object]".to_string(),
    }
}

fn binary(op: Op, left: Value, right: Value) -> Value {
    match op {
        Op::Add => match (&left, &right) {
            (Value::Str(_), _) | (_, Value::Str(_)) => Value::Str(format!("{}{}", to_text(&left), to_text(&right))),
            _ => Value::Num(to_number(&left) + to_number(&right)),
        },
        Op::Sub => Value::Num(to_number(&left) - to_number(&right)),
        Op::Mul => Value::Num(to_number(&left) * to_number(&right)),
        Op::Div => Value::Num(to_number(&left) / to_number(&right)),
        Op::Rem => Value::Num(to_number(&left) % to_number(&right)),
        Op::Eq => Value::Bool(loose_eq(&left, &right)),
        Op::Ne => Value::Bool(!loose_eq(&left, &right)),
        Op::Gt => Value::Bool(to_number(&left) > to_number(&right)),
        Op::Lt => Value::Bool(to_number(&left) < to_number(&right)),
        Op::Ge => Value::Bool(to_number(&left) >= to_number(&right)),
        Op::Le => Value::Bool(to_number(&left) <= to_number(&right)),
        Op::And => {
            if truthy(&left) {
                right
            } else {
                left
            }
        }
        Op::Or => {
            if truthy(&left) {
                left
            } else {
                right
            }
        }
    }
}

fn loose_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (Value::Str(a), Value::Str(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (a, b) => to_number(a) == to_number(b),
    }
}
