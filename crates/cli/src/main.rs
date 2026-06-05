use clawrouter_core::{compile_provider_snapshot, validate_provider_manifest, ProviderManifest};
use std::{env, fs, path::PathBuf, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    match (args.next().as_deref(), args.next().as_deref()) {
        (Some("provider"), Some("validate")) => {
            let path = args
                .next()
                .ok_or("usage: clawrouter provider validate <file>")?;
            let manifest = read_manifest(PathBuf::from(path))?;
            validate_provider_manifest(&manifest).map_err(|error| error.to_string())?;
            println!("provider manifest valid: {}", manifest.id);
            Ok(())
        }
        (Some("provider"), Some("compile")) => {
            let paths: Vec<PathBuf> = args.map(PathBuf::from).collect();
            if paths.is_empty() {
                return Err("usage: clawrouter provider compile <file...>".to_string());
            }
            let manifests: Result<Vec<_>, _> = paths.into_iter().map(read_manifest).collect();
            let snapshot =
                compile_provider_snapshot(&manifests?).map_err(|error| error.to_string())?;
            println!("{}", serde_json::to_string_pretty(&snapshot).unwrap());
            Ok(())
        }
        _ => Err("usage: clawrouter provider <validate|compile> ...".to_string()),
    }
}

fn read_manifest(path: PathBuf) -> Result<ProviderManifest, String> {
    let raw =
        fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_yaml::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}
