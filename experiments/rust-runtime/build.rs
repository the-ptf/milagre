use std::{env, fs, path::Path};

fn collect(root: &Path, directory: &Path, files: &mut Vec<String>) {
    let mut entries = fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    for entry in entries {
        let metadata = fs::symlink_metadata(&entry).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "Fixture sources must not contain symlinks"
        );
        if metadata.is_dir() {
            collect(root, &entry, files);
        } else {
            assert!(
                metadata.is_file(),
                "Fixture sources must contain only files and directories"
            );
            let relative = entry.strip_prefix(root).unwrap().to_str().unwrap();
            println!("cargo:rerun-if-changed={}", entry.display());
            files.push(format!(
                "({relative:?}, include_bytes!({:?})),",
                entry.to_str().unwrap()
            ));
        }
    }
}
fn main() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../rust-owner/fixtures/.projects");
    assert!(
        fs::symlink_metadata(&root).unwrap().is_dir(),
        "Fixture root cannot be a symlink"
    );
    let root = root.canonicalize().unwrap();
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    for name in ["alpha", "legacy", "surrogates"] {
        let project = root.join(name);
        assert!(
            fs::symlink_metadata(&project).unwrap().is_dir(),
            "Fixture must be a real directory"
        );
        collect(&root, &project, &mut files);
    }
    let output = format!("const FILES: &[(&str, &[u8])] = &[{}];", files.join("\n"));
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("fixtures.rs"),
        output,
    )
    .unwrap();
    let root =
        Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("fixtures/artifacts/alpha-1");
    assert!(
        fs::symlink_metadata(&root).unwrap().is_dir(),
        "Artifact fixture root cannot be a symlink"
    );
    let root = root.canonicalize().unwrap();
    println!("cargo:rerun-if-changed={}", root.display());
    let mut artifacts = Vec::new();
    collect(&root, &root, &mut artifacts);
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("artifact-fixtures.rs"),
        format!(
            "const ARTIFACT_FILES: &[(&str, &[u8])] = &[{}];",
            artifacts.join("\n")
        ),
    )
    .unwrap();
}
