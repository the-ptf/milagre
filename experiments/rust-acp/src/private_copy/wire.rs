//! Closed native-fixture wire data shared with its dedicated binary, never a provider grant.
use serde::{Deserialize, Serialize};

pub const IDENTITY: &str = "milagre-native-acp-copy-fixture-v1";
pub const TEXT_LIMIT: usize = 64 * 1024;
pub const FRAME_LIMIT: usize = 512 * 1024;
pub const RECEIPT_LIMIT: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Prompt {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: PromptParams,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PromptParams {
    pub nonce: String,
    pub prompt: [Text; 1],
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Text {
    pub r#type: String,
    pub text: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeReceipt {
    pub identity: String,
    pub pid: u32,
    pub cwd_device: u64,
    pub cwd_inode: u64,
    pub nonce: String,
    pub frame_bytes: usize,
    pub frame_sha256: String,
    pub text_bytes: usize,
    pub text_sha256: String,
    pub isolated_environment: bool,
}
