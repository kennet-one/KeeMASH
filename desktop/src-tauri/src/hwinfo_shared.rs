use serde::Serialize;

const MAX_SHARED_BYTES: usize = 20_000_000;
const HEADER_SIZE: usize = 48;
const SENSOR_V2_NAME_OFFSET: usize = 264;
const SENSOR_V2_NAME_LEN: usize = 128;
const SENSOR_ASCII_NAME_OFFSET: usize = 136;
const READING_V2_LABEL_OFFSET: usize = 316;
const READING_V2_UNIT_OFFSET: usize = 444;
const READING_ASCII_LABEL_OFFSET: usize = 140;
const READING_ASCII_UNIT_OFFSET: usize = 268;
const SENSOR_STRING_LEN: usize = 128;
const UNIT_STRING_LEN: usize = 16;
const READING_VALUE_OFFSET: usize = 284;
const SENSOR_TYPE_TEMPERATURE: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VramChipTemperature {
    pub channel: u32,
    pub label: String,
    pub temperature_c: f32,
    pub minimum_c: Option<f32>,
    pub maximum_c: Option<f32>,
    pub average_c: Option<f32>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HwinfoVramSnapshot {
    pub available: bool,
    pub active: bool,
    pub source: String,
    pub last_update_unix_s: u64,
    pub chips: Vec<VramChipTemperature>,
    pub error: String,
}

#[derive(Clone, Copy, Debug)]
struct Header {
    version: u32,
    last_update: u64,
    sensor_offset: usize,
    sensor_size: usize,
    sensor_count: usize,
    reading_offset: usize,
    reading_size: usize,
    reading_count: usize,
    active: bool,
}

pub fn read_vram_chip_temperatures() -> HwinfoVramSnapshot {
    #[cfg(windows)]
    {
        windows::read_snapshot().unwrap_or_else(|error| HwinfoVramSnapshot {
            source: "HWiNFO shared memory".into(),
            error,
            ..Default::default()
        })
    }

    #[cfg(not(windows))]
    HwinfoVramSnapshot {
        source: "HWiNFO shared memory".into(),
        error: "Per-chip VRAM telemetry is available only on Windows".into(),
        ..Default::default()
    }
}

fn parse_snapshot(bytes: &[u8]) -> Result<HwinfoVramSnapshot, String> {
    let header = parse_header(bytes)?;
    let sensors_end = checked_section_end(
        header.sensor_offset,
        header.sensor_size,
        header.sensor_count,
    )?;
    let readings_end = checked_section_end(
        header.reading_offset,
        header.reading_size,
        header.reading_count,
    )?;
    if sensors_end > bytes.len() || readings_end > bytes.len() {
        return Err("HWiNFO shared memory layout exceeds mapped data".into());
    }

    let mut sensor_names = Vec::with_capacity(header.sensor_count);
    for index in 0..header.sensor_count {
        let base = header.sensor_offset + index * header.sensor_size;
        let name = if header.version >= 2
            && header.sensor_size >= SENSOR_V2_NAME_OFFSET + SENSOR_V2_NAME_LEN
        {
            fixed_text(bytes, base + SENSOR_V2_NAME_OFFSET, SENSOR_V2_NAME_LEN)
        } else {
            fixed_text(bytes, base + SENSOR_ASCII_NAME_OFFSET, SENSOR_STRING_LEN)
        };
        sensor_names.push(name);
    }

    let mut chips = Vec::new();
    for index in 0..header.reading_count {
        let base = header.reading_offset + index * header.reading_size;
        if read_u32(bytes, base)? != SENSOR_TYPE_TEMPERATURE {
            continue;
        }
        let sensor_index = read_u32(bytes, base + 4)? as usize;
        let Some(sensor_name) = sensor_names.get(sensor_index) else {
            continue;
        };
        let label = if header.version >= 2
            && header.reading_size >= READING_V2_UNIT_OFFSET + UNIT_STRING_LEN
        {
            fixed_text(bytes, base + READING_V2_LABEL_OFFSET, SENSOR_STRING_LEN)
        } else {
            fixed_text(bytes, base + READING_ASCII_LABEL_OFFSET, SENSOR_STRING_LEN)
        };
        let unit = if header.version >= 2
            && header.reading_size >= READING_V2_UNIT_OFFSET + UNIT_STRING_LEN
        {
            fixed_text(bytes, base + READING_V2_UNIT_OFFSET, UNIT_STRING_LEN)
        } else {
            fixed_text(bytes, base + READING_ASCII_UNIT_OFFSET, UNIT_STRING_LEN)
        };
        if !is_nvidia_gpu_sensor(sensor_name)
            || !is_per_chip_vram_label(&label)
            || !is_celsius_unit(&unit)
        {
            continue;
        }

        let value = read_f64(bytes, base + READING_VALUE_OFFSET)?;
        if !(-50.0..=200.0).contains(&value) {
            continue;
        }
        let minimum = read_optional_temperature(bytes, base + READING_VALUE_OFFSET + 8);
        let maximum = read_optional_temperature(bytes, base + READING_VALUE_OFFSET + 16);
        let average = read_optional_temperature(bytes, base + READING_VALUE_OFFSET + 24);
        chips.push(VramChipTemperature {
            channel: extract_channel(&label).unwrap_or(index as u32),
            label,
            temperature_c: value as f32,
            minimum_c: minimum,
            maximum_c: maximum,
            average_c: average,
        });
    }
    chips.sort_by_key(|chip| chip.channel);
    chips.dedup_by_key(|chip| chip.channel);

    Ok(HwinfoVramSnapshot {
        available: header.active && !chips.is_empty(),
        active: header.active,
        source: "HWiNFO per-chip VRAM".into(),
        last_update_unix_s: header.last_update,
        chips,
        error: if header.active {
            String::new()
        } else {
            "HWiNFO shared memory is inactive".into()
        },
    })
}

fn parse_header(bytes: &[u8]) -> Result<Header, String> {
    if bytes.len() < HEADER_SIZE {
        return Err("HWiNFO shared memory header is truncated".into());
    }
    let status = &bytes[0..4];
    if status != b"HWiS" && status != b"DAED" {
        return Err("HWiNFO shared memory signature is invalid".into());
    }
    let header = Header {
        version: read_u32(bytes, 4)?,
        last_update: read_u64(bytes, 12)?,
        sensor_offset: read_u32(bytes, 20)? as usize,
        sensor_size: read_u32(bytes, 24)? as usize,
        sensor_count: read_u32(bytes, 28)? as usize,
        reading_offset: read_u32(bytes, 32)? as usize,
        reading_size: read_u32(bytes, 36)? as usize,
        reading_count: read_u32(bytes, 40)? as usize,
        active: status == b"HWiS",
    };
    if header.sensor_size < SENSOR_ASCII_NAME_OFFSET + SENSOR_STRING_LEN
        || header.reading_size < READING_VALUE_OFFSET + 32
    {
        return Err("Unsupported HWiNFO shared memory layout".into());
    }
    checked_section_end(
        header.sensor_offset,
        header.sensor_size,
        header.sensor_count,
    )?;
    checked_section_end(
        header.reading_offset,
        header.reading_size,
        header.reading_count,
    )?;
    Ok(header)
}

fn checked_section_end(offset: usize, item_size: usize, count: usize) -> Result<usize, String> {
    let size = item_size
        .checked_mul(count)
        .ok_or("HWiNFO shared memory section overflow")?;
    let end = offset
        .checked_add(size)
        .ok_or("HWiNFO shared memory section overflow")?;
    if end > MAX_SHARED_BYTES {
        return Err("HWiNFO shared memory section is unreasonably large".into());
    }
    Ok(end)
}

fn is_nvidia_gpu_sensor(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("nvidia") || normalized.contains("geforce") || normalized.contains("rtx")
}

fn is_per_chip_vram_label(label: &str) -> bool {
    let normalized = label.to_ascii_lowercase();
    let memory =
        normalized.contains("memory") || normalized.contains("vram") || normalized.contains("dram");
    let individual = normalized.contains("chip")
        || normalized.contains("module")
        || normalized.contains("channel")
        || normalized.contains("device")
        || normalized.contains("partition")
        || (normalized.contains("temperature") && extract_channel(label).is_some());
    memory && individual && !normalized.contains("junction")
}

fn is_celsius_unit(unit: &str) -> bool {
    let normalized = unit.trim().to_ascii_lowercase();
    normalized == "c" || normalized == "°c" || normalized.contains("celsius")
}

fn extract_channel(label: &str) -> Option<u32> {
    let mut current = String::new();
    let mut last = None;
    for character in label.chars() {
        if character.is_ascii_digit() {
            current.push(character);
        } else if !current.is_empty() {
            last = current.parse().ok();
            current.clear();
        }
    }
    if !current.is_empty() {
        last = current.parse().ok();
    }
    last
}

fn fixed_text(bytes: &[u8], offset: usize, length: usize) -> String {
    let Some(slice) = bytes.get(offset..offset.saturating_add(length)) else {
        return String::new();
    };
    let end = slice
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..end]).trim().to_string()
}

