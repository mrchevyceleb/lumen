import { useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type Tab } from "./types";
export default function QueuedMessages({ tab, onConfig }: { tab: Tab; onConfig: (change: Partial<Tab>) => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), draft = useRef(tab.draft || ""); draft.current = tab.draft || "";
  const messages = tab.queuedMessages || [];
  const busy = pending || messages.some((m) => m.state !== "queued");
  const action = async (id: string, operation: string) => {
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try {
      const editing = operation === "edit" ? messages.find((m) => m.id === id) : undefined;
      await api("session:queue-action", tab.id, id, operation === "edit" ? "remove" : operation);
      if (editing !== undefined) onConfig({ draft: [draft.current, editing.text].filter(Boolean).join("\n\n"), draftAttachments: [...(tab.draftAttachments || []), ...(editing.attachments || [])] });
    } catch (e: any) { setError(e.message); } finally { lock.current = false; setPending(false); }
  };
  if (!messages.length && !error) return null;
  return <div className="queued-messages">
    {!!messages.length && <div className="queue-heading"><span>{messages.length} queued {messages.length === 1 ? "message" : "messages"}{tab.queuePaused ? " · paused" : " · sent after this turn"}</span>
      {tab.queuePaused && <button disabled={busy} onClick={() => void action("", "resume")}>Resume queue</button>}</div>}
    <div className="queue-list">{messages.map((m) => <div className="queue-message" key={m.id}>
      <p title={m.text}>{m.text}{!!m.attachments?.length && <span> · {m.attachments.length} image(s)</span>}{m.deliveryUncertain && <strong> · Delivery uncertain; inspect history before resending</strong>}</p><div>
        {m.state !== "queued" ? <span>{m.state === "steering" ? "Sending to active run…" : "Sending…"}</span> : <>
          <button disabled={busy || m.deliveryUncertain || tab.phase === "compacting"} title={tab.busy ? "Send this correction into the active run at the CLI's next supported boundary." : "Send this message now."} onClick={() => void action(m.id, "steer")}>{tab.busy ? "Steer" : "Send now"}</button>
          <button disabled={busy} onClick={() => void action(m.id, "edit")}>Edit</button>
          <button disabled={busy} aria-label="Remove queued message" onClick={() => void action(m.id, "remove")}><X size={12} /></button>
        </>}
      </div></div>)}</div>
    {error && <p className="session-control-error" role="alert">{error}</p>}
  </div>;
}
