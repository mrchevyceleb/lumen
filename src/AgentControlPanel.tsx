import { useEffect, useState } from "react";
import { Copy, Plug, RefreshCw } from "lucide-react";
import { api, type AgentControlStatus } from "./types";

export default function AgentControlPanel() {
  const [status, setStatus] = useState<AgentControlStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let alive = true;
    const off = window.lumen.onAgentControlStatus((next) => { if (alive) setStatus(next); });
    api<AgentControlStatus>("agent-control:status").then((next) => { if (alive) setStatus(next); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; off(); };
  }, []);
  const change = async () => {
    setBusy(true); setError("");
    try { setStatus(await api("agent-control:change", !status?.running)); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); }
    catch { setError("Could not copy. Select the instructions below and copy them."); }
  };
  const instructions = status ? `Use Lumen to run coding tasks visibly on this computer. Read ${status.guideFile} for the API and CLI guide.\nConnection file: ${status.connectionFile}\nRun: ${status.command} --help\nCreate a task: ${status.command} create --agent codex --name "Coding task" --root "C:\\path\\to\\repo" --text-file "task.txt"\nCreate an isolated worktree job: add --worktree agent/branch-name --base main, with optional --model MODEL_ID --effort LEVEL.\nOmit --root for no workspace. Model and effort default to Settings → Agents. Use list/get/watch to follow output. Send every agent-to-agent message with send TASK_ID --text "message"; it steers the current turn when the receiver is busy. Do not use --delivery queue for updates or heads-ups; only use it if the user explicitly asks to wait until the current turn ends. Read the full result: steered means accepted; check the transcript when confirmation matters. steerPending means accepted for delivery after compaction; do not resend. If deliveryUncertain is true, inspect the chat before retrying. A queued or separately sent message was accepted; do not resend it. Inspect the queue and use lumen get to check the receiver. If a routine message is queued by mistake or is waiting for the queue while a supported receiver is busy, use steer TASK_ID MESSAGE_ID on that existing message. Never steer if the queue is paused or delivery is uncertain, or if the message is a command needing its own turn. Gemini cannot steer and receives queued messages on its next turn. If another action is in progress, wait for it to finish before steering. To steer explicitly use steer TASK_ID --text "message"; for an existing queued message use steer TASK_ID MESSAGE_ID. Keep the connection token private. Lumen must be running.` : "";
  return <div className="agent-control-panel">
    <h3>Let your agents work in Lumen</h3>
    <p className="muted">Start coding tasks, follow their output, and continue or steer them from another agent. Every task opens as a normal, visible chat. Agents already chatting in Lumen need no setup: they get a <code>lumen</code> command that lets them run the other chats and drive their own browser tab with a visible cursor.</p>
    <div className="update-card" aria-live="polite"><Plug size={22} /><div>
      <h4>{status?.running ? "Local agent control is on" : "Local agent control is off"}</h4>
      <p className="muted">{status?.running ? "Connections stay on this computer and require a private token. Turn this off to disconnect clients; your chats keep running." : "Turn on local control to let your agents use Lumen's chats."}</p>
      {status?.running && <small className="muted">{status.ready ? "Ready" : "Waiting for chats to open"} · {status.url}</small>}
    </div></div>
    <div className="update-actions"><button className="secondary" disabled={busy || !status} onClick={change}><RefreshCw size={15} />{busy ? "Please wait…" : status?.running ? "Turn off" : "Turn on"}</button>
      <button className="primary" disabled={!status?.running} onClick={() => copy("Instructions", instructions)}><Copy size={15} />Copy instructions for an agent</button></div>
    {status && <><p className="muted">Paste these instructions into your agent. It can choose Pi, Codex, Claude Code, Grok, or a shell, and reuse any open chat. Node.js runs the helper; the guide also includes PowerShell API examples.</p>
      <pre className="agent-control-instructions" tabIndex={0}>{instructions}</pre>
      <button className="secondary" onClick={() => copy("Command", `${status.command} list`)}><Copy size={14} />Copy list command</button></>}
    {copied && <p role="status" className="muted">{copied} copied.</p>}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
  </div>;
}
