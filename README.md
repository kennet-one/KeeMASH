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
- a compact Windows NSIS installer.

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

## PCIe telemetry

KeeMASH reads NVIDIA GPU counters through `nvidia-smi`. PCIe RX/TX comes from `nvidia-smi dmon`; link load is calculated against the currently active PCIe generation and width. On systems without supported NVIDIA telemetry, the monitor reports the source as unavailable instead of inventing a value.
