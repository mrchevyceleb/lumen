import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Code2, ExternalLink, Globe, Pencil, Plus, RefreshCw, Send, Smartphone, X } from "lucide-react";
import { api, type BrowserMark, type BrowserSnapshot, type BrowserState, type BrowserViewMode } from "./types";
import { IconButton } from "./Components";
import "./browser.css";

const browserStateCache = new Map<string, BrowserState>();
const DEVICE_OPTIONS: { id: string; label: string; width: number; height: number }[] = [
  { id: "iphone", label: "iPhone 390×844", width: 390, height: 844 },
  { id: "pixel", label: "Pixel 412×915", width: 412, height: 915 },
  { id: "ipad", label: "iPad 820×1180", width: 820, height: 1180 },
];
const MARK_PALETTE = ["red", "orange", "blue", "green", "purple"];

export default function BrowserPane({ chatId, chatName, workspace, open, blocked, width, maxWidth, onWidth, onClose, onAttach, canAttach, onError }: {
  chatId: string; chatName: string; workspace: string; open: boolean; blocked: boolean; width: number; maxWidth: number; onWidth: (width: number) => void;
  onClose: () => void; onAttach: (id: string, marks?: BrowserMark[], captureToken?: string) => Promise<void>; canAttach: boolean; onError: (message: string) => void;
}) {
  const scope = chatId ? `chat:${chatId.toLowerCase()}` : "";
  const [state, setState] = useState<BrowserState>(() => browserStateCache.get(scope) || { scope, tabs: [], activeId: "" });
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [markupMode, setMarkupMode] = useState(false);
  const [markupImage, setMarkupImage] = useState("");
  const [markupToken, setMarkupToken] = useState("");
  const [markupSize, setMarkupSize] = useState<{ width: number; height: number } | null>(null);
  const [marks, setMarks] = useState<BrowserMark[]>([]);
  const [markDraft, setMarkDraft] = useState("");
  const [marksSending, setMarksSending] = useState(false);
  const [pendingNorm, setPendingNorm] = useState<{ x: number; y: number } | null>(null);
  const marksLock = useRef(false);
  const captureLock = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onWidthRef = useRef(onWidth);
  onWidthRef.current = onWidth;
  const current = state.scope === scope ? state.tabs.find((tab) => tab.id === state.activeId) : undefined;
  const action = async (body: object) => {
    try { setError(""); return await api("browser:action", body); }
    catch (e: any) { setError(e.message); return null; }
  };
  useEffect(() => window.lumen.onBrowser((next) => {
    browserStateCache.set(next.scope, next);
    if (next.scope === scopeRef.current) { setState(next); if (next.error) setError(next.error); }
  }), []);
  useLayoutEffect(() => {
    let alive = true;
    const cached = browserStateCache.get(scope);
    if (cached) setState(cached);
    api<BrowserSnapshot>("browser:snapshot", chatId, workspace).then((next) => {
      for (const item of next.states) browserStateCache.set(item.scope, item);
      browserStateCache.set(next.active.scope, next.active);
      if (alive && next.active.scope === scopeRef.current) { setState(next.active); setError(""); }
    }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [chatId, scope, workspace]);
  useEffect(() => {
    setAddress(current?.url === "about:blank" ? "" : current?.url || "");
  }, [current?.id, current?.url]);
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
  const viewMode: BrowserViewMode = current?.view || { mode: "desktop" };
  const mobile = viewMode.mode === "mobile";
  useEffect(() => () => browserStateCache.clear(), []);
  useEffect(() => { setMarkupMode(false); setMarkupImage(""); setMarkupToken(""); setMarkupSize(null); setMarks([]); setMarkDraft(""); setPendingNorm(null); setMarksSending(false); marksLock.current = false; }, [current?.id, current?.url]);
  useEffect(() => { if (open && current) browserStateCache.set(scope, state); }, [state, scope, open, current]);
  useLayoutEffect(() => {
    if (!open || markupMode) return;
    let frame = 0, previous = "", failed = false;
    const visible = open && !blocked && !dragging && !!current && current.url !== "about:blank" && !current.error;
    if (!visible) void api("browser:layout", null).catch(onError);
    else {
      // Native views use device-independent pixels; the main process applies Lumen's UI zoom.
      // Measuring each frame also catches sidebar moves, editor changes, and maximization.
      const measure = () => {
        const rect = host.current?.getBoundingClientRect();
        if (rect && !failed) {
          const next = document.querySelector('[aria-modal="true"]') ? null : { scope, id: current.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
  }, [open, blocked, dragging, markupMode, current?.id, current?.url, current?.error, scope, onError]);
  const enterMarkup = async () => {
    if (!current || captureLock.current) return; captureLock.current = true; setCapturing(true);
    try {
      const frozen = await api<{ token: string; image: string }>("browser:action", { action: "markup-begin", id: current.id });
      if (!frozen.token || !frozen.image) throw new Error("The screenshot came back empty.");
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => reject(new Error("The screenshot could not be read."));
        probe.src = frozen.image;
      });
      setMarkupToken(frozen.token);
      setMarkupImage(frozen.image);
      setMarkupSize(dimensions);
      setMarks([]); setMarkDraft(""); setPendingNorm(null);
      setMarkupMode(true);
    } catch (e: any) { setError(e.message); }
    finally { captureLock.current = false; setCapturing(false); }
  };
  const sendMarkup = async () => {
    if (!current || marksLock.current || !marks.length) return;
    marksLock.current = true; setMarksSending(true);
    try { await onAttach(current.id, marks, markupToken); setMarkupMode(false); setMarkupImage(""); setMarkupToken(""); setMarkupSize(null); setMarks([]); setMarkDraft(""); setPendingNorm(null); }
    catch (e: any) { setError(e.message); }
    finally { marksLock.current = false; setMarksSending(false); }
  };
  const cancelMarkup = () => { setMarkupMode(false); setMarkupImage(""); setMarkupToken(""); setMarkupSize(null); setMarks([]); setMarkDraft(""); setPendingNorm(null); };
  const navigate = async (url: string) => {
    if (current) await action({ action: "navigate", id: current.id, url });
    else await action({ action: "open", chatId, workspace, url });
  };
  useEffect(() => {
    if (!open) dragCleanupRef.current?.();
    return () => dragCleanupRef.current?.();
  }, [open]);
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    dragCleanupRef.current?.();
    const element = event.currentTarget, start = event.clientX, initial = element.nextElementSibling!.getBoundingClientRect().width;
    element.setPointerCapture(event.pointerId); setDragging(true);
    const move = (e: PointerEvent) => onWidthRef.current(initial + start - e.clientX);
    const end = () => {
      if (dragCleanupRef.current === end) dragCleanupRef.current = null;
      setDragging(false);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
    };
    dragCleanupRef.current = end;
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
  };
  if (!open) return null;
  return <>
    <div className="resizer browser-resizer" role="separator" aria-label="Resize browser" aria-orientation="vertical"
      aria-valuemin={48} aria-valuemax={maxWidth} aria-valuenow={Math.round(width)} tabIndex={0}
      onPointerDown={resize} onKeyDown={(e) => {
        if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); onWidth(width + (e.key === "ArrowLeft" ? 20 : -20)); }
      }} />
    <aside id="browser-panel" className="browser-pane" style={{ width }} aria-label="Chromium browser">
      <div className="browser-heading"><Globe size={14} /><strong>Browser</strong><span title={chatName && chatName !== "Terminal" ? `${chatName}'s browser` : workspace ? `This chat's browser in ${workspace}` : "This chat's browser"}>{chatName && chatName !== "Terminal" ? `${chatName}'s browser` : "This chat's browser"}</span>
        <IconButton label="Hide browser (Ctrl Shift B)" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {state.scope === scope && state.tabs.map((tab, index) => <div className={`browser-tab ${tab.id === state.activeId ? "selected" : ""}`} key={tab.id}>
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
        <IconButton label="New browser tab" onClick={() => void action({ action: "open", chatId, workspace })}><Plus size={15} /></IconButton>
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
        <button disabled={!canAttach || !current || current.url === "about:blank" || capturing || !!current.error || current.loading} title="Take a screenshot, mark things on it, and send it to the chat" onClick={() => void enterMarkup()}><Pencil size={13} />{capturing ? "Capturing…" : "Mark up"}</button>
        <button disabled={!current || current.url === "about:blank"} onClick={() => void action({ action: "devtools", id: current?.id })}><Code2 size={13} />DevTools</button>
        <button disabled={!current || current.url === "about:blank"} title="Open in your default browser" onClick={() => void api("external:open", current?.url).catch((e) => setError(e.message))}><ExternalLink size={13} /></button>
        <span className="browser-view-controls">
          <button className={mobile ? "" : "selected"} disabled={!current || current.url === "about:blank"} title="Show this tab the way a desktop browser would" onClick={() => void action({ action: "view", id: current?.id, view: { mode: "desktop" } })}>Desktop</button>
          <button className={mobile ? "selected" : ""} disabled={!current || current.url === "about:blank"} title="Show this tab in a phone-sized view" onClick={() => void action({ action: "view", id: current?.id, view: viewMode.mode === "mobile" ? viewMode : { mode: "mobile", device: "iphone", orientation: "portrait" } })}><Smartphone size={12} />Phone</button>
          {mobile && <label className="browser-device-label"><span>Device</span><select aria-label="Phone size" value={viewMode.mode === "mobile" ? viewMode.device : "iphone"} onChange={(e) => void action({ action: "view", id: current?.id, view: { mode: "mobile", device: e.target.value, orientation: viewMode.mode === "mobile" ? viewMode.orientation : "portrait" } })}>{DEVICE_OPTIONS.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}</select></label>}
          {mobile && <button title="Turn the phone sideways" aria-label="Rotate phone" onClick={() => void action({ action: "view", id: current?.id, view: { mode: "mobile", device: viewMode.mode === "mobile" ? viewMode.device : "iphone", orientation: viewMode.mode === "mobile" && viewMode.orientation === "landscape" ? "portrait" : "landscape" } })}>Rotate</button>}
        </span>
      </div>
      {error && <div className="browser-error" role="alert">{error}<button aria-label="Dismiss browser error" onClick={() => setError("")}><X size={12} /></button></div>}
      {markupMode && current && <div className="browser-markup-bar">
        <strong>Mark up the screenshot</strong>
        <span className="browser-markup-hint">Click the picture to drop a pin, type what it means, then Add. Pins are numbered for the chat.</span>
        <input aria-label="What this pin means" placeholder="e.g. This button is broken" value={markDraft} maxLength={80}
          onChange={(e) => setMarkDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); document.querySelector<HTMLButtonElement>(".browser-mark-add")?.click(); } }} />
        <button className="browser-mark-add" disabled={!markDraft.trim() || marks.length >= 10} onClick={() => {
          if (!markDraft.trim() || marks.length >= 10) return;
          if (!pendingNorm) { setError("Click the screenshot first to place this pin, then type what it means."); return; }
          setMarks((old) => [...old, { label: markDraft.trim(), x: pendingNorm.x, y: pendingNorm.y, color: MARK_PALETTE[old.length % MARK_PALETTE.length] }]);
          setPendingNorm(null); setMarkDraft("");
        }}>Add</button>
        {marks.length > 0 && <button onClick={() => setMarks((old) => old.slice(0, -1))}>Remove last</button>}
        {marks.length > 0 && <button disabled={marksSending} onClick={() => void sendMarkup()}><Send size={12} />{marksSending ? "Sending…" : `Send ${marks.length} pin${marks.length === 1 ? "" : "s"} to chat`}</button>}
        <button disabled={marksSending} onClick={cancelMarkup}>Cancel</button>
      </div>}
      <div ref={host} className={mobile || markupMode ? "browser-viewport browser-viewport-device" : "browser-viewport"}>
        {markupMode && current ? <div className="browser-markup-layer">
          <div className="browser-markup-stage" style={markupSize ? { aspectRatio: `${markupSize.width} / ${markupSize.height}` } : undefined}>
            <img alt="Screenshot to mark up" src={markupImage} draggable={false}
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
                const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
                setPendingNorm({ x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 });
                setError("");
              }} />
            {marks.map((mark, index) => <div className="browser-mark-pin" key={index} style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}>
              <span style={{ background: mark.color }}>{index + 1}</span><em>#{index + 1} {mark.label}</em>
            </div>)}
            {pendingNorm && <div className="browser-mark-pin browser-mark-pending" style={{ left: `${pendingNorm.x * 100}%`, top: `${pendingNorm.y * 100}%` }}>
              <span>?</span><em>New pin: type what it means, then Add</em>
            </div>}
          </div>
          <div className="browser-markup-exit"><button onClick={cancelMarkup}><X size={12} />Done marking</button></div>
        </div> : current?.error ? <div className="browser-empty"><Globe size={30} /><strong>Couldn’t load this page</strong><p>{current.error}</p><button onClick={() => void action({ action: "reload", id: current.id })}>Try again</button></div> : (!current || current.url === "about:blank") && <div className="browser-empty">
          <Globe size={34} /><strong>This chat has its own browser.</strong><p>Open a local dev server or a live website here.<br />Other chats keep their own pages, right where they left them.</p>
          <div className="browser-local-links">{[3000, 5173, 8080].map((port) => <button key={port} onClick={() => void navigate(`http://localhost:${port}`)}>localhost:{port}</button>)}</div>
          <small>Ctrl L for the address · F12 for DevTools</small>
        </div>}
      </div>
      <div className="browser-status" title={current?.url}><span>{current?.loading ? "Loading…" : current?.url === "about:blank" ? "Chromium · ready" : current?.url || "Chromium · ready"}</span><small>Logins saved locally</small></div>
    </aside>
  </>;
}
