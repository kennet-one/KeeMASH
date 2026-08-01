use crate::models::{
    CpuSample, GpuSample, MemoryModuleSample, MemorySample, MemorySpdProfileSample,
    MemoryTimingSample, NetworkSample, PcieSample, ResourceSample,
};
use crate::runtime::RuntimeController;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Components, Networks, System};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SENSOR_HOST_INTERVAL: Duration = Duration::from_secs(2);
const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 1_000;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(4);
const SENSOR_RETRY_DELAY: Duration = Duration::from_secs(15);
const SENSOR_STALE_AFTER_MS: u64 = 10_000;
const MAX_CPU_PACKAGE_POWER_W: f32 = 1_000.0;
const AIDA_REPORT_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct NvidiaSnapshot {
    available: bool,
    name: String,
    load_percent: Option<f32>,
    temperature_c: Option<f32>,
    memory_temperature_c: Option<f32>,
    graphics_clock_mhz: Option<f32>,
    memory_clock_mhz: Option<f32>,
    memory_used_mib: Option<f32>,
    memory_total_mib: Option<f32>,
    power_w: Option<f32>,
    rx_mibs: Option<f32>,
    tx_mibs: Option<f32>,
    current_gen: Option<f32>,
    current_width: Option<f32>,
    max_gen: Option<f32>,
    max_width: Option<f32>,
}

#[derive(Clone)]
struct AdvancedSnapshot {
    updated_at_ms: u64,
    available: bool,
    backend: String,
    cpu_package_c: Option<f32>,
    cpu_hotspot_c: Option<f32>,
    cpu_power_w: Option<f32>,
    gpu_core_c: Option<f32>,
    gpu_hotspot_c: Option<f32>,
    gpu_memory_c: Option<f32>,
    memory_bus_load_percent: Option<f32>,
    memory_read_mi_bs: Option<f32>,
    memory_write_mi_bs: Option<f32>,
    memory_bus_source: String,
    memory_modules: Vec<MemoryModuleSample>,
    memory_spd_profiles: Vec<MemorySpdProfileSample>,
    memory_spd_error: String,
    memory_active_timings: Vec<MemoryTimingSample>,
    memory_active_timing_source: String,
    memory_active_timing_error: String,
}

impl Default for AdvancedSnapshot {
    fn default() -> Self {
        Self {
            updated_at_ms: 0,
            available: false,
            backend: "Low-level sensors starting".into(),
            cpu_package_c: None,
            cpu_hotspot_c: None,
            cpu_power_w: None,
            gpu_core_c: None,
            gpu_hotspot_c: None,
            gpu_memory_c: None,
            memory_bus_load_percent: None,
            memory_read_mi_bs: None,
            memory_write_mi_bs: None,
            memory_bus_source: String::new(),
            memory_modules: Vec::new(),
            memory_spd_profiles: Vec::new(),
            memory_spd_error: String::new(),
            memory_active_timings: Vec::new(),
            memory_active_timing_source: String::new(),
            memory_active_timing_error: "Active timing provider starting".into(),
        }
    }
}

