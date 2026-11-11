//! Pure, bounded patches consumed by the production `applyStatePatch` function.
//! This does not advertise state-patch capability or manage client versions.
use serde_json::{json, Map, Value};
use std::io::{self, Write};

/// Limits cover both input trees together. Errors require a whole-state/resync path;
/// they must never be published as an empty successful patch.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub depth: usize,
    pub input_nodes: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            depth: 4,
            input_nodes: 262_144,
            input_bytes: 32 * 1024 * 1024,
            output_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchError {
    InvalidLimits,
    InputLimit,
    OutputLimit,
    UnsupportedKey,
}

/// Returns None when the two JSON values are structurally equal in JavaScript.
/// Unlike JavaScript reference equality this may omit unchanged cloned subtrees.
/// Object iteration order and Node's array-replacement threshold are preserved.
pub fn diff(previous: &Value, next: &Value, limits: Limits) -> Result<Option<Value>, PatchError> {
    if limits.depth > 64
        || limits.input_nodes == 0
        || limits.input_nodes > 1_048_576
        || limits.input_bytes == 0
        || limits.input_bytes > 128 * 1024 * 1024
        || limits.output_bytes == 0
        || limits.output_bytes > 16 * 1024 * 1024
    {
        return Err(PatchError::InvalidLimits);
    }
    let mut budget = InputBudget { nodes: 0, bytes: 0 };
    budget.check(previous, 0, limits)?;
    budget.check(next, 0, limits)?;
    let patch = build(previous, next, limits.depth);
    if let Some(value) = &patch {
        let mut writer = BoundedWriter(limits.output_bytes);
        serde_json::to_writer(&mut writer, value).map_err(|_| PatchError::OutputLimit)?;
    }
    Ok(patch)
}

struct InputBudget {
    nodes: usize,
    bytes: usize,
}
impl InputBudget {
    fn charge(&mut self, bytes: usize, limits: Limits) -> Result<(), PatchError> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > limits.input_bytes {
            return Err(PatchError::InputLimit);
        }
        Ok(())
    }
    fn check(&mut self, value: &Value, depth: usize, limits: Limits) -> Result<(), PatchError> {
        self.nodes += 1;
        if depth > 128 || self.nodes > limits.input_nodes {
            return Err(PatchError::InputLimit);
        }
        self.charge(std::mem::size_of::<Value>(), limits)?;
        match value {
            Value::String(text) => self.charge(text.len(), limits)?,
            Value::Array(items) => {
                for item in items {
                    self.check(item, depth + 1, limits)?;
                }
            }
            Value::Object(items) => {
                for (key, item) in items {
                    // The production JS reducer assigns object keys. __proto__ would
                    // invoke its legacy setter instead of creating an own property.
                    if key == "__proto__" {
                        return Err(PatchError::UnsupportedKey);
                    }
                    self.charge(key.len() + std::mem::size_of::<String>(), limits)?;
                    self.check(item, depth + 1, limits)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn build(previous: &Value, next: &Value, depth: usize) -> Option<Value> {
    if same(previous, next) {
        return None;
    }
    if depth == 0 {
        return Some(json!({"v": next}));
    }
    match (previous, next) {
        (Value::Array(before), Value::Array(after)) => {
            let mut changed = Map::new();
            for (index, item) in after.iter().enumerate() {
                let patch = before
                    .get(index)
                    .map(|old| build(old, item, depth - 1))
                    .unwrap_or_else(|| Some(json!({"v": item})));
                if let Some(patch) = patch {
                    changed.insert(index.to_string(), patch);
                }
            }
            if changed.len() > after.len() / 2 && changed.len() > 8 {
                Some(json!({"v": next}))
            } else {
                Some(json!({"a": after.len(), "s": changed}))
            }
        }
        (Value::Object(before), Value::Object(after)) => {
            let mut changed = Map::new();
            for key in js_keys(after) {
                let item = &after[key];
                let patch = before
                    .get(key)
                    .map(|old| build(old, item, depth - 1))
                    .unwrap_or_else(|| Some(json!({"v": item})));
                if let Some(patch) = patch {
                    changed.insert(key.to_owned(), patch);
                }
            }
            let removed: Vec<_> = js_keys(before)
                .into_iter()
                .filter(|key| !after.contains_key(*key))
                .collect();
            Some(if removed.is_empty() {
                json!({"o": changed})
            } else {
                json!({"o": changed, "d": removed})
            })
        }
        _ => Some(json!({"v": next})),
    }
}

fn same(previous: &Value, next: &Value) -> bool {
    match (previous, next) {
        // JSON consumers use JavaScript doubles, including integer-looking numbers.
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => previous == next,
    }
}

// Object.keys orders canonical array indices first, then other insertion-order keys.
fn js_keys(object: &Map<String, Value>) -> Vec<&str> {
    let mut indices = Vec::new();
    let mut other = Vec::new();
    for key in object.keys() {
        match key.parse::<u32>() {
            Ok(index) if index != u32::MAX && index.to_string() == *key => {
                indices.push((index, key.as_str()))
            }
            _ => other.push(key.as_str()),
        }
    }
    indices.sort_unstable_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, key)| key)
        .chain(other)
        .collect()
}

struct BoundedWriter(usize);
impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| io::Error::other("patch limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_and_output_limits_fail_explicitly() {
        let before = json!({"nested": [1, 2, 3]});
        let after = json!({"nested": [2, 3, 4]});
        for limits in [
            Limits {
                input_nodes: 2,
                ..Limits::default()
            },
            Limits {
                input_bytes: 10,
                ..Limits::default()
            },
        ] {
            assert_eq!(diff(&before, &after, limits), Err(PatchError::InputLimit));
        }
        assert_eq!(
            diff(
                &before,
                &after,
                Limits {
                    output_bytes: 1,
                    ..Limits::default()
                }
            ),
            Err(PatchError::OutputLimit)
        );
        assert_eq!(
            diff(
                &before,
                &after,
                Limits {
                    depth: 65,
                    ..Limits::default()
                }
            ),
            Err(PatchError::InvalidLimits)
        );
        let mut deep = Value::Null;
        for _ in 0..130 {
            deep = json!([deep]);
        }
        assert_eq!(
            diff(&deep, &deep, Limits::default()),
            Err(PatchError::InputLimit)
        );
    }

    #[test]
    fn node_array_threshold_and_depth_boundary() {
        let before = json!([0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let after = json!([1, 1, 1, 1, 1, 1, 1, 1, 1]);
        assert_eq!(
            diff(&before, &after, Limits::default()).unwrap(),
            Some(json!({"v": after}))
        );
        assert_eq!(
            diff(&before, &json!([]), Limits::default()).unwrap(),
            Some(json!({"a": 0, "s": {}}))
        );
        assert_eq!(
            diff(
                &before,
                &after,
                Limits {
                    depth: 0,
                    ..Limits::default()
                }
            )
            .unwrap(),
            Some(json!({"v": after}))
        );
        assert_eq!(
            diff(&after, &after.clone(), Limits::default()).unwrap(),
            None
        );
        assert_eq!(
            diff(
                &json!({}),
                &json!({"__proto__": {"x": 1}}),
                Limits::default()
            ),
            Err(PatchError::UnsupportedKey)
        );
    }
}
