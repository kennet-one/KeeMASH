# KeeMASH

KeeMASH is a Windows command center for the KeeMASH mesh network. The modern application lives in [`desktop/`](desktop/) and uses a React interface with a Tauri 2 / Rust backend.

## Features

- serial bridge at 115200 baud with bounded line parsing and native COM discovery;
- legacy KeeMASH command controls and reply parsing;
- independent `Main` and `Monitor` views;
- live weather and air-quality data from Open-Meteo;
- CPU, RAM, NVIDIA GPU and VRAM telemetry;
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

## Windows package

```powershell
cd desktop
npm run package:win
```

The installer is written under `desktop/src-tauri/target/release/bundle/nsis/`.

## PCIe telemetry

KeeMASH reads NVIDIA GPU counters through `nvidia-smi`. PCIe RX/TX comes from `nvidia-smi dmon`; link load is calculated against the currently active PCIe generation and width. On systems without supported NVIDIA telemetry, the monitor reports the source as unavailable instead of inventing a value.