impl AdvancedSnapshot {
    fn current(&self) -> Self {
        if self.updated_at_ms > 0
            && now_millis().saturating_sub(self.updated_at_ms) <= SENSOR_STALE_AFTER_MS
        {
            return self.clone();
        }

        let mut stale = self.clone();
        stale.available = false;
        stale.backend = if self.updated_at_ms == 0 {
            self.backend.clone()
        } else {
            "Low-level sensor host reconnecting".into()
        };
        stale.cpu_package_c = None;
        stale.cpu_hotspot_c = None;
        stale.cpu_power_w = None;
        stale.gpu_core_c = None;
        stale.gpu_hotspot_c = None;
        stale.gpu_memory_c = None;
        stale.memory_bus_load_percent = None;
        stale.memory_read_mi_bs = None;
        stale.memory_write_mi_bs = None;
        stale.memory_bus_source.clear();
        for module in &mut stale.memory_modules {
            module.temperature_c = None;
        }
        stale
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshot {
    timestamp: u64,
    pawn_io_installed: bool,
    #[serde(default)]
    sensors: Vec<HostSensor>,
    #[serde(default)]
    memory_modules: Vec<HostMemoryModule>,
    #[serde(default)]
    memory_spd_profiles: Vec<HostMemorySpdProfile>,
    #[serde(default)]
    memory_spd_error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSensor {
    #[serde(default)]
    hardware_name: String,
    #[serde(default)]
    hardware_type: String,
    #[serde(default)]
    hardware_identifier: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    sensor_type: String,
    #[serde(default)]
    identifier: String,
    value: f32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMemoryModule {
    #[serde(default)]
    slot: String,
    #[serde(default)]
    bank: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    manufacturer: String,
    #[serde(default)]
    part_number: String,
    #[serde(default)]
    serial_number: String,
    #[serde(default)]
    capacity_bytes: u64,
    #[serde(default)]
    speed_mts: u32,
    #[serde(default)]
    configured_speed_mts: u32,
    #[serde(default)]
    configured_voltage_mv: u32,
    #[serde(default)]
    min_voltage_mv: u32,
    #[serde(default)]
    max_voltage_mv: u32,
    #[serde(default)]
    data_width_bits: u32,
    #[serde(default)]
    total_width_bits: u32,
    #[serde(default)]
    form_factor: String,
    #[serde(default)]
    memory_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMemoryTiming {
    #[serde(default)]
    name: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    cycles: u32,
    #[serde(default)]
    nanoseconds: f32,
    #[serde(default)]
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMemorySpdProfile {
    #[serde(default)]
    address: String,
    #[serde(default)]
    memory_type: String,
    #[serde(default)]
    manufacturer: String,
    #[serde(default)]
    dram_manufacturer: String,
    #[serde(default)]
    part_number: String,
    #[serde(default)]
    serial_number: String,
    #[serde(default)]
    capacity_gi_b: f32,
    #[serde(default)]
    data_rate_mts: u32,
    #[serde(default)]
    cas_latencies: Vec<i32>,
    #[serde(default)]
    timings: Vec<HostMemoryTiming>,
}

struct ResourceCollector {
    system: System,
    networks: Networks,
    components: Components,
    last_network_refresh: Instant,
    advanced: Arc<Mutex<AdvancedSnapshot>>,
}

impl ResourceCollector {
    fn new(advanced: Arc<Mutex<AdvancedSnapshot>>) -> Self {
        let mut system = System::new_all();
        system.refresh_cpu_usage();
        Self {
            system,
            networks: Networks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            last_network_refresh: Instant::now(),
            advanced,
        }
    }

    fn sample(&mut self) -> ResourceSample {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.networks.refresh(true);
        self.components.refresh(false);

        let elapsed = self.last_network_refresh.elapsed().as_secs_f64().max(0.001);
        self.last_network_refresh = Instant::now();
        let rx = self
            .networks
            .values()
            .map(|network| network.received())
            .sum::<u64>() as f64
            / elapsed;
        let tx = self
            .networks
            .values()
            .map(|network| network.transmitted())
            .sum::<u64>() as f64
            / elapsed;
        let fallback_temperature = self
            .components
            .iter()
            .filter_map(|component| component.temperature())
            .filter(|value| value.is_finite() && *value > 0.0)
            .max_by(|left, right| left.total_cmp(right));
        let advanced = self
            .advanced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current();
        let nvidia = read_nvidia();
        let capacity = link_capacity_mibs(nvidia.current_gen, nvidia.current_width);
        let peak_direction = nvidia
            .rx_mibs
            .unwrap_or(0.0)
            .max(nvidia.tx_mibs.unwrap_or(0.0));

        ResourceSample {
            timestamp: now_millis(),
            advanced_sensors_available: advanced.available,
            sensor_backend: advanced.backend,
            cpu: CpuSample {
                load_percent: self.system.global_cpu_usage(),
                temperature_c: advanced.cpu_package_c.or(fallback_temperature),
                hotspot_c: advanced.cpu_hotspot_c,
                power_w: advanced.cpu_power_w,
                cores: self
                    .system
                    .cpus()
                    .iter()
                    .map(|cpu| cpu.cpu_usage())
                    .collect(),
            },
            memory: MemorySample {
                used_bytes: self.system.used_memory(),
                total_bytes: self.system.total_memory(),
                active_bytes: self
                    .system
                    .total_memory()
                    .saturating_sub(self.system.available_memory()),
                bus_available: advanced.memory_bus_load_percent.is_some()
                    || advanced.memory_read_mi_bs.is_some()
                    || advanced.memory_write_mi_bs.is_some(),
                bus_load_percent: advanced.memory_bus_load_percent,
                read_mi_bs: advanced.memory_read_mi_bs,
                write_mi_bs: advanced.memory_write_mi_bs,
                bus_source: if advanced.memory_bus_source.is_empty() {
                    "IMC bandwidth sensor unavailable".into()
                } else {
                    advanced.memory_bus_source
                },
                modules: advanced.memory_modules,
                spd_profiles: advanced.memory_spd_profiles,
                spd_error: advanced.memory_spd_error,
                active_timings: advanced.memory_active_timings,
                active_timing_source: advanced.memory_active_timing_source,
                active_timing_error: advanced.memory_active_timing_error,
            },
            gpu: GpuSample {
                available: nvidia.available || advanced.gpu_core_c.is_some(),
                name: nvidia.name,
                load_percent: nvidia.load_percent,
                temperature_c: nvidia.temperature_c.or(advanced.gpu_core_c),
                hotspot_c: advanced.gpu_hotspot_c,
                memory_temperature_c: nvidia.memory_temperature_c.or(advanced.gpu_memory_c),
                graphics_clock_mhz: nvidia.graphics_clock_mhz,
                memory_clock_mhz: nvidia.memory_clock_mhz,
                memory_used_mi_b: nvidia.memory_used_mib,
                memory_total_mi_b: nvidia.memory_total_mib,
                power_w: nvidia.power_w,
            },
            pcie: PcieSample {
                available: nvidia.available && nvidia.rx_mibs.is_some() && nvidia.tx_mibs.is_some(),
                rx_mi_bs: nvidia.rx_mibs,
                tx_mi_bs: nvidia.tx_mibs,
                load_percent: capacity
                    .map(|value| (peak_direction / value * 100.0).clamp(0.0, 100.0)),
                current_gen: nvidia.current_gen,
                current_width: nvidia.current_width,
                max_gen: nvidia.max_gen,
                max_width: nvidia.max_width,
            },
            network: NetworkSample {
                rx_bytes_per_second: rx,
                tx_bytes_per_second: tx,
            },
        }
    }
}

pub struct ResourceMonitor {
    enabled: Arc<AtomicBool>,
    sample_interval_ms: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    collector: Arc<Mutex<Option<ResourceCollector>>>,
    advanced: Arc<Mutex<AdvancedSnapshot>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    sensor_worker: Mutex<Option<JoinHandle<()>>>,
    timing_worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ResourceMonitor {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            sample_interval_ms: Arc::new(AtomicU64::new(DEFAULT_SAMPLE_INTERVAL_MS)),
            stop: Arc::new(AtomicBool::new(false)),
            collector: Arc::new(Mutex::new(None)),
            advanced: Arc::new(Mutex::new(AdvancedSnapshot::default())),
            worker: Mutex::new(None),
            sensor_worker: Mutex::new(None),
            timing_worker: Mutex::new(None),
        }
    }
}

impl ResourceMonitor {
    pub fn start(&self, app: AppHandle, runtime: Arc<RuntimeController>) -> Result<(), String> {
        self.stop.store(false, Ordering::Release);
        self.start_sensor_worker(&app)?;
        self.start_memory_timing_worker()?;

        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        let enabled = Arc::clone(&self.enabled);
        let sample_interval_ms = Arc::clone(&self.sample_interval_ms);
        let stop = Arc::clone(&self.stop);
        let collector = Arc::clone(&self.collector);
        let advanced = Arc::clone(&self.advanced);
        *worker = Some(
            thread::Builder::new()
                .name("keemash-resources".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        if enabled.load(Ordering::Acquire) {
                            let sample = sample_locked(&collector, &advanced);
                            runtime.record(
                                "telemetry",
                                serde_json::json!({"source": "resources", "snapshot": &sample}),
                            );
                            let _ = app.emit("resources-sample", sample);
                        }
                        sleep_configurable(&stop, &sample_interval_ms);
                    }
                })
                .map_err(|error| format!("Unable to start resource monitor: {error}"))?,
        );
        Ok(())
    }

    fn start_sensor_worker(&self, app: &AppHandle) -> Result<(), String> {
        let mut worker = self
            .sensor_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return Ok(());
        }

        let runtime = locate_sensor_runtime(app);
        let stop = Arc::clone(&self.stop);
        let enabled = Arc::clone(&self.enabled);
        let advanced = Arc::clone(&self.advanced);
        *worker = Some(
            thread::Builder::new()
                .name("keemash-low-level-sensors".into())
                .spawn(move || low_level_sensor_loop(&stop, &enabled, &advanced, runtime))
                .map_err(|error| format!("Unable to start low-level sensor monitor: {error}"))?,
        );
        Ok(())
    }

    fn start_memory_timing_worker(&self) -> Result<(), String> {
        let mut worker = self
            .timing_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        let stop = Arc::clone(&self.stop);
        let advanced = Arc::clone(&self.advanced);
        *worker = Some(
            thread::Builder::new()
                .name("keemash-memory-timings".into())
                .spawn(move || {
                    let result = read_aida_memory_timings(&stop);
                    let mut snapshot = advanced
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match result {
                        Ok(mut timings) => {
                            let data_rate = snapshot
                                .memory_modules
                                .iter()
                                .find_map(|module| {
                                    (module.configured_speed_mts > 0)
                                        .then_some(module.configured_speed_mts)
                                })
                                .unwrap_or_default();
                            if data_rate > 0 {
                                let cycle_ns = 2_000.0 / data_rate as f32;
                                for timing in &mut timings {
                                    timing.nanoseconds = timing.cycles as f32 * cycle_ns;
                                }
                            }
                            snapshot.memory_active_timings = timings;
                            snapshot.memory_active_timing_source = "AIDA64 active IMC".into();
                            snapshot.memory_active_timing_error.clear();
                        }
                        Err(error) => {
                            snapshot.memory_active_timing_error = error;
                        }
                    }
                })
                .map_err(|error| format!("Unable to start active timing provider: {error}"))?,
        );
        Ok(())
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    pub fn set_sample_interval_ms(&self, interval_ms: u64) {
        self.sample_interval_ms
            .store(interval_ms, Ordering::Release);
    }

    pub fn sample(&self) -> ResourceSample {
        sample_locked(&self.collector, &self.advanced)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        if let Some(worker) = self
            .timing_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        if let Some(worker) = self
            .sensor_worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn sample_locked(
    collector: &Mutex<Option<ResourceCollector>>,
    advanced: &Arc<Mutex<AdvancedSnapshot>>,
) -> ResourceSample {
    let mut collector = collector
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    collector
        .get_or_insert_with(|| ResourceCollector::new(Arc::clone(advanced)))
        .sample()
}

fn read_nvidia() -> NvidiaSnapshot {
    let fields = [
        "name",
        "utilization.gpu",
        "memory.used",
        "memory.total",
        "temperature.gpu",
        "temperature.memory",
        "clocks.current.graphics",
        "clocks.current.memory",
        "power.draw",
        "pcie.link.gen.gpucurrent",
        "pcie.link.gen.gpumax",
        "pcie.link.width.current",
        "pcie.link.width.max",
    ]
    .join(",");

    let details = run_hidden(
        Path::new("nvidia-smi"),
        &[
            &format!("--query-gpu={fields}"),
            "--format=csv,noheader,nounits",
        ],
    );
    let throughput = run_hidden(Path::new("nvidia-smi"), &["dmon", "-s", "t", "-c", "1"]);
    let (Ok(details), Ok(throughput)) = (details, throughput) else {
        return NvidiaSnapshot {
            name: "GPU telemetry unavailable".into(),
            ..Default::default()
        };
    };
    if !details.status.success() || !throughput.status.success() {
        return NvidiaSnapshot {
            name: "GPU telemetry unavailable".into(),
            ..Default::default()
        };
    }

    let details_text = String::from_utf8_lossy(&details.stdout);
    let values = details_text
        .lines()
        .next()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    let throughput_text = String::from_utf8_lossy(&throughput.stdout);
    let (rx_mibs, tx_mibs) = parse_pcie_dmon(&throughput_text);
    NvidiaSnapshot {
        available: true,
        name: values.first().copied().unwrap_or("NVIDIA GPU").to_string(),
        load_percent: parse_number(values.get(1).copied()),
        memory_used_mib: parse_number(values.get(2).copied()),
        memory_total_mib: parse_number(values.get(3).copied()),
        temperature_c: parse_number(values.get(4).copied()),
        memory_temperature_c: parse_number(values.get(5).copied()),
        graphics_clock_mhz: parse_number(values.get(6).copied()),
        memory_clock_mhz: parse_number(values.get(7).copied()),
        power_w: parse_number(values.get(8).copied()),
        current_gen: parse_number(values.get(9).copied()),
        max_gen: parse_number(values.get(10).copied()),
        current_width: parse_number(values.get(11).copied()),
        max_width: parse_number(values.get(12).copied()),
        rx_mibs,
        tx_mibs,
    }
}

fn low_level_sensor_loop(
    stop: &AtomicBool,
    enabled: &AtomicBool,
    advanced: &Mutex<AdvancedSnapshot>,
    runtime: Option<PathBuf>,
) {
    let Some(runtime) = runtime else {
        set_backend_state(advanced, "Low-level sensor runtime missing");
        return;
    };

    while !stop.load(Ordering::Acquire) {
        if !enabled.load(Ordering::Acquire) {
            sleep_interruptible(stop, Duration::from_millis(250));
            continue;
        }
        let host = runtime.join("KeeMashSensorHost.exe");
        let mut command = Command::new(&host);
        command
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .current_dir(&runtime)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        match command.spawn() {
            Ok(mut child) => {
                let Some(stdout) = child.stdout.take() else {
                    set_backend_state(advanced, "Low-level sensor host has no output");
                    let _ = child.kill();
                    sleep_interruptible(stop, SENSOR_RETRY_DELAY);
                    continue;
                };
                let (sender, receiver) = mpsc::channel::<String>();
                let reader = thread::Builder::new()
                    .name("keemash-sensor-output".into())
                    .spawn(move || {
                        let mut reader = BufReader::new(stdout);
                        loop {
                            let mut line = String::new();
                            match reader.read_line(&mut line) {
                                Ok(0) | Err(_) => break,
                                Ok(_) if sender.send(line).is_err() => break,
                                Ok(_) => {}
                            }
                        }
                    });

                loop {
                    while let Ok(line) = receiver.try_recv() {
                        if let Ok(host_snapshot) = serde_json::from_str::<HostSnapshot>(line.trim())
                        {
                            let mut next = classify_advanced(host_snapshot);
                            let mut current = advanced
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            next.memory_active_timings = current.memory_active_timings.clone();
                            next.memory_active_timing_source =
                                current.memory_active_timing_source.clone();
                            next.memory_active_timing_error =
                                current.memory_active_timing_error.clone();
                            *current = next;
                        }
                    }
                    if stop.load(Ordering::Acquire) {
                        let _ = child.kill();
                        break;
                    }
                    if !enabled.load(Ordering::Acquire) {
                        let _ = child.kill();
                        break;
                    }
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => thread::sleep(Duration::from_millis(100)),
                    }
                }
                let _ = child.wait();
                if let Ok(reader) = reader {
                    let _ = reader.join();
                }
                if !stop.load(Ordering::Acquire) {
                    set_backend_state(advanced, "Low-level sensor host reconnecting");
                }
            }
            Err(error) => {
                set_backend_state(advanced, &format!("Low-level sensor host failed: {error}"))
            }
        }
        sleep_interruptible(stop, SENSOR_RETRY_DELAY);
    }
}

fn classify_advanced(host: HostSnapshot) -> AdvancedSnapshot {
    let mut result = AdvancedSnapshot {
        updated_at_ms: host
            .timestamp
            .max(now_millis().saturating_sub(SENSOR_HOST_INTERVAL.as_millis() as u64)),
        backend: if host.pawn_io_installed {
            "LibreHardwareMonitor + PawnIO".into()
        } else {
            "LibreHardwareMonitor (PawnIO unavailable)".into()
        },
        ..AdvancedSnapshot::default()
    };
    result.memory_spd_error =
        if host.memory_spd_profiles.is_empty() && host.memory_spd_error.trim().is_empty() {
            "SPD devices are not readable through the current SMBus provider".into()
        } else {
            host.memory_spd_error.trim().to_string()
        };
    result.memory_spd_profiles = host
        .memory_spd_profiles
        .into_iter()
        .map(|profile| MemorySpdProfileSample {
            address: profile.address,
            memory_type: profile.memory_type,
            manufacturer: profile.manufacturer,
            dram_manufacturer: profile.dram_manufacturer,
            part_number: profile.part_number,
            serial_number: profile.serial_number,
            capacity_gi_b: profile.capacity_gi_b,
            data_rate_mts: profile.data_rate_mts,
            cas_latencies: profile.cas_latencies,
            timings: profile
                .timings
                .into_iter()
                .map(|timing| MemoryTimingSample {
                    name: timing.name,
                    group: timing.group,
                    cycles: timing.cycles,
                    nanoseconds: timing.nanoseconds,
                    source: timing.source,
                })
                .collect(),
        })
        .collect();
    let mut memory_temperatures: Vec<&HostSensor> = Vec::new();

    for sensor in &host.sensors {
        if !sensor.value.is_finite() {
            continue;
        }

        let hardware_type = sensor.hardware_type.to_ascii_lowercase();
        let name = sensor.name.to_ascii_lowercase();
        let sensor_type = sensor.sensor_type.to_ascii_lowercase();
        let identifier = format!(
            "{} {}",
            sensor.hardware_identifier.to_ascii_lowercase(),
            sensor.identifier.to_ascii_lowercase()
        );
        let memory_bus_sensor = name.contains("memory controller")
            || name.contains("memory bus")
            || name.contains("dram bus")
            || name.contains("imc")
            || name.contains("memory bandwidth");
        if memory_bus_sensor {
            if sensor_type == "load" && (0.0..=100.0).contains(&sensor.value) {
                keep_max(&mut result.memory_bus_load_percent, sensor.value);
            } else if sensor_type.contains("throughput") || sensor_type.contains("datarate") {
                if name.contains("read") {
                    keep_max(&mut result.memory_read_mi_bs, sensor.value);
                } else if name.contains("write") {
                    keep_max(&mut result.memory_write_mi_bs, sensor.value);
                }
            }
            if result.memory_bus_load_percent.is_some()
                || result.memory_read_mi_bs.is_some()
                || result.memory_write_mi_bs.is_some()
            {
                result.memory_bus_source = format!("{} / {}", sensor.hardware_name, sensor.name);
            }
        }
        if hardware_type.contains("cpu")
            && sensor_type == "power"
            && (name.contains("cpu package") || name.contains("package power"))
            && (0.0..=MAX_CPU_PACKAGE_POWER_W).contains(&sensor.value)
        {
            keep_max(&mut result.cpu_power_w, sensor.value);
        }
        if sensor_type != "temperature" || !(-50.0..=200.0).contains(&sensor.value) {
            continue;
        }
        if hardware_type.contains("cpu") {
            if name.contains("package") {
                keep_max(&mut result.cpu_package_c, sensor.value);
            }
            if name.contains("core max") || name.contains("core #") {
                keep_max(&mut result.cpu_hotspot_c, sensor.value);
            }
        } else if hardware_type.contains("gpu") {
            if name.contains("hot spot") || name.contains("hotspot") {
                keep_max(&mut result.gpu_hotspot_c, sensor.value);
            } else if name.contains("memory") || name.contains("junction") {
                keep_max(&mut result.gpu_memory_c, sensor.value);
            } else if name.contains("core") {
                keep_max(&mut result.gpu_core_c, sensor.value);
            }
        } else if hardware_type.contains("memory") || identifier.contains("/memory/") {
            memory_temperatures.push(sensor);
        }
    }

    result.memory_modules = merge_memory_modules(&host.memory_modules, &memory_temperatures);
    result.available = result.cpu_package_c.is_some()
        || result.cpu_hotspot_c.is_some()
        || result.cpu_power_w.is_some()
        || result.gpu_core_c.is_some()
        || result.gpu_hotspot_c.is_some()
        || result.gpu_memory_c.is_some()
        || result.memory_bus_load_percent.is_some()
        || result.memory_read_mi_bs.is_some()
        || result.memory_write_mi_bs.is_some()
        || result
            .memory_modules
            .iter()
            .any(|module| module.temperature_c.is_some());
    result
}

fn merge_memory_modules(
    inventory: &[HostMemoryModule],
    temperatures: &[&HostSensor],
) -> Vec<MemoryModuleSample> {
    let mut used = vec![false; temperatures.len()];
    let mut modules = inventory
        .iter()
        .map(|module| {
            let keys = [normalize(&module.slot), normalize(&module.name)];
            let matched = temperatures.iter().enumerate().position(|(index, sensor)| {
                if used[index] {
                    return false;
                }
                let haystack = normalize(&format!(
                    "{} {} {} {}",
                    sensor.hardware_name,
                    sensor.hardware_identifier,
                    sensor.name,
                    sensor.identifier
                ));
                keys.iter()
                    .any(|key| key.len() >= 4 && haystack.contains(key))
            });
            let temperature_c = matched.map(|index| {
                used[index] = true;
                temperatures[index].value
            });
            MemoryModuleSample {
                slot: if module.slot.trim().is_empty() {
                    "Unknown slot".into()
                } else {
                    module.slot.trim().to_string()
                },
                bank: module.bank.trim().to_string(),
                name: if module.name.trim().is_empty() {
                    "Memory module".into()
                } else {
                    module.name.trim().to_string()
                },
                manufacturer: module.manufacturer.trim().to_string(),
                part_number: module.part_number.trim().to_string(),
                serial_number: module.serial_number.trim().to_string(),
                capacity_bytes: module.capacity_bytes,
                speed_mts: module.speed_mts,
                configured_speed_mts: module.configured_speed_mts,
                configured_voltage_mv: module.configured_voltage_mv,
                min_voltage_mv: module.min_voltage_mv,
                max_voltage_mv: module.max_voltage_mv,
                data_width_bits: module.data_width_bits,
                total_width_bits: module.total_width_bits,
                form_factor: module.form_factor.trim().to_string(),
                memory_type: module.memory_type.trim().to_string(),
                temperature_c,
            }
        })
        .collect::<Vec<_>>();

    let unmatched_module_indexes = modules
        .iter()
        .enumerate()
        .filter_map(|(index, module)| module.temperature_c.is_none().then_some(index))
        .collect::<Vec<_>>();
    let unmatched_temperature_indexes = used
        .iter()
        .enumerate()
        .filter_map(|(index, is_used)| (!is_used).then_some(index))
        .collect::<Vec<_>>();
    if unmatched_module_indexes.len() == unmatched_temperature_indexes.len() {
        for (module_index, temperature_index) in unmatched_module_indexes
            .into_iter()
            .zip(unmatched_temperature_indexes)
        {
            modules[module_index].temperature_c = Some(temperatures[temperature_index].value);
            used[temperature_index] = true;
        }
    }

    for (index, sensor) in temperatures.iter().enumerate() {
        if !used[index] {
            modules.push(MemoryModuleSample {
                slot: sensor.hardware_name.clone(),
                bank: String::new(),
                name: sensor.name.clone(),
                manufacturer: String::new(),
                part_number: String::new(),
                serial_number: String::new(),
                capacity_bytes: 0,
                speed_mts: 0,
                configured_speed_mts: 0,
                configured_voltage_mv: 0,
                min_voltage_mv: 0,
                max_voltage_mv: 0,
                data_width_bits: 0,
                total_width_bits: 0,
                form_factor: String::new(),
                memory_type: String::new(),
                temperature_c: Some(sensor.value),
            });
        }
    }
    modules.sort_by(|left, right| left.slot.cmp(&right.slot));
    modules
}

fn keep_max(slot: &mut Option<f32>, value: f32) {
    if slot.is_none_or(|current| value > current) {
        *slot = Some(value);
    }
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn locate_sensor_runtime(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("vendor").join("librehardwaremonitor"));
        candidates.push(resource_dir.join("librehardwaremonitor"));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor")
            .join("librehardwaremonitor"),
    );
    candidates.into_iter().find(|candidate| {
        candidate.join("KeeMashSensorHost.exe").is_file()
            && candidate.join("LibreHardwareMonitorLib.dll").is_file()
    })
}

fn set_backend_state(advanced: &Mutex<AdvancedSnapshot>, message: &str) {
    let mut state = advanced
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.available = false;
    state.backend = message.to_string();
    state.updated_at_ms = 0;
}

fn sleep_interruptible(stop: &AtomicBool, duration: Duration) {
    let started = Instant::now();
    while !stop.load(Ordering::Acquire) && started.elapsed() < duration {
        thread::sleep(Duration::from_millis(100));
    }
}

fn sleep_configurable(stop: &AtomicBool, interval_ms: &AtomicU64) {
    let configured = interval_ms.load(Ordering::Acquire);
    let started = Instant::now();
    while !stop.load(Ordering::Acquire)
        && interval_ms.load(Ordering::Acquire) == configured
        && started.elapsed() < Duration::from_millis(configured)
    {
        thread::sleep(Duration::from_millis(50));
    }
}

fn run_hidden(program: &Path, arguments: &[&str]) -> Result<Output, String> {
    run_hidden_timeout(program, arguments, PROCESS_TIMEOUT)
}

fn run_hidden_timeout(
    program: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
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

fn read_aida_memory_timings(stop: &AtomicBool) -> Result<Vec<MemoryTimingSample>, String> {
    #[cfg(windows)]
    {
        let executable = [
            PathBuf::from(r"C:\Program Files\FinalWire\AIDA64 Engineer\aida64.exe"),
            PathBuf::from(r"C:\Program Files\FinalWire\AIDA64 Extreme\aida64.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("AIDA64 timing provider is not installed")?;
        let report =
            std::env::temp_dir().join(format!("keemash-aida-memory-{}.csv", std::process::id()));
        let _ = fs::remove_file(&report);
        let mut command = Command::new(&executable);
        command
            .args(["/R", &report.to_string_lossy(), "/CSV", "/HW", "/SILENT"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Unable to start AIDA64 timing report: {error}"))?;
        let started = Instant::now();
        loop {
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(status) if status.success() => break,
                Some(status) => {
                    let _ = fs::remove_file(&report);
                    return Err(format!("AIDA64 timing report exited with {status}"));
                }
                None if stop.load(Ordering::Acquire) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&report);
                    return Err("AIDA64 timing report cancelled".into());
                }
                None if started.elapsed() < AIDA_REPORT_TIMEOUT => {
                    thread::sleep(Duration::from_millis(100));
                }
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&report);
                    return Err("AIDA64 timing report timed out".into());
                }
            }
        }

        let parsed = parse_aida_memory_report(&report);
        let _ = fs::remove_file(&report);
        parsed
    }
    #[cfg(not(windows))]
    {
        let _ = stop;
        Err("AIDA64 timing provider is available only on Windows".into())
    }
}

fn parse_aida_memory_report(path: &Path) -> Result<Vec<MemoryTimingSample>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|error| format!("AIDA64 timing report open failed: {error}"))?;
    let mut timings = BTreeMap::<String, MemoryTimingSample>::new();
    for row in reader.records() {
        let row = row.map_err(|error| format!("AIDA64 timing report parse failed: {error}"))?;
        let joined = row
            .iter()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if !joined.contains(" imc") {
            continue;
        }
        for (index, field) in row.iter().enumerate() {
            let Some(name) = aida_timing_name(field) else {
                continue;
            };
            let value = row
                .get(index + 1)
                .and_then(parse_timing_cycles)
                .or_else(|| row.iter().rev().find_map(parse_timing_cycles));
            let Some(cycles) = value else { continue };
            let group = if matches!(name, "tCL" | "tRCD" | "tRP" | "tRAS" | "CR") {
                "primary"
            } else if name.contains("RDRD")
                || name.contains("RDWR")
                || name.contains("WRRD")
                || name.contains("WRWR")
            {
                "tertiary"
            } else {
                "secondary"
            };
            timings.insert(
                name.into(),
                MemoryTimingSample {
                    name: name.into(),
                    group: group.into(),
                    cycles,
                    nanoseconds: 0.0,
                    source: "AIDA64 active IMC".into(),
                },
            );
        }
    }
    if timings.is_empty() {
        Err("AIDA64 report did not expose active IMC timings".into())
    } else {
        Ok(timings.into_values().collect())
    }
}

fn aida_timing_name(label: &str) -> Option<&'static str> {
    let value = label.to_ascii_lowercase();
    [
        ("(twcl)", "tCWL"),
        ("(tcwl)", "tCWL"),
        ("write cas latency", "tCWL"),
        ("(trcd)", "tRCD"),
        ("(trp)", "tRP"),
        ("(tras)", "tRAS"),
        ("(trfc)", "tRFC1"),
        ("(trefi)", "tREFI"),
        ("(tfaw)", "tFAW"),
        ("(trrd_s)", "tRRD_S"),
        ("(trrd_l)", "tRRD_L"),
        ("(tccd_s)", "tCCD_S"),
        ("(tccd_l)", "tCCD_L"),
        ("(twtr_s)", "tWTR_S"),
        ("(twtr_l)", "tWTR_L"),
        ("(twtr)", "tWTR_S"),
        ("(twr)", "tWR"),
        ("(trtp)", "tRTP"),
        ("(tcke)", "tCKE"),
        ("(txp)", "tXP"),
        ("(trc)", "tRC"),
        ("command rate", "CR"),
        ("cas latency (cl)", "tCL"),
    ]
    .into_iter()
    .find_map(|(needle, name)| value.contains(needle).then_some(name))
}

