//! Read-only GitHub PR details through an explicit owner-granted CLI/account.
//! No discovery, mutation, local fetch or production credential adoption.
mod normalize;
mod process;
mod selection;
pub use process::ReadMonitor;
pub use selection::{GithubSelectionOwner, Readiness, SelectionSnapshot};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
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
/// One read in flight plus a few queued, one waiter set per PR number.
const MAX_JOBS: usize = 4;
/// Waiting callers across all jobs. The wire server bounds its handler threads;
/// this keeps a burst of identical reads from parking more than needed.
const MAX_WAITERS: usize = 64;
/// How often a waiting caller notices its own client going away.
const POLL: Duration = Duration::from_millis(10);

#[derive(Clone)]
enum ReadError {
    Remote(String),
    Denied(ServiceError),
}
type Reading = Result<Value, ReadError>;
enum Stage {
    Queued,
    Running,
    Done(Reading),
}
struct Job {
    id: u64,
    number: u64,
    waiters: usize,
    /// Set when the last waiter leaves: the running child is killed and reaped.
    cancel: Arc<AtomicBool>,
    stage: Stage,
}
#[derive(Default)]
struct Board {
    jobs: Vec<Job>,
    next: u64,
    /// A read (possibly already abandoned) still owns the single read slot.
    running: bool,
}
impl Board {
    /// Drop one waiter. The last one out cancels the job and removes it, so a
    /// later request for the same number starts fresh instead of joining it.
    fn withdraw(&mut self, id: u64) {
        let Some(index) = self.jobs.iter().position(|job| job.id == id) else {
            return;
        };
        let job = &mut self.jobs[index];
        job.waiters = job.waiters.saturating_sub(1);
        if job.waiters == 0 {
            job.cancel.store(true, Ordering::Release);
            self.jobs.remove(index);
        }
    }
}

