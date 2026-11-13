//! Authenticated write-ahead plans for this fresh copy only. No public path admission.
use crate::{AccountError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub(crate) const FILE: &str = ".preparation-journal.json";
pub(crate) const LIMIT: usize = 64 * 1024 * 1024;
const BAD: &str = "Isolated preparation journal is invalid or changed outside its owner.";
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Journal {
    pub version: u32,
    pub revision: u64,
    pub entries: BTreeMap<String, Entry>,
    pub links: BTreeMap<String, Link>,
    pub dirs: BTreeMap<String, Identity>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    pub tag: String,
    pub steps: Vec<Step>,
    pub next: usize,
    pub complete: bool,
    pub creation: Option<Creation>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Creation {
    pub account: serde_json::Value,
    pub publication: Publication,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Publication {
    Pending,
    Published,
    Removing,
    Removed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(crate) enum Step {
    Directory {
        path: Vec<String>,
    },
    File {
        path: Vec<String>,
        text: String,
    },
    Link {
        path: Vec<String>,
        source: Vec<String>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Link {
    pub target: Vec<String>,
    pub source: Identity,
    pub inode: Option<Identity>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    pub dev: u64,
    pub ino: u64,
}
impl Identity {
    pub fn of(meta: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
}
impl Step {
    pub fn path(&self) -> &[String] {
        match self {
            Self::Directory { path } | Self::File { path, .. } | Self::Link { path, .. } => path,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    body: String,
    mac: String,
}
pub(crate) fn encode(journal: &Journal, key: &[u8; 32]) -> Result<Vec<u8>> {
    let body = serde_json::to_string(journal).map_err(|_| AccountError(BAD))?;
    let mac = blake3::keyed_hash(key, body.as_bytes())
        .to_hex()
        .to_string();
    let result = serde_json::to_vec(&Envelope { body, mac }).map_err(|_| AccountError(BAD))?;
    if result.len() > LIMIT {
        return Err(AccountError(
            "Isolated preparation journal exceeds its size limit.",
        ));
    }
    Ok(result)
}
pub(crate) fn decode(bytes: &[u8], key: &[u8; 32]) -> Result<Journal> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| AccountError(BAD))?;
    let expected = blake3::keyed_hash(key, envelope.body.as_bytes());
    let supplied = blake3::Hash::from_hex(&envelope.mac).map_err(|_| AccountError(BAD))?;
    // Hash equality uses the crate's constant-time MAC comparison.
    if supplied != expected {
        return Err(AccountError(BAD));
    }
    let journal: Journal = serde_json::from_str(&envelope.body).map_err(|_| AccountError(BAD))?;
    if journal.version != 1 {
        return Err(AccountError(BAD));
    }
    for entry in journal.entries.values() {
        if entry.next > entry.steps.len() || (entry.complete && entry.next != entry.steps.len()) {
            return Err(AccountError(BAD));
        }
        for step in &entry.steps {
            valid(step.path())?;
            if let Step::Link { source, .. } = step {
                valid(source)?;
            }
            if let Step::File { text, .. } = step {
                if text.len() > 4 * 1024 * 1024 {
                    return Err(AccountError(BAD));
                }
            }
        }
    }
    for (path, link) in &journal.links {
        valid(&split(path))?;
        valid(&link.target)?;
    }
    for path in journal.dirs.keys() {
        valid(&split(path))?;
    }
    Ok(journal)
}
fn valid(path: &[String]) -> Result<()> {
    if path.is_empty()
        || !matches!(path[0].as_str(), "home" | "accounts")
        || path
            .iter()
            .any(|p| p.is_empty() || p == "." || p == ".." || p.contains('/') || p.contains('\0'))
    {
        return Err(AccountError(BAD));
    }
    Ok(())
}
pub(crate) fn split(path: &str) -> Vec<String> {
    path.split('/').map(str::to_owned).collect()
}
pub(crate) fn refs(path: &[String]) -> Vec<&str> {
    path.iter().map(String::as_str).collect()
}
pub(crate) fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}
pub(crate) fn directory(steps: &mut Vec<Step>, parts: &[&str]) {
    for depth in 1..=parts.len() {
        let p = path(&parts[..depth]);
        if !steps
            .iter()
            .any(|s| matches!(s,Step::Directory{path} if *path==p))
        {
            steps.push(Step::Directory { path: p });
        }
    }
}
pub(crate) fn file(steps: &mut Vec<Step>, parts: &[&str], name: &str, text: String) {
    directory(steps, parts);
    let mut p = path(parts);
    p.push(name.into());
    steps.push(Step::File { path: p, text });
}
pub(crate) fn link(steps: &mut Vec<Step>, at: &[&str], source: &[&str]) {
    directory(steps, source);
    directory(steps, &at[..at.len() - 1]);
    steps.push(Step::Link {
        path: path(at),
        source: path(source),
    });
}

#[cfg(not(test))]
pub(crate) fn checkpoint(_stage: &'static str) -> Result<()> {
    Ok(())
}
#[cfg(test)]
thread_local! {static FAULT:std::cell::RefCell<Fault>=std::cell::RefCell::new(Fault::default());}
#[cfg(test)]
#[derive(Default)]
struct Fault {
    at: Option<usize>,
    crash: bool,
    seen: Vec<&'static str>,
}
#[cfg(test)]
pub(crate) fn inject(at: Option<usize>, crash: bool) {
    FAULT.with(|f| {
        *f.borrow_mut() = Fault {
            at,
            crash,
            seen: Vec::new(),
        }
    });
}
#[cfg(test)]
pub(crate) fn stages() -> Vec<&'static str> {
    FAULT.with(|f| f.borrow().seen.clone())
}
#[cfg(test)]
pub(crate) fn checkpoint(stage: &'static str) -> Result<()> {
    FAULT.with(|f| {
        let mut f = f.borrow_mut();
        let index = f.seen.len();
        f.seen.push(stage);
        if f.at == Some(index) {
            if f.crash {
                unsafe { libc::_exit(72) }
            }
            return Err(AccountError("Injected isolated preparation interruption."));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication_and_path_validation_refuse_modified_journals() {
        let key = [1; 32];
        let journal = Journal {
            version: 1,
            ..Default::default()
        };
        let bytes = encode(&journal, &key).unwrap();
        assert!(decode(&bytes, &key).is_ok());
        assert!(decode(&bytes, &[2; 32]).is_err());
        let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
        envelope.body.push(' ');
        assert!(decode(&serde_json::to_vec(&envelope).unwrap(), &key).is_err());
        let mut invalid = journal;
        invalid
            .dirs
            .insert("home/../../outside".into(), Identity { dev: 1, ino: 1 });
        assert!(decode(&encode(&invalid, &key).unwrap(), &key).is_err());
    }
}
