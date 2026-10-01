import { useEffect, useRef, useState } from "react";
import { Cable, RefreshCw, Check, AlertCircle } from "lucide-react";
import { Modal, Busy, IconButton } from "./Components";
import { api, type Tab, type SessionControlsState } from "./types";
import { agentNames } from "./settings";

export const lumenCommands = [
  { name: "mcp", insertText: "/mcp", description: "Manage MCP access for this chat", argumentHint: "", source: "Lumen", scope: "Session", native: false },
  { name: "autocompact", insertText: "/autocompact", description: "Automatically compact this chat at a token threshold", argumentHint: "[tokens | auto]", source: "Lumen", scope: "Session", native: false },
];
export function parseThreshold(text: string): number | null {
  if (["auto", "default", "off"].includes(text.toLowerCase())) return null;
  const match = text.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
  const tokens = match ? Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1000000 : match[2] ? 1000 : 1) : NaN;
  if (!Number.isSafeInteger(tokens) || tokens < 1000 || tokens > 2000000) throw new Error("Use /autocompact 160000 (or 160k), or /autocompact auto to restore the CLI default.");
  return tokens;
}
const statusLabel = (status: string) => ({ authenticationRequired: "Needs sign-in", "needs-auth": "Needs sign-in", starting: "Connecting", initializing: "Connecting",
  connected: "Connected", ready: "Connected", notStarted: "Not started", configured: "Configured", pending: "Connecting", setuprequired: "Needs setup", failed: "Connection failed", unavailable: "Unavailable", disabled: "Disabled", disconnected: "Disconnected" }[status] || status);

export default function SessionControls({ tab, onConfig, onClose, focusContext = false }: {
  tab: Tab; onConfig: (change: Partial<Tab>) => void; onClose: () => void; focusContext?: boolean;
}) {
  const [info, setInfo] = useState<SessionControlsState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [threshold, setThreshold] = useState(tab.autoCompactTokens ? String(tab.autoCompactTokens) : "");
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const contextInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setPending(true); setError("");
    try {
      const next = await api<SessionControlsState>("session:controls", tab.id);
      if (alive.current) { setInfo(next); onConfig({ autoCompactTokens: next.autoCompactTokens, mcpOverrides: next.mcpOverrides, contextTokens: next.contextTokens }); }
    } catch (e: any) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setPending(false); }
  };
  useEffect(() => { void refresh(); if (focusContext) contextInput.current?.focus(); return () => { alive.current = false; }; }, []);
  const change = async (data: object) => {
    setPending(true); setError(""); setSaved(false);
    try {
      const next = await api<SessionControlsState>("session:controls-change", tab.id, data);
      if (alive.current) { setInfo(next); setSaved(true); onConfig({ autoCompactTokens: next.autoCompactTokens, mcpOverrides: next.mcpOverrides, contextTokens: next.contextTokens }); }
    } catch (e: any) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setPending(false); }
  };
  const apply = () => {
    try { void change({ autoCompactTokens: threshold.trim() ? parseThreshold(threshold.trim()) : null }); }
    catch (e: any) { setError(e.message); }
  };
  return <Modal title="Session tools & context" subtitle={`${agentNames[tab.agent]} · ${tab.name} · only this chat`} onClose={onClose}>
    <div className="session-controls-panel">
      <section className="context-policy">
        <div className="session-section-heading"><h3>Auto-compact</h3>{info?.contextTokens !== null && info?.contextTokens !== undefined && <span>{info.contextTokens.toLocaleString()} tokens in context</span>}</div>
        <p>Compact with the CLI’s own summary, then continue the conversation.</p>
        <form className="threshold-form" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <label htmlFor="compact-threshold">Token threshold</label>
          <div><input id="compact-threshold" ref={contextInput} placeholder="CLI default" value={threshold} onChange={(e) => { setThreshold(e.target.value); setSaved(false); }} disabled={pending || tab.busy} />
            <button className="primary" disabled={pending || tab.busy} type="submit">Apply</button></div>
        </form>
        <div className="context-policy-footer"><code>/autocompact 160k</code><button disabled={pending || tab.busy} onClick={() => { setThreshold(""); void change({ autoCompactTokens: null }); }}>Use CLI default</button></div>
        <p className="session-fine-print">{tab.agent === "claude" ? "Claude supports 100k–1M tokens." : "Choose 1k–2M tokens."} Blank restores the CLI’s automatic threshold.</p>
        {saved && <div className="session-saved" role="status"><Check size={13} /> Applied to this chat</div>}
      </section>
      <section className="mcp-connections">
        <div className="session-section-heading"><h3><Cable size={15} /> MCP connections</h3><IconButton label="Refresh MCP connections" disabled={pending || tab.busy} onClick={() => void refresh()}><RefreshCw size={14} /></IconButton></div>
        <p>Disable MCP access to keep its tools out of future model requests. Existing tool results stay in history until compaction.</p>
        {pending && <div className="session-loading" role="status"><Busy text="Reading or applying session controls…" /></div>}
        {error && <div className="session-control-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
        {!pending && info && info.servers.length === 0 && <div className="mcp-empty">No MCP servers found. Configure servers in your CLI, then refresh here.</div>}
        <div className="mcp-server-list">{info?.servers.map((server) => <div className="mcp-server-row" key={server.name}>
          <span className={`mcp-status-dot ${server.enabled && ["connected", "ready"].includes(server.status) ? "connected" : ""}`} />
          <div className="mcp-server-info"><strong title={server.name}>{server.name}</strong><span>{server.enabled ? statusLabel(server.status) : "Disabled for this chat"} · {server.source}{server.tools !== null ? ` · ${server.tools} tools` : ""}</span></div>
          <button role="switch" aria-checked={server.enabled} aria-label={`MCP access: ${server.name}`} disabled={pending || tab.busy || !server.canToggle}
            title={server.canToggle ? "Change access for this chat only" : "Use native CLI controls to authenticate or configure this MCP"}
            className={`toggle ${server.enabled ? "on" : ""}`} onClick={() => void change({ server: server.name, enabled: !server.enabled })}><span /></button>
        </div>)}</div>
        {info?.warning && <p className="session-fine-print">{info.warning}</p>}
        <div className="context-policy-footer"><span /><button disabled={pending || tab.busy} onClick={() => void change({ resetMcps: true })}>Use CLI MCP defaults</button></div>
      </section>
    </div>
  </Modal>;
}
