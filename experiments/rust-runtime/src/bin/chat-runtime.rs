//! Explicit dedicated-root Chat backend. No production profile/socket or ambient provider discovery.
use std::{
    io::{self, Write},
    sync::Arc,
    time::Duration,
};

/// A startup refusal is an informational first line from this exact child, not
/// endpoint authority. Never serialize arbitrary error messages or credentials.
fn startup_refusal(args: &[String], error: &(dyn std::error::Error + 'static)) -> Option<Vec<u8>> {
    let busy = error
        .downcast_ref::<milagre_owner_wire::RpcError>()
        .is_some_and(|error| error.code == "CHAT_ROOT_BUSY");
    let (code, message) = if busy {
        (
            "CHAT_ROOT_BUSY",
            "This dedicated Rust Chat data root is already running",
        )
    } else {
        (
            "CHAT_RUNTIME_START_FAILED",
            "The dedicated Rust Chat runtime could not start",
        )
    };
    let value = serde_json::json!({
        "protocolVersion":1,"pid":std::process::id(),"uid":unsafe { libc::geteuid() },
        "dataRoot":args.get(1),"startupError":{"code":code,"message":message}
    });
    let mut bytes = serde_json::to_vec(&value).ok()?;
    bytes.push(b'\n');
    (bytes.len() <= 4096).then_some(bytes)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let runtime = match milagre_rust_runtime::chat_runtime::start(&args) {
        Ok(runtime) => runtime,
        Err(error) => {
            if let Some(bytes) = startup_refusal(&args, error.as_ref()) {
                let mut stdout = io::stdout().lock();
                let _ = stdout.write_all(&bytes).and_then(|()| stdout.flush());
            }
            // main's diagnostic is deliberately fixed, too. The raw error can
            // contain account/install paths; it is not part of the child wire.
            return Err("CHAT_RUNTIME_START_FAILED".into());
        }
    };
    println!("{}", runtime.receipt);
    io::stdout().flush()?;
    milagre_rust_runtime::actor::stop_on_stdin(Arc::downgrade(&runtime.server));
    while !runtime.server.is_stopped() {
        std::thread::sleep(Duration::from_millis(20));
    }
    runtime.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_refusal_is_bounded_and_sanitizes_raw_errors() {
        let args = vec!["open".into(), "/explicit/dedicated".into()];
        for code in ["CHAT_ROOT_BUSY", "CHAT_RUNTIME_CONFIG", "OTHER"] {
            let error =
                milagre_owner_wire::RpcError::new(code, "secret-account-path should never be sent");
            let line = startup_refusal(&args, &error).unwrap();
            assert!(line.len() <= 4096 && line.ends_with(b"\n"));
            assert!(!String::from_utf8_lossy(&line).contains("secret-account-path"));
            let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
            assert_eq!(value["pid"], std::process::id());
            assert_eq!(value["dataRoot"], "/explicit/dedicated");
            assert_eq!(
                value["startupError"]["code"],
                if code == "CHAT_ROOT_BUSY" {
                    "CHAT_ROOT_BUSY"
                } else {
                    "CHAT_RUNTIME_START_FAILED"
                }
            );
        }
        let error = std::io::Error::other("do not expose this raw IO path");
        let line = startup_refusal(&args, &error).unwrap();
        assert!(!String::from_utf8_lossy(&line).contains("raw IO path"));
        let overlong = vec!["open".into(), "x".repeat(4096)];
        assert!(startup_refusal(&overlong, &error).is_none());
    }
}
