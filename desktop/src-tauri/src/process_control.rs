use crate::gpu_residency::ProcessIdentity;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, WAIT_OBJECT_0,
};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, IsProcessCritical, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
};

const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOWS_TO_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;

#[cfg(windows)]
fn filetime_100ns(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

#[cfg(windows)]
pub(crate) fn process_creation_time_100ns(pid: u32) -> Result<u64, String> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return Err(format!("OpenProcess failed: {}", unsafe { GetLastError() }));
    }
    let result = (|| {
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        if unsafe { GetProcessTimes(raw, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
            return Err("Unable to read process creation time".into());
        }
        Ok(filetime_100ns(creation))
    })();
    unsafe { CloseHandle(raw) };
    result
}

#[cfg(not(windows))]
pub(crate) fn process_creation_time_100ns(_pid: u32) -> Result<u64, String> {
    Ok(0)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionResult {
    pub action: String,
    pub success: bool,
    pub pid: u32,
    pub requested_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub still_running: bool,
    pub window_count: usize,
    pub message: String,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug)]
struct ProcessTreeTarget {
    identity: ProcessIdentity,
    expected_parent: Option<u32>,
}

#[cfg(windows)]
struct CloseContext {
    pid: u32,
    windows: usize,
}

#[cfg(windows)]
pub(crate) struct VerifiedProcessHandle {
    raw: HANDLE,
}

#[cfg(windows)]
impl VerifiedProcessHandle {
    pub(crate) fn open(identity: &ProcessIdentity, access: u32) -> Result<Self, String> {
        if identity.pid == 0 || identity.pid == std::process::id() {
            return Err("KeeMASH cannot target itself".into());
        }
        let raw = unsafe {
            OpenProcess(
                access | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                identity.pid,
            )
        };
        if raw.is_null() {
            return Err(format!("OpenProcess failed: {}", unsafe { GetLastError() }));
        }
        let handle = Self { raw };
        handle.verify(identity)?;
        Ok(handle)
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.raw
    }

    fn verify(&self, identity: &ProcessIdentity) -> Result<(), String> {
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        if unsafe { GetProcessTimes(self.raw, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err("Unable to verify process creation time".into());
        }
        let created_100ns = filetime_100ns(creation);
        if identity.creation_time_100ns.is_empty() {
            return Err("Exact process creation time is required".into());
        }
        let expected = identity
            .creation_time_100ns
            .parse::<u64>()
            .map_err(|_| "Invalid exact process creation time")?;
        if created_100ns != expected {
            return Err("Process identity changed (exact creation time mismatch)".into());
        }
        let started_at = created_100ns.saturating_sub(WINDOWS_TO_UNIX_EPOCH_100NS) / 10_000_000;
        if started_at != identity.started_at {
            return Err("Process identity changed (PID was reused)".into());
        }
        let mut path = vec![0_u16; 32_768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.raw, 0, path.as_mut_ptr(), &mut length) } == 0 {
            return Err("Unable to verify process executable".into());
        }
        path.truncate(length as usize);
        let current_path = canonical_path(Path::new(&String::from_utf16_lossy(&path)));
        if current_path.is_empty() || !same_path(&current_path, &identity.executable_path) {
            return Err("Process executable identity changed".into());
        }
        let name = Path::new(&current_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if blocked_process(identity.pid, name, &current_path) {
            return Err("Critical, protected, and KeeMASH processes cannot be controlled".into());
        }
        let mut critical = 1;
        if unsafe { IsProcessCritical(self.raw, &mut critical) } == 0 || critical != 0 {
            return Err("Critical or unverifiable process cannot be controlled".into());
        }
        if !identity.executable_hash.is_empty()
            && executable_hash(Path::new(&current_path))? != identity.executable_hash
        {
            return Err("Executable hash changed".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for VerifiedProcessHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.raw) };
    }
}

#[cfg(windows)]
unsafe extern "system" fn close_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    let context = &mut *(lparam as *mut CloseContext);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == context.pid && PostMessageW(hwnd, WM_CLOSE, 0, 0) != 0 {
        context.windows += 1;
    }
    1
}

pub fn close_process(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    close_process_platform(identity)
}

