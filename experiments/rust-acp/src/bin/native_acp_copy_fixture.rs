//! Closed native test executable. No discovery, shell, profile, file writes, descendants or network operations.
#[path = "../private_copy/wire.rs"]
mod wire;

#[cfg(target_os = "macos")]
fn main() {
    if run().is_err() {
        std::process::exit(2);
    }
}
#[cfg(not(target_os = "macos"))]
fn main() {
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn run() -> Result<(), ()> {
    use sha2::{Digest, Sha256};
    use std::{
        io::{BufRead, Write},
        os::unix::fs::MetadataExt,
    };
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args != ["acp", "--agent-engine", "v3"] {
        return Err(());
    }
    let case = std::env::var("MILAGRE_COPY_FIXTURE_CASE").map_err(|_| ())?;
    if !matches!(case.as_str(), "ready" | "ignore-cancel") {
        return Err(());
    }
    let allowed = ["HOME", "TMPDIR", "LANG", "LC_ALL", "MILAGRE_COPY_FIXTURE_CASE"];
    let cwd = std::fs::metadata(".").map_err(|_| ())?;
    let current = std::env::current_dir().map_err(|_| ())?;
    let root = current.parent().ok_or(())?;
    let isolated = std::env::vars_os().all(|(key, _)| allowed.iter().any(|name| key == *name))
        && std::env::var_os("HOME").as_deref() == Some(root.join("home").as_os_str())
        && std::env::var_os("TMPDIR").as_deref() == Some(root.join("tmp").as_os_str())
        && std::env::var("LANG").as_deref() == Ok("C")
        && std::env::var("LC_ALL").as_deref() == Ok("C");
    let mut input = std::io::stdin().lock();
    let mut line = Vec::new();
    loop {
        let chunk = input.fill_buf().map_err(|_| ())?;
        if chunk.is_empty() {
            return Err(());
        }
        let take = chunk.iter().position(|b| *b == b'\n').map_or(chunk.len(), |n| n + 1);
        if line.len() + take > wire::FRAME_LIMIT + 1 {
            return Err(());
        }
        let done = chunk.get(take - 1) == Some(&b'\n');
        line.extend_from_slice(&chunk[..take]);
        input.consume(take);
        if done {
            line.pop();
            break;
        }
    }
    let prompt: wire::Prompt = serde_json::from_slice(&line).map_err(|_| ())?;
    let text = &prompt.params.prompt[0];
    if prompt.jsonrpc != "2.0"
        || prompt.id != 1
        || prompt.method != "session/prompt"
        || text.r#type != "text"
        || text.text.len() > wire::TEXT_LIMIT
        || prompt.params.nonce.len() != 64
        || !prompt.params.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(());
    }
    let receipt = wire::NativeReceipt {
        identity: wire::IDENTITY.into(),
        pid: std::process::id(),
        cwd_device: cwd.dev(),
        cwd_inode: cwd.ino(),
        nonce: prompt.params.nonce,
        frame_bytes: line.len(),
        frame_sha256: format!("{:x}", Sha256::digest(&line)),
        text_bytes: text.text.len(),
        text_sha256: format!("{:x}", Sha256::digest(text.text.as_bytes())),
        isolated_environment: isolated,
    };
    let encoded = serde_json::to_vec(&receipt).map_err(|_| ())?;
    if encoded.len() > wire::RECEIPT_LIMIT {
        return Err(());
    }
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&encoded).map_err(|_| ())?;
    stdout.write_all(b"\n").map_err(|_| ())?;
    stdout.flush().map_err(|_| ())?;
    if case == "ignore-cancel" {
        loop {
            unsafe {
                libc::pause();
            }
        }
    }
    Ok(())
}
