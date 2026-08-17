use crate::gpu_residency::GpuResidencyManager;
use crate::runtime::{RuntimeController, RuntimeSnapshot};
use serde::Serialize;
use std::collections::BTreeSet;
use std::env;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use tauri::AppHandle;

const RESTART_HELPER_ARG: &str = "--keemash-graphics-restart-helper";
const GPU_PREFERENCES_KEY: &str = "Software\\Microsoft\\DirectX\\UserGpuPreferences";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsAdapterInfo {
    pub luid: String,
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_video_bytes: u64,
    pub shared_system_bytes: u64,
    pub preference: String,
    pub preference_rank: u32,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsMasterSelection {
    pub luid: Option<String>,
    pub name: String,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsRuntimeStatus {
    pub adapters: Vec<GraphicsAdapterInfo>,
    pub selected: GraphicsMasterSelection,
    pub active_native_luid: Option<String>,
    pub observed_luids: Vec<String>,
    pub observed_names: Vec<String>,
    pub webview_preference: String,
    pub registry_preference: Option<u32>,
    pub restart_required: bool,
    pub fallback_reason: Option<String>,
}

pub struct GraphicsRuntimeManager {
    boot_luid: Mutex<Option<String>>,
}

impl Default for GraphicsRuntimeManager {
    fn default() -> Self {
        Self {
            boot_luid: Mutex::new(None),
        }
    }
}

impl GraphicsRuntimeManager {
    pub fn initialize(&self, selected_luid: Option<String>) {
        *lock(&self.boot_luid) = selected_luid.map(normalize_luid);
    }

    pub fn status(
        &self,
        selected_luid: Option<String>,
        residency: &GpuResidencyManager,
    ) -> Result<GraphicsRuntimeStatus, String> {
        let adapters = enumerate_adapters()?;
        let selected_luid = selected_luid.map(normalize_luid);
        let selected_adapter = selected_luid
            .as_ref()
            .and_then(|luid| adapters.iter().find(|adapter| adapter.luid == *luid));
        let boot_luid = lock(&self.boot_luid).clone();
        let active_native_luid = boot_luid
            .as_ref()
            .filter(|luid| adapters.iter().any(|adapter| adapter.luid == **luid))
            .cloned();
        let selected = GraphicsMasterSelection {
            luid: selected_luid.clone(),
            name: selected_adapter
                .map(|adapter| adapter.name.clone())
                .unwrap_or_else(|| {
                    if selected_luid.is_some() {
                        "Unavailable adapter".into()
                    } else {
                        "Auto (Windows)".into()
                    }
                }),
            available: selected_luid.is_none() || selected_adapter.is_some(),
        };
        let observed_luids = residency
            .observed_adapters_for_current_tree()
            .into_iter()
            .map(|value| normalize_observed_luid(&value))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let observed_names = observed_luids
            .iter()
            .map(|luid| {
                adapters
                    .iter()
                    .find(|adapter| adapter.luid == *luid)
                    .map(|adapter| adapter.name.clone())
                    .unwrap_or_else(|| luid.clone())
            })
            .collect();
        let executable = canonical_current_exe()?;
        let registry_preference = read_gpu_preference(&executable)?;
        let webview_preference = match registry_preference {
            Some(1) => "minimumPower",
            Some(2) => "highPerformance",
            _ => "system",
        }
        .to_string();
        let expected_registry_preference = selected_adapter.map(preference_value);
        let fallback_reason = if selected_luid.is_some() && selected_adapter.is_none() {
            Some("Selected adapter is unavailable; Windows default is active".into())
        } else if expected_registry_preference != registry_preference {
            Some("Windows graphics preference does not match the saved master GPU".into())
        } else if selected_luid.is_some()
            && boot_luid == selected_luid
            && !observed_luids.is_empty()
            && !observed_luids
                .iter()
                .any(|value| Some(value) == selected_luid.as_ref())
        {
            Some("WebView2 is currently observed on a different GPU".into())
        } else {
            None
        };
        Ok(GraphicsRuntimeStatus {
            adapters,
            selected,
            active_native_luid,
            observed_luids,
            observed_names,
            webview_preference,
            registry_preference,
            restart_required: boot_luid != selected_luid,
            fallback_reason,
        })
    }

    pub fn set_master(
        &self,
        app: &AppHandle,
        runtime: &RuntimeController,
        residency: &GpuResidencyManager,
        luid: Option<String>,
    ) -> Result<(RuntimeSnapshot, GraphicsRuntimeStatus), String> {
        let adapters = enumerate_adapters()?;
        let luid = luid.map(normalize_luid);
        let selected = luid
            .as_ref()
            .map(|value| {
                adapters
                    .iter()
                    .find(|adapter| adapter.luid == *value)
                    .ok_or_else(|| "Selected GPU is no longer available".to_string())
            })
            .transpose()?;
        let preference = selected.map(preference_value);
        let executable = canonical_current_exe()?;
        let previous_raw = read_preference_raw(&executable)?;
        write_gpu_preference(&executable, preference)?;
        let snapshot = match runtime.set_master_gpu(app, luid.clone()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let rollback = write_preference_raw(&executable, previous_raw.as_deref());
                return Err(match rollback {
                    Ok(()) => format!("GPU profile persistence failed; registry was rolled back: {error}"),
                    Err(rollback_error) => format!(
                        "GPU profile persistence failed ({error}); registry rollback also failed: {rollback_error}"
                    ),
                });
            }
        };
        let status = self.status(luid, residency)?;
        Ok((snapshot, status))
    }
}

fn preference_value(adapter: &GraphicsAdapterInfo) -> u32 {
    if adapter.preference == "minimumPower" {
        1
    } else {
        2
    }
}

fn normalize_luid(value: String) -> String {
    normalize_observed_luid(&value)
}

fn normalize_observed_luid(value: &str) -> String {
    value
        .split("_phys_")
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn enumerate_adapters() -> Result<Vec<GraphicsAdapterInfo>, String> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory6, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, DXGI_GPU_PREFERENCE_MINIMUM_POWER,
    };

    let factory: IDXGIFactory6 = unsafe { CreateDXGIFactory1() }
        .map_err(|error| format!("DXGI factory creation failed: {error}"))?;
    let ranked = |preference| {
        let mut result = Vec::new();
        for index in 0..64 {
            let adapter =
                unsafe { factory.EnumAdapterByGpuPreference::<IDXGIAdapter1>(index, preference) };
            let Ok(adapter) = adapter else { break };
            let desc = unsafe { adapter.GetDesc1() }
                .map_err(|error| format!("DXGI adapter description failed: {error}"))?;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0 {
                result.push(format_luid(
                    desc.AdapterLuid.LowPart,
                    desc.AdapterLuid.HighPart,
                ));
            }
        }
        Ok::<Vec<String>, String>(result)
    };
    let minimum = ranked(DXGI_GPU_PREFERENCE_MINIMUM_POWER)?;
    let high = ranked(DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)?;
    let mut result = Vec::new();
    for index in 0..64 {
        let adapter = unsafe { factory.EnumAdapters1(index) };
        let Ok(adapter) = adapter else { break };
        let desc = unsafe { adapter.GetDesc1() }
            .map_err(|error| format!("DXGI adapter description failed: {error}"))?;
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let luid = format_luid(desc.AdapterLuid.LowPart, desc.AdapterLuid.HighPart);
        let minimum_rank = minimum
            .iter()
            .position(|value| value == &luid)
            .unwrap_or(63) as u32;
        let high_rank = high.iter().position(|value| value == &luid).unwrap_or(63) as u32;
        let (preference, preference_rank) = if minimum.len() <= 1 {
            ("system", 0)
        } else if minimum_rank < high_rank {
            ("minimumPower", minimum_rank)
        } else {
            ("highPerformance", high_rank)
        };
        let name_end = desc
            .Description
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(desc.Description.len());
        result.push(GraphicsAdapterInfo {
            luid,
            name: String::from_utf16_lossy(&desc.Description[..name_end]),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            dedicated_video_bytes: desc.DedicatedVideoMemory as u64,
            shared_system_bytes: desc.SharedSystemMemory as u64,
            preference: preference.into(),
            preference_rank,
            available: true,
        });
    }
    result.sort_by_key(|adapter| {
        (
            adapter.preference != "highPerformance",
            adapter.preference_rank,
            adapter.name.clone(),
        )
    });
    Ok(result)
}

