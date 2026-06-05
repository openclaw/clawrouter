use clawrouter_core::{compile_provider_snapshot, ProviderManifest};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../../providers");
    println!("cargo:rerun-if-changed={}", manifest_dir.display());

    let mut paths = fs::read_dir(manifest_dir)
        .expect("read providers directory")
        .map(|entry| entry.expect("read provider entry").path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("yaml"))
        .collect::<Vec<_>>();
    paths.sort();

    for path in &paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let manifests = paths
        .into_iter()
        .map(|path| {
            let raw = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            serde_yaml::from_str::<ProviderManifest>(&raw)
                .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
        })
        .collect::<Vec<_>>();
    let snapshot = compile_provider_snapshot(&manifests).expect("compile provider snapshot");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    fs::write(
        Path::new(&out_dir).join("provider-snapshot.json"),
        serde_json::to_vec_pretty(&snapshot).expect("serialize provider snapshot"),
    )
    .expect("write provider snapshot");
}
