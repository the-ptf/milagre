//! Two-phase revisions keep rendering outside the Rust scene model while making
//! fresh source/HTML pairing mandatory. Prepared values cannot be constructed or
//! mutated by callers, and commit rechecks both version and kit authority.
use super::*;
use crate::{last, positive_version, summary, ArtifactStore, Dir};
use std::path::PathBuf;

pub type KitReader<'a> = dyn Fn(&Value) -> Result<Value> + 'a;
pub type Renderer<'a> = dyn Fn(&Value) -> Result<String> + 'a;

pub struct PreparedDesign {
    store: PathBuf,
    chat: String,
    id: String,
    base_version: u64,
    document: Value,
    entry: Value,
    apply: bool,
}
impl PreparedDesign {
    pub fn document(&self) -> &Value {
        &self.document
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn version(&self) -> u64 {
        self.base_version + 1
    }
}
fn editable(existing: Option<&Value>) -> Result<()> {
    if existing.is_some_and(|meta| crate::validation::format_of(last(meta)) != "design") {
        return Err(error("Artifacts and Designs use separate formats. Create a new id instead of changing formats."));
    }
    Ok(())
}
fn version(request: &Value, existing: Option<&Value>) -> Result<u64> {
    let actual = existing
        .map(|meta| positive_version(&last(meta)["version"]))
        .transpose()?
        .unwrap_or(0);
    match request.get("expectedVersion") {
        None if actual > 0 => Err(error(format!(
            "Read this design before revising it, then send expectedVersion {actual}."
        ))),
        None => Ok(actual),
        Some(expected) => {
            let expected = crate::validation::integer(expected)
                .filter(|number| *number >= 0)
                .ok_or_else(|| error("expectedVersion must be a non-negative integer."))?
                as u64;
            if expected != actual {
                return Err(Error::coded("DESIGN_VERSION_CONFLICT",format!("Design version conflict: expected version {expected}, but the latest is {actual}. Read the design again before applying your changes.")));
            }
            Ok(actual)
        }
    }
}
fn verify_kit(chat: &str, document: &Value, reader: &KitReader<'_>) -> Result<()> {
    if let Some(kit) = document.get("kit") {
        let saved = reader(&json!({"chatId":chat,"id":kit["id"],"version":kit["version"]}))?;
        if !kit::equivalent(kit, &saved) {
            return Err(error("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot."));
        }
    }
    kit::validate_consistency(document)
}
fn entry(base: u64, title: Value, group: Option<Value>, document: &Value, time: u64) -> Value {
    let mut entry = json!({"version":base+1,"title":title});
    if let Some(group) = group.filter(|group| jsjson::truthy(Some(group))) {
        entry["group"] = group;
    }
    if let Some(kit) = document.get("kit") {
        entry["kit"] = json!({"id":kit["id"],"version":kit["version"],"title":kit["title"]});
    }
    if let Some(consistency) = document.get("consistency") {
        entry["consistency"] = json!({"mode":consistency["mode"]});
    }
    for field in ["width", "height"] {
        entry[field] = document[field].clone();
    }
    entry["format"] = json!("design");
    entry["createdAt"] = json!(time);
    entry
}
impl ArtifactStore {
    /// Prepare a new Design, a version-checked replacement, or a variant of one
    /// retained saved revision. No preview or metadata is published here.
    pub fn prepare_design_show(
        &mut self,
        request: &Value,
        read_kit: &KitReader<'_>,
    ) -> Result<PreparedDesign> {
        (self.active)()?;
        let folder = self.chat(request, false)?;
        let title = request["title"]
            .as_str()
            .filter(|title| !trim(title).is_empty())
            .ok_or_else(|| error("A design needs a title."))?;
        let id = match request.get("id").filter(|id| !id.is_null()) {
            Some(id) => crate::validation::id(id)?.to_owned(),
            None => self.fresh_id(true)?,
        };
        let existing = if yes(request, "id") {
            folder
                .as_ref()
                .map(|folder| self.load(folder, &id, false))
                .transpose()?
                .flatten()
        } else {
            None
        };
        if existing.is_none()
            && yes(request, "id")
            && folder
                .as_ref()
                .map(|folder| self.load(folder, &id, true))
                .transpose()?
                .flatten()
                .is_some()
        {
            return Err(error(format!("The design {id} was deleted. Use a new id.")));
        }
        editable(existing.as_ref())?;
        let base = version(request, existing.as_ref())?;
        let source = if let Some(from) = request.get("from") {
            if has(request, "document") {
                return Err(error("Send document OR from, not both."));
            }
            let source_id = crate::validation::id(&from["id"])?;
            let saved = folder
                .as_ref()
                .map(|folder| self.load(folder, source_id, false))
                .transpose()?
                .flatten()
                .ok_or_else(|| {
                    error(format!(
                        "The design {source_id} to start from is no longer available."
                    ))
                })?;
            editable(Some(&saved))?;
            Some(self.read_version(folder.as_ref().unwrap(), &saved, from.get("version"))?)
        } else {
            if has(request, "operations") {
                return Err(error(
                    "operations go with from; to revise a design in place, use design_apply.",
                ));
            }
            None
        };
        let document = if let Some(source) = &source {
            if match request.get("operations") {
                Some(Value::Array(operations)) => !operations.is_empty(),
                Some(Value::String(operations)) => !operations.is_empty(),
                Some(Value::Object(operations)) => jsjson::truthy(operations.get("length")),
                _ => false,
            } {
                apply_operations(&source["document"], &request["operations"], None)?
            } else {
                validate_document(&source["document"])?
            }
        } else {
            let mut document = request.get("document").cloned().unwrap_or(json!({}));
            if !yes(&document, "consistency") {
                if let Some(existing) = &existing {
                    let current = self.read_version(folder.as_ref().unwrap(), existing, None)?;
                    if let Some(consistency) = current["document"].get("consistency") {
                        if let Some(map) = document.as_object_mut() {
                            map.insert("consistency".into(), consistency.clone());
                        }
                    }
                }
            }
            validate_document(&document)?
        };
        let chat = sid(request, "chatId");
        verify_kit(&chat, &document, read_kit)?;
        let group = if let Some(group) = request["group"].as_str() {
            Some(json!(crate::validation::slice(trim(group), 60)))
        } else {
            existing
                .as_ref()
                .and_then(|meta| last(meta).get("group"))
                .or_else(|| source.as_ref().and_then(|source| source.get("group")))
                .cloned()
        };
        let entry = entry(
            base,
            json!(crate::validation::slice(trim(title), 120)),
            group,
            &document,
            self.runtime.now_ms(),
        );
        Ok(PreparedDesign {
            store: self.path.clone(),
            chat,
            id,
            base_version: base,
            document,
            entry,
            apply: false,
        })
    }
    pub fn prepare_design_apply(
        &mut self,
        request: &Value,
        read_kit: &KitReader<'_>,
    ) -> Result<PreparedDesign> {
        (self.active)()?;
        let folder = self.chat(request, false)?;
        let id = crate::validation::id(&request["id"])?;
        let existing = folder
            .as_ref()
            .map(|folder| self.load(folder, id, false))
            .transpose()?
            .flatten()
            .ok_or_else(|| error("This design is no longer available."))?;
        editable(Some(&existing))?;
        let base = version(request, Some(&existing))?;
        let current = self.read_version(folder.as_ref().unwrap(), &existing, None)?;
        let document = apply_operations(
            &current["document"],
            &request["operations"],
            request.get("intent"),
        )?;
        let chat = sid(request, "chatId");
        verify_kit(&chat, &document, read_kit)?;
        let entry = entry(
            base,
            current["title"].clone(),
            current.get("group").cloned(),
            &document,
            self.runtime.now_ms(),
        );
        Ok(PreparedDesign {
            store: self.path.clone(),
            chat,
            id: id.to_owned(),
            base_version: base,
            document,
            entry,
            apply: true,
        })
    }
    /// The callback must render this exact document, including its fonts. A
    /// missing or failed renderer never creates a successful saved revision.
    pub fn commit_design(
        &mut self,
        prepared: PreparedDesign,
        read_kit: &KitReader<'_>,
        renderer: &Renderer<'_>,
    ) -> Result<Value> {
        if prepared.store != self.path {
            return Err(Error::coded(
                "NOT_ISOLATED",
                "The prepared Design belongs to another isolated store.",
            ));
        }
        (self.active)()?;
        let request = json!({"chatId":prepared.chat,"expectedVersion":prepared.base_version});
        let folder = self.chat(&request, true)?.unwrap();
        let existing = self.load(&folder, &prepared.id, false)?;
        if existing.is_none() && self.load(&folder, &prepared.id, true)?.is_some() {
            return Err(error(format!(
                "The design {} was deleted. Use a new id.",
                prepared.id
            )));
        }
        editable(existing.as_ref())?;
        version(&request, existing.as_ref())?;
        verify_kit(&prepared.chat, &prepared.document, read_kit)?;
        let html = renderer(&prepared.document)?;
        if html.is_empty() || html.len() > 64 * 1024 * 1024 {
            return Err(error(
                "A rendered Design preview must contain between 1 byte and 64 MiB.",
            ));
        }
        (self.active)()?;
        let previous = existing
            .as_ref()
            .map(|meta| meta["versions"].as_array().unwrap().clone())
            .unwrap_or_default();
        let directory = folder.child(&prepared.id, true)?;
        let revision = prepared.version();
        let html_name = format!("v{revision}.html");
        let document_name = format!("v{revision}.design.json");
        let mut versions = previous.clone();
        versions.push(prepared.entry.clone());
        if versions.len() > 50 {
            versions.drain(..versions.len() - 50);
        }
        let meta = json!({"id":prepared.id,"versions":versions});
        let saved = (|| -> Result<()> {
            directory.atomic(&html_name, utf8(&html).as_bytes(), || (self.active)())?;
            self.write_json(&directory, &document_name, &prepared.document)?;
            self.write_json(&directory, "meta.json", &meta)
        })();
        if let Err(error) = saved {
            let _ = directory.remove(&html_name);
            let _ = directory.remove(&document_name);
            return Err(error);
        }
        prune(&directory, &previous, &meta);
        let mut result = summary(&meta, &prepared.entry);
        if prepared.apply {
            result["latest"] = json!(revision);
            result["html"] = json!(html);
            result["document"] = prepared.document;
        }
        Ok(result)
    }
}
fn prune(directory: &Dir, previous: &[Value], meta: &Value) {
    let retained = meta["versions"].as_array().unwrap();
    for entry in previous {
        if retained
            .iter()
            .any(|kept| kept["version"] == entry["version"])
        {
            continue;
        }
        if let Ok(version) = positive_version(&entry["version"]) {
            let _ = directory.remove(&format!("v{version}.html"));
            let _ = directory.remove(&format!("v{version}.design.json"));
        }
    }
}

impl ArtifactStore {
    /// Agent export retains font-family references, matching design_export. The
    /// desktop can request embedded faces directly from design::render_svg.
    pub fn export_design(&mut self, request: &Value) -> Result<Value> {
        let mut query = request.clone();
        query["format"] = json!("design");
        query.as_object_mut().unwrap().shift_remove("fonts");
        let current = self.get(&query)?;
        let format = request["format"]
            .as_str()
            .filter(|format| ["json", "svg"].contains(format))
            .ok_or_else(|| error("Choose json or svg for the design export."))?;
        let content = if format == "svg" {
            render_svg(&current["document"], &json!({"embedFonts":false}))?
        } else {
            pretty_json(&current["document"], 0)
        };
        Ok(
            json!({"id":current["id"],"version":current["version"],"filename":format!("{}-v{}.{}",sid(&current,"id"),jsjson::to_string(&current["version"]),format),"mimeType":if format=="svg"{"image/svg+xml"}else{"application/json"},"content":content}),
        )
    }
}
fn pretty_json(value: &Value, depth: usize) -> String {
    let nested = "  ".repeat(depth + 1);
    let outer = "  ".repeat(depth);
    match value {
        Value::Array(values) if !values.is_empty() => format!(
            "[\n{}\n{outer}]",
            values
                .iter()
                .map(|value| format!("{nested}{}", pretty_json(value, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        Value::Object(values) if !values.is_empty() => format!(
            "{{\n{}\n{outer}}}",
            jsjson::js_entries(values)
                .into_iter()
                .map(|(key, value)| format!(
                    "{nested}{}: {}",
                    jsjson::to_string(&json!(key)),
                    pretty_json(value, depth + 1)
                ))
                .collect::<Vec<_>>()
                .join(",\n")
        ),
        _ => jsjson::to_string(value),
    }
}
