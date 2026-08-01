use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const CCC_SHARED_RUNTIME_ROOT: &str = r"C:\Users\kennet\.cocoindex_code";
pub const CCC_CLI_PATH: &str = r"C:\Users\kennet\scoop\apps\python313\current\Scripts\ccc.exe";

const CCC_PYTHON_PATH: &str = r"C:\Users\kennet\scoop\apps\python313\current\python.exe";
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CccDaemonState {
    Running,
    Stopped,
    StalePid,
    IdentityMismatch,
    Unavailable,
    #[cfg(not(windows))]
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CccPidSource {
    None,
    PidFile,
    RecoveredProcessScan,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CccGpuProcessMemory {
    pub dedicated_bytes: u64,
    pub shared_bytes: u64,
    pub instance_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CccDaemonProcess {
    pub pid: u32,
    pub name: String,
    pub executable_path: String,
    pub command_line: String,
    pub working_set_bytes: u64,
    pub private_bytes: u64,
    pub thread_count: u32,
    pub started_at: Option<String>,
    pub gpu_memory: CccGpuProcessMemory,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CccDaemonStatus {
    pub state: CccDaemonState,
    pub runtime_root: String,
    pub pid_file: String,
    pub cli_path: String,
    pub cli_available: bool,
    pub pid: Option<u32>,
    pub pid_file_value: Option<u32>,
    pub pid_source: CccPidSource,
    pub identity_valid: bool,
    pub process: Option<CccDaemonProcess>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CccDaemonAction {
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CccDaemonActionResult {
    pub action: CccDaemonAction,
    pub success: bool,
    pub forced: bool,
    pub message: String,
    pub cli_stdout: String,
    pub cli_stderr: String,
    pub status: CccDaemonStatus,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawProcessSnapshot {
    found: bool,
    process_id: Option<u32>,
    name: Option<String>,
    executable_path: Option<String>,
    command_line: Option<String>,
    creation_date: Option<String>,
    working_set_bytes: Option<u64>,
    private_bytes: Option<u64>,
    thread_count: Option<u32>,
    #[serde(default)]
    gpu: Vec<RawGpuMemory>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawGpuMemory {
    name: String,
    dedicated_usage: Option<u64>,
    shared_usage: Option<u64>,
}

pub fn inspect_shared_daemon() -> CccDaemonStatus {
    inspect_at(Path::new(CCC_SHARED_RUNTIME_ROOT), Path::new(CCC_CLI_PATH))
}

pub fn start_shared_daemon(timeout_ms: Option<u64>) -> Result<CccDaemonActionResult, String> {
    manage_daemon(CccDaemonAction::Start, bounded_timeout(timeout_ms))
}

pub fn stop_shared_daemon(timeout_ms: Option<u64>) -> Result<CccDaemonActionResult, String> {
    manage_daemon(CccDaemonAction::Stop, bounded_timeout(timeout_ms))
}

pub fn restart_shared_daemon(timeout_ms: Option<u64>) -> Result<CccDaemonActionResult, String> {
    manage_daemon(CccDaemonAction::Restart, bounded_timeout(timeout_ms))
}

fn bounded_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    )
}

fn pid_path(root: &Path) -> PathBuf {
    root.join("daemon.pid")
}

fn parse_pid(contents: &str) -> Result<u32, String> {
    let trimmed = contents.trim();
    if trimmed.is_empty() || trimmed.lines().count() != 1 {
        return Err("daemon.pid must contain exactly one PID".into());
    }
    if !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("daemon.pid contains non-decimal characters".into());
    }
    let pid = trimmed
        .parse::<u32>()
        .map_err(|error| format!("daemon.pid is invalid: {error}"))?;
    if pid == 0 {
        return Err("daemon.pid cannot contain PID 0".into());
    }
    Ok(pid)
}

fn base_status(root: &Path, cli: &Path) -> CccDaemonStatus {
    CccDaemonStatus {
        state: CccDaemonState::Stopped,
        runtime_root: root.display().to_string(),
        pid_file: pid_path(root).display().to_string(),
        cli_path: cli.display().to_string(),
        cli_available: cli.is_file(),
        pid: None,
        pid_file_value: None,
        pid_source: CccPidSource::None,
        identity_valid: false,
        process: None,
        message: "CCC daemon is stopped".into(),
    }
}

#[cfg(windows)]
fn inspect_at(root: &Path, cli: &Path) -> CccDaemonStatus {
    let mut status = base_status(root, cli);
    let marker = pid_path(root);
    let contents = match fs::read_to_string(&marker) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return recover_unique_daemon(status);
        }
        Err(error) => {
            status.state = CccDaemonState::Unavailable;
            status.message = format!("Unable to read {}: {error}", marker.display());
            return status;
        }
    };
    let pid = match parse_pid(&contents) {
        Ok(pid) => pid,
        Err(error) => {
            status.state = CccDaemonState::StalePid;
            status.message = error;
            return recover_unique_daemon(status);
        }
    };
    status.pid = Some(pid);
    status.pid_file_value = Some(pid);
    status.pid_source = CccPidSource::PidFile;

    let raw = match query_process_snapshot(pid, Duration::from_secs(5)) {
        Ok(raw) => raw,
        Err(error) => {
            status.state = CccDaemonState::Unavailable;
            status.message = format!("Unable to inspect daemon PID {pid}: {error}");
            return status;
        }
    };
    if !raw.found {
        status.state = CccDaemonState::StalePid;
        status.message = format!("daemon.pid references missing PID {pid}");
        return recover_unique_daemon(status);
    }

    let identity_valid = raw_identity_valid(&raw);
    let process = process_from_raw(raw, pid);
    status.identity_valid = identity_valid;
    status.process = Some(process);
    if identity_valid {
        status.state = CccDaemonState::Running;
        status.message = "Verified shared CocoIndex daemon is running".into();
    } else {
        status.state = CccDaemonState::IdentityMismatch;
        status.message = format!(
            "PID {pid} exists but is not the verified shared CocoIndex daemon; management is blocked"
        );
    }
    status
}

#[cfg(windows)]
fn recover_unique_daemon(mut status: CccDaemonStatus) -> CccDaemonStatus {
    let candidates = match query_daemon_candidates(Duration::from_secs(5)) {
        Ok(candidates) => candidates,
        Err(error) => {
            status.state = CccDaemonState::Unavailable;
            status.message = format!("Unable to recover daemon identity: {error}");
            return status;
        }
    };
    let mut verified = candidates
        .into_iter()
        .filter(|candidate| candidate.found && raw_identity_valid(candidate));
    let Some(raw) = verified.next() else {
        return status;
    };
    if verified.next().is_some() {
        status.state = CccDaemonState::Unavailable;
        status.message = "Multiple exact run-daemon processes exist; management is blocked".into();
        return status;
    }
    let process = process_from_raw(raw, 0);
    status.pid = Some(process.pid);
    status.pid_source = CccPidSource::RecoveredProcessScan;
    status.identity_valid = true;
    status.message = match status.pid_file_value {
        Some(marker_pid) => format!(
            "Verified daemon PID {} recovered; daemon.pid still contains stale PID {marker_pid}",
            process.pid
        ),
        None => format!(
            "Verified daemon PID {} recovered without a valid daemon.pid marker",
            process.pid
        ),
    };
    status.process = Some(process);
    status.state = CccDaemonState::Running;
    status
}

fn raw_identity_valid(raw: &RawProcessSnapshot) -> bool {
    validate_process_identity(
        raw.executable_path.as_deref().unwrap_or_default(),
        raw.command_line.as_deref().unwrap_or_default(),
    )
}

fn process_from_raw(raw: RawProcessSnapshot, fallback_pid: u32) -> CccDaemonProcess {
    CccDaemonProcess {
        pid: raw.process_id.unwrap_or(fallback_pid),
        name: raw.name.unwrap_or_default(),
        executable_path: raw.executable_path.unwrap_or_default(),
        command_line: raw.command_line.unwrap_or_default(),
        working_set_bytes: raw.working_set_bytes.unwrap_or_default(),
        private_bytes: raw.private_bytes.unwrap_or_default(),
        thread_count: raw.thread_count.unwrap_or_default(),
        started_at: raw.creation_date,
        gpu_memory: aggregate_gpu_usage(&raw.gpu),
    }
}

#[cfg(not(windows))]
fn inspect_at(root: &Path, cli: &Path) -> CccDaemonStatus {
    let mut status = base_status(root, cli);
    status.state = CccDaemonState::Unsupported;
    status.message = "CCC daemon inspection is available only on Windows".into();
    status
}

#[cfg(windows)]
fn query_process_snapshot(pid: u32, timeout: Duration) -> Result<RawProcessSnapshot, String> {
    let script = format!(
        "$ErrorActionPreference='Stop';$id=[uint32]{pid};\
         $c=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";\
         if($null -eq $c){{[pscustomobject]@{{Found=$false}}|ConvertTo-Json -Compress;exit 0}};\
         $p=Get-Process -Id $id -ErrorAction Stop;\
         $g=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory \
           -ErrorAction SilentlyContinue|Where-Object{{$_.Name -match ('^pid_'+$id+'_')}}|\
           ForEach-Object{{[pscustomobject]@{{Name=[string]$_.Name;DedicatedUsage=[uint64]$_.DedicatedUsage;SharedUsage=[uint64]$_.SharedUsage}}}});\
         [pscustomobject]@{{Found=$true;ProcessId=[uint32]$c.ProcessId;Name=[string]$c.Name;\
           ExecutablePath=[string]$c.ExecutablePath;CommandLine=[string]$c.CommandLine;\
           CreationDate=[string]$c.CreationDate;WorkingSetBytes=[uint64]$p.WorkingSet64;\
           PrivateBytes=[uint64]$p.PrivateMemorySize64;ThreadCount=[uint32]$p.Threads.Count;Gpu=$g}}|\
           ConvertTo-Json -Compress -Depth 4"
    );
    let output = run_bounded(
        Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ],
        timeout,
    )?;
    if !output.status.success() {
        return Err(output_error("PowerShell process inspection", &output));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("PowerShell returned non-UTF-8 JSON: {error}"))?;
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Invalid process inspection JSON: {error}"))
}

#[cfg(windows)]
fn query_daemon_candidates(timeout: Duration) -> Result<Vec<RawProcessSnapshot>, String> {
    let script = "$ErrorActionPreference='Stop';\
        $rows=@(Get-CimInstance Win32_Process|\
        Where-Object{[string]$_.CommandLine -like '*run-daemon*'}|ForEach-Object{\
        $c=$_;$p=Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue;if($null -ne $p){\
        $id=[uint32]$c.ProcessId;\
        $g=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory \
        -ErrorAction SilentlyContinue|Where-Object{$_.Name -match ('^pid_'+$id+'_')}|\
        ForEach-Object{[pscustomobject]@{Name=[string]$_.Name;DedicatedUsage=[uint64]$_.DedicatedUsage;SharedUsage=[uint64]$_.SharedUsage}});\
        [pscustomobject]@{Found=$true;ProcessId=$id;Name=[string]$c.Name;\
        ExecutablePath=[string]$c.ExecutablePath;CommandLine=[string]$c.CommandLine;\
        CreationDate=[string]$c.CreationDate;WorkingSetBytes=[uint64]$p.WorkingSet64;\
        PrivateBytes=[uint64]$p.PrivateMemorySize64;ThreadCount=[uint32]$p.Threads.Count;Gpu=$g}}});\
        ConvertTo-Json -InputObject @($rows) -Compress -Depth 4";
    let output = run_bounded(
        Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        timeout,
    )?;
    if !output.status.success() {
        return Err(output_error("PowerShell daemon discovery", &output));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("PowerShell returned non-UTF-8 JSON: {error}"))?;
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Invalid daemon discovery JSON: {error}"))
}

fn aggregate_gpu_usage(rows: &[RawGpuMemory]) -> CccGpuProcessMemory {
    let mut seen = HashSet::new();
    let mut result = CccGpuProcessMemory::default();
    for row in rows {
        let key = row.name.trim().to_ascii_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        result.dedicated_bytes = result
            .dedicated_bytes
            .saturating_add(row.dedicated_usage.unwrap_or_default());
        result.shared_bytes = result
            .shared_bytes
            .saturating_add(row.shared_usage.unwrap_or_default());
        result.instance_count += 1;
    }
    result
}

fn validate_process_identity(executable_path: &str, command_line: &str) -> bool {
    let argv = split_windows_command_line(command_line);
    if argv.is_empty() {
        return false;
    }
    let executable = normalize_windows_path(executable_path);
    let argv0 = normalize_windows_path(&argv[0]);
    if executable != argv0 {
        return false;
    }

    let ccc = normalize_windows_path(CCC_CLI_PATH);
    if executable == ccc {
        return argv.len() == 2 && argv[1].eq_ignore_ascii_case("run-daemon");
    }

    let python = normalize_windows_path(CCC_PYTHON_PATH);
    if executable != python {
        return false;
    }
    if argv.len() == 4 {
        return argv[1] == "-m"
            && argv[2].eq_ignore_ascii_case("cocoindex_code.cli")
            && argv[3].eq_ignore_ascii_case("run-daemon");
    }
    argv.len() == 3
        && normalize_windows_path(&argv[1]) == ccc
        && argv[2].eq_ignore_ascii_case("run-daemon")
}

fn normalize_windows_path(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn split_windows_command_line(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut args = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index == chars.len() {
            break;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while index < chars.len() {
            if chars[index].is_whitespace() && !quoted {
                break;
            }
            if chars[index] == '\\' {
                let start = index;
                while index < chars.len() && chars[index] == '\\' {
                    index += 1;
                }
                let slash_count = index - start;
                if index < chars.len() && chars[index] == '"' {
                    arg.extend(std::iter::repeat_n('\\', slash_count / 2));
                    if slash_count % 2 == 0 {
                        quoted = !quoted;
                    } else {
                        arg.push('"');
                    }
                    index += 1;
                } else {
                    arg.extend(std::iter::repeat_n('\\', slash_count));
                }
                continue;
            }
            if chars[index] == '"' {
                quoted = !quoted;
                index += 1;
                continue;
            }
            arg.push(chars[index]);
            index += 1;
        }
        args.push(arg);
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
    }
    args
}

#[cfg(windows)]
fn manage_daemon(
    action: CccDaemonAction,
    timeout: Duration,
) -> Result<CccDaemonActionResult, String> {
    let root = Path::new(CCC_SHARED_RUNTIME_ROOT);
    let cli = Path::new(CCC_CLI_PATH);
    if !cli.is_file() {
        return Err(format!("Verified CCC CLI is missing: {}", cli.display()));
    }
    let before = inspect_at(root, cli);
    if before.state == CccDaemonState::IdentityMismatch {
        return Err(before.message);
    }
    if before.state == CccDaemonState::Unavailable {
        return Err(before.message);
    }

    match action {
        CccDaemonAction::Start => start_daemon(before, timeout),
        CccDaemonAction::Stop => stop_daemon(before, timeout),
        CccDaemonAction::Restart => restart_daemon(before, timeout),
    }
}

#[cfg(not(windows))]
fn manage_daemon(
    _action: CccDaemonAction,
    _timeout: Duration,
) -> Result<CccDaemonActionResult, String> {
    Err("CCC daemon management is available only on Windows".into())
}

#[cfg(windows)]
fn start_daemon(
    before: CccDaemonStatus,
    timeout: Duration,
) -> Result<CccDaemonActionResult, String> {
    if before.state == CccDaemonState::Running {
        return Ok(action_result(
            CccDaemonAction::Start,
            false,
            "CCC daemon was already running",
            String::new(),
            String::new(),
            before,
        ));
    }
    cleanup_stale_pid(&before)?;
    let output = run_ccc(&["daemon", "status"], timeout)?;
    let status = wait_for_state(CccDaemonState::Running, timeout)?;
    Ok(action_result_from_output(
        CccDaemonAction::Start,
        false,
        "CCC daemon started",
        output,
        status,
    ))
}

#[cfg(windows)]
fn stop_daemon(
    before: CccDaemonStatus,
    timeout: Duration,
) -> Result<CccDaemonActionResult, String> {
    if before.state != CccDaemonState::Running {
        cleanup_stale_pid(&before)?;
        let status = inspect_shared_daemon();
        return Ok(action_result(
            CccDaemonAction::Stop,
            false,
            "CCC daemon was already stopped",
            String::new(),
            String::new(),
            status,
        ));
    }
    let expected_pid = before.pid.ok_or("Verified daemon has no PID")?;
    let cli_result = run_ccc(&["daemon", "stop"], timeout);
    if let Ok(status) = wait_for_stopped(Duration::from_secs(2)) {
        let (stdout, stderr) = output_text(cli_result.ok().as_ref());
        return Ok(action_result(
            CccDaemonAction::Stop,
            false,
            "CCC daemon stopped gracefully",
            stdout,
            stderr,
            status,
        ));
    }

    force_kill_after_revalidation(expected_pid)?;
    let status = wait_for_stopped(Duration::from_secs(5))?;
    let (stdout, stderr) = output_text(cli_result.ok().as_ref());
    Ok(action_result(
        CccDaemonAction::Stop,
        true,
        "CCC daemon required a verified force-stop fallback",
        stdout,
        stderr,
        status,
    ))
}

#[cfg(windows)]
fn restart_daemon(
    before: CccDaemonStatus,
    timeout: Duration,
) -> Result<CccDaemonActionResult, String> {
    if before.state != CccDaemonState::Running {
        cleanup_stale_pid(&before)?;
        return start_daemon(inspect_shared_daemon(), timeout).map(|mut result| {
            result.action = CccDaemonAction::Restart;
            result.message = "CCC daemon started from a stopped state".into();
            result
        });
    }

    let expected_pid = before.pid.ok_or("Verified daemon has no PID")?;
    let cli_result = run_ccc(&["daemon", "restart"], timeout);
    if let Ok(status) = wait_for_restarted(expected_pid, timeout) {
        let (stdout, stderr) = output_text(cli_result.ok().as_ref());
        return Ok(action_result(
            CccDaemonAction::Restart,
            false,
            "CCC daemon restarted gracefully",
            stdout,
            stderr,
            status,
        ));
    }

    let current = inspect_shared_daemon();
    if current.state == CccDaemonState::Running && current.pid == Some(expected_pid) {
        force_kill_after_revalidation(expected_pid)?;
        let _ = wait_for_stopped(Duration::from_secs(5))?;
    } else if current.state == CccDaemonState::IdentityMismatch {
        return Err(current.message);
    }
    cleanup_stale_pid(&inspect_shared_daemon())?;
    let start_output = run_ccc(&["daemon", "status"], timeout)?;
    let status = wait_for_state(CccDaemonState::Running, timeout)?;
    let (mut stdout, mut stderr) = output_text(cli_result.ok().as_ref());
    stdout.push_str(&String::from_utf8_lossy(&start_output.stdout));
    stderr.push_str(&String::from_utf8_lossy(&start_output.stderr));
    Ok(action_result(
        CccDaemonAction::Restart,
        true,
        "CCC daemon recovered through a verified force-stop and clean start",
        stdout,
        stderr,
        status,
    ))
}

#[cfg(windows)]
fn run_ccc(arguments: &[&str], timeout: Duration) -> Result<Output, String> {
    let output = run_bounded(Path::new(CCC_CLI_PATH), arguments, timeout)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(output_error("CCC CLI", &output))
    }
}

#[cfg(windows)]
fn force_kill_after_revalidation(expected_pid: u32) -> Result<(), String> {
    let verified = inspect_shared_daemon();
    if verified.state != CccDaemonState::Running
        || !verified.identity_valid
        || verified.pid != Some(expected_pid)
    {
        return Err(format!(
            "Force-stop blocked: PID {expected_pid} no longer has the verified daemon identity"
        ));
    }
    let pid = expected_pid.to_string();
    let output = run_bounded(
        Path::new(r"C:\Windows\System32\taskkill.exe"),
        &["/PID", &pid, "/T", "/F"],
        Duration::from_secs(5),
    )?;
    if !output.status.success() {
        return Err(output_error("Verified taskkill fallback", &output));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if !query_process_snapshot(expected_pid, Duration::from_secs(2))?.found {
            let stale = inspect_shared_daemon();
            return cleanup_stale_pid(&stale);
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "Verified daemon PID {expected_pid} still exists after taskkill"
    ))
}

#[cfg(windows)]
fn cleanup_stale_pid(status: &CccDaemonStatus) -> Result<(), String> {
    if status.state != CccDaemonState::StalePid {
        return Ok(());
    }
    if let Some(pid) = status.pid {
        cleanup_marker_if_matches(pid)?;
    } else {
        let marker = pid_path(Path::new(CCC_SHARED_RUNTIME_ROOT));
        let current = match fs::read_to_string(&marker) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Unable to re-read {}: {error}", marker.display())),
        };
        if parse_pid(&current).is_ok() {
            return Err("daemon.pid became valid while cleanup was pending".into());
        }
        fs::remove_file(&marker)
            .map_err(|error| format!("Unable to remove malformed {}: {error}", marker.display()))?;
    }
    Ok(())
}

