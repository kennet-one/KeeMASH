# KeeMASH

KeeMASH is a Windows command center for the KeeMASH mesh network. The modern application lives in [`desktop/`](desktop/) and uses a React interface with a Tauri 2 / Rust backend.

## Features

- serial bridge at 115200 baud with bounded line parsing and native COM discovery;
- startup auto-connect restricted to an available saved port or COM4, with
  resilient Windows Bluetooth SPP timeout handling;
- legacy KeeMASH command controls and reply parsing;
- adaptive `Home`, `Main`, `Monitor`, and `Enjoy` workspaces with persistent expanded, rail, hidden, and immersive chrome modes;
- content-sized, hideable, pinnable widgets with edit-only resizing, interruptible focus expansion, visible Undo, and persisted layouts;
- a four-edge draggable control drop that restores chrome and opens the widget catalog from its docked edge;
- `Full`, `Calm`, and `Off` motion profiles with fast, interruptible interaction feedback;
- a Rust-owned first-party runtime with transactional revisioned profiles, explicit app-command capabilities, bounded history, background scheduling, and automatic profile migration;
- live weather and air-quality data from Open-Meteo;
- a 30-second serial weather lease that publishes today's maximum rain chance
  to `esp_mixer` and clears it on orderly disconnect or exit;
- CPU, RAM, NVIDIA GPU and VRAM telemetry;
- a Rust-owned master GPU selector with stable DXGI adapter LUIDs, persisted Windows graphics preference, restart-safe switching, and requested/native/WebView2 diagnostics;
- elevated read-only CPU, GPU hotspot, clock, and physical DIMM sensor telemetry;
- per-module RAM inventory with temperatures when the DIMM exposes a thermal sensor;
- explicit unavailable states for unsupported CPU, VRAM, and DIMM temperature sensors;
- real NVIDIA PCIe RX/TX throughput, active Gen x width and estimated link load;
- an immersive `Enjoy` module that combines the local KenULTRABIOS knowledge graph with trusted KeeMASH capabilities;
- a per-machine Windows NSIS installer with controlled migration from the legacy per-user install;
- an Ed25519-signed GitHub Releases update channel with a verified local cache, protected staging, SHA-256 verification, and an animated in-app install indicator;
- complete offline English and Ukrainian interface catalogs with persistent `EN` and `UA` modes;
- curated Ukrainian explanations for important BIOS, RAM, mesh, telemetry, and updater terms.

## Localization

English is the canonical source language and the default for new installations. The compact `EN | UA` top-bar control changes the full managed interface immediately and stores the selected language locally. Legacy `BOTH` preferences migrate safely to `EN`.

Protocol commands, units, hardware identifiers, IFR labels, `QuestionId`, `VarStore`, offsets, GUIDs, and raw backend diagnostics remain canonical technical data. The small help icon beside curated terms opens a Ukrainian explanation; unknown IFR entries are explicitly marked as not yet verified.

## Enjoy Mode / KenULTRABIOS Brain

`Enjoy` is the introspection surface of the same KeeMASH application, alongside `Main` and `Monitor`. It loads the local sanitized catalog from:

```text
%USERPROFILE%\Desktop\grafs\KenULTRABIOS-Brain\.kenultra\mash-bridge.json
```

The imported catalog remains a sanitized simulation data source: the Tauri reader rejects it unless it explicitly declares `read-only-simulation`, `firmwareWrite=false`, `rawFirmwareIncluded=false`, and `privateInventoryIncluded=false`. That rule protects the catalog boundary; it does not reduce the `Enjoy` runtime to a read-only guest. `Enjoy` is a trusted first-party KeeMASH module with visible, revocable capabilities for serial commands, resource telemetry, low-level hardware workflows, firmware management, updates, network access, and background work. Destructive workflows still require their own validation and confirmation at the service boundary.

The module manager currently loads only built-in manifests compiled with KeeMASH. It does not execute arbitrary third-party packages. Module enablement, capabilities, workspace layouts, widget visibility, chrome state, motion profile, and keep-alive state are persisted by Rust through the Tauri store. The WebView has no direct Store permission.

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

`npm run audit` runs `npm audit` and RustSec `cargo audit`. Both audits are mandatory in `npm run release:local`.

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

