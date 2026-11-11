//! Chat search: `packages/shared/src/message-search.mjs` searchMessages and `packages/core/src/chat-pages.cjs`
//! chatSearch, ported. Offsets, lengths, typo distances and snippets are in UTF-16 code units, as JavaScript counts
//! them, so scores, snippets and highlights come out the same. The per-array index cache is not ported (perf only).

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::error::{Result, StoreError};
use crate::jsjson;

fn word_pattern() -> &'static Regex {
    static WORD: OnceLock<Regex> = OnceLock::new();
    WORD.get_or_init(|| Regex::new(r"[\p{L}\p{N}_]+").expect("valid"))
}

fn is_word_char(character: char) -> bool {
    static ONE: OnceLock<Regex> = OnceLock::new();
    let mut buffer = [0u8; 4];
    ONE.get_or_init(|| Regex::new(r"^[\p{L}\p{N}_]$").expect("valid"))
        .is_match(character.encode_utf8(&mut buffer))
}

/// JavaScript's `\s` / `trim` whitespace, all of it in the BMP.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

fn trim_start(units: &[u16]) -> &[u16] {
    let from = units
        .iter()
        .position(|unit| !js_space(*unit))
        .unwrap_or(units.len());
    &units[from..]
}

fn trim_end(units: &[u16]) -> &[u16] {
    let to = units
        .iter()
        .rposition(|unit| !js_space(*unit))
        .map_or(0, |at| at + 1);
    &units[..to]
}

/// `.replace(/\s+/g, " ")`
fn collapse(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut in_space = false;
    for unit in units {
        if js_space(*unit) {
            if !in_space {
                out.push(0x20);
            }
            in_space = true;
        } else {
            out.push(*unit);
            in_space = false;
        }
    }
    out
}

fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    (from..=haystack.len().saturating_sub(needle.len()))
        .find(|at| haystack[*at..].starts_with(needle))
}

/// Unique words of an (encoded) string, in order of first appearance.
fn words_of(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    word_pattern()
        .find_iter(text)
        .map(|found| found.as_str().to_string())
        .filter(|word| seen.insert(word.clone()))
        .collect()
}

/// Typos allowed for a query word: none for short words.
fn typos(length: usize) -> usize {
    if length >= 8 {
        2
    } else if length >= 4 {
        1
    } else {
        0
    }
}

/// editDistance: Damerau-Levenshtein distance between `a` and (with `prefix`) the closest prefix of `b`, or None
/// past `max`.
pub fn edit_distance(a: &[u16], b: &[u16], max: usize, prefix: bool) -> Option<usize> {
    let b = if prefix {
        &b[..b.len().min(a.len() + max)]
    } else {
        b
    };
    if a.len().abs_diff(b.len()) > max && !(prefix && b.len() > a.len()) {
        return None;
    }
    let mut before: Vec<usize> = vec![0; b.len() + 1];
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut current = vec![i];
        let mut best = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut value = (previous[j] + 1)
                .min(current[j - 1] + 1)
                .min(previous[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                value = value.min(before[j - 2] + 1);
            }
            current.push(value);
            best = best.min(value);
        }
        if best > max {
            return None;
        }
        before = previous;
        previous = current;
    }
    let distance = if prefix {
        let from = a.len().saturating_sub(max);
        previous
            .get(from..)
            .and_then(|rest| rest.iter().copied().min())?
    } else {
        previous[b.len()]
    };
    (distance <= max).then_some(distance)
}

struct Index {
    lowered: Vec<Vec<u16>>,
    /// word -> message positions, in insertion order
    words: Vec<(String, Vec<usize>)>,
}

fn build_index(bodies: &[&str]) -> Index {
    let mut lowered = Vec::with_capacity(bodies.len());
    let mut words: Vec<(String, Vec<usize>)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (position, body) in bodies.iter().enumerate() {
        let text = body.to_lowercase();
        for word in words_of(&text) {
            match at.get(&word) {
                Some(index) => words[*index].1.push(position),
                None => {
                    at.insert(word.clone(), words.len());
                    words.push((word, vec![position]));
                }
            }
        }
        lowered.push(jsjson::to_utf16(&text));
    }
    Index { lowered, words }
}

