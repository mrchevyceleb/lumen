import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Code2, ExternalLink, Globe, Plus, RefreshCw, X } from "lucide-react";
import { api, type BrowserState } from "./types";
import { IconButton } from "./Components";
import "./browser.css";

export default function BrowserPane({ workspace, open, blocked, width, onWidth, onClose, onAttach, canAttach, onError }: {
  workspace: string; open: boolean; blocked: boolean; width: number; onWidth: (width: number) => void;
  onClose: () => void; onAttach: (id: string) => Promise<void>; canAttach: boolean; onError: (message: string) => void;
}) {
  const [state, setState] = useState<BrowserState>({ workspace, tabs: [], activeId: "" });
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const captureLock = useRef(false);
  const [dragging, setDragging] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const current = state.workspace === workspace ? state.tabs.find((tab) => tab.id === state.activeId) : undefined;
  const action = async (body: object) => {
    try { setError(""); return await api("browser:action", body); }
    catch (e: any) { setError(e.message); return null; }
  };
  useEffect(() => window.lumen.onBrowser((next) => {
    if (next.workspace === workspaceRef.current) { setState(next); if (next.error) setError(next.error); }
  }), []);
  useEffect(() => {
    let alive = true;
    api<BrowserState>("browser:activate", workspace).then((next) => {
      if (alive) { setState(next); setError(""); }
    }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [workspace]);
  useEffect(() => {
    setAddress(current?.url === "about:blank" ? "" : current?.url || "");
    if (open && (!current || current.url === "about:blank")) input.current?.focus();
  }, [current?.id, current?.url, open]);
  useEffect(() => window.lumen.onBrowserCommand((command) => {
    if (command === "hide") onClose();
    else if (command === "address") { input.current?.focus(); input.current?.select(); }
  }), [onClose]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!open || blocked || event.defaultPrevented) return;
      if (event.key === "F12" && current) { event.preventDefault(); void action({ action: "devtools", id: current.id }); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") { event.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, blocked, current?.id]);
  useEffect(() => {
    let frame = 0, previous = "", failed = false;
    const visible = open && !blocked && !dragging && !!current && current.url !== "about:blank" && !current.error;
    if (!visible) void api("browser:layout", null).catch(onError);
    else {
      // Native views use device-independent pixels; the main process applies Lumen's UI zoom.
      // Measuring each frame also catches sidebar moves, editor changes, and maximization.
      const measure = () => {
        const rect = host.current?.getBoundingClientRect();
        if (rect && !failed) {
          const next = document.querySelector('[aria-modal="true"]') ? null : { workspace, id: current.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          const serialized = JSON.stringify([next, window.devicePixelRatio]);
          if (serialized !== previous) {
            previous = serialized;
            void api("browser:layout", next).catch((e) => { failed = true; onError(e.message); });
          }
        }
        frame = requestAnimationFrame(measure);
      };
      measure();
    }
    return () => { cancelAnimationFrame(frame); void api("browser:layout", null).catch(() => {}); };
  }, [open, blocked, dragging, current?.id, current?.url, current?.error, workspace, onError]);
  const navigate = async (url: string) => {
    if (current) await action({ action: "navigate", id: current.id, url });
    else await action({ action: "open", workspace, url });
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget, start = event.clientX, initial = element.nextElementSibling!.getBoundingClientRect().width;
    element.setPointerCapture(event.pointerId); setDragging(true);
    const move = (e: PointerEvent) => onWidth(Math.min(window.innerWidth * 0.6, Math.max(300, initial + start - e.clientX)));
    const end = () => {
      setDragging(false); element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", end); element.addEventListener("pointercancel", end);
  };
  if (!open) return null;
  return <>
    <div className="resizer browser-resizer" role="separator" aria-label="Resize browser" aria-orientation="vertical"
      aria-valuemin={300} aria-valuemax={Math.round(window.innerWidth * 0.6)} aria-valuenow={Math.round(width)} tabIndex={0}
      onPointerDown={resize} onKeyDown={(e) => {
        if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); onWidth(Math.max(300, Math.min(window.innerWidth * 0.6, width + (e.key === "ArrowLeft" ? 20 : -20)))); }
      }} />
    <aside id="browser-panel" className="browser-pane" style={{ width }} aria-label="Chromium browser">
      <div className="browser-heading"><Globe size={14} /><strong>Browser</strong><span title={workspace}>{workspace.replace(/\\/g, "/").split("/").at(-1) || "No workspace"}</span>
        <IconButton label="Hide browser (Ctrl Shift B)" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {state.workspace === workspace && state.tabs.map((tab, index) => <div className={`browser-tab ${tab.id === state.activeId ? "selected" : ""}`} key={tab.id}>
          <button role="tab" tabIndex={tab.id === state.activeId ? 0 : -1} aria-selected={tab.id === state.activeId} title={tab.url}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + state.tabs.length) % state.tabs.length;
              event.currentTarget.closest(".browser-tabs")?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              void action({ action: "select", id: state.tabs[next].id });
            }} onClick={() => void action({ action: "select", id: tab.id })}>{tab.loading ? <RefreshCw size={12} className="browser-loading" /> : <Globe size={12} />}<span>{tab.title || "New tab"}</span></button>
          <button aria-label={`Close browser tab ${tab.title}`} onClick={() => void action({ action: "close", id: tab.id })}><X size={12} /></button>
        </div>)}
        <IconButton label="New browser tab" onClick={() => void action({ action: "open", workspace })}><Plus size={15} /></IconButton>
      </div>
      <form className="browser-navigation" onSubmit={(e) => { e.preventDefault(); void navigate(address); }}>
        <IconButton label="Back" disabled={!current?.canGoBack} onClick={() => void action({ action: "back", id: current?.id })}><ArrowLeft size={15} /></IconButton>
        <IconButton label="Forward" disabled={!current?.canGoForward} onClick={() => void action({ action: "forward", id: current?.id })}><ArrowRight size={15} /></IconButton>
        <IconButton label={current?.loading ? "Stop loading" : "Reload page"} disabled={!current || current.url === "about:blank"} onClick={() => void action({ action: current?.loading ? "stop" : "reload", id: current?.id })}>{current?.loading ? <X size={15} /> : <RefreshCw size={15} />}</IconButton>
        <input ref={input} aria-label="Browser address" placeholder="localhost:3000 or any website" value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.target.select()} spellCheck={false} autoComplete="off" />
        <button type="submit" className="icon-button" aria-label="Go to address"><ArrowRight size={15} /></button>
      </form>
      <div className="browser-tools">
        <button disabled={!canAttach || !current || current.url === "about:blank" || capturing || !!current.error || current.loading} title="Add a screenshot and page context to the current chat draft" onClick={async () => {
          if (!current || captureLock.current) return; captureLock.current = true; setCapturing(true);
          try { await onAttach(current.id); } catch (e: any) { setError(e.message); } finally { captureLock.current = false; setCapturing(false); }
        }}><Camera size={13} />{capturing ? "Capturing…" : "Attach to chat"}</button>
        <button disabled={!current || current.url === "about:blank"} onClick={() => void action({ action: "devtools", id: current?.id })}><Code2 size={13} />DevTools</button>
        <button disabled={!current || current.url === "about:blank"} title="Open in your default browser" onClick={() => void api("external:open", current?.url).catch((e) => setError(e.message))}><ExternalLink size={13} /></button>
      </div>
      {error && <div className="browser-error" role="alert">{error}<button aria-label="Dismiss browser error" onClick={() => setError("")}><X size={12} /></button></div>}
      <div ref={host} className="browser-viewport">
        {current?.error ? <div className="browser-empty"><Globe size={30} /><strong>Couldn’t load this page</strong><p>{current.error}</p><button onClick={() => void action({ action: "reload", id: current.id })}>Try again</button></div> : (!current || current.url === "about:blank") && <div className="browser-empty">
          <Globe size={34} /><strong>Your preview, beside your code.</strong><p>Open a local dev server or a live website.<br />Your website logins stay saved in Lumen.</p>
          <div className="browser-local-links">{[3000, 5173, 8080].map((port) => <button key={port} onClick={() => void navigate(`http://localhost:${port}`)}>localhost:{port}</button>)}</div>
          <small>Ctrl L for the address · F12 for DevTools</small>
        </div>}
      </div>
      <div className="browser-status" title={current?.url}><span>{current?.loading ? "Loading…" : current?.url === "about:blank" ? "Chromium · ready" : current?.url || "Chromium · ready"}</span><small>Logins saved locally</small></div>
    </aside>
  </>;
}
