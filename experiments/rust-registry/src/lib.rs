//! Read-only registry/identity foundation for explicitly isolated copies.
mod identity;
pub mod links;
pub mod scopes;
pub use identity::Identity;
use milagre_owner_store::{jsjson, Isolation};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
pub type Result<T> = std::result::Result<T, String>;
pub type Active = Arc<dyn Fn() -> Result<()> + Send + Sync>;
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
#[derive(Clone)]
pub struct Registry {
    isolation: Isolation,
    profile: PathBuf,
    active: Active,
    root_stamp: (u64, u64),
    profile_stamp: (u64, u64),
    probes: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone)]
pub struct Snapshot {
    registry: Registry,
    fingerprint: [u8; 32],
    data: Value,
}
#[derive(Clone)]
pub struct ProjectGrant {
    snapshot: Snapshot,
    identity: Identity,
}
#[derive(Clone)]
pub struct LinkGrant {
    snapshot: Snapshot,
    id: String,
    members: Vec<ProjectGrant>,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn absolute(value: &Value) -> bool {
    value.as_str().is_some_and(|s| Path::new(s).is_absolute())
}
fn directory_stamp(path: &Path) -> Result<(u64, u64)> {
    let meta = std::fs::symlink_metadata(path).map_err(error)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Registry capability directory was replaced.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Err("Native registry capabilities currently require Unix file identities.".into())
    }
}
fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(error(e)),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("Registry copy contains a hard-linked file.".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_FILE {
        return Err("Registry copy must be a bounded regular file.".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options.open(path).map_err(error)?;
    let opened = file.metadata().map_err(error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.ino() != opened.ino() || metadata.dev() != opened.dev() {
            return Err("Registry changed while opening.".into());
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > MAX_FILE
        || opened.len() != bytes.len() as u64
        || file.metadata().map_err(error)?.modified().ok() != opened.modified().ok()
    {
        return Err("Registry changed during read.".into());
    }
    Ok(Some(bytes))
}
impl Registry {
    pub fn open(isolation: Isolation, profile: impl AsRef<Path>, active: Active) -> Result<Self> {
        active()?;
        let profile = isolation.resolve(profile.as_ref()).map_err(error)?;
        if !profile.is_dir() {
            return Err("Registry profile copy must already exist.".into());
        }
        let root_stamp = directory_stamp(isolation.root())?;
        let profile_stamp = directory_stamp(&profile)?;
        Ok(Self {
            root_stamp,
            profile_stamp,
            probes: Arc::new(tokio::sync::Semaphore::new(8)),
            isolation,
            profile,
            active,
        })
    }
    fn check(&self) -> Result<()> {
        (self.active)()?;
        if directory_stamp(self.isolation.root())? != self.root_stamp
            || directory_stamp(&self.profile)? != self.profile_stamp
        {
            return Err("Registry directory identity changed; acquire a fresh capability.".into());
        }
        let profile = self.isolation.resolve(&self.profile).map_err(error)?;
        if profile != self.profile || !profile.is_dir() {
            return Err("Registry profile capability changed.".into());
        }
        Ok(())
    }
    pub(crate) fn contained(&self, path: &Path) -> Result<PathBuf> {
        self.check()?;
        if !path.is_absolute() {
            return Err("Choose a folder.".into());
        }
        let canonical = std::fs::canonicalize(path).map_err(error)?;
        if !canonical.starts_with(self.isolation.root()) || canonical == self.isolation.root() {
            return Err("Path is outside the isolated registry capability.".into());
        }
        Ok(canonical)
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.check()?;
        let bytes = read_file(&self.profile.join("project-registry.json"))?.unwrap_or_default();
        let value = jsjson::parse_bytes(&bytes).unwrap_or(Value::Null);
        let mut seen = BTreeSet::new();
        let mut projects = Vec::new();
        if let Some(entries) = value["projects"].as_array() {
            if entries.len() > MAX_ENTRIES {
                return Err("Registry Project limit exceeded.".into());
            }
            for entry in entries {
                if absolute(&entry["id"])
                    && absolute(&entry["path"])
                    && seen.insert(entry["id"].as_str().unwrap().to_owned())
                {
                    projects.push(entry.clone());
                }
            }
        }
        let valid = value["projects"].is_array();
        let links = if valid {
            value["links"].as_array().cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        let groups = if valid {
            value["projectGroups"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if links.len() > MAX_ENTRIES || groups.len() > MAX_ENTRIES {
            return Err("Registry Link limit exceeded.".into());
        }
        let groups = groups
            .into_iter()
            .filter(links::valid_group)
            .collect::<Vec<_>>();
        let positions = if valid
            && (value["worktreePositions"].is_object() || value["worktreePositions"].is_array())
        {
            value["worktreePositions"].clone()
        } else {
            json!({})
        };
        let data = json!({"projects":projects,"links":links,"projectGroups":groups,"worktreePositions":positions});
        self.check()?;
        Ok(Snapshot {
            registry: self.clone(),
            fingerprint: Sha256::digest(bytes).into(),
            data,
        })
    }
    /// Mirrors the menu's read filtering. It grants no capability on its own.
    pub fn recent(&self) -> Result<Value> {
        self.check()?;
        let bytes = read_file(&self.profile.join("recent-projects.json"))?.unwrap_or_default();
        let value = jsjson::parse_bytes(&bytes).unwrap_or(Value::Null);
        let mut seen = BTreeSet::new();
        let mut result = Vec::new();
        if let Some(entries) = value.as_array() {
            if entries.len() > MAX_ENTRIES {
                return Err("Recent Project limit exceeded.".into());
            }
            for entry in entries {
                let Some(path) = entry["path"]
                    .as_str()
                    .filter(|p| Path::new(p).is_absolute())
                else {
                    continue;
                };
                let path = lexical(Path::new(path));
                if !seen.insert(path.clone()) {
                    continue;
                }
                // No probing arbitrary paths from saved input. Out-of-copy entries
                // are refused, not silently accepted as an authorization source.
                let canonical = match self.contained(&path) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if !canonical.is_dir() {
                    continue;
                }
                let name = entry["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| path.file_name().and_then(|s| s.to_str()).unwrap_or(""));
                result.push(json!({"path":path,"name":name,"openedAt":entry["openedAt"].as_str().unwrap_or("")}));
                if result.len() == 10 {
                    break;
                }
            }
        }
        self.check()?;
        Ok(json!(result))
    }
    pub async fn identify(&self, path: impl AsRef<Path>) -> Result<Identity> {
        let permit = self
            .probes
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Registry identity query capacity reached.".to_string())?;
        let registry = self.clone();
        let path = path.as_ref().to_owned();
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            runtime.block_on(identity::identify(&registry, &path))
        })
        .await
        .map_err(|_| "Registry identity worker failed.".to_string())?
    }
}
impl Snapshot {
    pub fn value(&self) -> &Value {
        &self.data
    }
    pub fn check(&self) -> Result<()> {
        self.registry.check()?;
        let bytes =
            read_file(&self.registry.profile.join("project-registry.json"))?.unwrap_or_default();
        if <[u8; 32]>::from(Sha256::digest(bytes)) != self.fingerprint {
            return Err("Registry snapshot changed; acquire a fresh capability.".into());
        }
        Ok(())
    }
    /// Resolve a canonical registry identity, never granting an arbitrary descendant.
    pub async fn project(&self, requested: impl AsRef<Path>) -> Result<ProjectGrant> {
        self.check()?;
        let identity = self.registry.identify(requested.as_ref()).await?;
        if !self.data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["id"] == identity.value["id"] && entry["path"] == identity.value["path"]
            })
        {
            return Err("Open this project in Milagre first.".into());
        }
        self.check()?;
        Ok(ProjectGrant {
            snapshot: self.clone(),
            identity,
        })
    }
    pub async fn link(&self, id: &str) -> Result<LinkGrant> {
        self.check()?;
        let group = self.data["projectGroups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["id"] == id)
            .ok_or("Link no longer exists")?;
        let mut members = Vec::new();
        for id in group["projectIds"].as_array().unwrap() {
            let entry = self.data["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["id"] == *id);
            let grant = match entry {
                Some(entry) => self.project(entry["path"].as_str().unwrap()).await.ok(),
                None => None,
            };
            if let Some(grant) = grant {
                members.push(grant)
            } else {
                let name = Path::new(id.as_str().unwrap())
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                return Err(format!(
                    "Link Project {name} is unavailable. Restore its folder before sending."
                ));
            }
        }
        self.check()?;
        Ok(LinkGrant {
            snapshot: self.clone(),
            id: id.into(),
            members,
        })
    }
}
impl ProjectGrant {
    pub fn identity(&self) -> &Value {
        &self.identity.value
    }
    pub fn worktrees(&self) -> &[Value] {
        &self.identity.worktrees
    }
    /// Fresh exact-root check, not a prefix test. Descendants need a separately
    /// scoped file service; the Project registry is not a general path grant.
    pub async fn contains_folder(&self, path: impl AsRef<Path>) -> Result<bool> {
        self.snapshot.check()?;
        let path = self.snapshot.registry.contained(path.as_ref())?;
        let fresh = self
            .snapshot
            .registry
            .identify(Path::new(self.identity.value["path"].as_str().unwrap()))
            .await?;
        if fresh.value != self.identity.value {
            return Err("Project identity changed.".into());
        }
        let found = fresh.worktrees.iter().any(|worktree| {
            std::fs::canonicalize(worktree["path"].as_str().unwrap()).is_ok_and(|p| p == path)
        });
        self.snapshot.check()?;
        Ok(found)
    }
}
impl LinkGrant {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn members(&self) -> &[ProjectGrant] {
        &self.members
    }
    pub async fn check(&self) -> Result<()> {
        self.snapshot.check()?;
        for member in &self.members {
            if !member
                .contains_folder(Path::new(member.identity()["path"].as_str().unwrap()))
                .await?
            {
                return Err("Link Project is no longer active.".into());
            }
        }
        self.snapshot.check()
    }
}
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            part => out.push(part.as_os_str()),
        }
    }
    out
}

#[derive(Clone)]
pub struct LinkedGrant {
    project: ProjectGrant,
    worktree: PathBuf,
    link_ids: Vec<String>,
}
impl LinkedGrant {
    pub fn project(&self) -> &ProjectGrant {
        &self.project
    }
    pub fn worktree(&self) -> &Path {
        &self.worktree
    }
    pub fn link_ids(&self) -> &[String] {
        &self.link_ids
    }
    pub async fn check(&self) -> Result<()> {
        if self.project.contains_folder(&self.worktree).await? {
            Ok(())
        } else {
            Err("Linked Worktree is no longer active.".into())
        }
    }
}
impl Snapshot {
    /// Canvas Link scope from fresh registered identities/active Worktrees. The
    /// pure links helpers alone never mint this capability.
    pub async fn reachable(
        &self,
        source: &ProjectGrant,
        worktree: &Path,
    ) -> Result<Vec<LinkedGrant>> {
        self.check()?;
        if source.snapshot.fingerprint != self.fingerprint
            || source.snapshot.registry.profile != self.registry.profile
        {
            return Err("Project capability belongs to another registry snapshot.".into());
        }
        if !source.contains_folder(worktree).await? {
            return Err("Source Worktree is not active in the admitted Project.".into());
        }
        let worktree = self.registry.contained(worktree)?;
        let source_id = source.identity()["id"].as_str().unwrap();
        let relevant = self.data["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| {
                link["a"]["project_id"] == source_id || link["b"]["project_id"] == source_id
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut ids = BTreeSet::from([source_id.to_owned()]);
        for link in &relevant {
            for endpoint in [&link["a"], &link["b"]] {
                if let Some(id) = endpoint["project_id"].as_str() {
                    ids.insert(id.into());
                }
            }
        }
        if ids.len() > 64 {
            return Err("Linked Project inspection limit exceeded.".into());
        }
        let mut active = json!({});
        let mut admitted = std::collections::BTreeMap::new();
        for id in ids {
            let entry = self.data["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["id"] == id);
            let Some(entry) = entry else { continue };
            let grant = match self.project(entry["path"].as_str().unwrap()).await {
                Ok(grant) => grant,
                Err(_) => continue,
            };
            active[&id] = json!(grant
                .worktrees()
                .iter()
                .map(|worktree| &worktree["path"])
                .collect::<Vec<_>>());
            admitted.insert(id, grant);
        }
        let links = links::prune(
            &relevant,
            self.data["projects"].as_array().unwrap(),
            &active,
        );
        let reached = links::linked_worktrees(
            &json!({"project_id":source_id,"worktree_path":worktree}),
            &links,
            &active,
        )?;
        let mut grants = Vec::new();
        for target in reached {
            let Some(project) = admitted.get(target["project_id"].as_str().unwrap()) else {
                continue;
            };
            let ids = target["link_ids"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            grants.push(LinkedGrant {
                project: project.clone(),
                worktree: PathBuf::from(target["worktree_path"].as_str().unwrap()),
                link_ids: ids,
            });
        }
        self.check()?;
        Ok(grants)
    }
}
