//! Account selection, environment plans and Unix isolated-copy metadata persistence.
//! No live profile, credential, process or login operations.
#[cfg(unix)]
mod service;
#[cfg(unix)]
mod store;
use serde_json::{json, Map, Value};
#[cfg(unix)]
pub use service::{
    AccountEvent, AccountService, Availability, IdentityState, Observation, PendingCreation,
    Readiness,
};
use std::{
    collections::BTreeMap,
    fmt,
    path::{Component, Path, PathBuf},
};
#[cfg(unix)]
pub use store::AccountSandbox;

pub const PROVIDERS: [&str; 4] = ["codex", "claude", "antigravity", "kiro"];
pub const READ_ERROR: &str =
    "Could not read saved accounts. Restore accounts/accounts.json before switching accounts.";
pub const MISSING_ACCOUNT: &str = "Account not found. Refresh and try again.";
pub const AMBIENT_ENV: [&str; 17] = [
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
pub type Result<T> = std::result::Result<T, AccountError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountError(pub &'static str);
impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for AccountError {}
fn provider_check(provider: &str) -> Result<()> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(AccountError("Unknown account provider."))
    }
}
fn account_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
}
fn bare(key: &str) -> &str {
    if let Some((computer, rest)) = key.split_once('|') {
        if !computer.is_empty()
            && computer.len() <= 64
            && computer != "local"
            && computer
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return rest;
        }
    }
    key
}
/// Matches shared/chat-scopes on POSIX and Windows Project keys, including remote qualifiers.
pub fn valid_scope(key: &str) -> Result<()> {
    let valid = if let Some(link) = key.strip_prefix("milagre-link:") {
        let groups: Vec<_> = bare(link).split('-').collect();
        groups.len() == 5
            && groups
                .iter()
                .zip([8, 4, 4, 4, 12])
                .all(|(s, n)| s.len() == n && s.bytes().all(|c| c.is_ascii_hexdigit()))
    } else {
        let s = bare(key).as_bytes();
        s.first() == Some(&b'/')
            || (s.len() >= 3
                && s[0].is_ascii_alphabetic()
                && s[1] == b':'
                && (s[2] == b'/' || s[2] == b'\\'))
    };
    if valid {
        Ok(())
    } else {
        Err(AccountError("Choose a valid Project or Link."))
    }
}

