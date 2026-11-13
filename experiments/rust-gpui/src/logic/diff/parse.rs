//! `diff-parse.ts`: one file's unified patch to hunks and numbered lines.

/// What a line did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Add,
    Remove,
}

/// One line of a hunk. `old_number` is set on context and removals, `new_number` on context and additions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    pub old_number: Option<u32>,
    pub new_number: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    /// The `@@ -a,b +c,d @@ ...` line, without its line ending.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

impl DiffHunk {
    /// Lines added and removed in this hunk.
    pub fn counts(&self) -> (u32, u32) {
        count_lines(&self.lines)
    }
}

/// Added and removed lines in a slice of lines. Not in the TS (the host sends the totals in `DiffFileEntry`); for
/// a view that shows a patch it has parsed itself.
pub fn count_lines(lines: &[DiffLine]) -> (u32, u32) {
    let added = lines.iter().filter(|l| l.kind == LineKind::Add).count();
    let removed = lines.iter().filter(|l| l.kind == LineKind::Remove).count();
    (added as u32, removed as u32)
}

/// Added and removed lines in all hunks.
pub fn count_hunks(hunks: &[DiffHunk]) -> (u32, u32) {
    hunks.iter().fold((0, 0), |(a, r), hunk| {
        let (ha, hr) = hunk.counts();
        (a + ha, r + hr)
    })
}

/// `\d+` as `Number(...)`; saturates instead of becoming a float.
fn digits(text: &str) -> Option<(u32, &str)> {
    let end = text.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let value = text[..end].bytes().fold(0u32, |acc, b| acc.saturating_mul(10).saturating_add(u32::from(b - b'0')));
    Some((value, &text[end..]))
}

/// `^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`: (old start, old count, new start, new count).
fn parse_header(row: &str) -> Option<(u32, Option<u32>, u32, Option<u32>)> {
    let rest = row.strip_prefix("@@ -")?;
    let (old_start, rest) = digits(rest)?;
    let (old_count, rest) = match rest.strip_prefix(',') {
        Some(after) => match digits(after) {
            Some((n, r)) => (Some(n), r),
            None => (None, rest),
        },
        None => (None, rest),
    };
    let rest = rest.strip_prefix(" +")?;
    let (new_start, rest) = digits(rest)?;
    let (new_count, rest) = match rest.strip_prefix(',') {
        Some(after) => match digits(after) {
            Some((n, r)) => (Some(n), r),
            None => (None, rest),
        },
        None => (None, rest),
    };
    rest.starts_with(" @@").then_some((old_start, old_count, new_start, new_count))
}

/// Parses one file's unified patch. File headers, binary notices and "\ No newline" markers are dropped.
///
/// Hunk lengths come from the header counts: a hunk is open while either count is left, so a removed line that reads
/// `-- x` is not mistaken for a `---` file header. Lines that do not fit the counts are dropped.
pub fn parse_patch(patch: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut old_number = 0u32;
    let mut new_number = 0u32;
    let mut old_left = 0u32;
    let mut new_left = 0u32;
    let mut rows: Vec<&str> = patch.split('\n').collect();
    // A trailing newline leaves one empty string that is not a line.
    if rows.last() == Some(&"") {
        rows.pop();
    }
    for raw in rows {
        let row = raw.strip_suffix('\r').unwrap_or(raw);
        let open = !hunks.is_empty() && (old_left > 0 || new_left > 0);
        if !open && let Some((old_start, old_count, new_start, new_count)) = parse_header(row) {
            old_number = old_start;
            new_number = new_start;
            old_left = old_count.unwrap_or(1);
            new_left = new_count.unwrap_or(1);
            hunks.push(DiffHunk {
                header: row.to_string(),
                old_start: old_number,
                old_lines: old_left,
                new_start: new_number,
                new_lines: new_left,
                lines: Vec::new(),
            });
            continue;
        }
        if !open || row.starts_with('\\') {
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        // Every marker that matters is ASCII, so slicing after it is on a character boundary.
        let marker = row.as_bytes().first().copied();
        let text = row.get(1..).unwrap_or("");
        if marker == Some(b'+') && new_left > 0 {
            hunk.lines.push(DiffLine { kind: LineKind::Add, text: text.to_string(), old_number: None, new_number: Some(new_number) });
            new_number += 1;
            new_left -= 1;
        } else if marker == Some(b'-') && old_left > 0 {
            hunk.lines.push(DiffLine { kind: LineKind::Remove, text: text.to_string(), old_number: Some(old_number), new_number: None });
            old_number += 1;
            old_left -= 1;
        } else if (marker == Some(b' ') || row.is_empty()) && old_left > 0 && new_left > 0 {
            // Some tools strip the single space of an empty context line.
            hunk.lines.push(DiffLine {
                kind: LineKind::Context,
                text: text.to_string(),
                old_number: Some(old_number),
                new_number: Some(new_number),
            });
            old_number += 1;
            new_number += 1;
            old_left -= 1;
            new_left -= 1;
        }
    }
    hunks
}
