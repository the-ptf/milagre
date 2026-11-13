//! Registry/identity foundation and separate writer for explicitly isolated copies.
mod identity;
pub mod links;
pub mod scopes;
#[cfg(unix)]
pub mod writer;
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
/// Inspection evidence, never a filesystem grant. Errors are unverifiable and
/// must not be treated as either absence or outside-copy metadata.
#[derive(Clone, Debug)]
pub enum Probe {
    Present(Identity),
    Gone,
    Outside,
}
enum RecordProbe {
    Present(Identity),
    Gone,
    Outside,
    Mismatch,
}
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
    data: Arc<Value>,
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
fn foreign_absolute(path: &str) -> bool {
    let drive = path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(1) == Some(&b':')
        && matches!(path.as_bytes().get(2), Some(b'/' | b'\\'));
    let unc = path.strip_prefix("\\\\").is_some_and(|tail| {
        let mut parts = tail.split('\\');
        parts.next().is_some_and(|server| !server.is_empty())
            && parts.next().is_some_and(|share| !share.is_empty())
    });
    drive || unc
}
fn absolute(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| Path::new(s).is_absolute() || foreign_absolute(s))
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
            data: Arc::new(data),
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
    /// Scope classification does not inspect the contents of an outside path.
    fn outside(&self, requested: &Path) -> Result<bool> {
        self.check()?;
        if !requested.is_absolute() && requested.to_str().is_some_and(foreign_absolute) {
            return Ok(true);
        }
        if !requested.is_absolute() {
            return Err("An absolute registry path is required.".into());
        }
        let lexical_path = lexical(requested);
        let scoped_path = if !lexical_path.starts_with(self.isolation.root())
            || lexical_path == self.isolation.root()
        {
            // macOS /var and /private/var can name the same copied directory.
            // Resolve metadata only; an outside target's contents are never probed.
            match std::fs::canonicalize(requested) {
                Ok(actual)
                    if actual.starts_with(self.isolation.root())
                        && actual != self.isolation.root() =>
                {
                    actual
                }
                _ => return Ok(true),
            }
        } else {
            requested.to_owned()
        };
        let mut current = self.isolation.root().to_owned();
        for part in scoped_path
            .strip_prefix(self.isolation.root())
            .map_err(|_| "Path spelling is outside the isolated registry capability.")?
            .components()
        {
            current.push(part);
            match std::fs::symlink_metadata(&current) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    let target = std::fs::read_link(&current).map_err(error)?;
                    let target = lexical(&current.parent().unwrap().join(target));
                    if !target.starts_with(self.isolation.root()) || target == self.isolation.root()
                    {
                        return Ok(true);
                    }
                    let actual = std::fs::canonicalize(&current).map_err(error)?;
                    if !actual.starts_with(self.isolation.root()) || actual == self.isolation.root()
                    {
                        return Ok(true);
                    }
                }
                Ok(_) => {
                    if part == std::path::Component::ParentDir {
                        let actual = std::fs::canonicalize(&current).map_err(error)?;
                        if !actual.starts_with(self.isolation.root()) {
                            return Ok(true);
                        }
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        || e.kind() == std::io::ErrorKind::NotADirectory =>
                {
                    break
                }
                Err(e) => return Err(error(e)),
            }
        }
        Ok(false)
    }
    fn entry_outside(&self, entry: &Value) -> Result<bool> {
        Ok(self.outside(Path::new(
            entry["id"].as_str().ok_or("Invalid saved Project id.")?,
        ))? || self.outside(Path::new(
            entry["path"]
                .as_str()
                .ok_or("Invalid saved Project path.")?,
        ))?)
    }
    async fn inspect_saved(&self, entry: &Value) -> Result<RecordProbe> {
        if self.entry_outside(entry)? {
            return Ok(RecordProbe::Outside);
        }
        match self
            .probe(Path::new(entry["path"].as_str().unwrap()))
            .await?
        {
            Probe::Present(identity)
                if identity.value["id"] == entry["id"]
                    && identity.value["path"] == entry["path"] =>
            {
                Ok(RecordProbe::Present(identity))
            }
            Probe::Present(_) => Ok(RecordProbe::Mismatch),
            Probe::Gone => Ok(RecordProbe::Gone),
            Probe::Outside => Ok(RecordProbe::Outside),
        }
    }
    /// Only a missing component under the isolated root, with no preceding
    /// symlink or I/O failure, counts as absence. All uncertain probes are errors.
    fn definitely_gone(&self, requested: &Path) -> Result<bool> {
        self.check()?;
        let path = lexical(requested);
        // Never classify link/../x lexically: the kernel resolves the link first.
        if path != requested {
            return Ok(false);
        }
        let relative = path
            .strip_prefix(self.isolation.root())
            .map_err(|_| "Path is outside the isolated registry capability.")?;
        let mut current = self.isolation.root().to_owned();
        for part in relative.components() {
            current.push(part);
            match std::fs::symlink_metadata(&current) {
                Ok(meta) if meta.file_type().is_symlink() => return Ok(false),
                Ok(meta) if !meta.is_dir() => return Ok(true),
                Ok(_) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
                Err(e) => return Err(error(e)),
            }
        }
        Ok(false)
    }
    /// Present, definitely gone or outside this copy. Err is unverifiable and
    /// must abort mutation cleanup. Outside rows must be retained, never granted.
    pub async fn probe(&self, requested: impl AsRef<Path>) -> Result<Probe> {
        let path = requested.as_ref();
        if self.outside(path)? {
            return Ok(Probe::Outside);
        }
        let canonical = match std::fs::canonicalize(path) {
            Ok(canonical) => canonical,
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    || e.kind() == std::io::ErrorKind::NotADirectory =>
            {
                path.to_owned()
            }
            Err(e) => return Err(error(e)),
        };
        if self.definitely_gone(&canonical)? {
            return Ok(Probe::Gone);
        }
        self.identify(&canonical).await.map(Probe::Present)
    }
    /// runtime.cjs projectOrigin's `git remote get-url origin` for a Project whose identity is a verified Git checkout
    /// inside the copy, run in the main checkout with the same locked-down Git environment as identity probes (no global
    /// or system config, no hooks or fsmonitor, the isolation as discovery ceiling). `None` outside Git, without an
    /// origin, or when Git fails; an unverifiable identity is an error.
    pub async fn origin_url(&self, path: impl AsRef<Path>) -> Result<Option<String>> {
        let identity = self.identify(path).await?;
        if identity.value["git"] != Value::Bool(true) {
            return Ok(None);
        }
        let main = PathBuf::from(identity.value["path"].as_str().unwrap_or_default());
        Ok(identity::git(self, &main, &["remote", "get-url", "origin"])
            .await
            .ok())
    }
    /// Node resolveBase's branch name, using only a verified isolated Git checkout.
    pub async fn main_branch(&self, path: impl AsRef<Path>) -> Result<String> {
        let identity = self.identify(path).await?;
        if identity.value["git"] != true {
            return Ok("main".into());
        }
        let main = PathBuf::from(identity.value["path"].as_str().unwrap_or_default());
        if let Ok(head) = identity::git(
            self,
            &main,
            &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        )
        .await
        {
            let head = head.trim();
            if !head.is_empty() {
                return Ok(head
                    .strip_prefix("refs/remotes/origin/")
                    .unwrap_or(head)
                    .into());
            }
        }
        for name in ["main", "master"] {
            for reference in [
                format!("refs/heads/{name}"),
                format!("refs/remotes/origin/{name}"),
            ] {
                if identity::git(
                    self,
                    &main,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{reference}^{{commit}}"),
                    ],
                )
                .await
                .is_ok()
                {
                    return Ok(name.into());
                }
            }
        }
        Ok("main".into())
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
        let identity = match self.registry.probe(requested.as_ref()).await? {
            Probe::Present(identity) => identity,
            Probe::Gone => return Err("Project folder is unavailable.".into()),
            Probe::Outside => {
                return Err("Project is outside the isolated registry capability.".into())
            }
        };
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
        if !scopes::valid_link_id(&json!(id)) {
            return Err("Invalid Link id.".into());
        }
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
                Some(entry) => match self.registry.inspect_saved(entry).await? {
                    RecordProbe::Present(identity) => Some(ProjectGrant {
                        snapshot: self.clone(),
                        identity,
                    }),
                    RecordProbe::Gone | RecordProbe::Outside | RecordProbe::Mismatch => None,
                },
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
    source: ProjectGrant,
    source_worktree: PathBuf,
    project: ProjectGrant,
    worktree: PathBuf,
    link_ids: Vec<String>,
}
impl LinkedGrant {
    /// Target metadata only. This capability cannot become a ProjectGrant or
    /// authorize a second hop through Snapshot::reachable.
    /// ```compile_fail
    /// # use milagre_registry::{Snapshot, LinkedGrant};
    /// # async fn cannot_chain(snapshot: &Snapshot, linked: &LinkedGrant) {
    /// snapshot.reachable(linked, linked.worktree()).await;
    /// # }
    /// ```
    pub fn identity(&self) -> &Value {
        self.project.identity()
    }
    pub async fn contains_folder(&self, path: impl AsRef<Path>) -> Result<bool> {
        self.check().await?;
        Ok(self.project.snapshot.registry.contained(path.as_ref())? == self.worktree)
    }
    pub fn worktree(&self) -> &Path {
        &self.worktree
    }
    pub fn link_ids(&self) -> &[String] {
        &self.link_ids
    }
    pub async fn check(&self) -> Result<()> {
        let fresh = self
            .source
            .snapshot
            .reachable(&self.source, &self.source_worktree)
            .await?;
        if fresh.iter().any(|grant| {
            grant.identity() == self.identity()
                && grant.worktree == self.worktree
                && grant.link_ids == self.link_ids
        }) {
            Ok(())
        } else {
            Err("Linked scope or endpoint is no longer active.".into())
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
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.reachable_inner(source, worktree),
        )
        .await
        .map_err(|_| "Linked scope discovery timed out; retry with a fresh snapshot.".to_string())?
    }
    async fn reachable_inner(
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
        let mut scoped = Vec::new();
        for mut link in relevant {
            if !links::admitted_edge_shape(&link) {
                continue;
            }
            let mut outside = false;
            for side in ["a", "b"] {
                if let Some(id) = link[side]["project_id"].as_str() {
                    if self.registry.outside(Path::new(id))? {
                        outside = true;
                    }
                }
                if let Some(path) = link[side]["worktree_path"].as_str() {
                    if self.registry.outside(Path::new(path))? {
                        outside = true;
                    } else if !self.registry.definitely_gone(Path::new(path))? {
                        link[side]["worktree_path"] =
                            json!(self.registry.contained(Path::new(path))?);
                    }
                }
            }
            if outside {
                continue;
            }
            scoped.push(link);
        }
        let relevant = scoped;
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
            let grant = match self.registry.inspect_saved(entry).await? {
                RecordProbe::Present(identity) => ProjectGrant {
                    snapshot: self.clone(),
                    identity,
                },
                RecordProbe::Gone | RecordProbe::Outside | RecordProbe::Mismatch => continue,
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
                source: source.clone(),
                source_worktree: worktree.clone(),
                project: project.clone(),
                worktree: PathBuf::from(target["worktree_path"].as_str().unwrap()),
                link_ids: ids,
            });
        }
        self.check()?;
        Ok(grants)
    }
}
