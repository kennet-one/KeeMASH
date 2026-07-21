import { Activity, BrainCircuit, Cpu, Languages, Radio, SlidersHorizontal } from "lucide-react";
import { LocalizedText, useLocale, type LocaleMode } from "../i18n/locale";
import type { TranslationKey } from "../i18n/catalog";
import type { LocalUpdateStatus, SerialStatus } from "../types";
import { UpdateControl } from "./UpdateControl";

interface ViewSwitchProps {
  labelKey: TranslationKey;
  titleKey: TranslationKey;
  active: boolean;
  onClick: () => void;
  icon: "main" | "monitor" | "enjoy";
}

function ViewSwitch({ labelKey, titleKey, active, onClick, icon }: ViewSwitchProps) {
  const { text } = useLocale();
  const Icon = icon === "main" ? SlidersHorizontal : icon === "monitor" ? Cpu : BrainCircuit;
  return (
    <button
      className={`view-switch${active ? " is-active" : ""}`}
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={text(titleKey)}
      onClick={onClick}
      title={text(titleKey)}
    >
      <Icon size={17} strokeWidth={2} />
      <LocalizedText textKey={labelKey} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}

function LocaleSelector() {
  const { mode, setMode, text } = useLocale();
  const modes: Array<{ value: LocaleMode; label: string; key: TranslationKey }> = [
    { value: "en", label: "EN", key: "locale.en" },
    { value: "uk", label: "UA", key: "locale.uk" },
  ];
  return (
    <div className="locale-control" role="group" aria-label={text("locale.selector")} title={text("locale.selector")}>
      <Languages size={15} aria-hidden="true" />
      {modes.map((item) => (
        <button
          key={item.value}
          type="button"
          className={mode === item.value ? "is-active" : ""}
          aria-pressed={mode === item.value}
          aria-label={text(item.key)}
          onClick={() => setMode(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
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

export function TopBar(props: TopBarProps) {
  const { text } = useLocale();
  const linkState = props.serialStatus.connected ? (props.bridgeOnline ? "online" : "serial") : "offline";
  return (
    <header className="top-bar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><Activity size={22} strokeWidth={2.2} /></span>
        <div>
          <div className="brand-name">KeeMASH</div>
          <div className="brand-context"><LocalizedText textKey="brand.context" /></div>
        </div>
      </div>
      <div className="top-actions">
        <ViewSwitch labelKey="top.main" titleKey={props.showMain ? "top.hideMain" : "top.showMain"} active={props.showMain} onClick={props.onToggleMain} icon="main" />
        <ViewSwitch labelKey="top.monitor" titleKey={props.showMonitor ? "top.hideMonitor" : "top.showMonitor"} active={props.showMonitor} onClick={props.onToggleMonitor} icon="monitor" />
        <ViewSwitch labelKey="top.enjoy" titleKey={props.showEnjoy ? "top.hideEnjoy" : "top.showEnjoy"} active={props.showEnjoy} onClick={props.onToggleEnjoy} icon="enjoy" />
        <LocaleSelector />
        <UpdateControl status={props.updateStatus} busy={props.updateBusy} error={props.updateError} onCheck={props.onCheckUpdate} onInstall={props.onInstallUpdate} />
        <div className={`link-pill state-${linkState}`}>
          <Radio size={16} />
          <span>{props.serialStatus.path ?? text("top.noPort")}</span>
          <span className="link-dot" aria-hidden="true" />
        </div>
      </div>
    </header>
  );
}