#[cfg(windows)]
fn close_process_platform(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    let handle = VerifiedProcessHandle::open(identity, 0)?;
    let mut context = CloseContext {
        pid: identity.pid,
        windows: 0,
    };
    unsafe {
        EnumWindows(
            Some(close_window),
            &mut context as *mut CloseContext as LPARAM,
        );
    }
    if context.windows == 0 {
        return Ok(ProcessActionResult {
            action: "close".into(),
            success: false,
            pid: identity.pid,
            requested_count: 1,
            completed_count: 0,
            failed_count: 0,
            still_running: true,
            window_count: 0,
            message: "Process has no top-level window; force termination requires confirmation"
                .into(),
            errors: Vec::new(),
        });
    }
    let deadline = Instant::now() + GRACEFUL_CLOSE_TIMEOUT;
    let mut exited = false;
    while Instant::now() < deadline {
        if unsafe { WaitForSingleObject(handle.raw, 100) } == WAIT_OBJECT_0 {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(ProcessActionResult {
        action: "close".into(),
        success: exited,
        pid: identity.pid,
        requested_count: 1,
        completed_count: usize::from(exited),
        failed_count: 0,
        still_running: !exited,
        window_count: context.windows,
        message: if exited {
            "Process closed normally".into()
        } else {
            "Process did not close within 5 seconds; force termination requires confirmation".into()
        },
        errors: Vec::new(),
    })
}

#[cfg(not(windows))]
fn close_process_platform(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    Err(format!(
        "Process {} control is available only on Windows",
        identity.pid
    ))
}

pub fn terminate_process(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    let result = terminate_identity(identity);
    Ok(ProcessActionResult {
        action: "terminate".into(),
        success: result.is_ok(),
        pid: identity.pid,
        requested_count: 1,
        completed_count: usize::from(result.is_ok()),
        failed_count: usize::from(result.is_err()),
        still_running: result.is_err(),
        window_count: 0,
        message: result
            .as_ref()
            .map(|_| "Process terminated".to_string())
            .unwrap_or_else(|error| error.clone()),
        errors: result.err().into_iter().collect(),
    })
}

pub fn terminate_process_tree(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    #[cfg(windows)]
    let _root = VerifiedProcessHandle::open(identity, 0)?;
    let targets = process_tree_targets(identity)?;
    let requested_count = targets.len();
    for target in &targets {
        validate_tree_target(target)?;
    }
    let mut completed_count = 0usize;
    let mut errors = Vec::new();
    for target in &targets {
        let result =
            validate_tree_target(target).and_then(|_| terminate_identity(&target.identity));
        if let Err(error) = result {
            errors.push(format!("PID {}: {error}", target.identity.pid));
            break;
        } else {
            completed_count += 1;
        }
    }
    Ok(ProcessActionResult {
        action: "terminate_tree".into(),
        success: errors.is_empty(),
        pid: identity.pid,
        requested_count,
        completed_count,
        failed_count: requested_count.saturating_sub(completed_count),
        still_running: completed_count < requested_count,
        window_count: 0,
        message: if errors.is_empty() {
            format!("Terminated {completed_count} process(es) leaf-first")
        } else {
            format!("Terminated {completed_count}/{requested_count} process(es)")
        },
        errors,
    })
}

#[cfg(windows)]
fn terminate_identity(identity: &ProcessIdentity) -> Result<(), String> {
    let handle = VerifiedProcessHandle::open(identity, PROCESS_TERMINATE)?;
    let ok = unsafe { TerminateProcess(handle.raw, 0x4B4D_0001) };
    let error = unsafe { GetLastError() };
    if ok == 0 {
        return Err(format!("TerminateProcess failed: {error}"));
    }
    let wait = unsafe { WaitForSingleObject(handle.raw, 2_000) };
    if wait != WAIT_OBJECT_0 {
        return Err("Process accepted termination but did not exit within 2 seconds".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn terminate_identity(_identity: &ProcessIdentity) -> Result<(), String> {
    Err("Process termination is available only on Windows".into())
}

#[cfg(windows)]
fn process_tree_pairs() -> Result<BTreeMap<u32, u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!("CreateToolhelp32Snapshot failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut pairs = BTreeMap::new();
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        pairs.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    Ok(pairs)
}

#[cfg(not(windows))]
fn process_tree_pairs() -> Result<BTreeMap<u32, u32>, String> {
    Ok(BTreeMap::new())
}

fn derive_tree_depths(pairs: &BTreeMap<u32, u32>, root_pid: u32) -> BTreeMap<u32, usize> {
    let mut depths = BTreeMap::from([(root_pid, 0usize)]);
    loop {
        let mut changed = false;
        for (&pid, &parent) in pairs {
            if depths.contains_key(&pid) {
                continue;
            }
            if let Some(parent_depth) = depths.get(&parent).copied() {
                depths.insert(pid, parent_depth + 1);
                changed = true;
            }
        }
        if !changed {
            return depths;
        }
    }
}

fn validate_tree_target(target: &ProcessTreeTarget) -> Result<(), String> {
    #[cfg(windows)]
    let _verified = VerifiedProcessHandle::open(&target.identity, 0)?;
    if let Some(expected_parent) = target.expected_parent {
        let current_parent = process_tree_pairs()
            .map_err(|error| format!("Unable to revalidate process tree: {error}"))?
            .get(&target.identity.pid)
            .copied();
        if current_parent != Some(expected_parent) {
            return Err(format!(
                "Process parent changed (expected {expected_parent}, found {})",
                current_parent
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "missing".into())
            ));
        }
    }
    Ok(())
}

fn process_tree_targets(root: &ProcessIdentity) -> Result<Vec<ProcessTreeTarget>, String> {
    let pairs = process_tree_pairs()?;
    let depths = derive_tree_depths(&pairs, root.pid);
    let wanted = depths.keys().copied().collect::<BTreeSet<_>>();
    let wanted_count = wanted.len();
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut targets = wanted
        .into_iter()
        .filter_map(|pid| {
            if pid == root.pid {
                return Some(ProcessTreeTarget {
                    identity: root.clone(),
                    expected_parent: None,
                });
            }
            let process = system.process(Pid::from_u32(pid))?;
            Some(ProcessTreeTarget {
                identity: ProcessIdentity {
                    pid,
                    started_at: process.start_time(),
                    creation_time_100ns: process_creation_time_100ns(pid).ok()?.to_string(),
                    executable_path: process.exe()?.to_string_lossy().into_owned(),
                    executable_hash: String::new(),
                },
                expected_parent: pairs.get(&pid).copied(),
            })
        })
        .collect::<Vec<_>>();
    if targets.len() != wanted_count {
        return Err("Process tree changed while identities were being captured".into());
    }
    targets.sort_by_key(|target| {
        std::cmp::Reverse(
            depths
                .get(&target.identity.pid)
                .copied()
                .unwrap_or_default(),
        )
    });
    Ok(targets)
}

fn canonical_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    let left = canonical_path(Path::new(left));
    let right = canonical_path(Path::new(right));
    normalize_extended_path(&left).eq_ignore_ascii_case(normalize_extended_path(&right))
}

fn normalize_extended_path(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path).trim()
}

fn executable_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Unable to open executable for identity hash: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to hash executable: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn blocked_process(pid: u32, name: &str, path: &str) -> bool {
    if pid <= 4 || pid == std::process::id() {
        return true;
    }
    let name = name.to_ascii_lowercase();
    let path = path.to_ascii_lowercase();
    const BLOCKED: &[&str] = &[
        "system",
        "registry",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "services.exe",
        "lsass.exe",
        "winlogon.exe",
        "fontdrvhost.exe",
        "dwm.exe",
        "audiodg.exe",
        "sihost.exe",
        "securityhealthservice.exe",
        "msmpeng.exe",
        "keemash-desktop.exe",
        "keemashsensorhost.exe",
        "keemash-injector.exe",
    ];
    BLOCKED.iter().any(|item| name == *item)
        || path.contains("keemash-desktop")
        || path.contains("keemashsensorhost")
        || path.contains("\\keemash\\")
}

#[cfg(test)]
mod tests {
    use super::{
        derive_tree_depths, process_creation_time_100ns, terminate_process, ProcessIdentity,
    };
    use std::collections::BTreeMap;

    #[test]
    fn derives_leaf_first_process_order() {
        let pairs = BTreeMap::from([(10u32, 1u32), (11, 10), (12, 10), (13, 11)]);
        let depths = derive_tree_depths(&pairs, 10);
        let mut order = depths.into_iter().collect::<Vec<_>>();
        order.sort_by_key(|(_, depth)| std::cmp::Reverse(*depth));
        assert_eq!(order[0].0, 13);
        assert_eq!(order.last().unwrap().0, 10);
    }

    #[cfg(windows)]
    #[test]
    fn verified_handle_rejects_stale_identity_and_terminates_disposable_process() {
        use std::process::{Command, Stdio};
        use std::thread;
        use std::time::{Duration, Instant};
        use sysinfo::{Pid, ProcessesToUpdate, System};

        let ping = std::path::Path::new(r"C:\Windows\System32\PING.EXE");
        let mut child = Command::new(ping)
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("disposable process should start");
        let pid = child.id();

        let deadline = Instant::now() + Duration::from_secs(3);
        let identity = loop {
            let mut system = System::new_all();
            system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
            if let Some(process) = system.process(Pid::from_u32(pid)) {
                if let Some(path) = process.exe() {
                    break ProcessIdentity {
                        pid,
                        started_at: process.start_time(),
                        creation_time_100ns: process_creation_time_100ns(pid)
                            .expect("exact creation time should be readable")
                            .to_string(),
                        executable_path: path.to_string_lossy().into_owned(),
                        executable_hash: String::new(),
                    };
                }
            }
            assert!(
                Instant::now() < deadline,
                "disposable process was not visible"
            );
            thread::sleep(Duration::from_millis(25));
        };

        let mut stale = identity.clone();
        stale.creation_time_100ns = stale
            .creation_time_100ns
            .parse::<u64>()
            .expect("exact creation time should parse")
            .saturating_add(1)
            .to_string();
        let stale_result = terminate_process(&stale).expect("stale action should be reported");
        assert!(!stale_result.success);
        assert!(child
            .try_wait()
            .expect("process query should work")
            .is_none());

        let result = terminate_process(&identity).expect("verified process action should run");
        assert!(result.success, "{}", result.message);
        let _ = child.wait();
    }
}