#[cfg(windows)]
fn cleanup_marker_if_matches(expected_pid: u32) -> Result<(), String> {
    let marker = pid_path(Path::new(CCC_SHARED_RUNTIME_ROOT));
    let current = match fs::read_to_string(&marker) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Unable to re-read {}: {error}", marker.display())),
    };
    if parse_pid(&current).ok() != Some(expected_pid) {
        return Err("daemon.pid changed while cleanup was pending".into());
    }
    let snapshot = query_process_snapshot(expected_pid, Duration::from_secs(3))?;
    if snapshot.found {
        return Err(format!(
            "Refusing to remove daemon.pid while PID {expected_pid} still exists"
        ));
    }
    fs::remove_file(&marker)
        .map_err(|error| format!("Unable to remove stale {}: {error}", marker.display()))
}

#[cfg(windows)]
fn wait_for_state(expected: CccDaemonState, timeout: Duration) -> Result<CccDaemonStatus, String> {
    let started = Instant::now();
    loop {
        let status = inspect_shared_daemon();
        if status.state == expected {
            return Ok(status);
        }
        if status.state == CccDaemonState::IdentityMismatch {
            return Err(status.message);
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for CCC daemon state {expected:?}; last state was {:?}",
                status.state
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(windows)]
fn wait_for_stopped(timeout: Duration) -> Result<CccDaemonStatus, String> {
    let started = Instant::now();
    loop {
        let status = inspect_shared_daemon();
        match status.state {
            CccDaemonState::Stopped => return Ok(status),
            CccDaemonState::StalePid => {
                cleanup_stale_pid(&status)?;
                return Ok(inspect_shared_daemon());
            }
            CccDaemonState::IdentityMismatch => return Err(status.message),
            _ if started.elapsed() >= timeout => {
                return Err(format!(
                    "Timed out waiting for CCC daemon to stop; last state was {:?}",
                    status.state
                ));
            }
            _ => thread::sleep(POLL_INTERVAL),
        }
    }
}

#[cfg(windows)]
fn wait_for_restarted(old_pid: u32, timeout: Duration) -> Result<CccDaemonStatus, String> {
    let started = Instant::now();
    loop {
        let status = inspect_shared_daemon();
        if status.state == CccDaemonState::Running && status.pid != Some(old_pid) {
            return Ok(status);
        }
        if status.state == CccDaemonState::IdentityMismatch {
            return Err(status.message);
        }
        if started.elapsed() >= timeout {
            return Err("Timed out waiting for a verified CCC daemon restart".into());
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(windows)]
fn run_bounded(program: &Path, arguments: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {}: {error}", program.display()))?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} timed out", program.display()));
            }
        }
    }
}

