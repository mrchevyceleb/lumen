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
// Main keeps a markup capture alive for 15 minutes; a stashed set of pins past that cannot send.
const MARKUP_TTL_MS = 15 * 60 * 1000;
// While a screenshot is being marked, the page under the pins must stay the page that was
// captured: swapping tabs, navigating, or reloading would make the frozen shot (and the
// token bound to its generation) stale, so those actions wait until marking ends.
const PAGE_CHANGING = new Set(["select", "close", "open", "navigate", "back", "forward", "reload", "stop", "view"]);

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
  const [stageBox, setStageBox] = useState<{ width: number; height: number } | null>(null);
  const marksLock = useRef(false);
  const captureLock = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const markupLayerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Frozen screenshots and their pins, kept per chat so a switch never costs the user their marks.
  // A capture token lives 15 minutes, so a stash older than that can no longer be sent.
  const markupStash = useRef(new Map<string, { image: string; token: string; size: { width: number; height: number } | null; marks: BrowserMark[]; draft: string; at: number }>());
  const input = useRef<HTMLInputElement>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onWidthRef = useRef(onWidth);
  onWidthRef.current = onWidth;
  const current = state.scope === scope ? state.tabs.find((tab) => tab.id === state.activeId) : undefined;
  const currentIdRef = useRef<string | undefined>(current?.id);
  currentIdRef.current = current?.id;
  const action = async (body: object) => {
    if (markupMode && PAGE_CHANGING.has((body as { action?: string }).action || "")) return null;
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
  // Reset the marking view when the page underneath changes, but never while marking is open:
  // a tab switch or navigation must not throw away pins the user has already placed.
  useEffect(() => {
    if (markupMode) return;
    setMarkupMode(false); setMarkupImage(""); setMarkupToken(""); setMarkupSize(null); setMarks([]); setMarkDraft(""); setPendingNorm(null); setMarksSending(false); marksLock.current = false;
  }, [current?.id, current?.url, markupMode]);
  // A frozen screenshot belongs to the chat it was taken in. Leaving that chat ends marking
  // rather than carrying chat A's pins and image into chat B's pane.
  const markupScopeRef = useRef(scope);
  useEffect(() => {
    if (markupScopeRef.current === scope) return;
    const left = markupScopeRef.current;
    markupScopeRef.current = scope;
    // Marks belong to the chat they were drawn in, so they never follow the pane into another
    // chat. They are kept with that chat rather than thrown away: coming back brings the frozen
    // screenshot and every pin back exactly as they were, until the capture token expires.
    if (markupMode && (marks.length || markupImage)) {
      markupStash.current.set(left, { image: markupImage, token: markupToken, size: markupSize, marks, draft: markDraft, at: Date.now() });
    }
    const kept = markupStash.current.get(scope);
    const fresh = kept && Date.now() - kept.at < MARKUP_TTL_MS ? kept : undefined;
    if (kept && !fresh) markupStash.current.delete(scope);
    setMarkupMode(!!fresh); setMarkupImage(fresh?.image || ""); setMarkupToken(fresh?.token || "");
    setMarkupSize(fresh?.size || null); setMarks(fresh?.marks || []); setMarkDraft(fresh?.draft || "");
    setPendingNorm(null); setMarksSending(false); setConfirmDiscard(false); marksLock.current = false;
    if (fresh?.marks.length) onError(`Your ${fresh.marks.length} mark${fresh.marks.length === 1 ? " is" : "s are"} still on this chat's screenshot. Carry on when you are ready.`);
  }, [scope, markupMode, marks, markupImage, markupToken, markupSize, markDraft, onError]);
  useEffect(() => { if (open && current) browserStateCache.set(scope, state); }, [state, scope, open, current]);
  // Fit the frozen screenshot into the pane ourselves: the pins are placed as percentages of the
  // image box, so the *image* box must be the thing we measure. CSS aspect-ratio plus max-width and
  // max-height resolves differently in a grid cell (it clipped the bottom of the capture and left
  // the letterbox area swallowing clicks), so the stage gets explicit pixels from this measurement.
  useLayoutEffect(() => {
    if (!markupMode || !markupSize) { setStageBox(null); return; }
    const fit = () => {
      const layer = markupLayerRef.current;
      if (!layer) return;
      const box = layer.getBoundingClientRect();
      const pad = 14;
      const scale = Math.min((box.width - pad * 2) / markupSize.width, (box.height - pad * 2) / markupSize.height);
      if (!Number.isFinite(scale) || scale <= 0) return;
      const width = Math.max(1, Math.round(markupSize.width * scale)), height = Math.max(1, Math.round(markupSize.height * scale));
      setStageBox((old) => old && old.width === width && old.height === height ? old : { width, height });
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (markupLayerRef.current) observer.observe(markupLayerRef.current);
    return () => observer.disconnect();
  }, [markupMode, markupSize]);
  // Switch synchronously, before a different chat paints. The async path below lands a few frames
  // late, and that gap is exactly what showed the previous chat's page over the new one. The same
  // call puts this chat's own page up when it has one, so the pane is never left blank either.
  useLayoutEffect(() => {
    const rect = host.current?.getBoundingClientRect();
    const box = rect && rect.width > 1 && rect.height > 1 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    try { window.lumen.switchBrowserNow(chatId, workspace, box, open && !markupMode); }
    catch { /* app is closing */ }
  }, [scope]);
  // Closing the pane or opening markup has to retract the composited page in this same commit
  // too, for the same reason: the async layout(null) below is a few frames late.
  useLayoutEffect(() => {
    if (open && !markupMode) return;
    try { window.lumen.hideBrowserNow(); } catch { /* app is closing */ }
  }, [open, markupMode]);
  useLayoutEffect(() => {
    if (!open || markupMode) { void api("browser:layout", null).catch(onError); return; }
    let frame = 0, previous = "", failed = false;
    // Re-measure every frame so resizing the pane, dragging the splitter, and maximizing all move
    // the native page with the panel. Nothing is detached on teardown: a navigation or a dep change
    // used to blank and re-add the view (a visible flicker), and the next measure corrects the bounds.
    const measure = () => {
      const rect = host.current?.getBoundingClientRect();
      if (rect && !failed) {
        const next = document.querySelector('[aria-modal="true"]') ? null : { scope, id: current?.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const serialized = JSON.stringify([next, window.devicePixelRatio]);
        if (serialized !== previous) {
          previous = serialized;
          void api("browser:layout", next).catch((e) => { failed = true; onError(e.message); });
        }
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [open, blocked, markupMode, current?.id, current?.url, current?.error, scope, onError]);
  const enterMarkup = async () => {
    if (!current || captureLock.current || markupMode) return;
    const startScope = scopeRef.current, startTab = current.id;
    captureLock.current = true; setCapturing(true);
    try {
      const frozen = await api<{ token: string; image: string }>("browser:action", { action: "markup-begin", id: startTab });
      if (!frozen.token || !frozen.image) throw new Error("The screenshot came back empty.");
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => reject(new Error("The screenshot could not be read."));
        probe.src = frozen.image;
      });
      // A capture can take a while. If the user moved to another chat or tab meanwhile, this
      // picture no longer belongs to what is on screen, so drop it instead of opening markup
      // over the wrong page.
      if (scopeRef.current !== startScope || currentIdRef.current !== startTab) return;
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
  // Leaving markup throws the pins away, so ask first when there is work to lose.
  const cancelMarkup = () => {
    if (marks.length && !confirmDiscard) { setConfirmDiscard(true); setError(""); return; }
    setMarkupMode(false); setMarkupImage(""); setMarkupToken(""); setMarkupSize(null); setMarks([]); setMarkDraft(""); setPendingNorm(null); setConfirmDiscard(false);
  };
  // Place every label in measured pixels: beside its dot when there is room, flipped to the
  // other side near the right edge, and kept fully inside the picture top and bottom.
  const clampPinLabels = () => {
    const box = stageRef.current; if (!box) return;
    const width = box.clientWidth, height = box.clientHeight;
    if (!width || !height) return;
    box.querySelectorAll<HTMLElement>(".browser-mark-pin").forEach((pin) => {
      const label = pin.querySelector("em"), dot = pin.querySelector("span");
      if (!label || !dot) return;
      const x = Number(pin.dataset.x || 0) * width, y = Number(pin.dataset.y || 0) * height;
      const radius = dot.offsetWidth / 2 || 13, gap = 6;
      label.style.transform = "none";
      // Measure at natural width each time, so a label widens again when the stage grows.
      label.style.width = "";
      let w = label.offsetWidth, h = label.offsetHeight;
      if (w > width - 8) { label.style.width = `${width - 8}px`; w = label.offsetWidth; h = label.offsetHeight; }
      let left = x + radius + gap;
      if (left + w > width - 4) left = x - radius - gap - w;
      if (left < 4) left = Math.min(Math.max(4, width - 4 - w), Math.max(4, x - w / 2));
      const top = Math.min(Math.max(4, y - h / 2), Math.max(4, height - 4 - h));
      // The pin is a zero-size anchor at (x, y), and the label is positioned inside it,
      // so offsets have to be relative to the pin, not to the stage.
      label.style.left = `${Math.round(left - x)}px`; label.style.top = `${Math.round(top - y)}px`;
      // Keep the whole dot visible when the click lands on the very edge of the picture.
      const dotX = Math.min(Math.max(x, radius + 2), width - radius - 2), dotY = Math.min(Math.max(y, radius + 2), height - radius - 2);
      dot.style.left = `${Math.round(dotX - x)}px`; dot.style.top = `${Math.round(dotY - y)}px`;
    });
  };
  useLayoutEffect(() => { clampPinLabels(); }, [marks, pendingNorm, stageBox, markupMode]);
  useEffect(() => { setConfirmDiscard(false); }, [marks.length]);
  // An armed "Discard N pins?" must not sit there waiting for a stray click minutes later.
  useEffect(() => {
    if (!confirmDiscard) return;
    const timer = setTimeout(() => setConfirmDiscard(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDiscard]);
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
    <aside id="browser-panel" className={dragging ? "browser-pane browser-resizing" : "browser-pane"} style={{ width }} aria-label="Chromium browser">
      <div className="browser-heading"><Globe size={14} /><strong>Browser</strong><span title={chatName && chatName !== "Terminal" ? `${chatName}'s browser` : workspace ? `This chat's browser in ${workspace}` : "This chat's browser"}>{chatName && chatName !== "Terminal" ? `${chatName}'s browser` : "This chat's browser"}</span>
        <IconButton label="Hide browser (Ctrl Shift B)" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div className={markupMode ? "browser-tabs browser-locked" : "browser-tabs"} role="tablist" aria-label="Browser tabs">
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
      <form className={markupMode ? "browser-navigation browser-locked" : "browser-navigation"} onSubmit={(e) => { e.preventDefault(); void navigate(address); }}>
        <IconButton label="Back" disabled={!current?.canGoBack} onClick={() => void action({ action: "back", id: current?.id })}><ArrowLeft size={15} /></IconButton>
        <IconButton label="Forward" disabled={!current?.canGoForward} onClick={() => void action({ action: "forward", id: current?.id })}><ArrowRight size={15} /></IconButton>
        <IconButton label={current?.loading ? "Stop loading" : "Reload page"} disabled={!current || current.url === "about:blank"} onClick={() => void action({ action: current?.loading ? "stop" : "reload", id: current?.id })}>{current?.loading ? <X size={15} /> : <RefreshCw size={15} />}</IconButton>
        <input ref={input} aria-label="Browser address" placeholder={state.scope === scope ? "localhost:3000 or any website" : ""} value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.target.select()} spellCheck={false} autoComplete="off" />
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
        <button disabled={marksSending} onClick={cancelMarkup}>{confirmDiscard ? `Discard ${marks.length} pin${marks.length === 1 ? "" : "s"}?` : "Done marking"}</button>
      </div>}
      <div ref={host} className={mobile || markupMode ? "browser-viewport browser-viewport-device" : "browser-viewport"}>
        {markupMode && current ? <div className="browser-markup-layer" ref={markupLayerRef}>
          <div ref={stageRef} className="browser-markup-stage" style={stageBox ? { width: stageBox.width, height: stageBox.height } : { visibility: "hidden" }}>
            <img alt="Screenshot to mark up" src={markupImage} draggable={false}
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                if (box.width < 1 || box.height < 1) return;
                const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
                const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
                setPendingNorm({ x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 });
                setError("");
              }} />
            {marks.map((mark, index) => <div className="browser-mark-pin" key={index} data-x={mark.x} data-y={mark.y} style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}>
              <span style={{ background: mark.color }}>{index + 1}</span><em>#{index + 1} {mark.label}</em>
            </div>)}
            {pendingNorm && <div className="browser-mark-pin browser-mark-pending" data-x={pendingNorm.x} data-y={pendingNorm.y} style={{ left: `${pendingNorm.x * 100}%`, top: `${pendingNorm.y * 100}%` }}>
              <span>?</span><em>New pin: type what it means, then Add</em>
            </div>}
          </div>
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
