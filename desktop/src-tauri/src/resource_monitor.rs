use crate::models::{
    CpuSample, GpuSample, MemorySample, NetworkSample, PcieSample, ResourceSample,
};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Components, Networks, System};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct NvidiaSnapshot {
    available: bool,
    name: String,
    load_percent: Option<f32>,
    temperature_c: Option<f32>,
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

struct ResourceCollector {
    system: System,
    networks: Networks,
    components: Components,
    last_network_refresh: Instant,
}

impl ResourceCollector {
    fn new() -> Self {
        let mut system = System::new_all();
        system.refresh_cpu_usage();
        Self {
            system,
            networks: Networks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            last_network_refresh: Instant::now(),
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
        let temperature = self
            .components
            .iter()
            .filter_map(|component| component.temperature())
            .filter(|value| value.is_finite() && *value > 0.0)
            .max_by(|left, right| left.total_cmp(right));
        let nvidia = read_nvidia();
        let capacity = link_capacity_mibs(nvidia.current_gen, nvidia.current_width);
        let peak_direction = nvidia
            .rx_mibs
            .unwrap_or(0.0)
            .max(nvidia.tx_mibs.unwrap_or(0.0));

        ResourceSample {
            timestamp: now_millis(),
            cpu: CpuSample {
                load_percent: self.system.global_cpu_usage(),
                temperature_c: temperature,
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
            },
            gpu: GpuSample {
                available: nvidia.available,
                name: nvidia.name,
                load_percent: nvidia.load_percent,
                temperature_c: nvidia.temperature_c,
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
    stop: Arc<AtomicBool>,
    collector: Arc<Mutex<Option<ResourceCollector>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ResourceMonitor {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            collector: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        }
    }
}

impl ResourceMonitor {
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return Ok(());
        }
        let enabled = Arc::clone(&self.enabled);
        let stop = Arc::clone(&self.stop);
        let collector = Arc::clone(&self.collector);
        *worker = Some(
            thread::Builder::new()
                .name("keemash-resources".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        if enabled.load(Ordering::Acquire) {
                            let sample = sample_locked(&collector);
                            let _ = app.emit("resources-sample", sample);
                        }
                        thread::sleep(SAMPLE_INTERVAL);
                    }
                })
                .map_err(|error| format!("Unable to start resource monitor: {error}"))?,
        );
        Ok(())
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    pub fn sample(&self) -> ResourceSample {
        sample_locked(&self.collector)
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
    }
}

fn sample_locked(collector: &Mutex<Option<ResourceCollector>>) -> ResourceSample {
    let mut collector = collector
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    collector
        .get_or_insert_with(ResourceCollector::new)
        .sample()
}

fn read_nvidia() -> NvidiaSnapshot {
    let fields = [
        "name",
        "utilization.gpu",
        "memory.used",
        "memory.total",
        "temperature.gpu",
        "power.draw",
        "pcie.link.gen.gpucurrent",
        "pcie.link.gen.gpumax",
        "pcie.link.width.current",
        "pcie.link.width.max",
    ]
    .join(",");

    let details = run_hidden(
        "nvidia-smi",
        &[
            &format!("--query-gpu={fields}"),
            "--format=csv,noheader,nounits",
        ],
    );
    let throughput = run_hidden("nvidia-smi", &["dmon", "-s", "t", "-c", "1"]);
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
        power_w: parse_number(values.get(5).copied()),
        current_gen: parse_number(values.get(6).copied()),
        max_gen: parse_number(values.get(7).copied()),
        current_width: parse_number(values.get(8).copied()),
        max_width: parse_number(values.get(9).copied()),
        rx_mibs,
        tx_mibs,
    }
}

fn run_hidden(program: &str, arguments: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if started.elapsed() < PROCESS_TIMEOUT => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out"));
            }
        }
    }
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
    fn computes_link_capacity() {
        assert_eq!(link_capacity_mibs(Some(4.0), Some(8.0)), Some(15_752.0));
    }
}
