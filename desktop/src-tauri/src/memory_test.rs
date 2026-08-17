use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::System;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MIB: u64 = 1024 * 1024;
const MAX_TEST_BYTES: u64 = 16 * 1024 * MIB;
const WHEA_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTestRequest {
    #[serde(default)]
    pub memory_mi_b: u64,
    pub duration_seconds: u64,
    #[serde(default)]
    pub threads: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTestStatus {
    pub state: String,
    pub stage: String,
    pub requested_mi_b: u64,
    pub allocated_mi_b: u64,
    pub duration_seconds: u64,
    pub elapsed_seconds: u64,
    pub threads: usize,
    pub passes: u64,
    pub errors: u64,
    pub tested_bytes: u64,
    pub throughput_mi_bs: f64,
    pub started_at: u64,
    pub last_error: Option<String>,
    pub whea_count_24h: Option<u32>,
    pub whea_last_event_id: Option<u32>,
    pub whea_capped: bool,
    pub whea_error: Option<String>,
}

impl Default for MemoryTestStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            stage: "Ready".into(),
            requested_mi_b: 0,
            allocated_mi_b: 0,
            duration_seconds: 0,
            elapsed_seconds: 0,
            threads: 0,
            passes: 0,
            errors: 0,
            tested_bytes: 0,
            throughput_mi_bs: 0.0,
            started_at: 0,
            last_error: None,
            whea_count_24h: None,
            whea_last_event_id: None,
            whea_capped: false,
            whea_error: None,
        }
    }
}

#[derive(Clone)]
struct WheaSnapshot {
    count: Option<u32>,
    last_event_id: Option<u32>,
    capped: bool,
    error: Option<String>,
    updated: Instant,
}

impl Default for WheaSnapshot {
    fn default() -> Self {
        Self {
            count: None,
            last_event_id: None,
            capped: false,
            error: None,
            updated: Instant::now() - WHEA_CACHE_TTL,
        }
    }
}

pub struct MemoryTestController {
    status: Arc<Mutex<MemoryTestStatus>>,
    cancel: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    whea: Mutex<WheaSnapshot>,
}

impl Default for MemoryTestController {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(MemoryTestStatus::default())),
            cancel: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            whea: Mutex::new(WheaSnapshot::default()),
        }
    }
}

impl MemoryTestController {
    pub fn start(&self, request: MemoryTestRequest) -> Result<MemoryTestStatus, String> {
        if !(10..=86_400).contains(&request.duration_seconds) {
            return Err("Memory test duration must be between 10 seconds and 24 hours".into());
        }
        self.reap_finished();
        if lock(&self.status).state == "running" || lock(&self.status).state == "allocating" {
            return Err("A memory test is already running".into());
        }

        let mut system = System::new_all();
        system.refresh_memory();
        let available = system.available_memory();
        let safe_max = (available.saturating_mul(70) / 100).min(MAX_TEST_BYTES);
        let requested_bytes = request.memory_mi_b.saturating_mul(MIB);
        let target_bytes = if request.memory_mi_b == 0 {
            (available.saturating_mul(60) / 100).clamp(64 * MIB, MAX_TEST_BYTES)
        } else {
            requested_bytes
        };
        if target_bytes < 64 * MIB {
            return Err("At least 64 MiB is required for the memory test".into());
        }
        if target_bytes > safe_max {
            return Err(format!(
                "Requested {} MiB exceeds the current safe limit of {} MiB",
                target_bytes / MIB,
                safe_max / MIB
            ));
        }

        let default_threads = thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .clamp(1, 16);
        let threads = if request.threads == 0 {
            default_threads
        } else {
            request.threads.clamp(1, 32)
        }
        .min((target_bytes / (8 * MIB)).max(1) as usize);

        self.cancel.store(false, Ordering::Release);
        *lock(&self.status) = MemoryTestStatus {
            state: "allocating".into(),
            stage: "Reserving test pages".into(),
            requested_mi_b: request.memory_mi_b,
            allocated_mi_b: target_bytes / MIB,
            duration_seconds: request.duration_seconds,
            threads,
            started_at: now_seconds(),
            ..MemoryTestStatus::default()
        };

        let status = Arc::clone(&self.status);
        let cancel = Arc::clone(&self.cancel);
        let worker = thread::Builder::new()
            .name("keemash-memory-test".into())
            .spawn(move || {
                run_test(
                    status,
                    cancel,
                    target_bytes,
                    request.duration_seconds,
                    threads,
                )
            })
            .map_err(|error| {
                let message = format!("Unable to start memory test: {error}");
                *lock(&self.status) = MemoryTestStatus {
                    state: "error".into(),
                    stage: "Worker startup failed".into(),
                    last_error: Some(message.clone()),
                    ..MemoryTestStatus::default()
                };
                message
            })?;
        *lock(&self.worker) = Some(worker);
        Ok(self.status())
    }

