//! Shared UI copy after `packages/shared/src/model-copy.ts` and `approval-copy.ts`, plus [`js`], the JavaScript
//! semantics the other ports in `src/logic/{prs,usage,prompts,activity,files}` lean on.

pub mod approval;
pub mod js;
pub mod model_copy;

#[cfg(test)]
pub(crate) mod source {
    //! Reads a TypeScript source from `packages/shared/src` so a test can fail when a ported table drifts.
    //! Returns `None` when the crate is checked out without the rest of the repository.

    pub fn shared(file: &str) -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/shared/src").join(file);
        std::fs::read_to_string(path).ok()
    }

    /// The `key: "value"` pairs (one per line, in order) of the object literal that starts at `start` and ends at
    /// the first line that begins with `}`.
    pub fn string_pairs(source: &str, start: &str) -> Vec<(String, String)> {
        let body = source.split(start).nth(1).unwrap_or_else(|| panic!("`{start}` not found in the TypeScript source"));
        let mut pairs = Vec::new();
        for line in body.lines().skip(1) {
            if line.starts_with('}') {
                break;
            }
            let line = line.trim();
            let Some((key, rest)) = line.split_once(": \"") else { continue };
            let Some(value) = rest.strip_suffix("\",") else { continue };
            pairs.push((key.trim_matches('"').to_string(), value.to_string()));
        }
        pairs
    }
}
