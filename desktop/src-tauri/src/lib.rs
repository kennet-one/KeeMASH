mod local_updater;
mod models;
mod resource_monitor;
mod serial_service;
mod weather;

use local_updater::{
    installer_sha256, launch_update_helper, local_update_root, resolve_local_update,
};
use models::{ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot};
use resource_monitor::ResourceMonitor;
use serial_service::SerialService;
use std::path::PathBuf;
use std::sync::Arc;
use std::{env, fs, thread, time::Duration};
use tauri::{AppHandle, Manager, RunEvent, State};

struct AppState {
    serial: SerialService,
    resources: Arc<ResourceMonitor>,
}

#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window was not created")?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
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
fn local_update_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    let update = resolve_local_update(&local_update_root()?, &current_version)?
        .ok_or("No newer local KeeMASH build is available")?;
    let actual_sha256 = installer_sha256(&update.installer_path)?;
    if !actual_sha256.eq_ignore_ascii_case(&update.manifest.sha256) {
        return Err("Installer SHA256 does not match the update manifest".to_string());
    }
    state.resources.stop();
    state.serial.close(&app)?;
    let installed_exe =
        env::current_exe().map_err(|error| format!("Current executable lookup failed: {error}"))?;
    launch_update_helper(&current_version, &installed_exe)?;
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(300));
        std::process::exit(0);
    });
    Ok(())
}

pub fn maybe_run_update_helper() -> Option<i32> {
    local_updater::maybe_run_update_helper()
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
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            serial: SerialService::default(),
            resources: Arc::clone(&resources),
        })
        .setup(move |app| {
            resources.start(app.handle().clone())?;
            if let Some(window) = app.get_webview_window("main") {
                let fallback = window.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(5));
                    if !fallback.is_visible().unwrap_or(false) {
                        let _ = fallback.show();
                    }
                });
            }
            Ok(())
        })
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
            frontend_ready,
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