/// wordMatches: each index word that matches `term`, scored (exact 4, prefix 3, inside 2, typo 1.5 - edits/2).
fn word_matches<'a>(index: &'a Index, term: &str) -> Vec<(&'a str, &'a [usize], f64)> {
    let term16 = jsjson::to_utf16(term);
    let allowed = typos(term16.len());
    let mut found = Vec::new();
    for (word, postings) in &index.words {
        let score = if word == term {
            Some(4.0)
        } else if word.starts_with(term) {
            Some(3.0)
        } else if term16.len() >= 3 && word.contains(term) {
            Some(2.0)
        } else if allowed > 0 {
            edit_distance(&term16, &jsjson::to_utf16(word), allowed, true)
                .map(|distance| 1.5 - distance as f64 / 2.0)
        } else {
            None
        };
        if let Some(score) = score {
            found.push((word.as_str(), postings.as_slice(), score));
        }
    }
    found
}

/// snippetAround: up to ~90 units of `text` around [start, end), on word boundaries, and the match's place in it.
fn snippet_around(text: &[u16], start: usize, end: usize) -> (Vec<u16>, [usize; 2]) {
    let width: i64 = 90;
    let (start_i, end_i, length) = (start as i64, end as i64, text.len() as i64);
    let lead = 0.max(start_i.min(((width - (end_i - start_i)) as f64 / 3.0).floor() as i64));
    let mut from = start_i - lead;
    let mut to = length.min(from + width);
    if from > 0 {
        let space = text[..=(from as usize).min(text.len().saturating_sub(1))]
            .iter()
            .rposition(|unit| *unit == 0x20)
            .map(|at| at as i64);
        if let Some(space) = space.filter(|space| ((start_i - space) as f64) < width as f64 / 2.0) {
            from = space + 1;
        }
    }
    if to < length {
        if let Some(space) = index_of(text, &[0x20], to as usize).map(|at| at as i64) {
            if space - to < 12 {
                to = space;
            }
        }
    }
    let (from, to) = (from as usize, to as usize);
    let mut before: Vec<u16> = if from > 0 { vec![0x2026] } else { Vec::new() };
    before.extend_from_slice(trim_start(&collapse(&text[from..start])));
    let matched = collapse(&text[start..end]);
    let mut after = trim_end(&collapse(&text[end..to])).to_vec();
    if to < text.len() {
        after.push(0x2026);
    }
    let highlight = [before.len(), before.len() + matched.len()];
    let mut snippet = before;
    snippet.extend(matched);
    snippet.extend(after);
    (snippet, highlight)
}

