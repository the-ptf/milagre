//! Project-owned, immutable Design kit snapshots in an admitted isolated copy.
use super::*;
use crate::{
    files::{Dir, StoreLock},
    ActiveCheck,
};
use milagre_owner_store::{isolation::MARKER, Isolation};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path},
    sync::Arc,
};

pub type ProjectForChat = Arc<dyn Fn(&str) -> Result<String> + Send + Sync>;
pub struct DesignKits {
    root: Dir,
    _lock: StoreLock,
    project_for_chat: ProjectForChat,
    active: ActiveCheck,
}

pub fn validate_kit(input: &Value) -> Result<Value> {
    let kit = schema::parse(
        &schema::contract()["document"]["properties"]["kit"],
        input,
        &[],
    )?;
    refine_document(&json!({"kit":kit}), &[])?;
    if jsjson::to_string(&kit).encode_utf16().count() > 250_000 {
        return Err(error("A design kit is limited to 250,000 characters."));
    }
    if let Some(components) = kit["components"].as_object() {
        for (id, layers) in components {
            let mut context = kit.clone();
            context["components"] = json!({});
            let document = validate_document(
                &json!({"schemaVersion":1,"width":390,"height":844,"kit":context,"nodes":layers}),
            )?;
            let roots = nodes(&document)
                .iter()
                .filter(|node| !yes(node, "parentId"))
                .collect::<Vec<_>>();
            if roots.len() != 1 || roots[0]["id"] != *id || !yes(roots[0], "component") {
                return Err(error(format!(
                    "Kit component \"{id}\" needs one root main component with the same id."
                )));
            }
        }
    }
    Ok(kit)
}
pub struct AuthorizedKits<'a> {
    store: &'a mut DesignKits,
    previous: ActiveCheck,
}
impl std::ops::Deref for AuthorizedKits<'_> {
    type Target = DesignKits;
    fn deref(&self) -> &DesignKits {
        self.store
    }
}
impl std::ops::DerefMut for AuthorizedKits<'_> {
    fn deref_mut(&mut self) -> &mut DesignKits {
        self.store
    }
}
impl Drop for AuthorizedKits<'_> {
    fn drop(&mut self) {
        self.store.active = self.previous.clone();
    }
}

impl DesignKits {
    pub fn authorized(&mut self, grant: ActiveCheck) -> AuthorizedKits<'_> {
        let previous = self.active.clone();
        let owner = previous.clone();
        self.active = Arc::new(move || {
            owner()?;
            grant()
        });
        AuthorizedKits {
            store: self,
            previous,
        }
    }

    pub fn open(
        isolation: Isolation,
        relative: &Path,
        project_for_chat: ProjectForChat,
        active: ActiveCheck,
    ) -> Result<Self> {
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(Error::coded(
                "NOT_ISOLATED",
                "Use a relative Design kit directory inside the isolated copy.",
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
                    .ok_or_else(|| error("Design kit paths must be UTF-8."))?,
                true,
            )?;
        }
        let lock = root.lock()?;
        Ok(Self {
            root,
            _lock: lock,
            project_for_chat,
            active,
        })
    }
    fn scope(&self, request: &Value, create: bool) -> Result<(Option<Dir>, String, String)> {
        let id = request.get("id").unwrap_or(&json!("project")).clone();
        let id = id
            .as_str()
            .filter(|id| {
                regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$")
                    .unwrap()
                    .is_match(id)
            })
            .ok_or_else(|| error("Invalid design kit id."))?
            .to_owned();
        let chat = request["chatId"]
            .as_str()
            .ok_or_else(|| error("This Chat has no design kit scope."))?;
        let project = (self.project_for_chat)(chat)?;
        if project.is_empty() {
            return Err(error("This Chat has no design kit scope."));
        }
        let name = hex::encode(Sha256::digest(utf8(&project).as_bytes()));
        let folder = match self.root.child(&name, create) {
            Ok(dir) => Some(dir),
            Err(error) if error.missing() && !create => None,
            Err(error) => return Err(error),
        };
        Ok((folder, id, name))
    }
    fn history(folder: Option<&Dir>, id: &str) -> Result<Vec<Value>> {
        let Some(folder) = folder else {
            return Ok(Vec::new());
        };
        let bytes = match folder.read(&format!("{id}.json"), 128 * 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.missing() => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        jsjson::parse_bytes(&bytes)
            .map_err(|error| Error::coded("INVALID_CONTENT_STORAGE", error))?
            .as_array()
            .cloned()
            .ok_or_else(|| Error::coded("INVALID_CONTENT_STORAGE", "Invalid kit history."))
    }
    pub fn read(&mut self, request: &Value) -> Result<Value> {
        let (folder, id, _) = self.scope(request, false)?;
        let all = Self::history(folder.as_ref(), &id)?;
        let found = match request.get("version") {
            Some(version) => all
                .iter()
                .find(|kit| jsjson::strict_equals(&kit["version"], version)),
            None => all.last(),
        };
        if let Some(found) = found {
            return validate_kit(found).map_err(|mut error| {
                error.code = "INVALID_CONTENT_STORAGE".into();
                error
            });
        }
        if let Some(version) = request.get("version") {
            return Err(error(format!(
                "Kit \"{id}\" version {} does not exist in this Project.",
                jsjson::property_key(Some(version))
            )));
        }
        Ok(Value::Null)
    }
    pub fn save(&mut self, request: &Value) -> Result<Value> {
        (self.active)()?;
        let (folder, id, project) = self.scope(request, false)?;
        let mut all = Self::history(folder.as_ref(), &id)?;
        let actual = all
            .last()
            .map(|kit| kit["version"].clone())
            .unwrap_or(json!(0));
        if request["expectedVersion"]
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value.fract() != 0.0)
            || !jsjson::strict_equals(&request["expectedVersion"], &actual)
        {
            return Err(error(format!(
                "Kit version conflict: expected {}, latest {}. Read the kit again.",
                jsjson::property_key(request.get("expectedVersion")),
                jsjson::property_key(Some(&actual))
            )));
        }
        if all.len() >= 100 {
            return Err(error(
                "This kit has 100 immutable versions. Create a new kit id.",
            ));
        }
        let mut data_schema = schema::contract()["document"]["properties"]["kit"].clone();
        for field in ["id", "version"] {
            remove(&mut data_schema["properties"], field);
        }
        data_schema["required"]
            .as_array_mut()
            .unwrap()
            .retain(|field| field != "id" && field != "version");
        let mut input = schema::parse(&data_schema, &request["kit"], &[])?;
        input["id"] = json!(id);
        input["version"] = json!(actual.as_f64().unwrap() + 1.0);
        let saved = validate_kit(&input)?;
        all.push(saved.clone());
        let folder = self.root.child(&project, true)?;
        folder.atomic(
            &format!("{id}.json"),
            jsjson::to_string(&json!(all)).as_bytes(),
            || (self.active)(),
        )?;
        Ok(saved)
    }
}
