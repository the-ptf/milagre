//! Node-format settings, serialized by the Profile command mutex. File access is relative to an
//! opened directory descriptor: symbolic links are never followed, including during replacement.
use milagre_owner_store::{jsjson, ownership::random_uuid, StoreError};
use milagre_owner_wire::{RpcError, RpcResult};
use serde_json::{json, Map, Value};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

pub const METHODS: &[&str] = &[
    "done:settings:read",
    "done:settings:save",
    "context:settings:read",
    "context:settings:save",
    "device-notes:read",
    "device-notes:save",
    "linked:remote-enabled:read",
    "linked:remote-enabled:save",
    "app-update:auto:read",
    "app-update:auto:save",
    "limits:auto-switch:read",
    "limits:auto-switch:save",
    "limits:resume-at-reset:read",
    "limits:resume-at-reset:save",
    "linear:enabled:read",
    "linear:enabled:save",
    "linear:move-to-started:save",
    "main-sync:default:read",
    "main-sync:default:save",
];
pub fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new("COMMAND_FAILED", message)
}
fn io(error: std::io::Error, op: &'static str, path: &Path) -> RpcError {
    let e = StoreError::io(error, op, path);
    RpcError::new(e.code().unwrap_or("COMMAND_FAILED"), e.to_string())
}
fn c(name: &str) -> CString {
    CString::new(name).expect("internal filename")
}
const MAX: u64 = 4 * 1024 * 1024;
pub type Active = std::sync::Arc<dyn Fn() -> Result<(), RpcError> + Send + Sync>;
pub struct Files {
    active: Option<Active>,
    dir: File,
    path: PathBuf,
}
impl Files {
    pub fn new(path: &Path) -> Result<Self, String> {
        let dir = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            active: None,
            dir,
            path: path.into(),
        })
    }
    pub fn set_owner_check(&mut self, active: Active) {
        self.active = Some(active);
    }
    fn check(&self) -> Result<(), RpcError> {
        if let Some(active) = &self.active {
            active()?;
        }
        let actual =
            std::fs::symlink_metadata(&self.path).map_err(|e| io(e, "lstat", &self.path))?;
        let held = self
            .dir
            .metadata()
            .map_err(|e| io(e, "fstat", &self.path))?;
        if !actual.is_dir() || actual.dev() != held.dev() || actual.ino() != held.ino() {
            return Err(failed("The settings directory was replaced."));
        }
        Ok(())
    }
    fn parent(&self, name: &str, create: bool) -> Result<(File, String), RpcError> {
        self.check()?;
        let (parent, leaf) = name.split_once('/').unwrap_or(("", name));
        if parent.is_empty() {
            return Ok((
                self.dir.try_clone().map_err(|e| io(e, "dup", &self.path))?,
                leaf.into(),
            ));
        }
        assert_eq!(parent, "linear");
        let name = c(parent);
        if create {
            let rc = unsafe { libc::mkdirat(self.dir.as_raw_fd(), name.as_ptr(), 0o700) };
            if rc < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(io(e, "mkdir", &self.path.join(parent)));
                }
            }
        }
        let fd = unsafe {
            libc::openat(
                self.dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io(
                std::io::Error::last_os_error(),
                "open",
                &self.path.join(parent),
            ));
        }
        let dir = unsafe { File::from_raw_fd(fd) };
        if create && unsafe { libc::fchmod(dir.as_raw_fd(), 0o700) } < 0 {
            return Err(io(
                std::io::Error::last_os_error(),
                "chmod",
                &self.path.join(parent),
            ));
        }
        Ok((dir, leaf.into()))
    }
    pub fn read(&self, name: &str) -> Result<Vec<u8>, RpcError> {
        let (dir, leaf) = self.parent(name, false)?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                c(&leaf).as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io(
                std::io::Error::last_os_error(),
                "open",
                &self.path.join(name),
            ));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file
            .metadata()
            .map_err(|e| io(e, "fstat", &self.path.join(name)))?;
        if !meta.is_file() || meta.len() > MAX {
            return Err(failed("Settings must be a regular file under 4 MiB."));
        }
        let mut bytes = Vec::new();
        file.take(MAX + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| io(e, "read", &self.path.join(name)))?;
        if bytes.len() as u64 > MAX {
            return Err(failed("Settings exceed 4 MiB."));
        }
        Ok(bytes)
    }
    pub fn value(&self, name: &str) -> Value {
        self.read(name)
            .ok()
            .and_then(|b| jsjson::parse_bytes(&b).ok())
            .unwrap_or(Value::Null)
    }
    pub fn write(&self, name: &str, bytes: &[u8], private: bool) -> Result<(), RpcError> {
        let (dir, leaf) = self.parent(name, true)?;
        // Refuse symlinks and special files even though rename would replace rather than follow them.
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        let rc = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                c(&leaf).as_ptr(),
                st.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if rc == 0 {
            let st = unsafe { st.assume_init() };
            if st.st_mode & libc::S_IFMT != libc::S_IFREG {
                return Err(failed("Settings target is not a regular file."));
            }
        } else {
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(io(e, "lstat", &self.path.join(name)));
            }
        }
        let temp = c(&format!("{leaf}.{}.tmp", random_uuid()));
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                temp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                if private { 0o600 } else { 0o666 },
            )
        };
        if fd < 0 {
            return Err(io(
                std::io::Error::last_os_error(),
                "open",
                &self.path.join(name),
            ));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            file.write_all(bytes)
                .map_err(|e| io(e, "write", &self.path.join(name)))?;
            self.check()?;
            if unsafe {
                libc::renameat(
                    dir.as_raw_fd(),
                    temp.as_ptr(),
                    dir.as_raw_fd(),
                    c(&leaf).as_ptr(),
                )
            } < 0
            {
                return Err(io(
                    std::io::Error::last_os_error(),
                    "rename",
                    &self.path.join(name),
                ));
            }
            Ok(())
        })();
        unsafe {
            libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0);
        }
        result
    }
    pub fn save(&self, name: &str, value: &Value, private: bool) -> Result<(), RpcError> {
        self.write(name, jsjson::to_string(value).as_bytes(), private)
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
    pub fn projects(&self, strict: bool) -> Result<Value, RpcError> {
        let value = match self.read("project-settings.json") {
            Ok(bytes) => jsjson::parse_bytes(&bytes).unwrap_or(Value::Null),
            Err(e) if !strict || e.code == "ENOENT" => Value::Null,
            Err(e) => return Err(e),
        };
        if value.is_object() && (value["projects"].is_object() || value["projects"].is_array()) {
            Ok(value)
        } else {
            Ok(json!({"projects":{}}))
        }
    }
    pub fn save_projects(&self, data: &Value) -> Result<(), RpcError> {
        self.write("project-settings.json", pretty(data, 0).as_bytes(), false)
    }
}
/// JSON.stringify(value, null, 2), including JS property order and number spelling.
pub fn pretty(value: &Value, depth: usize) -> String {
    let pad = "  ".repeat(depth + 1);
    let entries: Option<(char, char, Vec<String>)> = match value {
        Value::Object(map) if !map.is_empty() => Some((
            '{',
            '}',
            jsjson::js_entries(map)
                .into_iter()
                .map(|(k, v)| format!("{}: {}", jsjson::to_string(&json!(k)), pretty(v, depth + 1)))
                .collect(),
        )),
        Value::Array(list) if !list.is_empty() => Some((
            '[',
            ']',
            list.iter().map(|v| pretty(v, depth + 1)).collect(),
        )),
        _ => None,
    };
    match entries {
        Some((a, b, entries)) => format!(
            "{a}\n{pad}{}\n{}{b}",
            entries.join(&format!(",\n{pad}")),
            "  ".repeat(depth)
        ),
        None => jsjson::to_string(value),
    }
}
pub fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(list) => list
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => jsjson::to_utf16(s)
            .iter()
            .enumerate()
            .map(|(i, c)| (i.to_string(), json!(jsjson::from_utf16(&[*c]))))
            .collect(),
        _ => Map::new(),
    }
}
fn normalized(kind: &str, raw: &Value) -> Value {
    if kind == "done" {
        let n = raw["retentionHours"].as_f64();
        return json!({"retentionHours":n.filter(|n|[1.,8.,24.,72.,168.,0.].contains(n)).unwrap_or(24.)});
    }
    let percent = |key: &str, default: f64, min: f64, max: f64| {
        raw[key]
            .as_f64()
            .filter(|v| v.is_finite())
            .map(|v| (v + 0.5).floor())
            .unwrap_or(default)
            .clamp(min, max)
    };
    let button = percent("buttonThreshold", 70., 5., 90.);
    json!({"buttonThreshold":button,"autoThreshold":percent("autoThreshold",85.,button+5.,95.),"autoCompact":raw["autoCompact"]==true,"followUps":if raw["followUps"]=="queue" {"queue"} else {"now"}})
}
pub struct Settings {
    pub files: Files,
    device: bool,
    remote: bool,
}
impl Settings {
    pub fn new(path: &Path) -> Result<Self, String> {
        let files = Files::new(path)?;
        let device = files.value("device-notes.json")["enabled"] == true;
        let remote = files.value("remote-delegation.json")["enabled"] == true;
        Ok(Self {
            files,
            device,
            remote,
        })
    }
    pub fn call(
        &mut self,
        method: &str,
        args: &[Value],
    ) -> Result<(Value, Option<&'static str>), RpcError> {
        let save = method.ends_with(":save");
        let arg = args.first().unwrap_or(&Value::Null);
        if method.starts_with("done:") || method.starts_with("context:") {
            let (kind, file, event, label) = if method.starts_with("done:") {
                ("done", "done.json", "done:settings", "Done")
            } else {
                (
                    "context",
                    "context-settings.json",
                    "context:settings",
                    "Context",
                )
            };
            let mut value = normalized(kind, &self.files.value(file));
            if save {
                let patch = arg
                    .as_object()
                    .ok_or_else(|| failed(format!("{label} settings must be an object")))?;
                value.as_object_mut().unwrap().extend(patch.clone());
                value = normalized(kind, &value);
                self.files.save(file, &value, false)?;
            }
            return Ok((value, save.then_some(event)));
        }
        if method.starts_with("device-notes:") || method.starts_with("linked:") {
            let (file, event, label, current) = if method.starts_with("device-notes:") {
                (
                    "device-notes.json",
                    "device-notes:changed",
                    "Device notes",
                    &mut self.device,
                )
            } else {
                (
                    "remote-delegation.json",
                    "linked:remote-enabled-changed",
                    "Delegating to other computers",
                    &mut self.remote,
                )
            };
            if save {
                let enabled = arg
                    .as_bool()
                    .ok_or_else(|| failed(format!("{label} enabled must be a boolean.")))?;
                self.files.save(file, &json!({"enabled":enabled}), true)?;
                *current = enabled;
            }
            return Ok((json!({"enabled":*current}), save.then_some(event)));
        }
        if method.starts_with("main-sync:default:") {
            let mut data = self.files.projects(save)?;
            if save {
                let mut defaults = if data["defaults"].is_object() || data["defaults"].is_array() {
                    spread(&data["defaults"])
                } else {
                    Map::new()
                };
                defaults.insert("syncMain".into(), json!(arg == true));
                data["defaults"] = Value::Object(defaults);
                self.files.save_projects(&data)?;
            }
            return Ok((json!({"syncMain":data["defaults"]["syncMain"]==true}), None));
        }
        let (file, key, default, event, private) = match method {
            "app-update:auto:read" | "app-update:auto:save" => (
                "app-update.json",
                "autoUpdate",
                false,
                Some("app-update:auto"),
                false,
            ),
            "limits:auto-switch:read" | "limits:auto-switch:save" => {
                ("limit-switch.json", "autoSwitch", false, None, false)
            }
            "limits:resume-at-reset:read" | "limits:resume-at-reset:save" => {
                ("limit-switch.json", "resumeAtReset", true, None, false)
            }
            "linear:enabled:read" | "linear:enabled:save" => (
                "linear/settings.json",
                "enabled",
                false,
                Some("linear:enabled-changed"),
                true,
            ),
            "linear:move-to-started:save" => {
                ("linear/settings.json", "moveToStarted", true, None, true)
            }
            _ => return Err(failed(format!("Unknown command: {method}"))),
        };
        let mut raw = self.files.value(file);
        if save {
            let mut map = spread(&raw);
            map.insert(key.into(), json!(arg == true));
            raw = Value::Object(map);
            self.files.save(file, &raw, private)?;
        }
        let value = if default {
            raw[key] != false
        } else {
            raw[key] == true
        };
        let result = if method == "linear:enabled:read" {
            json!({"enabled":value,"moveToStarted":raw["moveToStarted"]!=false})
        } else {
            json!({key:value})
        };
        Ok((result, if save { event } else { None }))
    }
    pub fn update_project(&self, path: &str, key: &str, value: Option<Value>) -> RpcResult {
        let mut data = self.files.projects(true)?;
        let mut entry = spread(&data["projects"][path]);
        if let Some(v) = value {
            entry.insert(key.into(), v);
        } else {
            entry.shift_remove(key);
        }
        // JS arrays ignore named properties in JSON.stringify; preserve that behavior for malformed saved data.
        if let Some(projects) = data["projects"].as_object_mut() {
            if entry.is_empty() {
                projects.shift_remove(path);
            } else {
                projects.insert(path.into(), Value::Object(entry));
            }
        }
        self.files.save_projects(&data)?;
        Ok(data)
    }
    pub fn main_sync(&self, path: &str, branch: &str) -> RpcResult {
        let data = self.files.projects(false)?;
        let entry = &data["projects"][path];
        let over = entry["syncMain"].as_bool();
        let default = data["defaults"]["syncMain"] == true;
        let raw = &entry["mainSync"];
        let last = if raw["at"].is_number()
            && raw["branch"].is_string()
            && ["updated", "up-to-date", "skipped", "failed"]
                .iter()
                .any(|v| raw["outcome"] == *v)
        {
            let mut v = json!({"at":raw["at"],"outcome":raw["outcome"],"branch":raw["branch"]});
            for key in ["commit", "message"] {
                if raw[key].is_string() {
                    v[key] = raw[key].clone();
                }
            }
            v
        } else {
            Value::Null
        };
        Ok(
            json!({"branch":branch,"override":over,"defaultValue":default,"enabled":over.unwrap_or(default),"last":last}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_loss_after_staging_preserves_prior_bytes_and_cleans_temp() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("done.json"), b"old").unwrap();
        let mut files = Files::new(root.path()).unwrap();
        let checks = Arc::new(AtomicUsize::new(0));
        files.set_owner_check(Arc::new(move || {
            if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(RpcError::new("OWNERSHIP_LOST", "test owner replaced"))
            }
        }));
        assert!(files.write("done.json", b"new", false).is_err());
        assert_eq!(
            std::fs::read(root.path().join("done.json")).unwrap(),
            b"old"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn failed_cached_switch_save_does_not_change_memory_or_follow_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(root.path()).unwrap();
        let target = outside.path().join("device.json");
        std::fs::write(&target, b"unchanged").unwrap();
        std::os::unix::fs::symlink(&target, root.path().join("device-notes.json")).unwrap();
        assert!(settings.call("device-notes:save", &[json!(true)]).is_err());
        assert_eq!(
            settings.call("device-notes:read", &[]).unwrap().0,
            json!({"enabled":false})
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn linear_parent_symlink_is_refused_without_chmod_or_write() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::set_permissions(outside.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linear")).unwrap();
        let mut settings = Settings::new(root.path()).unwrap();
        assert!(settings
            .call("linear:enabled:save", &[json!(true)])
            .is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(
            std::fs::metadata(outside.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
    #[test]
    fn replaced_profile_is_refused_before_write() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        let mut settings = Settings::new(&profile).unwrap();
        std::fs::rename(&profile, root.path().join("old")).unwrap();
        std::fs::create_dir(&profile).unwrap();
        assert!(settings
            .call("done:settings:save", &[json!({"retentionHours":8})])
            .is_err());
        assert_eq!(std::fs::read_dir(&profile).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_dir(root.path().join("old")).unwrap().count(),
            0
        );
    }
    #[test]
    fn strict_project_read_never_overwrites_unreadable_settings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("project-settings.json")).unwrap();
        let settings = Settings::new(root.path()).unwrap();
        assert!(settings
            .update_project("/project", "hidden", Some(json!(true)))
            .is_err());
        assert!(root.path().join("project-settings.json").is_dir());
    }
}
