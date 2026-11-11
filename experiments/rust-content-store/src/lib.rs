//! Node-compatible Artifact and Design source persistence in explicit isolated copies.
//! No production profile constructor or daemon registration is provided.
mod comments;
pub mod design;
pub mod error;
mod files;
mod validation;

pub use error::{Error, Result};
use files::Dir;
use milagre_owner_store::{isolation::MARKER, jsjson, Isolation};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use validation::*;

pub type Validator = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;
pub type ActiveCheck = Arc<dyn Fn() -> Result<()> + Send + Sync>;
pub trait Runtime: Send + Sync {
    fn now_ms(&self) -> u64;
    fn uuid(&self) -> String;
}
pub struct SystemRuntime;
impl Runtime for SystemRuntime {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    fn uuid(&self) -> String {
        milagre_owner_store::ownership::random_uuid()
    }
}

/// One serialized writer. The caller supplies the owner's existing-Chat validator
/// and active-ownership check; every commit rechecks that authority.
pub struct ArtifactStore {
    root: Dir,
    path: PathBuf,
    isolation: Isolation,
    _lock: File,
    validate: Validator,
    active: ActiveCheck,
    runtime: Arc<dyn Runtime>,
}
struct Staged {
    directory: Dir,
    name: String,
    metadata: Value,
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = self.directory.remove(&self.name);
    }
}

