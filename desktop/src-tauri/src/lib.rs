mod models;
mod resource_monitor;
mod serial_service;
mod weather;

use models::{ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot};
use resource_monitor::ResourceMonitor;
use serial_service::SerialService;
use std::sync::Arc;
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