fn parse_timing_cycles(value: &str) -> Option<u32> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse()
        .ok()
}

fn parse_pcie_dmon(output: &str) -> (Option<f32>, Option<f32>) {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            (
                parse_number(fields.get(1).copied()),
                parse_number(fields.get(2).copied()),
            )
        })
        .unwrap_or((None, None))
}

fn parse_number(value: Option<&str>) -> Option<f32> {
    value?
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|number| number.is_finite())
}

fn link_capacity_mibs(generation: Option<f32>, width: Option<f32>) -> Option<f32> {
    let per_lane = match generation?.round() as u8 {
        1 => 250.0,
        2 => 500.0,
        3 => 985.0,
        4 => 1_969.0,
        5 => 3_938.0,
        6 => 7_563.0,
        _ => return None,
    };
    Some(per_lane * width?)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_pcie_throughput() {
        let text = "# gpu   rxpci   txpci\n# Idx   MB/s    MB/s\n    0       5    1152\n";
        assert_eq!(parse_pcie_dmon(text), (Some(5.0), Some(1152.0)));
    }

    #[test]
    fn rejects_unsupported_nvidia_values() {
        assert_eq!(parse_number(Some("N/A")), None);
        assert_eq!(parse_number(Some("[Not Supported]")), None);
    }

    #[test]
    fn computes_link_capacity() {
        assert_eq!(link_capacity_mibs(Some(4.0), Some(8.0)), Some(15_752.0));
    }

    #[test]
    fn classifies_cpu_gpu_and_memory_temperatures() {
        let snapshot = HostSnapshot {
            timestamp: now_millis(),
            pawn_io_installed: true,
            sensors: vec![
                sensor("Cpu", "CPU Package", 57.0),
                sensor("Cpu", "Core Max", 63.0),
                sensor("GpuNvidia", "GPU Hot Spot", 71.0),
                sensor("GpuNvidia", "GPU Memory", 66.0),
                HostSensor {
                    hardware_name: "Controller0-ChannelA-DIMM0".into(),
                    hardware_type: "Memory".into(),
                    hardware_identifier: "/memory/0".into(),
                    name: "DIMM Temperature".into(),
                    sensor_type: "Temperature".into(),
                    identifier: "/memory/0/temperature/0".into(),
                    value: 44.0,
                },
            ],
            memory_modules: vec![HostMemoryModule {
                slot: "Controller0-ChannelA-DIMM0".into(),
                name: "Kingston KF3200C20S4/16G".into(),
                capacity_bytes: 16 * 1024 * 1024 * 1024,
                ..HostMemoryModule::default()
            }],
            ..HostSnapshot::default()
        };
        let parsed = classify_advanced(snapshot);
        assert_eq!(parsed.cpu_package_c, Some(57.0));
        assert_eq!(parsed.cpu_hotspot_c, Some(63.0));
        assert_eq!(parsed.gpu_hotspot_c, Some(71.0));
        assert_eq!(parsed.gpu_memory_c, Some(66.0));
        assert_eq!(parsed.memory_modules[0].temperature_c, Some(44.0));
    }

    #[test]
    fn classifies_only_sane_cpu_package_power() {
        let snapshot = HostSnapshot {
            timestamp: now_millis(),
            pawn_io_installed: true,
            sensors: vec![
                power_sensor("Cpu", "CPU Package", 42.5),
                power_sensor("Cpu", "Package Power", 47.25),
                power_sensor("Cpu", "CPU Core #1", 19.0),
                power_sensor("GpuNvidia", "GPU Package Power", 80.0),
                power_sensor("Cpu", "CPU Package", -1.0),
                power_sensor("Cpu", "Package Power", MAX_CPU_PACKAGE_POWER_W + 1.0),
                sensor("Cpu", "CPU Package", 61.0),
            ],
            ..HostSnapshot::default()
        };

        let parsed = classify_advanced(snapshot);
        assert_eq!(parsed.cpu_power_w, Some(47.25));
        assert!(parsed.available);
    }

    #[test]
    fn clears_cpu_package_power_when_sensor_snapshot_is_stale() {
        let snapshot = AdvancedSnapshot {
            updated_at_ms: now_millis().saturating_sub(SENSOR_STALE_AFTER_MS + 1),
            available: true,
            cpu_power_w: Some(44.0),
            ..AdvancedSnapshot::default()
        };

        let current = snapshot.current();
        assert_eq!(current.cpu_power_w, None);
        assert!(!current.available);
    }

    #[test]
    fn accepts_only_explicit_memory_bus_sensors() {
        let snapshot = HostSnapshot {
            timestamp: now_millis(),
            pawn_io_installed: true,
            sensors: vec![
                HostSensor {
                    hardware_name: "Intel IMC".into(),
                    hardware_type: "Memory".into(),
                    hardware_identifier: "/memorycontroller/0".into(),
                    name: "Memory Controller Load".into(),
                    sensor_type: "Load".into(),
                    identifier: "/memorycontroller/0/load/0".into(),
                    value: 47.5,
                },
                HostSensor {
                    hardware_name: "Total Memory".into(),
                    hardware_type: "Memory".into(),
                    hardware_identifier: "/memory".into(),
                    name: "Memory".into(),
                    sensor_type: "Load".into(),
                    identifier: "/memory/load/0".into(),
                    value: 73.0,
                },
            ],
            memory_modules: Vec::new(),
            ..HostSnapshot::default()
        };
        let parsed = classify_advanced(snapshot);
        assert_eq!(parsed.memory_bus_load_percent, Some(47.5));
        assert!(parsed.memory_bus_source.contains("Intel IMC"));
    }

    #[test]
    fn parses_active_imc_timings_from_aida_csv() {
        let path = std::env::temp_dir().join(format!(
            "keemash-aida-parser-test-{}.csv",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "Chipset,North Bridge : Intel Tiger Lake-H IMC,Memory Timings,793,CAS Latency (CL),16T\nChipset,North Bridge : Intel Tiger Lake-H IMC,Memory Timings,800,Row Refresh Cycle Time (tRFC),520T\nChipset,North Bridge : Intel Tiger Lake-H IMC,Memory Timings,801,Command Rate (CR),1T\n",
        )
        .unwrap();
        let parsed = parse_aida_memory_report(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert!(parsed
            .iter()
            .any(|timing| timing.name == "tCL" && timing.cycles == 16));
        assert!(parsed
            .iter()
            .any(|timing| timing.name == "tRFC1" && timing.cycles == 520));
        assert!(parsed
            .iter()
            .any(|timing| timing.name == "CR" && timing.cycles == 1));
    }

    fn sensor(hardware_type: &str, name: &str, value: f32) -> HostSensor {
        HostSensor {
            hardware_name: "hardware".into(),
            hardware_type: hardware_type.into(),
            hardware_identifier: format!("/{hardware_type}"),
            name: name.into(),
            sensor_type: "Temperature".into(),
            identifier: format!("/{hardware_type}/{name}"),
            value,
        }
    }

    fn power_sensor(hardware_type: &str, name: &str, value: f32) -> HostSensor {
        HostSensor {
            hardware_name: "hardware".into(),
            hardware_type: hardware_type.into(),
            hardware_identifier: format!("/{hardware_type}"),
            name: name.into(),
            sensor_type: "Power".into(),
            identifier: format!("/{hardware_type}/{name}"),
            value,
        }
    }
}
