//! A saved value of unknown shape (JavaScript's `unknown`: parsed JSON), for the `parse*` functions that read a
//! stored preference and fall back field by field. `serde` is not a dependency yet, so this is the minimum
//! those functions need.

#[derive(Clone, Debug, PartialEq)]
pub enum Raw {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Array(Vec<Raw>),
    /// Own enumerable properties in order.
    Object(Vec<(String, Raw)>),
}

impl Raw {
    /// The property `key` of an object; `None` for anything else or a missing key. When a key repeats, the
    /// last one wins, as in a JSON object.
    pub fn get(&self, key: &str) -> Option<&Raw> {
        match self {
            Raw::Object(fields) => fields.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Raw::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Raw::Number(value) => Some(*value),
            _ => None,
        }
    }

    /// `typeof value === "object"` and not null, not an array.
    pub fn is_plain_object(&self) -> bool {
        matches!(self, Raw::Object(_))
    }
}
