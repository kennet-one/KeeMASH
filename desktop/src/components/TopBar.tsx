import { Activity, BrainCircuit, Cpu, Radio, SlidersHorizontal } from "lucide-react";
import type { LocalUpdateStatus, SerialStatus } from "../types";
import { UpdateControl } from "./UpdateControl";

interface ViewSwitchProps {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: "main" | "monitor" | "enjoy";
}

function ViewSwitch({ label, active, onClick, icon }: ViewSwitchProps) {
  const Icon = icon === "main" ? SlidersHorizontal : icon === "monitor" ? Cpu : BrainCircuit;
  return (
    <button
      className={`view-switch${active ? " is-active" : ""}`}
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      title={`${active ? "Hide" : "Show"} ${label.toLowerCase()}`}
    >
      <Icon size={17} strokeWidth={2} />
      <span>{label}</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

interface TopBarProps {
  showMain: boolean;
  showMonitor: boolean;
  showEnjoy: boolean;
  serialStatus: SerialStatus;
  bridgeOnline: boolean;
  updateStatus: LocalUpdateStatus | null;
  updateBusy: boolean;
  updateError: string | null;
  onToggleMain: () => void;
  onToggleMonitor: () => void;
  onToggleEnjoy: () => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

export function TopBar({
  showMain,
  showMonitor,
  showEnjoy,
  serialStatus,
  bridgeOnline,
  updateStatus,
  updateBusy,
  updateError,
  onToggleMain,
  onToggleMonitor,
  onToggleEnjoy,
  onCheckUpdate,
  onInstallUpdate,
}: TopBarProps) {
  const linkState = serialStatus.connected ? (bridgeOnline ? "online" : "serial") : "offline";
  return (
    <header className="top-bar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          <Activity size={22} strokeWidth={2.2} />
        </span>
        <div>
          <div className="brand-name">KeeMASH</div>
          <div className="brand-context">Mesh command center</div>
        </div>
      </div>

      <div className="top-actions">
        <ViewSwitch label="Main" active={showMain} onClick={onToggleMain} icon="main" />
        <ViewSwitch label="Monitor" active={showMonitor} onClick={onToggleMonitor} icon="monitor" />
        <ViewSwitch label="Enjoy" active={showEnjoy} onClick={onToggleEnjoy} icon="enjoy" />
        <UpdateControl
          status={updateStatus}
          busy={updateBusy}
          error={updateError}
          onCheck={onCheckUpdate}
          onInstall={onInstallUpdate}
        />
        <div className={`link-pill state-${linkState}`}>
          <Radio size={16} />
          <span>{serialStatus.path ?? "No port"}</span>
          <span className="link-dot" aria-hidden="true" />
        </div>
      </div>
    </header>
  );
}
