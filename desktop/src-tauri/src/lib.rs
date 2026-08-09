mod afterburner_shared;
mod ccc_daemon;
mod gpu_residency;
mod hwinfo_shared;
mod local_updater;
mod memory_test;
mod models;
mod process_control;
mod resource_monitor;
mod runtime;
mod serial_service;
mod vram_telemetry;
mod weather;

use ccc_daemon::{
    inspect_shared_daemon, restart_shared_daemon, start_shared_daemon, stop_shared_daemon,
};
use gpu_residency::{GpuResidencyManager, SetProcessPolicyRequest};
use local_updater::{
    installer_sha256, launch_update_helper, local_update_root, resolve_local_update,
};
use memory_test::{launch_windows_memory_diagnostic, MemoryTestController, MemoryTestRequest};
use models::{ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot};
use process_control::{close_process, terminate_process, terminate_process_tree};
use resource_monitor::ResourceMonitor;
use runtime::{
    RuntimeAction, RuntimeController, RuntimeDispatchRequest, RuntimeHistoryPage, RuntimeSnapshot,
};
use serial_service::SerialService;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::{env, fs, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct AppState {
    serial: SerialService,
    weather: Arc<Mutex<Option<WeatherSnapshot>>>,
    resources: Arc<ResourceMonitor>,
    gpu_residency: Arc<GpuResidencyManager>,
    memory_test: Arc<MemoryTestController>,
    runtime: Arc<RuntimeController>,
}

#[tauri::command]
fn frontend_ready(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window was not created")?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn serial_list(state: &AppState) -> Result<Vec<SerialPortInfo>, String> {
    state.serial.list()
}

fn serial_open(app: &AppHandle, state: &AppState, path: String) -> Result<SerialStatus, String> {
    let status = state.serial.open(app, path, Arc::clone(&state.runtime))?;
    let _ = publish_mixer_weather(&state.serial, &state.weather);
    Ok(status)
}

fn serial_close(app: &AppHandle, state: &AppState) -> Result<SerialStatus, String> {
    let _ = state.serial.send("mixer.weather:off".into());
    state.serial.close(app)
}

fn serial_status(state: &AppState) -> SerialStatus {
    state.serial.status()
}

fn serial_send(state: &AppState, message: String) -> Result<(), String> {
    state.serial.send(message)
}

async fn resources_sample(state: &AppState) -> Result<ResourceSample, String> {
    let resources = Arc::clone(&state.resources);
    tauri::async_runtime::spawn_blocking(move || resources.sample())
        .await
        .map_err(|error| format!("Resource sampler failed: {error}"))
}

async fn gpu_residency_snapshot(state: &AppState) -> Result<serde_json::Value, String> {
    let aggregate = resources_sample(state).await?;
    let used = aggregate.gpu.memory_used_mi_b.unwrap_or_default().max(0.0) as u64 * 1024 * 1024;
    let total = aggregate.gpu.memory_total_mi_b.unwrap_or_default().max(0.0) as u64 * 1024 * 1024;
    let manager = Arc::clone(&state.gpu_residency);
    let snapshot = tauri::async_runtime::spawn_blocking(move || manager.snapshot(used, total))
        .await
        .map_err(|error| format!("GPU residency worker failed: {error}"))??;
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

async fn memory_test_status(state: &AppState) -> Result<memory_test::MemoryTestStatus, String> {
    let controller = Arc::clone(&state.memory_test);
    tauri::async_runtime::spawn_blocking(move || controller.status())
        .await
        .map_err(|error| format!("Memory test status failed: {error}"))
}

fn mixer_weather_command(chance: Option<f64>) -> String {
    match chance.filter(|value| value.is_finite() && *value >= 0.0 && *value <= 100.0) {
        Some(value) => format!("mixer.weather:{:.0}", value.round()),
        None => "mixer.weather:?".into(),
    }
}

fn publish_mixer_weather(
    serial: &SerialService,
    weather: &Arc<Mutex<Option<WeatherSnapshot>>>,
) -> Result<(), String> {
    if !serial.status().connected {
        return Ok(());
    }
    let chance = weather
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|snapshot| snapshot.daily.precipitation_probability_max_percent);
    serial.send(mixer_weather_command(chance))
}

async fn weather_refresh(state: &AppState) -> Result<WeatherSnapshot, String> {
    let snapshot = weather::fetch_weather().await?;
    *state
        .weather
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(snapshot.clone());
    let _ = publish_mixer_weather(&state.serial, &state.weather);
    Ok(snapshot)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KenUltraCatalogEnvelope {
    catalog: serde_json::Value,
    source_path: String,
}

#[derive(Clone, serde::Serialize)]
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

fn local_update_check(app: &AppHandle) -> Result<LocalUpdateStatus, String> {
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

fn local_update_install(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    let update = resolve_local_update(&local_update_root()?, &current_version)?
        .ok_or("No newer local KeeMASH build is available")?;
    let actual_sha256 = installer_sha256(&update.installer_path)?;
    if !actual_sha256.eq_ignore_ascii_case(&update.manifest.sha256) {
        return Err("Installer SHA256 does not match the update manifest".to_string());
    }
    state.resources.stop();
    state.serial.close(app)?;
    let installed_exe =
        env::current_exe().map_err(|error| format!("Current executable lookup failed: {error}"))?;
    launch_update_helper(&current_version, &installed_exe)?;
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(300));
        std::process::exit(0);
    });
    Ok(())
}