#[derive(Clone, Debug)]
pub struct Accounts {
    saved: Value,
}
impl Default for Accounts {
    fn default() -> Self {
        Self {
            saved: json!({"scopes": {}, "accounts": [], "selected": PROVIDERS.into_iter().map(|p|(p.to_owned(),json!("default"))).collect::<Map<_,_>>()}),
        }
    }
}
impl Accounts {
    /// `None` represents ENOENT only. A failed read must never be turned into `None`.
    pub fn parse(body: Option<&str>) -> Result<Self> {
        let Some(body) = body else {
            return Ok(Self::default());
        };
        let raw: Value = serde_json::from_str(body).map_err(|_| AccountError(READ_ERROR))?;
        Self::from_value(&raw).map_err(|_| AccountError(READ_ERROR))
    }
    fn from_value(raw: &Value) -> Result<Self> {
        let error = || AccountError(READ_ERROR);
        let entries = raw
            .get("accounts")
            .and_then(Value::as_array)
            .ok_or_else(error)?;
        // Restrict malformed selected values rather than relying on JS property coercion.
        let selected = raw
            .get("selected")
            .and_then(Value::as_object)
            .ok_or_else(error)?;
        let mut accounts = Vec::new();
        for a in entries {
            let provider = a
                .get("provider")
                .and_then(Value::as_str)
                .ok_or_else(error)?;
            let id = a.get("id").and_then(Value::as_str).ok_or_else(error)?;
            let label = a.get("label").and_then(Value::as_str).ok_or_else(error)?;
            if !PROVIDERS.contains(&provider)
                || !account_id(id)
                || accounts.iter().any(|a: &Value| a["id"] == id)
            {
                return Err(error());
            }
            accounts.push(json!({"id":id,"provider":provider,"label":label}));
        }
        let mut choices = Map::new();
        for p in PROVIDERS {
            let id = match selected.get(p) {
                None | Some(Value::Null) => "default",
                Some(v) => v.as_str().ok_or_else(error)?,
            };
            if id != "default" && !accounts.iter().any(|a| a["id"] == id && a["provider"] == p) {
                return Err(error());
            }
            choices.insert(p.into(), json!(id));
        }
        let empty = Map::new();
        let scopes = match raw.get("scopes") {
            None | Some(Value::Null) => &empty,
            Some(v) => v.as_object().ok_or_else(error)?,
        };
        for (scope, choices) in scopes {
            valid_scope(scope)?;
            for (p, id) in choices.as_object().ok_or_else(error)? {
                let id = id.as_str().ok_or_else(error)?;
                if !PROVIDERS.contains(&p.as_str()) || (id != "default" && !account_id(id)) {
                    return Err(error());
                }
            }
        }
        Ok(Self {
            saved: json!({"scopes": scopes,"accounts":accounts,"selected":choices}),
        })
    }
    pub fn saved(&self) -> &Value {
        &self.saved
    }
    pub fn account(&self, provider: &str, id: &str) -> Result<Value> {
        provider_check(provider)?;
        if id == "default" {
            return Ok(
                json!({"id":id,"provider":provider,"label":if provider == "antigravity" {"Default account"} else {"Connected CLI account"}}),
            );
        }
        self.saved["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["provider"] == provider && a["id"] == id)
            .cloned()
            .ok_or(AccountError(MISSING_ACCOUNT))
    }
    pub fn selected<'a>(&'a self, provider: &str, scope: Option<&str>) -> Result<&'a str> {
        provider_check(provider)?;
        if let Some(scope) = scope.filter(|s| !s.is_empty()) {
            valid_scope(scope)?;
            if let Some(id) = self.saved["scopes"]
                .get(scope)
                .and_then(|s| s.get(provider))
                .and_then(Value::as_str)
            {
                return Ok(id);
            }
        }
        Ok(self.saved["selected"][provider].as_str().unwrap())
    }
    /// Capture once per session/service. Later selection changes cannot change this value.
    pub fn pin(&self, scope: Option<&str>) -> Result<Selection> {
        let mut ids = BTreeMap::new();
        for p in PROVIDERS {
            ids.insert(p.into(), self.selected(p, scope)?.into());
        }
        Ok(Selection { ids })
    }
    pub fn snapshot(&self) -> Value {
        json!({"providers":PROVIDERS.map(|p| {
            let mut entries = vec![self.account(p,"default").unwrap()];
            entries.extend(self.saved["accounts"].as_array().unwrap().iter().filter(|a|a["provider"]==p).cloned());
            for a in &mut entries { a["state"] = json!("unknown"); }
            json!({"provider":p,"selectedId":self.saved["selected"][p],"accounts":entries})
        })})
    }
    /// Saved metadata only; it deliberately does not claim login/installation readiness.
    pub fn scope_snapshot(&self, scope: &str) -> Result<Value> {
        valid_scope(scope)?;
        let mut providers = Vec::new();
        for group in self.snapshot()["providers"].as_array().unwrap() {
            let p = group["provider"].as_str().unwrap();
            let effective = self.selected(p, Some(scope))?;
            let mut entries = group["accounts"].as_array().unwrap().clone();
            if !entries.iter().any(|a| a["id"] == effective) {
                entries.push(json!({"id":effective,"provider":p,"label":"Removed account","state":"error","missing":true,"message":"This assigned account was removed. Choose another account or use the computer default."}));
            }
            providers.push(json!({"provider":p,"accountId":self.saved["scopes"].get(scope).and_then(|v|v.get(p)).unwrap_or(&Value::Null),"effectiveId":effective,"defaultId":group["selectedId"],"accounts":entries}));
        }
        Ok(json!({"scopeKey":scope,"providers":providers}))
    }
    pub fn environment_plan(
        &self,
        provider: &str,
        selection: &Selection,
        context: &EnvironmentContext,
    ) -> Result<EnvironmentPlan> {
        self.environment_for_account(provider, selection.account_id(provider)?, context)
    }
    /// Explicit account operation, such as inspecting a selected row in Settings.
    /// Session launches must use `environment_plan` with their captured Selection.
    pub fn environment_for_account(
        &self,
        provider: &str,
        id: &str,
        context: &EnvironmentContext,
    ) -> Result<EnvironmentPlan> {
        self.account(provider, id)?;
        let mut env = context.env.clone();
        let mut preparation = Vec::new();
        if provider == "antigravity" {
            for name in AMBIENT_ENV {
                env.remove(name);
            }
            let directory = context.directory(provider, id)?;
            env.insert("GEMINI_HOME".into(), directory.clone());
            env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
            if id == "default" {
                preparation.push(Preparation::AntigravityDefault {
                    directory,
                    root: Path::new(&context.data_dir)
                        .join("accounts")
                        .to_string_lossy()
                        .into_owned(),
                    home: context.home.clone(),
                });
            }
        } else if id != "default" {
            let names: &[&str] = if provider == "codex" {
                &["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
            } else {
                &[
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                    "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_VERTEX",
                    "CLAUDE_CODE_USE_FOUNDRY",
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_PROFILE",
                ]
            };
            for name in names {
                env.insert((*name).into(), String::new());
            }
            if provider == "claude" {
                env.insert("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".into(), String::new());
            }
            let target = context.directory(provider, id)?;
            env.insert(
                if provider == "codex" {
                    "CODEX_HOME"
                } else {
                    "CLAUDE_CONFIG_DIR"
                }
                .into(),
                target.clone(),
            );
            preparation.push(Preparation::InheritMcp {
                provider: provider.into(),
                source: context.directory(provider, "default")?,
                target,
                home: context.home.clone(),
                config_dir_set: context
                    .env
                    .get("CLAUDE_CONFIG_DIR")
                    .is_some_and(|s| !s.is_empty()),
            });
        }
        Ok(EnvironmentPlan { env, preparation })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    ids: BTreeMap<String, String>,
}
impl Selection {
    pub fn account_id(&self, provider: &str) -> Result<&str> {
        provider_check(provider)?;
        Ok(&self.ids[provider])
    }
    pub fn value(&self) -> Value {
        Value::Object(
            PROVIDERS
                .into_iter()
                .map(|p| (p.into(), json!(self.ids[p])))
                .collect(),
        )
    }
}

#[derive(Clone)]
pub struct EnvironmentContext {
    pub data_dir: String,
    pub home: String,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}
impl fmt::Debug for EnvironmentContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "EnvironmentContext(<{} variables redacted>)",
            self.env.len()
        )
    }
}
impl EnvironmentContext {
    /// POSIX host path resolution. Scope keys themselves support Windows.
    pub fn directory(&self, provider: &str, id: &str) -> Result<String> {
        provider_check(provider)?;
        if id != "default" && !account_id(id) {
            return Err(AccountError(MISSING_ACCOUNT));
        }
        if !Path::new(&self.home).is_absolute()
            || !Path::new(&self.data_dir).is_absolute()
            || !Path::new(&self.cwd).is_absolute()
        {
            return Err(AccountError(
                "Account environment requires absolute home, data and working directories.",
            ));
        }
        let path = if provider == "antigravity" {
            Path::new(&self.data_dir)
                .join("accounts")
                .join(if id == "default" {
                    "antigravity-default"
                } else {
                    id
                })
        } else if provider == "kiro" {
            Path::new(&self.home).join(".kiro")
        } else if id != "default" {
            Path::new(&self.data_dir).join("accounts").join(id)
        } else {
            let key = if provider == "codex" {
                "CODEX_HOME"
            } else {
                "CLAUDE_CONFIG_DIR"
            };
            self.env
                .get(key)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| Path::new(&self.home).join(format!(".{provider}")))
        };
        let absolute = if path.is_absolute() {
            path
        } else {
            Path::new(&self.cwd).join(path)
        };
        let mut normalized = PathBuf::new();
        for part in absolute.components() {
            match part {
                Component::CurDir => {}
                Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized
            .to_str()
            .map(str::to_owned)
            .ok_or(AccountError("Account directory is not UTF-8."))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Preparation {
    AntigravityDefault {
        directory: String,
        root: String,
        home: String,
    },
    InheritMcp {
        provider: String,
        source: String,
        target: String,
        home: String,
        config_dir_set: bool,
    },
}
pub struct EnvironmentPlan {
    env: BTreeMap<String, String>,
    preparation: Vec<Preparation>,
}
impl fmt::Debug for EnvironmentPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "EnvironmentPlan(<{} variables redacted>, {} pending preparations)",
            self.env.len(),
            self.preparation.len()
        )
    }
}
impl EnvironmentPlan {
    pub fn preparation(&self) -> &[Preparation] {
        &self.preparation
    }
    /// The owner must perform every requested side effect before obtaining credentials.
    /// InheritMcp is best-effort in Node; a callback may explicitly accept its failure.
    pub fn prepare(
        self,
        mut apply: impl FnMut(&Preparation) -> Result<()>,
    ) -> Result<BTreeMap<String, String>> {
        for preparation in &self.preparation {
            apply(preparation)?;
        }
        Ok(self.env)
    }
}
