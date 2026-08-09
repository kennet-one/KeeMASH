import { Check, Power, ShieldCheck } from "lucide-react";
import { useWorkspace } from "../core/workspace";
import type { TranslationKey } from "../i18n/catalog";
import { useLocale } from "../i18n/locale";
import { moduleDefinitions } from "../modules/registry";

export function ModuleManager() {
  const { text } = useLocale();
  const { profile, runtimeState, setCapability, setModuleEnabled } = useWorkspace();
  return <div className="module-manager view-enter">
    <header className="module-manager-intro"><span>{text("modules.runtime")}</span><h1>{text("shell.modules")}</h1><p>{text("modules.intro")}</p></header>
    <div className="module-list">{moduleDefinitions.map((module) => {
      const Icon = module.icon;
      const enabled = profile.enabledModules[module.id];
      const state = runtimeState(module.id);
      return <section className="module-row" key={module.id}>
        <div className="module-icon"><Icon size={22} /></div>
        <div className="module-info"><div className="module-heading"><div><h2>{module.title}</h2><span>v{module.version} · {text("modules.trusted")}</span></div><span className={`runtime-badge state-${state}`}>{state}</span></div><p>{text(`modules.${module.id}Description` as TranslationKey)}</p><div className="capability-list">{module.capabilities.map((capability) => {
          const granted = profile.grants[module.id].includes(capability);
          const managed = ["hardware.lowlevel", "process.control", "process.inject", "updates.manage"].includes(capability);
          return <button type="button" className={`${granted ? "is-granted" : ""}${managed ? " is-managed" : ""}`} key={capability} disabled={managed} onClick={() => setCapability(module.id, capability, !granted)} title={managed ? text("modules.managed") : text(granted ? "modules.revoke" : "modules.grant", { capability })}>{granted ? <Check size={12} /> : <ShieldCheck size={12} />}{capability}</button>;
        })}</div></div>
        <button className={`module-power${enabled ? " is-on" : ""}`} type="button" role="switch" aria-checked={enabled} onClick={() => setModuleEnabled(module.id, !enabled)} title={text(enabled ? "modules.disable" : "modules.enable", { module: module.title })}><Power size={18} /></button>
      </section>;
    })}</div>
  </div>;
}