fn reboot_to_firmware() -> Result<(), String> {
    #[cfg(windows)]
    {
        let output = Command::new("shutdown.exe")
            .args([
                "/r",
                "/fw",
                "/t",
                "3",
                "/d",
                "p:0:0",
                "/c",
                "KeeMASH requested UEFI firmware settings",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Unable to request firmware restart: {error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!(
                    "Windows rejected firmware restart with status {}",
                    output.status
                )
            } else {
                format!("Windows rejected firmware restart: {detail}")
            });
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Restart to firmware settings is available only on Windows".into())
    }
}

fn schedule_system_power(action: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mode = match action {
            "restart" => "/r",
            "shutdown" => "/s",
            _ => return Err(format!("Unsupported system power action: {action}")),
        };
        let message = if action == "restart" {
            "KeeMASH scheduled a Windows restart"
        } else {
            "KeeMASH scheduled a Windows shutdown"
        };
        run_shutdown(&[mode, "/t", "15", "/d", "p:0:0", "/c", message])
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("System power controls are available only on Windows".into())
    }
}

fn cancel_system_power() -> Result<(), String> {
    #[cfg(windows)]
    {
        run_shutdown(&["/a"])
    }
    #[cfg(not(windows))]
    {
        Err("System power controls are available only on Windows".into())
    }
}

#[cfg(windows)]
fn run_shutdown(arguments: &[&str]) -> Result<(), String> {
    let output = Command::new("shutdown.exe")
        .args(arguments)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Unable to invoke Windows power control: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!(
            "Windows rejected power control with status {}",
            output.status
        )
    } else {
        format!("Windows rejected power control: {detail}")
    })
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

#[tauri::command]
fn runtime_bootstrap(state: State<'_, AppState>) -> RuntimeSnapshot {
    sync_runtime_lifecycle(&state);
    state.runtime.snapshot()
}

