//! JSON text exactly as Node's `JSON.stringify` writes it for a value `JSON.parse` read.
//!
//! The daemon answers commands with `JSON.stringify` of JavaScript objects, so a Rust owner that keeps the result
//! contracts byte-compatible has to follow JavaScript's rules, which differ from serde_json's in three places:
//!
//! - **Key order.** JavaScript objects list integer-like keys ("0".."4294967294", canonical) first, ascending, then the
//!   other keys in insertion order. `{"10":…,"9":…,"a":…}` parsed and written again comes out `{"9":…,"10":…,"a":…}`.
//!   Sessions and worktrees are keyed by number, so this shows in every state.
//! - **Numbers.** Every number is an IEEE double printed with ECMAScript `Number::toString` (`1e+21`, `1e-7`,
//!   `0.000001`, `-0` as `0`), and integers beyond 2^53 lose precision as JavaScript's do.
//! - **Strings.** Escapes are `\" \\ \b \f \n \r \t` and `\u00xx` (lower-case) for other control characters, nothing
//!   else; an unpaired UTF-16 surrogate is written `\udxxx`.
//!
//! ## Unpaired surrogates
//!
//! A JavaScript string is UTF-16 and may hold an unpaired surrogate (half an emoji cut by `slice`); `JSON.stringify`
//! writes it as `\ud83d`, `JSON.parse` reads it back. A Rust `String` can't hold one and serde_json refuses the
//! escape. [`parse`] keeps it anyway, losslessly, in an escape inside the `String`:
//!
//! - an unpaired surrogate `s` becomes [`ESC`] followed by `char(0xF0000 + (s - 0xD800))`;
//! - a real [`ESC`] (U+10FFFE, a noncharacter) becomes [`ESC`] [`ESC`].
//!
//! The mapping is injective, so equality of encoded strings is equality of the JavaScript strings. [`to_string`]
//! decodes it back to `\udxxx` (or the real U+10FFFE), [`utf16_len`] / [`to_utf16`] / [`from_utf16`] work on the
//! JavaScript string, and [`to_sqlite_text`] gives the UTF-8 node:sqlite would bind (an unpaired surrogate as U+FFFD).
//! Strings that come from elsewhere (SQLite text, file names) go through [`js_string`] before they enter a `Value`.

use serde_json::{Map, Number, Value};

/// `JSON.stringify(value)` for a value made of what `JSON.parse` returns.
pub fn to_string(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        _ if is_undefined(value) => out.push_str("null"),
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number_to_js(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let entries = js_entries(map)
                .into_iter()
                .filter(|(_, item)| !is_undefined(item));
            for (index, (key, item)) in entries.enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

/// An object's entries in JavaScript's own-property order.
pub fn js_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

/// The array index a property key names (ECMAScript CanonicalNumericIndexString for 0..2^32-2), if it is one.
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    (value < u32::MAX as u64).then_some(value as u32)
}

/// The escape character of the unpaired-surrogate encoding (see module docs).
pub const ESC: char = '\u{10FFFE}';
const LONE_BASE: u32 = 0xF0000;

/// One unit of an encoded string: a real character, or an unpaired surrogate.
enum Unit {
    Char(char),
    Lone(u16),
}

fn units(text: &str) -> impl Iterator<Item = Unit> + '_ {
    let mut chars = text.chars();
    std::iter::from_fn(move || {
        let character = chars.next()?;
        if character != ESC {
            return Some(Unit::Char(character));
        }
        Some(match chars.next() {
            Some(ESC) | None => Unit::Char(ESC),
            Some(marker) => Unit::Lone((marker as u32 - LONE_BASE + 0xD800) as u16),
        })
    })
}

/// JSON as a provider produced it: a plain `serde_json` value, its strings as they are (they may hold U+10FFFE, the
/// `undefined` marker's text or anything else). The owner's own values are encoded (see the module docs); a
/// `RawJson` crosses into them once, through [`RawJson::encode`] (ChatHost::deliver does it for every provider event).
/// Values a caller already encoded (parsed with [`parse`], or read back from storage) never go through it again.
#[derive(Clone, Debug, PartialEq)]
pub struct RawJson(pub Value);

impl RawJson {
    /// The encoded value: every string and key through [`js_string`] (a real U+10FFFE doubled).
    pub fn encode(&self) -> Value {
        encode_raw(&self.0)
    }

