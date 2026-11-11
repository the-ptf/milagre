//! Pure vendor launch shaping. No executable discovery, installs, files, profiles or login.
use std::collections::BTreeMap;
pub const KIRO_ARGS: &[&str] = &["acp", "--agent-engine", "v3"];
pub const SCRUBBED_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
];
#[derive(Debug, Clone, Copy)]
pub enum Platform {
    Mac,
    Linux,
    Windows,
}
pub fn antigravity_args(platform: Platform) -> Vec<String> {
    if matches!(platform, Platform::Linux) {
        vec!["--uid=".into()]
    } else {
        vec![]
    }
}
/// Explicit harness path avoids guessing cross-platform separators. Caller supplies private profile
/// and temporary directory values. This function only shapes strings; it does not create them.
pub fn antigravity_env(env: &BTreeMap<String, String>, harness: &str, tmpdir: &str, platform: Platform) -> BTreeMap<String, String> {
    let mut next = env.clone();
    for key in SCRUBBED_ENV {
        next.remove(*key);
    }
    if let Some(home) = env.get("GEMINI_HOME").filter(|v| !v.is_empty()) {
        next.insert("GEMINI_HOME".into(), home.clone());
    }
    next.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
    next.insert("PYTHONUNBUFFERED".into(), "1".into());
    next.insert("ANTIGRAVITY_HARNESS_PATH".into(), harness.into());
    next.insert("TMPDIR".into(), tmpdir.into());
    if matches!(platform, Platform::Windows) {
        next.insert("TEMP".into(), tmpdir.into());
        next.insert("TMP".into(), tmpdir.into());
    }
    next
}
