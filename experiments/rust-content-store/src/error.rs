use serde_json::{json, Value};
use std::{fmt, io};

#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub issues: Option<Box<Value>>,
    pub diagnostics: Option<Box<Value>>,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self::coded("CONTENT_ERROR", message)
    }
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            issues: None,
            diagnostics: None,
        }
    }
    pub fn at(message: impl Into<String>, path: &[Value]) -> Self {
        let mut error = Self::new(message);
        error.issues = Some(Box::new(json!([{"path":path,"message":error.message}])));
        error
    }
    pub fn value(&self) -> Value {
        let mut value = json!({"code":self.code,"message":self.message});
        if let Some(issues) = &self.issues {
            value["issues"] = issues.as_ref().clone();
        }
        if let Some(diagnostics) = &self.diagnostics {
            value["diagnostics"] = diagnostics.as_ref().clone();
        }
        value
    }
    pub fn missing(&self) -> bool {
        self.code == "ENOENT"
    }
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::coded(
            if error.kind() == io::ErrorKind::NotFound {
                "ENOENT"
            } else {
                "IO_ERROR"
            },
            error.to_string(),
        )
    }
}
pub type Result<T> = std::result::Result<T, Error>;