    pub fn stop(&self) -> MemoryTestStatus {
        self.cancel.store(true, Ordering::Release);
        let mut status = lock(&self.status);
        if matches!(status.state.as_str(), "running" | "allocating") {
            status.stage = "Stopping after the current memory block".into();
        }
        drop(status);
        self.status()
    }

    pub fn status(&self) -> MemoryTestStatus {
        self.reap_finished();
        let mut status = lock(&self.status).clone();
        if status.started_at > 0 {
            status.elapsed_seconds = now_seconds().saturating_sub(status.started_at);
            if status.elapsed_seconds > 0 {
                status.throughput_mi_bs =
                    status.tested_bytes as f64 / MIB as f64 / status.elapsed_seconds as f64;
            }
        }
        let whea = self.whea_status();
        status.whea_count_24h = whea.count;
        status.whea_last_event_id = whea.last_event_id;
        status.whea_capped = whea.capped;
        status.whea_error = whea.error;
        status
    }

    fn reap_finished(&self) {
        let mut worker = lock(&self.worker);
        if worker.as_ref().is_some_and(JoinHandle::is_finished) {
            if let Some(done) = worker.take() {
                let _ = done.join();
            }
        }
    }

    fn whea_status(&self) -> WheaSnapshot {
        let mut cache = lock(&self.whea);
        if cache.updated.elapsed() >= WHEA_CACHE_TTL {
            *cache = read_whea_status();
        }
        cache.clone()
    }
}