#[tauri::command]
fn runtime_apply_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: RuntimeAction,
    expected_revision: Option<u64>,
) -> Result<RuntimeSnapshot, String> {
    let snapshot = state
        .runtime
        .apply_action(&app, action, expected_revision)?;
    sync_runtime_lifecycle(&state);
    let _ = app.emit("runtime-snapshot", snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
fn runtime_history(
    state: State<'_, AppState>,
    kind: Option<String>,
    cursor: Option<u64>,
    limit: Option<usize>,
) -> RuntimeHistoryPage {
    state.runtime.history(
        kind.as_deref(),
        cursor.unwrap_or_default(),
        limit.unwrap_or(100),
    )
}

#[tauri::command]
async fn runtime_dispatch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: RuntimeDispatchRequest,
) -> Result<serde_json::Value, String> {
    state.runtime.authorize(&request)?;
    let result = match request.operation.as_str() {
        "serial.list" => serde_json::to_value(serial_list(&state)?),
        "serial.open" => {
            let path = request
                .payload
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or("serial.open requires payload.path")?;
            serde_json::to_value(serial_open(&app, &state, path.to_string())?)
        }
        "serial.close" => serde_json::to_value(serial_close(&app, &state)?),
        "serial.status" => serde_json::to_value(serial_status(&state)),
        "serial.send" => {
            let message = request
                .payload
                .get("message")
                .and_then(serde_json::Value::as_str)
                .ok_or("serial.send requires payload.message")?;
            serial_send(&state, message.to_string())?;
            state.runtime.record(
                "log",
                serde_json::json!({"direction": "tx", "text": message}),
            );
            Ok(serde_json::Value::Null)
        }
        "resources.sample" => serde_json::to_value(resources_sample(&state).await?),
        "gpu.residency.snapshot" => Ok(gpu_residency_snapshot(&state).await?),
        "gpu.residency.setProcessPolicy" => {
            let settings: SetProcessPolicyRequest = serde_json::from_value(request.payload.clone())
                .map_err(|error| format!("Invalid GPU process policy: {error}"))?;
            let manager = Arc::clone(&state.gpu_residency);
            let app = app.clone();
            serde_json::to_value(
                tauri::async_runtime::spawn_blocking(move || manager.apply_policy(&app, settings))
                    .await
                    .map_err(|error| format!("GPU policy worker failed: {error}"))??,
            )
        }
        "gpu.residency.undoProcessPolicy" => {
            let identity = serde_json::from_value(
                request
                    .payload
                    .get("identity")
                    .cloned()
                    .ok_or("gpu.residency.undoProcessPolicy requires payload.identity")?,
            )
            .map_err(|error| format!("Invalid process identity: {error}"))?;
            serde_json::to_value(state.gpu_residency.undo_policy(&app, &identity)?)
        }
        "gpu.residency.removeRule" => {
            let executable_path = request
                .payload
                .get("executablePath")
                .and_then(serde_json::Value::as_str)
                .ok_or("gpu.residency.removeRule requires payload.executablePath")?
                .to_string();
            serde_json::to_value(state.gpu_residency.remove_rule(&app, &executable_path)?)
        }
        "gpu.residency.attachAgent"
        | "gpu.residency.detachAgent"
        | "gpu.residency.applyResourcePolicy"
        | "gpu.residency.forceEvict"
        | "gpu.residency.makeResident" => {
            return Err("The authenticated D3D agent is not installed in this build; process-level telemetry and priorities remain available".into());
        }
        "process.close" | "process.terminate" | "process.terminateTree" => {
            let identity = serde_json::from_value(
                request
                    .payload
                    .get("identity")
                    .cloned()
                    .ok_or("process operation requires payload.identity")?,
            )
            .map_err(|error| format!("Invalid process identity: {error}"))?;
            let operation = request.operation.clone();
            let result = tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
                "process.close" => close_process(&identity),
                "process.terminate" => terminate_process(&identity),
                "process.terminateTree" => terminate_process_tree(&identity),
                _ => unreachable!(),
            })
            .await
            .map_err(|error| format!("Process control worker failed: {error}"))??;
            state.runtime.record(
                "process",
                serde_json::json!({
                    "action": result.action,
                    "pid": result.pid,
                    "success": result.success,
                    "requestedCount": result.requested_count,
                    "completedCount": result.completed_count,
                    "failedCount": result.failed_count,
                    "errors": result.errors,
                }),
            );
            serde_json::to_value(result)
        }
        "ccc.status" => serde_json::to_value(
            tauri::async_runtime::spawn_blocking(inspect_shared_daemon)
                .await
                .map_err(|error| format!("CCC status worker failed: {error}"))?,
        ),
        "ccc.start" | "ccc.stop" | "ccc.restart" => {
            let operation = request.operation.clone();
            let timeout_ms = request
                .payload
                .get("timeoutMs")
                .and_then(serde_json::Value::as_u64);
            let result = tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
                "ccc.start" => start_shared_daemon(timeout_ms),
                "ccc.stop" => stop_shared_daemon(timeout_ms),
                "ccc.restart" => restart_shared_daemon(timeout_ms),
                _ => unreachable!(),
            })
            .await
            .map_err(|error| format!("CCC management worker failed: {error}"))??;
            serde_json::to_value(result)
        }
        "memory.test.status" => serde_json::to_value(memory_test_status(&state).await?),
        "memory.test.start" => {
            let request: MemoryTestRequest = serde_json::from_value(request.payload.clone())
                .map_err(|error| format!("Invalid memory test settings: {error}"))?;
            serde_json::to_value(state.memory_test.start(request)?)
        }
        "memory.test.stop" => serde_json::to_value(state.memory_test.stop()),
        "memory.diagnostic.open" => {
            launch_windows_memory_diagnostic()?;
            state.runtime.record(
                "system",
                serde_json::json!({"action": "windowsMemoryDiagnostic", "opened": true}),
            );
            Ok(serde_json::Value::Null)
        }
        "weather.refresh" => serde_json::to_value(weather_refresh(&state).await?),
        "kenultra.load" => serde_json::to_value(kenultra_catalog_load().await?),
        "updates.check" => serde_json::to_value(local_update_check(&app)?),
        "updates.install" => {
            local_update_install(&app, &state)?;
            Ok(serde_json::Value::Null)
        }
        "system.rebootToFirmware" => {
            reboot_to_firmware()?;
            state.runtime.record(
                "system",
                serde_json::json!({"action": "rebootToFirmware", "scheduled": true}),
            );
            Ok(serde_json::Value::Null)
        }
        "system.restart" | "system.shutdown" => {
            let action = request.operation.trim_start_matches("system.");
            schedule_system_power(action)?;
            state.runtime.record(
                "system",
                serde_json::json!({"action": action, "scheduled": true, "delaySeconds": 15}),
            );
            Ok(serde_json::json!({"action": action, "delaySeconds": 15}))
        }
        "system.cancelPower" => {
            cancel_system_power()?;
            state.runtime.record(
                "system",
                serde_json::json!({"action": "cancelPower", "cancelled": true}),
            );
            Ok(serde_json::Value::Null)
        }
        _ => return Err(format!("unknown runtime operation: {}", request.operation)),
    }
    .map_err(|error| error.to_string())?;
    state.runtime.record(
        "dispatch",
        serde_json::json!({"caller": request.caller, "operation": request.operation, "ok": true}),
    );
    Ok(result)
}