/// The first `word` in `text` not preceded by a word character, in UTF-16 units.
fn word_start(text: &[u16], word: &[u16]) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = index_of(text, word, from) {
        let previous = if at == 0 {
            None
        } else {
            // The character before: a low surrogate's pair starts one unit earlier.
            let low = text[at - 1];
            let units = if (0xDC00..0xE000).contains(&low)
                && at >= 2
                && (0xD800..0xDC00).contains(&text[at - 2])
            {
                &text[at - 2..at]
            } else {
                &text[at - 1..at]
            };
            char::decode_utf16(units.iter().copied())
                .next()
                .and_then(|decoded| decoded.ok())
        };
        if !previous.is_some_and(is_word_char) {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

fn body_of(message: &Value) -> Result<&str> {
    match message.get("body") {
        Some(Value::String(body)) => Ok(body),
        Some(Value::Null) => Err(StoreError::Invalid(
            "Cannot read properties of null (reading 'toLowerCase')".into(),
        )),
        None => Err(StoreError::Invalid(
            "Cannot read properties of undefined (reading 'toLowerCase')".into(),
        )),
        Some(_) => Err(StoreError::Invalid(
            "message.body.toLowerCase is not a function".into(),
        )),
    }
}

/// One match: the message, its score, the matched text and a snippet with the match's place.
pub struct Match<'a> {
    pub message: &'a Value,
    pub score: f64,
    pub term: String,
    pub snippet: String,
    pub highlight: [usize; 2],
}

/// searchMessages: messages matching every word of `query`, best first, ties to the newest.
pub fn search_messages<'a>(
    messages: &'a [Value],
    query: &str,
    limit: usize,
) -> Result<Vec<Match<'a>>> {
    let units = jsjson::to_utf16(query);
    let phrase16 = collapse(trim_end(trim_start(&jsjson::to_utf16(
        &jsjson::from_utf16(&units).to_lowercase(),
    ))));
    // Lowercasing first then trimming is the same as trimming first: case mapping never makes or removes whitespace.
    let phrase = jsjson::from_utf16(&phrase16);
    let terms = words_of(&phrase);
    if terms.is_empty() || phrase16.len() < 2 {
        return Ok(Vec::new());
    }
    let bodies: Vec<&str> = messages.iter().map(body_of).collect::<Result<_>>()?;
    let index = build_index(&bodies);
    let mut scores: Option<Vec<(usize, f64)>> = None;
    let mut first_word: HashMap<usize, String> = HashMap::new();
    for (position, term) in terms.iter().enumerate() {
        let mut next: Vec<(usize, f64)> = Vec::new();
        let mut at: HashMap<usize, usize> = HashMap::new();
        let allowed: Option<std::collections::HashSet<usize>> = scores
            .as_ref()
            .map(|scores| scores.iter().map(|(message, _)| *message).collect());
        for (word, postings, score) in word_matches(&index, term) {
            for message in postings {
                if allowed
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(message))
                {
                    continue;
                }
                let current = at.get(message).map(|index| next[*index].1).unwrap_or(0.0);
                if current < score {
                    match at.get(message) {
                        Some(index) => next[*index].1 = score,
                        None => {
                            at.insert(*message, next.len());
                            next.push((*message, score));
                        }
                    }
                    if position == 0 {
                        first_word.insert(*message, word.to_string());
                    }
                }
            }
        }
        let earlier: HashMap<usize, f64> = scores.unwrap_or_default().into_iter().collect();
        for entry in next.iter_mut() {
            entry.1 += earlier.get(&entry.0).copied().unwrap_or(0.0);
        }
        if next.is_empty() {
            return Ok(Vec::new());
        }
        scores = Some(next);
    }
    let mut matches = Vec::new();
    for (position, score) in scores.unwrap_or_default() {
        let text = &index.lowered[position];
        let body = jsjson::to_utf16(bodies[position]);
        let exact = index_of(text, &phrase16, 0);
        let aligned = text.len() == body.len();
        let (start, end) = if let (Some(exact), true) = (exact, aligned) {
            (exact, exact + phrase16.len())
        } else if aligned {
            let word = jsjson::to_utf16(&first_word[&position]);
            word_start(text, &word).map_or((0, 0), |at| (at, at + word.len()))
        } else {
            (0, 0)
        };
        let (snippet, highlight) = snippet_around(&body, start, end);
        matches.push(Match {
            message: &messages[position],
            score: score
                + if exact.is_some() {
                    terms.len() as f64 * 4.0
                } else {
                    0.0
                },
            term: jsjson::from_utf16(&body[start..end]),
            snippet: jsjson::from_utf16(&snippet),
            highlight,
        });
    }
    let id = |message: &Value| {
        message
            .get("id")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    matches.sort_by(|a, b| {
        let by_score = b.score - a.score;
        let by_id = id(b.message) - id(a.message);
        let order = if by_score != 0.0 && !by_score.is_nan() {
            by_score
        } else {
            by_id
        };
        order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    matches.truncate(limit);
    Ok(matches)
}

/// chat-pages.cjs chatSearch: matches across the Chats that exist and aren't archived, as the daemon answers them.
pub fn chat_search(
    sessions: Option<&Map<String, Value>>,
    query: &str,
    limit: usize,
    all: &[Value],
) -> Result<Value> {
    let live = |message: &Value| {
        let key = jsjson::property_key(message.get("session_id"));
        sessions
            .and_then(|sessions| sessions.get(&key))
            .is_some_and(|session| {
                jsjson::truthy(Some(session)) && !jsjson::truthy(session.get("archived"))
            })
    };
    let messages: Vec<Value> = all
        .iter()
        .filter(|message| live(message))
        .cloned()
        .collect();
    let found = search_messages(&messages, query, limit)?;
    Ok(Value::Array(
        found
            .into_iter()
            .map(|item| {
                let mut message = Map::new();
                for key in ["id", "session_id"] {
                    if let Some(value) = item.message.get(key) {
                        message.insert(key.into(), value.clone());
                    }
                }
                let mut out = Map::new();
                out.insert("message".into(), Value::Object(message));
                out.insert("score".into(), jsjson::number(item.score));
                out.insert("snippet".into(), Value::String(item.snippet));
                out.insert("highlight".into(), serde_json::json!(item.highlight));
                out.insert("term".into(), Value::String(item.term));
                Value::Object(out)
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_matches_the_javascript() {
        let u = |text: &str| jsjson::to_utf16(text);
        assert_eq!(edit_distance(&u("parser"), &u("parsre"), 1, false), Some(1));
        assert_eq!(edit_distance(&u("parsr"), &u("parserx"), 1, true), Some(1));
        assert_eq!(edit_distance(&u("abc"), &u("xyz"), 1, false), None);
    }
}
