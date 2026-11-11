use serde_json::{json, Value};
use std::{fmt, io};

#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self::coded("CONTENT_ERROR", message)
    }
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn value(&self) -> Value {
        json!({"code":self.code,"message":self.message})
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
