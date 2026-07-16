use serde::Serialize;

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
    pub cores: Vec<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySample {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub active_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub available: bool,
    pub name: String,
    pub load_percent: Option<f32>,
    pub temperature_c: Option<f32>,
    pub memory_used_mi_b: Option<f32>,
    pub memory_total_mi_b: Option<f32>,
    pub power_w: Option<f32>,
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
