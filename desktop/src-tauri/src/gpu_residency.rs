use crate::models::ResourceSample;
use crate::resource_monitor::ResourceMonitor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::ffi::c_void;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

#[cfg(windows)]
use crate::process_control::VerifiedProcessHandle;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_MORE_DATA,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    GetProcessInformation, IsProcessCritical, OpenProcess, ProcessMemoryPriority,
    SetProcessInformation, MEMORY_PRIORITY_INFORMATION, PROCESS_QUERY_INFORMATION,
    PROCESS_SET_INFORMATION,
};

const RULE_STORE_FILE: &str = "gpu-residency-rules.json";
const RULE_STORE_KEY: &str = "rules";
const RULE_SCHEMA_VERSION: u8 = 1;
const MAX_VISIBLE_PROCESSES: usize = 128;
const MAX_RULES: usize = 128;
const MAX_UNDO_ENTRIES: usize = 128;
const MAX_RULE_PATH_BYTES: usize = 32 * 1024;
const MAX_CACHED_SNAPSHOT_AGE_MS: u64 = 5_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: u64,
    #[serde(default)]
    pub creation_time_100ns: String,
    pub executable_path: String,
    #[serde(default)]
    pub executable_hash: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GpuPolicyPreset {
    Protect,
    #[default]
    Balanced,
    Yield,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuResidencyRule {
    pub executable_path: String,
    pub executable_hash: String,
    pub preset: GpuPolicyPreset,
    pub gpu_priority: i32,
    pub ram_priority: u32,
    #[serde(default)]
    pub auto_attach: bool,
    #[serde(default)]
    pub agent_allowed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuResourceRecord {
    pub resource_id: String,
    pub kind: String,
    pub bytes: u64,
    pub format: String,
    pub dimensions: String,
    pub flags: String,
    pub callsite_hash: String,
    pub priority: String,
    pub residency: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuResourceGroup {
    pub kind: String,
    pub count: usize,
    pub bytes: u64,
    pub resources: Vec<GpuResourceRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcessResidency {
    pub identity: ProcessIdentity,
    pub name: String,
    pub dedicated_bytes: u64,
    pub shared_bytes: u64,
    pub gpu_percent: f64,
    pub engines: Vec<String>,
    pub adapters: Vec<String>,
    pub descendant_count: usize,
    pub gpu_priority: Option<i32>,
    pub ram_priority: Option<u32>,
    pub protected: bool,
    pub manageable: bool,
    pub agent_state: String,
    pub agent_message: String,
    pub applied_rule: Option<GpuResidencyRule>,
    pub resource_groups: Vec<GpuResourceGroup>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuResidencySnapshot {
    pub timestamp: u64,
    pub source: String,
    pub source_warning: String,
    pub physical_used_bytes: u64,
    pub physical_total_bytes: u64,
    pub tracked_dedicated_bytes: u64,
    pub tracked_shared_bytes: u64,
    pub unaccounted_bytes: u64,
    pub pressure_percent: f32,
    pub processes: Vec<GpuProcessResidency>,
    pub rules: Vec<GpuResidencyRule>,
    pub agent_available: bool,
    pub agent_protocol: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProcessPolicyRequest {
    pub identity: ProcessIdentity,
    pub preset: GpuPolicyPreset,
    pub gpu_priority: i32,
    pub ram_priority: u32,
    #[serde(default)]
    pub persist: bool,
}

type ProcessPriorities = (Option<i32>, Option<u32>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPolicyApplyResult {
    pub success: bool,
    pub pid: u32,
    pub previous_gpu_priority: Option<i32>,
    pub previous_ram_priority: Option<u32>,
    pub gpu_priority: Option<i32>,
    pub ram_priority: Option<u32>,
    pub persisted: bool,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleStore {
    schema_version: u8,
    rules: Vec<GpuResidencyRule>,
}

impl Default for RuleStore {
    fn default() -> Self {
        Self {
            schema_version: RULE_SCHEMA_VERSION,
            rules: Vec::new(),
        }
    }
}

#[derive(Default)]
struct ProcessCounters {
    dedicated: u64,
    shared: u64,
    gpu_percent: f64,
    engines: BTreeSet<String>,
    adapters: BTreeSet<String>,
}

pub struct GpuResidencyManager {
    collector: Mutex<GpuCounterCollector>,
    rules: Mutex<RuleStore>,
    applied_instances: Mutex<BTreeSet<(u32, u64, String)>>,
    undo: Mutex<HashMap<(u32, u64), PolicyUndo>>,
    latest: Mutex<Option<GpuResidencySnapshot>>,
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for GpuResidencyManager {
    fn default() -> Self {
        Self {
            collector: Mutex::new(GpuCounterCollector::new()),
            rules: Mutex::new(RuleStore::default()),
            applied_instances: Mutex::new(BTreeSet::new()),
            undo: Mutex::new(HashMap::new()),
            latest: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }
}

impl GpuResidencyManager {
    pub fn start(self: &Arc<Self>, resources: Arc<ResourceMonitor>) -> Result<(), String> {
        let mut worker = lock(&self.worker);
        if worker.is_some() {
            return Ok(());
        }
        self.stop.store(false, Ordering::Release);
        let manager = Arc::clone(self);
        let stop = Arc::clone(&self.stop);
        *worker = Some(
            thread::Builder::new()
                .name("keemash-gpu-residency".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        if let Some(aggregate) = resources.latest() {
                            let _ = manager.refresh_snapshot(&aggregate);
                        }
                        for _ in 0..30 {
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                    }
                })
                .map_err(|error| format!("Unable to start GPU residency service: {error}"))?,
        );
        Ok(())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }

    pub fn load(&self, app: &AppHandle) -> Result<(), String> {
        let store = app
            .store(RULE_STORE_FILE)
            .map_err(|error| error.to_string())?;
        let loaded = store
            .get(RULE_STORE_KEY)
            .map(serde_json::from_value::<RuleStore>)
            .transpose()
            .map_err(|error| format!("Invalid GPU residency rule store: {error}"))?
            .unwrap_or_default();
        let loaded = if loaded.schema_version == RULE_SCHEMA_VERSION {
            validate_rule_store(&loaded)?;
            loaded
        } else {
            RuleStore::default()
        };
        *lock(&self.rules) = loaded;
        Ok(())
    }

    pub fn snapshot(
        &self,
        physical_used_bytes: u64,
        physical_total_bytes: u64,
    ) -> Result<GpuResidencySnapshot, String> {
        if let Some(snapshot) = lock(&self.latest).clone() {
            if now_millis().saturating_sub(snapshot.timestamp) <= MAX_CACHED_SNAPSHOT_AGE_MS {
                return Ok(snapshot);
            }
        }
        let snapshot = self.collect_snapshot(physical_used_bytes, physical_total_bytes)?;
        *lock(&self.latest) = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub fn process_memory(&self, pid: u32) -> Option<(u64, u64, usize)> {
        let latest = lock(&self.latest);
        let snapshot = latest.as_ref()?;
        if now_millis().saturating_sub(snapshot.timestamp) > MAX_CACHED_SNAPSHOT_AGE_MS {
            return None;
        }
        snapshot
            .processes
            .iter()
            .find(|process| process.identity.pid == pid)
            .map(|process| {
                (
                    process.dedicated_bytes,
                    process.shared_bytes,
                    process.engines.len(),
                )
            })
    }

    pub fn observed_adapters_for_current_tree(&self) -> Vec<String> {
        let latest = lock(&self.latest);
        let Some(snapshot) = latest.as_ref() else {
            return Vec::new();
        };
        if now_millis().saturating_sub(snapshot.timestamp) > MAX_CACHED_SNAPSHOT_AGE_MS {
            return Vec::new();
        }
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let parents = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                process
                    .parent()
                    .map(|parent| (pid.as_u32(), parent.as_u32()))
            })
            .collect::<HashMap<_, _>>();
        let mut tree = BTreeSet::from([std::process::id()]);
        loop {
            let before = tree.len();
            for (&pid, &parent) in &parents {
                if tree.contains(&parent) {
                    tree.insert(pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        snapshot
            .processes
            .iter()
            .filter(|process| tree.contains(&process.identity.pid))
            .flat_map(|process| process.adapters.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    fn refresh_snapshot(&self, aggregate: &ResourceSample) -> Result<(), String> {
        let used = aggregate.gpu.memory_used_mi_b.unwrap_or_default().max(0.0) as u64 * 1024 * 1024;
        let total =
            aggregate.gpu.memory_total_mi_b.unwrap_or_default().max(0.0) as u64 * 1024 * 1024;
        let snapshot = self.collect_snapshot(used, total)?;
        *lock(&self.latest) = Some(snapshot);
        Ok(())
    }

    fn collect_snapshot(
        &self,
        physical_used_bytes: u64,
        physical_total_bytes: u64,
    ) -> Result<GpuResidencySnapshot, String> {
        let counters = lock(&self.collector).sample()?;
        let rules = lock(&self.rules).rules.clone();
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let current_pid = std::process::id();
        let parent_map = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                process
                    .parent()
                    .map(|parent| (pid.as_u32(), parent.as_u32()))
            })
            .collect::<HashMap<_, _>>();
        lock(&self.undo).retain(|(pid, started_at), _| {
            system
                .process(Pid::from_u32(*pid))
                .is_some_and(|process| process.start_time() == *started_at)
        });
        let mut applied_instances = lock(&self.applied_instances);
        applied_instances.retain(|(pid, started_at, _)| {
            system
                .process(Pid::from_u32(*pid))
                .is_some_and(|process| process.start_time() == *started_at)
        });
        let mut processes = counters
            .into_iter()
            .filter_map(|(pid, counters)| {
                let process = system.process(Pid::from_u32(pid))?;
                let path = process.exe().map(canonical_path).unwrap_or_default();
                let name = process.name().to_string_lossy().into_owned();
                let exact_creation_time =
                    crate::process_control::process_creation_time_100ns(pid).ok();
                let identity = ProcessIdentity {
                    pid,
                    started_at: process.start_time(),
                    creation_time_100ns: exact_creation_time
                        .map(|value| value.to_string())
                        .unwrap_or_default(),
                    executable_path: path.clone(),
                    executable_hash: String::new(),
                };
                let protected = is_blocked_process(pid, &name, &path, current_pid)
                    || process_is_critical(pid).unwrap_or(true)
                    || exact_creation_time.is_none();
                let applied_rule = rules
                    .iter()
                    .find(|rule| same_path(&rule.executable_path, &path))
                    .cloned();
                if let Some(rule) = &applied_rule {
                    let key = (pid, process.start_time(), path.clone());
                    if !applied_instances.contains(&key)
                        && executable_hash(Path::new(&path))
                            .is_ok_and(|hash| hash == rule.executable_hash)
                        && write_process_priorities(&identity, rule.gpu_priority, rule.ram_priority)
                            .is_ok()
                    {
                        applied_instances.insert(key);
                    }
                }
                let (gpu_priority, ram_priority) =
                    read_process_priorities(&identity).unwrap_or_default();
                Some(GpuProcessResidency {
                    identity,
                    name,
                    dedicated_bytes: counters.dedicated,
                    shared_bytes: counters.shared,
                    gpu_percent: counters.gpu_percent.clamp(0.0, 100.0),
                    engines: counters.engines.into_iter().collect(),
                    adapters: counters.adapters.into_iter().collect(),
                    descendant_count: count_descendants(&parent_map, pid),
                    gpu_priority,
                    ram_priority,
                    protected,
                    manageable: !protected && !path.is_empty(),
                    agent_state: "detached".into(),
                    agent_message: "D3D agent is not attached; process totals remain live".into(),
                    applied_rule,
                    resource_groups: Vec::new(),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| std::cmp::Reverse(process.dedicated_bytes));
        processes.truncate(MAX_VISIBLE_PROCESSES);
        let tracked_dedicated_bytes = processes.iter().map(|item| item.dedicated_bytes).sum();
        let tracked_shared_bytes = processes.iter().map(|item| item.shared_bytes).sum();
        let unaccounted_bytes = physical_used_bytes.saturating_sub(tracked_dedicated_bytes);
        let pressure_percent = if physical_total_bytes == 0 {
            0.0
        } else {
            (physical_used_bytes as f64 * 100.0 / physical_total_bytes as f64) as f32
        };
        Ok(GpuResidencySnapshot {
            timestamp: now_millis(),
            source: "Windows PDH GPU Process Memory + GPU Engine".into(),
            source_warning: "Windows GPU process counters are allocation telemetry; per-resource physical residency requires an attached D3D agent".into(),
            physical_used_bytes,
            physical_total_bytes,
            tracked_dedicated_bytes,
            tracked_shared_bytes,
            unaccounted_bytes,
            pressure_percent,
            processes,
            rules,
            agent_available: false,
            agent_protocol: 1,
        })
    }

    pub fn apply_policy(
        &self,
        app: &AppHandle,
        request: SetProcessPolicyRequest,
    ) -> Result<GpuPolicyApplyResult, String> {
        if !(0..=4).contains(&request.gpu_priority) {
            return Err("GPU priority must be between Idle (0) and High (4)".into());
        }
        if !(1..=5).contains(&request.ram_priority) {
            return Err("RAM priority must be between Very low (1) and Normal (5)".into());
        }
        let previous_rules = lock(&self.rules).clone();
        let previous_rule = previous_rules
            .rules
            .iter()
            .find(|rule| same_path(&rule.executable_path, &request.identity.executable_path))
            .cloned();
        let path = canonical_path(Path::new(&request.identity.executable_path));
        let mut candidate_rules = previous_rules;
        candidate_rules
            .rules
            .retain(|item| !same_path(&item.executable_path, &path));
        let persisted = request.persist;
        if request.persist {
            candidate_rules.rules.push(GpuResidencyRule {
                executable_path: path.clone(),
                executable_hash: executable_hash(Path::new(&path))?,
                preset: request.preset,
                gpu_priority: request.gpu_priority,
                ram_priority: request.ram_priority,
                auto_attach: false,
                agent_allowed: false,
            });
        }
        validate_rule_store(&candidate_rules)?;

        let ((previous_gpu_priority, previous_ram_priority), (gpu_priority, ram_priority)) =
            write_process_priorities(
                &request.identity,
                request.gpu_priority,
                request.ram_priority,
            )?;
        if let Err(error) = persist_rules(app, &candidate_rules) {
            let rollback = restore_process_priorities(
                &request.identity,
                previous_gpu_priority,
                previous_ram_priority,
            );
            return Err(match rollback {
                Ok(()) => format!("GPU policy persistence failed; OS priorities rolled back: {error}"),
                Err(rollback_error) => format!(
                    "GPU policy persistence failed ({error}); priority rollback also failed ({rollback_error})"
                ),
            });
        }
        *lock(&self.rules) = candidate_rules;

        let undo_key = (request.identity.pid, request.identity.started_at);
        let mut undo = lock(&self.undo);
        if undo.len() >= MAX_UNDO_ENTRIES && !undo.contains_key(&undo_key) {
            if let Some(oldest) = undo.keys().next().copied() {
                undo.remove(&oldest);
            }
        }
        undo.insert(
            undo_key,
            PolicyUndo {
                gpu_priority: previous_gpu_priority,
                ram_priority: previous_ram_priority,
                rule: previous_rule,
            },
        );
        Ok(GpuPolicyApplyResult {
            success: true,
            pid: request.identity.pid,
            previous_gpu_priority,
            previous_ram_priority,
            gpu_priority,
            ram_priority,
            persisted,
            message: "Process scheduling and RAM retention priorities applied".into(),
        })
    }

    pub fn undo_policy(
        &self,
        app: &AppHandle,
        identity: &ProcessIdentity,
    ) -> Result<GpuPolicyApplyResult, String> {
        let undo_key = (identity.pid, identity.started_at);
        let undo = lock(&self.undo)
            .get(&undo_key)
            .cloned()
            .ok_or("No process policy change is available to undo")?;
        let gpu = undo
            .gpu_priority
            .ok_or("Previous GPU priority is unavailable")?;
        let ram = undo
            .ram_priority
            .ok_or("Previous RAM priority is unavailable")?;
        let ((current_gpu, current_ram), _) = write_process_priorities(identity, gpu, ram)?;
        let path = canonical_path(Path::new(&identity.executable_path));
        let mut candidate_rules = lock(&self.rules).clone();
        candidate_rules
            .rules
            .retain(|item| !same_path(&item.executable_path, &path));
        let restored_persisted_rule = undo.rule.is_some();
        if let Some(rule) = undo.rule {
            candidate_rules.rules.push(rule);
        }
        validate_rule_store(&candidate_rules)?;
        if let Err(error) = persist_rules(app, &candidate_rules) {
            let rollback = restore_process_priorities(identity, current_gpu, current_ram);
            return Err(match rollback {
                Ok(()) => format!("Undo persistence failed; OS priorities restored: {error}"),
                Err(rollback_error) => format!(
                    "Undo persistence failed ({error}); priority rollback also failed ({rollback_error})"
                ),
            });
        }
        *lock(&self.rules) = candidate_rules;
        lock(&self.undo).remove(&undo_key);
        let (gpu_priority, ram_priority) = read_process_priorities(identity)?;
        Ok(GpuPolicyApplyResult {
            success: true,
            pid: identity.pid,
            previous_gpu_priority: Some(gpu),
            previous_ram_priority: Some(ram),
            gpu_priority,
            ram_priority,
            persisted: restored_persisted_rule,
            message: "Previous process policy restored".into(),
        })
    }

    pub fn remove_rule(&self, app: &AppHandle, executable_path: &str) -> Result<bool, String> {
        let mut candidate = lock(&self.rules).clone();
        let before = candidate.rules.len();
        candidate
            .rules
            .retain(|item| !same_path(&item.executable_path, executable_path));
        let removed = candidate.rules.len() != before;
        if removed {
            validate_rule_store(&candidate)?;
            persist_rules(app, &candidate)?;
            *lock(&self.rules) = candidate;
        }
        Ok(removed)
    }
}

#[derive(Clone)]
struct PolicyUndo {
    gpu_priority: Option<i32>,
    ram_priority: Option<u32>,
    rule: Option<GpuResidencyRule>,
}

fn persist_rules(app: &AppHandle, rules: &RuleStore) -> Result<(), String> {
    validate_rule_store(rules)?;
    let store = app
        .store(RULE_STORE_FILE)
        .map_err(|error| error.to_string())?;
    store.set(
        RULE_STORE_KEY,
        serde_json::to_value(rules).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
}

fn validate_rule_store(store: &RuleStore) -> Result<(), String> {
    if store.rules.len() > MAX_RULES {
        return Err(format!(
            "GPU residency rules exceed the {MAX_RULES}-rule limit"
        ));
    }
    for rule in &store.rules {
        if rule.executable_path.is_empty() || rule.executable_path.len() > MAX_RULE_PATH_BYTES {
            return Err("GPU residency rule contains an invalid executable path".into());
        }
        if rule.executable_hash.len() != 64
            || !rule
                .executable_hash
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err("GPU residency rule contains an invalid executable hash".into());
        }
        if !(0..=4).contains(&rule.gpu_priority) || !(1..=5).contains(&rule.ram_priority) {
            return Err("GPU residency rule contains an invalid priority".into());
        }
    }
    Ok(())
}

fn canonical_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn executable_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Unable to open executable for identity hash: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to hash executable: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_blocked_process(pid: u32, name: &str, path: &str, current_pid: u32) -> bool {
    if pid <= 4 || pid == current_pid {
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
        "keemash-injector.exe",
    ];
    BLOCKED.iter().any(|item| name == *item)
        || path.contains("keemash-desktop")
        || path.contains("\\keemash\\")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn count_descendants(parents: &HashMap<u32, u32>, root_pid: u32) -> usize {
    let mut known = BTreeSet::from([root_pid]);
    loop {
        let before = known.len();
        for (&pid, &parent) in parents {
            if known.contains(&parent) {
                known.insert(pid);
            }
        }
        if known.len() == before {
            return known.len().saturating_sub(1);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
struct GpuCounterCollector {
    query: isize,
    dedicated: isize,
    shared: isize,
    engine: isize,
    error: Option<String>,
    retry_at: Option<Instant>,
    failures: u32,
}

#[cfg(windows)]
unsafe impl Send for GpuCounterCollector {}

#[cfg(windows)]
impl GpuCounterCollector {
    fn new() -> Self {
        match Self::open() {
            Ok(value) => value,
            Err(error) => Self {
                query: 0,
                dedicated: 0,
                shared: 0,
                engine: 0,
                error: Some(error),
                retry_at: Some(Instant::now() + Duration::from_secs(1)),
                failures: 1,
            },
        }
    }

    fn open() -> Result<Self, String> {
        let mut query = 0isize;
        let status = unsafe { PdhOpenQueryW(null(), 0, &mut query) };
        if status != 0 {
            return Err(format!("PdhOpenQueryW failed: 0x{status:08X}"));
        }
        let mut dedicated = 0isize;
        let mut shared = 0isize;
        let mut engine = 0isize;
        for (path, output) in [
            (r"\GPU Process Memory(*)\Dedicated Usage", &mut dedicated),
            (r"\GPU Process Memory(*)\Shared Usage", &mut shared),
            (r"\GPU Engine(*)\Utilization Percentage", &mut engine),
        ] {
            let path = wide(path);
            let status = unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, output) };
            if status != 0 {
                unsafe { PdhCloseQuery(query) };
                return Err(format!("PdhAddEnglishCounterW failed: 0x{status:08X}"));
            }
        }
        let _ = unsafe { PdhCollectQueryData(query) };
        Ok(Self {
            query,
            dedicated,
            shared,
            engine,
            error: None,
            retry_at: None,
            failures: 0,
        })
    }

    fn sample(&mut self) -> Result<HashMap<u32, ProcessCounters>, String> {
        if self.error.is_some() {
            if self
                .retry_at
                .is_some_and(|retry_at| Instant::now() < retry_at)
            {
                return Err(self
                    .error
                    .clone()
                    .unwrap_or_else(|| "GPU PDH collector is retrying".into()));
            }
            match Self::open() {
                Ok(opened) => *self = opened,
                Err(error) => {
                    self.mark_failed(error.clone());
                    return Err(error);
                }
            }
        }
        match self.sample_inner() {
            Ok(sample) => Ok(sample),
            Err(error) => {
                self.mark_failed(error.clone());
                Err(error)
            }
        }
    }

    fn sample_inner(&mut self) -> Result<HashMap<u32, ProcessCounters>, String> {
        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != 0 {
            return Err(format!("PdhCollectQueryData failed: 0x{status:08X}"));
        }
        let mut result = HashMap::<u32, ProcessCounters>::new();
        for (name, value) in read_counter_array_i64(self.dedicated)? {
            if let Some(pid) = parse_pid(&name) {
                let entry = result.entry(pid).or_default();
                entry.dedicated = entry.dedicated.saturating_add(value.max(0) as u64);
                if let Some(adapter) = parse_adapter(&name) {
                    entry.adapters.insert(adapter);
                }
            }
        }
        for (name, value) in read_counter_array_i64(self.shared)? {
            if let Some(pid) = parse_pid(&name) {
                let entry = result.entry(pid).or_default();
                entry.shared = entry.shared.saturating_add(value.max(0) as u64);
                if let Some(adapter) = parse_adapter(&name) {
                    entry.adapters.insert(adapter);
                }
            }
        }
        for (name, value) in read_counter_array_f64(self.engine)? {
            if value <= 0.0 {
                continue;
            }
            if let Some(pid) = parse_pid(&name) {
                let entry = result.entry(pid).or_default();
                entry.gpu_percent = entry.gpu_percent.max(value);
                if let Some(engine) = parse_marker(&name, "engtype") {
                    entry.engines.insert(engine);
                }
                if let Some(adapter) = parse_adapter(&name) {
                    entry.adapters.insert(adapter);
                }
            }
        }
        result.retain(|_, item| item.dedicated > 0 || item.shared > 0 || item.gpu_percent > 0.01);
        Ok(result)
    }

    fn mark_failed(&mut self, error: String) {
        if self.query != 0 {
            unsafe { PdhCloseQuery(self.query) };
        }
        self.query = 0;
        self.dedicated = 0;
        self.shared = 0;
        self.engine = 0;
        self.failures = self.failures.saturating_add(1);
        let delay = 1_u64 << self.failures.saturating_sub(1).min(5);
        self.retry_at = Some(Instant::now() + Duration::from_secs(delay));
        self.error = Some(error);
    }
}

#[cfg(windows)]
impl Drop for GpuCounterCollector {
    fn drop(&mut self) {
        if self.query != 0 {
            unsafe { PdhCloseQuery(self.query) };
        }
    }
}

#[cfg(not(windows))]
struct GpuCounterCollector;

#[cfg(not(windows))]
impl GpuCounterCollector {
    fn new() -> Self {
        Self
    }

    fn sample(&mut self) -> Result<HashMap<u32, ProcessCounters>, String> {
        Err("GPU process residency is available only on Windows".into())
    }
}

#[cfg(windows)]
fn read_counter_array_i64(counter: isize) -> Result<Vec<(String, i64)>, String> {
    read_counter_array(counter, PDH_FMT_LARGE, |item| unsafe {
        item.FmtValue.Anonymous.largeValue as f64
    })
    .map(|items| {
        items
            .into_iter()
            .map(|(name, value)| (name, value as i64))
            .collect()
    })
}

#[cfg(windows)]
fn read_counter_array_f64(counter: isize) -> Result<Vec<(String, f64)>, String> {
    read_counter_array(counter, PDH_FMT_DOUBLE, |item| unsafe {
        item.FmtValue.Anonymous.doubleValue
    })
}

#[cfg(windows)]
fn read_counter_array<F>(
    counter: isize,
    format: u32,
    value: F,
) -> Result<Vec<(String, f64)>, String>
where
    F: Fn(&PDH_FMT_COUNTERVALUE_ITEM_W) -> f64,
{
    let mut bytes = 0u32;
    let mut count = 0u32;
    let status = unsafe {
        PdhGetFormattedCounterArrayW(counter, format, &mut bytes, &mut count, null_mut())
    };
    if status != PDH_MORE_DATA || bytes == 0 {
        if status == 0 && count == 0 {
            return Ok(Vec::new());
        }
        return Err(format!(
            "PdhGetFormattedCounterArrayW size failed: 0x{status:08X}"
        ));
    }
    let align = std::mem::align_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    let mut storage = vec![0u8; bytes as usize + align];
    let base = storage.as_mut_ptr() as usize;
    let aligned = (base + align - 1) & !(align - 1);
    let items = aligned as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
    let status =
        unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut bytes, &mut count, items) };
    if status != 0 {
        return Err(format!(
            "PdhGetFormattedCounterArrayW failed: 0x{status:08X}"
        ));
    }
    let mut output = Vec::with_capacity(count as usize);
    for item in unsafe { std::slice::from_raw_parts(items, count as usize) } {
        if item.FmtValue.CStatus != 0 || item.szName.is_null() {
            continue;
        }
        let mut length = 0usize;
        unsafe {
            while *item.szName.add(length) != 0 {
                length += 1;
            }
        }
        let name =
            String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(item.szName, length) });
        output.push((name, value(item)));
    }
    Ok(output)
}

fn parse_pid(instance: &str) -> Option<u32> {
    let parts = instance.split('_').collect::<Vec<_>>();
    parts
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case("pid"))?
        .get(1)?
        .parse()
        .ok()
}

fn parse_marker(instance: &str, marker: &str) -> Option<String> {
    let parts = instance.split('_').collect::<Vec<_>>();
    parts
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case(marker))
        .map(|pair| pair[1].trim_end_matches([')', '#']).to_string())
}

fn parse_adapter(instance: &str) -> Option<String> {
    let lower = instance.to_ascii_lowercase();
    let start = lower.find("luid_")? + 5;
    let end = lower[start..]
        .find("_eng_")
        .map(|value| start + value)
        .or_else(|| lower[start..].find(')').map(|value| start + value))
        .unwrap_or(lower.len());
    Some(instance[start..end].to_string())
}

#[cfg(windows)]
#[link(name = "gdi32")]
unsafe extern "system" {
    fn D3DKMTGetProcessSchedulingPriorityClass(process: HANDLE, priority: *mut i32) -> i32;
    fn D3DKMTSetProcessSchedulingPriorityClass(process: HANDLE, priority: i32) -> i32;
}

#[cfg(windows)]
fn read_process_priorities(identity: &ProcessIdentity) -> Result<ProcessPriorities, String> {
    let handle = VerifiedProcessHandle::open(identity, PROCESS_QUERY_INFORMATION)?;
    read_process_priorities_handle(handle.raw())
}

#[cfg(windows)]
fn read_process_priorities_handle(handle: HANDLE) -> Result<ProcessPriorities, String> {
    let mut gpu = 0i32;
    let gpu_status = unsafe { D3DKMTGetProcessSchedulingPriorityClass(handle, &mut gpu) };
    let mut ram = MEMORY_PRIORITY_INFORMATION { MemoryPriority: 0 };
    let ram_ok = unsafe {
        GetProcessInformation(
            handle,
            ProcessMemoryPriority,
            &mut ram as *mut _ as *mut c_void,
            std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
        )
    } != 0;
    Ok((
        (gpu_status >= 0).then_some(gpu),
        ram_ok.then_some(ram.MemoryPriority),
    ))
}

#[cfg(not(windows))]
fn read_process_priorities(_identity: &ProcessIdentity) -> Result<ProcessPriorities, String> {
    Ok((None, None))
}

#[cfg(windows)]
fn write_process_priorities(
    identity: &ProcessIdentity,
    gpu_priority: i32,
    ram_priority: u32,
) -> Result<(ProcessPriorities, ProcessPriorities), String> {
    let handle = VerifiedProcessHandle::open(identity, PROCESS_SET_INFORMATION)?;
    let previous = read_process_priorities_handle(handle.raw())?;
    let previous_gpu = previous
        .0
        .ok_or("Unable to read previous D3DKMT priority")?;
    let previous_ram = previous.1.ok_or("Unable to read previous RAM priority")?;
    let gpu_status = unsafe { D3DKMTSetProcessSchedulingPriorityClass(handle.raw(), gpu_priority) };
    if gpu_status < 0 {
        return Err(format!(
            "D3DKMT priority update failed: 0x{:08X}",
            gpu_status as u32
        ));
    }
    let ram = MEMORY_PRIORITY_INFORMATION {
        MemoryPriority: ram_priority,
    };
    let ram_ok = unsafe {
        SetProcessInformation(
            handle.raw(),
            ProcessMemoryPriority,
            &ram as *const _ as *const c_void,
            std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
        )
    };
    let error = unsafe { GetLastError() };
    if ram_ok == 0 {
        unsafe { D3DKMTSetProcessSchedulingPriorityClass(handle.raw(), previous_gpu) };
        return Err(format!("RAM priority update failed: {error}"));
    }
    let current = read_process_priorities_handle(handle.raw())?;
    Ok(((Some(previous_gpu), Some(previous_ram)), current))
}

#[cfg(not(windows))]
fn write_process_priorities(
    _identity: &ProcessIdentity,
    _gpu: i32,
    _ram: u32,
) -> Result<(ProcessPriorities, ProcessPriorities), String> {
    Err("Process priority control is available only on Windows".into())
}

fn restore_process_priorities(
    identity: &ProcessIdentity,
    gpu: Option<i32>,
    ram: Option<u32>,
) -> Result<(), String> {
    let gpu = gpu.ok_or("Previous GPU priority is unavailable")?;
    let ram = ram.ok_or("Previous RAM priority is unavailable")?;
    write_process_priorities(identity, gpu, ram).map(|_| ())
}

#[cfg(windows)]
fn process_is_critical(pid: u32) -> Result<bool, String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess({pid}) failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut critical = 0;
    let ok = unsafe { IsProcessCritical(handle, &mut critical) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        Ok(false)
    } else {
        Ok(critical != 0)
    }
}

#[cfg(not(windows))]
fn process_is_critical(_pid: u32) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{
        count_descendants, is_blocked_process, parse_adapter, parse_marker, parse_pid,
        validate_rule_store, GpuPolicyPreset, GpuResidencyRule, RuleStore, MAX_RULES,
    };
    use std::collections::HashMap;

    #[test]
    fn counts_all_nested_descendants() {
        let parents = HashMap::from([(11, 10), (12, 10), (13, 11), (20, 1)]);
        assert_eq!(count_descendants(&parents, 10), 3);
        assert_eq!(count_descendants(&parents, 13), 0);
    }

    #[test]
    fn parses_windows_gpu_counter_instances() {
        let value = "pid_19812_luid_0x00000000_0x00012ecb_phys_0_eng_4_engtype_copy";
        assert_eq!(parse_pid(value), Some(19812));
        assert_eq!(parse_marker(value, "engtype").as_deref(), Some("copy"));
        assert_eq!(
            parse_adapter(value).as_deref(),
            Some("0x00000000_0x00012ecb_phys_0")
        );
    }

    #[test]
    fn protects_system_and_keemash_processes() {
        assert!(is_blocked_process(4, "System", "", 900));
        assert!(is_blocked_process(
            42,
            "keemash-desktop.exe",
            r"C:\Program Files\KeeMASH\keemash-desktop.exe",
            900
        ));
        assert!(is_blocked_process(
            43,
            "KeeMASH helper.exe",
            r"C:\Program Files\KeeMASH\helper.exe",
            900
        ));
        assert!(!is_blocked_process(
            44,
            "blender.exe",
            r"C:\Program Files\Blender Foundation\Blender\blender.exe",
            900
        ));
    }

    #[test]
    fn bounds_and_validates_persistent_residency_rules() {
        let valid = GpuResidencyRule {
            executable_path: r"C:\Program Files\Example\example.exe".into(),
            executable_hash: "ab".repeat(32),
            preset: GpuPolicyPreset::Balanced,
            gpu_priority: 2,
            ram_priority: 5,
            auto_attach: false,
            agent_allowed: false,
        };
        let mut store = RuleStore {
            schema_version: 1,
            rules: vec![valid.clone(); MAX_RULES],
        };
        assert!(validate_rule_store(&store).is_ok());
        store.rules.push(valid.clone());
        assert!(validate_rule_store(&store).is_err());

        store.rules = vec![GpuResidencyRule {
            executable_hash: "not-a-hash".into(),
            ..valid.clone()
        }];
        assert!(validate_rule_store(&store).is_err());
        store.rules = vec![GpuResidencyRule {
            ram_priority: 99,
            ..valid
        }];
        assert!(validate_rule_store(&store).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn reads_native_windows_gpu_process_counters() {
        let mut collector = super::GpuCounterCollector::new();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let snapshot = collector
            .sample()
            .expect("Windows GPU process counters should be readable");
        assert!(snapshot.keys().all(|pid| *pid > 0));
    }
}