    /// The encoded value, taking the raw one: strings are rewritten only when they hold U+10FFFE (no copy otherwise).
    pub fn into_encoded(self) -> Value {
        let mut value = self.0;
        encode_in_place(&mut value);
        value
    }

    /// What the owner hands a provider (a turn's request, answers): the raw value of an encoded one, an unpaired
    /// surrogate (a truncated emoji from a JavaScript client) replaced by U+FFFD, which no plain string or CLI pipe can
    /// carry. A real U+10FFFE comes back single.
    pub fn decode_lossy(encoded: &Value) -> RawJson {
        RawJson(decode_value_lossy(encoded))
    }

    /// The raw value of an encoded one (for a test or a recorded trace replayed through a provider). Fails on an
    /// unpaired surrogate, which a plain Rust string can't hold.
    pub fn decode(encoded: &Value) -> Result<RawJson, String> {
        decode_value(encoded).map(RawJson)
    }
}

fn encode_raw(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(js_string(text)),
        Value::Array(items) => Value::Array(items.iter().map(encode_raw).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (js_string(key), encode_raw(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn encode_in_place(value: &mut Value) {
    match value {
        Value::String(text) => {
            if text.contains(ESC) {
                *text = js_string(text);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(encode_in_place),
        Value::Object(map) => {
            if map.keys().any(|key| key.contains(ESC)) {
                let taken = std::mem::take(map);
                *map = taken
                    .into_iter()
                    .map(|(key, mut item)| {
                        encode_in_place(&mut item);
                        (js_string(&key), item)
                    })
                    .collect();
            } else {
                map.values_mut().for_each(encode_in_place);
            }
        }
        _ => {}
    }
}

/// An encoded string as a plain one, an unpaired surrogate as U+FFFD.
pub fn decode_text_lossy(text: &str) -> String {
    if !text.contains(ESC) {
        return text.to_string();
    }
    String::from_utf16_lossy(&to_utf16(text))
}

fn decode_value_lossy(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(decode_text_lossy(text)),
        Value::Array(items) => Value::Array(items.iter().map(decode_value_lossy).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (decode_text_lossy(key), decode_value_lossy(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn decode_text(text: &str) -> Result<String, String> {
    String::from_utf16(&to_utf16(text))
        .map_err(|_| "an unpaired surrogate has no plain Rust string".to_string())
}

fn decode_value(value: &Value) -> Result<Value, String> {
    Ok(match value {
        Value::String(text) => Value::String(decode_text(text)?),
        Value::Array(items) => {
            Value::Array(items.iter().map(decode_value).collect::<Result<_, _>>()?)
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| Ok((decode_text(key)?, decode_value(item)?)))
                .collect::<Result<_, String>>()?,
        ),
        other => other.clone(),
    })
}

/// A string from outside JSON (SQLite text, a path) in the encoding `Value`s use: a real U+10FFFE doubled.
pub fn js_string(text: &str) -> String {
    if text.contains(ESC) {
        text.replace(ESC, "\u{10FFFE}\u{10FFFE}")
    } else {
        text.to_string()
    }
}

/// UTF-16 code units of the JavaScript string an encoded `String` stands for.
pub fn to_utf16(text: &str) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    for unit in units(text) {
        match unit {
            Unit::Char(character) => out.extend_from_slice(character.encode_utf16(&mut [0u16; 2])),
            Unit::Lone(surrogate) => out.push(surrogate),
        }
    }
    out
}

/// The encoded `String` for JavaScript UTF-16 code units (lossless; see module docs).
pub fn from_utf16(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len());
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ESC) => {
                out.push(ESC);
                out.push(ESC);
            }
            Ok(character) => out.push(character),
            Err(error) => {
                out.push(ESC);
                out.push(
                    char::from_u32(LONE_BASE + (error.unpaired_surrogate() as u32 - 0xD800))
                        .expect("plane 15"),
                );
            }
        }
    }
    out
}

/// JavaScript `string.length` of an encoded string.
pub fn utf16_len(text: &str) -> usize {
    units(text)
        .map(|unit| match unit {
            Unit::Char(character) => character.len_utf16(),
            Unit::Lone(_) => 1,
        })
        .sum()
}

/// Whether an encoded string holds an unpaired surrogate.
pub fn has_lone_surrogate(text: &str) -> bool {
    units(text).any(|unit| matches!(unit, Unit::Lone(_)))
}

/// The UTF-8 node:sqlite binds for this JavaScript string: V8 writes an unpaired surrogate as U+FFFD.
pub fn to_sqlite_text(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains(ESC) {
        return std::borrow::Cow::Borrowed(text);
    }
    std::borrow::Cow::Owned(
        units(text)
            .map(|unit| match unit {
                Unit::Char(character) => character,
                Unit::Lone(_) => '\u{FFFD}',
            })
            .collect(),
    )
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for unit in units(text) {
        let character = match unit {
            Unit::Lone(surrogate) => {
                out.push_str(&format!("\\u{surrogate:04x}"));
                continue;
            }
            Unit::Char(character) => character,
        };
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32))
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// The double JavaScript holds for a JSON number.
pub fn as_f64(number: &Number) -> f64 {
    if let Some(value) = number.as_i64() {
        value as f64
    } else if let Some(value) = number.as_u64() {
        value as f64
    } else {
        number.as_f64().unwrap_or(f64::NAN)
    }
}

fn number_to_js(number: &Number) -> String {
    const SAFE: i64 = 1 << 53;
    if let Some(value) = number.as_i64() {
        if (-SAFE..=SAFE).contains(&value) {
            return value.to_string();
        }
    }
    if let Some(value) = number.as_u64() {
        if value <= SAFE as u64 {
            return value.to_string();
        }
    }
    f64_to_js(as_f64(number))
}

/// ECMAScript `Number::toString(x)` (radix 10). JSON writes NaN and infinities as `null`.
pub fn f64_to_js(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value < 0.0 {
        return format!("-{}", f64_to_js(-value));
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, as ECMAScript requires: "d.ddde±x".
    let formatted = format!("{value:e}");
    let (mantissa, exponent) = formatted.split_once('e').expect("exponent format");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// `JSON.parse(text)`: the same values serde_json gives (integers as i64/u64, other numbers as f64, objects in
/// insertion order with a repeated key keeping its first place and last value), but an unpaired `\udxxx` escape is
/// kept (see module docs) instead of refused. Errors carry the byte offset.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        text,
        at: 0,
    };
    parser.space();
    let value = parser.value(0)?;
    parser.space();
    if parser.at != parser.bytes.len() {
        return Err(parser.error("Unexpected data after JSON"));
    }
    Ok(value)
}

/// [`parse`] for bytes read from a file, decoded like Node's `readFile(…, "utf8")` (invalid UTF-8 as U+FFFD).
pub fn parse_bytes(bytes: &[u8]) -> Result<Value, String> {
    parse(&String::from_utf8_lossy(bytes))
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn error(&self, message: &str) -> String {
        format!("{message} at position {}", self.at)
    }

    fn space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, String> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error("Unexpected token"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > 10_000 {
            return Err(self.error("Nesting too deep"));
        }
        match self.bytes.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut map = Map::new();
                self.space();
                if self.bytes.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Value::Object(map));
                }
                loop {
                    self.space();
                    if self.bytes.get(self.at) != Some(&b'"') {
                        return Err(self.error("Expected a property name"));
                    }
                    let key = self.string()?;
                    self.space();
                    if self.bytes.get(self.at) != Some(&b':') {
                        return Err(self.error("Expected ':'"));
                    }
                    self.at += 1;
                    self.space();
                    let item = self.value(depth + 1)?;
                    map.insert(key, item);
                    self.space();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Value::Object(map));
                        }
                        _ => return Err(self.error("Expected ',' or '}'")),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.bytes.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                loop {
                    self.space();
                    items.push(self.value(depth + 1)?);
                    self.space();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::Array(items));
                        }
                        _ => return Err(self.error("Expected ',' or ']'")),
                    }
                }
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            None => Err(self.error("Unexpected end of JSON input")),
            _ => Err(self.error("Unexpected token")),
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.at;
        let digits = |parser: &mut Self| {
            let from = parser.at;
            while matches!(parser.bytes.get(parser.at), Some(b'0'..=b'9')) {
                parser.at += 1;
            }
            parser.at > from
        };
        if self.bytes.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        if self.bytes.get(self.at) == Some(&b'0') {
            self.at += 1;
        } else if !digits(self) {
            return Err(self.error("No number after minus sign"));
        }
        let mut integer = true;
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            integer = false;
            if !digits(self) {
                return Err(self.error("Unterminated fractional number"));
            }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            integer = false;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !digits(self) {
                return Err(self.error("Exponent part is missing a number"));
            }
        }
        let text = &self.text[start..self.at];
        if integer {
            if let Ok(value) = text.parse::<i64>() {
                return Ok(Value::from(value));
            }
            if let Ok(value) = text.parse::<u64>() {
                return Ok(Value::from(value));
            }
        }
        let value: f64 = text.parse().map_err(|_| self.error("Bad number"))?;
        // JSON.parse gives Infinity for 1e400, which JSON.stringify writes as null.
        Ok(Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let digits = self
            .text
            .get(self.at..self.at + 4)
            .ok_or_else(|| self.error("Bad Unicode escape"))?;
        let value =
            u16::from_str_radix(digits, 16).map_err(|_| self.error("Bad Unicode escape"))?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(self.error("Bad Unicode escape"));
        }
        self.at += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, String> {
        self.at += 1;
        let mut units: Vec<u16> = Vec::new();
        let mut plain = String::new();
        let mut simple = true;
        loop {
            let Some(&byte) = self.bytes.get(self.at) else {
                return Err(self.error("Unterminated string in JSON"));
            };
            match byte {
                b'"' => {
                    self.at += 1;
                    return Ok(if simple {
                        js_string(&plain)
                    } else {
                        from_utf16(&units)
                    });
                }
                b'\\' => {
                    if simple {
                        units.extend(plain.encode_utf16());
                        simple = false;
                    }
                    self.at += 1;
                    let escape = *self
                        .bytes
                        .get(self.at)
                        .ok_or_else(|| self.error("Bad escaped character"))?;
                    self.at += 1;
                    match escape {
                        b'"' => units.push(0x22),
                        b'\\' => units.push(0x5C),
                        b'/' => units.push(0x2F),
                        b'b' => units.push(0x08),
                        b'f' => units.push(0x0C),
                        b'n' => units.push(0x0A),
                        b'r' => units.push(0x0D),
                        b't' => units.push(0x09),
                        b'u' => {
                            let unit = self.hex4()?;
                            units.push(unit);
                        }
                        _ => {
                            self.at -= 1;
                            return Err(self.error("Bad escaped character"));
                        }
                    }
                }
                0x00..=0x1F => return Err(self.error("Bad control character in string literal")),
                _ => {
                    let rest = &self.text[self.at..];
                    let character = rest.chars().next().expect("in bounds");
                    self.at += character.len_utf8();
                    if simple {
                        plain.push(character);
                    } else {
                        units.extend_from_slice(character.encode_utf16(&mut [0u16; 2]));
                    }
                }
            }
        }
    }
}

