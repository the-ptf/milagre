//! Native headless rendering behind a bounded, killable process. The helper
//! consumes only generated SVG and bundled fonts; it has no external resolver.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use resvg::{
    tiny_skia,
    usvg::{self, TreeParsing, TreeTextToPath},
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};

const MAX_INPUT: usize = 4 * 1024 * 1024;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;
const MAX_EDGE: f64 = 1568.0;
const MAX_IMAGE_EDGE: u32 = 4096;
const MAX_DECODE_PIXELS: u64 = 64 * 1024 * 1024;

/// The renderer executable is a trusted packaged path, never a renderer request.
/// Each process handles one request and exits, releasing all native image memory.
pub struct RasterRenderer {
    helper: PathBuf,
    lane: Semaphore,
    pending: Semaphore,
    deadline: Duration,
}
impl RasterRenderer {
    pub fn new(helper: impl AsRef<Path>) -> Result<Self> {
        if !helper.as_ref().is_absolute() {
            return Err(Error::new(
                "The Design renderer helper path must be absolute.",
            ));
        }
        Ok(Self {
            helper: helper.as_ref().to_owned(),
            lane: Semaphore::new(1),
            pending: Semaphore::new(16),
            deadline: Duration::from_secs(10),
        })
    }
    /// Shorter deadlines support tests and a stricter owner budget; never lengthen the production limit.
    pub fn with_timeout(mut self, deadline: Duration) -> Result<Self> {
        if deadline.is_zero() || deadline > Duration::from_secs(10) {
            return Err(Error::new("Invalid Design renderer deadline."));
        }
        self.deadline = deadline;
        Ok(self)
    }
    pub async fn render(&self, document: &Value, crop: Option<&Value>) -> Result<Value> {
        let mut request = json!({"document":document});
        if let Some(crop) = crop {
            request["crop"] = crop.clone();
        }
        self.run(request).await
    }
    pub async fn resize(&self, src: &str, width: u32, height: u32) -> Result<String> {
        let result = self
            .run(json!({"image":{"src":src,"width":width,"height":height}}))
            .await?;
        Ok(format!(
            "data:image/png;base64,{}",
            result["base64"]
                .as_str()
                .ok_or_else(|| Error::new("Invalid Design renderer reply."))?
        ))
    }
    async fn run(&self, request: Value) -> Result<Value> {
        let _pending = self
            .pending
            .try_acquire()
            .map_err(|_| Error::coded("RENDER_BUSY", "The Design renderer queue is full."))?;
        let input = jsjson::to_string(&request);
        if input.len() > MAX_INPUT {
            return Err(Error::coded(
                "RENDER_TOO_LARGE",
                "Design renderer input is too large.",
            ));
        }
        let _lane = self
            .lane
            .acquire()
            .await
            .map_err(|_| Error::new("The design renderer stopped."))?;
        let mut child = tokio::process::Command::new(&self.helper)
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| {
                Error::coded(
                    "RENDER_UNAVAILABLE",
                    "The Design renderer helper could not start.",
                )
            })?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let work = async {
            let write = async {
                stdin.write_all(input.as_bytes()).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            };
            let read = read_bounded(stdout, MAX_OUTPUT);
            let wait = child.wait();
            let (_, output, status) = tokio::try_join!(write, read, wait)
                .map_err(|_| Error::new("The design renderer stopped."))?;
            if !status.success() {
                return Err(Error::new("The design renderer stopped."));
            }
            let result = jsjson::parse_bytes(&output)
                .map_err(|_| Error::new("Invalid Design renderer reply."))?;
            if let Some(message) = result.get("error").and_then(Value::as_str) {
                return Err(Error::new(message));
            }
            let value = result
                .get("result")
                .ok_or_else(|| Error::new("Invalid Design renderer reply."))?;
            if value["mime"] != "image/png" || !value["base64"].is_string() {
                return Err(Error::new("Invalid Design renderer reply."));
            }
            Ok(value.clone())
        };
        match tokio::time::timeout(self.deadline, work).await {
            Ok(result) => {
                if result.is_err() {
                    let _ = child.kill().await;
                }
                result
            }
            Err(_) => {
                let _ = child.kill().await;
                Err(Error::new("Rendering took too long"))
            }
        }
    }
}
async fn read_bounded(reader: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(std::io::Error::other("Render output exceeded limit"));
    }
    Ok(bytes)
}

