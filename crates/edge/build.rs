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

    write_admin_assets(Path::new(&out_dir));
}

fn write_admin_assets(out_dir: &Path) {
    let repo_root =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("../..");
    let dist_dir = repo_root.join("admin/dist");
    println!("cargo:rerun-if-changed={}", dist_dir.display());
    let index_path = dist_dir.join("index.html");
    if !index_path.exists() {
        fs::write(
            out_dir.join("admin-assets.rs"),
            "const ADMIN_INDEX_HTML: Option<&str> = None;\nconst ADMIN_ASSETS: &[(&str, &str, &[u8])] = &[];\n",
        )
        .expect("write empty admin asset manifest");
        return;
    }

    let index_html = fs::read_to_string(&index_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", index_path.display()));
    println!("cargo:rerun-if-changed={}", index_path.display());

    let mut output = String::new();
    output.push_str("const ADMIN_INDEX_HTML: Option<&str> = Some(");
    output.push_str(&serde_json::to_string(&index_html).expect("escape admin index html"));
    output.push_str(");\nconst ADMIN_ASSETS: &[(&str, &str, &[u8])] = &[\n");

    let assets_dir = dist_dir.join("assets");
    if assets_dir.exists() {
        let mut assets = fs::read_dir(&assets_dir)
            .expect("read admin assets directory")
            .map(|entry| entry.expect("read admin asset entry").path())
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        assets.sort();
        for asset in assets {
            println!("cargo:rerun-if-changed={}", asset.display());
            let file_name = asset
                .file_name()
                .and_then(|value| value.to_str())
                .expect("admin asset filename");
            output.push_str(&format!(
                "    (\"/assets/{file_name}\", \"{}\", include_bytes!(r#\"{}\"#)),\n",
                content_type(file_name),
                asset.display()
            ));
        }
    }
    output.push_str("];\n");
    fs::write(out_dir.join("admin-assets.rs"), output).expect("write admin asset manifest");
}

fn content_type(file_name: &str) -> &'static str {
    if file_name.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if file_name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if file_name.ends_with(".svg") {
        "image/svg+xml"
    } else if file_name.ends_with(".png") {
        "image/png"
    } else if file_name.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}