fn read_optional_temperature(bytes: &[u8], offset: usize) -> Option<f32> {
    read_f64(bytes, offset)
        .ok()
        .filter(|value| value.is_finite() && (-50.0..=200.0).contains(value))
        .map(|value| value as f32)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or("HWiNFO shared memory read exceeded bounds")?
        .try_into()
        .map_err(|_| "HWiNFO shared memory u32 is truncated")?;
    Ok(u32::from_le_bytes(raw))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or("HWiNFO shared memory read exceeded bounds")?
        .try_into()
        .map_err(|_| "HWiNFO shared memory u64 is truncated")?;
    Ok(u64::from_le_bytes(raw))
}

fn read_f64(bytes: &[u8], offset: usize) -> Result<f64, String> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .ok_or("HWiNFO shared memory read exceeded bounds")?
        .try_into()
        .map_err(|_| "HWiNFO shared memory f64 is truncated")?;
    Ok(f64::from_le_bytes(raw))
}

#[cfg(windows)]
mod windows {
    use super::{parse_header, parse_snapshot, HwinfoVramSnapshot, HEADER_SIZE, MAX_SHARED_BYTES};
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const FILE_MAP_READ: u32 = 0x0004;
    const MUTEX_MODIFY_STATE: u32 = 0x0001;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_ABANDONED: u32 = 0x80;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn MapViewOfFile(
            handle: Handle,
            access: u32,
            high: u32,
            low: u32,
            bytes: usize,
        ) -> *mut c_void;
        fn UnmapViewOfFile(address: *const c_void) -> i32;
        fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    struct Mapping {
        handle: Handle,
        view: *mut c_void,
    }

