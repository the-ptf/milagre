//! Read-only GitHub PR details through an explicit owner-granted CLI/account.
//! No discovery, mutation, local fetch or production credential adoption.
mod normalize;
mod process;
mod selection;
pub use process::ReadMonitor;
pub use selection::{GithubSelectionOwner, Readiness, SelectionSnapshot};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub type Check = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub type LocalCommits = Arc<dyn Fn(&str, Instant) -> Result<u64, String> + Send + Sync>;
const DETAIL_QUERY: &str = include_str!("detail.graphql");
const FILES_QUERY: &str = include_str!("files.graphql");
const LIMIT: usize = 16 * 1024 * 1024;
/// Trusted owner inputs only. Never construct these fields from RPC arguments.
/// This crate has no global/default constructor and no production account lookup.
#[derive(Clone)]
pub struct CapturedContext {
    pub project: PathBuf,
    pub program: PathBuf,
    pub home: PathBuf,
    pub config_directory: PathBuf,
    pub owner: String,
    pub repository: String,
    pub account_login: String,
    pub path: String,
    pub computer_label: String,
    pub lifetime: Arc<dyn Send + Sync>,
    pub check: Check,
    /// Already confined to this Project by the owner. None is a failed/unavailable
    /// local count, which Node also represents by omitting localCommits.
    pub local_commits: Option<LocalCommits>,
}
type FilePin = (u64, u64, u32, u32, u64, i64, i64, i64, i64);
fn program_pin(path: &Path) -> Result<FilePin, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "Configured GitHub CLI is unavailable")?;
    if !path.is_absolute()
        || !m.is_file()
        || m.file_type().is_symlink()
        || m.mode() & 0o022 != 0
        || m.mode() & 0o111 == 0
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err("Configured GitHub CLI identity is invalid".into());
    }
    Ok((
        m.dev(),
        m.ino(),
        m.mode(),
        m.uid(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
fn segment(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        && s != "."
        && s != ".."
}
#[derive(Clone)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}
impl ServiceError {
    fn authority(message: impl Into<String>) -> Self {
        Self {
            code: "PR_SELECTION_REVOKED",
            message: message.into(),
        }
    }
    fn account(message: impl Into<String>) -> Self {
        Self {
            code: "PR_ACCOUNT_NOT_READY",
            message: message.into(),
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT",
            message: message.into(),
        }
    }
}
impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::fmt::Debug for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceError")
            .field("code", &self.code)
            .field("message", &self.message)
            .finish()
    }
}
impl std::error::Error for ServiceError {}
impl From<&str> for ServiceError {
    fn from(message: &str) -> Self {
        Self::invalid(message)
    }
}
impl From<String> for ServiceError {
    fn from(message: String) -> Self {
        Self::invalid(message)
    }
}
pub struct DetailsReader {
    context: CapturedContext,
    grant: selection::ReadGrant,
    serial: Mutex<()>,
    monitor: Arc<ReadMonitor>,
}
impl DetailsReader {
    fn from_grant(context: CapturedContext, grant: selection::ReadGrant) -> Self {
        Self {
            context,
            grant,
            serial: Mutex::new(()),
            monitor: Arc::new(ReadMonitor::default()),
        }
    }
    pub fn monitor(&self) -> Arc<ReadMonitor> {
        self.monitor.clone()
    }
    /// Revalidate the exact opaque selection before serialized result acceptance.
    pub fn validate_selection(&self) -> Result<(), ServiceError> {
        self.check()
    }
    fn check(&self) -> Result<(), ServiceError> {
        if self.monitor.cleanup_retained() {
            return Err(ServiceError {
                code: "PR_READ_CLEANUP_PENDING",
                message: "GitHub child cleanup remains retained".into(),
            });
        }
        self.grant.check()
    }
    /// Exact production `pr:detail` argument shape. The fixed repository and
    /// account come from CapturedContext, not from this request.
    pub fn invoke(&self, args: &[Value]) -> Result<Value, ServiceError> {
        self.check()?;
        let [arg] = args else {
            return Err("Expected one PR detail argument".into());
        };
        let object = arg.as_object().ok_or("Expected a PR detail object")?;
        if object
            .keys()
            .any(|k| !matches!(k.as_str(), "cwd" | "number"))
            || arg["cwd"].as_str() != self.context.project.to_str()
        {
            return Err("Choose the exact dedicated Project for PR details".into());
        }
        let raw_number = arg["number"]
            .as_f64()
            .ok_or("Expected a numeric PR number")?;
        if !raw_number.is_finite()
            || raw_number <= 0.
            || raw_number > 9_007_199_254_740_991.
            || raw_number.fract() != 0.
        {
            return Ok(json!({"ok":false,"message":"That isn't a PR number."}));
        }
        let number = raw_number as u64;
        // Do not enqueue arbitrary numbers of synchronous network requests.
        let _guard = self
            .serial
            .try_lock()
            .map_err(|_| "Another GitHub detail read is active")?;
        let result = self.read(number);
        self.check()?;
        match result {
            Ok(pr) => Ok(json!({"ok":true,"pr":pr})),
            Err(ReadError::Remote(message)) => Ok(json!({"ok":false,"message":message})),
            Err(ReadError::Denied(error)) => Err(error),
        }
    }
    fn query(
        &self,
        query: &str,
        number: u64,
        after: Option<&str>,
        deadline: Instant,
        budget: &mut usize,
    ) -> Result<Value, ReadError> {
        self.check().map_err(ReadError::Denied)?;
        if Instant::now() >= deadline {
            return Err(ReadError::Remote("GitHub read timed out".into()));
        }
        // The actual account that serves every page is part of the response.
        let authenticated_query = query.replacen('{', "{ viewer { login } ", 1);
        let mut command = Command::new(&self.context.program);
        command
            .current_dir(&self.context.project)
            .env_clear()
            .env("HOME", &self.context.home)
            .env("GH_CONFIG_DIR", &self.context.config_directory)
            .env("PATH", &self.context.path)
            .env("GH_HOST", "github.com")
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_BROWSER", "false")
            .env("NO_COLOR", "1")
            .env("LANG", "en_US.UTF-8")
            .args([
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "-f",
                &format!("owner={}", self.context.owner),
                "-f",
                &format!("name={}", self.context.repository),
                "-f",
                &format!("query={authenticated_query}"),
                "-F",
                &format!("number={number}"),
            ]);
        if let Some(cursor) = after {
            command.args(["-f", &format!("after={cursor}")]);
        }
        let output = process::run(
            command,
            deadline,
            LIMIT,
            self.context.lifetime.clone(),
            self.monitor.clone(),
            &|| self.check().map_err(|e| e.to_string()),
        )
        .map_err(|message| {
            if let Err(authority) = self.check() {
                ReadError::Denied(authority)
            } else {
                ReadError::Remote(message)
            }
        })?;
        *budget = budget
            .checked_sub(output.stdout.len() + output.stderr.len())
            .ok_or_else(|| {
                ReadError::Remote("GitHub detail response exceeded the aggregate bound".into())
            })?;
        self.check().map_err(ReadError::Denied)?;
        let parsed = milagre_owner_store::jsjson::parse(
            std::str::from_utf8(&output.stdout)
                .map_err(|_| ReadError::Remote("GitHub returned invalid UTF-8".into()))?,
        );
        if output.status.code() == Some(4) {
            return Err(ReadError::Denied(
                self.grant
                    .deny_account("The selected GitHub account is not authenticated"),
            ));
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        let graphql_message = parsed
            .as_ref()
            .ok()
            .and_then(|v| v["errors"][0]["message"].as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if [
            "gh auth login",
            "not logged in",
            "authentication required",
            "requires authentication",
            "http 401",
            "bad credentials",
        ]
        .iter()
        .any(|s| stderr.contains(s) || graphql_message.contains(s))
        {
            return Err(ReadError::Denied(
                self.grant
                    .deny_account("The selected GitHub account is not authenticated"),
            ));
        }
        if let Ok(value) = &parsed {
            if output.status.success() {
                self.grant
                    .observed(&value["data"])
                    .map_err(ReadError::Denied)?;
            }
            if value["errors"].as_array().is_some_and(|v| !v.is_empty()) {
                return Err(ReadError::Remote(
                    value["errors"][0]["message"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .unwrap_or("GitHub didn't answer.")
                        .into(),
                ));
            }
        }
        if !output.status.success() {
            let raw = String::from_utf8_lossy(&output.stderr);
            let raw = raw.trim();
            if ["gh auth login", "not logged in", "authentication required"]
                .iter()
                .any(|s| raw.to_ascii_lowercase().contains(s))
            {
                return Err(ReadError::Denied(
                    self.grant
                        .deny_account("The selected GitHub account is not authenticated"),
                ));
            }
            let line = raw
                .lines()
                .find(|s| !s.is_empty())
                .unwrap_or("GitHub didn't answer.");
            let line = line
                .strip_prefix("gh: ")
                .or_else(|| line.strip_prefix("GraphQL: "))
                .unwrap_or(line);
            return Err(ReadError::Remote(line.chars().take(400).collect()));
        }
        parsed
            .map(|v| v["data"].clone())
            .map_err(|_| ReadError::Remote("GitHub returned malformed JSON".into()))
    }
    fn read(&self, number: u64) -> Result<Value, ReadError> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut budget = 32 * 1024 * 1024;
        let data = self.query(DETAIL_QUERY, number, None, deadline, &mut budget)?;
        let pr = &data["repository"]["pullRequest"];
        if pr.is_null() {
            return Err(ReadError::Remote(format!(
                "PR #{number} isn't in this repository."
            )));
        }
        if !pr.is_object() || pr["number"].as_u64() != Some(number) {
            return Err(ReadError::Remote(
                "GitHub returned malformed PR details".into(),
            ));
        }
        let mut files = normal_files(&pr["files"]);
        let mut page = pr["files"]["pageInfo"].clone();
        for _ in 1..30 {
            if page["hasNextPage"] != true {
                break;
            }
            let Some(after) = page["endCursor"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 8192)
            else {
                return Err(ReadError::Remote(
                    "GitHub returned an invalid file cursor".into(),
                ));
            };
            let data = self.query(FILES_QUERY, number, Some(after), deadline, &mut budget)?;
            let next = &data["repository"]["pullRequest"]["files"];
            files.extend(normal_files(next));
            page = next["pageInfo"].clone();
        }
        // Unlike Node, never silently present a truncated file list as complete.
        if page["hasNextPage"] == true {
            return Err(ReadError::Remote(
                "This PR exceeds the 3000-file detail limit".into(),
            ));
        }
        let mut detail = normalize::detail(pr, files);
        if detail["state"] == "OPEN" {
            let head = detail["headRefOid"].as_str().unwrap_or("");
            if head.len() == 40
                && head
                    .bytes()
                    .all(|c| c.is_ascii_digit() || b"abcdef".contains(&c))
            {
                if let Some(counter) = &self.context.local_commits {
                    self.check().map_err(ReadError::Denied)?;
                    if let Ok(n) = counter(head, deadline) {
                        if n > 0 && n <= 9_007_199_254_740_991 {
                            detail["localCommits"] = json!(n);
                        }
                    }
                }
            }
        }
        self.check().map_err(ReadError::Denied)?;
        if Instant::now() >= deadline {
            return Err(ReadError::Remote("GitHub detail read timed out".into()));
        }
        Ok(detail)
    }
}
fn normal_files(files: &Value) -> Vec<Value> {
    files["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| milagre_owner_store::jsjson::truthy(Some(v)))
        .map(normalize::file)
        .collect()
}
enum ReadError {
    Remote(String),
    Denied(ServiceError),
}
