# LibreHardwareMonitor Runtime

KeeMASH bundles the x64 runtime libraries from LibreHardwareMonitor v0.9.6 and its embedded PawnIO installer for read-only hardware telemetry.

- Project: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
- Release: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/tag/v0.9.6
- Source commit: `3d331e3370efb858411f19511373eff65a218701`
- Official release archive SHA-256: `086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001`
- Bundled PawnIO installer SHA-256: `a3a46226c5e2824f4cdd42be0eecbabfc672c86f7889710f5ab1e6ad385b47a0`
- License: MPL-2.0; see `LICENSE` and `THIRD-PARTY-NOTICES.txt` in this directory.

KeeMASH enables only CPU, memory, and GPU sensor reads. It does not expose LibreHardwareMonitor fan, voltage, clock, or other hardware control operations.