    impl Drop for Mapping {
        fn drop(&mut self) {
            unsafe {
                if !self.view.is_null() {
                    let _ = UnmapViewOfFile(self.view);
                }
                if !self.handle.is_null() {
                    let _ = CloseHandle(self.handle);
                }
            }
        }
    }

    struct MutexGuard(Handle);

    impl Drop for MutexGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) fn read_snapshot() -> Result<HwinfoVramSnapshot, String> {
        let map_name = wide("Global\\HWiNFO_SENS_SM2");
        let mutex_name = wide("Global\\HWiNFO_SM2_MUTEX");
        let mutex = unsafe { OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, 0, mutex_name.as_ptr()) };
        if mutex.is_null() {
            return Err("HWiNFO shared memory is unavailable; start Sensors and enable Shared Memory Support".into());
        }
        let wait = unsafe { WaitForSingleObject(mutex, 200) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            unsafe {
                let _ = CloseHandle(mutex);
            }
            return Err("HWiNFO shared memory lock timed out".into());
        }
        let _guard = MutexGuard(mutex);

        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, map_name.as_ptr()) };
        if handle.is_null() {
            return Err("HWiNFO shared memory mapping is unavailable".into());
        }
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, HEADER_SIZE) };
        if view.is_null() {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err("Unable to map HWiNFO shared memory".into());
        }
        let mut mapping = Mapping { handle, view };
        let header_bytes = unsafe { std::slice::from_raw_parts(mapping.view.cast::<u8>(), 48) };
        let header = parse_header(header_bytes)?;
        let sensor_end = header
            .sensor_size
            .checked_mul(header.sensor_count)
            .and_then(|size| header.sensor_offset.checked_add(size))
            .ok_or("HWiNFO sensor section overflow")?;
        let reading_end = header
            .reading_size
            .checked_mul(header.reading_count)
            .and_then(|size| header.reading_offset.checked_add(size))
            .ok_or("HWiNFO reading section overflow")?;
        let used = sensor_end.max(reading_end);
        if used > MAX_SHARED_BYTES {
            return Err("HWiNFO shared memory layout exceeds safety limit".into());
        }
        unsafe {
            let _ = UnmapViewOfFile(mapping.view);
        }
        mapping.view = unsafe { MapViewOfFile(mapping.handle, FILE_MAP_READ, 0, 0, used) };
        if mapping.view.is_null() {
            return Err("HWiNFO shared memory sections exceed the mapping size".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(mapping.view.cast::<u8>(), used) };
        parse_snapshot(bytes)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENSOR_SIZE: usize = 392;
    const READING_SIZE: usize = 476;

    #[test]
    fn parses_and_orders_exact_vram_channels() {
        let sensor_offset = HEADER_SIZE;
        let reading_offset = sensor_offset + SENSOR_SIZE;
        let mut bytes = vec![0_u8; reading_offset + READING_SIZE * 3];
        bytes[0..4].copy_from_slice(b"HWiS");
        write_u32(&mut bytes, 4, 2);
        write_u64(&mut bytes, 12, 123_456);
        write_u32(&mut bytes, 20, sensor_offset as u32);
        write_u32(&mut bytes, 24, SENSOR_SIZE as u32);
        write_u32(&mut bytes, 28, 1);
        write_u32(&mut bytes, 32, reading_offset as u32);
        write_u32(&mut bytes, 36, READING_SIZE as u32);
        write_u32(&mut bytes, 40, 3);
        write_text(
            &mut bytes,
            sensor_offset + SENSOR_V2_NAME_OFFSET,
            SENSOR_V2_NAME_LEN,
            "NVIDIA GeForce RTX 3050 Ti Laptop GPU",
        );

        write_reading(
            &mut bytes,
            reading_offset,
            "GPU Memory Chip 3 Temperature",
            67.5,
        );
        write_reading(
            &mut bytes,
            reading_offset + READING_SIZE,
            "GPU Memory Junction Temperature",
            82.0,
        );
        write_reading(
            &mut bytes,
            reading_offset + READING_SIZE * 2,
            "GPU Memory Chip 1 Temperature",
            64.0,
        );

        let snapshot = parse_snapshot(&bytes).expect("synthetic snapshot should parse");
        assert!(snapshot.available);
        assert!(snapshot.active);
        assert_eq!(snapshot.last_update_unix_s, 123_456);
        assert_eq!(snapshot.chips.len(), 2);
        assert_eq!(snapshot.chips[0].channel, 1);
        assert_eq!(snapshot.chips[0].temperature_c, 64.0);
        assert_eq!(snapshot.chips[1].channel, 3);
        assert_eq!(snapshot.chips[1].temperature_c, 67.5);
    }

    #[test]
    fn rejects_aggregate_and_non_nvidia_labels() {
        assert!(!is_per_chip_vram_label("GPU Memory Junction Temperature"));
        assert!(!is_per_chip_vram_label("GPU Memory Temperature"));
        assert!(is_per_chip_vram_label("VRAM Channel 2 Temperature"));
        assert!(is_nvidia_gpu_sensor("NVIDIA GeForce RTX 3050 Ti"));
        assert!(!is_nvidia_gpu_sensor("Generic DDR5 DIMM"));
        assert_eq!(extract_channel("GPU [#0] Memory Chip [3]"), Some(3));
        assert_eq!(extract_channel("VRAM module"), None);
    }

    #[test]
    fn rejects_layouts_beyond_the_safety_limit() {
        let mut bytes = vec![0_u8; HEADER_SIZE];
        bytes[0..4].copy_from_slice(b"HWiS");
        write_u32(&mut bytes, 4, 2);
        write_u32(&mut bytes, 20, HEADER_SIZE as u32);
        write_u32(&mut bytes, 24, SENSOR_SIZE as u32);
        write_u32(&mut bytes, 28, (MAX_SHARED_BYTES / SENSOR_SIZE + 1) as u32);
        write_u32(&mut bytes, 32, HEADER_SIZE as u32);
        write_u32(&mut bytes, 36, READING_SIZE as u32);
        write_u32(&mut bytes, 40, 0);
        assert!(parse_header(&bytes).is_err());
    }

    fn write_reading(bytes: &mut [u8], base: usize, label: &str, value: f64) {
        write_u32(bytes, base, SENSOR_TYPE_TEMPERATURE);
        write_u32(bytes, base + 4, 0);
        write_text(
            bytes,
            base + READING_V2_LABEL_OFFSET,
            SENSOR_STRING_LEN,
            label,
        );
        write_text(bytes, base + READING_V2_UNIT_OFFSET, UNIT_STRING_LEN, "C");
        bytes[base + READING_VALUE_OFFSET..base + READING_VALUE_OFFSET + 8]
            .copy_from_slice(&value.to_le_bytes());
        for (offset, sample) in [(8, value - 2.0), (16, value + 2.0), (24, value)] {
            bytes[base + READING_VALUE_OFFSET + offset..base + READING_VALUE_OFFSET + offset + 8]
                .copy_from_slice(&sample.to_le_bytes());
        }
    }

    fn write_text(bytes: &mut [u8], offset: usize, length: usize, value: &str) {
        let source = value.as_bytes();
        let count = source.len().min(length.saturating_sub(1));
        bytes[offset..offset + count].copy_from_slice(&source[..count]);
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
}
