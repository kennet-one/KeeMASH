import { Download, PackageCheck, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { LocalUpdateStatus } from "../types";
import { TechnicalTerm } from "./TechnicalTerm";

interface UpdateControlProps {
  status: LocalUpdateStatus | null; busy: boolean; error: string | null;
  onCheck: () => void; onInstall: () => void;
}

export function UpdateControl({ status, busy, error, onCheck, onInstall }: UpdateControlProps) {
  const { text } = useLocale();
  const [open, setOpen] = useState(false);
  const available = status?.available === true;
  const title = available ? text("update.readyTitle", { version: status.version ?? "?" }) : text("update.checkTitle");
  const size = status?.bytes ? `${(status.bytes / 1024 / 1024).toFixed(1)} MiB` : text("update.sizeUnknown");
  return (
    <div className="update-control">
      <button className={`update-trigger${available ? " has-update" : ""}`} type="button" aria-label={title} aria-expanded={open} title={title} onClick={() => setOpen((current) => !current)}>
        {available ? <PackageCheck size={18} /> : <RefreshCw className={busy ? "spin" : ""} size={17} />}
        {available && <span className="update-beacon" aria-hidden="true" />}
      </button>
      {open && (
        <div className="update-popover" role="dialog" aria-label={text("update.dialog")}>
          <div className="update-popover-head">
            <div><small><LocalizedText textKey="update.channel" /></small><strong>{available ? text("update.version", { version: status.version ?? "?" }) : text("update.updater")}</strong></div>
            <button type="button" onClick={() => setOpen(false)} title={text("update.close")} aria-label={text("update.close")}><X size={15} /></button>
          </div>
          {available ? (
            <>
              <div className="update-release-meta">
                <span>{status.installerName}</span><span>{size}</span><span>{text("update.installed", { version: status.currentVersion })}</span>
              </div>
              <button className="update-install" type="button" disabled={busy} onClick={onInstall}>
                <Download className={busy ? "spin" : ""} size={16} />
                <LocalizedText textKey={busy ? "update.verifying" : "update.install"} />
              </button>
            </>
          ) : (
            <>
              <p>{error ? text("common.operationFailed") : status ? text("update.current") : text("update.notChecked")}</p>
              {(error || status?.message) && <code className="technical-detail">{error ?? status?.message}</code>}
            </>
          )}
          <button className="update-refresh" type="button" disabled={busy} onClick={onCheck}><RefreshCw className={busy ? "spin" : ""} size={13} /><LocalizedText textKey="update.checkAgain" /></button>
          <div className="update-trust"><LocalizedText textKey="update.trust" /> <TechnicalTerm term="SHA256" showLabel={false} /></div>
        </div>
      )}
    </div>
  );
}
