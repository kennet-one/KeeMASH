use serde::Serialize;

use crate::hwinfo_shared::VramChipTemperature;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialStatus {
    pub connected: bool,
    pub path: Option<String>,
    pub baud_rate: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuSample {
    pub load_percent: f32,
    pub temperature_c: Option<f32>,
    pub hotspot_c: Option<f32>,
    pub power_w: Option<f32>,
    pub cores: Vec<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryModuleSample {
    pub slot: String,
    pub bank: String,
    pub name: String,
    pub manufacturer: String,
    pub part_number: String,
    pub serial_number: String,
    pub capacity_bytes: u64,
    pub speed_mts: u32,
    pub configured_speed_mts: u32,
    pub configured_voltage_mv: u32,
    pub min_voltage_mv: u32,
    pub max_voltage_mv: u32,
    pub data_width_bits: u32,
    pub total_width_bits: u32,
    pub form_factor: String,
    pub memory_type: String,
    pub temperature_c: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTimingSample {
    pub name: String,
    pub group: String,
    pub cycles: u32,
    pub nanoseconds: f32,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySpdProfileSample {
    pub address: String,
    pub memory_type: String,
    pub manufacturer: String,
    pub dram_manufacturer: String,
    pub part_number: String,
    pub serial_number: String,
    pub capacity_gi_b: f32,
    pub data_rate_mts: u32,
    pub cas_latencies: Vec<i32>,
    pub timings: Vec<MemoryTimingSample>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySample {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub active_bytes: u64,
    pub bus_available: bool,
    pub bus_load_percent: Option<f32>,
    pub read_mi_bs: Option<f32>,
    pub write_mi_bs: Option<f32>,
    pub bus_source: String,
    pub modules: Vec<MemoryModuleSample>,
    pub spd_profiles: Vec<MemorySpdProfileSample>,
    pub spd_error: String,
    pub active_timings: Vec<MemoryTimingSample>,
    pub active_timing_source: String,
    pub active_timing_error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub available: bool,
    pub name: String,
    pub load_percent: Option<f32>,
    pub temperature_c: Option<f32>,
    pub hotspot_c: Option<f32>,
    pub memory_temperature_c: Option<f32>,
    pub graphics_clock_mhz: Option<f32>,
    pub memory_clock_mhz: Option<f32>,
    pub memory_used_mi_b: Option<f32>,
    pub memory_total_mi_b: Option<f32>,
    pub power_w: Option<f32>,
    pub memory_chips_available: bool,
    pub memory_chip_source: String,
    pub memory_chip_updated_at: u64,
    pub memory_chip_error: String,
    pub memory_chips: Vec<VramChipTemperature>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcieSample {
    pub available: bool,
    pub rx_mi_bs: Option<f32>,
    pub tx_mi_bs: Option<f32>,
    pub load_percent: Option<f32>,
    pub current_gen: Option<f32>,
    pub current_width: Option<f32>,
    pub max_gen: Option<f32>,
    pub max_width: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub rx_bytes_per_second: f64,
    pub tx_bytes_per_second: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    pub timestamp: u64,
    pub cpu: CpuSample,
    pub advanced_sensors_available: bool,
    pub sensor_backend: String,
    pub memory: MemorySample,
    pub gpu: GpuSample,
    pub pcie: PcieSample,
    pub network: NetworkSample,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherCurrent {
    pub temperature_c: Option<f64>,
    pub apparent_c: Option<f64>,
    pub humidity_percent: Option<f64>,
    pub wind_kmh: Option<f64>,
    pub precipitation_mm: Option<f64>,
    pub precipitation_probability_percent: Option<f64>,
    pub rain_mm: Option<f64>,
    pub snowfall_cm: Option<f64>,
    pub weather_code: Option<i64>,
    pub is_day: Option<bool>,
    pub cloud_percent: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherAir {
    pub pm25: Option<f64>,
    pub pm10: Option<f64>,
    pub carbon_dioxide: Option<f64>,
    pub ozone: Option<f64>,
    pub dust: Option<f64>,
    pub aerosol_optical_depth: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherDaily {
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
    pub temperature_max_c: Option<f64>,
    pub temperature_min_c: Option<f64>,
    pub precipitation_sum_mm: Option<f64>,
    pub precipitation_probability_max_percent: Option<f64>,
    pub snowfall_sum_cm: Option<f64>,
    pub weather_code: Option<i64>,
    pub precipitation_hours: Option<f64>,
    pub shortwave_radiation_sum: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherSnapshot {
    pub updated_at: u64,
    pub current: WeatherCurrent,
    pub air: WeatherAir,
    pub daily: WeatherDaily,
}