impl Drop for MemoryTestController {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

fn run_test(
    status: Arc<Mutex<MemoryTestStatus>>,
    cancel: Arc<AtomicBool>,
    target_bytes: u64,
    duration_seconds: u64,
    threads: usize,
) {
    let tested = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let completed_cycles = Arc::new(AtomicU64::new(0));
    let deadline = Instant::now() + Duration::from_secs(duration_seconds);
    let words_total = (target_bytes / 8) as usize;
    let base_words = words_total / threads;
    let extra_words = words_total % threads;
    let mut workers = Vec::with_capacity(threads);

    {
        let mut current = lock(&status);
        current.state = "running".into();
        current.stage = "Allocating worker pages".into();
    }

    for worker_index in 0..threads {
        let words = base_words + usize::from(worker_index < extra_words);
        let tested = Arc::clone(&tested);
        let errors = Arc::clone(&errors);
        let cycles = Arc::clone(&completed_cycles);
        let cancel = Arc::clone(&cancel);
        let status = Arc::clone(&status);
        workers.push(thread::spawn(move || {
            let mut memory = Vec::<u64>::new();
            if let Err(error) = memory.try_reserve_exact(words) {
                cancel.store(true, Ordering::Release);
                let mut current = lock(&status);
                current.state = "error".into();
                current.stage = "Allocation failed".into();
                current.last_error = Some(format!("Unable to reserve test memory: {error}"));
                return;
            }
            memory.resize(words, 0);
            let seed = 0x9e37_79b9_7f4a_7c15u64
                ^ (worker_index as u64).wrapping_mul(0xd1b5_4a32_d192_ed03);
            let patterns = [
                "Zero / one inversion",
                "Address XOR",
                "Walking bits",
                "Seeded random",
            ];
            while !cancel.load(Ordering::Acquire) && Instant::now() < deadline {
                for (pattern, label) in patterns.iter().enumerate() {
                    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                        break;
                    }
                    if worker_index == 0 {
                        lock(&status).stage = (*label).into();
                    }
                    run_pattern(
                        &mut memory,
                        pattern,
                        seed,
                        worker_index,
                        &cancel,
                        &tested,
                        &errors,
                        &status,
                    );
                }
                cycles.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    while workers.iter().any(|worker| !worker.is_finished()) {
        {
            let mut current = lock(&status);
            current.tested_bytes = tested.load(Ordering::Relaxed);
            current.errors = errors.load(Ordering::Relaxed);
            current.passes = completed_cycles.load(Ordering::Relaxed) / threads as u64;
        }
        thread::sleep(Duration::from_millis(150));
    }
    for worker in workers {
        let _ = worker.join();
    }

    let mut current = lock(&status);
    current.tested_bytes = tested.load(Ordering::Relaxed);
    current.errors = errors.load(Ordering::Relaxed);
    current.passes = completed_cycles.load(Ordering::Relaxed) / threads as u64;
    if current.state == "error" {
        return;
    }
    if current.errors > 0 {
        current.state = "failed".into();
        current.stage = "Memory errors detected".into();
    } else if cancel.load(Ordering::Acquire) && Instant::now() < deadline {
        current.state = "stopped".into();
        current.stage = "Stopped".into();
    } else {
        current.state = "passed".into();
        current.stage = "No errors detected".into();
    }
}

#[allow(clippy::too_many_arguments)]
fn run_pattern(
    memory: &mut [u64],
    pattern: usize,
    seed: u64,
    worker_index: usize,
    cancel: &AtomicBool,
    tested: &AtomicU64,
    errors: &AtomicU64,
    status: &Mutex<MemoryTestStatus>,
) {
    const BLOCK_WORDS: usize = 4096;
    let value = |index: usize, inversion: bool| -> u64 {
        let base = match pattern {
            0 => {
                if inversion {
                    u64::MAX
                } else {
                    0
                }
            }
            1 => {
                (index as u64)
                    .wrapping_add((worker_index as u64) << 48)
                    .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                    ^ seed
            }
            2 => 1u64.rotate_left((index & 63) as u32),
            _ => random_at(seed, index as u64),
        };
        if inversion && pattern != 0 {
            !base
        } else {
            base
        }
    };

    let rounds = if pattern == 0 { 2 } else { 1 };
    for round in 0..rounds {
        for (block_index, block) in memory.chunks_mut(BLOCK_WORDS).enumerate() {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            let base = block_index * BLOCK_WORDS;
            for (offset, slot) in block.iter_mut().enumerate() {
                *slot = value(base + offset, round == 1);
            }
        }
        for (block_index, block) in memory.chunks(BLOCK_WORDS).enumerate() {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            let base = block_index * BLOCK_WORDS;
            for (offset, actual) in block.iter().enumerate() {
                let expected = value(base + offset, round == 1);
                if *actual != expected {
                    let count = errors.fetch_add(1, Ordering::Relaxed) + 1;
                    if count == 1 {
                        lock(status).last_error = Some(format!(
                            "Mismatch in worker {worker_index} at word {}: expected {expected:#018x}, read {actual:#018x}",
                            base + offset
                        ));
                    }
                }
            }
            tested.fetch_add((block.len() * 8) as u64, Ordering::Relaxed);
        }
    }
}

fn random_at(seed: u64, index: u64) -> u64 {
    let mut value = seed ^ index.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn read_whea_status() -> WheaSnapshot {
    #[cfg(windows)]
    {
        let output = Command::new("wevtutil.exe")
            .args([
                "qe",
                "System",
                "/q:*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and TimeCreated[timediff(@SystemTime) <= 86400000]]]",
                "/f:xml",
                "/c:256",
                "/rd:true",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let text = decode_windows_output(&output.stdout);
                let ids = parse_whea_event_ids(&text);
                WheaSnapshot {
                    count: Some(ids.len() as u32),
                    last_event_id: ids.first().copied(),
                    capped: ids.len() >= 256,
                    error: None,
                    updated: Instant::now(),
                }
            }
            Ok(output) => WheaSnapshot {
                count: None,
                last_event_id: None,
                capped: false,
                error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
                updated: Instant::now(),
            },
            Err(error) => WheaSnapshot {
                count: None,
                last_event_id: None,
                capped: false,
                error: Some(format!("WHEA query failed: {error}")),
                updated: Instant::now(),
            },
        }
    }
    #[cfg(not(windows))]
    WheaSnapshot {
        count: None,
        last_event_id: None,
        capped: false,
        error: Some("WHEA is available only on Windows".into()),
        updated: Instant::now(),
    }
}

fn parse_whea_event_ids(text: &str) -> Vec<u32> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut inside_event_id = false;
    let mut result = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) if tag.name().as_ref() == b"EventID" => inside_event_id = true,
            Ok(Event::Text(value)) if inside_event_id => {
                if let Ok(value) = value.decode() {
                    if let Ok(id) = value.parse() {
                        result.push(id);
                    }
                }
            }
            Ok(Event::End(tag)) if tag.name().as_ref() == b"EventID" => inside_event_id = false,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    result
}

fn decode_windows_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub fn launch_windows_memory_diagnostic() -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("mdsched.exe")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to open Windows Memory Diagnostic: {error}"))
    }
    #[cfg(not(windows))]
    {
        Err("Windows Memory Diagnostic is available only on Windows".into())
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{parse_whea_event_ids, random_at, run_pattern, MemoryTestStatus};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex;

    #[test]
    fn random_pattern_is_deterministic_and_indexed() {
        assert_eq!(random_at(42, 7), random_at(42, 7));
        assert_ne!(random_at(42, 7), random_at(42, 8));
    }

    #[test]
    fn parses_whea_xml_output() {
        let events = parse_whea_event_ids("<Events><Event><System><EventID>19</EventID></System></Event><Event><System><EventID>18</EventID></System></Event></Events>");
        assert_eq!(events, vec![19, 18]);
    }

    #[test]
    fn all_memory_patterns_round_trip_without_errors() {
        let mut memory = vec![0u64; 16 * 1024];
        let cancel = AtomicBool::new(false);
        let tested = AtomicU64::new(0);
        let errors = AtomicU64::new(0);
        let status = Mutex::new(MemoryTestStatus::default());
        for pattern in 0..4 {
            run_pattern(
                &mut memory,
                pattern,
                0x1234_5678_9abc_def0,
                0,
                &cancel,
                &tested,
                &errors,
                &status,
            );
        }
        assert_eq!(errors.load(Ordering::Relaxed), 0);
        assert!(tested.load(Ordering::Relaxed) >= (memory.len() * 8 * 4) as u64);
    }
}
