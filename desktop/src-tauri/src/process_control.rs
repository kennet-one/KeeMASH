use crate::gpu_residency::{validate_identity, ProcessIdentity};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HWND, INVALID_HANDLE_VALUE, LPARAM, WAIT_OBJECT_0,
};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
};

const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

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
    validate_identity(identity)?;
    close_process_platform(identity)
}

#[cfg(windows)]
fn close_process_platform(identity: &ProcessIdentity) -> Result<ProcessActionResult, String> {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, identity.pid) };
    if handle.is_null() {
        return Err(format!(
            "Unable to monitor process {}: {}",
            identity.pid,
            unsafe { GetLastError() }
        ));
    }
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
        unsafe { CloseHandle(handle) };
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
        if unsafe { WaitForSingleObject(handle, 100) } == WAIT_OBJECT_0 {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    unsafe { CloseHandle(handle) };
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
    validate_identity(identity)?;
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
    validate_identity(identity)?;
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
    validate_identity(identity)?;
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, identity.pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess failed: {}", unsafe { GetLastError() }));
    }
    let ok = unsafe { TerminateProcess(handle, 0x4B4D_0001) };
    let error = unsafe { GetLastError() };
    if ok == 0 {
        unsafe { CloseHandle(handle) };
        return Err(format!("TerminateProcess failed: {error}"));
    }
    let wait = unsafe { WaitForSingleObject(handle, 2_000) };
    unsafe { CloseHandle(handle) };
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
    validate_identity(&target.identity)?;
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

#[cfg(test)]
mod tests {
    use super::derive_tree_depths;
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
}