/// A property whose value is JavaScript `undefined`: `{ ...previous, title: event.title }` keeps the key, in its place,
/// with no value. `JSON.stringify` leaves it out (and writes `null` for it in an array), but it holds the key's position
/// in memory, so a later assignment lands where Node's would. Never parsed from JSON: an [`ESC`] followed by U+0000 is
/// not a valid escape of the unpaired-surrogate encoding. Strip it with [`strip_undefined`] before handing a value to
/// anything that serializes with serde_json.
pub fn undefined() -> Value {
    Value::String(UNDEFINED.into())
}

const UNDEFINED: &str = "\u{10FFFE}\u{0}undefined";

pub fn is_undefined(value: &Value) -> bool {
    matches!(value, Value::String(text) if text == UNDEFINED)
}

/// The value of a property unless it is missing or `undefined`: JavaScript's `value !== undefined`.
pub fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !is_undefined(value))
}

/// `value ?? fallback`: the first that is neither missing, `undefined` nor `null`.
pub fn nullish<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match defined(value) {
        Some(Value::Null) | None => fallback,
        some => some,
    }
}

/// `value` as JSON would carry it: `undefined` properties dropped, `undefined` array items as `null`.
pub fn strip_undefined(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, item)| !is_undefined(item))
                .map(|(key, item)| (key.clone(), strip_undefined(item)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| {
                    if is_undefined(item) {
                        Value::Null
                    } else {
                        strip_undefined(item)
                    }
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// JavaScript `a === b` for values `JSON.parse` returns: objects and arrays are never equal (distinct references).
pub fn strict_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        _ if is_undefined(a) || is_undefined(b) => is_undefined(a) && is_undefined(b),
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => as_f64(x) == as_f64(y),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

/// JavaScript truthiness of a parsed value; `None` stands for `undefined`.
pub fn truthy(value: Option<&Value>) -> bool {
    match defined(value) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => {
            let value = as_f64(number);
            value != 0.0 && !value.is_nan()
        }
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(value)` as a property key, for lookups like `details[step.id]`; `None` is `undefined`.
pub fn property_key(value: Option<&Value>) -> String {
    match defined(value) {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => {
            let text = number_to_js(number);
            if text == "null" {
                "NaN".into()
            } else {
                text
            }
        }
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                _ if is_undefined(item) => String::new(),
                other => property_key(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// A JSON number from a double, as JavaScript would hold it (integers stay integers when exact).
pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= (1u64 << 53) as f64 {
        Value::from(value as i64)
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_ecmascript() {
        for (value, expected) in [
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (-2.5, "-2.5"),
            (123456789.125, "123456789.125"),
            (1.5e-10, "1.5e-10"),
            (2.0, "2"),
            (-0.0, "0"),
            (1794312000000.0, "1794312000000"),
        ] {
            assert_eq!(f64_to_js(value), expected, "{value}");
        }
        assert_eq!(to_string(&json!(9007199254740993u64)), "9007199254740992");
    }

    #[test]
    fn integer_keys_come_first() {
        let value: Value = serde_json::from_str(
            r#"{"b":1,"10":2,"9":3,"01":4,"a":5,"4294967295":6,"4294967294":7}"#,
        )
        .unwrap();
        assert_eq!(
            to_string(&value),
            r#"{"9":3,"10":2,"4294967294":7,"b":1,"01":4,"a":5,"4294967295":6}"#
        );
    }

    #[test]
    fn unpaired_surrogates_round_trip() {
        for text in [
            r#""\ud83d""#,
            r#""a\udc00b""#,
            r#""\ud83d\ude00""#,
            "\"\u{10FFFE}x\"",
            r#""\udbff\udffe\ud800""#,
            r#"{"k\ud800":["\udfff"]}"#,
        ] {
            let value = parse(text).unwrap();
            let again = to_string(&value);
            let expected = to_string(&parse(&again).unwrap());
            assert_eq!(again, expected, "{text}");
        }
        assert_eq!(to_string(&parse(r#""\ud83d""#).unwrap()), r#""\ud83d""#);
        assert_eq!(
            to_string(&parse(r#""\ud83d\ude00""#).unwrap()),
            "\"\u{1F600}\""
        );
        // A real U+10FFFE and an unpaired surrogate stay distinct.
        let real = parse("\"\u{10FFFE}\"").unwrap();
        let lone = parse(r#""\udbff""#).unwrap();
        assert_ne!(real, lone);
        assert_eq!(utf16_len(real.as_str().unwrap()), 2);
        assert_eq!(utf16_len(lone.as_str().unwrap()), 1);
        assert_eq!(to_string(&real), "\"\u{10FFFE}\"");
        assert_eq!(to_sqlite_text(lone.as_str().unwrap()), "\u{FFFD}");
        // slice(0, 1) of an emoji: half of it.
        let emoji = to_utf16("\u{1F600}");
        assert_eq!(
            to_string(&Value::String(from_utf16(&emoji[..1]))),
            r#""\ud83d""#
        );
    }

    #[test]
    fn parse_matches_serde_for_ordinary_json() {
        for text in [
            r#"{"b":1,"a":[1.5,-0,1e400,-2,18446744073709551615,9223372036854775808,"x\n\u00e9\/"],"c":{"d":null,"e":true}}"#,
            r#"[]"#,
            r#" { "dup": 1, "x": 2, "dup": 3 } "#,
        ] {
            let ours = parse(text).unwrap();
            let theirs: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            if text.contains("1e400") {
                assert_eq!(ours["a"][2], Value::Null);
                continue;
            }
            assert_eq!(ours, theirs, "{text}");
        }
        for bad in [
            "",
            "{",
            r#"{"a":}"#,
            "[1,]",
            "01",
            "\"\t\"",
            r#""\x""#,
            "tru",
            "1 2",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        assert_eq!(
            to_string(&json!("a\"b\\c\u{1}\u{1f}\n\t\u{7f}é\u{1F600}/")),
            "\"a\\\"b\\\\c\\u0001\\u001f\\n\\t\u{7f}é\u{1F600}/\""
        );
    }
}
