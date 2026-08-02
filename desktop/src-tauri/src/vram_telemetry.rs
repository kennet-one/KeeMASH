use serde::Serialize;

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
pub struct VramProviderStatus {
    pub id: String,
    pub label: String,
    pub state: String,
    pub active: bool,
    pub exact_channel_count: usize,
    pub candidate_count: usize,
    pub last_update_unix_s: u64,
    pub detail: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ProviderSnapshot {
    pub id: String,
    pub label: String,
    pub active: bool,
    pub last_update_unix_s: u64,
    pub chips: Vec<VramChipTemperature>,
    pub candidate_count: usize,
    pub error: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VramTelemetrySnapshot {
    pub available: bool,
    pub experimental_supported: bool,
    pub source: String,
    pub last_update_unix_s: u64,
    pub chips: Vec<VramChipTemperature>,
    pub providers: Vec<VramProviderStatus>,
    pub error: String,
}

pub fn read_vram_chip_temperatures(gpu_name: &str) -> VramTelemetrySnapshot {
    let snapshots = vec![
        crate::afterburner_shared::read_provider(),
        crate::hwinfo_shared::read_provider(),
    ];
    choose_snapshot(gpu_name, snapshots)
}

fn choose_snapshot(gpu_name: &str, snapshots: Vec<ProviderSnapshot>) -> VramTelemetrySnapshot {
    let selected = snapshots
        .iter()
        .filter(|snapshot| snapshot.active && !snapshot.chips.is_empty())
        .max_by_key(|snapshot| (snapshot.chips.len(), snapshot.last_update_unix_s));
    let providers = snapshots.iter().map(provider_status).collect::<Vec<_>>();
    let experimental_supported = is_mobile_nvidia_rtx(gpu_name);

    if let Some(selected) = selected {
        return VramTelemetrySnapshot {
            available: true,
            experimental_supported,
            source: selected.label.clone(),
            last_update_unix_s: selected.last_update_unix_s,
            chips: selected.chips.clone(),
            providers,
            error: String::new(),
        };
    }

    let errors = snapshots
        .iter()
        .map(|snapshot| {
            let detail = if snapshot.error.is_empty() {
                "no exact physical channels".to_string()
            } else {
                snapshot.error.clone()
            };
            format!("{}: {detail}", snapshot.label)
        })
        .collect::<Vec<_>>()
        .join("; ");
    VramTelemetrySnapshot {
        experimental_supported,
        source: "Experimental per-chip providers".into(),
        providers,
        error: errors,
        ..Default::default()
    }
}

fn provider_status(snapshot: &ProviderSnapshot) -> VramProviderStatus {
    let state = if !snapshot.error.is_empty() && !snapshot.active {
        "unavailable"
    } else if !snapshot.error.is_empty() {
        "error"
    } else if snapshot.chips.is_empty() {
        "no-exact-channels"
    } else {
        "live"
    };
    VramProviderStatus {
        id: snapshot.id.clone(),
        label: snapshot.label.clone(),
        state: state.into(),
        active: snapshot.active,
        exact_channel_count: snapshot.chips.len(),
        candidate_count: snapshot.candidate_count,
        last_update_unix_s: snapshot.last_update_unix_s,
        detail: if snapshot.error.is_empty() {
            match state {
                "live" => format!("{} exact physical channels", snapshot.chips.len()),
                _ => format!(
                    "{} temperature candidates, none identified as physical channels",
                    snapshot.candidate_count
                ),
            }
        } else {
            snapshot.error.clone()
        },
    }
}

pub(crate) fn is_nvidia_gpu_sensor(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("nvidia") || normalized.contains("geforce") || normalized.contains("rtx")
}

pub(crate) fn classify_vram_channel(label: &str) -> Option<u32> {
    let normalized = label.to_ascii_lowercase();
    let aggregate = [
        "junction", "hot spot", "hotspot", "average", "hottest", "maximum", "overall",
    ]
    .iter()
    .any(|token| normalized.contains(token));
    if !is_vram_temperature_candidate(label) || aggregate {
        return None;
    }

    for token in ["chip", "module", "channel", "partition", "device", " ic"] {
        if let Some(position) = normalized.find(token) {
            if let Some(channel) = first_number(&normalized[position + token.len()..]) {
                return Some(channel);
            }
        }
    }
    bracket_number(&normalized).or_else(|| trailing_number(&normalized))
}

pub(crate) fn is_vram_temperature_candidate(label: &str) -> bool {
    let normalized = label.to_ascii_lowercase();
    let is_memory = normalized.contains("memory")
        || normalized.contains("vram")
        || normalized.contains("dram")
        || normalized.contains("gddr");
    let is_temperature = normalized.contains("temperature")
        || normalized.contains("thermal")
        || normalized.contains(" temp");
    is_memory && is_temperature
}

pub(crate) fn is_celsius_unit(unit: &str) -> bool {
    let normalized = unit.trim().to_ascii_lowercase();
    normalized == "c" || normalized == "°c" || normalized.contains("celsius")
}

fn is_mobile_nvidia_rtx(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    (normalized.contains("nvidia") || normalized.contains("geforce"))
        && normalized.contains("rtx")
        && (normalized.contains("laptop") || normalized.contains("mobile"))
}

fn first_number(value: &str) -> Option<u32> {
    let start = value.find(|character: char| character.is_ascii_digit())?;
    let digits = value[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

fn bracket_number(value: &str) -> Option<u32> {
    let close = value.rfind(']')?;
    let open = value[..close].rfind('[')?;
    value[open + 1..close].trim().parse().ok()
}

fn trailing_number(value: &str) -> Option<u32> {
    let trimmed = value.trim_end();
    let end = trimmed.len();
    let start = trimmed
        .char_indices()
        .rev()
        .take_while(|(_, character)| character.is_ascii_digit())
        .map(|(index, _)| index)
        .last()?;
    trimmed[start..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_numbered_physical_memory_channels() {
        assert_eq!(
            classify_vram_channel("GPU Memory Chip 3 Temperature"),
            Some(3)
        );
        assert_eq!(classify_vram_channel("GPU1 memory temperature 2"), Some(2));
        assert_eq!(classify_vram_channel("VRAM Temperature [0]"), Some(0));
        assert_eq!(classify_vram_channel("DRAM module #4 thermal"), Some(4));
        assert_eq!(classify_vram_channel("GPU1 memory temperature"), None);
        assert_eq!(
            classify_vram_channel("GPU Memory Junction Temperature"),
            None
        );
        assert_eq!(classify_vram_channel("GPU Memory Hotspot"), None);
    }

    #[test]
    fn chooses_live_provider_with_the_most_exact_channels() {
        let chip = |channel| VramChipTemperature {
            channel,
            label: format!("Memory chip {channel} temperature"),
            temperature_c: 60.0 + channel as f32,
            ..Default::default()
        };
        let result = choose_snapshot(
            "NVIDIA GeForce RTX 3050 Ti Laptop GPU",
            vec![
                ProviderSnapshot {
                    id: "a".into(),
                    label: "Provider A".into(),
                    active: true,
                    chips: vec![chip(0)],
                    ..Default::default()
                },
                ProviderSnapshot {
                    id: "b".into(),
                    label: "Provider B".into(),
                    active: true,
                    chips: vec![chip(0), chip(1)],
                    ..Default::default()
                },
            ],
        );
        assert!(result.available);
        assert!(result.experimental_supported);
        assert_eq!(result.source, "Provider B");
        assert_eq!(result.chips.len(), 2);
        assert_eq!(result.providers.len(), 2);
    }
}
