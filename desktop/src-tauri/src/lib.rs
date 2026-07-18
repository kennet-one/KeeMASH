mod models;
mod resource_monitor;
mod serial_service;
mod weather;

use models::{ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot};
use resource_monitor::ResourceMonitor;
use serial_service::SerialService;
use std::sync::Arc;
use std::{env, fs, path::PathBuf};
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
    use super::validate_kenultra_catalog;
    use serde_json::json;

    #[test]
    fn accepts_only_read_only_sanitized_catalogs() {
        let valid = json!({"safety":{"mode":"read-only-simulation","firmwareWrite":false,"rawFirmwareIncluded":false,"privateInventoryIncluded":false},"nodes":[],"edges":[]});
        assert!(validate_kenultra_catalog(&valid).is_ok());
        let writable = json!({"safety":{"mode":"read-only-simulation","firmwareWrite":true,"rawFirmwareIncluded":false,"privateInventoryIncluded":false},"nodes":[],"edges":[]});
        assert!(validate_kenultra_catalog(&writable).is_err());
    }
}
