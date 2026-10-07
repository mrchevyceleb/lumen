import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, type AdministratorStatus } from "./types";

export default function AdministratorPanel({ status, onStatus }: {
  status: AdministratorStatus;
  onStatus: (status: AdministratorStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const restart = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage("");
    try {
      const current = await api<AdministratorStatus>("administrator:status");
      onStatus(current);
      if (current.error) throw new Error(current.error);
      const result = await api<{ started: boolean; cancelled: boolean }>("administrator:restart");
      if (result.cancelled) setMessage("Administrator restart cancelled. Lumen is still running.");
    } catch (error: any) { setMessage(error.message); }
    finally { pending.current = false; setBusy(false); }
  };
  if (!status.supported) return null;
  return <div className="administrator-panel">
    <h3><ShieldCheck size={19} />Administrator mode</h3>
    <p className="muted">{status.elevated
      ? "Lumen is running as administrator. All agents and terminals inherit administrator access."
      : "Restart Lumen as administrator to let agents and terminals run commands that require Windows administrator access."}</p>
    {!status.elevated && <>
      <p className="muted">Windows will ask for permission. Save edited files first. Running sessions stop during the restart; your chats and settings are restored.</p>
      <button className="secondary" disabled={busy} onClick={() => void restart()}><ShieldCheck size={16} />{busy ? "Waiting for Windows…" : "Restart as administrator"}</button>
    </>}
    {status.elevated && <p className="muted">Close Lumen and open it normally to return to standard access.</p>}
    {(message || status.error) && <p role="status">{message || status.error}</p>}
  </div>;
}
