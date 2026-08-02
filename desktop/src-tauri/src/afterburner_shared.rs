use crate::vram_telemetry::{
    classify_vram_channel, is_celsius_unit, is_vram_temperature_candidate, ProviderSnapshot,
    VramChipTemperature,
};

const HEADER_SIZE: usize = 32;
const MAX_SHARED_BYTES: usize = 8_000_000;
const STRING_LEN: usize = 260;
const SOURCE_NAME_OFFSET: usize = 0;
const SOURCE_UNIT_OFFSET: usize = 260;
const LOCALIZED_NAME_OFFSET: usize = 520;
const LOCALIZED_UNIT_OFFSET: usize = 780;
const DATA_OFFSET: usize = 1300;
const MINIMUM_OFFSET: usize = 1304;
const MAXIMUM_OFFSET: usize = 1308;
const MINIMUM_ENTRY_SIZE: usize = 1324;

#[derive(Clone, Copy, Debug)]
struct Header {
    header_size: usize,
    entry_count: usize,
    entry_size: usize,
    last_update_unix_s: u64,
}

pub(crate) fn read_provider() -> ProviderSnapshot {
    #[cfg(windows)]
    {
        windows::read_snapshot().unwrap_or_else(unavailable)
    }

    #[cfg(not(windows))]
    unavailable("MSI Afterburner shared memory is available only on Windows".into())
}

fn unavailable(error: String) -> ProviderSnapshot {
    ProviderSnapshot {
        id: "afterburner-hotspot".into(),
        label: "MSI Afterburner / Hotspot plugin".into(),
        error,
        ..Default::default()
    }
}

fn parse_snapshot(bytes: &[u8]) -> Result<ProviderSnapshot, String> {
    let header = parse_header(bytes)?;
    let used = header
        .entry_size
        .checked_mul(header.entry_count)
        .and_then(|size| header.header_size.checked_add(size))
        .ok_or("MSI Afterburner shared memory section overflow")?;
    if used > bytes.len() {
        return Err("MSI Afterburner shared memory layout exceeds mapped data".into());
    }

    let mut chips = Vec::new();
    let mut candidate_count = 0;
    for index in 0..header.entry_count {
        let base = header.header_size + index * header.entry_size;
        let original_name = fixed_text(bytes, base + SOURCE_NAME_OFFSET, STRING_LEN);
        let localized_name = fixed_text(bytes, base + LOCALIZED_NAME_OFFSET, STRING_LEN);
        let original_unit = fixed_text(bytes, base + SOURCE_UNIT_OFFSET, STRING_LEN);
        let localized_unit = fixed_text(bytes, base + LOCALIZED_UNIT_OFFSET, STRING_LEN);
        let is_temperature = is_celsius_unit(&original_unit) || is_celsius_unit(&localized_unit);
        if !is_temperature {
            continue;
        }
        if is_vram_temperature_candidate(&original_name)
            || is_vram_temperature_candidate(&localized_name)
        {
            candidate_count += 1;
        }
        let identity = classify_vram_channel(&original_name)
            .map(|channel| (channel, original_name.clone()))
            .or_else(|| {
                classify_vram_channel(&localized_name)
                    .map(|channel| (channel, localized_name.clone()))
            });
        let Some((channel, label)) = identity else {
            continue;
        };
        let value = read_f32(bytes, base + DATA_OFFSET)?;
        if !valid_temperature(value) {
            continue;
        }
        chips.push(VramChipTemperature {
            channel,
            label,
            temperature_c: value,
            minimum_c: read_optional_temperature(bytes, base + MINIMUM_OFFSET),
            maximum_c: read_optional_temperature(bytes, base + MAXIMUM_OFFSET),
            average_c: None,
        });
    }
    chips.sort_by_key(|chip| chip.channel);
    chips.dedup_by_key(|chip| chip.channel);

    Ok(ProviderSnapshot {
        id: "afterburner-hotspot".into(),
        label: "MSI Afterburner / Hotspot plugin".into(),
        active: true,
        last_update_unix_s: header.last_update_unix_s,
        chips,
        candidate_count,
        error: String::new(),
    })
}

