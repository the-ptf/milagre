//! The `milagre-artifact` protocol, ported from `apps/desktop/electron/artifact-preview.cjs`.
//!
//! Each page shown is registered under an unguessable address, `milagre-artifact://preview/<48 hex>`, that serves the
//! page as a document ([`super::document::artifact_document`]) under its content security policy, and its files at
//! `<address>/assets/<name>`, whole or by byte range, each under `default-src 'none'; sandbox` so a file never runs as
//! a page of its own. Anything else is a 404. The page's HTML says `assets/<name>`; registering rewrites those to the
//! address, as the desktop does (a relative `assets/` would resolve beside `preview/`, not under the page).
//!
//! The webview's scheme handler ([`crate::platform::webview::HostRequest`]) calls [`Previews::handle`]; the owner
//! registers a page when it shows one and releases it when it moves on.

use std::collections::HashMap;
use std::sync::Arc;

use super::document::{self, Range};
use crate::platform::webview::{HostRequest, HostResponse};

pub const SCHEME: &str = "milagre-artifact";
pub const PREFIX: &str = "milagre-artifact://preview/";
/// A page's files load from this source, so every preview's policy allows it.
pub const ASSET_SOURCE: &str = "milagre-artifact:";
/// One page's document at most.
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Every page registered at once at most, and how many.
pub const MAX_TOTAL: usize = 64 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 128;
/// The policy a file is served under.
pub const ASSET_CSP: &str = "default-src 'none'; sandbox";

/// A file of a page: its name on the page (`assets/<name>`), media type and bytes.
#[derive(Clone, Debug)]
pub struct Asset {
    pub name: String,
    pub mime: String,
    pub bytes: Arc<[u8]>,
}

impl Asset {
    pub fn new(name: &str, bytes: &'static [u8]) -> Self {
        Self { name: name.to_string(), mime: document::asset_type(name).to_string(), bytes: Arc::from(bytes) }
    }
}

struct Entry {
    owner: u64,
    body: Arc<[u8]>,
    policy: String,
    assets: HashMap<String, Asset>,
}

/// The pages registered, by address.
#[derive(Default)]
pub struct Previews {
    entries: HashMap<String, Entry>,
    bytes: usize,
}

/// Why a page could not be registered.
#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    TooLarge,
    TooMany,
}

impl std::fmt::Display for RegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RegisterError::TooLarge => "Artifact preview is too large.",
            RegisterError::TooMany => "Too many artifact previews are open.",
        })
    }
}

/// 24 random bytes as 48 hex digits: the address of one registered page.
pub fn random_token() -> String {
    let mut bytes = [0u8; 24];
    // The OS random source; only fails if the OS has none, and then the address stays all zeros (a fixture-only app).
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Previews {
    /// Registers `html` for `owner` and returns its address. `page` adds the helper (an Artifact page in the dock);
    /// without it the document is an inline reply's, under the plain policy.
    pub fn register(&mut self, owner: u64, html: &str, assets: &[Asset], page: bool, token: &str) -> Result<String, RegisterError> {
        if html.len() > MAX_BYTES {
            return Err(RegisterError::TooLarge);
        }
        let url = format!("{PREFIX}{token}");
        let assets: Vec<&Asset> = assets.iter().filter(|asset| document::valid_asset_name(&asset.name)).collect();
        let names: Vec<&str> = assets.iter().map(|asset| asset.name.as_str()).collect();
        let html = if names.is_empty() {
            html.to_string()
        } else {
            document::rewrite_asset_urls(html, &names, |name| format!("{url}/assets/{name}"))
        };
        let body = document::artifact_document(&html, page, if page { ASSET_SOURCE } else { "" });
        let policy = if page { document::artifact_csp(ASSET_SOURCE) } else { document::ARTIFACT_CSP.to_string() };
        if self.bytes + body.len() > MAX_TOTAL || self.entries.len() >= MAX_ENTRIES {
            return Err(RegisterError::TooMany);
        }
        self.bytes += body.len();
        let assets = assets.into_iter().map(|asset| (asset.name.clone(), asset.clone())).collect();
        self.entries.insert(url.clone(), Entry { owner, body: Arc::from(body.into_bytes()), policy, assets });
        Ok(url)
    }

    /// Forgets the page at `url`, when `owner` registered it.
    pub fn release(&mut self, owner: u64, url: &str) {
        if self.entries.get(url).is_some_and(|entry| entry.owner == owner)
            && let Some(entry) = self.entries.remove(url)
        {
            self.bytes -= entry.body.len();
        }
    }

    /// Forgets every page `owner` registered.
    pub fn clear(&mut self, owner: u64) {
        let urls: Vec<String> = self.entries.iter().filter(|(_, entry)| entry.owner == owner).map(|(url, _)| url.clone()).collect();
        for url in urls {
            self.release(owner, &url);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Answers one request of the webview.
    pub fn handle(&self, request: &HostRequest) -> HostResponse {
        if !request.method.eq_ignore_ascii_case("GET") {
            return not_found();
        }
        // The address without a query or a fragment, which a page may add to its own links.
        let url = request.url.split(['?', '#']).next().unwrap_or_default();
        let url = url.strip_suffix('/').unwrap_or(url);
        if let Some(entry) = self.entries.get(url) {
            return HostResponse {
                status: 200,
                headers: vec![
                    ("Content-Type", "text/html; charset=utf-8".into()),
                    ("Content-Security-Policy", entry.policy.clone()),
                    ("Cache-Control", "no-store".into()),
                    ("Referrer-Policy", "no-referrer".into()),
                    ("X-Content-Type-Options", "nosniff".into()),
                ],
                body: entry.body.to_vec(),
            };
        }
        let Some((page, name)) = url.split_once("/assets/") else { return not_found() };
        let Some(entry) = self.entries.get(page) else { return not_found() };
        let Some(asset) = entry.assets.get(&percent_decode(name)) else { return not_found() };
        file_response(asset, request.range)
    }
}

fn not_found() -> HostResponse {
    HostResponse { status: 404, headers: vec![("Content-Type", "text/plain".into())], body: b"Not found".to_vec() }
}

/// One file of a page, whole or by byte range.
fn file_response(asset: &Asset, range: Option<&str>) -> HostResponse {
    let size = asset.bytes.len();
    let mut headers = vec![
        ("Accept-Ranges", "bytes".to_string()),
        ("Cache-Control", "no-store".into()),
        ("Content-Security-Policy", ASSET_CSP.into()),
        ("X-Content-Type-Options", "nosniff".into()),
    ];
    let (status, offset, length) = match document::byte_range(range, size) {
        Range::Unsatisfiable => {
            headers.push(("Content-Range", format!("bytes */{size}")));
            return HostResponse { status: 416, headers, body: Vec::new() };
        }
        Range::Whole => (200, 0, size),
        Range::Part { offset, length } => {
            headers.push(("Content-Range", format!("bytes {offset}-{}/{size}", offset + length - 1)));
            (206, offset, length)
        }
    };
    headers.push(("Content-Type", asset.mime.clone()));
    headers.push(("Content-Length", length.to_string()));
    HostResponse { status, headers, body: asset.bytes[offset..offset + length].to_vec() }
}

/// `%XX` escapes in a file name (`decodeURIComponent` for the names `valid_asset_name` allows).
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((high * 16 + low) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