#[cfg(not(windows))]
fn enumerate_adapters() -> Result<Vec<GraphicsAdapterInfo>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn format_luid(low: u32, high: i32) -> String {
    format!("0x{:08x}_0x{:08x}", high as u32, low)
}

fn canonical_current_exe() -> Result<PathBuf, String> {
    let path =
        env::current_exe().map_err(|error| format!("Current executable lookup failed: {error}"))?;
    path.canonicalize()
        .map_err(|error| format!("Current executable canonicalization failed: {error}"))
}

fn update_preference_raw(raw: Option<&str>, preference: Option<u32>) -> Option<String> {
    let mut tokens = raw
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .filter(|token| !token.to_ascii_lowercase().starts_with("gpupreference="))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(preference) = preference {
        tokens.push(format!("GpuPreference={preference}"));
    }
    (!tokens.is_empty()).then(|| format!("{};", tokens.join(";")))
}

fn read_gpu_preference(path: &Path) -> Result<Option<u32>, String> {
    Ok(read_preference_raw(path)?.and_then(|raw| {
        raw.split(';').find_map(|token| {
            let (key, value) = token.trim().split_once('=')?;
            key.eq_ignore_ascii_case("GpuPreference")
                .then(|| value.parse().ok())
                .flatten()
        })
    }))
}

fn write_gpu_preference(path: &Path, preference: Option<u32>) -> Result<(), String> {
    let current = read_preference_raw(path)?;
    let next = update_preference_raw(current.as_deref(), preference);
    write_preference_raw(path, next.as_deref())
}