The per-machine installer is written under `desktop/src-tauri/target/release/bundle/nsis/` and installs KeeMASH under `Program Files`. Its preinstall hook removes only the exact legacy `%LOCALAPPDATA%\KeeMASH\uninstall.exe` installation; the Rust workspace profile under `%APPDATA%\one.kennet.keemash` is preserved.

## Signed release and self-update

```powershell
cd desktop
npm run release:local
```

This command runs dependency audits and the complete validation suite, builds and integrity-checks the NSIS installer, copies a convenient release artifact under ignored `desktop/release/`, and publishes the installer plus a signed `latest.json` under `%LOCALAPPDATA%\KeeMASH\updates`.

After the source commit is pushed, publish the same signed artifacts to the stable GitHub channel:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\scripts\publish-github-release.ps1 -Apply
```

KeeMASH checks `https://github.com/kennet-one/KeeMASH/releases/latest/download/latest.json` at startup and every minute through a Rust background scheduler that does not depend on the top bar being mounted. A valid newer release is downloaded into an atomically published local cache; when GitHub is temporarily unavailable, the last valid signed cache remains usable. The update panel always shows the installed version and the available version or `Current`. Installation remains user-triggered and requires a Rust-owned native confirmation. Manifest v2 signs schema, version, timestamp, relative installer path, SHA-256, size, and channel with Ed25519; the private signing key lives outside the repository. The helper receives only a one-time request ID, claims it atomically, verifies the real parent through one process handle, stages the installer under administrator-only `%PROGRAMDATA%\KeeMASH\updates`, revalidates the exact staged path and signature, and launches only that verified copy.

## Runtime security boundary

Tauri app commands are declared through `AppManifest::commands` and explicit window capabilities. Normal and administrative runtime dispatch are separate; standard dispatch rejects process control, GPU policy changes, CCC lifecycle, update installation, memory-test control, and system power operations. Sensitive capability grants cannot be issued by renderer state, and destructive actions use Rust-owned native confirmations with verified process/update identity.

KeeMASH remains an always-administrator application by design. These controls reduce the exposed IPC surface but do not make a compromised elevated WebView equivalent to a separate low-privilege broker. Production therefore hides D3D attach, eviction, and per-resource residency controls until the authenticated bundled agent is ready; process-level PDH telemetry and verified scheduling/RAM priority controls remain available.

Version `0.3.1` fixes the original `0.2.0` exit-time stack overflow. Moving from `0.2.0` to `0.3.1` requires one manual installer run; later locally published versions use the detached helper from the in-app update icon.

Version `0.3.2` removes the stacked bilingual mode and keeps the interface focused on two complete language choices: `EN` or `UA`.

Version `0.4.0` introduces the modular super-app shell, persisted widget workspaces, explicit module capabilities, background widget lifecycles, adaptive compact navigation, and a console-free Windows startup handshake.

Version `0.7.0` adds graph-driven Lighting and Climate domains, expandable node topology, clearer mesh ownership and resilient environmental telemetry refresh. Version `0.6.0` added a RAM overclocking workbench with physical DIMM inventory, SPD profiles, active Intel IMC timings through a read-only AIDA64 provider, WHEA history, and a built-in open-source multithreaded memory stability test. Version `0.5.1` added adaptive telemetry, honest RAM-bus/IMC history, and restart-to-UEFI support; the `0.5.0` foundation moved persistence, permissions, lifecycle, command routing, bounded logs, and telemetry history into Rust while keeping React as the visual engine.

Version `0.10.0` hardens the elevated runtime: transactional profile and GPU policy persistence, exact 100-nanosecond process identities verified on an open handle, bounded sensor IPC with restart backoff, native CCC inspection/control, coalesced telemetry polling, signed updates with locked protected staging, per-machine installation, dependency audits, and responsive layouts down to `720x520`. It also introduces global master GPU selection: KeeMASH-owned native workloads resolve the saved DXGI LUID, while WebView2 receives the corresponding documented Windows minimum-power or high-performance preference and is verified through process-tree telemetry after restart. Privileged operations use fixed Tauri commands with individual manifest permissions; the renderer cannot select an arbitrary administrative operation through a generic dispatcher. Release publication also verifies that the external signing key matches the public key embedded in KeeMASH.

## PCIe telemetry

KeeMASH reads NVIDIA GPU counters through `nvidia-smi`. PCIe RX/TX comes from `nvidia-smi dmon`; link load is calculated against the currently active PCIe generation and width. On systems without supported NVIDIA telemetry, the monitor reports the source as unavailable instead of inventing a value.
