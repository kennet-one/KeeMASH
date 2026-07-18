mod models;
mod resource_monitor;
mod serial_service;
mod weather;

use models::{ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot};
use resource_monitor::ResourceMonitor;
use semver::Version;
use serial_service::SerialService;
use sha2::{Digest, Sha256};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::{env, fs};
use tauri::{AppHandle, Manager, RunEvent, State};

struct AppState {
    serial: SerialService,
    resources: Arc<ResourceMonitor>,
}

#[tauri::command]
fn serial_list(state: State<'_, AppState>) -> Result<Vec<SerialPortInfo>, String> {
    state.serial.list()
}

#[tauri::command]
fn serial_open(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<SerialStatus, String> {
    state.serial.open(&app, path)
}

#[tauri::command]
fn serial_close(app: AppHandle, state: State<'_, AppState>) -> Result<SerialStatus, String> {
    state.serial.close(&app)
}

#[tauri::command]
fn serial_status(state: State<'_, AppState>) -> SerialStatus {
    state.serial.status()
}

#[tauri::command]
fn serial_send(state: State<'_, AppState>, message: String) -> Result<(), String> {
    state.serial.send(message)
}

#[tauri::command]
fn resources_set_enabled(state: State<'_, AppState>, enabled: bool) {
    state.resources.set_enabled(enabled);
}

#[tauri::command]
async fn resources_sample(state: State<'_, AppState>) -> Result<ResourceSample, String> {
    let resources = Arc::clone(&state.resources);
    tauri::async_runtime::spawn_blocking(move || resources.sample())
        .await
        .map_err(|error| format!("Resource sampler failed: {error}"))
}

#[tauri::command]
async fn weather_refresh() -> Result<WeatherSnapshot, String> {
    weather::fetch_weather().await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KenUltraCatalogEnvelope {
    catalog: serde_json::Value,
    source_path: String,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalUpdateManifest {
    schema_version: u8,
    version: String,
    published_at: String,
    installer: String,
    sha256: String,
    bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalUpdateStatus {
    current_version: String,
    available: bool,
    version: Option<String>,
    published_at: Option<String>,
    installer_name: Option<String>,
    bytes: Option<u64>,
    message: String,
}

struct ValidatedLocalUpdate {
    manifest: LocalUpdateManifest,
    installer_path: PathBuf,
}

fn local_update_root() -> Result<PathBuf, String> {
    if let Ok(explicit) = env::var("KEEMASH_UPDATE_ROOT") {
        if !explicit.trim().is_empty() {
            return Ok(PathBuf::from(explicit));
        }
    }
    env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("KeeMASH/updates"))
        .map_err(|_| "LOCALAPPDATA is unavailable".to_string())
}

fn validated_relative_installer(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.extension().and_then(|value| value.to_str()) != Some("exe")
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Update installer path must be a relative .exe path".to_string());
    }
    Ok(path.to_path_buf())
}

fn resolve_local_update(
    root: &Path,
    current_version: &str,
) -> Result<Option<ValidatedLocalUpdate>, String> {
    let manifest_path = root.join("latest.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let metadata = fs::metadata(&manifest_path)
        .map_err(|error| format!("Update manifest metadata failed: {error}"))?;
    if metadata.len() > 64 * 1024 {
        return Err("Update manifest exceeds the 64 KiB limit".to_string());
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Update manifest read failed: {error}"))?;
    let manifest: LocalUpdateManifest = serde_json::from_str(&text)
        .map_err(|error| format!("Update manifest JSON failed: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("Unsupported update manifest schema".to_string());
    }
    let current = Version::parse(current_version)
        .map_err(|error| format!("Current app version is invalid: {error}"))?;
    let available = Version::parse(&manifest.version)
        .map_err(|error| format!("Published update version is invalid: {error}"))?;
    if available <= current {
        return Ok(None);
    }
    if manifest.sha256.len() != 64 || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Update SHA256 is invalid".to_string());
    }
    let relative = validated_relative_installer(&manifest.installer)?;
    let installer_path = root.join(relative);
    let installer_metadata = fs::metadata(&installer_path)
        .map_err(|error| format!("Published installer is unavailable: {error}"))?;
    if !installer_metadata.is_file() || installer_metadata.len() != manifest.bytes {
        return Err("Published installer size does not match its manifest".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Update root validation failed: {error}"))?;
    let canonical_installer = installer_path
        .canonicalize()
        .map_err(|error| format!("Installer path validation failed: {error}"))?;
    if !canonical_installer.starts_with(&canonical_root) {
        return Err("Published installer resolves outside the update root".to_string());
    }
    Ok(Some(ValidatedLocalUpdate {
        manifest,
        installer_path: canonical_installer,
    }))
}

fn installer_sha256(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("Installer open failed: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Installer hash read failed: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[tauri::command]
fn local_update_check(app: AppHandle) -> Result<LocalUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let update = resolve_local_update(&local_update_root()?, &current_version)?;
    Ok(match update {
        Some(update) => LocalUpdateStatus {
            current_version,
            available: true,
            version: Some(update.manifest.version),
            published_at: Some(update.manifest.published_at),
            installer_name: update
                .installer_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            bytes: Some(update.manifest.bytes),
            message: "Fresh local build is ready".to_string(),
        },
        None => LocalUpdateStatus {
            current_version,
            available: false,
            version: None,
            published_at: None,
            installer_name: None,
            bytes: None,
            message: "KeeMASH is current".to_string(),
        },
    })
}

#[tauri::command]
fn local_update_install(app: AppHandle) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    let update = resolve_local_update(&local_update_root()?, &current_version)?
        .ok_or("No newer local KeeMASH build is available")?;
    let actual_sha256 = installer_sha256(&update.installer_path)?;
    if !actual_sha256.eq_ignore_ascii_case(&update.manifest.sha256) {
        return Err("Installer SHA256 does not match the update manifest".to_string());
    }
    Command::new(&update.installer_path)
        .arg("/S")
        .spawn()
        .map_err(|error| format!("Installer launch failed: {error}"))?;
    app.exit(0);
    Ok(())
}

fn kenultra_catalog_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(explicit) = env::var("KEEMASH_KENULTRA_CATALOG") {
        if !explicit.trim().is_empty() {
            candidates.push(PathBuf::from(explicit));
        }
    }
    if let Ok(home) = env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        candidates.push(home.join("Desktop/grafs/KenULTRABIOS-Brain/.kenultra/mash-bridge.json"));
        candidates.push(
            home.join("Documents/KenULTRABIOS/reports/obsidian-generated/catalog/mash-bridge.json"),
        );
    }
    candidates
}

fn validate_kenultra_catalog(catalog: &serde_json::Value) -> Result<(), String> {
    let safety = catalog
        .get("safety")
        .ok_or("Catalog has no safety declaration")?;
    if safety.get("mode").and_then(serde_json::Value::as_str) != Some("read-only-simulation")
        || safety
            .get("firmwareWrite")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || safety
            .get("rawFirmwareIncluded")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || safety
            .get("privateInventoryIncluded")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return Err("Catalog safety declaration rejected".to_string());
    }
    if !catalog
        .get("nodes")
        .is_some_and(serde_json::Value::is_array)
        || !catalog
            .get("edges")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("Catalog graph arrays are missing".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn kenultra_catalog_load() -> Result<KenUltraCatalogEnvelope, String> {
    let path = kenultra_catalog_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or("KenULTRABIOS mash-bridge.json was not found in the local vault")?;
    let size = fs::metadata(&path)
        .map_err(|error| format!("Catalog metadata failed: {error}"))?
        .len();
    if size > 32 * 1024 * 1024 {
        return Err(format!(
            "Catalog is larger than the 32 MiB safety limit: {size} bytes"
        ));
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("Catalog read failed: {error}"))?;
    let catalog: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("Catalog JSON failed: {error}"))?;
    validate_kenultra_catalog(&catalog)?;
    Ok(KenUltraCatalogEnvelope {
        catalog,
        source_path: path.display().to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resources = Arc::new(ResourceMonitor::default());
    let app = tauri::Builder::default()
        .manage(AppState {
            serial: SerialService::default(),
            resources: Arc::clone(&resources),
        })
        .setup(move |app| resources.start(app.handle().clone()).map_err(Into::into))
        .invoke_handler(tauri::generate_handler![
            serial_list,
            serial_open,
            serial_close,
            serial_status,
            serial_send,
            resources_set_enabled,
            resources_sample,
            weather_refresh,
            kenultra_catalog_load,
            local_update_check,
            local_update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building KeeMASH");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            state.resources.stop();
            let _ = state.serial.close(handle);
        }
    });
}

#[cfg(test)]
mod kenultra_tests {
    use super::{installer_sha256, resolve_local_update, validate_kenultra_catalog};
    use serde_json::json;
    use std::fs;

    #[test]
    fn accepts_only_read_only_sanitized_catalogs() {
        let valid = json!({"safety":{"mode":"read-only-simulation","firmwareWrite":false,"rawFirmwareIncluded":false,"privateInventoryIncluded":false},"nodes":[],"edges":[]});
        assert!(validate_kenultra_catalog(&valid).is_ok());
        let writable = json!({"safety":{"mode":"read-only-simulation","firmwareWrite":true,"rawFirmwareIncluded":false,"privateInventoryIncluded":false},"nodes":[],"edges":[]});
        assert!(validate_kenultra_catalog(&writable).is_err());
    }

    #[test]
    fn local_update_rejects_traversal_and_accepts_hashed_newer_build() {
        let root = std::env::temp_dir().join(format!("keemash-update-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("0.3.0")).unwrap();
        let installer = root.join("0.3.0/KeeMASH_0.3.0_setup.exe");
        fs::write(&installer, b"test installer").unwrap();
        let sha256 = installer_sha256(&installer).unwrap();
        let manifest = json!({
            "schemaVersion": 1,
            "version": "0.3.0",
            "publishedAt": "2026-07-18T00:00:00Z",
            "installer": "0.3.0/KeeMASH_0.3.0_setup.exe",
            "sha256": sha256,
            "bytes": 14
        });
        fs::write(
            root.join("latest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(resolve_local_update(&root, "0.2.0").unwrap().is_some());
        assert!(resolve_local_update(&root, "0.3.0").unwrap().is_none());

        let mut traversal = manifest;
        traversal["installer"] = json!("../outside.exe");
        fs::write(
            root.join("latest.json"),
            serde_json::to_vec(&traversal).unwrap(),
        )
        .unwrap();
        assert!(resolve_local_update(&root, "0.2.0").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