fn sync_runtime_lifecycle(state: &AppState) {
    let monitor_state = state.runtime.module_state("monitor");
    state
        .resources
        .set_enabled(matches!(monitor_state.as_str(), "active" | "background"));
    state
        .resources
        .set_sample_interval_ms(state.runtime.telemetry_interval_ms());
}

fn start_background_schedulers(
    app: AppHandle,
    runtime: Arc<RuntimeController>,
    serial: SerialService,
    weather_state: Arc<Mutex<Option<WeatherSnapshot>>>,
) {
    let weather_app = app.clone();
    let weather_runtime = Arc::clone(&runtime);
    let scheduler_weather_state = Arc::clone(&weather_state);
    let scheduler_serial = serial.clone();
    let _ = thread::Builder::new()
        .name("keemash-weather-scheduler".into())
        .spawn(move || loop {
            let weather_active = matches!(
                weather_runtime.module_state("main").as_str(),
                "active" | "background"
            ) && weather_runtime.capability_granted("main", "weather.read")
                && weather_runtime.capability_granted("main", "network.external");
            match weather_active
                .then(|| tauri::async_runtime::block_on(weather::fetch_weather()))
                .transpose()
            {
                Ok(None) => {}
                Ok(Some(snapshot)) => {
                    *scheduler_weather_state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(snapshot.clone());
                    let _ = publish_mixer_weather(&scheduler_serial, &scheduler_weather_state);
                    weather_runtime.record(
                        "telemetry",
                        serde_json::json!({"source": "weather", "snapshot": &snapshot}),
                    );
                    let _ = weather_app.emit("weather-snapshot", snapshot);
                }
                Err(error) => weather_runtime.record(
                    "runtime-error",
                    serde_json::json!({"source": "weather", "error": error}),
                ),
            }
            thread::sleep(Duration::from_secs(10 * 60));
        });

    let heartbeat_runtime = Arc::clone(&runtime);
    let _ = thread::Builder::new()
        .name("keemash-mixer-weather".into())
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(30));
            if let Err(error) = publish_mixer_weather(&serial, &weather_state) {
                heartbeat_runtime.record(
                    "runtime-error",
                    serde_json::json!({"source": "mixer-weather", "error": error}),
                );
            }
        });

    let update_app = app;
    let _ = thread::Builder::new()
        .name("keemash-update-scheduler".into())
        .spawn(move || loop {
            match local_update_check(&update_app) {
                Ok(status) => {
                    runtime.record(
                        "telemetry",
                        serde_json::json!({"source": "updates", "snapshot": &status}),
                    );
                    let _ = update_app.emit("update-status", status);
                }
                Err(error) => runtime.record(
                    "runtime-error",
                    serde_json::json!({"source": "updates", "error": error}),
                ),
            }
            thread::sleep(Duration::from_secs(60));
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resources = Arc::new(ResourceMonitor::default());
    let gpu_residency = Arc::new(GpuResidencyManager::default());
    let memory_test = Arc::new(MemoryTestController::default());
    let runtime = Arc::new(RuntimeController::default());
    let weather_state = Arc::new(Mutex::new(None));
    let serial = SerialService::default();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            serial: serial.clone(),
            weather: Arc::clone(&weather_state),
            resources: Arc::clone(&resources),
            gpu_residency: Arc::clone(&gpu_residency),
            memory_test: Arc::clone(&memory_test),
            runtime: Arc::clone(&runtime),
        })
        .setup(move |app| {
            runtime.load(app.handle())?;
            gpu_residency.load(app.handle())?;
            resources.start(app.handle().clone(), Arc::clone(&runtime))?;
            let monitor_state = runtime.module_state("monitor");
            resources.set_enabled(matches!(monitor_state.as_str(), "active" | "background"));
            start_background_schedulers(
                app.handle().clone(),
                Arc::clone(&runtime),
                serial.clone(),
                Arc::clone(&weather_state),
            );
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
            runtime_bootstrap,
            runtime_apply_action,
            runtime_dispatch,
            runtime_history,
            frontend_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while building KeeMASH");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            state.resources.stop();
            let _ = state.serial.send("mixer.weather:off".into());
            let _ = state.serial.close(handle);
        }
    });
}

#[cfg(test)]
mod kenultra_tests {
    use super::{
        installer_sha256, mixer_weather_command, resolve_local_update, validate_kenultra_catalog,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn formats_bounded_mixer_weather_commands() {
        assert_eq!(mixer_weather_command(Some(42.4)), "mixer.weather:42");
        assert_eq!(mixer_weather_command(Some(99.6)), "mixer.weather:100");
        assert_eq!(mixer_weather_command(None), "mixer.weather:?");
        assert_eq!(mixer_weather_command(Some(-1.0)), "mixer.weather:?");
        assert_eq!(mixer_weather_command(Some(101.0)), "mixer.weather:?");
        assert_eq!(mixer_weather_command(Some(f64::NAN)), "mixer.weather:?");
    }

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
