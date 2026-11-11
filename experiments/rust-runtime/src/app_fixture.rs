//! Fresh in-process scripted app owner. No external root, executable, account or environment input.
#[path = "app_receipt.rs"]
mod receipt;
use milagre_accounts::Accounts;
use milagre_owner_store::{jsjson, Isolation};
use milagre_owner_wire::{RpcError, RpcResult, Server};
use milagre_registry::{
    writer::{RegistryCopy, Seeds, Writer},
    Snapshot,
};
pub use receipt::{bootstrap_receipt, MAX_BOOTSTRAP_BYTES};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

pub const METHODS: &[&str] = &[
    "project:read",
    "chat:runs",
    "project:recent",
    "project:known",
    "project:registry",
    "canvas:snapshot",
    "canvas:links",
    "link:list",
    "agent:models",
    "agent:cli-status",
    "accounts:list",
    "accounts:scope",
    "accounts:scopes",
];
pub fn start() -> Result<(Server, Value), RpcError> {
    crate::actor::start_app_fixture()
}
pub(crate) fn generated(project: &Path) -> Value {
    // Replacement happens in parsed strings, never by interpolating JSON syntax.
    fn replace(value: &mut Value, project: &str) {
        match value {
            Value::String(s) => *s = s.replace("$PROJECT", project),
            Value::Array(items) => {
                for v in items {
                    replace(v, project);
                }
            }
            Value::Object(items) => {
                for v in items.values_mut() {
                    replace(v, project);
                }
            }
            _ => {}
        }
    }
    let mut value: Value = serde_json::from_str(include_str!("../fixtures/app-bootstrap.json"))
        .expect("compiled fixture JSON");
    replace(&mut value, &project.to_string_lossy());
    value
}
fn error(message: impl ToString) -> RpcError {
    RpcError::new("FIXTURE_BOOTSTRAP_INVALID", message.to_string())
}
pub(crate) struct Bootstrap {
    copy: RegistryCopy,
    _writer: Writer,
    snapshot: Snapshot,
    recent: Value,
    accounts: Accounts,
    catalog: Value,
    status: Value,
}
impl Bootstrap {
    pub(crate) fn new(isolation: Isolation, project: &Path) -> Result<Self, RpcError> {
        let fixture = generated(project);
        let copy = RegistryCopy::create(
            isolation,
            Seeds {
                registry: Some(serde_json::to_vec(&fixture["registry"]).map_err(error)?),
                recent: Some(serde_json::to_vec(&fixture["recent"]).map_err(error)?),
            },
        )
        .map_err(error)?;
        let active = Arc::new(|| Ok(())); // Internal only; actor checks live Project readiness before every use.
        let writer = copy
            .writer(
                active.clone(),
                Arc::new(|| "2026-01-01T00:00:00.000Z".into()),
            )
            .map_err(error)?;
        let reader = copy.reader(active).map_err(error)?;
        let snapshot = reader.snapshot().map_err(error)?;
        let recent = reader.recent().map_err(error)?;
        Ok(Self {
            copy,
            _writer: writer,
            snapshot,
            recent,
            accounts: Accounts::parse(None).map_err(error)?,
            catalog: fixture["catalog"].clone(),
            status: fixture["status"].clone(),
        })
    }
    pub(crate) fn check(&self) -> Result<(), RpcError> {
        let reader = self.copy.reader(Arc::new(|| Ok(()))).map_err(error)?;
        self.snapshot.check().map_err(error)?;
        if reader.recent().map_err(error)? != self.recent {
            return Err(error("Fixture recent metadata changed"));
        }
        Ok(())
    }
    pub(crate) fn validate_send(&self, request: &Value) -> Result<(), RpcError> {
        self.check()?;
        let unsupported = || {
            RpcError::new("FIXTURE_UNSUPPORTED", "This fixture accepts only the advertised scripted text model and ordinary Ask mode")
        };
        if request["model"] != "scripted"
            || request
                .get("permissionMode")
                .is_some_and(|v| !v.is_null() && v != "ask")
            || ["images", "files"].iter().any(|key| {
                request
                    .get(*key)
                    .is_some_and(|v| !v.is_null() && !v.as_array().is_some_and(Vec::is_empty))
            })
            || ["effort", "replies"]
                .iter()
                .any(|key| request.get(*key).is_some_and(|v| !v.is_null()))
            || ["fastMode", "ultracode", "tldrEnabled"].iter().any(|key| {
                request
                    .get(*key)
                    .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
            })
        {
            return Err(unsupported());
        }
        let fields = [
            "projectPath",
            "sessionId",
            "worktreeId",
            "body",
            "prompt",
            "clientMessageId",
            "delivery",
            "provider",
            "model",
            "permissionMode",
            "images",
            "files",
            "effort",
            "replies",
            "fastMode",
            "ultracode",
            "tldrEnabled",
        ];
        if request
            .as_object()
            .is_none_or(|v| v.keys().any(|key| !fields.contains(&key.as_str())))
        {
            return Err(unsupported());
        }
        Ok(())
    }
    pub(crate) fn call(
        &self,
        method: &str,
        args: &[Value],
        project: &Path,
        state: Value,
    ) -> RpcResult {
        self.check()?;
        let scope = args.first().unwrap_or(&Value::Null);
        if matches!(
            method,
            "agent:models" | "agent:cli-status" | "accounts:scope"
        ) && !(scope.is_null() && method != "accounts:scope")
            && scope.as_str() != project.to_str()
        {
            return Err(RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Choose this generated Project",
            ));
        }
        if (method == "accounts:list"
            && args
                .first()
                .is_some_and(|v| v != &Value::Null && v != &json!(false)))
            || (method == "accounts:scope"
                && args
                    .get(1)
                    .is_some_and(|v| v != &Value::Null && v != &json!(false)))
        {
            return Err(RpcError::new("FIXTURE_UNSUPPORTED", "Account refresh requires a real account service; this fixture exposes saved metadata only"));
        }
        let registry = self.snapshot.value();
        let projects = &registry["projects"];
        match method {
            "project:registry" => Ok(projects.clone()),
            "project:recent" => Ok(self.recent.clone()),
            "project:known" => Ok(json!(projects.as_array().unwrap().iter().map(|p| json!({"path":p["path"],"name":p["name"],"openedAt":p["openedAt"]})).collect::<Vec<_>>())),
            "canvas:links" => Ok(registry["links"].clone()),
            "link:list" => Ok(registry["projectGroups"].clone()),
            "canvas:snapshot" => { let mut value=registry.clone(); value["states"]=json!([{"path":project,"state":state}]); Ok(value) },
            "agent:models" => Ok(self.catalog.clone()),
            "agent:cli-status" => Ok(self.status.clone()),
            "accounts:list" => Ok(self.accounts.snapshot()),
            "accounts:scope" => self.accounts.scope_snapshot(&jsjson::js_string(project.to_str().unwrap())).map_err(error),
            "accounts:scopes" => Ok(json!(projects.as_array().unwrap().iter().map(|p| json!({"key":p["path"],"name":p["name"],"kind":"project","projects":[{"id":p["id"],"path":p["path"],"name":p["name"]}]})).collect::<Vec<_>>())),
            _ => Err(RpcError::new("FIXTURE_UNSUPPORTED", "This fixture does not implement that service")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_store::Policy;
    use milagre_owner_wire::IsolatedProfile;
    #[test]
    fn registry_writer_is_exclusive_and_send_options_fail_closed() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("fixture")).unwrap();
        let bootstrap = Bootstrap::new(isolation, &project).unwrap();
        assert!(bootstrap
            .copy
            .writer(Arc::new(|| Ok(())), Arc::new(|| "unused".into()))
            .is_err());
        let base = json!({"model":"scripted","body":"hello","permissionMode":"ask","images":[],"files":[],"fastMode":false});
        bootstrap.validate_send(&base).unwrap();
        for (key, value) in [
            ("model", json!("real-model")),
            ("permissionMode", json!("full")),
            ("images", json!(["image"])),
            ("files", json!(["outside"])),
            ("effort", json!("high")),
            ("replies", json!(2)),
            ("fastMode", json!(true)),
            ("env", json!({})),
            ("cwd", json!("/tmp")),
        ] {
            let mut request = base.clone();
            request[key] = value;
            assert_eq!(
                bootstrap.validate_send(&request).unwrap_err().code,
                "FIXTURE_UNSUPPORTED"
            );
        }
    }
}
