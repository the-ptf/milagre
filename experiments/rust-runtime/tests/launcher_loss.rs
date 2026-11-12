#![cfg(feature = "chat-runtime-fixture")]
#[test]
fn crashed_stdin_controller_cancels_and_reaps_the_owned_native_child() {
    for closed_stderr in [false, true] {
        let output = std::process::Command::new("node")
            .arg("tests/launcher-loss.cjs")
            .arg(env!("CARGO_BIN_EXE_chat-runtime"))
            .env(
                "CLOSE_RUNTIME_STDERR",
                if closed_stderr { "1" } else { "0" },
            )
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("\"cleanup\":true"));
    }
}