pub struct DetailsReader {
    context: CapturedContext,
    grant: selection::ReadGrant,
    board: Mutex<Board>,
    wake: Condvar,
    paused: AtomicBool,
    monitor: Arc<ReadMonitor>,
}
impl DetailsReader {
    fn from_grant(context: CapturedContext, grant: selection::ReadGrant) -> Self {
        Self {
            context,
            grant,
            board: Mutex::new(Board::default()),
            wake: Condvar::new(),
            paused: AtomicBool::new(false),
            monitor: Arc::new(ReadMonitor::default()),
        }
    }
    pub fn monitor(&self) -> Arc<ReadMonitor> {
        self.monitor.clone()
    }
    /// Refuse new reads and cancel running ones, without touching the selection.
    /// A shutdown that is later refused calls `resume`.
    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
        self.wake.notify_all();
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
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
        if self.paused.load(Ordering::Acquire) {
            return Err(ServiceError::authority(
                "GitHub reads are paused while this runtime shuts down",
            ));
        }
        self.grant.check()
    }
    /// What Node says when gh is not signed in (`GH_LOGIN`).
    fn login_message(&self) -> String {
        format!(
            "Sign in to GitHub on {} with `gh auth login`, then try again.",
            self.context.computer_label
        )
    }
    /// Exact production `pr:detail` argument shape. The fixed repository and
    /// account come from CapturedContext, not from this request.
    pub fn invoke(&self, args: &[Value]) -> Result<Value, ServiceError> {
        self.invoke_cancellable(args, &|| false)
    }
    /// Like `invoke`, for a caller that can tell its client went away. Concurrent
    /// reads of one PR number join a single gh read and all get its result; other
    /// numbers queue behind it (a few at most, then `PR_READ_BUSY`). A caller
    /// whose client is gone stops waiting at once, and when nobody is left
    /// waiting for the running read its child is killed and reaped.
    pub fn invoke_cancellable(
        &self,
        args: &[Value],
        gone: &dyn Fn() -> bool,
    ) -> Result<Value, ServiceError> {
        // Idle: adopt account files a `gh auth login` rewrote since the last read.
        // Behind a read in flight, a changed file refuses that read instead.
        let idle = {
            let board = self.board.lock().map_err(|_| Self::poisoned())?;
            board.jobs.is_empty() && !board.running
        };
        if idle {
            self.grant.begin_read()?;
        }
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
        // Node's `number()`: anything but a positive safe integer is a result.
        let number = match arg["number"].as_f64() {
            Some(n)
                if n.is_finite() && n > 0. && n <= 9_007_199_254_740_991. && n.fract() == 0. =>
            {
                n as u64
            }
            _ => return Ok(json!({"ok":false,"message":"That isn't a PR number."})),
        };
        match self.join(number, gone)? {
            Ok(pr) => Ok(json!({"ok":true,"pr":pr})),
            Err(ReadError::Remote(message)) => Ok(json!({"ok":false,"message":message})),
            Err(ReadError::Denied(error)) => Err(error),
        }
    }
    fn busy() -> ServiceError {
        ServiceError {
            code: "PR_READ_BUSY",
            message: "Too many GitHub detail reads are waiting".into(),
        }
    }
    fn client_gone() -> ServiceError {
        ServiceError {
            code: "PR_READ_CANCELLED",
            message: "The client went away before the GitHub read finished".into(),
        }
    }
    fn poisoned() -> ServiceError {
        ServiceError::authority("GitHub read admission is unavailable")
    }
    /// Join the job for `number` (or start one) and wait for its result. The
    /// waiter at the head of the queue runs the read on its own thread.
    fn join(&self, number: u64, gone: &dyn Fn() -> bool) -> Result<Reading, ServiceError> {
        let mut board = self.board.lock().map_err(|_| Self::poisoned())?;
        let id = match board
            .jobs
            .iter_mut()
            .find(|j| j.number == number && !matches!(j.stage, Stage::Done(_)))
        {
            Some(job) => {
                job.waiters += 1;
                job.id
            }
            None => {
                let open = board
                    .jobs
                    .iter()
                    .filter(|j| !matches!(j.stage, Stage::Done(_)))
                    .count();
                if open >= MAX_JOBS {
                    return Err(Self::busy());
                }
                board.next += 1;
                let id = board.next;
                board.jobs.push(Job {
                    id,
                    number,
                    waiters: 1,
                    cancel: Arc::new(AtomicBool::new(false)),
                    stage: Stage::Queued,
                });
                id
            }
        };
        if board.jobs.iter().map(|j| j.waiters).sum::<usize>() > MAX_WAITERS {
            board.withdraw(id);
            return Err(Self::busy());
        }
        loop {
            let Some(index) = board.jobs.iter().position(|j| j.id == id) else {
                // Cancelled and removed while we were not looking.
                return Err(Self::client_gone());
            };
            if let Stage::Done(result) = &board.jobs[index].stage {
                let result = result.clone();
                board.withdraw(id);
                drop(board);
                // Authority is rechecked per caller before it accepts the result.
                self.check()?;
                return Ok(result);
            }
            if gone() {
                board.withdraw(id);
                drop(board);
                self.wake.notify_all();
                return Err(Self::client_gone());
            }
            let first_queued = board
                .jobs
                .iter()
                .find(|j| matches!(j.stage, Stage::Queued))
                .map(|j| j.id);
            if !board.running
                && first_queued == Some(id)
                && matches!(board.jobs[index].stage, Stage::Queued)
            {
                board.running = true;
                board.jobs[index].stage = Stage::Running;
                let cancel = board.jobs[index].cancel.clone();
                drop(board);
                let left = Cell::new(false);
                let reading = self.run_job(id, number, &cancel, &left, gone);
                board = self.board.lock().map_err(|_| Self::poisoned())?;
                board.running = false;
                if let Some(job) = board.jobs.iter_mut().find(|j| j.id == id) {
                    job.stage = Stage::Done(reading);
                }
                self.wake.notify_all();
                if left.get() {
                    // This caller already withdrew when its own client went away.
                    return Err(Self::client_gone());
                }
                continue;
            }
            board = self
                .wake
                .wait_timeout(board, POLL)
                .map_err(|_| Self::poisoned())?
                .0;
        }
    }
    /// The read itself, on the runner's thread. Cancelled when nobody waits for
    /// it any more, including when the runner's own client is the last to go.
    fn run_job(
        &self,
        id: u64,
        number: u64,
        cancel: &Arc<AtomicBool>,
        left: &Cell<bool>,
        gone: &dyn Fn() -> bool,
    ) -> Reading {
        struct Unwind<'a> {
            reader: &'a DetailsReader,
            id: u64,
            armed: bool,
        }
        impl Drop for Unwind<'_> {
            fn drop(&mut self) {
                if self.armed {
                    if let Ok(mut board) = self.reader.board.lock() {
                        board.running = false;
                        if let Some(job) = board.jobs.iter_mut().find(|j| j.id == self.id) {
                            job.stage = Stage::Done(Err(ReadError::Remote(
                                "The GitHub read failed unexpectedly".into(),
                            )));
                        }
                    }
                    self.reader.wake.notify_all();
                }
            }
        }
        let mut unwind = Unwind {
            reader: self,
            id,
            armed: true,
        };
        let stop = || -> bool {
            if !left.get() && gone() {
                left.set(true);
                if let Ok(mut board) = self.board.lock() {
                    board.withdraw(id);
                }
                self.wake.notify_all();
            }
            cancel.load(Ordering::Acquire)
        };
        let reading = self.read(number, &stop);
        unwind.armed = false;
        reading
    }
    fn query(
        &self,
        query: &str,
        number: u64,
        after: Option<&str>,
        deadline: Instant,
        budget: &mut usize,
        stop: &dyn Fn() -> bool,
    ) -> Result<Value, ReadError> {
        self.check().map_err(ReadError::Denied)?;
        if stop() {
            return Err(ReadError::Remote("The GitHub read was cancelled".into()));
        }
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
            &|| {
                if stop() {
                    return Err("The GitHub read was cancelled".into());
                }
                self.check().map_err(|e| e.to_string())
            },
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
        self.classify(&output)
    }
    /// Node's `graphql()` + `ghMessage()`: a successful exit carries data or the
    /// first GraphQL error; a failed exit is sign-in, GitHub's own error message,
    /// or the first line gh printed.
    fn classify(&self, output: &process::Output) -> Result<Value, ReadError> {
        if output.status.success() {
            let text = std::str::from_utf8(&output.stdout)
                .map_err(|_| ReadError::Remote("GitHub returned invalid UTF-8".into()))?;
            let value = milagre_owner_store::jsjson::parse(text)
                .map_err(|_| ReadError::Remote("GitHub returned malformed JSON".into()))?;
            if value["errors"].as_array().is_some_and(|v| !v.is_empty()) {
                return Err(ReadError::Remote(
                    first_error(&value).unwrap_or_else(|| "GitHub didn't answer.".into()),
                ));
            }
            self.grant
                .observed(&value["data"])
                .map_err(ReadError::Denied)?;
            return Ok(value["data"].clone());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lowered = stderr.to_lowercase();
        if output.status.code() == Some(4)
            || ["gh auth login", "not logged in", "authentication required"]
                .iter()
                .any(|s| lowered.contains(s))
        {
            self.grant.unready();
            return Err(ReadError::Remote(self.login_message()));
        }
        if let Some(message) = milagre_owner_store::jsjson::parse(&stdout)
            .ok()
            .and_then(|v| first_error(&v))
        {
            return Err(ReadError::Remote(message));
        }
        let source = if !stderr.is_empty() {
            stderr.as_ref()
        } else {
            stdout.as_ref()
        };
        // Node falls back to execFile's own "Command failed: gh api ..." text
        // here, which carries the whole argv; this says what it can without it.
        let line = source
            .trim()
            .split('\n')
            .find(|s| !s.is_empty())
            .unwrap_or("GitHub didn't answer.");
        let line = line
            .strip_prefix("gh: ")
            .or_else(|| line.strip_prefix("GraphQL: "))
            .unwrap_or(line);
        Err(ReadError::Remote(utf16_prefix(line, 400)))
    }
    fn read(&self, number: u64, stop: &dyn Fn() -> bool) -> Reading {
        // First page of a read: adopt rewritten account files (`gh auth login`).
        self.grant.begin_read().map_err(ReadError::Denied)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut budget = 32 * 1024 * 1024;
        let data = self.query(DETAIL_QUERY, number, None, deadline, &mut budget, stop)?;
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
        // Node's loop: at most FILE_PAGES (30) pages, stopping quietly at a page
        // with no next page or no usable cursor. A PR past that shows a partial
        // file list, exactly as in Node.
        for _ in 1..30 {
            if page["hasNextPage"] != true {
                break;
            }
            let Some(after) = page["endCursor"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 8192)
            else {
                break;
            };
            let data = self.query(
                FILES_QUERY,
                number,
                Some(after),
                deadline,
                &mut budget,
                stop,
            )?;
            let next = &data["repository"]["pullRequest"]["files"];
            files.extend(normal_files(next));
            page = next["pageInfo"].clone();
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
        if stop() {
            return Err(ReadError::Remote("The GitHub read was cancelled".into()));
        }
        if Instant::now() >= deadline {
            return Err(ReadError::Remote("GitHub detail read timed out".into()));
        }
        Ok(detail)
    }
}
/// `errors[0].message` when it is a non-empty string, as Node's `ghMessage` reads it.
fn first_error(value: &Value) -> Option<String> {
    value["errors"][0]["message"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
/// JavaScript's `slice(0, max)` counts UTF-16 units; never split a character.
fn utf16_prefix(text: &str, max: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect()
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
