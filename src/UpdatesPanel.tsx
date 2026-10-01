import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api, type UpdateStatus } from "./types";

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const unsubscribe = window.lumen.onUpdate(setStatus);
    let alive = true;
    api<UpdateStatus>("updates:status").then((next) => { if (alive) setStatus(next); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}

export default function UpdatesPanel() {
  const status = useUpdates();
  const [error, setError] = useState("");
  const busy = status?.phase === "checking" || status?.phase === "downloading";
  const action = async (channel: string) => {
    setError("");
    try { await api(channel); } catch (e: any) { setError(e.message); }
  };
  return <div className="updates-panel">
    <h3>Lumen {status?.version || ""}</h3>
    <p className="muted">A little more room to think. Open source under the MIT license.</p>
    <div className="update-card" aria-live="polite">
      <Download size={22} />
      <div>
        <h4>{status?.phase === "downloaded" ? `Lumen ${status.latest} is ready` : status?.phase === "downloading" ? `Downloading ${status.latest} · ${status.percent}%` : status?.phase === "checking" ? "Checking for updates…" : status?.phase === "current" ? "You're up to date" : status?.phase === "error" ? "Updates couldn't connect" : status?.phase === "portable" ? "Install Lumen to enable automatic updates" : "Automatic updates"}</h4>
        <p className="muted">{status?.phase === "portable" ? "Download the Setup installer from GitHub. It keeps your existing Lumen settings and chats." : status?.phase === "downloaded" ? "Installs when you close Lumen. Restart now when you're ready; your usual unsaved-work checks still apply." : status?.message || "Lumen checks at launch and every six hours. Updates download in the background and install when you close the app."}</p>
        {status?.checkedAt ? <small className="muted">Last checked {new Date(status.checkedAt).toLocaleString()}</small> : null}
      </div>
    </div>
    <div className="update-actions">
      {status?.phase === "downloaded" ? <button className="primary" onClick={() => action("updates:install")}><RefreshCw size={15} />Restart and update</button> : status && status.phase !== "portable" ? <button className="secondary" disabled={busy} onClick={() => action("updates:check")}><RefreshCw size={15} />{busy ? "Please wait…" : "Check for updates"}</button> : null}
      <button className="secondary" onClick={() => api("external:open", "https://github.com/mrchevyceleb/lumen/releases/latest").catch((e) => setError(e.message))}>GitHub releases</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
