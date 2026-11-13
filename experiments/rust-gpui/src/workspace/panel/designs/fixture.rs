//! The Chat's designs while there is no daemon: what `artifact:list` and `artifact:get` would return for four
//! designs, each with every version's document. `fixture/*.json` are `{ id, title, group?, versions: [document] }`;
//! every document passes the host's `validateDesignDocument` (`generate.mjs` runs it to build the parity vectors).

use std::sync::Arc;

use serde_json::Value;

use crate::logic::design_layout::DesignDocument;

/// One design and its versions (`ArtifactSummary` with the documents `artifact:get` returns per version).
#[derive(Clone, Debug)]
pub struct DesignArtifact {
    pub id: String,
    pub title: String,
    pub group: Option<String>,
    /// The oldest version kept (1 unless the host dropped older ones): version `n` is `versions[n - first]`.
    pub first: u32,
    pub versions: Vec<Arc<DesignDocument>>,
    /// Each version's document as the host stores it (the design page editor edits and saves these).
    pub sources: Vec<Arc<Value>>,
}

impl DesignArtifact {
    pub fn latest(&self) -> u32 {
        self.first + self.versions.len() as u32 - 1
    }

    pub fn version(&self, version: u32) -> Option<&Arc<DesignDocument>> {
        self.versions.get(version.checked_sub(self.first)? as usize)
    }

    /// A version's stored document.
    pub fn source(&self, version: u32) -> Option<&Arc<Value>> {
        self.sources.get(version.checked_sub(self.first)? as usize)
    }

    /// A design read from the host (`artifact:list`'s summary, `artifact:get`'s `document` per version): versions
    /// `first..` in order. Fails when a document does not read or there is none.
    pub fn from_documents(id: String, title: String, group: Option<String>, first: u32, documents: Vec<Value>) -> Result<Self, String> {
        let sources: Vec<Arc<Value>> = documents.into_iter().map(Arc::new).collect();
        let versions = sources.iter().map(|doc| DesignDocument::from_json(doc).map(Arc::new)).collect::<Result<Vec<_>, _>>()?;
        if versions.is_empty() {
            return Err("A design needs a version.".into());
        }
        Ok(Self { id, title, group, first: first.max(1), versions, sources })
    }

    /// Saves a document as the next version (what `artifact:apply` returns), and returns its number.
    pub fn push_version(&mut self, document: Value) -> Result<u32, String> {
        let parsed = DesignDocument::from_json(&document)?;
        self.versions.push(Arc::new(parsed));
        self.sources.push(Arc::new(document));
        Ok(self.latest())
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let sources: Vec<Arc<Value>> = value
            .get("versions")
            .and_then(Value::as_array)
            .ok_or("A fixture design needs versions.")?
            .iter()
            .cloned()
            .map(Arc::new)
            .collect();
        let versions = sources.iter().map(|doc| DesignDocument::from_json(doc).map(Arc::new)).collect::<Result<Vec<_>, _>>()?;
        if versions.is_empty() {
            return Err("A fixture design needs a version.".into());
        }
        Ok(Self {
            id: text("id").ok_or("A fixture design needs an id.")?,
            title: text("title").unwrap_or_default(),
            group: text("group"),
            first: 1,
            versions,
            sources,
        })
    }
}

const FIXTURES: [&str; 4] = [
    include_str!("fixture/welcome.json"),
    include_str!("fixture/sign-in.json"),
    include_str!("fixture/settings.json"),
    include_str!("fixture/empty-state.json"),
];

/// The Chat's designs in the order the agent showed them.
pub fn designs() -> Vec<DesignArtifact> {
    FIXTURES.iter().map(|json| DesignArtifact::from_json(json).expect("fixture designs are valid")).collect()
}
