//! Sandboxed artifact documents and read-only media protocols for the production renderer.
//! No protocol request receives a filesystem write or a Tauri command capability.
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{
    http::{Request, Response},
    Manager,
};

const PREFIX: &str = "milagre-artifact://preview/";
const MAX_HTML: usize = 8 * 1024 * 1024;
const MAX_PREVIEWS: usize = 64 * 1024 * 1024;
const MAX_RESPONSE: u64 = 256 * 1024 * 1024;
// A player can continue requesting subsequent ranges without buffering an entire movie.
const RANGE_CHUNK: u64 = 8 * 1024 * 1024;
const MAX_ASSET: u64 = 95 * 1024 * 1024;

type Reply = Result<Value, Value>;
type BytesResponse = Response<Vec<u8>>;
#[derive(Clone)]
struct Asset {
    name: String,
    hash: String,
    size: u64,
    mime: String,
}
#[derive(Clone)]
struct Preview {
    body: Arc<Vec<u8>>,
    policy: String,
    chat: Option<String>,
    assets: HashMap<String, Asset>,
}
#[derive(Default)]
struct Previews {
    entries: HashMap<String, Preview>,
    bytes: usize,
}
#[derive(Default)]
struct ContentState(Mutex<Previews>);
fn failure(message: &str) -> Value {
    json!({"code":"CONTENT_ERROR","message":message})
}
fn support() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../generated/content-support.json"))
            .expect("generated artifact support")
    })
}
fn asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn asset_from(value: &Value) -> Option<Asset> {
    let name = value["name"].as_str()?;
    let hash = value["hash"].as_str()?;
    let size = value["size"].as_u64()?;
    let mime = value["type"].as_str()?;
    if !asset_name(name)
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || size > MAX_ASSET
        || mime.len() > 160
        || mime.is_empty()
        || !mime.bytes().all(|byte| (32..=126).contains(&byte))
    {
        return None;
    }
    Some(Asset {
        name: name.into(),
        hash: hash.into(),
        size,
        mime: mime.into(),
    })
}
fn random_id() -> Result<String, Value> {
    let mut data = [0u8; 24];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut data))
        .map_err(|_| failure("Could not allocate a secure preview address"))?;
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}
/// Rewrite only whole assets/<name> references, matching the shared production rule.
fn rewrite_asset(html: &str, name: &str, target: &str) -> String {
    let needle = format!("assets/{name}");
    let mut out = String::with_capacity(html.len());
    let mut from = 0;
    for (start, _) in html.match_indices(&needle) {
        let at = if start >= 2 && &html.as_bytes()[start - 2..start] == b"./" {
            start - 2
        } else {
            start
        };
        let end = start + needle.len();
        let before = html[..at].bytes().next_back();
        let after = html[end..].bytes().next();
        let name_char = |b: u8| b.is_ascii_alphanumeric() || b"._-".contains(&b);
        if before.is_some_and(|b| name_char(b) || b == b'/') || after.is_some_and(name_char) {
            continue;
        }
        out.push_str(&html[from..at]);
        out.push_str(target);
        from = end;
    }
    out.push_str(&html[from..]);
    out
}
fn document(html: &str, inline: bool) -> (String, String) {
    let data = support();
    let mut prefix = data[if inline { "inline" } else { "page" }]
        .as_str()
        .unwrap()
        .to_owned();
    // Generated prefixes use standards mode; discard only the input's leading doctype.
    static DOCTYPE: OnceLock<Regex> = OnceLock::new();
    let re =
        DOCTYPE.get_or_init(|| Regex::new(r"(?is)^(?:\s|<!--.*?-->)*<!doctype[^>]*>").unwrap());
    let body = re.find(html).map_or(html, |m| &html[m.end()..]);
    if !inline {
        static DIAGRAM: OnceLock<Regex> = OnceLock::new();
        let diagram = DIAGRAM.get_or_init(|| {
            Regex::new(r#"(?i)\sclass\s*=\s*["']?[^"'>]*\b(?:mermaid|language-mermaid)\b"#).unwrap()
        });
        if diagram.is_match(html) {
            prefix.push_str("<script>");
            prefix.push_str(data["diagrams"].as_str().unwrap());
            prefix.push_str("</script>");
        }
    }
    prefix.push_str(body);
    (
        prefix,
        data[if inline { "inlinePolicy" } else { "policy" }]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}
/// Called only from the main app's privileged native command adapter.
pub fn invoke(app: &tauri::AppHandle, method: &str, args: &Value) -> Option<Reply> {
    match method {
        "artifact-preview:register" => Some(register(app, args)),
        "artifact-preview:release" => Some((|| {
            let url = args[0]
                .as_str()
                .ok_or_else(|| failure("Expected a preview address"))?;
            let state = app.state::<ContentState>();
            let mut state = state
                .0
                .lock()
                .map_err(|_| failure("Preview store unavailable"))?;
            if let Some(old) = state.entries.remove(url) {
                state.bytes -= old.body.len();
            }
            Ok(Value::Null)
        })()),
        _ => None,
    }
}
fn register(app: &tauri::AppHandle, args: &Value) -> Reply {
    let html = args[0]
        .as_str()
        .ok_or_else(|| failure("Expected artifact HTML"))?;
    if html.len() > MAX_HTML {
        return Err(failure("Artifact preview is too large"));
    }
    let source = &args[1];
    let url = format!("{PREFIX}{}", random_id()?);
    let chat = source["chatId"].as_str().map(str::to_owned);
    let assets: HashMap<_, _> = source["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(100)
                .filter_map(asset_from)
                .map(|a| (a.name.clone(), a))
                .collect()
        })
        .unwrap_or_default();
    let mut page = html.to_owned();
    if chat.is_some() {
        for asset in assets.values() {
            page = rewrite_asset(&page, &asset.name, &format!("{url}/assets/{}", asset.name));
        }
    }
    let (body, policy) = document(&page, source["inline"].as_bool() == Some(true));
    let state = app.state::<ContentState>();
    let mut state = state
        .0
        .lock()
        .map_err(|_| failure("Preview store unavailable"))?;
    if body.len() + state.bytes > MAX_PREVIEWS || state.entries.len() >= 128 {
        return Err(failure("Too many artifact previews are open"));
    }
    state.bytes += body.len();
    state.entries.insert(
        url.clone(),
        Preview {
            body: Arc::new(body.into_bytes()),
            policy,
            chat,
            assets,
        },
    );
    Ok(Value::String(url))
}
fn reply(status: u16, mime: &str, body: Vec<u8>, policy: &str) -> BytesResponse {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", policy)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap()
}
fn missing() -> BytesResponse {
    reply(
        404,
        "text/plain",
        b"Not found".to_vec(),
        "default-src 'none'; sandbox",
    )
}
fn range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    let raw = header.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = raw.split_once('-').ok_or(())?;
    if a.is_empty() {
        let length = b.parse::<u64>().map_err(|_| ())?.min(size);
        return if length == 0 {
            Err(())
        } else {
            Ok(Some((size - length, length)))
        };
    }
    let start = a.parse::<u64>().map_err(|_| ())?;
    let end = if b.is_empty() {
        size.saturating_sub(1)
    } else {
        b.parse::<u64>()
            .map_err(|_| ())?
            .min(size.saturating_sub(1))
    };
    if start >= size || end < start {
        Err(())
    } else {
        Ok(Some((start, end - start + 1)))
    }
}
fn bounded_range(chosen: Option<(u64, u64)>) -> Option<(u64, u64)> {
    chosen.map(|(offset, length)| (offset, length.min(RANGE_CHUNK)))
}
fn unsatisfiable(size: u64) -> BytesResponse {
    let mut r = reply(416, "text/plain", Vec::new(), "default-src 'none'; sandbox");
    r.headers_mut()
        .insert("Content-Range", format!("bytes */{size}").parse().unwrap());
    r
}
fn ranged_response(
    mime: &str,
    bytes: Vec<u8>,
    size: u64,
    chosen: Option<(u64, u64)>,
) -> BytesResponse {
    let len = bytes.len();
    let mut response = reply(
        if chosen.is_some() { 206 } else { 200 },
        mime,
        bytes,
        "default-src 'none'; sandbox",
    );
    response
        .headers_mut()
        .insert("Accept-Ranges", "bytes".parse().unwrap());
    response
        .headers_mut()
        .insert("Content-Length", len.to_string().parse().unwrap());
    if let Some((start, length)) = chosen {
        response.headers_mut().insert(
            "Content-Range",
            format!("bytes {start}-{}/{size}", start + length - 1)
                .parse()
                .unwrap(),
        );
    }
    response
}
fn remote_chat(chat: &str) -> Option<(String, String)> {
    let (prefix, rest) = if let Some(rest) = chat.strip_prefix("milagre-link:") {
        ("milagre-link:", rest)
    } else {
        ("", chat)
    };
    let (computer, bare) = rest.split_once('|')?;
    if computer == "local"
        || computer.is_empty()
        || computer.len() > 64
        || !computer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some((computer.to_owned(), format!("{prefix}{bare}")))
}
async fn artifact(app: tauri::AppHandle, request: Request<Vec<u8>>) -> BytesResponse {
    if request.method() != "GET" {
        return missing();
    }
    let url = request.uri().to_string();
    let (base, name) = url
        .split_once("/assets/")
        .map_or((url.as_str(), None), |(a, b)| (a, Some(b)));
    let entry = {
        let state = app.state::<ContentState>();
        let Ok(state) = state.0.lock() else {
            return missing();
        };
        state.entries.get(base).cloned()
    };
    let Some(entry) = entry else { return missing() };
    let Some(name) = name else {
        return reply(
            200,
            "text/html; charset=utf-8",
            entry.body.as_ref().clone(),
            &format!("{}; sandbox allow-scripts", entry.policy),
        );
    };
    let Some(asset) = entry.assets.get(name) else {
        return missing();
    };
    let Some(chat) = entry.chat else {
        return missing();
    };
    let chosen = match range(
        request.headers().get("range").and_then(|h| h.to_str().ok()),
        asset.size,
    ) {
        Ok(r) => bounded_range(r),
        Err(()) => return unsatisfiable(asset.size),
    };
    let (offset, length) = chosen.unwrap_or((0, asset.size));
    let transport = app.state::<crate::transport::Transport>().inner().clone();
    let mut bytes = Vec::with_capacity(length as usize);
    while (bytes.len() as u64) < length {
        let request = json!({"chatId":remote_chat(&chat).map_or(chat.clone(),|(_,bare)|bare),"name":asset.name,"offset":offset+bytes.len() as u64,"length":(length-bytes.len() as u64).min(1024*1024)});
        let (method, args) = if let Some((computer, _)) = remote_chat(&chat) {
            (
                "computers:invoke",
                json!([computer, "artifact:asset", [request]]),
            )
        } else {
            ("artifact:asset", json!([request]))
        };
        let Ok(part) = transport.call(method.into(), args).await else {
            return missing();
        };
        if part["hash"].as_str() != Some(&asset.hash) {
            return missing();
        }
        let Ok(chunk) = STANDARD.decode(part["base64"].as_str().unwrap_or("")) else {
            return missing();
        };
        if chunk.is_empty() || chunk.len() as u64 > length - bytes.len() as u64 {
            return missing();
        }
        bytes.extend(chunk);
    }
    ranged_response(&asset.mime, bytes, asset.size, chosen)
}
fn media_type(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "mp4" | "m4v" => "video/mp4",
            "mov" => "video/quicktime",
            "webm" => "video/webm",
            "ogv" => "video/ogg",
            _ => return None,
        },
    )
}
fn media(request: Request<Vec<u8>>) -> BytesResponse {
    if request.method() != "GET" {
        return missing();
    }
    let Ok(url) = tauri::Url::parse(&request.uri().to_string()) else {
        return missing();
    };
    if url.scheme() != "milagre-media" || url.host_str() != Some("file") || url.path() != "/" {
        return missing();
    }
    let Some((_, file)) = url.query_pairs().find(|(key, _)| key == "path") else {
        return missing();
    };
    let path = Path::new(file.as_ref());
    if !path.is_absolute() || media_type(path).is_none() {
        return missing();
    }
    let Ok(path) = path.canonicalize() else {
        return missing();
    };
    let Some(mime) = media_type(&path) else {
        return missing();
    };
    let Ok(mut file) = File::open(path) else {
        return missing();
    };
    let Ok(meta) = file.metadata() else {
        return missing();
    };
    if !meta.is_file() {
        return missing();
    }
    let size = meta.len();
    let chosen = match range(
        request.headers().get("range").and_then(|h| h.to_str().ok()),
        size,
    ) {
        Ok(r) => bounded_range(r),
        Err(()) => return unsatisfiable(size),
    };
    let (offset, length) = chosen.unwrap_or((0, size));
    if length > MAX_RESPONSE {
        return reply(
            413,
            "text/plain",
            b"Media range too large".to_vec(),
            "default-src 'none'; sandbox",
        );
    }
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return missing();
    }
    let mut bytes = Vec::with_capacity(length as usize);
    if file.take(length).read_to_end(&mut bytes).is_err() || bytes.len() as u64 != length {
        return missing();
    }
    ranged_response(mime, bytes, size, chosen)
}
/// Release the previous renderer document's capability URLs when the main app reloads.
/// Call for the trusted main document only, never for Artifact child navigation.
pub fn clear_previews(app: &tauri::AppHandle) {
    let state = app.state::<ContentState>();
    if let Ok(mut state) = state.0.lock() {
        *state = Previews::default();
    };
}
pub fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(ContentState::default())
        .register_asynchronous_uri_scheme_protocol(
            "milagre-artifact",
            |context, request, responder| {
                let app = context.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(artifact(app, request).await)
                });
            },
        )
        .register_asynchronous_uri_scheme_protocol("milagre-media", |_, request, responder| {
            std::thread::spawn(move || responder.respond(media(request)));
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_reject_overflow_and_handle_suffixes() {
        assert_eq!(range(Some("bytes=2-5"), 10), Ok(Some((2, 4))));
        assert_eq!(range(Some("bytes=-3"), 10), Ok(Some((7, 3))));
        assert_eq!(range(Some("bytes=8-100"), 10), Ok(Some((8, 2))));
        assert!(range(Some("bytes=10-"), 10).is_err());
        assert!(range(Some("bytes=18446744073709551616-"), 10).is_err());
        assert!(range(Some("bytes=1-2,4-5"), 10).is_err());
        assert!(range(Some("bytes=-0"), 10).is_err());
    }
    #[test]
    fn only_whole_asset_references_rewrite() {
        assert_eq!(
            rewrite_asset(
                "assets/a.png ./assets/a.png x/assets/a.png assets/a.png.bak",
                "a.png",
                "URL"
            ),
            "URL URL x/assets/a.png assets/a.png.bak"
        );
        assert_eq!(rewrite_asset("€assets/a.png", "a.png", "URL"), "€URL");
        assert!(!asset_name("../secret"));
        assert!(!asset_name("a/b"));
        assert!(asset_name("photo-1.png"));
        assert!(asset_from(
            &json!({"name":"a.png","hash":"a".repeat(64),"size":1,"type":"image/png\u{0000}"})
        )
        .is_none());
    }
    #[test]
    fn documents_keep_production_helpers_and_sandbox_policy() {
        let (doc, policy) = document("<!DOCTYPE html><h1>Hello</h1>", false);
        assert_eq!(doc.matches("<!doctype html>").count(), 1);
        assert!(doc.contains("milagre:artifact-page"));
        assert!(doc.contains("<h1>Hello</h1>"));
        assert!(policy.contains("script-src 'unsafe-inline'"));
        assert!(!policy.contains("connect-src"));
        assert!(doc.find("Content-Security-Policy").unwrap() < doc.find("<h1>").unwrap());
    }
    #[test]
    fn media_range_response_and_resolved_extension_checks() {
        let dir =
            std::env::temp_dir().join(format!("milagre-content-test-{}", random_id().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let image = dir.join("sample.png");
        let secret = dir.join("private.txt");
        let link = dir.join("linked.png");
        std::fs::write(&image, b"0123456789").unwrap();
        std::fs::write(&secret, b"private").unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let request = |path: &Path, method: &str, range: &str| {
            let mut url = tauri::Url::parse("milagre-media://file/").unwrap();
            url.query_pairs_mut()
                .append_pair("path", path.to_str().unwrap());
            Request::builder()
                .method(method)
                .uri(url.as_str())
                .header("range", range)
                .body(Vec::new())
                .unwrap()
        };
        let response = media(request(&image, "GET", "bytes=2-5"));
        assert_eq!(response.status(), 206);
        assert_eq!(response.body(), b"2345");
        assert_eq!(response.headers()["Content-Range"], "bytes 2-5/10");
        assert!(response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("sandbox"));
        assert_eq!(media(request(&link, "GET", "bytes=0-")).status(), 404);
        assert_eq!(media(request(&image, "POST", "bytes=0-")).status(), 404);
        assert_eq!(media(request(&image, "GET", "bytes=100-")).status(), 416);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn large_open_ended_movie_ranges_return_bounded_206_chunks() {
        let file_path =
            std::env::temp_dir().join(format!("milagre-range-{}.mp4", random_id().unwrap()));
        let file = File::create(&file_path).unwrap();
        let size = MAX_RESPONSE + RANGE_CHUNK;
        file.set_len(size).unwrap();
        let mut url = tauri::Url::parse("milagre-media://file/").unwrap();
        url.query_pairs_mut()
            .append_pair("path", file_path.to_str().unwrap());
        let request = |range: &str| {
            Request::builder()
                .uri(url.as_str())
                .header("range", range)
                .body(Vec::new())
                .unwrap()
        };
        let first = media(request("bytes=0-"));
        assert_eq!(first.status(), 206);
        assert_eq!(first.body().len(), RANGE_CHUNK as usize);
        assert_eq!(
            first.headers()["Content-Range"],
            format!("bytes 0-{}/{size}", RANGE_CHUNK - 1)
        );
        assert!(!first.headers().contains_key("Access-Control-Allow-Origin"));
        let last = media(request(&format!("bytes={}-", size - 4)));
        assert_eq!(last.status(), 206);
        assert_eq!(last.body().len(), 4);
        assert_eq!(
            last.headers()["Content-Range"],
            format!("bytes {}-{}/{size}", size - 4, size - 1)
        );
        std::fs::remove_file(file_path).unwrap();
    }
    #[test]
    fn chat_qualifiers_preserve_link_scopes() {
        assert_eq!(
            remote_chat("computer-1|/repo#3"),
            Some(("computer-1".into(), "/repo#3".into()))
        );
        assert_eq!(
            remote_chat("milagre-link:computer-1|abc#3"),
            Some(("computer-1".into(), "milagre-link:abc#3".into()))
        );
        assert_eq!(remote_chat("/repo#3"), None);
    }
}