#[cfg(windows)]
fn read_preference_raw(path: &Path) -> Result<Option<String>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
    };
    let key_name = wide(GPU_PREFERENCES_KEY);
    let value_name = wide(&path.to_string_lossy());
    let mut key: HKEY = null_mut();
    let status =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key_name.as_ptr(), 0, KEY_READ, &mut key) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(format!("GPU preference registry open failed: {status}"));
    }
    let result = (|| {
        let mut kind = 0u32;
        let mut bytes = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                key,
                value_name.as_ptr(),
                null(),
                &mut kind,
                null_mut(),
                &mut bytes,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS || kind != REG_SZ {
            return Err(format!("GPU preference registry query failed: {status}"));
        }
        let mut data = vec![0u16; (bytes as usize).div_ceil(2).max(1)];
        let status = unsafe {
            RegQueryValueExW(
                key,
                value_name.as_ptr(),
                null(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("GPU preference registry read failed: {status}"));
        }
        let length = data
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(data.len());
        Ok(Some(String::from_utf16_lossy(&data[..length])))
    })();
    unsafe { RegCloseKey(key) };
    result
}

#[cfg(not(windows))]
fn read_preference_raw(_path: &Path) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(windows)]
fn write_preference_raw(path: &Path, raw: Option<&str>) -> Result<(), String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        REG_SZ,
    };
    let key_name = wide(GPU_PREFERENCES_KEY);
    let value_name = wide(&path.to_string_lossy());
    let mut key: HKEY = null_mut();
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, key_name.as_ptr(), &mut key) };
    if status != ERROR_SUCCESS {
        return Err(format!("GPU preference registry create failed: {status}"));
    }
    let status = if let Some(raw) = raw {
        let data = wide(raw);
        unsafe {
            RegSetValueExW(
                key,
                value_name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * size_of::<u16>()) as u32,
            )
        }
    } else {
        unsafe { RegDeleteValueW(key, value_name.as_ptr()) }
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
        return Err(format!("GPU preference registry write failed: {status}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn write_preference_raw(_path: &Path, _raw: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
pub fn launch_restart_helper() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let executable = canonical_current_exe()?;
    let creation = crate::process_control::process_creation_time_100ns(std::process::id())?;
    Command::new(executable)
        .args([
            RESTART_HELPER_ARG,
            &std::process::id().to_string(),
            &creation.to_string(),
        ])
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|error| format!("Graphics restart helper failed to start: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn launch_restart_helper() -> Result<(), String> {
    Err("Graphics restart is supported only on Windows".into())
}

#[cfg(windows)]
pub fn maybe_run_restart_helper() -> Option<i32> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    let args = env::args().collect::<Vec<_>>();
    let index = args.iter().position(|arg| arg == RESTART_HELPER_ARG)?;
    let pid = args
        .get(index + 1)
        .and_then(|value| value.parse::<u32>().ok());
    let creation = args
        .get(index + 2)
        .and_then(|value| value.parse::<u64>().ok());
    let Some((pid, expected_creation)) = pid.zip(creation) else {
        return Some(2);
    };
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return Some(3);
    }
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let valid = unsafe { GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) }
        != 0
        && (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
            == expected_creation;
    let waited = valid && unsafe { WaitForSingleObject(handle, 30_000) } == WAIT_OBJECT_0;
    unsafe { CloseHandle(handle) };
    if !waited {
        return Some(4);
    }
    std::thread::sleep(std::time::Duration::from_millis(350));
    let executable = match canonical_current_exe() {
        Ok(path) => path,
        Err(_) => return Some(5),
    };
    Some(
        Command::new(executable)
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| 0)
            .unwrap_or(6),
    )
}

#[cfg(not(windows))]
pub fn maybe_run_restart_helper() -> Option<i32> {
    None
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{normalize_observed_luid, update_preference_raw};

    #[test]
    fn preserves_unrelated_graphics_preference_tokens() {
        assert_eq!(
            update_preference_raw(Some("VRROptimizeEnable=0;GpuPreference=1;"), Some(2)),
            Some("VRROptimizeEnable=0;GpuPreference=2;".into())
        );
        assert_eq!(update_preference_raw(Some("GpuPreference=2;"), None), None);
    }

    #[test]
    fn normalizes_pdh_adapter_suffixes() {
        assert_eq!(
            normalize_observed_luid("0x00000000_0x00012ECB_phys_0"),
            "0x00000000_0x00012ecb"
        );
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_unique_hardware_adapters_with_stable_luids() {
        use super::enumerate_adapters;
        use std::collections::BTreeSet;

        let adapters = enumerate_adapters().expect("DXGI adapter enumeration");
        assert!(!adapters.is_empty());
        assert_eq!(
            adapters
                .iter()
                .map(|adapter| adapter.luid.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            adapters.len()
        );
        assert!(adapters.iter().all(|adapter| {
            adapter.luid.starts_with("0x")
                && adapter.luid.contains("_0x")
                && !adapter.name.trim().is_empty()
        }));
    }
}
