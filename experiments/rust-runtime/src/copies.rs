use crate::{ProjectInfo, ReadBackend};
use milagre_owner_store::{
    chat_page, jsjson, PageOptions, ProjectReader, ProjectRepository, ProjectStore, StoreError,
};
use milagre_owner_wire::{IsolatedProfile, ProfileLease, RpcError, RpcResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
include!(concat!(env!("OUT_DIR"), "/fixtures.rs"));

pub struct SavedCopies {
    root: PathBuf,
    projects: Vec<ProjectInfo>,
    seals: BTreeMap<String, String>,
    _profile: ProfileLease,
}
impl SavedCopies {
    pub fn create(profile: &IsolatedProfile) -> Result<Self, RpcError> {
        let root = profile.path().join(".projects");
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        for (relative, bytes) in FILES {
            let file = root.join(relative);
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(file.parent().unwrap())?;
            write_new(&file, bytes)?;
        }
        // A larger recorded-state variant, derived from the inline legacy fixture in this fresh directory.
        // It tests real storage and wire paging, without constructing a pretend handler response.
        let large = root.join("large/.milagre");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&large)?;
        let mut state =
            jsjson::parse_bytes(&fs::read(root.join("legacy/.milagre/coordination.json"))?)
                .map_err(|error| RpcError::new("INVALID_FIXTURE", error))?;
        state["messages"][1]["body"] = Value::String("Saved Rust/Node paging 🦀\n".repeat(6000));
        write_new(
            &large.join("coordination.json"),
            jsjson::to_string(&state).as_bytes(),
        )?;
        let projects = ["alpha", "legacy", "surrogates", "large"]
            .map(|name| ProjectInfo {
                path: root.join(name).to_string_lossy().into_owned(),
                name: name.into(),
            })
            .to_vec();
        let mut seals = BTreeMap::new();
        for project in &projects {
            seals.insert(project.path.clone(), seal(Path::new(&project.path))?);
        }
        Ok(Self {
            root,
            projects,
            seals,
            _profile: profile.lease(),
        })
    }
    fn reader(&self, path: &str) -> Result<ProjectReader, RpcError> {
        let expected = self.seals.get(path).ok_or_else(|| {
            RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Only copied fixture Projects can be read",
            )
        })?;
        for directory in [self.root.as_path(), self.root.parent().unwrap()] {
            if !fs::symlink_metadata(directory)?.is_dir() {
                return Err(RpcError::new(
                    "UNSAFE_FIXTURE",
                    "Fixture ancestor directories cannot be symlinks",
                ));
            }
        }
        if &seal(Path::new(path))? != expected {
            return Err(RpcError::new(
                "FIXTURE_CHANGED",
                "The sealed fixture copy changed; start a new isolated runtime",
            ));
        }
        Ok(ProjectReader::new(ProjectStore::new(path)))
    }
}
fn write_new(file: &Path, bytes: &[u8]) -> Result<(), RpcError> {
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(file)?
        .write_all(bytes)?;
    Ok(())
}
fn seal(root: &Path) -> Result<String, RpcError> {
    fn walk(root: &Path, entry: &Path, digest: &mut Sha256) -> Result<(), RpcError> {
        let metadata = fs::symlink_metadata(entry)?;
        if metadata.file_type().is_symlink()
            || !(metadata.is_dir() || metadata.is_file())
            || (metadata.is_file() && metadata.nlink() != 1)
        {
            return Err(RpcError::new(
                "UNSAFE_FIXTURE",
                "Fixture copies must contain only private directories and regular, unlinked files",
            ));
        }
        digest.update(
            entry
                .strip_prefix(root)
                .unwrap()
                .as_os_str()
                .as_encoded_bytes(),
        );
        digest.update([0]);
        if metadata.is_dir() {
            let mut paths = fs::read_dir(entry)?
                .map(|e| e.map(|e| e.path()))
                .collect::<Result<Vec<PathBuf>, _>>()?;
            paths.sort();
            for path in paths {
                walk(root, &path, digest)?;
            }
        } else {
            digest.update(metadata.len().to_le_bytes());
            digest.update(fs::read(entry)?);
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    walk(root, root, &mut hash)?;
    Ok(hex::encode(hash.finalize()))
}
fn store_error(error: StoreError) -> RpcError {
    RpcError::new(error.code().unwrap_or("COMMAND_FAILED"), error.to_string())
}
impl ReadBackend for SavedCopies {
    fn projects(&self) -> Vec<ProjectInfo> {
        self.projects.clone()
    }
    fn state(&self, path: &str) -> RpcResult {
        self.reader(path)?
            .store()
            .read_project_state()
            .map(|read| read.state)
            .map_err(store_error)
    }
    fn messages(&self, path: &str, chat: i64, options: Option<&Value>, opened: bool) -> RpcResult {
        let reader = self.reader(path)?;
        let options = PageOptions::from_value(options);
        if opened {
            let state = reader
                .store()
                .read_project_state()
                .map_err(store_error)?
                .state;
            Ok(chat_page(
                state["messages"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                &Value::from(chat),
                &options,
            ))
        } else {
            reader.chat_messages(chat, &options).map_err(store_error)
        }
    }
    fn message(&self, path: &str, id: &Value) -> RpcResult {
        self.reader(path)?.chat_message(id).map_err(store_error)
    }
    fn send_status(&self, path: &str, identity: &str) -> RpcResult {
        self.reader(path)?
            .send_status(identity)
            .map_err(store_error)
    }
    fn has_database(&self, path: &str) -> Result<bool, RpcError> {
        Ok(self.reader(path)?.store().chats().exists())
    }
}