impl ArtifactStore {
    fn fresh_id(&self, short: bool) -> Result<String> {
        let uuid = self.runtime.uuid();
        validation::id(&json!(uuid))?;
        if uuid.len() != 36
            || uuid.bytes().enumerate().any(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte != b'-'
                } else {
                    !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte)
                }
            })
        {
            return Err(Error::new("The content runtime returned an invalid UUID."));
        }
        Ok(if short { uuid[..8].to_owned() } else { uuid })
    }
    pub fn open(
        isolation: Isolation,
        relative: &Path,
        validate: Validator,
        active: ActiveCheck,
        runtime: Arc<dyn Runtime>,
    ) -> Result<Self> {
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(Error::coded(
                "NOT_ISOLATED",
                "Use a relative Artifact directory inside the isolated copy.",
            ));
        }
        active()?;
        let mut root = Dir::open_absolute(isolation.root())?;
        root.open(MARKER)?;
        for part in relative.components() {
            let Component::Normal(part) = part else {
                unreachable!()
            };
            root = root.child(
                part.to_str()
                    .ok_or_else(|| Error::new("Artifact paths must be UTF-8."))?,
                true,
            )?;
        }
        let lock = root.lock()?;
        let path = isolation.root().join(relative);
        Ok(Self {
            root,
            path,
            isolation,
            _lock: lock,
            validate,
            active,
            runtime,
        })
    }
    fn chat(&self, request: &Value, create: bool) -> Result<Option<Dir>> {
        let chat = request["chatId"]
            .as_str()
            .filter(|id| !id.is_empty() && jsjson::utf16_len(id) <= 8192)
            .ok_or_else(|| Error::new("An existing Chat is required."))?;
        (self.validate)(chat)?;
        let name = chat_hash(chat);
        match self.root.child(&name, create) {
            Ok(dir) => Ok(Some(dir)),
            Err(error) if error.missing() && !create => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn write_json(&self, dir: &Dir, name: &str, value: &Value) -> Result<()> {
        dir.atomic(name, jsjson::to_string(value).as_bytes(), || {
            (self.active)()
        })
    }
    fn load(&self, folder: &Dir, id: &str, deleted: bool) -> Result<Option<Value>> {
        validation::id(&json!(id))?;
        let directory = match folder.child(id, false) {
            Ok(dir) => Some(dir),
            Err(error) if error.missing() => None,
            Err(error) => return Err(error),
        };
        if let Some(directory) = directory {
            match read_json(&directory, "meta.json", 8 * 1024 * 1024) {
                Ok(meta) => {
                    check_meta(&meta, id)?;
                    return Ok((jsjson::truthy(meta.get("deletedAt")) == deleted).then_some(meta));
                }
                Err(error) if error.missing() => {}
                Err(error) => return Err(error),
            }
        }
        if deleted {
            return Ok(None);
        }
        let legacy_name = format!("{id}.json");
        let legacy = match read_json(folder, &legacy_name, 256 * 1024 * 1024) {
            Ok(value) => value,
            Err(error) if error.missing() => return Ok(None),
            Err(error) => return Err(error),
        };
        let versions = legacy["versions"]
            .as_array()
            .ok_or_else(|| Error::new("Invalid legacy Artifact metadata."))?;
        (self.active)()?;
        let directory = folder.child(id, true)?;
        let mut entries = Vec::new();
        for entry in versions {
            let version = positive_version(&entry["version"])?;
            let html = entry["html"]
                .as_str()
                .ok_or_else(|| Error::new("Invalid legacy Artifact HTML."))?;
            directory.atomic(&format!("v{version}.html"), utf8(html).as_bytes(), || {
                (self.active)()
            })?;
            let mut entry = entry.clone();
            entry.as_object_mut().unwrap().shift_remove("html");
            entry["format"] = json!("html");
            entries.push(entry);
        }
        let meta = json!({"id":id,"versions":entries});
        self.write_json(&directory, "meta.json", &meta)?;
        folder.remove(&legacy_name)?;
        Ok(Some(meta))
    }
    fn active_artifacts(&self, folder: &Dir, filter: Option<&str>) -> Result<Vec<Value>> {
        let ids = folder
            .entries()?
            .into_iter()
            .map(|name| name.strip_suffix(".json").unwrap_or(&name).to_owned())
            .filter(|name| valid_id(name) && name != "comments")
            .collect::<std::collections::BTreeSet<_>>();
        let mut values = Vec::new();
        for id in ids {
            if let Some(meta) = self.load(folder, &id, false)? {
                if let Some(entry) = meta["versions"]
                    .as_array()
                    .and_then(|versions| versions.last())
                {
                    if !jsjson::truthy(entry.get("inline"))
                        && filter.is_none_or(|filter| filter == format_of(entry))
                    {
                        values.push(meta);
                    }
                }
            }
        }
        let latest_html = values
            .iter()
            .filter(|meta| format_of(last(meta)) == "html")
            .min_by(|a, b| {
                number(&last(b)["createdAt"])
                    .total_cmp(&number(&last(a)["createdAt"]))
                    .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            })
            .map(|meta| meta["id"].clone());
        values.retain(|meta| {
            format_of(last(meta)) == "design" || latest_html.as_ref() == Some(&meta["id"])
        });
        values.sort_by(|a, b| {
            number(&a["versions"][0]["createdAt"])
                .total_cmp(&number(&b["versions"][0]["createdAt"]))
        });
        Ok(values)
    }
    fn read_version(&self, folder: &Dir, meta: &Value, version: Option<&Value>) -> Result<Value> {
        let versions = meta["versions"].as_array().unwrap();
        let entry = match version {
            None => versions.last(),
            Some(version) => versions
                .iter()
                .find(|entry| jsjson::strict_equals(&entry["version"], version)),
        }
        .ok_or_else(|| {
            Error::new(format!(
                "Version {} of this design is no longer kept.",
                jsjson::property_key(version)
            ))
        })?;
        let version = positive_version(&entry["version"])?;
        let directory = folder.child(validation::id(&meta["id"])?, false)?;
        let html = directory
            .read(
                &format!("v{version}.html"),
                if format_of(entry) == "design" {
                    64 * 1024 * 1024
                } else {
                    4 * MAX_HTML
                },
            )
            .map_err(|error| {
                if error.missing() {
                    Error::new("This design is no longer available.")
                } else {
                    error
                }
            })?;
        let mut result = summary(meta, entry);
        result["latest"] = last(meta)["version"].clone();
        result["html"] = json!(jsjson::js_string(&String::from_utf8_lossy(&html)));
        if format_of(entry) == "design" {
            result["document"] = read_json(
                &directory,
                &format!("v{version}.design.json"),
                64 * 1024 * 1024,
            )?;
        }
        if format_of(entry) == "html" && jsjson::truthy(entry.get("tabs")) {
            result["tabs"] = read_json(&directory, &format!("v{version}.tabs.json"), 8 * MAX_HTML)?;
        }
        if format_of(entry) == "html"
            && entry["assets"]
                .as_array()
                .is_some_and(|assets| !assets.is_empty())
        {
            result["assets"] = entry["assets"].clone();
        }
        Ok(result)
    }
    pub fn list(&mut self, request: &Value) -> Result<Value> {
        let folder = self.chat(request, false)?;
        validation::format(request.get("format"))?;
        let Some(folder) = folder else {
            return Ok(json!([]));
        };
        Ok(Value::Array(
            self.active_artifacts(&folder, request["format"].as_str())?
                .iter()
                .map(|meta| summary(meta, last(meta)))
                .collect(),
        ))
    }
    pub fn get(&mut self, request: &Value) -> Result<Value> {
        let folder = self
            .chat(request, false)?
            .ok_or_else(|| Error::new("This design is no longer available."))?;
        let mut meta = self
            .load(&folder, validation::id(&request["id"])?, false)?
            .ok_or_else(|| Error::new("This design is no longer available."))?;
        validation::format(request.get("format"))?;
        if request
            .get("format")
            .is_some_and(|format| format.as_str() != Some(format_of(last(&meta))))
        {
            return Err(Error::new(FORMAT_MISMATCH));
        }
        let html = format_of(last(&meta)) == "html";
        if html && !jsjson::truthy(last(&meta).get("inline")) {
            if let Some(current) = self
                .active_artifacts(&folder, Some("html"))?
                .into_iter()
                .next()
            {
                meta = current;
            }
        }
        if !html && request["fonts"]["have"].is_array() {
            return Err(Error::coded(
                "UNSUPPORTED_CONTENT_OPERATION",
                "Structured Design font transport is not implemented by the Rust Artifact store.",
            ));
        }
        self.read_version(
            &folder,
            &meta,
            if html { None } else { request.get("version") },
        )
    }
    pub fn artifact_read(&mut self, request: &Value) -> Result<Value> {
        let mut input = request.clone();
        input["format"] = json!("html");
        let mut page = self.get(&input)?;
        if let Some(tabs) = page["tabs"].as_array().cloned() {
            page.as_object_mut().unwrap().shift_remove("html");
            if let Some(tab) = request.get("tab") {
                let one = tabs
                    .iter()
                    .find(|entry| &entry["id"] == tab)
                    .cloned()
                    .ok_or_else(|| {
                        Error::new(format!(
                            "This page has no tab {}. Its tabs: {}.",
                            jsjson::property_key(Some(tab)),
                            tabs.iter()
                                .map(|tab| tab["id"].as_str().unwrap_or(""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ))
                    })?;
                page["tabs"] = json!(tabs
                    .iter()
                    .map(|tab| json!({"id":tab["id"],"title":tab["title"]}))
                    .collect::<Vec<_>>());
                page["tab"] = one;
            }
        }
        Ok(page)
    }
    fn import_assets(&self, request: &Value, roots: &[PathBuf]) -> Result<Vec<Staged>> {
        let Some(assets) = request.get("assets") else {
            return Ok(Vec::new());
        };
        let assets = assets
            .as_array()
            .filter(|assets| assets.len() <= 100)
            .ok_or_else(|| Error::new("Attach at most 100 files to a page."))?;
        let mut imported: Vec<Staged> = Vec::new();
        for asset in assets {
            let name = asset["name"].as_str().filter(|name| asset_name(name)).ok_or_else(|| Error::new("Name each file with letters, digits, dots, dashes and underscores, and no folders, such as demo.mp4."))?;
            if imported.iter().any(|asset| asset.metadata["name"] == name) {
                return Err(Error::new(format!("Two files are named {name}.")));
            }
            let failure = || {
                Error::new(format!("{} isn't a file in this Chat's Worktree. Save the file in the Worktree and attach it by its absolute path.",jsjson::property_key(asset.get("path"))))
            };
            let source = asset["path"]
                .as_str()
                .filter(|path| Path::new(path).is_absolute())
                .ok_or_else(failure)?;
            let source = std::fs::canonicalize(utf8(source)).map_err(|_| failure())?;
            let root = roots
                .iter()
                .filter_map(|root| std::fs::canonicalize(root).ok())
                .find(|root| root.starts_with(self.isolation.root()) && source.starts_with(root))
                .ok_or_else(failure)?;
            let relative = source.strip_prefix(&root).map_err(|_| failure())?;
            let mut parent = Dir::open_absolute(&root).map_err(|_| failure())?;
            let parts = relative.components().collect::<Vec<_>>();
            for part in &parts[..parts.len().saturating_sub(1)] {
                let Component::Normal(part) = part else {
                    return Err(failure());
                };
                parent = parent
                    .child(part.to_str().ok_or_else(failure)?, false)
                    .map_err(|_| failure())?;
            }
            let mut input = parent
                .open(
                    source
                        .file_name()
                        .and_then(|name| name.to_str())
                        .ok_or_else(failure)?,
                )
                .map_err(|_| failure())?;
            let bytes = input.metadata()?.len();
            if bytes > MAX_ASSET {
                return Err(Error::new(format!(
                    "{name} is {} MB. A file is limited to 95 MB.",
                    bytes.div_ceil(1024 * 1024)
                )));
            }
            (self.active)()?;
            let incoming = self.root.child(".incoming", true)?;
            let temporary = self.runtime.uuid();
            validation::id(&json!(temporary))?;
            let mut output = incoming.create(&temporary)?;
            let mut staged = Staged {
                directory: incoming,
                name: temporary,
                metadata: json!({"name":name,"hash":"","size":0,"type":asset_type(name)}),
            };
            let mut digest = Sha256::new();
            let mut size = 0u64;
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                if size > MAX_ASSET {
                    return Err(Error::new(format!(
                        "{name} is over 95 MB, the limit for a file."
                    )));
                }
                digest.update(&buffer[..count]);
                output.write_all(&buffer[..count])?;
            }
            output.sync_all()?;
            staged.metadata["hash"] = json!(hex::encode(digest.finalize()));
            staged.metadata["size"] = json!(size);
            imported.push(staged);
        }
        Ok(imported)
    }
    pub fn show(&mut self, request: &Value, roots: &[PathBuf]) -> Result<Value> {
        let imported = self.import_assets(request, roots)?;
        (self.active)()?;
        let folder = self.chat(request, true)?.unwrap();
        let title = request["title"]
            .as_str()
            .map(trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| Error::new("An artifact needs a title."))?;
        if request.get("tabs").is_some() && request.get("html").is_some() {
            return Err(Error::new("Send the page as html or as tabs, not both."));
        }
        if request.get("tabs").is_none()
            && !request["html"]
                .as_str()
                .is_some_and(|html| !trim(html).is_empty())
        {
            return Err(Error::new("An artifact needs its HTML."));
        }
        if request["html"]
            .as_str()
            .is_some_and(|html| jsjson::utf16_len(html) > MAX_HTML)
        {
            return Err(Error::new(
                "Artifact HTML is limited to 1000000 characters.",
            ));
        }
        let requested = if jsjson::truthy(request.get("id")) {
            Some(validation::id(&request["id"])?)
        } else {
            None
        };
        if let Some(id) = requested {
            if let Some(meta) = self.load(&folder, id, false)? {
                if jsjson::truthy(last(&meta).get("inline")) {
                    return Err(Error::new(
                        "HTML replies are immutable. Publish a new reply with html_render.",
                    ));
                }
                if format_of(last(&meta)) != "html" {
                    return Err(Error::new(FORMAT_MISMATCH));
                }
            }
        }
        let current = self
            .active_artifacts(&folder, Some("html"))?
            .into_iter()
            .next();
        let reusable = match requested {
            Some(id) => self.load(&folder, id, true)?.is_none(),
            None => false,
        };
        let id = if let Some(current) = &current {
            current["id"].as_str().unwrap().to_owned()
        } else if let Some(id) = requested.filter(|_| reusable) {
            id.to_owned()
        } else {
            self.fresh_id(true)?
        };
        validation::id(&json!(id))?;
        let previous = current
            .as_ref()
            .map(|meta| meta["versions"].as_array().unwrap().clone())
            .unwrap_or_default();
        let prior = previous.last().unwrap_or(&Value::Null);
        let version = integer(&prior["version"]).unwrap_or(0) as u64;
        if let Some(expected) = request.get("expectedVersion") {
            let expected = integer(expected)
                .filter(|version| *version >= 0)
                .ok_or_else(|| Error::new("expectedVersion must be a non-negative integer."))?;
            if expected as u64 != version {
                return Err(Error::coded("DESIGN_VERSION_CONFLICT",format!("Design version conflict: expected version {expected}, but the latest is {version}. Read the design again before applying your changes.")));
            }
        }
        let keeping = request["tabs"]
            .as_array()
            .is_some_and(|tabs| tabs.iter().any(|tab| tab.get("html").is_none()))
            && jsjson::truthy(prior.get("tabs"));
        let saved = if keeping {
            Some(self.read_version(&folder, current.as_ref().unwrap(), None)?)
        } else {
            None
        };
        let tabs = request
            .get("tabs")
            .map(|input| {
                validation::tabs(input, saved.as_ref().and_then(|value| value.get("tabs")))
            })
            .transpose()?;
        let mut entry = json!({"version":version+1,"title":slice(title,120),"width":dimension(&request["width"],&prior["width"],1280),"height":dimension(&request["height"],&prior["height"],800),"format":"html","livePage":true});
        if let Some(tabs) = &tabs {
            entry["tabs"] = json!(tabs
                .iter()
                .map(|tab| json!({"id":tab["id"],"title":tab["title"]}))
                .collect::<Vec<_>>());
        }
        entry["createdAt"] = json!(self.runtime.now_ms());
        let page_html = tabs
            .as_ref()
            .map(|tabs| {
                tabs.iter()
                    .map(|tab| tab["html"].as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| request["html"].as_str().unwrap().to_owned());
        for asset in &imported {
            let name = asset.metadata["name"].as_str().unwrap();
            if !mentions(&page_html, name) {
                return Err(Error::new(format!("The page doesn't use assets/{name}. Refer to it in the HTML as assets/{name}, or leave the file out.")));
            }
        }
        let mut assets = prior["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|asset| {
                asset["name"].as_str().is_some_and(|name| {
                    !imported.iter().any(|item| item.metadata["name"] == name)
                        && mentions(&page_html, name)
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        assets.extend(imported.iter().map(|asset| asset.metadata.clone()));
        if assets.len() > 100 {
            return Err(Error::new("A page has at most 100 files."));
        }
        if assets
            .iter()
            .map(|asset| asset["size"].as_u64().unwrap_or(MAX_PAGE_BYTES + 1))
            .fold(0u64, u64::saturating_add)
            > MAX_PAGE_BYTES
        {
            return Err(Error::new(
                "A page's files are limited to 1024 MB together.",
            ));
        }
        if !assets.is_empty() {
            entry["assets"] = json!(assets);
        }
        let directory = folder.child(&id, true)?;
        if !imported.is_empty() {
            let target = directory.child("assets", true)?;
            for asset in &imported {
                let hash = asset.metadata["hash"].as_str().unwrap();
                match target.open(hash) {
                    Ok(_) => {}
                    Err(error) if error.missing() => {
                        asset.directory.rename(&asset.name, &target, hash)?
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        let html = tabs
            .as_ref()
            .map(|tabs| tabs[0]["html"].as_str().unwrap())
            .unwrap_or_else(|| request["html"].as_str().unwrap());
        let meta = self.write_version(&folder, &id, &previous, &entry, html, tabs.as_ref())?;
        Ok(summary(&meta, &entry))
    }
    fn write_version(
        &self,
        folder: &Dir,
        id: &str,
        previous: &[Value],
        entry: &Value,
        html: &str,
        tabs: Option<&Vec<Value>>,
    ) -> Result<Value> {
        (self.active)()?;
        let directory = folder.child(id, true)?;
        let version = positive_version(&entry["version"])?;
        let html_name = format!("v{version}.html");
        let tabs_name = format!("v{version}.tabs.json");
        let meta = json!({"id":id,"versions":[entry]});
        let result = (|| {
            directory.atomic(&html_name, utf8(html).as_bytes(), || (self.active)())?;
            if let Some(tabs) = tabs {
                self.write_json(&directory, &tabs_name, &json!(tabs))?;
            }
            self.write_json(&directory, "meta.json", &meta)
        })();
        if let Err(error) = result {
            let _ = directory.remove(&html_name);
            if tabs.is_some() {
                let _ = directory.remove(&tabs_name);
            }
            return Err(error);
        }
        for old in previous {
            if old["version"] == entry["version"] || !jsjson::truthy(old.get("livePage")) {
                continue;
            }
            let old_version = positive_version(&old["version"])?;
            let _ = directory.remove(&format!("v{old_version}.html"));
            if jsjson::truthy(old.get("tabs")) {
                let _ = directory.remove(&format!("v{old_version}.tabs.json"));
            }
        }
        // Like Node's pruneAssets, cleanup after the metadata commit is best effort.
        // A failed cleanup must not claim that the committed page was rolled back.
        if let Ok(assets) = directory.child("assets", false) {
            let kept = entry["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|asset| asset["hash"].as_str())
                .collect::<std::collections::HashSet<_>>();
            for name in assets.entries().unwrap_or_default() {
                if !kept.contains(name.as_str()) {
                    let _ = assets.remove(&name);
                }
            }
        }
        Ok(meta)
    }
    pub fn render(&mut self, request: &Value) -> Result<Value> {
        (self.active)()?;
        let folder = self.chat(request, true)?.unwrap();
        let html = request["html"]
            .as_str()
            .filter(|html| !trim(html).is_empty() && jsjson::utf16_len(html) <= MAX_HTML)
            .ok_or_else(|| Error::new("Send HTML between 1 and 1000000 characters."))?;
        let title = request["title"]
            .as_str()
            .filter(|title| !trim(title).is_empty() && jsjson::utf16_len(title) <= 120)
            .ok_or_else(|| Error::new("Use a title between 1 and 120 characters."))?;
        let height = request
            .get("height")
            .map(integer)
            .unwrap_or(Some(400))
            .filter(|height| (24..=2000).contains(height))
            .ok_or_else(|| Error::new("Height must be between 24 and 2000 pixels."))?;
        let id = self.fresh_id(false)?;
        let entry = json!({"version":1,"title":trim(title),"format":"html","inline":true,"width":720,"height":height,"createdAt":self.runtime.now_ms()});
        let meta = self.write_version(&folder, &id, &[], &entry, html, None)?;
        Ok(summary(&meta, &entry))
    }
    pub fn asset(&mut self, request: &Value) -> Result<Value> {
        use base64::Engine;
        let folder = self
            .chat(request, false)?
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        let meta = self
            .active_artifacts(&folder, Some("html"))?
            .into_iter()
            .next()
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        let asset = last(&meta)["assets"]
            .as_array()
            .and_then(|assets| assets.iter().find(|asset| asset["name"] == request["name"]))
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        let size = asset["size"]
            .as_u64()
            .filter(|size| *size <= MAX_ASSET)
            .ok_or_else(|| Error::new("Invalid stored asset size."))?;
        let offset = request
            .get("offset")
            .filter(|value| !value.is_null())
            .map(integer)
            .unwrap_or(Some(0))
            .filter(|offset| *offset >= 0 && *offset as u64 <= size)
            .ok_or_else(|| Error::new("Invalid file offset."))? as u64;
        let length = request
            .get("length")
            .map(integer)
            .unwrap_or(Some(ASSET_CHUNK as i64))
            .filter(|length| *length >= 0)
            .ok_or_else(|| Error::new("Invalid file length."))? as u64;
        let hash = asset["hash"]
            .as_str()
            .filter(|hash| validation::hash(hash))
            .ok_or_else(|| Error::new("Invalid stored asset hash."))?;
        let directory = folder
            .child(validation::id(&meta["id"])?, false)?
            .child("assets", false)?;
        let mut file = directory
            .open(hash)
            .map_err(|_| Error::new("This file is no longer on the page."))?;
        let mut bytes = vec![0; length.min(ASSET_CHUNK as u64).min(size - offset) as usize];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)
            .map_err(|_| Error::new("This file is no longer on the page."))?;
        Ok(
            json!({"name":asset["name"],"hash":hash,"size":size,"type":asset["type"],"offset":offset,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    }
    pub fn asset_path(&mut self, request: &Value) -> Result<PathBuf> {
        let folder = self
            .chat(request, false)?
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        let meta = self
            .active_artifacts(&folder, Some("html"))?
            .into_iter()
            .next()
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        let hash = request["hash"]
            .as_str()
            .filter(|hash| validation::hash(hash))
            .filter(|hash| {
                last(&meta)["assets"]
                    .as_array()
                    .is_some_and(|assets| assets.iter().any(|asset| asset["hash"] == *hash))
            })
            .ok_or_else(|| Error::new("This file is no longer on the page."))?;
        folder
            .child(validation::id(&meta["id"])?, false)?
            .child("assets", false)?
            .open(hash)?;
        Ok(self
            .path
            .join(chat_hash(request["chatId"].as_str().unwrap()))
            .join(meta["id"].as_str().unwrap())
            .join("assets")
            .join(hash))
    }
}
pub fn chat_hash(chat: &str) -> String {
    hex::encode(Sha256::digest(utf8(chat).as_bytes()))[..32].to_owned()
}
fn last(meta: &Value) -> &Value {
    meta["versions"]
        .as_array()
        .and_then(|versions| versions.last())
        .unwrap_or(&Value::Null)
}
fn positive_version(value: &Value) -> Result<u64> {
    integer(value)
        .filter(|version| *version >= 1)
        .map(|version| version as u64)
        .ok_or_else(|| Error::new("Invalid stored Artifact version."))
}
fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn dimension(value: &Value, previous: &Value, default: u64) -> Value {
    integer(value)
        .filter(|value| (240..=3840).contains(value))
        .map(|value| json!(value))
        .unwrap_or_else(|| {
            if previous.is_null() {
                json!(default)
            } else {
                previous.clone()
            }
        })
}
fn check_meta(meta: &Value, id: &str) -> Result<()> {
    if meta["id"] != id || !meta["versions"].is_array() {
        return Err(Error::new("Invalid Artifact metadata."));
    }
    for entry in meta["versions"].as_array().unwrap() {
        positive_version(&entry["version"])?;
    }
    Ok(())
}
fn read_json(dir: &Dir, name: &str, limit: usize) -> Result<Value> {
    jsjson::parse_bytes(&dir.read(name, limit)?).map_err(Error::new)
}
fn summary(meta: &Value, entry: &Value) -> Value {
    let mut value = json!({"id":meta["id"],"title":entry["title"],"version":entry["version"],"versions":if format_of(entry)=="html"{1}else{meta["versions"].as_array().map_or(0,Vec::len)},"width":if entry["width"].is_null(){json!(1280)}else{entry["width"].clone()},"height":if entry["height"].is_null(){json!(800)}else{entry["height"].clone()},"format":format_of(entry)});
    for key in ["inline", "group", "kit", "consistency"] {
        if jsjson::truthy(entry.get(key)) {
            value[key] = if key == "inline" {
                json!(true)
            } else {
                entry[key].clone()
            };
        }
    }
    value
}
