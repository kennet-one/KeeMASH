# KeeMASH

KeeMASH is a Windows command center for the KeeMASH mesh network. The modern application lives in [`desktop/`](desktop/) and uses a React interface with a Tauri 2 / Rust backend.

## Features

- serial bridge at 115200 baud with bounded line parsing and native COM discovery;
- legacy KeeMASH command controls and reply parsing;
- independent `Main` and `Monitor` views;
- live weather and air-quality data from Open-Meteo;
- CPU, RAM, NVIDIA GPU and VRAM telemetry;
- elevated read-only CPU, GPU hotspot, clock, and physical DIMM sensor telemetry;
- per-module RAM inventory with temperatures when the DIMM exposes a thermal sensor;
- explicit unavailable states for unsupported CPU, VRAM, and DIMM temperature sensors;
- real NVIDIA PCIe RX/TX throughput, active Gen x width and estimated link load;
- an immersive `Enjoy` view that opens the local KenULTRABIOS firmware/RAM knowledge graph;
- a compact Windows NSIS installer;
- a SHA256-verified local update channel with an animated in-app install indicator.
- complete offline English and Ukrainian interface catalogs with persistent `EN`, `UA`, and stacked bilingual `BOTH` modes;
- curated Ukrainian explanations for important BIOS, RAM, mesh, telemetry, and updater terms.

## Localization

English is the canonical source language and the default for new installations. The top-bar language control changes the full managed interface immediately and stores the selected mode locally. `BOTH` keeps English primary and shows a smaller Ukrainian line underneath.

Protocol commands, units, hardware identifiers, IFR labels, `QuestionId`, `VarStore`, offsets, GUIDs, and raw backend diagnostics remain canonical technical data. The small help icon beside curated terms opens a Ukrainian explanation; unknown IFR entries are explicitly marked as not yet verified.

## Enjoy Mode / KenULTRABIOS Brain

`Enjoy` is the introspection surface of the same KeeMASH application, alongside `Main` and `Monitor`. It loads the local sanitized catalog from:

```text
%USERPROFILE%\Desktop\grafs\KenULTRABIOS-Brain\.kenultra\mash-bridge.json
```

The Tauri reader rejects catalogs unless they explicitly declare `read-only-simulation`, `firmwareWrite=false`, `rawFirmwareIncluded=false`, and `privateInventoryIncluded=false`. Enjoy Mode can search, focus, explain relationships, and preview direct What-if effects. It has no BIOS, NVRAM, SPD, flash, shell, or network write interface.

The source is licensed under Apache License 2.0, matching the Node0 repository.

## Prerequisites

- Node.js LTS;
- Rust stable through `rustup`;
- Microsoft Visual Studio 2022 Build Tools with the `VCTools` workload and a Windows SDK;
- Microsoft Edge WebView2 Runtime (included with current Windows 11 installations).

The repository helper discovers Visual Studio through `vswhere` and activates the correct MSVC environment automatically.

## Development

```powershell
cd desktop
npm install
npm run build
npm run dev
```

`npm run build` runs TypeScript type checking, Vitest, Vite production compilation, `cargo fmt --check`, Clippy with warnings denied, and Rust unit tests.

## Elevated hardware telemetry

Release builds request Windows administrator privileges at startup. KeeMASH uses a small read-only sensor host built against LibreHardwareMonitor v0.9.6 and can use the PawnIO driver for low-level hardware access. It does not expose fan, voltage, clock, or other hardware controls.

PawnIO installation is an explicit machine setup step; KeeMASH never installs a kernel driver silently at application startup. The verified official installer and its provenance are stored under `desktop/src-tauri/vendor/librehardwaremonitor/` for reproducible packaging.

Sensor availability depends on the motherboard, firmware, processor, GPU, and memory modules:

- CPU package and hottest-core values are shown when the processor interface exposes them;
- NVIDIA GPU core, hotspot, graphics clock, and memory clock are combined with `nvidia-smi` telemetry;
- VRAM temperature is shown only on GPUs that report it;
- each physical RAM module is listed, while temperature remains `?` when that DIMM has no exposed thermal sensor.

Unavailable values are never inferred from unrelated sensors.

## Windows package

```powershell
cd desktop
npm run package:win
```

The installer is written under `desktop/src-tauri/target/release/bundle/nsis/`.

## Local release and self-update

```powershell
cd desktop
npm run release:local
```

This command runs the complete validation suite, builds the NSIS installer, copies a convenient release artifact under ignored `desktop/release/`, and publishes the installer plus `latest.json` under `%LOCALAPPDATA%\KeeMASH\updates`.

KeeMASH checks that local channel at startup, every minute, and when the window becomes visible. A pulsing package icon appears in the top bar when a newer semantic version is available. Installation remains user-triggered: the Rust backend restricts the manifest to a relative `.exe` path inside the update root, verifies file size and SHA256, launches the trusted NSIS installer silently with `/S`, and exits the running app.

Version `0.2.0` is the one-time bootstrap release for this updater. Install its generated `.exe` manually; later locally published versions can be installed from the in-app update icon.

## PCIe telemetry

KeeMASH reads NVIDIA GPU counters through `nvidia-smi`. PCIe RX/TX comes from `nvidia-smi dmon`; link load is calculated against the currently active PCIe generation and width. On systems without supported NVIDIA telemetry, the monitor reports the source as unavailable instead of inventing a value.