fn parse_header(bytes: &[u8]) -> Result<Header, String> {
    if bytes.len() < HEADER_SIZE {
        return Err("MSI Afterburner shared memory header is truncated".into());
    }
    if &bytes[0..4] != b"MAHM" {
        return Err("MSI Afterburner shared memory signature is invalid".into());
    }
    let version = read_u32(bytes, 4)?;
    let header = Header {
        header_size: read_u32(bytes, 8)? as usize,
        entry_count: read_u32(bytes, 12)? as usize,
        entry_size: read_u32(bytes, 16)? as usize,
        last_update_unix_s: read_u32(bytes, 20)? as u64,
    };
    if version < 0x0002_0000 {
        return Err("MSI Afterburner shared memory v2 is required".into());
    }
    if !(HEADER_SIZE..=256).contains(&header.header_size)
        || !(MINIMUM_ENTRY_SIZE..=4096).contains(&header.entry_size)
        || header.entry_count > 2048
    {
        return Err("Unsupported MSI Afterburner shared memory layout".into());
    }
    let used = header
        .entry_size
        .checked_mul(header.entry_count)
        .and_then(|size| header.header_size.checked_add(size))
        .ok_or("MSI Afterburner shared memory section overflow")?;
    if used > MAX_SHARED_BYTES {
        return Err("MSI Afterburner shared memory section is unreasonably large".into());
    }
    Ok(header)
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

fn valid_temperature(value: f32) -> bool {
    value.is_finite() && (-50.0..=200.0).contains(&value)
}

fn read_optional_temperature(bytes: &[u8], offset: usize) -> Option<f32> {
    read_f32(bytes, offset)
        .ok()
        .filter(|value| valid_temperature(*value))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or("MSI Afterburner shared memory u32 is truncated")?
        .try_into()
        .map_err(|_| "MSI Afterburner shared memory u32 is truncated")?;
    Ok(u32::from_le_bytes(raw))
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, String> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or("MSI Afterburner shared memory f32 is truncated")?
        .try_into()
        .map_err(|_| "MSI Afterburner shared memory f32 is truncated")?;
    Ok(f32::from_le_bytes(raw))
}

#[cfg(windows)]
mod windows {
    use super::{parse_header, parse_snapshot, ProviderSnapshot, HEADER_SIZE, MAX_SHARED_BYTES};
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const FILE_MAP_READ: u32 = 0x0004;

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

    pub(super) fn read_snapshot() -> Result<ProviderSnapshot, String> {
        let mut last_error = "MSI Afterburner shared memory is unavailable".to_string();
        for name in [
            "Global\\MAHMSharedMemory",
            "MAHMSharedMemory",
            "Local\\MAHMSharedMemory",
        ] {
            match read_mapping(name) {
                Ok(snapshot) => return Ok(snapshot),
                Err(error) if !error.contains("unavailable") => last_error = error,
                Err(_) => {}
            }
        }
        Err(last_error)
    }

    fn read_mapping(name: &str) -> Result<ProviderSnapshot, String> {
        let wide = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err("MSI Afterburner shared memory is unavailable".into());
        }
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, HEADER_SIZE) };
        if view.is_null() {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err("Unable to map MSI Afterburner shared memory".into());
        }
        let mut mapping = Mapping { handle, view };
        let header_bytes =
            unsafe { std::slice::from_raw_parts(mapping.view.cast::<u8>(), HEADER_SIZE) };
        let header = parse_header(header_bytes)?;
        let used = header
            .entry_size
            .checked_mul(header.entry_count)
            .and_then(|size| header.header_size.checked_add(size))
            .ok_or("MSI Afterburner shared memory section overflow")?;
        if used > MAX_SHARED_BYTES {
            return Err("MSI Afterburner shared memory layout exceeds safety limit".into());
        }
        unsafe {
            let _ = UnmapViewOfFile(mapping.view);
        }
        mapping.view = unsafe { MapViewOfFile(mapping.handle, FILE_MAP_READ, 0, 0, used) };
        if mapping.view.is_null() {
            return Err("MSI Afterburner shared memory sections exceed the mapping size".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(mapping.view.cast::<u8>(), used) };
        parse_snapshot(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY_SIZE: usize = 1324;

    #[test]
    fn parses_hotspot_plugin_physical_channels_only() {
        let mut bytes = vec![0_u8; HEADER_SIZE + ENTRY_SIZE * 4];
        bytes[0..4].copy_from_slice(b"MAHM");
        write_u32(&mut bytes, 4, 0x0002_0000);
        write_u32(&mut bytes, 8, HEADER_SIZE as u32);
        write_u32(&mut bytes, 12, 4);
        write_u32(&mut bytes, 16, ENTRY_SIZE as u32);
        write_u32(&mut bytes, 20, 123_456);
        write_entry(&mut bytes, 0, "GPU1 memory temperature 0", "C", 61.0);
        write_entry(&mut bytes, 1, "GPU1 memory temperature 1", "C", 64.5);
        write_entry(&mut bytes, 2, "GPU1 memory junction temperature", "C", 76.0);
        write_entry(&mut bytes, 3, "GPU1 usage", "%", 50.0);

        let snapshot = parse_snapshot(&bytes).expect("synthetic MAHM snapshot should parse");
        assert!(snapshot.active);
        assert_eq!(snapshot.candidate_count, 3);
        assert_eq!(snapshot.chips.len(), 2);
        assert_eq!(snapshot.chips[0].channel, 0);
        assert_eq!(snapshot.chips[1].temperature_c, 64.5);
    }

    #[test]
    fn rejects_malformed_or_oversized_layouts() {
        let mut bytes = vec![0_u8; HEADER_SIZE];
        bytes[0..4].copy_from_slice(b"MAHM");
        write_u32(&mut bytes, 4, 0x0002_0000);
        write_u32(&mut bytes, 8, HEADER_SIZE as u32);
        write_u32(&mut bytes, 12, 10_000);
        write_u32(&mut bytes, 16, ENTRY_SIZE as u32);
        assert!(parse_header(&bytes).is_err());
    }

    fn write_entry(bytes: &mut [u8], index: usize, name: &str, unit: &str, value: f32) {
        let base = HEADER_SIZE + index * ENTRY_SIZE;
        write_text(bytes, base + SOURCE_NAME_OFFSET, STRING_LEN, name);
        write_text(bytes, base + SOURCE_UNIT_OFFSET, STRING_LEN, unit);
        bytes[base + DATA_OFFSET..base + DATA_OFFSET + 4].copy_from_slice(&value.to_le_bytes());
        bytes[base + MINIMUM_OFFSET..base + MINIMUM_OFFSET + 4]
            .copy_from_slice(&(value - 2.0).to_le_bytes());
        bytes[base + MAXIMUM_OFFSET..base + MAXIMUM_OFFSET + 4]
            .copy_from_slice(&(value + 2.0).to_le_bytes());
    }

    fn write_text(bytes: &mut [u8], offset: usize, length: usize, value: &str) {
        let source = value.as_bytes();
        let count = source.len().min(length.saturating_sub(1));
        bytes[offset..offset + count].copy_from_slice(&source[..count]);
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
}