#[cfg(windows)]
fn output_error(label: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{label} exited with {}", output.status)
    } else {
        format!("{label} failed: {stderr}")
    }
}

#[cfg(windows)]
fn output_text(output: Option<&Output>) -> (String, String) {
    output.map_or_else(
        || (String::new(), String::new()),
        |output| {
            (
                String::from_utf8_lossy(&output.stdout).trim().to_string(),
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            )
        },
    )
}

fn action_result(
    action: CccDaemonAction,
    forced: bool,
    message: &str,
    cli_stdout: String,
    cli_stderr: String,
    status: CccDaemonStatus,
) -> CccDaemonActionResult {
    CccDaemonActionResult {
        action,
        success: status.state == CccDaemonState::Running
            || (action == CccDaemonAction::Stop && status.state == CccDaemonState::Stopped),
        forced,
        message: message.into(),
        cli_stdout,
        cli_stderr,
        status,
    }
}

#[cfg(windows)]
fn action_result_from_output(
    action: CccDaemonAction,
    forced: bool,
    message: &str,
    output: Output,
    status: CccDaemonStatus,
) -> CccDaemonActionResult {
    let (stdout, stderr) = output_text(Some(&output));
    action_result(action, forced, message, stdout, stderr, status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_one_positive_decimal_pid() {
        assert_eq!(parse_pid("2032\r\n"), Ok(2032));
        assert!(parse_pid("").is_err());
        assert!(parse_pid("0").is_err());
        assert!(parse_pid("12\n13").is_err());
        assert!(parse_pid("+12").is_err());
        assert!(parse_pid("12x").is_err());
    }

    #[test]
    fn tokenizes_quoted_windows_command_lines() {
        assert_eq!(
            split_windows_command_line(
                r#""C:\Program Files\Python\python.exe" -m cocoindex_code.cli run-daemon"#
            ),
            vec![
                r"C:\Program Files\Python\python.exe",
                "-m",
                "cocoindex_code.cli",
                "run-daemon"
            ]
        );
        assert_eq!(
            split_windows_command_line(r#"tool.exe "quoted value" plain"#),
            vec!["tool.exe", "quoted value", "plain"]
        );
    }

    #[test]
    fn accepts_only_exact_daemon_identities() {
        assert!(validate_process_identity(
            CCC_PYTHON_PATH,
            &format!(r#""{CCC_PYTHON_PATH}" -m cocoindex_code.cli run-daemon"#)
        ));
        assert!(validate_process_identity(
            CCC_PYTHON_PATH,
            &format!(r#""{CCC_PYTHON_PATH}" "{CCC_CLI_PATH}" run-daemon"#)
        ));
        assert!(validate_process_identity(
            CCC_CLI_PATH,
            &format!(r#""{CCC_CLI_PATH}" run-daemon"#)
        ));
        assert!(!validate_process_identity(
            CCC_PYTHON_PATH,
            &format!(r#""{CCC_PYTHON_PATH}" -m http.server run-daemon"#)
        ));
        assert!(!validate_process_identity(
            CCC_PYTHON_PATH,
            &format!(r#""{CCC_PYTHON_PATH}" -m cocoindex_code.cli run-daemon extra"#)
        ));
        assert!(!validate_process_identity(
            r"C:\Windows\python.exe",
            &format!(r#""{CCC_PYTHON_PATH}" -m cocoindex_code.cli run-daemon"#)
        ));
    }

    #[test]
    fn aggregates_unique_gpu_instances_with_saturation() {
        let rows = vec![
            RawGpuMemory {
                name: "pid_42_luid_0_phys_0".into(),
                dedicated_usage: Some(100),
                shared_usage: Some(20),
            },
            RawGpuMemory {
                name: "PID_42_LUID_0_PHYS_0".into(),
                dedicated_usage: Some(999),
                shared_usage: Some(999),
            },
            RawGpuMemory {
                name: "pid_42_luid_1_phys_0".into(),
                dedicated_usage: Some(300),
                shared_usage: None,
            },
        ];
        assert_eq!(
            aggregate_gpu_usage(&rows),
            CccGpuProcessMemory {
                dedicated_bytes: 400,
                shared_bytes: 20,
                instance_count: 2,
            }
        );
    }
}
