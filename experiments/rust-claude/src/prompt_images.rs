//! Pure Node `promptImageBlocks`/`prosePrompt` ordering over validated image bytes.
//! No path or filesystem input. The full expanded native frame is sized before any repeated
//! image block is materialized; a small prompt cannot allocate unbounded repeated base64.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

#[derive(Debug, Clone, Copy)]
pub struct PromptImage<'a> {
    mime: &'a str,
    bytes: &'a [u8],
}
impl<'a> PromptImage<'a> {
    pub fn new(mime: &'a str, bytes: &'a [u8]) -> Result<Self, &'static str> {
        let valid = match mime {
            "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
            "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        if !valid || bytes.len() > crate::images::MAX_IMAGE_BYTES {
            return Err("Invalid supported image bytes");
        }
        Ok(Self { mime, bytes })
    }
}
#[derive(Clone, Copy)]
enum Part<'a> {
    Text(&'a str),
    Image(usize),
}

/// First end of a code match at `start`, following Node's leftmost regex alternatives:
/// triple backticks, triple tildes, then a greedy run of inline backticks through its matching
/// closing run or line end. Only ASCII delimiters are inspected; original UTF-8 slices stay exact.
fn code_end(bytes: &[u8], start: usize) -> Option<usize> {
    let rest = &bytes[start..];
    if rest.starts_with(b"```") || rest.starts_with(b"~~~") {
        let fence = &rest[..3];
        return Some(rest[3..].windows(3).position(|part| part == fence).map_or(bytes.len(), |end| start + 3 + end + 3));
    }
    if rest.first() != Some(&b'`') {
        return None;
    }
    let count = rest.iter().take_while(|byte| **byte == b'`').count();
    let mut at = start + count;
    while at < bytes.len() && bytes[at] != b'\n' {
        if bytes[at] == b'`' {
            let run = bytes[at..].iter().take_while(|byte| **byte == b'`').count();
            if run >= count {
                return Some(at + run);
            }
            at += run;
        } else {
            at += 1;
        }
    }
    Some(at)
}
fn image_token(bytes: &[u8], start: usize, count: usize) -> Option<(usize, usize)> {
    let rest = &bytes[start..];
    if !rest.starts_with(b"[Image #") || !matches!(rest.get(8), Some(b'1'..=b'9')) {
        return None;
    }
    let digits = rest[8..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    if rest.get(8 + digits) != Some(&b']') {
        return None;
    }
    let index = std::str::from_utf8(&rest[8..8 + digits]).ok()?.parse::<u64>().ok()?;
    if index > 9_007_199_254_740_991 || index > count as u64 {
        return None;
    }
    Some((index as usize - 1, start + 9 + digits))
}
fn parts<'a>(prompt: &'a str, count: usize, mut emit: impl FnMut(Part<'a>) -> Result<(), &'static str>) -> Result<(), &'static str> {
    if count == 0 {
        return emit(Part::Text(prompt));
    }
    let mut referenced = vec![false; count];
    let bytes = prompt.as_bytes();
    let (mut at, mut end, mut matched) = (0, 0, false);
    while at < bytes.len() {
        if let Some(next) = code_end(bytes, at) {
            at = next;
            continue;
        }
        if let Some((index, next)) = image_token(bytes, at, count) {
            if at > end {
                emit(Part::Text(&prompt[end..at]))?;
            }
            emit(Part::Image(index))?;
            referenced[index] = true;
            matched = true;
            end = next;
            at = next;
        } else {
            at += 1;
        }
    }
    if !matched || end < prompt.len() {
        emit(Part::Text(&prompt[end..]))?;
    }
    for (index, seen) in referenced.into_iter().enumerate() {
        if !seen {
            emit(Part::Image(index))?;
        }
    }
    Ok(())
}
fn json_string_bytes(text: &str) -> usize {
    2 + text
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum::<usize>()
}
/// `limit` uses the transport's convention: serialized JSON bytes, excluding the final newline.
/// Image MIME is checked at construction; canonical base64 is produced from its bytes only.
/// The caller still owns its stricter incoming request/attachment budget.
pub fn validate_content(prompt: &str, images: &[PromptImage<'_>], limit: usize) -> Result<usize, &'static str> {
    const TOO_LARGE: &str = "Expanded image prompt exceeds the native frame budget";
    let empty = crate::protocol::user_message("00000000-0000-4000-8000-000000000000", vec![]);
    let mut frame_bytes = serde_json::to_vec(&empty).expect("fixed JSON").len();
    let image_sizes: Vec<_> = images
        .iter()
        .map(|image| {
            serde_json::to_vec(&crate::protocol::image_block(image.mime, "")).expect("fixed JSON").len() + image.bytes.len().div_ceil(3) * 4
        })
        .collect();
    let mut count = 0;
    parts(prompt, images.len(), |part| {
        let size = match part {
            Part::Text(text) => "{\"type\":\"text\",\"text\":".len() + json_string_bytes(text) + 1,
            Part::Image(index) => image_sizes[index],
        };
        frame_bytes = frame_bytes.checked_add(size).and_then(|size| size.checked_add(usize::from(count > 0))).ok_or(TOO_LARGE)?;
        if frame_bytes > limit {
            return Err(TOO_LARGE);
        }
        count += 1;
        Ok(())
    })?;
    Ok(count)
}

/// Materialize only after the bounded, pure preflight accepts the complete serialized frame.
pub fn user_content(prompt: &str, images: &[PromptImage<'_>], limit: usize) -> Result<Vec<Value>, &'static str> {
    let count = validate_content(prompt, images, limit)?;
    let encoded: Vec<_> = images.iter().map(|image| STANDARD.encode(image.bytes)).collect();
    let mut content = Vec::with_capacity(count);
    parts(prompt, images.len(), |part| {
        content.push(match part {
            Part::Text(text) => crate::protocol::text_block(text),
            Part::Image(index) => crate::protocol::image_block(images[index].mime, &encoded[index]),
        });
        Ok(())
    })?;
    Ok(content)
}
