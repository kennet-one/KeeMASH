import { Download, PackageCheck, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { LocalUpdateStatus } from "../types";

interface UpdateControlProps {
  status: LocalUpdateStatus | null;
  busy: boolean;
  error: string | null;
  onCheck: () => void;
  onInstall: () => void;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "Size unavailable";
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function UpdateControl({ status, busy, error, onCheck, onInstall }: UpdateControlProps) {
  const [open, setOpen] = useState(false);
  const available = status?.available === true;
  const title = available ? `KeeMASH ${status.version} ready to install` : "Check for a fresh local build";

  return (
    <div className="update-control">
      <button
        className={`update-trigger${available ? " has-update" : ""}`}
        type="button"
        aria-label={title}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        {available ? <PackageCheck size={18} /> : <RefreshCw className={busy ? "spin" : ""} size={17} />}
        {available && <span className="update-beacon" aria-hidden="true" />}
      </button>

      {open && (
        <div className="update-popover" role="dialog" aria-label="KeeMASH local update">
          <div className="update-popover-head">
            <div>
              <small>LOCAL BUILD CHANNEL</small>
              <strong>{available ? `Version ${status.version}` : "KeeMASH updater"}</strong>
            </div>
            <button type="button" onClick={() => setOpen(false)} title="Close update panel" aria-label="Close update panel">
              <X size={15} />
            </button>
          </div>

          {available ? (
            <>
              <div className="update-release-meta">
                <span>{status.installerName}</span>
                <span>{formatBytes(status.bytes)}</span>
                <span>Installed: {status.currentVersion}</span>
              </div>
              <button className="update-install" type="button" disabled={busy} onClick={onInstall}>
                <Download className={busy ? "spin" : ""} size={16} />
                <span>{busy ? "Verifying SHA256" : "Install fresh build"}</span>
              </button>
            </>
          ) : (
            <p>{error ?? status?.message ?? "The local update channel has not been checked yet."}</p>
          )}

          <button className="update-refresh" type="button" disabled={busy} onClick={onCheck}>
            <RefreshCw className={busy ? "spin" : ""} size={13} />
            <span>Check again</span>
          </button>
          <div className="update-trust">Relative path + size + SHA256 verification</div>
        </div>
      )}
    </div>
  );
}