/// Header inspection only; never decodes attacker-sized pixels.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let be32 = |at| {
        bytes
            .get(at..at + 4)
            .map(|s| u32::from_be_bytes(s.try_into().unwrap()))
    };
    let le16 = |at| {
        bytes
            .get(at..at + 2)
            .map(|s| u16::from_le_bytes(s.try_into().unwrap()) as u32)
    };
    let be16 = |at| {
        bytes
            .get(at..at + 2)
            .map(|s| u16::from_be_bytes(s.try_into().unwrap()) as u32)
    };
    if bytes.len() >= 24 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47] && &bytes[12..16] == b"IHDR" {
        return Some((be32(16)?, be32(20)?));
    }
    if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return match &bytes[12..16] {
            b"VP8X" => Some((
                1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]),
                1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]),
            )),
            b"VP8 " => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes[21..25].try_into().unwrap());
                Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
            }
            _ => None,
        };
    }
    if bytes.len() >= 10 && &bytes[..3] == b"GIF" {
        return Some((le16(6)?, le16(8)?));
    }
    if bytes.len() >= 4 && bytes[..2] == [0xff, 0xd8] {
        let mut at = 2;
        while at + 9 < bytes.len() {
            if bytes[at] != 0xff {
                return None;
            }
            let marker = bytes[at + 1];
            if marker == 0xff {
                at += 1;
                continue;
            }
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                return Some((be16(at + 7)?, be16(at + 5)?));
            }
            at += 2 + be16(at + 2)? as usize;
        }
    }
    None
}
fn source_bytes(src: &str) -> Option<Vec<u8>> {
    let data = src.split_once(',')?.1;
    STANDARD.decode(data).ok()
}
fn raster_document(document: &Value) -> Result<Value> {
    let mut document = document.clone();
    let mut pixels = 0u64;
    for node in document["nodes"].as_array_mut().unwrap() {
        if node["type"] != "image" {
            continue;
        }
        let Some(src) = node["src"].as_str() else {
            continue;
        };
        let keep = src.starts_with("data:")
            && !source_bytes(src)
                .and_then(|b| image_size(&b))
                .is_some_and(|(w, h)| w > MAX_IMAGE_EDGE || h > MAX_IMAGE_EDGE);
        if !keep {
            remove(node, "src");
            remove(node, "fill");
        } else if let Some((w, h)) = source_bytes(src).and_then(|b| image_size(&b)) {
            pixels = pixels.saturating_add(u64::from(w) * u64::from(h));
            if pixels > MAX_DECODE_PIXELS {
                return Err(Error::coded(
                    "RENDER_TOO_LARGE",
                    "Design images exceed the decoded pixel budget.",
                ));
            }
        }
    }
    Ok(document)
}
fn fonts(document: &Value) -> Result<usvg::fontdb::Database> {
    let mut database = usvg::fontdb::Database::new();
    let data = layout::data();
    for weight in data["interWeights"].as_array().unwrap() {
        let bytes = data["inter"][jsjson::to_string(weight)].as_str().unwrap();
        database.load_font_data(
            STANDARD
                .decode(bytes)
                .map_err(|_| Error::new("Invalid bundled Design font."))?,
        );
    }
    let mut loaded = BTreeSet::new();
    for node in nodes(document)
        .iter()
        .filter(|node| node["type"] == "text" && !yes(node, "hidden"))
    {
        if layout::inter(node) {
            continue;
        }
        let Some(entry) = layout::catalog(node) else {
            continue;
        };
        let weights = entry["weights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_f64().unwrap())
            .collect::<Vec<_>>();
        let weight = layout::nearest(&weights, layout::number(node, "fontWeight", 400.0));
        let key = jsjson::to_string(&json!(weight));
        if loaded.insert(format!("{}:{key}", entry["family"])) {
            database.load_font_data(
                STANDARD
                    .decode(entry["faces"][key].as_str().unwrap())
                    .map_err(|_| Error::new("Invalid bundled Design font."))?,
            );
        }
    }
    database.set_serif_family("Inter");
    database.set_sans_serif_family("Inter");
    database.set_cursive_family("Inter");
    database.set_fantasy_family("Inter");
    database.set_monospace_family("Inter");
    Ok(database)
}
fn draw(svg: &str, database: &usvg::fontdb::Database, scale: f64) -> Result<tiny_skia::Pixmap> {
    let mut options = usvg::Options {
        font_family: "Inter".into(),
        ..Default::default()
    };
    // No local-file or URL lookup. Inline raster bytes are resolved in memory.
    options.image_href_resolver.resolve_string = Arc::new(|_, _| None);
    let mut tree = usvg::Tree::from_str(svg, &options)
        .map_err(|_| Error::new("The Design SVG could not be read."))?;
    tree.convert_text(database);
    let width = (tree.size.width() * scale as f32).round().max(0.0) as u32;
    let height = (tree.size.height() * scale as f32).round().max(0.0) as u32;
    if width == 0 || height == 0 || width > 3840 || height > 3840 {
        return Err(Error::new("Invalid Design raster dimensions."));
    }
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| Error::new("The Design raster could not be allocated."))?;
    let transform = tiny_skia::Transform::from_scale(
        width as f32 / tree.size.width(),
        height as f32 / tree.size.height(),
    );
    resvg::Tree::from_usvg(&tree).render(transform, &mut pixmap.as_mut());
    Ok(pixmap)
}
fn png(pixmap: tiny_skia::Pixmap, dimensions: bool) -> Result<Value> {
    let mut result = json!({"mime":"image/png","base64":STANDARD.encode(pixmap.encode_png().map_err(|_|Error::new("The Design PNG could not be encoded."))?)});
    if dimensions {
        result["width"] = json!(pixmap.width());
        result["height"] = json!(pixmap.height());
    }
    Ok(result)
}
/// Helper-only entry point. This synchronous function must never run on the owner
/// thread. Public callers use RasterRenderer so timeouts can terminate it.
#[doc(hidden)]
pub fn helper_request(request: &Value) -> Result<Value> {
    if let Some(image) = request.get("image") {
        let src = image["src"]
            .as_str()
            .ok_or_else(|| Error::new("The image size could not be read."))?;
        if !src.starts_with("data:image/")
            || !src
                .split_once(',')
                .is_some_and(|(head, _)| head.ends_with(";base64"))
        {
            return Err(Error::new("The image size could not be read."));
        }
        let (w, h) = source_bytes(src)
            .and_then(|b| image_size(&b))
            .ok_or_else(|| Error::new("The image size could not be read."))?;
        if w > MAX_IMAGE_EDGE * 2 || h > MAX_IMAGE_EDGE * 2 {
            return Err(Error::new("The image is too large to decode."));
        }
        let width = image["width"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 3840)
            .ok_or_else(|| Error::new("Invalid Design raster dimensions."))?;
        let height = image["height"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 3840)
            .ok_or_else(|| Error::new("Invalid Design raster dimensions."))?;
        let svg=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\"><image width=\"{width}\" height=\"{height}\" preserveAspectRatio=\"none\" href=\"{}\"/></svg>",render::escape(src));
        return png(draw(&svg, &usvg::fontdb::Database::new(), 1.0)?, false);
    }
    let document = validate_document(&request["document"])?;
    let document = raster_document(&document)?;
    let crop = request.get("crop").filter(|c| !c.is_null());
    let dimensions = if let Some(crop) = crop {
        let get = |key| {
            crop[key]
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| Error::new("Invalid preview crop."))
        };
        let (x, y, w, h) = (get("x")?, get("y")?, get("width")?, get("height")?);
        if w <= 0.0 || h <= 0.0 {
            return Err(Error::new("Invalid preview crop."));
        }
        Some((x, y, w, h))
    } else {
        None
    };
    let (width, height) = dimensions.map(|(_, _, w, h)| (w, h)).unwrap_or((
        document["width"].as_f64().unwrap(),
        document["height"].as_f64().unwrap(),
    ));
    let scale = (MAX_EDGE / width.max(height)).min(1.0);
    let svg = render_svg(&document, &json!({"embedFonts":false,"onCanvasOnly":true}))?;
    let image = draw(
        &svg,
        &fonts(&document)?,
        if dimensions.is_some() { 1.0 } else { scale },
    )?;
    if let Some((x, y, w, h)) = dimensions {
        let bytes = STANDARD.encode(
            image
                .encode_png()
                .map_err(|_| Error::new("The Design PNG could not be encoded."))?,
        );
        let svg=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"{x} {y} {w} {h}\"><image width=\"{}\" height=\"{}\" href=\"data:image/png;base64,{bytes}\"/></svg>",document["width"],document["height"]);
        return png(draw(&svg, &usvg::fontdb::Database::new(), scale)?, true);
    }
    png(image, true)
}

#[doc(hidden)]
pub fn helper_main() -> Result<()> {
    use std::io::{Read, Write};
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT as u64 + 1)
        .read_to_end(&mut input)?;
    if input.len() > MAX_INPUT {
        return Err(Error::new("Design renderer input is too large."));
    }
    let result = match jsjson::parse_bytes(&input)
        .map_err(|_| Error::new("Invalid Design renderer input."))
        .and_then(|r| helper_request(&r))
    {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error.message}),
    };
    let output = jsjson::to_string(&result);
    if output.len() > MAX_OUTPUT {
        return Err(Error::new("Design renderer output is too large."));
    }
    std::io::stdout().write_all(output.as_bytes())?;
    Ok(())
}
