#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    UnsupportedPlatform,
    Busy,
    Bounds,
    Artifact,
    Identity,
    Revoked,
    Spawn,
    Protocol,
    Deadline,
    WorkerPanic,
    CleanupUncertain,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixtureCase {
    Ready,
    IgnoreCancel,
}
/// Parent-validated native-child evidence. Digests describe input and the pinned copy,
/// not a production executable authorization or an immutable execution proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Execution {
    pub compiled_identity: &'static str,
    pub pid: u32,
    pub cwd_device: u64,
    pub cwd_inode: u64,
    pub nonce: String,
    pub frame_bytes: usize,
    pub frame_sha256: String,
    pub text_bytes: usize,
    pub text_sha256: String,
    pub parent_artifact_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub result: Result<Execution, Error>,
    pub reaped: bool,
    pub exit_code: Option<i32>,
    pub resources_removed: bool,
}
