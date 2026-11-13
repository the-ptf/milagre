//! Offline renderer: JSON source on stdin, fresh HTML on stdout. No file access.
use std::io::{Read, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 4 * 1024 * 1024 {
        return Err("Design input exceeds 4 MiB".into());
    }
    let document = milagre_owner_store::jsjson::parse_bytes(&input)?;
    let html = milagre_content_store::design::render_html(&document)?;
    std::io::stdout().write_all(html.as_bytes())?;
    Ok(())
}
